export function parseModels(output: string): string[] {
  return output
    .split("\n")
    .map((l) => l.trim().replace(/\s*\(current\)$/, ""))
    .filter((l) => l.length > 0);
}

export interface ResolveOptions {
  explicit?: string;
  chain: string[];
  defaultModel?: string;
}

export interface Resolution {
  model?: string;
  note?: string;
}

export interface ChainResolution {
  models: (string | undefined)[];
  note?: string;
}

export class ModelRegistry {
  private listing: string[] | null = null;
  private pending: Promise<string[] | null> | null = null;

  constructor(private fetchListing: () => Promise<string>) {}

  async available(): Promise<string[] | null> {
    if (this.listing) return this.listing;
    // Cache the promise so concurrent first calls share one fetch.
    this.pending ??= this.fetchListing()
      .then(parseModels)
      .catch(() => null);
    const result = await this.pending;
    if (result) this.listing = result;
    else this.pending = null; // transient failure — retry on the next call
    return result;
  }

  async resolve(opts: ResolveOptions): Promise<Resolution> {
    const r = await this.resolveChain(opts);
    return { model: r.models[0], note: r.note };
  }

  /**
   * Returns every viable model in preference order so callers can fail over
   * (e.g. on quota exhaustion). `[undefined]` means "let agy pick".
   */
  async resolveChain(opts: ResolveOptions): Promise<ChainResolution> {
    const available = await this.available();

    if (opts.explicit) {
      if (available === null) {
        return {
          models: [opts.explicit],
          note: "could not list agy models; passing model through unvalidated",
        };
      }
      if (available.includes(opts.explicit)) return { models: [opts.explicit] };
      throw new Error(
        `Model "${opts.explicit}" is not available. Available models:\n${available.join("\n")}`,
      );
    }

    if (available === null) {
      return {
        models: [undefined],
        note: "could not list agy models; using agy's own default model",
      };
    }
    const models = opts.chain.filter((m) => available.includes(m));
    if (
      opts.defaultModel &&
      available.includes(opts.defaultModel) &&
      !models.includes(opts.defaultModel)
    ) {
      models.push(opts.defaultModel);
    }
    if (models.length === 0) {
      return {
        models: [undefined],
        note: "no preferred model available; using agy's own default model",
      };
    }
    return { models };
  }
}

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

export class ModelRegistry {
  private listing: string[] | null = null;
  private loaded = false;

  constructor(private fetchListing: () => Promise<string>) {}

  async available(): Promise<string[] | null> {
    if (!this.loaded) {
      this.loaded = true;
      try {
        this.listing = parseModels(await this.fetchListing());
      } catch {
        this.listing = null;
      }
    }
    return this.listing;
  }

  async resolve(opts: ResolveOptions): Promise<Resolution> {
    const available = await this.available();

    if (opts.explicit) {
      if (available === null) {
        return {
          model: opts.explicit,
          note: "could not list agy models; passing model through unvalidated",
        };
      }
      if (available.includes(opts.explicit)) return { model: opts.explicit };
      throw new Error(
        `Model "${opts.explicit}" is not available. Available models:\n${available.join("\n")}`,
      );
    }

    if (available === null) {
      return { note: "could not list agy models; using agy's own default model" };
    }
    for (const candidate of opts.chain) {
      if (available.includes(candidate)) return { model: candidate };
    }
    if (opts.defaultModel && available.includes(opts.defaultModel)) {
      return { model: opts.defaultModel };
    }
    return { note: "no preferred model available; using agy's own default model" };
  }
}

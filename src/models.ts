export interface ModelEntry {
  /** Machine id, e.g. `gemini-3.7-flash-medium` (agy ≥1.1 only). */
  id?: string;
  /** Display name, e.g. `Gemini 3.7 Flash (Medium)` — what `agy --model` accepts on every version. */
  name: string;
}

/**
 * Parses `agy models` output. Handles both the legacy one-column format (one
 * display name per line) and the agy ≥1.1 two-column `<id>\t<display name>`
 * format, which also emits a `Fetching available models...` status line.
 */
export function parseModelEntries(output: string): ModelEntry[] {
  const lines = output
    .split("\n")
    .map((l) => l.trim().replace(/\s*\(current\)$/, ""))
    .filter((l) => l.length > 0);
  // ponytail: in two-column mode only tabbed lines are models; anything else is status chatter.
  const tabbed = lines.some((l) => l.includes("\t"));
  return lines
    .filter((l) => !tabbed || l.includes("\t"))
    .map((l) => {
      const [first, ...rest] = l.split("\t");
      return rest.length > 0 ? { id: first.trim(), name: rest.join(" ").trim() } : { name: first };
    });
}

/** Display names only — the values valid for `agy --model`. */
export function parseModels(output: string): string[] {
  return parseModelEntries(output).map((e) => e.name);
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
  private entries: ModelEntry[] | null = null;
  private pending: Promise<ModelEntry[] | null> | null = null;

  constructor(private fetchListing: () => Promise<string>) {}

  private async load(): Promise<ModelEntry[] | null> {
    if (this.entries) return this.entries;
    // Cache the promise so concurrent first calls share one fetch.
    this.pending ??= this.fetchListing()
      .then(parseModelEntries)
      .catch(() => null);
    const result = await this.pending;
    if (result) this.entries = result;
    else this.pending = null; // transient failure — retry on the next call
    return result;
  }

  /** Available display names, or null when `agy models` could not be read. */
  async available(): Promise<string[] | null> {
    return (await this.load())?.map((e) => e.name) ?? null;
  }

  async resolve(opts: ResolveOptions): Promise<Resolution> {
    const r = await this.resolveChain(opts);
    return { model: r.models[0], note: r.note };
  }

  /**
   * Returns every viable model in preference order so callers can fail over
   * (e.g. on quota exhaustion). `[undefined]` means "let agy pick".
   * Caller-supplied names (`explicit`, `defaultModel`) may be either the id or
   * the display name; both are normalised to the display name.
   */
  async resolveChain(opts: ResolveOptions): Promise<ChainResolution> {
    const entries = await this.load();
    const available = entries?.map((e) => e.name) ?? null;
    const canonical = (m: string) => entries?.find((e) => e.id === m)?.name ?? m;

    if (opts.explicit) {
      if (available === null) {
        return {
          models: [opts.explicit],
          note: "could not list agy models; passing model through unvalidated",
        };
      }
      const explicit = canonical(opts.explicit);
      if (available.includes(explicit)) return { models: [explicit] };
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
    const defaultModel = opts.defaultModel && canonical(opts.defaultModel);
    if (defaultModel && available.includes(defaultModel) && !models.includes(defaultModel)) {
      models.push(defaultModel);
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

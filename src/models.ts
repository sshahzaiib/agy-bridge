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

/**
 * Expands a chain pattern against the available display names. A single `*`
 * stands for a version number (`Gemini * Flash (High)`) and resolves to the
 * newest matching model, so chains survive model releases. Patterns without
 * `*` must match exactly.
 */
export function pickModel(pattern: string, available: string[]): string | undefined {
  if (!pattern.includes("*")) return available.includes(pattern) ? pattern : undefined;
  const [head, tail] = pattern.split("*", 2);
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${escape(head)}(\\d+(?:\\.\\d+)*)${escape(tail ?? "")}$`);
  let best: { name: string; version: number[] } | undefined;
  for (const name of available) {
    const m = re.exec(name);
    if (!m) continue;
    const version = m[1].split(".").map(Number);
    if (!best || compareVersions(version, best.version) > 0) best = { name, version };
  }
  return best?.name;
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export interface ResolveOptions {
  explicit?: string;
  /** Preference order; entries may be exact display names or `*` version patterns (see `pickModel`). */
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
      const explicit = pickModel(canonical(opts.explicit), available);
      if (explicit) return { models: [explicit] };
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
    const models = [...new Set(opts.chain.flatMap((p) => pickModel(p, available) ?? []))];
    const defaultModel = opts.defaultModel && pickModel(canonical(opts.defaultModel), available);
    if (defaultModel && !models.includes(defaultModel)) {
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

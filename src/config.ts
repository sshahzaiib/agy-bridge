export interface Config {
  agyPath: string;
  timeoutSec: number;
  /** True when AGY_TIMEOUT was set explicitly; overrides per-tool timeouts. */
  timeoutExplicit: boolean;
  /**
   * Per-tool timeout overrides from AGY_TIMEOUT_<TOOL_NAME> env vars
   * (e.g. AGY_TIMEOUT_DEEP_SEARCH), keyed by lowercased tool name.
   * Takes precedence over the global AGY_TIMEOUT and the tool's default.
   */
  perToolTimeouts: Record<string, number>;
  maxOutputChars: number;
  defaultModel: string | undefined;
  skipPermissions: boolean;
  sandbox: boolean;
  onFailure: "strict" | "fallback";
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function loadPerToolTimeouts(env: Record<string, string | undefined>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(env)) {
    if (!key.startsWith("AGY_TIMEOUT_")) continue;
    const tool = key.slice("AGY_TIMEOUT_".length).toLowerCase();
    if (!tool) continue;
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) out[tool] = n;
  }
  return out;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return {
    agyPath: env.AGY_PATH || "agy",
    timeoutSec: positiveInt(env.AGY_TIMEOUT, 1200),
    timeoutExplicit: positiveInt(env.AGY_TIMEOUT, 0) > 0,
    perToolTimeouts: loadPerToolTimeouts(env),
    maxOutputChars: positiveInt(env.AGY_MAX_OUTPUT_CHARS, 50_000),
    defaultModel: env.AGY_DEFAULT_MODEL || undefined,
    skipPermissions: env.AGY_SKIP_PERMISSIONS !== "false",
    sandbox: env.AGY_SANDBOX === "true",
    onFailure: env.AGY_ON_FAILURE === "strict" ? "strict" : "fallback",
  };
}

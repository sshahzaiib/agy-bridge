export interface Config {
  agyPath: string;
  timeoutSec: number;
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

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return {
    agyPath: env.AGY_PATH || "agy",
    timeoutSec: positiveInt(env.AGY_TIMEOUT, 1200),
    maxOutputChars: positiveInt(env.AGY_MAX_OUTPUT_CHARS, 50_000),
    defaultModel: env.AGY_DEFAULT_MODEL || undefined,
    skipPermissions: env.AGY_SKIP_PERMISSIONS !== "false",
    sandbox: env.AGY_SANDBOX === "true",
    onFailure: env.AGY_ON_FAILURE === "strict" ? "strict" : "fallback",
  };
}

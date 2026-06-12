/**
 * Quota detection and cooldown tracking for agy model failover.
 *
 * agy never surfaces RESOURCE_EXHAUSTED to stdout/stderr in print mode — it
 * silently retries until --print-timeout, then exits 0 with empty output.
 * The only reliable signal is the 429 line in its log file, which includes
 * the exact reset time ("Resets in 96h53m25s").
 */

export const DEFAULT_COOLDOWN_SEC = 15 * 60;

const QUOTA_RE = /RESOURCE_EXHAUSTED \(code 429\)/;
const RESET_RE = /Resets in ((?:\d+h)?(?:\d+m)?(?:\d+s)?)\b/;

export interface QuotaInfo {
  resetText?: string;
  resetSeconds?: number;
}

export function parseResetDuration(text: string): number | undefined {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(text);
  if (!m || (!m[1] && !m[2] && !m[3])) return undefined;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  let out = "";
  if (h) out += `${h}h`;
  if (m) out += `${m}m`;
  if (sec || !out) out += `${sec}s`;
  return out;
}

export function detectQuota(log: string): QuotaInfo | null {
  if (!QUOTA_RE.test(log)) return null;
  const reset = RESET_RE.exec(log)?.[1];
  const resetSeconds = reset ? parseResetDuration(reset) : undefined;
  return { resetText: resetSeconds !== undefined ? reset : undefined, resetSeconds };
}

export class QuotaError extends Error {
  readonly resetSeconds?: number;
  readonly resetText?: string;

  constructor(
    readonly model: string | undefined,
    info: QuotaInfo,
  ) {
    const who = model ?? "agy's default model";
    const when = info.resetText ? ` Quota resets in ${info.resetText}.` : "";
    super(`Quota exhausted for ${who} (RESOURCE_EXHAUSTED 429).${when}`);
    this.name = "QuotaError";
    this.resetSeconds = info.resetSeconds;
    this.resetText = info.resetText;
  }
}

export class CooldownRegistry {
  private until = new Map<string, number>();

  constructor(private now: () => number = Date.now) {}

  set(model: string, resetSeconds: number | undefined): void {
    this.until.set(model, this.now() + (resetSeconds ?? DEFAULT_COOLDOWN_SEC) * 1000);
  }

  cooling(model: string): boolean {
    const t = this.until.get(model);
    return t !== undefined && t > this.now();
  }

  describe(model: string): string {
    const t = this.until.get(model);
    return formatDuration(t === undefined ? 0 : (t - this.now()) / 1000);
  }
}

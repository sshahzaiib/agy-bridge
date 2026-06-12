// Live e2e against the real agy CLI — run manually, not in CI:
//   npx vitest run test/e2e-quota.live.test.ts
// Requires a model with exhausted quota (Claude Sonnet as of 2026-06-13).
import { describe, it, expect } from "vitest";
import { runAgy } from "../src/runner.js";
import { QuotaError } from "../src/quota.js";
import { loadConfig } from "../src/config.js";

describe.skipIf(!process.env.AGY_E2E)("live quota detection", () => {
  it(
    "fails fast with QuotaError on an exhausted model instead of hanging",
    { timeout: 60_000 },
    async () => {
      const started = Date.now();
      const err = await runAgy(
        {
          prompt: "say ok",
          cwd: process.cwd(),
          model: "Claude Sonnet 4.6 (Thinking)",
          timeoutSec: 45,
        },
        loadConfig(),
      ).catch((e) => e as Error);

      const elapsed = (Date.now() - started) / 1000;
      expect(err).toBeInstanceOf(QuotaError);
      expect((err as QuotaError).resetSeconds).toBeGreaterThan(0);
      // the whole point: detection in seconds, not minutes
      expect(elapsed).toBeLessThan(30);
    },
  );
});

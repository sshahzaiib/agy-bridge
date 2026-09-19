import { describe, it, expect } from "vitest";
import { createSetupHandler } from "../src/server.js";
import type { Config } from "../src/config.js";

const cfg: Config = {
  agyPath: "agy",
  timeoutSec: 600,
  timeoutExplicit: false,
  perToolTimeouts: {},
  maxOutputChars: 50_000,
  defaultModel: undefined,
  skipPermissions: true,
  sandbox: false,
  onFailure: "fallback",
};

function jsonOf(res: { content: Array<{ type: string; text?: string }> }): Record<string, unknown> {
  return JSON.parse(res.content[0]?.text ?? "") as Record<string, unknown>;
}

describe("setup tool", () => {
  it("reports installed + version + auth when `agy --version` succeeds", async () => {
    // Given: a fake exec returning a version string.
    const handler = createSetupHandler(cfg, async () => ({ stdout: "1.0.15\n", stderr: "" }));
    // When: the setup tool runs.
    const res = await handler({});
    // Then: the JSON payload mirrors agy-run.sh cmd_check for an installed binary.
    const payload = jsonOf(res);
    expect(res.isError).toBeUndefined();
    expect(payload.installed).toBe(true);
    expect(payload.version).toBe("1.0.15");
    expect(payload.path).toBe("agy");
    expect(["api-key", "oauth", "missing"]).toContain(payload.auth);
    expect(payload.error).toBe("");
  });

  it("reports installed:false with a clear error on ENOENT (missing binary)", async () => {
    // Given: agy is not on PATH.
    const enoent = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    const handler = createSetupHandler({ ...cfg, agyPath: "/nope/agy" }, async () => {
      throw enoent;
    });
    // When: the setup tool runs.
    const res = await handler({});
    // Then: it reports not-installed without throwing.
    const payload = jsonOf(res);
    expect(res.isError).toBeUndefined();
    expect(payload.installed).toBe(false);
    expect(payload.path).toBe("");
    expect(payload.version).toBe("");
    expect(payload.auth).toBe("unknown");
    expect(String(payload.error)).toMatch(/not found|install/i);
  });

  it("takes only the first line of version output", async () => {
    const handler = createSetupHandler(cfg, async () => ({
      stdout: "1.2.3\nbuild 456\nextra\n",
      stderr: "",
    }));
    const payload = jsonOf(await handler({}));
    expect(payload.version).toBe("1.2.3");
  });
});

import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("returns defaults for empty env", () => {
    const c = loadConfig({});
    expect(c).toEqual({
      agyPath: "agy",
      timeoutSec: 1200,
      timeoutExplicit: false,
      perToolTimeouts: {},
      maxOutputChars: 50_000,
      defaultModel: undefined,
      skipPermissions: true,
      sandbox: false,
      onFailure: "fallback",
    });
  });

  it("reads overrides from env", () => {
    const c = loadConfig({
      AGY_PATH: "/opt/agy",
      AGY_TIMEOUT: "300",
      AGY_MAX_OUTPUT_CHARS: "1000",
      AGY_DEFAULT_MODEL: "Gemini 3.1 Pro (High)",
      AGY_SKIP_PERMISSIONS: "false",
      AGY_SANDBOX: "true",
    });
    expect(c.agyPath).toBe("/opt/agy");
    expect(c.timeoutSec).toBe(300);
    expect(c.timeoutExplicit).toBe(true);
    expect(c.maxOutputChars).toBe(1000);
    expect(c.defaultModel).toBe("Gemini 3.1 Pro (High)");
    expect(c.skipPermissions).toBe(false);
    expect(c.sandbox).toBe(true);
  });

  it("falls back to defaults on non-numeric values", () => {
    const c = loadConfig({ AGY_TIMEOUT: "abc", AGY_MAX_OUTPUT_CHARS: "-5" });
    expect(c.timeoutSec).toBe(1200);
    expect(c.timeoutExplicit).toBe(false);
    expect(c.maxOutputChars).toBe(50_000);
  });

  it("parses per-tool AGY_TIMEOUT_<TOOL> overrides", () => {
    const c = loadConfig({ AGY_TIMEOUT_DEEP_SEARCH: "300", AGY_TIMEOUT_DELEGATE: "900" });
    expect(c.perToolTimeouts).toEqual({ deep_search: 300, delegate: 900 });
  });

  it("ignores non-positive per-tool timeout values", () => {
    const c = loadConfig({ AGY_TIMEOUT_DEEP_SEARCH: "abc", AGY_TIMEOUT_DELEGATE: "-5" });
    expect(c.perToolTimeouts).toEqual({});
  });

  it("reads AGY_ON_FAILURE=strict", () => {
    expect(loadConfig({ AGY_ON_FAILURE: "strict" }).onFailure).toBe("strict");
  });

  it("treats unknown AGY_ON_FAILURE values as fallback", () => {
    expect(loadConfig({ AGY_ON_FAILURE: "explode" }).onFailure).toBe("fallback");
  });
});

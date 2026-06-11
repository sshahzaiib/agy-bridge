import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("returns defaults for empty env", () => {
    const c = loadConfig({});
    expect(c).toEqual({
      agyPath: "agy",
      timeoutSec: 1200,
      maxOutputChars: 50_000,
      defaultModel: undefined,
      skipPermissions: true,
      sandbox: false,
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
    expect(c.maxOutputChars).toBe(1000);
    expect(c.defaultModel).toBe("Gemini 3.1 Pro (High)");
    expect(c.skipPermissions).toBe(false);
    expect(c.sandbox).toBe(true);
  });

  it("falls back to defaults on non-numeric values", () => {
    const c = loadConfig({ AGY_TIMEOUT: "abc", AGY_MAX_OUTPUT_CHARS: "-5" });
    expect(c.timeoutSec).toBe(1200);
    expect(c.maxOutputChars).toBe(50_000);
  });
});

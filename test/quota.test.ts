import { describe, it, expect } from "vitest";
import {
  parseResetDuration,
  formatDuration,
  detectQuota,
  QuotaError,
  CooldownRegistry,
  DEFAULT_COOLDOWN_SEC,
} from "../src/quota.js";

const LOG_429 =
  'E0613 00:38:03.030151 56767 log.go:398] agent executor error: RESOURCE_EXHAUSTED (code 429): ' +
  "Individual quota reached. Contact your administrator to enable overages. Resets in 96h53m25s.: " +
  "RESOURCE_EXHAUSTED (code 429): Individual quota reached.";

describe("parseResetDuration", () => {
  it("parses full h/m/s durations", () => {
    expect(parseResetDuration("96h53m25s")).toBe(96 * 3600 + 53 * 60 + 25);
  });
  it("parses partial durations", () => {
    expect(parseResetDuration("4h24m")).toBe(4 * 3600 + 24 * 60);
    expect(parseResetDuration("30s")).toBe(30);
    expect(parseResetDuration("5m")).toBe(300);
  });
  it("returns undefined for garbage", () => {
    expect(parseResetDuration("soon")).toBeUndefined();
    expect(parseResetDuration("")).toBeUndefined();
  });
});

describe("formatDuration", () => {
  it("formats seconds into h/m/s", () => {
    expect(formatDuration(348805)).toBe("96h53m25s");
    expect(formatDuration(300)).toBe("5m");
    expect(formatDuration(0)).toBe("0s");
  });
});

describe("detectQuota", () => {
  it("detects a 429 line and extracts the reset time", () => {
    const q = detectQuota(LOG_429);
    expect(q).not.toBeNull();
    expect(q!.resetText).toBe("96h53m25s");
    expect(q!.resetSeconds).toBe(348805);
  });
  it("detects a 429 even without a reset time", () => {
    const q = detectQuota("RESOURCE_EXHAUSTED (code 429): quota reached");
    expect(q).not.toBeNull();
    expect(q!.resetSeconds).toBeUndefined();
  });
  it("returns null on a clean log", () => {
    expect(detectQuota("I0613 print mode: sending message\nall good")).toBeNull();
  });
});

describe("QuotaError", () => {
  it("carries model and reset info in the message", () => {
    const e = new QuotaError("Gemini 3.5 Flash (Medium)", { resetText: "4h24m", resetSeconds: 15840 });
    expect(e.message).toContain("Gemini 3.5 Flash (Medium)");
    expect(e.message).toContain("4h24m");
    expect(e.resetSeconds).toBe(15840);
  });
});

describe("CooldownRegistry", () => {
  it("marks a model as cooling until its reset time", () => {
    let now = 1_000_000;
    const reg = new CooldownRegistry(() => now);
    reg.set("ModelA", 60);
    expect(reg.cooling("ModelA")).toBe(true);
    expect(reg.cooling("ModelB")).toBe(false);
    now += 61_000;
    expect(reg.cooling("ModelA")).toBe(false);
  });

  it("falls back to a default cooldown when reset time is unknown", () => {
    let now = 0;
    const reg = new CooldownRegistry(() => now);
    reg.set("ModelA", undefined);
    now = (DEFAULT_COOLDOWN_SEC - 1) * 1000;
    expect(reg.cooling("ModelA")).toBe(true);
    now = (DEFAULT_COOLDOWN_SEC + 1) * 1000;
    expect(reg.cooling("ModelA")).toBe(false);
  });

  it("describes remaining cooldown", () => {
    const reg = new CooldownRegistry(() => 0);
    reg.set("ModelA", 3661);
    expect(reg.describe("ModelA")).toBe("1h1m1s");
  });
});

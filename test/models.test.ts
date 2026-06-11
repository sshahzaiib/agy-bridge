import { describe, it, expect } from "vitest";
import { parseModels, ModelRegistry } from "../src/models.js";

const LISTING = `Gemini 3.5 Flash (Medium)
Gemini 3.5 Flash (High)
Gemini 3.1 Pro (High)
`;

describe("parseModels", () => {
  it("returns one trimmed model per non-empty line", () => {
    expect(parseModels(LISTING)).toEqual([
      "Gemini 3.5 Flash (Medium)",
      "Gemini 3.5 Flash (High)",
      "Gemini 3.1 Pro (High)",
    ]);
  });

  it("strips a trailing ' (current)' marker", () => {
    expect(parseModels("Claude Opus 4.6 (Thinking) (current)\n")).toEqual([
      "Claude Opus 4.6 (Thinking)",
    ]);
  });
});

describe("ModelRegistry.resolve", () => {
  const registry = (out: string | Error) =>
    new ModelRegistry(async () => {
      if (out instanceof Error) throw out;
      return out;
    });

  it("uses explicit model when available", async () => {
    const r = await registry(LISTING).resolve({ explicit: "Gemini 3.1 Pro (High)", chain: [] });
    expect(r.model).toBe("Gemini 3.1 Pro (High)");
  });

  it("throws on explicit model not available, listing options", async () => {
    await expect(
      registry(LISTING).resolve({ explicit: "Nope", chain: [] }),
    ).rejects.toThrow(/Gemini 3.5 Flash \(Medium\)/);
  });

  it("picks first available model in chain", async () => {
    const r = await registry(LISTING).resolve({
      chain: ["Gemini 9.9 Ultra", "Gemini 3.5 Flash (High)"],
    });
    expect(r.model).toBe("Gemini 3.5 Flash (High)");
  });

  it("falls back to defaultModel when chain misses", async () => {
    const r = await registry(LISTING).resolve({
      chain: ["Gemini 9.9 Ultra"],
      defaultModel: "Gemini 3.5 Flash (Medium)",
    });
    expect(r.model).toBe("Gemini 3.5 Flash (Medium)");
  });

  it("returns undefined model when nothing matches", async () => {
    const r = await registry(LISTING).resolve({ chain: ["X"], defaultModel: "Y" });
    expect(r.model).toBeUndefined();
  });

  it("degrades when agy models fails: explicit passes through, chain yields undefined + note", async () => {
    const reg = registry(new Error("boom"));
    const a = await reg.resolve({ explicit: "Whatever", chain: [] });
    expect(a.model).toBe("Whatever");
    const b = await reg.resolve({ chain: ["Gemini 3.5 Flash (High)"] });
    expect(b.model).toBeUndefined();
    expect(b.note).toMatch(/could not list/i);
  });

  it("caches the listing across calls", async () => {
    let calls = 0;
    const reg = new ModelRegistry(async () => {
      calls++;
      return LISTING;
    });
    await reg.resolve({ chain: ["Gemini 3.5 Flash (High)"] });
    await reg.resolve({ chain: ["Gemini 3.1 Pro (High)"] });
    expect(calls).toBe(1);
  });
});

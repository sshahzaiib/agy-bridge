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
    await expect(registry(LISTING).resolve({ explicit: "Nope", chain: [] })).rejects.toThrow(
      /Gemini 3.5 Flash \(Medium\)/,
    );
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

  it("resolveChain returns every available chain model in order, then defaultModel", async () => {
    const r = await registry(LISTING).resolveChain({
      chain: ["Gemini 9.9 Ultra", "Gemini 3.5 Flash (Medium)", "Gemini 3.5 Flash (High)"],
      defaultModel: "Gemini 3.1 Pro (High)",
    });
    expect(r.models).toEqual([
      "Gemini 3.5 Flash (Medium)",
      "Gemini 3.5 Flash (High)",
      "Gemini 3.1 Pro (High)",
    ]);
  });

  it("resolveChain with explicit model returns just that model", async () => {
    const r = await registry(LISTING).resolveChain({
      explicit: "Gemini 3.1 Pro (High)",
      chain: ["Gemini 3.5 Flash (High)"],
    });
    expect(r.models).toEqual(["Gemini 3.1 Pro (High)"]);
  });

  it("resolveChain yields [undefined] + note when nothing matches or listing fails", async () => {
    const a = await registry(LISTING).resolveChain({ chain: ["X"], defaultModel: "Y" });
    expect(a.models).toEqual([undefined]);
    expect(a.note).toMatch(/no preferred model/i);
    const b = await registry(new Error("boom")).resolveChain({ chain: ["X"] });
    expect(b.models).toEqual([undefined]);
    expect(b.note).toMatch(/could not list/i);
  });

  it("fetches the listing only once under concurrent calls", async () => {
    let calls = 0;
    const reg = new ModelRegistry(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return LISTING;
    });
    const [a, b] = await Promise.all([
      reg.resolveChain({ chain: ["Gemini 3.5 Flash (High)"] }),
      reg.resolveChain({ chain: ["Gemini 3.1 Pro (High)"] }),
    ]);
    expect(calls).toBe(1);
    expect(a.models).toEqual(["Gemini 3.5 Flash (High)"]);
    expect(b.models).toEqual(["Gemini 3.1 Pro (High)"]);
  });

  it("retries the listing after a transient failure instead of caching null forever", async () => {
    let calls = 0;
    const reg = new ModelRegistry(async () => {
      if (++calls === 1) throw new Error("transient");
      return LISTING;
    });
    const a = await reg.resolveChain({ chain: ["Gemini 3.1 Pro (High)"] });
    expect(a.models).toEqual([undefined]);
    const b = await reg.resolveChain({ chain: ["Gemini 3.1 Pro (High)"] });
    expect(b.models).toEqual(["Gemini 3.1 Pro (High)"]);
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

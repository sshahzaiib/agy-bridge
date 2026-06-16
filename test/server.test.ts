import { describe, it, expect } from "vitest";
import { createToolHandler } from "../src/server.js";
import { ModelRegistry } from "../src/models.js";
import { TOOLS } from "../src/tools.js";
import { CooldownRegistry } from "../src/quota.js";
import type { Config } from "../src/config.js";
import type { ChildHandle, RunnerDeps } from "../src/runner.js";

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

const LISTING = "Gemini 3.5 Flash (Medium)\nGemini 3.5 Flash (High)\nGemini 3.1 Pro (High)\n";

const LOG_429 =
  "E0613 log.go:398] agent executor error: RESOURCE_EXHAUSTED (code 429): " +
  "Individual quota reached. Resets in 4h24m.";

interface Run {
  args: string[];
}

/**
 * Fake runner deps: `quotaModels` lists models whose runs hit a 429 in the log;
 * everything else answers normally. Records every spawn's args.
 */
function fakeDeps(quotaModels: string[] = []) {
  const runs: Run[] = [];
  let currentQuota = false;

  const deps: RunnerDeps = {
    spawnChild: (_file, args) => {
      runs.push({ args });
      const i = args.indexOf("--model");
      currentQuota = i !== -1 && quotaModels.includes(args[i + 1]);
      const quota = currentQuota;
      const child: ChildHandle = {
        stdout: () => (quota ? "" : "the answer"),
        stderr: () => "",
        wait: () => Promise.resolve({ code: 0 }),
        kill: () => {},
      };
      return child;
    },
    readLog: async () => (currentQuota ? LOG_429 : ""),
    removeLog: async () => {},
    readSessionsFile: async () => JSON.stringify({ [process.cwd()]: "sess-1" }),
    makeLogPath: () => "/tmp/agy-bridge-test.log",
    pollMs: 5,
    graceMs: 20,
    killGraceMs: 5,
  };

  return { deps, runs, modelOf: (r: Run) => r.args[r.args.indexOf("--model") + 1] };
}

function handlerFor(
  name: string,
  f: ReturnType<typeof fakeDeps>,
  overrides: Partial<Config> = {},
  cooldowns = new CooldownRegistry(),
) {
  return createToolHandler(
    TOOLS.find((t) => t.name === name)!,
    { ...cfg, ...overrides },
    new ModelRegistry(async () => LISTING),
    f.deps,
    cooldowns,
  );
}

describe("createToolHandler", () => {
  it("runs delegate and appends model + session footer", async () => {
    const f = fakeDeps();
    const res = await handlerFor("delegate", f)({ prompt: "do x" });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("the answer");
    expect(text).toContain("Gemini 3.5 Flash (High)");
    expect(text).toContain("sess-1");
    expect(f.runs[0].args).toContain("--model");
  });

  it("follow_up passes --conversation and no --model", async () => {
    const f = fakeDeps();
    await handlerFor("follow_up", f)({ session_id: "abc", question: "more?" });
    expect(f.runs[0].args).toContain("--conversation");
    expect(f.runs[0].args).toContain("abc");
    expect(f.runs[0].args).not.toContain("--model");
  });

  it("uses the per-tool timeout for --print-timeout", async () => {
    const f = fakeDeps();
    await handlerFor("web_lookup", f)({ query: "docs" });
    const args = f.runs[0].args;
    const tool = TOOLS.find((t) => t.name === "web_lookup")!;
    expect(args[args.indexOf("--print-timeout") + 1]).toBe(`${tool.timeoutSec}s`);
  });

  it("explicit AGY_TIMEOUT overrides per-tool timeouts", async () => {
    const f = fakeDeps();
    await handlerFor("web_lookup", f, { timeoutSec: 900, timeoutExplicit: true })({ query: "q" });
    const args = f.runs[0].args;
    expect(args[args.indexOf("--print-timeout") + 1]).toBe("900s");
  });

  it("per-tool AGY_TIMEOUT_<TOOL> overrides only that tool", async () => {
    const f = fakeDeps();
    const cfg = { perToolTimeouts: { deep_search: 300 } };
    await handlerFor("deep_search", f, cfg)({ query: "q" });
    expect(f.runs[0].args[f.runs[0].args.indexOf("--print-timeout") + 1]).toBe("300s");
    // a tool without an override keeps its default
    await handlerFor("web_lookup", f, cfg)({ query: "q" });
    const tool = TOOLS.find((t) => t.name === "web_lookup")!;
    expect(f.runs[1].args[f.runs[1].args.indexOf("--print-timeout") + 1]).toBe(`${tool.timeoutSec}s`);
  });

  it("per-tool override wins over explicit global AGY_TIMEOUT", async () => {
    const f = fakeDeps();
    const cfg = { timeoutSec: 900, timeoutExplicit: true, perToolTimeouts: { deep_search: 300 } };
    await handlerFor("deep_search", f, cfg)({ query: "q" });
    expect(f.runs[0].args[f.runs[0].args.indexOf("--print-timeout") + 1]).toBe("300s");
  });

  it("fails over to the next chain model on quota exhaustion", async () => {
    const f = fakeDeps(["Gemini 3.5 Flash (Medium)"]);
    const res = await handlerFor("web_lookup", f)({ query: "docs" });
    const text = (res.content[0] as { text: string }).text;
    expect(res.isError).toBeUndefined();
    expect(f.runs).toHaveLength(2);
    expect(f.modelOf(f.runs[0])).toBe("Gemini 3.5 Flash (Medium)");
    expect(f.modelOf(f.runs[1])).toBe("Gemini 3.5 Flash (High)");
    expect(text).toContain("the answer");
    expect(text).toContain("model: Gemini 3.5 Flash (High)");
    expect(text).toMatch(/failover.*Gemini 3.5 Flash \(Medium\).*quota/i);
  });

  it("skips cooled-down models on subsequent calls without spawning them", async () => {
    const f = fakeDeps(["Gemini 3.5 Flash (Medium)"]);
    const cooldowns = new CooldownRegistry();
    const handler = handlerFor("web_lookup", f, {}, cooldowns);
    await handler({ query: "first" });
    expect(f.runs).toHaveLength(2);
    await handler({ query: "second" });
    expect(f.runs).toHaveLength(3);
    expect(f.modelOf(f.runs[2])).toBe("Gemini 3.5 Flash (High)");
  });

  it("errors with reset times when every chain model is quota-exhausted", async () => {
    const f = fakeDeps(["Gemini 3.5 Flash (Medium)", "Gemini 3.5 Flash (High)"]);
    const res = await handlerFor("web_lookup", f)({ query: "docs" });
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toMatch(/quota/i);
    expect(text).toContain("Gemini 3.5 Flash (Medium)");
    expect(text).toContain("Gemini 3.5 Flash (High)");
    expect(text).toContain("4h24m");
  });

  it("returns isError content on failure instead of throwing", async () => {
    const f = fakeDeps();
    f.deps.spawnChild = () => {
      throw new Error("kaboom");
    };
    const res = await handlerFor("delegate", f)({ prompt: "x" });
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("kaboom");
    expect(text).not.toContain("Do NOT perform this work yourself");
  });

  it("strict mode appends do-not-fallback instruction to errors", async () => {
    const f = fakeDeps();
    f.deps.spawnChild = () => {
      throw new Error("kaboom");
    };
    const res = await handlerFor("delegate", f, { onFailure: "strict" })({ prompt: "x" });
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("kaboom");
    expect(text).toContain("Do NOT perform this work yourself");
  });

  it("forwards the MCP abort signal to the runner", async () => {
    const f = fakeDeps();
    const ac = new AbortController();
    ac.abort();
    const res = await handlerFor("delegate", f)({ prompt: "x" }, { signal: ac.signal });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/cancelled/i);
  });
});

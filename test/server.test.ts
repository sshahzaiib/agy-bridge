import { describe, it, expect } from "vitest";
import { createToolHandler } from "../src/server.js";
import { ModelRegistry } from "../src/models.js";
import { TOOLS } from "../src/tools.js";
import type { Config } from "../src/config.js";
import type { RunnerDeps } from "../src/runner.js";

const cfg: Config = {
  agyPath: "agy",
  timeoutSec: 600,
  maxOutputChars: 50_000,
  defaultModel: undefined,
  skipPermissions: true,
  sandbox: false,
  onFailure: "fallback",
};

const LISTING = "Gemini 3.5 Flash (High)\nGemini 3.1 Pro (High)\n";

function deps(capture: { args?: string[] }): RunnerDeps {
  return {
    exec: async (_file, args) => {
      capture.args = args;
      return { stdout: "the answer", stderr: "" };
    },
    readSessionsFile: async () => JSON.stringify({ [process.cwd()]: "sess-1" }),
  };
}

describe("createToolHandler", () => {
  it("runs delegate and appends model + session footer", async () => {
    const capture: { args?: string[] } = {};
    const handler = createToolHandler(
      TOOLS.find((t) => t.name === "delegate")!,
      cfg,
      new ModelRegistry(async () => LISTING),
      deps(capture),
    );
    const res = await handler({ prompt: "do x" });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("the answer");
    expect(text).toContain("Gemini 3.5 Flash (High)");
    expect(text).toContain("sess-1");
    expect(capture.args).toContain("--model");
  });

  it("follow_up passes --conversation and no --model", async () => {
    const capture: { args?: string[] } = {};
    const handler = createToolHandler(
      TOOLS.find((t) => t.name === "follow_up")!,
      cfg,
      new ModelRegistry(async () => LISTING),
      deps(capture),
    );
    await handler({ session_id: "abc", question: "more?" });
    expect(capture.args).toContain("--conversation");
    expect(capture.args).toContain("abc");
    expect(capture.args).not.toContain("--model");
  });

  it("returns isError content on failure instead of throwing", async () => {
    const handler = createToolHandler(
      TOOLS.find((t) => t.name === "delegate")!,
      cfg,
      new ModelRegistry(async () => LISTING),
      {
        exec: async () => {
          throw new Error("kaboom");
        },
        readSessionsFile: async () => "{}",
      },
    );
    const res = await handler({ prompt: "x" });
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("kaboom");
    expect(text).not.toContain("Do NOT perform this work yourself");
  });

  it("strict mode appends do-not-fallback instruction to errors", async () => {
    const handler = createToolHandler(
      TOOLS.find((t) => t.name === "delegate")!,
      { ...cfg, onFailure: "strict" },
      new ModelRegistry(async () => LISTING),
      {
        exec: async () => {
          throw new Error("kaboom");
        },
        readSessionsFile: async () => "{}",
      },
    );
    const res = await handler({ prompt: "x" });
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("kaboom");
    expect(text).toContain("Do NOT perform this work yourself");
  });
});

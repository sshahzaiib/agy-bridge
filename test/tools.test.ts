import { describe, it, expect } from "vitest";
import path from "node:path";
import { TOOLS, resolveFiles, SESSION_TRANSFER_TOOL } from "../src/tools.js";

describe("TOOLS", () => {
  it("defines the eight runAgy tools", () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual([
      "adversarial_review",
      "analyze_files",
      "deep_search",
      "delegate",
      "follow_up",
      "image_gen",
      "pre_finish_review",
      "web_lookup",
    ]);
  });

  it("exposes session_transfer as a standalone ToolDef (not a runAgy tool)", () => {
    expect(SESSION_TRANSFER_TOOL.name).toBe("session_transfer");
    expect(SESSION_TRANSFER_TOOL.schema).toHaveProperty("cwd");
    expect(TOOLS.find((t) => t.name === "session_transfer")).toBeUndefined();
  });

  it("every tool except follow_up has a non-empty model chain", () => {
    for (const t of TOOLS) {
      if (t.name === "follow_up") expect(t.chain).toEqual([]);
      else expect(t.chain.length).toBeGreaterThan(0);
    }
  });

  it("every tool has a sane per-tool timeout", () => {
    for (const t of TOOLS) {
      expect(t.timeoutSec).toBeGreaterThan(0);
      expect(t.timeoutSec).toBeLessThanOrEqual(600);
    }
  });

  it("web_lookup fails fast (well under the old 20-minute default)", () => {
    expect(TOOLS.find((t) => t.name === "web_lookup")!.timeoutSec).toBeLessThanOrEqual(180);
  });
});

describe("resolveFiles", () => {
  it("resolves relative paths against cwd, keeps absolute", () => {
    expect(resolveFiles(["a.ts", "/abs/b.ts"], "/repo")).toEqual([
      path.resolve("/repo", "a.ts"),
      "/abs/b.ts",
    ]);
  });
});

describe("prompt templates", () => {
  const get = (name: string) => TOOLS.find((t) => t.name === name)!;

  it("analyze_files lists absolute paths and the question", () => {
    const p = get("analyze_files").buildPrompt(
      { files: ["x.log"], question: "find errors" },
      "/repo",
    );
    expect(p).toContain(path.resolve("/repo", "x.log"));
    expect(p).toContain("find errors");
    expect(p).toMatch(/file:line/);
  });

  it("adversarial_review accepts inline content", () => {
    const p = get("adversarial_review").buildPrompt(
      { content: "plan text", focus: "security" },
      "/repo",
    );
    expect(p).toContain("plan text");
    expect(p).toContain("security");
    expect(p).toMatch(/severity/i);
  });

  it("adversarial_review requires content or files", () => {
    expect(() => get("adversarial_review").buildPrompt({}, "/repo")).toThrow(/content.*files/i);
  });

  it("pre_finish_review builds an adversarial-review prompt from content + focus", () => {
    const p = get("pre_finish_review").buildPrompt(
      { content: "diff --git a/x b/x", focus: "concurrency" },
      "/repo",
    );
    expect(p).toContain("diff --git a/x b/x");
    expect(p).toContain("concurrency");
    expect(p).toMatch(/severity/i);
  });

  it("pre_finish_review requires content or files", () => {
    expect(() => get("pre_finish_review").buildPrompt({}, "/repo")).toThrow(/content.*files/i);
  });

  it("follow_up passes the question through verbatim", () => {
    expect(get("follow_up").buildPrompt({ question: "and then?" }, "/repo")).toBe("and then?");
  });

  it("delegate passes the prompt through verbatim", () => {
    expect(get("delegate").buildPrompt({ prompt: "do x" }, "/repo")).toBe("do x");
  });
});

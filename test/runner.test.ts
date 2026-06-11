import { describe, it, expect } from "vitest";
import { buildArgs, truncate, runAgy, execWithClosedStdin, type ExecFn } from "../src/runner.js";
import type { Config } from "../src/config.js";

const cfg: Config = {
  agyPath: "agy",
  timeoutSec: 600,
  maxOutputChars: 100,
  defaultModel: undefined,
  skipPermissions: true,
  sandbox: false,
};

describe("buildArgs", () => {
  it("builds full arg list", () => {
    expect(
      buildArgs({ prompt: "hi", cwd: "/repo", model: "Gemini 3.1 Pro (High)" }, cfg),
    ).toEqual([
      "--dangerously-skip-permissions",
      "--add-dir", "/repo",
      "--model", "Gemini 3.1 Pro (High)",
      "--print-timeout", "600s",
      "-p", "hi",
    ]);
  });

  it("omits model when undefined, adds --conversation and --sandbox when set", () => {
    const args = buildArgs(
      { prompt: "q", cwd: "/repo", conversationId: "abc-123" },
      { ...cfg, sandbox: true, skipPermissions: false },
    );
    expect(args).toEqual([
      "--sandbox",
      "--add-dir", "/repo",
      "--conversation", "abc-123",
      "--print-timeout", "600s",
      "-p", "q",
    ]);
  });
});

describe("truncate", () => {
  it("passes short output through", () => {
    expect(truncate("short", 100)).toEqual({ text: "short", truncated: false });
  });
  it("cuts long output with a notice", () => {
    const r = truncate("x".repeat(150), 100);
    expect(r.truncated).toBe(true);
    expect(r.text).toContain("x".repeat(100));
    expect(r.text).toMatch(/truncated at 100.*150/s);
  });
});

describe("execWithClosedStdin", () => {
  it("closes child stdin so stdin-reading commands exit instead of hanging", async () => {
    // cat with an open stdin pipe never exits; this would time out without the fix
    const r = await execWithClosedStdin("cat", [], {
      cwd: process.cwd(),
      timeout: 5000,
      maxBuffer: 1024,
    });
    expect(r.stdout).toBe("");
  });
});

describe("runAgy", () => {
  const sessions = JSON.stringify({ "/repo": "sess-42" });

  it("returns output and session id", async () => {
    const exec: ExecFn = async () => ({ stdout: "answer\n", stderr: "" });
    const r = await runAgy({ prompt: "q", cwd: "/repo" }, cfg, {
      exec,
      readSessionsFile: async () => sessions,
    });
    expect(r.output).toBe("answer");
    expect(r.sessionId).toBe("sess-42");
  });

  it("omits session id when file unreadable", async () => {
    const r = await runAgy({ prompt: "q", cwd: "/repo" }, cfg, {
      exec: async () => ({ stdout: "ok", stderr: "" }),
      readSessionsFile: async () => {
        throw new Error("no file");
      },
    });
    expect(r.sessionId).toBeUndefined();
  });

  it("throws install guidance on ENOENT", async () => {
    const exec: ExecFn = async () => {
      const e = new Error("spawn agy ENOENT") as NodeJS.ErrnoException;
      e.code = "ENOENT";
      throw e;
    };
    await expect(
      runAgy({ prompt: "q", cwd: "/repo" }, cfg, { exec, readSessionsFile: async () => "{}" }),
    ).rejects.toThrow(/not found.*antigravity/is);
  });

  it("surfaces stderr on failure", async () => {
    const exec: ExecFn = async () => {
      const e = new Error("exit 1") as Error & { stderr?: string };
      e.stderr = "auth expired";
      throw e;
    };
    await expect(
      runAgy({ prompt: "q", cwd: "/repo" }, cfg, { exec, readSessionsFile: async () => "{}" }),
    ).rejects.toThrow(/auth expired/);
  });
});

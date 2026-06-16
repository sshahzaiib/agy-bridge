import { describe, it, expect } from "vitest";
import {
  buildArgs,
  truncate,
  runAgy,
  execWithClosedStdin,
  type ChildHandle,
  type RunnerDeps,
} from "../src/runner.js";
import { QuotaError } from "../src/quota.js";
import type { Config } from "../src/config.js";

const cfg: Config = {
  agyPath: "agy",
  timeoutSec: 600,
  timeoutExplicit: false,
  perToolTimeouts: {},
  maxOutputChars: 100,
  defaultModel: undefined,
  skipPermissions: true,
  sandbox: false,
  onFailure: "fallback",
};

const LOG_429 =
  "E0613 log.go:398] agent executor error: RESOURCE_EXHAUSTED (code 429): " +
  "Individual quota reached. Resets in 4h24m.";

interface FakeOpts {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  spawnError?: NodeJS.ErrnoException;
  neverExit?: boolean;
  log?: string;
}

function fakeDeps(opts: FakeOpts = {}) {
  const kills: string[] = [];
  const removed: string[] = [];
  let capturedArgs: string[] | undefined;

  const child: ChildHandle = {
    stdout: () => opts.stdout ?? "",
    stderr: () => opts.stderr ?? "",
    wait: () =>
      opts.neverExit
        ? new Promise(() => {})
        : Promise.resolve({ code: opts.exitCode ?? 0, error: opts.spawnError }),
    kill: (sig) => {
      kills.push(sig);
    },
  };

  const deps: RunnerDeps = {
    spawnChild: (_file, args) => {
      capturedArgs = args;
      return child;
    },
    readLog: async () => opts.log ?? "",
    removeLog: async (p) => {
      removed.push(p);
    },
    readSessionsFile: async () => JSON.stringify({ "/repo": "sess-42" }),
    makeLogPath: () => "/tmp/agy-bridge-test.log",
    pollMs: 5,
    graceMs: 20,
    killGraceMs: 5,
  };

  return { deps, kills, removed, args: () => capturedArgs };
}

describe("buildArgs", () => {
  it("builds full arg list with log file and per-request timeout", () => {
    expect(
      buildArgs(
        { prompt: "hi", cwd: "/repo", model: "Gemini 3.1 Pro (High)", timeoutSec: 120 },
        cfg,
        "/tmp/run.log",
      ),
    ).toEqual([
      "--dangerously-skip-permissions",
      "--add-dir", "/repo",
      "--log-file", "/tmp/run.log",
      "--model", "Gemini 3.1 Pro (High)",
      "--print-timeout", "120s",
      "-p", "hi",
    ]);
  });

  it("falls back to cfg timeout; adds --conversation and --sandbox when set", () => {
    const args = buildArgs(
      { prompt: "q", cwd: "/repo", conversationId: "abc-123" },
      { ...cfg, sandbox: true, skipPermissions: false },
      "/tmp/run.log",
    );
    expect(args).toEqual([
      "--sandbox",
      "--add-dir", "/repo",
      "--log-file", "/tmp/run.log",
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
    const r = await execWithClosedStdin("cat", [], {
      cwd: process.cwd(),
      timeout: 5000,
      maxBuffer: 1024,
    });
    expect(r.stdout).toBe("");
  });
});

describe("runAgy", () => {
  it("returns output and session id, and removes the run log", async () => {
    const f = fakeDeps({ stdout: "answer\n" });
    const r = await runAgy({ prompt: "q", cwd: "/repo" }, cfg, f.deps);
    expect(r.output).toBe("answer");
    expect(r.sessionId).toBe("sess-42");
    expect(f.removed).toEqual(["/tmp/agy-bridge-test.log"]);
  });

  it("omits session id when file unreadable", async () => {
    const f = fakeDeps({ stdout: "ok" });
    f.deps.readSessionsFile = async () => {
      throw new Error("no file");
    };
    const r = await runAgy({ prompt: "q", cwd: "/repo" }, cfg, f.deps);
    expect(r.sessionId).toBeUndefined();
  });

  it("kills the child and throws QuotaError when the log shows a 429", async () => {
    const f = fakeDeps({ neverExit: true, log: LOG_429 });
    await expect(
      runAgy({ prompt: "q", cwd: "/repo", model: "Gemini 3.5 Flash (Medium)" }, cfg, f.deps),
    ).rejects.toThrow(QuotaError);
    expect(f.kills).toContain("SIGTERM");
  });

  it("includes the reset time in the QuotaError", async () => {
    const f = fakeDeps({ neverExit: true, log: LOG_429 });
    const err = (await runAgy({ prompt: "q", cwd: "/repo", model: "M" }, cfg, f.deps).catch(
      (e) => e,
    )) as QuotaError;
    expect(err).toBeInstanceOf(QuotaError);
    expect(err.resetSeconds).toBe(4 * 3600 + 24 * 60);
  });

  it("times out and rejects even if the child never exits (held pipes)", async () => {
    const f = fakeDeps({ neverExit: true });
    await expect(
      runAgy({ prompt: "q", cwd: "/repo", timeoutSec: 0.05 }, cfg, f.deps),
    ).rejects.toThrow(/timed out after/);
    expect(f.kills).toContain("SIGTERM");
  });

  it("escalates to SIGKILL when the child survives SIGTERM", async () => {
    const f = fakeDeps({ neverExit: true });
    await expect(
      runAgy({ prompt: "q", cwd: "/repo", timeoutSec: 0.05 }, cfg, f.deps),
    ).rejects.toThrow(/timed out/);
    await new Promise((r) => setTimeout(r, 25)); // killGraceMs is 5 in fakes
    expect(f.kills).toContain("SIGKILL");
  });

  it("kills the child and rejects when the abort signal fires", async () => {
    const f = fakeDeps({ neverExit: true });
    const ac = new AbortController();
    const p = runAgy({ prompt: "q", cwd: "/repo", signal: ac.signal }, cfg, f.deps);
    setTimeout(() => ac.abort(), 10);
    await expect(p).rejects.toThrow(/cancelled/i);
    expect(f.kills.length).toBeGreaterThan(0);
  });

  it("treats empty output with a quota log as QuotaError, not success", async () => {
    const f = fakeDeps({ stdout: "", exitCode: 0, log: "early\n" });
    // quota line appears only when checked after exit
    let calls = 0;
    f.deps.readLog = async () => (++calls > 0 ? LOG_429 : "");
    await expect(
      runAgy({ prompt: "q", cwd: "/repo", model: "M" }, cfg, f.deps),
    ).rejects.toThrow(QuotaError);
  });

  it("treats empty output with a clean log as an error, not success", async () => {
    const f = fakeDeps({ stdout: "", exitCode: 0 });
    await expect(runAgy({ prompt: "q", cwd: "/repo" }, cfg, f.deps)).rejects.toThrow(
      /empty output/i,
    );
  });

  it("throws install guidance on ENOENT", async () => {
    const e = new Error("spawn agy ENOENT") as NodeJS.ErrnoException;
    e.code = "ENOENT";
    const f = fakeDeps({ spawnError: e, exitCode: null });
    await expect(runAgy({ prompt: "q", cwd: "/repo" }, cfg, f.deps)).rejects.toThrow(
      /not found.*antigravity/is,
    );
  });

  it("surfaces stderr on non-zero exit", async () => {
    const f = fakeDeps({ exitCode: 1, stderr: "auth expired" });
    await expect(runAgy({ prompt: "q", cwd: "/repo" }, cfg, f.deps)).rejects.toThrow(
      /auth expired/,
    );
  });
});

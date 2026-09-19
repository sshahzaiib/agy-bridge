import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";
import {
  treeKill,
  defaultDeps,
  type ChildHandle,
  type RunnerDeps,
  type TreeKillExecFn,
} from "../src/runner.js";
import {
  createJobStore,
  runAgyBackground,
  cancelJob,
  scanOrphans,
  type JobStoreDeps,
  type JobRecord,
} from "../src/jobs.js";
import {
  createToolHandler,
  createJobResultHandler,
  createJobStatusHandler,
} from "../src/server.js";
import { ModelRegistry } from "../src/models.js";
import { TOOLS } from "../src/tools.js";
import { CooldownRegistry } from "../src/quota.js";
import type { Config } from "../src/config.js";

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

const LISTING = "Gemini 3.5 Flash (High)\n";

/**
 * In-memory JobStoreDeps: tracks temp writes per-path and applies the temp
 * content to the "file" only on rename (mirrors real atomic temp+rename). No
 * real filesystem touched — deterministic and inspectable.
 */
function memDeps(initial: JobRecord[] = []) {
  let content = JSON.stringify(initial);
  const temps = new Map<string, string>();
  const writeCalls: { path: string; data: string }[] = [];
  const renameCalls: { src: string; dest: string }[] = [];
  const deps: JobStoreDeps = {
    storePath: "/mem/jobs.json",
    readFile: async () => content,
    writeFile: async (p, data) => {
      temps.set(p, data);
      writeCalls.push({ path: p, data });
    },
    rename: async (src, dest) => {
      renameCalls.push({ src, dest });
      const t = temps.get(src);
      if (t !== undefined) content = t;
    },
    mkdir: async () => {},
  };
  return {
    deps,
    renameCalls,
    writeCalls,
    read: () => content,
  };
}

/** Poll `fn` until it returns a non-nullish value or `ms` elapses (for fire-and-forget completion). */
async function waitFor<T>(
  fn: () => Promise<T | undefined> | (T | undefined),
  ms = 1000,
  step = 10,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined && v !== null) return v;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, step));
  }
}

describe("treeKill", () => {
  it("Windows branch invokes taskkill with /PID <pid> /T /F", async () => {
    const calls: { file: string; args: string[] }[] = [];
    const exec: TreeKillExecFn = async (file, args) => {
      calls.push({ file, args });
      return { stdout: "", stderr: "" };
    };
    await treeKill(4321, "SIGTERM", exec, "win32");
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe("taskkill");
    expect(calls[0].args).toEqual(["/PID", "4321", "/T", "/F"]);
  });

  it("Windows branch swallows a taskkill failure (process already gone)", async () => {
    const exec: TreeKillExecFn = async () => {
      throw new Error("not running");
    };
    await expect(treeKill(4321, "SIGTERM", exec, "win32")).resolves.toBeUndefined();
  });

  it("POSIX branch kills the whole process group via process.kill(-pid, signal)", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const exec: TreeKillExecFn = async () => {
      throw new Error("exec must NOT be called on POSIX");
    };
    await treeKill(1234, "SIGTERM", exec, "linux");
    expect(killSpy).toHaveBeenCalledWith(-1234, "SIGTERM");
    killSpy.mockRestore();
  });

  it("POSIX branch falls back to child-only kill when the group is gone", async () => {
    let first = true;
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      if (first) {
        first = false;
        throw new Error("ESRCH");
      }
      return true;
    });
    await treeKill(1234, "SIGTERM", async () => ({ stdout: "", stderr: "" }), "linux");
    expect(killSpy).toHaveBeenCalledTimes(2);
    expect(killSpy).toHaveBeenNthCalledWith(1, -1234, "SIGTERM");
    expect(killSpy).toHaveBeenNthCalledWith(2, 1234, "SIGTERM");
    killSpy.mockRestore();
  });
});

describe("createJobStore", () => {
  it("upsert then get round-trips a record; load returns [] when missing", async () => {
    const mem = memDeps();
    const store = createJobStore(mem.deps);
    await store.upsert({
      id: "j1",
      status: "running",
      cwd: "/r",
      prompt: "p",
      startedAt: "t",
    });
    expect(await store.get("j1")).toMatchObject({ id: "j1", status: "running" });
    expect(await store.get("missing")).toBeUndefined();
  });

  it("load() returns [] when the file is unreadable", async () => {
    const deps: JobStoreDeps = {
      ...memDeps().deps,
      readFile: async () => {
        throw new Error("ENOENT");
      },
    };
    expect(await createJobStore(deps).load()).toEqual([]);
  });

  it("every write goes through a temp file + rename (atomic)", async () => {
    const mem = memDeps();
    const store = createJobStore(mem.deps);
    await store.upsert({ id: "j1", status: "done", cwd: "/r", prompt: "p", startedAt: "t" });
    expect(mem.writeCalls).toHaveLength(1);
    expect(mem.renameCalls).toHaveLength(1);
    expect(mem.writeCalls[0].path).toMatch(/\.tmp$/);
    expect(mem.renameCalls[0].dest).toBe("/mem/jobs.json");
  });

  it("concurrent upserts do not corrupt the store (serialized RMW)", async () => {
    const mem = memDeps();
    const store = createJobStore(mem.deps);
    const N = 50;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        store.upsert({
          id: `j${i}`,
          status: "done",
          cwd: "/r",
          prompt: `p${i}`,
          startedAt: "t",
        }),
      ),
    );
    // every write went through its own temp+rename (no in-place final writes)
    expect(mem.renameCalls).toHaveLength(N);
    // order is non-deterministic under concurrency — assert by SET: exactly N
    // distinct ids, no losses, no duplicates (the real "no corruption" check).
    const ids = (JSON.parse(mem.read()) as JobRecord[]).map((r) => r.id);
    expect(ids).toHaveLength(N);
    expect(new Set(ids).size).toBe(N);
    expect(new Set(ids)).toEqual(new Set(Array.from({ length: N }, (_, i) => `j${i}`)));
  });
});

describe("runAgyBackground", () => {
  /**
   * RunnerDeps whose child wait() is gated by a deferred the test resolves.
   * Necessary because a pre-resolved wait() lets the fire-and-forget runP
   * overwrite the record to `done` before the test can observe `running`.
   */
  function agyDeps(opts: { pid?: number; stdout?: string; sessionKey?: string }): {
    deps: RunnerDeps;
    resolve: (code?: number) => void;
  } {
    let resolveWait!: (r: { code: number | null }) => void;
    const waitP = new Promise<{ code: number | null }>((r) => {
      resolveWait = r;
    });
    const child: ChildHandle = {
      stdout: () => opts.stdout ?? "the answer\n",
      stderr: () => "",
      pid: () => opts.pid,
      wait: () => waitP,
      kill: () => {},
    };
    const deps: RunnerDeps = {
      spawnChild: () => child,
      readLog: async () => "",
      removeLog: async () => {},
      readSessionsFile: async () =>
        // runAgy resolves the session key with path.resolve(cwd); mirror that
        // so the fixture matches on POSIX (/repo) and Windows (C:\repo).
        JSON.stringify({ [path.resolve(opts.sessionKey ?? "/repo")]: "sess-99" }),
      makeLogPath: () => "/tmp/bg.log",
      pollMs: 5,
      graceMs: 20,
      killGraceMs: 5,
    };
    return { deps, resolve: (code = 0) => resolveWait({ code }) };
  }

  it("persists running+pid immediately, then done+conversationId on completion", async () => {
    const mem = memDeps();
    const store = createJobStore(mem.deps);
    const { deps, resolve } = agyDeps({ pid: 7777 });

    const id = await runAgyBackground({ prompt: "q", cwd: "/repo" }, cfg, deps, store);

    // runP is gated by the deferred, so the running record is stable here.
    const running = await store.get(id);
    expect(running?.status).toBe("running");
    expect(running?.pid).toBe(7777);

    resolve(); // let agy "complete"
    const done = await waitFor(async () => {
      const r = await store.get(id);
      return r?.status === "done" ? r : undefined;
    });
    expect(done.status).toBe("done");
    expect(done.conversationId).toBe("sess-99");
    expect(done.output).toBe("the answer");
    expect(done.endedAt).toBeTruthy();
  });

  it("marks the job failed when agy rejects", async () => {
    const mem = memDeps();
    const store = createJobStore(mem.deps);
    let resolveWait!: (r: { code: number | null }) => void;
    const child: ChildHandle = {
      stdout: () => "",
      stderr: () => "boom",
      pid: () => 8888,
      wait: () =>
        new Promise((r) => {
          resolveWait = r;
        }),
      kill: () => {},
    };
    const deps: RunnerDeps = {
      spawnChild: () => child,
      readLog: async () => "",
      removeLog: async () => {},
      readSessionsFile: async () => "{}",
      makeLogPath: () => "/tmp/bg.log",
    };

    const id = await runAgyBackground({ prompt: "q", cwd: "/repo" }, cfg, deps, store);
    resolveWait({ code: 1 }); // non-zero exit → runAgy rejects
    const failed = await waitFor(async () => {
      const r = await store.get(id);
      return r?.status === "failed" ? r : undefined;
    });
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(/boom/);
  });
});

describe("cancelJob", () => {
  it("Windows branch tree-kills a running job's pid and marks cancelled", async () => {
    const calls: { file: string; args: string[] }[] = [];
    const exec: TreeKillExecFn = async (file, args) => {
      calls.push({ file, args });
      return { stdout: "", stderr: "" };
    };
    const mem = memDeps([
      { id: "j1", status: "running", pid: 4321, cwd: "/r", prompt: "p", startedAt: "t" },
    ]);
    const store = createJobStore(mem.deps);

    const res = await cancelJob("j1", store, { exec, platform: "win32" });
    expect(res).toEqual({ cancelled: true, status: "cancelled" });
    expect(calls).toEqual([{ file: "taskkill", args: ["/PID", "4321", "/T", "/F"] }]);
    expect((await store.get("j1"))?.status).toBe("cancelled");
  });

  it("is idempotent on an already-done job (no tree-kill invoked)", async () => {
    const calls: { file: string; args: string[] }[] = [];
    const exec: TreeKillExecFn = async (file, args) => {
      calls.push({ file, args });
      return { stdout: "", stderr: "" };
    };
    const mem = memDeps([
      { id: "j1", status: "done", pid: 4321, cwd: "/r", prompt: "p", startedAt: "t" },
    ]);
    const store = createJobStore(mem.deps);

    const res = await cancelJob("j1", store, { exec, platform: "win32" });
    expect(res).toEqual({ cancelled: false, status: "done" });
    expect(calls).toHaveLength(0); // no kill attempted on a finished job
  });

  it("throws on an unknown job id", async () => {
    const store = createJobStore(memDeps().deps);
    await expect(cancelJob("nope", store, { platform: "win32" })).rejects.toThrow(
      /unknown job id/i,
    );
  });
});

describe("scanOrphans", () => {
  it("marks a stale running job whose pid is dead as failed", async () => {
    const mem = memDeps([
      { id: "j1", status: "running", pid: 4321, cwd: "/r", prompt: "p", startedAt: "t" },
      { id: "j2", status: "done", pid: 5555, cwd: "/r", prompt: "p", startedAt: "t" },
    ]);
    const store = createJobStore(mem.deps);
    const fixed = await scanOrphans(store, () => false); // probe says every pid is dead
    expect(fixed).toBe(1);
    const j1 = await store.get("j1");
    expect(j1?.status).toBe("failed");
    expect(j1?.error).toMatch(/orphaned/i);
    // done job untouched
    expect((await store.get("j2"))?.status).toBe("done");
  });

  it("leaves running jobs alone when their pid is still alive", async () => {
    const mem = memDeps([
      { id: "j1", status: "running", pid: 4321, cwd: "/r", prompt: "p", startedAt: "t" },
    ]);
    const store = createJobStore(mem.deps);
    const fixed = await scanOrphans(store, () => true); // alive
    expect(fixed).toBe(0);
    expect((await store.get("j1"))?.status).toBe("running");
  });
});

describe("createToolHandler background flag", () => {
  function handlerFor(
    name: string,
    f: { deps: RunnerDeps },
    overrides: {
      jobStore?: ReturnType<typeof createJobStore>;
      backgroundRunner?: (
        req: { prompt: string },
        cfg: Config,
        deps: RunnerDeps,
        store: ReturnType<typeof createJobStore>,
      ) => Promise<string>;
    } = {},
  ) {
    const jobStore = overrides.jobStore ?? createJobStore(memDeps().deps);
    return {
      handler: createToolHandler(
        TOOLS.find((t) => t.name === name)!,
        { ...cfg },
        new ModelRegistry(async () => LISTING),
        f.deps,
        new CooldownRegistry(),
        undefined,
        jobStore,
        overrides.backgroundRunner as never,
      ),
      jobStore,
    };
  }

  it("returns {job_id} immediately without running agy when background:true", async () => {
    let runnerCalled = 0;
    let spawnCount = 0;
    const f = {
      deps: {
        spawnChild: () => {
          spawnCount++;
          return {
            stdout: () => "should not happen",
            stderr: () => "",
            pid: () => undefined,
            wait: () => Promise.resolve({ code: 0 }),
            kill: () => {},
          } as ChildHandle;
        },
        readLog: async () => "",
        removeLog: async () => {},
        readSessionsFile: async () => "{}",
        makeLogPath: () => "/tmp/x.log",
      } as RunnerDeps,
    };
    const { handler } = handlerFor("delegate", f, {
      backgroundRunner: async () => {
        runnerCalled++;
        return "job-abc";
      },
    });
    const res = await handler({ prompt: "do x", background: true });
    const payload = JSON.parse((res.content[0] as { text: string }).text);
    expect(payload.job_id).toBe("job-abc");
    expect(payload.status).toBe("running");
    expect(runnerCalled).toBe(1);
    expect(spawnCount).toBe(0); // backgroundRunner mocked — agy never spawned synchronously
  });

  it("background absent keeps the synchronous path exactly as today", async () => {
    let spawnCount = 0;
    const f = {
      deps: {
        spawnChild: () => {
          spawnCount++;
          return {
            stdout: () => "the answer",
            stderr: () => "",
            pid: () => undefined,
            wait: () => Promise.resolve({ code: 0 }),
            kill: () => {},
          } as ChildHandle;
        },
        readLog: async () => "",
        removeLog: async () => {},
        readSessionsFile: async () => "{}",
        makeLogPath: () => "/tmp/x.log",
      } as RunnerDeps,
    };
    const { handler } = handlerFor("delegate", f);
    const res = await handler({ prompt: "do x" });
    expect(spawnCount).toBe(1);
    expect((res.content[0] as { text: string }).text).toContain("the answer");
  });
});

describe("createJobResultHandler", () => {
  function storeWith(records: JobRecord[]) {
    return createJobStore(memDeps(records).deps);
  }

  it("returns {status:'running'} for a not-yet-done job", async () => {
    const store = storeWith([
      { id: "j1", status: "running", pid: 1, cwd: "/r", prompt: "p", startedAt: "t" },
    ]);
    const res = await createJobResultHandler(store)({ id: "j1" });
    expect(JSON.parse((res.content[0] as { text: string }).text)).toEqual({
      id: "j1",
      status: "running",
    });
  });

  it("returns the stored output + session footer for a done job", async () => {
    const store = storeWith([
      {
        id: "j1",
        status: "done",
        conversationId: "sess-7",
        cwd: "/r",
        prompt: "p",
        startedAt: "t",
        output: "FINAL ANSWER",
      },
    ]);
    const res = await createJobResultHandler(store)({ id: "j1" });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("FINAL ANSWER");
    expect(text).toMatch(/session: sess-7.*follow_up/);
  });

  it("errors on an unknown id", async () => {
    const res = await createJobResultHandler(storeWith([]))({ id: "nope" });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/unknown job id/i);
  });
});

describe("createJobStatusHandler", () => {
  it("echoes status and timing for a known job", async () => {
    const store = createJobStore(
      memDeps([
        {
          id: "j1",
          status: "done",
          cwd: "/r",
          prompt: "p",
          startedAt: "2026-01-01T00:00:00Z",
          endedAt: "2026-01-01T00:01:00Z",
        },
      ]).deps,
    );
    const res = await createJobStatusHandler(store)({ id: "j1" });
    const payload = JSON.parse((res.content[0] as { text: string }).text);
    expect(payload).toMatchObject({ id: "j1", status: "done", startedAt: "2026-01-01T00:00:00Z" });
  });
});

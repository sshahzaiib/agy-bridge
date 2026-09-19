/**
 * Background job management for agy-bridge: a pid-persisting file job-store
 * with atomic (temp+rename) writes and serialized read-modify-write, plus
 * detached-run / cancel / orphan-scan helpers. The store is a local-dev aid,
 * not a durability guarantee — on an ungraceful server exit a finished job may
 * be mislabeled until the next orphan scan corrects it.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import {
  runAgy,
  treeKill,
  type RunnerDeps,
  type RunRequest,
  type TreeKillExecFn,
  type PidProbe,
  defaultTreeKillExec,
  defaultPidProbe,
} from "./runner.js";

export const JOBS_DIR = path.join(homedir(), ".agy-bridge");
export const JOBS_FILE = path.join(JOBS_DIR, "jobs.json");

export type JobStatus = "running" | "done" | "failed" | "cancelled";

export interface JobRecord {
  id: string;
  status: JobStatus;
  pid?: number;
  conversationId?: string;
  cwd: string;
  prompt: string;
  startedAt: string;
  endedAt?: string;
  outputPath?: string;
  /** agy output text, populated when status becomes `done`. */
  output?: string;
  /** Failure reason, populated when status becomes `failed`. */
  error?: string;
}

export interface JobStore {
  load(): Promise<JobRecord[]>;
  save(records: JobRecord[]): Promise<void>;
  get(id: string): Promise<JobRecord | undefined>;
  upsert(record: JobRecord): Promise<void>;
}

export interface JobStoreDeps {
  storePath: string;
  readFile: (p: string) => Promise<string>;
  writeFile: (p: string, data: string) => Promise<void>;
  rename: (src: string, dest: string) => Promise<void>;
  mkdir: (p: string) => Promise<void>;
}

export const defaultJobStoreDeps: JobStoreDeps = {
  storePath: JOBS_FILE,
  readFile: (p) => readFile(p, "utf8"),
  writeFile: (p, data) => writeFile(p, data, "utf8"),
  rename: (src, dest) => rename(src, dest),
  mkdir: async (p) => {
    await mkdir(p, { recursive: true });
  },
};

/**
 * Build a job store backed by `deps.storePath`. All mutations are funneled
 * through a serialized promise chain (one RMW at a time) and written via temp
 * file + rename so a crash mid-write cannot corrupt or truncate the store.
 */
export function createJobStore(deps: JobStoreDeps = defaultJobStoreDeps): JobStore {
  let chain: Promise<unknown> = Promise.resolve();
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    // Run `fn` after the prior op settles (success OR failure); keep the chain
    // alive regardless so one rejection can't deadlock subsequent writes.
    const next = chain.then(fn, fn);
    chain = next.catch(() => {});
    return next;
  };

  const loadRaw = async (): Promise<JobRecord[]> => {
    let raw: string;
    try {
      raw = await deps.readFile(deps.storePath);
    } catch {
      return [];
    }
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as JobRecord[]) : [];
    } catch {
      return [];
    }
  };

  const atomicWrite = async (data: string): Promise<void> => {
    const tmp = `${deps.storePath}.${process.pid}.${randomUUID()}.tmp`;
    await deps.writeFile(tmp, data);
    await deps.rename(tmp, deps.storePath);
  };

  const persist = async (records: JobRecord[]): Promise<void> => {
    await deps.mkdir(path.dirname(deps.storePath));
    await atomicWrite(JSON.stringify(records, null, 2));
  };

  return {
    load: () => serialize(loadRaw),
    save: (records) => serialize(() => persist(records)),
    get: (id) => serialize(async () => (await loadRaw()).find((r) => r.id === id)),
    upsert: (record) =>
      serialize(async () => {
        const records = await loadRaw();
        const idx = records.findIndex((r) => r.id === record.id);
        if (idx === -1) records.push(record);
        else records[idx] = record;
        await persist(records);
      }),
  };
}

export const defaultJobStore = createJobStore();

/**
 * Spawn agy detached and return a job id immediately, WITHOUT awaiting the
 * run. The pid is persisted as soon as `spawnChild` returns it (which happens
 * synchronously during runAgy's first step), so the record is `running` with a
 * real pid before this function resolves. On completion the record moves to
 * `done` (carrying agy's conversation id from runAgy's session-map read) or
 * `failed` (carrying the error message). The completion write is fire-and-
 * forget — callers that need to observe it poll `job_result`.
 */
export async function runAgyBackground(
  req: RunRequest,
  cfg: Config,
  deps: RunnerDeps,
  store: JobStore = defaultJobStore,
  now: () => string = () => new Date().toISOString(),
): Promise<string> {
  const id = randomUUID();
  const startedAt = now();
  const realSpawn = deps.spawnChild;
  let capturedPid: number | undefined;

  const wrappedDeps: RunnerDeps = {
    ...deps,
    spawnChild: (file, args, cwd) => {
      const child = realSpawn(file, args, cwd);
      capturedPid = child.pid();
      return child;
    },
  };

  // Kick off the run; spawnChild runs synchronously during runAgy's first step,
  // so `capturedPid` is populated before the first await suspends runAgy.
  const runP = runAgy(req, cfg, wrappedDeps);
  await store.upsert({
    id,
    status: "running",
    pid: capturedPid,
    cwd: req.cwd,
    prompt: req.prompt,
    startedAt,
  });

  void runP
    .then(async (result) => {
      await store.upsert({
        id,
        status: "done",
        pid: capturedPid,
        conversationId: result.sessionId,
        cwd: req.cwd,
        prompt: req.prompt,
        startedAt,
        endedAt: now(),
        output: result.output,
      });
    })
    .catch(async (err) => {
      await store.upsert({
        id,
        status: "failed",
        pid: capturedPid,
        cwd: req.cwd,
        prompt: req.prompt,
        startedAt,
        endedAt: now(),
        error: (err as Error).message,
      });
    });

  return id;
}

export interface CancelResult {
  cancelled: boolean;
  status: JobStatus;
}

/**
 * Cancel a running job by tree-killing its pid. Idempotent: a job already
 * done/failed/cancelled is a no-op returning its current status. Killing is
 * best-effort — a pid that already exited is treated as cancelled.
 */
export async function cancelJob(
  id: string,
  store: JobStore = defaultJobStore,
  opts: { exec?: TreeKillExecFn; platform?: NodeJS.Platform; now?: () => string } = {},
): Promise<CancelResult> {
  const exec = opts.exec ?? defaultTreeKillExec;
  const platform = opts.platform ?? process.platform;
  const now = opts.now ?? (() => new Date().toISOString());
  const job = await store.get(id);
  if (!job) throw new Error(`Unknown job id: ${id}`);
  if (job.status !== "running") return { cancelled: false, status: job.status };
  if (job.pid !== undefined) {
    try {
      await treeKill(job.pid, "SIGTERM", exec, platform);
    } catch {
      // best-effort — mark cancelled regardless
    }
  }
  await store.upsert({ ...job, status: "cancelled", endedAt: now() });
  return { cancelled: true, status: "cancelled" };
}

/**
 * On startup, mark any `running` job whose pid is no longer alive as `failed`.
 * Corrects records left dangling by an ungraceful server exit. Returns the
 * number of jobs reclassified.
 */
export async function scanOrphans(
  store: JobStore = defaultJobStore,
  probe: PidProbe = defaultPidProbe,
  now: () => string = () => new Date().toISOString(),
): Promise<number> {
  const records = await store.load();
  let fixed = 0;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.status === "running" && r.pid !== undefined && !probe(r.pid)) {
      records[i] = {
        ...r,
        status: "failed",
        endedAt: now(),
        error: "process exited without reporting (orphaned on restart)",
      };
      fixed++;
    }
  }
  if (fixed > 0) await store.save(records);
  return fixed;
}

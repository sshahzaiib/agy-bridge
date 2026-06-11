import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { Config } from "./config.js";

const execFileAsync = promisify(execFile);

export interface RunRequest {
  prompt: string;
  cwd: string;
  model?: string;
  conversationId?: string;
}

export interface RunResult {
  output: string;
  truncated: boolean;
  sessionId?: string;
}

export type ExecFn = (
  file: string,
  args: string[],
  options: { cwd: string; timeout: number; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string }>;

export interface RunnerDeps {
  exec: ExecFn;
  readSessionsFile: () => Promise<string>;
}

export const SESSIONS_FILE = path.join(
  homedir(),
  ".gemini",
  "antigravity-cli",
  "cache",
  "last_conversations.json",
);

// agy reads stdin until EOF even in print mode; an open stdin pipe hangs it forever.
export const execWithClosedStdin: ExecFn = (file, args, options) => {
  const promise = execFileAsync(file, args, options);
  promise.child.stdin?.end();
  return promise;
};

export const defaultDeps: RunnerDeps = {
  exec: execWithClosedStdin,
  readSessionsFile: () => readFile(SESSIONS_FILE, "utf8"),
};

export function buildArgs(req: RunRequest, cfg: Config): string[] {
  const args: string[] = [];
  if (cfg.skipPermissions) args.push("--dangerously-skip-permissions");
  if (cfg.sandbox) args.push("--sandbox");
  args.push("--add-dir", req.cwd);
  if (req.conversationId) args.push("--conversation", req.conversationId);
  if (req.model) args.push("--model", req.model);
  args.push("--print-timeout", `${cfg.timeoutSec}s`, "-p", req.prompt);
  return args;
}

export function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return {
    text:
      `${text.slice(0, max)}\n\n[agy-bridge: output truncated at ${max} chars; ` +
      `full length was ${text.length} chars. Ask a narrower question or raise AGY_MAX_OUTPUT_CHARS.]`,
    truncated: true,
  };
}

export async function runAgy(
  req: RunRequest,
  cfg: Config,
  deps: RunnerDeps = defaultDeps,
): Promise<RunResult> {
  let stdout: string;
  try {
    ({ stdout } = await deps.exec(cfg.agyPath, buildArgs(req, cfg), {
      cwd: req.cwd,
      timeout: (cfg.timeoutSec + 15) * 1000,
      maxBuffer: 64 * 1024 * 1024,
    }));
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
    if (e.code === "ENOENT") {
      throw new Error(
        `agy CLI not found at "${cfg.agyPath}". Install the Antigravity CLI ` +
          `(https://antigravity.google/docs/cli-getting-started) or set AGY_PATH.`,
      );
    }
    if (e.killed) {
      throw new Error(`agy timed out after ${cfg.timeoutSec}s (AGY_TIMEOUT to adjust).`);
    }
    const stderr = e.stderr?.trim();
    throw new Error(stderr ? `agy failed: ${stderr}` : `agy failed: ${e.message}`);
  }

  const { text, truncated } = truncate(stdout.trim(), cfg.maxOutputChars);

  let sessionId: string | undefined;
  try {
    const map = JSON.parse(await deps.readSessionsFile()) as Record<string, string>;
    sessionId = map[path.resolve(req.cwd)];
  } catch {
    sessionId = undefined;
  }

  return { output: text, truncated, sessionId };
}

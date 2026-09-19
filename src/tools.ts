import path from "node:path";
import { z } from "zod";

const OUTPUT_RULES =
  "Answer directly with no preamble or closing remarks. Be thorough but concise. " +
  "Cite file:line for every code-level finding.";

export function resolveFiles(files: string[], cwd: string): string[] {
  return files.map((f) => (path.isAbsolute(f) ? f : path.resolve(cwd, f)));
}

/**
 * Shared adversarial-review prompt framing for `adversarial_review` and
 * `pre_finish_review`. Both tools gather content/files + an optional focus and
 * ask for a severity-ranked flaw list (mirrors agy-run.sh cmd_review framing).
 */
function buildReviewPrompt(
  args: Record<string, unknown>,
  cwd: string,
  toolName = "adversarial_review",
): string {
  const files = args.files as string[] | undefined;
  const content = args.content as string | undefined;
  if (!content && !files?.length) {
    throw new Error(`${toolName} requires either \`content\` or \`files\`.`);
  }
  const subject = content
    ? `Review the following:\n\n${content}`
    : `Read and review these files:\n${resolveFiles(files!, cwd)
        .map((f) => `- ${f}`)
        .join("\n")}`;
  const focus = args.focus ? `\nFocus especially on: ${args.focus}.` : "";
  return (
    `You are an adversarial reviewer. Find real flaws: bugs, edge cases, security issues, ` +
    `performance traps, unstated assumptions, and simpler alternatives.${focus}\n\n${subject}\n\n` +
    `Rank findings by severity (critical/major/minor) and justify each. ` +
    `Do not pad with praise or restate the input. ${OUTPUT_RULES}`
  );
}

const commonShape = {
  cwd: z
    .string()
    .optional()
    .describe(
      "Absolute path to the working directory / project root. Defaults to the server's cwd.",
    ),
  model: z
    .string()
    .optional()
    .describe(
      'Override the model (exact name from `agy models`, e.g. "Gemini 3.1 Pro (High)"). ' +
        "Normally omit — the tool routes automatically.",
    ),
};

/**
 * Added to tools that support background execution (delegate / analyze_files /
 * deep_search / web_lookup). When true the handler returns a {job_id} at once
 * and runs agy detached; poll with job_status / job_result, cancel with
 * job_cancel. Absent/false keeps the existing synchronous path exactly as-is.
 */
const backgroundShape = {
  background: z
    .boolean()
    .optional()
    .describe(
      "If true, run this task in the background and return a {job_id} immediately instead of " +
        "awaiting the result. Poll with job_status / job_result; cancel with job_cancel. " +
        "Default false (synchronous — current behavior).",
    ),
};

export interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  chain: string[];
  /** Default --print-timeout for this tool, in seconds. AGY_TIMEOUT overrides. */
  timeoutSec: number;
  buildPrompt(args: Record<string, unknown>, cwd: string): string;
}

/** Tool names that accept the `background` flag (see backgroundShape). */
export const BACKGROUND_CAPABLE = new Set([
  "delegate",
  "analyze_files",
  "deep_search",
  "web_lookup",
]);

export const TOOLS: ToolDef[] = [
  {
    name: "analyze_files",
    description:
      "Delegate file analysis to the Antigravity CLI (Gemini) instead of reading files yourself. " +
      "USE THIS whenever a file is large (>200 lines) or the task spans more than 3 files: " +
      "logs, database dumps, generated code, cross-file reviews, comparisons. " +
      "The files never enter your context — only the answer does.",
    schema: {
      files: z
        .array(z.string())
        .min(1)
        .describe("File paths to analyze (relative to cwd or absolute)."),
      question: z.string().describe("What you want to know about these files."),
      ...commonShape,
      ...backgroundShape,
    },
    chain: ["Gemini 3.5 Flash (High)", "Gemini 3.1 Pro (Low)"],
    timeoutSec: 300,
    buildPrompt(args, cwd) {
      const files = resolveFiles(args.files as string[], cwd);
      return (
        `Read and analyze these files:\n${files.map((f) => `- ${f}`).join("\n")}\n\n` +
        `Question: ${args.question}\n\n${OUTPUT_RULES}`
      );
    },
  },
  {
    name: "deep_search",
    description:
      "Delegate codebase archaeology to the Antigravity CLI: git log/diff/blame spelunking, " +
      "wide greps across a repo, 'when/why did X change', 'where is Y used'. " +
      "USE THIS instead of running many search commands yourself — it saves your context.",
    schema: {
      query: z
        .string()
        .describe("What to find, e.g. 'when was the auth middleware refactored and why'."),
      ...commonShape,
      ...backgroundShape,
    },
    chain: ["Gemini 3.5 Flash (Medium)", "Gemini 3.5 Flash (High)"],
    timeoutSec: 180,
    buildPrompt(args) {
      return (
        `Search this repository to answer the following. Use git log, git diff, git blame, ` +
        `and grep as needed.\n\nQuery: ${args.query}\n\n` +
        `Report findings with commit hashes where relevant. ${OUTPUT_RULES}`
      );
    },
  },
  {
    name: "web_lookup",
    description:
      "Delegate a web/documentation lookup to the Antigravity CLI (Gemini with web access): " +
      "library docs, API references, error messages, current versions, external knowledge. " +
      "USE THIS when you need information you don't have or that may be newer than your training data.",
    schema: {
      query: z.string().describe("What to look up on the web."),
      ...commonShape,
      ...backgroundShape,
    },
    chain: ["Gemini 3.5 Flash (Medium)", "Gemini 3.5 Flash (High)"],
    timeoutSec: 120,
    buildPrompt(args) {
      return `Look up on the web: ${args.query}\n\nInclude source URLs for key claims. ${OUTPUT_RULES}`;
    },
  },
  {
    name: "adversarial_review",
    description:
      "Get an adversarial second opinion from a different model family (Gemini Pro). " +
      "ALWAYS use this for plan critiques, design reviews, and pre-merge code review: " +
      "it hunts for flaws, edge cases, security issues, and unstated assumptions you may have missed.",
    schema: {
      content: z
        .string()
        .optional()
        .describe("Inline content to review (plan, diff, code snippet)."),
      files: z
        .array(z.string())
        .optional()
        .describe("File paths to review instead of inline content."),
      focus: z.string().optional().describe("Optional focus area, e.g. 'security', 'concurrency'."),
      ...commonShape,
    },
    chain: ["Gemini 3.1 Pro (High)", "Claude Opus 4.6 (Thinking)", "Gemini 3.5 Flash (High)"],
    timeoutSec: 300,
    buildPrompt: (args, cwd) => buildReviewPrompt(args, cwd),
  },
  {
    name: "pre_finish_review",
    description:
      "Get an adversarial pre-finish review of work-in-progress BEFORE declaring a task " +
      "complete. ALWAYS call this tool before you report a task as done / fixed / passing: it " +
      "hunts for bugs, edge cases, security issues, performance traps, and unstated assumptions " +
      "that a second model family catches and you may have missed. Pass `content` (inline " +
      "diff/plan/code/snippet) or `files` (paths to review), plus an optional `focus`. Returns " +
      "findings as TEXT — advisory and NON-blocking; weigh them with judgement, they do not gate " +
      "completion.",
    schema: {
      content: z
        .string()
        .optional()
        .describe("Inline content to review (plan, diff, code snippet)."),
      files: z
        .array(z.string())
        .optional()
        .describe("File paths to review instead of inline content."),
      focus: z.string().optional().describe("Optional focus area, e.g. 'security', 'concurrency'."),
      ...commonShape,
    },
    chain: ["Gemini 3.1 Pro (High)", "Claude Opus 4.6 (Thinking)", "Gemini 3.5 Flash (High)"],
    timeoutSec: 300,
    buildPrompt: (args, cwd) => buildReviewPrompt(args, cwd, "pre_finish_review"),
  },
  {
    name: "follow_up",
    description:
      "Continue a previous Antigravity session by session_id (returned by every other tool). " +
      "USE THIS for follow-up questions about a prior delegation — the full prior context " +
      "is already on agy's side, so you don't resend anything.",
    schema: {
      session_id: z.string().describe("The session id returned by a previous agy-bridge call."),
      question: z.string().describe("The follow-up question."),
      ...commonShape,
    },
    chain: [],
    timeoutSec: 300,
    buildPrompt(args) {
      return args.question as string;
    },
  },
  {
    name: "delegate",
    description:
      "Raw delegation to the Antigravity CLI for heavy tasks that don't fit the other tools. " +
      "agy has full tool access (shell, file reads, web) in the given cwd.",
    schema: {
      prompt: z.string().describe("The complete task prompt for agy."),
      ...commonShape,
      ...backgroundShape,
    },
    chain: ["Gemini 3.5 Flash (High)"],
    timeoutSec: 600,
    buildPrompt(args) {
      return args.prompt as string;
    },
  },
  {
    name: "image_gen",
    description:
      "Generate an image via the Antigravity CLI's built-in generate_image tool (Imagen). " +
      "Returns the saved image path (text) PLUS an MCP image content block so a vision-capable " +
      "agent can inspect the generated asset; pass `output` to also copy the file to a target " +
      "path (e.g. for embedding in HTML/PPTX). agy is instructed to END its reply with a single " +
      "`IMAGE_PATH: <absolute path>` line — when it omits that marker the bridge falls back to " +
      "scraping an absolute image path, and when neither is found it returns the reply text plus " +
      "a clear warning instead of guessing a path. Relies on the prompt contract; does NOT call " +
      "agy's generate_image directly.",
    schema: {
      description: z.string().describe("What the image should depict."),
      name: z
        .string()
        .optional()
        .describe(
          'Slug used as the saved image filename (passed to agy as "Save the image with name ' +
            '\\"<slug>\\".").',
        ),
      output: z
        .string()
        .optional()
        .describe("Optional absolute path to copy the generated image to."),
      ...commonShape,
    },
    chain: ["Gemini 3.5 Flash (High)", "Gemini 3.5 Flash (Medium)"],
    timeoutSec: 300,
    buildPrompt(args) {
      const description = args.description as string;
      const slug = args.name as string | undefined;
      const nameClause = slug ? ` Save the image with name "${slug}".` : "";
      return (
        `Use your built-in generate_image tool to create the following image. ` +
        `Description: ${description}.${nameClause}\n\n` +
        `After the tool returns, you MUST end your reply with a single line in this exact format ` +
        `(no quotes, no markdown, nothing after it):\n` +
        `IMAGE_PATH: <absolute filesystem path to the saved image>\n\n` +
        `The IMAGE_PATH line is required — the calling wrapper parses it to locate the file.`
      );
    },
  },
];

/**
 * session_transfer does NOT run agy. It resolves the conversation id stored in
 * agy's local sessions cache and returns a resume command. Registered with a
 * custom (non-runAgy) handler in server.ts, so chain/timeoutSec/buildPrompt are
 * not exercised — they only satisfy the ToolDef shape.
 */
export const SESSION_TRANSFER_TOOL: ToolDef = {
  name: "session_transfer",
  description:
    "Resolve the Antigravity CLI (agy) conversation id for a working directory and return a " +
    "resume command (`agy --conversation <id>`) so a session can be handed off or continued in a " +
    "terminal. Reads agy's local sessions cache; makes NO agy run. Returns session_id null when " +
    "no conversation is recorded for the cwd.",
  schema: { cwd: commonShape.cwd },
  chain: [],
  timeoutSec: 0,
  buildPrompt: () => "",
};

export interface SessionTransferResult {
  session_id: string | null;
  resume_command: string | null;
}

/**
 * Pure resolver over agy's last_conversations.json (keyed by resolved cwd path,
 * mirroring runner.ts session-map read). Returns a null session_id — never throws —
 * when the map is missing, empty, unparseable, or has no entry for the cwd.
 */
export function resolveSessionTransfer(mapJson: string, cwd: string): SessionTransferResult {
  let map: Record<string, string>;
  try {
    const parsed = JSON.parse(mapJson);
    if (!parsed || typeof parsed !== "object") {
      return { session_id: null, resume_command: null };
    }
    map = parsed as Record<string, string>;
  } catch {
    return { session_id: null, resume_command: null };
  }
  const id = map[path.resolve(cwd)];
  if (!id) return { session_id: null, resume_command: null };
  return { session_id: id, resume_command: `agy --conversation ${id}` };
}

/**
 * Result of parsing an agy image_gen reply for the saved-image path.
 * `srcPath` is null when neither the IMAGE_PATH marker nor a confidently
 * absolute image path is present (deterministic default — no guessing).
 */
export interface ImageGenParse {
  srcPath: string | null;
  /** True when found via the `IMAGE_PATH:` marker; false when scraped. */
  viaMarker: boolean;
}

/**
 * Pure parser over an agy image_gen reply. Mirrors references/.../agy-run.sh
 * cmd_image: primary = the LAST line matching `^\s*IMAGE_PATH:\s*(.+?)\s*$`;
 * fallback = scrape an absolute image path (Windows-drive form first, then
 * POSIX), tolerating BOTH `\` and `/` separators and spaces in paths. Returns
 * null srcPath when neither yields a confident absolute path.
 */
export function parseImageGenReply(reply: string): ImageGenParse {
  // Primary: scan lines bottom-up for the last IMAGE_PATH: marker.
  const lines = reply.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^\s*IMAGE_PATH:\s*(.+?)\s*$/);
    if (m) {
      const p = m[1].trim();
      if (p) return { srcPath: p, viaMarker: true };
    }
  }
  // Fallback: Windows-drive absolute path (tolerates \ and /, spaces).
  const win = reply.match(/[A-Za-z]:[\\/][^\n\r]*?\.(?:png|jpe?g|webp)/);
  if (win) return { srcPath: win[0].trim(), viaMarker: false };
  // Fallback: POSIX absolute path.
  const posix = reply.match(/\/[^\n\r]+?\.(?:png|jpe?g|webp)/);
  if (posix) return { srcPath: posix[0].trim(), viaMarker: false };
  return { srcPath: null, viaMarker: false };
}

/** MIME type from a file extension for an MCP image content block. */
export function mimeTypeFor(filePath: string): string {
  const ext = filePath.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

import path from "node:path";
import { z } from "zod";

const OUTPUT_RULES =
  "Answer directly with no preamble or closing remarks. Be thorough but concise. " +
  "Cite file:line for every code-level finding.";

export function resolveFiles(files: string[], cwd: string): string[] {
  return files.map((f) => (path.isAbsolute(f) ? f : path.resolve(cwd, f)));
}

const commonShape = {
  cwd: z
    .string()
    .optional()
    .describe("Absolute path to the working directory / project root. Defaults to the server's cwd."),
  model: z
    .string()
    .optional()
    .describe(
      'Override the model (exact name from `agy models`, e.g. "Gemini 3.1 Pro (High)"). ' +
        "Normally omit — the tool routes automatically.",
    ),
};

export interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  chain: string[];
  buildPrompt(args: Record<string, unknown>, cwd: string): string;
}

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
    },
    chain: ["Gemini 3.5 Flash (High)", "Gemini 3.1 Pro (Low)"],
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
    },
    chain: ["Gemini 3.5 Flash (Medium)", "Gemini 3.5 Flash (High)"],
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
    },
    chain: ["Gemini 3.5 Flash (Medium)", "Gemini 3.5 Flash (High)"],
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
      content: z.string().optional().describe("Inline content to review (plan, diff, code snippet)."),
      files: z
        .array(z.string())
        .optional()
        .describe("File paths to review instead of inline content."),
      focus: z.string().optional().describe("Optional focus area, e.g. 'security', 'concurrency'."),
      ...commonShape,
    },
    chain: ["Gemini 3.1 Pro (High)", "Claude Opus 4.6 (Thinking)", "Gemini 3.5 Flash (High)"],
    buildPrompt(args, cwd) {
      const files = args.files as string[] | undefined;
      const content = args.content as string | undefined;
      if (!content && !files?.length) {
        throw new Error("adversarial_review requires either `content` or `files`.");
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
    },
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
    },
    chain: ["Gemini 3.5 Flash (High)"],
    buildPrompt(args) {
      return args.prompt as string;
    },
  },
];

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadConfig, type Config } from "./config.js";
import { ModelRegistry } from "./models.js";
import { runAgy, defaultDeps, type RunnerDeps } from "./runner.js";
import { TOOLS, type ToolDef } from "./tools.js";

const execFileAsync = promisify(execFile);

interface ToolResponse {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export function createToolHandler(
  tool: ToolDef,
  cfg: Config,
  registry: ModelRegistry,
  deps: RunnerDeps = defaultDeps,
): (args: Record<string, unknown>) => Promise<ToolResponse> {
  return async (args) => {
    try {
      const cwd = (args.cwd as string | undefined) ?? process.cwd();
      const conversationId = args.session_id as string | undefined;
      const prompt = tool.buildPrompt(args, cwd);

      const resolution = conversationId
        ? { model: undefined, note: undefined }
        : await registry.resolve({
            explicit: args.model as string | undefined,
            chain: tool.chain,
            defaultModel: cfg.defaultModel,
          });

      const result = await runAgy({ prompt, cwd, model: resolution.model, conversationId }, cfg, deps);

      const meta: string[] = [`model: ${resolution.model ?? "agy default"}`];
      if (resolution.note) meta.push(`note: ${resolution.note}`);
      if (result.sessionId) meta.push(`session: ${result.sessionId} (use follow_up to continue)`);

      return {
        content: [{ type: "text", text: `${result.output}\n\n---\n[agy-bridge] ${meta.join(" | ")}` }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: (err as Error).message }],
        isError: true,
      };
    }
  };
}

export function createServer(): McpServer {
  const cfg = loadConfig();
  const registry = new ModelRegistry(async () => {
    const { stdout } = await execFileAsync(cfg.agyPath, ["models"], { timeout: 30_000 });
    return stdout;
  });

  const server = new McpServer({ name: "agy-bridge", version: "0.1.0" });
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.schema },
      createToolHandler(tool, cfg, registry),
    );
  }
  return server;
}

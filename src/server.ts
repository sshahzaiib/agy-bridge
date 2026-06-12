import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig, type Config } from "./config.js";
import { ModelRegistry } from "./models.js";
import { runAgy, defaultDeps, execWithClosedStdin, type RunnerDeps, type RunResult } from "./runner.js";
import { CooldownRegistry, QuotaError } from "./quota.js";
import { TOOLS, type ToolDef } from "./tools.js";

interface ToolResponse {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

interface HandlerExtra {
  signal?: AbortSignal;
}

export function createToolHandler(
  tool: ToolDef,
  cfg: Config,
  registry: ModelRegistry,
  deps: RunnerDeps = defaultDeps,
  cooldowns: CooldownRegistry = new CooldownRegistry(),
): (args: Record<string, unknown>, extra?: HandlerExtra) => Promise<ToolResponse> {
  return async (args, extra) => {
    try {
      const cwd = (args.cwd as string | undefined) ?? process.cwd();
      const conversationId = args.session_id as string | undefined;
      const prompt = tool.buildPrompt(args, cwd);
      const timeoutSec = cfg.timeoutExplicit ? cfg.timeoutSec : tool.timeoutSec;

      const resolution = conversationId
        ? { models: [undefined], note: undefined }
        : await registry.resolveChain({
            explicit: args.model as string | undefined,
            chain: tool.chain,
            defaultModel: cfg.defaultModel,
          });

      const attempts: string[] = [];
      let result: RunResult | undefined;
      let used: string | undefined;

      for (const model of resolution.models) {
        if (model && cooldowns.cooling(model)) {
          attempts.push(`${model}: quota cooldown, ${cooldowns.describe(model)} left`);
          continue;
        }
        try {
          result = await runAgy(
            { prompt, cwd, model, conversationId, timeoutSec, signal: extra?.signal },
            cfg,
            deps,
          );
          used = model;
          break;
        } catch (err) {
          if (err instanceof QuotaError && model) {
            cooldowns.set(model, err.resetSeconds);
            attempts.push(
              `${model}: quota exhausted${err.resetText ? ` (resets in ${err.resetText})` : ""}`,
            );
            continue;
          }
          throw err;
        }
      }

      if (!result) {
        throw new Error(
          `All candidate models are quota-exhausted or cooling down:\n` +
            `${attempts.map((a) => `- ${a}`).join("\n")}\n` +
            `Retry after the quota resets, or pass an explicit \`model\`.`,
        );
      }

      const meta: string[] = [`model: ${used ?? "agy default"}`];
      if (resolution.note) meta.push(`note: ${resolution.note}`);
      if (attempts.length) meta.push(`failover: ${attempts.join("; ")}`);
      if (result.sessionId) meta.push(`session: ${result.sessionId} (use follow_up to continue)`);

      return {
        content: [{ type: "text", text: `${result.output}\n\n---\n[agy-bridge] ${meta.join(" | ")}` }],
      };
    } catch (err) {
      let text = (err as Error).message;
      if (cfg.onFailure === "strict") {
        text +=
          "\n\n[agy-bridge strict mode] Delegation failed. Do NOT perform this work yourself " +
          "in the main context — report the failure to the user and let them decide how to proceed.";
      }
      return {
        content: [{ type: "text", text }],
        isError: true,
      };
    }
  };
}

export function createServer(): McpServer {
  const cfg = loadConfig();
  const registry = new ModelRegistry(async () => {
    const { stdout } = await execWithClosedStdin(cfg.agyPath, ["models"], {
      cwd: process.cwd(),
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  });
  const cooldowns = new CooldownRegistry();

  const server = new McpServer({ name: "agy-bridge", version: "0.3.1" });
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.schema },
      createToolHandler(tool, cfg, registry, defaultDeps, cooldowns),
    );
  }
  return server;
}

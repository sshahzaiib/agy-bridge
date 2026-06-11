# agy-bridge

An MCP bridge that lets **Claude Code delegate heavy tasks to the Antigravity CLI (`agy`)** — saving Claude's context window and tokens for what matters.

Claude sends a task → the bridge routes it to the best available model via `agy` → only the answer comes back. Large files, deep git searches, and web lookups never touch Claude's context.

```
User → Claude Code → agy-bridge (MCP) → agy CLI → Gemini / Claude / GPT-OSS
                   ←                  ←          ←
```

## Why this over claude-to-agy?

| | claude-to-agy | **agy-bridge** |
|---|---|---|
| Tool surface | 1 generic `delegate_to_agy` | 6 purpose-built tools — Claude self-routes reliably |
| Model selection | none (agy default only) | per-tool routing across all `agy models`, with availability detection and fallback |
| Multi-turn | stateless | session continuity — `follow_up` resumes agy conversations without resending context |
| Output safety | unbounded | configurable truncation cap protects Claude's context |
| Sandbox | no | optional `--sandbox` mode |
| Install | uvx (Python) | npx (Node) — zero install |

## Requirements

- Node.js 18+
- [Antigravity CLI](https://antigravity.google/docs/cli-getting-started) (`agy`) installed and authenticated
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code)

## Install

```bash
# 1. Register the MCP server (user scope = all projects)
claude mcp add -s user agy-bridge npx -- -y agy-bridge

# 2. Add delegation rules to your project (or ~/.claude/CLAUDE.md for global)
curl -o CLAUDE.md https://raw.githubusercontent.com/zaibansari/agy-bridge/main/CLAUDE.md
```

## Tools

| Tool | Use for | Model routing (first available) |
|---|---|---|
| `analyze_files` | Files >200 lines, >3 files at once, logs, dumps, generated code | Gemini 3.5 Flash (High) → Gemini 3.1 Pro (Low) |
| `deep_search` | git log/diff/blame archaeology, repo-wide greps | Gemini 3.5 Flash (Medium) → (High) |
| `web_lookup` | Docs, API references, external/current knowledge | Gemini 3.5 Flash (Medium) → (High) |
| `adversarial_review` | Plan critiques, design and code reviews | Gemini 3.1 Pro (High) → Claude Opus 4.6 (Thinking) → Flash (High) |
| `follow_up` | Continue a prior session by `session_id` — no context resend | inherits the session |
| `delegate` | Anything else heavy | Gemini 3.5 Flash (High) |

All tools accept optional `cwd` (project root) and `model` (exact name from `agy models`; validated, with available models listed on mismatch).

Every response ends with a footer:

```
---
[agy-bridge] model: Gemini 3.5 Flash (High) | session: 1f0c…-d4 (use follow_up to continue)
```

### Model routing

On first use the bridge runs `agy models` (cached for the process lifetime) and picks the first available model in the tool's preference chain. If none is available it falls back to `AGY_DEFAULT_MODEL`, and finally to agy's own default. agy silently ignores unknown `--model` values, so the bridge validates names up front instead of letting requests land on the wrong model.

## Configuration

All optional, via environment variables:

| Variable | Default | Description |
|---|---|---|
| `AGY_PATH` | `agy` | Path to the agy binary |
| `AGY_TIMEOUT` | `1200` | Seconds; passed as `--print-timeout`, enforced with a 15s kill grace |
| `AGY_MAX_OUTPUT_CHARS` | `50000` | Truncation cap for tool output |
| `AGY_DEFAULT_MODEL` | unset | Fallback model when no chain entry is available |
| `AGY_SKIP_PERMISSIONS` | `true` | Pass `--dangerously-skip-permissions` to agy |
| `AGY_SANDBOX` | `false` | Run agy with `--sandbox` |

## Development

```bash
npm install
npm test           # vitest unit tests (exec mocked — no agy needed)
npm run typecheck
npm run build      # tsup → dist/index.js
```

## License

MIT

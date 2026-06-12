# Multi-client support plan

> Status: planned, not started. Captured 2026-06-12.

Extend agy-bridge beyond Claude Code to other MCP-capable coding agents:
**Codex CLI, Cursor, Windsurf, VS Code Copilot (agent mode)**.

## Key insight: zero server changes

agy-bridge speaks standard MCP over stdio — the protocol is client-agnostic,
and any MCP client can run `npx -y agy-bridge` today. The only "Claude"
reference in `src/` is a backend model name in the `adversarial_review`
routing chain (`src/tools.ts`), not a client assumption.

The actual work is documentation and instructions-file packaging.

## Out of scope: Gemini CLI

Deliberately excluded. Gemini CLI and Antigravity CLI are both Google agentic
CLIs backed by the same Gemini models (and typically the same account/quota).
Delegating from Gemini CLI through agy-bridge routes Gemini work to Gemini
through an extra hop:

- No second model family for `adversarial_review` (agy *can* route reviews to
  Claude Opus, but a Gemini CLI user has that in agy directly).
- Context offloading is a weak argument when the user could run agy as their
  primary CLI instead.

Excluding it also simplifies packaging: all four target clients read
`AGENTS.md` natively, so no `GEMINI.md` or `settings.json` context override
to document.

Positioning: **"agy-bridge brings Gemini delegation to non-Gemini agents."**

## Work items

### 1. `AGENTS.md`

Same delegation rules as `CLAUDE.md`, with client-neutral wording ("you" /
"the agent" instead of "Claude"). Add to the `files` array in `package.json`
so it ships in the npm tarball. Install step becomes: curl whichever file
matches the client.

### 2. README — "Other MCP clients" section

Config snippets (verified current as of June 2026):

**Codex CLI**

```bash
codex mcp add agy-bridge --command npx --args -y agy-bridge
```

or `~/.codex/config.toml` (project scope: `.codex/config.toml`):

```toml
[mcp_servers.agy-bridge]
command = "npx"
args = ["-y", "agy-bridge"]
```

**Cursor** — `~/.cursor/mcp.json` (project scope: `.cursor/mcp.json`):

```json
{ "mcpServers": { "agy-bridge": { "command": "npx", "args": ["-y", "agy-bridge"] } } }
```

**Windsurf** — `~/.codeium/windsurf/mcp_config.json`: same JSON shape as Cursor.

**VS Code Copilot (agent mode)** — `.vscode/mcp.json` (user scope:
`~/Library/Application Support/Code/User/mcp.json` on macOS): same shape but
the top-level key is `"servers"` instead of `"mcpServers"`.

Instructions file: all four read `AGENTS.md` (Codex and Windsurf at project
root; Cursor as a project rules file alongside `.cursor/rules/`; Copilot as
workspace instructions in agent mode).

### 3. Reposition wording

README intro and `package.json` description currently say "lets Claude Code
delegate". Generalize to "lets your coding agent (Claude Code, Codex, Cursor,
…) delegate" and keep Claude Code as the primary documented path. Widens
search/discovery surface (e.g. "codex mcp delegate").

### 4. Honest caveat to include in docs

The value proposition is strongest from non-Gemini agents: token/context
savings **plus** a second model family for reviews. State this plainly rather
than overclaiming.

## Checklist

- [ ] Write `AGENTS.md` (client-neutral delegation rules)
- [ ] Add `AGENTS.md` to `files` in `package.json`
- [ ] README: "Other MCP clients" section with the four snippets above
- [ ] README + `package.json`: generalize "Claude Code" wording
- [ ] Re-verify client config syntax at implementation time (formats change)
- [ ] Bump version + publish; update GitHub topics if needed (e.g. `codex`, `cursor`)

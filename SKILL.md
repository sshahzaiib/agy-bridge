---
name: agy-delegation
description: Use when analyzing large files (>200 lines), more than 3 files at once, deep git/grep searches, web lookups, or adversarial reviews - delegates to the Antigravity CLI via agy-bridge MCP tools to save context.
---

# Delegating to Antigravity CLI

Use the agy-bridge MCP tools instead of doing heavy work yourself:

| Situation | Tool |
|---|---|
| File >200 lines, logs, dumps, generated code | `analyze_files` |
| >3 files in one task | `analyze_files` |
| Git history / repo-wide search | `deep_search` |
| Docs or external knowledge | `web_lookup` |
| Plan critique, code review | `adversarial_review` |
| Follow-up on a prior delegation | `follow_up` (use the returned session id) |
| Anything else heavy | `delegate` |

Every response ends with `[agy-bridge] model: … | session: …`. Reuse the
session id with `follow_up` for iterative work — the context stays on agy's
side. Pass `cwd` as the project root so agy can read files and run git.

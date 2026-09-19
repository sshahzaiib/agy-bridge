# Delegation rules: agy-bridge

You have agy-bridge MCP tools that delegate heavy work to the Antigravity CLI
(Gemini). Delegation keeps large content OUT of your context — only answers
come back. Prefer delegating over doing it yourself when:

- **Any file >200 lines** you'd otherwise read → `analyze_files`
- **More than 3 files** in one analysis/comparison → `analyze_files`
- **Git history or repo-wide searches** (git log/diff/blame, broad greps) → `deep_search`
- **Web/documentation lookups** → `web_lookup`
- **Plan critique or code review** → `adversarial_review` (always — a second
  model family catches what you miss)
- **Follow-up question on a prior delegation** → `follow_up` with the returned
  session id (never resend the context)

Do NOT delegate: small single-file edits, questions you can answer from
context already loaded, or tasks needing tools only you have.

## Pre-finish review

Before you declare a task **complete / fixed / passing**, call
`pre_finish_review` on the work-in-progress. Pass the diff or plan as `content`,
or the changed file paths as `files` (optional `focus` like "security"). It runs
an adversarial second-opinion pass and returns findings as **advisory text** —
non-blocking, but it catches bugs, edge cases, and unstated assumptions you may
have missed. Weigh the findings with judgement; they do not gate completion.

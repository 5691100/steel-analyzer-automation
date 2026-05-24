# Steel Handoff Index

Date: 2026-05-24
Status: active

## Read First

1. `{steel} {handoff} analyzer prd - 2026-05-12.md`
2. `../operations/{steel} {runbook} llm split workflow - 2026-05-24.md`
3. `../production-dry-run.md`

## Source Of Truth

- Canonical repo: `https://github.com/5691100/steel-analyzer-automation`
- Current local checkout: `/root/workspace/projects/steel-analyzer-automation`
- Drive critical path: `agent-core/scripts/steel-drive.mjs`
- Project docs in this repo override historical loose files.

## Historical Context

The imported PRD handoff contains old absolute paths under `/root`, `/root/CODEXCLAW`,
and `/root/workspace/output`. Treat those as historical evidence only. Do not use
them as current implementation sources unless the owner explicitly directs a
recovery task.

## Active Rules

- No n8n on the Steel Drive critical path.
- Future Steel Analyzer automation changes go through branch, PR, and CI.
- Uploads require explicit owner approval and user OAuth.
- Runtime smoke evidence must record list/download/upload status and MD5 results.
- LLM-to-LLM messages go through the owner.
- Codex must not dispatch Claude/Gemini directly for Steel sprint work. Prepare
  owner-readable prompts/handoffs; the owner sends them to Claude/Gemini and
  returns their reports.

## Open POS Follow-Up

Do not add a project `AGENTS.md` ad hoc during Sprint 7. Design the global and
project-level `AGENTS.md` strategy as a separate Personal POS task, covering:

- global runtime bootstrap;
- shared POS contract in Obsidian;
- project-level adapters for Codex, Gemini, and Claude;
- startup context reading order;
- handoff discovery rules;
- stale-rule avoidance.

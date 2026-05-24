# Steel LLM Split Workflow

Date: 2026-05-24
Status: active for Sprint 7 planning

## Purpose

Define how Codex, Claude, and Gemini participate in Steel Analyzer automation
without direct LLM-to-LLM communication or multiple sources of truth.

## Operating Model

- Owner is the message bus between LLM runtimes.
- Codex does not call Claude or Gemini directly for Steel sprint execution.
  Direct Claude/Gemini CLI dispatch from Codex is treated as non-working for
  this workflow.
- Codex owns repository changes, branch/PR workflow, CI evidence, and final
  artifact placement.
- Claude reviews product fit, operator safety, user scenarios, and data
  integrity when invoked by the owner.
- Gemini performs runtime smoke reports, Drive-oriented evidence collection,
  and large-context review when invoked by the owner.
- Each runtime must return a concise handoff with commands run, evidence paths,
  decisions made, open questions, and PASS/FAIL status.

## Owner-Mediated Handoff Rule

When Codex needs Claude or Gemini input:

1. Codex writes a concise prompt/handoff in chat or repo docs.
2. Owner sends that prompt to Claude/Gemini.
3. Owner pastes the returned report back to Codex.
4. Codex records the report in evidence/docs and continues.

Do not rely on direct CLI calls such as `claude -p ...` or `gemini -p ...` as
the operational split mechanism for Steel Analyzer.

## Sprint 7 Split

Codex lane:

- create Sprint 7 branch/worktree from canonical `main`;
- add owner-gated upload rehearsal behavior and docs through PR;
- keep Drive critical path in `agent-core/scripts/steel-drive.mjs`;
- run CI and create PR evidence.

Claude lane:

- receive owner-forwarded prompt only; no direct Codex-to-Claude dispatch;
- review upload rehearsal from product/operator-safety lens;
- confirm owner approval gate is clear and cannot be bypassed by accident;
- check runbook clarity and rollback/cleanup instructions.

Gemini lane:

- receive owner-forwarded prompt only; no direct Codex-to-Gemini dispatch;
- run or review production-like smoke evidence when owner provides runtime
  access/results;
- report Drive list/download/upload status and MD5 verification;
- confirm no n8n upload path is used.

## Non-Negotiables

- No n8n for Steel Drive list/download/upload critical path.
- No service-account fallback for writes.
- Upload requires user OAuth and exact explicit owner approval:
  `--owner-approval "I_APPROVE_STEEL_UPLOAD:<run_id>:<folder_id>"`.
- Upload paths must remain contained to the run directory.
- All future changes go through branch, PR, and CI.
- Do not introduce repo `AGENTS.md` until the Personal POS `AGENTS.md` strategy
  is designed separately.

## Evidence Format

Runtime reports should include:

- run id;
- branch and commit;
- command summary;
- Drive folder id;
- files listed/downloaded/uploaded;
- manifest paths, including `manifest-drive-upload.json`;
- MD5 match count;
- upload executed, skipped, or blocked by the owner gate;
- safety notes from upload manifest;
- final PASS/FAIL.

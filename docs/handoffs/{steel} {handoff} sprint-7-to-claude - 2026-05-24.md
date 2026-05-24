# Steel Sprint 7 Handoff To Claude

Timestamp: 2026-05-24T10:17:27Z
Status: ready for Claude continuation
Branch: `feat/production-upload-rehearsal-sprint-7`
Base: `main@41f510b`
Repo: `https://github.com/5691100/steel-analyzer-automation`
Worktree: `/root/workspace/projects/steel-analyzer-automation/.worktrees/sprint-7`

## Goal

Finish Sprint 7: Owner-Gated Production Upload Rehearsal.

Core behavior implemented:

- Direct upload requires exact CLI token:
  `--owner-approval "I_APPROVE_STEEL_UPLOAD:<run_id>:<folder_id>"`
- Missing/wrong approval writes blocked `manifest-drive-upload.json` and must not touch OAuth or Drive.
- Approved upload uses user OAuth only, verifies Drive MD5, and writes upload manifest evidence.
- Upload path is contained under `agent-core/steel-bus/runs/<run_id>/`.
- Symlink run directories / realpath escapes are rejected.
- Multiple workbook uploads aggregate evidence in `items[]`.
- Re-running the same `run_id` appends evidence; rotate `run_id` for a fresh report.
- No n8n upload path.

## Changed Files

Tracked modified:

- `README.md`
- `agent-core/package.json`
- `agent-core/schemas/steel-upload-verified.schema.json`
- `agent-core/scripts/steel-drive.mjs`
- `agent-core/scripts/steel-orchestrator.mjs`
- `docs/production-dry-run.md`

Untracked new:

- `agent-core/schemas/steel-manifest-drive-upload.schema.json`
- `agent-core/test/steel-drive-upload-gate.test.mjs`
- `agent-core/test/steel-orchestrator-upload-approve.test.mjs`
- `docs/handoffs/{steel} {handoff} analyzer prd - 2026-05-12.md`
- `docs/handoffs/{steel} {summary} handoff index - 2026-05-24.md`
- `docs/handoffs/{steel} {handoff} sprint-7-to-claude - 2026-05-24.md`
- `docs/operations/{steel} {runbook} llm split workflow - 2026-05-24.md`

## Reviews Completed

Claude product/operator review:

- Initial verdict: `NEEDS_FIXES`
- Final re-review verdict: `ACCEPTED`
- All 15 previous items fixed.
- Remaining real-upload owner decisions are documented in `docs/production-dry-run.md`.

Gemini runtime/evidence review:

- Verdict: `PASS`
- Confirmed runtime/evidence readiness.
- Noted risks: token visibility in shell/process table, duplicate Drive files on re-run, and need to ensure runs directory itself is not symlinked.

Codex technical review:

- Initial verdict: `REQUEST_CHANGES`
- Re-review verdict: `APPROVE`
- Fixed prior issues:
  - symlink run-dir containment escape;
  - manifest evidence on approved upload failures;
  - orchestrator missing-approval blocked evidence;
  - multi-upload manifest overwrite.

Docs review:

- Verdict: `PASS`
- No documentation blockers found.
- `llms.txt`: absent. `CLAUDE.md`: absent. Docs reviewer judged this acceptable
  for this repo because README routes operators to the active runbook/handoff docs.
- Repo `AGENTS.md` was not added.

## Verification Already Run

From `agent-core`:

```bash
timeout 120 node --check scripts/steel-drive.mjs
timeout 120 node --check scripts/steel-orchestrator.mjs
timeout 120 npm test
```

Observed:

- `steel-drive.mjs` syntax: exit 0, no output
- `steel-orchestrator.mjs` syntax: exit 0, no output
- `npm test`: 2 tests, 2 pass

From repo root:

```bash
git diff --check
timeout 120 rg -n 'UPLOAD_WEBHOOK_URL|N8N_UPLOAD|n8n.*webhook|webhook.*n8n' agent-core/scripts agent-core/schemas agent-core/package.json
```

Observed:

- `git diff --check`: exit 0
- webhook/n8n guard: no output, exit 1 expected

Blocked upload smoke:

```bash
mkdir -p agent-core/steel-bus/runs/sprint7-final-blocked-smoke
cp agent-core/package.json agent-core/steel-bus/runs/sprint7-final-blocked-smoke/package.json
timeout 120 node agent-core/scripts/steel-drive.mjs upload \
  --run sprint7-final-blocked-smoke \
  --folder test-folder \
  --file agent-core/steel-bus/runs/sprint7-final-blocked-smoke/package.json
```

Observed:

- exit code 2
- `missing_owner_approval`
- manifest fields included:
  - `status: "blocked"`
  - `upload_executed: false`
  - `oauth_attempted: false`
  - `drive_create_attempted: false`
  - `drive_get_attempted: false`
  - `skipped_reason: "missing_owner_approval"`
  - `md5_status: "not_applicable"`

Temporary smoke directory was removed after reading evidence.

## Remaining Gates

1. Write `.par-evidence.json`. Suggested content:

   ```json
   {
     "sprint": 7,
     "claude_product": "ACCEPTED",
     "technical_review": "APPROVE",
     "gemini_runtime": "PASS",
     "docs_update": "UPDATED",
     "docs_review": "PASS",
     "provider": "owner-mediated-claude-gemini-codex",
     "ts": "<ISO-8601>"
   }
   ```

2. Re-run final verification after `.par-evidence.json` if desired:

   ```bash
   cd /root/workspace/projects/steel-analyzer-automation/.worktrees/sprint-7/agent-core
   timeout 120 node --check scripts/steel-drive.mjs
   timeout 120 node --check scripts/steel-orchestrator.mjs
   timeout 120 npm test
   cd ..
   git diff --check
   timeout 120 rg -n 'UPLOAD_WEBHOOK_URL|N8N_UPLOAD|n8n.*webhook|webhook.*n8n' agent-core/scripts agent-core/schemas agent-core/package.json
   ```

3. Stage and commit all Sprint 7 changes:

   ```bash
   git add README.md agent-core/package.json agent-core/schemas agent-core/scripts agent-core/test docs .par-evidence.json
   git commit -m "feat(ops): add owner-gated upload rehearsal"
   ```

4. Push and create PR:

   ```bash
   git push -u origin feat/production-upload-rehearsal-sprint-7
   gh pr create --repo 5691100/steel-analyzer-automation \
     --base main \
     --head feat/production-upload-rehearsal-sprint-7 \
     --title "feat(ops): add owner-gated upload rehearsal" \
     --body "<PR BODY>"
   ```

5. Wait for GitHub Actions CI and record result.

## PR Body Draft

```markdown
## Summary

- add explicit owner approval token gate for direct Drive uploads
- write `manifest-drive-upload.json` for blocked, failed, and successful upload attempts
- harden upload path containment, including run-id allowlist and symlink escape rejection
- aggregate upload manifest evidence across multiple workbook uploads/re-runs
- add node:test coverage for upload gate and orchestrator approval behavior
- update production runbook, handoff index, and owner-mediated Claude/Gemini split docs

## Verification

- `timeout 120 node --check scripts/steel-drive.mjs`
- `timeout 120 node --check scripts/steel-orchestrator.mjs`
- `timeout 120 npm test`
- `git diff --check`
- `timeout 120 rg -n 'UPLOAD_WEBHOOK_URL|N8N_UPLOAD|n8n.*webhook|webhook.*n8n' agent-core/scripts agent-core/schemas agent-core/package.json` (no matches, exit 1 expected)
- blocked-upload smoke: missing owner approval exited 2 and wrote `upload_executed:false`, `oauth_attempted:false`, `drive_create_attempted:false`

## Reviews

- Claude product/operator review: ACCEPTED
- Gemini runtime/evidence review: PASS
- Codex technical review: APPROVE
- Docs review: PASS
```

## Important Rules

- No n8n for Steel Drive critical path.
- Use `agent-core/scripts/steel-drive.mjs` for Drive list/download/upload.
- Upload writes are user OAuth only.
- LLM-to-LLM messages go through owner; do not rely on direct Codex-to-Claude/Gemini CLI dispatch.
- Do not create repo `AGENTS.md` in Sprint 7. Personal POS `AGENTS.md` strategy is deferred and documented in Obsidian.

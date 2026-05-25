# steel-analyzer-automation — Project Instructions for Claude Code

## Project Summary

Automated steel structure analysis pipeline. Node.js (ESM), no n8n anywhere in this pipeline.

## Package Root

`agent-core/` is the npm package root (`package.json` name: `steel-agent-core`).

## How to Run Tests

```bash
cd agent-core && npm test
# Expands to: node --test test/*.test.mjs
```

Test files: `agent-core/test/*.test.mjs`

## Key Entry Points

| File | Purpose |
|------|---------|
| `agent-core/scripts/steel-drive.mjs` (799 lines) | Google Drive list/download/upload with MD5 verification and atomic manifests. Uses User OAuth only — no Service Account fallback. |
| `agent-core/scripts/steel-orchestrator.mjs` (843 lines) | File-bus watcher. Watches `steel-bus/inbox/`, drives state transitions, calls steel-drive and external CLIs. |
| `agent-core/src/telegram-bot.mjs` (208 lines) | grammy Telegram bot. Commands: `/run <run_id> <folder_id>`, `/status <run_id>`, `/cancel <run_id>`. Inline buttons: `approve_upload`, `reject_upload`. Security: `TELEGRAM_CHAT_ID` gate on every update. Publishes dashboard run JSON after successful upload, upload failure, pipeline crash, or owner rejection. |
| `agent-core/src/pipeline-runner.mjs` (90 lines) | `runPipeline(runId, folderId, notifyFn)` — orchestrates download → Gemini analysis → Claude QA → Telegram approval prompt. |
| `agent-core/src/publish-run.mjs` (161 lines) | `publishRun(runId, runDir, repoRoot, options)` — writes `dashboard/runs/<run_id>.json`, updates `dashboard/runs/index.json`, then runs `git pull --rebase` (with Basic auth if `GITHUB_TOKEN` set), `git add dashboard/runs/`, `git commit`, and `git push` unless `dryRun` is set. On failure: step-aware rollback (`reset HEAD~1` for push, `reset HEAD --` for commit) + `git clean` scoped to the two written files. |
| `agent-core/src/llm-dispatcher.mjs` (81 lines) | `dispatchGeminiAnalysis(runId, runDir, sourcesDir)` — calls `gemini -p <prompt>` via `spawnSync`, parses JSON, generates workbooks, verifies output. |
| `agent-core/src/prompts/steel-analysis-prompt.mjs` (33 lines) | `buildAnalysisPrompt(runId, sourceTexts)` — builds the structured Gemini prompt from source `.txt` files. |
| `agent-core/src/workbook-generator.mjs` (341 lines) | JSON → 3 xlsx files (BoM, MaterialList, Description) via ExcelJS. Entry: `generateWorkbooks(data, outputDir)`. |
| `agent-core/src/artifact-verifier.mjs` (60 lines) | Verifies run output directory contains required xlsx files. Entry: `verifyRunOutput(runDir)`. |
| `agent-core/steel-bus/lib/state-machine.mjs` | Pure state machine (no I/O). 17 states from `requested` to `closed`/`dead_letter`. |
| `dashboard/` | Static Vercel dashboard (`dashboard/vercel.json` uses `@vercel/static`) that loads published run data from `dashboard/runs/index.json` and per-run JSON files. Failed runs render their error message. |
| `ecosystem.config.cjs` | PM2 process definitions: `steel-orchestrator` (file-bus watcher) and `steel-bot` (Telegram bot). |

## Owner-Approval Gate (Upload)

Upload is blocked until an exact token is provided:

```
I_APPROVE_STEEL_UPLOAD:<run_id>:<folder_id>
```

Pass via `--owner-approval` flag to steel-drive.mjs. Token is scoped to the specific run and Drive folder — no wildcards accepted. This is enforced at `checkOwnerApproval()` in steel-drive.mjs line 296.

## Schemas

`agent-core/schemas/` contains JSON schemas for all bus signals:
`steel-run-request`, `steel-run-complete`, `steel-manifest-drive-upload`, `steel-upload-verified`, `steel-review-result`, `steel-integration-result`, `steel-gepa-register`, `steel.workbooks-validated.v1`.

## Write Boundaries

- `agent-core/scripts/` — changes via PR only. CodexClaw is integrator.
- `agent-core/src/` — changes via PR only. CodexClaw is integrator.
- `dashboard/runs/` — runtime run history for Vercel dashboard. Maintained by `publish-run.mjs`.
- `agent-core/steel-bus/runs/` — runtime artifacts, never committed. Add to `.gitignore` if missing.
- `agent-core/schemas/` — schema changes require spec update in `docs/superflow/specs/`.

## Runtime Notes

- OAuth token path: `/root/.config/codexclaw/secrets/google-oauth-user.json`
- Bus root: `agent-core/steel-bus/` — `inbox/`, `runs/`, `dead-letter/`
- Dependencies: `exceljs ^4.4.0`, `googleapis ^171.4.0`, `grammy` (Telegram bot)
- Required env vars for bot startup: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (numeric; bot exits if either missing)
- Dashboard auto-publish uses git commands from `publishRun()`; provide GitHub push credentials to the PM2 `steel-bot` environment via `GITHUB_TOKEN`. The helper reports publish failures instead of blocking a successful Drive upload.
- PM2 launch: `pm2 start ecosystem.config.cjs` starts `steel-orchestrator`, `steel-bot`, and `agent-tasks-daemon`

## Agent Tasks

File-based multi-runtime task dispatch. PM2 daemon polls `agent-core/agent-tasks/queue/`,
dispatches to Codex/Gemini/Claude via spawnSync (stdin), writes results to `results/<id>/`.

- **Daemon**: `pm2 start ecosystem.config.cjs` includes `agent-tasks-daemon`
- **Manual dispatch**: `node agent-core/agent-tasks/bin/pos-dispatch.mjs <task-id>`
- **Replay dead-letter**: `node agent-core/agent-tasks/bin/pos-dispatch.mjs --replay <task-id>`
- **dry_run**: set `dry_run: true` in task JSON — daemon/dispatch skips CLI, writes `verdict:"DRY_RUN"`
- **Schemas**: `agent-core/agent-tasks/schemas/pos.task.v1.json` + `pos.result.v1.json`
- **Queue dirs**: `queue/` → `running/` → `results/<id>/` | `dead-letter/`

## Documentation

- Specs: `docs/superflow/specs/`
- Plans: `docs/superflow/plans/`
- Handoffs: `docs/handoffs/`
- Operations: `docs/operations/`

<!-- superflow:onboarded -->
<!-- sprint:12 -->
<!-- updated-by-superflow:2026-05-25 -->

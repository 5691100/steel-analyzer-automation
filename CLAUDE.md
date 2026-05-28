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
| `agent-core/src/telegram-bot.mjs` (320 lines) | grammy Telegram bot. Drive-link intake (paste URL → auto run_id), 5-gate approval flow (G1-G5) with Approve/Reject/Defer/Clarify/Open-chat buttons, Open-chat Q&A mode, improved /status with ledger state. Security: `TELEGRAM_CHAT_ID` gate. |
| `agent-core/src/pipeline-runner.mjs` | `runPipeline(runId, folderId, notifyFn)` — pipeline: G1→G2→G3→Phase:self-checklist→Phase:dashboard→Phase:GEPA→G5, Codex/GEPA flow via gepa-via-codex.mjs (non-blocking) |
| `agent-core/src/self-checklist.mjs` (246 lines) | `runSelfChecklist(runDir)` — 7-point quality checklist. Reads `analysis.json`, writes `self-checklist.json` (schema: `steel.self-checklist.v1`). Pipeline blocks on failure (`verdict: 'BLOCKED'`). Exports `runSelfChecklist`, `formatFailedItems`. |
| `agent-core/src/codex-runner.mjs` | `callCodex(prompt, opts)` — shared Codex→Claude fallback helper. Tries `codex exec -` first; falls back to `claude --dangerously-skip-permissions -p -` on ENOENT or ETIMEDOUT. Returns `{ stdout, stderr, provider, exitCode }`. |
| `agent-core/src/gepa-via-codex.mjs` | `runGepaReview(runDir, deps)` — reads `analysis.json` + `self-checklist.json`, calls `callCodex`, parses proposals, writes `gepa-register.json` (schema: `steel.gepa-register.v1`). Returns `{ verdict: 'OK'|'WARN', proposals, reason?, provider }`. |
| `agent-core/src/gate-manager.mjs` (62 lines) | Pending gate registry (pendingGates Map), InlineKeyboard factory, resolveGate, GATE_AGENT/GATE_PROMPTS/GATE_HELP constants. |
| `agent-core/src/publish-run.mjs` (161 lines) | `publishRun(runId, runDir, repoRoot, options)` — writes `dashboard/runs/<run_id>.json`, updates `dashboard/runs/index.json`, then runs `git pull --rebase` (with Basic auth if `GITHUB_TOKEN` set), `git add dashboard/runs/`, `git commit`, and `git push` unless `dryRun` is set. On failure: step-aware rollback (`reset HEAD~1` for push, `reset HEAD --` for commit) + `git clean` scoped to the two written files. |
| `agent-core/src/llm-dispatcher.mjs` (410 lines) | `dispatchClaudeAnalysis` — calls `claude --dangerously-skip-permissions -p -` via stdin, parses JSON, generates workbooks, writes `analysis.json`. `dispatchAntigravityQA` — Claude QA self-check (reads `analysis.json`). `dispatchCodexReview` — uses `callCodex` from `codex-runner.mjs` (Codex→Claude fallback), writes `codex-review.json`. `writeGepaRegister` — writes `gepa-register.json`. `dispatchOpenChatQuestion`. Exports `extractJsonFromText`. |
| `agent-core/src/prompts/steel-analysis-prompt.mjs` (150 lines) | `buildAnalysisPrompt(runId, sourceTexts)` — builds the structured analysis prompt from source `.txt` files. Aligned to unified schema field names (`file_name`, `source_type` in `sources_detail`). |
| `agent-core/src/template-config.mjs` (198 lines) | Externalized template configuration: sheet names, column definitions, category aliases, description sheet structure. Single source of truth for workbook layout. |
| `agent-core/src/dashboard-generator.mjs` (206 lines) | `generateDashboard(data, outputPath)` — generates `dashboard.html` in `runDir/output/`. Uploaded to Drive alongside xlsx files. HTML-escaped throughout. Null-guarded for missing `totals`. |
| `agent-core/src/workbook-generator.mjs` (604 lines) | JSON → 3 xlsx files (BoM, MaterialList, Description) via ExcelJS. Entry: `generateWorkbooks(data, outputDir)`. Includes sheet sanitizer, Description sheets, versioning (throws on >50 versions). |
| `agent-core/src/artifact-verifier.mjs` (60 lines) | Verifies run output directory contains required xlsx files. Entry: `verifyRunOutput(runDir)`. |
| `agent-core/steel-bus/lib/state-machine.mjs` | Pure state machine (no I/O). 17 states from `requested` to `closed`/`dead_letter`. |
| `dashboard/` | Static Vercel dashboard (`dashboard/vercel.json` uses `@vercel/static`) that loads published run data from `dashboard/runs/index.json` and per-run JSON files. Failed runs render their error message. |
| `ecosystem.config.cjs` | PM2 process definitions: `steel-orchestrator` (file-bus watcher) and `steel-bot` (Telegram bot). |

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
dispatches to Codex/AntigravityClaw/Claude via spawnSync (stdin), writes results to `results/<id>/`.

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
<!-- sprint:18 -->
<!-- updated-by-superflow:2026-05-27 -->

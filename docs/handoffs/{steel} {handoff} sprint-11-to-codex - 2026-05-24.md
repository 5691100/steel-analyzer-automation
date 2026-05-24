# Steel Sprint 11 Handoff To Codex

Timestamp: 2026-05-24
Status: ready for Codex implementation
Repo: `https://github.com/5691100/steel-analyzer-automation`
Branch to create: `feat/sprint-11-vercel-dashboard` from `main`
Git workflow: `solo_single_pr` — one final PR

---

## Goal

Implement Sprint 11: Vercel dashboard that auto-updates after each pipeline run.

Two deliverables:
1. **`agent-core/src/publish-run.mjs`** — post-upload step: reads `gemini-analysis.json`, writes JSON to `dashboard/runs/`, commits+pushes to GitHub → Vercel auto-deploys
2. **`dashboard/index.html`** — static HTML, hash-router, two views: run list + run detail

---

## Read First (in order)

1. `docs/superflow/specs/2026-05-24-sprint-11-vercel-dashboard-design.md` — full technical spec (authoritative)
2. `docs/superflow/plans/2026-05-24-sprint-11-vercel-dashboard-plan.md` — sprint breakdown + task list
3. `docs/superflow/specs/2026-05-24-sprint-11-vercel-dashboard-brief.md` — product brief (context)

---

## Sprint Plan Summary

### Wave 1 — parallel (no shared files)

**Sprint 1: publish-run.mjs**
- New: `agent-core/src/publish-run.mjs`
- New: `agent-core/test/publish-run.test.mjs`
- Key behavior:
  - `publishRun(runId, runDir, repoRoot?, options?)` — `repoRoot` defaults to repo root from `import.meta.url`
  - `options.spawnSyncFn` — injectable git runner (for testing git failures without dryRun)
  - `options.dryRun` — skip git ops entirely
  - Validate runId: `/^[a-zA-Z0-9_-]{1,80}$/` — throw on invalid (path traversal guard)
  - Missing `gemini-analysis.json` → write failed stub, do NOT throw
  - `git pull --rebase` before modifying `index.json`; if fails → return `{ ok: false, error: 'rebase failed' }`
  - `git add dashboard/runs/ && git commit -m "chore(runs): add run <runId>" && git push`
  - Push failure → return `{ ok: false, error }`, never throw
  - No cap on `index.json` — all history, newest first

**Sprint 2: dashboard HTML**
- New: `dashboard/index.html` (hash-router, Chart.js 4.4 CDN, dark theme matching `steel-report-deploy/index.html`)
- New: `dashboard/vercel.json`
  ```json
  {
    "version": 2,
    "name": "steel-analyzer-report",
    "builds": [{ "src": "**", "use": "@vercel/static" }],
    "headers": [{ "source": "/runs/(.*).json", "headers": [{ "key": "Cache-Control", "value": "no-cache, no-store, must-revalidate" }] }]
  }
  ```
- New: `dashboard/runs/index.json` — initial `[]`
- Index view (`#/`): sortable table: Run ID | Project | Date | Weight kg | Paint m² | Status
  - All dynamic content via `element.textContent` (no innerHTML — XSS prevention)
  - Client-side runId sanitize: `/^[a-zA-Z0-9_-]{1,80}$/`
  - Error state if fetch fails; empty state if index empty
- Detail view (`#/run/<id>`): KPI cards (6) + stacked bar + donut + profile table
  - Source: `./runs/<id>.json`
  - Error state if 404/parse fail; failed-run state if `status === 'failed'`
  - Base style on existing `steel-report-deploy/index.html` (dark #0d1117 theme)

### Wave 2 — sequential (depends on Wave 1)

**Sprint 3: Wire + integration**
- Modify: `agent-core/src/telegram-bot.mjs`
  - Import `publishRun`
  - After upload success loop in `approve_upload`:
    ```js
    const pubResult = await publishRun(runId, join(RUNS_DIR, runId)).catch(err => ({ ok: false, error: err.message }));
    if (!pubResult.ok) {
      await ctx.reply(`⚠️ Uploaded to Drive, but dashboard publish failed: ${pubResult.error}`);
    }
    ```
  - In `approve_upload` catch block (upload failure path) — publish failed run entry:
    ```js
    await publishRun(runId, join(RUNS_DIR, runId)).catch(() => {});
    ```
  - In `reject_upload` callback — publish rejected entry:
    ```js
    await publishRun(runId, join(RUNS_DIR, runId)).catch(() => {});
    ```
- Modify: `agent-core/test/telegram-bot.test.mjs` — 4 new tests (see plan)
- Modify: `ecosystem.config.cjs` — add `GITHUB_TOKEN: process.env.GITHUB_TOKEN || ''` to `steel-bot` env
- New: `.env.example` — `GITHUB_TOKEN=ghp_...  # Required for dashboard auto-publish`
- Run: `cd agent-core && npm test` — all tests green

---

## Critical Rules (from LLM split workflow)

- Codex owns all repo changes, branch/PR, CI evidence
- No direct `claude -p` or `gemini -p` dispatch from Codex for this sprint
- Owner is message bus if Claude/Gemini review needed
- Upload requires `--owner-approval` token (not relevant for this sprint — dashboard only)
- No n8n anywhere in this pipeline

---

## Vercel Reconfiguration Note

The existing Vercel project `steel-analyzer-report` currently serves `steel-report-deploy/` (separate directory, hardcoded single-run HTML). After this sprint merges:

1. Reconfigure Vercel project root to `steel-analyzer-automation` repo, directory `dashboard/`
2. OR create a new Vercel project pointing to `dashboard/` — use same `name: steel-analyzer-report`

This is a Vercel UI step (owner does it), not a code task.

---

## Git Auth for publish-run

The bot process needs push access. Required before testing e2e:
```bash
git remote set-url origin https://${GITHUB_TOKEN}@github.com/5691100/steel-analyzer-automation.git
```
Add `GITHUB_TOKEN` to PM2 env in `ecosystem.config.cjs`.

---

## Test Baseline

Current passing tests (Sprint 10): **31 tests, 6 suites**
```bash
cd agent-core && npm test
```
After Sprint 11: expect ≥43 tests (8+ new publish-run + 4+ new telegram-bot).

---

## What Claude Did (Phase 1)

- Read existing codebase and signal schemas
- Ran spec + plan dual reviews (Codex technical + Claude product)
- Spec ACCEPTED, plan reviewed with fixes applied
- All docs written and committed to repo

**No code written yet.** Implementation starts here.

---

## State File

`.superflow-state.json` in repo root → `phase: 2, stage: ready`
Spec/plan/brief paths in `context.*`

<!-- updated-by-superflow:2026-05-24 -->

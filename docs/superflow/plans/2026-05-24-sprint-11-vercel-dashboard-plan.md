# Implementation Plan: Sprint 11 — Vercel Dashboard

References: `docs/superflow/specs/2026-05-24-sprint-11-vercel-dashboard-design.md`

Git workflow: `solo_single_pr` — one branch `feat/sprint-11-vercel-dashboard`, one final PR.

---

## Sprint 1: publish-run.mjs [complexity: medium]

files: agent-core/src/publish-run.mjs, agent-core/test/publish-run.test.mjs
depends_on: []

### Tasks

1. Create `agent-core/src/publish-run.mjs`
   - Export `publishRun(runId, runDir, repoRoot, options = {})`
   - `repoRoot` defaults to `path.resolve(fileURLToPath(import.meta.url), '../../../')` (repo root from src/)
   - `options.dryRun` — skip git ops; `options.spawnSyncFn` — injectable git runner (default: `spawnSync` from `child_process`)
   - Validate runId: `/^[a-zA-Z0-9_-]{1,80}$/` — throw on invalid
   - Read `<runDir>/gemini-analysis.json`; if missing, build failed stub: `{ run_id, status: 'failed', project_name: 'unknown', created_at: now, totals: null, subproject_count: 0 }`
   - Build summary entry: `{ run_id, project_name, status, created_at, totals, subproject_count }`
   - Write `dashboard/runs/<runId>.json` (full payload or stub)
   - Unless `dryRun`: run `git pull --rebase` via `spawnSyncFn`; if fails → return `{ ok: false, error: 'rebase failed' }`
   - Read/create `dashboard/runs/index.json`; prepend entry; write back
   - Unless `dryRun`: `git add` → `git commit` → `git push` via `spawnSyncFn`; catch/status≠0 → return `{ ok: false, error }`
   - Return `{ ok: true, publishedPath }` on success
   - Commit: `feat(dashboard): add publish-run module`

2. Create `agent-core/test/publish-run.test.mjs`
   - happy path (dryRun: true): writes `<id>.json` and `index.json`
   - first run (dryRun: true): creates `index.json` from scratch
   - prepend (dryRun: true): entry added at head of existing array
   - missing `gemini-analysis.json` (dryRun: true): writes failed stub, does NOT throw
   - invalid runId `../etc`: throws before any file write (no dryRun needed)
   - invalid runId `a/b`: throws
   - git push failure: inject `spawnSyncFn` that returns `{ status: 1, stderr: Buffer.from('auth failed') }`; assert returns `{ ok: false }`, does not throw
   - rebase failure: inject `spawnSyncFn` that returns status 1 on pull; assert returns `{ ok: false, error: 'rebase failed' }`
   - Commit: `test(dashboard): publish-run unit tests`

---

## Sprint 2: dashboard HTML [complexity: medium]

files: dashboard/index.html, dashboard/vercel.json
depends_on: []

### Tasks

1. Create `dashboard/vercel.json`
   ```json
   {
     "version": 2,
     "name": "steel-analyzer-report",
     "builds": [{ "src": "**", "use": "@vercel/static" }],
     "headers": [{
       "source": "/runs/(.*).json",
       "headers": [{ "key": "Cache-Control", "value": "no-cache, no-store, must-revalidate" }]
     }]
   }
   ```

2. Create `dashboard/index.html` — single-file app, hash-router
   - Index view (`#/` or empty): loads `./runs/index.json`, renders sortable table
     - Columns: Run ID | Project | Date | Weight kg | Paint m² | Status
     - Status badges via `textContent` (no innerHTML anywhere)
     - Empty state: "No runs yet"
     - Error state if fetch fails: "Dashboard data unavailable"
   - Detail view (`#/run/<id>`): sanitize id → `/^[a-zA-Z0-9_-]{1,80}$/`, loads `./runs/<id>.json`
     - Back button → `#/`
     - KPI cards (6): Weight, Paint, Subprojects, Status, Date, Outputs count
     - Stacked bar chart (weight by category × subproject) — Chart.js 4.4 CDN
     - Donut chart (procurement split) — Chart.js 4.4 CDN
     - Profile table (sortable): Profile | Grade | Qty | Length m | Weight kg | Paint m²
     - All dynamic data via `element.textContent` / `element.setAttribute`
     - Error state: "Run data unavailable" if fetch 404 or JSON parse fails
     - Failed run state: if `status === 'failed'`, show error panel instead of charts
   - Base the layout/style on existing `steel-report-deploy/index.html` (dark theme, Chart.js)
   - Commit: `feat(dashboard): add static dashboard with hash-router`

3. Create `dashboard/runs/index.json` — initial empty array `[]`
   - Commit: `chore(dashboard): init empty runs index`

---

## Sprint 3: Wire + Integration [complexity: medium]

files: agent-core/src/telegram-bot.mjs, agent-core/test/telegram-bot.test.mjs, ecosystem.config.cjs, .env.example
depends_on: [1, 2]

### Tasks

1. Update `agent-core/src/telegram-bot.mjs`
   - Import `publishRun` from `../src/publish-run.mjs`
   - In `approve_upload` callback after `results` loop (upload success path):
     ```js
     const pubResult = await publishRun(runId, join(RUNS_DIR, runId)).catch(err => ({ ok: false, error: err.message }));
     if (!pubResult.ok) {
       await ctx.reply(`⚠️ Uploaded to Drive, but dashboard publish failed: ${pubResult.error}`);
     }
     ```
   - In `approve_upload` catch block (upload failure path) — add AFTER error reply:
     ```js
     await publishRun(runId, join(RUNS_DIR, runId)).catch(() => {});
     ```
   - In `reject_upload` callback after logging:
     ```js
     await publishRun(runId, join(RUNS_DIR, runId)).catch(() => {});
     ```
   - Commit: `feat(dashboard): wire publish-run into telegram-bot`

2. Update `agent-core/test/telegram-bot.test.mjs`
   - Mock `publishRun`
   - Test: `approve_upload` calls `publishRun` on upload success
   - Test: bot sends `⚠️` warning reply when `publishRun` returns `{ ok: false }`
   - Test: `approve_upload` calls `publishRun` on upload failure (error path)
   - Test: `reject_upload` calls `publishRun`
   - Commit: `test(dashboard): telegram-bot publish-run integration tests`

3. Update `ecosystem.config.cjs`
   - Add `GITHUB_TOKEN: process.env.GITHUB_TOKEN || ''` to `steel-bot` env section
   - Commit: `chore(ops): add GITHUB_TOKEN to PM2 bot env`

4. Create `.env.example` in repo root
   ```
   # Required for dashboard auto-publish after each run
   GITHUB_TOKEN=ghp_...
   ```
   - Commit: `docs(ops): add .env.example with GITHUB_TOKEN`

5. Run full test suite: `cd agent-core && npm test`
   - All tests must pass (≥31 existing + new publish-run + new telegram-bot tests)
   - Commit: none (verification only)

---

## PR Summary

Branch: `feat/sprint-11-vercel-dashboard`
Target: `main`

Sprints 1 and 2 are independent (no file overlap) — can be dispatched in parallel.
Sprint 3 depends on both.

Wave plan:
- Wave 1: Sprint 1 + Sprint 2 (parallel)
- Wave 2: Sprint 3 (depends on Wave 1)

Estimated PR: 1 final PR after Wave 2 complete.
Merge method: `gh pr merge --rebase --delete-branch`

<!-- updated-by-superflow:2026-05-24 -->

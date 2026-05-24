# Technical Spec: Sprint 11 — Vercel Dashboard

References: `docs/superflow/specs/2026-05-24-sprint-11-vercel-dashboard-brief.md`

## Overview

Extend the steel-analyzer-automation pipeline with a Vercel-deployed dashboard that automatically reflects every pipeline run. Two new capabilities:

1. **`publish-run.mjs`** — post-upload step that writes run data as JSON into `dashboard/runs/` and commits+pushes to GitHub, triggering Vercel auto-deploy.
2. **`dashboard/`** — static HTML dashboard with hash-router: index view (run list) + detail view (existing KPI layout, data-driven).

## Architecture

```
approve_upload (Telegram callback)
  → steel-drive.mjs upload() [existing]
  → publishRun(runId, runDir, repoRoot)   [NEW]
      reads: steel-bus/runs/<id>/gemini-analysis.json
      writes: dashboard/runs/<id>.json
      updates: dashboard/runs/index.json
      git add/commit/push → Vercel auto-deploy (~2 min)

dashboard/index.html (static, hash-router)
  #/           → index view: fetches ./runs/index.json → sortable run table
  #/run/<id>   → detail view: fetches ./runs/<id>.json → KPI cards + charts + table
```

## File-Level Changes

### New Files

| File | Purpose |
|------|---------|
| `dashboard/index.html` | Static dashboard, two-view hash-router, Chart.js CDN |
| `dashboard/vercel.json` | Vercel static build config with Cache-Control headers |
| `dashboard/runs/index.json` | Auto-generated run manifest (gitignored initially, created by publish-run) |
| `agent-core/src/publish-run.mjs` | `publishRun(runId, runDir, repoRoot)` — writes JSON, git ops |
| `agent-core/test/publish-run.test.mjs` | Unit tests for publish-run |

### Modified Files

| File | Change |
|------|--------|
| `agent-core/src/telegram-bot.mjs` | Call `publishRun()` after successful upload in `approve_upload` callback (non-fatal, wrapped in try/catch) |
| `agent-core/test/telegram-bot.test.mjs` | Add test: publishRun called after upload success; skipped on publishRun failure |
| `CLAUDE.md` | Add dashboard section |
| `llms.txt` | Update file map and architecture |

## Technical Design

### publish-run.mjs

```js
// Entry point
export async function publishRun(runId, runDir, repoRoot, options = {})
```

**Parameters:**
- `runId` — string, validated: `/^[a-zA-Z0-9_-]{1,80}$/` — reject anything else (path traversal prevention)
- `runDir` — absolute path to `steel-bus/runs/<runId>/`
- `repoRoot` — absolute path to git repo root (default: resolved from `__dirname`)
- `options.dryRun` — boolean, skip git ops (for tests)
- `options.spawnSync` — injectable for testing

**Steps:**
1. Validate `runId` against regex — throw `Error('Invalid runId')` if fails
2. Read `<runDir>/gemini-analysis.json` → parse as `run-complete` payload. If missing, build minimal failed entry: `{ run_id: runId, status: 'failed', project_name: 'unknown', created_at: new Date().toISOString(), totals: null, subproject_count: 0 }`
3. Build summary entry: `{ run_id, project_name, status, created_at, totals: { weight_kg, paint_m2 }, subproject_count }`
4. Write `<repoRoot>/dashboard/runs/<runId>.json` (full payload or failed stub)
5. `git pull --rebase` before modifying `index.json` to reduce lost-update risk
6. Read + update `<repoRoot>/dashboard/runs/index.json` (create if missing); prepend new entry; no cap (all history preserved)
7. Unless `dryRun`: `git -C <repoRoot> add dashboard/runs/` → `git commit -m "chore(runs): add run <runId>"` → `git push`. If `git pull --rebase` fails (conflicts or no remote), skip rebase, return `{ ok: false, error: 'rebase failed' }` without committing.
8. Return `{ ok: true, publishedPath, indexUpdated: true }` or `{ ok: false, error: string }`

**Error handling:**
- `runId` invalid → throw immediately (never write files for invalid IDs)
- `gemini-analysis.json` missing → write failed stub (do NOT throw — still publish the failed run)
- git commit/push failure → log to stderr, return `{ ok: false, error }` (never throw from publish step)

### Git Auth — Required Setup

`publish-run.mjs` uses `git push` from the PM2 bot process. Required: the repo must be cloned via HTTPS with a GitHub token embedded in the remote URL, OR via SSH with a key available to the PM2 user. Recommended approach:

```bash
# Set remote with token (add to PM2 env or .env file):
git remote set-url origin https://<GITHUB_TOKEN>@github.com/5691100/steel-analyzer-automation.git
```

Env var `GITHUB_TOKEN` must be set in `ecosystem.config.cjs` under `steel-bot` env. If not set, `publishRun` detects the push failure and returns `{ ok: false }` — the pipeline run is not affected.

Add to `.env.example` in repo root: `GITHUB_TOKEN=ghp_...  # Required for dashboard publish step`

### dashboard/index.html — Hash Router

Single file, vanilla JS, no build step. Two logical views toggled by `window.location.hash`:

**Index view (`#/` or empty hash):**
- Header: "Steel Analyzer — Run History"
- Sortable table columns: Run ID | Project | Date | Weight kg | Paint m² | Status
- Status badges: `success` (green) / `failed` (red) / `partial` (yellow)
- Click row → navigate to `#/run/<id>`
- Empty state: "No runs yet" if index.json is empty or missing

**Detail view (`#/run/<id>`):**
- Back button → `#/`
- KPI cards (6): Total Weight, Total Paint, Subproject count, Status, Run date, MD5 verified
- Charts: stacked bar (weight by category × subproject), donut (procurement split)
- Profile table (sortable): Profile | Grade | Qty | Length m | Weight kg | Paint m²
- Error state: if `runs/<id>.json` missing or `status: failed`, show error message from payload

**Data loading:**
```js
// Index view
const res = await fetch('./runs/index.json');
// Detail view
// runId validated on load — only alphanumeric + hyphens + underscores (client-side guard)
const id = (window.location.hash.replace('#/run/', '') || '').replace(/[^a-zA-Z0-9_-]/g, '');
if (!id) { showError('Invalid run ID'); return; }
const res = await fetch(`./runs/${id}.json`);
```

**XSS prevention:** All dynamic content set via `element.textContent` or `element.setAttribute`, never `innerHTML`. Chart.js labels sanitized via the same regex before rendering.

**Detail view error state:** If fetch returns 404 or JSON parse fails, render: `<div class="error-state">Run data unavailable. The run may still be uploading, or the data was not published.</div>` in the main content area.

**Index cap:** No cap — all runs kept. Index view shows newest first (sorted by `created_at`).

**Libraries:** Chart.js 4.4 via CDN (same as existing `steel-report-deploy/index.html`)

### dashboard/vercel.json

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

### telegram-bot.mjs integration points

**After upload success** (approve_upload callback, after `results` loop):
```js
// Non-fatal publish step
const pubResult = await publishRun(runId, join(RUNS_DIR, runId)).catch(err => ({ ok: false, error: err.message }));
if (!pubResult.ok) {
  await ctx.reply(`⚠️ Uploaded to Drive, but dashboard publish failed: ${pubResult.error}. Run will appear after next manual push.`);
}
```

**After pipeline failure** (catch block in approve_upload and in pipeline-runner error path):
```js
// Publish failed run entry so it appears in dashboard history
await publishRun(runId, join(RUNS_DIR, runId)).catch(() => {});
```

This ensures ALL runs (success + failure + rejection) appear in dashboard history, satisfying the brief edge case.

## Data Contract

`dashboard/runs/index.json` — array, newest first, no cap (full history preserved):
```json
[
  {
    "run_id": "nordic-ajaur-v4-20260524",
    "project_name": "Nordic A-jaur",
    "status": "complete",
    "created_at": "2026-05-24T11:00:00.000Z",
    "totals": { "weight_kg": 12450.3, "paint_m2": 890.1 },
    "subproject_count": 3
  }
]
```

`dashboard/runs/<id>.json` — full `steel.run-complete.v1` payload (as written by llm-dispatcher)

## Testing Strategy

`agent-core/test/publish-run.test.mjs`:
- `publishRun` writes `<id>.json` with correct payload (happy path)
- `publishRun` creates `index.json` on first run (no pre-existing file)
- `publishRun` prepends to existing `index.json` (all history preserved)
- `publishRun` returns `{ ok: false }` (not throws) when git push fails
- `publishRun` writes failed stub when `gemini-analysis.json` missing (does NOT throw)
- `publishRun` throws on invalid `runId` (path traversal attempts: `../etc`, `a/b`)
- All tests use `dryRun: true` to skip actual git ops

`agent-core/test/telegram-bot.test.mjs` additions:
- `approve_upload` calls `publishRun` after successful upload
- Bot sends warning reply when `publishRun` returns `{ ok: false }`
- `reject_upload` callback also calls `publishRun` (failed stub for rejected run)

## Out of Scope

- Quality flags / anomaly detection
- Auth
- Approval actions via dashboard
- Next.js / SSR

<!-- updated-by-superflow:2026-05-24 -->

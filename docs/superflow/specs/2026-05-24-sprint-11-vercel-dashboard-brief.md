# Product Brief: Sprint 11 — Vercel Dashboard

## Problem Statement

After a Steel Analyzer pipeline run completes, there is no single place to view run history or results. The only dashboard is hardcoded for one specific run (Nordic A-jaur v4). Reviewing any run requires opening files manually.

## Jobs to be Done

- When a run completes, I want it to appear in the dashboard without manual action, so history builds automatically.
- When I need to compare two projects, I want to open a run list and click the one I need, rather than searching Drive.

## User Stories

1. As pipeline owner, I want a list of all runs (date / project / status) so I can quickly find the one I need.
2. As pipeline owner, I want to click a run and see full data (KPIs, charts, profile table) to verify extraction quality.
3. As pipeline owner, I want a new run to appear in the dashboard automatically within ~2 min of upload — no manual HTML update.

## Success Criteria

- After `approve_upload` in Telegram → run entry visible in dashboard within ≤3 min.
- All historical runs are clickable; data is correct.
- `cd agent-core && npm test` — all tests green including publish-run tests.

## Edge Cases

- Run failed (`status: failed`): entry written to `index.json` with `status: failed`; detail view shows error message.
- `git push` from pipeline fails (no network / credentials): log to stderr, pipeline run is NOT aborted — publish failure is non-fatal.
- `index.json` missing on first run: `publish-run.mjs` creates the file from scratch.

## Out of Scope

- Quality flags / anomaly detection (Sprint 12)
- Auth / access control
- Approval actions via dashboard (Telegram bot handles this)
- Next.js / server-side rendering

<!-- updated-by-superflow:2026-05-24 -->

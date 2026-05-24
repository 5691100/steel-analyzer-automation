# Steel Analyzer Automation

Automated Google Drive pipeline for steel structure workbook analysis (SIA Stars Met, Latvia).

## Architecture

- **Upload**: User OAuth 2.0 only — no Service Account fallback for writes
- **List / Download**: Service Account (read-only operations)
- **No n8n upload path**: Direct Drive API only; n8n webhook upload removed in Slice 6
- **Integrity**: MD5 hash verified on every download/upload; upload path-contained to run directory
- **Owner gate**: direct uploads require `--owner-approval "I_APPROVE_STEEL_UPLOAD:<run_id>:<folder_id>"`

## Setup

### Prerequisites
- Node.js 18+
- Google Cloud project with Drive API enabled
- OAuth 2.0 client credentials (Desktop app type)
- Service Account credentials for list/download

### First-time OAuth setup
```bash
cd agent-core
npm install
node scripts/steel-drive.mjs setup-oauth --clientId YOUR_CLIENT_ID --clientSecret YOUR_CLIENT_SECRET
```
This prints the auth URL. Visit it, approve access, copy the code, then exchange it non-interactively:
```bash
node scripts/steel-drive.mjs setup-oauth --clientId YOUR_CLIENT_ID --clientSecret YOUR_CLIENT_SECRET --code YOUR_AUTH_CODE
```
Token is stored at `~/.config/codexclaw/secrets/google-oauth-user.json` (mode 0600, directory 0700). **Never commit secrets.**

## Usage

```bash
# Upload a workbook (User OAuth required)
node agent-core/scripts/steel-drive.mjs upload \
  --run <run_id> \
  --folder <drive_folder_id> \
  --file agent-core/steel-bus/runs/<run_id>/your-file.xlsx \
  --owner-approval "I_APPROVE_STEEL_UPLOAD:<run_id>:<drive_folder_id>"

# List files in a folder
node agent-core/scripts/steel-drive.mjs list \
  --run <run_id> \
  --folder <drive_folder_id>

# Download files from a folder
node agent-core/scripts/steel-drive.mjs download \
  --run <run_id> \
  --folder <drive_folder_id>
```

## Orchestrator

The `steel-orchestrator.mjs` manages the full pipeline: trigger → download → analysis → upload → signal.

```bash
node agent-core/scripts/steel-orchestrator.mjs
# or via PM2:
pm2 start agent-core/scripts/steel-orchestrator.mjs --name steel-orchestrator
```

## Security

- Upload is **User OAuth only** — Service Account cannot write files
- Direct upload is **owner-gated** — missing or wrong approval writes `manifest-drive-upload.json` with `upload_executed:false` before any OAuth or Drive call
- Owner approval is accepted only from `--owner-approval <token>` on the CLI. No environment variable, `.env`, or PM2 ecosystem value is consulted.
- The owner approval token is not a secret; it is bound to one run and folder, but it can appear in process tables and shell history.
- File paths for upload are **contained to `runs/<run_id>/`** — no path traversal or symlinked run-directory escape
- Download MD5 is verified against Drive metadata — mismatch aborts immediately
- Upload MD5 is verified against Drive metadata and recorded in `manifest-drive-upload.json`; multi-workbook uploads and re-runs append workbook items to that single manifest
- OAuth tokens stored with `0700` directory and `0600` file permissions
- No credentials committed to this repository

## Operator Runbook

See [docs/production-dry-run.md](docs/production-dry-run.md) for:
- OAuth setup (one-time, non-interactive via `--code`)
- Drive folder listing and download dry-run
- PASS/FAIL criteria and manifest locations
- Upload approval gate

## Tests

```bash
cd agent-core
npm test
```

## Handoffs And Runtime Split

Read [docs/handoffs/{steel} {summary} handoff index - 2026-05-24.md](docs/handoffs/%7Bsteel%7D%20%7Bsummary%7D%20handoff%20index%20-%202026-05-24.md) before sprint planning.
It records the active Steel handoff context, legacy-path policy, and the open
Personal POS follow-up for global/project `AGENTS.md` strategy.

See [docs/operations/{steel} {runbook} llm split workflow - 2026-05-24.md](docs/operations/%7Bsteel%7D%20%7Brunbook%7D%20llm%20split%20workflow%20-%202026-05-24.md) for the owner-mediated Codex/Claude/Gemini split.

## CI

GitHub Actions runs on every PR and push to `main`:
- Dependency install (`npm ci`)
- Syntax check: `steel-drive.mjs`, `steel-orchestrator.mjs`
- Secret pattern scan (high-confidence token values)
- Webhook URL guard (rejects re-introduction of n8n upload webhook)
- `npm audit` (informational)

## Slice 6 Changes (2026-05-23)

- Removed: `UPLOAD_WEBHOOK_URL` (n8n upload webhook dead path)
- Removed: Service Account fallback for upload
- Added: `getUploadDriveClient()` — OAuth-only upload gate
- Restored: upload path containment guard (`path.relative` check)
- Restored: download MD5 mismatch abort
- Hardened: OAuth token storage permissions (0700/0600)

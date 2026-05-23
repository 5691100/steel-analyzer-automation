# Steel Analyzer Automation

Automated Google Drive pipeline for steel structure workbook analysis (SIA Stars Met, Latvia).

## Architecture

- **Upload**: User OAuth 2.0 only — no Service Account fallback for writes
- **List / Download**: Service Account (read-only operations)
- **No n8n upload path**: Direct Drive API only; n8n webhook upload removed in Slice 6
- **Integrity**: MD5 hash verified on every download; upload path-contained to run directory

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
Follow the browser prompt. Token is stored at `agent-core/secrets/oauth-token.json` (mode 0600, directory 0700). **Never commit secrets.**

## Usage

```bash
# Upload a workbook (User OAuth required)
node agent-core/scripts/steel-drive.mjs upload \
  --run <run_id> \
  --folder <drive_folder_id> \
  --file agent-core/steel-bus/runs/<run_id>/your-file.xlsx

# List files in a folder
node agent-core/scripts/steel-drive.mjs list --folder <drive_folder_id>

# Download files from a folder
node agent-core/scripts/steel-drive.mjs download \
  --folder <drive_folder_id> \
  --dest agent-core/steel-bus/runs/<run_id>/

# Verify local files against manifest
node agent-core/scripts/steel-drive.mjs verify --run <run_id>
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
- File paths for upload are **contained to `runs/<run_id>/`** — no path traversal
- Download MD5 is verified against Drive metadata — mismatch aborts immediately
- OAuth tokens stored with `0700` directory and `0600` file permissions
- No credentials committed to this repository

## Slice 6 Changes (2026-05-23)

- Removed: `UPLOAD_WEBHOOK_URL` (n8n upload webhook dead path)
- Removed: Service Account fallback for upload
- Added: `getUploadDriveClient()` — OAuth-only upload gate
- Restored: upload path containment guard (`path.relative` check)
- Restored: download MD5 mismatch abort
- Hardened: OAuth token storage permissions (0700/0600)

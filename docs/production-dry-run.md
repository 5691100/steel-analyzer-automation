# Production Dry-Run Runbook

## Prerequisites
- Node.js 20+
- `cd agent-core && npm ci`
- Google OAuth token configured (see OAuth Setup below)
- Access to RAMP/Steel Drive folder: `14rmeQNlj1tXphidzvrZqSiJVsvOVw2dH`

## OAuth Setup (one-time)

### Step 1 — get auth URL
```bash
node agent-core/scripts/steel-drive.mjs setup-oauth \
  --clientId <YOUR_CLIENT_ID> \
  --clientSecret <YOUR_CLIENT_SECRET>
```
Open the printed URL in a browser. Authorize. Copy the `code` parameter from the redirect URL.

### Step 2 — exchange code for token (non-interactive)
```bash
node agent-core/scripts/steel-drive.mjs setup-oauth \
  --clientId <YOUR_CLIENT_ID> \
  --clientSecret <YOUR_CLIENT_SECRET> \
  --code <CODE_FROM_BROWSER>
```
Token saved to `/root/.config/codexclaw/secrets/google-oauth-user.json` (dir 0700, file 0600).
refresh_token does not expire while used regularly.

## Dry-Run: List Drive Folder

```bash
node agent-core/scripts/steel-drive.mjs list \
  --run dry-run-$(date +%s) \
  --folder 14rmeQNlj1tXphidzvrZqSiJVsvOVw2dH
```

**PASS**: prints file list with names and IDs.  
**FAIL**: `ERROR: No credentials found` → run OAuth setup first.

## Dry-Run: Download Files

```bash
RUN_ID=dry-run-$(date +%s)
node agent-core/scripts/steel-drive.mjs download \
  --run $RUN_ID \
  --folder 14rmeQNlj1tXphidzvrZqSiJVsvOVw2dH
```

**PASS criteria:**
- Files downloaded to `agent-core/steel-bus/runs/<run_id>/`
- `manifest-drive-download.json` written
- MD5 of each file matches Drive metadata (`md5_match: true`)

**FAIL criteria:**
- MD5 mismatch → file corrupt, do not proceed
- `ERROR: No credentials` → OAuth setup required
- `ERROR: path containment` → file destination outside allowed directory

## Viewing Results

```bash
cat agent-core/steel-bus/runs/<run_id>/manifest-drive-download.json
```

Fields to check:
- `status`: must be `"complete"`
- `files[*].md5_match`: must be `true` for all files
- `files[*].local_path`: files present on disk

## Upload (owner approval required)

Upload is blocked until owner runs explicit approval:
```bash
node agent-core/scripts/steel-drive.mjs upload \
  --run <run_id> \
  --folder <target_folder_id> \
  --file <path/to/file.xlsx>
```

**No n8n upload path.** The legacy webhook URL has been removed. All Drive operations go through `steel-drive.mjs` only.

## PASS/FAIL Summary

| Check | PASS | FAIL |
|-------|------|------|
| OAuth / credentials | token present, scope=drive | ERROR: No credentials |
| Drive folder accessible | files listed | permission denied / empty |
| Manifest written | file exists after download | missing / empty |
| MD5 verification | all files md5_match=true | any md5_match=false |
| No n8n upload path | `UPLOAD_WEBHOOK_URL` absent from scripts | rg finds match |
| Upload gate | requires explicit `upload` command | never triggered automatically |

## Log / Manifest Locations

| Artifact | Path |
|----------|------|
| Download manifest | `agent-core/steel-bus/runs/<run_id>/manifest-drive-download.json` |
| OAuth token | `/root/.config/codexclaw/secrets/google-oauth-user.json` |
| PM2 orchestrator logs | `pm2 logs steel-orchestrator` |

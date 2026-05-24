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
- Files downloaded to `agent-core/steel-bus/runs/<run_id>/sources/`
- `manifest-drive-download.json` written
- For every `items[]` entry with `drive_md5`, `drive_md5` equals `local_md5`

**FAIL criteria:**
- MD5 mismatch → file corrupt, do not proceed
- `ERROR: No credentials` → OAuth setup required
- `ERROR: path containment` → file destination outside allowed directory

## Viewing Results

```bash
cat agent-core/steel-bus/runs/<run_id>/manifest-drive-download.json
```

Fields to check:
- `run_id`: equals the selected run id
- `drive_folder_id`: equals the source Drive folder id
- `items[*].drive_file_id`, `items[*].name`, and `items[*].size`: match the listed Drive files
- `items[*].drive_md5` and `items[*].local_md5`: must match when Drive provides an MD5
- downloaded files are present under `agent-core/steel-bus/runs/<run_id>/sources/`

## Upload (owner approval required)

Upload is blocked until the owner provides a token that binds the approval to
the exact run and Drive folder:
```bash
node agent-core/scripts/steel-drive.mjs upload \
  --run <run_id> \
  --folder <target_folder_id> \
  --file agent-core/steel-bus/runs/<run_id>/<path/to/file.xlsx> \
  --owner-approval "I_APPROVE_STEEL_UPLOAD:<run_id>:<target_folder_id>"
```

The upload file must resolve inside `agent-core/steel-bus/runs/<run_id>/`.
Writes use User OAuth only; service-account credentials are not allowed as a
write fallback.

The approval token is read only from `--owner-approval <token>` on the command
line. No environment variable, `.env`, or PM2 ecosystem value is consulted. The
token is not a secret because it is bound to one run and one folder, but it can
still appear in process tables and shell history.

Missing or wrong approval must not touch OAuth or Drive. It writes:
`agent-core/steel-bus/runs/<run_id>/manifest-drive-upload.json`
with `upload_executed:false`, `status:"blocked"`, `skipped_reason`,
`expected_approval_format`, `approval_mode:"owner_token"`,
`md5_status:"not_applicable"`, and `safety_notes`.

Wrong folder approval example:
```bash
node agent-core/scripts/steel-drive.mjs upload \
  --run run-X \
  --folder CORRECT_FOLDER \
  --file agent-core/steel-bus/runs/run-X/artifacts/output.xlsx \
  --owner-approval "I_APPROVE_STEEL_UPLOAD:run-X:WRONG_FOLDER"
```
Expected result: `manifest-drive-upload.json` is written with
`upload_executed:false`, `status:"blocked"`, and
`skipped_reason:"wrong_owner_approval"`. Regenerate the approval token with the
actual folder id: `I_APPROVE_STEEL_UPLOAD:run-X:CORRECT_FOLDER`.

Approved upload writes the same manifest with `oauth_attempted`,
`drive_create_attempted`, `drive_get_attempted`, `local_path`, `local_md5`,
`drive_file_id`, `drive_md5`, `md5_status`, `folder_id`, `run_id`, and
`approval_mode:"owner_token"`. Failed approved attempts still write the
manifest with `status:"failed"` plus matching `skipped_reason`, `error_reason`,
and `error_message`.
Multi-workbook orchestrator uploads append each workbook to `items` in the
single run manifest instead of overwriting previous workbook evidence.
Re-running upload on the same `run_id` appends another entry to `items[]`; rotate
to a fresh `run_id` when you need fresh evidence instead of cumulative evidence.

Orchestrator approval uses the same token:
```bash
node agent-core/scripts/steel-orchestrator.mjs upload-approve <run_id> \
  --owner-approval "I_APPROVE_STEEL_UPLOAD:<run_id>:<target_folder_id>"
```

**No n8n upload path.** The legacy webhook URL has been removed. All Drive operations go through `steel-drive.mjs` only. Guard command:
```bash
rg 'UPLOAD_WEBHOOK_URL|codexclaw-eugeniy-auto-drive-upload' agent-core/scripts/
```

## Production Upload Evidence Checklist

Record these fields for the production rehearsal:
- run id
- branch and commit
- Drive folder id
- files listed, downloaded, and uploaded
- download and upload manifest paths
- MD5 match count
- upload executed, skipped, or blocked by owner gate
- safety notes from `manifest-drive-upload.json`
- PASS/FAIL

## PASS/FAIL Summary

| Check | PASS | FAIL |
|-------|------|------|
| OAuth / credentials | token present, scope=drive | ERROR: No credentials |
| Drive folder accessible | files listed | permission denied / empty |
| Manifest written | file exists after download | missing / empty |
| MD5 verification | every download `items[]` entry has matching `drive_md5` and `local_md5` when Drive provides MD5 | any Drive/local MD5 mismatch |
| No n8n upload path | `rg 'UPLOAD_WEBHOOK_URL|codexclaw-eugeniy-auto-drive-upload' agent-core/scripts/` has no matches | rg finds match |
| Upload gate | exact `--owner-approval "I_APPROVE_STEEL_UPLOAD:<run_id>:<folder_id>"` accepted | missing/wrong token writes blocked manifest and makes no OAuth/Drive call |
| Upload containment | file resolves inside a non-symlinked `steel-bus/runs/<run_id>/` directory | manifest status blocked, `skipped_reason:path_containment_violation` |
| Upload MD5 | `manifest-drive-upload.json` has `md5_status:"match"` for each uploaded item | mismatch, missing Drive MD5, failed approved attempt, or no upload manifest |

## Log / Manifest Locations

| Artifact | Path |
|----------|------|
| Download manifest | `agent-core/steel-bus/runs/<run_id>/manifest-drive-download.json` |
| Upload manifest | `agent-core/steel-bus/runs/<run_id>/manifest-drive-upload.json` |
| OAuth token | `/root/.config/codexclaw/secrets/google-oauth-user.json` |
| PM2 orchestrator logs | `pm2 logs steel-orchestrator` |

## Owner Decisions Before Real Production Upload

- Approval token procedure: decide whether the owner will type the token directly, use a short-lived shell variable, or another local handoff. The tool reads only the CLI flag; avoid leaving reusable commands with live tokens in shared shell history.
- Delivery index: decide whether `web_view_link` from upload evidence needs a permanent delivery index, or whether the run manifest is sufficient for now.
- Rollback/unpublish: current rollback is manual Drive UI delete/unpublish by the owner. A future delete command would need its own owner gate and evidence manifest.
- Re-upload idempotency: current behavior appends and re-uploads on the same `run_id`; use a new `run_id` for clean evidence unless policy changes.
- OAuth lifecycle: decide the production Google account, acceptable scopes, refresh-token rotation cadence, and the re-auth/resume workflow if the refresh token is revoked or missing.

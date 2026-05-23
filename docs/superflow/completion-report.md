# Release Report: Steel Automation Reset (Slice 2 + Slice 3 + Slice 4 + Slice 6)

## 1. What's New

### Secure Drive Operations
- **steel-drive.mjs** — A new, local-first wrapper for Google Drive that handles all file transfers securely.
- **Capabilities**:
  - Securely list and download files with Google Drive credentials.
  - Upload files with the owner's User OAuth credentials only.
  - Automatic MD5 checksum verification for all transfers (no more corrupted downloads).
  - Atomic manifest generation for auditability.
- **How it works**: Uses Node.js (ESM) with the official `googleapis` library, completely bypassing external webhooks for data transfer.

### Automated Workbook Validation
- **Validation Gate** — Every generated Excel workbook is now automatically verified before the analysis is marked as complete.
- **Capabilities**:
  - Detects corrupted files or incorrect formats before they reach the user.
  - Captures sheet metadata (names, counts) to ensure all expected data is present.
- **How it works**: A robust TypeScript utility integrated into the GeminiClaw bot flow performs a "smoke test" on every generated XLSX file.

### Deterministic Signaling (Steel-Bus)
- **Unified Signaling** — GeminiClaw now communicates its progress and results via standard JSON signals in the local `steel-bus`.
- **Capabilities**:
  - The orchestrator can now reliably track run status and file manifests.
  - Signals are strictly validated against JSON schemas.
- **How it works**: Automatic signaling logic in the bot intercepts analyzer results, deduplicates files, and writes atomic JSON signals to the `steel-bus/inbox/run-complete/` directory.

### Legacy Cleanup
- **n8n Transition** — Old n8n workflows used for Drive operations are now marked as `[LEGACY]`.
- **Capabilities**: Clearer architecture and reduced dependence on external cloud services.

## 2. How It Works Together
The system now follows a reliable end-to-end path:
1. **Drive Download**: `steel-drive.mjs` downloads source files with MD5 verification.
2. **Analysis**: GeminiClaw subagents process the files.
3. **Validation**: The validation gate ensures all output workbooks are valid.
4. **Signal**: GeminiClaw writes a `run-complete` signal to the orchestrator, containing the manifest of all verified outputs.

## 3. Slice 3 Consumer/Orchestrator
- **steel-orchestrator** is active under PM2 and processes Steel Bus signals.
- **State machine hardening** now handles failed statuses and duplicate/unexpected signals without silent success.
- **Honest validation gate**: `workbooks_validated` is derived from actual validator output, not forced by test scripts.
- **Upload verification path**: `upload-verified` can close a run after review/integration stages.

## 4. Technical Summary
- **Branch**: `feat/steel-analyzer-slice3`.
- **Local main baseline**: Slice 2 and hardening were already on `main` before Slice 3 work.
- **Review**: ClaudeClaw Slice 3 re-review ACCEPTED.
- **E2E evidence**: `real-e2e-honest-v4` reached `closed`.
- **Tests**: `test-e2e-steel-flow.mjs` passed 26/26; `GeminiClaw` TypeScript check passed.
- **Security**: No credentials in code, signals, manifests, ledgers, logs, or Telegram payload samples.

## 6. Slice 6 OAuth Hardening

- **Upload path enforced**: `upload` command now uses User OAuth only. No Service Account fallback for uploads.
- **SA fallback removed**: removed the code path that silently fell back to SA credentials during upload; upload fails with a clear error if the OAuth token is missing.
- **UPLOAD_WEBHOOK_URL removed**: dead n8n upload webhook constant and all references purged from `steel-drive.mjs`.
- **Token file permissions hardened**: secrets directory is created/chmod'd to `0o700`; token JSON file is written then chmod'd to `0o600`.
- **Upload containment restored**: upload approval again rejects output paths outside `steel-bus/runs/<run_id>/`.
- **Download MD5 guard restored**: Drive download aborts on checksum mismatch instead of only logging it.
- **Evidence**: `slice-6-test` reached `closed`; Drive file `1mpKiyDu0ELkPHGO2Z46rEh5PUw59oTlX` matched MD5 `61d2dbdc3087b9b19982fe3f743e0868`.
- **Review**: Codex technical review `APPROVE`, product review `ACCEPTED`, docs review `PASS`.

## 5. Slice 4 Production Hardening
- **Init idempotency**: duplicate `run_id` is rejected before a second requested ledger entry can be written.
- **Upload readiness**: broken standard-mode auto-approve is removed; owner action via `upload-approve` is explicit.
- **Upload approval**: command checks credentials and state, uploads via `steel-drive.mjs`, and writes `steel.upload-verified.v1` only after all uploads succeed.
- **Validation policy**: `STEEL_VALIDATION_REQUIRE_AUTOFILTER` controls RAMP/source relaxation explicitly; strict AutoFilter validation remains the default.
- **Dependency cleanup**: `agent-core/package.json` owns the `googleapis` dependency; no `node_modules` symlink is required.
- **Review**: ClaudeClaw Slice 4 final review ACCEPTED.

## 7. Known Issues Carried Forward
- **KI-9**: before the first real RAMP production run, verify Steel Analyzer output workbooks are written inside `steel-bus/runs/<run_id>/`; otherwise `upload-approve` will fail safely with a path containment error.

## 8. Status
Slice 4 is accepted. Slice 6 OAuth hardening is accepted and ready for the Superflow ship gate: SA upload fallback removed, `UPLOAD_WEBHOOK_URL` removed, token storage permissions hardened, upload path containment restored, and download MD5 mismatch abort restored. The next operational step is the first controlled real RAMP production dry-run with live Drive credentials after the Slice 6 branch is shipped/merged.

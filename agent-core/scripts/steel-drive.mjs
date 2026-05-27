#!/usr/bin/env node

/**
 * steel-drive.mjs
 *
 * Google Drive wrapper for Steel Analyzer.
 * Supports list, download, and upload with MD5 verification and atomic manifests.
 *
 * Updated: 2026-05-23 - User OAuth support (Slice 6).
 * Upload uses User OAuth only — no Service Account fallback.
 * Updated: 2026-05-24 - Owner-gated upload rehearsal (Sprint 7).
 * Upload requires explicit --owner-approval token scoped to run_id and folder_id.
 * Writes manifest-drive-upload.json for both blocked/skipped and executed uploads.
 */

import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import readline from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Paths - resolved relative to the script location in the worktree
const ROOT = resolve(__dirname, '../../');
const BUS_DIR = join(ROOT, 'agent-core/steel-bus');
const RUNS_DIR = join(BUS_DIR, 'runs');

const OAUTH_TOKEN_PATH = '/root/.config/codexclaw/secrets/google-oauth-user.json';

// ── Environment & Auth ───────────────────────────────────────────────────────

function loadEnv() {
  const envPaths = [
    join(ROOT, 'AntigravityClaw/.env'),
    join(process.env.HOME || '/root', 'AntigravityClaw/.env'),
    join(ROOT, '.env')
  ];
  for (const envPath of envPaths) {
    if (fs.existsSync(envPath)) {
      const envConfig = fs.readFileSync(envPath, 'utf8');
      envConfig.split('\n').forEach(line => {
        const match = line.match(/^([^#=]+)=(.*)$/);
        if (match) {
          const key = match[1].trim();
          let value = match[2].trim();
          if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
          if (!process.env[key]) process.env[key] = value;
        }
      });
    }
  }
}

loadEnv();

function getCredsPath(cmdArgs) {
  if (cmdArgs.creds) return cmdArgs.creds;
  if (process.env.STEEL_DRIVE_CREDS) return process.env.STEEL_DRIVE_CREDS;
  if (process.env.GWS_AUTH_PATH) return process.env.GWS_AUTH_PATH;

  const defaultPath = join(process.env.HOME || '/root', 'AntigravityClaw/store/gws-auth.json');
  if (fs.existsSync(defaultPath)) return defaultPath;

  return null;
}

async function getOAuthClient() {
  if (!fs.existsSync(OAUTH_TOKEN_PATH)) {
    return null;
  }
  const creds = JSON.parse(fs.readFileSync(OAUTH_TOKEN_PATH, 'utf8'));
  const oauth2Client = new google.auth.OAuth2(
    creds.client_id,
    creds.client_secret,
    'http://localhost'
  );
  oauth2Client.setCredentials(creds.token);
  return oauth2Client;
}

export async function getDriveClient(cmdArgs) {
  // 1. Try User OAuth first
  const oauthClient = await getOAuthClient();
  if (oauthClient) {
    return google.drive({ version: 'v3', auth: oauthClient });
  }

  // 2. Fallback to Service Account (for list and download only)
  const credsPath = getCredsPath(cmdArgs);
  if (credsPath && fs.existsSync(credsPath)) {
    const auth = new google.auth.GoogleAuth({
      keyFile: credsPath,
      scopes: ['https://www.googleapis.com/auth/drive'],
    });
    const client = await auth.getClient();
    return google.drive({ version: 'v3', auth: client });
  }

  console.error('ERROR: No credentials found. Run setup-oauth or set GWS_AUTH_PATH.');
  process.exit(1);
}

async function getUploadDriveClient(cmdArgs) {
  // Upload MUST use User OAuth only — no Service Account fallback
  const oauthClient = await getOAuthClient();
  if (!oauthClient) {
    const err = new Error('Upload requires User OAuth token. Run: node steel-drive.mjs setup-oauth');
    err.reason = 'oauth_missing';
    err.tokenPath = OAUTH_TOKEN_PATH;
    throw err;
  }
  return google.drive({ version: 'v3', auth: oauthClient });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const params = {};
  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const value = args[i + 1];
      params[key] = value;
      i++;
    }
  }
  return { cmd, params };
}

function calculateMd5(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const input = fs.createReadStream(filePath);
    input.on('error', reject);
    input.on('data', chunk => hash.update(chunk));
    input.on('close', () => resolve(hash.digest('hex')));
  });
}

function atomicWriteJson(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tempPath = filePath + '.tmp';
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filePath);
}

// ── Commands ─────────────────────────────────────────────────────────────────

async function setupOauth(params) {
  const clientId = params.clientId || process.env.GOOGLE_CLIENT_ID;
  const clientSecret = params.clientSecret || process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.log('\n--- Google OAuth Setup ---');
    console.log('1. Go to Google Cloud Console: https://console.cloud.google.com/apis/credentials');
    console.log('2. Create "OAuth 2.0 Client ID" of type "Desktop app".');
    console.log('3. Run this command again with: --clientId <ID> --clientSecret <SECRET>');
    process.exit(0);
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, 'http://localhost');
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/drive.readonly'],
  });

  if (params.code) {
    try {
      const { tokens } = await oauth2Client.getToken(params.code);
      const storage = { client_id: clientId, client_secret: clientSecret, token: tokens, updated_at: new Date().toISOString() };
      atomicWriteJson(OAUTH_TOKEN_PATH, storage);
      // Ensure secrets directory and file have restricted permissions
      const dir = path.dirname(OAUTH_TOKEN_PATH);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.chmodSync(OAUTH_TOKEN_PATH, 0o600);
      console.log(`\n✓ OAuth token saved to ${OAUTH_TOKEN_PATH}`);
      console.log('   scope:', tokens.scope);
      console.log('   refresh_token:', tokens.refresh_token ? 'present' : 'MISSING — re-auth required');
    } catch (e) {
      console.error('FAILED to get token:', e.message);
      process.exit(1);
    }
    return;
  }

  console.log('\nAuthorize this app by visiting this url:');
  console.log(authUrl);
  console.log('\nThen run with --code <code> to exchange it:');
  console.log(`node steel-drive.mjs setup-oauth --clientId ${clientId} --clientSecret ${clientSecret} --code <CODE>`);
}

async function list(drive, runId, folderId) {
  if (!folderId) throw new Error('--folder <folder_id> is required for list');
  console.log(`Listing folder ${folderId} for run ${runId}...`);
  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false`,
    fields: 'files(id, name, md5Checksum, size, mimeType)',
  });
  const files = res.data.files || [];
  const filtered = files.filter(f => !f.mimeType || !f.mimeType.startsWith('application/vnd.google-apps.'));
  console.table(filtered.map(f => ({ name: f.name, id: f.id, md5: f.md5Checksum, size: f.size })));
  return filtered;
}

export function mergeDownloadManifest(existing, next) {
  if (!existing || existing.run_id !== next.run_id || !Array.isArray(existing.items)) {
    return next;
  }
  const items = [
    ...existing.items,
    ...(next.items || []),
  ];
  return {
    ...existing,
    ...next,
    started_at: existing.started_at || next.started_at,
    ended_at: next.ended_at,
    items,
  };
}

export async function download(drive, runId, folderId) {
  const files = await list(drive, runId, folderId);
  const sourcesDir = join(RUNS_DIR, runId, 'sources');
  if (!fs.existsSync(sourcesDir)) fs.mkdirSync(sourcesDir, { recursive: true });

  const manifestPath = join(RUNS_DIR, runId, 'manifest-drive-download.json');
  const items = [];
  const startedAt = new Date().toISOString();

  for (const file of files) {
    const destPath = join(sourcesDir, file.name);
    console.log(`Downloading ${file.name} (${file.id})...`);

    const res = await drive.files.get({ fileId: file.id, alt: 'media' }, { responseType: 'stream' });
    const dest = fs.createWriteStream(destPath);

    await new Promise((resolve, reject) => {
      res.data.on('end', resolve).on('error', reject).pipe(dest);
    });

    const localMd5 = await calculateMd5(destPath);
    console.log(`  ✓ MD5: ${localMd5}`);
    if (file.md5Checksum && file.md5Checksum !== localMd5) {
      console.error(`FATAL: MD5 mismatch for ${file.name}`);
      console.error(`  Expected: ${file.md5Checksum}`);
      console.error(`  Got:      ${localMd5}`);
      process.exit(1);
    }
    items.push({
      drive_file_id: file.id,
      name: file.name,
      size: parseInt(file.size || 0),
      drive_md5: file.md5Checksum,
      local_md5: localMd5,
      downloaded_at: new Date().toISOString()
    });
  }

  const payload = {
    run_id: runId, drive_folder_id: folderId, started_at: startedAt,
    ended_at: new Date().toISOString(), items
  };

  let finalPayload = payload;
  if (fs.existsSync(manifestPath)) {
    try {
      finalPayload = mergeDownloadManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')), payload);
    } catch (err) {
      console.warn(`Warning: Could not read existing manifest for merging: ${err.message}`);
    }
  }

  atomicWriteJson(manifestPath, finalPayload);
  console.log(`Manifest written to ${manifestPath}`);
}

// ── Owner approval & path containment (Sprint 7) ─────────────────────────────

export const APPROVAL_PREFIX = 'I_APPROVE_STEEL_UPLOAD';
export const RUN_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;

export function validateRunId(runId) {
  if (!runId || !RUN_ID_PATTERN.test(runId)) {
    throw new Error(`Invalid run_id: ${runId || '(empty)'}. Allowed characters: letters, numbers, dot, underscore, hyphen.`);
  }
  return runId;
}

export function expectedApprovalToken(runId, folderId) {
  return `${APPROVAL_PREFIX}:${runId}:${folderId}`;
}

export function checkOwnerApproval(token, runId, folderId) {
  if (!token) return { ok: false, reason: 'missing_owner_approval' };
  const expected = expectedApprovalToken(runId, folderId);
  if (token !== expected) return { ok: false, reason: 'wrong_owner_approval' };
  return { ok: true };
}

export function allowedRunDir(runId) {
  validateRunId(runId);
  const candidate = path.resolve(RUNS_DIR, runId);
  const rel = path.relative(RUNS_DIR, candidate);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Invalid run_id for Drive upload path containment: ${runId}`);
  }
  return candidate;
}

function isRunDirSymlink(runDirAbs) {
  try {
    return fs.lstatSync(runDirAbs).isSymbolicLink();
  } catch {
    return false;
  }
}

// Resist symlink escapes: the run anchor itself must be a real directory under
// the real RUNS_DIR, then the target must resolve under that trusted anchor.
export function pathContainmentResult(allowedDirAbs, candidateAbs) {
  if (isRunDirSymlink(allowedDirAbs)) {
    return { ok: false, reason: `Run directory is a symbolic link: ${allowedDirAbs}` };
  }

  let runsReal;
  let baseReal;
  let targetReal;
  try {
    runsReal = fs.realpathSync(RUNS_DIR);
  } catch (err) {
    return { ok: false, reason: `RUNS_DIR realpath failed for ${RUNS_DIR}: ${err.message}` };
  }
  try {
    baseReal = fs.realpathSync(allowedDirAbs);
  } catch (err) {
    return { ok: false, reason: `Run directory realpath failed for ${allowedDirAbs}: ${err.message}` };
  }
  const baseRel = path.relative(runsReal, baseReal);
  if (baseRel === '' || baseRel.startsWith('..') || path.isAbsolute(baseRel)) {
    return { ok: false, reason: `Run directory resolves outside RUNS_DIR: ${baseReal}` };
  }
  try {
    targetReal = fs.realpathSync(candidateAbs);
  } catch {
    // File does not exist yet — fall back to logical resolution for the parent dir.
    try {
      const parentReal = fs.realpathSync(path.dirname(candidateAbs));
      targetReal = path.join(parentReal, path.basename(candidateAbs));
    } catch (err) {
      return { ok: false, reason: `Candidate parent realpath failed for ${path.dirname(candidateAbs)}: ${err.message}` };
    }
  }
  const rel = path.relative(baseReal, targetReal);
  if (rel === '') return { ok: true, reason: null };
  if (rel.startsWith('..')) return { ok: false, reason: `Candidate resolves outside run directory: ${targetReal}` };
  if (path.isAbsolute(rel)) return { ok: false, reason: `Candidate resolves outside run directory: ${targetReal}` };
  return { ok: true, reason: null };
}

export function isPathContained(allowedDirAbs, candidateAbs) {
  return pathContainmentResult(allowedDirAbs, candidateAbs).ok;
}

function manifestPathFor(runId) {
  return path.join(allowedRunDir(runId), 'manifest-drive-upload.json');
}

function aggregateManifestStatus(items) {
  if (items.some(item => item.status === 'failed')) return 'failed';
  if (items.some(item => item.status === 'blocked')) return 'blocked';
  if (items.every(item => item.status === 'uploaded')) return 'uploaded';
  if (items.every(item => item.status === 'skipped')) return 'skipped';
  return 'blocked';
}

function mergeUploadManifest(existing, next) {
  if (!existing || existing.run_id !== next.run_id || !Array.isArray(existing.items)) {
    return next;
  }
  const items = [
    ...existing.items,
    ...(next.items || []),
  ];
  const safetyNotes = Array.from(new Set([
    ...(existing.safety_notes || []),
    ...(next.safety_notes || []),
  ]));
  return {
    ...existing,
    ...next,
    started_at: existing.started_at || next.started_at,
    ended_at: next.ended_at,
    status: aggregateManifestStatus(items),
    upload_executed: items.some(item => item.upload_executed === true || item.status === 'uploaded'),
    safety_notes: safetyNotes,
    items,
  };
}

function writeUploadManifest(runId, payload, { merge = false } = {}) {
  const manifestPath = manifestPathFor(runId);
  let nextPayload = payload;
  if (merge && fs.existsSync(manifestPath)) {
    try {
      nextPayload = mergeUploadManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')), payload);
    } catch {
      nextPayload = payload;
    }
  }
  atomicWriteJson(manifestPath, nextPayload);
  return manifestPath;
}

function writeSkippedUploadManifest({ runId, folderId, localPath, skippedReason, message }) {
  const now = new Date().toISOString();
  const expectedApproval = folderId ? expectedApprovalToken(runId, folderId) : null;
  const payload = {
    run_id: runId,
    folder_id: folderId || null,
    drive_folder_id: folderId || null,
    started_at: now,
    ended_at: now,
    status: skippedReason === 'local_file_missing' ? 'skipped' : 'blocked',
    upload_executed: false,
    oauth_attempted: false,
    drive_create_attempted: false,
    drive_get_attempted: false,
    skipped_reason: skippedReason,
    message: message || null,
    error_reason: skippedReason,
    error_message: message || null,
    expected_approval_format: expectedApproval,
    approval_mode: 'owner_token',
    local_path: localPath || null,
    local_md5: null,
    drive_file_id: null,
    drive_md5: null,
    md5_status: 'not_applicable',
    safety_notes: [
      'No OAuth token was read before the owner approval gate passed.',
      'No Google Drive API call was attempted before the owner approval gate passed.',
      'Upload writes require user OAuth only; service-account fallback is disabled for writes.',
    ],
    items: [
      {
        local_path: localPath || null,
        local_md5: null,
        drive_file_id: null,
        drive_md5: null,
        md5_status: 'not_applicable',
        status: skippedReason === 'local_file_missing' ? 'skipped' : 'blocked',
        upload_executed: false,
        oauth_attempted: false,
        drive_create_attempted: false,
        drive_get_attempted: false,
        error_reason: skippedReason,
        error_message: message || null,
      },
    ],
  };
  const manifestPath = writeUploadManifest(runId, payload, { merge: true });
  return { manifestPath, payload };
}

function uploadItem({
  absoluteLocalPath,
  localMd5,
  driveFileId,
  driveMd5,
  md5Status,
  status,
  uploadedAt,
  oauthAttempted,
  driveCreateAttempted,
  driveGetAttempted,
  errorReason = null,
  errorMessage = null,
}) {
  return {
    local_path: absoluteLocalPath,
    local_md5: localMd5,
    drive_file_id: driveFileId,
    drive_md5: driveMd5,
    md5_status: md5Status,
    status,
    upload_executed: Boolean(driveFileId),
    oauth_attempted: oauthAttempted,
    drive_create_attempted: driveCreateAttempted,
    drive_get_attempted: driveGetAttempted,
    error_reason: errorReason,
    error_message: errorMessage,
    ...(uploadedAt ? { uploaded_at: uploadedAt } : {}),
  };
}

function writeApprovedUploadManifest({
  runId,
  folderId,
  absoluteLocalPath,
  allowedDir,
  startedAt,
  status,
  uploadExecuted,
  localMd5 = null,
  driveFileId = null,
  driveMd5 = null,
  md5Status = 'not_applicable',
  webViewLink = null,
  oauthAttempted,
  driveCreateAttempted,
  driveGetAttempted,
  errorReason = null,
  errorMessage = null,
}) {
  const endedAt = new Date().toISOString();
  const payload = {
    run_id: runId,
    folder_id: folderId,
    drive_folder_id: folderId,
    started_at: startedAt,
    ended_at: endedAt,
    status,
    upload_executed: uploadExecuted,
    oauth_attempted: oauthAttempted,
    drive_create_attempted: driveCreateAttempted,
    drive_get_attempted: driveGetAttempted,
    skipped_reason: status === 'failed' ? errorReason : null,
    message: errorMessage,
    error_reason: errorReason,
    error_message: errorMessage,
    expected_approval_format: expectedApprovalToken(runId, folderId),
    approval_mode: 'owner_token',
    local_path: absoluteLocalPath,
    local_md5: localMd5,
    drive_file_id: driveFileId,
    drive_md5: driveMd5,
    md5_status: md5Status,
    safety_notes: [
      'Upload was executed only after exact owner approval token validation.',
      'Upload writes used user OAuth only; service-account fallback is disabled for writes.',
      `Local path was resolved and verified inside ${allowedDir}.`,
    ],
    web_view_link: webViewLink,
    items: [
      uploadItem({
        absoluteLocalPath,
        localMd5,
        driveFileId,
        driveMd5,
        md5Status,
        status,
        uploadedAt: endedAt,
        oauthAttempted,
        driveCreateAttempted,
        driveGetAttempted,
        errorReason,
        errorMessage,
      }),
    ],
  };
  const manifestPath = writeUploadManifest(runId, payload, { merge: true });
  return { manifestPath, payload };
}

// ── Upload command ───────────────────────────────────────────────────────────

export async function upload(runId, folderId, localPath, ownerApprovalToken, { driveFactory } = {}) {
  if (!runId) {
    console.error('ERROR: --run <run_id> is required for upload');
    process.exit(1);
  }
  try {
    validateRunId(runId);
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }
  if (!folderId || !localPath) {
    console.error('ERROR: --folder and --file are required for upload');
    process.exit(1);
  }

  // 1. Owner approval gate — runs BEFORE any OAuth or Drive interaction.
  const approval = checkOwnerApproval(ownerApprovalToken, runId, folderId);
  if (!approval.ok) {
    const { manifestPath } = writeSkippedUploadManifest({
      runId,
      folderId,
      localPath,
      skippedReason: approval.reason,
      message:
        approval.reason === 'missing_owner_approval'
          ? `Provide --owner-approval "${expectedApprovalToken(runId, folderId)}"`
          : `--owner-approval did not match expected token for run=${runId} folder=${folderId}`,
    });
    console.error(`ERROR: ${approval.reason}. No OAuth or Drive call performed.`);
    console.error(`  Expected: --owner-approval "${expectedApprovalToken(runId, folderId)}"`);
    console.error(`  Manifest: ${manifestPath} (upload_executed=false, md5_status=not_applicable)`);
    process.exit(2);
  }

  // 2. Path containment — must be inside RUNS/<runId>/, symlink-resistant.
  const allowedDir = allowedRunDir(runId);
  if (!fs.existsSync(allowedDir)) {
    fs.mkdirSync(allowedDir, { recursive: true });
  }
  const absoluteLocalPath = path.resolve(localPath);
  const containment = pathContainmentResult(allowedDir, absoluteLocalPath);
  if (!containment.ok) {
    const { manifestPath } = writeSkippedUploadManifest({
      runId,
      folderId,
      localPath: absoluteLocalPath,
      skippedReason: 'path_containment_violation',
      message: `File must resolve inside ${allowedDir}. ${containment.reason}`,
    });
    console.error(`ERROR: Path restriction violation. File must be inside runs/${runId}/`);
    console.error(`  Allowed (real): ${allowedDir}`);
    console.error(`  Got:            ${absoluteLocalPath}`);
    console.error(`  Manifest:       ${manifestPath} (upload_executed=false)`);
    process.exit(2);
  }

  if (!fs.existsSync(absoluteLocalPath)) {
    const { manifestPath } = writeSkippedUploadManifest({
      runId,
      folderId,
      localPath: absoluteLocalPath,
      skippedReason: 'local_file_missing',
      message: `Local file not found: ${absoluteLocalPath}`,
    });
    console.error(`ERROR: Local file not found: ${absoluteLocalPath}`);
    console.error(`  Manifest: ${manifestPath} (upload_executed=false)`);
    process.exit(2);
  }

  // 3. Approved + contained — now (and only now) acquire OAuth and call Drive.
  const fileName = path.basename(absoluteLocalPath);
  const startedAt = new Date().toISOString();
  let oauthAttempted = false;
  let driveCreateAttempted = false;
  let driveGetAttempted = false;
  let localMd5 = null;
  let driveFileId = null;
  let driveAcquired = false;

  try {
    oauthAttempted = true;
    const drive = driveFactory ? await driveFactory() : await getUploadDriveClient({});
    driveAcquired = true;

    localMd5 = await calculateMd5(absoluteLocalPath);
    console.log(`Uploading ${fileName} (MD5: ${localMd5}) to ${folderId}...`);

    const fileMetadata = { name: fileName, parents: [folderId] };
    const media = { body: fs.createReadStream(absoluteLocalPath) };

    driveCreateAttempted = true;
    const res = await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: 'id, name, md5Checksum',
    });

    driveFileId = res.data.id;
    if (!driveFileId) {
      throw Object.assign(new Error('Drive upload returned no file id'), { reason: 'drive_no_file_id' });
    }

    console.log(`  ✓ Uploaded. Drive File ID: ${driveFileId}`);

    // 4. Verify MD5 against Drive's own checksum.
    console.log('Verifying upload...');
    driveGetAttempted = true;
    const info = await drive.files.get({ fileId: driveFileId, fields: 'md5Checksum, size, webViewLink' });
    const driveMd5 = info.data.md5Checksum;
    const webViewLink = info.data.webViewLink || null;

    let md5Status = 'not_applicable';
    if (!driveMd5) {
      md5Status = 'drive_md5_missing';
      console.error(`  ✗ Drive MD5 missing for file ${driveFileId}. Verification blocked.`);
    } else if (driveMd5 !== localMd5) {
      md5Status = 'mismatch';
      console.error(`  ✗ Verification FAILED: MD5 mismatch! Local: ${localMd5}, Drive: ${driveMd5}`);
    } else {
      md5Status = 'match';
      console.log(`  ✓ Verification SUCCESS: MD5 matches (${localMd5}).`);
    }

    const { manifestPath } = writeApprovedUploadManifest({
      runId,
      folderId,
      absoluteLocalPath,
      allowedDir,
      startedAt,
      status: md5Status === 'match' ? 'uploaded' : 'blocked',
      uploadExecuted: true,
      localMd5,
      driveFileId,
      driveMd5: driveMd5 || null,
      md5Status,
      webViewLink,
      oauthAttempted,
      driveCreateAttempted,
      driveGetAttempted,
      errorReason: md5Status === 'match' ? null : md5Status,
      errorMessage: md5Status === 'match' ? null : `Upload verification status: ${md5Status}`,
    });
    console.log(`Manifest written to ${manifestPath}`);

    if (md5Status !== 'match') {
      process.exit(1);
    }
    return { driveFileId, driveMd5, manifestPath, md5Status };
  } catch (err) {
    const reason = err.reason === 'oauth_missing' ? 'oauth_failed' : err.reason || (
      !driveAcquired ? 'oauth_failed'
        : !localMd5 ? 'local_md5_failed'
          : driveCreateAttempted && !driveFileId ? 'drive_create_failed'
            : driveGetAttempted ? 'drive_get_failed'
              : 'upload_failed'
    );
    const { manifestPath } = writeApprovedUploadManifest({
      runId,
      folderId,
      absoluteLocalPath,
      allowedDir,
      startedAt,
      status: 'failed',
      uploadExecuted: Boolean(driveFileId),
      localMd5,
      driveFileId,
      driveMd5: null,
      md5Status: 'not_applicable',
      oauthAttempted,
      driveCreateAttempted,
      driveGetAttempted,
      errorReason: reason,
      errorMessage: err.message,
    });
    console.error(`ERROR: ${err.message}`);
    if (err.tokenPath) console.error(`       Token path: ${err.tokenPath}`);
    console.error(`  Manifest: ${manifestPath}`);
    process.exit(1);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { cmd, params } = parseArgs();

  if (cmd === 'setup-oauth') {
    await setupOauth(params);
    return;
  }

  const runId = params.run;
  if (!cmd || !runId) {
    console.error('Usage: node steel-drive.mjs <list|download|upload|setup-oauth> --run <run_id> [...]');
    process.exit(1);
  }
  try {
    validateRunId(runId);
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }

  if (cmd === 'list') {
    const drive = await getDriveClient(params);
    await list(drive, runId, params.folder);
  } else if (cmd === 'download') {
    const drive = await getDriveClient(params);
    await download(drive, runId, params.folder);
  } else if (cmd === 'upload') {
    // upload() owns the approval gate and only acquires OAuth after the gate passes.
    await upload(runId, params.folder, params.file, params['owner-approval']);
  } else {
    console.error(`Unknown command: ${cmd}`);
    process.exit(1);
  }
}

const invokedAsScript = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (invokedAsScript) {
  main().catch(err => {
    console.error('FATAL ERROR:', err.message);
    process.exit(1);
  });
}

#!/usr/bin/env node

/**
 * steel-drive.mjs
 *
 * Google Drive wrapper for Steel Analyzer.
 * Supports list, download, and upload with MD5 verification and atomic manifests.
 *
 * Updated: 2026-05-23 - User OAuth support (Slice 6).
 * Upload uses User OAuth only — no Service Account fallback.
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
    join(ROOT, 'GeminiClaw/.env'),
    join(process.env.HOME || '/root', 'GeminiClaw/.env'),
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

  const defaultPath = join(process.env.HOME || '/root', 'GeminiClaw/store/gws-auth.json');
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

async function getDriveClient(cmdArgs) {
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
    console.error('ERROR: Upload requires User OAuth token. Run: node steel-drive.mjs setup-oauth');
    console.error(`       Token path: ${OAUTH_TOKEN_PATH}`);
    process.exit(1);
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

  console.log('\nAuthorize this app by visiting this url:');
  console.log(authUrl);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('\nEnter the code from that page here: ', async (code) => {
    rl.close();
    try {
      const { tokens } = await oauth2Client.getToken(code);
      const storage = {
        client_id: clientId,
        client_secret: clientSecret,
        token: tokens,
        updated_at: new Date().toISOString()
      };

      // Ensure secrets directory exists with restricted permissions
      const secretsDir = path.dirname(OAUTH_TOKEN_PATH);
      if (!fs.existsSync(secretsDir)) {
        fs.mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
      } else {
        fs.chmodSync(secretsDir, 0o700);
      }

      // Write token file and restrict its permissions
      fs.writeFileSync(OAUTH_TOKEN_PATH, JSON.stringify(storage, null, 2));
      fs.chmodSync(OAUTH_TOKEN_PATH, 0o600);

      console.log(`\n✓ OAuth token saved to ${OAUTH_TOKEN_PATH}`);
      console.log(`  Directory permissions: 0700, file permissions: 0600`);
    } catch (e) {
      console.error('FAILED to get token:', e.message);
      process.exit(1);
    }
  });
}

async function list(drive, runId, folderId) {
  if (!folderId) throw new Error('--folder <folder_id> is required for list');
  console.log(`Listing folder ${folderId} for run ${runId}...`);
  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false`,
    fields: 'files(id, name, md5Checksum, size)',
  });
  const files = res.data.files || [];
  console.table(files.map(f => ({ name: f.name, id: f.id, md5: f.md5Checksum, size: f.size })));
  return files;
}

async function download(drive, runId, folderId) {
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

  atomicWriteJson(manifestPath, {
    run_id: runId, drive_folder_id: folderId, started_at: startedAt,
    ended_at: new Date().toISOString(), items
  });
  console.log(`Manifest written to ${manifestPath}`);
}

async function upload(drive, runId, folderId, localPath) {
  if (!folderId || !localPath) throw new Error('--folder and --file are required for upload');

  // Enforce run-scoped upload: file must be inside agent-core/steel-bus/runs/<runId>/
  const allowedDir = path.resolve(process.cwd(), 'agent-core', 'steel-bus', 'runs', runId);
  const absoluteLocalPath = path.resolve(localPath);
  const rel = path.relative(allowedDir, absoluteLocalPath);
  if (!runId || rel.startsWith('..') || path.isAbsolute(rel)) {
    console.error(`ERROR: Path restriction violation. File must be inside runs/${runId}/`);
    console.error(`  Allowed: ${allowedDir}`);
    console.error(`  Got:     ${absoluteLocalPath}`);
    process.exit(1);
  }

  if (!fs.existsSync(localPath)) {
    console.error(`ERROR: Local file not found: ${localPath}`);
    process.exit(1);
  }

  const fileName = path.basename(localPath);
  const localMd5 = await calculateMd5(localPath);
  console.log(`Uploading ${fileName} (MD5: ${localMd5}) to ${folderId}...`);

  const fileMetadata = { name: fileName, parents: [folderId] };
  const media = { body: fs.createReadStream(localPath) };

  const res = await drive.files.create({
    resource: fileMetadata,
    media: media,
    fields: 'id, name, md5Checksum'
  });

  const driveFileId = res.data.id;
  if (!driveFileId) {
    throw new Error('Upload failed: No driveFileId returned');
  }

  console.log(`  ✓ Uploaded. Drive File ID: ${driveFileId}`);

  // Strict Verification
  console.log(`Verifying upload...`);
  const info = await drive.files.get({ fileId: driveFileId, fields: 'md5Checksum, size' });
  const driveMd5 = info.data.md5Checksum;

  if (!driveMd5) {
    throw new Error(`FATAL: Drive MD5 missing for file ${driveFileId}. Verification blocked.`);
  }

  if (driveMd5 !== localMd5) {
    console.error(`  ✗ Verification FAILED: MD5 mismatch! Local: ${localMd5}, Drive: ${driveMd5}`);
    process.exit(1);
  }
  console.log(`  ✓ Verification SUCCESS: MD5 matches (${localMd5}).`);
  return { driveFileId, driveMd5 };
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

  if (cmd === 'list') {
    const drive = await getDriveClient(params);
    await list(drive, runId, params.folder);
  } else if (cmd === 'download') {
    const drive = await getDriveClient(params);
    await download(drive, runId, params.folder);
  } else if (cmd === 'upload') {
    // Upload uses User OAuth only — getUploadDriveClient will exit if token missing
    const drive = await getUploadDriveClient(params);
    await upload(drive, runId, params.folder, params.file);
  } else {
    console.error(`Unknown command: ${cmd}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('FATAL ERROR:', err.message);
  process.exit(1);
});

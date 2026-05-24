import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { upload } from '../scripts/steel-drive.mjs';

const __filename = fileURLToPath(import.meta.url);
const AGENT_CORE = path.resolve(path.dirname(__filename), '..');
const RUNS_DIR = path.join(AGENT_CORE, 'steel-bus/runs');

function resetRun(runId) {
  fs.rmSync(path.join(RUNS_DIR, runId), { recursive: true, force: true });
}

function readUploadManifest(runId) {
  return JSON.parse(fs.readFileSync(path.join(RUNS_DIR, runId, 'manifest-drive-upload.json'), 'utf8'));
}

async function captureExit(fn) {
  const originalExit = process.exit;
  const originalError = console.error;
  const errors = [];
  process.exit = (code = 0) => {
    const err = new Error(`process.exit:${code}`);
    err.exitCode = code;
    throw err;
  };
  console.error = (...args) => {
    errors.push(args.join(' '));
  };
  try {
    await fn();
    assert.fail('Expected process.exit');
  } catch (err) {
    if (!String(err.message).startsWith('process.exit:')) throw err;
    return { code: err.exitCode, errors: errors.join('\n') };
  } finally {
    process.exit = originalExit;
    console.error = originalError;
  }
}

test('missing owner approval blocks before OAuth/Drive and writes non-executed manifest evidence', async (t) => {
  const runId = 'sprint7-test-missing-approval';
  t.after(() => resetRun(runId));
  const folderId = 'folder-missing-approval';
  const localPath = path.join(RUNS_DIR, runId, 'artifacts/output.xlsx');
  resetRun(runId);

  const result = await captureExit(() => upload(runId, folderId, localPath, null, {
    driveFactory: () => assert.fail('Drive factory must not be called without owner approval'),
  }));

  assert.equal(result.code, 2);
  assert.match(result.errors, /missing_owner_approval/);
  assert.doesNotMatch(result.errors, /Upload requires User OAuth token/);

  const manifest = readUploadManifest(runId);
  assert.equal(manifest.upload_executed, false);
  assert.equal(manifest.status, 'blocked');
  assert.equal(manifest.skipped_reason, 'missing_owner_approval');
  assert.equal(manifest.expected_approval_format, `I_APPROVE_STEEL_UPLOAD:${runId}:${folderId}`);
  assert.equal(manifest.approval_mode, 'owner_token');
  assert.deepEqual(manifest.safety_notes, [
    'No OAuth token was read before the owner approval gate passed.',
    'No Google Drive API call was attempted before the owner approval gate passed.',
    'Upload writes require user OAuth only; service-account fallback is disabled for writes.',
  ]);
  assert.equal(manifest.items[0].md5_status, 'not_applicable');
});

test('invalid run id is rejected before approval, OAuth, or Drive work', async () => {
  const runId = 'sprint7-test;bad';
  const folderId = 'folder-invalid-run-id';
  const localPath = path.join(RUNS_DIR, 'sprint7-test-bad', 'artifacts/output.xlsx');

  const result = await captureExit(() => upload(runId, folderId, localPath, null, {
    driveFactory: () => assert.fail('Drive factory must not be called for invalid run id'),
  }));

  assert.equal(result.code, 1);
  assert.match(result.errors, /Invalid run_id/);
});

test('wrong owner approval token is rejected with expected token in manifest', async (t) => {
  const runId = 'sprint7-test-wrong-approval';
  t.after(() => resetRun(runId));
  const folderId = 'folder-wrong-approval';
  const localPath = path.join(RUNS_DIR, runId, 'artifacts/output.xlsx');
  resetRun(runId);

  const result = await captureExit(() => upload(
    runId,
    folderId,
    localPath,
    `I_APPROVE_STEEL_UPLOAD:${runId}:different-folder`,
    { driveFactory: () => assert.fail('Drive factory must not be called with wrong owner approval') },
  ));

  assert.equal(result.code, 2);
  assert.match(result.errors, /wrong_owner_approval/);
  assert.doesNotMatch(result.errors, /Upload requires User OAuth token/);

  const manifest = readUploadManifest(runId);
  assert.equal(manifest.upload_executed, false);
  assert.equal(manifest.status, 'blocked');
  assert.equal(manifest.skipped_reason, 'wrong_owner_approval');
  assert.equal(manifest.expected_approval_format, `I_APPROVE_STEEL_UPLOAD:${runId}:${folderId}`);
  assert.equal(manifest.items[0].md5_status, 'not_applicable');
});

test('approved upload rejects paths outside RUNS_DIR/runId before OAuth/Drive', async (t) => {
  const runId = 'sprint7-test-path-containment';
  t.after(() => resetRun(runId));
  const folderId = 'folder-path-containment';
  const outsidePath = path.join(AGENT_CORE, 'package.json');
  resetRun(runId);

  const result = await captureExit(() => upload(
    runId,
    folderId,
    outsidePath,
    `I_APPROVE_STEEL_UPLOAD:${runId}:${folderId}`,
    { driveFactory: () => assert.fail('Drive factory must not be called for path containment rejection') },
  ));

  assert.equal(result.code, 2);
  assert.match(result.errors, /Path restriction violation/);
  assert.doesNotMatch(result.errors, /Upload requires User OAuth token/);

  const manifest = readUploadManifest(runId);
  assert.equal(manifest.upload_executed, false);
  assert.equal(manifest.status, 'blocked');
  assert.equal(manifest.skipped_reason, 'path_containment_violation');
  assert.equal(manifest.items[0].local_path, outsidePath);
  assert.equal(manifest.items[0].md5_status, 'not_applicable');
});

test('approved upload rejects symlinked run directory escape before OAuth/Drive', async (t) => {
  const runId = 'sprint7-test-symlink-run-dir';
  const folderId = 'folder-symlink-run-dir';
  const runDir = path.join(RUNS_DIR, runId);
  const outsideDir = path.join(AGENT_CORE, 'steel-bus', `${runId}-outside-target`);
  const localPath = path.join(runDir, 'artifacts/output.xlsx');
  t.after(() => {
    resetRun(runId);
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });
  resetRun(runId);
  fs.rmSync(outsideDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(outsideDir, 'artifacts'), { recursive: true });
  fs.writeFileSync(path.join(outsideDir, 'artifacts/output.xlsx'), 'escaped through symlink\n');
  fs.symlinkSync(outsideDir, runDir, 'dir');

  const result = await captureExit(() => upload(
    runId,
    folderId,
    localPath,
    `I_APPROVE_STEEL_UPLOAD:${runId}:${folderId}`,
    { driveFactory: () => assert.fail('Drive factory must not be called for symlinked run directory') },
  ));

  assert.equal(result.code, 2);
  assert.match(result.errors, /Path restriction violation/);
  assert.doesNotMatch(result.errors, /Upload requires User OAuth token/);
});

test('approved upload writes failed manifest when OAuth acquisition fails', async (t) => {
  const runId = 'sprint7-test-approved-oauth-failure';
  t.after(() => resetRun(runId));
  const folderId = 'folder-approved-oauth-failure';
  const runDir = path.join(RUNS_DIR, runId);
  const localPath = path.join(runDir, 'artifacts/output.xlsx');
  resetRun(runId);
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  fs.writeFileSync(localPath, 'approved upload oauth failure\n');

  const result = await captureExit(() => upload(
    runId,
    folderId,
    localPath,
    `I_APPROVE_STEEL_UPLOAD:${runId}:${folderId}`,
    { driveFactory: async () => { throw new Error('oauth token unavailable'); } },
  ));

  assert.equal(result.code, 1);
  assert.match(result.errors, /oauth token unavailable/);

  const manifest = readUploadManifest(runId);
  assert.equal(manifest.status, 'failed');
  assert.equal(manifest.upload_executed, false);
  assert.equal(manifest.oauth_attempted, true);
  assert.equal(manifest.drive_create_attempted, false);
  assert.equal(manifest.drive_file_id, null);
  assert.equal(manifest.local_md5, null);
  assert.equal(manifest.skipped_reason, 'oauth_failed');
  assert.equal(manifest.error_reason, 'oauth_failed');
  assert.equal(manifest.error_message, 'oauth token unavailable');
  assert.equal(manifest.items[0].status, 'failed');
  assert.equal(manifest.items[0].error_reason, 'oauth_failed');
});

test('approved upload appends successful workbook items to one manifest', async (t) => {
  const runId = 'sprint7-test-approved-multi-file-manifest';
  t.after(() => resetRun(runId));
  const folderId = 'folder-approved-multi-file-manifest';
  const runDir = path.join(RUNS_DIR, runId);
  const firstPath = path.join(runDir, 'artifacts/first.xlsx');
  const secondPath = path.join(runDir, 'artifacts/second.xlsx');
  resetRun(runId);
  fs.mkdirSync(path.dirname(firstPath), { recursive: true });
  fs.writeFileSync(firstPath, 'first workbook\n');
  fs.writeFileSync(secondPath, 'second workbook\n');
  const md5ByName = new Map([
    ['first.xlsx', crypto.createHash('md5').update('first workbook\n').digest('hex')],
    ['second.xlsx', crypto.createHash('md5').update('second workbook\n').digest('hex')],
  ]);

  function driveFactory() {
    return {
      files: {
        create: async ({ resource, media }) => {
          await new Promise((resolve, reject) => {
            media.body.on('error', reject);
            media.body.on('end', resolve);
            media.body.resume();
          });
          return { data: { id: `drive-file-${resource.name}`, name: resource.name, md5Checksum: md5ByName.get(resource.name) } };
        },
        get: async ({ fileId }) => {
          const name = fileId.replace('drive-file-', '');
          return { data: { md5Checksum: md5ByName.get(name), size: '1', webViewLink: `https://drive.example/${name}` } };
        },
      },
    };
  }

  await upload(runId, folderId, firstPath, `I_APPROVE_STEEL_UPLOAD:${runId}:${folderId}`, { driveFactory });
  await upload(runId, folderId, secondPath, `I_APPROVE_STEEL_UPLOAD:${runId}:${folderId}`, { driveFactory });
  await upload(runId, folderId, firstPath, `I_APPROVE_STEEL_UPLOAD:${runId}:${folderId}`, { driveFactory });

  const manifest = readUploadManifest(runId);
  assert.equal(manifest.status, 'uploaded');
  assert.equal(manifest.items.length, 3);
  assert.deepEqual(manifest.items.map((item) => path.basename(item.local_path)), ['first.xlsx', 'second.xlsx', 'first.xlsx']);
  assert.deepEqual(manifest.items.map((item) => item.drive_file_id), ['drive-file-first.xlsx', 'drive-file-second.xlsx', 'drive-file-first.xlsx']);
});

test('approved upload verifies MD5 and writes executed manifest evidence', async (t) => {
  const runId = 'sprint7-test-approved-upload';
  t.after(() => resetRun(runId));
  const folderId = 'folder-approved-upload';
  const runDir = path.join(RUNS_DIR, runId);
  const localPath = path.join(runDir, 'artifacts/output.xlsx');
  resetRun(runId);
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  fs.writeFileSync(localPath, 'approved upload rehearsal\n');
  const localMd5 = crypto.createHash('md5').update('approved upload rehearsal\n').digest('hex');

  const result = await upload(
    runId,
    folderId,
    localPath,
    `I_APPROVE_STEEL_UPLOAD:${runId}:${folderId}`,
    {
      driveFactory: async () => ({
        files: {
          create: async ({ resource, media }) => {
            assert.equal(resource.parents[0], folderId);
            await new Promise((resolve, reject) => {
              media.body.on('error', reject);
              media.body.on('end', resolve);
              media.body.resume();
            });
            return { data: { id: 'drive-file-approved-upload', name: resource.name, md5Checksum: localMd5 } };
          },
          get: async ({ fileId }) => {
            assert.equal(fileId, 'drive-file-approved-upload');
            return { data: { md5Checksum: localMd5, size: String(fs.statSync(localPath).size), webViewLink: 'https://drive.example/file' } };
          },
        },
      }),
    },
  );

  assert.equal(result.md5Status, 'match');
  const manifest = readUploadManifest(runId);
  assert.equal(manifest.upload_executed, true);
  assert.equal(manifest.status, 'uploaded');
  assert.equal(manifest.run_id, runId);
  assert.equal(manifest.folder_id, folderId);
  assert.equal(manifest.approval_mode, 'owner_token');
  assert.equal(manifest.local_path, localPath);
  assert.equal(manifest.local_md5, localMd5);
  assert.equal(manifest.drive_file_id, 'drive-file-approved-upload');
  assert.equal(manifest.drive_md5, localMd5);
  assert.equal(manifest.md5_status, 'match');
  assert.equal(manifest.items[0].md5_status, 'match');
});

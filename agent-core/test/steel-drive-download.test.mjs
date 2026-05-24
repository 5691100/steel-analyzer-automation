import { describe, it, beforeEach, afterEach } from 'node:test';
import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Mocking list and drive client is complex, so we'll test the helper mergeDownloadManifest directly 
// or test the logic by calling the script if we can.
// Actually, I'll just test mergeDownloadManifest since I exported it or I can just test it by reading the file.

// Let's import the script as a module if possible.
// Wait, the script is not an ESM module with exports for those helpers.
// I'll update it to export mergeDownloadManifest for testing.

import { mergeDownloadManifest, download } from '../scripts/steel-drive.mjs';

const __test_filename = fileURLToPath(import.meta.url);
const AGENT_CORE = path.resolve(path.dirname(__test_filename), '..');
const RUNS_DIR = path.join(AGENT_CORE, 'steel-bus/runs');

function resetRun(runId) {
  fs.rmSync(path.join(RUNS_DIR, runId), { recursive: true, force: true });
}

function readDownloadManifest(runId) {
  return JSON.parse(fs.readFileSync(path.join(RUNS_DIR, runId, 'manifest-drive-download.json'), 'utf8'));
}

describe('Steel Drive Download Manifest', () => {
  it('should merge download manifests correctly', () => {
    const existing = {
      run_id: 'test-run',
      items: [{ name: 'file1.pdf' }]
    };
    const next = {
      run_id: 'test-run',
      items: [{ name: 'file2.pdf' }]
    };
    const result = mergeDownloadManifest(existing, next);
    assert.strictEqual(result.items.length, 2);
    assert.strictEqual(result.items[0].name, 'file1.pdf');
    assert.strictEqual(result.items[1].name, 'file2.pdf');
  });

  it('should return next if existing is missing or run_id mismatch', () => {
    const next = { run_id: 'test-run', items: [] };
    assert.deepStrictEqual(mergeDownloadManifest(null, next), next);
    assert.deepStrictEqual(mergeDownloadManifest({ run_id: 'other' }, next), next);
  });

  it('should aggregate manifests on multiple download calls', async () => {
    const runId = 'test-download-agg';
    resetRun(runId);
    fs.mkdirSync(path.join(RUNS_DIR, runId), { recursive: true });

    const emptyMd5 = 'd41d8cd98f00b204e9800998ecf8427e';
    const drive = {
      files: {
        list: async ({ q }) => {
          if (q.includes('folder1')) {
            return { data: { files: [{ id: 'f1', name: 'f1.pdf', md5Checksum: emptyMd5, size: '0' }] } };
          }
          if (q.includes('folder2')) {
            return { data: { files: [{ id: 'f2', name: 'f2.pdf', md5Checksum: emptyMd5, size: '0' }] } };
          }
          return { data: { files: [] } };
        },
        get: async () => {
          return { data: { on: (evt, cb) => { if (evt === 'end') cb(); return { on: () => {} }; }, pipe: (dest) => { dest.end(); return { on: (evt, cb) => { if (evt === 'end') cb(); } }; } } };
        }
      }
    };

    await download(drive, runId, 'folder1');
    let manifest = readDownloadManifest(runId);
    assert.strictEqual(manifest.items.length, 1);
    assert.strictEqual(manifest.items[0].name, 'f1.pdf');

    await download(drive, runId, 'folder2');
    manifest = readDownloadManifest(runId);
    assert.strictEqual(manifest.items.length, 2);
    assert.strictEqual(manifest.items[0].name, 'f1.pdf');
    assert.strictEqual(manifest.items[1].name, 'f2.pdf');

    resetRun(runId);
  });
});

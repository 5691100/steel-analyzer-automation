import { describe, it, beforeEach, afterEach } from 'node:test';
import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import { fileURLToPath } from 'url';

const __test_filename = fileURLToPath(import.meta.url);
const AGENT_CORE = path.resolve(path.dirname(__test_filename), '..');
const RUNS_DIR = path.join(AGENT_CORE, 'steel-bus/runs');

import { mergeDownloadManifest, download } from '../scripts/steel-drive.mjs';

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
    const runDir = path.join(RUNS_DIR, runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.mkdirSync(path.join(runDir, 'sources'), { recursive: true });

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
          // Mock a stream-like object
          const mockStream = {
            on: (evt, cb) => {
              if (evt === 'end') setTimeout(cb, 5);
              return mockStream;
            },
            pipe: (dest) => {
              dest.end();
              return dest;
            }
          };
          return { data: mockStream };
        }
      }
    };

    // We need to ensure calculateMd5 doesn't fail. Since we're writing empty files, it should be fine.
    // Wait, steel-drive.mjs uses fs.createWriteStream.
    
    await download(drive, runId, 'folder1');
    let manifest = readDownloadManifest(runId);
    assert.strictEqual(manifest.items.length, 1);

    await download(drive, runId, 'folder2');
    manifest = readDownloadManifest(runId);
    assert.strictEqual(manifest.items.length, 2);

    resetRun(runId);
  });
});

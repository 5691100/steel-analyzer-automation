import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { runPipeline } from '../src/pipeline-runner.mjs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Pipeline Runner', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-runner-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should notify on each step of the pipeline', async (t) => {
    const notifications = [];
    const notifyFn = async (text, keyboard) => {
      notifications.push({ text, keyboard });
    };

    const runId = 'test-pipeline-run';
    const folderId = 'test-folder';

    // Mocks
    const getDrive = async () => ({});
    const doDownload = async () => {
      const runDir = path.join(tempDir, 'steel-bus/runs', runId);
      if (!fs.existsSync(runDir)) fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, 'manifest-drive-download.json'), JSON.stringify({ items: [1, 2, 3] }));
    };
    const doAnalysis = async () => ({ ok: true });
    const doQA = async () => ({ verdict: 'ACCEPTED' });

    const runsDir = path.join(tempDir, 'steel-bus/runs');
    await runPipeline(runId, folderId, notifyFn, { getDrive, doDownload, doAnalysis, doQA, runsDir });

    assert.ok(notifications.length >= 4, `Expected at least 4 notifications, got ${notifications.length}`);
    assert.match(notifications[0].text, /Steel Analyzer запущен/);
    assert.match(notifications[notifications.length - 1].text, /QA: ACCEPTED/);
  });

  it('should notify on error during download', async (t) => {
    const notifications = [];
    const notifyFn = async (text) => {
      notifications.push(text);
    };

    const getDrive = async () => { throw new Error('Auth failed'); };

    try {
      await runPipeline('error-run', 'folder', notifyFn, { getDrive });
    } catch (err) {
      // expected
    }

    assert.ok(notifications.some(n => n.includes('❌ Pipeline failed: Auth failed')));
  });
});

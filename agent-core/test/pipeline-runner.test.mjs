import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { runPipeline } from '../src/pipeline-runner.mjs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function setupRun(tempDir, runId, itemCount = 3) {
  const runsDir = path.join(tempDir, 'steel-bus/runs');
  const runDir = path.join(runsDir, runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, 'manifest-drive-download.json'),
    JSON.stringify({ items: Array(itemCount).fill({}) })
  );
  return { runsDir, runDir };
}

describe('Pipeline Runner', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-runner-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // ── Existing tests (preserved) ────────────────────────────────────────────

  it('should notify on each step of the pipeline', async () => {
    const notifications = [];
    const notifyFn = async (text, keyboard) => notifications.push({ text, keyboard });
    const runId = 'test-pipeline-run';
    const folderId = 'test-folder';
    const getDrive = async () => ({});
    const doDownload = async () => {
      const { runDir } = setupRun(tempDir, runId);
    };
    const doAnalysis = async () => ({ ok: true });
    const doQA = async () => ({ verdict: 'ACCEPTED' });
    const waitForGate = async () => 'approve';
    const makeGateKb = () => ({ inline_keyboard: [] });
    const { runsDir } = setupRun(tempDir, runId);

    await runPipeline(runId, folderId, notifyFn, {
      getDrive, doDownload, doAnalysis, doQA, waitForGate, makeGateKb, runsDir,
    });

    assert.ok(notifications.length >= 4, `Expected ≥4 notifications, got ${notifications.length}`);
    assert.match(notifications[0].text, /Steel Analyzer запущен/);
  });

  it('should notify on error during download', async () => {
    const notifications = [];
    const notifyFn = async (text) => notifications.push(text);
    const getDrive = async () => { throw new Error('Auth failed'); };

    try {
      await runPipeline('error-run', 'folder', notifyFn, { getDrive });
    } catch {}

    assert.ok(notifications.some(n => n.includes('❌ Pipeline failed: Auth failed')));
  });

  it('should throw error when QA is BLOCKED after max corrections', async () => {
    const notifications = [];
    const notifyFn = async (text) => notifications.push(text);
    const runId = 'blocked-run';
    const folderId = 'test-folder';
    const getDrive = async () => ({});
    const doDownload = async () => { setupRun(tempDir, runId); };
    const doAnalysis = async () => ({ ok: true });
    const doQA = async () => ({ verdict: 'BLOCKED', notes: 'QA-blocked reasons' });
    const waitForGate = async () => 'approve';
    const makeGateKb = () => ({ inline_keyboard: [] });
    const { runsDir } = setupRun(tempDir, runId);

    await assert.rejects(
      runPipeline(runId, folderId, notifyFn, {
        getDrive, doDownload, doAnalysis, doQA, waitForGate, makeGateKb, runsDir, maxCorrections: 0,
      }),
      { message: /QA blocked/ }
    );
    assert.ok(notifications.some(n => typeof n === 'string' && n.includes('QA: BLOCKED')));
  });

  // ── New gate tests ─────────────────────────────────────────────────────────

  it('pipeline calls waitForGate for each of 5 gates in order when approved', async () => {
    const gatesCalled = [];
    const waitForGate = async (runId, gateId) => {
      gatesCalled.push(gateId);
      return 'approve';
    };
    const makeGateKb = () => ({ inline_keyboard: [] });
    const notifications = [];
    const notifyFn = async (text, kb) => notifications.push({ text, kb });
    const runId = 'gate-order-run';
    const { runsDir } = setupRun(tempDir, runId);

    await runPipeline(runId, 'folder', notifyFn, {
      getDrive: async () => ({}),
      doDownload: async () => { setupRun(tempDir, runId); },
      doAnalysis: async () => ({ ok: true }),
      doQA: async () => ({ verdict: 'ACCEPTED' }),
      doUpload: async () => ({ md5Status: 'OK', manifestPath: 'manifest.json' }),
      doPublish: async () => ({ ok: true }),
      waitForGate,
      makeGateKb,
      runsDir,
    });

    assert.deepEqual(gatesCalled, ['g1_gemini', 'g2_qa', 'g4_codex', 'g5_upload'],
      `Expected gates in order, got: ${gatesCalled}`);
  });

  it('pipeline stops at G1 when rejected', async () => {
    const waitForGate = async (runId, gateId) => gateId === 'g1_gemini' ? 'reject' : 'approve';
    let analysisCalledCount = 0;
    const doAnalysis = async () => { analysisCalledCount++; return { ok: true }; };

    const runId = 'reject-g1-run';
    const { runsDir } = setupRun(tempDir, runId);

    await runPipeline(runId, 'folder', async () => {}, {
      getDrive: async () => ({}),
      doDownload: async () => { setupRun(tempDir, runId); },
      doAnalysis,
      waitForGate,
      makeGateKb: () => ({ inline_keyboard: [] }),
      runsDir,
    });

    assert.equal(analysisCalledCount, 0, 'Analysis should not run when G1 rejected');
  });

  it('correction loop runs up to maxCorrections times then throws', async () => {
    const waitForGate = async () => 'approve';
    let analysisCount = 0;
    const doAnalysis = async () => { analysisCount++; return { ok: true }; };
    const doQA = async () => ({ verdict: 'BLOCKED', notes: 'bad profile' });

    const runId = 'correction-loop-run';
    const { runsDir } = setupRun(tempDir, runId);

    await assert.rejects(
      runPipeline(runId, 'folder', async () => {}, {
        getDrive: async () => ({}),
        doDownload: async () => { setupRun(tempDir, runId); },
        doAnalysis,
        doQA,
        waitForGate,
        makeGateKb: () => ({ inline_keyboard: [] }),
        runsDir,
        maxCorrections: 2,
      }),
      /QA blocked/
    );

    // 1 initial analysis + 2 correction re-runs
    assert.equal(analysisCount, 3, `Expected 3 analysis calls (1+2 corrections), got ${analysisCount}`);
  });

  it('correction loop exits early on G3 reject', async () => {
    let qaCount = 0;
    const waitForGate = async (runId, gateId) => {
      if (gateId === 'g3_correction') return 'reject';
      return 'approve';
    };
    const doQA = async () => { qaCount++; return { verdict: 'BLOCKED', notes: 'defect' }; };

    const runId = 'correction-reject-run';
    const { runsDir } = setupRun(tempDir, runId);

    await runPipeline(runId, 'folder', async () => {}, {
      getDrive: async () => ({}),
      doDownload: async () => { setupRun(tempDir, runId); },
      doAnalysis: async () => ({ ok: true }),
      doQA,
      waitForGate,
      makeGateKb: () => ({ inline_keyboard: [] }),
      runsDir,
      maxCorrections: 3,
    });

    assert.equal(qaCount, 1, 'QA should only run once before G3 reject stops loop');
  });
});

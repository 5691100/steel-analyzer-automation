import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { runPipeline } from '../src/pipeline-runner.mjs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function setupRun(tempDir, runId, itemCount = 3, withOutput = false) {
  const runsDir = path.join(tempDir, 'steel-bus/runs');
  const runDir = path.join(runsDir, runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, 'manifest-drive-download.json'),
    JSON.stringify({ items: Array(itemCount).fill({}) })
  );
  if (withOutput) {
    const outputDir = path.join(runDir, 'output');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'workbook.xlsx'), 'mock');
  }
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
    const doDownload = async () => { setupRun(tempDir, runId, 3, true); };
    const doAnalysis = async () => ({ ok: true });
    const doQA = async () => ({ verdict: 'ACCEPTED' });
    const doUpload = async () => ({ md5Status: 'OK', manifestPath: 'manifest.json' });
    const doPublish = async () => ({ ok: true });
    const waitForGate = async () => 'approve';
    const makeGateKb = () => ({ inline_keyboard: [] });
    const { runsDir } = setupRun(tempDir, runId, 3, true);

    await runPipeline(runId, folderId, notifyFn, {
      getDrive, doDownload, doAnalysis, doQA,
      doSelfChecklist: async () => ({ passed: true, items: [] }),
      doGepaReview: async () => ({ verdict: 'OK', proposals: [] }),
      doUpload, doPublish, waitForGate, makeGateKb, runsDir,
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
        getDrive, doDownload, doAnalysis, doQA,
        waitForGate, makeGateKb, runsDir, maxCorrections: 0,
      }),
      { message: /QA blocked/ }
    );
    assert.ok(notifications.some(n => typeof n === 'string' && n.includes('QA: BLOCKED')));
  });

  // ── New gate tests ─────────────────────────────────────────────────────────

  it('pipeline calls waitForGate for each of 4 gates in order when approved (no g4_codex)', async () => {
    const gatesCalled = [];
    const waitForGate = async (runId, gateId) => {
      gatesCalled.push(gateId);
      return 'approve';
    };
    const makeGateKb = () => ({ inline_keyboard: [] });
    const notifications = [];
    const notifyFn = async (text, kb) => notifications.push({ text, kb });
    const runId = 'gate-order-run';
    const { runsDir } = setupRun(tempDir, runId, 3, true);

    await runPipeline(runId, 'folder', notifyFn, {
      getDrive: async () => ({}),
      doDownload: async () => { setupRun(tempDir, runId, 3, true); },
      doAnalysis: async () => ({ ok: true }),
      doQA: async () => ({ verdict: 'ACCEPTED' }),
      doSelfChecklist: async () => ({ passed: true, items: [] }),
      doGepaReview: async () => ({ verdict: 'OK', proposals: [] }),
      doUpload: async () => ({ md5Status: 'OK', manifestPath: 'manifest.json' }),
      doPublish: async () => ({ ok: true, publishedPath: '/dashboard/runs/gate-order-run.json' }),
      waitForGate,
      makeGateKb,
      runsDir,
    });

    assert.deepEqual(gatesCalled, ['g1_claude', 'g2_qa', 'g5_upload'],
      `Expected gates in order [g1_claude, g2_qa, g5_upload], got: ${gatesCalled}`);
  });

  it('pipeline blocks and returns BLOCKED verdict when self-checklist fails', async () => {
    const runId = 'checklist-fail-run';
    const { runsDir } = setupRun(tempDir, runId, 3, true);
    const notifications = [];
    const notifyFn = async (text) => notifications.push(text);

    const result = await runPipeline(runId, 'folder', notifyFn, {
      getDrive: async () => ({}),
      doDownload: async () => { setupRun(tempDir, runId, 3, true); },
      doAnalysis: async () => ({ ok: true }),
      doQA: async () => ({ verdict: 'ACCEPTED' }),
      doSelfChecklist: async () => ({
        passed: false,
        items: [{ id: 'xlsx-exists', verdict: 'fail', detail: 'No .xlsx files in output/', description: '' }],
      }),
      doPublish: async () => ({ ok: true, publishedPath: '/dashboard/runs/checklist-fail-run.json' }),
      doUpload: async () => ({ md5Status: 'OK', manifestPath: 'manifest.json' }),
      waitForGate: async () => 'approve',
      makeGateKb: () => ({ inline_keyboard: [] }),
      runsDir,
    });

    assert.ok(result, 'Expected a return value when self-checklist fails');
    assert.strictEqual(result.verdict, 'BLOCKED');
    assert.strictEqual(result.reason, 'self-checklist-failed');
    assert.ok(result.checklist, 'Expected checklist in result');
    assert.ok(notifications.some(n => n.includes('Self-checklist FAIL')),
      `Expected "Self-checklist FAIL" notification, got: ${notifications}`);
  });

  it('pipeline calls doSelfChecklist and doPublish after QA ACCEPTED', async () => {
    const runId = 'checklist-publish-run';
    const { runsDir } = setupRun(tempDir, runId, 3, true);
    let selfChecklistCalled = false;
    let publishCalled = false;
    const notifications = [];
    const notifyFn = async (text) => notifications.push(text);

    await runPipeline(runId, 'folder', notifyFn, {
      getDrive: async () => ({}),
      doDownload: async () => { setupRun(tempDir, runId, 3, true); },
      doAnalysis: async () => ({ ok: true }),
      doQA: async () => ({ verdict: 'ACCEPTED' }),
      doSelfChecklist: async () => { selfChecklistCalled = true; return { passed: true, items: [] }; },
      doPublish: async () => { publishCalled = true; return { ok: true, publishedPath: '/dashboard/runs/checklist-publish-run.json' }; },
      doGepaReview: async () => ({ verdict: 'OK', proposals: [] }),
      doUpload: async () => ({ md5Status: 'OK', manifestPath: 'manifest.json' }),
      waitForGate: async () => 'approve',
      makeGateKb: () => ({ inline_keyboard: [] }),
      runsDir,
    });

    assert.ok(selfChecklistCalled, 'doSelfChecklist should have been called');
    assert.ok(publishCalled, 'doPublish should have been called for dashboard phase');
    assert.ok(notifications.some(n => n.includes('Self-checklist passed')),
      `Expected "Self-checklist passed" notification`);
    assert.ok(notifications.some(n => n.includes('Dashboard')),
      `Expected "Dashboard" notification`);
  });

  it('doSelfChecklist is called with only runDir (not runId)', async () => {
    const runId = 'sig-check-run';
    const { runsDir } = setupRun(tempDir, runId, 3, true);
    const capturedArgs = [];

    await runPipeline(runId, 'folder', async () => {}, {
      getDrive: async () => ({}),
      doDownload: async () => { setupRun(tempDir, runId, 3, true); },
      doAnalysis: async () => ({ ok: true }),
      doQA: async () => ({ verdict: 'ACCEPTED' }),
      doSelfChecklist: async (...args) => { capturedArgs.push(...args); return { passed: true, items: [] }; },
      doPublish: async () => ({ ok: true, publishedPath: '/dashboard/runs/sig-check-run.json' }),
      doGepaReview: async () => ({ verdict: 'OK', proposals: [] }),
      doUpload: async () => ({ md5Status: 'OK', manifestPath: 'manifest.json' }),
      waitForGate: async () => 'approve',
      makeGateKb: () => ({ inline_keyboard: [] }),
      runsDir,
    });

    assert.strictEqual(capturedArgs.length, 1,
      `doSelfChecklist should be called with exactly 1 argument, got ${capturedArgs.length}: ${JSON.stringify(capturedArgs)}`);
    assert.ok(capturedArgs[0].includes(runId) || capturedArgs[0].endsWith(runId),
      `first arg should be runDir containing runId, got: ${capturedArgs[0]}`);
  });

  // ── GEPA phase tests ──────────────────────────────────────────────────────

  it('calls doGepaReview after dashboard publish', async () => {
    const runId = 'gepa-called-run';
    const { runsDir, runDir } = setupRun(tempDir, runId, 3, true);
    let gepaCalledWith = null;

    await runPipeline(runId, 'folder', async () => {}, {
      getDrive: async () => ({}),
      doDownload: async () => { setupRun(tempDir, runId, 3, true); },
      doAnalysis: async () => ({ ok: true }),
      doQA: async () => ({ verdict: 'ACCEPTED' }),
      doSelfChecklist: async () => ({ passed: true, items: [] }),
      doPublish: async () => ({ ok: true, publishedPath: '/dashboard/runs/gepa-called-run.json' }),
      doGepaReview: async (rd) => { gepaCalledWith = rd; return { verdict: 'OK', proposals: [] }; },
      doUpload: async () => ({ md5Status: 'OK', manifestPath: 'manifest.json' }),
      waitForGate: async () => 'approve',
      makeGateKb: () => ({ inline_keyboard: [] }),
      runsDir,
    });

    assert.ok(gepaCalledWith, 'doGepaReview should have been called');
    assert.ok(gepaCalledWith.includes(runId), `doGepaReview should be called with runDir containing runId, got: ${gepaCalledWith}`);
  });

  it('notifies on GEPA WARN', async () => {
    const runId = 'gepa-warn-run';
    const { runsDir } = setupRun(tempDir, runId, 3, true);
    const notifications = [];
    const notifyFn = async (text) => notifications.push(text);

    await runPipeline(runId, 'folder', notifyFn, {
      getDrive: async () => ({}),
      doDownload: async () => { setupRun(tempDir, runId, 3, true); },
      doAnalysis: async () => ({ ok: true }),
      doQA: async () => ({ verdict: 'ACCEPTED' }),
      doSelfChecklist: async () => ({ passed: true, items: [] }),
      doPublish: async () => ({ ok: true, publishedPath: '/dashboard/runs/gepa-warn-run.json' }),
      doGepaReview: async () => ({ verdict: 'WARN', reason: 'timeout' }),
      doUpload: async () => ({ md5Status: 'OK', manifestPath: 'manifest.json' }),
      waitForGate: async () => 'approve',
      makeGateKb: () => ({ inline_keyboard: [] }),
      runsDir,
    });

    assert.ok(notifications.some(n => typeof n === 'string' && n.includes('GEPA')),
      `Expected notification containing 'GEPA', got: ${JSON.stringify(notifications)}`);
  });

  it('notifies on proposals found', async () => {
    const runId = 'gepa-proposals-run';
    const { runsDir } = setupRun(tempDir, runId, 3, true);
    const notifications = [];
    const notifyFn = async (text) => notifications.push(text);

    await runPipeline(runId, 'folder', notifyFn, {
      getDrive: async () => ({}),
      doDownload: async () => { setupRun(tempDir, runId, 3, true); },
      doAnalysis: async () => ({ ok: true }),
      doQA: async () => ({ verdict: 'ACCEPTED' }),
      doSelfChecklist: async () => ({ passed: true, items: [] }),
      doPublish: async () => ({ ok: true, publishedPath: '/dashboard/runs/gepa-proposals-run.json' }),
      doGepaReview: async () => ({ verdict: 'OK', proposals: [{ id: 'GEPA-001' }], provider: 'codex' }),
      doUpload: async () => ({ md5Status: 'OK', manifestPath: 'manifest.json' }),
      waitForGate: async () => 'approve',
      makeGateKb: () => ({ inline_keyboard: [] }),
      runsDir,
    });

    assert.ok(notifications.some(n => typeof n === 'string' && n.includes('1 proposal')),
      `Expected notification containing '1 proposal', got: ${JSON.stringify(notifications)}`);
  });

  it('pipeline continues even if GEPA returns WARN', async () => {
    const runId = 'gepa-continue-run';
    const { runsDir } = setupRun(tempDir, runId, 3, true);
    const gatesCalled = [];

    await runPipeline(runId, 'folder', async () => {}, {
      getDrive: async () => ({}),
      doDownload: async () => { setupRun(tempDir, runId, 3, true); },
      doAnalysis: async () => ({ ok: true }),
      doQA: async () => ({ verdict: 'ACCEPTED' }),
      doSelfChecklist: async () => ({ passed: true, items: [] }),
      doPublish: async () => ({ ok: true, publishedPath: '/dashboard/runs/gepa-continue-run.json' }),
      doGepaReview: async () => ({ verdict: 'WARN', reason: 'timeout' }),
      doUpload: async () => ({ md5Status: 'OK', manifestPath: 'manifest.json' }),
      waitForGate: async (runId, gateId) => { gatesCalled.push(gateId); return 'approve'; },
      makeGateKb: () => ({ inline_keyboard: [] }),
      runsDir,
    });

    assert.ok(gatesCalled.includes('g5_upload'), `Pipeline should reach G5, gates called: ${gatesCalled}`);
  });

  it('doCodexReview is NOT called in the pipeline', async () => {
    const runId = 'no-codex-run';
    const { runsDir } = setupRun(tempDir, runId, 3, true);
    let codexCalled = false;

    await runPipeline(runId, 'folder', async () => {}, {
      getDrive: async () => ({}),
      doDownload: async () => { setupRun(tempDir, runId, 3, true); },
      doAnalysis: async () => ({ ok: true }),
      doQA: async () => ({ verdict: 'ACCEPTED' }),
      doSelfChecklist: async () => ({ passed: true, items: [] }),
      doPublish: async () => ({ ok: true, publishedPath: '/dashboard/runs/no-codex-run.json' }),
      doGepaReview: async () => ({ verdict: 'OK', proposals: [] }),
      doUpload: async () => ({ md5Status: 'OK', manifestPath: 'manifest.json' }),
      doCodexReview: async () => { codexCalled = true; return { verdict: 'APPROVED', notes: '', proposals: [] }; },
      waitForGate: async () => 'approve',
      makeGateKb: () => ({ inline_keyboard: [] }),
      runsDir,
    });

    assert.strictEqual(codexCalled, false, 'doCodexReview should not be called in the new pipeline');
  });

  it('pipeline stops at G1 when rejected', async () => {
    const waitForGate = async (runId, gateId) => gateId === 'g1_claude' ? 'reject' : 'approve';
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

  it('pipeline continues to G5 even if doGepaReview throws', async () => {
    const runId = 'gepa-throws-run';
    const { runsDir } = setupRun(tempDir, runId, 3, true);
    const gatesCalled = [];
    const notifications = [];
    const notifyFn = async (text) => notifications.push(text);

    await runPipeline(runId, 'folder', notifyFn, {
      getDrive: async () => ({}),
      doDownload: async () => { setupRun(tempDir, runId, 3, true); },
      doAnalysis: async () => ({ ok: true }),
      doQA: async () => ({ verdict: 'ACCEPTED' }),
      doSelfChecklist: async () => ({ passed: true, items: [] }),
      doPublish: async () => ({ ok: true, publishedPath: '/dashboard/runs/gepa-throws-run.json' }),
      doGepaReview: async () => { throw new Error('analysis.json not found'); },
      doUpload: async () => ({ md5Status: 'OK', manifestPath: 'manifest.json' }),
      waitForGate: async (runId, gateId) => { gatesCalled.push(gateId); return 'approve'; },
      makeGateKb: () => ({ inline_keyboard: [] }),
      runsDir,
    });

    assert.ok(gatesCalled.includes('g5_upload'),
      `Pipeline should reach G5 even when GEPA throws, gates called: ${gatesCalled}`);
    assert.ok(notifications.some(n => typeof n === 'string' && n.includes('GEPA') && n.includes('помилка')),
      `Expected GEPA error notification, got: ${JSON.stringify(notifications)}`);
  });

  it('notifies "ошибок не найдено" when GEPA verdict is OK with no proposals', async () => {
    const runId = 'gepa-ok-empty-run';
    const { runsDir } = setupRun(tempDir, runId, 3, true);
    const notifications = [];
    const notifyFn = async (text) => notifications.push(text);

    await runPipeline(runId, 'folder', notifyFn, {
      getDrive: async () => ({}),
      doDownload: async () => { setupRun(tempDir, runId, 3, true); },
      doAnalysis: async () => ({ ok: true }),
      doQA: async () => ({ verdict: 'ACCEPTED' }),
      doSelfChecklist: async () => ({ passed: true, items: [] }),
      doPublish: async () => ({ ok: true, publishedPath: '/dashboard/runs/gepa-ok-empty-run.json' }),
      doGepaReview: async () => ({ verdict: 'OK', proposals: [] }),
      doUpload: async () => ({ md5Status: 'OK', manifestPath: 'manifest.json' }),
      waitForGate: async () => 'approve',
      makeGateKb: () => ({ inline_keyboard: [] }),
      runsDir,
    });

    assert.ok(notifications.some(n => typeof n === 'string' && n.includes('GEPA') && n.includes('ошибок не найдено')),
      `Expected "GEPA: ошибок не найдено" notification, got: ${JSON.stringify(notifications)}`);
  });
});

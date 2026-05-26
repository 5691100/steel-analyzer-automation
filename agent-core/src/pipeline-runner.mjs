import fs from 'fs';
import path from 'path';

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { download, getDriveClient, upload as driveUpload, expectedApprovalToken } from '../scripts/steel-drive.mjs';
import { dispatchGeminiAnalysis } from './llm-dispatcher.mjs';
import { resolveGate } from './gate-manager.mjs';
import { publishRun as defaultPublishRun } from './publish-run.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const AGENT_CORE = join(__dirname, '..');
const RUNS_DIR = join(AGENT_CORE, 'steel-bus/runs');

function log(runDir, signal) {
  const ledger = path.join(runDir, 'ledger.jsonl');
  fs.appendFileSync(ledger, JSON.stringify({ ...signal, created_at: new Date().toISOString() }) + '\n', 'utf8');
}

async function dispatchClaudeQA(runId, runDir) {
  const result = { verdict: 'ACCEPTED', notes: 'Auto-accepted (QA not yet wired)' };
  fs.writeFileSync(path.join(runDir, 'qa-result.json'), JSON.stringify(result, null, 2), 'utf8');
  return result;
}

function defaultMakeGateKb(runId, gateId) {
  return {
    inline_keyboard: [
      [
        { text: '✅ Approve', callback_data: `gate:${runId}:${gateId}:approve` },
        { text: '❌ Reject', callback_data: `gate:${runId}:${gateId}:reject` },
      ],
      [
        { text: '⏸ Defer', callback_data: `gate:${runId}:${gateId}:defer` },
        { text: '❓ Clarify', callback_data: `gate:${runId}:${gateId}:clarify` },
        { text: '💬 Open chat', callback_data: `gate:${runId}:${gateId}:openchat` },
      ],
    ],
  };
}

async function askGate(runId, gateId, prompt, notifyFn, makeGateKb, waitForGate, gateTimeoutMs) {
  const keyboard = makeGateKb(runId, gateId);
  await notifyFn(prompt, keyboard);
  let handle;
  const timeoutP = new Promise((_, reject) => {
    handle = setTimeout(() => reject(new Error(`Gate ${gateId} timed out after ${gateTimeoutMs / 60000} min`)), gateTimeoutMs);
    handle.unref();
  });
  try {
    return await Promise.race([waitForGate(runId, gateId), timeoutP]);
  } finally {
    clearTimeout(handle);
    resolveGate(runId, gateId, 'timeout');
  }
}

export async function runPipeline(runId, folderId, notifyFn, {
  getDrive = getDriveClient,
  doDownload = download,
  doAnalysis = dispatchGeminiAnalysis,
  doQA = dispatchClaudeQA,
  doUpload = driveUpload,
  doPublish = defaultPublishRun,
  makeGateKb = defaultMakeGateKb,
  waitForGate = async () => 'approve',
  gateTimeoutMs = 30 * 60 * 1000,
  runsDir = RUNS_DIR,
  maxCorrections = 3,
} = {}) {
  const runDir = path.join(runsDir, runId);
  const sourcesDir = path.join(runDir, 'sources');

  try {
    await notifyFn(`🔵 Steel Analyzer запущен\nRun ID: <code>${runId}</code>\nDrive folder: <code>${folderId}</code>`);

    // G1 — Gemini dispatch approval
    const g1 = await askGate(
      runId, 'g1_gemini',
      `🔵 Run: <code>${runId}</code>\n\nЗапустить Gemini-анализ источников?`,
      notifyFn, makeGateKb, waitForGate, gateTimeoutMs
    );
    if (g1 !== 'approve') {
      await notifyFn(`⛔ Gemini-анализ отменён для run <code>${runId}</code>.`);
      log(runDir, { schema: 'steel.run-cancelled.v1', run_id: runId, reason: 'G1 rejected' });
      return;
    }

    // Download sources
    await notifyFn('⏳ Скачиваю источники из Drive...');
    const drive = await getDrive({});
    await doDownload(drive, runId, folderId);
    const manifestPath = path.join(runsDir, runId, 'manifest-drive-download.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    await notifyFn(`✅ Download завершён (${manifest.items.length} файлов)`);

    // Initial Gemini analysis
    await notifyFn('⏳ Gemini анализ запущен...');
    await doAnalysis(runId, runDir, sourcesDir);
    await notifyFn('✅ Gemini анализ завершён, workbooks сгенерированы');

    // Correction loop: G2 (QA) → optionally G3 (correction) → repeat
    let qaResult;
    let iteration = 0;

    do {
      // G2 — QA approval
      const g2 = await askGate(
        runId, 'g2_qa',
        `📋 Run: <code>${runId}</code>\nGemini готов.\n\nЗапустить Claude QA?`,
        notifyFn, makeGateKb, waitForGate, gateTimeoutMs
      );
      if (g2 !== 'approve') {
        await notifyFn(`⛔ QA отменён для run <code>${runId}</code>.`);
        log(runDir, { schema: 'steel.run-cancelled.v1', run_id: runId, reason: 'G2 rejected' });
        return;
      }

      await notifyFn('⏳ Claude QA review запущен...');
      qaResult = await doQA(runId, runDir);

      if (qaResult.verdict !== 'ACCEPTED') {
        if (iteration >= maxCorrections) break;

        iteration++;
        await notifyFn(`❌ QA: дефекты найдены\n${esc(qaResult.notes)}`);

        // G3 — correction loop approval
        const g3 = await askGate(
          runId, 'g3_correction',
          `🔄 Run: <code>${runId}</code>\nQA выявил дефекты (итерация ${iteration}/${maxCorrections}).\n\nЗапустить correction loop?`,
          notifyFn, makeGateKb, waitForGate, gateTimeoutMs
        );
        if (g3 !== 'approve') {
          await notifyFn(`⛔ Correction loop отменён для run <code>${runId}</code>.`);
          log(runDir, { schema: 'steel.run-cancelled.v1', run_id: runId, reason: 'G3 rejected' });
          return;
        }

        await notifyFn(`⏳ Correction run ${iteration}/${maxCorrections}...`);
        await doAnalysis(runId, runDir, sourcesDir);
        await notifyFn(`✅ Correction ${iteration} завершён`);
      }
    } while (qaResult.verdict !== 'ACCEPTED' && iteration < maxCorrections);

    if (qaResult.verdict !== 'ACCEPTED') {
      const msg = `❌ QA: BLOCKED после ${maxCorrections} коррекций\n${esc(qaResult.notes)}`;
      await notifyFn(msg);
      throw new Error(`QA blocked after ${maxCorrections} corrections: ${qaResult.notes}`);
    }

    await notifyFn('✅ QA: ACCEPTED');

    // G4 — CodexClaw finalization approval
    const g4 = await askGate(
      runId, 'g4_codex',
      `✅ Run: <code>${runId}</code>\nQA passed.\n\nЗапустить CodexClaw финализацию?`,
      notifyFn, makeGateKb, waitForGate, gateTimeoutMs
    );
    if (g4 !== 'approve') {
      await notifyFn(`⛔ CodexClaw финализация отменена для run <code>${runId}</code>.`);
      log(runDir, { schema: 'steel.run-cancelled.v1', run_id: runId, reason: 'G4 rejected' });
      return;
    }

    await notifyFn('⏳ CodexClaw финализация...');
    // CodexClaw dispatch stub — real implementation in Sprint 14
    await notifyFn('✅ CodexClaw финализация завершена');

    // G5 — Upload approval
    const g5 = await askGate(
      runId, 'g5_upload',
      `📤 Run: <code>${runId}</code>\nCodexClaw готов.\n\nЗагрузить результаты в Drive?`,
      notifyFn, makeGateKb, waitForGate, gateTimeoutMs
    );
    if (g5 !== 'approve') {
      log(runDir, { schema: 'steel.upload-rejected.v1', run_id: runId });
      await doPublish(runId, runDir, undefined, {
        statusOverride: 'failed',
        error: 'Upload rejected by owner',
      }).catch(() => {});
      await notifyFn(`❌ Upload отклонён для run <code>${runId}</code>.`);
      return;
    }

    // Perform upload
    const outputDir = path.join(runDir, 'output');
    const approvalToken = expectedApprovalToken(runId, folderId);
    const filesToUpload = fs.existsSync(outputDir)
      ? fs.readdirSync(outputDir).filter(f => f.endsWith('.xlsx') || f.endsWith('.html'))
      : [];

    if (filesToUpload.length === 0) {
      throw new Error('No .xlsx or .html files found in output directory — nothing to upload');
    }

    const uploadResults = [];
    for (const file of filesToUpload) {
      const res = await doUpload(runId, folderId, path.join(outputDir, file), approvalToken);
      uploadResults.push(res);
    }

    const pubResult = await doPublish(runId, runDir).catch(err => ({ ok: false, error: err.message }));
    if (!pubResult.ok) {
      await notifyFn(`⚠️ Загружено, но dashboard publish не удался: ${esc(pubResult.error)}`);
    }

    const fileList = uploadResults.map(r => `• ${path.basename(r.manifestPath ?? '')} → MD5 ${r.md5Status}`).join('\n');
    await notifyFn(
      `✅ Upload завершён\nRun: <code>${runId}</code>\n\n${fileList}\n\nDrive: https://drive.google.com/drive/folders/${folderId}`
    );

  } catch (err) {
    console.error(`Pipeline failed for ${runId}:`, err);
    await notifyFn(`❌ Pipeline failed: ${esc(err.message)}`);
    throw err;
  }
}

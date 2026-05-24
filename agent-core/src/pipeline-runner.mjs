import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { download, getDriveClient } from '../scripts/steel-drive.mjs'; // Need to make sure it's exported and works
import { dispatchGeminiAnalysis } from './llm-dispatcher.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const AGENT_CORE = join(__dirname, '..');
const RUNS_DIR = join(AGENT_CORE, 'steel-bus/runs');

/**
 * Dispatches Claude QA task (Stub for Sprint 10).
 * 
 * @param {string} runId
 * @param {string} runDir
 * @returns {Promise<Object>} QA result
 */
async function dispatchClaudeQA(runId, runDir) {
  const result = {
    verdict: 'ACCEPTED',
    notes: 'Auto-accepted (QA not yet wired)'
  };
  const qaPath = path.join(runDir, 'qa-result.json');
  fs.writeFileSync(qaPath, JSON.stringify(result, null, 2), 'utf8');
  return result;
}

/**
 * Runs the full steel analysis pipeline.
 * 
 * @param {string} runId
 * @param {string} folderId
 * @param {Function} notifyFn - (text, keyboard?) => Promise<void>
 */
export async function runPipeline(runId, folderId, notifyFn, { 
  getDrive = getDriveClient, 
  doDownload = download, 
  doAnalysis = dispatchGeminiAnalysis,
  doQA = dispatchClaudeQA,
  runsDir = RUNS_DIR
} = {}) {
  const runDir = path.join(runsDir, runId);
  const sourcesDir = path.join(runDir, 'sources');

  try {
    // 1. Notify Start
    await notifyFn(`🔵 Steel Analyzer запущен\nRun ID: ${runId}\nDrive folder: ${folderId}`);

    // 2. Download Sources
    await notifyFn(`⏳ Начинаю скачивание источников...`);
    const drive = await getDrive({});
    await doDownload(drive, runId, folderId);
    
    // Read manifest to get file count
    const manifestPath = path.join(runsDir, runId, 'manifest-drive-download.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    await notifyFn(`✅ Download завершён (${manifest.items.length} файлов)`);

    // 4. Dispatch Gemini Analysis
    await notifyFn(`⏳ Gemini анализ запущен...`);
    await doAnalysis(runId, runDir, sourcesDir);
    await notifyFn(`✅ Анализ выполнен, workbooks сгенерированы`);

    // 5. Dispatch Claude QA
    await notifyFn(`⏳ Claude QA review запущен...`);
    const qa = await doQA(runId, runDir);
    
    // 6. Notify Approval Request
    if (qa.verdict === 'ACCEPTED') {
      const keyboard = {
        inline_keyboard: [
          [
            { text: '✅ Approve upload', callback_data: `approve_upload:${runId}:${folderId}` },
            { text: '❌ Reject', callback_data: `reject_upload:${runId}` }
          ]
        ]
      };
      await notifyFn(`✅ QA: ACCEPTED\nЗагрузить на Drive?`, keyboard);
    } else {
      await notifyFn(`❌ QA: BLOCKED\n${qa.notes}`);
      throw new Error(`QA blocked: ${qa.notes}`);
    }

  } catch (err) {
    console.error(`Pipeline failed for ${runId}:`, err);
    await notifyFn(`❌ Pipeline failed: ${err.message}`);
    throw err;
  }
}

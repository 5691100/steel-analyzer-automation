import { Bot, InlineKeyboard } from 'grammy';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { runPipeline } from './pipeline-runner.mjs';
import { validateRunId, upload as driveUpload, expectedApprovalToken } from '../scripts/steel-drive.mjs';
import { publishRun as defaultPublishRun } from './publish-run.mjs';
import { STATES, stateLabel } from '../steel-bus/lib/state-machine.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const AGENT_CORE = join(__dirname, '..');
const RUNS_DIR = join(AGENT_CORE, 'steel-bus/runs');

const token = process.env.TELEGRAM_BOT_TOKEN;
const allowedChatId = Number(process.env.TELEGRAM_CHAT_ID);

let upload = driveUpload;
let publishRun = defaultPublishRun;

if (!token || !Number.isFinite(allowedChatId)) {
  console.error('FATAL: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required and must be valid');
  process.exit(1);
}

const bot = new Bot(token);

function __setTelegramBotTestDeps(deps = {}) {
  upload = deps.upload ?? driveUpload;
  publishRun = deps.publishRun ?? defaultPublishRun;
}

/**
 * Logs a signal to the run's ledger.jsonl.
 * @param {string} runId
 * @param {Object} signal
 */
function logSignal(runId, signal) {
  const runDir = join(RUNS_DIR, runId);
  if (!fs.existsSync(runDir)) fs.mkdirSync(runDir, { recursive: true });
  const ledgerPath = join(runDir, 'ledger.jsonl');
  const entry = JSON.stringify({
    ...signal,
    created_at: new Date().toISOString()
  });
  fs.appendFileSync(ledgerPath, entry + '\n', 'utf8');
}

// Middleware: Security gate
bot.use(async (ctx, next) => {
  if (ctx.chat?.id !== allowedChatId) {
    console.log(`Unauthorized access attempt from chat_id: ${ctx.chat?.id}`);
    return; // Ignore silently
  }
  await next();
});

// Command: /run <run_id> <drive_folder_id>
bot.command('run', async (ctx) => {
  const [runId, folderId] = ctx.match.split(/\s+/);

  if (!runId || !folderId) {
    return ctx.reply('Usage: /run <run_id> <drive_folder_id>');
  }

  try {
    validateRunId(runId);
  } catch (err) {
    return ctx.reply(`❌ Invalid run_id: ${err.message}`);
  }

  const runDir = join(RUNS_DIR, runId);
  if (fs.existsSync(runDir) && fs.existsSync(join(runDir, 'ledger.jsonl'))) {
    return ctx.reply(`⚠️ Run ${runId} already exists.`);
  }

  if (!fs.existsSync(runDir)) fs.mkdirSync(runDir, { recursive: true });

  // Initial signal
  logSignal(runId, { schema: 'steel.run-request.v1', run_id: runId, folder_id: folderId });

  // Start pipeline in background
  const notifyFn = async (text, keyboard) => {
    await ctx.reply(text, keyboard ? { reply_markup: keyboard } : {});
  };

  runPipeline(runId, folderId, notifyFn).catch(async err => {
    console.error('[pipeline-runner]', err);
    await ctx.reply(`❌ Pipeline crashed: ${err.message}`).catch(() => {});
  });
});

// Command: /status <run_id>
bot.command('status', async (ctx) => {
  const runId = ctx.match.trim();
  if (!runId) return ctx.reply('Usage: /status <run_id>');

  const ledgerPath = join(RUNS_DIR, runId, 'ledger.jsonl');
  if (!fs.existsSync(ledgerPath)) {
    return ctx.reply('❌ Run not found');
  }

  const lines = fs.readFileSync(ledgerPath, 'utf8').trim().split('\n');
  const lastLine = JSON.parse(lines[lines.length - 1]);
  
  // Try to derive state (simple version for now)
  const state = lastLine.to || lastLine.schema || 'unknown';
  ctx.reply(`Status for ${runId}: ${stateLabel(state)}`);
});

// Command: /cancel <run_id>
bot.command('cancel', async (ctx) => {
  const runId = ctx.match.trim();
  if (!runId) return ctx.reply('Usage: /cancel <run_id>');

  logSignal(runId, { schema: 'steel.run-cancelled.v1', run_id: runId, reason: 'User cancelled via bot' });
  ctx.reply(`⚠️ Cancellation flag recorded. Current pipeline step will still complete.
Approve/Reject buttons will appear — tap Reject to block upload.`);
});

// Callback: approve_upload:<run_id>:<folder_id>
bot.callbackQuery(/^approve_upload:(.+):(.+)$/, async (ctx) => {
  const runId = ctx.match[1];
  const folderId = ctx.match[2];
  
  try {
    validateRunId(runId);
  } catch (err) {
    return ctx.reply(`❌ Invalid run_id in callback: ${err.message}`);
  }

  await ctx.answerCallbackQuery('Uploading...');
  await ctx.editMessageText(`⬆️ Uploading to Drive for run ${runId}...`);

  const approvalToken = expectedApprovalToken(runId, folderId);
  const outputDir = join(RUNS_DIR, runId, 'output');
  
  if (!fs.existsSync(outputDir)) {
    return ctx.reply(`❌ Output directory missing for ${runId}`);
  }

  const files = fs.readdirSync(outputDir).filter(f => f.endsWith('.xlsx'));
  
  try {
    const results = [];
    for (const file of files) {
      const filePath = join(outputDir, file);
      // Call upload from steel-drive.mjs
      const res = await upload(runId, folderId, filePath, approvalToken);
      results.push(res);
    }

    const pubResult = await publishRun(runId, join(RUNS_DIR, runId)).catch(err => ({ ok: false, error: err.message }));
    if (!pubResult.ok) {
      await ctx.reply(`⚠️ Uploaded to Drive, but dashboard publish failed: ${pubResult.error}`);
    }

    const fileList = results.map(r => `- ${path.basename(r.manifestPath)} → MD5 ${r.md5Status}`).join('\n');
    await ctx.reply(`✅ Upload завершён\nRun: ${runId}\n\n${fileList}\n\nDrive folder: https://drive.google.com/drive/folders/${folderId}`);
  } catch (err) {
    await ctx.reply(`❌ Upload failed: ${err.message}`);
    await publishRun(runId, join(RUNS_DIR, runId)).catch(() => {});
  }
});

// Callback: reject_upload:<run_id>
bot.callbackQuery(/^reject_upload:(.+)$/, async (ctx) => {
  const runId = ctx.match[1];
  try {
    validateRunId(runId);
  } catch (err) {
    return ctx.reply(`❌ Invalid run_id in callback: ${err.message}`);
  }
  await ctx.answerCallbackQuery('Rejected');
  logSignal(runId, { schema: 'steel.upload-rejected.v1', run_id: runId });
  await publishRun(runId, join(RUNS_DIR, runId)).catch(() => {});
  await ctx.editMessageText(`❌ Upload отклонён для run ${runId}`);
});

process.once('SIGINT', () => bot.stop());
process.once('SIGTERM', () => bot.stop());

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  bot.start().catch(err => {
    console.error('Bot failed to start:', err);
    process.exit(1);
  });
  console.log('Steel Bot started...');
}

export { bot, logSignal, __setTelegramBotTestDeps };

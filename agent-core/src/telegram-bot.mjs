import { Bot, InlineKeyboard } from 'grammy';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { runPipeline as defaultRunPipeline } from './pipeline-runner.mjs';
import {
  pendingGates,
  chatQuestionState,
  makeGateKeyboard,
  registerGate,
  resolveGate,
  GATE_AGENT,
  GATE_PROMPTS,
  GATE_HELP,
} from './gate-manager.mjs';
import { validateRunId, upload as driveUpload, expectedApprovalToken } from '../scripts/steel-drive.mjs';
import { publishRun as defaultPublishRun } from './publish-run.mjs';
import { dispatchGeminiAnalysis, dispatchOpenChatQuestion } from './llm-dispatcher.mjs';
import { STATES, stateLabel } from '../steel-bus/lib/state-machine.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const AGENT_CORE = join(__dirname, '..');
const RUNS_DIR = join(AGENT_CORE, 'steel-bus/runs');

const token = process.env.TELEGRAM_BOT_TOKEN;
const allowedChatId = Number(process.env.TELEGRAM_CHAT_ID);

let upload = driveUpload;
let publishRun = defaultPublishRun;
let runPipeline = defaultRunPipeline;

const DRIVE_URL_RE =
  /drive\.google\.com\/(?:drive\/folders\/|folderview\?(?:[^#]*&)?id=)([A-Za-z0-9_-]+)/;

function generateRunId() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
  return `steel-${date}-${rand}`;
}

if (!token || !Number.isFinite(allowedChatId)) {
  console.error('FATAL: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required and must be valid');
  process.exit(1);
}

const bot = new Bot(token);

function __setTelegramBotTestDeps(deps = {}) {
  upload = deps.upload ?? driveUpload;
  publishRun = deps.publishRun ?? defaultPublishRun;
  runPipeline = deps.runPipeline ?? defaultRunPipeline;
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

// Drive-link intake: owner sends a Drive folder URL
bot.on('message:text', async (ctx, next) => {
  // 1. Open chat question mode takes priority
  const qstate = chatQuestionState.get(ctx.chat.id);
  if (qstate) {
    const { runId, gateId, agent } = qstate;
    chatQuestionState.delete(ctx.chat.id);
    const question = ctx.message.text;
    await ctx.reply('⏳ Передаю вопрос агенту...');
    try {
      const answer = await dispatchOpenChatQuestion(runId, gateId, question, agent);
      await ctx.reply(`💬 ${agent}: ${answer}`);
    } catch (err) {
      await ctx.reply(`❌ Ошибка агента: ${err.message}`);
    }
    if (pendingGates.has(runId)) {
      const kb = makeGateKeyboard(runId, gateId);
      const prompt = GATE_PROMPTS[gateId]?.(runId) ?? `Продолжить?`;
      await ctx.reply(prompt, { reply_markup: kb, parse_mode: 'HTML' });
    }
    return;
  }

  // 2. Drive URL intake
  const m = ctx.message.text.match(DRIVE_URL_RE);
  if (!m) return next();

  const folderId = m[1];
  const runId = generateRunId();

  const runDir = join(RUNS_DIR, runId);
  if (!fs.existsSync(runDir)) fs.mkdirSync(runDir, { recursive: true });
  logSignal(runId, { schema: 'steel.run-request.v1', run_id: runId, folder_id: folderId });

  await ctx.reply(
    `✅ Run создан: <code>${runId}</code>\nDrive folder: <code>${folderId}</code>`,
    { parse_mode: 'HTML' }
  );

  const notifyFn = async (text, keyboard) => {
    await ctx.reply(text, keyboard ? { reply_markup: keyboard, parse_mode: 'HTML' } : { parse_mode: 'HTML' });
  };

  runPipeline(runId, folderId, notifyFn, {
    makeGateKb: makeGateKeyboard,
    waitForGate: registerGate,
  }).catch(async (err) => {
    console.error('[pipeline-runner]', err);
    await ctx.reply(`❌ Pipeline crashed: ${err.message}`).catch(() => {});
    await publishRun(runId, join(RUNS_DIR, runId), undefined, {
      statusOverride: 'failed',
      error: err.message,
    }).catch(() => {});
  });
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
    await ctx.reply(text, keyboard ? { reply_markup: keyboard, parse_mode: 'HTML' } : { parse_mode: 'HTML' });
  };

  runPipeline(runId, folderId, notifyFn, {
    makeGateKb: makeGateKeyboard,
    waitForGate: registerGate,
  }).catch(async err => {
    console.error('[pipeline-runner]', err);
    const error = `Pipeline crashed: ${err.message}`;
    await ctx.reply(`❌ ${error}`, { parse_mode: 'HTML' }).catch(() => {});
    await publishRun(runId, join(RUNS_DIR, runId), undefined, {
      statusOverride: 'failed',
      error,
    }).catch(() => {});
  });
});

// Command: /status <run_id>
bot.command('status', async (ctx) => {
  const runId = ctx.match.trim();
  if (!runId) return ctx.reply('Usage: /status <run_id>');

  const ledgerPath = join(RUNS_DIR, runId, 'ledger.jsonl');
  if (!fs.existsSync(ledgerPath)) return ctx.reply('❌ Run not found');

  const SCHEMA_LABELS = {
    'steel.run-request.v1': '📥 Запрос принят',
    'steel.run-complete.v1': '✅ Анализ завершён',
    'steel.upload-verified.v1': '📤 Загружено в Drive',
    'steel.upload-rejected.v1': '❌ Загрузка отклонена',
    'steel.run-cancelled.v1': '🚫 Отменён',
  };

  const lines = fs.readFileSync(ledgerPath, 'utf8').trim().split('\n').filter(Boolean);
  const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const steps = entries.map(e => `• ${SCHEMA_LABELS[e.schema] ?? e.schema ?? 'unknown'}`);

  const pending = pendingGates.get(runId);
  if (pending) {
    const prompt = GATE_PROMPTS[pending.gateId]?.(runId) ?? `⏳ Ожидание: ${pending.gateId}`;
    steps.push(`⏳ ${prompt}`);
    const kb = makeGateKeyboard(runId, pending.gateId);
    return ctx.reply(`📊 <b>Status</b>: <code>${runId}</code>\n\n${steps.join('\n')}`, {
      reply_markup: kb,
      parse_mode: 'HTML',
    });
  }

  return ctx.reply(`📊 <b>Status</b>: <code>${runId}</code>\n\n${steps.join('\n')}`, {
    parse_mode: 'HTML',
  });
});

// Command: /cancel <run_id>
bot.command('cancel', async (ctx) => {
  const runId = ctx.match.trim();
  if (!runId) return ctx.reply('Usage: /cancel <run_id>');

  logSignal(runId, { schema: 'steel.run-cancelled.v1', run_id: runId, reason: 'User cancelled via bot' });
  ctx.reply(`⚠️ Cancellation flag recorded. Current pipeline step will still complete.
Approve/Reject buttons will appear — tap Reject to block upload.`);
});

// Unified gate callback handler: gate:<runId>:<gateId>:<decision>
bot.callbackQuery(/^gate:([^:]+):([^:]+):([^:]+)$/, async (ctx) => {
  const [, runId, gateId, decision] = ctx.match;

  try {
    validateRunId(runId);
  } catch (err) {
    await ctx.answerCallbackQuery({ text: `Invalid run_id: ${err.message}`, show_alert: true });
    return;
  }

  await ctx.answerCallbackQuery();

  if (decision === 'openchat') {
    const agent = GATE_AGENT[gateId] ?? 'gemini';
    chatQuestionState.set(ctx.chat.id, { runId, gateId, agent });
    await ctx.editMessageText(
      `💬 <b>Open chat</b> активирован для <code>${runId}</code>\n` +
      `Gate: ${gateId} | Агент: ${agent}\n\nЗадайте вопрос:`,
      { parse_mode: 'HTML' }
    );
    return; // gate stays pending
  }

  if (decision === 'clarify') {
    const help = GATE_HELP[gateId] ?? 'Нет описания для этого шага.';
    await ctx.reply(`ℹ️ ${help}\n\nВыберите действие:`, {
      reply_markup: makeGateKeyboard(runId, gateId),
    });
    return; // gate stays pending
  }

  if (decision === 'defer') {
    await ctx.editMessageText(
      `⏸ Отложено. Кнопки вернутся через 10 минут для run <code>${runId}</code>.`,
      { parse_mode: 'HTML' }
    );
    setTimeout(async () => {
      if (pendingGates.has(runId)) {
        const prompt = GATE_PROMPTS[gateId]?.(runId) ?? `Продолжить?`;
        await ctx.reply(prompt, { reply_markup: makeGateKeyboard(runId, gateId), parse_mode: 'HTML' });
      }
    }, 10 * 60 * 1000);
    return; // gate stays pending
  }

  // approve or reject — resolve the gate
  const resolved = resolveGate(runId, gateId, decision);
  if (!resolved) {
    await ctx.answerCallbackQuery({ text: 'Gate expired or not found', show_alert: true });
    return;
  }

  const label = decision === 'approve' ? `✅ ${gateId} одобрено` : `❌ ${gateId} отклонено`;
  await ctx.editMessageText(`${label}\nRun: <code>${runId}</code>`, { parse_mode: 'HTML' });
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

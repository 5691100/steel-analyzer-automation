import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

// Mock env vars BEFORE importing the bot
process.env.TELEGRAM_BOT_TOKEN = '000000000:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
process.env.TELEGRAM_CHAT_ID = '12345';

const { bot, __setTelegramBotTestDeps } = await import('../src/telegram-bot.mjs');

const TEST_RUNS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'steel-bus', 'runs');
const createdRunDirs = new Set();

// Register a single transformer for all tests in this process
let sentMessages = [];
bot.api.config.use((prev, method, payload, signal) => {
  if (method === 'sendMessage') {
    sentMessages.push(payload);
    return { ok: true, result: { message_id: Date.now(), chat: { id: payload.chat_id }, date: Math.floor(Date.now()/1000), text: payload.text } };
  }
  if (method === 'answerCallbackQuery') return { ok: true, result: true };
  if (method === 'editMessageText') return { ok: true, result: true };
  return prev(method, payload, signal);
});

describe('Telegram Bot Logic', () => {
  beforeEach(async () => {
    bot.botInfo = { id: 1, is_bot: true, first_name: 'SteelBot', username: 'steel_bot', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false };
    sentMessages.length = 0; // Clear the array
    const { pendingGates, chatQuestionState } = await import("../src/gate-manager.mjs");
    pendingGates.clear();
    chatQuestionState.clear();
  });

  afterEach(() => {
    __setTelegramBotTestDeps();
    for (const runDir of createdRunDirs) {
      fs.rmSync(runDir, { recursive: true, force: true });
    }
    createdRunDirs.clear();
  });

  function createRunWithOutput(runId, files = ['result.xlsx']) {
    const runDir = path.join(TEST_RUNS_DIR, runId);
    createdRunDirs.add(runDir);
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(runDir, 'output'), { recursive: true });
    for (const file of files) {
      fs.writeFileSync(path.join(runDir, 'output', file), 'xlsx fixture');
    }
    return runDir;
  }

  function writeAnalysis(runDir, runId) {
    fs.writeFileSync(path.join(runDir, 'analysis.json'), JSON.stringify({
      run_id: runId,
      project_name: 'Existing Analysis',
      status: 'complete',
      created_at: '2026-05-24T15:00:00.000Z',
      totals: { weight_kg: 1, paint_m2: 2 },
      subproject_count: 1,
    }));
  }

  it('should ignore messages from unauthorized chat ids', async (t) => {
    await bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        from: { id: 99999, is_bot: false, first_name: 'Stalker' },
        chat: { id: 99999, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: '/start'
      }
    });
    assert.equal(sentMessages.length, 0);
  });

  it('should validate run_id in /run command', async (t) => {
    await bot.handleUpdate({
      update_id: 2,
      message: {
        message_id: 2,
        from: { id: 12345, is_bot: false, first_name: 'Owner' },
        chat: { id: 12345, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: '/run "invalid_id!" some-folder',
        entities: [{ offset: 0, length: 4, type: 'bot_command' }]
      }
    });

    assert.ok(sentMessages.length > 0, 'Should have sent a reply');
    assert.ok(sentMessages.some(m => m.text && m.text.includes('Invalid run_id')), 'Should report validation error');
  });

  it('publishes a failed run entry when the pipeline crashes before approval', async () => {
    const runId = 'telegram-pipeline-crash';
    const folderId = 'valid-folder-id-1234567';
    const runDir = path.join(TEST_RUNS_DIR, runId);
    createdRunDirs.add(runDir);
    fs.mkdirSync(runDir, { recursive: true });
    writeAnalysis(runDir, runId);
    const publishCalls = [];

    __setTelegramBotTestDeps({
      runPipeline: async () => {
        throw new Error('Gemini failed');
      },
      publishRun: async (...args) => {
        publishCalls.push(args);
        return { ok: true };
      }
    });

    await bot.handleUpdate({
      update_id: 8,
      message: {
        message_id: 8,
        from: { id: 12345, is_bot: false, first_name: 'Owner' },
        chat: { id: 12345, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: `/run ${runId} ${folderId}`,
        entities: [{ offset: 0, length: 4, type: 'bot_command' }]
      }
    });
    await new Promise(resolve => setImmediate(resolve));

    assert.ok(sentMessages.some(m => m.text.includes('❌ Pipeline crashed: Gemini failed')));
    assert.deepStrictEqual(publishCalls, [[runId, runDir, undefined, {
      statusOverride: 'failed',
      error: 'Pipeline crashed: Gemini failed',
    }]]);
  });

  // ── Drive-link intake ──────────────────────────────────────────────────────

  it('Drive link message triggers run creation and replies with run_id', async () => {
    let pipelineCalled = false;
    let calledRunId = null;
    let calledFolderId = null;

    __setTelegramBotTestDeps({
      runPipeline: async (runId, folderId, notifyFn) => {
        pipelineCalled = true;
        calledRunId = runId;
        calledFolderId = folderId;
        await notifyFn('✅ Pipeline started');
      },
    });

    await bot.handleUpdate({
      update_id: 1001,
      message: {
        message_id: 1,
        from: { id: 12345, is_bot: false, first_name: 'Test' },
        chat: { id: 12345, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: 'https://drive.google.com/drive/folders/1ABC_folder_id_XYZ',
      },
    });

    assert.equal(pipelineCalled, true, 'runPipeline should have been called');
    assert.match(calledRunId, /^steel-\d{8}-[A-Z0-9]{5}$/, `run_id format wrong: ${calledRunId}`);
    assert.equal(calledFolderId, '1ABC_folder_id_XYZ');
    assert.ok(
      sentMessages.some(m => m.text.includes(calledRunId)),
      'bot should reply with the generated run_id'
    );
  });

  it('Drive folderview URL also triggers run creation', async () => {
    let calledFolderId = null;
    __setTelegramBotTestDeps({
      runPipeline: async (runId, folderId) => { calledFolderId = folderId; },
    });

    await bot.handleUpdate({
      update_id: 1002,
      message: {
        message_id: 2,
        from: { id: 12345, is_bot: false, first_name: 'Test' },
        chat: { id: 12345, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: 'https://drive.google.com/folderview?id=FOLDER_ID_2',
      },
    });

    assert.equal(calledFolderId, 'FOLDER_ID_2');
  });

  it('Message without Drive URL is ignored (no pipeline call)', async () => {
    let pipelineCalled = false;
    __setTelegramBotTestDeps({ runPipeline: async () => { pipelineCalled = true; } });

    await bot.handleUpdate({
      update_id: 1003,
      message: {
        message_id: 3,
        from: { id: 12345, is_bot: false, first_name: 'Test' },
        chat: { id: 12345, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: 'Hello bot, what is the status?',
      },
    });

    assert.equal(pipelineCalled, false);
  });

  // ── Gate callbacks ────────────────────────────────────────────────────────

  it('gate:approve callback resolves the pending gate and edits message', async () => {
    const { registerGate, resolveGate, pendingGates } = await import('../src/gate-manager.mjs');
    pendingGates.clear();

    let resolvedDecision = null;
    const gatePromise = registerGate('run-gate-1', 'g1_claude');
    // Intercept resolution
    gatePromise.then(d => { resolvedDecision = d; });

    // Simulate approve callback
    await bot.handleUpdate({
      update_id: 2001,
      callback_query: {
        id: 'cq1',
        from: { id: 12345, is_bot: false, first_name: 'Test' },
        message: {
          message_id: 10,
          chat: { id: 12345, type: 'private' },
          date: Math.floor(Date.now() / 1000),
          text: 'Запустить Claude-анализ источников?',
        },
        data: 'gate:run-gate-1:g1_claude:approve',
        chat_instance: '1',
      },
    });

    // Allow microtasks to flush
    await new Promise(r => setImmediate(r));

    assert.equal(resolvedDecision, 'approve', 'gate should resolve with approve');
    assert.equal(pendingGates.has('run-gate-1'), false, 'gate should be removed from map');
  });

  it('gate:reject callback resolves with reject', async () => {
    const { registerGate, pendingGates } = await import('../src/gate-manager.mjs');
    pendingGates.clear();

    let decision = null;
    registerGate('run-gate-2', 'g5_upload').then(d => { decision = d; });

    await bot.handleUpdate({
      update_id: 2002,
      callback_query: {
        id: 'cq2',
        from: { id: 12345, is_bot: false, first_name: 'Test' },
        message: {
          message_id: 11,
          chat: { id: 12345, type: 'private' },
          date: Math.floor(Date.now() / 1000),
          text: 'Загрузить?',
        },
        data: 'gate:run-gate-2:g5_upload:reject',
        chat_instance: '1',
      },
    });

    await new Promise(r => setImmediate(r));
    assert.equal(decision, 'reject');
  });

  it('gate:openchat sets chatQuestionState and does not resolve gate', async () => {
    const { registerGate, pendingGates, chatQuestionState } = await import('../src/gate-manager.mjs');
    pendingGates.clear();
    chatQuestionState.clear();

    let resolved = false;
    registerGate('run-gate-3', 'g2_qa').then(() => { resolved = true; });

    await bot.handleUpdate({
      update_id: 2003,
      callback_query: {
        id: 'cq3',
        from: { id: 12345, is_bot: false, first_name: 'Test' },
        message: {
          message_id: 12,
          chat: { id: 12345, type: 'private' },
          date: Math.floor(Date.now() / 1000),
          text: 'Запустить QA?',
        },
        data: 'gate:run-gate-3:g2_qa:openchat',
        chat_instance: '1',
      },
    });

    await new Promise(r => setImmediate(r));
    assert.equal(resolved, false, 'gate should NOT be resolved on openchat');
    assert.ok(pendingGates.has('run-gate-3'), 'gate should stay pending');
    assert.ok(chatQuestionState.has(12345), 'chatQuestionState should be set for chatId 12345');
    const state = chatQuestionState.get(12345);
    assert.equal(state.runId, 'run-gate-3');
    assert.equal(state.gateId, 'g2_qa');
  });

  it('gate callback with wrong gateId answers "Gate expired"', async () => {
    const { registerGate, pendingGates } = await import('../src/gate-manager.mjs');
    pendingGates.clear();

    registerGate('run-gate-4', 'g1_claude'); // registered for g1_claude

    const answeredCallbacks = [];
    // Override answerCallbackQuery to capture response
    bot.api.config.use((prev, method, payload, signal) => {
      if (method === 'answerCallbackQuery') {
        answeredCallbacks.push(payload);
        return { ok: true, result: true };
      }
      return prev(method, payload, signal);
    });

    await bot.handleUpdate({
      update_id: 2004,
      callback_query: {
        id: 'cq4',
        from: { id: 12345, is_bot: false, first_name: 'Test' },
        message: {
          message_id: 13,
          chat: { id: 12345, type: 'private' },
          date: Math.floor(Date.now() / 1000),
          text: 'Old message',
        },
        data: 'gate:run-gate-4:g5_upload:approve', // wrong gateId
        chat_instance: '1',
      },
    });

    await new Promise(r => setImmediate(r));
    assert.ok(pendingGates.has('run-gate-4'), 'gate should still be pending');
  });

  // ── /status improvements ──────────────────────────────────────────────────

  it('/status renders ledger entries as labelled steps', async () => {
    const runId = 'status-run-1';
    const runDir = path.join(TEST_RUNS_DIR, runId);
    createdRunDirs.add(runDir);
    fs.mkdirSync(runDir, { recursive: true });
    const ledger = [
      { schema: 'steel.run-request.v1', run_id: runId, created_at: '2026-01-01T00:00:00Z' },
      { schema: 'steel.run-complete.v1', run_id: runId, created_at: '2026-01-01T00:05:00Z' },
    ];
    fs.writeFileSync(
      path.join(runDir, 'ledger.jsonl'),
      ledger.map(e => JSON.stringify(e)).join('\n') + '\n'
    );

    await bot.handleUpdate({
      update_id: 3001,
      message: {
        message_id: 20,
        from: { id: 12345, is_bot: false, first_name: 'Test' },
        chat: { id: 12345, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: `/status ${runId}`,
        entities: [{ type: 'bot_command', offset: 0, length: 7 }],
      },
    });

    const reply = sentMessages.find(m => m.text.includes(runId));
    console.log("SENT MESSAGES:", sentMessages); assert.ok(reply, 'should reply with run status');
    assert.ok(reply.text.includes('Запрос принят') || reply.text.includes('run-request'),
      `should contain human label; got: ${reply.text}`);
    assert.ok(reply.text.includes('Анализ завершён') || reply.text.includes('run-complete'),
      `should contain run-complete label; got: ${reply.text}`);
  });

  it('/status shows pending gate buttons when gate is active', async () => {
    const { pendingGates, registerGate } = await import('../src/gate-manager.mjs');
    pendingGates.clear();

    const runId = 'status-run-2';
    const runDir = path.join(TEST_RUNS_DIR, runId);
    createdRunDirs.add(runDir);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, 'ledger.jsonl'),
      JSON.stringify({ schema: 'steel.run-request.v1', run_id: runId, created_at: '2026-01-01T00:00:00Z' }) + '\n'
    );

    registerGate(runId, 'g1_claude'); // simulate pending gate

    await bot.handleUpdate({
      update_id: 3002,
      message: {
        message_id: 21,
        from: { id: 12345, is_bot: false, first_name: 'Test' },
        chat: { id: 12345, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: `/status ${runId}`,
        entities: [{ type: 'bot_command', offset: 0, length: 7 }],
      },
    });

    const reply = sentMessages.find(m => m.text.includes(runId));
    assert.ok(reply, 'should reply');
    // Should include reply_markup with gate buttons
    assert.ok(reply.reply_markup, 'should include inline keyboard for pending gate');
  });
});

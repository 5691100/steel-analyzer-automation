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
  beforeEach(() => {
    bot.botInfo = { id: 1, is_bot: true, first_name: 'SteelBot', username: 'steel_bot', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false };
    sentMessages.length = 0; // Clear the array
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
    fs.writeFileSync(path.join(runDir, 'gemini-analysis.json'), JSON.stringify({
      run_id: runId,
      project_name: 'Existing Analysis',
      status: 'complete',
      created_at: '2026-05-24T15:00:00.000Z',
      totals: { weight_kg: 1, paint_m2: 2 },
      subproject_count: 1,
    }));
  }

  async function handleRunCommand(updateId, text) {
    await bot.handleUpdate({
      update_id: updateId,
      message: {
        message_id: updateId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 12345, type: 'private' },
        from: { id: 12345, first_name: 'Owner', is_bot: false },
        text,
        entities: [{ offset: 0, length: 4, type: 'bot_command' }]
      }
    });
  }

  async function handleCallback(updateId, data) {
    await bot.handleUpdate({
      update_id: updateId,
      callback_query: {
        id: String(updateId),
        from: { id: 12345, first_name: 'Owner', is_bot: false },
        chat_instance: String(updateId),
        message: {
          message_id: updateId,
          date: Math.floor(Date.now() / 1000),
          chat: { id: 12345, type: 'private' },
          text: 'Upload request'
        },
        data
      }
    });
  }

  it('should ignore messages from unauthorized chat ids', async (t) => {
    await bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 99999, type: 'private' },
        from: { id: 99999, first_name: 'Attacker', is_bot: false },
        text: '/run test-run folder-id'
      }
    });

    assert.strictEqual(sentMessages.length, 0, 'Should NOT reply to unauthorized chat');
  });

  it('should validate run_id in /run command', async (t) => {
    await bot.handleUpdate({
      update_id: 2,
      message: {
        message_id: 2,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 12345, type: 'private' },
        from: { id: 12345, first_name: 'Owner', is_bot: false },
        text: '/run "invalid_id!" some-folder',
        entities: [{ offset: 0, length: 4, type: 'bot_command' }]
      }
    });

    assert.ok(sentMessages.length > 0, 'Should have sent a reply');
    assert.ok(sentMessages.some(m => m.text && m.text.includes('Invalid run_id')), 'Should report validation error');
  });

  it('should validate runId in approve_upload callback', async (t) => {
    await bot.handleUpdate({
      update_id: 3,
      callback_query: {
        id: '1',
        from: { id: 12345, first_name: 'Owner', is_bot: false },
        chat_instance: '1',
        message: {
          message_id: 3,
          date: Math.floor(Date.now() / 1000),
          chat: { id: 12345, type: 'private' },
          text: 'Upload request'
        },
        data: 'approve_upload:BAD-ID!:folder-id'
      }
    });

    assert.ok(sentMessages.length > 0, 'Should have sent an error message');
    assert.ok(sentMessages.some(m => m.text && m.text.includes('Invalid run_id in callback')), 'Should report validation error in callback');
  });

  it('calls publishRun after successful upload approval', async () => {
    const runId = 'telegram-publish-success';
    const folderId = 'folder-id';
    const runDir = createRunWithOutput(runId);
    const publishCalls = [];
    const uploadCalls = [];

    __setTelegramBotTestDeps({
      upload: async (...args) => {
        uploadCalls.push(args);
        return { manifestPath: path.join(runDir, 'output', 'result.xlsx'), md5Status: 'OK' };
      },
      publishRun: async (...args) => {
        publishCalls.push(args);
        return { ok: true };
      }
    });

    await handleCallback(4, `approve_upload:${runId}:${folderId}`);

    assert.strictEqual(uploadCalls.length, 1);
    assert.deepStrictEqual(publishCalls, [[runId, runDir]]);
  });

  it('sends a warning when dashboard publish fails after upload success', async () => {
    const runId = 'telegram-publish-warning';
    const folderId = 'folder-id';
    const runDir = createRunWithOutput(runId);

    __setTelegramBotTestDeps({
      upload: async () => ({ manifestPath: path.join(runDir, 'output', 'result.xlsx'), md5Status: 'OK' }),
      publishRun: async () => ({ ok: false, error: 'push failed' })
    });

    await handleCallback(5, `approve_upload:${runId}:${folderId}`);

    assert.ok(
      sentMessages.some(m => m.text === '⚠️ Uploaded to Drive, but dashboard publish failed: push failed'),
      'Should warn that dashboard publishing failed without failing upload'
    );
  });

  it('publishes a failed run entry when upload approval fails', async () => {
    const runId = 'telegram-publish-upload-failure';
    const folderId = 'folder-id';
    const runDir = createRunWithOutput(runId);
    writeAnalysis(runDir, runId);
    const publishCalls = [];

    __setTelegramBotTestDeps({
      upload: async () => {
        throw new Error('Drive unavailable');
      },
      publishRun: async (...args) => {
        publishCalls.push(args);
        return { ok: true };
      }
    });

    await handleCallback(6, `approve_upload:${runId}:${folderId}`);

    assert.ok(sentMessages.some(m => m.text === '❌ Upload failed: Drive unavailable'));
    assert.deepStrictEqual(publishCalls, [[runId, runDir, undefined, {
      statusOverride: 'failed',
      error: 'Upload failed: Drive unavailable',
    }]]);
  });

  it('publishes a failed run entry when upload is rejected', async () => {
    const runId = 'telegram-publish-rejected';
    const runDir = path.join(TEST_RUNS_DIR, runId);
    createdRunDirs.add(runDir);
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.mkdirSync(runDir, { recursive: true });
    writeAnalysis(runDir, runId);
    const publishCalls = [];

    __setTelegramBotTestDeps({
      publishRun: async (...args) => {
        publishCalls.push(args);
        return { ok: true };
      }
    });

    await handleCallback(7, `reject_upload:${runId}`);

    assert.deepStrictEqual(publishCalls, [[runId, runDir, undefined, {
      statusOverride: 'failed',
      error: 'Upload rejected by owner',
    }]]);
  });

  it('publishes a failed run entry when the pipeline crashes before approval', async () => {
    const runId = 'telegram-pipeline-crash';
    const folderId = 'folder-id';
    const runDir = path.join(TEST_RUNS_DIR, runId);
    createdRunDirs.add(runDir);
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

    await handleRunCommand(8, `/run ${runId} ${folderId}`);
    await new Promise(resolve => setImmediate(resolve));

    assert.ok(sentMessages.some(m => m.text === '❌ Pipeline crashed: Gemini failed'));
    assert.deepStrictEqual(publishCalls, [[runId, runDir, undefined, {
      statusOverride: 'failed',
      error: 'Pipeline crashed: Gemini failed',
    }]]);
  });
});

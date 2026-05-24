import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

// Mock env vars BEFORE importing the bot
process.env.TELEGRAM_BOT_TOKEN = '000000000:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
process.env.TELEGRAM_CHAT_ID = '12345';

const { bot } = await import('../src/telegram-bot.mjs');

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
});

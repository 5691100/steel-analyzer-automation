import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { dispatchOpenChatQuestion, dispatchGeminiAnalysis } from '../src/llm-dispatcher.mjs';

describe('dispatchOpenChatQuestion', () => {
  it('returns a string answer for a gemini agent (mocked spawn)', async () => {
    const answer = await dispatchOpenChatQuestion(
      'run-test',
      'g1_gemini',
      'Сколько профилей?',
      'gemini',
      {
        spawn: (_cmd, _args, opts) => ({
          stdout: 'В источниках 42 профиля.',
          stderr: '',
          status: 0,
          error: null,
        }),
      }
    );
    assert.equal(typeof answer, 'string');
    assert.ok(answer.length > 0, 'answer should not be empty');
  });

  it('returns a string answer for an antigravity agent, calling agy with skip-permissions flag', async () => {
    let calledCmd, calledArgs, calledOpts;
    const answer = await dispatchOpenChatQuestion(
      'run-test',
      'g1_gemini',
      'Сколько профилей?',
      'antigravity',
      {
        spawn: (cmd, args, opts) => {
          calledCmd = cmd;
          calledArgs = args;
          calledOpts = opts;
          return {
            stdout: 'В источниках 42 профиля.',
            stderr: '',
            status: 0,
            error: null,
          };
        },
      }
    );
    assert.equal(answer, 'В источниках 42 профиля.');
    assert.equal(calledCmd, 'agy');
    assert.deepEqual(calledArgs, ['--dangerously-skip-permissions', '-p', '-']);
    assert.ok(calledOpts && calledOpts.input && calledOpts.input.includes('Сколько профилей?'));
  });

  it('throws when spawn returns non-zero exit code', async () => {
    await assert.rejects(
      dispatchOpenChatQuestion('run-test', 'g1_gemini', 'question', 'gemini', {
        spawn: () => ({ stdout: '', stderr: 'error', status: 1, error: null }),
      }),
      /failed/i
    );
  });
});

describe('dispatchGeminiAnalysis', () => {
  it('calls agy binary with --dangerously-skip-permissions, -p, and - with prompt in stdin', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-disp-test-'));
    const runDir = path.join(tempDir, 'run');
    const sourcesDir = path.join(runDir, 'sources');
    fs.mkdirSync(sourcesDir, { recursive: true });
    fs.writeFileSync(path.join(sourcesDir, 'source.txt'), 'steel source', 'utf8');

    let calledCmd, calledArgs, calledOpts;
    await dispatchGeminiAnalysis('run-123', runDir, sourcesDir, {
      spawn: (cmd, args, opts) => {
        calledCmd = cmd;
        calledArgs = args;
        calledOpts = opts;
        return {
          stdout: JSON.stringify({
            project_name: 'Project',
            subprojects: [{ name: 'All', totals: { weight_kg: 0, paint_m2: 0 }, profiles: [] }]
          }),
          status: 0
        };
      },
      generate: async () => {},
      generateDash: () => {},
      verify: () => ({ ok: true, errors: [], files: [] })
    });

    assert.equal(calledCmd, 'agy');
    assert.deepEqual(calledArgs, ['--dangerously-skip-permissions', '--print-timeout', '15m', '-p', '-']);
    assert.ok(calledOpts && calledOpts.input && calledOpts.input.includes('run-123'));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});

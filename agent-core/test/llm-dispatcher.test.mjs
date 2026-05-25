import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchOpenChatQuestion } from '../src/llm-dispatcher.mjs';

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

  it('throws when spawn returns non-zero exit code', async () => {
    await assert.rejects(
      dispatchOpenChatQuestion('run-test', 'g1_gemini', 'question', 'gemini', {
        spawn: () => ({ stdout: '', stderr: 'error', status: 1, error: null }),
      }),
      /failed/i
    );
  });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callCodex } from '../src/codex-runner.mjs';

test('uses codex when available', async () => {
  const mockSpawn = () => ({ status: 0, stdout: 'result', stderr: '', error: null });
  const result = await callCodex('prompt', { deps: { spawnSync: mockSpawn } });
  assert.equal(result.provider, 'codex');
  assert.equal(result.stdout, 'result');
  assert.equal(result.exitCode, 0);
});

test('falls back to claude when codex ENOENT', async () => {
  let callCount = 0;
  const mockSpawn = () => {
    callCount++;
    if (callCount === 1) return { error: { code: 'ENOENT' }, status: null, stdout: '', stderr: '' };
    return { status: 0, stdout: 'claude-result', stderr: '', error: null };
  };
  const result = await callCodex('prompt', { deps: { spawnSync: mockSpawn } });
  assert.equal(result.provider, 'claude');
  assert.equal(result.stdout, 'claude-result');
});

test('falls back to claude when codex times out (status null)', async () => {
  let callCount = 0;
  const mockSpawn = () => {
    callCount++;
    if (callCount === 1) return { status: null, stdout: '', stderr: '', error: null };
    return { status: 0, stdout: 'claude-fallback', stderr: '', error: null };
  };
  const result = await callCodex('prompt', { deps: { spawnSync: mockSpawn } });
  assert.equal(result.provider, 'claude');
});

test('falls back to claude when stderr contains "command not found"', async () => {
  let callCount = 0;
  const mockSpawn = () => {
    callCount++;
    if (callCount === 1) return { status: 1, stdout: '', stderr: 'codex: command not found', error: null };
    return { status: 0, stdout: 'claude-result', stderr: '', error: null };
  };
  const result = await callCodex('prompt', { deps: { spawnSync: mockSpawn } });
  assert.equal(result.provider, 'claude');
});

test('does NOT fall back when codex returns non-zero exit (real error)', async () => {
  let callCount = 0;
  const mockSpawn = () => {
    callCount++;
    return { status: 2, stdout: '', stderr: 'some error', error: null };
  };
  const result = await callCodex('prompt', { deps: { spawnSync: mockSpawn } });
  assert.equal(result.provider, 'codex');
  assert.equal(result.exitCode, 2);
  assert.equal(callCount, 1);
});

test('passes prompt as stdin input', async () => {
  let capturedArgs;
  const mockSpawn = (cmd, args, opts) => {
    capturedArgs = [cmd, args, opts];
    return { status: 0, stdout: '', stderr: '', error: null };
  };
  const prompt = 'my test prompt';
  await callCodex(prompt, { deps: { spawnSync: mockSpawn } });
  assert.equal(capturedArgs[2].input, prompt);
});

test('respects opts.timeout', async () => {
  let capturedArgs;
  const mockSpawn = (cmd, args, opts) => {
    capturedArgs = [cmd, args, opts];
    return { status: 0, stdout: '', stderr: '', error: null };
  };
  await callCodex('prompt', { timeout: 5000, deps: { spawnSync: mockSpawn } });
  assert.equal(capturedArgs[2].timeout, 5000);
});

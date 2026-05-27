import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGepaReview } from '../src/gepa-via-codex.mjs';

// Base deps that succeed for both file reads
function makeBaseDeps(overrides = {}) {
  return {
    readFile: async (p) => {
      if (p.endsWith('analysis.json')) return JSON.stringify({ subprojects: [] });
      if (p.endsWith('self-checklist.json')) return JSON.stringify({ verdict: 'PASS' });
      throw Object.assign(new Error('not found'), { code: 'ENOENT' });
    },
    writeFile: async () => {},
    callCodex: async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ proposals: [] }),
      provider: 'codex',
    }),
    ...overrides,
  };
}

test('throws if analysis.json missing', async () => {
  const deps = makeBaseDeps({
    readFile: async (p) => {
      if (p.endsWith('analysis.json')) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      return '{}';
    },
  });
  await assert.rejects(
    () => runGepaReview('/tmp/run-abc', deps),
    (err) => {
      assert.equal(err.message, 'analysis.json not found');
      return true;
    }
  );
});

test('throws if self-checklist.json missing', async () => {
  const deps = makeBaseDeps({
    readFile: async (p) => {
      if (p.endsWith('analysis.json')) return JSON.stringify({ subprojects: [] });
      if (p.endsWith('self-checklist.json')) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      throw new Error('unexpected path');
    },
  });
  await assert.rejects(
    () => runGepaReview('/tmp/run-abc', deps),
    (err) => {
      assert.equal(err.message, 'self-checklist.json not found');
      return true;
    }
  );
});

test('returns WARN on empty stdout', async () => {
  const deps = makeBaseDeps({
    callCodex: async () => ({ exitCode: 0, stdout: '   ', provider: 'codex' }),
  });
  const result = await runGepaReview('/tmp/run-abc', deps);
  assert.equal(result.verdict, 'WARN');
  assert.equal(result.reason, 'empty-stdout');
});

test('returns WARN on parse error', async () => {
  const deps = makeBaseDeps({
    callCodex: async () => ({ exitCode: 0, stdout: 'not json', provider: 'codex' }),
  });
  const result = await runGepaReview('/tmp/run-abc', deps);
  assert.equal(result.verdict, 'WARN');
  assert.equal(result.reason, 'parse-error');
});

test('returns WARN on codex error exit', async () => {
  const deps = makeBaseDeps({
    callCodex: async () => ({ exitCode: 2, stdout: '', provider: 'codex' }),
  });
  const result = await runGepaReview('/tmp/run-abc', deps);
  assert.equal(result.verdict, 'WARN');
  assert.equal(result.reason, 'codex-error');
});

test('returns OK with proposals, writes gepa-register.json', async () => {
  const proposals = [
    { id: 'G1', description: 'Check weld thickness', severity: 'medium' },
  ];
  const writtenFiles = {};
  const deps = makeBaseDeps({
    callCodex: async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ proposals }),
      provider: 'codex',
    }),
    writeFile: async (filePath, content) => {
      writtenFiles[filePath] = content;
    },
  });

  const result = await runGepaReview('/tmp/run-xyz', deps);

  assert.equal(result.verdict, 'OK');
  assert.equal(result.proposals.length, 1);
  assert.equal(result.proposals[0].id, 'G1');
  assert.equal(result.proposals[0].raised_by, 'codex');
  assert.equal(result.proposals[0].owner_decision, null);
  assert.ok(result.gepaPath.endsWith('gepa-register.json'));
  assert.equal(result.provider, 'codex');

  // Verify gepa-register.json was written
  const writtenPath = Object.keys(writtenFiles)[0];
  assert.ok(writtenPath, 'writeFile should have been called');
  const written = JSON.parse(writtenFiles[writtenPath]);
  assert.equal(written.schema, 'steel.gepa-register.v1');
  assert.equal(written.run_id, 'run-xyz');
  assert.equal(written.verdict, 'OK');
  assert.equal(written.proposals.length, 1);
});

test('returns OK with empty proposals', async () => {
  const deps = makeBaseDeps({
    callCodex: async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ proposals: [] }),
      provider: 'claude',
    }),
  });
  const result = await runGepaReview('/tmp/run-empty', deps);
  assert.equal(result.verdict, 'OK');
  assert.deepEqual(result.proposals, []);
  assert.equal(result.provider, 'claude');
});

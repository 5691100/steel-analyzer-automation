import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { publishRun } from '../src/publish-run.mjs';

describe('publishRun', () => {
  let tempDir;
  let runDir;
  let repoRoot;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-run-test-'));
    runDir = path.join(tempDir, 'run');
    repoRoot = path.join(tempDir, 'repo');
    fs.mkdirSync(runDir, { recursive: true });
    fs.mkdirSync(repoRoot, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes run payload and summary index on the happy path', async () => {
    const payload = {
      run_id: 'run-1',
      project_name: 'Nordic A-jaur',
      status: 'complete',
      created_at: '2026-05-24T10:00:00.000Z',
      totals: { weight_kg: 123.4, paint_m2: 56.7, ignored: true },
      subproject_count: 2,
    };
    fs.writeFileSync(path.join(runDir, 'gemini-analysis.json'), JSON.stringify(payload));

    const result = await publishRun('run-1', runDir, repoRoot, { dryRun: true });

    assert.equal(result.ok, true);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(repoRoot, 'dashboard/runs/run-1.json'), 'utf8')),
      payload,
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(repoRoot, 'dashboard/runs/index.json'), 'utf8')),
      [{
        run_id: 'run-1',
        project_name: 'Nordic A-jaur',
        status: 'complete',
        created_at: '2026-05-24T10:00:00.000Z',
        totals: { weight_kg: 123.4, paint_m2: 56.7 },
        subproject_count: 2,
      }],
    );
  });

  it('creates index.json for the first published run', async () => {
    writeAnalysis({
      run_id: 'first-run',
      project_name: 'First Project',
      status: 'complete',
      created_at: '2026-05-24T11:00:00.000Z',
      totals: { weight_kg: 10, paint_m2: 20 },
      subproject_count: 1,
    });

    await publishRun('first-run', runDir, repoRoot, { dryRun: true });

    const index = JSON.parse(fs.readFileSync(path.join(repoRoot, 'dashboard/runs/index.json'), 'utf8'));
    assert.equal(index.length, 1);
    assert.equal(index[0].run_id, 'first-run');
  });

  it('prepends a rerun and preserves history without duplicate run IDs', async () => {
    const runsDir = path.join(repoRoot, 'dashboard/runs');
    fs.mkdirSync(runsDir, { recursive: true });
    fs.writeFileSync(path.join(runsDir, 'index.json'), JSON.stringify([
      {
        run_id: 'old-run',
        project_name: 'Old Project',
        status: 'complete',
        created_at: '2026-05-23T10:00:00.000Z',
        totals: { weight_kg: 1, paint_m2: 2 },
        subproject_count: 1,
      },
      {
        run_id: 'run-2',
        project_name: 'Stale Project',
        status: 'failed',
        created_at: '2026-05-22T10:00:00.000Z',
        totals: null,
        subproject_count: 0,
      },
    ]));
    writeAnalysis({
      run_id: 'run-2',
      project_name: 'Updated Project',
      status: 'complete',
      created_at: '2026-05-24T12:00:00.000Z',
      totals: { weight_kg: 30, paint_m2: 40 },
      subproject_count: 3,
    });

    await publishRun('run-2', runDir, repoRoot, { dryRun: true });

    const index = JSON.parse(fs.readFileSync(path.join(runsDir, 'index.json'), 'utf8'));
    assert.deepEqual(index.map((entry) => entry.run_id), ['run-2', 'old-run']);
    assert.equal(index[0].project_name, 'Updated Project');
  });

  it('writes a failed stub when gemini-analysis.json is missing', async () => {
    await publishRun('missing-analysis', runDir, repoRoot, { dryRun: true });

    const payload = JSON.parse(fs.readFileSync(path.join(repoRoot, 'dashboard/runs/missing-analysis.json'), 'utf8'));
    assert.equal(payload.run_id, 'missing-analysis');
    assert.equal(payload.status, 'failed');
    assert.equal(payload.project_name, 'unknown');
    assert.equal(payload.totals, null);
    assert.equal(payload.subproject_count, 0);
    assert.ok(!Number.isNaN(Date.parse(payload.created_at)));

    const index = JSON.parse(fs.readFileSync(path.join(repoRoot, 'dashboard/runs/index.json'), 'utf8'));
    assert.deepEqual(index[0], {
      run_id: 'missing-analysis',
      project_name: 'unknown',
      status: 'failed',
      created_at: payload.created_at,
      totals: null,
      subproject_count: 0,
    });
  });

  it('throws before file writes for invalid ../etc run ID', async () => {
    await assert.rejects(
      publishRun('../etc', runDir, repoRoot, { dryRun: true }),
      /Invalid runId/,
    );
    assert.equal(fs.existsSync(path.join(repoRoot, 'dashboard')), false);
  });

  it('throws before file writes for invalid a/b run ID', async () => {
    await assert.rejects(
      publishRun('a/b', runDir, repoRoot, { dryRun: true }),
      /Invalid runId/,
    );
    assert.equal(fs.existsSync(path.join(repoRoot, 'dashboard')), false);
  });

  it('returns ok false when git push fails', async () => {
    writeAnalysis({
      run_id: 'push-fails',
      project_name: 'Push Project',
      status: 'complete',
      created_at: '2026-05-24T13:00:00.000Z',
      totals: { weight_kg: 50, paint_m2: 60 },
      subproject_count: 4,
    });
    const calls = [];
    const spawnSyncFn = (_command, args) => {
      calls.push(args);
      if (args.at(-1) === 'push') {
        return { status: 1, stderr: Buffer.from('auth failed') };
      }
      return { status: 0, stderr: Buffer.from('') };
    };

    const result = await publishRun('push-fails', runDir, repoRoot, { spawnSyncFn });

    assert.deepEqual(result, { ok: false, error: 'auth failed' });
    assert.deepEqual(calls.map((args) => args.slice(2).join(' ')), [
      'pull --rebase',
      'add dashboard/runs/',
      'commit -m chore(runs): add run push-fails',
      'push',
    ]);
  });

  it('returns exact rebase failure error and skips commit and push', async () => {
    writeAnalysis({
      run_id: 'rebase-fails',
      project_name: 'Rebase Project',
      status: 'complete',
      created_at: '2026-05-24T14:00:00.000Z',
      totals: { weight_kg: 70, paint_m2: 80 },
      subproject_count: 5,
    });
    const calls = [];
    const spawnSyncFn = (_command, args) => {
      calls.push(args);
      return { status: 1, stderr: Buffer.from('conflict') };
    };

    const result = await publishRun('rebase-fails', runDir, repoRoot, { spawnSyncFn });

    assert.deepEqual(result, { ok: false, error: 'rebase failed' });
    assert.deepEqual(calls.map((args) => args.slice(2).join(' ')), ['pull --rebase']);
    assert.equal(fs.existsSync(path.join(repoRoot, 'dashboard/runs/index.json')), false);
  });

  function writeAnalysis(payload) {
    fs.writeFileSync(path.join(runDir, 'gemini-analysis.json'), JSON.stringify(payload));
  }
});

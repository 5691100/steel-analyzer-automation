import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RUN_ID_PATTERN = /^[a-zA-Z0-9_-]{1,80}$/;

function defaultRepoRoot() {
  return path.resolve(fileURLToPath(import.meta.url), '../../../');
}

function readPayload(runId, runDir) {
  const analysisPath = path.join(runDir, 'gemini-analysis.json');

  if (!fs.existsSync(analysisPath)) {
    return {
      run_id: runId,
      status: 'failed',
      project_name: 'unknown',
      created_at: new Date().toISOString(),
      totals: null,
      subproject_count: 0,
    };
  }

  return JSON.parse(fs.readFileSync(analysisPath, 'utf8'));
}

function buildSummary(runId, payload) {
  return {
    run_id: runId,
    project_name: payload.project_name,
    status: payload.status,
    created_at: payload.created_at,
    totals: payload.totals
      ? {
          weight_kg: payload.totals.weight_kg ?? null,
          paint_m2: payload.totals.paint_m2 ?? null,
        }
      : null,
    subproject_count: payload.subproject_count,
  };
}

function readIndex(indexPath) {
  if (!fs.existsSync(indexPath)) {
    return [];
  }

  return JSON.parse(fs.readFileSync(indexPath, 'utf8'));
}

function gitFailure(result, fallback) {
  return result.stderr?.toString().trim() || result.error?.message || fallback;
}

function runGit(spawnSyncFn, repoRoot, args) {
  try {
    return spawnSyncFn('git', ['-C', repoRoot, ...args], { encoding: 'utf8' });
  } catch (error) {
    return { status: 1, error };
  }
}

export async function publishRun(runId, runDir, repoRoot = defaultRepoRoot(), options = {}) {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error('Invalid runId');
  }

  const spawnSyncFn = options.spawnSyncFn ?? spawnSync;
  const runsDir = path.join(repoRoot, 'dashboard', 'runs');
  const publishedPath = path.join(runsDir, `${runId}.json`);
  const indexPath = path.join(runsDir, 'index.json');
  const payload = readPayload(runId, runDir);
  const summary = buildSummary(runId, payload);

  fs.mkdirSync(runsDir, { recursive: true });
  fs.writeFileSync(publishedPath, `${JSON.stringify(payload, null, 2)}\n`);

  if (!options.dryRun) {
    const pullResult = runGit(spawnSyncFn, repoRoot, ['pull', '--rebase']);
    if (pullResult.status !== 0) {
      return { ok: false, error: 'rebase failed' };
    }
  }

  const existing = readIndex(indexPath).filter((entry) => entry.run_id !== runId);
  fs.writeFileSync(indexPath, `${JSON.stringify([summary, ...existing], null, 2)}\n`);

  if (!options.dryRun) {
    for (const args of [
      ['add', 'dashboard/runs/'],
      ['commit', '-m', `chore(runs): add run ${runId}`],
      ['push'],
    ]) {
      const result = runGit(spawnSyncFn, repoRoot, args);
      if (result.status !== 0) {
        return { ok: false, error: gitFailure(result, `git ${args[0]} failed`) };
      }
    }
  }

  return { ok: true, publishedPath, indexUpdated: true };
}

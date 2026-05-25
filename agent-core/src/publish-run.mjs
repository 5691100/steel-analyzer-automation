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
    ...(payload.error ? { error: payload.error } : {}),
    ...(payload.message ? { message: payload.message } : {}),
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
  const env = { 
    ...process.env, 
    GIT_TERMINAL_PROMPT: '0', 
    GIT_ASKPASS: 'echo' 
  };
  
  const options = { 
    encoding: 'utf8', 
    timeout: 30000, 
    env 
  };

  try {
    return spawnSyncFn('git', ['-C', repoRoot, ...args], { ...options });
  } catch (error) {
    return { status: 1, error };
  }
}

function applyPublishOptions(payload, options) {
  const nextPayload = { ...payload };

  if (options.statusOverride) {
    nextPayload.status = options.statusOverride;
  }

  if (options.error) {
    nextPayload.error = options.error;
  }

  if (options.message) {
    nextPayload.message = options.message;
  }

  return nextPayload;
}

export async function publishRun(runId, runDir, repoRoot = defaultRepoRoot(), options = {}) {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error('Invalid runId');
  }

  const spawnSyncFn = options.spawnSyncFn ?? spawnSync;
  const runsDir = path.join(repoRoot, 'dashboard', 'runs');
  const publishedPath = path.join(runsDir, `${runId}.json`);
  const indexPath = path.join(runsDir, 'index.json');

  // Fix 4a: Rebase early (before writing files) to avoid dirty tree issues
  if (!options.dryRun) {
    const pullArgs = ['pull', '--rebase'];
    if (process.env.GITHUB_TOKEN) {
      const encoded = Buffer.from(`x-access-token:${process.env.GITHUB_TOKEN}`).toString('base64');
      pullArgs.unshift('-c', `http.extraheader=Authorization: Basic ${encoded}`);
    }
    const pullResult = runGit(spawnSyncFn, repoRoot, pullArgs);
    if (pullResult.status !== 0) {
      return { ok: false, error: 'rebase failed' };
    }
  }

  const payload = applyPublishOptions(readPayload(runId, runDir), options);
  const summary = buildSummary(runId, payload);

  fs.mkdirSync(runsDir, { recursive: true });
  fs.writeFileSync(publishedPath, `${JSON.stringify(payload, null, 2)}\n`);

  const existing = readIndex(indexPath).filter((entry) => entry.run_id !== runId);
  fs.writeFileSync(indexPath, `${JSON.stringify([summary, ...existing], null, 2)}\n`);

  if (!options.dryRun) {
    // Fix 3: Use GITHUB_TOKEN for push if available
    const pushArgs = ['push'];
    if (process.env.GITHUB_TOKEN) {
      const encoded = Buffer.from(`x-access-token:${process.env.GITHUB_TOKEN}`).toString('base64');
      pushArgs.unshift('-c', `http.extraheader=Authorization: Basic ${encoded}`);
    }

    for (const args of [
      ['add', 'dashboard/runs/'],
      ['commit', '-m', `chore(runs): add run ${runId}`],
      pushArgs,
    ]) {
      const result = runGit(spawnSyncFn, repoRoot, args);
      if (result.status !== 0) {
        // Fix 4b: Clean up written files on failure so next attempt isn't dirty
        if (args.includes('push')) {
          runGit(spawnSyncFn, repoRoot, ['reset', 'HEAD~1']);
        } else if (args.includes('commit')) {
          runGit(spawnSyncFn, repoRoot, ['reset', 'HEAD', '--', 'dashboard/runs/']);
        }
        runGit(spawnSyncFn, repoRoot, ['checkout', '--', 'dashboard/runs/']);
        runGit(spawnSyncFn, repoRoot, ['clean', '-fd', '--',
          path.relative(repoRoot, publishedPath),
          path.relative(repoRoot, indexPath),
        ]);
        return { ok: false, error: gitFailure(result, `git ${args[args.length - 1]} failed`) };
      }
    }
  }

  return { ok: true, publishedPath, indexUpdated: true };
}

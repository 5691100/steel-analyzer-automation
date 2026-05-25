#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ADAPTER_MAP, injectSentinel, parseVerdict } from '../lib/adapters.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getPaths() {
  const ROOT = process.env.AGENT_TASKS_ROOT || path.join(__dirname, '..');
  return {
    QUEUE: path.join(ROOT, 'queue'),
    RUNNING: path.join(ROOT, 'running'),
    RESULTS: path.join(ROOT, 'results'),
    DEAD: path.join(ROOT, 'dead-letter')
  };
}

export async function dispatch(id, fromDead = false) {
  const { QUEUE, RUNNING, RESULTS, DEAD } = getPaths();
  const fileName = `${id}.json`;
  let sourcePath = path.join(QUEUE, fileName);
  if (fromDead) {
    sourcePath = path.join(DEAD, fileName);
  }

  if (!fs.existsSync(sourcePath)) {
    console.error(`Task ${id} not found in ${fromDead ? 'dead-letter' : 'queue'}`);
    return;
  }

  const task = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
  if (fromDead) {
    task.attempts = 0;
    task.state = 'queued';
  }

  const runningPath = path.join(RUNNING, fileName);
  const now = new Date().toISOString();

  task.state = 'claimed';
  task.claimed_at = now;
  fs.writeFileSync(runningPath, JSON.stringify(task, null, 2));
  fs.unlinkSync(sourcePath);

  const adapter = ADAPTER_MAP[task.to];
  let tempPrompt;
  try {
    tempPrompt = injectSentinel(task.prompt_path);
    task.state = 'running';
    fs.writeFileSync(runningPath, JSON.stringify(task, null, 2));

    let { stdout, exitCode } = adapter(task, tempPrompt);
    if (stdout.length > 10 * 1024 * 1024) {
      stdout = stdout.slice(0, 10 * 1024 * 1024);
    }

    if (exitCode === 0) {
      const parsed = parseVerdict(stdout) || { verdict: 'ERROR', findings: [] };
      fs.mkdirSync(path.join(RESULTS, id), { recursive: true });
      fs.writeFileSync(path.join(RESULTS, id, 'result.json'), JSON.stringify({
        schema: 'pos.result.v1',
        task_id: id,
        from: task.to,
        ...parsed,
        exit_code: 0,
        completed_at: new Date().toISOString(),
        error: null,
        gepa_proposal: parsed.gepa_proposal || null
      }, null, 2));
      fs.writeFileSync(path.join(RESULTS, id, 'result.md'), stdout);
      fs.renameSync(runningPath, path.join(RESULTS, id, 'task.json'));
    } else {
      task.attempts = (task.attempts || 0) + 1;
      task.state = 'queued';
      fs.writeFileSync(path.join(QUEUE, fileName), JSON.stringify(task, null, 2));
      fs.unlinkSync(runningPath);
    }
  } catch (e) {
    task.attempts = (task.attempts || 0) + 1;
    task.state = 'queued';
    fs.writeFileSync(path.join(QUEUE, fileName), JSON.stringify(task, null, 2));
    fs.unlinkSync(runningPath);
  } finally {
    if (tempPrompt) {
      try { fs.unlinkSync(tempPrompt); } catch {}
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === '--replay') {
    dispatch(args[1], true);
  } else if (args[0]) {
    dispatch(args[0], false);
  } else {
    console.log('Usage: node pos-dispatch.mjs <task-id> | --replay <id>');
  }
}

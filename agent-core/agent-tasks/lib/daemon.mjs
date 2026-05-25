import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import child_process from 'node:child_process';
import { ADAPTER_MAP, injectSentinel, parseVerdict } from './adapters.mjs';
import { validateTask } from './task-schema.mjs';

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

export function startupSweep() {
  const { QUEUE, RUNNING, DEAD } = getPaths();

  // Recover stale .claiming files first — runs even when RUNNING dir is absent
  if (fs.existsSync(QUEUE)) {
    const claimingFiles = fs.readdirSync(QUEUE).filter(f => f.endsWith('.json.claiming'));
    let recovered = 0;
    for (const file of claimingFiles) {
      const claimingPath = path.join(QUEUE, file);
      const queuePath = path.join(QUEUE, file.slice(0, -'.claiming'.length));
      try {
        fs.renameSync(claimingPath, queuePath);
        recovered++;
      } catch (e) {
        console.error(`[STARTUP] Failed to recover claiming file ${file}: ${e.message}`);
      }
    }
    if (recovered > 0) {
      console.log(`[STARTUP] Recovered ${recovered} stale .claiming file(s) back to queue`);
    }
  }

  if (!fs.existsSync(RUNNING)) return;
  const files = fs.readdirSync(RUNNING).filter(f => f.endsWith('.json'));
  for (const file of files) {
    const filePath = path.join(RUNNING, file);
    try {
      const task = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      let elapsed = Infinity;
      if (task.claimed_at) {
        elapsed = Date.now() - Date.parse(task.claimed_at);
      }
      
      if (elapsed > (task.timeout_sec || 600) * 1.5 * 1000) {
        task.attempts = (task.attempts || 0) + 1;
        if (task.attempts >= 3) {
          task.state = 'dead_letter';
          fs.writeFileSync(path.join(DEAD, file), JSON.stringify(task, null, 2));
          fs.unlinkSync(filePath);
        } else {
          task.state = 'queued';
          fs.writeFileSync(path.join(QUEUE, file), JSON.stringify(task, null, 2));
          fs.unlinkSync(filePath);
        }
      }
    } catch (e) {
      console.error(`Failed to process orphan task ${file}: ${e.message}`);
    }
  }

}

export async function poll() {
  const { QUEUE, RUNNING, RESULTS, DEAD } = getPaths();
  if (!fs.existsSync(QUEUE)) return;
  const files = fs.readdirSync(QUEUE).filter(f => f.endsWith('.json'));
  const tasks = [];
  for (const file of files) {
    try {
      const task = JSON.parse(fs.readFileSync(path.join(QUEUE, file), 'utf8'));
      validateTask(task);
      tasks.push({ task, file });
    } catch (e) {
      // Malformed tasks are skipped silently
    }
  }

  tasks.sort((a, b) => {
    if (a.task.priority !== b.task.priority) {
      return (a.task.priority || 5) - (b.task.priority || 5);
    }
    return Date.parse(a.task.created_at) - Date.parse(b.task.created_at);
  });

  for (const { task, file } of tasks) {
    const id = task.id;
    const queuePath = path.join(QUEUE, file);
    const runningPath = path.join(RUNNING, file);
    const now = new Date().toISOString();

    if ((task.attempts || 0) >= 3) {
      task.state = 'dead_letter';
      { const tmpDL = queuePath + '.tmp'; fs.writeFileSync(tmpDL, JSON.stringify(task, null, 2)); fs.renameSync(tmpDL, queuePath); }
      fs.renameSync(queuePath, path.join(DEAD, file));
      continue;
    }

    if (task.deadline_at && Date.parse(task.deadline_at) < Date.now()) {
      task.state = 'dead_letter';
      { const tmpDL = queuePath + '.tmp'; fs.writeFileSync(tmpDL, JSON.stringify(task, null, 2)); fs.renameSync(tmpDL, queuePath); }
      fs.renameSync(queuePath, path.join(DEAD, file));
      continue;
    }

    if (task.dry_run) {
      const result = {
        schema: 'pos.result.v1',
        task_id: id,
        from: task.to,
        verdict: 'DRY_RUN',
        findings: [],
        exit_code: 0,
        completed_at: now,
        error: null,
        gepa_proposal: null
      };
      fs.mkdirSync(path.join(RESULTS, id), { recursive: true });
      fs.writeFileSync(path.join(RESULTS, id, 'result.json'), JSON.stringify(result, null, 2));
      fs.unlinkSync(queuePath);
      continue;
    }

    // Атомарно захватываем через rename queue -> claiming
    const claimingPath = queuePath + '.claiming';
    try {
      fs.renameSync(queuePath, claimingPath);
    } catch (e) {
      if (e.code === 'ENOENT') continue; // другой экземпляр уже захватил
      throw e;
    }

    task.state = 'claimed';
    task.claimed_at = now;
    const tmpRunningPath = runningPath + '.tmp';
    fs.writeFileSync(tmpRunningPath, JSON.stringify(task, null, 2));
    fs.renameSync(tmpRunningPath, runningPath);
    fs.unlinkSync(claimingPath); // убираем claiming файл

    const adapter = ADAPTER_MAP[task.to];
    const cli = task.to;

    const which = child_process.spawnSync('which', [cli]);
    if (which.status !== 0) {
      task.attempts = (task.attempts || 0) + 1;
      task.state = 'queued';
      fs.writeFileSync(queuePath, JSON.stringify(task, null, 2));
      fs.unlinkSync(runningPath);
      continue;
    }

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
        if (parsed.gepa_proposal) {
          console.log('[GEPA]', JSON.stringify(parsed.gepa_proposal));
        }
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
        if (task.attempts >= 3) {
          task.state = 'dead_letter';
          { const tmpDL = runningPath + '.tmp'; fs.writeFileSync(tmpDL, JSON.stringify(task, null, 2)); fs.renameSync(tmpDL, runningPath); }
          fs.renameSync(runningPath, path.join(DEAD, file));
        } else {
          task.state = 'queued';
          fs.writeFileSync(queuePath, JSON.stringify(task, null, 2));
          fs.unlinkSync(runningPath);
        }
      }
    } catch (e) {
      task.attempts = (task.attempts || 0) + 1;
      if (task.attempts >= 3) {
        task.state = 'dead_letter';
          { const tmpDL = runningPath + '.tmp'; fs.writeFileSync(tmpDL, JSON.stringify(task, null, 2)); fs.renameSync(tmpDL, runningPath); }
          fs.renameSync(runningPath, path.join(DEAD, file));
      } else {
        task.state = 'queued';
        fs.writeFileSync(queuePath, JSON.stringify(task, null, 2));
        fs.unlinkSync(runningPath);
      }
    } finally {
      if (tempPrompt) {
        try { fs.unlinkSync(tempPrompt); } catch {}
      }
    }
  }

  if (fs.existsSync(RUNNING)) {
    const runningFiles = fs.readdirSync(RUNNING);
    for (const f of runningFiles) {
      if (f.endsWith('.tmp')) {
        const p = path.join(RUNNING, f);
        const stat = fs.statSync(p);
        if (Date.now() - stat.mtimeMs > 60 * 1000) {
          fs.unlinkSync(p);
        }
      }
    }
  }
}

export function runDaemon() {
  startupSweep();
  setInterval(poll, 5000);
}

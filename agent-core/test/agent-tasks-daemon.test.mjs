import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import child_process from 'node:child_process';
import { mock } from 'node:test';

// Set ROOT for the library to use
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tasks-test-'));
process.env.AGENT_TASKS_ROOT = tmpDir;

// Mock dirs
const queueDir = path.join(tmpDir, 'queue');
const runningDir = path.join(tmpDir, 'running');
const resultsDir = path.join(tmpDir, 'results');
const deadDir = path.join(tmpDir, 'dead-letter');
fs.mkdirSync(queueDir);
fs.mkdirSync(runningDir);
fs.mkdirSync(resultsDir);
fs.mkdirSync(deadDir);

// Now import the daemon
import * as daemon from '../agent-tasks/lib/daemon.mjs';

describe('agent-tasks-daemon', () => {
  beforeEach(() => {
    // Clear dirs
    [queueDir, runningDir, resultsDir, deadDir].forEach(dir => {
      if (fs.existsSync(dir)) {
        fs.readdirSync(dir).forEach(file => {
          fs.rmSync(path.join(dir, file), { recursive: true, force: true });
        });
      }
    });
    mock.restoreAll();
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('1. queued task claimed — queue file gone, running file exists with claimed_at set', async () => {
    const taskId = 'task-1';
    const task = {
      schema: 'pos.task.v1', id: taskId, from: 'claude', to: 'codex', type: 'code-review',
      priority: 5, created_at: new Date().toISOString(), state: 'queued',
      prompt_path: path.join(tmpDir, 'prompt.md'), cwd: tmpDir, result_path: 'results/task-1/result.json'
    };
    fs.writeFileSync(path.join(tmpDir, 'prompt.md'), 'test prompt');
    fs.writeFileSync(path.join(queueDir, taskId + '.json'), JSON.stringify(task));

    mock.method(child_process, 'spawnSync', (cmd) => {
      if (cmd === 'which') return { status: 0 };
      return { status: 0, stdout: '<<<POS_RESULT>>>\n{"verdict":"APPROVE","findings":[]}\n<<<END>>>' };
    });

    await daemon.poll();

    assert.ok(!fs.existsSync(path.join(queueDir, taskId + '.json')), 'Queue file should be gone');
    assert.ok(fs.existsSync(path.join(resultsDir, taskId, 'task.json')), 'Task should be in results');
    const savedTask = JSON.parse(fs.readFileSync(path.join(resultsDir, taskId, 'task.json'), 'utf8'));
    assert.ok(savedTask.claimed_at, 'claimed_at should be set');
  });

  test('2. successful dispatch — running → results, result.json has verdict field', async () => {
    const taskId = 'task-2';
    const task = {
      schema: 'pos.task.v1', id: taskId, from: 'claude', to: 'codex', type: 'code-review',
      priority: 5, created_at: new Date().toISOString(), state: 'queued',
      prompt_path: path.join(tmpDir, 'prompt.md'), cwd: tmpDir, result_path: 'results/task-2/result.json'
    };
    fs.writeFileSync(path.join(queueDir, taskId + '.json'), JSON.stringify(task));

    mock.method(child_process, 'spawnSync', (cmd) => {
      if (cmd === 'which') return { status: 0 };
      return { status: 0, stdout: '<<<POS_RESULT>>>\n{"verdict":"APPROVE","findings":[]}\n<<<END>>>' };
    });

    await daemon.poll();

    assert.ok(fs.existsSync(path.join(resultsDir, taskId, 'result.json')));
    const result = JSON.parse(fs.readFileSync(path.join(resultsDir, taskId, 'result.json'), 'utf8'));
    assert.equal(result.verdict, 'APPROVE');
  });

  test('3. failed dispatch (exitCode!=0) — attempts incremented, task back in queue', async () => {
    const taskId = 'task-3';
    const task = {
      schema: 'pos.task.v1', id: taskId, from: 'claude', to: 'codex', type: 'code-review',
      priority: 5, created_at: new Date().toISOString(), state: 'queued',
      prompt_path: path.join(tmpDir, 'prompt.md'), cwd: tmpDir, result_path: 'results/task-3/result.json',
      attempts: 0
    };
    fs.writeFileSync(path.join(queueDir, taskId + '.json'), JSON.stringify(task));

    mock.method(child_process, 'spawnSync', (cmd) => {
      if (cmd === 'which') return { status: 0 };
      return { status: 1, stdout: 'error' };
    });

    await daemon.poll();

    assert.ok(fs.existsSync(path.join(queueDir, taskId + '.json')), 'Task should be back in queue');
    const updatedTask = JSON.parse(fs.readFileSync(path.join(queueDir, taskId + '.json'), 'utf8'));
    assert.equal(updatedTask.attempts, 1);
  });

  test('4. dead-letter after 3 failures — task in dead-letter/, not in queue/', async () => {
    const taskId = 'task-4';
    const task = {
      schema: 'pos.task.v1', id: taskId, from: 'claude', to: 'codex', type: 'code-review',
      priority: 5, created_at: new Date().toISOString(), state: 'queued',
      prompt_path: path.join(tmpDir, 'prompt.md'), cwd: tmpDir, result_path: 'results/task-4/result.json',
      attempts: 2
    };
    fs.writeFileSync(path.join(queueDir, taskId + '.json'), JSON.stringify(task));

    mock.method(child_process, 'spawnSync', (cmd) => {
      if (cmd === 'which') return { status: 0 };
      return { status: 1 };
    });

    await daemon.poll();

    assert.ok(!fs.existsSync(path.join(queueDir, taskId + '.json')));
    assert.ok(fs.existsSync(path.join(deadDir, taskId + '.json')));
  });

  test('5. deadline_at expired — immediate dead-letter, attempts not incremented', async () => {
    const taskId = 'task-5';
    const task = {
      schema: 'pos.task.v1', id: taskId, from: 'claude', to: 'codex', type: 'code-review',
      priority: 5, created_at: new Date().toISOString(), state: 'queued',
      prompt_path: path.join(tmpDir, 'prompt.md'), cwd: tmpDir, result_path: 'results/task-5/result.json',
      deadline_at: new Date(Date.now() - 1000).toISOString(),
      attempts: 0
    };
    fs.writeFileSync(path.join(queueDir, taskId + '.json'), JSON.stringify(task));

    await daemon.poll();

    assert.ok(fs.existsSync(path.join(deadDir, taskId + '.json')));
    const deadTask = JSON.parse(fs.readFileSync(path.join(deadDir, taskId + '.json'), 'utf8'));
    assert.equal(deadTask.attempts, 0);
  });

  test('6. orphan recovery — running/ task with stale claimed_at requeued with attempts++', async () => {
    const taskId = 'task-6';
    const task = {
      schema: 'pos.task.v1', id: taskId, from: 'claude', to: 'codex', type: 'code-review',
      priority: 5, created_at: new Date().toISOString(), state: 'claimed',
      claimed_at: new Date(Date.now() - 2000 * 1000).toISOString(),
      prompt_path: path.join(tmpDir, 'prompt.md'), cwd: tmpDir, result_path: 'results/task-6/result.json',
      timeout_sec: 600,
      attempts: 0
    };
    fs.writeFileSync(path.join(runningDir, taskId + '.json'), JSON.stringify(task));

    daemon.startupSweep();

    assert.ok(!fs.existsSync(path.join(runningDir, taskId + '.json')));
    assert.ok(fs.existsSync(path.join(queueDir, taskId + '.json')));
    const recoveredTask = JSON.parse(fs.readFileSync(path.join(queueDir, taskId + '.json'), 'utf8'));
    assert.equal(recoveredTask.attempts, 1);
  });

  test('7. malformed task.json — skipped silently, other tasks processed', async () => {
    fs.writeFileSync(path.join(queueDir, 'malformed.json'), 'invalid json');
    
    const taskId = 'task-7';
    const task = {
      schema: 'pos.task.v1', id: taskId, from: 'claude', to: 'codex', type: 'code-review',
      priority: 5, created_at: new Date().toISOString(), state: 'queued',
      prompt_path: path.join(tmpDir, 'prompt.md'), cwd: tmpDir, result_path: 'results/task-7/result.json'
    };
    fs.writeFileSync(path.join(queueDir, taskId + '.json'), JSON.stringify(task));

    mock.method(child_process, 'spawnSync', (cmd) => {
      if (cmd === 'which') return { status: 0 };
      return { status: 0, stdout: '<<<POS_RESULT>>>\n{"verdict":"APPROVE","findings":[]}\n<<<END>>>' };
    });

    await daemon.poll();

    assert.ok(fs.existsSync(path.join(resultsDir, taskId, 'result.json')));
    assert.ok(fs.existsSync(path.join(queueDir, 'malformed.json')));
  });

  test('8. priority ordering — priority=1 task dispatched before priority=5 task', async () => {
    const task1 = {
      schema: 'pos.task.v1', id: 'task-8-p5', from: 'claude', to: 'codex', type: 'code-review',
      priority: 5, created_at: new Date().toISOString(), state: 'queued',
      prompt_path: path.join(tmpDir, 'p5.md'), cwd: tmpDir, result_path: 'results/p5/result.json'
    };
    const task2 = {
      schema: 'pos.task.v1', id: 'task-8-p1', from: 'claude', to: 'codex', type: 'code-review',
      priority: 1, created_at: new Date().toISOString(), state: 'queued',
      prompt_path: path.join(tmpDir, 'p1.md'), cwd: tmpDir, result_path: 'results/p1/result.json'
    };
    fs.writeFileSync(path.join(tmpDir, 'p5.md'), 'p5');
    fs.writeFileSync(path.join(tmpDir, 'p1.md'), 'p1');
    fs.writeFileSync(path.join(queueDir, 'task-8-p5.json'), JSON.stringify(task1));
    fs.writeFileSync(path.join(queueDir, 'task-8-p1.json'), JSON.stringify(task2));

    let order = [];
    mock.method(child_process, 'spawnSync', (cmd, args, options) => {
      if (cmd === 'which') return { status: 0 };
      if (cmd === 'codex' || cmd === 'gemini' || cmd === 'claude') {
        const promptContent = options && options.input ? options.input : args[args.length - 1];
        if (promptContent.includes('p5')) order.push('p5');
        if (promptContent.includes('p1')) order.push('p1');
        return { status: 0, stdout: '<<<POS_RESULT>>>\n{"verdict":"APPROVE","findings":[]}\n<<<END>>>' };
      }
      return { status: 0 };
    });

    await daemon.poll();

    assert.deepEqual(order, ['p1', 'p5']);
  });
});

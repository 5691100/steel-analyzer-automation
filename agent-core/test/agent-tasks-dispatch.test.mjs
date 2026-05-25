import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { mock } from 'node:test';
import cp from 'node:child_process';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tasks-dispatch-test-'));
process.env.AGENT_TASKS_ROOT = tmpDir;

import * as adapters from '../agent-tasks/lib/adapters.mjs';
import * as dispatchLib from '../agent-tasks/bin/pos-dispatch.mjs';

describe('agent-tasks-dispatch', () => {
  let queueDir, runningDir, resultsDir, deadDir;

  before(() => {
    queueDir = path.join(tmpDir, 'queue');
    runningDir = path.join(tmpDir, 'running');
    resultsDir = path.join(tmpDir, 'results');
    deadDir = path.join(tmpDir, 'dead-letter');
    fs.mkdirSync(queueDir);
    fs.mkdirSync(runningDir);
    fs.mkdirSync(resultsDir);
    fs.mkdirSync(deadDir);
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('9. sentinel injection — injectSentinel() creates .tmp file with <<<POS_RESULT>>> block', () => {
    const promptPath = path.join(tmpDir, 'test-prompt.md');
    fs.writeFileSync(promptPath, 'Hello world');
    const tempPath = adapters.injectSentinel(promptPath);
    
    assert.ok(fs.existsSync(tempPath));
    const content = fs.readFileSync(tempPath, 'utf8');
    assert.ok(content.includes('<<<POS_RESULT>>>'));
    assert.ok(content.includes('<<<END>>>'));
    fs.unlinkSync(tempPath);
  });

  test('10. verdict parsing valid — parseVerdict returns correct object from sentinel output', () => {
    const stdout = 'Some log\n<<<POS_RESULT>>>\n{"verdict":"APPROVE","findings":[{"message":"ok"}]}\n<<<END>>>\nFooter';
    const parsed = adapters.parseVerdict(stdout);
    assert.equal(parsed.verdict, 'APPROVE');
    assert.equal(parsed.findings[0].message, 'ok');
  });

  test('11. verdict parsing missing sentinel — returns null', () => {
    const stdout = 'No sentinel here';
    const parsed = adapters.parseVerdict(stdout);
    assert.equal(parsed, null);
  });

  test('12. verdict parsing multiple sentinels — last match used', () => {
    const stdout = '<<<POS_RESULT>>>{"verdict":"FIRST"}<<<END>>>\n<<<POS_RESULT>>>{"verdict":"SECOND"}<<<END>>>';
    const parsed = adapters.parseVerdict(stdout);
    assert.equal(parsed.verdict, 'SECOND');
  });

  test('13. stdout >10MB — truncated, parse still finds sentinel near start', () => {
    const largeData = 'A'.repeat(11 * 1024 * 1024);
    const stdout = '<<<POS_RESULT>>>{"verdict":"LARGE"}<<<END>>>' + largeData;
    const truncated = stdout.slice(0, 10 * 1024 * 1024);
    const parsed = adapters.parseVerdict(truncated);
    assert.equal(parsed.verdict, 'LARGE');
  });

  test('14. pos-dispatch.mjs manual trigger — mock adapter, task moves to results/', async () => {
    const taskId = 'manual-1';
    const task = {
      schema: 'pos.task.v1', id: taskId, from: 'claude', to: 'codex', type: 'code-review',
      priority: 5, created_at: new Date().toISOString(), state: 'queued',
      prompt_path: path.join(tmpDir, 'prompt.md'), cwd: tmpDir, result_path: 'results/manual-1/result.json'
    };
    fs.writeFileSync(path.join(tmpDir, 'prompt.md'), 'test');
    fs.writeFileSync(path.join(queueDir, taskId + '.json'), JSON.stringify(task));

    mock.method(cp, 'spawnSync', (cmd) => {
      if (cmd === 'which') return { status: 0 };
      return { status: 0, stdout: '<<<POS_RESULT>>>\n{"verdict":"APPROVE","findings":[]}\n<<<END>>>' };
    });

    await dispatchLib.dispatch(taskId);

    assert.ok(fs.existsSync(path.join(resultsDir, taskId, 'result.json')));
  });

  test('15. --replay flag — dead-letter task moves to queue, attempts=0, dispatched', async () => {
    const taskId = 'replay-1';
    const task = {
      schema: 'pos.task.v1', id: taskId, from: 'claude', to: 'codex', type: 'code-review',
      priority: 5, created_at: new Date().toISOString(), state: 'dead_letter',
      prompt_path: path.join(tmpDir, 'prompt.md'), cwd: tmpDir, result_path: 'results/replay-1/result.json',
      attempts: 3
    };
    fs.writeFileSync(path.join(deadDir, taskId + '.json'), JSON.stringify(task));

    mock.method(cp, 'spawnSync', (cmd) => {
      if (cmd === 'which') return { status: 0 };
      return { status: 0, stdout: '<<<POS_RESULT>>>\n{"verdict":"APPROVE","findings":[]}\n<<<END>>>' };
    });

    await dispatchLib.dispatch(taskId, true);

    assert.ok(fs.existsSync(path.join(resultsDir, taskId, 'result.json')));
    const savedTask = JSON.parse(fs.readFileSync(path.join(resultsDir, taskId, 'task.json'), 'utf8'));
    assert.equal(savedTask.attempts, 0);
  });

  test('16. dry_run in pos-dispatch — task marked DRY_RUN, no CLI invoked', async () => {
    const taskId = 'dryrun-1';
    const task = {
      schema: 'pos.task.v1', id: taskId, from: 'claude', to: 'codex', type: 'code-review',
      priority: 5, created_at: new Date().toISOString(), state: 'queued',
      dry_run: true,
      prompt_path: path.join(tmpDir, 'prompt.md'), cwd: tmpDir,
      result_path: 'results/' + taskId + '/result.json'
    };
    fs.writeFileSync(path.join(tmpDir, 'prompt.md'), 'test dry');
    fs.writeFileSync(path.join(queueDir, taskId + '.json'), JSON.stringify(task));

    let cliInvoked = false;
    mock.method(cp, 'spawnSync', (cmd) => {
      if (cmd === 'which') return { status: 0 };
      cliInvoked = true;
      return { status: 0, stdout: '' };
    });

    await dispatchLib.dispatch(taskId);

    assert.ok(!cliInvoked, 'CLI should not be invoked for dry_run task');
    const result = JSON.parse(fs.readFileSync(path.join(resultsDir, taskId, 'result.json'), 'utf8'));
    assert.equal(result.verdict, 'DRY_RUN');
  });

});

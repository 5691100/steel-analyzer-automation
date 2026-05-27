import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { dispatchOpenChatQuestion, dispatchGeminiAnalysis, dispatchAntigravityQA, dispatchCodexReview, writeGepaRegister } from '../src/llm-dispatcher.mjs';

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

  it('returns a string answer for an antigravity agent, calling claude with skip-permissions flag', async () => {
    let calledCmd, calledArgs, calledOpts;
    const answer = await dispatchOpenChatQuestion(
      'run-test',
      'g1_gemini',
      'Сколько профилей?',
      'antigravity',
      {
        spawn: (cmd, args, opts) => {
          calledCmd = cmd;
          calledArgs = args;
          calledOpts = opts;
          return {
            stdout: 'В источниках 42 профиля.',
            stderr: '',
            status: 0,
            error: null,
          };
        },
      }
    );
    assert.equal(answer, 'В источниках 42 профиля.');
    assert.equal(calledCmd, 'claude');
    assert.deepEqual(calledArgs, ['--dangerously-skip-permissions', '-p', '-']);
    assert.ok(calledOpts && calledOpts.input && calledOpts.input.includes('Сколько профилей?'));
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

describe('dispatchGeminiAnalysis', () => {
  it('calls claude binary with --dangerously-skip-permissions, -p, and - with prompt in stdin', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-disp-test-'));
    const runDir = path.join(tempDir, 'run');
    const sourcesDir = path.join(runDir, 'sources');
    fs.mkdirSync(sourcesDir, { recursive: true });
    fs.writeFileSync(path.join(sourcesDir, 'source.txt'), 'steel source', 'utf8');

    let calledCmd, calledArgs, calledOpts;
    await dispatchGeminiAnalysis('run-123', runDir, sourcesDir, {
      spawn: (cmd, args, opts) => {
        calledCmd = cmd;
        calledArgs = args;
        calledOpts = opts;
        return {
          stdout: JSON.stringify({
            project_name: 'Project',
            subprojects: [{ name: 'All', totals: { weight_kg: 0, paint_m2: 0 }, profiles: [] }]
          }),
          status: 0
        };
      },
      generate: async () => {},
      generateDash: () => {},
      verify: () => ({ ok: true, errors: [], files: [] })
    });

    assert.equal(calledCmd, 'claude');
    assert.deepEqual(calledArgs, ['--dangerously-skip-permissions', '-p', '-']);
    assert.ok(calledOpts && calledOpts.input && calledOpts.input.includes('run-123'));
    assert.equal(calledOpts.cwd, '/tmp');
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});

describe('dispatchGeminiAnalysis customComment', () => {
  it('appends customComment to the prompt sent to agy', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-comment-test-'));
    const runDir = path.join(tempDir, 'run');
    const sourcesDir = path.join(runDir, 'sources');
    fs.mkdirSync(sourcesDir, { recursive: true });
    fs.writeFileSync(path.join(sourcesDir, 'source.txt'), 'steel source', 'utf8');

    let capturedInput;
    await dispatchGeminiAnalysis('run-comment', runDir, sourcesDir, {
      spawn: (_cmd, _args, opts) => {
        capturedInput = opts.input;
        return {
          stdout: JSON.stringify({
            project_name: 'P', subprojects: [{ name: 'All', totals: { weight_kg: 0, paint_m2: 0 }, profiles: [] }]
          }),
          status: 0
        };
      },
      generate: async () => {},
      generateDash: () => {},
      verify: () => ({ ok: true, errors: [], files: [] }),
      customComment: 'Обратить внимание на покрытие балок'
    });

    assert.ok(capturedInput.includes('Обратить внимание на покрытие балок'), 'prompt must include customComment');
    assert.ok(capturedInput.includes('Дополнительные указания'), 'prompt must include header');
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});

describe('dispatchAntigravityQA', () => {
  it('returns ACCEPTED when agy returns valid ACCEPTED JSON', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-test-'));
    const runDir = path.join(tempDir, 'run');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'gemini-analysis.json'), JSON.stringify({ project_name: 'Test', subprojects: [] }), 'utf8');

    const result = await dispatchAntigravityQA('run-qa-1', runDir, {
      spawn: () => ({
        stdout: JSON.stringify({ verdict: 'ACCEPTED', notes: 'All good' }),
        stderr: '',
        status: 0,
        error: null
      })
    });

    assert.equal(result.verdict, 'ACCEPTED');
    assert.equal(result.notes, 'All good');
    const qaFile = JSON.parse(fs.readFileSync(path.join(runDir, 'qa-result.json'), 'utf8'));
    assert.equal(qaFile.verdict, 'ACCEPTED');
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns BLOCKED when agy returns BLOCKED', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-test-'));
    const runDir = path.join(tempDir, 'run');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'gemini-analysis.json'), '{}', 'utf8');

    const result = await dispatchAntigravityQA('run-qa-2', runDir, {
      spawn: () => ({
        stdout: JSON.stringify({ verdict: 'BLOCKED', notes: 'Missing weights' }),
        stderr: '',
        status: 0,
        error: null
      })
    });

    assert.equal(result.verdict, 'BLOCKED');
    assert.ok(result.notes.includes('Missing weights'));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns BLOCKED when gemini-analysis.json does not exist', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-test-'));
    const runDir = path.join(tempDir, 'run');
    fs.mkdirSync(runDir, { recursive: true });

    const result = await dispatchAntigravityQA('run-qa-3', runDir);
    assert.equal(result.verdict, 'BLOCKED');
    assert.ok(result.notes.includes('not found'));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns BLOCKED when agy process fails', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-test-'));
    const runDir = path.join(tempDir, 'run');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'gemini-analysis.json'), '{}', 'utf8');

    const result = await dispatchAntigravityQA('run-qa-4', runDir, {
      spawn: () => ({ stdout: '', stderr: 'crash', status: 1, error: null })
    });

    assert.equal(result.verdict, 'BLOCKED');
    assert.ok(result.notes.includes('failed'));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});

describe('dispatchCodexReview', () => {
  it('returns APPROVED when codex returns valid APPROVED JSON', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-review-test-'));
    const runDir = path.join(tempDir, 'run');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'gemini-analysis.json'), JSON.stringify({ project_name: 'Test', subprojects: [] }), 'utf8');

    const result = await dispatchCodexReview('run-cr-1', runDir, {
      spawn: () => ({
        stdout: JSON.stringify({ verdict: 'APPROVED', notes: '', proposals: [] }),
        stderr: '',
        status: 0,
        error: null
      })
    });

    assert.equal(result.verdict, 'APPROVED');
    assert.deepEqual(result.proposals, []);
    const reviewFile = JSON.parse(fs.readFileSync(path.join(runDir, 'codex-review.json'), 'utf8'));
    assert.equal(reviewFile.verdict, 'APPROVED');
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns NEEDS_FIXES with proposals when codex finds issues', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-review-test-'));
    const runDir = path.join(tempDir, 'run');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'gemini-analysis.json'), '{}', 'utf8');

    const result = await dispatchCodexReview('run-cr-2', runDir, {
      spawn: () => ({
        stdout: JSON.stringify({
          verdict: 'NEEDS_FIXES',
          notes: 'Missing weights for HEA200',
          proposals: [{ id: 'GEPA-001', description: 'Check HEA200 weight' }]
        }),
        stderr: '',
        status: 0,
        error: null
      })
    });

    assert.equal(result.verdict, 'NEEDS_FIXES');
    assert.ok(result.notes.includes('HEA200'));
    assert.equal(result.proposals.length, 1);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns NEEDS_FIXES when gemini-analysis.json does not exist', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-review-test-'));
    const runDir = path.join(tempDir, 'run');
    fs.mkdirSync(runDir, { recursive: true });

    const result = await dispatchCodexReview('run-cr-3', runDir);
    assert.equal(result.verdict, 'NEEDS_FIXES');
    assert.ok(result.notes.includes('not found'));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns NEEDS_FIXES when codex process fails', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-review-test-'));
    const runDir = path.join(tempDir, 'run');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'gemini-analysis.json'), '{}', 'utf8');

    const result = await dispatchCodexReview('run-cr-4', runDir, {
      spawn: () => ({ stdout: '', stderr: 'crash', status: 1, error: null })
    });

    assert.equal(result.verdict, 'NEEDS_FIXES');
    assert.ok(result.notes.includes('failed'));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});

describe('writeGepaRegister', () => {
  it('writes a valid gepa-register.json with proposals', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gepa-test-'));
    const runDir = path.join(tempDir, 'run');
    fs.mkdirSync(runDir, { recursive: true });

    const proposals = [
      { description: 'Check HEA200', drawing_ref: 'ST-01' },
      { id: 'GEPA-002', description: 'Verify IPE300 weight' }
    ];
    const registerPath = writeGepaRegister('run-gepa-1', runDir, proposals);

    const written = JSON.parse(fs.readFileSync(registerPath, 'utf8'));
    assert.equal(written.schema, 'steel.gepa-register.v1');
    assert.equal(written.run_id, 'run-gepa-1');
    assert.equal(written.proposals.length, 2);
    assert.equal(written.proposals[0].id, 'GEPA-001');
    assert.equal(written.proposals[0].raised_by, 'codex');
    assert.equal(written.proposals[0].owner_decision, 'pending');
    assert.equal(written.proposals[1].id, 'GEPA-002');
    assert.ok(written.updated_at);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes empty proposals array without throwing', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gepa-test-'));
    const runDir = path.join(tempDir, 'run');
    fs.mkdirSync(runDir, { recursive: true });

    const registerPath = writeGepaRegister('run-gepa-2', runDir, []);
    const written = JSON.parse(fs.readFileSync(registerPath, 'utf8'));
    assert.equal(written.proposals.length, 0);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});

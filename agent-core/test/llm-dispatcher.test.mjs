import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { dispatchGeminiAnalysis } from '../src/llm-dispatcher.mjs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('LLM Dispatcher', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'steel-dispatcher-test-'));
    fs.mkdirSync(path.join(tempDir, 'sources'));
    fs.writeFileSync(path.join(tempDir, 'sources/test.txt'), 'test source content');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should dispatch analysis and generate workbooks on valid JSON output', async (t) => {
    const mockOutput = {
      run_id: 'test-run',
      project_name: 'Test Project',
      subprojects: [{ name: 'SP1', totals: { weight_kg: 100, paint_m2: 10 }, profiles: [] }],
      excluded: [],
      sources: ['test.txt']
    };

    const spawn = () => ({ stdout: JSON.stringify(mockOutput), status: 0 });
    const generate = async () => {}; // mock
    const verify = () => ({ ok: true }); // mock

    const result = await dispatchGeminiAnalysis('test-run', tempDir, path.join(tempDir, 'sources'), { spawn, generate, verify });
    
    assert.strictEqual(result.ok, true);
    assert.ok(fs.existsSync(path.join(tempDir, 'gemini-analysis.json')));
  });

  it('should save raw output and throw error on invalid JSON', async (t) => {
    const spawn = () => ({ stdout: 'NOT JSON', status: 0 });

    await assert.rejects(
      dispatchGeminiAnalysis('test-run', tempDir, path.join(tempDir, 'sources'), { spawn }),
      /Failed to parse Gemini JSON output/
    );

    assert.ok(fs.existsSync(path.join(tempDir, 'gemini-raw.txt')));
  });

  it('should throw error if verification fails', async (t) => {
    const mockOutput = {
      run_id: 'test-run',
      project_name: 'Test Project',
      subprojects: [{ name: 'SP1', totals: { weight_kg: 100, paint_m2: 10 }, profiles: [] }],
      excluded: [],
      sources: ['test.txt']
    };

    const spawn = () => ({ stdout: JSON.stringify(mockOutput), status: 0 });
    const generate = async () => {};
    const verify = () => ({ ok: false, errors: ['Mock failure'] });

    await assert.rejects(
      dispatchGeminiAnalysis('test-run', tempDir, path.join(tempDir, 'sources'), { spawn, generate, verify }),
      /Workbook verification failed: Mock failure/
    );
  });
});

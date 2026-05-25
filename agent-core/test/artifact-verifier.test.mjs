import { describe, it, beforeEach, afterEach } from 'node:test';
import { verifyRunOutput } from '../src/artifact-verifier.mjs';
import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';

describe('Artifact Verifier', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'steel-verifier-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should return error if output directory is missing', () => {
    const result = verifyRunOutput(tempDir);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors[0].includes('Output directory missing'));
  });

  it('should return error if workbooks are missing', () => {
    fs.mkdirSync(path.join(tempDir, 'output'));
    const result = verifyRunOutput(tempDir);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errors.length, 3);
  });

  it('should return error if workbooks are too small', () => {
    const outputDir = path.join(tempDir, 'output');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(path.join(outputDir, 'test_BoM.xlsx'), 'small');
    fs.writeFileSync(path.join(outputDir, 'test_MaterialList.xlsx'), 'small');
    fs.writeFileSync(path.join(outputDir, 'test_Description.xlsx'), 'small');

    const result = verifyRunOutput(tempDir);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errors.length, 3);
    assert.ok(result.errors[0].includes('Workbook too small'));
  });

  it('should pass if all workbooks are present and valid size', () => {
    const outputDir = path.join(tempDir, 'output');
    fs.mkdirSync(outputDir);
    const validData = Buffer.alloc(1100, 'a');
    fs.writeFileSync(path.join(outputDir, 'test_BoM.xlsx'), validData);
    fs.writeFileSync(path.join(outputDir, 'test_MaterialList.xlsx'), validData);
    fs.writeFileSync(path.join(outputDir, 'test_Description.xlsx'), validData);

    const result = verifyRunOutput(tempDir);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.files.length, 3);
    assert.strictEqual(result.errors.length, 0);
  });

  it('should pass with versioned filenames', () => {
    const outputDir = path.join(tempDir, 'output');
    fs.mkdirSync(outputDir);
    const validData = Buffer.alloc(1100, 'a');
    fs.writeFileSync(path.join(outputDir, 'test_BoM_v2.xlsx'), validData);
    fs.writeFileSync(path.join(outputDir, 'test_MaterialList_v3.xlsx'), validData);
    fs.writeFileSync(path.join(outputDir, 'test_Description_v1.xlsx'), validData);

    const result = verifyRunOutput(tempDir);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.files.length, 3);
  });
});

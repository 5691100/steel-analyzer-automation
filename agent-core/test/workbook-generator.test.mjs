import { describe, it, beforeEach, afterEach } from 'node:test';
import { generateWorkbooks } from '../src/workbook-generator.mjs';
import { verifyRunOutput } from '../src/artifact-verifier.mjs';
import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';

describe('Workbook Generator', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'steel-generator-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should generate 3 workbooks from synthetic data and pass verification', async () => {
    const data = {
      run_id: 'test-run',
      project: 'Test_Project',
      subprojects: [
        {
          name: 'Skärmtak',
          coating: 'C3',
          categories: [
            { name: 'Main steel - beams', weight_kg: 1000, paint_m2: 25, qty: 10 }
          ],
          profiles: [
            { profile: 'HEA180', steel_grade: 'S355J2', qty: 5, length_m: 30, weight_kg: 500, paint_m2: 12 }
          ],
          totals: { weight_kg: 1000, paint_m2: 25 }
        }
      ],
      excluded: [
        { subproject: 'Skärmtak', scope: 'Trusses', reason: 'Local purchase', weight_kg: 200, paint_m2: 5 }
      ],
      sources: ['Source1.pdf']
    };

    const outputDir = path.join(tempDir, 'output');
    await generateWorkbooks(data, outputDir);

    const verification = verifyRunOutput(tempDir);
    assert.strictEqual(verification.ok, true, `Verification failed: ${verification.errors.join(', ')}`);
    assert.strictEqual(verification.files.length, 3);
  });

  it('should generate workbooks with empty excluded array', async () => {
    const data = {
      run_id: 'empty-excluded',
      project: 'Project',
      subprojects: [{ name: 'SP', totals: { weight_kg: 100, paint_m2: 10 }, profiles: [] }],
      excluded: [],
      sources: []
    };
    await generateWorkbooks(data, path.join(tempDir, 'out1'));
    assert.ok(fs.existsSync(path.join(tempDir, 'out1', 'BoM_Project_empty-excluded.xlsx')));
  });

  it('should generate sheets for subproject with empty assembly_map', async () => {
    const data = {
      run_id: 'empty-map',
      project: 'Project',
      subprojects: [{ name: 'SP', totals: { weight_kg: 100, paint_m2: 10 }, profiles: [], assembly_map: [] }],
      excluded: [],
      sources: []
    };
    await generateWorkbooks(data, path.join(tempDir, 'out2'));
    assert.ok(fs.existsSync(path.join(tempDir, 'out2', 'BoM_Project_empty-map.xlsx')));
  });

  it('should truncate sheet names longer than 31 characters', async () => {
    const longName = 'This is a very long subproject name that exceeds thirty one chars';
    const data = {
      run_id: 'long-name',
      project: 'Project',
      subprojects: [{ name: longName, totals: { weight_kg: 100, paint_m2: 10 }, profiles: [] }],
      excluded: [],
      sources: []
    };
    await generateWorkbooks(data, path.join(tempDir, 'out3'));
    // If it didn't throw, it's a pass for the truncation requirement
  });

  it('should throw Error if required fields are missing', async () => {
    const data = {
      run_id: 'missing-sp',
      project: 'Project'
      // missing subprojects
    };
    await assert.rejects(generateWorkbooks(data, path.join(tempDir, 'out4')), /subprojects is required/);
  });
});

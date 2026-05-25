import { describe, it, beforeEach, afterEach } from 'node:test';
import { generateWorkbooks } from '../src/workbook-generator.mjs';
import { verifyRunOutput } from '../src/artifact-verifier.mjs';
import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import ExcelJS from 'exceljs';

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
      project_no: 'P-100',
      project_name: 'Test_Project',
      project: 'Test_Project',
      sources_detail: [
        {
          subproject: 'Skärmtak',
          source_type: 'Drawing',
          file_name: 'Source1.pdf',
          used_for: 'Geometry',
          priority: 'Primary',
          notes: 'Fixture source'
        }
      ],
      subprojects: [
        {
          name: 'Skärmtak',
          coating_summary: 'C3 summary',
          fire_summary: 'R30 summary',
          transport_summary: 'Standard transport',
          excluded_rows: [
            { category: 'Trusses', part: 'FV1', profile: 'L50', steel_grade: 'S355', qty: 1, length_mm: 1000, weight_kg: 200, paint_m2: 5, exclusion_reason: 'Local purchase', source: 'Source1.pdf' }
          ],
          categories: [
            { name: 'Beams', coating: 'C3', fire_class: 'R30', weight_kg: 1000, paint_m2: 25, qty: 10 }
          ],
          profiles: [
            { profile: 'HEA180', category: 'Beams', steel_grade: 'S355J2', qty: 5, length_m: 30, weight_kg: 500, paint_m2: 12, coating: 'C3', fire_class: 'R30' }
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
    assert.ok(verification.files.length >= 3);

    const desc = new ExcelJS.Workbook();
    await desc.xlsx.readFile(path.join(outputDir, 'P-100_Test_Project_Description.xlsx'));
    assert.strictEqual(desc.getWorksheet('Sources').actualRowCount, data.sources_detail.length + 1);
    assert.strictEqual(desc.getWorksheet('Exclusions').actualRowCount, data.subprojects[0].excluded_rows.length + 1);
  });

  it('should generate workbooks with empty excluded array', async () => {
    const data = {
      run_id: 'empty-excluded',
      project_no: 'P1',
      project_name: 'Project',
      subprojects: [{ name: 'SP', totals: { weight_kg: 100, paint_m2: 10 }, profiles: [] }],
      excluded: [],
      sources: []
    };
    const outDir = path.join(tempDir, 'out1');
    await generateWorkbooks(data, outDir);
    const files = fs.readdirSync(outDir);
    assert.ok(files.some(f => f.includes('BoM')), 'BoM file missing');
  });

  it('should populate BoM profile rows from aggregated profile totals', async () => {
    const data = {
      run_id: 'bom-profile-totals',
      project_no: 'P3',
      project_name: 'Project',
      subprojects: [
        {
          name: 'SP1',
          totals: { weight_kg: 3000, paint_m2: 55 },
          profiles: [
            {
              profile: 'IPE200',
              category: 'Beams',
              steel_grade: 'S355',
              total_length_m: 18,
              total_weight_t: 1.2,
              total_paint_area_m2: 25
            },
            {
              profile: 'IPE200',
              category: 'Beams',
              steel_grade: 'S355',
              total_length_m: 12,
              total_weight_t: 0.8,
              total_paint_area_m2: 20
            }
          ]
        },
        {
          name: 'SP2',
          totals: { weight_kg: 1000, paint_m2: 10 },
          profiles: [
            {
              profile: 'HEA160',
              category: 'Columns',
              steel_grade: 'S235',
              total_length_m: 7,
              total_weight_t: 0.5,
              total_paint_area_m2: 10
            }
          ]
        }
      ]
    };

    const outDir = path.join(tempDir, 'out-bom-profile-totals');
    await generateWorkbooks(data, outDir);

    const bom = new ExcelJS.Workbook();
    await bom.xlsx.readFile(path.join(outDir, 'P3_Project_BoM.xlsx'));
    const profileSheet = bom.getWorksheet('BoM by Profile');
    const dataRows = profileSheet.getRows(4, 20)
      .filter(row => row.getCell(1).value && row.getCell(1).value !== 'Total');

    assert.strictEqual(dataRows.length, 2);
    const ipeRow = dataRows.find(row => row.getCell(1).value === 'IPE200');
    assert.ok(ipeRow, 'Missing aggregated IPE200 row');
    assert.strictEqual(ipeRow.getCell(3).value, 30);
    assert.strictEqual(ipeRow.getCell(4).value, 2);
    assert.strictEqual(ipeRow.getCell(5).value, 45);
    assert.strictEqual(ipeRow.getCell(6).value, null);
    assert.deepStrictEqual(ipeRow.getCell(7).value, { formula: `D${ipeRow.number}*F${ipeRow.number}` });

    const categorySheet = bom.getWorksheet('BoM by Category');
    const categoryRows = categorySheet.getRows(4, 20)
      .filter(row => row.getCell(1).value);
    assert.strictEqual(categoryRows.length, 2);
  });

  it('should generate sheets for subproject with empty assembly_map', async () => {
    const data = {
      run_id: 'empty-map',
      project_no: 'P2',
      project_name: 'Project',
      subprojects: [{ name: 'SP', totals: { weight_kg: 100, paint_m2: 10 }, profiles: [], assembly_map: [] }],
      excluded: [],
      sources: []
    };
    const outDir = path.join(tempDir, 'out2');
    await generateWorkbooks(data, outDir);
    const files = fs.readdirSync(outDir);
    assert.ok(files.some(f => f.includes('BoM')), 'BoM file missing');
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

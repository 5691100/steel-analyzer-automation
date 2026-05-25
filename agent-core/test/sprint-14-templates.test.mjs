import { describe, it, beforeEach, afterEach } from 'node:test';
import { generateWorkbooks } from '../src/workbook-generator.mjs';
import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import ExcelJS from 'exceljs';

describe('Sprint 14 Template Decisions', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'steel-sprint14-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should generate files with ProjectNo_ProjectName pattern and versioning', async () => {
    const data = {
      run_id: 'run123',
      project_no: '146/26',
      project_name: 'Nordic A-jaur',
      subprojects: [{ name: 'All', totals: { weight_kg: 1000, paint_m2: 25 }, profiles: [] }],
      excluded: [],
      sources: []
    };
    const outputDir = path.join(tempDir, 'output');
    await generateWorkbooks(data, outputDir);
    assert.ok(fs.existsSync(path.join(outputDir, '146_26_Nordic A-jaur_BoM.xlsx')), 'BoM filename mismatch');
    assert.ok(fs.existsSync(path.join(outputDir, '146_26_Nordic A-jaur_MaterialList.xlsx')), 'MaterialList filename mismatch');
    assert.ok(fs.existsSync(path.join(outputDir, '146_26_Nordic A-jaur_Description.xlsx')), 'Description filename mismatch');
  });

  it('should apply version suffix correctly', async () => {
    const data = {
      run_id: 'run123',
      project_no: '146/26',
      project_name: 'Nordic A-jaur',
      subprojects: [{ name: 'All', totals: { weight_kg: 1000, paint_m2: 25 }, profiles: [] }],
      excluded: [],
      sources: []
    };
    const outputDir = path.join(tempDir, 'output');
    const existingFiles = [
      '146_26_Nordic A-jaur_BoM.xlsx',
      '146_26_Nordic A-jaur_MaterialList.xlsx',
      '146_26_Nordic A-jaur_Description.xlsx'
    ];
    await generateWorkbooks(data, outputDir, { existingFiles });
    assert.ok(fs.existsSync(path.join(outputDir, '146_26_Nordic A-jaur_BoM_v2.xlsx')));
  });

  it('should have correct Description sheet order and required columns', async () => {
    const data = {
      run_id: 'run123',
      project_no: '146/26',
      project_name: 'Nordic A-jaur',
      subprojects: [
        {
          name: 'All',
          totals: { weight_kg: 1000, paint_m2: 25 },
          profiles: [],
          categories: [{ name: 'Columns', weight_kg: 500, paint_m2: 12, qty: 1 }],
          coating: 'C3',
          fire_protection: 'R30',
          transport_rows: [],
          transport_signals: []
        }
      ],
      open_questions: [],
      sources_detailed: []
    };
    const outputDir = path.join(tempDir, 'output');
    await generateWorkbooks(data, outputDir);
    const descPath = path.join(outputDir, '146_26_Nordic A-jaur_Description.xlsx');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(descPath);
    const sheetNames = workbook.worksheets.map(s => s.name);
    assert.ok(sheetNames.includes('Project Summary'));
    const summarySheet = workbook.getWorksheet('Project Summary');
    // Headers are at row 3 per new requirements
    const headers = summarySheet.getRow(3).values;
    assert.ok(headers.includes('Total Weight (t)'), 'Missing Total Weight (t) header');
  });

  it('should aggregate "All" row in Project Summary for multi-subproject projects', async () => {
    const data = {
      run_id: 'run123',
      project_no: '146/26',
      project_name: 'Nordic A-jaur',
      subprojects: [
        { name: 'SP1', totals: { weight_kg: 1000, paint_m2: 10 }, profiles: [] },
        { name: 'SP2', totals: { weight_kg: 2000, paint_m2: 20 }, profiles: [] }
      ]
    };
    const outputDir = path.join(tempDir, 'output');
    await generateWorkbooks(data, outputDir);
    const descPath = path.join(outputDir, '146_26_Nordic A-jaur_Description.xlsx');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(descPath);
    const summarySheet = workbook.getWorksheet('Project Summary');
    // Row 3: Headers
    // Row 4: SP1
    // Row 5: SP2
    // Row 6: All
    const lastRow = summarySheet.getRow(6);
    assert.strictEqual(lastRow.getCell(2).value, 'All'); // Column B is Subproject Name in [null, sp.name, ...]
    assert.strictEqual(lastRow.getCell(6).value, 3.00); // Column F is Total Weight (t) in [null, sp.name, pNo, pName, exec, weight, ...]
  });
});

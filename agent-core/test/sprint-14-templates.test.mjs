import { describe, it, beforeEach, afterEach } from 'node:test';
import { generateWorkbooks } from '../src/workbook-generator.mjs';
import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import ExcelJS from 'exceljs';
import { dispatchGeminiAnalysis } from '../src/llm-dispatcher.mjs';

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
      sources_detail: []
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
    assert.strictEqual(lastRow.getCell(1).value, 'All');
    assert.strictEqual(lastRow.getCell(5).value, 3.00);
  });

  it('should implement Round 3 workbook structure and data mapping', async () => {
    const data = {
      run_id: 'round3',
      project_no: '146/26',
      project_name: 'Nordic A-jaur',
      sources_detail: [
        { subproject: 'Phase A', source_type: 'IFC', file_name: 'model.ifc', used_for: 'Geometry', priority: 'Primary', notes: 'Main model' },
        { subproject: 'Phase B', type: 'Drawing', name: 'fire.pdf', used_for: 'Fire protection', priority: 'Secondary', notes: 'R60 notes' }
      ],
      transport_detail: {
        t1: [{ subproject: 'Phase A', category: 'Beams', assembly_no: 'A1', transport_class: 'Long load', length_m: 13, width_m: 1, height_m: 1, weight_t: 1.2, confidence: 'Confirmed', source: 'model.ifc', notes: 'Route check' }],
        t2: [{ subproject: 'Phase B', category: 'Stairs', assembly_profile: 'STR1', row_type: 'Profile', length_m: 5, width_m: 1, height_m: 2, weight_t: 0.5, transport_class: 'Gauge', confidence: 'Estimated', source: 'fire.pdf', notes: '' }]
      },
      open_questions: [
        { subproject: 'Phase B', category: 'Stairs', question: 'Confirm finish?', option_a: 'C3', option_b: 'C4', option_c: '', status: 'Answered' },
        { id: 'CUSTOM-1', subproject: 'Phase A', category: 'Beams', question: 'Confirm R60?', option_a: 'R30', option_b: 'R60', option_c: '', status: 'Open' }
      ],
      analysis_warnings: ['Missing owner choice for finish'],
      subprojects: [
        {
          name: 'Phase A',
          exec_class: 'EXC2',
          coating_summary: 'C3 per drawing',
          fire_summary: 'R60 required',
          transport_summary: 'Long loads present',
          fire_protection: 'R60',
          welding: 'EN 1090',
          gratings_steps: 'Excluded',
          notes: 'Phase note',
          totals: { weight_kg: 1500, paint_m2: 45 },
          categories: [{ name: 'Beams', coating: 'C3', fire_class: 'R60', exec_class: 'EXC2', weight_kg: 1500, paint_m2: 45, notes: 'Primary steel' }],
          profiles: [
            { profile: 'HEA200', category: 'Beams', steel_grade: 'S355', qty: 2, length_m: 12, weight_kg: 1000, paint_m2: 30, coating: 'C3', fire_class: 'R60', critical_temp_c: 550, am_v: 110, source: 'model.ifc' },
            { profile: 'HEA200', category: 'Beams', steel_grade: 'S355', qty: 1, length_m: 6, weight_kg: 500, paint_m2: 15, coating: 'C3', fire_class: 'R60', critical_temp_c: 550, am_v: 110, source: 'model.ifc' }
          ],
          source_rows: [
            { category: 'Beams', assembly_no: 'A1', part: 'P-01', profile: 'HEA200', steel_grade: 'S355', qty: 1, length_mm: 12000, weight_kg: 1000, paint_m2: 30, am: 110, coating: 'C3', fire_class: 'R60', critical_temp_c: 550, oversize: 'Y' }
          ],
          excluded_rows: [
            { category: 'Trusses', assembly_no: 'T1', part: 'FV1', profile: 'L50', steel_grade: 'S355', qty: 1, length_mm: 2000, weight_kg: 120, paint_m2: 6, exclusion_reason: 'Local procurement', source: 'model.ifc' }
          ]
        },
        {
          name: 'Phase B',
          exec_class: 'EXC3',
          coating_summary: 'C4 per spec',
          fire_summary: 'R30 stairs',
          transport_summary: 'Gauge transport',
          totals: { weight_kg: 800, paint_m2: 20 },
          categories: [{ name: 'Stairs / Stringers', coating: 'C4', fire_class: 'R30', exec_class: 'EXC3', weight_kg: 800, paint_m2: 20 }],
          profiles: [
            { profile: 'UPN160', category: 'Stairs / Stringers', steel_grade: 'S235', qty: 2, length_m: 10, weight_kg: 800, paint_m2: 20, coating: 'C4', fire_class: 'R30', critical_temp_c: 500, am_v: 90, source: 'fire.pdf' }
          ],
          source_rows: [
            { category: 'Stairs / Stringers', assembly_no: 'S1', part_no: 'OLD-02', profile: 'UPN160', steel_grade: 'S235', qty: 2, length_mm: 5000, weight_kg: 800, paint_m2: 20, coating: 'C4', fire_class: 'R30', critical_temp_c: 500, oversize: 'N' }
          ],
          excluded_rows: []
        }
      ]
    };

    const outputDir = path.join(tempDir, 'output');
    await generateWorkbooks(data, outputDir);

    const bom = new ExcelJS.Workbook();
    await bom.xlsx.readFile(path.join(outputDir, '146_26_Nordic A-jaur_BoM.xlsx'));
    assert.deepStrictEqual(bom.worksheets.map(s => s.name).slice(0, 2), ['BoM by Profile', 'BoM by Category']);
    const bomProfileSheet = bom.getWorksheet('BoM by Profile');
    const bomProfileRows = bomProfileSheet.getRows(4, 20)
      .filter(row => row.getCell(1).value && row.getCell(1).value !== 'Total');
    assert.ok(bomProfileRows.length > 0, 'BoM by Profile should include data rows');
    for (const row of bomProfileRows) {
      assert.strictEqual(row.getCell(6).value, null);
      assert.deepStrictEqual(row.getCell(7).value, { formula: `D${row.number}*F${row.number}` });
    }
    const bomTotalRow = bomProfileSheet.getRows(4, 10).find(row => row.getCell(1).value === 'Total');
    assert.deepStrictEqual(bomTotalRow.getCell(6).value, { formula: `G${bomTotalRow.number}/D${bomTotalRow.number}` });
    const bomCategoryRows = bom.getWorksheet('BoM by Category').getRows(4, 20)
      .filter(row => row.getCell(1).value && row.getCell(1).value !== 'Total');
    assert.ok(bomCategoryRows.length > 0, 'BoM by Category should include data rows');
    assert.deepStrictEqual(
      bomCategoryRows.map(row => row.getCell(1).value),
      ['Beams', 'Stairs']
    );

    const material = new ExcelJS.Workbook();
    await material.xlsx.readFile(path.join(outputDir, '146_26_Nordic A-jaur_MaterialList.xlsx'));
    assert.deepStrictEqual(material.worksheets.map(s => s.name), ['Phase A', 'Phase B', 'MaterialList Total', 'Excluded Detail']);
    assert.strictEqual(material.getWorksheet('Phase A').getRow(4).getCell(4).value, 'P-01');
    assert.strictEqual(material.getWorksheet('Phase B').getRow(4).getCell(4).value, 'OLD-02');
    assert.strictEqual(material.getWorksheet('Excluded Detail').actualRowCount, 2);

    const desc = new ExcelJS.Workbook();
    await desc.xlsx.readFile(path.join(outputDir, '146_26_Nordic A-jaur_Description.xlsx'));
    assert.deepStrictEqual(desc.worksheets.map(s => s.name), [
      'Project Summary',
      'ScopeClassification',
      'Exclusions',
      'Coating Summary',
      'Coating Detail',
      'Transport Detail',
      'Open Questions',
      'Sources'
    ]);
    assert.strictEqual(desc.getWorksheet('Project Summary').getRow(6).getCell(1).value, 'All');
    assert.deepStrictEqual(desc.getWorksheet('ScopeClassification').getRow(3).values.slice(1), ['Subproject', 'Category', 'Coating Class', 'Fire Class', 'Exec Class', 'Total Weight (t)', 'Total Paint Area (m2)', 'Notes']);
    assert.strictEqual(desc.getWorksheet('Sources').actualRowCount, data.sources_detail.length + 1);
    assert.strictEqual(desc.getWorksheet('Exclusions').actualRowCount, 2);
    assert.strictEqual(desc.getWorksheet('Open Questions').getRow(4).getCell(1).value, 'CUSTOM-1');
    assert.match(desc.getWorksheet('Open Questions').getRow(5).getCell(1).value, /^OQ-\d{3}$/);
    assert.strictEqual(desc.getWorksheet('Open Questions').getRow(3).getCell(9).value, 'Owner Decision');
    const transportRows = desc.getWorksheet('Transport Detail').getRows(1, 12);
    const table2Row = transportRows.find(row => row.getCell(1).value === 'Table 2');
    assert.strictEqual(desc.getWorksheet('Transport Detail').getRow(table2Row.number + 1).getCell(1).value, 'Subproject');

    for (const workbook of [bom, material, desc]) {
      for (const sheet of workbook.worksheets) {
        const headerRow = sheet.getRow(3);
        for (let c = 1; c <= headerRow.cellCount; c++) {
          const header = headerRow.getCell(c).value;
          if (header) assert.ok(sheet.getColumn(c).width >= Math.max(12, String(header).length + 2));
        }
      }
    }
  });

  it('should remove stale xlsx files after successful workbook generation', async () => {
    const runDir = path.join(tempDir, 'run');
    const sourcesDir = path.join(runDir, 'sources');
    const outputDir = path.join(runDir, 'output');
    fs.mkdirSync(sourcesDir, { recursive: true });
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(sourcesDir, 'source.txt'), 'steel source', 'utf8');
    fs.writeFileSync(path.join(outputDir, 'stale_BoM.xlsx'), 'old workbook', 'utf8');
    fs.writeFileSync(path.join(outputDir, 'stale.xlsx'), 'old non-matching workbook', 'utf8');
    fs.writeFileSync(path.join(outputDir, 'keep.txt'), 'keep', 'utf8');

    await dispatchGeminiAnalysis('run-1', runDir, sourcesDir, {
      spawn: () => ({
        stdout: JSON.stringify({
          project_name: 'Project',
          subprojects: [{ name: 'All', totals: { weight_kg: 0, paint_m2: 0 }, profiles: [] }]
        }),
        status: 0
      }),
      generate: async (_analysis, out) => {
        // Stale files are still present during generation
        const files = fs.readdirSync(out);
        assert.ok(files.includes('stale_BoM.xlsx'));
        assert.ok(files.includes('stale.xlsx'));
        assert.ok(files.includes('keep.txt'));
        fs.writeFileSync(path.join(out, 'fresh.xlsx'), 'new workbook', 'utf8');
      },
      generateDash: () => {},
      verify: () => ({ ok: true, errors: [], files: [] })
    });

    // Stale files matching the pattern are deleted afterwards
    const finalFiles = fs.readdirSync(outputDir);
    assert.strictEqual(finalFiles.includes('stale_BoM.xlsx'), false, 'stale_BoM.xlsx should be deleted');
    assert.ok(finalFiles.includes('stale.xlsx'), 'stale.xlsx should be kept (non-matching pattern)');
    assert.ok(finalFiles.includes('keep.txt'), 'keep.txt should be kept');
    assert.ok(finalFiles.includes('fresh.xlsx'), 'fresh.xlsx should be kept');
  });
});

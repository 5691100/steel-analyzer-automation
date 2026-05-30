import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runSelfChecklist, formatFailedItems } from '../src/self-checklist.mjs';

// ── helpers ─────────────────────────────────────────────────────────────────

function makeRunDir(baseDir, opts = {}) {
  const runDir = fs.mkdtempSync(path.join(baseDir, 'run-'));
  const outputDir = path.join(runDir, 'output');
  fs.mkdirSync(outputDir, { recursive: true });

  const {
    noAnalysis = false,
    invalidAnalysis = false,
    emptySubprojects = false,
    zeroWeight = false,
    noXlsx = false,
    noSources = false,
  } = opts;

  if (!noAnalysis) {
    const analysis = {
      subprojects: emptySubprojects ? [] : [{ name: 'SP1' }],
      totals: { weight_kg: zeroWeight ? 0 : 1500 },
      sources_detail: noSources ? [] : [{ file_name: 'source.ifc' }],
    };
    fs.writeFileSync(
      path.join(runDir, 'analysis.json'),
      invalidAnalysis ? '{ not valid json' : JSON.stringify(analysis)
    );
  }

  if (!noXlsx) {
    fs.writeFileSync(path.join(outputDir, 'project_Description.xlsx'), 'xlsx-placeholder');
  }

  return runDir;
}

/** A minimal ExcelJS mock whose workbook contains the given sheet names. */
function makeExcelMock(sheetNames, weightCell = 1500) {
  return {
    Workbook: class {
      constructor() {
        this.xlsx = { readFile: async (_p) => {} };
      }
      getWorksheet(name) {
        if (!sheetNames.includes(name)) return null;
        if (name === 'Project Summary') {
          return {
            eachRow(cb) {
              // Simulate single "All" row: col1='All', col5=weightCell
              cb({ getCell: (n) => ({ value: n === 1 ? 'All' : n === 5 ? weightCell : null }) }, 2);
            },
            getColumn: () => ({
              eachCell: (opts, cb) => {
                cb({ value: weightCell, type: 2 }, 2);
              },
            }),
          };
        }
        return {};
      }
      get worksheets() {
        return sheetNames.map(n => ({ name: n }));
      }
    },
  };
}

/** ExcelJS mock that throws on readFile. */
function makeExcelThrowMock() {
  return {
    Workbook: class {
      constructor() {
        this.xlsx = {
          readFile: async () => { throw new Error('XLSX read error'); }
        };
      }
    },
  };
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('self-checklist', () => {
  let baseDir;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'steel-checklist-'));
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  // 1. all checks pass
  it('returns passed=true when all checks are OK', async () => {
    const { DESCRIPTION_SHEETS } = await import('../src/template-config.mjs');
    const runDir = makeRunDir(baseDir);
    // analysis.json has weight_kg=1500; workbook stores tonnes → 1.5t * 1000 = 1500 kg
    const result = await runSelfChecklist(runDir, { ExcelJS: makeExcelMock(DESCRIPTION_SHEETS, 1.5) });

    assert.strictEqual(result.passed, true);
    assert.ok(Array.isArray(result.items));
    assert.ok(result.items.length >= 7, `expected ≥7 items, got ${result.items.length}`);
    result.items.forEach(item => {
      assert.ok(['pass', 'warning'].includes(item.verdict),
        `item ${item.id} should not fail: ${item.verdict} — ${item.detail}`);
    });

    // self-checklist.json must be written
    const written = JSON.parse(fs.readFileSync(path.join(runDir, 'self-checklist.json'), 'utf8'));
    assert.strictEqual(written.schema, 'steel.self-checklist.v1');
    assert.strictEqual(written.passed, true);
  });

  // 2. analysis.json missing
  it('fails analysis-exists when analysis.json is absent', async () => {
    const runDir = makeRunDir(baseDir, { noAnalysis: true });
    const result = await runSelfChecklist(runDir, { ExcelJS: makeExcelThrowMock() });

    assert.strictEqual(result.passed, false);
    const item = result.items.find(i => i.id === 'analysis-exists');
    assert.ok(item, 'analysis-exists item missing');
    assert.strictEqual(item.verdict, 'fail');
  });

  // 3. subprojects empty
  it('fails subprojects-nonempty when subprojects array is empty', async () => {
    const runDir = makeRunDir(baseDir, { emptySubprojects: true });
    const result = await runSelfChecklist(runDir, { ExcelJS: makeExcelThrowMock() });

    assert.strictEqual(result.passed, false);
    const item = result.items.find(i => i.id === 'subprojects-nonempty');
    assert.ok(item, 'subprojects-nonempty item missing');
    assert.strictEqual(item.verdict, 'fail');
  });

  // 4. totals.weight_kg = 0
  it('fails totals-positive when weight_kg is 0', async () => {
    const runDir = makeRunDir(baseDir, { zeroWeight: true });
    const result = await runSelfChecklist(runDir, { ExcelJS: makeExcelThrowMock() });

    assert.strictEqual(result.passed, false);
    const item = result.items.find(i => i.id === 'totals-positive');
    assert.ok(item, 'totals-positive item missing');
    assert.strictEqual(item.verdict, 'fail');
  });

  // 5. no xlsx in output/
  it('fails xlsx-exists when no xlsx files in output/', async () => {
    const runDir = makeRunDir(baseDir, { noXlsx: true });
    const result = await runSelfChecklist(runDir, { ExcelJS: makeExcelThrowMock() });

    assert.strictEqual(result.passed, false);
    const item = result.items.find(i => i.id === 'xlsx-exists');
    assert.ok(item, 'xlsx-exists item missing');
    assert.strictEqual(item.verdict, 'fail');
  });

  // 5b. totals-match passes when ExcelJS uses workbook.xlsx.readFile API (correct API shape)
  it('totals-match passes when ExcelJS mock uses workbook.xlsx.readFile API', async () => {
    const { DESCRIPTION_SHEETS } = await import('../src/template-config.mjs');
    const runDir = makeRunDir(baseDir); // weight_kg = 1500 in analysis.json
    // weightCell = 1.5 (tonnes) → 1.5 * 1000 = 1500 kg = analysis weight_kg
    const result = await runSelfChecklist(runDir, { ExcelJS: makeExcelMock(DESCRIPTION_SHEETS, 1.5) });

    const item = result.items.find(i => i.id === 'totals-match');
    assert.ok(item, 'totals-match item missing');
    assert.strictEqual(item.verdict, 'pass',
      `Expected totals-match to pass with correct ExcelJS API, got: ${item.verdict} — ${item.detail}`);
  });

  // 6. totals-match warning when ExcelJS throws
  it('gives warning for totals-match when ExcelJS throws', async () => {
    const runDir = makeRunDir(baseDir);
    const result = await runSelfChecklist(runDir, { ExcelJS: makeExcelThrowMock() });

    const item = result.items.find(i => i.id === 'totals-match');
    assert.ok(item, 'totals-match item missing');
    assert.strictEqual(item.verdict, 'warning');
  });

  // 7. sources warning when both provenance and sources_detail are empty
  it('gives warning for sources-present when sources_detail is empty and no provenance', async () => {
    const { DESCRIPTION_SHEETS } = await import('../src/template-config.mjs');
    const runDir = makeRunDir(baseDir, { noSources: true });
    const result = await runSelfChecklist(runDir, { ExcelJS: makeExcelMock(DESCRIPTION_SHEETS) });

    const item = result.items.find(i => i.id === 'sources-present');
    assert.ok(item, 'sources-present item missing');
    assert.strictEqual(item.verdict, 'warning');
  });

  // 8. analysis.json invalid JSON
  it('fails analysis-exists when analysis.json contains invalid JSON', async () => {
    const runDir = makeRunDir(baseDir, { invalidAnalysis: true });
    const result = await runSelfChecklist(runDir, { ExcelJS: makeExcelThrowMock() });

    assert.strictEqual(result.passed, false);
    const item = result.items.find(i => i.id === 'analysis-exists');
    assert.ok(item, 'analysis-exists item missing');
    assert.strictEqual(item.verdict, 'fail');
  });
});

describe('formatFailedItems', () => {
  it('returns bullet list of only fail-verdict items', () => {
    const items = [
      { id: 'a', verdict: 'pass', detail: 'ok' },
      { id: 'b', verdict: 'fail', detail: 'missing file' },
      { id: 'c', verdict: 'warning', detail: 'cannot verify' },
      { id: 'd', verdict: 'fail', detail: 'zero weight' },
    ];
    const result = formatFailedItems(items);
    assert.strictEqual(result, '• b: missing file\n• d: zero weight');
  });
});

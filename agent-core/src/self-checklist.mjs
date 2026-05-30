import fs from 'node:fs';
import path from 'node:path';
import ExcelJSDefault from 'exceljs';
import { DESCRIPTION_SHEETS } from './template-config.mjs';

/**
 * @typedef {{ id: string, description: string, verdict: 'pass'|'fail'|'warning', detail: string }} ChecklistItem
 * @typedef {{ passed: boolean, items: ChecklistItem[] }} ChecklistResult
 */

/**
 * Run the 7-point self-checklist for a completed steel analysis run.
 *
 * @param {string} runDir - Absolute path to the run directory.
 * @param {{ ExcelJS?: object }} [deps] - Optional dependency injection (for testing).
 * @returns {Promise<ChecklistResult>}
 */
export async function runSelfChecklist(runDir, deps = {}) {
  const ExcelJS = deps.ExcelJS ?? ExcelJSDefault;
  const items = [];

  // ── 1. analysis-exists ────────────────────────────────────────────────────
  let analysis = null;
  {
    const analysisPath = path.join(runDir, 'analysis.json');
    if (!fs.existsSync(analysisPath)) {
      items.push({
        id: 'analysis-exists',
        description: 'analysis.json is present and parseable',
        verdict: 'fail',
        detail: 'analysis.json not found',
      });
    } else {
      try {
        analysis = JSON.parse(fs.readFileSync(analysisPath, 'utf8'));
        items.push({
          id: 'analysis-exists',
          description: 'analysis.json is present and parseable',
          verdict: 'pass',
          detail: 'analysis.json found and parsed',
        });
      } catch (err) {
        items.push({
          id: 'analysis-exists',
          description: 'analysis.json is present and parseable',
          verdict: 'fail',
          detail: `analysis.json parse error: ${err.message}`,
        });
      }
    }
  }

  // ── 2. subprojects-nonempty ───────────────────────────────────────────────
  {
    const ok = analysis && Array.isArray(analysis.subprojects) && analysis.subprojects.length > 0;
    items.push({
      id: 'subprojects-nonempty',
      description: 'analysis.subprojects is a non-empty array',
      verdict: ok ? 'pass' : 'fail',
      detail: ok
        ? `${analysis.subprojects.length} subproject(s) found`
        : 'subprojects is missing or empty',
    });
  }

  // ── 3. totals-positive ────────────────────────────────────────────────────
  {
    // Fall back to summing subproject totals if top-level totals is missing
    const topWeight = analysis?.totals?.weight_kg;
    const weight = (typeof topWeight === 'number' && topWeight > 0)
      ? topWeight
      : (analysis?.subprojects ?? []).reduce((sum, s) => sum + (s?.totals?.weight_kg ?? 0), 0) || undefined;
    const ok = typeof weight === 'number' && weight > 0;
    items.push({
      id: 'totals-positive',
      description: 'analysis.totals.weight_kg > 0',
      verdict: ok ? 'pass' : 'fail',
      detail: ok ? `weight_kg = ${weight}` : `weight_kg = ${weight ?? 'undefined'}`,
    });
  }

  // ── 4. xlsx-exists ────────────────────────────────────────────────────────
  const outputDir = path.join(runDir, 'output');
  let xlsxFiles = [];
  {
    let found = false;
    if (fs.existsSync(outputDir)) {
      xlsxFiles = fs.readdirSync(outputDir).filter(f => f.endsWith('.xlsx'));
      found = xlsxFiles.length > 0;
    }
    items.push({
      id: 'xlsx-exists',
      description: 'At least one .xlsx file exists in output/',
      verdict: found ? 'pass' : 'fail',
      detail: found ? `${xlsxFiles.length} xlsx file(s) found` : 'No .xlsx files in output/',
    });
  }

  // ── 5 & 6. ExcelJS-based checks ───────────────────────────────────────────
  if (xlsxFiles.length > 0) {
    const descFile = xlsxFiles.find(f => /_Description(_v\d+)?\.xlsx$/i.test(f));
    const firstXlsx = path.join(outputDir, descFile ?? xlsxFiles[0]);
    let wb = null;
    let xlsxError = null;

    try {
      wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(firstXlsx);
    } catch (err) {
      xlsxError = err.message;
      wb = null;
    }

    // 5. totals-match
    if (wb === null) {
      items.push({
        id: 'totals-match',
        description: 'XLSX Project Summary weight matches analysis.totals.weight_kg (±0.1%)',
        verdict: 'warning',
        detail: `Cannot open XLSX: ${xlsxError}`,
      });
    } else {
      try {
        const sheet = wb.getWorksheet('Project Summary');
        // Column 5 = "Total Weight (t)". For multi-subproject sheets the total is
        // on the "All" row (col 1 = "All"). Fall back to first numeric if not found.
        let xlsxWeightT = null;
        if (sheet) {
          sheet.eachRow((row) => {
            const label = row.getCell(1).value;
            const val = row.getCell(5).value;
            if (typeof val === 'number') {
              if (String(label).trim() === 'All') {
                xlsxWeightT = val; // authoritative — stop searching
              } else if (xlsxWeightT === null) {
                xlsxWeightT = val; // fallback if no "All" row found
              }
            }
          });
        }
        const analysisWeight = analysis?.totals?.weight_kg;
        if (xlsxWeightT === null || analysisWeight == null) {
          items.push({
            id: 'totals-match',
            description: 'XLSX Project Summary weight matches analysis.totals.weight_kg (±0.1%)',
            verdict: 'warning',
            detail: `Could not read weight from sheet (xlsxWeightT=${xlsxWeightT}, analysisWeight=${analysisWeight})`,
          });
        } else {
          const xlsxWeightKg = xlsxWeightT * 1000;
          const tolerance = Math.abs(analysisWeight) * 0.001;
          const diff = Math.abs(xlsxWeightKg - analysisWeight);
          const ok = diff <= tolerance;
          items.push({
            id: 'totals-match',
            description: 'XLSX Project Summary weight matches analysis.totals.weight_kg (±0.1%)',
            verdict: ok ? 'pass' : 'fail',
            detail: ok
              ? `XLSX ${xlsxWeightT}t (${xlsxWeightKg}kg) ≈ analysis ${analysisWeight}kg`
              : `XLSX ${xlsxWeightT}t (${xlsxWeightKg}kg) vs analysis ${analysisWeight}kg (diff=${diff.toFixed(3)})`,
          });
        }
      } catch (err) {
        items.push({
          id: 'totals-match',
          description: 'XLSX Project Summary weight matches analysis.totals.weight_kg (±0.1%)',
          verdict: 'warning',
          detail: `Error reading weight column: ${err.message}`,
        });
      }
    }

    // 6. required-sheets
    if (wb === null) {
      items.push({
        id: 'required-sheets',
        description: `All DESCRIPTION_SHEETS present in XLSX`,
        verdict: 'warning',
        detail: `Cannot open XLSX: ${xlsxError}`,
      });
    } else {
      try {
        const presentNames = wb.worksheets.map(s => s.name);
        const missing = DESCRIPTION_SHEETS.filter(n => !presentNames.includes(n));
        items.push({
          id: 'required-sheets',
          description: `All DESCRIPTION_SHEETS present in XLSX`,
          verdict: missing.length === 0 ? 'pass' : 'fail',
          detail: missing.length === 0
            ? `All ${DESCRIPTION_SHEETS.length} required sheets found`
            : `Missing sheets: ${missing.join(', ')}`,
        });
      } catch (err) {
        items.push({
          id: 'required-sheets',
          description: `All DESCRIPTION_SHEETS present in XLSX`,
          verdict: 'warning',
          detail: `Error reading worksheets: ${err.message}`,
        });
      }
    }
  } else {
    // No xlsx — both ExcelJS checks become warnings (cannot open what doesn't exist)
    items.push({
      id: 'totals-match',
      description: 'XLSX Project Summary weight matches analysis.totals.weight_kg (±0.1%)',
      verdict: 'warning',
      detail: 'No XLSX file to open',
    });
    items.push({
      id: 'required-sheets',
      description: `All DESCRIPTION_SHEETS present in XLSX`,
      verdict: 'warning',
      detail: 'No XLSX file to open',
    });
  }

  // ── 7. sources-present ────────────────────────────────────────────────────
  {
    const hasProvenance = analysis?.provenance && Object.keys(analysis.provenance).length > 0;
    const hasSourcesDetail = Array.isArray(analysis?.sources_detail) && analysis.sources_detail.length > 0;
    const ok = hasProvenance || hasSourcesDetail;
    items.push({
      id: 'sources-present',
      description: 'analysis.provenance or analysis.sources_detail is non-empty',
      verdict: ok ? 'pass' : 'warning',
      detail: ok ? 'Sources found' : 'No provenance or sources_detail found',
    });
  }

  const passed = items.every(i => i.verdict !== 'fail');

  const result = { passed, items };

  fs.writeFileSync(
    path.join(runDir, 'self-checklist.json'),
    JSON.stringify({
      schema: 'steel.self-checklist.v1',
      ...result,
      generated_at: new Date().toISOString(),
    })
  );

  return result;
}

/**
 * Format failed checklist items as a bullet list string.
 *
 * @param {ChecklistItem[]} items
 * @returns {string}
 */
export function formatFailedItems(items) {
  return items
    .filter(i => i.verdict === 'fail')
    .map(i => `• ${i.id}: ${i.detail}`)
    .join('\n');
}

import ExcelJS from 'exceljs';
import path from 'path';
import fs_ from 'fs';
import {
  WORKBOOK_STYLE,
  DESCRIPTION_SHEETS,
  BOM_COLUMNS,
  BOM_CAT_COLUMNS,
  MATERIAL_LIST_COLUMNS,
  EXCLUDED_DETAIL_COLUMNS,
  SUMMARY_COLUMNS,
  TRANSPORT_DETAIL_T1_COLUMNS,
  TRANSPORT_DETAIL_T2_COLUMNS,
  OPEN_QUESTIONS_COLUMNS,
  SOURCES_COLUMNS,
  CATEGORY_ORDER
} from './template-config.mjs';

function sanitizeSheetName(name) {
  if (!name) return 'Sheet';
  let sanitized = name.replace(/[\\/:*?[\]]/g, '');
  return sanitized.substring(0, 31).trim();
}

function addWorksheetSafe(workbook, name) {
  let safeName = sanitizeSheetName(name);
  let counter = 1;
  while (workbook.getWorksheet(safeName)) {
    let suffix = ' (' + counter + ')';
    let base = sanitizeSheetName(name);
    safeName = base.substring(0, 31 - suffix.length) + suffix;
    counter++;
  }
  return workbook.addWorksheet(safeName);
}

function sanitizeFilename(name) {
  if (!name) return 'unnamed';
  return name.replace(/[/\:*?"<>|]/g, '_');
}

function validateInput(data) {
  if (!data.subprojects || !Array.isArray(data.subprojects) || data.subprojects.length === 0) {
    throw new Error('Invalid input: subprojects is required and must not be empty');
  }
}

async function getNextVersionSuffix(outputDir, basePrefix, existingFiles = []) {
  let version = 1;
  while (true) {
    const s = version === 1 ? '' : '_v' + version;
    const exists = (f) => (existingFiles || []).includes(f) || fs_.existsSync(path.join(outputDir, f));
    const bomExists = exists(basePrefix + '_BoM' + s + '.xlsx');
    const mlExists = exists(basePrefix + '_MaterialList' + s + '.xlsx');
    const descExists = exists(basePrefix + '_Description' + s + '.xlsx');
    if (!bomExists && !mlExists && !descExists) return s;
    version++;
    if (version > 50) break;
  }
  return '';
}

function applyTableStyle(sheet, startRow, endRow, colCount) {
  if (startRow > endRow) return;
  for (let r = startRow; r <= endRow; r++) {
    const row = sheet.getRow(r);
    for (let c = 1; c <= colCount; c++) {
      const cell = row.getCell(c);
      cell.border = WORKBOOK_STYLE.border;
      cell.font = WORKBOOK_STYLE.font;
      if (r === startRow) {
        cell.fill = WORKBOOK_STYLE.headerFill;
        cell.font = WORKBOOK_STYLE.headerFont;
      }
    }
  }
  sheet.views = [{ state: 'frozen', ySplit: startRow }];
}

export async function generateWorkbooks(data, outputDir, options = {}) {
  validateInput(data);
  if (!fs_.existsSync(outputDir)) fs_.mkdirSync(outputDir, { recursive: true });
  const projectNo = sanitizeFilename(data.project_no || 'UNKNOWN');
  const projectName = sanitizeFilename(data.project_name || 'Project');
  const basePrefix = projectNo + '_' + projectName;
  let versionSuffix = data.version_suffix ?? await getNextVersionSuffix(outputDir, basePrefix, options.existingFiles);
  data.version_string = versionSuffix ? versionSuffix.replace(/^_/, '') : 'v1';
  data.generated_at = new Date();
  await generateBoM(data, path.join(outputDir, basePrefix + '_BoM' + versionSuffix + '.xlsx'));
  await generateMaterialList(data, path.join(outputDir, basePrefix + '_MaterialList' + versionSuffix + '.xlsx'));
  await generateDescription(data, path.join(outputDir, basePrefix + '_Description' + versionSuffix + '.xlsx'));
}

async function generateBoM(data, filePath) {
  const workbook = new ExcelJS.Workbook();
  const sheet = addWorksheetSafe(workbook, 'BoM by Profile');
  sheet.getRow(3).values = [null, ...BOM_COLUMNS];
  let rowIdx = 4;
  data.subprojects.flatMap(sp => sp.profiles || []).forEach(p => {
    const row = sheet.getRow(rowIdx++);
    row.values = [null, p.profile, p.steel_grade || 'Undefined', p.length_m || 0, (p.weight_kg || 0) / 1000, p.paint_m2 || 0];
  });
  applyTableStyle(sheet, 3, rowIdx - 1, BOM_COLUMNS.length);
  await workbook.xlsx.writeFile(filePath);
}

async function generateMaterialList(data, filePath) {
  const workbook = new ExcelJS.Workbook();
  data.subprojects.forEach(sp => {
    const sheet = addWorksheetSafe(workbook, sp.name);
    sheet.getRow(3).values = [null, ...MATERIAL_LIST_COLUMNS];
    let rowIdx = 4;
    (sp.source_rows || []).forEach(sr => {
      const row = sheet.getRow(rowIdx++);
      row.values = [null, sp.name, sr.category, sr.assembly_no, sr.part_no, sr.profile, sr.steel_grade, sr.qty, sr.length_mm, sr.weight_kg, sr.paint_m2, sr.am, sr.coating, sr.fire_class, sr.critical_temp_c, sr.oversize];
    });
    applyTableStyle(sheet, 3, rowIdx - 1, MATERIAL_LIST_COLUMNS.length);
  });
  await workbook.xlsx.writeFile(filePath);
}

async function generateDescription(data, filePath) {
  const workbook = new ExcelJS.Workbook();
  const summarySheet = addWorksheetSafe(workbook, 'Project Summary');
  summarySheet.getRow(3).values = [null, ...SUMMARY_COLUMNS];
  let sumRowIdx = 4;
  let totalW = 0;
  data.subprojects.forEach(sp => {
    const w = (sp.totals?.weight_kg || 0) / 1000;
    totalW += w;
    summarySheet.getRow(sumRowIdx++).values = [null, sp.name, data.project_no, data.project_name, sp.exec_class, w, sp.totals?.paint_m2, sp.coating, sp.fire_protection, sp.welding, sp.gratings_steps, sp.transport, sp.exclusions_summary, sp.notes];
  });
  if (data.subprojects.length > 1) {
    summarySheet.getRow(sumRowIdx).values = [null, 'All', data.project_no, data.project_name, null, totalW];
    sumRowIdx++;
  }
  applyTableStyle(summarySheet, 3, sumRowIdx - 1, SUMMARY_COLUMNS.length);

  // Scope / Classification
  const scopeSheet = addWorksheetSafe(workbook, 'Scope / Classification');
  scopeSheet.getRow(3).values = [null, 'Subproject', 'Category', 'Exec Class', 'Source', 'Notes'];
  let scopeRowIdx = 4;
  data.subprojects.forEach(sp => {
    const categories = Array.from(new Set((sp.profiles || []).map(p => p.category))).filter(Boolean);
    categories.forEach(cat => {
      scopeSheet.getRow(scopeRowIdx++).values = [null, sp.name, cat, sp.exec_class || '', '', ''];
    });
  });
  applyTableStyle(scopeSheet, 3, scopeRowIdx - 1, 5);

  // Exclusions
  const exclSheet = addWorksheetSafe(workbook, 'Exclusions');
  exclSheet.getRow(3).values = [null, ...EXCLUDED_DETAIL_COLUMNS];
  let exclRowIdx = 4;
  data.subprojects.forEach(sp => {
    (sp.excluded_rows || []).forEach(row => {
      exclSheet.getRow(exclRowIdx++).values = [
        null, sp.name, row.category, row.assembly_no, row.part_no, row.profile, row.steel_grade,
        row.qty, row.length_mm, row.weight_kg, row.paint_m2, row.am, row.coating,
        row.fire_class, row.critical_temp_c, row.oversize, row.exclusion_reason || '', row.source || ''
      ];
    });
  });
  applyTableStyle(exclSheet, 3, exclRowIdx - 1, EXCLUDED_DETAIL_COLUMNS.length);

  // Coating / Fire Evidence
  const coatSheet = addWorksheetSafe(workbook, 'Coating / Fire Evidence');
  coatSheet.getRow(3).values = [null, 'Subproject', 'Profile', 'Category', 'Fire Class', 'Critical Temp (°C)', 'Coating System', 'Am/V', 'Paint m²', 'Source'];
  let coatRowIdx = 4;
  data.subprojects.flatMap(sp => (sp.profiles || []).map(p => ({ ...p, spName: sp.name }))).forEach(p => {
    coatSheet.getRow(coatRowIdx++).values = [
      null, p.spName, p.profile || p.name, p.category || '', p.fire_class || '', p.critical_temp_c ?? '',
      p.coating || '', p.am_v ?? '', p.paint_m2 || 0, p.source || ''
    ];
  });
  applyTableStyle(coatSheet, 3, coatRowIdx - 1, 9);

  // Transport Detail
  const transSheet = addWorksheetSafe(workbook, 'Transport Detail');
  transSheet.getRow(3).values = [null, ...TRANSPORT_DETAIL_T1_COLUMNS];
  let transRowIdx = 4;
  (data.transport_detail?.t1 || []).forEach(row => {
    transSheet.getRow(transRowIdx++).values = [
      null, row.subproject, row.category, row.assembly_no, row.transport_class, row.length_m,
      row.width_m, row.height_m, row.weight_t, row.confidence, row.source, row.notes
    ];
  });
  applyTableStyle(transSheet, 3, transRowIdx - 1, TRANSPORT_DETAIL_T1_COLUMNS.length);

  const t1End = transRowIdx - 1;
  transRowIdx += 2;
  const t2Start = transRowIdx;
  transSheet.getRow(transRowIdx++).values = [null, ...TRANSPORT_DETAIL_T2_COLUMNS];
  (data.transport_detail?.t2 || []).forEach(row => {
    transSheet.getRow(transRowIdx++).values = [
      null, row.subproject, row.category, row.assembly_profile, row.row_type, row.length_m,
      row.width_m, row.height_m, row.weight_t, row.transport_class, row.confidence, row.source, row.notes
    ];
  });
  applyTableStyle(transSheet, t2Start, transRowIdx - 1, TRANSPORT_DETAIL_T2_COLUMNS.length);

  // Open Questions
  const oqSheet = addWorksheetSafe(workbook, 'Open Questions');
  oqSheet.getRow(3).values = [null, ...OPEN_QUESTIONS_COLUMNS];
  let oqRowIdx = 4;
  (data.open_questions || []).forEach(q => {
    oqSheet.getRow(oqRowIdx++).values = [
      null, q.id || '', q.subproject || '', q.category || '', q.question || '',
      q.option_a || '', q.option_b || '', q.option_c || '', q.status || 'Open'
    ];
  });
  applyTableStyle(oqSheet, 3, oqRowIdx - 1, OPEN_QUESTIONS_COLUMNS.length);

  // Sources
  const srcSheet = addWorksheetSafe(workbook, 'Sources');
  srcSheet.getRow(3).values = [null, ...SOURCES_COLUMNS];
  let srcRowIdx = 4;
  (data.sources || []).forEach(s => {
    srcSheet.getRow(srcRowIdx++).values = [
      null, s.subproject || '', s.source_type || '', s.file_name || '', s.used_for || '',
      s.priority || '', s.notes || ''
    ];
  });
  applyTableStyle(srcSheet, 3, srcRowIdx - 1, SOURCES_COLUMNS.length);

  await workbook.xlsx.writeFile(filePath);
}

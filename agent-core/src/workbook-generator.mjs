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
  return name.replace(/[\\/:*?"<>|]/g, '_');
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
    if (version > 50) {
      throw new Error('Too many versions (>50) for this run — check for stuck retry loop');
    }
  }
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

const DESCRIPTION_SHEET_NAMES = [
  'Project Summary',
  'Scope/Classification',
  'Exclusions',
  'Coating/Fire Evidence',
  'Transport Detail',
  'Open Questions',
  'Sources'
];

const SCOPE_CLASSIFICATION_COLUMNS = [
  'Subproject',
  'Category',
  'Coating Class',
  'Fire Class',
  'Exec Class',
  'Total Weight (t)',
  'Total Paint Area (m2)',
  'Notes'
];

const OPEN_QUESTIONS_WITH_DECISION_COLUMNS = [
  ...OPEN_QUESTIONS_COLUMNS,
  'Owner Decision'
];

const CATEGORY_ALIASES = new Map([
  ['Stairs / Stringers', 'Stairs'],
  ['Outside structures', 'Outside']
]);

const CATEGORY_OUTPUT_ORDER = CATEGORY_ORDER.map(cat => CATEGORY_ALIASES.get(cat) || cat);

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function profileWeightT(profile) {
  const tonnes = firstFiniteNumber(profile.total_weight_t, profile.weight_t);
  if (tonnes !== null) return tonnes;
  return num(firstFiniteNumber(profile.total_weight_kg, profile.weight_kg)) / 1000;
}

function setHeaders(sheet, rowNumber, headers) {
  const row = sheet.getRow(rowNumber);
  row.values = headers;
  headers.forEach((header, idx) => {
    const column = sheet.getColumn(idx + 1);
    column.width = Math.max(column.width || 0, 12, String(header).length + 2);
  });
}

function updateWidthsFromRow(sheet, rowNumber, colCount) {
  const row = sheet.getRow(rowNumber);
  for (let c = 1; c <= colCount; c++) {
    const value = row.getCell(c).value;
    if (!value) continue;
    const header = typeof value === 'object' ? value.text || value.result || '' : value;
    sheet.getColumn(c).width = Math.max(sheet.getColumn(c).width || 0, 12, String(header).length + 2);
  }
}

function categoryName(value) {
  const raw = String(value || 'Unclassified').trim() || 'Unclassified';
  return CATEGORY_ALIASES.get(raw) || raw;
}

function categorySortIndex(value) {
  const idx = CATEGORY_OUTPUT_ORDER.indexOf(categoryName(value));
  return idx === -1 ? CATEGORY_OUTPUT_ORDER.indexOf('Unclassified') : idx;
}

function rowPart(row) {
  return row?.part || row?.part_no || '';
}

function sourceRows(data) {
  if (Array.isArray(data.sources_detail) && data.sources_detail.length > 0) {
    return data.sources_detail.map(normalizeSource);
  }
  return (data.sources || []).map(normalizeSource);
}

function normalizeSource(source) {
  if (typeof source === 'string') {
    return {
      subproject: '',
      source_type: '',
      file_name: source,
      used_for: '',
      priority: '',
      notes: ''
    };
  }
  return {
    subproject: source?.subproject || '',
    source_type: source?.source_type || source?.type || '',
    file_name: source?.file_name || source?.name || '',
    used_for: source?.used_for || '',
    priority: source?.priority || '',
    notes: source?.notes || ''
  };
}

function excludedRowsForSubproject(data, sp) {
  if (Array.isArray(sp.excluded_rows) && sp.excluded_rows.length > 0) {
    return sp.excluded_rows;
  }
  return (data.excluded || [])
    .filter(row => !row.subproject || row.subproject === sp.name)
    .map(row => ({
      ...row,
      category: row.category || row.scope || '',
      exclusion_reason: row.exclusion_reason || row.reason || ''
    }));
}

function allExcludedRows(data) {
  return data.subprojects.flatMap(sp => excludedRowsForSubproject(data, sp).map(row => ({ ...row, subproject: sp.name })));
}

function sourceRowValues(spName, row) {
  return [
    spName,
    row.category || '',
    row.assembly_no || '',
    rowPart(row),
    row.profile || '',
    row.steel_grade || '',
    row.qty ?? '',
    row.length_mm ?? '',
    row.weight_kg ?? '',
    row.paint_m2 ?? '',
    row.am ?? row.am_v ?? '',
    row.coating || '',
    row.fire_class || '',
    row.critical_temp_c ?? '',
    row.oversize || ''
  ];
}

function excludedRowValues(row) {
  return [
    row.subproject || '',
    row.category || row.scope || '',
    row.assembly_no || '',
    rowPart(row),
    row.profile || '',
    row.steel_grade || '',
    row.qty ?? '',
    row.length_mm ?? '',
    row.weight_kg ?? row.assembly_weight_kg ?? '',
    row.paint_m2 ?? row.assembly_paint_m2 ?? '',
    row.am ?? row.am_v ?? '',
    row.coating || '',
    row.fire_class || '',
    row.critical_temp_c ?? '',
    row.oversize || '',
    row.exclusion_reason || row.reason || '',
    row.source || ''
  ];
}

function addMaterialTotalRow(sheet, rowIdx, firstLabel = 'Total') {
  sheet.getRow(rowIdx).values = [
    firstLabel,
    '',
    '',
    '',
    '',
    '',
    { formula: `SUM(G4:G${rowIdx - 1})` },
    '',
    { formula: `SUM(I4:I${rowIdx - 1})` },
    { formula: `SUM(J4:J${rowIdx - 1})` },
    '',
    '',
    '',
    '',
    ''
  ];
  return rowIdx + 1;
}

function aggregateProfiles(data, includeCategory = false) {
  const groups = new Map();
  data.subprojects.forEach(sp => {
    (sp.profiles || []).forEach(p => {
      const category = categoryName(p.category);
      const key = [
        includeCategory ? category : '',
        p.profile || p.name || '',
        p.steel_grade || 'Undefined'
      ].join('\u0001');
      const current = groups.get(key) || {
        category,
        profile: p.profile || p.name || '',
        steel_grade: p.steel_grade || 'Undefined',
        length_m: 0,
        weight_t: 0,
        paint_m2: 0
      };
      current.length_m += num(firstFiniteNumber(p.total_length_m, p.total_length, p.length_m));
      current.weight_t += profileWeightT(p);
      current.paint_m2 += num(firstFiniteNumber(p.total_paint_area_m2, p.paint_area_m2, p.paint_m2));
      groups.set(key, current);
    });
  });
  return Array.from(groups.values()).sort((a, b) => (
    includeCategory
      ? categorySortIndex(a.category) - categorySortIndex(b.category)
        || a.category.localeCompare(b.category)
      : 0
  ) || a.profile.localeCompare(b.profile) || a.steel_grade.localeCompare(b.steel_grade));
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
  setHeaders(sheet, 3, BOM_COLUMNS);
  let rowIdx = 4;
  const profileRows = aggregateProfiles(data);
  profileRows.forEach(p => {
    const row = sheet.getRow(rowIdx++);
    row.values = [p.profile, p.steel_grade, p.length_m, p.weight_t, p.paint_m2, null, { formula: `D${row.number}*F${row.number}` }];
  });
  if (profileRows.length > 0) {
    const totalRow = sheet.getRow(rowIdx++);
    totalRow.values = [
      'Total',
      '',
      { formula: `SUM(C4:C${rowIdx - 2})` },
      { formula: `SUM(D4:D${rowIdx - 2})` },
      { formula: `SUM(E4:E${rowIdx - 2})` },
      { formula: `G${rowIdx - 1}/D${rowIdx - 1}` },
      { formula: `SUM(G4:G${rowIdx - 2})` }
    ];
    totalRow.eachCell(cell => { cell.fill = WORKBOOK_STYLE.totalFill; });
  }
  applyTableStyle(sheet, 3, rowIdx - 1, BOM_COLUMNS.length);

  const catSheet = addWorksheetSafe(workbook, 'BoM by Category');
  setHeaders(catSheet, 3, BOM_CAT_COLUMNS);
  let catRowIdx = 4;
  aggregateProfiles(data, true).forEach(p => {
    catSheet.getRow(catRowIdx++).values = [p.category, p.profile, p.steel_grade, p.length_m, p.weight_t, p.paint_m2];
  });
  applyTableStyle(catSheet, 3, catRowIdx - 1, BOM_CAT_COLUMNS.length);
  await workbook.xlsx.writeFile(filePath);
}

async function generateMaterialList(data, filePath) {
  const workbook = new ExcelJS.Workbook();
  const allRows = [];
  data.subprojects.forEach(sp => {
    const sheet = addWorksheetSafe(workbook, sp.name);
    setHeaders(sheet, 3, MATERIAL_LIST_COLUMNS);
    let rowIdx = 4;
    (sp.source_rows || []).forEach(sr => {
      const row = sheet.getRow(rowIdx++);
      row.values = sourceRowValues(sp.name, sr);
      allRows.push({ spName: sp.name, row: sr });
    });
    rowIdx = addMaterialTotalRow(sheet, rowIdx);
    applyTableStyle(sheet, 3, rowIdx - 1, MATERIAL_LIST_COLUMNS.length);
  });
  if (data.subprojects.length > 1) {
    const totalSheet = addWorksheetSafe(workbook, 'MaterialList Total');
    setHeaders(totalSheet, 3, MATERIAL_LIST_COLUMNS);
    let rowIdx = 4;
    allRows.forEach(({ spName, row }) => {
      totalSheet.getRow(rowIdx++).values = sourceRowValues(spName, row);
    });
    rowIdx = addMaterialTotalRow(totalSheet, rowIdx);
    applyTableStyle(totalSheet, 3, rowIdx - 1, MATERIAL_LIST_COLUMNS.length);
  }
  const exclSheet = addWorksheetSafe(workbook, 'Excluded Detail');
  setHeaders(exclSheet, 3, EXCLUDED_DETAIL_COLUMNS);
  let exclRowIdx = 4;
  allExcludedRows(data).forEach(row => {
    exclSheet.getRow(exclRowIdx++).values = excludedRowValues(row);
  });
  applyTableStyle(exclSheet, 3, exclRowIdx - 1, EXCLUDED_DETAIL_COLUMNS.length);
  await workbook.xlsx.writeFile(filePath);
}

async function generateDescription(data, filePath) {
  const workbook = new ExcelJS.Workbook();
  const descriptionSheets = new Map(DESCRIPTION_SHEET_NAMES.map(name => [name, addWorksheetSafe(workbook, name)]));
  const summarySheet = descriptionSheets.get('Project Summary');
  setHeaders(summarySheet, 3, SUMMARY_COLUMNS);
  let sumRowIdx = 4;
  let totalW = 0;
  let totalArea = 0;
  const writeSummaryRow = (spName, sp = {}) => {
    const w = (sp.totals?.weight_kg || 0) / 1000;
    const area = sp.totals?.paint_m2 || 0;
    totalW += w;
    totalArea += area;
    summarySheet.getRow(sumRowIdx++).values = [
      spName,
      data.project_no || '',
      data.project_name || data.project || '',
      sp.exec_class || '',
      w,
      area,
      sp.coating_summary || '',
      sp.fire_summary || sp.fire_protection || '',
      sp.welding || '',
      sp.gratings_steps || '',
      sp.transport_summary || '',
      sp.exclusions_summary || '',
      sp.notes || ''
    ];
  };
  if (data.subprojects.length === 1) {
    writeSummaryRow('All', data.subprojects[0]);
  } else {
    data.subprojects.forEach(sp => writeSummaryRow(sp.name, sp));
  }
  if (data.subprojects.length > 1) {
    summarySheet.getRow(sumRowIdx).values = ['All', data.project_no || '', data.project_name || data.project || '', '', totalW, totalArea, '', '', '', '', '', '', ''];
    sumRowIdx++;
  }
  applyTableStyle(summarySheet, 3, sumRowIdx - 1, SUMMARY_COLUMNS.length);

  const scopeSheet = descriptionSheets.get('Scope/Classification');
  setHeaders(scopeSheet, 3, SCOPE_CLASSIFICATION_COLUMNS);
  let scopeRowIdx = 4;
  data.subprojects.forEach(sp => {
    const categories = new Map();
    (sp.categories || []).forEach(cat => {
      const name = categoryName(cat.name || cat.category);
      categories.set(name, {
        category: name,
        coating: cat.coating || cat.coating_class || sp.coating_summary || '',
        fire_class: cat.fire_class || sp.fire_summary || '',
        exec_class: cat.exec_class || sp.exec_class || '',
        weight_t: num(cat.weight_kg) / 1000,
        paint_m2: num(cat.paint_m2),
        notes: cat.notes || ''
      });
    });
    (sp.profiles || []).forEach(p => {
      const name = categoryName(p.category);
      const existing = categories.get(name);
      if (existing) {
        existing.coating ||= p.coating || '';
        existing.fire_class ||= p.fire_class || '';
        existing.exec_class ||= sp.exec_class || '';
        return;
      }
      categories.set(name, {
        category: name,
        coating: p.coating || sp.coating_summary || '',
        fire_class: p.fire_class || sp.fire_summary || '',
        exec_class: sp.exec_class || '',
        weight_t: num(p.weight_kg) / 1000,
        paint_m2: num(p.paint_m2),
        notes: ''
      });
    });
    Array.from(categories.values()).sort((a, b) => categorySortIndex(a.category) - categorySortIndex(b.category)).forEach(cat => {
      scopeSheet.getRow(scopeRowIdx++).values = [
        sp.name,
        cat.category,
        cat.coating,
        cat.fire_class,
        cat.exec_class,
        cat.weight_t,
        cat.paint_m2,
        cat.notes
      ];
    });
  });
  applyTableStyle(scopeSheet, 3, scopeRowIdx - 1, SCOPE_CLASSIFICATION_COLUMNS.length);

  const exclSheet = descriptionSheets.get('Exclusions');
  setHeaders(exclSheet, 3, EXCLUDED_DETAIL_COLUMNS);
  let exclRowIdx = 4;
  allExcludedRows(data).forEach(row => {
    exclSheet.getRow(exclRowIdx++).values = excludedRowValues(row);
  });
  applyTableStyle(exclSheet, 3, exclRowIdx - 1, EXCLUDED_DETAIL_COLUMNS.length);

  const coatSheet = descriptionSheets.get('Coating/Fire Evidence');
  const coatSummaryColumns = ['Subproject', 'Category', 'Coating Class', 'Fire Class', 'Total Weight (t)', 'Total Paint Area (m2)', 'Profile Count'];
  const coatDetailColumns = ['Subproject', 'Profile', 'Category', 'Steel Grade', 'Coating Class', 'Fire Class', 'Critical Temp (°C)', 'Am/V', 'Paint Area (m2)', 'Source'];
  setHeaders(coatSheet, 3, coatSummaryColumns);
  let coatRowIdx = 4;
  const coatingGroups = new Map();
  const profileDetails = data.subprojects.flatMap(sp => (sp.profiles || []).map(p => ({ ...p, spName: sp.name })));
  profileDetails.forEach(p => {
    const category = categoryName(p.category);
    const key = [p.spName, category, p.coating || '', p.fire_class || ''].join('\u0001');
    const group = coatingGroups.get(key) || {
      subproject: p.spName,
      category,
      coating: p.coating || '',
      fire_class: p.fire_class || '',
      weight_t: 0,
      paint_m2: 0,
      count: 0
    };
    group.weight_t += num(p.weight_kg) / 1000;
    group.paint_m2 += num(p.paint_m2);
    group.count += 1;
    coatingGroups.set(key, group);
  });
  Array.from(coatingGroups.values())
    .sort((a, b) => a.subproject.localeCompare(b.subproject) || categorySortIndex(a.category) - categorySortIndex(b.category))
    .forEach(group => {
      coatSheet.getRow(coatRowIdx++).values = [
        group.subproject,
        group.category,
        group.coating,
        group.fire_class,
        group.weight_t,
        group.paint_m2,
        group.count
      ];
    });
  applyTableStyle(coatSheet, 3, Math.max(3, coatRowIdx - 1), coatSummaryColumns.length);
  coatRowIdx++;
  coatSheet.getRow(coatRowIdx++).values = ['PROFILE DETAIL'];
  setHeaders(coatSheet, coatRowIdx++, coatDetailColumns);
  const detailHeaderRow = coatRowIdx - 1;
  profileDetails.forEach(p => {
    coatSheet.getRow(coatRowIdx++).values = [
      p.spName,
      p.profile || p.name || '',
      categoryName(p.category),
      p.steel_grade || '',
      p.coating || '',
      p.fire_class || '',
      p.critical_temp_c ?? '',
      p.am_v ?? p.am ?? '',
      p.paint_m2 || 0,
      p.source || ''
    ];
  });
  applyTableStyle(coatSheet, detailHeaderRow, Math.max(detailHeaderRow, coatRowIdx - 1), coatDetailColumns.length);
  updateWidthsFromRow(coatSheet, detailHeaderRow, coatDetailColumns.length);

  const transSheet = descriptionSheets.get('Transport Detail');
  transSheet.getRow(2).values = ['Table 1'];
  setHeaders(transSheet, 3, TRANSPORT_DETAIL_T1_COLUMNS);
  let transRowIdx = 4;
  (data.transport_detail?.t1 || []).forEach(row => {
    transSheet.getRow(transRowIdx++).values = [
      row.subproject, row.category, row.assembly_no, row.transport_class, row.length_m,
      row.width_m, row.height_m, row.weight_t, row.confidence, row.source, row.notes
    ];
  });
  applyTableStyle(transSheet, 3, transRowIdx - 1, TRANSPORT_DETAIL_T1_COLUMNS.length);

  transRowIdx += 2;
  transSheet.getRow(transRowIdx++).values = ['Table 2'];
  const t2Start = transRowIdx;
  setHeaders(transSheet, transRowIdx++, TRANSPORT_DETAIL_T2_COLUMNS);
  (data.transport_detail?.t2 || []).forEach(row => {
    transSheet.getRow(transRowIdx++).values = [
      row.subproject, row.category, row.assembly_profile, row.row_type, row.length_m,
      row.width_m, row.height_m, row.weight_t, row.transport_class, row.confidence, row.source, row.notes
    ];
  });
  applyTableStyle(transSheet, t2Start, transRowIdx - 1, TRANSPORT_DETAIL_T2_COLUMNS.length);

  const oqSheet = descriptionSheets.get('Open Questions');
  setHeaders(oqSheet, 3, OPEN_QUESTIONS_WITH_DECISION_COLUMNS);
  let oqRowIdx = 4;
  const statusOrder = new Map([['Open', 0], ['Answered', 1], ['Not applicable', 2]]);
  const questions = (data.open_questions || []).map((q, idx) => ({ ...q, id: q.id || `OQ-${String(idx + 1).padStart(3, '0')}` }));
  questions.sort((a, b) => (
    (statusOrder.get(a.status || 'Open') ?? 99) - (statusOrder.get(b.status || 'Open') ?? 99)
    || String(a.subproject || '').localeCompare(String(b.subproject || ''))
    || String(a.category || '').localeCompare(String(b.category || ''))
    || String(a.id || '').localeCompare(String(b.id || ''))
  ));
  questions.forEach(q => {
    oqSheet.getRow(oqRowIdx++).values = [
      q.id || '', q.subproject || '', q.category || '', q.question || '',
      q.option_a || '', q.option_b || '', q.option_c || '', q.status || 'Open', q.owner_decision || ''
    ];
  });
  applyTableStyle(oqSheet, 3, oqRowIdx - 1, OPEN_QUESTIONS_WITH_DECISION_COLUMNS.length);

  const srcSheet = descriptionSheets.get('Sources');
  setHeaders(srcSheet, 3, SOURCES_COLUMNS);
  let srcRowIdx = 4;
  sourceRows(data).forEach(s => {
    srcSheet.getRow(srcRowIdx++).values = [
      s.subproject || '', s.source_type || '', s.file_name || '', s.used_for || '',
      s.priority || '', s.notes || ''
    ];
  });
  applyTableStyle(srcSheet, 3, srcRowIdx - 1, SOURCES_COLUMNS.length);

  await workbook.xlsx.writeFile(filePath);
}

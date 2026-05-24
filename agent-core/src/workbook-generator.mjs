import ExcelJS from 'exceljs';
import path from 'path';
import fs from 'fs';

/**
 * Sanitizes sheet names to comply with Excel limits and restricted characters.
 * @param {string} name
 * @returns {string}
 */
function sanitizeSheetName(name) {
  if (!name) return 'Sheet';
  // Strip : \ / ? * [ ]
  let sanitized = name.replace(/[:\\/?*\[\]]/g, '');
  return sanitized.substring(0, 31);
}

/**
 * Adds a worksheet to the workbook, ensuring the name is safe and unique.
 * @param {ExcelJS.Workbook} workbook
 * @param {string} name
 * @returns {ExcelJS.Worksheet}
 */
function addWorksheetSafe(workbook, name) {
  let safeName = sanitizeSheetName(name);
  let counter = 1;
  while (workbook.getWorksheet(safeName)) {
    let suffix = ` (${counter})`;
    let base = sanitizeSheetName(name);
    safeName = base.substring(0, 31 - suffix.length) + suffix;
    counter++;
  }
  return workbook.addWorksheet(safeName);
}

/**
 * Sanitizes filenames to strip restricted characters.
 * @param {string} name
 * @returns {string}
 */
function sanitizeFilename(name) {
  if (!name) return 'unnamed';
  // Strip / \ : * ? " < > |
  return name.replace(/[/\\:*?"<>|]/g, '_');
}

/**
 * Validates input data and sets defaults.
 * @param {Object} data
 */
function validateInput(data) {
  if (!data.subprojects || !Array.isArray(data.subprojects) || data.subprojects.length === 0) {
    throw new Error('Invalid input: subprojects is required and must not be empty');
  }
  data.subprojects.forEach((sp, idx) => {
    if (!sp.name || !sp.totals || !sp.profiles) {
      throw new Error(`Invalid input: subproject at index ${idx} must have name, totals, and profiles`);
    }
    sp.source_rows = sp.source_rows || [];
    sp.assembly_map = sp.assembly_map || [];
    sp.oversize = sp.oversize || [];
    sp.categories = sp.categories || [];
  });
  data.excluded = data.excluded || [];
  data.sources = data.sources || [];
}

/**
 * Generates 3 Excel workbooks (BoM, Material List, Description) based on input JSON.
 * 
 * @param {Object} data - Input data following the specified schema.
 * @param {string} outputDir - Directory to save the generated files.
 */
export async function generateWorkbooks(data, outputDir) {
  validateInput(data);

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  await generateBoM(data, outputDir);
  await generateMaterialList(data, outputDir);
  await generateDescription(data, outputDir);
}

async function generateBoM(data, outputDir) {
  const { run_id, project, subprojects, excluded, sources } = data;
  const workbook = new ExcelJS.Workbook();
  const filename = `BoM_${sanitizeFilename(project)}_${sanitizeFilename(run_id)}.xlsx`;
  const filePath = path.join(outputDir, filename);

  // Per subproject sheets
  for (const sp of subprojects) {
    const sheet = addWorksheetSafe(workbook, sp.name);
    sheet.getCell('A1').value = `BoM - ${sp.name} Procurement${sp.name === 'Skärmtak' ? ' Excluding Trusses' : ''}`;
    sheet.getCell('A1').font = { bold: true, size: 14 };
    
    const headers = ['Profile', 'Steel Grade', 'Standard', 'Qty', 'Total Length m', 'Total Weight kg', 'Total Weight t', 'Total Paint Area m2'];
    sheet.getRow(3).values = headers;
    sheet.getRow(3).font = { bold: true };

    sp.profiles.forEach((p, idx) => {
      sheet.getRow(4 + idx).values = [
        p.profile,
        p.steel_grade,
        p.standard || 'EN 10025-2',
        p.qty,
        p.length_m,
        p.weight_kg,
        p.weight_kg / 1000,
        p.paint_m2
      ];
    });
  }

  // TOTAL BoM
  const totalSheet = addWorksheetSafe(workbook, 'TOTAL BoM');
  totalSheet.getCell('A1').value = 'BoM - Total';
  totalSheet.getCell('A1').font = { bold: true, size: 14 };
  totalSheet.getRow(3).values = ['Profile', 'Steel Grade', 'Standard', 'Qty', 'Total Length m', 'Total Weight kg', 'Total Weight t', 'Total Paint Area m2'];
  totalSheet.getRow(3).font = { bold: true };
  
  const aggregated = {};
  subprojects.flatMap(sp => sp.profiles).forEach(p => {
    const key = `${p.profile}|${p.steel_grade}|${p.standard || 'EN 10025-2'}`;
    if (!aggregated[key]) {
      aggregated[key] = { ...p, standard: p.standard || 'EN 10025-2' };
    } else {
      aggregated[key].qty += p.qty;
      aggregated[key].length_m += p.length_m;
      aggregated[key].weight_kg += p.weight_kg;
      aggregated[key].paint_m2 += p.paint_m2;
    }
  });
  Object.values(aggregated).forEach((p, idx) => {
    totalSheet.getRow(4 + idx).values = [p.profile, p.steel_grade, p.standard, p.qty, p.length_m, p.weight_kg, p.weight_kg / 1000, p.paint_m2];
  });

  // Excluded Scope
  addExcludedSheet(workbook, excluded);

  // Sources
  addSourcesSheet(workbook, sources);

  // Reconciliation
  addReconciliationSheet(workbook, subprojects);

  await workbook.xlsx.writeFile(filePath);
}

async function generateMaterialList(data, outputDir) {
  const { run_id, project, subprojects, excluded, sources } = data;
  const workbook = new ExcelJS.Workbook();
  const filename = `Material_List_${sanitizeFilename(project)}_${sanitizeFilename(run_id)}.xlsx`;
  const filePath = path.join(outputDir, filename);

  for (const sp of subprojects) {
    // Source Rows / Details
    const detailsName = sp.name === 'Ombyggnad' ? 'Ombyggnad Details' : `${sp.name} Source Rows`;
    const detailsSheet = addWorksheetSafe(workbook, detailsName);
    detailsSheet.getCell('A1').value = `${detailsName} with Source Subtotals`;
    detailsSheet.getRow(3).values = ['Subproject', 'Category', 'Part', 'Profile', 'Steel Grade', 'Standard', 'Qty', 'Length mm', 'Length total m', 'Weight total kg', 'Paint area total m2', 'Area/weight source', 'Source', 'Source line', 'Oversize length >13.7m', 'Oversize width >2.4m'];
    detailsSheet.getRow(3).font = { bold: true };
    sp.source_rows.forEach((sr, idx) => {
      detailsSheet.getRow(4 + idx).values = [
        sp.name, sr.category || '', sr.part, sr.profile, sr.steel_grade, sr.standard || 'EN 10025-2', sr.qty, sr.length_mm, sr.length_mm * sr.qty / 1000, sr.weight_kg, sr.paint_m2, sr.area_weight_source || '', sr.source || '', sr.source_line || '', sr.length_mm > 13700 ? 'YES' : '', ''
      ];
    });

    // Procurement / Subtotals
    const subtotalsName = sp.name === 'Ombyggnad' ? 'Ombyggnad Subtotals' : `${sp.name} Procurement`;
    const subSheet = addWorksheetSafe(workbook, subtotalsName);
    subSheet.getCell('A1').value = `Material List - ${subtotalsName}${sp.name === 'Skärmtak' ? ' Excluding Trusses' : ''}`;
    subSheet.getRow(3).values = ['Subproject', 'Profile', 'Steel Grade', 'Standard', 'Qty', 'Total Length m', 'Total Weight kg', 'Total Paint Area m2'];
    subSheet.getRow(3).font = { bold: true };
    sp.profiles.forEach((p, idx) => {
      subSheet.getRow(4 + idx).values = [sp.name, p.profile, p.steel_grade, p.standard || 'EN 10025-2', p.qty, p.length_m, p.weight_kg, p.paint_m2];
    });

    // Assembly Map
    if (sp.assembly_map.length > 0 || sp.name === 'Skärmtak') {
      const amSheet = addWorksheetSafe(workbook, `${sp.name} Assembly Map`);
      amSheet.getCell('A1').value = `${sp.name} Assembly Drawing Part Mapping`;
      amSheet.getRow(3).values = ['Subproject', 'Category', 'Assembly No.', 'Part No.', 'Profile', 'Steel Grade', 'Standard', 'Qty', 'Length mm', 'Total Length m', 'Weight kg', 'Paint Area m2', 'Included in Procurement', 'Source', 'Source line'];
      amSheet.getRow(3).font = { bold: true };
      sp.assembly_map.forEach((am, idx) => {
        amSheet.getRow(4 + idx).values = [sp.name, am.category || '', am.assembly_no, am.part_no, am.profile, am.steel_grade, am.standard || 'EN 10025-2', am.qty, am.length_mm, am.length_mm * am.qty / 1000, am.weight_kg, am.paint_m2, 'YES', am.source || '', am.source_line || ''];
      });
    }

    // Excluded
    if (sp.name === 'Skärmtak') {
      const exclDetailSheet = addWorksheetSafe(workbook, 'Skärmtak Excluded');
      exclDetailSheet.getCell('A1').value = 'Skärmtak Excluded Truss Details';
      exclDetailSheet.getRow(3).values = ['Subproject', 'Category', 'Assembly No.', 'Part No.', 'Profile', 'Steel Grade', 'Standard', 'Qty', 'Length mm', 'Total Length m', 'Weight kg', 'Paint Area m2', 'Included in Procurement', 'Source', 'Source line'];
      exclDetailSheet.getRow(3).font = { bold: true };
    }
  }

  // TOTAL Subtotals
  const totalSheet = addWorksheetSafe(workbook, 'TOTAL Subtotals');
  totalSheet.getCell('A1').value = 'Material List - Total Profile Subtotals';
  totalSheet.getRow(3).values = ['Profile', 'Steel Grade', 'Standard', 'Qty', 'Total Length m', 'Total Weight kg', 'Total Weight t', 'Total Paint Area m2'];
  totalSheet.getRow(3).font = { bold: true };
  const aggregated = {};
  subprojects.flatMap(sp => sp.profiles).forEach(p => {
    const key = `${p.profile}|${p.steel_grade}|${p.standard || 'EN 10025-2'}`;
    if (!aggregated[key]) {
      aggregated[key] = { ...p, standard: p.standard || 'EN 10025-2' };
    } else {
      aggregated[key].qty += p.qty;
      aggregated[key].length_m += p.length_m;
      aggregated[key].weight_kg += p.weight_kg;
      aggregated[key].paint_m2 += p.paint_m2;
    }
  });
  Object.values(aggregated).forEach((p, idx) => {
    totalSheet.getRow(4 + idx).values = [p.profile, p.steel_grade, p.standard, p.qty, p.length_m, p.weight_kg, p.weight_kg / 1000, p.paint_m2];
  });

  addExcludedSheet(workbook, excluded);
  addSourcesSheet(workbook, sources);
  addReconciliationSheet(workbook, subprojects);

  await workbook.xlsx.writeFile(filePath);
}

async function generateDescription(data, outputDir) {
  const { run_id, project, subprojects, excluded, sources } = data;
  const workbook = new ExcelJS.Workbook();
  const filename = `Description_${sanitizeFilename(project)}_${sanitizeFilename(run_id)}.xlsx`;
  const filePath = path.join(outputDir, filename);

  const summarySheet = addWorksheetSafe(workbook, 'Project Summary');
  summarySheet.getCell('A1').value = 'Project Summary and Procurement Totals';
  summarySheet.getRow(3).values = ['Subproject', 'Official/source total kg', 'Coating', 'Source', 'Workbook controlling total kg', 'Workbook controlling area m2', 'Difference kg'];
  summarySheet.getRow(3).font = { bold: true };
  subprojects.forEach((sp, idx) => {
    const diff = sp.totals.weight_kg - (sp.source_total_kg ?? sp.totals.weight_kg);
    summarySheet.getRow(4 + idx).values = [sp.name, sp.source_total_kg ?? sp.totals.weight_kg, sp.coating, 'Project Documentation', sp.totals.weight_kg, sp.totals.paint_m2, diff];
  });

  const catSheet = addWorksheetSafe(workbook, 'Category Summary');
  catSheet.getCell('A1').value = 'Description - Category Summary';
  catSheet.getRow(3).values = ['Subproject', 'Category', 'Qty', 'Total Length m', 'Total Weight kg', 'Total Weight t', 'Total Paint Area m2'];
  catSheet.getRow(3).font = { bold: true };
  let rowIdx = 4;
  subprojects.forEach(sp => {
    sp.categories.forEach(cat => {
      catSheet.getRow(rowIdx++).values = [sp.name, cat.name, cat.qty, cat.length_m || null, cat.weight_kg, cat.weight_kg / 1000, cat.paint_m2];
    });
  });

  const coatingSheet = addWorksheetSafe(workbook, 'Coating Requirements');
  coatingSheet.getCell('A1').value = 'Coating Requirements';
  coatingSheet.getRow(3).values = ['Subproject', 'Coating / corrosion protection', 'Source quantity', 'Note'];
  coatingSheet.getRow(3).font = { bold: true };
  subprojects.forEach((sp, idx) => {
    coatingSheet.getRow(4 + idx).values = [sp.name, sp.coating, sp.source_total_kg ?? sp.totals.weight_kg, 'Standard requirements'];
  });

  for (const sp of subprojects) {
    const pSheet = addWorksheetSafe(workbook, `${sp.name} Profiles`);
    pSheet.getRow(3).values = ['Subproject', 'Profile', 'Steel Grade', 'Standard', 'Qty', 'Total Length m', 'Total Weight kg', 'Total Paint Area m2'];
    pSheet.getRow(3).font = { bold: true };
    sp.profiles.forEach((p, idx) => {
      pSheet.getRow(4 + idx).values = [sp.name, p.profile, p.steel_grade, p.standard || 'EN 10025-2', p.qty, p.length_m, p.weight_kg, p.paint_m2];
    });
  }

  const refSheet = addWorksheetSafe(workbook, 'Material Reference');
  refSheet.getCell('A1').value = 'Detailed Material Reference';
  refSheet.getRow(3).values = ['Subproject', 'Category', 'Part', 'Profile', 'Steel Grade', 'Standard', 'Qty', 'Length mm', 'Length total m', 'Weight total kg', 'Paint area total m2', 'Area/weight source', 'Source', 'Source line', 'Oversize length >13.7m', 'Oversize width >2.4m'];
  refSheet.getRow(3).font = { bold: true };
  let refRowIdx = 4;
  subprojects.forEach(sp => {
    sp.source_rows.forEach(sr => {
      refSheet.getRow(refRowIdx++).values = [sp.name, sr.category || '', sr.part, sr.profile, sr.steel_grade, sr.standard || 'EN 10025-2', sr.qty, sr.length_mm, sr.length_mm * sr.qty / 1000, sr.weight_kg, sr.paint_m2, sr.area_weight_source || '', sr.source || '', sr.source_line || '', sr.length_mm > 13700 ? 'YES' : '', ''];
    });
  });

  for (const sp of subprojects) {
    if (sp.assembly_map.length > 0 || sp.name === 'Skärmtak') {
      const amSheet = addWorksheetSafe(workbook, `${sp.name} Assembly Map`);
      amSheet.getRow(3).values = ['Subproject', 'Category', 'Assembly No.', 'Part No.', 'Profile', 'Steel Grade', 'Standard', 'Qty', 'Length mm', 'Total Length m', 'Weight kg', 'Paint Area m2', 'Included in Procurement', 'Source', 'Source line'];
      amSheet.getRow(3).font = { bold: true };
      sp.assembly_map.forEach((am, idx) => {
        amSheet.getRow(4 + idx).values = [sp.name, am.category || '', am.assembly_no, am.part_no, am.profile, am.steel_grade, am.standard || 'EN 10025-2', am.qty, am.length_mm, am.length_mm * am.qty / 1000, am.weight_kg, am.paint_m2, 'YES', am.source || '', am.source_line || ''];
      });
    }
  }

  addExcludedSheet(workbook, excluded);

  const overSheet = addWorksheetSafe(workbook, 'Oversize');
  overSheet.getCell('A1').value = 'Oversize Checks';
  overSheet.getRow(3).values = ['Subproject', 'Category', 'Part', 'Profile', 'Steel Grade', 'Standard', 'Qty', 'Length mm', 'Length total m', 'Weight total kg', 'Paint area total m2', 'Area/weight source', 'Source', 'Source line', 'Oversize length >13.7m', 'Oversize width >2.4m'];
  overSheet.getRow(3).font = { bold: true };
  let overRowIdx = 4;
  subprojects.forEach(sp => {
    sp.oversize.forEach(o => {
      overSheet.getRow(overRowIdx++).values = [sp.name, o.category || '', o.part, o.profile, o.steel_grade, o.standard || 'EN 10025-2', o.qty, o.length_mm, o.length_mm * o.qty / 1000, o.weight_kg, o.paint_m2, o.area_weight_source || '', o.source || '', o.source_line || '', o.length_mm > 13700 ? 'YES' : '', ''];
    });
  });

  addSourcesSheet(workbook, sources);

  await workbook.xlsx.writeFile(filePath);
}

function addExcludedSheet(workbook, excluded) {
  const exclSheet = addWorksheetSafe(workbook, 'Excluded Scope');
  exclSheet.getCell('A1').value = 'Excluded Scope';
  exclSheet.getRow(3).values = ['Subproject', 'Excluded Scope', 'Reason', 'Extracted excluded weight kg', 'Extracted excluded paint area m2', 'Assembly-list control weight kg', 'Assembly-list control paint area m2', 'Difference kg', 'Difference m2', 'Note'];
  exclSheet.getRow(3).font = { bold: true };
  excluded.forEach((e, idx) => {
    const diffKg = e.weight_kg - (e.assembly_weight_kg ?? e.weight_kg);
    const diffM2 = e.paint_m2 - (e.assembly_paint_m2 ?? e.paint_m2);
    exclSheet.getRow(4 + idx).values = [e.subproject, e.scope, e.reason, e.weight_kg, e.paint_m2, e.assembly_weight_kg ?? e.weight_kg, e.assembly_paint_m2 ?? e.paint_m2, diffKg, diffM2, ''];
  });
}

function addSourcesSheet(workbook, sources) {
  const sourcesSheet = addWorksheetSafe(workbook, 'Sources');
  sourcesSheet.getCell('A1').value = 'Sources';
  sourcesSheet.getRow(3).values = ['Source', 'Use'];
  sourcesSheet.getRow(3).font = { bold: true };
  sources.forEach((s, idx) => {
    sourcesSheet.getRow(4 + idx).values = [s, 'Source of Truth'];
  });
}

function addReconciliationSheet(workbook, subprojects) {
  const reconSheet = addWorksheetSafe(workbook, 'Reconciliation');
  reconSheet.getCell('A1').value = 'Procurement Weight Reconciliation';
  reconSheet.getRow(3).values = ['Subproject', 'Official/source total kg', 'Coating', 'Source', 'Workbook controlling total kg', 'Workbook controlling area m2', 'Difference kg'];
  reconSheet.getRow(3).font = { bold: true };
  subprojects.forEach((sp, idx) => {
    const diff = sp.totals.weight_kg - (sp.source_total_kg ?? sp.totals.weight_kg);
    reconSheet.getRow(4 + idx).values = [sp.name, sp.source_total_kg ?? sp.totals.weight_kg, sp.coating, 'Project Documentation', sp.totals.weight_kg, sp.totals.paint_m2, diff];
  });
}

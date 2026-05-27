export const WORKBOOK_STYLE = {
  headerFill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } },
  totalFill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9EAD3' } },
  warningFill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } },
  criticalFill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF0000' } },
  font: { name: 'Arial', size: 10 },
  headerFont: { name: 'Arial', size: 10, bold: true },
  border: {
    top: { style: 'thin' },
    left: { style: 'thin' },
    bottom: { style: 'thin' },
    right: { style: 'thin' }
  }
};

export const DESCRIPTION_SHEETS = [
  'Project Summary',
  'Scope / Classification',
  'Exclusions',
  'Coating Summary',
  'Coating Detail',
  'Transport Detail',
  'Open Questions',
  'Sources'
];

export const COATING_SUMMARY_COLUMNS = [
  'Subproject',
  'Coating Class',
  'Fire Class',
  'Total Weight (t)',
  'Total Paint Area (m2)'
];

export const COATING_DETAIL_COLUMNS = [
  'Subproject',
  'Profile',
  'Category',
  'Steel Grade',
  'Coating Class',
  'Fire Class',
  'Critical Temp (°C)',
  'Am/V',
  'Paint Area (m2)',
  'Source'
];

export const BOM_COLUMNS = [
  'Profile',
  'Steel Grade',
  'Total Length (m)',
  'Total Weight (t)',
  'Total Paint Area (m2)',
  'Unit price €/t',
  'Material cost €'
];

export const BOM_CAT_COLUMNS = [
  'Category',
  'Profile',
  'Steel Grade',
  'Total Length (m)',
  'Total Weight (t)',
  'Total Paint Area (m2)'
];

export const MATERIAL_LIST_COLUMNS = [
  'Subproject',
  'Category',
  'Assembly No',
  'Part No',
  'Profile',
  'Steel Grade',
  'Qty',
  'Length (mm)',
  'Weight (kg)',
  'Paint Area (m2)',
  'Am',
  'Coating',
  'Fireproofing Class',
  'Critical Temperature',
  'Oversize (Y/N)'
];

export const EXCLUDED_DETAIL_COLUMNS = [
  ...MATERIAL_LIST_COLUMNS,
  'Exclusion Reason',
  'Source'
];

export const SUMMARY_COLUMNS = [
  'Subproject',
  'Project No',
  'Project Name',
  'Execution Class',
  'Total Weight (t)',
  'Total Paint Area (m2)',
  'Coating',
  'Fire Protection',
  'Welding',
  'Gratings/Steps',
  'Transport',
  'Exclusions',
  'Notes'
];

export const TRANSPORT_DETAIL_T1_COLUMNS = [
  'Subproject',
  'Category',
  'Assembly No',
  'Transport Class',
  'Length (m)',
  'Width (m)',
  'Height (m)',
  'Weight (t)',
  'Confidence',
  'Source',
  'Notes'
];

export const TRANSPORT_DETAIL_T2_COLUMNS = [
  'Subproject',
  'Category',
  'Assembly/Profile',
  'Row Type',
  'Length (m)',
  'Width (m)',
  'Height (m)',
  'Weight (t)',
  'Transport Class',
  'Confidence',
  'Source',
  'Notes'
];

export const OPEN_QUESTIONS_COLUMNS = [
  'Question ID',
  'Subproject',
  'Category',
  'Question',
  'Option A',
  'Option B',
  'Option C',
  'Status'
];

export const SOURCES_COLUMNS = [
  'Subproject',
  'Source Type',
  'File Name',
  'Used For',
  'Priority',
  'Notes'
];

export const TRANSPORT_CONFIDENCE = [
  'Confirmed from drawings',
  'Estimated from IFC assembly',
  'Signal from part length',
  'Manual owner input',
  'Needs review'
];

export const TRANSPORT_CLASS = [
  'Gauge',
  'Long load',
  'Wide load',
  'High load',
  'Heavy load',
  'Special transport',
  'Needs review'
];

export const SOURCE_PRIORITY = [
  'Primary',
  'Secondary',
  'Reference'
];

export const SOURCE_TYPE = [
  'IFC',
  'Drawing',
  'Specification',
  'PDF',
  'Excel',
  'Email',
  'Other'
];

export const SOURCE_USED_FOR = [
  'Geometry',
  'Weight',
  'Coating',
  'Fire protection',
  'Welding',
  'Transport',
  'Exclusions',
  'Classification',
  'General reference'
];

export const OQ_STATUS = [
  'Open',
  'Answered',
  'Not applicable'
];

export const CATEGORY_ORDER = [
  'Columns',
  'Beams',
  'Trusses',
  'HSQ',
  'Bracing',
  'Railings',
  'Stairs / Stringers',
  'Outside structures',
  'Plates',
  'Other',
  'Unclassified'
];

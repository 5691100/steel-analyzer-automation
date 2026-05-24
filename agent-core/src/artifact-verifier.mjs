import fs from 'fs';
import path from 'path';

/**
 * Verifies that the run output contains the required Excel workbooks.
 * 
 * @param {string} runDir - Absolute path to the run directory.
 * @returns {Object} { ok: boolean, files: string[], errors: string[] }
 */
export function verifyRunOutput(runDir) {
  const results = {
    ok: true,
    files: [],
    errors: []
  };

  if (typeof runDir !== 'string' || !path.isAbsolute(runDir)) {
    results.ok = false;
    results.errors.push(`Invalid run directory: must be an absolute path. Got: ${runDir}`);
    return results;
  }

  const outputDir = path.join(runDir, 'output');

  if (!fs.existsSync(outputDir)) {
    results.ok = false;
    results.errors.push(`Output directory missing: ${outputDir}`);
    return results;
  }

  const expectedPatterns = [
    /^BoM_.*\.xlsx$/,
    /^Material_List_.*\.xlsx$/,
    /^Description_.*\.xlsx$/
  ];

  const foundFiles = fs.readdirSync(outputDir);
  const minSize = 5000;

  for (const pattern of expectedPatterns) {
    const matchedFile = foundFiles.find(f => pattern.test(f));
    if (!matchedFile) {
      results.ok = false;
      results.errors.push(`Missing workbook matching pattern: ${pattern}`);
      continue;
    }

    const filePath = path.join(outputDir, matchedFile);
    const stats = fs.statSync(filePath);

    if (stats.size < minSize) {
      results.ok = false;
      results.errors.push(`Workbook too small (${stats.size} bytes): ${matchedFile}`);
    } else {
      results.files.push(matchedFile);
    }
  }

  return results;
}

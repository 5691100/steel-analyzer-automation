/**
 * Builds the analysis prompt for Gemini.
 * 
 * @param {string} runId
 * @param {Object.<string, string>} sourceTexts - Map of filename to text content.
 * @returns {string}
 */
export function buildAnalysisPrompt(runId, sourceTexts) {
  const sourcesList = Object.keys(sourceTexts).map(name => `- ${name}`).join('\n');
  const combinedText = Object.entries(sourceTexts)
    .map(([name, text]) => `--- SOURCE: ${name} ---\n${text}`)
    .join('\n\n');

  return `
Analyze steel structures from the provided source texts. 
Run ID: ${runId}

SOURCES:
${sourcesList}

CONSTRAINTS:
1. Return JSON strictly following the schema "steel.run-complete.v1".
2. Include "subprojects" with detailed "profiles", "categories", "source_rows", and "assembly_map".
3. Include "totals", "excluded" scope, and "sources" list.
4. DO NOT invent data. If a field is unknown and not required, omit it or set to null.
5. All weight must be in kg, lengths in m (or mm where specified in schema), areas in m2.
6. Identify trusses (usually FV/* marks) and exclude them from procurement totals if appropriate, but list them in the "excluded" array.
7. Output ONLY raw JSON. No markdown blocks, no preamble, no postamble.

TEXT CONTENT:
${combinedText}
`.trim();
}

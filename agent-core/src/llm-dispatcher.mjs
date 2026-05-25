import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { buildAnalysisPrompt } from './prompts/steel-analysis-prompt.mjs';
import { generateWorkbooks } from './workbook-generator.mjs';
import { verifyRunOutput } from './artifact-verifier.mjs';

/**
 * Dispatches the analysis task to Gemini LLM, generateworkbooks, and verifies results.
 * 
 * @param {string} runId
 * @param {string} runDir
  * @param {string} sourcesDir
 * @return {Promise<Object>} Verification result
 */
export async function dispatchGeminiAnalysis(runId, runDir, sourcesDir, { 
  spawn = spawnSync,
  generate = generateWorkbooks,
  verify = verifyRunOutput
} = {}) {
  // 1. Read all .txt files from sourcesDir
  const files = fs.readdirSync(sourcesDir).filter(f => f.endsWith('.txt'));
  const sourceTexts = {};
  for (const file of files) {
    sourceTexts[file] = fs.readFileSync(path.join(sourcesDir, file), 'utf8');
  }

  // 2, Formulate prompt
  const prompt = buildAnalysisPrompt(runId, sourceTexts);

  // 3. Call Gemini
  console.log(`Dispatching Gemini analysis for run ${runId}...`);
  const result = spawn('gemini', ['-p', prompt], { 
    timeout: 300_000,
    encoding: 'utf8' 
  });

  if (result.error) {
    throw result.error;
  }

  const stdout = result.stdout.trim();
  let analysis;
  
  // 4. Parse stdout as JSON
  try {
    // LLMs sometimes wrap JSON in markdown blocks even when told not to.
    const jsonMatch = stdout.match(/\{[\s\S]*}/);
    const jsonStr = jsonMatch ? jsonMatch[0] : stdout;
    analysis = JSON.parse(jsonStr);
  } catch (err) {
    // 5. If parsing failed — record raw output
    const rawPath = path.join(runDir, 'gemini-raw.txt');
    fs.writeFileSync(rawPath, stdout, 'utf8');
    throw new Error(`Failed to parse Gemini JSON output. Raw output saved to ${rawPath}. Error: ${err.message}`);
  }

  // 6. Record analysis result
  const analysisPath = path.join(runDir, 'gemini-analysis.json');
  fs.writeFileSync(analysisPath, JSON.stringify(analysis, null, 2), 'utf8');

  // Ensure project field exists for workbook generator
  if (!analysis.project && analysis.project_name) {
    analysis.project = analysis.project_name;
  }

  // 7. Generate workbooks
  const outputDir = path.join(runDir, 'output');
  await generate(analysis, outputDir);

  // 8. Verify output
  const vResult = verify(runDir);

  // 9. If not ok — throw Error
  if (!vResult.ok) {
    throw new Error(`Workbook verification failed: ${vResult.errors.join('; ')}`);
  }

  // 10. Return result
  return vResult;
}

/**
 * Dispatches a free-text question from Open-chat mode to the appropriate agent CLI.
 * @param {string} runId
 * @param {string} gateId  - e.g. 'g1_gemini', 'g2_qa'
 * @param {string} question - owner's question text
 * @param {string} agent   - 'gemini' | 'claude' | 'codex'
 * @param {{ spawn: Function }} opts
 * @returns {Promise<string>} agent answer
 */
export async function dispatchOpenChatQuestion(runId, gateId, question, agent, { spawn = spawnSync } = {}) {
  const CLI_MAP = { gemini: 'gemini', claude: 'claude', codex: 'codex' };
  const cli = CLI_MAP[agent] ?? 'gemini';

  const prompt = `Steel Analyzer run: ${runId}\nGate: ${gateId}\nOwner question: ${question}\n\nAnswer concisely in the same language as the question.`;

  const result = spawn(cli, ['-p', '-'], {
    input: prompt,
    timeout: 120_000,
    encoding: 'utf8',
  });

  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr?.slice(0, 200) ?? 'unknown';
    throw new Error(`dispatchOpenChatQuestion failed (${cli}): ${detail}`);
  }

  return (result.stdout ?? '').trim() || '(no answer)';
}

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { buildAnalysisPrompt } from './prompts/steel-analysis-prompt.mjs';
import { generateWorkbooks } from './workbook-generator.mjs';
import { verifyRunOutput } from './artifact-verifier.mjs';
import { generateDashboard } from './dashboard-generator.mjs';

function parseProjectInfo(folderName) {
  if (!folderName) return { project_no: 'Unknown', project_name: 'Unknown' };
  const match = folderName.match(/^([0-9/.-]+)\s+(.*)$/);
  if (match) {
    return { project_no: match[1], project_name: match[2] };
  }
  return { project_no: 'Unknown', project_name: folderName };
}

export async function dispatchGeminiAnalysis(runId, runDir, sourcesDir, {
  spawn = spawnSync,
  generate = generateWorkbooks,
  generateDash = generateDashboard,
  verify = verifyRunOutput
} = {}) {
  const files = fs.readdirSync(sourcesDir).filter(f => f.endsWith('.txt'));
  const sourceTexts = {};
  for (const file of files) {
    sourceTexts[file] = fs.readFileSync(path.join(sourcesDir, file), 'utf8');
  }

  const prompt = buildAnalysisPrompt(runId, sourceTexts);

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

  try {
    const jsonMatch = stdout.match(/\{[\s\S]*}/);
    const jsonStr = jsonMatch ? jsonMatch[0] : stdout;
    analysis = JSON.parse(jsonStr);
  } catch (err) {
    const rawPath = path.join(runDir, 'gemini-raw.txt');
    fs.writeFileSync(rawPath, stdout, 'utf8');
    throw new Error(`Failed to parse Gemini JSON output. Raw output saved to ${rawPath}. Error: ${err.message}`);
  }

  let folderName = 'Unknown';
  const manifestPath = path.join(runDir, 'manifest-drive-download.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      folderName = manifest.drive_folder_name || manifest.folder_id || 'Unknown';
    } catch (e) {
      console.warn('Failed to read download manifest:', e.message);
    }
  }
  const projectInfo = parseProjectInfo(folderName);
  analysis.project_no = analysis.project_no || projectInfo.project_no;
  analysis.project_name = analysis.project_name || projectInfo.project_name;

  if (!analysis.project && analysis.project_name) {
    analysis.project = analysis.project_name;
  }

  const outputDir = path.join(runDir, 'output');
  if (fs.existsSync(outputDir)) {
    for (const file of fs.readdirSync(outputDir)) {
      if (file.endsWith('.xlsx')) {
        fs.rmSync(path.join(outputDir, file), { force: true });
      }
    }
  }
  const existingFiles = fs.existsSync(outputDir) ? fs.readdirSync(outputDir) : [];
  await generate(analysis, outputDir, { existingFiles });

  // Save analysis result AFTER generateWorkbooks so it includes version_string and generated_at
  const analysisPath = path.join(runDir, 'gemini-analysis.json');
  fs.writeFileSync(analysisPath, JSON.stringify(analysis, null, 2), 'utf8');

  await generateDash(analysis, outputDir);

  const vResult = verify(runDir);
  if (!vResult.ok) {
    throw new Error(`Workbook verification failed: ${vResult.errors.join('; ')}`);
  }

  return vResult;
}

export async function dispatchOpenChatQuestion(runId, gateId, question, agent, { spawn = spawnSync } = {}) {
  const CLI_MAP = { gemini: 'gemini', claude: 'claude', codex: 'codex' };
  const cli = CLI_MAP[agent] ?? 'gemini';
  const prompt = `Steel Analyzer run: ${runId}\nGate: ${gateId}\nOwner question: ${question}\n\nAnswer concisely in the same language as the question.`;
  let result;
  if (cli === 'codex') {
    result = spawn('codex', ['exec', '-'], { input: prompt, timeout: 120_000, encoding: 'utf8' });
  } else {
    result = spawn(cli, ['-p', '-'], { input: prompt, timeout: 120_000, encoding: 'utf8' });
  }
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr?.slice(0, 200) ?? 'unknown';
    throw new Error(`dispatchOpenChatQuestion failed (${cli}): ${detail}`);
  }
  return (result.stdout ?? '').trim() || '(no answer)';
}

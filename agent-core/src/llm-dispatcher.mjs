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
  // Convert PDFs to text if .txt counterparts are missing
  for (const file of fs.readdirSync(sourcesDir).filter(f => f.endsWith('.pdf'))) {
    const txtPath = path.join(sourcesDir, file.replace(/\.pdf$/i, '.txt'));
    if (!fs.existsSync(txtPath)) {
      const r = spawnSync('pdftotext', [path.join(sourcesDir, file), txtPath], { encoding: 'utf8' });
      if (r.status !== 0) console.warn(`pdftotext failed for ${file}: ${r.stderr}`);
    }
  }

  const MAX_SOURCE_CHARS = 80_000;
  const MAX_DRAWING_CHARS = 20_000;
  const DRAWING_PATTERN = /teräs(?:kokoonpanot|osakuvat)/i;
  const files = fs.readdirSync(sourcesDir).filter(f => f.endsWith('.txt'));
  const sourceTexts = {};
  for (const file of files) {
    let text = fs.readFileSync(path.join(sourcesDir, file), 'utf8');
    const limit = DRAWING_PATTERN.test(file) ? MAX_DRAWING_CHARS : MAX_SOURCE_CHARS;
    if (text.length > limit) {
      console.warn(`Truncating ${file} (${text.length} chars → ${limit})`);
      text = text.slice(0, limit) + '\n[TRUNCATED]';
    }
    sourceTexts[file] = text;
  }

  const prompt = buildAnalysisPrompt(runId, sourceTexts);

  const promptChars = prompt.length;
  console.log(`Dispatching Gemini analysis for run ${runId} (prompt: ${promptChars} chars)...`);
  const dispatchStart = Date.now();
  const result = spawn('agy', ['--dangerously-skip-permissions', '--print-timeout', '15m', '-p', '-'], {
    input: prompt,
    timeout: 1_200_000,
    encoding: 'utf8',
    cwd: '/tmp'
  });
  const elapsedSec = ((Date.now() - dispatchStart) / 1000).toFixed(1);
  const stdoutBytes = (result.stdout ?? '').length;
  const stderrBytes = (result.stderr ?? '').length;
  console.log(`agy finished: status=${result.status ?? 'null'} elapsed=${elapsedSec}s stdout=${stdoutBytes}B stderr=${stderrBytes}B`);

  // Always persist agy output for post-mortem analysis
  const agyLogPath = path.join(runDir, 'agy-run.log');
  const logHeader = `=== agy run ${runId} ===\nstart: ${new Date(dispatchStart).toISOString()}\nelapsed: ${elapsedSec}s\nstatus: ${result.status ?? 'null'}\nprompt_chars: ${promptChars}\nstdout_bytes: ${stdoutBytes}\nstderr_bytes: ${stderrBytes}\n\n--- STDOUT ---\n`;
  const logFooter = stderrBytes > 0 ? `\n\n--- STDERR ---\n${result.stderr}` : '';
  fs.writeFileSync(agyLogPath, logHeader + (result.stdout ?? '') + logFooter, 'utf8');

  if (result.error) {
    throw result.error;
  }

  const stdout = (result.stdout ?? '').trim();
  let analysis;

  try {
    const jsonMatch = stdout.match(/\{[\s\S]*}/);
    const jsonStr = jsonMatch ? jsonMatch[0] : stdout;
    analysis = JSON.parse(jsonStr);
  } catch (err) {
    throw new Error(`Failed to parse Gemini JSON output. Raw output saved to ${agyLogPath}. Error: ${err.message}`);
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
  const existingFiles = fs.existsSync(outputDir) ? fs.readdirSync(outputDir) : [];
  await generate(analysis, outputDir, { existingFiles });

  if (fs.existsSync(outputDir)) {
    for (const file of existingFiles) {
      if (file.endsWith('.xlsx') && (
        file.includes('_BoM') ||
        file.includes('_MaterialList') ||
        file.includes('_Description')
      )) {
        const filePath = path.join(outputDir, file);
        if (fs.existsSync(filePath)) {
          fs.rmSync(filePath, { force: true });
        }
      }
    }
  }

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
  const CLI_MAP = { gemini: 'gemini', claude: 'claude', codex: 'codex', antigravity: 'agy' };
  const cli = CLI_MAP[agent] ?? 'gemini';
  const prompt = `Steel Analyzer run: ${runId}\nGate: ${gateId}\nOwner question: ${question}\n\nAnswer concisely in the same language as the question.`;
  let result;
  if (cli === 'codex') {
    result = spawn('codex', ['exec', '-'], { input: prompt, timeout: 120_000, encoding: 'utf8' });
  } else {
    const args = cli === 'agy' ? ['--dangerously-skip-permissions', '-p', '-'] : ['-p', '-'];
    result = spawn(cli, args, { input: prompt, timeout: 120_000, encoding: 'utf8' });
  }
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr?.slice(0, 200) ?? 'unknown';
    throw new Error(`dispatchOpenChatQuestion failed (${cli}): ${detail}`);
  }
  return (result.stdout ?? '').trim() || '(no answer)';
}

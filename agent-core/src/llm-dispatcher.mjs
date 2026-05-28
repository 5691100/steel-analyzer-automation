import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { buildAnalysisPrompt } from './prompts/steel-analysis-prompt.mjs';
import { generateWorkbooks } from './workbook-generator.mjs';
import { verifyRunOutput } from './artifact-verifier.mjs';
import { generateDashboard } from './dashboard-generator.mjs';
import { callCodex } from './codex-runner.mjs';

function parseProjectInfo(folderName) {
  if (!folderName) return { project_no: 'Unknown', project_name: 'Unknown' };
  const match = folderName.match(/^([0-9/.-]+)\s+(.*)$/);
  if (match) {
    return { project_no: match[1], project_name: match[2] };
  }
  return { project_no: 'Unknown', project_name: folderName };
}

/**
 * Recursively collect all files matching a predicate from a directory tree.
 */
function findFilesRecursive(dir, predicate) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findFilesRecursive(fullPath, predicate));
    } else if (predicate(entry.name)) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Extract the outermost balanced JSON object from text that may contain
 * chain-of-thought, markdown fences, or other non-JSON content.
 * Returns the parsed object or throws.
 */
function extractJsonFromText(text) {
  // Strategy 1: Try the whole text as JSON
  try {
    return JSON.parse(text);
  } catch { /* continue */ }

  // Strategy 2: Find the first { and match to the last corresponding }
  const firstBrace = text.indexOf('{');
  if (firstBrace === -1) throw new Error('No JSON object found in output');

  // Find matching closing brace by counting depth
  let depth = 0;
  let lastClose = -1;
  for (let i = firstBrace; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) lastClose = i;
    }
  }

  if (lastClose === -1) throw new Error('No balanced JSON object found in output');

  const candidate = text.slice(firstBrace, lastClose + 1);
  try {
    return JSON.parse(candidate);
  } catch { /* continue */ }

  // Strategy 3: Try the LAST large JSON block (Gemini may output thinking, then JSON)
  // Find all { positions and try from the last one
  for (let start = text.lastIndexOf('{"schema"'); start >= 0; start = text.lastIndexOf('{"schema"', start - 1)) {
    depth = 0;
    for (let i = start; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(start, i + 1));
          } catch { break; }
        }
      }
    }
  }

  // Strategy 4: Strip markdown code fences and try again
  const fenced = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch { /* continue */ }
  }

  throw new Error(`Could not extract valid JSON from output (${text.length} chars)`);
}

export async function dispatchClaudeAnalysis(runId, runDir, sourcesDir, {
  spawn = spawnSync,
  generate = generateWorkbooks,
  generateDash = generateDashboard,
  verify = verifyRunOutput,
  customComment = null,
  maxRetries = 1
} = {}) {
  // Recursively convert PDFs to text if .txt counterparts are missing
  const allPdfs = findFilesRecursive(sourcesDir, f => f.toLowerCase().endsWith('.pdf'));
  for (const pdfPath of allPdfs) {
    const txtPath = pdfPath.replace(/\.pdf$/i, '.txt');
    if (!fs.existsSync(txtPath)) {
      const r = spawnSync('pdftotext', [pdfPath, txtPath], { encoding: 'utf8' });
      if (r.status !== 0) console.warn(`pdftotext failed for ${pdfPath}: ${r.stderr}`);
    }
  }

  const MAX_SOURCE_CHARS = 80_000;
  const MAX_DRAWING_CHARS = 20_000;
  const MAX_TOTAL_PROMPT_CHARS = 160_000; // stay within standard Claude context
  const DRAWING_PATTERN = /teräs(?:kokoonpanot|osakuvat)/i;
  // Low-priority files to skip if total budget is tight (legal/contract docs)
  const SKIP_PATTERN = /yse.{0,10}(1998|eng)|construction.contract.programme/i;

  // File priority: BOM/material lists > RFQ/structural > drawings > other
  function filePriority(name) {
    const n = name.toLowerCase();
    if (/material.list|bom|teräsluettelo|stückliste/.test(n)) return 0;
    if (/rfq|request.for.quot|tarjouspyyntö/.test(n)) return 1;
    if (/\.(xlsx|csv)\.txt$/.test(n)) return 1;
    if (/drawing|piirustus|teräs/.test(n)) return 2;
    if (/\.dwg\.txt$|\.ifc\.txt$/.test(n)) return 3;
    return 2;
  }

  // Recursively find all .txt files in sources and subdirectories
  const allTxtPaths = findFilesRecursive(sourcesDir, f => f.endsWith('.txt'));

  // Per-file truncation
  const candidates = [];
  for (const txtPath of allTxtPaths) {
    const relName = path.relative(sourcesDir, txtPath);
    if (SKIP_PATTERN.test(relName)) {
      console.warn(`Skipping low-priority file: ${relName}`);
      continue;
    }
    let text = fs.readFileSync(txtPath, 'utf8');
    const limit = DRAWING_PATTERN.test(relName) ? MAX_DRAWING_CHARS : MAX_SOURCE_CHARS;
    if (text.length > limit) {
      console.warn(`Truncating ${relName} (${text.length} chars → ${limit})`);
      text = text.slice(0, limit) + '\n[TRUNCATED]';
    }
    candidates.push({ relName, text, priority: filePriority(relName) });
  }

  // Sort by priority, then fill up to global budget
  candidates.sort((a, b) => a.priority - b.priority);
  const sourceTexts = {};
  let totalChars = 0;
  for (const { relName, text, priority } of candidates) {
    if (totalChars + text.length > MAX_TOTAL_PROMPT_CHARS) {
      console.warn(`Global budget reached — skipping ${relName} (priority ${priority}, ${text.length} chars)`);
      continue;
    }
    sourceTexts[relName] = text;
    totalChars += text.length;
  }

  if (Object.keys(sourceTexts).length === 0) {
    throw new Error(`No .txt source files found in ${sourcesDir} or its subdirectories. Check that msg/zip extraction and PDF conversion completed.`);
  }
  console.log(`Included ${Object.keys(sourceTexts).length}/${candidates.length} source text files (${totalChars} chars total, budget ${MAX_TOTAL_PROMPT_CHARS})`);

  let prompt = buildAnalysisPrompt(runId, sourceTexts);
  if (customComment) {
    prompt += `\n\n⚠️ Дополнительные указания заказчика по этому проекту:\n${customComment}\n`;
  }

  // Check for previous QA feedback to perform corrections
  const qaPath = path.join(runDir, 'qa-result.json');
  if (fs.existsSync(qaPath)) {
    try {
      const qaResult = JSON.parse(fs.readFileSync(qaPath, 'utf8'));
      if (qaResult.verdict === 'BLOCKED' && qaResult.notes) {
        prompt += `\n\n⚠️ ВНИМАНИЕ: Предыдущий анализ был отклонен QA-рецензентом (ClaudeClaw) со следующими замечаниями:\n\n--- НАЧАЛО ЗАМЕЧАНИЙ ClaudeClaw ---\n${qaResult.notes}\n--- КОНЕЦ ЗАМЕЧАНИЙ ClaudeClaw ---\n\nПожалуйста, исправьте ВСЕ указанные дефекты в новом отчете.\n`;
      }
    } catch (err) {
      console.warn(`Warning: Could not read previous QA result: ${err.message}`);
    }
  }

  const promptChars = prompt.length;
  let analysis;
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      console.log(`Retry ${attempt}/${maxRetries} for Claude analysis...`);
    }

    console.log(`Dispatching Claude analysis for run ${runId} (prompt: ${promptChars} chars, attempt ${attempt + 1})...`);
    const dispatchStart = Date.now();
    const result = spawn('claude', ['-p', '-'], {
      input: prompt,
      timeout: 4_200_000,
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
      cwd: '/tmp'
    });
    const elapsedSec = ((Date.now() - dispatchStart) / 1000).toFixed(1);
    const stdoutBytes = (result.stdout ?? '').length;
    const stderrBytes = (result.stderr ?? '').length;
    console.log(`claude finished: status=${result.status ?? 'null'} elapsed=${elapsedSec}s stdout=${stdoutBytes}B stderr=${stderrBytes}B`);

    // Always persist claude output for post-mortem analysis
    const claudeLogPath = path.join(runDir, `claude-run${attempt > 0 ? `-retry${attempt}` : ''}.log`);
    const logHeader = `=== claude run ${runId} (attempt ${attempt + 1}) ===\nstart: ${new Date(dispatchStart).toISOString()}\nelapsed: ${elapsedSec}s\nstatus: ${result.status ?? 'null'}\nprompt_chars: ${promptChars}\nstdout_bytes: ${stdoutBytes}\nstderr_bytes: ${stderrBytes}\n\n--- STDOUT ---\n`;
    const logFooter = stderrBytes > 0 ? `\n\n--- STDERR ---\n${result.stderr}` : '';
    fs.writeFileSync(claudeLogPath, logHeader + (result.stdout ?? '') + logFooter, 'utf8');

    if (result.error) {
      lastError = result.error;
      continue;
    }

    const stdout = (result.stdout ?? '').trim();
    try {
      analysis = extractJsonFromText(stdout);
      break; // Success
    } catch (err) {
      lastError = new Error(`Failed to parse Claude JSON output (attempt ${attempt + 1}). Raw output saved to ${claudeLogPath}. Error: ${err.message}`);
      console.warn(lastError.message);
      if (attempt < maxRetries) {
        console.log(`Will retry in 10 seconds...`);
        await new Promise(r => setTimeout(r, 10_000));
      }
    }
  }

  if (!analysis) {
    throw lastError || new Error('Claude analysis failed: no valid JSON output after retries');
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
  const analysisPath = path.join(runDir, 'analysis.json');
  fs.writeFileSync(analysisPath, JSON.stringify(analysis, null, 2), 'utf8');

  await generateDash(analysis, outputDir);

  const vResult = verify(runDir);
  if (!vResult.ok) {
    throw new Error(`Workbook verification failed: ${vResult.errors.join('; ')}`);
  }

  return vResult;
}

export async function dispatchOpenChatQuestion(runId, gateId, question, agent, { spawn = spawnSync } = {}) {
  const CLI_MAP = { gemini: 'gemini', claude: 'claude', codex: 'codex', antigravity: 'claude' };
  const cli = CLI_MAP[agent] ?? 'gemini';
  const prompt = `Steel Analyzer run: ${runId}\nGate: ${gateId}\nOwner question: ${question}\n\nAnswer concisely in the same language as the question.`;
  let result;
  if (cli === 'codex') {
    result = spawn('codex', ['exec', '-'], { input: prompt, timeout: 120_000, encoding: 'utf8' });
  } else {
    const args = ['-p', '-'];
    result = spawn(cli, args, { input: prompt, timeout: 120_000, encoding: 'utf8' });
  }
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr?.slice(0, 200) ?? 'unknown';
    throw new Error(`dispatchOpenChatQuestion failed (${cli}): ${detail}`);
  }
  return (result.stdout ?? '').trim() || '(no answer)';
}

export async function dispatchAntigravityQA(runId, runDir, { spawn = spawnSync } = {}) {
  const analysisPath = path.join(runDir, 'analysis.json');
  if (!fs.existsSync(analysisPath)) {
    return { verdict: 'BLOCKED', notes: 'analysis.json not found — nothing to verify' };
  }
  const analysisJson = fs.readFileSync(analysisPath, 'utf8');

  const prompt = `You are a QA reviewer for a steel structure analysis.
Review the following JSON analysis output and check for:
1. Missing or null weights where data should exist
2. Category assignment violations (profiles without categories)
3. Totals mismatches (sum of profile weights vs reported totals)
4. Empty subprojects array
5. Missing project_name or project_no

Return ONLY a JSON object with two fields:
- "verdict": "ACCEPTED" if no critical issues found, "BLOCKED" if critical issues exist
- "notes": brief description of findings (one line)

Analysis JSON:
${analysisJson}`;

  const result = spawn('claude', ['-p', '-'], {
    input: prompt,
    timeout: 900_000,
    encoding: 'utf8',
    cwd: '/tmp'
  });

  const qaLogPath = path.join(runDir, 'claude-qa.log');
  fs.writeFileSync(qaLogPath, `=== QA run ${runId} ===\nstatus: ${result.status}\n\n--- STDOUT ---\n${result.stdout ?? ''}\n--- STDERR ---\n${result.stderr ?? ''}`, 'utf8');

  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr?.slice(0, 200) ?? 'unknown';
    return { verdict: 'BLOCKED', notes: `claude QA process failed: ${detail}` };
  }

  const stdout = (result.stdout ?? '').trim();
  try {
    const jsonMatch = stdout.match(/\{[\s\S]*}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : stdout);
    const qaResult = {
      verdict: parsed.verdict === 'ACCEPTED' ? 'ACCEPTED' : 'BLOCKED',
      notes: parsed.notes || ''
    };
    fs.writeFileSync(path.join(runDir, 'qa-result.json'), JSON.stringify(qaResult, null, 2), 'utf8');
    return qaResult;
  } catch (err) {
    const fallback = { verdict: 'BLOCKED', notes: `Failed to parse QA JSON: ${err.message}` };
    fs.writeFileSync(path.join(runDir, 'qa-result.json'), JSON.stringify(fallback, null, 2), 'utf8');
    return fallback;
  }
}

export async function dispatchCodexReview(runId, runDir, { spawn, callCodexFn = callCodex } = {}) {
  const analysisPath = path.join(runDir, 'analysis.json');
  if (!fs.existsSync(analysisPath)) {
    return { verdict: 'NEEDS_FIXES', notes: 'analysis.json not found — nothing to review', proposals: [] };
  }
  const analysisJson = fs.readFileSync(analysisPath, 'utf8');

  const prompt = `You are a technical reviewer for a steel structure analysis pipeline (CodexClaw).
Review the following JSON analysis output and:
1. Check for critical errors: missing weights, wrong totals, invalid profile data
2. Identify ambiguities where standard assumptions were made or deviations from standard exist

Return ONLY a JSON object with three fields:
- "verdict": "APPROVED" if no critical errors, "NEEDS_FIXES" if critical errors exist
- "notes": brief summary of findings (one line, empty string if approved)
- "proposals": array of GEPA proposals for ambiguities/deviations (can be empty). Each proposal:
  {
    "id": "GEPA-001" (sequential),
    "description": "what needs owner decision",
    "drawing_ref": "optional drawing reference",
    "standard_assumption": "what standard says",
    "proposed_deviation": "what was assumed instead"
  }

Analysis JSON:
${analysisJson}`;

  // If a legacy spawn mock is provided, wrap it into callCodexFn for backwards compatibility
  const codexFn = spawn
    ? async (p, opts) => {
        const r = spawn('codex', ['exec', '-'], { input: p, timeout: opts?.timeout ?? 300_000, encoding: 'utf8' });
        return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', provider: 'codex', exitCode: r.status, error: r.error };
      }
    : callCodexFn;

  const result = await codexFn(prompt, { timeout: 300_000 });

  const reviewLogPath = path.join(runDir, 'codex-review.log');
  fs.writeFileSync(reviewLogPath, `=== Codex review ${runId} ===\nstatus: ${result.exitCode}\n\n--- STDOUT ---\n${result.stdout ?? ''}\n--- STDERR ---\n${result.stderr ?? ''}`, 'utf8');

  if (result.error || result.exitCode !== 0) {
    const detail = result.error?.message ?? result.stderr?.slice(0, 200) ?? 'unknown';
    return { verdict: 'NEEDS_FIXES', notes: `codex review process failed: ${detail}`, proposals: [] };
  }

  const stdout = (result.stdout ?? '').trim();
  try {
    const jsonMatch = stdout.match(/\{[\s\S]*}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : stdout);
    const reviewResult = {
      verdict: parsed.verdict === 'APPROVED' ? 'APPROVED' : 'NEEDS_FIXES',
      notes: parsed.notes || '',
      proposals: Array.isArray(parsed.proposals) ? parsed.proposals : []
    };
    fs.writeFileSync(path.join(runDir, 'codex-review.json'), JSON.stringify(reviewResult, null, 2), 'utf8');
    return reviewResult;
  } catch (err) {
    const fallback = { verdict: 'NEEDS_FIXES', notes: `Failed to parse Codex review JSON: ${err.message}`, proposals: [] };
    fs.writeFileSync(path.join(runDir, 'codex-review.json'), JSON.stringify(fallback, null, 2), 'utf8');
    return fallback;
  }
}

export function writeGepaRegister(runId, runDir, proposals) {
  const register = {
    schema: 'steel.gepa-register.v1',
    run_id: runId,
    proposals: proposals.map((p, i) => ({
      id: p.id || `GEPA-${String(i + 1).padStart(3, '0')}`,
      raised_by: 'codex',
      description: p.description || '',
      drawing_ref: p.drawing_ref,
      standard_assumption: p.standard_assumption,
      proposed_deviation: p.proposed_deviation,
      owner_decision: 'pending',
      raised_at: new Date().toISOString()
    })),
    updated_at: new Date().toISOString()
  };
  const registerPath = path.join(runDir, 'gepa-register.json');
  fs.writeFileSync(registerPath, JSON.stringify(register, null, 2), 'utf8');
  return registerPath;
}

export { extractJsonFromText };

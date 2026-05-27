import path from 'path';
import { callCodex } from './codex-runner.mjs';
import { readFile as fsReadFile, writeFile as fsWriteFile } from 'fs/promises';

/**
 * Run a GEPA (technical deviation/proposal) review via Codex.
 *
 * @param {string} runDir - Path to the run directory
 * @param {object} [deps] - Dependency injection for testing
 * @param {Function} [deps.readFile] - Override for fs.promises.readFile
 * @param {Function} [deps.writeFile] - Override for fs.promises.writeFile
 * @param {Function} [deps.callCodex] - Override for callCodex
 * @returns {Promise<{ verdict: string, reason?: string, proposals?: object[], gepaPath?: string, provider?: string }>}
 */
export async function runGepaReview(runDir, deps = {}) {
  const readFile = deps.readFile ?? fsReadFile;
  const writeFile = deps.writeFile ?? fsWriteFile;
  const callCodexFn = deps.callCodex ?? callCodex;

  // Read analysis.json
  let analysisJson;
  try {
    analysisJson = await readFile(path.join(runDir, 'analysis.json'), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error('analysis.json not found');
    throw err;
  }

  // Read self-checklist.json
  let checklistJson;
  try {
    checklistJson = await readFile(path.join(runDir, 'self-checklist.json'), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error('self-checklist.json not found');
    throw err;
  }

  const runId = path.basename(runDir);

  const prompt = `You are CodexClaw, a technical reviewer for a steel structure analysis pipeline.
Review the analysis and self-checklist below and identify any ambiguities, deviations from standards, or engineering proposals (GEPA) that require owner decisions.

Return ONLY a JSON object with one field:
- "proposals": array of GEPA proposals. Each proposal:
  {
    "id": "GEPA-001" (sequential),
    "description": "what needs owner decision",
    "drawing_ref": "optional drawing reference or null",
    "severity": "low|medium|high",
    "standard_assumption": "what standard says",
    "proposed_deviation": "what was assumed instead"
  }

Analysis JSON:
${analysisJson}

Self-checklist JSON:
${checklistJson}`;

  const result = await callCodexFn(prompt, { timeout: 300_000 });

  // Handle error exit
  if (result.exitCode !== 0) {
    return { verdict: 'WARN', reason: 'codex-error' };
  }

  // Handle empty stdout
  const stdout = (result.stdout ?? '').trim();
  if (!stdout) {
    return { verdict: 'WARN', reason: 'empty-stdout' };
  }

  // Parse JSON
  let parsed;
  try {
    const jsonMatch = stdout.match(/\{[\s\S]*}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : stdout);
  } catch {
    return { verdict: 'WARN', reason: 'parse-error' };
  }

  const proposals = Array.isArray(parsed.proposals)
    ? parsed.proposals.map(p => ({
        ...p,
        raised_by: result.provider,
        owner_decision: null,
        raised_at: new Date().toISOString()
      }))
    : [];

  const register = {
    schema: 'steel.gepa-register.v1',
    run_id: runId,
    verdict: 'OK',
    proposals,
    updated_at: new Date().toISOString()
  };

  const gepaPath = path.join(runDir, 'gepa-register.json');
  await writeFile(gepaPath, JSON.stringify(register, null, 2), 'utf8');

  return {
    verdict: 'OK',
    proposals,
    gepaPath,
    provider: result.provider
  };
}

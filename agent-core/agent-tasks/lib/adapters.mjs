import child_process from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function codexAdapter(task, promptPath) {
  const result = child_process.spawnSync('codex', [
    'exec', '--full-auto', '-m', 'gpt-5.5',
    '-c', 'model_reasoning_effort=high', fs.readFileSync(promptPath, 'utf8')
  ], {
    cwd: task.cwd,
    timeout: (task.timeout_sec || 600) * 1000,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  });
  return { stdout: result.stdout || '', exitCode: result.status };
}

export function geminiAdapter(task, promptPath) {
  const result = child_process.spawnSync('gemini', [
    '-p', fs.readFileSync(promptPath, 'utf8')
  ], {
    cwd: task.cwd,
    timeout: (task.timeout_sec || 600) * 1000,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  });
  return { stdout: result.stdout || '', exitCode: result.status };
}

export function claudeAdapter(task, promptPath) {
  const result = child_process.spawnSync('claude', [
    '-p', fs.readFileSync(promptPath, 'utf8')
  ], {
    cwd: task.cwd,
    timeout: (task.timeout_sec || 600) * 1000,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  });
  return { stdout: result.stdout || '', exitCode: result.status };
}

export function injectSentinel(promptPath) {
  const content = fs.readFileSync(promptPath, 'utf8');
  const sentinelBlock = `
---
IMPORTANT: End your response with a result block in this exact format:
<<<POS_RESULT>>>
{"verdict":"APPROVE","findings":[]}
<<<END>>>
Do not add any text after <<<END>>>.
`;
  const tempPath = promptPath + '.tmp';
  fs.writeFileSync(tempPath, content + sentinelBlock);
  return tempPath;
}

export function parseVerdict(stdout) {
  const match = stdout.match(/<<<POS_RESULT>>>\s*([\s\S]*?)\s*<<<END>>>/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

export const ADAPTER_MAP = {
  codex: codexAdapter,
  gemini: geminiAdapter,
  claude: claudeAdapter
};

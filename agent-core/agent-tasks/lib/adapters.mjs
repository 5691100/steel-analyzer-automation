import child_process from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function codexAdapter(task, promptPath) {
  const prompt = fs.readFileSync(promptPath, 'utf8');
  const result = child_process.spawnSync('codex', [
    'exec', '--full-auto', '-m', 'gpt-5.5',
    '-c', 'model_reasoning_effort=high', '-'
  ], {
    input: prompt,
    cwd: task.cwd,
    timeout: (task.timeout_sec || 600) * 1000,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  });
  return { stdout: result.stdout || '', exitCode: result.status };
}

export function geminiAdapter(task, promptPath) {
  const prompt = fs.readFileSync(promptPath, 'utf8');
  const result = child_process.spawnSync('gemini', ['-p', '-'], {
    input: prompt,
    cwd: task.cwd,
    timeout: (task.timeout_sec || 600) * 1000,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  });
  return { stdout: result.stdout || '', exitCode: result.status };
}

export function claudeAdapter(task, promptPath) {
  const prompt = fs.readFileSync(promptPath, 'utf8');
  const result = child_process.spawnSync('claude', ['-p', '-'], {
    input: prompt,
    cwd: task.cwd,
    timeout: (task.timeout_sec || 600) * 1000,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  });
  return { stdout: result.stdout || '', exitCode: result.status };
}

export function injectSentinel(promptPath) {
  const content = fs.readFileSync(promptPath, 'utf8');
  const sentinelBlock = "\n---\nIMPORTANT: End your entire response with a result block in EXACTLY this format.\nNo text after <<<END>>>. Replace ... with your actual JSON:\n<<<POS_RESULT>>>\n{ \"verdict\": \"APPROVE|REQUEST_CHANGES|ACCEPTED|FAIL|ERROR\", \"findings\": [] }\n<<<END>>>\n";
  const tempPath = path.join(
    path.dirname(promptPath),
    'sentinel-' + crypto.randomBytes(6).toString('hex') + '.tmp'
  );
  fs.writeFileSync(tempPath, content + sentinelBlock);
  return tempPath;
}

export function parseVerdict(stdout) {
  const regex = /<<<POS_RESULT>>>\s*([\s\S]*?)\s*<<<END>>>/g;
  let match, last;
  while ((match = regex.exec(stdout)) !== null) last = match;
  if (!last) return null;
  try {
    return JSON.parse(last[1]);
  } catch {
    return null;
  }
}

export const ADAPTER_MAP = {
  codex: codexAdapter,
  gemini: geminiAdapter,
  claude: claudeAdapter
};

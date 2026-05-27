import { spawnSync } from 'child_process';

/**
 * Call Codex with a fallback to Claude if Codex is unavailable.
 *
 * @param {string} prompt - The prompt to send via stdin
 * @param {object} opts
 * @param {number} [opts.timeout=30000] - Timeout in ms
 * @param {object} [opts.deps] - Dependency injection for testing
 * @param {Function} [opts.deps.spawnSync] - Override for spawnSync
 * @returns {Promise<{ stdout: string, stderr: string, provider: 'codex'|'claude', exitCode: number|null }>}
 */
export async function callCodex(prompt, opts = {}) {
  const spawnFn = opts.deps?.spawnSync ?? spawnSync;
  const timeout = opts.timeout ?? 30000;

  const result = spawnFn('codex', ['exec', '-'], {
    input: prompt,
    encoding: 'utf8',
    timeout,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const codexUnavailable =
    result.error?.code === 'ENOENT' ||
    result.status === null ||
    (typeof result.stderr === 'string' && (
      result.stderr.includes('command not found') ||
      result.stderr.includes('No such file')
    ));

  if (codexUnavailable) {
    const fallback = spawnFn('claude', ['--dangerously-skip-permissions', '-p', '-'], {
      input: prompt,
      encoding: 'utf8',
      timeout,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return {
      stdout: fallback.stdout ?? '',
      stderr: fallback.stderr ?? '',
      provider: 'claude',
      exitCode: fallback.status
    };
  }

  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    provider: 'codex',
    exitCode: result.status
  };
}

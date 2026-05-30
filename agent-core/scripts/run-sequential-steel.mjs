#!/usr/bin/env node

/**
 * run-sequential-steel.mjs
 *
 * Batch sequential runner for Steel Analyzer pipeline.
 * Runs projects from a JSON queue with 10-minute delay between runs.
 *
 * Usage:
 *   node run-sequential-steel.mjs <queue.json> [--interval-ms <ms>] [--dry-run]
 *
 * Queue file format:
 * [
 *   { "folderId": "abc123", "comment": "Optional project notes" },
 *   { "folderId": "def456" }
 * ]
 *
 * All gates are auto-approved. No Telegram notifications.
 * QA verification uses Claude (ClaudeClaw) only.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { runPipeline } from '../src/pipeline-runner.mjs';
import { dispatchClaudeAnalysis, dispatchAntigravityQA } from '../src/llm-dispatcher.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const AGENT_CORE = resolve(__dirname, '..');
const RUNS_DIR = join(AGENT_CORE, 'steel-bus/runs');
const LOG_DIR = join(AGENT_CORE, 'logs');

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function generateRunId() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const suffix = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `steel-${date}-${suffix}`;
}

function createLogger(logPath) {
  const stream = fs.createWriteStream(logPath, { flags: 'a' });
  return {
    log(msg) {
      const ts = new Date().toISOString();
      const line = `[${ts}] ${msg}`;
      console.log(line);
      stream.write(line + '\n');
    },
    close() {
      stream.end();
    }
  };
}

async function main() {
  const args = process.argv.slice(2);
  const queuePath = args.find(a => !a.startsWith('--'));
  const dryRun = args.includes('--dry-run');
  const intervalIdx = args.indexOf('--interval-ms');
  const intervalMs = intervalIdx >= 0 ? parseInt(args[intervalIdx + 1], 10) : DEFAULT_INTERVAL_MS;
  const delayIdx = args.indexOf('--start-delay-ms');
  const startDelayMs = delayIdx >= 0 ? parseInt(args[delayIdx + 1], 10) : 0;

  if (!queuePath) {
    console.error('Usage: node run-sequential-steel.mjs <queue.json> [--interval-ms <ms>] [--start-delay-ms <ms>] [--dry-run]');
    process.exit(1);
  }

  if (!fs.existsSync(queuePath)) {
    console.error(`Queue file not found: ${queuePath}`);
    process.exit(1);
  }

  const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
  if (!Array.isArray(queue) || queue.length === 0) {
    console.error('Queue must be a non-empty JSON array');
    process.exit(1);
  }

  // Ensure log directory exists
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const logPath = join(LOG_DIR, `sequential-${new Date().toISOString().slice(0, 10)}.log`);
  const logger = createLogger(logPath);

  logger.log(`=== Sequential Steel Analyzer ===`);
  logger.log(`Queue: ${queuePath} (${queue.length} projects)`);
  logger.log(`Interval: ${intervalMs / 60000} min`);
  logger.log(`Start Delay: ${startDelayMs / 60000} min`);
  logger.log(`Dry run: ${dryRun}`);
  logger.log(`Log file: ${logPath}`);
  logger.log('');

  if (startDelayMs > 0) {
    logger.log(`⏱ Waiting ${(startDelayMs / 60000).toFixed(1)} min before starting the first project...`);
    if (!dryRun) {
      await sleep(startDelayMs);
    }
  }

  // Console-only notification function (suppresses Telegram)
  const notifyFn = async (text) => {
    logger.log(`[notify] ${text.replace(/<[^>]+>/g, '')}`);
  };

  // Auto-approve all gates
  const waitForGate = async (_runId, gateId) => {
    logger.log(`[gate] Auto-approving ${gateId}`);
    return 'approve';
  };

  const makeGateKb = () => ({ inline_keyboard: [] });

  const results = [];

  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    const { folderId, comment } = item;
    const runId = generateRunId();
    const startTime = Date.now();

    logger.log(`--- Project ${i + 1}/${queue.length} ---`);
    logger.log(`Folder ID: ${folderId}`);
    logger.log(`Run ID: ${runId}`);
    if (comment) logger.log(`Comment: ${comment}`);

    if (dryRun) {
      logger.log('[DRY RUN] Skipping actual pipeline execution');
      results.push({ runId, folderId, status: 'dry-run', elapsed: 0 });
    } else {
      try {
        // Create run directory
        const runDir = join(RUNS_DIR, runId);
        fs.mkdirSync(runDir, { recursive: true });

        // Wrap doAnalysis to pass customComment
        const doAnalysis = async (rid, rDir, srcDir) => {
          return dispatchClaudeAnalysis(rid, rDir, srcDir, { customComment: comment || null });
        };

        // Custom QA function that routes to ClaudeClaw and polls for the response
        const doQA = async (rid, rDir) => {
          let folderName = 'Unknown';
          const manifestPath = path.join(rDir, 'manifest-drive-download.json');
          if (fs.existsSync(manifestPath)) {
            try {
              const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
              folderName = manifest.drive_folder_name || manifest.folder_id || 'Unknown';
            } catch (e) {
              // ignore
            }
          }

          const runData = {
            run_id: rid,
            project_name: folderName,
            delivery_mode: 'procurement-grade',
            requested_by: 'operator',
            state: 'claude_review_requested',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };

          const taskFile = `/root/ClaudeClaw/workspace/inbox/steel-review-${rid}.json`;
          const signalOutput = join(AGENT_CORE, `steel-bus/inbox/review-complete/${rid}.json`);

          const taskPayload = {
            task: 'steel-review',
            run_id: rid,
            schema_path: '/root/agent-core/schemas/steel-review-result.schema.json',
            signal_output: signalOutput,
            run_data: runData,
            created_at: new Date().toISOString(),
          };

          // Ensure folders exist
          fs.mkdirSync(path.dirname(taskFile), { recursive: true });
          fs.mkdirSync(path.dirname(signalOutput), { recursive: true });

          // Atomic write
          const tempTaskFile = `${taskFile}.tmp`;
          fs.writeFileSync(tempTaskFile, JSON.stringify(taskPayload, null, 2), 'utf8');
          fs.renameSync(tempTaskFile, taskFile);

          logger.log(`[ClaudeClaw Review] Written task payload to ${taskFile}`);

          // Polling loop
          const maxWaitMs = 120 * 60 * 1000; // 2 hours timeout
          const pollIntervalMs = 5000; // 5 seconds
          const startTimePoll = Date.now();

          logger.log(`[ClaudeClaw Review] Polling for review result at ${signalOutput}...`);

          while (Date.now() - startTimePoll < maxWaitMs) {
            if (fs.existsSync(signalOutput)) {
              try {
                const signalContent = fs.readFileSync(signalOutput, 'utf8');
                const signal = JSON.parse(signalContent);

                if (signal.verdict) {
                  logger.log(`[ClaudeClaw Review] Verdict received: ${signal.verdict}`);
                  const mappedVerdict = (signal.verdict === 'PASS' || signal.verdict === 'ACCEPTED' || signal.verdict === 'APPROVE') ? 'ACCEPTED' : 'BLOCKED';
                  
                  let notes = 'Claude QA Review completed.';
                  if (signal.issues && signal.issues.length > 0) {
                    notes += '\nIssues found:\n' + signal.issues.map(i => `[${i.stage}] ${i.description} (${i.evidence || ''})`).join('\n');
                  }

                  // Save qa-result.json to runs folder
                  const qaResult = {
                    verdict: mappedVerdict,
                    notes: notes
                  };
                  fs.writeFileSync(path.join(rDir, 'qa-result.json'), JSON.stringify(qaResult, null, 2), 'utf8');

                  // Clean up the signal file so subsequent runs are clean
                  try {
                    fs.unlinkSync(signalOutput);
                  } catch (e) {
                    // ignore
                  }

                  return qaResult;
                }
              } catch (err) {
                logger.log(`[ClaudeClaw Review] Error reading/parsing signal: ${err.message}`);
              }
            }
            await sleep(pollIntervalMs);
          }

          throw new Error(`ClaudeClaw review timed out after ${maxWaitMs / 60000} minutes`);
        };

        await runPipeline(runId, folderId, notifyFn, {
          doAnalysis,
          doQA,
          waitForGate,
          makeGateKb,
          runsDir: RUNS_DIR,
        });

        const elapsed = Math.round((Date.now() - startTime) / 1000);
        logger.log(`✅ Project ${i + 1} completed in ${elapsed}s`);
        results.push({ runId, folderId, status: 'success', elapsed });
      } catch (err) {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        logger.log(`❌ Project ${i + 1} failed after ${elapsed}s: ${err.message}`);
        results.push({ runId, folderId, status: 'failed', elapsed, error: err.message });
      }
    }

    // Wait for fixed delay (from completion of current run)
    if (i < queue.length - 1) {
      logger.log(`⏱ Waiting ${(intervalMs / 60000).toFixed(1)} min before next project...`);
      await sleep(intervalMs);
    }
  }

  // Summary
  logger.log('');
  logger.log('=== Summary ===');
  for (const r of results) {
    logger.log(`${r.status === 'success' ? '✅' : r.status === 'dry-run' ? '⏭' : '❌'} ${r.runId} (${r.folderId}) — ${r.status} [${r.elapsed}s]`);
  }
  logger.log(`Total: ${results.filter(r => r.status === 'success').length}/${queue.length} succeeded`);
  logger.close();

  // Write results summary
  const summaryPath = join(LOG_DIR, `sequential-results-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(summaryPath, JSON.stringify(results, null, 2), 'utf8');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

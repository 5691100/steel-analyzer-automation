#!/usr/bin/env node

/**
 * run-sequential-steel.mjs
 *
 * Batch sequential runner for Steel Analyzer pipeline.
 * Runs projects from a JSON queue with 2-hour fixed-interval scheduling.
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
 * QA verification uses local Antigravity (agy) only.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { runPipeline } from '../src/pipeline-runner.mjs';
import { dispatchGeminiAnalysis, dispatchAntigravityQA } from '../src/llm-dispatcher.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const AGENT_CORE = resolve(__dirname, '..');
const RUNS_DIR = join(AGENT_CORE, 'steel-bus/runs');
const LOG_DIR = join(AGENT_CORE, 'logs');

const DEFAULT_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours

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

  if (!queuePath) {
    console.error('Usage: node run-sequential-steel.mjs <queue.json> [--interval-ms <ms>] [--dry-run]');
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
  logger.log(`Dry run: ${dryRun}`);
  logger.log(`Log file: ${logPath}`);
  logger.log('');

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
          return dispatchGeminiAnalysis(rid, rDir, srcDir, { customComment: comment || null });
        };

        await runPipeline(runId, folderId, notifyFn, {
          doAnalysis,
          doQA: dispatchAntigravityQA,
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

    // Wait for fixed interval (from start of current run)
    if (i < queue.length - 1) {
      const elapsed = Date.now() - startTime;
      const delay = Math.max(0, intervalMs - elapsed);
      if (delay > 0) {
        logger.log(`⏱ Waiting ${(delay / 60000).toFixed(1)} min before next project...`);
        await sleep(delay);
      } else {
        logger.log(`⏱ Run exceeded interval, starting next immediately`);
      }
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

#!/usr/bin/env node
/**
 * Steel Analyzer Orchestrator
 *
 * Usage:
 *   node steel-orchestrator.mjs          — run the file-bus watcher
 *   node steel-orchestrator.mjs status   — print status of all runs
 *   node steel-orchestrator.mjs init <run_id> <project_name> <delivery_mode>
 *                                        — create a new run (writes run-request signal)
 */

import { watch } from "fs";
import {
  readFileSync, writeFileSync, readdirSync, existsSync,
  mkdirSync, renameSync, statSync,
} from "fs";
import { resolve, join, basename } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { spawnSync } from "child_process";

const ROOT = resolve(dirname(), "..");
const BUS_ROOT = join(ROOT, "steel-bus");
const INBOX = join(BUS_ROOT, "inbox");
const RUNS = join(BUS_ROOT, "runs");
const DEAD_LETTER = join(BUS_ROOT, "dead-letter");

import {
  transition, transitionSequence, deriveState,
  stateLabel, isTerminal, isOwnerBlocked, SIGNAL_ROUTING,
} from "../steel-bus/lib/state-machine.mjs";

import {
  addProposals, checkAllDecided, recordDecision, summary as gepaSummary,
} from "../steel-bus/lib/gepa-register.mjs";

function dirname() {
  return fileURLToPath(new URL(".", import.meta.url));
}

// ── Ledger helpers ─────────────────────────────────────────────────────────

function ledgerPath(runId) {
  return join(RUNS, runId, "ledger.jsonl");
}

function readLedger(runId) {
  const p = ledgerPath(runId);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function appendLedger(runId, entry) {
  const p = ledgerPath(runId);
  mkdirSync(join(RUNS, runId), { recursive: true });
  const line = JSON.stringify({ ...entry, ts: new Date().toISOString() }) + "\n";
  // Atomic append via temp+rename is tricky for appends; use exclusive open pattern
  // For single-run (current scope), plain append is safe.
  writeFileSync(p, line, { flag: "a" });
}

// ── Run directory helpers ──────────────────────────────────────────────────

function ensureRunDir(runId) {
  const dirs = ["sources", "logs", "qa", "artifacts"];
  for (const d of dirs) mkdirSync(join(RUNS, runId, d), { recursive: true });
}

function writeRunJson(runId, data) {
  const p = join(RUNS, runId, "run.json");
  const tmp = p + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, p);
}

function readRunJson(runId) {
  const p = join(RUNS, runId, "run.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

// ── Signal file helpers ────────────────────────────────────────────────────

function atomicWrite(path, data) {
  const tmp = path + ".tmp";
  writeFileSync(tmp, typeof data === "string" ? data : JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

function moveToDeadLetter(signalPath, reason, runId = null) {
  const name = basename(signalPath);
  const dest = join(DEAD_LETTER, `${Date.now()}-${name}`);
  const meta = dest + ".reason.txt";
  try { renameSync(signalPath, dest); } catch {}
  writeFileSync(meta, reason);
  log(`DEAD_LETTER: ${name} — ${reason}`);
  if (runId) {
    const runData = readRunJson(runId);
    notify(runId, "dead_letter", { ...runData, dead_letter_reason: reason });
  }
}

// ── Task routing ───────────────────────────────────────────────────────────

function routeToRuntime(runId, state, runData, signal = null) {
  switch (state) {
    case "producer_handoff_done": {
      // Advance to review automatically
      appendLedger(runId, { from: "producer_handoff_done", to: "claude_review_requested", signal: "orchestrator-route", run_id: runId });
      const nextData = { ...runData, state: "claude_review_requested", updated_at: new Date().toISOString() };
      writeRunJson(runId, nextData);
      log(`Run ${runId}: producer_handoff_done → claude_review_requested (auto-advance)`);
      routeToRuntime(runId, "claude_review_requested", nextData, signal);
      break;
    }
    case "claude_review_requested": {
      const taskPath = "/root/ClaudeClaw/workspace/inbox";
      if (!existsSync(taskPath)) break;
      atomicWrite(join(taskPath, `steel-review-${runId}.json`), {
        task: "steel-review",
        run_id: runId,
        schema_path: join(ROOT, "schemas/steel-review-result.schema.json"),
        signal_output: join(INBOX, "review-complete", `${runId}.json`),
        run_data: runData,
        created_at: new Date().toISOString(),
      });
      log(`Routed review task to ClaudeClaw for run ${runId}`);
      break;
    }
    case "claude_review_passed": {
      // Advance to integration automatically
      appendLedger(runId, { from: "claude_review_passed", to: "codex_integration_requested", signal: "orchestrator-route", run_id: runId });
      const nextData = { ...runData, state: "codex_integration_requested", updated_at: new Date().toISOString() };
      writeRunJson(runId, nextData);
      log(`Run ${runId}: claude_review_passed → codex_integration_requested (auto-advance)`);
      routeToRuntime(runId, "codex_integration_requested", nextData, signal);
      break;
    }
    case "codex_integration_requested": {
      const taskPath = "/root/CODEXCLAW/workspace/inbox";
      if (!existsSync(taskPath)) break;
      atomicWrite(join(taskPath, `steel-integration-${runId}.json`), {
        task: "steel-integration",
        run_id: runId,
        schema_path: join(ROOT, "schemas/steel-integration-result.schema.json"),
        signal_output: join(INBOX, "integration-complete", `${runId}.json`),
        run_data: runData,
        created_at: new Date().toISOString(),
      });
      log(`Routed integration task to CodexClaw for run ${runId}`);
      break;
    }
    case "gepa_proposed": {
      // Write proposals to GEPA register
      if (signal && signal.gepa_proposals) {
        addProposals(runId, signal.integration_runtime ?? "system", signal.gepa_proposals);
      }
      const gepaSumm = gepaSummary(runId);
      log(`GEPA register updated for run ${runId}`);
      notify(runId, "gepa_proposed", { ...runData, gepa_summary: gepaSumm });
      break;
    }
    case "upload_ready": {
      // KI-6: all modes require explicit owner action via upload-approve command
      const notifyKey = runData.delivery_mode === "procurement-grade" ? "upload_ready_manual" : "upload_ready_standard";
      notify(runId, notifyKey, runData);
      break;
    }
    case "uploaded_verified": {
      // Advance to closed automatically if upload verified
      if (signal && signal.verification_status === "verified") {
        appendLedger(runId, { from: "uploaded_verified", to: "closed", signal: "auto-close", run_id: runId });
        writeRunJson(runId, { ...runData, state: "closed", updated_at: new Date().toISOString() });
        log(`Run ${runId}: uploaded_verified → closed`);
        notify(runId, "closed", { ...runData, web_view_link: signal.web_view_link });
      } else {
        moveToDeadLetter(join(INBOX, "upload-verified", `${runId}.json`), `MD5 mismatch or download failed: ${signal?.verification_status}`, runId);
      }
      break;
    }
    case "closed":
      notify(runId, "closed", runData);
      break;
  }
}

// ── Telegram notifications ─────────────────────────────────────────────────

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? process.env.ALLOWED_CHAT_ID ?? "";

// Riga timezone offset: UTC+3 (summer) / UTC+2 (winter)
// Using UTC+3 as conservative estimate for quiet hours check
function isQuietHours() {
  const rigaHour = (new Date().getUTCHours() + 3) % 24;
  return rigaHour >= 22 || rigaHour < 8;
}

async function sendTelegram(text, urgent = false) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    log(`[Telegram not configured] ${text.replace(/\n/g, " | ").slice(0, 120)}`);
    return;
  }
  if (!urgent && isQuietHours()) {
    log(`[Quiet hours — deferred] ${text.slice(0, 80)}`);
    return;
  }
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      log(`Telegram error ${res.status}: ${body.slice(0, 200)}`);
    }
  } catch (e) {
    log(`Telegram send failed: ${e.message}`);
  }
}

function notify(runId, event, runData) {
  const project = runData?.project_name ?? runId;
  const mode = runData?.delivery_mode ?? "standard";

  const messages = {
    gepa_proposed: [
      `⚠️ <b>GEPA approval required</b>`,
      `Run: <code>${runId}</code>`,
      `Project: ${project}`,
      ``,
      runData?.gepa_summary ?? "(see gepa-register.json)",
      ``,
      `Approve: <code>node steel-orchestrator.mjs gepa-approve ${runId} &lt;proposal_id&gt; &lt;rationale&gt;</code>`,
    ].join("\n"),

    upload_ready_manual: [
      `📋 <b>Upload approval required</b>`,
      `Run: <code>${runId}</code>`,
      `Project: ${project}`,
      `Delivery: <b>${mode}</b> — manual gate`,
      ``,
      `Approve: <code>node steel-orchestrator.mjs upload-approve ${runId}</code>`,
    ].join("\n"),

    upload_ready_standard: [
      `📦 <b>Ready to upload</b>`,
      `Run: <code>${runId}</code>`,
      `Project: ${project}`,
      ``,
      `Trigger: <code>node steel-orchestrator.mjs upload-approve ${runId}</code>`,
      `(Requires STEEL_DRIVE_CREDS or GWS_AUTH_PATH to be set)`,
    ].join("\n"),

    closed: [
      `✅ <b>Run closed</b>`,
      `Run: <code>${runId}</code>`,
      `Project: ${project}`,
      runData?.web_view_link ? `Drive: ${runData.web_view_link}` : "",
    ].filter(Boolean).join("\n"),

    dead_letter: [
      `❌ <b>Signal moved to Dead Letter</b>`,
      `Run: <code>${runId}</code>`,
      `Project: ${project}`,
      `Reason: <code>${runData?.dead_letter_reason ?? "Unknown"}</code>`,
    ].join("\n"),

    gepa_nudge: [
      `⏰ <b>GEPA waiting for your decision</b>`,
      `Run: <code>${runId}</code> — ${runData?.age_label ?? ""}`,
      `Project: ${project}`,
      ``,
      runData?.gepa_summary ?? "",
      ``,
      `Approve: <code>node steel-orchestrator.mjs gepa-approve ${runId} &lt;proposal_id&gt; &lt;rationale&gt;</code>`,
    ].filter(Boolean).join("\n"),

    system_stuck: [
      `🔴 <b>Run appears stuck (system issue, not waiting on you)</b>`,
      `Run: <code>${runId}</code> — stuck in <b>${runData?.stuck_state ?? "?"}</b> for ${runData?.age_label ?? "?"}`,
      `Project: ${project}`,
      `Check: <code>node steel-orchestrator.mjs status</code>`,
    ].join("\n"),
  };

  const text = messages[event] ?? `Steel run ${runId}: ${event}`;
  const urgent = event === "system_stuck";
  log(`NOTIFY [${event}]: ${runId}`);
  sendTelegram(text, urgent).catch(() => {});
}

// ── Stuck-run watchdog (Sprint 3) ─────────────────────────────────────────

const OWNER_BLOCKED_THRESHOLD_MS = 2 * 60 * 60 * 1000;  // 2h
const SYSTEM_STUCK_THRESHOLD_MS  = 4 * 60 * 60 * 1000;  // 4h
const WATCHDOG_INTERVAL_MS       = 5 * 60 * 1000;        // check every 5 min

// Per-run last-nudge timestamps to avoid repeated alerts in the same stuck state
const lastNudge = new Map(); // key: `${runId}:${state}` → Date

function isHeld(runId) {
  return existsSync(join(INBOX, "hold", `${runId}.json`));
}

async function checkStuckRuns() {
  if (!existsSync(RUNS)) return;

  const now = Date.now();
  let runDirs;
  try { runDirs = readdirSync(RUNS); } catch { return; }

  for (const runId of runDirs) {
    const runPath = join(RUNS, runId);
    let stat;
    try { stat = statSync(runPath); } catch { continue; }
    if (!stat.isDirectory() || runId === ".gitkeep") continue;

    const run = readRunJson(runId);
    if (!run) continue;

    const ledger = readLedger(runId);
    const state = deriveState(ledger);
    if (!state || isTerminal(state)) continue;
    if (isHeld(runId)) continue;

    const lastEntry = ledger[ledger.length - 1];
    const enteredAt = lastEntry?.ts ? new Date(lastEntry.ts).getTime() : null;
    if (!enteredAt) continue;
    const ageMs = now - enteredAt;
    const ageLabel = formatAge(ageMs);

    const nudgeKey = `${runId}:${state}`;
    const lastNudgeTs = lastNudge.get(nudgeKey);
    // Re-nudge at most once per threshold period
    if (lastNudgeTs && now - lastNudgeTs < OWNER_BLOCKED_THRESHOLD_MS) continue;

    const ownerBlocked = isOwnerBlocked(state);

    if (ownerBlocked && ageMs >= OWNER_BLOCKED_THRESHOLD_MS) {
      const gepaSumm = state === "gepa_proposed" ? gepaSummary(runId) : null;
      notify(runId, "gepa_nudge", {
        ...run,
        age_label: ageLabel,
        gepa_summary: gepaSumm,
      });
      lastNudge.set(nudgeKey, now);
      log(`WATCHDOG nudge (owner-blocked): run ${runId} in ${state} for ${ageLabel}`);
    } else if (!ownerBlocked && ageMs >= SYSTEM_STUCK_THRESHOLD_MS) {
      notify(runId, "system_stuck", {
        ...run,
        stuck_state: state,
        age_label: ageLabel,
      });
      lastNudge.set(nudgeKey, now);
      log(`WATCHDOG alert (system-stuck): run ${runId} in ${state} for ${ageLabel}`);
    }
  }
}

function startWatchdog() {
  // Ensure hold inbox dir exists
  mkdirSync(join(INBOX, "hold"), { recursive: true });
  log("Stuck-run watchdog started (owner-blocked: 2h, system-stuck: 4h, quiet hours: 22-08 Riga)");
  setInterval(() => { checkStuckRuns().catch((e) => log(`WATCHDOG error: ${e.message}`)); }, WATCHDOG_INTERVAL_MS);
  // Also run immediately on startup
  checkStuckRuns().catch((e) => log(`WATCHDOG startup check error: ${e.message}`));
}

// ── Signal processing ──────────────────────────────────────────────────────

async function processSignal(signalPath) {
  let signal;
  try {
    signal = JSON.parse(readFileSync(signalPath, "utf8"));
  } catch (e) {
    moveToDeadLetter(signalPath, `JSON parse error: ${e.message}`);
    return;
  }

  const schemaId = signal.schema;
  if (!schemaId) {
    moveToDeadLetter(signalPath, "Missing 'schema' field");
    return;
  }

  // New run creation
  if (schemaId === "steel.run-request.v1") {
    const runId = signal.run_id || randomUUID().replace(/-/g, "").slice(0, 12);
    // KI-7: defense-in-depth — reject if ledger already exists
    const existingLedger = join(RUNS, runId, "ledger.jsonl");
    if (existsSync(existingLedger)) {
      moveToDeadLetter(signalPath, `Run ${runId} already exists — duplicate init rejected`);
      return;
    }
    ensureRunDir(runId);
    writeRunJson(runId, {
      run_id: runId,
      project_name: signal.project_name,
      delivery_mode: signal.delivery_mode,
      requested_by: signal.requested_by,
      state: "requested",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    appendLedger(runId, { from: null, to: "requested", signal: schemaId });
    log(`New run created: ${runId} (${signal.project_name})`);
    renameSignalToProcessed(signalPath, runId);
    return;
  }

  // Existing run signal
  const runId = signal.run_id;
  if (!runId) {
    moveToDeadLetter(signalPath, "Missing 'run_id' field");
    return;
  }

  const ledger = readLedger(runId);
  const currentState = deriveState(ledger);

  if (!currentState) {
    moveToDeadLetter(signalPath, `No ledger found for run_id: ${runId}`, runId);
    return;
  }

  if (isTerminal(currentState)) {
    moveToDeadLetter(signalPath, `Run ${runId} is terminal (${currentState})`, runId);
    return;
  }

  const sequence = transitionSequence(currentState, schemaId, signal);
  if (sequence.length === 0 || sequence[0] === "dead_letter") {
    moveToDeadLetter(signalPath, `Cannot process ${schemaId} from state ${currentState}`, runId);
    return;
  }

  // Drive through the state sequence
  let prevState = currentState;
  for (const nextState of sequence) {
    appendLedger(runId, { from: prevState, to: nextState, signal: schemaId, run_id: runId });
    prevState = nextState;
  }

  const finalState = prevState;
  const runData = readRunJson(runId);
  writeRunJson(runId, {
    ...runData,
    state: finalState,
    delivery_mode: signal.delivery_mode ?? runData?.delivery_mode,
    updated_at: new Date().toISOString(),
  });

  log(`Run ${runId}: ${currentState} → ${finalState} (${schemaId})`);
  routeToRuntime(runId, finalState, { ...runData, state: finalState }, signal);
  renameSignalToProcessed(signalPath, runId);
}

function renameSignalToProcessed(signalPath, runId) {
  const name = basename(signalPath);
  const processedDir = join(RUNS, runId, "processed-signals");
  mkdirSync(processedDir, { recursive: true });
  try { renameSync(signalPath, join(processedDir, name)); } catch {}
}

// ── Inbox watcher ──────────────────────────────────────────────────────────

const INBOX_DIRS = [
  "run-request", "run-complete",
  "review-complete", "integration-complete",
  "upload-verified",
];

const processingQueue = [];
let processing = false;

async function drainQueue() {
  if (processing) return;
  processing = true;
  while (processingQueue.length > 0) {
    const path = processingQueue.shift();
    try { await processSignal(path); } catch (e) { log(`ERROR processing ${path}: ${e.message}`); }
  }
  processing = false;
}

function watchInbox() {
  for (const dir of INBOX_DIRS) {
    const dirPath = join(INBOX, dir);
    mkdirSync(dirPath, { recursive: true });

    // Process any existing signals on startup
    for (const file of readdirSync(dirPath)) {
      if (file.endsWith(".json") && !file.endsWith(".tmp")) {
        processingQueue.push(join(dirPath, file));
      }
    }

    watch(dirPath, (eventType, filename) => {
      if (!filename || !filename.endsWith(".json") || filename.endsWith(".tmp")) return;
      const full = join(dirPath, filename);
      if (existsSync(full)) {
        processingQueue.push(full);
        drainQueue().catch(console.error);
      }
    });

    log(`Watching: ${dirPath}`);
  }

  drainQueue().catch(console.error);
}

// ── Status command ─────────────────────────────────────────────────────────

function statusCommand() {
  if (!existsSync(RUNS)) {
    console.log("No runs found.");
    return;
  }

  const runDirs = readdirSync(RUNS).filter((d) => {
    const stat = statSync(join(RUNS, d));
    return stat.isDirectory() && d !== ".gitkeep";
  });

  if (runDirs.length === 0) {
    console.log("No runs found.");
    return;
  }

  const now = Date.now();
  const rows = [];

  for (const runId of runDirs) {
    const run = readRunJson(runId);
    if (!run) continue;

    const ledger = readLedger(runId);
    const state = deriveState(ledger) ?? run.state ?? "unknown";
    const updatedAt = run.updated_at ? new Date(run.updated_at) : null;
    const ageMs = updatedAt ? now - updatedAt.getTime() : null;
    const ageStr = ageMs == null ? "?" : formatAge(ageMs);
    const ownerBlocked = isOwnerBlocked(state);
    const terminal = isTerminal(state);

    rows.push({
      run_id: runId.slice(0, 16),
      project: (run.project_name ?? "?").slice(0, 24),
      mode: (run.delivery_mode ?? "?").slice(0, 12),
      state: stateLabel(state),
      age: ageStr,
      flag: ownerBlocked ? "⚠ OWNER" : terminal ? (state === "closed" ? "✓" : "✗") : "",
    });
  }

  // Print table
  const cols = ["run_id", "project", "mode", "state", "age", "flag"];
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c]).length)));
  const header = cols.map((c, i) => c.padEnd(widths[i])).join("  ");
  const sep = widths.map((w) => "-".repeat(w)).join("  ");

  console.log(`\nSteel Bus Status — ${new Date().toISOString()}`);
  console.log(sep);
  console.log(header);
  console.log(sep);
  for (const r of rows) {
    console.log(cols.map((c, i) => String(r[c]).padEnd(widths[i])).join("  "));
  }
  console.log(sep);
  console.log(`${rows.length} run(s)\n`);
}

function formatAge(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// ── Init command ───────────────────────────────────────────────────────────

function initCommand(args) {
  const [runId, projectName, deliveryMode] = args;
  if (!projectName || !deliveryMode) {
    console.error("Usage: steel-orchestrator.mjs init <run_id_prefix> <project_name> <standard|procurement-grade>");
    process.exit(1);
  }
  const deliveryModes = ["standard", "procurement-grade"];
  if (!deliveryModes.includes(deliveryMode)) {
    console.error(`delivery_mode must be one of: ${deliveryModes.join(", ")}`);
    process.exit(1);
  }
  // KI-7: reject if run already exists
  if (runId) {
    const ledgerFile = join(RUNS, runId, "ledger.jsonl");
    if (existsSync(ledgerFile)) {
      console.error(`Run ${runId} already exists. Use a new run_id or check status with: node steel-orchestrator.mjs status`);
      process.exit(1);
    }
  }
  const signalPath = join(INBOX, "run-request", `${runId ?? randomUUID().slice(0, 8)}-${Date.now()}.json`);
  atomicWrite(signalPath, {
    schema: "steel.run-request.v1",
    run_id: runId,
    project_name: projectName,
    delivery_mode: deliveryMode,
    requested_by: "operator",
    created_at: new Date().toISOString(),
  });
  console.log(`Run request written: ${signalPath}`);
}

// ── Logger ─────────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ── gepa-approve command ───────────────────────────────────────────────────

function gepaApproveCommand(args) {
  const [runId, proposalId, ...rationaleParts] = args;
  if (!runId || !proposalId) {
    console.error("Usage: steel-orchestrator.mjs gepa-approve <run_id> <proposal_id> [rationale]");
    process.exit(1);
  }
  const rationale = rationaleParts.join(" ") || "Approved by owner";
  recordDecision(runId, proposalId, "approved", "owner", rationale);
  console.log(`GEPA proposal ${proposalId} approved for run ${runId}`);

  // Check if all proposals decided → write gepa-reviewed signal
  const { allDecided, pendingCount } = checkAllDecided(runId);
  if (allDecided) {
    const signalPath = join(INBOX, "integration-complete", `${runId}-gepa-reviewed.json`);
    atomicWrite(signalPath, {
      schema: "steel.gepa-reviewed.v1",
      run_id: runId,
      reviewed_by: "owner",
      all_decided: true,
      created_at: new Date().toISOString(),
    });
    console.log(`All GEPA proposals decided — gepa-reviewed signal written`);
  } else {
    console.log(`${pendingCount} proposal(s) still pending`);
  }
}

// ── upload-approve command ─────────────────────────────────────────────────

function uploadApproveCommand(args) {
  const [runId] = args;
  if (!runId) {
    console.error("Usage: steel-orchestrator.mjs upload-approve <run_id>");
    process.exit(1);
  }

  // Credentials must be resolvable before any Drive call
  const credsEnv = process.env.STEEL_DRIVE_CREDS || process.env.GWS_AUTH_PATH;
  if (!credsEnv) {
    console.error("STEEL_DRIVE_CREDS (or GWS_AUTH_PATH) env var must be set for upload-approve");
    process.exit(1);
  }

  // Run must exist
  const lf = ledgerPath(runId);
  if (!existsSync(lf)) {
    console.error(`Run ${runId} not found. Check with: node steel-orchestrator.mjs status`);
    process.exit(1);
  }

  // Must be in upload_ready state
  const ledger = readLedger(runId);
  const state = deriveState(ledger);
  if (state !== "upload_ready") {
    console.error(`Run ${runId} is in state '${state}', expected 'upload_ready'`);
    process.exit(1);
  }

  // Read download manifest for drive_folder_id
  const manifestFile = join(RUNS, runId, "manifest-drive-download.json");
  if (!existsSync(manifestFile)) {
    console.error(`Download manifest not found: ${manifestFile}`);
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  const driveFolderId = manifest.drive_folder_id;
  if (!driveFolderId) {
    console.error("No drive_folder_id in download manifest");
    process.exit(1);
  }

  // Read output files from processed run-complete signal
  const processedDir = join(RUNS, runId, "processed-signals");
  let outputFiles = [];
  if (existsSync(processedDir)) {
    for (const sig of readdirSync(processedDir).filter(f => f.endsWith(".json"))) {
      try {
        const s = JSON.parse(readFileSync(join(processedDir, sig), "utf8"));
        if (s.schema === "steel.run-complete.v1" && Array.isArray(s.outputs)) {
          outputFiles = s.outputs.filter(o => o.kind === "workbook" && o.path).map(o => o.path);
          break;
        }
      } catch {}
    }
  }

  if (outputFiles.length === 0) {
    console.error(`No output workbooks found in processed signals for run ${runId}`);
    process.exit(1);
  }

  // Upload each output file via steel-drive.mjs
  const steelDrivePath = join(dirname(), "steel-drive.mjs");
  const uploadedFiles = [];

  for (const filePath of outputFiles) {
    if (!existsSync(filePath)) {
      console.error(`Output file not found: ${filePath}`);
      const runData = readRunJson(runId);
      notify(runId, "dead_letter", { ...runData, dead_letter_reason: `upload-approve: file not found: ${filePath}` });
      process.exit(1);
    }
    console.log(`Uploading ${filePath}...`);
    const result = spawnSync("node", [steelDrivePath, "upload", "--run", runId, "--folder", driveFolderId, "--file", filePath], {
      stdio: "inherit",
      env: process.env,
    });
    if (result.status !== 0) {
      console.error(`Upload failed for ${filePath} (exit ${result.status})`);
      const runData = readRunJson(runId);
      notify(runId, "dead_letter", { ...runData, dead_letter_reason: `upload-approve: Drive upload failed for ${basename(filePath)}` });
      process.exit(1);
    }
    uploadedFiles.push(filePath);
  }

  // All uploads succeeded — write upload-verified signal
  const signalPath = join(INBOX, "upload-verified", `${runId}.json`);
  atomicWrite(signalPath, {
    schema: "steel.upload-verified.v1",
    run_id: runId,
    verified_by: "upload-approve-command",
    verification_status: "verified",
    uploaded_files: uploadedFiles,
    drive_folder_id: driveFolderId,
    created_at: new Date().toISOString(),
  });
  console.log(`Upload verified — steel.upload-verified.v1 written`);
  console.log(`Signal: ${signalPath}`);
}

// ── Entry point ────────────────────────────────────────────────────────────

const [, , command, ...args] = process.argv;

if (command === "status") {
  statusCommand();
} else if (command === "init") {
  initCommand(args);
} else if (command === "gepa-approve") {
  gepaApproveCommand(args);
} else if (command === "upload-approve") {
  uploadApproveCommand(args);
} else {
  log("Steel Orchestrator starting...");
  log(`Bus root: ${BUS_ROOT}`);
  watchInbox();
  startWatchdog();
  log("Watching for signals. Press Ctrl-C to stop.");
}

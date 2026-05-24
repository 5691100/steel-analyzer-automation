/**
 * GEPA decision register — RFI-pattern for Steel Analyzer.
 * Each run has one gepa-register.json; proposals are appended, never overwritten.
 * Run cannot close while any proposal.owner_decision === "pending".
 */

import { readFileSync, writeFileSync, existsSync, renameSync } from "fs";
import { join } from "path";

const RUNS_ROOT = new URL("../runs/", import.meta.url).pathname;

function registerPath(runId) {
  return join(RUNS_ROOT, runId, "gepa-register.json");
}

function atomicWrite(path, data) {
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

function readRegister(runId) {
  const p = registerPath(runId);
  if (!existsSync(p)) {
    return {
      schema: "steel.gepa-register.v1",
      run_id: runId,
      proposals: [],
      updated_at: new Date().toISOString(),
    };
  }
  return JSON.parse(readFileSync(p, "utf8"));
}

/**
 * Add proposals from a review-result signal to the register.
 * @param {string} runId
 * @param {string} raisedBy - runtime that raised the proposals
 * @param {{ id: string, description: string, path?: string }[]} proposals
 */
export function addProposals(runId, raisedBy, proposals) {
  const register = readRegister(runId);
  const now = new Date().toISOString();
  for (const p of proposals) {
    if (register.proposals.find((r) => r.id === p.id)) continue; // idempotent
    register.proposals.push({
      id: p.id,
      raised_by: raisedBy,
      description: p.description,
      drawing_ref: p.drawing_ref ?? null,
      standard_assumption: p.standard_assumption ?? null,
      proposed_deviation: p.proposed_deviation ?? null,
      owner_decision: "pending",
      decided_by: null,
      decided_at: null,
      rationale: null,
      raised_at: now,
    });
  }
  register.updated_at = now;
  atomicWrite(registerPath(runId), register);
  return register;
}

/**
 * Record owner decision on a GEPA proposal.
 * @param {string} runId
 * @param {string} proposalId
 * @param {"approved"|"rejected"} decision
 * @param {string} decidedBy
 * @param {string} [rationale]
 */
export function recordDecision(runId, proposalId, decision, decidedBy, rationale = "") {
  const register = readRegister(runId);
  const proposal = register.proposals.find((p) => p.id === proposalId);
  if (!proposal) throw new Error(`GEPA proposal ${proposalId} not found in run ${runId}`);
  if (proposal.owner_decision !== "pending") {
    throw new Error(`Proposal ${proposalId} already decided: ${proposal.owner_decision}`);
  }
  proposal.owner_decision = decision;
  proposal.decided_by = decidedBy;
  proposal.decided_at = new Date().toISOString();
  proposal.rationale = rationale;
  register.updated_at = new Date().toISOString();
  atomicWrite(registerPath(runId), register);
  return register;
}

/**
 * Check if all GEPA proposals have been decided.
 * @param {string} runId
 * @returns {{ allDecided: boolean, pendingCount: number, pending: string[] }}
 */
export function checkAllDecided(runId) {
  const register = readRegister(runId);
  const pending = register.proposals
    .filter((p) => p.owner_decision === "pending")
    .map((p) => p.id);
  return {
    allDecided: pending.length === 0,
    pendingCount: pending.length,
    pending,
  };
}

/**
 * Return a human-readable summary of the GEPA register for Telegram notification.
 * @param {string} runId
 */
export function summary(runId) {
  const register = readRegister(runId);
  const total = register.proposals.length;
  const pending = register.proposals.filter((p) => p.owner_decision === "pending");
  const lines = [`GEPA Register — run ${runId}: ${total} proposal(s), ${pending.length} pending`];
  for (const p of pending) {
    lines.push(`  [${p.id}] ${p.description.slice(0, 80)}`);
    if (p.drawing_ref) lines.push(`    Drawing: ${p.drawing_ref}`);
    if (p.proposed_deviation) lines.push(`    Deviation: ${p.proposed_deviation}`);
  }
  return lines.join("\n");
}

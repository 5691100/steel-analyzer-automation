/**
 * Steel Analyzer state machine — pure functions only.
 * No I/O, no filesystem, no side effects.
 * Current state is always derived from the run's ledger.jsonl, never from memory.
 */

export const STATES = /** @type {const} */ ([
  "requested",
  "sources_manifested",
  "sources_downloaded",
  "extraction_done",
  "workbooks_generated",
  "workbooks_validated",
  "producer_handoff_done",
  "claude_review_requested",
  "claude_review_passed",
  "claude_review_blocked",
  "codex_integration_requested",
  "codex_integration_done",
  "gepa_proposed",
  "gepa_reviewed",
  "upload_ready",
  "uploaded_verified",
  "closed",
  "dead_letter",
]);

/** @typedef {typeof STATES[number]} State */

/**
 * Allowed transitions. dead_letter is always reachable from any non-terminal state.
 * Terminal states: closed, dead_letter.
 */
const TRANSITION_TABLE = /** @type {Record<State, State[]>} */ ({
  requested:                  ["sources_manifested", "dead_letter"],
  sources_manifested:         ["sources_downloaded", "dead_letter"],
  sources_downloaded:         ["extraction_done", "dead_letter"],
  extraction_done:            ["workbooks_generated", "dead_letter"],
  workbooks_generated:        ["workbooks_validated", "dead_letter"],
  workbooks_validated:        ["producer_handoff_done", "dead_letter"],
  producer_handoff_done:      ["claude_review_requested", "dead_letter"],
  claude_review_requested:    ["claude_review_passed", "claude_review_blocked", "dead_letter"],
  claude_review_passed:       ["codex_integration_requested", "dead_letter"],
  claude_review_blocked:      ["claude_review_requested", "dead_letter"],
  codex_integration_requested:["codex_integration_done", "dead_letter"],
  codex_integration_done:     ["gepa_proposed", "upload_ready", "dead_letter"],
  gepa_proposed:              ["gepa_reviewed", "dead_letter"],
  gepa_reviewed:              ["upload_ready", "dead_letter"],
  upload_ready:               ["uploaded_verified", "dead_letter"],
  uploaded_verified:          ["closed"],
  closed:                     [],
  dead_letter:                [],
});

/**
 * Signal type → allowed source states + target state resolver.
 * resolver receives the signal payload and returns the target state.
 */
export const SIGNAL_ROUTING = /** @type {Record<string, {from: State[], to: (signal: object, currentState: State) => State}>} */ ({
  "steel.run-request.v1": {
    from: [],
    to: () => "requested",
  },
  "steel.run-complete.v1": {
    from: ["producer_handoff_done"],
    // Orchestrator drives through workbooks_generated → workbooks_validated → producer_handoff_done
    // by processing run-complete. workbooks_validated must be true or signal is dead_letter.
    to: (signal) => {
      const failures = ["failed", "validation_failed", "drive_failed", "partial_outputs"];
      if (failures.includes(signal.status)) return "dead_letter";
      if (!signal.workbooks_validated) return "dead_letter";
      return "producer_handoff_done";
    },
  },
  "steel.review-result.v1": {
    from: ["claude_review_requested"],
    to: (signal) => {
      if (signal.verdict === "PASS") return "claude_review_passed";
      if (signal.verdict === "BLOCKED") return "claude_review_blocked";
      return "dead_letter";
    },
  },
  "steel.integration-result.v1": {
    from: ["codex_integration_requested"],
    to: (signal) => {
      if (signal.status === "blocked") return "dead_letter";
      if (signal.status === "needs-owner-decision") return "dead_letter";
      // complete — check GEPA
      if (signal.gepa_proposals && signal.gepa_proposals.length > 0) return "gepa_proposed";
      return "upload_ready";
    },
  },
  "steel.upload-verified.v1": {
    from: ["upload_ready"],
    to: (signal) => {
      if (signal.verification_status === "verified") return "uploaded_verified";
      return "dead_letter";
    },
  },
  "steel.upload-approved.v1": {
    from: ["gepa_reviewed", "codex_integration_done"],
    to: () => "upload_ready",
  },
});

/**
 * Compute the target state for a given signal received in a given current state.
 *
 * @param {State} currentState
 * @param {string} signalSchema
 * @param {object} signal
 * @returns {{ ok: true, nextState: State } | { ok: false, error: string }}
 */
export function transition(currentState, signalSchema, signal) {
  if (currentState === "closed" || currentState === "dead_letter") {
    return { ok: false, error: `Run is terminal (${currentState}), no further transitions allowed` };
  }

  const routing = SIGNAL_ROUTING[signalSchema];
  if (!routing) {
    return { ok: false, error: `Unknown signal schema: ${signalSchema}` };
  }

  // run-request creates a new run (no current state check)
  if (signalSchema === "steel.run-request.v1") {
    return { ok: true, nextState: "requested" };
  }

  const nextState = routing.to(signal, currentState);
  const allowed = TRANSITION_TABLE[currentState] ?? [];

  if (!allowed.includes(nextState)) {
    return {
      ok: false,
      error: `Transition ${currentState} → ${nextState} not allowed. Allowed: [${allowed.join(", ")}]`,
    };
  }

  return { ok: true, nextState };
}

/**
 * For run-complete signal, the orchestrator must drive through intermediate states.
 * Returns the sequence of states to record in the ledger before the final state.
 *
 * @param {State} currentState
 * @param {string} signalSchema
 * @param {object} signal
 * @returns {State[]} states to record, in order (not including currentState)
 */
export function transitionSequence(currentState, signalSchema, signal) {
  // run-complete drives through intermediate states
  if (signalSchema === "steel.run-complete.v1") {
    const failures = ["failed", "validation_failed", "drive_failed", "partial_outputs"];
    if (failures.includes(signal.status) || !signal.workbooks_validated) return ["dead_letter"];
    if (currentState === "producer_handoff_done") return []; // Idempotent: already handled
    const intermediates = {
      requested:           ["sources_manifested", "sources_downloaded", "extraction_done", "workbooks_generated", "workbooks_validated", "producer_handoff_done"],
      extraction_done:     ["workbooks_generated", "workbooks_validated", "producer_handoff_done"],
      workbooks_generated: ["workbooks_validated", "producer_handoff_done"],
      workbooks_validated: ["producer_handoff_done"],
    };
    return intermediates[currentState] ?? ["dead_letter"];
  }

  // integration-result drives: codex_integration_requested → codex_integration_done → gepa_proposed|upload_ready
  if (signalSchema === "steel.integration-result.v1") {
    if (signal.status === "blocked" || signal.status === "needs-owner-decision") return ["dead_letter"];
    const hasGepa = signal.gepa_proposals && signal.gepa_proposals.length > 0;
    if (currentState === "codex_integration_requested") {
      return hasGepa
        ? ["codex_integration_done", "gepa_proposed"]
        : ["codex_integration_done", "upload_ready"];
    }
    if (currentState === "codex_integration_done") {
      return hasGepa ? ["gepa_proposed"] : ["upload_ready"];
    }
    return ["dead_letter"];
  }

  // All other signals: single-step transition
  const result = transition(currentState, signalSchema, signal);
  return result.ok ? [result.nextState] : ["dead_letter"];
}

/**
 * Derive current state from an append-only ledger (array of entries).
 * Current state = last entry's `to` field, or "requested" if only one entry.
 *
 * @param {{ from: string, to: string }[]} ledger
 * @returns {State | null}
 */
export function deriveState(ledger) {
  if (!ledger || ledger.length === 0) return null;
  return /** @type {State} */ (ledger[ledger.length - 1].to);
}

/**
 * Human-readable label for each state.
 * @param {State} state
 * @returns {string}
 */
export function stateLabel(state) {
  const labels = {
    requested:                  "Run requested",
    sources_manifested:         "Source inventory ready",
    sources_downloaded:         "Sources downloaded",
    extraction_done:            "Extraction complete",
    workbooks_generated:        "Workbooks generated",
    workbooks_validated:        "Workbooks validated ✓",
    producer_handoff_done:      "Producer handoff done",
    claude_review_requested:    "Waiting for QA review",
    claude_review_passed:       "QA review passed ✓",
    claude_review_blocked:      "QA review BLOCKED ✗",
    codex_integration_requested:"Waiting for integration",
    codex_integration_done:     "Integration done",
    gepa_proposed:              "⚠ GEPA approval required",
    gepa_reviewed:              "GEPA approved ✓",
    upload_ready:               "Ready for upload",
    uploaded_verified:          "Uploaded & verified ✓",
    closed:                     "Closed ✓",
    dead_letter:                "Dead letter ✗",
  };
  return labels[state] ?? state;
}

/** @param {State} state @returns {boolean} */
export function isTerminal(state) {
  return state === "closed" || state === "dead_letter";
}

/** @param {State} state @returns {boolean} */
export function isOwnerBlocked(state) {
  return state === "gepa_proposed" || state === "upload_ready";
}

# Project Charter: Sprint 9 - Workbook Generator & Hardening

## Context
Standardizing workbook generation and hardening the orchestrator infrastructure.

## SPRINT 9 SCOPE

### TASK 1: Workbook Generator
- File: `agent-core/src/workbook-generator.mjs`
- Input: Standardized JSON structure.
- Output: 3 XLSX files (BoM, Material List, Description).
- Requirements: Match reference files from `nordic-ajaur-v4-20260524`.

### TASK 2: Local-Artifact Verifier
- File: `agent-core/src/artifact-verifier.mjs`
- Function: `verifyRunOutput(runDir)`.
- Requirements: Verify presence and size of outputs (> 5000 bytes).

### TASK 3: Orchestrator Missing Imports
- Files: `state-machine.mjs`, `gepa-register.mjs`.
- Action: Copy from `/root/agent-core/steel-bus/lib/` to `agent-core/steel-bus/lib/`.

### TASK 4: Download Manifest Fix
- File: `agent-core/scripts/steel-drive.mjs`.
- Fix: Aggregate manifest instead of overwriting.

## Success Criteria
1. `workbook-generator.mjs` produces 3 valid XLSX files.
2. `artifact-verifier.mjs` correctly flags missing/small outputs.
3. `npm test` passes.
4. `state-machine.mjs` and `gepa-register.mjs` are in the repo.
5. Download manifest aggregation works.

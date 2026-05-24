# Implementation Plan: Sprint 9

## Phase 1: Infrastructure (Tasks 3 & 4)
1. **Copy missing files**: `cp /root/agent-core/steel-bus/lib/{state-machine.mjs,gepa-register.mjs} agent-core/steel-bus/lib/`.
2. **Fix steel-drive.mjs**: Update `download` function to read existing manifest if present and merge.

## Phase 2: Verifier (Task 2)
1. Implement `agent-core/src/artifact-verifier.mjs`.
2. Add tests in `agent-core/test/artifact-verifier.test.mjs`.
3. Verify with `npm test`.

## Phase 3: Workbook Generator (Task 1)
1. Analyze reference workbooks from `nordic-ajaur-v4-20260524`.
2. Implement `agent-core/src/workbook-generator.mjs` using `exceljs`.
3. Create smoke test with synthetic data.
4. Verify output structure matches reference.

## Phase 4: Integration & Final Test
1. Run full `npm test`.
2. Ensure all files are staged.

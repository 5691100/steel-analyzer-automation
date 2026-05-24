import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const AGENT_CORE = path.resolve(path.dirname(__filename), '..');
const ORCHESTRATOR = path.join(AGENT_CORE, 'scripts/steel-orchestrator.mjs');

test('upload-approve resolves folder and output before missing owner approval manifest delegation', () => {
  const source = fs.readFileSync(ORCHESTRATOR, 'utf8');
  const outputResolution = source.indexOf('if (outputFiles.length === 0)');
  const missingApproval = source.indexOf('if (!ownerApproval)', outputResolution);
  const delegation = source.indexOf('runSteelDriveUpload(filePath)', missingApproval);

  assert.notEqual(outputResolution, -1);
  assert.notEqual(missingApproval, -1);
  assert.notEqual(delegation, -1);
  assert.ok(missingApproval > outputResolution);
  assert.ok(delegation > missingApproval);
});

test('upload-approve keeps one aggregate upload manifest path for all workbook uploads', () => {
  const source = fs.readFileSync(ORCHESTRATOR, 'utf8');

  assert.match(source, /const uploadManifestPath = join\(RUNS, runId, "manifest-drive-upload\.json"\)/);
  assert.match(source, /upload_manifest_path: uploadManifestPath/);
  assert.doesNotMatch(source, /manifest-drive-upload-\$\{/);
});

test('commands validate unsafe run id characters at the command boundary', () => {
  const source = fs.readFileSync(ORCHESTRATOR, 'utf8');

  assert.match(source, /function validateRunId\(runId\)/);
  assert.match(source, /validateRunId\(runId\);\n\s+const ledgerFile/);
  assert.match(source, /validateRunId\(runId\);[\s\S]*?recordDecision\(runId/);
  assert.match(source, /validateRunId\(runId\);\n\s+\/\/ Writes are User OAuth only/);
  assert.match(source, /if \(!isValidRunId\(runId\)\) {\n\s+moveToDeadLetter\(signalPath, invalidRunIdMessage\(runId\)\)/);
});

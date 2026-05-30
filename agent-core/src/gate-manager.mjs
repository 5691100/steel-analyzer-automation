import { InlineKeyboard } from 'grammy';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNS_DIR = path.resolve(fileURLToPath(import.meta.url), '../../steel-bus/runs');

// Gate state — in-memory, backed by per-run pending-gate.json for restart resilience
export const pendingGates = new Map(); // runId → { gateId, resolve }
export const chatQuestionState = new Map(); // chatId → { runId, gateId, agent }

function gateFile(runId) {
  return path.join(RUNS_DIR, runId, 'pending-gate.json');
}

function persistGate(runId, gateId) {
  try {
    fs.writeFileSync(gateFile(runId), JSON.stringify({ runId, gateId, at: new Date().toISOString() }));
  } catch { /* non-fatal */ }
}

function clearGate(runId) {
  try { fs.unlinkSync(gateFile(runId)); } catch { /* non-fatal */ }
}

/** Returns list of runs that had pending gates when process last stopped. */
export function loadOrphanedGates() {
  try {
    return fs.readdirSync(RUNS_DIR)
      .map(runId => {
        const f = gateFile(runId);
        try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
      })
      .filter(Boolean);
  } catch { return []; }
}

export const GATE_AGENT = {
  g1_claude: 'claude',
  g2_qa: 'claude',
  g3_correction: 'claude',
  g4_codex: 'codex',
  g5_upload: 'claude',
};

export const GATE_PROMPTS = {
  g1_claude: (runId) => `🔵 Run: <code>${runId}</code>\n\nЗапустить Claude-анализ источников?`,
  g2_qa: (runId) => `📋 Run: <code>${runId}</code>\nClaude анализ завершён.\n\nЗапустить QA?`,
  g3_correction: (runId, iter = 1) =>
    `🔄 Run: <code>${runId}</code>\nQA выявил дефекты (итерация ${iter}/3).\n\nЗапустить correction loop?`,
  g4_codex: (runId) =>
    `✅ Run: <code>${runId}</code>\nQA passed.\n\nЗапустить CodexClaw финализацию?`,
  g5_upload: (runId) =>
    `📤 Run: <code>${runId}</code>\nCodexClaw завершён.\n\nЗагрузить результаты в Drive?`,
};

export const GATE_HELP = {
  g1_claude:
    'Claude скачает источники из Drive и сгенерирует workbooks (BoM, MaterialList, Description).',
  g2_qa:
    'Claude проверит workbooks: профили, покраска, итоги, полнота данных.',
  g3_correction:
    'Claude повторит анализ с учётом дефектов из QA-отчёта.',
  g4_codex:
    'CodexClaw выполнит финальную проверку и подготовит пакет для загрузки.',
  g5_upload:
    'Файлы из output/ будут загружены в исходную Drive-папку с MD5-верификацией.',
};

export function makeGateKeyboard(runId, gateId) {
  return new InlineKeyboard()
    .text('✅ Approve', `gate:${runId}:${gateId}:approve`)
    .text('❌ Reject', `gate:${runId}:${gateId}:reject`)
    .row()
    .text('⏸ Defer', `gate:${runId}:${gateId}:defer`)
    .text('❓ Clarify', `gate:${runId}:${gateId}:clarify`)
    .text('💬 Open chat', `gate:${runId}:${gateId}:openchat`);
}

export function registerGate(runId, gateId) {
  return new Promise((resolve) => {
    pendingGates.set(runId, { gateId, resolve });
    persistGate(runId, gateId);
  });
}

// Returns true if gate was found and resolved; false if not found or gateId mismatch.
export function resolveGate(runId, gateId, decision) {
  const gate = pendingGates.get(runId);
  if (!gate || gate.gateId !== gateId) return false;
  pendingGates.delete(runId);
  clearGate(runId);
  gate.resolve(decision);
  return true;
}

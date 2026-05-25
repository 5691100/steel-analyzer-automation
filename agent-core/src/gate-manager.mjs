import { InlineKeyboard } from 'grammy';

// Gate state — in-memory, process-scoped
export const pendingGates = new Map(); // runId → { gateId, resolve }
export const chatQuestionState = new Map(); // chatId → { runId, gateId, agent }

export const GATE_AGENT = {
  g1_gemini: 'gemini',
  g2_qa: 'claude',
  g3_correction: 'gemini',
  g4_codex: 'codex',
  g5_upload: 'gemini',
};

export const GATE_PROMPTS = {
  g1_gemini: (runId) => `🔵 Run: <code>${runId}</code>\n\nЗапустить Gemini-анализ источников?`,
  g2_qa: (runId) => `📋 Run: <code>${runId}</code>\nGemini-анализ завершён.\n\nЗапустить Claude QA?`,
  g3_correction: (runId, iter = 1) =>
    `🔄 Run: <code>${runId}</code>\nQA выявил дефекты (итерация ${iter}/3).\n\nЗапустить correction loop?`,
  g4_codex: (runId) =>
    `✅ Run: <code>${runId}</code>\nQA passed.\n\nЗапустить CodexClaw финализацию?`,
  g5_upload: (runId) =>
    `📤 Run: <code>${runId}</code>\nCodexClaw завершён.\n\nЗагрузить результаты в Drive?`,
};

export const GATE_HELP = {
  g1_gemini:
    'Gemini скачает источники из Drive и сгенерирует workbooks (BoM, MaterialList, Description).',
  g2_qa:
    'Claude проверит workbooks: профили, покраска, итоги, полнота данных.',
  g3_correction:
    'Gemini повторит анализ с учётом дефектов из QA-отчёта.',
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
  });
}

// Returns true if gate was found and resolved; false if not found or gateId mismatch.
export function resolveGate(runId, gateId, decision) {
  const gate = pendingGates.get(runId);
  if (!gate || gate.gateId !== gateId) return false;
  pendingGates.delete(runId);
  gate.resolve(decision);
  return true;
}

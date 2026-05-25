import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  pendingGates,
  chatQuestionState,
  makeGateKeyboard,
  registerGate,
  resolveGate,
  GATE_AGENT,
  GATE_PROMPTS,
  GATE_HELP,
} from '../src/gate-manager.mjs';

describe('gate-manager', () => {
  beforeEach(() => {
    pendingGates.clear();
    chatQuestionState.clear();
  });

  it('makeGateKeyboard returns inline_keyboard with 5 buttons for g1_gemini', () => {
    const kb = makeGateKeyboard('run-1', 'g1_gemini');
    // grammy InlineKeyboard serializes to { inline_keyboard: [...] }
    const serialized = kb.inline_keyboard ?? kb;
    const all = serialized.flat();
    const texts = all.map(b => b.text);
    assert.ok(texts.includes('✅ Approve'), `missing Approve, got: ${texts}`);
    assert.ok(texts.includes('❌ Reject'));
    assert.ok(texts.includes('⏸ Defer'));
    assert.ok(texts.includes('❓ Clarify'));
    assert.ok(texts.includes('💬 Open chat'));
    // callback_data encodes runId and gateId
    const approveBtn = all.find(b => b.text === '✅ Approve');
    assert.equal(approveBtn.callback_data, 'gate:run-1:g1_gemini:approve');
  });

  it('registerGate returns a Promise that resolves when resolveGate is called', async () => {
    const p = registerGate('run-2', 'g2_qa');
    const resolved = resolveGate('run-2', 'g2_qa', 'approve');
    assert.equal(resolved, true);
    const decision = await p;
    assert.equal(decision, 'approve');
  });

  it('resolveGate returns false when runId not found', () => {
    const result = resolveGate('nonexistent', 'g1_gemini', 'approve');
    assert.equal(result, false);
  });

  it('resolveGate returns false when gateId mismatch', () => {
    registerGate('run-3', 'g1_gemini');
    const result = resolveGate('run-3', 'g2_qa', 'approve'); // wrong gateId
    assert.equal(result, false);
    // gate is still pending
    assert.ok(pendingGates.has('run-3'));
  });

  it('pendingGates is cleared after resolveGate', () => {
    registerGate('run-4', 'g3_correction');
    resolveGate('run-4', 'g3_correction', 'reject');
    assert.equal(pendingGates.has('run-4'), false);
  });

  it('GATE_AGENT maps all 5 gate ids', () => {
    for (const gid of ['g1_gemini', 'g2_qa', 'g3_correction', 'g4_codex', 'g5_upload']) {
      assert.ok(GATE_AGENT[gid], `missing GATE_AGENT[${gid}]`);
    }
  });

  it('GATE_PROMPTS[g1_gemini] includes runId', () => {
    const prompt = GATE_PROMPTS.g1_gemini('run-test');
    assert.ok(prompt.includes('run-test'), `GATE_PROMPTS.g1_gemini should include runId`);
  });

  it('GATE_HELP has entries for all 5 gates', () => {
    for (const gid of ['g1_gemini', 'g2_qa', 'g3_correction', 'g4_codex', 'g5_upload']) {
      assert.ok(typeof GATE_HELP[gid] === 'string' && GATE_HELP[gid].length > 0, `missing GATE_HELP[${gid}]`);
    }
  });
});

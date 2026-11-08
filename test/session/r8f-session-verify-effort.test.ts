/**
 * r8 #8 verifier (session group). Claude Code keeps the session's effort level as its own setting
 * across `set_model`: on a model without effort levels it is just not applied, and a later switch
 * to a model that has the level runs at it again (VERIFIED 2.1.319 with control requests only:
 * `--effort low` on a model with effort levels, set_model to one without them (get_settings
 * applied effort null), set_model to one with them: applied effort low; a child started with
 * `--effort low` on a model without effort levels (no model list cached yet), then set_model to
 * one with them: low; a local `/effort high` on a model without effort levels is accepted and
 * applied after a set_model to one with them). The fix sent `/effort <level>` again after a switch
 * through such a model, a local command the child did not need (the finding: no extra local
 * command when the child already has the level).
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

import type { ClaudeCapabilities } from '../../src/claude/binary.js';
import { KiroSessionImpl, type KiroSessionInternalOptions } from '../../src/session/kiroSession.js';
import { closeAll, drain, fakeBinary, fakeCaps, flagValue, mkSandbox, recordingUI, type RecordingUI, type Sandbox } from './helpers.js';

let caps: ClaudeCapabilities;
before(async () => {
  caps = await fakeCaps();
});

const SCRIPT = { default: { steps: [{ text: 'MODEL={{model}} EFFORT={{effort}}' }] } };

const open = (sb: Sandbox, over: Partial<KiroSessionInternalOptions> = {}, ui: RecordingUI = recordingUI()): Promise<KiroSessionImpl> =>
  KiroSessionImpl.create({ ws: sb.ws, origin: 'repl', interactive: true, ui, binary: fakeBinary(), caps, env: sb.env, ...over });

function textOf(line: Record<string, unknown> | undefined): string {
  const c = (line?.message as { content?: unknown } | undefined)?.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.map((b) => (typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'text' ? String((b as { text?: unknown }).text) : '')).join('');
}
const effortLines = (sb: Sandbox): string[] => sb.userLines().map(textOf).filter((t) => /^\/effort\b/.test(t));

/** A sandbox whose model list a first session cached: a launch knows which models have no effort levels. */
async function warmSandbox(): Promise<Sandbox> {
  const sb = mkSandbox({ script: SCRIPT });
  const first = await open(sb);
  try {
    await drain(first.prompt({ text: 'warm' }));
  } finally {
    await closeAll(first);
  }
  return sb;
}

describe('r8 #8 verifier: Claude Code keeps the effort level across set_model', () => {
  it('a /model through a model without effort levels and back sends no /effort line (the child kept the level)', async () => {
    const sb = await warmSandbox();
    const s = await open(sb, { effort: 'low' });
    try {
      await drain(s.prompt({ text: 'a' }));
      assert.equal(flagValue(sb.starts().at(-1)!, '--effort'), 'low', 'precondition: the child got --effort');
      await s.setModel('claude-haiku-4.5');
      await s.setModel('claude-sonnet-4.6');
      assert.deepEqual(effortLines(sb), [], 'no local /effort line: the child has the level');
      assert.match((await drain(s.prompt({ text: 'b' }))).result.text, /MODEL=claude-sonnet-4-6 EFFORT=low/);
      assert.equal(s.effort, 'low');
    } finally {
      await closeAll(s);
    }
  });

  it('a child that got the level, then a respawn on a model without it: the next /model sends it (the new child never had it)', async () => {
    const sb = await warmSandbox();
    sb.agent('pinned', { description: 'pinned', tools: ['read'], model: 'claude-haiku-4.5' });
    sb.refresh();
    const s = await open(sb, { effort: 'low' });
    try {
      await drain(s.prompt({ text: 'a' }));
      await s.setModel('claude-haiku-4.5'); // the child keeps low
      await s.swapAgent('pinned'); // a new child on the pinned model: no --effort
      assert.equal(flagValue(sb.starts().at(-1)!, '--effort'), undefined, 'precondition: the swap restart dropped --effort');
      await s.setModel('claude-sonnet-4.6');
      assert.deepEqual(effortLines(sb), ['/effort low']);
      assert.match((await drain(s.prompt({ text: 'b' }))).result.text, /MODEL=claude-sonnet-4-6 EFFORT=low/);
    } finally {
      await closeAll(s);
    }
  });

  it('no model list cached yet: a start on a model without effort levels passes --effort, and a /model sends nothing', async () => {
    const sb = mkSandbox({ script: SCRIPT });
    const s = await open(sb, { model: 'claude-haiku-4.5', effort: 'low' });
    try {
      assert.equal(flagValue(sb.starts().at(-1)!, '--effort'), 'low', 'precondition: the launch did not know the model has no effort levels');
      await drain(s.prompt({ text: 'a' }));
      await s.setModel('claude-sonnet-4.6');
      assert.deepEqual(effortLines(sb), []);
      assert.match((await drain(s.prompt({ text: 'b' }))).result.text, /MODEL=claude-sonnet-4-6 EFFORT=low/);
    } finally {
      await closeAll(s);
    }
  });
});

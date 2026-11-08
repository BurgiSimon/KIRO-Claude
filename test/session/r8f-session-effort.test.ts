/**
 * r8 #8 (session group): the effort is session state (docs/ARCHITECTURE.md "So are the model and
 * the effort"). A launch on a model without that effort level (claude-haiku-4.5 has none) drops
 * `--effort`, but the record keeps the user's level: after a start or respawn on such a model (the
 * model list cached by any earlier run), an `/agent swap` to an agent that pins it, a tangent
 * restart on it. A later `/model` (set_model, also ACP session/set_model and set_config_option
 * model, which call setModel) to a model that has the level used to switch the model only, so
 * Claude Code ran it at its own default effort while session.effort, `/effort`, ACP configOptions
 * and the record reported the user's level. The switch now sends the session effort when the
 * running child does not have it (a silent local `/effort <level>`, queued for the next prompt line
 * while a turn runs or a restored history is pending, R4 #1), and never when it does.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ClaudeCapabilities } from '../../src/claude/binary.js';
import { KiroSessionImpl, type KiroSessionInternalOptions } from '../../src/session/kiroSession.js';
import { SessionStore } from '../../src/session/store.js';
import { closeAll, drain, fakeBinary, fakeCaps, flagValue, mkSandbox, recordingUI, type RecordingUI, type Sandbox } from './helpers.js';
import { TestClient, tmpEnv, writeAgent, type Frame } from '../acp/helpers.js';

let caps: ClaudeCapabilities;
before(async () => {
  caps = await fakeCaps();
});

const SCRIPT = {
  // (long enough that the set_model round trip ends inside the turn on a loaded machine)
  turns: [{ repeat: true, match: 'slow', steps: [{ sleepMs: 3000 }, { text: 'SLOW MODEL={{model}} EFFORT={{effort}}' }] }],
  default: { steps: [{ text: 'MODEL={{model}} EFFORT={{effort}} HIST[{{historyUserTexts}}]' }] },
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const open = (sb: Sandbox, over: Partial<KiroSessionInternalOptions> = {}, ui: RecordingUI = recordingUI()): Promise<KiroSessionImpl> =>
  KiroSessionImpl.create({ ws: sb.ws, origin: 'repl', interactive: true, ui, binary: fakeBinary(), caps, env: sb.env, ...over });

function textOf(line: Record<string, unknown> | undefined): string {
  const c = (line?.message as { content?: unknown } | undefined)?.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.map((b) => (typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'text' ? String((b as { text?: unknown }).text) : '')).join('');
}
const effortLines = (sb: Sandbox): string[] => sb.userLines().map(textOf).filter((t) => /^\/effort\b/.test(t));
const applied = async (s: KiroSessionImpl): Promise<{ model: unknown; effort: unknown }> => {
  const r = (await s.process!.getSettings()) as { applied: { model: unknown; effort: unknown } };
  return { model: r.applied.model, effort: r.applied.effort };
};

/** A sandbox whose model list a first session cached (as any earlier run does): a launch knows haiku 4.5 has no effort levels. */
async function warmSandbox(env: Record<string, string> = {}): Promise<Sandbox> {
  const sb = mkSandbox({ script: SCRIPT, env });
  const first = await open(sb);
  try {
    await drain(first.prompt({ text: 'warm' }));
  } finally {
    await closeAll(first);
  }
  return sb;
}

describe('r8 #8: /model to a model with the session effort, from a child that runs without it', () => {
  it('started on a no-effort model with effort low: /model to one that has it runs Claude Code at low (once)', async () => {
    const sb = await warmSandbox();
    const ui = recordingUI();
    const s = await open(sb, { model: 'claude-haiku-4.5', effort: 'low' }, ui);
    try {
      await drain(s.prompt({ text: 'a' }));
      assert.ok(ui.notices.some((n) => /does not support effort levels; effort 'low' ignored/.test(n.message)), JSON.stringify(ui.notices));
      assert.equal(flagValue(sb.starts().at(-1)!, '--effort'), undefined, 'precondition: the launch dropped --effort');
      const before = effortLines(sb).length;
      await s.setModel('claude-sonnet-4.6');
      assert.deepEqual(await applied(s), { model: 'claude-sonnet-4-6', effort: 'low' });
      assert.match((await drain(s.prompt({ text: 'b' }))).result.text, /MODEL=claude-sonnet-4-6 EFFORT=low/);
      assert.equal(s.effort, 'low');
      assert.equal(new SessionStore(sb.sessionsDir).read(s.id)?.effort, 'low');
      assert.deepEqual(effortLines(sb).slice(before), ['/effort low'], 'one silent /effort line');
      // the child has it now: a further switch to a model with the level sends nothing
      await s.setModel('claude-opus-4.6');
      assert.match((await drain(s.prompt({ text: 'c' }))).result.text, /MODEL=claude-opus-4-6 EFFORT=low/);
      assert.deepEqual(effortLines(sb).slice(before), ['/effort low'], 'no /effort line on every /model');
    } finally {
      await closeAll(s);
    }
  });

  it('/agent swap to an agent pinning a no-effort model, then /model to one with the level', async () => {
    const sb = mkSandbox({ script: SCRIPT });
    sb.agent('pinned', { description: 'pinned', tools: ['read'], model: 'claude-haiku-4.5' });
    sb.refresh();
    const s = await open(sb, { effort: 'low' });
    try {
      assert.match((await drain(s.prompt({ text: 'a' }))).result.text, /EFFORT=low/);
      await s.swapAgent('pinned');
      assert.equal(flagValue(sb.starts().at(-1)!, '--effort'), undefined, 'precondition: the swap restart dropped --effort');
      await drain(s.prompt({ text: 'b' }));
      await s.setModel('claude-sonnet-4.6');
      assert.match((await drain(s.prompt({ text: 'c' }))).result.text, /MODEL=claude-sonnet-4-6 EFFORT=low/, 'Claude Code runs at the effort the session reports and saves');
      assert.equal(s.effort, 'low');
      assert.equal(new SessionStore(sb.sessionsDir).read(s.id)?.effort, 'low');
    } finally {
      await closeAll(s);
    }
  });

  it('a child started with --effort sends nothing on /model (no extra local command)', async () => {
    const sb = await warmSandbox();
    const s = await open(sb, { effort: 'low' });
    try {
      await drain(s.prompt({ text: 'a' }));
      assert.equal(flagValue(sb.starts().at(-1)!, '--effort'), 'low', 'precondition');
      await s.setModel('claude-sonnet-4.6');
      await s.setModel('claude-opus-4.6');
      assert.match((await drain(s.prompt({ text: 'b' }))).result.text, /MODEL=claude-opus-4-6 EFFORT=low/);
      assert.deepEqual(effortLines(sb), []);
    } finally {
      await closeAll(s);
    }
  });

  it('a /effort the child got after its start counts: /model sends nothing more', async () => {
    const sb = await warmSandbox();
    const s = await open(sb, { model: 'claude-sonnet-4.6' });
    try {
      await drain(s.prompt({ text: 'a' }));
      await s.setEffort('low'); // written at once
      assert.deepEqual(effortLines(sb), ['/effort low']);
      await s.setModel('claude-opus-4.6');
      assert.match((await drain(s.prompt({ text: 'b' }))).result.text, /MODEL=claude-opus-4-6 EFFORT=low/);
      assert.deepEqual(effortLines(sb), ['/effort low'], 'no second /effort line');
    } finally {
      await closeAll(s);
    }
  });

  it('a switch through a model without the level sends nothing, also on the way back (Claude Code keeps the level, VERIFIED 2.1.319)', async () => {
    const sb = await warmSandbox();
    const s = await open(sb, { effort: 'low' });
    try {
      await drain(s.prompt({ text: 'a' }));
      assert.equal(flagValue(sb.starts().at(-1)!, '--effort'), 'low', 'precondition');
      await s.setModel('claude-haiku-4.5');
      assert.deepEqual(effortLines(sb), [], 'nothing for a model without effort levels');
      await s.setModel('claude-sonnet-4.6');
      assert.deepEqual(effortLines(sb), [], 'nothing on the way back: the child kept the level');
      assert.match((await drain(s.prompt({ text: 'b' }))).result.text, /MODEL=claude-sonnet-4-6 EFFORT=low/);
    } finally {
      await closeAll(s);
    }
  });

  it('/model while a turn runs: the level is queued and written right before the next prompt line', async () => {
    const sb = await warmSandbox();
    const s = await open(sb, { model: 'claude-haiku-4.5', effort: 'low' });
    try {
      await drain(s.prompt({ text: 'a' }));
      const turn = drain(s.prompt({ text: 'slow' }));
      // (polled, not a fixed wait: the line may take longer to reach Claude on a loaded machine)
      for (let i = 0; i < 500 && !s.process?.busy; i++) await sleep(10);
      assert.equal(s.process?.busy, true, 'precondition: the turn runs');
      await s.setModel('claude-sonnet-4.6');
      assert.deepEqual(effortLines(sb), [], 'no local line while the turn runs');
      await turn;
      const { result } = await drain(s.prompt({ text: 'b' }));
      assert.match(result.text, /MODEL=claude-sonnet-4-6 EFFORT=low/);
      const lines = sb.userLines().map(textOf);
      assert.equal(lines.at(-2), '/effort low', JSON.stringify(lines.slice(-3)));
      assert.match(lines.at(-1)!, /^b/);
    } finally {
      await closeAll(s);
    }
  });

  it('/model while a restored history is pending: the level is queued for the line that carries it (R4 #1)', async () => {
    const sb = await warmSandbox({ FAKE_CLAUDE_PERSIST: '1' });
    const first = await open(sb, { model: 'claude-haiku-4.5', effort: 'low' });
    const id = first.id;
    try {
      await drain(first.prompt({ text: 'remember ALPHA_1' }));
    } finally {
      await closeAll(first);
    }
    fs.rmSync(path.join(sb.claudeConfig, 'projects'), { recursive: true, force: true });
    const ui = recordingUI();
    const s = await open(sb, { resume: { sessionId: id } }, ui);
    try {
      assert.ok(ui.notices.some((n) => /could not find the saved conversation/i.test(n.message)), 'precondition: the resume fell back');
      assert.ok(s.record.pendingHistory, 'precondition: the restored history is pending');
      assert.equal(flagValue(sb.starts().at(-1)!, '--effort'), undefined, 'precondition: the launch dropped --effort');
      const before = sb.userLines().length;
      await s.setModel('claude-sonnet-4.6');
      assert.equal(sb.userLines().length, before, 'no line written while the history is pending');
      const { result } = await drain(s.prompt({ text: 'next' }));
      const lines = sb.userLines().slice(before).map(textOf);
      assert.equal(lines.length, 2, JSON.stringify(lines.map((l) => l.slice(0, 60))));
      assert.equal(lines[0], '/effort low');
      assert.match(lines[1]!, /<kiro-restored-history>[\s\S]*ALPHA_1[\s\S]*next/);
      assert.match(result.text, /MODEL=claude-sonnet-4-6 EFFORT=low/);
    } finally {
      await closeAll(s);
    }
  });
});

// ── over ACP: session/set_mode (an agent swap) and session/set_config_option model use the same code ──

describe('r8 #8 over ACP', () => {
  it('set_config_option effortLevel low, set_mode to an agent pinning a no-effort model, set_config_option model to one with the level: Claude Code runs at low', async () => {
    const t = tmpEnv({ FAKE_CLAUDE_SCRIPT_JSON: JSON.stringify(SCRIPT) });
    writeAgent(path.join(t.work, '.kiro'), 'probe', { description: 'probe', tools: ['*'] });
    writeAgent(t.kiroHome, 'pinned', { description: 'pinned', tools: ['read'], model: 'claude-haiku-4.5' });
    const c = new TestClient({ args: ['--agent-engine', 'v2', '--agent', 'probe'], env: t.env, cwd: t.work });
    try {
      await c.initialize();
      const sid = (await c.call('session/new', { cwd: t.work, mcpServers: [] })).sessionId as string;
      await c.call('session/set_config_option', { sessionId: sid, configId: 'effortLevel', value: 'low' });
      await c.call('session/set_mode', { sessionId: sid, modeId: 'pinned' });
      await c.call('session/set_config_option', { sessionId: sid, configId: 'model', value: 'claude-sonnet-4.6' });
      const from = c.frames.length;
      const r = await c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'x' }] }, 15_000);
      assert.equal(r.result?.stopReason, 'end_turn', JSON.stringify(r));
      const text = c.frames
        .slice(from)
        .filter((f: Frame) => f.method === 'session/update' && f.params?.update?.sessionUpdate === 'agent_message_chunk')
        .map((f: Frame) => String(f.params.update.content?.text ?? ''))
        .join('');
      assert.match(text, /MODEL=claude-sonnet-4-6 EFFORT=low/, 'the effort ACP reports in configOptions');
    } finally {
      await c.close(15_000).catch(() => undefined);
    }
  });
});

/**
 * r9 #3 (session group): Claude Code gets one `/effort` line per effort change. setEffort while a
 * turn runs (in the REPL: `/effort high` typed at an approval prompt) queues the level for the
 * next prompt line (pendingEffort) and leaves the running child at its level. A `/model` after
 * that turn, to a model that has the level, sent it at once (effortAfterSwitch, r8 #8) but left
 * the queued line, so the next prompt wrote the same `/effort high` a second time (an extra
 * local-command entry in the Claude transcript; docs/ARCHITECTURE.md "A Claude Code that already
 * has the level gets no extra command"). The level applied was right.
 *
 * Now a line that applies a level settles a queued line for the same record and level. The other
 * paths that send or queue the line are guarded here to send exactly one: the switch queuing the
 * level during a turn, an explicit `/effort` after the switch queued it, a restored history
 * pending (R4 #1: before the line that carries it), and a respawn before the next prompt (an
 * `/agent swap`, a crashed child). A respawn starts Claude Code with the level as `--effort` and
 * still gets the queued line, as R4 #6 (r4-history-verify) asserts: one line, harmless.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ClaudeCapabilities } from '../../src/claude/binary.js';
import { KiroSessionImpl, type KiroSessionInternalOptions } from '../../src/session/kiroSession.js';
import { closeAll, drain, fakeBinary, fakeCaps, flagValue, mkSandbox, recordingUI, type RecordingUI, type Sandbox } from './helpers.js';

let caps: ClaudeCapabilities;
before(async () => {
  caps = await fakeCaps();
});

const SCRIPT = {
  // (long enough for a setEffort / setModel round trip inside the turn on a loaded machine)
  turns: [{ repeat: true, match: 'slow', steps: [{ sleepMs: 2500 }, { text: 'SLOW MODEL={{model}} EFFORT={{effort}}' }] }],
  default: { steps: [{ text: 'MODEL={{model}} EFFORT={{effort}}' }] },
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

/** Start the slow turn and wait (polled) until Claude Code runs it; `done` settles with the turn. */
async function slowTurn(s: KiroSessionImpl): Promise<{ done: Promise<unknown> }> {
  const done = drain(s.prompt({ text: 'slow' }));
  for (let i = 0; i < 1000 && !s.process?.busy; i++) await sleep(10);
  assert.equal(s.process?.busy, true, 'precondition: the slow turn runs');
  return { done };
}

async function killChild(s: KiroSessionImpl): Promise<void> {
  process.kill(s.process!.pid!, 'SIGKILL'); // our own fake child
  for (let i = 0; i < 500 && s.process?.running; i++) await sleep(10);
  assert.equal(s.process?.running, false, 'precondition: the child is dead');
}

/** A sandbox whose model list a first session cached (a launch knows haiku 4.5 has no effort levels). */
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

describe('r9 #3: one /effort line per effort change', () => {
  it('baseline: an /effort set while a turn runs is written once, right before the next prompt line', async () => {
    const sb = mkSandbox({ script: SCRIPT });
    const s = await open(sb, { model: 'claude-sonnet-4.6', effort: 'low' });
    try {
      await drain(s.prompt({ text: 'a' }));
      const turn = await slowTurn(s);
      await s.setEffort('high');
      await turn.done;
      assert.deepEqual(effortLines(sb), [], 'queued while the turn ran');
      const { result } = await drain(s.prompt({ text: 'b' }));
      assert.match(result.text, /EFFORT=high/);
      const lines = sb.userLines().map(textOf);
      assert.deepEqual(lines.slice(-2), ['/effort high', 'b']);
      assert.deepEqual(effortLines(sb), ['/effort high']);
    } finally {
      await closeAll(s);
    }
  });

  it('an /effort set while a turn runs, then /model after the turn: the switch writes the line, the next prompt none', async () => {
    const sb = mkSandbox({ script: SCRIPT });
    const s = await open(sb, { model: 'claude-sonnet-4.6', effort: 'low' });
    try {
      await drain(s.prompt({ text: 'a' }));
      assert.equal(flagValue(sb.starts().at(-1)!, '--effort'), 'low');
      const turn = await slowTurn(s);
      await s.setEffort('high');
      await turn.done;
      assert.deepEqual(effortLines(sb), [], 'queued while the turn ran');
      await s.setModel('claude-opus-4.6');
      assert.deepEqual(effortLines(sb), ['/effort high'], 'the switch gives the new model the session level at once');
      const { result } = await drain(s.prompt({ text: 'b' }));
      assert.match(result.text, /MODEL=claude-opus-4-6 EFFORT=high/);
      assert.equal(sb.starts().length, 1, 'no respawn');
      assert.deepEqual(effortLines(sb), ['/effort high'], 'one /effort line for one level change');
      assert.equal(s.effort, 'high');
    } finally {
      await closeAll(s);
    }
  });

  it('an /effort set while a turn runs, then an /agent swap after it: the restart starts with --effort, one line', async () => {
    const sb = mkSandbox({ script: SCRIPT });
    sb.agent('other', { description: 'other', tools: ['*'] });
    const s = await open(sb, { model: 'claude-sonnet-4.6', effort: 'low' });
    try {
      await drain(s.prompt({ text: 'a' }));
      const turn = await slowTurn(s);
      await s.setEffort('high');
      await turn.done;
      await s.swapAgent('other');
      assert.equal(sb.starts().length, 2, 'precondition: the swap restarted Claude Code');
      assert.equal(flagValue(sb.starts().at(-1)!, '--effort'), 'high', 'the restart has the level');
      const { result } = await drain(s.prompt({ text: 'b' }));
      assert.match(result.text, /EFFORT=high/);
      assert.deepEqual(effortLines(sb), ['/effort high'], 'one line for the change');
    } finally {
      await closeAll(s);
    }
  });

  it('an /effort set while Claude Code is down: its respawn starts with --effort, one line', async () => {
    const sb = mkSandbox({ script: SCRIPT });
    const s = await open(sb, { model: 'claude-sonnet-4.6', effort: 'low' });
    try {
      await drain(s.prompt({ text: 'a' }));
      await killChild(s);
      await s.setEffort('high');
      const { result } = await drain(s.prompt({ text: 'b' }));
      assert.equal(sb.starts().length, 2, 'precondition: the prompt respawned Claude Code');
      assert.equal(flagValue(sb.starts().at(-1)!, '--effort'), 'high');
      assert.match(result.text, /EFFORT=high/);
      assert.deepEqual(effortLines(sb), ['/effort high'], 'one line for the change');
    } finally {
      await closeAll(s);
    }
  });

  it('an /effort and a /model both while a turn runs: one line, right before the next prompt line', async () => {
    const sb = mkSandbox({ script: SCRIPT });
    const s = await open(sb, { model: 'claude-sonnet-4.6', effort: 'low' });
    try {
      await drain(s.prompt({ text: 'a' }));
      const turn = await slowTurn(s);
      await s.setEffort('high');
      await s.setModel('claude-opus-4.6');
      assert.deepEqual(effortLines(sb), [], 'queued while the turn runs');
      await turn.done;
      const { result } = await drain(s.prompt({ text: 'b' }));
      assert.match(result.text, /MODEL=claude-opus-4-6 EFFORT=high/);
      assert.deepEqual(sb.userLines().map(textOf).slice(-2), ['/effort high', 'b']);
      assert.deepEqual(effortLines(sb), ['/effort high']);
    } finally {
      await closeAll(s);
    }
  });

  it('the other order: /model queues the level while a turn runs, an /effort of that level after it is the one line', async () => {
    const sb = await warmSandbox();
    const s = await open(sb, { model: 'claude-haiku-4.5', effort: 'low' });
    try {
      await drain(s.prompt({ text: 'a' }));
      assert.equal(flagValue(sb.starts().at(-1)!, '--effort'), undefined, 'precondition: the launch dropped --effort');
      const before = effortLines(sb).length;
      const turn = await slowTurn(s);
      await s.setModel('claude-sonnet-4.6');
      await turn.done;
      assert.deepEqual(effortLines(sb).slice(before), [], 'the switch queued the level');
      await s.setEffort('low');
      assert.deepEqual(effortLines(sb).slice(before), ['/effort low']);
      const { result } = await drain(s.prompt({ text: 'b' }));
      assert.match(result.text, /MODEL=claude-sonnet-4-6 EFFORT=low/);
      assert.deepEqual(effortLines(sb).slice(before), ['/effort low'], 'the queued line went with the explicit one');
    } finally {
      await closeAll(s);
    }
  });

  it('a restored history pending: an /effort and a /model write one line, before the line that carries the history (R4 #1)', async () => {
    const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const first = await open(sb, { model: 'claude-sonnet-4.6', effort: 'low' });
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
      assert.ok(s.record.pendingHistory, 'precondition: the resume fell back and the restored history is pending');
      const before = sb.userLines().length;
      await s.setEffort('high');
      await s.setModel('claude-opus-4.6');
      assert.equal(sb.userLines().length, before, 'no line written while the history is pending');
      const { result } = await drain(s.prompt({ text: 'next' }));
      const lines = sb.userLines().slice(before).map(textOf);
      assert.equal(lines.length, 2, JSON.stringify(lines.map((l) => l.slice(0, 60))));
      assert.equal(lines[0], '/effort high');
      assert.match(lines[1]!, /<kiro-restored-history>[\s\S]*ALPHA_1[\s\S]*next/);
      assert.match(result.text, /MODEL=claude-opus-4-6 EFFORT=high/);
    } finally {
      await closeAll(s);
    }
  });

  it('a restored history pending and Claude Code restarted before the next prompt: one line, before the line that carries the history', async () => {
    const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const first = await open(sb, { model: 'claude-sonnet-4.6', effort: 'low' });
    const id = first.id;
    try {
      await drain(first.prompt({ text: 'remember ALPHA_1' }));
    } finally {
      await closeAll(first);
    }
    fs.rmSync(path.join(sb.claudeConfig, 'projects'), { recursive: true, force: true });
    const s = await open(sb, { resume: { sessionId: id } });
    try {
      assert.ok(s.record.pendingHistory, 'precondition: the restored history is pending');
      await s.setEffort('high');
      const starts = sb.starts().length;
      await killChild(s);
      const before = sb.userLines().length;
      const { result } = await drain(s.prompt({ text: 'next' }));
      assert.equal(sb.starts().length, starts + 1, 'precondition: the prompt respawned Claude Code');
      assert.equal(flagValue(sb.starts().at(-1)!, '--effort'), 'high');
      const lines = sb.userLines().slice(before).map(textOf);
      assert.equal(lines.length, 2, JSON.stringify(lines.map((l) => l.slice(0, 60))));
      assert.equal(lines[0], '/effort high');
      assert.match(lines[1]!, /<kiro-restored-history>[\s\S]*ALPHA_1[\s\S]*next/);
      assert.match(result.text, /EFFORT=high/);
    } finally {
      await closeAll(s);
    }
  });
});

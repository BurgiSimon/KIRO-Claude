/**
 * r9 #3 verification (session group): other ways into the doubled `/effort` line, each of which
 * wrote the same level twice before the fix (a line queued while a turn ran, then the `/model`
 * switch's own line for that level, then the queued one again before the next prompt line):
 *  - a `/model` typed at an approval prompt on a Claude Code started without the level (the
 *    switch queues the level), then a second `/model` after the turn;
 *  - two `/effort`s at one approval prompt, then a `/model` after the turn;
 *  - an `/effort` at an approval prompt, then `/model` through a model without effort levels and
 *    back to one that has them;
 *  - an `/effort` at an approval prompt, a `/model` after the turn, then a `/compact` (its line
 *    takes a queued level too);
 *  - the reported REPL path itself: the built CLI, `/effort high` typed at the Write approval
 *    prompt, `y`, `/model` after the turn, a prompt (the transcript's `/effort` entries).
 * The turns wait at a real approval prompt (the UI answers only when the test lets it), so the
 * commands always run while the turn runs, also on a loaded machine.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ClaudeCapabilities } from '../../src/claude/binary.js';
import { KiroSessionImpl, type KiroSessionInternalOptions } from '../../src/session/kiroSession.js';
import type { SessionEvent, TurnResult } from '../../src/types.js';
import { cli, mkRoot } from '../headless/r5f-signals-helpers.js';
import { removeOnExit } from '../tmpdirs.js';
import { closeAll, drain, fakeBinary, fakeCaps, flagValue, mkSandbox, recordingUI, type RecordingUI, type Sandbox } from './helpers.js';

let caps: ClaudeCapabilities;
before(async () => {
  caps = await fakeCaps();
});

const WRITE = { repeat: true, match: 'write it', steps: [{ tool: { name: 'Write', input: { file_path: 'x.txt', content: 'x' } } }, { text: 'WROTE MODEL={{model}} EFFORT={{effort}} END' }] };
const SCRIPT = { turns: [WRITE], default: { steps: [{ text: 'MODEL={{model}} EFFORT={{effort}} END' }] } };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const open = (sb: Sandbox, ui: RecordingUI, over: Partial<KiroSessionInternalOptions> = {}): Promise<KiroSessionImpl> =>
  KiroSessionImpl.create({ ws: sb.ws, origin: 'repl', interactive: true, ui, binary: fakeBinary(), caps, env: sb.env, ...over });

function textOf(line: Record<string, unknown> | undefined): string {
  const c = (line?.message as { content?: unknown } | undefined)?.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.map((b) => (typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'text' ? String((b as { text?: unknown }).text) : '')).join('');
}
const effortLines = (sb: Sandbox): string[] => sb.userLines().map(textOf).filter((t) => /^\/effort\b/.test(t));

/**
 * A turn that waits at the Write approval prompt until `release()`: what runs meanwhile runs
 * while the turn runs (as a slash command typed at that prompt in the chat does).
 */
async function atApproval(s: KiroSessionImpl, ui: RecordingUI): Promise<{ release(): void; done: Promise<{ events: SessionEvent[]; result: TurnResult }> }> {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  ui.answers.push(async () => {
    await gate;
    return { kind: 'allow-once' };
  });
  const asked = ui.approvals.length;
  const done = drain(s.prompt({ text: 'write it' }));
  for (let i = 0; i < 6000 && ui.approvals.length === asked; i++) await sleep(10);
  assert.equal(ui.approvals.length, asked + 1, 'precondition: the turn waits at the approval prompt');
  assert.equal(s.busy, true, 'precondition: the turn runs');
  return { release, done };
}

/** A sandbox whose model list a first session cached (the launch knows haiku 4.5 has no effort levels). */
async function warmSandbox(): Promise<Sandbox> {
  const sb = mkSandbox({ script: SCRIPT });
  const first = await open(sb, recordingUI());
  try {
    await drain(first.prompt({ text: 'warm' }));
  } finally {
    await closeAll(first);
  }
  return sb;
}

describe('r9 #3 (verify): one /effort line per change, other ways in', () => {
  it('a /model at an approval prompt on a Claude Code started without the level, a /model after the turn: one line', async () => {
    const sb = await warmSandbox();
    const ui = recordingUI();
    const s = await open(sb, ui, { model: 'claude-haiku-4.5', effort: 'low' });
    try {
      await drain(s.prompt({ text: 'a' }));
      assert.equal(flagValue(sb.starts().at(-1)!, '--effort'), undefined, 'precondition: the launch dropped --effort');
      const before = effortLines(sb).length;
      const turn = await atApproval(s, ui);
      await s.setModel('claude-sonnet-4.6');
      assert.deepEqual(effortLines(sb).slice(before), [], 'queued while the turn runs');
      turn.release();
      await turn.done;
      await s.setModel('claude-opus-4.6');
      assert.deepEqual(effortLines(sb).slice(before), ['/effort low'], 'the second switch sends the level at once');
      const { result } = await drain(s.prompt({ text: 'b' }));
      assert.match(result.text, /MODEL=claude-opus-4-6 EFFORT=low/);
      assert.deepEqual(effortLines(sb).slice(before), ['/effort low'], 'not a second time before the next prompt line');
    } finally {
      await closeAll(s);
    }
  });

  it('two /effort levels at one approval prompt, a /model after the turn: one line, the last level', async () => {
    const sb = mkSandbox({ script: SCRIPT });
    const ui = recordingUI();
    const s = await open(sb, ui, { model: 'claude-sonnet-4.6', effort: 'low' });
    try {
      await drain(s.prompt({ text: 'a' }));
      const turn = await atApproval(s, ui);
      await s.setEffort('high');
      await s.setEffort('medium');
      turn.release();
      await turn.done;
      assert.deepEqual(effortLines(sb), [], 'queued while the turn ran');
      await s.setModel('claude-opus-4.6');
      const { result } = await drain(s.prompt({ text: 'b' }));
      assert.match(result.text, /MODEL=claude-opus-4-6 EFFORT=medium/);
      assert.deepEqual(effortLines(sb), ['/effort medium']);
      assert.equal(sb.starts().length, 1, 'no respawn');
    } finally {
      await closeAll(s);
    }
  });

  it('an /effort at an approval prompt, then /model through a model without effort levels and back: one line', async () => {
    const sb = await warmSandbox();
    const ui = recordingUI();
    const s = await open(sb, ui, { model: 'claude-sonnet-4.6', effort: 'low' });
    try {
      await drain(s.prompt({ text: 'a' }));
      const before = effortLines(sb).length;
      const turn = await atApproval(s, ui);
      await s.setEffort('high');
      turn.release();
      await turn.done;
      await s.setModel('claude-haiku-4.5');
      assert.deepEqual(effortLines(sb).slice(before), [], 'nothing for a model without effort levels');
      await s.setModel('claude-opus-4.6');
      assert.deepEqual(effortLines(sb).slice(before), ['/effort high']);
      const { result } = await drain(s.prompt({ text: 'b' }));
      assert.match(result.text, /MODEL=claude-opus-4-6 EFFORT=high/);
      assert.deepEqual(effortLines(sb).slice(before), ['/effort high'], 'one line for one change');
    } finally {
      await closeAll(s);
    }
  });

  it('an /effort at an approval prompt, a /model after the turn, then /compact: the compaction line gets no second /effort', async () => {
    const sb = mkSandbox({ script: SCRIPT });
    const ui = recordingUI();
    const s = await open(sb, ui, { model: 'claude-sonnet-4.6', effort: 'low' });
    try {
      await drain(s.prompt({ text: 'a' }));
      const turn = await atApproval(s, ui);
      await s.setEffort('high');
      turn.release();
      await turn.done;
      await s.setModel('claude-opus-4.6');
      assert.deepEqual(effortLines(sb), ['/effort high']);
      await drain(s.compact());
      assert.ok(sb.userLines().map(textOf).some((t) => /^\/compact\b/.test(t)), 'precondition: the /compact line was written');
      const { result } = await drain(s.prompt({ text: 'b' }));
      assert.match(result.text, /EFFORT=high/);
      assert.deepEqual(effortLines(sb), ['/effort high']);
    } finally {
      await closeAll(s);
    }
  });
});

/** The levels of the `/effort` local-command entries in the fake's persisted transcripts. */
function transcriptEfforts(claudeConfig: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) {
        for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          const o = JSON.parse(line) as { message?: { content?: unknown } };
          const t = textOf(o as Record<string, unknown>);
          const m = /<command-name>\/effort<\/command-name>[\s\S]*?<command-args>([^<]*)<\/command-args>/.exec(t) ?? /^\/effort (\w+)/.exec(t);
          if (m) out.push(m[1]!);
        }
      }
    }
  };
  walk(path.join(claudeConfig, 'projects'));
  return out;
}

describe('r9 #3 (verify): the chat, /effort typed at an approval prompt, then /model', () => {
  it('Claude Code gets each level once (the transcript holds /effort low, /effort high)', { timeout: 120_000 }, async () => {
    const r = mkRoot({ turns: [WRITE], default: { steps: [{ text: 'ANSWER MODEL={{model}} EFFORT={{effort}} END' }] } });
    removeOnExit(r.root);
    const c = cli(r, ['chat', '--model', 'claude-sonnet-4.6']);
    try {
      await c.waitFor(/> $/);
      let m = c.o().length;
      c.line('/effort low');
      await c.waitFor(/Effort set to low[\s\S]*> $/, m);
      m = c.o().length;
      c.line('write it');
      await c.waitFor(/y\/n/i, m);
      m = c.o().length;
      c.line('/effort high'); // at the approval prompt: the turn runs
      await c.waitFor(/Effort set to high/, m);
      m = c.o().length;
      c.line('y');
      await c.waitFor(/WROTE MODEL=\S+ EFFORT=low END[\s\S]*> $/, m);
      m = c.o().length;
      c.line('/model claude-opus-4.6');
      await c.waitFor(/Using [^\n]*\n[\s\S]*> $/, m);
      m = c.o().length;
      c.line('hello');
      await c.waitFor(/ANSWER MODEL=\S+ EFFORT=\S+ END[\s\S]*> $/, m);
      assert.match(c.o().slice(m), /ANSWER MODEL=claude-opus-4-6 EFFORT=high END/);
      c.line('/quit');
      const exit = await c.exit;
      assert.equal(exit.code, 0, c.o().slice(-1500));
      assert.deepEqual(transcriptEfforts(path.join(r.home, '.claude')), ['low', 'high'], 'each level once');
    } finally {
      c.dispose();
      r.cleanup();
    }
  });
});

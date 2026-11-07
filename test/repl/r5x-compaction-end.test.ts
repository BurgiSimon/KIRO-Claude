/**
 * r5x X2 (group compaction-end), the REPL: a compaction that ends without compacting is closed by
 * a plain one-line notice, and a `/compact` Claude refuses prints Claude's reason the same way.
 *
 * Before this fix 'Summarizing the conversation history...' stayed open after a compaction Claude
 * reported failed (an automatic one inside a prompt turn printed nothing at all for its end), and
 * a refused `/compact` printed "Kiro is having trouble responding right now: <reason>", wording
 * for a failed answer, not for a refusal.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TurnRenderer, type RenderSettings } from '../../src/repl/render.js';
import type { SessionEvent, TurnResult } from '../../src/types.js';
import { setColorEnabled } from '../../src/util/ansi.js';
import { liveRepl } from '../spec/liveRepl.js';

setColorEnabled(false);

const S: RenderSettings = { markdown: false, showThinking: true, autoExpandToolOutput: false, ascii: false, cwd: '/work' };

function render(events: SessionEvent[], result?: TurnResult): string {
  let out = '';
  const r = new TurnRenderer((s) => (out += s), S, () => 1000);
  r.beginTurn();
  for (const e of events) r.handle(e);
  r.endTurn(result, { progName: 'kiro-claude' });
  return out;
}

const OK: TurnResult = { stopReason: 'end_turn', isError: false, text: 'the answer', permissionDenials: [] };
const refused = (error: string): TurnResult => ({ stopReason: 'local_command', isError: true, text: '', error, localCommand: 'compact', permissionDenials: [] });
const TROUBLE = /trouble responding/;
const count = (s: string, sub: string): number => s.split(sub).length - 1;

test('render: an automatic compaction that fails mid-turn: "Compaction failed: <reason>" closes the start, the answer follows', () => {
  const out = render(
    [
      { type: 'compaction', state: 'started' },
      { type: 'compaction_failed', reason: 'Conversation too long.' },
      { type: 'text_delta', text: 'the answer' },
    ],
    OK,
  );
  const iStart = out.indexOf('Summarizing the conversation history...');
  const iEnd = out.indexOf('Compaction failed: Conversation too long.');
  assert.ok(iStart >= 0 && iEnd > iStart, out);
  assert.ok(out.indexOf('the answer') > iEnd, out);
  assert.doesNotMatch(out, /compacted successfully/);
  assert.doesNotMatch(out, TROUBLE);
  // one line of its own, a blank line before the answer
  assert.match(out, /\nCompaction failed: Conversation too long\.\n\n/);
});

test('render: a cancelled compaction says so and nothing else', () => {
  const out = render(
    [
      { type: 'compaction', state: 'started' },
      { type: 'compaction_failed', reason: 'Compaction cancelled', cancelled: true },
    ],
    { stopReason: 'cancelled', isError: false, text: '', permissionDenials: [] },
  );
  assert.match(out, /Compaction cancelled\./);
  assert.doesNotMatch(out, /Compaction failed/);
  assert.doesNotMatch(out, TROUBLE);
});

test('render: a failed compaction without a reason of Claude\'s reads "Compaction failed." once (a /compact\'s error says the same)', () => {
  const out = render(
    [
      { type: 'compaction', state: 'started' },
      { type: 'compaction_failed', reason: 'Compaction failed' },
    ],
    refused('Compaction failed'),
  );
  assert.equal(count(out, 'Compaction failed'), 1, out);
  assert.match(out, /Compaction failed\.\n/);
  assert.doesNotMatch(out, TROUBLE, out);
});

test('render: a /compact refused with no status ("No messages to compact"): Claude\'s reason as a plain line, not a failed answer', () => {
  const out = render([], refused('No messages to compact'));
  assert.equal(count(out, 'No messages to compact'), 1, out);
  assert.doesNotMatch(out, TROUBLE, out);
  assert.doesNotMatch(out, /compacted successfully/);
});

test('render: a /compact refused after its start ("Not enough messages to compact."): the reason once, from the failed end', () => {
  const why = 'Not enough messages to compact.';
  const out = render(
    [
      { type: 'compaction', state: 'started' },
      { type: 'compaction_failed', reason: why },
    ],
    refused(why),
  );
  assert.equal(count(out, why), 1, out);
  assert.match(out, /Summarizing the conversation history\.\.\.\n(?:\n)?Compaction failed: Not enough messages to compact\.\n/);
  assert.doesNotMatch(out, TROUBLE, out);
});

test('render: a /compact refusal whose turn error says more than the failed end (a restored history): the extra explanation is not lost', () => {
  const out = render(
    [
      { type: 'compaction', state: 'started' },
      { type: 'compaction_failed', reason: 'Not enough messages to compact.' },
    ],
    refused('Not enough messages to compact: Claude Code gets the restored conversation with your next message, so it has nothing to compact yet'),
  );
  assert.match(out, /gets the restored conversation with your next message/);
  assert.doesNotMatch(out, TROUBLE, out);
});

test('render: a prompt turn that fails for another reason after a failed compaction keeps the error line', () => {
  const out = render(
    [
      { type: 'compaction', state: 'started' },
      { type: 'compaction_failed', reason: 'Conversation too long.' },
    ],
    { stopReason: 'error', isError: true, text: '', error: 'Prompt is too long', permissionDenials: [] },
  );
  assert.match(out, /Compaction failed: Conversation too long\./);
  assert.match(out, /Kiro is having trouble responding right now: Prompt is too long/);
});

// ───────────── end to end: the real runRepl over the fake (claude 2.1.319 frames) ─────────────

const TOO_LONG = 'Conversation too long. Press esc twice to go up a few messages and try again.';
const SCRIPT = {
  turns: [{ repeat: true, match: '^autofail', steps: [{ autoCompact: 'failed', error: TOO_LONG }, { text: 'ANSWER after' }] }],
  default: { steps: [{ text: 'ANSWER' }] },
};

test('chat: an automatic compaction that fails inside a turn prints its start, "Compaction failed: <reason>", then the answer', { timeout: 60_000 }, async () => {
  const r = liveRepl(SCRIPT);
  try {
    await r.waitFor(/> $/);
    const out = await r.send('autofail please', /ANSWER after[\s\S]*> $/);
    const iStart = out.indexOf('Summarizing the conversation history...');
    const iEnd = out.indexOf(`Compaction failed: ${TOO_LONG}`);
    assert.ok(iStart >= 0, `no start:\n${out}`);
    assert.ok(iEnd > iStart, `the start was never closed:\n${out}`);
    assert.ok(out.indexOf('ANSWER after') > iEnd, out);
    assert.doesNotMatch(out, TROUBLE, out);
    assert.doesNotMatch(out, /compacted successfully/, out);
    // the next compaction is reported from its start again
    const again = await r.send('autofail again', /ANSWER after[\s\S]*> $/);
    assert.match(again, /Summarizing the conversation history[\s\S]*Compaction failed:/, again);
  } finally {
    await r.close();
  }
});

test('chat: /compact of a new chat prints Claude\'s reason as a plain line, not "Kiro is having trouble responding"', { timeout: 60_000 }, async () => {
  const r = liveRepl(SCRIPT);
  try {
    await r.waitFor(/> $/);
    const out = await r.send('/compact', /No messages to compact[\s\S]*> $/);
    assert.doesNotMatch(out, TROUBLE, out);
    assert.equal(count(out, 'No messages to compact'), 1, out);
  } finally {
    await r.close();
  }
});

test('chat: /effort high, then /compact: "Compaction failed: Not enough messages to compact." once closes the start', { timeout: 60_000 }, async () => {
  const r = liveRepl(SCRIPT);
  try {
    await r.waitFor(/> $/);
    await r.send('/effort high', /> $/);
    const out = await r.send('/compact', /Not enough messages to compact[\s\S]*> $/);
    assert.match(out, /Summarizing the conversation history\.\.\.\s*\nCompaction failed: Not enough messages to compact\./, out);
    assert.equal(count(out, 'Not enough messages to compact'), 1, out);
    assert.doesNotMatch(out, TROUBLE, out);
  } finally {
    await r.close();
  }
});

/**
 * Verifier guards for the r7 session fixes (#1 fork records written with the session's state,
 * #3 the model and the effort as session state across tangents). Each case attacks an entry point
 * the fixer's tests (r7f-session-*.test.ts) do not cover:
 *  - an `/effort` queued for a record's next prompt line (setEffort while a turn runs, while the
 *    child is down, while a restored history is pending) is superseded by any later `/effort`: the
 *    level the user set last is the one Claude Code runs at. Since r7 #3 made the effort session
 *    state, a level set inside a tangent is written to the records under it, so a level queued in
 *    main before the tangent must not be written into main's child after the return (Claude would
 *    run at the stale level while the session reports, and saves, the new one); the same holds
 *    without a tangent (a queued level, then one set directly once the turn ended).
 *  - r7 #9: the `compaction_failed` reason is not always compactErrorText(compact_error): it is
 *    worded as the turn's error (a `/compact` refused while a restored history is pending says
 *    why it had nothing to compact), and `Compaction failed` when Claude gives none; the
 *    SessionEvent doc (src/types.ts) and the kiroSession module doc say so.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ClaudeCapabilities } from '../../src/claude/binary.js';
import { KiroSessionImpl, type KiroSessionInternalOptions } from '../../src/session/kiroSession.js';
import { SessionStore } from '../../src/session/store.js';
import type { SessionRecord } from '../../src/types.js';
import { closeAll, drain, fakeBinary, fakeCaps, mkSandbox, recordingUI, type Sandbox } from './helpers.js';

let caps: ClaudeCapabilities;
before(async () => {
  caps = await fakeCaps();
});

/** `slow…` lines take a while (a turn the test sets the effort during); every answer names the effort. */
const SCRIPT = {
  turns: [{ match: '^slow', repeat: true, steps: [{ sleepMs: 700 }, { text: 'EFFORT={{effort}}' }] }],
  default: { steps: [{ text: 'EFFORT={{effort}}' }] },
};

function sandbox(): Sandbox {
  return mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
}
const open = (sb: Sandbox, over: Partial<KiroSessionInternalOptions> = {}): Promise<KiroSessionImpl> =>
  KiroSessionImpl.create({ ws: sb.ws, origin: 'repl', interactive: true, ui: recordingUI(), binary: fakeBinary(), caps, env: sb.env, ...over });
const read = (sb: Sandbox, id: string): SessionRecord => {
  const r = new SessionStore(sb.sessionsDir).read(id);
  assert.ok(r, `record ${id} exists`);
  return r;
};
const answer = async (s: KiroSessionImpl, text: string): Promise<string> => (await drain(s.prompt({ text }))).result.text;
const effortLines = (sb: Sandbox): string[] =>
  sb
    .userLines()
    .map((l) => (l.message as { content?: unknown } | undefined)?.content)
    .filter((c): c is string => typeof c === 'string' && /^\/effort /.test(c));

/** A turn that runs while `during` runs (`setEffort` then queues its level for the next line). */
async function duringTurn(s: KiroSessionImpl, during: () => Promise<void>): Promise<void> {
  const turn = drain(s.prompt({ text: 'slow turn' }));
  const t0 = Date.now();
  while (!s.busy && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 10));
  assert.ok(s.busy, 'precondition: the turn runs');
  await during();
  await turn;
}

describe('r7 #3 (verify): an /effort queued for the next line never outlives a later /effort', () => {
  it('queued in main while a turn runs, then /tangent, /effort (direct) and back: main runs at the level set last', async () => {
    const sb = sandbox();
    const s = await open(sb);
    try {
      const mainId = s.id;
      await drain(s.prompt({ text: 'hello' }));
      await duringTurn(s, () => s.setEffort('low')); // queued for main's next line
      await s.enterTangent('side');
      await s.setEffort('high'); // the tangent's child is idle: written to it at once
      // (no line in the tangent: a prompt line there would drop main's queued level anyway)
      await s.exitTangent('discard');
      assert.equal(s.effort, 'high', 'the session reports the level set last');
      assert.equal(read(sb, mainId).effort, 'high', "and saves it on main's record");
      const back = await answer(s, 'back in main');
      assert.match(back, /^EFFORT=high/, `main's Claude Code runs at the level set last, not the stale queued one: ${back}`);
      assert.ok(!effortLines(sb).includes('/effort low'), `the superseded level was never written: ${effortLines(sb).join(', ')}`);
    } finally {
      await closeAll(s);
    }
  });

  it('control: queued in main while a turn runs, /tangent and back without a new level: main runs at the queued level', async () => {
    const sb = sandbox();
    const s = await open(sb);
    try {
      await drain(s.prompt({ text: 'hello' }));
      await duringTurn(s, () => s.setEffort('low'));
      await s.enterTangent('side');
      await s.exitTangent('discard');
      assert.equal(s.effort, 'low');
      assert.match(await answer(s, 'back in main'), /^EFFORT=low/);
    } finally {
      await closeAll(s);
    }
  });

  it('without a tangent: queued while a turn runs, then set directly once it ended: the direct level holds', async () => {
    const sb = sandbox();
    const s = await open(sb);
    try {
      await drain(s.prompt({ text: 'hello' }));
      await duringTurn(s, () => s.setEffort('low'));
      await s.setEffort('high'); // idle child: `/effort high` at once
      assert.equal(s.effort, 'high');
      const next = await answer(s, 'next');
      assert.match(next, /^EFFORT=high/, `Claude Code runs at the level set last: ${next}`);
    } finally {
      await closeAll(s);
    }
  });

  it('control: queued while a turn runs, then the next line: written right before it', async () => {
    const sb = sandbox();
    const s = await open(sb);
    try {
      await drain(s.prompt({ text: 'hello' }));
      await duringTurn(s, () => s.setEffort('low'));
      assert.match(await answer(s, 'next'), /^EFFORT=low/);
      assert.deepEqual(effortLines(sb), ['/effort low']);
    } finally {
      await closeAll(s);
    }
  });
});

function repoRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (fs.existsSync(path.join(dir, 'src', 'session', 'kiroSession.ts')) && fs.existsSync(path.join(dir, 'docs', 'ARCHITECTURE.md'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('run the tests from the repository root');
    dir = parent;
  }
}
const oneLine = (s: string): string => s.replace(/\n\s*\*\s?/g, ' ');
const source = (rel: string): string => fs.readFileSync(path.join(repoRoot(), rel), 'utf8');

describe('r7 #9 (verify): a compaction_failed reason worded as the turn error', () => {
  it('a /compact refused while a restored history is pending: the reason says why, and both contract docs say the reason can', async () => {
    const sb = mkSandbox({ script: { turns: [], default: { steps: [{ text: 'ok' }] } }, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const first = await open(sb);
    const id = first.id;
    await drain(first.prompt({ text: 'remember' }));
    await first.close();
    fs.rmSync(path.join(sb.claudeConfig, 'projects'), { recursive: true, force: true }); // the transcript is lost
    const s = await open(sb, { resume: { sessionId: id } });
    try {
      assert.ok(s.record.pendingHistory, 'precondition: the resume fell back, the history is pending');
      await s.setEffort('high'); // queued: Claude's fresh session holds no message yet
      const { events, result } = await drain(s.compact());
      const failed = events.find((e) => e.type === 'compaction_failed');
      assert.ok(failed && failed.type === 'compaction_failed', 'precondition: the compaction failed');
      assert.match(failed.reason, /^Not enough messages to compact: Claude Code gets the restored conversation with your next message/);
      assert.equal(result.error, failed.reason, "the reason is the turn's error");
    } finally {
      await closeAll(s);
    }
    const types = source('src/types.ts');
    const at = types.indexOf("type: 'compaction_failed'");
    const doc = oneLine(types.slice(types.lastIndexOf('/**', at), at));
    assert.match(doc, /restored history is pending/, 'types.ts: the reason of a /compact refused while a restored history is pending');
    assert.match(doc, /`Compaction failed` when Claude gives none/, 'types.ts: the reason when Claude gives none');
    const mod = source('src/session/kiroSession.ts');
    const modDoc = oneLine(mod.slice(mod.indexOf('/**'), mod.indexOf('*/')));
    assert.match(modDoc, /worded as the turn's error, `localFailureText`/, 'module doc: worded as the turn error');
    assert.match(modDoc, /`Compaction failed` when Claude gives none/, 'module doc: the reason when Claude gives none');
  });
});

describe('r7 #3 (verify): a /model inside a tangent whose request got no answer', () => {
  it('the child died before it answered: the choice is kept (r5 verify) and saved at once, on the tangent and on the records under it', async () => {
    const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1', FAKE_CLAUDE_CONTROL_DELAYS: JSON.stringify({ set_model: 5000 }) } });
    const s = await open(sb);
    try {
      const mainId = s.id;
      await drain(s.prompt({ text: 'hello' }));
      const before = s.model;
      assert.notEqual(before, 'claude-sonnet-4.6', 'precondition');
      await s.enterTangent('side');
      const pending = s.setModel('claude-sonnet-4.6');
      pending.catch(() => undefined);
      await new Promise((r) => setTimeout(r, 200));
      process.kill(s.process!.pid!, 'SIGKILL'); // our own fake child dies before it answers
      await assert.rejects(pending);
      assert.equal(s.model, 'claude-sonnet-4.6', 'Claude did not refuse it: the session keeps the model the user chose');
      // a crash now (no clean close) must not resume main on the model the user left
      assert.equal(read(sb, mainId).model, 'claude-sonnet-4.6', "main's record names the kept model at once");
      assert.equal(read(sb, s.id).model, 'claude-sonnet-4.6', "and so does the tangent's");
      await s.exitTangent('discard');
      assert.equal(s.model, 'claude-sonnet-4.6');
    } finally {
      await closeAll(s);
    }
  });
});

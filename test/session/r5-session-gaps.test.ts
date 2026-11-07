/**
 * r5 S5: known session gaps closed.
 *  - /rewind inside an untouched `create({ fork })` copy (a /spec continuation that has not spoken
 *    yet) leaves no pending duplicate of its parent behind: the rewind record holds the
 *    conversation now, the copy had nothing of its own (K1).
 *  - /tangent from a session that fell back to a fresh Claude session with no turn since starts
 *    the tangent fresh with the restored history (the fresh session has no transcript to fork),
 *    and the return to the parent starts it fresh again: the "could not find the saved
 *    conversation" warning is not repeated, and each conversation gets its history once.
 *  - A `/model` whose `set_model` is rejected (also one the REPL stopped waiting for) leaves the
 *    model as it was, in memory and on disk.
 *  - forkSource() of a fork Claude has written (a local command line wrote its transcript) is the
 *    fork itself, no longer its source.
 *  - A `/tangent merge` whose tangent child died and lost its transcript sends the summary request
 *    with the tangent's restored history, once.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ClaudeCapabilities } from '../../src/claude/binary.js';
import { KiroSessionImpl, type KiroSessionInternalOptions } from '../../src/session/kiroSession.js';
import { SessionStore } from '../../src/session/store.js';
import type { KiroSession, SessionRecord } from '../../src/types.js';
import { closeAll, drain, fakeBinary, fakeCaps, mkSandbox, recordingUI, type RecordingUI, type Sandbox } from './helpers.js';

let caps: ClaudeCapabilities;
before(async () => {
  caps = await fakeCaps();
});

const SCRIPT = {
  turns: [{ repeat: true, match: 'Summarize the findings', steps: [{ text: 'SUMMARY of {{historyUserTexts}}' }] }],
  default: { steps: [{ text: 'hist={{historyUserTexts}}' }] },
};

function baseOptions(sb: Sandbox, ui: RecordingUI = recordingUI()): KiroSessionInternalOptions {
  return { ws: sb.ws, origin: 'repl', interactive: true, ui, binary: fakeBinary(), caps, env: sb.env };
}
const open = (sb: Sandbox, over: Partial<KiroSessionInternalOptions> = {}, ui?: RecordingUI): Promise<KiroSessionImpl> =>
  KiroSessionImpl.create({ ...baseOptions(sb, ui), ...over });
const read = (sb: Sandbox, id: string): SessionRecord | undefined => new SessionStore(sb.sessionsDir).read(id);
const fallbacks = (ui: RecordingUI): number => ui.notices.filter((n) => /could not find the saved conversation/i.test(n.message)).length;
const count = (s: string, sub: string): number => s.split(sub).length - 1;
const lastUserText = (sb: Sandbox): string => {
  const c = (sb.userLines().at(-1)!.message as { content: unknown }).content;
  return typeof c === 'string' ? c : JSON.stringify(c);
};

/** Remove every Claude transcript of `claudeId` (a lost transcript). */
function loseTranscript(sb: Sandbox, claudeId: string): void {
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === `${claudeId}.jsonl`) fs.rmSync(p);
    }
  };
  walk(sb.claudeConfig);
}

/** A chat of one turn reopened after its Claude transcript was lost: a fresh session, the history pending. */
async function fellBack(sb: Sandbox, ui: RecordingUI): Promise<KiroSessionImpl> {
  const s = await open(sb);
  await drain(s.prompt({ text: 'alpha ALPHA_1' }));
  const id = s.id;
  const claudeId = s.claudeSessionId!;
  await s.close();
  loseTranscript(sb, claudeId);
  const r = await open(sb, { resume: { sessionId: id } }, ui);
  assert.equal(fallbacks(ui), 1, 'precondition: the reopen fell back');
  assert.ok(r.record.pendingHistory, 'precondition: the history is pending');
  return r;
}

describe('r5 S5: /rewind inside an untouched continuation', () => {
  it('drops the untouched copy it leaves (no pending duplicate of its parent); the rewind keeps the conversation', async () => {
    const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const main = await open(sb);
    let cont: KiroSessionImpl | undefined;
    try {
      await drain(main.prompt({ text: 'alpha ALPHA_1' }));
      await drain(main.prompt({ text: 'beta BETA_2' }));
      const src = main.forkSource();
      cont = await open(sb, { fork: { fromClaudeSessionId: src.from, kind: 'main', parentId: main.id } });
      const contId = cont.id;
      assert.equal(cont.record.turns.length, 2, 'precondition: the copy carries the parent\'s turns (K1)');
      await cont.rewind(1);
      const rewindId = cont.id;
      assert.notEqual(rewindId, contId);
      assert.equal(read(sb, contId), undefined, 'the untouched copy is gone');
      assert.ok(!fs.existsSync(path.join(sb.sessionsDir, `${contId}.jsonl`)));
      const { result } = await drain(cont.prompt({ text: 'after rewind' }));
      assert.equal(result.text, 'hist=alpha ALPHA_1 | after rewind');
      await cont.close();
      assert.equal(read(sb, rewindId)?.forkKind, 'rewind');
      assert.ok(read(sb, main.id), 'the parent is untouched');
    } finally {
      await closeAll(cont, main);
    }
  });

  it('a copy that spoke is kept when it rewinds', async () => {
    const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const main = await open(sb);
    let cont: KiroSessionImpl | undefined;
    try {
      await drain(main.prompt({ text: 'alpha ALPHA_1' }));
      const src = main.forkSource();
      cont = await open(sb, { fork: { fromClaudeSessionId: src.from, kind: 'main', parentId: main.id } });
      const contId = cont.id;
      await drain(cont.prompt({ text: 'own line' }));
      await cont.rewind(1);
      assert.equal(read(sb, contId)?.messageCount, 2, 'its own conversation stays');
    } finally {
      await closeAll(cont, main);
    }
  });
});

describe('r5 S5: /tangent from a session that fell back with no turn since', () => {
  it('warns once: the tangent and the return start fresh, each conversation gets its history once', async () => {
    const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const ui = recordingUI();
    const s = await fellBack(sb, ui);
    try {
      const starts = sb.starts().length;
      await s.enterTangent('side');
      assert.equal(fallbacks(ui), 1, `the warning was repeated: ${ui.notices.map((n) => n.message).join(' / ')}`);
      const argv = sb.starts()[starts]!;
      assert.equal(argv.includes('--fork-session'), false, `no fork of a session with no transcript: ${argv.join(' ')}`);
      assert.equal(sb.starts().length, starts + 1, 'one start, no failing fork first');
      const { result } = await drain(s.prompt({ text: 'in tangent' }));
      assert.equal(count(lastUserText(sb), '<kiro-restored-history>'), 1);
      assert.match(lastUserText(sb), /ALPHA_1/);
      assert.match(result.text, /in tangent/);
      await s.exitTangent('discard');
      assert.equal(fallbacks(ui), 1, `the return repeated it: ${ui.notices.map((n) => n.message).join(' / ')}`);
      await drain(s.prompt({ text: 'back in main' }));
      assert.equal(count(lastUserText(sb), '<kiro-restored-history>'), 1, 'main still gets its own block, once');
      await drain(s.prompt({ text: 'again' }));
      assert.equal(count(lastUserText(sb), '<kiro-restored-history>'), 0);
    } finally {
      await s.close();
    }
  });
});

describe('r5 S5: a rejected set_model', () => {
  it('leaves the model as it was, in memory and on disk (also after the REPL stopped waiting)', async () => {
    const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_CONTROL_ERRORS: JSON.stringify({ set_model: 'model not available' }), FAKE_CLAUDE_CONTROL_DELAYS: JSON.stringify({ set_model: 300 }) } });
    const s = await open(sb);
    try {
      await drain(s.prompt({ text: 'alpha' }));
      const before = s.model;
      assert.notEqual(before, 'claude-sonnet-4.6', 'precondition');
      const pending = s.setModel('claude-sonnet-4.6'); // the REPL's Ctrl+C stops awaiting this
      await assert.rejects(pending, /model not available/);
      assert.equal(s.model, before, 'not the rejected model');
      assert.equal(read(sb, s.id)?.model, before);
      // a later save (any turn) does not write the rejected model either
      await drain(s.prompt({ text: 'beta' }));
      assert.equal(read(sb, s.id)?.model, before);
    } finally {
      await s.close();
    }
  });
});

describe('r5 S5: forkSource() of a fork Claude has written', () => {
  it('is the fork itself once a local command line wrote its transcript, the source before', async () => {
    const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const s = await open(sb);
    try {
      await drain(s.prompt({ text: 'alpha ALPHA_1' }));
      const mainClaude = s.claudeSessionId!;
      await s.enterTangent('side');
      assert.deepEqual(s.forkSource(), { from: mainClaude }, 'an unwritten fork: its source');
      await s.setEffort('low'); // Claude writes the fork's transcript for a local command (VERIFIED 2.1.319)
      const own = s.claudeSessionId!;
      assert.deepEqual(s.forkSource(), { from: own }, 'a written fork: itself');
      const other: KiroSession = await open(sb, { fork: { fromClaudeSessionId: own, kind: 'main', parentId: s.id } });
      try {
        const { result } = await drain(other.prompt({ text: 'from fork' }));
        assert.equal(result.text, 'hist=alpha ALPHA_1 | from fork');
      } finally {
        await other.close();
      }
    } finally {
      await s.close();
    }
  });
});

describe('r5 S5: /tangent merge after the tangent lost its transcript', () => {
  it('the summary request carries the tangent\'s restored history once; the merge summary has the conversation', async () => {
    const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const ui = recordingUI();
    const s = await open(sb, {}, ui);
    try {
      await drain(s.prompt({ text: 'alpha ALPHA_1' }));
      await s.enterTangent('side');
      await drain(s.prompt({ text: 'tangent TANGENT_2' }));
      const tangentClaude = s.claudeSessionId!;
      const tangentId = s.id;
      // the tangent's child dies and its transcript is gone: the merge's summary turn respawns it
      loseTranscript(sb, tangentClaude);
      process.kill(s.process!.pid!, 'SIGKILL'); // our own fake child
      const t0 = Date.now();
      while (s.process?.running && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 20));
      assert.equal(s.process?.running, false, 'precondition: the child is dead');
      await s.exitTangent('merge');
      assert.equal(fallbacks(ui), 1, 'precondition: the respawn fell back');
      const summaryLine = sb
        .userLines()
        .map((l) => (l.message as { content: unknown }).content)
        .map((c) => (typeof c === 'string' ? c : JSON.stringify(c)))
        .filter((c) => c.includes('Summarize the findings'))
        .at(-1)!;
      assert.equal(count(summaryLine, '<kiro-restored-history>'), 1, `the summary request: ${summaryLine.slice(0, 300)}`);
      assert.match(summaryLine, /TANGENT_2/);
      assert.equal(read(sb, tangentId)?.pendingHistory, undefined, 'delivered: a reopen of the tangent does not send it again');
      const { result } = await drain(s.prompt({ text: 'in main' }));
      assert.match(lastUserText(sb), /<tangent-summary[\s\S]*TANGENT_2/, 'the merged summary knows the tangent');
      assert.match(result.text, /in main/);
    } finally {
      await s.close();
    }
  });
});

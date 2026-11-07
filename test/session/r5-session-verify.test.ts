/**
 * r5 session group, verifier: edge cases of the S1-S5 fixes.
 *  - S5d: a `set_model` the CLI rejects after a turn saved the record while the request was
 *    pending (the REPL stopped waiting for it): the rejected model is not left on disk either;
 *    a request that got no answer because the child died refused nothing: the user's choice
 *    stays and the respawn starts with it (the S5 fix reverted it on any failure).
 *  - S2: a `/compact` inside a fresh tangent (a pending fork Claude writes with that command)
 *    records its pin there; a copy of the tangent forks the tangent's own conversation at it.
 *  - S2: two `/compact`s in a row pin at the newer one; a source compacted again after the copy
 *    refuses the older pin, which falls back on the journal without the source's later turns.
 *  - S5b: a fresh tangent of a session that fell back, merged back: the parent's history and the
 *    merge carry each reach its next line once, and the warning is not repeated.
 *  - S5e: a local command in a fork made at a rewind point ends the pending state; a fork of it
 *    holds the history through that point only.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ClaudeCapabilities } from '../../src/claude/binary.js';
import { KiroSessionImpl, type KiroSessionInternalOptions } from '../../src/session/kiroSession.js';
import { SessionStore } from '../../src/session/store.js';
import type { SessionRecord } from '../../src/types.js';
import { closeAll, drain, fakeBinary, fakeCaps, flagValue, mkSandbox, recordingUI, type RecordingUI, type Sandbox } from './helpers.js';

let caps: ClaudeCapabilities;
before(async () => {
  caps = await fakeCaps();
});

const SCRIPT = {
  // (not the fake's {{historyUserTexts}}: that would echo the restored-history block into the carry)
  turns: [{ repeat: true, match: 'Summarize the findings', steps: [{ text: 'SUMMARY_TEXT' }] }],
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

function transcriptFiles(sb: Sandbox, claudeId: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === `${claudeId}.jsonl`) out.push(p);
    }
  };
  walk(sb.claudeConfig);
  return out;
}
const summaries = (sb: Sandbox, claudeId: string): string[] =>
  transcriptFiles(sb, claudeId).flatMap((f) =>
    fs
      .readFileSync(f, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.isCompactSummary === true)
      .map((l) => l.uuid as string),
  );

/** Copy record and journal under a new id the way KiroCrew's Layer B transfer does (08a §4.2). */
function layerBCopy(sb: Sandbox, sid: string): string {
  const nsid = randomUUID();
  const raw = JSON.parse(fs.readFileSync(path.join(sb.sessionsDir, `${sid}.json`), 'utf8')) as Record<string, unknown>;
  raw.session_id = nsid;
  raw.title = null;
  fs.writeFileSync(path.join(sb.sessionsDir, `${nsid}.json`), JSON.stringify(raw));
  fs.copyFileSync(path.join(sb.sessionsDir, `${sid}.jsonl`), path.join(sb.sessionsDir, `${nsid}.jsonl`));
  return nsid;
}

describe('r5 S5d (verify): a set_model rejected after a turn saved the record meanwhile', () => {
  it('the rejected model is not left on disk', async () => {
    const sb = mkSandbox({
      script: SCRIPT,
      env: { FAKE_CLAUDE_CONTROL_ERRORS: JSON.stringify({ set_model: 'model not available' }), FAKE_CLAUDE_CONTROL_DELAYS: JSON.stringify({ set_model: 600 }) },
    });
    const s = await open(sb);
    try {
      await drain(s.prompt({ text: 'alpha' }));
      const before = s.model;
      assert.notEqual(before, 'claude-sonnet-4.6', 'precondition');
      // the REPL's Ctrl+C stopped awaiting this; the user goes on with a prompt
      const pending = s.setModel('claude-sonnet-4.6');
      pending.catch(() => undefined);
      await drain(s.prompt({ text: 'beta' }));
      await assert.rejects(pending, /model not available/);
      assert.equal(s.model, before, 'not the rejected model');
      assert.equal(read(sb, s.id)?.model, before, 'nor on disk (the turn saved it while the request was pending)');
    } finally {
      await s.close();
    }
  });

  it('a request that fails because the child died (not a rejection) keeps the user\'s choice: the respawn applies it', async () => {
    const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_CONTROL_DELAYS: JSON.stringify({ set_model: 5000 }) } });
    const s = await open(sb);
    try {
      await drain(s.prompt({ text: 'alpha' }));
      const before = s.model;
      assert.notEqual(before, 'claude-sonnet-4.6', 'precondition');
      const pending = s.setModel('claude-sonnet-4.6'); // the REPL stopped waiting ("not confirmed yet")
      pending.catch(() => undefined);
      await new Promise((r) => setTimeout(r, 200));
      process.kill(s.process!.pid!, 'SIGKILL'); // our own fake child dies before it answers
      await assert.rejects(pending);
      assert.equal(s.model, 'claude-sonnet-4.6', 'Claude did not refuse it: the session keeps the model the user chose');
      const starts = sb.starts().length;
      await drain(s.prompt({ text: 'beta' }));
      const argv = sb.starts()[starts];
      assert.ok(argv, 'precondition: the prompt respawned the child');
      assert.match(flagValue(argv, '--model') ?? '', /sonnet/, `the respawn runs the chosen model: ${argv.join(' ')}`);
      assert.equal(read(sb, s.id)?.model, 'claude-sonnet-4.6');
    } finally {
      await s.close();
    }
  });
});

describe('r5 S2 (verify): compaction pins in other shapes', () => {
  it('a /compact in a fresh tangent pins the tangent; a copy of it forks the tangent at that pin', async () => {
    const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const s = await open(sb, { origin: 'acp' });
    let copy: KiroSessionImpl | undefined;
    try {
      await drain(s.prompt({ text: 'alpha ALPHA_1' }));
      await s.enterTangent('side');
      await drain(s.compact()); // writes the fork's transcript (pending until now)
      const tangentClaude = s.claudeSessionId!;
      assert.deepEqual(s.forkSource(), { from: tangentClaude }, 'the fork is written: its own source');
      const pin = s.record.turns.at(-1)!.compactUuid!;
      assert.ok(pin, 'the compaction in the tangent recorded its pin');
      assert.deepEqual(summaries(sb, tangentClaude), [pin], 'the summary of the tangent\'s own transcript');
      const tangentId = s.id;
      await s.close();
      assert.equal(read(sb, tangentId)?.pendingFork, undefined, 'no pending fork saved');
      const y = layerBCopy(sb, tangentId);
      const starts = sb.starts().length;
      const ui = recordingUI();
      copy = await open(sb, { origin: 'acp', resume: { sessionId: y } }, ui);
      const argv = sb.starts()[starts]!;
      assert.equal(flagValue(argv, '--resume'), tangentClaude, `argv: ${argv.join(' ')}`);
      assert.equal(flagValue(argv, '--resume-session-at'), pin);
      assert.equal(fallbacks(ui), 0);
      const { result } = await drain(copy.prompt({ text: 'RECALL' }));
      assert.equal(result.text, 'hist=alpha ALPHA_1 | RECALL');
    } finally {
      await closeAll(copy, s);
    }
  });

  it('two /compacts in a row pin at the newer; a source compacted again since the copy falls back without its later turns', async () => {
    const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const s = await open(sb, { origin: 'acp' });
    let o: KiroSessionImpl | undefined;
    let copy: KiroSessionImpl | undefined;
    let copy2: KiroSessionImpl | undefined;
    try {
      await drain(s.prompt({ text: 'alpha ALPHA_1' }));
      await drain(s.compact());
      await drain(s.compact());
      const claudeId = s.claudeSessionId!;
      const sums = summaries(sb, claudeId);
      assert.equal(sums.length, 2, 'precondition: two summaries');
      assert.equal(s.record.turns.at(-1)!.compactUuid, sums[1], 'the newer compaction is the pin');
      const origId = s.id;
      await s.close();
      const y1 = layerBCopy(sb, origId);
      // a copy now is served at that pin
      let starts = sb.starts().length;
      let ui = recordingUI();
      copy = await open(sb, { origin: 'acp', resume: { sessionId: y1 } }, ui);
      assert.equal(flagValue(sb.starts()[starts]!, '--resume-session-at'), sums[1]);
      assert.equal(fallbacks(ui), 0);
      assert.equal((await drain(copy.prompt({ text: 'RECALL' }))).result.text, 'hist=alpha ALPHA_1 | RECALL');
      await copy.close();
      // the original runs on and compacts again: the older pin is gone from what Claude loads
      const y2 = layerBCopy(sb, origId);
      o = await open(sb, { origin: 'acp', resume: { sessionId: origId } });
      await drain(o.prompt({ text: 'gamma-later GAMMA_3' }));
      await drain(o.compact());
      await o.close();
      starts = sb.starts().length;
      ui = recordingUI();
      copy2 = await open(sb, { origin: 'acp', resume: { sessionId: y2 } }, ui);
      assert.equal(flagValue(sb.starts()[starts]!, '--resume-session-at'), sums[1]);
      // (the fake loads from the newest boundary and keeps no summary verbatim, so it refuses the
      // older pin; UNVERIFIED that the real claude never keeps one: either way no later turn leaks)
      assert.equal(fallbacks(ui), 1, 'refused (No message found): the journal fallback');
      const { result } = await drain(copy2.prompt({ text: 'RECALL2' }));
      assert.match(lastUserText(sb), /ALPHA_1/);
      assert.doesNotMatch(lastUserText(sb), /GAMMA_3/, 'never the original\'s later turns');
      assert.match(result.text, /RECALL2/);
    } finally {
      await closeAll(copy2, copy, o, s);
    }
  });
});

describe('r5 S5b (verify): a fresh tangent of a session that fell back, merged back', () => {
  it('the parent\'s next line carries its own history and the merge summary once each; one warning', async () => {
    const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const ui = recordingUI();
    const s0 = await open(sb);
    await drain(s0.prompt({ text: 'alpha ALPHA_1' }));
    const id = s0.id;
    const claudeId = s0.claudeSessionId!;
    await s0.close();
    for (const f of transcriptFiles(sb, claudeId)) fs.rmSync(f);
    const s = await open(sb, { resume: { sessionId: id } }, ui);
    try {
      assert.equal(fallbacks(ui), 1, 'precondition: the reopen fell back');
      await s.enterTangent('side');
      await drain(s.prompt({ text: 'tangent TANGENT_2' }));
      assert.equal(count(lastUserText(sb), '<kiro-restored-history>'), 1);
      await s.exitTangent('merge');
      assert.equal(s.id, id);
      await drain(s.prompt({ text: 'back BACK_3' }));
      const line = lastUserText(sb);
      assert.equal(count(line, '<kiro-restored-history>'), 1, 'the parent\'s own block, once');
      assert.equal(count(line, '<tangent-summary'), 1, 'the merge carry, once');
      assert.match(line, /SUMMARY_TEXT/);
      assert.match(line, /ALPHA_1[\s\S]*BACK_3/);
      assert.equal(fallbacks(ui), 1, `no second warning: ${ui.notices.map((n) => n.message).join(' / ')}`);
      await drain(s.prompt({ text: 'again' }));
      assert.equal(count(lastUserText(sb), '<kiro-restored-history>'), 0);
      assert.equal(count(lastUserText(sb), '<tangent-summary'), 0);
      assert.equal(read(sb, id)?.pendingHistory, undefined);
    } finally {
      await s.close();
    }
  });
});

describe('r5 S5e (verify): a local command in a fork made at a rewind point', () => {
  it('ends the pending state; a fork of it holds the history through that point only', async () => {
    const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const main = await open(sb);
    let f: KiroSessionImpl | undefined;
    let g: KiroSessionImpl | undefined;
    try {
      await drain(main.prompt({ text: 'alpha ALPHA_1' }));
      await drain(main.prompt({ text: 'beta BETA_2' }));
      const at = main.record.turns[0]!.assistantUuid!;
      f = await open(sb, { origin: 'spec', fork: { fromClaudeSessionId: main.claudeSessionId!, at, kind: 'main', parentId: main.id } });
      assert.deepEqual(f.forkSource(), { from: main.claudeSessionId!, at }, 'precondition: pending, pinned');
      await f.setEffort('low');
      assert.deepEqual(f.forkSource(), { from: f.claudeSessionId! }, 'written: itself');
      g = await open(sb, { origin: 'spec', fork: { fromClaudeSessionId: f.claudeSessionId!, kind: 'main', parentId: f.id } });
      const { result } = await drain(g.prompt({ text: 'from fork' }));
      assert.equal(result.text, 'hist=alpha ALPHA_1 | from fork', 'not BETA_2 (cut at the rewind point)');
    } finally {
      await closeAll(g, f, main);
    }
  });
});

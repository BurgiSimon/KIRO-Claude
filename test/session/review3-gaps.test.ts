/**
 * Guards for the gaps the third review's verifiers left in session/ (scratchpad r3-gaps.md):
 *  - S1: a fork made through `create({ fork })` (a spec-phase session or continuation) gets a copy
 *    of its parent's journal (cut at a rewind point `at`), so a fork whose source has no Claude
 *    transcript restores the parent's history instead of starting empty; a failed create leaves
 *    nothing behind.
 *  - S2: a line Claude drops before starting it (the synthetic `cancelled` result) is no turn: no
 *    turn record, no journal entry, and a fork without a turn stays one (`pendingFork`).
 *  - S3: the pending fork source is saved on the record (`SessionRecord.pendingFork`), so a fork
 *    that never got a message (tangent, rewind, transferred copy) is forked again from its source
 *    when it is resumed by id after a quit; the journal fallback stays for a lost source.
 *  - S4: a line written to a child that dies before reading it (no `started`, no output, not in
 *    the transcript) gives back what it carried (tangent carry, restored history); a line the
 *    child did read does not (no double delivery).
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ClaudeCapabilities } from '../../src/claude/binary.js';
import type { ClaudeProcess } from '../../src/claude/process.js';
import { journalHistoryText, promptRecord, readJournal, writeJournalRecords } from '../../src/session/kiroFiles.js';
import { KiroSessionImpl, type KiroSessionInternalOptions } from '../../src/session/kiroSession.js';
import { SessionStore } from '../../src/session/store.js';
import type { KiroSession, SessionRecord } from '../../src/types.js';
import { closeAll, drain, fakeBinary, fakeCaps, flagValue, mkSandbox, recordingUI, type RecordingUI, type Sandbox } from './helpers.js';

let caps: ClaudeCapabilities;
before(async () => {
  caps = await fakeCaps();
});

function baseOptions(sb: Sandbox, ui: RecordingUI = recordingUI()): KiroSessionInternalOptions {
  return { ws: sb.ws, origin: 'repl', interactive: true, ui, binary: fakeBinary(), caps, env: sb.env };
}

async function open(sb: Sandbox, over: Partial<KiroSessionInternalOptions> = {}, ui: RecordingUI = recordingUI()): Promise<KiroSessionImpl> {
  return KiroSessionImpl.create({ ...baseOptions(sb, ui), ...over });
}

/** A fork of `parent`'s conversation, the way SpecSessionDriver.fork asks for one (from its forkSource). */
async function forkOf(sb: Sandbox, parent: KiroSession, ui: RecordingUI = recordingUI(), at?: string): Promise<KiroSessionImpl> {
  const src = parent.forkSource()!;
  const point = at ?? src.at;
  return open(sb, { origin: 'spec', fork: { fromClaudeSessionId: src.from, ...(point ? { at: point } : {}), kind: 'main', parentId: parent.id } }, ui);
}

function contentText(line: Record<string, unknown>): string {
  const c = (line.message as { content: unknown }).content;
  if (typeof c === 'string') return c;
  return (c as { type: string; text?: string }[]).map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('');
}

const userTexts = (sb: Sandbox): string[] => sb.userLines().map(contentText);
const lastUserText = (sb: Sandbox): string => userTexts(sb).at(-1) ?? '';
const count = (hay: string, needle: string): number => hay.split(needle).length - 1;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const read = (sb: Sandbox, id: string): SessionRecord | undefined => new SessionStore(sb.sessionsDir).read(id);
const fallbackNotice = (ui: RecordingUI): boolean => ui.notices.some((n) => /could not find the saved conversation/i.test(n.message));

async function waitFor(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await sleep(10);
  }
}

const BLOCK = '<kiro-restored-history>';
const HIST = {
  turns: [
    { repeat: true, match: '^Summarize the findings', steps: [{ text: 'SUMMARY: the tangent found FOUND_X' }] },
    { repeat: true, match: 'crash me', steps: [{ exit: 1 }] },
  ],
  default: { steps: [{ text: 'hist={{historyUserTexts}}' }] },
};

/** A saved session with `prompts`, its Claude transcripts deleted, resumed: the fallback queued the history. */
async function resumedWithoutTranscript(prompts: string[]): Promise<{ sb: Sandbox; s: KiroSessionImpl }> {
  const sb = mkSandbox({ script: HIST, env: { FAKE_CLAUDE_PERSIST: '1' } });
  const first = await open(sb);
  let id: string;
  try {
    for (const p of prompts) await drain(first.prompt({ text: p }));
    id = first.id;
  } finally {
    await closeAll(first);
  }
  dropTranscripts(sb);
  const ui = recordingUI();
  const s = await open(sb, { resume: { sessionId: id } }, ui);
  assert.ok(fallbackNotice(ui), 'the resume fell back to a fresh Claude session');
  return { sb, s };
}

function dropTranscripts(sb: Sandbox): void {
  fs.rmSync(path.join(sb.claudeConfig, 'projects'), { recursive: true, force: true });
}

/** main `m1`, `/tangent research`, `finding FOUND_X`, `/tangent merge`: main holds the carry. */
async function mainWithCarry(sb: Sandbox): Promise<KiroSessionImpl> {
  const s = await open(sb);
  await drain(s.prompt({ text: 'm1' }));
  await s.enterTangent('research');
  await drain(s.prompt({ text: 'finding FOUND_X' }));
  await s.exitTangent('merge');
  return s;
}

/**
 * Claude reads the next user line and drops it before starting it (`queued`, then `cancelled`,
 * as a `cancel_queued` interrupt does to a line still waiting in its queue): the line never
 * reaches the model (the fake never sees it); ClaudeProcess ends the turn with its synthetic
 * result.
 */
function dropNextUserLine(proc: ClaudeProcess): void {
  const p = proc as unknown as { writeLine(o: unknown): void; handleLine(l: string): void };
  p.writeLine = function (this: unknown, o: unknown): void {
    const m = o as { type?: string; uuid?: string };
    if (m?.type !== 'user' || typeof m.uuid !== 'string') return Object.getPrototypeOf(p).writeLine.call(p, o);
    delete (p as { writeLine?: unknown }).writeLine; // once
    const u = m.uuid;
    setImmediate(() => {
      for (const state of ['queued', 'cancelled']) p.handleLine(JSON.stringify({ type: 'command_lifecycle', command_uuid: u, state, uuid: randomUUID(), session_id: '' }));
    });
  };
}

/** Starts a prompt while the child is stopped, kills the child once the line is in its stdin pipe. */
async function promptIntoDyingChild(s: KiroSessionImpl, text: string, kill: () => Promise<void> = async () => undefined): Promise<{ isError: boolean }> {
  const proc = s.process!;
  process.kill(proc.pid!, 'SIGSTOP'); // the child cannot read stdin any more
  const p = drain(s.prompt({ text }));
  await waitFor(() => proc.busy); // ClaudeProcess wrote the line (sendUserMessage marks it pending)
  await kill();
  process.kill(proc.pid!, 'SIGKILL');
  const r = await p;
  return r.result;
}

// ───────────────────────────── S1 ─────────────────────────────

describe('S1: a fork made by create({fork}) copies its parent\'s journal', () => {
  it('a fork of a session whose Claude session has no transcript (resumed after the transcript was lost, silent since) restores the parent\'s history', async () => {
    const { sb, s } = await resumedWithoutTranscript(['first ALPHA_1', 'second BETA_2']);
    let f: KiroSessionImpl | undefined;
    try {
      const ui = recordingUI();
      f = await forkOf(sb, s, ui);
      const { result } = await drain(f.prompt({ text: 'phase one' }));
      const sent = lastUserText(sb);
      assert.equal(count(sent, BLOCK), 1, `the fork restored no history: ${JSON.stringify(sent.slice(0, 200))}`);
      assert.ok(fallbackNotice(ui), 'the fork source has no transcript either: the fork fell back on its journal');
      assert.match(sent, /ALPHA_1[\s\S]*BETA_2[\s\S]*<\/kiro-restored-history>[\s\S]*phase one/);
      assert.match(result.text, /ALPHA_1[\s\S]*phase one/, 'in the fork\'s Claude conversation now');
      // the fork's own journal: the parent's records, then its own turn
      const hist = journalHistoryText(readJournal(sb.sessionsDir, f.id)) ?? '';
      assert.match(hist, /User: first ALPHA_1[\s\S]*User: second BETA_2[\s\S]*User: phase one/);
      // the parent keeps its own copy of its history for its own next line
      await drain(s.prompt({ text: 'back in main' }));
      assert.equal(count(lastUserText(sb), BLOCK), 1);
    } finally {
      await closeAll(f, s);
    }
  });

  it('a fork at a rewind point copies the journal up to that turn only; an unknown point copies none', async () => {
    const sb = mkSandbox({ script: HIST, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const s = await open(sb);
    let f: KiroSessionImpl | undefined;
    let g: KiroSessionImpl | undefined;
    try {
      await drain(s.prompt({ text: 'first ALPHA_1' }));
      await drain(s.prompt({ text: 'second BETA_2' }));
      await drain(s.prompt({ text: 'third GAMMA_3' }));
      const a1 = s.record.turns[0]!.assistantUuid!;
      dropTranscripts(sb); // the fork has to fall back on its journal
      f = await forkOf(sb, s, recordingUI(), a1);
      const hist = journalHistoryText(readJournal(sb.sessionsDir, f.id)) ?? '';
      assert.match(hist, /ALPHA_1/);
      assert.doesNotMatch(hist, /BETA_2|GAMMA_3/, 'turns after the fork point are not its history');
      await drain(f.prompt({ text: 'from turn one' }));
      const sent = lastUserText(sb);
      assert.match(sent, /<kiro-restored-history>[\s\S]*ALPHA_1[\s\S]*<\/kiro-restored-history>[\s\S]*from turn one/);
      assert.doesNotMatch(sent, /BETA_2|GAMMA_3/);
      g = await forkOf(sb, s, recordingUI(), randomUUID());
      assert.deepEqual(readJournal(sb.sessionsDir, g.id), [], 'the cut is unknown: rewound turns never come back');
    } finally {
      await closeAll(g, f, s);
    }
  });

  it('a fork after /rewind (the driver forks from the rewind record and its point) restores the rewound history only', async () => {
    const sb = mkSandbox({ script: HIST, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const s = await open(sb);
    let f: KiroSessionImpl | undefined;
    try {
      await drain(s.prompt({ text: 'first ALPHA_1' }));
      await drain(s.prompt({ text: 'second BETA_2' }));
      await s.rewind(1);
      assert.ok(s.forkSource().at, 'a rewind fork without a message: its forks start at its point');
      dropTranscripts(sb);
      f = await forkOf(sb, s);
      await drain(f.prompt({ text: 'phase' }));
      const sent = lastUserText(sb);
      assert.match(sent, /<kiro-restored-history>[\s\S]*ALPHA_1[\s\S]*phase/);
      assert.doesNotMatch(sent, /BETA_2/);
    } finally {
      await closeAll(f, s);
    }
  });

  describe('a failed create leaves no copy behind', () => {
    function parentWithJournal(sb: Sandbox): SessionRecord {
      const store = new SessionStore(sb.sessionsDir);
      const parent = store.create({
        origin: 'repl',
        cwd: sb.cwd,
        agent: 'kiro_default',
        model: 'auto',
        turns: [{ userUuid: randomUUID(), assistantUuid: randomUUID(), preview: 'p', at: '2026-01-01T00:00:00.000Z' }],
        messageCount: 1,
      });
      writeJournalRecords(sb.sessionsDir, parent.sessionId, [promptRecord('parent PROMPT_P')]);
      return parent;
    }
    const files = (sb: Sandbox): string[] => fs.readdirSync(sb.sessionsDir).sort();

    for (const at of [false, true]) {
      it(`the child fails to start${at ? ' (fork at a turn)' : ''}: only the parent's files are left`, async () => {
        const sb = mkSandbox({ env: { FAKE_CLAUDE_EXIT_ON_START: '3', FAKE_CLAUDE_STDERR: 'kaboom' } });
        const parent = parentWithJournal(sb);
        await assert.rejects(
          open(sb, { origin: 'spec', fork: { fromClaudeSessionId: parent.claudeSessionId, ...(at ? { at: parent.turns[0]!.assistantUuid! } : {}), kind: 'main', parentId: parent.sessionId } }),
          /kaboom|exit/i,
        );
        assert.deepEqual(files(sb), [`${parent.sessionId}.json`, `${parent.sessionId}.jsonl`].sort());
      });
    }

    it('lock acquisition fails after the fork record was created: only the parent\'s files are left', async () => {
      const sb = mkSandbox();
      const parent = parentWithJournal(sb);
      const orig = SessionStore.prototype.acquireLock;
      SessionStore.prototype.acquireLock = function (): never {
        throw new Error('Failed to start session: simulated lock failure');
      };
      try {
        await assert.rejects(open(sb, { origin: 'spec', fork: { fromClaudeSessionId: parent.claudeSessionId, kind: 'main', parentId: parent.sessionId } }), /simulated lock failure/);
      } finally {
        SessionStore.prototype.acquireLock = orig;
      }
      assert.deepEqual(files(sb), [`${parent.sessionId}.json`, `${parent.sessionId}.jsonl`].sort());
    });

    it('a fork that closes without a message (spec phase, origin spec) removes its record and its journal copy', async () => {
      const sb = mkSandbox();
      const parent = parentWithJournal(sb);
      const f = await open(sb, { origin: 'spec', fork: { fromClaudeSessionId: parent.claudeSessionId, kind: 'main', parentId: parent.sessionId } });
      try {
        assert.match(journalHistoryText(readJournal(sb.sessionsDir, f.id)) ?? '', /PROMPT_P/, 'precondition: the copy');
      } finally {
        await f.close();
      }
      assert.deepEqual(files(sb), [`${parent.sessionId}.json`, `${parent.sessionId}.jsonl`].sort());
    });
  });
});

// ───────────────────────────── S2 ─────────────────────────────

describe('S2: a line Claude drops before starting it is no turn', () => {
  it('a tangent\'s first line dropped: no turn record, no journal entry, still an unwritten fork; a respawn forks main again', async () => {
    const sb = mkSandbox({ script: HIST, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const s = await open(sb);
    try {
      await drain(s.prompt({ text: 'main ALPHA_1' }));
      const mainClaude = s.claudeSessionId!;
      await s.enterTangent('side');
      const turns = s.record.turns.length;
      const messages = s.record.messageCount;
      const journal = readJournal(sb.sessionsDir, s.id).length;
      dropNextUserLine(s.process!);
      const { result } = await drain(s.prompt({ text: 'dropped DROPPED_X' }));
      assert.equal(result.stopReason, 'cancelled', 'precondition: the synthetic result');
      assert.equal(s.record.turns.length, turns, 'no turn recorded');
      assert.equal(s.record.messageCount, messages);
      assert.equal(read(sb, s.id)?.turns.length, turns, 'nor on disk');
      assert.equal(readJournal(sb.sessionsDir, s.id).length, journal, 'not journaled');
      assert.deepEqual(s.forkSource(), { from: mainClaude }, 'still a fork without a message: its forks start at main');
      assert.deepEqual(read(sb, s.id)?.pendingFork, { from: mainClaude });
      // the child crashes: the respawn forks main again (the tangent's own id has no transcript)
      const proc = s.process!;
      process.kill(proc.pid!, 'SIGKILL');
      await waitFor(() => !proc.running);
      const starts = sb.starts().length;
      const { result: r2 } = await drain(s.prompt({ text: 'in tangent' }));
      const argv = sb.starts()[starts]!;
      assert.equal(flagValue(argv, '--resume'), mainClaude);
      assert.ok(argv.includes('--fork-session'));
      assert.match(r2.text, /main ALPHA_1 \| in tangent/);
      assert.doesNotMatch(r2.text, /DROPPED_X/, 'the dropped line is no history');
      assert.equal(s.record.turns.length, turns + 1);
      assert.equal(read(sb, s.id)?.pendingFork, undefined, 'a completed turn materializes the fork');
    } finally {
      await closeAll(s);
    }
  });
});

// ───────────────────────────── S3 ─────────────────────────────

describe('S3: a fork without a message is forked again from its source after a quit', () => {
  it('/tangent, quit, resume the tangent by id: it forks main again (no fallback); after its first turn it resumes its own transcript', async () => {
    const sb = mkSandbox({ script: HIST, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const s = await open(sb);
    let r: KiroSessionImpl | undefined;
    let r2: KiroSessionImpl | undefined;
    try {
      await drain(s.prompt({ text: 'main ALPHA_1' }));
      const mainClaude = s.claudeSessionId!;
      await s.enterTangent('side');
      const tangentId = s.id;
      const tangentClaude = s.claudeSessionId!;
      assert.deepEqual(read(sb, tangentId)?.pendingFork, { from: mainClaude }, 'saved with the record');
      await s.close();
      const ui = recordingUI();
      const starts = sb.starts().length;
      r = await open(sb, { resume: { sessionId: tangentId } }, ui);
      const argv = sb.starts()[starts]!;
      assert.equal(flagValue(argv, '--resume'), mainClaude, `argv: ${argv.join(' ')}`);
      assert.ok(argv.includes('--fork-session'));
      assert.equal(flagValue(argv, '--session-id'), tangentClaude, 'into the tangent\'s own id');
      assert.equal(fallbackNotice(ui), false, 'no journal fallback');
      const { result } = await drain(r.prompt({ text: 'in tangent' }));
      assert.equal(count(lastUserText(sb), BLOCK), 0, 'the history came from Claude\'s transcript');
      assert.match(result.text, /main ALPHA_1 \| in tangent/);
      assert.equal(read(sb, tangentId)?.pendingFork, undefined);
      await r.close();
      const starts2 = sb.starts().length;
      r2 = await open(sb, { resume: { sessionId: tangentId } });
      const argv2 = sb.starts()[starts2]!;
      assert.equal(flagValue(argv2, '--resume'), tangentClaude);
      assert.equal(argv2.includes('--fork-session'), false);
    } finally {
      await closeAll(r2, r, s);
    }
  });

  it('/rewind 1, quit, resume the rewind by id: it forks the source at the rewind point again', async () => {
    const sb = mkSandbox({ script: HIST, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const s = await open(sb);
    let r: KiroSessionImpl | undefined;
    try {
      await drain(s.prompt({ text: 'first ALPHA_1' }));
      await drain(s.prompt({ text: 'second BETA_2' }));
      const mainClaude = s.claudeSessionId!;
      const a1 = s.record.turns[0]!.assistantUuid!;
      await s.rewind(1);
      const rewindId = s.id;
      await s.close();
      const ui = recordingUI();
      const starts = sb.starts().length;
      r = await open(sb, { resume: { sessionId: rewindId } }, ui);
      const argv = sb.starts()[starts]!;
      assert.equal(flagValue(argv, '--resume'), mainClaude, `argv: ${argv.join(' ')}`);
      assert.ok(argv.includes('--fork-session'));
      assert.equal(flagValue(argv, '--resume-session-at'), a1);
      assert.equal(fallbackNotice(ui), false);
      const { result } = await drain(r.prompt({ text: 'after rewind' }));
      assert.match(result.text, /first ALPHA_1 \| after rewind/);
      assert.doesNotMatch(result.text, /BETA_2/);
    } finally {
      await closeAll(r, s);
    }
  });

  it('a transferred copy closed before its first message forks the original again when it is reopened', async () => {
    const sb = mkSandbox({ script: HIST, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const s = await open(sb, { origin: 'acp' });
    let origId: string;
    let origClaude: string;
    try {
      await drain(s.prompt({ text: 'remember ALPHA' }));
      origId = s.id;
      origClaude = s.claudeSessionId!;
    } finally {
      await s.close();
    }
    const newId = randomUUID();
    const raw = JSON.parse(fs.readFileSync(path.join(sb.sessionsDir, `${origId}.json`), 'utf8')) as Record<string, unknown>;
    raw.session_id = newId;
    fs.writeFileSync(path.join(sb.sessionsDir, `${newId}.json`), JSON.stringify(raw));
    fs.copyFileSync(path.join(sb.sessionsDir, `${origId}.jsonl`), path.join(sb.sessionsDir, `${newId}.jsonl`));
    const copy = await open(sb, { origin: 'acp', resume: { sessionId: newId } });
    const copyClaude = copy.claudeSessionId!;
    await copy.close(); // no message: Claude wrote no transcript for the copy's id
    const ui = recordingUI();
    const starts = sb.starts().length;
    const again = await open(sb, { origin: 'acp', resume: { sessionId: newId } }, ui);
    try {
      const argv = sb.starts()[starts]!;
      assert.equal(flagValue(argv, '--resume'), origClaude, `argv: ${argv.join(' ')}`);
      assert.ok(argv.includes('--fork-session'));
      assert.equal(again.claudeSessionId, copyClaude, 'still its own Claude id');
      assert.equal(fallbackNotice(ui), false);
      const { result } = await drain(again.prompt({ text: 'in the copy' }));
      assert.match(result.text, /remember ALPHA \| in the copy/);
      assert.equal(count(lastUserText(sb), BLOCK), 0);
    } finally {
      await closeAll(again);
    }
  });

  it('the source transcript is gone too: the journal fallback restores the history (once)', async () => {
    const sb = mkSandbox({ script: HIST, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const s = await open(sb);
    let r: KiroSessionImpl | undefined;
    try {
      await drain(s.prompt({ text: 'main ALPHA_1' }));
      await s.enterTangent('side');
      const tangentId = s.id;
      await s.close();
      dropTranscripts(sb);
      const ui = recordingUI();
      r = await open(sb, { resume: { sessionId: tangentId } }, ui);
      assert.ok(fallbackNotice(ui));
      await drain(r.prompt({ text: 'in tangent' }));
      const sent = lastUserText(sb);
      assert.equal(count(sent, BLOCK), 1);
      assert.match(sent, /ALPHA_1[\s\S]*<\/kiro-restored-history>[\s\S]*in tangent/);
      assert.equal(read(sb, tangentId)?.pendingFork, undefined, 'the fallback is a new conversation, no fork');
      await drain(r.prompt({ text: 'later' }));
      assert.equal(count(lastUserText(sb), BLOCK), 0);
    } finally {
      await closeAll(r, s);
    }
  });

  it('/clear in a fork without a message starts a new conversation: nothing is forked again', async () => {
    const sb = mkSandbox({ script: HIST, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const s = await open(sb);
    try {
      await drain(s.prompt({ text: 'main ALPHA_1' }));
      await s.enterTangent('side');
      assert.ok(read(sb, s.id)?.pendingFork);
      await s.clear();
      assert.equal(read(sb, s.id)?.pendingFork, undefined);
      assert.deepEqual(s.forkSource(), { from: s.claudeSessionId });
    } finally {
      await closeAll(s);
    }
  });

  it('store: pendingFork round-trips; ids that are not UUIDs (a flag in a copied file) are dropped', () => {
    const sb = mkSandbox();
    const store = new SessionStore(sb.sessionsDir);
    const from = randomUUID();
    const at = randomUUID();
    const rec = store.create({ origin: 'repl', cwd: sb.cwd, agent: 'a', model: 'auto' });
    rec.pendingFork = { from, at };
    store.write(rec);
    assert.deepEqual(store.read(rec.sessionId)?.pendingFork, { from, at });
    rec.pendingFork = { from };
    store.write(rec);
    assert.deepEqual(store.read(rec.sessionId)?.pendingFork, { from });
    const file = path.join(sb.sessionsDir, `${rec.sessionId}.json`);
    for (const bad of [{ from: '--dangerously-skip-permissions' }, { from, at: '--print' }, { from: 42 }, 'x', null]) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      raw.pendingFork = bad;
      fs.writeFileSync(file, JSON.stringify(raw));
      assert.equal(store.read(rec.sessionId)?.pendingFork, undefined, JSON.stringify(bad));
    }
  });
});

// ───────────────────────────── S4 ─────────────────────────────

describe('S4: a line the child never read gives back what it carried', () => {
  it('the child dies with the line unread in its pipe: the tangent carry is back on the record and reaches the next line once', async () => {
    const sb = mkSandbox({ script: HIST, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const s = await mainWithCarry(sb);
    try {
      const res = await promptIntoDyingChild(s, 'lost line');
      assert.equal(res.isError, true, 'the line itself fails visibly');
      assert.ok(!userTexts(sb).some((t) => t.includes('lost line')), 'precondition: the child never read it');
      assert.match(read(sb, s.id)?.pendingContext?.join('\n') ?? '', /<tangent-summary name="research">/, 'saved with the record again');
      await drain(s.prompt({ text: 'what did the tangent find?' }));
      const sent = lastUserText(sb);
      assert.match(sent, /<tangent-summary name="research">[\s\S]*FOUND_X[\s\S]*what did the tangent find\?/);
      assert.equal(count(sent, '<tangent-summary'), 1);
      await drain(s.prompt({ text: 'again' }));
      assert.doesNotMatch(lastUserText(sb), /tangent-summary/, 'delivered once');
    } finally {
      await closeAll(s);
    }
  });

  it('the restored history of a fallback goes with the next line when the child died before reading the first one', async () => {
    const { sb, s } = await resumedWithoutTranscript(['first ALPHA_1']);
    try {
      await promptIntoDyingChild(s, 'lost line');
      await drain(s.prompt({ text: 'next' }));
      const sent = lastUserText(sb);
      assert.equal(count(sent, BLOCK), 1, `the history was lost with the unread line: ${JSON.stringify(sent.slice(0, 160))}`);
      assert.match(sent, /ALPHA_1[\s\S]*next/);
      await drain(s.prompt({ text: 'after' }));
      assert.equal(count(lastUserText(sb), BLOCK), 0);
    } finally {
      await closeAll(s);
    }
  });

  it('a forced stop (close) right after the line was written, the child never read it: the saved record keeps the carry', async () => {
    const sb = mkSandbox({ script: HIST, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const s = await mainWithCarry(sb);
    const mainId = s.id;
    let r: KiroSessionImpl | undefined;
    try {
      let closing: Promise<void> | undefined;
      await promptIntoDyingChild(s, 'lost line', async () => {
        closing = s.close();
      });
      await closing;
      assert.ok(!userTexts(sb).some((t) => t.includes('lost line')), 'precondition: the child never read it');
      assert.match(read(sb, mainId)?.pendingContext?.join('\n') ?? '', /<tangent-summary/, 'still on the saved record');
      r = await open(sb, { resume: { sessionId: mainId } });
      await drain(r.prompt({ text: 'what did the tangent find?' }));
      assert.equal(count(lastUserText(sb), '<tangent-summary'), 1);
    } finally {
      await closeAll(r, s);
    }
  });

  it('a line the child read before it crashed (in its transcript) keeps the carry delivered: not sent twice', async () => {
    const sb = mkSandbox({ script: HIST, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const s = await mainWithCarry(sb);
    try {
      const { result } = await drain(s.prompt({ text: 'crash me' }));
      assert.equal(result.isError, true, 'precondition: the child died mid-turn');
      assert.ok(userTexts(sb).some((t) => t.includes('crash me') && t.includes('<tangent-summary')), 'precondition: it read the line');
      assert.equal(read(sb, s.id)?.pendingContext, undefined);
      await drain(s.prompt({ text: 'next' }));
      assert.doesNotMatch(lastUserText(sb), /tangent-summary/, 'not queued again');
    } finally {
      await closeAll(s);
    }
  });

  it('…also when none of its output reached us before the crash: the transcript decides', async () => {
    const sb = mkSandbox({ script: HIST, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const s = await mainWithCarry(sb);
    try {
      const proc = s.process!;
      const emit = proc.emit.bind(proc) as (ev: string, ...a: unknown[]) => boolean;
      // every frame of this turn is lost on the way (no `started`, no output): only Claude's
      // transcript shows that it read the line
      (proc as unknown as { emit: (ev: string, ...a: unknown[]) => boolean }).emit = (ev, ...a) => (ev === 'frame' ? false : emit(ev, ...a));
      const { result } = await drain(s.prompt({ text: 'crash me' }));
      assert.equal(result.isError, true);
      assert.ok(userTexts(sb).some((t) => t.includes('crash me')), 'precondition: it read the line');
      assert.equal(read(sb, s.id)?.pendingContext, undefined, 'the line is in the transcript: delivered');
      await drain(s.prompt({ text: 'next' }));
      assert.doesNotMatch(lastUserText(sb), /tangent-summary/);
    } finally {
      await closeAll(s);
    }
  });
});

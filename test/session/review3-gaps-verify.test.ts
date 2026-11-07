/**
 * Verifier guards for the session group's round-3 gap fixes (S1-S4, review3-gaps.test.ts):
 *  - S3: a pending fork re-forked after a quit starts at the conversation its record was forked
 *    with, not at wherever its source has moved since (the source can be resumed and continued
 *    in between: main after a quit inside a fresh tangent, the original of a transferred copy).
 *  - S2: a brand-new chat whose only line Claude dropped is no saved chat.
 *  - S4 combined with S3: a pending fork whose first line died unread keeps the carry and the
 *    fork source across a quit.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ClaudeCapabilities } from '../../src/claude/binary.js';
import type { ClaudeProcess } from '../../src/claude/process.js';
import { readJournal } from '../../src/session/kiroFiles.js';
import { KiroSessionImpl, type KiroSessionInternalOptions } from '../../src/session/kiroSession.js';
import { SessionStore } from '../../src/session/store.js';
import type { SessionRecord } from '../../src/types.js';
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

const HIST = {
  turns: [{ repeat: true, match: '^Summarize the findings', steps: [{ text: 'SUMMARY: the tangent found FOUND_X' }] }],
  default: { steps: [{ text: 'hist={{historyUserTexts}}' }] },
};

/** Claude reads the next user line and drops it before starting it (see review3-gaps.test.ts). */
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

// ───────────────────────────── S3: the source moved on ─────────────────────────────

describe('S3 (verify): a pending fork re-forked after a quit keeps the conversation it was forked with', () => {
  it('/tangent, quit inside it, main resumed and continued, then the tangent resumed: main\'s later turns are not in the tangent', async () => {
    const sb = mkSandbox({ script: HIST, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const s = await open(sb);
    let m: KiroSessionImpl | undefined;
    let t: KiroSessionImpl | undefined;
    try {
      await drain(s.prompt({ text: 'first ALPHA_1' }));
      const mainId = s.id;
      const mainClaude = s.claudeSessionId!;
      await s.enterTangent('side');
      const tangentId = s.id;
      await s.close(); // quit inside the tangent, before its first message
      m = await open(sb, { resume: { sessionId: mainId } });
      await drain(m.prompt({ text: 'later GAMMA_3' }));
      await m.close();
      const ui = recordingUI();
      const starts = sb.starts().length;
      t = await open(sb, { resume: { sessionId: tangentId } }, ui);
      const argv = sb.starts()[starts]!;
      assert.equal(flagValue(argv, '--resume'), mainClaude, `argv: ${argv.join(' ')}`);
      assert.ok(argv.includes('--fork-session'));
      assert.equal(flagValue(argv, '--resume-session-at'), read(sb, tangentId)!.turns.at(-1)!.assistantUuid, 'at the tangent\'s own last turn');
      const { result } = await drain(t.prompt({ text: 'in tangent' }));
      assert.match(result.text, /first ALPHA_1/, 'the tangent lost main\'s history');
      assert.doesNotMatch(result.text, /GAMMA_3/, `main's later turn leaked into the tangent: ${result.text}`);
      assert.doesNotMatch(lastUserText(sb), /GAMMA_3/);
    } finally {
      await closeAll(t, m, s);
    }
  });

  it('a transferred copy closed before its first message, the original continued, the copy reopened: the original\'s later turns are not in the copy', async () => {
    const sb = mkSandbox({ script: HIST, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const s = await open(sb, { origin: 'acp' });
    const origId = s.id;
    try {
      await drain(s.prompt({ text: 'remember ALPHA' }));
    } finally {
      await s.close();
    }
    const newId = randomUUID();
    const raw = JSON.parse(fs.readFileSync(path.join(sb.sessionsDir, `${origId}.json`), 'utf8')) as Record<string, unknown>;
    raw.session_id = newId;
    fs.writeFileSync(path.join(sb.sessionsDir, `${newId}.json`), JSON.stringify(raw));
    fs.copyFileSync(path.join(sb.sessionsDir, `${origId}.jsonl`), path.join(sb.sessionsDir, `${newId}.jsonl`));
    const copy = await open(sb, { origin: 'acp', resume: { sessionId: newId } });
    await copy.close(); // no message
    const o = await open(sb, { origin: 'acp', resume: { sessionId: origId } });
    try {
      await drain(o.prompt({ text: 'later GAMMA' }));
    } finally {
      await o.close();
    }
    const again = await open(sb, { origin: 'acp', resume: { sessionId: newId } });
    try {
      const { result } = await drain(again.prompt({ text: 'in the copy' }));
      assert.match(result.text, /remember ALPHA/);
      assert.doesNotMatch(result.text, /GAMMA/, `the original's later turn leaked into the copy: ${result.text}`);
    } finally {
      await closeAll(again);
    }
  });

  it('…the pin is the record\'s own last turn: no later turn of the source, and a pin the source does not hold falls back on the journal (once)', async () => {
    const sb = mkSandbox({ script: HIST, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const s = await open(sb);
    let t: KiroSessionImpl | undefined;
    try {
      await drain(s.prompt({ text: 'first ALPHA_1' }));
      const mainId = s.id;
      await s.enterTangent('side');
      const tangentId = s.id;
      await s.close();
      // the tangent's saved turns name a message main's transcript does not hold (it was rebuilt)
      const file = path.join(sb.sessionsDir, `${tangentId}.json`);
      const rawT = JSON.parse(fs.readFileSync(file, 'utf8')) as { turns: { assistantUuid?: string }[] };
      rawT.turns[rawT.turns.length - 1]!.assistantUuid = randomUUID();
      fs.writeFileSync(file, JSON.stringify(rawT));
      const ui = recordingUI();
      t = await open(sb, { resume: { sessionId: tangentId } }, ui);
      assert.ok(fallbackNotice(ui), 'no fork at an unknown message: the journal fallback');
      await drain(t.prompt({ text: 'in tangent' }));
      const sent = lastUserText(sb);
      assert.equal(count(sent, '<kiro-restored-history>'), 1);
      assert.match(sent, /ALPHA_1[\s\S]*in tangent/);
      assert.ok(read(sb, mainId), 'main is untouched');
    } finally {
      await closeAll(t, s);
    }
  });

  it('…but not at a turn a compaction followed (the fork starts from the compacted source), nor at a turn without an assistant message', async () => {
    const sb = mkSandbox({ script: HIST, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const s = await open(sb);
    let t: KiroSessionImpl | undefined;
    try {
      await drain(s.prompt({ text: 'first ALPHA_1' }));
      await drain(s.compact());
      const mainClaude = s.claudeSessionId!;
      await s.enterTangent('side');
      const tangentId = s.id;
      await s.close();
      let starts = sb.starts().length;
      t = await open(sb, { resume: { sessionId: tangentId } });
      let argv = sb.starts()[starts]!;
      assert.equal(flagValue(argv, '--resume'), mainClaude);
      assert.ok(argv.includes('--fork-session'));
      assert.equal(argv.includes('--resume-session-at'), false, `argv: ${argv.join(' ')}`);
      await t.close();
      // a last turn with no assistant message (e.g. cancelled before any): the whole source
      const file = path.join(sb.sessionsDir, `${tangentId}.json`);
      const rawT = JSON.parse(fs.readFileSync(file, 'utf8')) as { turns: { assistantUuid?: string }[] };
      rawT.turns.push({ ...rawT.turns[0]!, assistantUuid: undefined });
      fs.writeFileSync(file, JSON.stringify(rawT));
      fs.appendFileSync(path.join(sb.sessionsDir, `${tangentId}.jsonl`), JSON.stringify({ version: 1, kind: 'Prompt', timestamp: new Date().toISOString(), data: { message_id: randomUUID(), content: [{ kind: 'text', data: 'cancelled' }] } }) + '\n');
      starts = sb.starts().length;
      t = await open(sb, { resume: { sessionId: tangentId } });
      argv = sb.starts()[starts]!;
      assert.ok(argv.includes('--fork-session'));
      assert.equal(argv.includes('--resume-session-at'), false, `argv: ${argv.join(' ')}`);
    } finally {
      await closeAll(t, s);
    }
  });
});

// ───────────────────────────── S2 ─────────────────────────────

describe('S2 (verify): a dropped line is no turn', () => {
  it('a new chat whose only line Claude dropped is not saved (no record, no journal) when it closes', async () => {
    const sb = mkSandbox({ script: HIST, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const s = await open(sb);
    const id = s.id;
    try {
      dropNextUserLine(s.process!);
      const { result } = await drain(s.prompt({ text: 'dropped' }));
      assert.equal(result.stopReason, 'cancelled');
      assert.equal(s.record.messageCount, 0);
    } finally {
      await s.close();
    }
    assert.equal(read(sb, id), undefined, 'an empty chat stays out of the index');
    assert.deepEqual(readJournal(sb.sessionsDir, id), []);
  });
});

// ───────────────────────────── S3 + S4 ─────────────────────────────

describe('S3 + S4 (verify): a fresh tangent whose first line died unread, then a quit', () => {
  it('keeps the parent carry and the fork source: the resumed tangent forks main and delivers the carry once', async () => {
    const sb = mkSandbox({ script: HIST, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const s = await open(sb);
    let t: KiroSessionImpl | undefined;
    try {
      await drain(s.prompt({ text: 'm1' }));
      await s.enterTangent('research');
      await drain(s.prompt({ text: 'finding FOUND_X' }));
      await s.exitTangent('merge'); // main holds the carry
      const mainClaude = s.claudeSessionId!;
      await s.enterTangent('second'); // the new tangent gets its own copy of the carry
      const tangentId = s.id;
      const proc = s.process!;
      process.kill(proc.pid!, 'SIGSTOP');
      const p = drain(s.prompt({ text: 'lost line' }));
      await waitFor(() => proc.busy);
      process.kill(proc.pid!, 'SIGKILL');
      const r = await p;
      assert.equal(r.result.isError, true);
      await s.close();
      const saved = read(sb, tangentId)!;
      assert.match(saved.pendingContext?.join('\n') ?? '', /<tangent-summary name="research">/, 'the carry is back on the tangent');
      assert.equal(saved.pendingFork?.from, mainClaude, 'still a fork of main');
      const starts = sb.starts().length;
      t = await open(sb, { resume: { sessionId: tangentId } });
      assert.equal(flagValue(sb.starts()[starts]!, '--resume'), mainClaude);
      await drain(t.prompt({ text: 'what was found?' }));
      const sent = lastUserText(sb);
      assert.equal(count(sent, '<tangent-summary'), 1, sent.slice(0, 300));
      assert.doesNotMatch(sent, /lost line/);
      await drain(t.prompt({ text: 'again' }));
      assert.doesNotMatch(lastUserText(sb), /tangent-summary/);
    } finally {
      await closeAll(t, s);
    }
  });
});

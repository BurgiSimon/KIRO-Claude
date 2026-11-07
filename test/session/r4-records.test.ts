/**
 * Guards for the round-4 "session-records" items (scratchpad r4-findings.json):
 *  - #0 (`/chat load` half): an export saved in plan mode comes back in plan mode, so the gate
 *    keeps denying mutating tools.
 *  - #4 (store side): a chat that never had a message, left in the index by a process that died
 *    before its close() (a signal during the start or at the first prompt, SIGKILL, a crash), is
 *    neither listed nor picked by `chat --resume`; it is removed. A starting / idle chat (live
 *    lock), and ACP sessions, tangents and records with turns, messages or journaled prompts are
 *    never touched.
 *  - #5 / #9: the continuation a /spec flow hands to the chat (an untouched `create({ fork })`
 *    record of origin `repl`) is the user's conversation and survives a quit; only a spec-phase
 *    copy (origin `spec`) is dropped as a duplicate. `resumeId()` names the record close() kept.
 *  - #10: a saved record with turns never forks the whole source: a last turn cancelled before
 *    any answer pins at its user line, a trailing compaction pins at the last turn (transferred
 *    copy, `/chat load` of an export without a transcript).
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { ClaudeCapabilities } from '../../src/claude/binary.js';
import { importSessionExport, KiroSessionImpl, type KiroSessionInternalOptions } from '../../src/session/kiroSession.js';
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

/** A fork of `parent`'s conversation as SpecSessionDriver.fork asks for one; `origin` 'spec' = a phase, 'repl' = the continuation. */
async function forkOf(sb: Sandbox, parent: KiroSession, origin: 'spec' | 'repl'): Promise<KiroSessionImpl> {
  const src = parent.forkSource()!;
  return open(sb, { origin, fork: { fromClaudeSessionId: src.from, ...(src.at ? { at: src.at } : {}), kind: 'main', parentId: parent.id } });
}

const SCRIPT = {
  turns: [
    { repeat: true, match: 'SLOWPOKE', steps: [{ sleepMs: 8000 }, { text: 'late answer' }] },
    {
      repeat: true,
      match: 'make the file',
      steps: [{ tool: { name: 'Bash', input: { command: 'touch made-by-test.txt', description: 'Create a file' } } }, { text: 'TOOL-SAID {{lastToolResult}} END' }],
    },
  ],
  default: { steps: [{ text: 'hist={{historyUserTexts}}' }] },
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const read = (sb: Sandbox, id: string): SessionRecord | undefined => new SessionStore(sb.sessionsDir).read(id);
const files = (sb: Sandbox): string[] => (fs.existsSync(sb.sessionsDir) ? fs.readdirSync(sb.sessionsDir).sort() : []);
const fallbackNotice = (ui: RecordingUI): boolean => ui.notices.some((n) => /could not find the saved conversation/i.test(n.message));

async function mainWith(prompts: string[], over: Partial<KiroSessionInternalOptions> = {}): Promise<{ sb: Sandbox; s: KiroSessionImpl }> {
  const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
  const s = await open(sb, over);
  for (const p of prompts) await drain(s.prompt({ text: p }));
  return { sb, s };
}

/** A prompt cancelled (interrupt) before Claude produced any assistant message. */
async function cancelledTurn(s: KiroSession, text: string): Promise<void> {
  const gen = s.prompt({ text });
  const done = drain(gen);
  await sleep(400);
  await s.interrupt();
  const { result } = await done;
  assert.equal(result.stopReason, 'cancelled', 'precondition: the turn was cancelled');
}

/** The pid of a process that has exited (a lock left behind by a dead kiro-claude). */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number(r.stdout);
}

function writeLock(sb: Sandbox, id: string, pid: number, host = os.hostname()): void {
  fs.writeFileSync(path.join(sb.sessionsDir, `${id}.lock`), `${JSON.stringify({ pid, started_at: new Date().toISOString(), host })}\n`);
}

// ───────────────────────────── #0 ─────────────────────────────

describe('r4 #0: /chat load restores plan mode', () => {
  it('an export saved in plan mode is imported in plan mode: the gate still denies a mutating tool', async () => {
    const { sb, s } = await mainWith([]);
    let imported: KiroSessionImpl | undefined;
    try {
      s.planMode = true;
      const before = await drain(s.prompt({ text: 'make the file' }));
      assert.match(before.result.text, /Plan mode is read-only/, `precondition: plan mode denies the tool: ${before.result.text}`);
      const file = path.join(sb.root, 'plan-export.json');
      await s.exportTo(file, true);
      assert.equal((JSON.parse(fs.readFileSync(file, 'utf8')) as { session: SessionRecord }).session.planMode, true);
      imported = (await importSessionExport(file, baseOptions(sb))) as KiroSessionImpl;
      assert.equal(imported.planMode, true, 'the imported session left plan mode');
      assert.equal(read(sb, imported.id)?.planMode, true, 'and so did its record');
      const after = await drain(imported.prompt({ text: 'make the file' }));
      assert.match(after.result.text, /Plan mode is read-only/, `the mutating tool was not denied after /chat load: ${after.result.text}`);
      assert.equal(fs.existsSync(path.join(sb.cwd, 'made-by-test.txt')), false);
    } finally {
      await closeAll(imported, s);
    }
  });

  it('an export saved outside plan mode is imported outside it', async () => {
    const { sb, s } = await mainWith(['first ALPHA_1']);
    let imported: KiroSessionImpl | undefined;
    try {
      const file = path.join(sb.root, 'export.json');
      await s.exportTo(file, true);
      imported = (await importSessionExport(file, baseOptions(sb))) as KiroSessionImpl;
      assert.equal(imported.planMode, false);
    } finally {
      await closeAll(imported, s);
    }
  });
});

// ───────────────────────────── #4 (store side) ─────────────────────────────

describe('r4 #4: a never-used chat left behind by a dead process is no saved session', () => {
  function setup(): { sb: Sandbox; store: SessionStore; real: SessionRecord } {
    const sb = mkSandbox();
    const store = new SessionStore(sb.sessionsDir);
    const real = store.create({ origin: 'repl', cwd: sb.cwd, agent: 'kiro_default', model: 'auto' });
    store.appendTurn(real, { userUuid: randomUUID(), assistantUuid: randomUUID(), preview: 'real conversation', at: new Date().toISOString() }, 'answer');
    fs.writeFileSync(path.join(sb.sessionsDir, `${real.sessionId}.jsonl`), JSON.stringify({ version: 1, kind: 'Prompt', timestamp: new Date().toISOString(), data: { message_id: randomUUID(), content: [{ kind: 'text', data: 'real conversation' }] } }) + '\n');
    return { sb, store, real };
  }
  /** A newer record, as `chat` writes before Claude Code is up (KiroSessionImpl.build). */
  function fresh(store: SessionStore, sb: Sandbox, init: Partial<SessionRecord> = {}): SessionRecord {
    const r = store.create({ origin: 'repl', cwd: sb.cwd, agent: 'kiro_default', model: 'auto', updatedAt: new Date(Date.now() + 60_000).toISOString(), ...init });
    return r;
  }

  it('a dead process\'s empty chat is skipped by list / latestResumable and removed with its lock and journal', () => {
    const { sb, store, real } = setup();
    const left = fresh(store, sb);
    writeLock(sb, left.sessionId, deadPid());
    fs.writeFileSync(path.join(sb.sessionsDir, `${left.sessionId}.jsonl`), '');
    assert.equal(store.latestResumable(sb.cwd)?.sessionId, real.sessionId, '`chat --resume` must continue the real conversation');
    assert.deepEqual(store.list({ cwd: sb.cwd }).map((r) => r.sessionId), [real.sessionId]);
    assert.deepEqual(files(sb).filter((f) => f.startsWith(left.sessionId)), [], 'record, lock and journal are removed');
  });

  it('a chat whose only action was /clear or /compact (a compaction marker) counts as never used too', () => {
    const { sb, store, real } = setup();
    const left = fresh(store, sb);
    writeLock(sb, left.sessionId, deadPid());
    fs.writeFileSync(path.join(sb.sessionsDir, `${left.sessionId}.jsonl`), JSON.stringify({ version: 1, kind: 'Compaction', timestamp: new Date().toISOString(), data: { messages_snapshot: [] } }) + '\n');
    assert.equal(store.latestResumable(sb.cwd)?.sessionId, real.sessionId);
  });

  it('a chat still starting or waiting at its first prompt (a live lock: this process or another) stays listed', () => {
    const { sb, store } = setup();
    const own = fresh(store, sb);
    const lock = store.acquireLock(own.sessionId);
    try {
      assert.equal(store.latestResumable(sb.cwd)?.sessionId, own.sessionId);
    } finally {
      lock.release();
    }
    const other = fresh(store, sb, { updatedAt: new Date(Date.now() + 120_000).toISOString() });
    writeLock(sb, other.sessionId, process.ppid); // a live process that is not us (the test runner)
    assert.equal(store.latestResumable(sb.cwd)?.sessionId, other.sessionId);
    assert.ok(read(sb, other.sessionId));
    // another host's lock is never judged here
    writeLock(sb, other.sessionId, deadPid(), 'some-other-host');
    assert.equal(store.latestResumable(sb.cwd)?.sessionId, other.sessionId);
  });

  it('an empty record without a lock (closed, or another process creating it) is not removed', () => {
    const { sb, store } = setup();
    const r = fresh(store, sb);
    assert.equal(store.latestResumable(sb.cwd)?.sessionId, r.sessionId);
    assert.ok(read(sb, r.sessionId));
  });

  it('never touches ACP sessions, tangents, or records with turns, messages or a journaled prompt, even with a dead lock', () => {
    const { sb, store } = setup();
    const keep: SessionRecord[] = [
      fresh(store, sb, { origin: 'acp' }),
      fresh(store, sb, { forkKind: 'tangent', parentId: randomUUID() }),
      fresh(store, sb, { messageCount: 1 }),
      fresh(store, sb, { turns: [{ userUuid: randomUUID(), preview: 'cancelled before an answer', at: new Date().toISOString() }] }),
    ];
    const prompted = fresh(store, sb);
    fs.writeFileSync(path.join(sb.sessionsDir, `${prompted.sessionId}.jsonl`), JSON.stringify({ version: 1, kind: 'Prompt', timestamp: new Date().toISOString(), data: { message_id: randomUUID(), content: [{ kind: 'text', data: 'cleared later' }] } }) + '\n');
    keep.push(prompted);
    const dead = deadPid();
    for (const r of keep) writeLock(sb, r.sessionId, dead);
    const listed = new Set(store.list({ cwd: sb.cwd }).map((r) => r.sessionId));
    for (const r of keep) {
      assert.ok(listed.has(r.sessionId), `${r.origin}/${r.forkKind} removed`);
      assert.ok(read(sb, r.sessionId));
    }
  });

  it('a real chat killed before its first reply leaves nothing `chat --resume` would pick', async () => {
    const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const s = await open(sb);
    await drain(s.prompt({ text: 'real conversation' }));
    await s.close();
    const k = await open(sb);
    try {
      // what a death by signal leaves: the record and a lock naming a process that is gone
      assert.ok(read(sb, k.id), 'precondition: the fresh record is in the index while the chat runs');
      assert.equal(new SessionStore(sb.sessionsDir).latestResumable(sb.cwd)?.sessionId, k.id, 'a live chat stays listed');
      writeLock(sb, k.id, deadPid());
      const store = new SessionStore(sb.sessionsDir);
      assert.equal(store.latestResumable(sb.cwd)?.sessionId, s.id);
      assert.equal(read(sb, k.id), undefined);
    } finally {
      await closeAll(k);
    }
  });
});

// ───────────────────────────── #5 / #9 ─────────────────────────────

describe('r4 #5/#9: the continuation a /spec flow hands to the chat survives a quit', () => {
  it('an untouched continuation (origin repl) is kept with the conversation, resumable by its id, spec turns included', async () => {
    const { sb, s } = await mainWith(['remember CODEWORD-PELICAN']);
    let phase: KiroSessionImpl | undefined;
    let cont: KiroSessionImpl | undefined;
    let r: KiroSessionImpl | undefined;
    try {
      phase = await forkOf(sb, s, 'spec');
      await drain(phase.prompt({ text: 'Phase: REQUIREMENTS draft' }));
      cont = await forkOf(sb, phase, 'repl');
      await phase.close();
      await s.close();
      const id = cont.id;
      await cont.close(); // the user quits before typing a line
      const rec = read(sb, id);
      assert.ok(rec, 'the continuation was dropped as an untouched copy');
      assert.equal(cont.resumeId(), id, 'the exit hint names the continuation');
      assert.equal(rec.turns.length, 2, 'main\'s turn and the spec turn');
      assert.equal(new SessionStore(sb.sessionsDir).latestResumable(sb.cwd)?.sessionId, id, '`chat --resume` picks the chat the user left');
      r = await open(sb, { resume: { latest: true } });
      assert.equal(r.id, id);
      const { result } = await drain(r.prompt({ text: 'which code word?' }));
      assert.match(result.text, /hist=remember CODEWORD-PELICAN \| Phase: REQUIREMENTS draft \| which code word\?/);
    } finally {
      await closeAll(r, cont, phase, s);
    }
  });

  it('an untouched spec-phase copy (origin spec) is still dropped; resumeId() names its parent, which holds the conversation', async () => {
    const { sb, s } = await mainWith(['first ALPHA_1']);
    try {
      const before = files(sb).filter((f) => f.endsWith('.json'));
      const phase = await forkOf(sb, s, 'spec');
      await phase.close();
      assert.deepEqual(files(sb).filter((f) => f.endsWith('.json')), before, 'a duplicate of main in the index');
      assert.equal(phase.resumeId(), s.id);
    } finally {
      await closeAll(s);
    }
  });

  it('a chat that never had a message: closing drops it and resumeId() is undefined; a chat with a turn names itself', async () => {
    const { sb, s } = await mainWith([]);
    let t: KiroSessionImpl | undefined;
    try {
      const id = s.id;
      const before = typeof s.resumeId === 'function' ? s.resumeId() : undefined;
      await s.close();
      assert.equal(before, id, 'before close: its own id');
      assert.equal(read(sb, id), undefined);
      assert.equal(s.resumeId(), undefined, 'no hint for a record closing dropped');
      t = await open(sb);
      await drain(t.prompt({ text: 'hello' }));
      await t.close();
      assert.equal(t.resumeId(), t.id);
      assert.ok(read(sb, t.id));
    } finally {
      await closeAll(t, s);
    }
  });
});

// ───────────────────────────── #10 ─────────────────────────────

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

describe('r4 #10: a saved record with turns never forks the whole source', () => {
  for (const lastStep of ['cancelled', 'compacted'] as const) {
    it(`a transferred copy whose last turn was ${lastStep === 'cancelled' ? 'cancelled before any answer' : 'followed by a compaction'} does not see the original's later turns`, async () => {
      const { sb, s } = await mainWith(['alpha ALPHA_1'], { origin: 'acp' });
      let o: KiroSessionImpl | undefined;
      let copy: KiroSessionImpl | undefined;
      try {
        if (lastStep === 'cancelled') await cancelledTurn(s, 'SLOWPOKE beta');
        else {
          await drain(s.prompt({ text: 'beta BETA_2' }));
          await drain(s.compact());
        }
        const last = s.record.turns.at(-1)!;
        if (lastStep === 'cancelled') assert.equal(last.assistantUuid, undefined, 'precondition: no answer recorded');
        const origId = s.id;
        await s.close();
        const y = layerBCopy(sb, origId);
        o = await open(sb, { origin: 'acp', resume: { sessionId: origId } });
        await drain(o.prompt({ text: 'gamma-later GAMMA_3' }));
        await o.close();
        const starts = sb.starts().length;
        const ui = recordingUI();
        copy = await open(sb, { origin: 'acp', resume: { sessionId: y } }, ui);
        const argv = sb.starts()[starts]!;
        assert.ok(argv.includes('--fork-session'), `argv: ${argv.join(' ')}`);
        assert.equal(flagValue(argv, '--resume-session-at'), lastStep === 'cancelled' ? last.userUuid : last.assistantUuid, 'pinned at the copied record\'s last turn');
        assert.equal(fallbackNotice(ui), false, 'the source holds the pin');
        const { result } = await drain(copy.prompt({ text: 'RECALL' }));
        assert.match(result.text, lastStep === 'cancelled' ? /alpha ALPHA_1 \| SLOWPOKE beta \| RECALL/ : /alpha ALPHA_1 \| beta BETA_2 \| RECALL/);
        assert.doesNotMatch(result.text, /GAMMA_3/, `the copy sees a turn the original made after the copy: ${result.text}`);
      } finally {
        await closeAll(copy, o, s);
      }
    });
  }

  it('/chat load of an export without a transcript whose last turn was cancelled pins at that turn\'s user line', async () => {
    const { sb, s } = await mainWith(['alpha ALPHA_1']);
    let imported: KiroSessionImpl | undefined;
    try {
      const mainClaude = s.claudeSessionId!;
      await cancelledTurn(s, 'SLOWPOKE beta');
      const last = s.record.turns.at(-1)!;
      assert.equal(last.assistantUuid, undefined, 'precondition');
      const file = path.join(sb.root, 'export.json');
      await s.exportTo(file, true);
      const data = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      data.claudeTranscript = ''; // e.g. unreadable when it was exported
      fs.writeFileSync(file, JSON.stringify(data));
      await drain(s.prompt({ text: 'later GAMMA_3' })); // the original runs on
      const starts = sb.starts().length;
      imported = (await importSessionExport(file, baseOptions(sb))) as KiroSessionImpl;
      const argv = sb.starts()[starts]!;
      assert.equal(flagValue(argv, '--resume'), mainClaude, `argv: ${argv.join(' ')}`);
      assert.equal(flagValue(argv, '--resume-session-at'), last.userUuid);
      const { result } = await drain(imported.prompt({ text: 'loaded' }));
      assert.match(result.text, /hist=alpha ALPHA_1 \| SLOWPOKE beta \| loaded/);
      assert.doesNotMatch(result.text, /GAMMA_3/);
    } finally {
      await closeAll(imported, s);
    }
  });
});

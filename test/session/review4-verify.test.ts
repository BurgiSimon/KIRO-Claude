/**
 * Verifier guards for the round-4 session items (K1, K3, K4; scratchpad r3g-gaps.md), for cases
 * the first fix missed:
 *  - K4: a fresh chat whose only action was `/clear` (or `/compact`) never had a conversation:
 *    closing it still leaves nothing in the index (as before K4); a cleared chat that had one is
 *    kept.
 *  - K1: the continuation a /spec flow hands over carries its parent's turns, so `/tangent` works in
 *    it straight away; what the tangent carries back (`/tangent tail` / `merge`) is the
 *    continuation's own and must survive a quit (it was dropped as an untouched copy), and so must
 *    a continuation whose first prompt was sent but never answered (the REPL's forced stop): the
 *    REPL re-creates the stopped session from its record, and without it the chat would restart
 *    empty.
 *  - K2: `/chat load` of an exported fork that has no message yet at its own point (a fresh
 *    `/rewind N`) forks the source at that point, not at the record's last turn or the whole source.
 *  - K3: a /clear cancelled while its agentSpawn hooks ran changes nothing, not even the cache of
 *    the per-prompt hooks; a `/chat resume` cancelled the same way leaves the saved record as it
 *    was (it was rewritten, its `updatedAt` moving it to the top of the session lists).
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ClaudeCapabilities } from '../../src/claude/binary.js';
import type { ClaudeProcess } from '../../src/claude/process.js';
import { importSessionExport, KiroSessionImpl, type KiroSessionInternalOptions } from '../../src/session/kiroSession.js';
import { isSessionStartCancelled, withStartSignal } from '../../src/session/startSignal.js';
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

/** A fork of `parent`'s conversation, the way SpecSessionDriver.fork asks for one. */
async function forkOf(sb: Sandbox, parent: KiroSession, ui: RecordingUI = recordingUI()): Promise<KiroSessionImpl> {
  const src = parent.forkSource()!;
  return open(sb, { origin: 'spec', fork: { fromClaudeSessionId: src.from, ...(src.at ? { at: src.at } : {}), kind: 'main', parentId: parent.id } }, ui);
}

const HIST = {
  turns: [{ repeat: true, match: 'slow thing', steps: [{ text: 'working' }, { sleepMs: 30_000 }, { text: 'done' }] }],
  default: { steps: [{ text: 'hist={{historyUserTexts}}' }] },
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const read = (sb: Sandbox, id: string): SessionRecord | undefined => new SessionStore(sb.sessionsDir).read(id);
const recordFiles = (sb: Sandbox): string[] => (fs.existsSync(sb.sessionsDir) ? fs.readdirSync(sb.sessionsDir).filter((f) => f.endsWith('.json')).sort() : []);

async function waitFor(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await sleep(10);
  }
}

/** Claude reads the next user line and drops it before starting it (S2, as in review3-gaps.test.ts). */
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

async function mainWith(prompts: string[], env: Record<string, string> = {}): Promise<{ sb: Sandbox; s: KiroSessionImpl }> {
  const sb = mkSandbox({ script: HIST, env: { FAKE_CLAUDE_PERSIST: '1', ...env } });
  const s = await open(sb);
  for (const p of prompts) await drain(s.prompt({ text: p }));
  return { sb, s };
}

describe('K4 (verifier): only a chat that had a conversation survives as a cleared record', () => {
  it('a fresh chat whose only action was /clear leaves nothing in the index when it closes', async () => {
    const sb = mkSandbox({ script: HIST, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const s = await open(sb);
    await s.clear();
    await s.close();
    assert.deepEqual(recordFiles(sb), [], 'an empty chat in the index');
    assert.equal(fs.existsSync(path.join(sb.sessionsDir, `${s.id}.jsonl`)), false, 'nor its journal');
  });

  it('a fresh chat whose only action was /compact leaves nothing in the index either', async () => {
    const sb = mkSandbox({ script: HIST, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const s = await open(sb);
    await drain(s.compact());
    await s.close();
    assert.deepEqual(recordFiles(sb), []);
  });

  it('a chat cleared after a conversation is kept, also after a reopen that sent nothing', async () => {
    const { sb, s } = await mainWith(['first ALPHA_1']);
    await s.clear();
    await s.close();
    assert.ok(read(sb, s.id), 'the cleared chat is kept');
    const r = await open(sb, { resume: { sessionId: s.id } });
    await r.close();
    assert.ok(read(sb, s.id), 'still kept after a reopen without a message');
  });
});

describe('K1 (verifier): what the continuation gets of its own is never dropped with it', () => {
  for (const how of ['tail', 'merge'] as const) {
    it(`a /tangent ${how} carry back into an untouched continuation survives a quit`, async () => {
      const { sb, s } = await mainWith(['first ALPHA_1']);
      let f: KiroSessionImpl | undefined;
      try {
        f = await forkOf(sb, s);
        await f.enterTangent('side');
        await drain(f.prompt({ text: 'side SIDE_2' }));
        await f.exitTangent(how);
        assert.equal(f.record.pendingContext?.length, 1, 'precondition: the carry is queued on the continuation');
        const id = f.id;
        await f.close();
        const rec = read(sb, id);
        assert.ok(rec, `the continuation with the ${how} carry was dropped`);
        assert.equal(rec.pendingContext?.length, 1, 'with its carry');
        assert.match(rec.pendingContext![0]!, /tangent-(tail|summary)/);
      } finally {
        await closeAll(f, s);
      }
    });
  }

  it('a continuation closed while its first prompt runs (the REPL\'s forced stop) stays resumable, with the conversation it continues', async () => {
    const { sb, s } = await mainWith(['first ALPHA_1'], { FAKE_CLAUDE_CONTROL_DELAYS: JSON.stringify({ interrupt: 120_000 }) });
    let f: KiroSessionImpl | undefined;
    let r: KiroSessionImpl | undefined;
    try {
      f = await forkOf(sb, s);
      const id = f.id;
      const gen = f.prompt({ text: 'run the slow thing' });
      const running = drain(gen).catch(() => undefined);
      await waitFor(() => sb.userLines().some((l) => JSON.stringify(l).includes('run the slow thing')));
      await sleep(200);
      await f.close(); // what the REPL's forced stop does
      await running;
      assert.ok(read(sb, id), 'the stopped continuation was dropped: the REPL would restart an empty chat');
      r = await open(sb, { resume: { sessionId: id } });
      const { result } = await drain(r.prompt({ text: 'after stop' }));
      assert.match(result.text, /hist=first ALPHA_1 \| /, `main's conversation is lost: ${result.text}`);
    } finally {
      await closeAll(r, f, s);
    }
  });

  it('a line Claude drops before starting it (S2) leaves the continuation an untouched copy: dropped on close', async () => {
    const { sb, s } = await mainWith(['first ALPHA_1']);
    try {
      const f = await forkOf(sb, s);
      dropNextUserLine(f.process!);
      const { result } = await drain(f.prompt({ text: 'dropped DROPPED_X' }));
      assert.equal(result.stopReason, 'cancelled', 'precondition: the synthetic result');
      const id = f.id;
      await f.close();
      assert.equal(read(sb, id), undefined, 'a duplicate of its parent left in the index');
    } finally {
      await closeAll(s);
    }
  });

  it('an untouched continuation is still dropped when nothing of its own happened (a tangent discarded)', async () => {
    const { sb, s } = await mainWith(['first ALPHA_1']);
    try {
      const f = await forkOf(sb, s);
      await f.enterTangent('side');
      await f.exitTangent('discard');
      const id = f.id;
      await f.close();
      assert.equal(read(sb, id), undefined);
    } finally {
      await closeAll(s);
    }
  });
});

describe('K3 (verifier): a cancelled /clear changes nothing', () => {
  it('a resume cancelled through its start signal leaves the saved record file as it was', async () => {
    const sb = mkSandbox({ script: HIST, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const s = await open(sb);
    await drain(s.prompt({ text: 'first ALPHA_1' }));
    await s.close();
    const pidFile = path.join(sb.root, 'spawn.pid');
    sb.write('.kiro/hooks/spawn.json', JSON.stringify({ version: 'v1', hooks: [{ name: 'spawn', trigger: 'SessionStart', timeout: 0, action: { type: 'command', command: `echo $$ > '${pidFile}'; sleep 30` } }] }));
    const file = path.join(sb.sessionsDir, `${s.id}.json`);
    const before = fs.readFileSync(file, 'utf8');
    await sleep(20); // a rewrite would move updatedAt
    try {
      const ac = new AbortController();
      const p = withStartSignal(ac.signal, () => open(sb, { resume: { sessionId: s.id } }));
      p.then((x) => x.close()).catch(() => undefined);
      await waitFor(() => fs.existsSync(pidFile));
      ac.abort();
      const err = await p.then(() => undefined, (e: unknown) => e);
      assert.ok(isSessionStartCancelled(err), String(err));
      assert.equal(fs.readFileSync(file, 'utf8'), before, 'the cancelled resume rewrote the saved record');
    } finally {
      try {
        const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
        if (pid) process.kill(-pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
  });

  it('the cache of a per-prompt hook survives a /clear cancelled while the agentSpawn hooks ran', async () => {
    const sb = mkSandbox({ script: HIST, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const once = path.join(sb.root, 'spawn.once');
    const pidFile = path.join(sb.root, 'spawn.pid');
    const runs = path.join(sb.root, 'prompt.runs');
    const spawnCmd = `if [ -f '${once}' ]; then echo $$ > '${pidFile}'; sleep 30; fi; touch '${once}'; echo SPAWN-CTX`;
    // V2 agent hooks (cache_ttl_seconds is a V2 field; timeout_ms 0 = never)
    sb.agent('cachey', {
      description: 'agent with cached hooks',
      hooks: {
        agentSpawn: [{ command: spawnCmd, timeout_ms: 0 }],
        userPromptSubmit: [{ command: `echo run >> '${runs}'; echo PROMPT-CTX`, cache_ttl_seconds: 3600 }],
      },
    });
    const s = await open(sb, { agentName: 'cachey' });
    try {
      // (the cache key holds the prompt: the same prompt is served from the cache)
      await drain(s.prompt({ text: 'same SAME' }));
      const countRuns = (): number => (fs.existsSync(runs) ? fs.readFileSync(runs, 'utf8').trim().split('\n').length : 0);
      assert.equal(countRuns(), 1, 'precondition: the prompt hook ran once');
      await drain(s.prompt({ text: 'same SAME' }));
      assert.equal(countRuns(), 1, 'precondition: then from its cache');
      const p = s.clear();
      p.catch(() => undefined);
      await waitFor(() => fs.existsSync(pidFile));
      await s.interrupt();
      const err = await p.then(() => undefined, (e: unknown) => e);
      assert.ok(isSessionStartCancelled(err), String(err));
      await drain(s.prompt({ text: 'same SAME' }));
      assert.equal(countRuns(), 1, 'the cancelled /clear emptied the hook cache');
      assert.equal(s.record.turns.length, 3, 'nor was anything cleared');
      // a /clear that completes still empties it (Q): the agentSpawn hook is fast again
      fs.rmSync(once);
      await s.clear();
      await drain(s.prompt({ text: 'same SAME' }));
      assert.equal(countRuns(), 2, 'a completed /clear empties the cache');
    } finally {
      try {
        const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
        if (pid) process.kill(-pid, 'SIGKILL');
      } catch {
        /* gone */
      }
      await closeAll(s);
    }
  });
});

describe('K2 (verifier): an exported pending rewind is forked again at its own point', () => {
  it('/rewind 1, /chat save (no transcript yet), main runs on, /chat load: --resume-session-at turn 1, only turn 1 is history', async () => {
    const { sb, s } = await mainWith(['first ALPHA_1', 'second BETA_2']);
    let imported: KiroSessionImpl | undefined;
    try {
      const mainClaude = s.claudeSessionId!;
      const a1 = s.record.turns[0]!.assistantUuid!;
      const mainId = s.id;
      await s.rewind(1);
      const file = path.join(sb.root, 'rewind-export.json');
      await s.exportTo(file, true);
      const data = JSON.parse(fs.readFileSync(file, 'utf8')) as { claudeTranscript: string; session: SessionRecord };
      assert.equal(data.claudeTranscript, '', 'precondition: the rewind fork has no transcript yet');
      assert.deepEqual(data.session.pendingFork, { from: mainClaude, at: a1 });
      await s.close();
      // main runs on after the export
      const m = await open(sb, { resume: { sessionId: mainId } });
      await drain(m.prompt({ text: 'later LATER_3' }));
      await m.close();
      const starts = sb.starts().length;
      imported = (await importSessionExport(file, baseOptions(sb))) as KiroSessionImpl;
      const argv = sb.starts()[starts]!;
      assert.equal(flagValue(argv, '--resume'), mainClaude, `argv: ${argv.join(' ')}`);
      assert.equal(flagValue(argv, '--resume-session-at'), a1);
      assert.equal(imported.record.turns.length, 1);
      const { result } = await drain(imported.prompt({ text: 'loaded' }));
      assert.match(result.text, /hist=first ALPHA_1 \| loaded$/);
    } finally {
      await closeAll(imported, s);
    }
  });
});

describe('K1/K2 (verifier): a fork or import that fell back to a fresh Claude session respawns as one until its first turn', () => {
  const fallbacks = (ui: RecordingUI): number => ui.notices.filter((n) => /could not find the saved conversation/i.test(n.message)).length;

  it('a create({fork}) copy whose source has no transcript: /agent swap before its first turn starts a new conversation again (no second fallback)', async () => {
    const { sb, s } = await mainWith(['first ALPHA_1']);
    sb.agent('other', { description: 'another agent' });
    let f: KiroSessionImpl | undefined;
    try {
      fs.rmSync(path.join(sb.claudeConfig, 'projects'), { recursive: true, force: true });
      const ui = recordingUI();
      f = await forkOf(sb, s, ui);
      assert.equal(fallbacks(ui), 1, 'precondition: the fork fell back to the journal');
      assert.ok(f.record.turns.length > 0, 'precondition: it carries its parent\'s turns (K1)');
      const starts = sb.starts().length;
      await f.swapAgent('other');
      const argv = sb.starts()[starts]!;
      assert.equal(argv.includes('--resume'), false, `a --resume of a Claude session without a transcript: ${argv.join(' ')}`);
      assert.equal(sb.starts().length, starts + 1, 'one spawn');
      assert.equal(fallbacks(ui), 1, 'the fallback warning came again');
      const { result } = await drain(f.prompt({ text: 'after swap' }));
      assert.match(result.text, /first ALPHA_1/, 'the restored history still goes with the first line');
    } finally {
      await closeAll(f, s);
    }
  });

  it('an import without a transcript or source (journal as context): /agent swap before its first turn starts a new conversation again', async () => {
    const { sb, s } = await mainWith(['first ALPHA_1']);
    sb.agent('other', { description: 'another agent' });
    let imported: KiroSessionImpl | undefined;
    try {
      const file = path.join(sb.root, 'export.json');
      await s.exportTo(file, true);
      const data = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      data.claudeTranscript = ''; // e.g. unreadable when it was exported
      fs.writeFileSync(file, JSON.stringify(data));
      await s.close();
      fs.rmSync(path.join(sb.claudeConfig, 'projects'), { recursive: true, force: true });
      const ui = recordingUI();
      imported = (await importSessionExport(file, baseOptions(sb, ui))) as KiroSessionImpl;
      assert.ok(imported.record.turns.length > 0, 'precondition: the exported turns are kept (K2)');
      assert.equal(sb.starts()[sb.starts().length - 1]!.includes('--resume'), false, 'precondition: a new conversation with the journal as context');
      const before = fallbacks(ui);
      const starts = sb.starts().length;
      await imported.swapAgent('other');
      const argv = sb.starts()[starts]!;
      assert.equal(argv.includes('--resume'), false, `a --resume of a Claude session without a transcript: ${argv.join(' ')}`);
      assert.equal(sb.starts().length, starts + 1, 'one spawn');
      assert.equal(fallbacks(ui), before, 'a fallback warning');
      const { result } = await drain(imported.prompt({ text: 'after swap' }));
      assert.match(result.text, /first ALPHA_1/);
    } finally {
      await closeAll(imported, s);
    }
  });
});

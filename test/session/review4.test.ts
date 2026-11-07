/**
 * Guards for the round-4 session items (scratchpad r3g-gaps.md):
 *  - K1: a fork made by `create({ fork })` (a spec-phase session, the continuation a /spec flow
 *    hands to the chat) carries its parent's turns and message count (cut at a rewind point
 *    `at`), like a tangent / rewind record: `/tangent` and `/rewind N` work in it straight away,
 *    the pin of a pending fork reopened after a quit is its last carried turn, and closed without
 *    a turn of its own it still leaves no duplicate of its parent in the index.
 *  - K2: `/chat load` of an export without a Claude transcript applies a reopen's rules: an
 *    exported `pendingFork` is forked again from its source, and the exported Claude session is
 *    forked at the record's own last turn (the original may have run on since the export).
 *  - K3: agentSpawn (SessionStart) hooks re-run by `/clear`, `/agent swap` and a new session's
 *    start are cancelled by `interrupt()` / `close()` / the creator's start signal: the hook is
 *    killed and the command changes nothing (no half-started or closed session left).
 *  - K4: `/clear` resets the message count with the turns (Q/Kiro: the cleared conversation has
 *    no messages), and the cleared record still stays in the index.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ClaudeCapabilities } from '../../src/claude/binary.js';
import { importSessionExport, KiroSessionImpl, type KiroSessionInternalOptions } from '../../src/session/kiroSession.js';
import { currentStartSignal, isSessionStartCancelled, SessionStartCancelledError, withStartSignal } from '../../src/session/startSignal.js';
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

const HIST = { turns: [], default: { steps: [{ text: 'hist={{historyUserTexts}}' }] } };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const read = (sb: Sandbox, id: string): SessionRecord | undefined => new SessionStore(sb.sessionsDir).read(id);
const recordFiles = (sb: Sandbox): string[] => (fs.existsSync(sb.sessionsDir) ? fs.readdirSync(sb.sessionsDir).filter((f) => f.endsWith('.json')).sort() : []);
const fallbackNotice = (ui: RecordingUI): boolean => ui.notices.some((n) => /could not find the saved conversation/i.test(n.message));
const turnIds = (r: SessionRecord | undefined): string[] => (r?.turns ?? []).map((t) => `${t.userUuid}/${t.assistantUuid}`);

async function waitFor(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await sleep(10);
  }
}

/** main with turns `prompts` (fake transcripts persisted). */
async function mainWith(prompts: string[]): Promise<{ sb: Sandbox; s: KiroSessionImpl }> {
  const sb = mkSandbox({ script: HIST, env: { FAKE_CLAUDE_PERSIST: '1' } });
  const s = await open(sb);
  for (const p of prompts) await drain(s.prompt({ text: p }));
  return { sb, s };
}

// ───────────────────────────── K1 ─────────────────────────────

describe('K1: a create({fork}) fork carries its parent\'s turns', () => {
  it('a continuation of main has main\'s turns and message count; /tangent works in it straight away', async () => {
    const { sb, s } = await mainWith(['first ALPHA_1', 'second BETA_2']);
    let f: KiroSessionImpl | undefined;
    try {
      f = await forkOf(sb, s);
      assert.deepEqual(turnIds(f.record), turnIds(s.record), 'the fork record carries main\'s turns');
      assert.equal(f.record.messageCount, 2);
      assert.equal(f.record.lastPreview, s.record.lastPreview);
      assert.deepEqual(turnIds(read(sb, f.id)), turnIds(s.record), 'also on disk');
      // "Can't branch an empty chat." before K1
      await f.enterTangent('side');
      const { result } = await drain(f.prompt({ text: 'in tangent' }));
      assert.match(result.text, /first ALPHA_1 \| second BETA_2 \| in tangent/);
    } finally {
      await closeAll(f, s);
    }
  });

  it('/rewind N inside the continuation reaches main\'s turns (forks main\'s source at that turn)', async () => {
    const { sb, s } = await mainWith(['first ALPHA_1', 'second BETA_2']);
    let f: KiroSessionImpl | undefined;
    try {
      const mainClaude = s.claudeSessionId!;
      const a1 = s.record.turns[0]!.assistantUuid!;
      f = await forkOf(sb, s);
      const starts = sb.starts().length;
      await f.rewind(1);
      const argv = sb.starts()[starts]!;
      assert.equal(flagValue(argv, '--resume'), mainClaude, `argv: ${argv.join(' ')}`);
      assert.ok(argv.includes('--fork-session'));
      assert.equal(flagValue(argv, '--resume-session-at'), a1);
      assert.equal(f.record.turns.length, 1);
      const { result } = await drain(f.prompt({ text: 'after rewind' }));
      assert.match(result.text, /hist=first ALPHA_1 \| after rewind/);
      assert.doesNotMatch(result.text, /BETA_2/);
    } finally {
      await closeAll(f, s);
    }
  });

  it('a fork at a rewind point carries the turns up to it; at an unknown point none (like its journal copy)', async () => {
    const { sb, s } = await mainWith(['first ALPHA_1', 'second BETA_2', 'third GAMMA_3']);
    let f: KiroSessionImpl | undefined;
    let g: KiroSessionImpl | undefined;
    try {
      const a2 = s.record.turns[1]!.assistantUuid!;
      f = await forkOf(sb, s, recordingUI(), a2);
      assert.deepEqual(turnIds(f.record), turnIds(s.record).slice(0, 2));
      assert.equal(f.record.messageCount, 2);
      assert.equal(f.record.lastPreview, s.record.turns[1]!.preview);
      g = await forkOf(sb, s, recordingUI(), randomUUID());
      assert.deepEqual(g.record.turns, [], 'the cut is unknown: rewound turns never come back');
      assert.equal(g.record.messageCount, 0);
    } finally {
      await closeAll(g, f, s);
    }
  });

  it('closed without a turn of its own the fork leaves no duplicate record; with one it is kept with its own turn', async () => {
    const { sb, s } = await mainWith(['first ALPHA_1']);
    try {
      const before = recordFiles(sb);
      const f = await forkOf(sb, s);
      await f.close();
      assert.deepEqual(recordFiles(sb), before, 'an untouched copy of main is dropped like an empty chat');
      assert.equal(fs.existsSync(path.join(sb.sessionsDir, `${f.id}.jsonl`)), false, 'with its journal copy');
      const g = await forkOf(sb, s);
      await drain(g.prompt({ text: 'phase one' }));
      await g.close();
      assert.equal(read(sb, g.id)?.turns.length, 2, 'main\'s turn and its own');
      assert.equal(read(sb, g.id)?.messageCount, 2);
    } finally {
      await closeAll(s);
    }
  });

  it('a fork whose source fell back to its journal (no transcript) is still dropped when closed without a turn of its own', async () => {
    const { sb, s } = await mainWith(['first ALPHA_1']);
    try {
      fs.rmSync(path.join(sb.claudeConfig, 'projects'), { recursive: true, force: true });
      const before = recordFiles(sb);
      const ui = recordingUI();
      const f = await forkOf(sb, s, ui);
      assert.ok(fallbackNotice(ui), 'precondition: the fork fell back to a fresh Claude session');
      await f.close();
      assert.deepEqual(recordFiles(sb), before);
    } finally {
      await closeAll(s);
    }
  });

  it('a pending fork reopened after a quit forks its source at its last carried turn, not where the source moved since', async () => {
    const { sb, s } = await mainWith(['first ALPHA_1', 'second BETA_2']);
    let f: KiroSessionImpl | undefined;
    let r: KiroSessionImpl | undefined;
    try {
      const mainClaude = s.claudeSessionId!;
      const a2 = s.record.turns[1]!.assistantUuid!;
      f = await forkOf(sb, s);
      assert.deepEqual(read(sb, f.id)?.pendingFork, { from: mainClaude });
      // main runs on (a quit left the fork pending on disk; main was resumed and continued)
      await drain(s.prompt({ text: 'later LATER_3' }));
      const ui = recordingUI();
      const starts = sb.starts().length;
      r = await open(sb, { origin: 'spec', resume: { sessionId: f.id } }, ui);
      const argv = sb.starts()[starts]!;
      assert.equal(flagValue(argv, '--resume'), mainClaude, `argv: ${argv.join(' ')}`);
      assert.equal(flagValue(argv, '--resume-session-at'), a2, 'pinned at the record\'s own last turn');
      assert.equal(fallbackNotice(ui), false);
      const { result } = await drain(r.prompt({ text: 'reopened' }));
      assert.match(result.text, /hist=first ALPHA_1 \| second BETA_2 \| reopened/);
      assert.doesNotMatch(result.text, /LATER_3/);
    } finally {
      await closeAll(r, f, s);
    }
  });

  it('a failed start of a fork that carries turns leaves only its parent\'s files', async () => {
    const sb = mkSandbox({ env: { FAKE_CLAUDE_EXIT_ON_START: '3', FAKE_CLAUDE_STDERR: 'kaboom' } });
    const store = new SessionStore(sb.sessionsDir);
    const parent = store.create({
      origin: 'repl',
      cwd: sb.cwd,
      agent: 'kiro_default',
      model: 'auto',
      turns: [{ userUuid: randomUUID(), assistantUuid: randomUUID(), preview: 'p', at: '2026-01-01T00:00:00.000Z' }],
      messageCount: 1,
    });
    await assert.rejects(open(sb, { origin: 'spec', fork: { fromClaudeSessionId: parent.claudeSessionId, kind: 'main', parentId: parent.sessionId } }), /kaboom|exit/i);
    assert.deepEqual(recordFiles(sb), [`${parent.sessionId}.json`]);
  });
});

// ───────────────────────────── K2 ─────────────────────────────

describe('K2: /chat load of an export without a Claude transcript applies a reopen\'s fork rules', () => {
  it('an exported fresh tangent (pendingFork, no transcript yet) forks its source again, pinned, with its turns', async () => {
    const { sb, s } = await mainWith(['first ALPHA_1', 'second BETA_2']);
    let imported: KiroSessionImpl | undefined;
    try {
      const mainClaude = s.claudeSessionId!;
      const a2 = s.record.turns[1]!.assistantUuid!;
      await s.enterTangent('side');
      const file = path.join(sb.root, 'tangent-export.json');
      await s.exportTo(file, true);
      const data = JSON.parse(fs.readFileSync(file, 'utf8')) as { claudeTranscript: string; session: SessionRecord };
      assert.equal(data.claudeTranscript, '', 'precondition: the fork has no transcript yet');
      assert.deepEqual(data.session.pendingFork, { from: mainClaude });
      // main runs on after the export
      await s.exitTangent('discard');
      await drain(s.prompt({ text: 'later LATER_3' }));
      const ui = recordingUI();
      const starts = sb.starts().length;
      imported = (await importSessionExport(file, baseOptions(sb, ui))) as KiroSessionImpl;
      const argv = sb.starts()[starts]!;
      assert.equal(flagValue(argv, '--resume'), mainClaude, `argv: ${argv.join(' ')}`);
      assert.ok(argv.includes('--fork-session'));
      assert.equal(flagValue(argv, '--resume-session-at'), a2);
      assert.equal(fallbackNotice(ui), false, 'no journal fallback');
      assert.equal(imported.record.turns.length, 2, 'the exported turns are kept');
      assert.deepEqual(read(sb, imported.id)?.pendingFork, { from: mainClaude, at: a2 }, 'still a fork without a message');
      const { result } = await drain(imported.prompt({ text: 'loaded' }));
      assert.match(result.text, /hist=first ALPHA_1 \| second BETA_2 \| loaded/);
      assert.doesNotMatch(result.text, /LATER_3|kiro-restored-history/);
    } finally {
      await closeAll(imported, s);
    }
  });

  it('an export without a transcript whose Claude session still exists forks it at the record\'s last turn', async () => {
    const { sb, s } = await mainWith(['first ALPHA_1', 'second BETA_2']);
    let imported: KiroSessionImpl | undefined;
    try {
      const mainClaude = s.claudeSessionId!;
      const a2 = s.record.turns[1]!.assistantUuid!;
      const file = path.join(sb.root, 'main-export.json');
      await s.exportTo(file, true);
      const data = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      data.claudeTranscript = ''; // e.g. unreadable when it was exported
      fs.writeFileSync(file, JSON.stringify(data));
      await drain(s.prompt({ text: 'later LATER_3' })); // the original runs on
      const starts = sb.starts().length;
      imported = (await importSessionExport(file, baseOptions(sb))) as KiroSessionImpl;
      const argv = sb.starts()[starts]!;
      assert.equal(flagValue(argv, '--resume'), mainClaude, `argv: ${argv.join(' ')}`);
      assert.equal(flagValue(argv, '--resume-session-at'), a2);
      const { result } = await drain(imported.prompt({ text: 'loaded' }));
      assert.match(result.text, /hist=first ALPHA_1 \| second BETA_2 \| loaded/);
      assert.doesNotMatch(result.text, /LATER_3/);
    } finally {
      await closeAll(imported, s);
    }
  });

  it('an export whose pending fork source is gone (and no transcript) starts fresh with the journal, as before', async () => {
    const { sb, s } = await mainWith(['first ALPHA_1']);
    let imported: KiroSessionImpl | undefined;
    try {
      await s.enterTangent('side');
      const file = path.join(sb.root, 'tangent-export.json');
      await s.exportTo(file, true);
      fs.rmSync(path.join(sb.claudeConfig, 'projects'), { recursive: true, force: true });
      const starts = sb.starts().length;
      imported = (await importSessionExport(file, baseOptions(sb))) as KiroSessionImpl;
      const argv = sb.starts()[starts]!;
      assert.equal(argv.includes('--fork-session'), false, `argv: ${argv.join(' ')}`);
      const { result } = await drain(imported.prompt({ text: 'loaded' }));
      assert.match(result.text, /kiro-restored-history|first ALPHA_1/);
    } finally {
      await closeAll(imported, s);
    }
  });
});

// ───────────────────────────── K3 ─────────────────────────────

/**
 * A SessionStart hook (V3 file, timeout 0 = never) that is fast the first time and hangs from the
 * second run on, ignoring TERM/INT/HUP; `pid()` is the hanging run's shell (its group's leader).
 */
function slowSpawnHook(sb: Sandbox, opts: { hangFirst?: boolean } = {}): { pid(): number | undefined; done(): boolean; kill(): void } {
  const once = path.join(sb.root, 'hook.once');
  const pidFile = path.join(sb.root, 'hook.pid');
  const marker = path.join(sb.root, 'hook.done');
  if (opts.hangFirst) fs.writeFileSync(once, '');
  const command = `trap '' TERM INT HUP; if [ -f '${once}' ]; then echo $$ > '${pidFile}'; sleep 30; touch '${marker}'; fi; touch '${once}'; echo SPAWN-CTX`;
  sb.write('.kiro/hooks/spawn.json', JSON.stringify({ version: 'v1', hooks: [{ name: 'spawn', trigger: 'SessionStart', timeout: 0, action: { type: 'command', command } }] }));
  const pid = (): number | undefined => {
    try {
      const t = fs.readFileSync(pidFile, 'utf8').trim();
      return /^\d+$/.test(t) ? Number(t) : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    pid,
    done: () => fs.existsSync(marker),
    kill() {
      const p = pid();
      if (p === undefined) return;
      try {
        process.kill(-p, 'SIGKILL');
      } catch {
        /* gone */
      }
    },
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** `p` settles within `ms`, else a rejection naming `what`. */
async function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new Error(`${what} did not end within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(t);
  }
}

async function hookKilled(h: { pid(): number | undefined; done(): boolean }): Promise<void> {
  const pid = h.pid()!;
  await waitFor(() => !alive(pid), 3000).catch(() => assert.fail(`hook process ${pid} still runs`));
  assert.equal(h.done(), false, 'the hook ran to completion');
}

const userLines = (sb: Sandbox): string[] => sb.userLines().map((l) => JSON.stringify(l));

describe('K3: agentSpawn hooks re-run by /clear, /agent swap and a session start are cancellable', () => {
  it('interrupt() during /clear\'s hooks kills the hook and cancels the /clear: nothing is cleared, the session goes on', async () => {
    const sb = mkSandbox({ script: HIST, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const hook = slowSpawnHook(sb);
    const s = await open(sb);
    try {
      await drain(s.prompt({ text: 'first ALPHA_1' }));
      const claude = s.claudeSessionId;
      const starts = sb.starts().length;
      const p = s.clear();
      p.catch(() => undefined);
      await waitFor(() => hook.pid() !== undefined);
      await sleep(100);
      assert.equal(s.busy, false, 'idle while kiro-claude\'s own hook runs (F0: never force-stopped)');
      await s.interrupt();
      const err = await within(p.then(() => undefined, (e: unknown) => e), 3000, '/clear');
      assert.ok(isSessionStartCancelled(err), `rejects cancelled: ${String(err)}`);
      assert.ok(err instanceof SessionStartCancelledError);
      await hookKilled(hook);
      assert.equal(s.record.turns.length, 1, 'not cleared');
      assert.equal(s.record.messageCount, 1);
      assert.equal(s.claudeSessionId, claude);
      assert.equal(sb.starts().length, starts, 'the child was neither stopped nor respawned');
      assert.ok(!userLines(sb).some((l) => l.includes('"/clear"')), 'Claude never got /clear');
      const { result } = await drain(s.prompt({ text: 'second BETA_2' }));
      assert.match(result.text, /hist=first ALPHA_1 \| second BETA_2/);
    } finally {
      hook.kill();
      await closeAll(s);
    }
  });

  it('interrupt() during /agent swap\'s hooks kills the hook and cancels the swap: same agent, same child', async () => {
    const sb = mkSandbox({ script: HIST, env: { FAKE_CLAUDE_PERSIST: '1' } });
    sb.agent('other', { description: 'another agent' });
    const hook = slowSpawnHook(sb);
    const s = await open(sb);
    try {
      await drain(s.prompt({ text: 'first ALPHA_1' }));
      const agent = s.agent.name;
      const proc = s.process;
      const starts = sb.starts().length;
      const p = s.swapAgent('other');
      p.catch(() => undefined);
      await waitFor(() => hook.pid() !== undefined);
      await sleep(100);
      assert.equal(s.busy, false);
      await s.interrupt();
      const err = await within(p.then(() => undefined, (e: unknown) => e), 3000, '/agent swap');
      assert.ok(isSessionStartCancelled(err), `rejects cancelled: ${String(err)}`);
      await hookKilled(hook);
      assert.equal(s.agent.name, agent, 'still the old agent');
      assert.equal(s.record.agent, agent);
      assert.equal(s.process, proc, 'the same child');
      assert.ok(proc?.running);
      assert.equal(sb.starts().length, starts);
      const { result } = await drain(s.prompt({ text: 'second BETA_2' }));
      assert.match(result.text, /hist=first ALPHA_1 \| second BETA_2/);
    } finally {
      hook.kill();
      await closeAll(s);
    }
  });

  it('close() during /clear\'s hooks kills the hook and closes promptly', async () => {
    const sb = mkSandbox({ script: HIST, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const hook = slowSpawnHook(sb);
    const s = await open(sb);
    try {
      await drain(s.prompt({ text: 'first ALPHA_1' }));
      const p = s.clear();
      p.catch(() => undefined);
      await waitFor(() => hook.pid() !== undefined);
      await within(s.close(), 8000, 'close()');
      await within(p.then(() => undefined, () => undefined), 1000, '/clear');
      await hookKilled(hook);
      assert.equal(read(sb, s.id)?.turns.length, 1, 'saved, not cleared');
    } finally {
      hook.kill();
      await closeAll(s);
    }
  });

  for (const how of ['withStartSignal', 'startSignal option'] as const) {
    it(`a session start cancelled through its creator's start signal (${how}) kills the hook and leaves nothing behind`, async () => {
      const sb = mkSandbox({ script: HIST, env: { FAKE_CLAUDE_PERSIST: '1' } });
      const hook = slowSpawnHook(sb, { hangFirst: true });
      try {
        const ac = new AbortController();
        const create = (): Promise<KiroSessionImpl> => (how === 'withStartSignal' ? withStartSignal(ac.signal, () => open(sb)) : open(sb, { startSignal: ac.signal }));
        const p = create();
        p.then((s) => s.close()).catch(() => undefined);
        await waitFor(() => hook.pid() !== undefined);
        ac.abort();
        const err = await within(p.then(() => undefined, (e: unknown) => e), 3000, 'the start');
        assert.ok(isSessionStartCancelled(err), `rejects cancelled: ${String(err)}`);
        await hookKilled(hook);
        assert.deepEqual(recordFiles(sb), [], 'no record left');
        assert.equal(sb.starts().length, 0, 'Claude Code was never spawned');
        assert.equal(fs.existsSync(sb.sessionsDir) ? fs.readdirSync(sb.sessionsDir).filter((f) => f.endsWith('.lock')).length : 0, 0, 'no lock left');
      } finally {
        hook.kill();
      }
    });
  }

  it('the start signal of a resume (/chat resume) keeps the saved record, untouched', async () => {
    const sb = mkSandbox({ script: HIST, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const hook = slowSpawnHook(sb);
    const s = await open(sb);
    let id: string;
    try {
      await drain(s.prompt({ text: 'first ALPHA_1' }));
      id = s.id;
    } finally {
      await closeAll(s);
    }
    try {
      const ac = new AbortController();
      const p = withStartSignal(ac.signal, () => open(sb, { resume: { sessionId: id } }));
      p.then((x) => x.close()).catch(() => undefined);
      await waitFor(() => hook.pid() !== undefined);
      ac.abort();
      const err = await within(p.then(() => undefined, (e: unknown) => e), 3000, 'the resume');
      assert.ok(isSessionStartCancelled(err), String(err));
      await hookKilled(hook);
      assert.equal(read(sb, id)?.turns.length, 1, 'the record stays');
      const again = await open(sb, { resume: { sessionId: id } });
      await closeAll(again);
    } finally {
      hook.kill();
    }
  });

  it('a start signal aborted once the hooks are done (Claude Code is starting) changes nothing: the session starts (F0)', async () => {
    const sb = mkSandbox({ script: HIST, env: { FAKE_CLAUDE_PERSIST: '1', FAKE_CLAUDE_CONTROL_DELAYS: JSON.stringify({ initialize: 800 }) } });
    sb.write('.kiro/hooks/spawn.json', JSON.stringify({ version: 'v1', hooks: [{ name: 'spawn', trigger: 'SessionStart', action: { type: 'command', command: 'echo SPAWN-CTX' } }] }));
    const ac = new AbortController();
    const p = open(sb, { startSignal: ac.signal });
    p.catch(() => undefined);
    await waitFor(() => sb.starts().length > 0);
    ac.abort();
    const s = await within(p, 8000, 'the start');
    try {
      assert.ok(s.process?.running);
      const { result } = await drain(s.prompt({ text: 'first ALPHA_1' }));
      assert.match(result.text, /hist=first ALPHA_1/);
      assert.match(fs.readFileSync(s.lastLaunch!.files.systemPrompt, 'utf8'), /SPAWN-CTX/, 'the hook output applied');
    } finally {
      await closeAll(s);
    }
  });

  it('a session created under a start signal does not carry it on: its child\'s frames are handled outside it', async () => {
    const sb = mkSandbox({ script: HIST, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const ac = new AbortController();
    const seen: Array<AbortSignal | undefined> = [];
    const s = await withStartSignal(ac.signal, async () => {
      assert.equal(currentStartSignal(), ac.signal, 'precondition');
      const x = await open(sb);
      x.process!.on('frame', () => seen.push(currentStartSignal()));
      return x;
    });
    try {
      await drain(s.prompt({ text: 'first ALPHA_1' }));
      assert.ok(seen.length > 0);
      assert.ok(seen.every((v) => v === undefined), 'the start signal leaked into the session\'s child');
    } finally {
      await closeAll(s);
    }
  });

  it('without a press nothing changed: /clear still re-runs the agentSpawn hooks', async () => {
    const sb = mkSandbox({ script: HIST, env: { FAKE_CLAUDE_PERSIST: '1' } });
    sb.write('.kiro/hooks/spawn.json', JSON.stringify({ version: 'v1', hooks: [{ name: 'spawn', trigger: 'SessionStart', action: { type: 'command', command: `echo run >> '${path.join(sb.root, 'runs')}'; echo SPAWN-CTX` } }] }));
    const s = await open(sb);
    try {
      await drain(s.prompt({ text: 'first ALPHA_1' }));
      await s.clear();
      assert.equal(fs.readFileSync(path.join(sb.root, 'runs'), 'utf8').trim().split('\n').length, 2, 'the hooks ran again');
      assert.equal(s.record.turns.length, 0);
    } finally {
      await closeAll(s);
    }
  });
});

// ───────────────────────────── K4 ─────────────────────────────

describe('K4: /clear resets the message count', () => {
  it('after /clear: no turns, no messages, no tangent; the cleared record stays in the index and reopens as a new conversation', async () => {
    const { sb, s } = await mainWith(['first ALPHA_1', 'second BETA_2']);
    let r: KiroSessionImpl | undefined;
    try {
      await s.clear();
      assert.equal(s.record.turns.length, 0);
      assert.equal(s.record.messageCount, 0, 'the cleared conversation has no messages');
      assert.equal(read(sb, s.id)?.messageCount, 0, 'on disk too');
      await assert.rejects(s.enterTangent(), /Can't branch an empty chat/);
      const id = s.id;
      const claude = s.claudeSessionId!;
      await s.close();
      assert.ok(read(sb, id), 'the cleared session is kept (it had a conversation)');
      const ui = recordingUI();
      const starts = sb.starts().length;
      r = await open(sb, { resume: { sessionId: id } }, ui);
      const argv = sb.starts()[starts]!;
      assert.equal(argv.includes('--resume'), false, `a new conversation: ${argv.join(' ')}`);
      assert.equal(flagValue(argv, '--session-id'), claude);
      assert.equal(fallbackNotice(ui), false);
      const { result } = await drain(r.prompt({ text: 'after clear' }));
      assert.match(result.text, /hist=after clear$/);
      assert.equal(r.record.messageCount, 1);
    } finally {
      await closeAll(r, s);
    }
  });

  it('a session that never had a message is still dropped from the index when it closes', async () => {
    const sb = mkSandbox({ script: HIST, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const s = await open(sb);
    await s.close();
    assert.deepEqual(recordFiles(sb), []);
  });
});

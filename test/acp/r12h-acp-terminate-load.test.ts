/**
 * r12h H3 (acp group): two writers of one session in one ACP server. `terminate` (and
 * `_session/terminate` sent as a notification, which nobody awaits) took the session out of the
 * server at once and then closed it; a `session/load` of the same id arriving meanwhile found no
 * live session and opened it afresh: the new session replaced this process's own lock (a lock
 * naming our own pid is replaced in one step) and read the record before the close saved it, and
 * the close then wrote its in-memory record over the new session's and ran its SessionEnd hooks
 * against a session that was live again. The same held for the restart after a stuck cancel when the
 * old session's close overran the close budget, and the server's shutdown did not wait for such a
 * close at all.
 *
 * Every test runs the ACP server in this process with the real session module and the fake Claude
 * Code; a wrapped session factory records, in one sequence, when each session of an id is created and
 * when its close ended, so "the open waited for the close" is checked directly as well as through
 * what the close would have broken (the record, the lock, the hook order).
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { KiroSession, SessionRecord } from '../../src/types.js';
import { defaultSessionFactory, type SessionFactory } from '../../src/acp/server.js';
import { TestClient, tmpEnv, until, writeAgent, type Frame, type StartClientOptions, type TmpEnv } from './helpers.js';

const skip = process.platform === 'win32' ? 'POSIX process groups' : false;
const clients: TestClient[] = [];
after(async () => {
  await Promise.allSettled(clients.filter((c) => c.exitCode === undefined).map((c) => c.close(20_000)));
});

const SCRIPT = JSON.stringify({
  turns: [
    { repeat: true, match: 'PING', steps: [{ text: 'PONG' }] },
    { repeat: true, match: 'HANG', steps: [{ text: 'starting' }, { sleepMs: 120_000 }] },
  ],
});

/** One session the server created: its id, and when (in {@link Tracker.seq}) it was created and its close ended. */
interface Opened {
  id: string;
  created: number;
  closed?: number;
  session?: KiroSession;
}

interface Tracker {
  factory: SessionFactory;
  opened: Opened[];
  of(id: string): Opened[];
  /** Every session of `id` was created only after the close of the one before it had ended. */
  assertOneAtATime(id: string): void;
}

function tracker(): Tracker {
  let seq = 0;
  const opened: Opened[] = [];
  const factory: SessionFactory = async (opts) => {
    // created = when the session module is asked to open it (it reads the record and takes the lock)
    const e: Opened = { id: opts.resume && 'sessionId' in opts.resume ? opts.resume.sessionId : '', created: ++seq };
    opened.push(e);
    let s: KiroSession;
    try {
      s = await defaultSessionFactory(opts);
    } catch (err) {
      e.closed = ++seq; // nothing of it is left open
      throw err;
    }
    if (!e.id) e.id = s.id;
    e.session = s;
    const close = s.close.bind(s);
    let first: Promise<void> | undefined;
    (s as { close(): Promise<void> }).close = () => {
      const p = close();
      if (!first) {
        first = p;
        const end = (): void => {
          e.closed = ++seq;
        };
        p.then(end, end);
      }
      return p;
    };
    return s;
  };
  const of = (id: string): Opened[] => opened.filter((e) => e.id === id);
  return {
    factory,
    opened,
    of,
    assertOneAtATime(id) {
      const list = of(id);
      for (let i = 1; i < list.length; i++) {
        const before = list[i - 1]!;
        assert.ok(
          before.closed !== undefined && before.closed < list[i]!.created,
          `session #${i + 1} of ${id} was created (seq ${list[i]!.created}) while #${i} was still open or closing (its close ended at ${before.closed ?? 'not yet'})`,
        );
      }
    },
  };
}

const promptReq = (c: TestClient, sid: string, text: string, ms = 30_000): Promise<Frame> =>
  c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text }] }, ms);
const loadReq = (c: TestClient, t: TmpEnv, sid: string, ms = 60_000): Promise<Frame> =>
  c.request('session/load', { sessionId: sid, cwd: t.work, mcpServers: [] }, ms);
const indexDir = (t: TmpEnv): string => path.join(t.kiroHome, 'sessions', 'cli');
const readRecord = (t: TmpEnv, sid: string): SessionRecord | undefined => {
  try {
    return JSON.parse(fs.readFileSync(path.join(indexDir(t), `${sid}.json`), 'utf8')) as SessionRecord;
  } catch {
    return undefined;
  }
};
const lockPid = (t: TmpEnv, sid: string): number | undefined => {
  try {
    return (JSON.parse(fs.readFileSync(path.join(indexDir(t), `${sid}.lock`), 'utf8')) as { pid: number }).pid;
  } catch {
    return undefined;
  }
};
const previews = (rec: SessionRecord | undefined): string[] => (rec?.turns ?? []).map((x) => x.preview);

/** A workspace SessionEnd hook running `command` (capped at 5 s by the hook runner). */
function sessionEndHook(t: TmpEnv, command: string): void {
  fs.mkdirSync(path.join(t.work, '.kiro', 'hooks'), { recursive: true });
  fs.writeFileSync(
    path.join(t.work, '.kiro', 'hooks', 'end.json'),
    JSON.stringify({ version: 'v1', hooks: [{ name: 'end', trigger: 'SessionEnd', timeout: 0, action: { type: 'command', command } }] }),
  );
}

function start(t: TmpEnv, tr: Tracker, extra: Partial<StartClientOptions> = {}): TestClient {
  const c = new TestClient({ env: t.env, cwd: t.work, createSession: tr.factory, ...extra });
  clients.push(c);
  return c;
}

async function newWithTurn(c: TestClient, t: TmpEnv, text = 'PING one'): Promise<string> {
  await c.initialize();
  const sid = (await c.call('session/new', { cwd: t.work, mcpServers: [] }, 30_000)).sessionId as string;
  const r = await promptReq(c, sid, text);
  assert.equal(r.result?.stopReason, 'end_turn', JSON.stringify(r));
  return sid;
}

test('`_session/terminate` as a notification, then session/load at once (slow close): the load waits for the close, which never writes over the loaded session', { skip, timeout: 120_000 }, async () => {
  const t = tmpEnv({ FAKE_CLAUDE_SCRIPT_JSON: SCRIPT, FAKE_CLAUDE_PERSIST: '1', FAKE_CLAUDE_HANG_ON_EOF: '1' });
  const tr = tracker();
  const c = start(t, tr);
  const sid = await newWithTurn(c, t);
  c.notify('_session/terminate', { sessionId: sid });
  const r = await loadReq(c, t, sid);
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  assert.ok(r.result?.modes, 'the session was loaded');
  assert.equal((await promptReq(c, sid, 'PING two')).result?.stopReason, 'end_turn');
  await until(() => tr.of(sid)[0]!.closed !== undefined, 20_000, 'the terminated session closed');
  // the terminated session's close is over: what is on disk is the loaded session's
  assert.deepEqual(previews(readRecord(t, sid)), ['PING one', 'PING two'], 'the record keeps the loaded session\'s turn');
  assert.equal(readRecord(t, sid)?.messageCount, 2);
  assert.equal(lockPid(t, sid), process.pid, 'the loaded session holds the lock');
  tr.assertOneAtATime(sid);
  assert.deepEqual(c.server!.sessionIds, [sid]);
  assert.equal(await c.close(20_000), 0);
  assert.deepEqual(previews(readRecord(t, sid)), ['PING one', 'PING two']);
  assert.equal(lockPid(t, sid), undefined, 'the lock is released at the end');
});

test('a slow SessionEnd hook: the terminated session\'s hooks run before the loaded session\'s agentSpawn hook, and its record save comes first', { skip, timeout: 120_000 }, async () => {
  const t = tmpEnv({ FAKE_CLAUDE_SCRIPT_JSON: SCRIPT, FAKE_CLAUDE_PERSIST: '1' });
  const log = path.join(t.root, 'hooks.log');
  writeAgent(path.join(t.work, '.kiro'), 'probe', {
    description: 'probe',
    tools: ['*'],
    includeMcpJson: false,
    hooks: { agentSpawn: [{ command: `echo spawn >> '${log}'`, timeout_ms: 0 }] },
  });
  sessionEndHook(t, `sleep 2; echo end >> '${log}'`);
  const tr = tracker();
  const c = start(t, tr, { args: ['--agent', 'probe'] });
  const sid = await newWithTurn(c, t);
  c.notify('_session/terminate', { sessionId: sid });
  const r = await loadReq(c, t, sid);
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  assert.equal((await promptReq(c, sid, 'PING two')).result?.stopReason, 'end_turn');
  await until(() => tr.of(sid)[0]!.closed !== undefined, 20_000, 'the terminated session closed');
  const lines = (): string[] => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
  assert.deepEqual(lines(), ['spawn', 'end', 'spawn'], 'SessionEnd of the terminated session, then agentSpawn of the loaded one');
  assert.deepEqual(previews(readRecord(t, sid)), ['PING one', 'PING two']);
  tr.assertOneAtATime(sid);
  assert.equal(await c.close(20_000), 0);
  assert.deepEqual(lines(), ['spawn', 'end', 'spawn', 'end']);
});

test('a session that never had a message, terminated and loaded at once: answered as after an awaited terminate, and no live session is left without its lock', { skip, timeout: 120_000 }, async () => {
  // the reference: terminate awaited, then load
  const ref = tmpEnv({ FAKE_CLAUDE_SCRIPT_JSON: SCRIPT, FAKE_CLAUDE_PERSIST: '1', FAKE_CLAUDE_HANG_ON_EOF: '1' });
  const rt = tracker();
  const rc = start(ref, rt);
  await rc.initialize();
  const rsid = (await rc.call('session/new', { cwd: ref.work, mcpServers: [] }, 30_000)).sessionId as string;
  await rc.waitFor((f) => f.params?.update?.sessionUpdate === 'available_commands_update', 10_000, 'session ready');
  assert.deepEqual(await rc.call('_kiro.dev/session/terminate', { sessionId: rsid }, 20_000), {});
  const expected = await loadReq(rc, ref, rsid);
  assert.equal(await rc.close(20_000), 0);

  const t = tmpEnv({ FAKE_CLAUDE_SCRIPT_JSON: SCRIPT, FAKE_CLAUDE_PERSIST: '1', FAKE_CLAUDE_HANG_ON_EOF: '1' });
  const tr = tracker();
  const c = start(t, tr);
  await c.initialize();
  const sid = (await c.call('session/new', { cwd: t.work, mcpServers: [] }, 30_000)).sessionId as string;
  await c.waitFor((f) => f.params?.update?.sessionUpdate === 'available_commands_update', 10_000, 'session ready');
  c.notify('_session/terminate', { sessionId: sid });
  const r = await loadReq(c, t, sid);
  await until(() => tr.of(sid)[0]!.closed !== undefined, 20_000, 'the terminated session closed');
  if (r.result) {
    // loaded: then it must still own its session (the close dropped the never-used record and its lock)
    assert.equal(lockPid(t, sid), process.pid, 'the loaded session lost its lock to the terminated session\'s close');
  }
  assert.deepEqual({ error: r.error, ok: r.result !== undefined }, { error: expected.error, ok: expected.result !== undefined }, 'the same answer as after an awaited terminate');
  tr.assertOneAtATime(sid);
  assert.equal(await c.close(20_000), 0);
});

test('stuck cancel whose old session closes slower than the close budget: the restart waits for that close, which never writes over the restarted session', { skip, timeout: 120_000 }, async () => {
  const t = tmpEnv({
    FAKE_CLAUDE_SCRIPT_JSON: SCRIPT,
    FAKE_CLAUDE_PERSIST: '1',
    FAKE_CLAUDE_HANG_ON_EOF: '1',
    FAKE_CLAUDE_CONTROL_DELAYS: JSON.stringify({ interrupt: 120_000 }),
  });
  // the stuck session's close: 3 s of SessionEnd hook, then Claude Code's 2 s EOF grace and SIGTERM
  // (about 5 s), against a close budget of 1.5 s; the restart's own bound on that wait is set well
  // above it (its default, 4 close budgets, is 6 s here: under 1 s above this close, too close on a
  // loaded machine, r12h verification)
  sessionEndHook(t, 'sleep 3');
  const tr = tracker();
  const c = start(t, tr, { timings: { cancelGraceMs: 300, closeTimeoutMs: 1_500, reopenWaitMs: 30_000 } });
  const sid = await newWithTurn(c, t);
  const hung = promptReq(c, sid, 'HANG');
  await c.waitFor((f) => f.params?.update?.sessionUpdate === 'agent_message_chunk' && f.params.update.content?.text === 'starting', 10_000, 'the hanging turn started');
  c.notify('session/cancel', { sessionId: sid });
  assert.deepEqual((await hung).result, { stopReason: 'cancelled' });
  const r = await promptReq(c, sid, 'PING two');
  assert.equal(r.result?.stopReason, 'end_turn', JSON.stringify(r));
  await until(() => tr.of(sid)[0]!.closed !== undefined, 20_000, 'the stuck session closed');
  assert.ok(previews(readRecord(t, sid)).includes('PING two'), `the record keeps the restarted session's turn: ${JSON.stringify(previews(readRecord(t, sid)))}`);
  assert.equal(tr.of(sid).length, 2, 'one restart');
  tr.assertOneAtATime(sid);
  assert.equal(lockPid(t, sid), process.pid);
  assert.equal(await c.close(20_000), 0);
  assert.ok(previews(readRecord(t, sid)).includes('PING two'));
});

test('two loads right after a terminate notification share one session, opened after the close', { skip, timeout: 120_000 }, async () => {
  const t = tmpEnv({ FAKE_CLAUDE_SCRIPT_JSON: SCRIPT, FAKE_CLAUDE_PERSIST: '1', FAKE_CLAUDE_HANG_ON_EOF: '1' });
  const tr = tracker();
  const c = start(t, tr);
  const sid = await newWithTurn(c, t);
  c.notify('_session/terminate', { sessionId: sid });
  const [a, b] = await Promise.all([loadReq(c, t, sid), loadReq(c, t, sid)]);
  assert.equal(a.error, undefined, JSON.stringify(a.error));
  assert.equal(b.error, undefined, JSON.stringify(b.error));
  assert.equal(tr.of(sid).length, 2, 'session/new and one load');
  tr.assertOneAtATime(sid);
  assert.equal((await promptReq(c, sid, 'PING two')).result?.stopReason, 'end_turn');
  assert.equal(await c.close(20_000), 0);
  assert.deepEqual(previews(readRecord(t, sid)), ['PING one', 'PING two']);
});

test('a load waiting for the close is cancelled by its $/cancel_request: -32800, nothing opened', { skip, timeout: 120_000 }, async () => {
  const t = tmpEnv({ FAKE_CLAUDE_SCRIPT_JSON: SCRIPT, FAKE_CLAUDE_PERSIST: '1', FAKE_CLAUDE_HANG_ON_EOF: '1' });
  const tr = tracker();
  const c = start(t, tr);
  const sid = await newWithTurn(c, t);
  c.notify('_session/terminate', { sessionId: sid });
  const from = c.frames.length;
  const id = 'load-1';
  c.send({ jsonrpc: '2.0', id, method: 'session/load', params: { sessionId: sid, cwd: t.work, mcpServers: [] } });
  c.notify('$/cancel_request', { requestId: id });
  const r = await c.waitFor((f) => f.id === id && f.method === undefined, 20_000, 'the load answer', from);
  assert.equal(r.error?.code, -32800, JSON.stringify(r));
  await until(() => tr.of(sid)[0]!.closed !== undefined, 20_000, 'the terminated session closed');
  assert.equal(tr.of(sid).length, 1, 'no session was opened for the cancelled load');
  assert.deepEqual(c.server!.sessionIds, []);
  assert.equal(lockPid(t, sid), undefined);
  assert.equal(await c.close(20_000), 0);
  assert.deepEqual(previews(readRecord(t, sid)), ['PING one']);
});

test('shutdown right after a terminate notification waits for that close: SessionEnd ran, record saved, lock released before the server returns', { skip, timeout: 120_000 }, async () => {
  const t = tmpEnv({ FAKE_CLAUDE_SCRIPT_JSON: SCRIPT, FAKE_CLAUDE_PERSIST: '1', FAKE_CLAUDE_HANG_ON_EOF: '1' });
  const tr = tracker();
  const c = start(t, tr);
  const sid = await newWithTurn(c, t);
  c.notify('_session/terminate', { sessionId: sid });
  assert.equal(await c.close(20_000), 0);
  assert.notEqual(tr.of(sid)[0]!.closed, undefined, 'the terminated session\'s close ended before the server returned');
  assert.equal(lockPid(t, sid), undefined, 'its lock is released');
  assert.deepEqual(previews(readRecord(t, sid)), ['PING one']);
});

/**
 * r12h H3 verification (acp group): more entry points to "one writer per session id in an ACP
 * server" than the fixer's own tests (r12h-acp-terminate-load.test.ts) cover, and the robustness of
 * the code the fix moved.
 *
 * Every test runs the ACP server in this process with the real session module and the fake Claude
 * Code; a wrapped session factory records, in one sequence, when each session of an id is created and
 * when its close ended.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { KiroSession, SessionRecord } from '../../src/types.js';
import { defaultSessionFactory, type SessionFactory } from '../../src/acp/server.js';
import { TestClient, tmpEnv, until, type Frame, type StartClientOptions, type TmpEnv } from './helpers.js';

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
  assertOneAtATime(id: string): void;
  /** Before the `n`-th creation (1-based) asks the session module: wait for `gate`. */
  gateAt(n: number, gate: Promise<void>): void;
  /** Wrap each created session's close (after the real close has been asked for). */
  onClose?: (s: KiroSession, real: () => Promise<void>) => Promise<void>;
}

function tracker(): Tracker {
  let seq = 0;
  let calls = 0;
  const gates = new Map<number, Promise<void>>();
  const opened: Opened[] = [];
  const t: Tracker = {
    opened,
    factory: async (opts) => {
      const n = ++calls;
      const gate = gates.get(n);
      if (gate) await gate;
      const e: Opened = { id: opts.resume && 'sessionId' in opts.resume ? opts.resume.sessionId : '', created: ++seq };
      opened.push(e);
      let s: KiroSession;
      try {
        s = await defaultSessionFactory(opts);
      } catch (err) {
        e.closed = ++seq;
        throw err;
      }
      if (!e.id) e.id = s.id;
      e.session = s;
      const close = s.close.bind(s);
      let first: Promise<void> | undefined;
      (s as { close(): Promise<void> }).close = () => {
        if (!first) {
          // (the session module's close is idempotent: every caller gets this one)
          first = close();
          const end = (): void => {
            e.closed = ++seq;
          };
          first.then(end, end);
        }
        return t.onClose ? t.onClose(s, close) : first;
      };
      return s;
    },
    of: (id) => opened.filter((e) => e.id === id),
    assertOneAtATime(id) {
      const list = t.of(id);
      for (let i = 1; i < list.length; i++) {
        const before = list[i - 1]!;
        assert.ok(
          before.closed !== undefined && before.closed < list[i]!.created,
          `session #${i + 1} of ${id} was created (seq ${list[i]!.created}) while #${i} was still open or closing (its close ended at ${before.closed ?? 'not yet'})`,
        );
      }
    },
    gateAt(n, gate) {
      gates.set(n, gate);
    },
  };
  return t;
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

test('shutdown while a session/load waits for a terminated session\'s close: the load answers "Server is shutting down", opens nothing, and the close still ends before the server returns', { skip, timeout: 120_000 }, async () => {
  const t = tmpEnv({ FAKE_CLAUDE_SCRIPT_JSON: SCRIPT, FAKE_CLAUDE_PERSIST: '1' });
  sessionEndHook(t, 'sleep 2');
  const tr = tracker();
  const c = start(t, tr);
  const sid = await newWithTurn(c, t);
  c.notify('_session/terminate', { sessionId: sid });
  const load = loadReq(c, t, sid);
  await until(() => c.server!.sessionIds.length === 0, 5_000, 'the session left the server');
  await new Promise((r) => setTimeout(r, 200));
  const code = await c.close(20_000);
  assert.equal(code, 0);
  const r = await load;
  assert.deepEqual({ code: r.error?.code, data: r.error?.data }, { code: -32603, data: 'Server is shutting down' }, JSON.stringify(r));
  assert.equal(tr.of(sid).length, 1, 'nothing opened for the load');
  assert.notEqual(tr.of(sid)[0]!.closed, undefined, 'the terminated session\'s close ended before the server returned');
  assert.equal(lockPid(t, sid), undefined);
  assert.deepEqual(previews(readRecord(t, sid)), ['PING one']);
});

test('a close slower than reopenWaitMs: the load answers the retriable "Session is active in another process (PID <ours>)" and opens nothing; once the close ended a load opens what it saved', { skip, timeout: 120_000 }, async () => {
  const t = tmpEnv({ FAKE_CLAUDE_SCRIPT_JSON: SCRIPT, FAKE_CLAUDE_PERSIST: '1' });
  sessionEndHook(t, 'sleep 3');
  const tr = tracker();
  const c = start(t, tr, { timings: { reopenWaitMs: 800 } });
  const sid = await newWithTurn(c, t);
  c.notify('_session/terminate', { sessionId: sid });
  const r = await loadReq(c, t, sid);
  assert.equal(r.error?.code, -32603, JSON.stringify(r));
  assert.equal(r.error?.data, `Failed to start session: Session is active in another process (PID ${process.pid})`);
  assert.equal(tr.of(sid).length, 1, 'nothing opened');
  await until(() => tr.of(sid)[0]!.closed !== undefined, 20_000, 'the terminated session closed');
  const r2 = await loadReq(c, t, sid);
  assert.equal(r2.error, undefined, JSON.stringify(r2.error));
  assert.equal((await promptReq(c, sid, 'PING two')).result?.stopReason, 'end_turn');
  tr.assertOneAtATime(sid);
  assert.equal(await c.close(20_000), 0);
  assert.deepEqual(previews(readRecord(t, sid)), ['PING one', 'PING two']);
});

test('terminate while the stuck-cancel restart creates the new session, then session/load: the load opens only after the late session\'s close, and nothing writes over it', { skip, timeout: 120_000 }, async () => {
  const t = tmpEnv({
    FAKE_CLAUDE_SCRIPT_JSON: SCRIPT,
    FAKE_CLAUDE_PERSIST: '1',
    FAKE_CLAUDE_CONTROL_DELAYS: JSON.stringify({ interrupt: 120_000 }),
  });
  sessionEndHook(t, 'sleep 1');
  const tr = tracker();
  let open!: () => void;
  tr.gateAt(2, new Promise<void>((r) => (open = r)));
  const c = start(t, tr, { timings: { cancelGraceMs: 300 } });
  const sid = await newWithTurn(c, t);
  const hung = promptReq(c, sid, 'HANG');
  await c.waitFor((f) => f.params?.update?.sessionUpdate === 'agent_message_chunk' && f.params.update.content?.text === 'starting', 10_000, 'the hanging turn started');
  c.notify('session/cancel', { sessionId: sid });
  assert.deepEqual((await hung).result, { stopReason: 'cancelled' });
  // the stuck session's close ended; the restart waits at the factory (creation #2)
  await until(() => tr.of(sid)[0]!.closed !== undefined, 20_000, 'the stuck session closed');
  c.notify('_session/terminate', { sessionId: sid });
  await until(() => c.server!.sessionIds.length === 0, 5_000, 'terminated');
  const load = loadReq(c, t, sid);
  await new Promise((r) => setTimeout(r, 300));
  open();
  const r = await load;
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  assert.equal(tr.of(sid).length, 3, 'session/new, the late restart, the load');
  tr.assertOneAtATime(sid);
  assert.equal((await promptReq(c, sid, 'PING two')).result?.stopReason, 'end_turn');
  assert.equal(await c.close(20_000), 0);
  assert.ok(previews(readRecord(t, sid)).includes('PING two'), JSON.stringify(previews(readRecord(t, sid))));
});

test('a session whose close() throws synchronously: terminate still answers {} and the session leaves the server (as before r12h)', { skip, timeout: 60_000 }, async () => {
  const t = tmpEnv({ FAKE_CLAUDE_SCRIPT_JSON: SCRIPT, FAKE_CLAUDE_PERSIST: '1' });
  const tr = tracker();
  tr.onClose = (_s, real) => {
    void real().catch(() => undefined);
    throw new Error('close threw');
  };
  const c = start(t, tr);
  const sid = await newWithTurn(c, t);
  const r = await c.request('_kiro.dev/session/terminate', { sessionId: sid }, 20_000);
  assert.deepEqual(r.result, {}, JSON.stringify(r));
  assert.deepEqual(c.server!.sessionIds, []);
  await until(() => tr.of(sid)[0]!.closed !== undefined, 20_000, 'closed');
  const l = await loadReq(c, t, sid);
  assert.equal(l.error, undefined, JSON.stringify(l.error));
  tr.onClose = undefined;
  assert.equal(await c.close(20_000), 0);
});

test('stuck cancel where the old session\'s close() throws synchronously: the session is still restarted (as before r12h)', { skip, timeout: 60_000 }, async () => {
  const t = tmpEnv({
    FAKE_CLAUDE_SCRIPT_JSON: SCRIPT,
    FAKE_CLAUDE_PERSIST: '1',
    FAKE_CLAUDE_CONTROL_DELAYS: JSON.stringify({ interrupt: 120_000 }),
  });
  const tr = tracker();
  let throwOnce = true;
  tr.onClose = (_s, real) => {
    const p = real();
    if (throwOnce) {
      throwOnce = false;
      void p.catch(() => undefined);
      throw new Error('close threw');
    }
    return p;
  };
  const c = start(t, tr, { timings: { cancelGraceMs: 300 } });
  const sid = await newWithTurn(c, t);
  const hung = promptReq(c, sid, 'HANG');
  await c.waitFor((f) => f.params?.update?.sessionUpdate === 'agent_message_chunk' && f.params.update.content?.text === 'starting', 10_000, 'the hanging turn started');
  c.notify('session/cancel', { sessionId: sid });
  assert.deepEqual((await hung).result, { stopReason: 'cancelled' });
  const r = await promptReq(c, sid, 'PING two');
  assert.equal(r.result?.stopReason, 'end_turn', JSON.stringify(r));
  assert.equal(tr.of(sid).length, 2, 'restarted once');
  assert.equal(await c.close(20_000), 0);
});

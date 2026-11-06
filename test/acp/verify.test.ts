/**
 * Adversarial checks of the hung-child-after-cancel fix (05 §4.6 step 5): the replacement must
 * also cover a stuck `/compact`, survive terminate / shutdown while it runs, keep the
 * queued-before-cancel semantics (08 KC-ACP-07), not depend on the old child ever closing, and
 * let a queued `session/load` re-attach on the replacement. Mock sessions, plus one run of the
 * REAL session module with test/fixtures/fake-claude.mjs (a `/compact` the child never ends).
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { KiroSession, KiroSessionOptions, SessionEvent, TurnResult } from '../../src/types.js';
import { createWorld, mockFactory, type MockSession, type MockWorld } from './mockSession.js';
import { TestClient, sleep, tmpEnv, until, writeAgent, type Frame } from './helpers.js';

let sessionModuleOk = true;
try {
  await import('../../src/session/kiroSession.js');
} catch {
  sessionModuleOk = false;
}
const skip = sessionModuleOk ? false : 'src/session/kiroSession.ts is not available';

const clients: TestClient[] = [];
after(async () => {
  await Promise.allSettled(clients.filter((c) => c.exitCode === undefined).map((c) => c.close(15_000)));
});

const isUpdate = (kind: string) => (f: Frame) => f.method === 'session/update' && f.params?.update?.sessionUpdate === kind;
const promptReq = (c: TestClient, sid: string, text: string, ms = 10_000) => c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text }] }, ms);

interface HangOpts {
  /** What hangs in the FIRST session (ignoring interrupts and the abort signal until closed). */
  hang: 'prompt' | 'compact';
  /** `close()` of the first session never resolves. */
  closeNeverResolves?: boolean;
  /** Re-creations wait for this before returning. */
  recreateGate?: Promise<void>;
}

function hangingFactory(world: MockWorld, o: HangOpts): (opts: KiroSessionOptions) => Promise<KiroSession> {
  const base = mockFactory(world);
  return async (opts) => {
    if (world.sessions.length >= 1 && o.recreateGate) {
      world.calls.push('recreate:waiting');
      await o.recreateGate;
    }
    const s = (await base(opts)) as MockSession;
    if (world.sessions.length !== 1) return s;
    let release!: () => void;
    const closed = new Promise<void>((r) => (release = r));
    const close = s.close.bind(s);
    s.interrupt = async () => {
      world.calls.push('interrupt(ignored)');
    };
    s.close = async () => {
      await close();
      release();
      if (o.closeNeverResolves) await new Promise<void>(() => undefined);
    };
    if (o.hang === 'prompt') {
      s.prompt = async function* (): AsyncGenerator<SessionEvent, TurnResult> {
        const ev: SessionEvent = { type: 'text_delta', text: 'starting' };
        s.emit('event', ev);
        yield ev;
        await closed;
        throw new Error('Claude Code exited (code 143)');
      };
    } else {
      s.compact = async function* (): AsyncGenerator<SessionEvent, TurnResult> {
        world.calls.push('compact(hanging)');
        const ev: SessionEvent = { type: 'compaction', state: 'started' };
        yield ev;
        await closed;
        throw new Error('Claude Code exited (code 143)');
      };
    }
    return s;
  };
}

function setup(o: HangOpts, timings: Record<string, number> = {}): { c: TestClient; world: MockWorld; work: string } {
  const t = tmpEnv();
  writeAgent(path.join(t.work, '.kiro'), 'probe', { description: 'probe', tools: ['*'], includeMcpJson: false });
  const world = createWorld([
    { match: /PING/, steps: [{ text: 'PONG' }] },
    { match: /PONG2/, steps: [{ text: 'PONG2' }] },
  ]);
  const c = new TestClient({ args: ['--agent', 'probe'], env: t.env, cwd: t.work, createSession: hangingFactory(world, o), timings: { cancelGraceMs: 100, closeTimeoutMs: 300, ...timings } });
  clients.push(c);
  return { c, world, work: t.work };
}

/** Start the hanging prompt; resolves (wrapped: an async function would flatten it) once it runs. */
async function hangPrompt(c: TestClient, sid: string): Promise<{ hung: Promise<Frame> }> {
  const hung = promptReq(c, sid, 'HANG');
  await c.waitFor((f) => isUpdate('agent_message_chunk')(f) && f.params.update.content.text === 'starting', 5_000, 'hung turn started');
  return { hung };
}

test('stuck /compact (prompt path) after a cancel: the session is replaced and the next prompt answers', { timeout: 30_000 }, async () => {
  const { c, world, work } = setup({ hang: 'compact' });
  await c.initialize();
  const sid = (await c.call('session/new', { cwd: work, mcpServers: [] })).sessionId as string;
  assert.deepEqual((await promptReq(c, sid, '/compact')).result, { stopReason: 'end_turn' });
  await c.waitFor((f) => f.method === '_kiro.dev/compaction/status' && f.params.status.type === 'started', 5_000, 'compaction started');
  await until(() => world.calls.includes('compact(hanging)'), 5_000, 'compaction running');
  c.notify('session/cancel', { sessionId: sid });
  await c.waitFor((f) => f.method === '_kiro.dev/compaction/status' && f.params.status.type === 'failed', 5_000, 'compaction reported failed');
  const r = await promptReq(c, sid, 'PING');
  assert.equal(r.result?.stopReason, 'end_turn', JSON.stringify(r));
  assert.equal(world.sessions.length, 2, 'the stuck session was replaced');
  assert.equal(world.sessions[0]!.closed, true);
  assert.deepEqual(world.created[1]!.resume, { sessionId: sid });
  assert.deepEqual(c.server!.sessionIds, [sid]);
  assert.equal(await c.close(), 0);
});

test('stuck compaction via _kiro.dev/commands/execute after a cancel: the command answers and the queue continues', { timeout: 30_000 }, async () => {
  const { c, world, work } = setup({ hang: 'compact' });
  await c.initialize();
  const sid = (await c.call('session/new', { cwd: work, mcpServers: [] })).sessionId as string;
  const exec = c.request('_kiro.dev/commands/execute', { sessionId: sid, command: { command: 'compact', args: {} } });
  await until(() => world.calls.includes('compact(hanging)'), 5_000, 'compaction running');
  c.notify('session/cancel', { sessionId: sid });
  const er = await exec;
  assert.equal(er.result?.success, false, JSON.stringify(er));
  const r = await promptReq(c, sid, 'PING');
  assert.equal(r.result?.stopReason, 'end_turn', JSON.stringify(r));
  assert.equal(world.sessions.length, 2);
  assert.equal(await c.close(), 0);
});

test('hung child: a prompt queued before the cancel is cancelled; one sent after it runs on the replacement', { timeout: 30_000 }, async () => {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const { c, world, work } = setup({ hang: 'prompt', recreateGate: gate });
  await c.initialize();
  const sid = (await c.call('session/new', { cwd: work, mcpServers: [] })).sessionId as string;
  const { hung } = await hangPrompt(c, sid);
  const queuedBefore = promptReq(c, sid, 'PING');
  await sleep(20);
  c.notify('session/cancel', { sessionId: sid });
  assert.deepEqual((await hung).result, { stopReason: 'cancelled' });
  // the replacement is still being created: a prompt sent now waits for it
  const sentAfter = promptReq(c, sid, 'PONG2');
  await sleep(50);
  open();
  assert.deepEqual((await queuedBefore).result, { stopReason: 'cancelled' });
  const r = await sentAfter;
  assert.equal(r.result?.stopReason, 'end_turn', JSON.stringify(r));
  assert.ok(c.frames.some((f) => isUpdate('agent_message_chunk')(f) && f.params.update.content.text === 'PONG2'));
  assert.equal(world.sessions.length, 2);
  assert.equal(await c.close(), 0);
});

test('hung child: the old session never finishing close() does not block the replacement', { timeout: 30_000 }, async () => {
  const { c, world, work } = setup({ hang: 'prompt', closeNeverResolves: true });
  await c.initialize();
  const sid = (await c.call('session/new', { cwd: work, mcpServers: [] })).sessionId as string;
  const { hung } = await hangPrompt(c, sid);
  c.notify('session/cancel', { sessionId: sid });
  assert.deepEqual((await hung).result, { stopReason: 'cancelled' });
  const r = await promptReq(c, sid, 'PING');
  assert.equal(r.result?.stopReason, 'end_turn', JSON.stringify(r));
  assert.equal(world.sessions.length, 2);
  assert.equal(await c.close(), 0);
});

test('hung child: terminate while the replacement is being created closes the late session and answers', { timeout: 30_000 }, async () => {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const { c, world, work } = setup({ hang: 'prompt', recreateGate: gate });
  await c.initialize();
  const sid = (await c.call('session/new', { cwd: work, mcpServers: [] })).sessionId as string;
  const { hung } = await hangPrompt(c, sid);
  c.notify('session/cancel', { sessionId: sid });
  assert.deepEqual((await hung).result, { stopReason: 'cancelled' });
  const queued = promptReq(c, sid, 'PING');
  await until(() => world.calls.includes('recreate:waiting'), 5_000, 'replacement being created');
  assert.deepEqual(await c.call('_kiro.dev/session/terminate', { sessionId: sid }), {});
  open();
  const q = await queued;
  assert.ok(q.error, `a prompt on a terminated session fails: ${JSON.stringify(q)}`);
  await until(() => world.sessions.length === 2 && world.sessions[1]!.closed, 5_000, 'late replacement closed');
  assert.equal(world.sessions[1]!.started, false, 'the late replacement never spawned a child');
  assert.deepEqual(c.server!.sessionIds, []);
  assert.equal(await c.close(), 0);
});

test('hung child: stdin EOF while the replacement is being created exits 0 and closes everything', { timeout: 30_000 }, async () => {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const { c, world, work } = setup({ hang: 'prompt', recreateGate: gate });
  await c.initialize();
  const sid = (await c.call('session/new', { cwd: work, mcpServers: [] })).sessionId as string;
  const { hung } = await hangPrompt(c, sid);
  c.notify('session/cancel', { sessionId: sid });
  assert.deepEqual((await hung).result, { stopReason: 'cancelled' });
  await until(() => world.calls.includes('recreate:waiting'), 5_000, 'replacement being created');
  const closing = c.close(10_000);
  await sleep(50);
  open();
  assert.equal(await closing, 0);
  for (const s of world.sessions) assert.equal(s.closed || !s.started, true, 'no started session is left open');
});

test('hung child: a session/load re-attach queued during the hang replays and answers on the replacement', { timeout: 30_000 }, async () => {
  // prompts work normally at first (only /compact would hang); the second prompt is made to hang below
  const { c, world, work } = setup({ hang: 'compact' });
  await c.initialize();
  const sid = (await c.call('session/new', { cwd: work, mcpServers: [] })).sessionId as string;
  assert.equal((await promptReq(c, sid, 'PING')).result.stopReason, 'end_turn');
  // the first session's prompt is replaced after the first turn: hang the next one
  const s0 = world.sessions[0]!;
  let release!: () => void;
  const closed = new Promise<void>((r) => (release = r));
  const close0 = s0.close.bind(s0);
  s0.close = async () => {
    await close0();
    release();
  };
  s0.prompt = async function* (): AsyncGenerator<SessionEvent, TurnResult> {
    const ev: SessionEvent = { type: 'text_delta', text: 'starting' };
    yield ev;
    await closed;
    throw new Error('Claude Code exited (code 143)');
  };
  const { hung } = await hangPrompt(c, sid);
  const load = c.request('session/load', { sessionId: sid, cwd: work, mcpServers: [] });
  await sleep(20);
  c.notify('session/cancel', { sessionId: sid });
  assert.deepEqual((await hung).result, { stopReason: 'cancelled' });
  const l = await load;
  assert.ok(l.result?.modes, JSON.stringify(l));
  assert.equal(world.sessions.length, 2);
  assert.ok(
    c.frames.some((f) => isUpdate('user_message_chunk')(f) && f.params.update._meta?.kiro?.replay === true && f.params.update.content.text === 'PING'),
    'replayed the history',
  );
  assert.equal((await promptReq(c, sid, 'PING')).result?.stopReason, 'end_turn');
  assert.equal(await c.close(), 0);
});

test('stuck /compact with the real session module (fake claude ignores the interrupt): replaced, the next prompt answers', { skip, timeout: 90_000 }, async () => {
  const t = tmpEnv({
    FAKE_CLAUDE_SCRIPT_JSON: JSON.stringify({ turns: [{ repeat: true, match: 'PING', steps: [{ text: 'PONG' }] }] }),
    FAKE_CLAUDE_PERSIST: '1',
    FAKE_CLAUDE_COMPACT_MS: '120000',
    FAKE_CLAUDE_CONTROL_DELAYS: JSON.stringify({ interrupt: 120_000 }),
  });
  const log = path.join(t.root, 'fake-claude.jsonl');
  t.env.FAKE_CLAUDE_LOG = log;
  writeAgent(path.join(t.work, '.kiro'), 'kc-probe', { description: 'probe', tools: ['*'], allowedTools: [], includeMcpJson: false });
  const c = new TestClient({ args: ['--agent', 'kc-probe'], env: t.env, cwd: t.work, timings: { cancelGraceMs: 300 } });
  clients.push(c);
  await c.initialize();
  const sid = (await c.call('session/new', { cwd: t.work, mcpServers: [] }, 30_000)).sessionId as string;
  assert.equal((await promptReq(c, sid, 'PING', 30_000)).result?.stopReason, 'end_turn');
  assert.deepEqual((await promptReq(c, sid, '/compact', 30_000)).result, { stopReason: 'end_turn' });
  await c.waitFor((f) => f.method === '_kiro.dev/compaction/status' && f.params.status.type === 'started', 10_000, 'compaction started');
  const starts = (): Frame[] =>
    fs
      .readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Frame)
      .filter((x) => x.event === 'start' && Array.isArray(x.argv) && x.argv.includes('-p'));
  await until(() => fs.readFileSync(log, 'utf8').includes('/compact'), 10_000, 'the child got /compact');
  c.notify('session/cancel', { sessionId: sid });
  await c.waitFor((f) => f.method === '_kiro.dev/compaction/status' && f.params.status.type === 'failed', 10_000, 'compaction failed');
  const r = await promptReq(c, sid, 'PING', 30_000);
  assert.equal(r.result?.stopReason, 'end_turn', JSON.stringify(r));
  assert.ok(c.frames.slice(-20).some((f) => isUpdate('agent_message_chunk')(f) && String(f.params.update.content.text).includes('PONG')));
  assert.ok(starts().length >= 2, 'a second claude child was spawned');
  assert.ok((starts().at(-1)!.argv as string[]).includes('--resume'), 'the replacement resumed the conversation');
  assert.equal(await c.close(20_000), 0);
  assert.deepEqual(c.nonJson, []);
});

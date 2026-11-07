/**
 * Round 5 fixes, group acp: the verifier's probes of #11 (commands/execute compact cancels), #8
 * seen from ACP (a refused /compact) and g1 (set_mode cancelled by its own `$/cancel_request`).
 *
 * - a withdrawn compaction whose Claude child never ends (stuck): `failed`, the session replaced,
 *   `Command cancelled` last, and the session usable;
 * - a compaction withdrawn while the session is still starting never runs;
 * - a `/compact` Claude refuses the other way ("Not enough messages to compact.", a session
 *   holding only local-command entries): `{success:false}` with that text as a command, `failed`
 *   with it as prompt text;
 * - a set_mode withdrawn during its hook, with a prompt queued behind it: the prompt runs on the
 *   agent the session kept, with its conversation.
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { KiroSession, KiroSessionOptions, SessionEvent, TurnResult } from '../../src/types.js';
import { MockSession, createWorld, type MockWorld } from './mockSession.js';
import { TestClient, sleep, tmpEnv, until, writeAgent, type Frame, type TmpEnv } from './helpers.js';

const clients: TestClient[] = [];
after(async () => {
  await Promise.allSettled(clients.filter((c) => c.exitCode === undefined).map((c) => c.close(15_000)));
});

let nextId = 640_000;
function send(c: TestClient, method: string, params: unknown, ms = 30_000): { id: number; response: Promise<Frame> } {
  const id = nextId++;
  const response = c.waitFor((f) => f.id === id && f.method === undefined && ('result' in f || 'error' in f), ms, `response to ${method}#${id}`, c.frames.length);
  c.send({ jsonrpc: '2.0', id, method, params });
  return { id, response };
}

function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, sleep(ms).then(() => Promise.reject(new Error(`${what}: no answer within ${ms} ms`)))]);
}

const compactStatuses = (c: TestClient, from: number): Frame[] => c.frames.slice(from).filter((f) => f.method === '_kiro.dev/compaction/status').map((f) => f.params);
const statusTypes = (c: TestClient, from: number): string[] => compactStatuses(c, from).map((p) => p.status.type);
const nothingAfter = (c: TestClient, f: Frame, sid: string): Frame[] => c.frames.slice(c.frames.indexOf(f) + 1).filter((x) => x.method !== undefined && x.params?.sessionId === sid);
const compactCmd = (sid: string): Record<string, unknown> => ({ sessionId: sid, command: { command: 'compact', args: {} } });
const chunks = (c: TestClient, from: number): string =>
  c.frames
    .slice(from)
    .filter((f) => f.method === 'session/update' && f.params.update.sessionUpdate === 'agent_message_chunk')
    .map((f) => f.params.update.content.text as string)
    .join('');

// ───────────── mock sessions ─────────────

interface Ctl {
  compact: 'stuck' | 'stuck-after-boundary' | 'normal';
  /** start() waits until this is true. */
  startGate?: { open: boolean };
}

function factory(world: MockWorld, ctl: Ctl): (opts: KiroSessionOptions) => Promise<KiroSession> {
  class S extends MockSession {
    override async start(): Promise<void> {
      if (ctl.startGate) await until(() => ctl.startGate!.open, 10_000, 'the start gate');
      return super.start();
    }
    override async *compact(instructions?: string): AsyncGenerator<SessionEvent, TurnResult> {
      if (ctl.compact === 'normal') return yield* super.compact(instructions);
      world.calls.push(`compact(${ctl.compact})`);
      yield { type: 'compaction', state: 'started' };
      if (ctl.compact === 'stuck-after-boundary') {
        yield { type: 'raw', frame: { type: 'system', subtype: 'compact_boundary' } };
        yield { type: 'compaction', state: 'finished', preTokens: 9000, postTokens: 2000 };
        yield { type: 'raw', frame: { type: 'user', isSynthetic: true, message: { role: 'user', content: 'This session is being continued from a previous conversation.\n\nSummary:\nhi' } } };
      }
      // the child never answers the interrupt: only its close ends the compaction
      await until(() => this.closed, 20_000, 'the session closed');
      return { stopReason: 'cancelled', isError: false, text: '', permissionDenials: [] };
    }
  }
  return async (opts) => {
    world.created.push(opts);
    const s = new S(world, opts);
    world.sessions.push(s);
    return s;
  };
}

function mockSetup(ctl: Ctl): { t: TmpEnv; world: MockWorld; c: TestClient } {
  const t = tmpEnv();
  const world = createWorld([{ steps: [{ text: 'hello back' }] }]);
  const c = new TestClient({ args: [], env: t.env, cwd: t.work, createSession: factory(world, ctl), timings: { cancelGraceMs: 400, closeTimeoutMs: 1000 } });
  clients.push(c);
  return { t, world, c };
}

async function mockSession(c: TestClient, t: TmpEnv, prompt = true): Promise<string> {
  await c.initialize();
  const { sessionId } = (await c.call('session/new', { cwd: t.work, mcpServers: [] })) as { sessionId: string };
  if (prompt) {
    await c.waitFor((f) => f.method === 'session/update' && f.params?.update?.sessionUpdate === 'available_commands_update' && f.params.sessionId === sessionId, 5000);
    await c.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hi' }] });
  }
  return sessionId;
}

describe('#11 verify (mock): a withdrawn compaction whose child never ends', () => {
  test('$/cancel_request: failed after the grace period, the session replaced, Command cancelled last; the session goes on', async () => {
    const { t, world, c } = mockSetup({ compact: 'stuck' });
    const sid = await mockSession(c, t);
    const before = c.frames.length;
    const req = send(c, '_kiro.dev/commands/execute', compactCmd(sid));
    await until(() => world.calls.includes('compact(stuck)'), 5000, 'compaction running');
    c.notify('$/cancel_request', { requestId: req.id });
    const r = await within(req.response, 6000, 'a stuck withdrawn compaction');
    assert.deepEqual(r.result, { success: false, message: 'Command cancelled' }, JSON.stringify(r));
    assert.deepEqual(statusTypes(c, before), ['started', 'failed']);
    assert.equal(compactStatuses(c, before)[1]!.summary, 'Compaction cancelled');
    assert.equal(world.created.length, 2, 'the stuck session was replaced');
    await sleep(200);
    assert.deepEqual(nothingAfter(c, r, sid), [], 'frames of the session after the answer');
    const p = await c.call('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'again' }] });
    assert.equal(p.stopReason, 'end_turn');
    assert.equal(await c.close(), 0);
  });

  test('$/cancel_request after Claude compacted (boundary and summary seen), the child then stuck: completed, as it happened (module doc)', async () => {
    const { t, world, c } = mockSetup({ compact: 'stuck-after-boundary' });
    const sid = await mockSession(c, t);
    const before = c.frames.length;
    const req = send(c, '_kiro.dev/commands/execute', compactCmd(sid));
    await until(() => world.calls.includes('compact(stuck-after-boundary)'), 5000, 'compaction running');
    await sleep(50);
    c.notify('$/cancel_request', { requestId: req.id });
    const r = await within(req.response, 6000, 'a stuck withdrawn compaction');
    const info = `answer ${JSON.stringify(r.result ?? r.error)}; statuses ${JSON.stringify(compactStatuses(c, before))}`;
    assert.deepEqual(r.result, { success: true, message: 'Conversation compacted' }, info);
    assert.deepEqual(statusTypes(c, before), ['started', 'completed'], info);
    assert.equal(world.created.length, 2, 'the stuck session was replaced');
    await sleep(200);
    assert.deepEqual(nothingAfter(c, r, sid), []);
    assert.equal(await c.close(), 0);
  });

  test('"/compact" as prompt text, session/cancel after Claude compacted, the child then stuck: completed, the session replaced', async () => {
    const { t, world, c } = mockSetup({ compact: 'stuck-after-boundary' });
    const sid = await mockSession(c, t);
    const before = c.frames.length;
    const r = await c.call('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: '/compact' }] });
    assert.deepEqual(r, { stopReason: 'end_turn' });
    await until(() => world.calls.includes('compact(stuck-after-boundary)'), 5000, 'compaction running');
    await sleep(50);
    c.notify('session/cancel', { sessionId: sid });
    const end = await c.waitFor((f) => f.method === '_kiro.dev/compaction/status' && f.params.status.type !== 'started', 6000, 'the compaction end', before);
    assert.deepEqual(end.params.status, { type: 'completed' }, JSON.stringify(end.params));
    assert.match(String(end.params.summary), /hi/);
    await c.waitFor((f) => f.method === '_kiro.dev/metadata' && f.params.sessionId === sid, 6000, 'metadata', c.frames.indexOf(end));
    assert.equal(world.created.length, 2, 'the stuck session was replaced');
    const p = await c.call('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'again' }] });
    assert.equal(p.stopReason, 'end_turn');
    assert.equal(await c.close(), 0);
  });

  test('withdrawn while the session is still starting: it never runs, Command cancelled', async () => {
    const gate = { open: false };
    const { t, world, c } = mockSetup({ compact: 'normal', startGate: gate });
    const sid = await mockSession(c, t, false);
    const before = c.frames.length;
    const req = send(c, '_kiro.dev/commands/execute', compactCmd(sid));
    await sleep(100);
    c.notify('$/cancel_request', { requestId: req.id });
    await sleep(100);
    gate.open = true;
    const r = await within(req.response, 5000, 'a compaction withdrawn during the start');
    assert.deepEqual(r.result, { success: false, message: 'Command cancelled' });
    assert.ok(!world.calls.some((x) => x.startsWith('compact')), world.calls.join(','));
    assert.deepEqual(statusTypes(c, before), []);
    assert.equal(await c.close(), 0);
  });
});

// ───────────── real session module + the fake Claude Code ─────────────

async function realSetup(): Promise<{ t: TmpEnv; c: TestClient; sid: string }> {
  const t = tmpEnv({ FAKE_CLAUDE_PERSIST: '1' });
  const c = new TestClient({ args: [], env: t.env, cwd: t.work });
  clients.push(c);
  await c.initialize();
  const { sessionId } = (await c.call('session/new', { cwd: t.work, mcpServers: [] }, 30_000)) as { sessionId: string };
  await sleep(100);
  return { t, c, sid: sessionId };
}

describe('#8 verify: a /compact refused for "Not enough messages" (a session holding only local-command entries)', () => {
  test('commands/execute effort, then compact: {success:false} with Claude\'s text; status failed, never completed', async () => {
    const { c, sid } = await realSetup();
    const e = await c.call('_kiro.dev/commands/execute', { sessionId: sid, command: { command: 'effort', args: { value: 'high' } } }, 30_000);
    assert.equal(e.success, true, JSON.stringify(e));
    const before = c.frames.length;
    const r = await c.call('_kiro.dev/commands/execute', compactCmd(sid), 30_000);
    assert.equal(r.success, false, JSON.stringify(r));
    assert.match(String(r.message), /not enough messages to compact/i, JSON.stringify(r));
    assert.deepEqual(statusTypes(c, before), ['started', 'failed']);
    assert.match(String(compactStatuses(c, before)[1]!.summary), /not enough messages to compact/i);
    const p = await c.call('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'hello' }] }, 30_000);
    assert.equal(p.stopReason, 'end_turn');
    assert.equal(await c.close(15_000), 0);
  });

  test('"/compact" as prompt text twice on a new session: both failed (the second "Not enough messages"), no answer text claims success', async () => {
    const { c, sid } = await realSetup();
    for (const want of [/^No messages to compact$/, /not enough messages to compact/i]) {
      const before = c.frames.length;
      const r = await c.call('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: '/compact' }] }, 30_000);
      assert.deepEqual(r, { stopReason: 'end_turn' });
      const end = await c.waitFor((f) => f.method === '_kiro.dev/compaction/status' && f.params.status.type !== 'started', 10_000, 'the compaction end', before);
      assert.deepEqual(end.params.status, { type: 'failed' });
      assert.match(String(end.params.summary), want);
      await c.waitFor((f) => f.method === '_kiro.dev/metadata' && f.params.sessionId === sid, 10_000, 'metadata', c.frames.indexOf(end));
      assert.equal(chunks(c, before), 'Compacting conversation...\n');
    }
    assert.equal(await c.close(15_000), 0);
  });

  test('session/load after a refused /compact and a turn: the replay shows the turn, no compaction summary or error text', async () => {
    const { t, c, sid } = await realSetup();
    const r = await c.call('_kiro.dev/commands/execute', compactCmd(sid), 30_000);
    assert.equal(r.success, false);
    await c.call('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'hello there' }] }, 30_000);
    await c.call('_kiro.dev/session/terminate', { sessionId: sid }, 15_000);
    const from = c.frames.length;
    await c.call('session/load', { sessionId: sid, cwd: t.work, mcpServers: [] }, 30_000);
    const replayed = c.frames
      .slice(from)
      .filter((f) => f.method === 'session/update' && f.params.update._meta?.kiro?.replay === true)
      .map((f) => [f.params.update.sessionUpdate, f.params.update.content?.text]);
    const text = JSON.stringify(replayed);
    assert.ok(replayed.some(([k, x]) => k === 'user_message_chunk' && x === 'hello there'), text);
    assert.ok(replayed.some(([k]) => k === 'agent_message_chunk'), text);
    assert.doesNotMatch(text, /summary|compact/i);
    assert.equal(await c.close(15_000), 0);
  });
});

// ───────────── g1 with a prompt queued behind the withdrawn set_mode ─────────────

const SLEEP = '28.6191';
function hookPid(file: string): number | undefined {
  try {
    const pid = Number(fs.readFileSync(file, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}
function hookRuns(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').includes(SLEEP);
  } catch {
    return false;
  }
}
function killHook(file: string): void {
  const pid = hookPid(file);
  if (pid !== undefined && hookRuns(pid)) process.kill(pid, 'SIGKILL');
}

describe('g1 verify: a prompt queued behind a set_mode withdrawn during its hook', { skip: process.platform !== 'linux' ? 'needs /proc' : false }, () => {
  test('the prompt runs on the agent the session kept (crew), with the conversation, and no mode change is reported', async () => {
    const script = {
      turns: [{ repeat: true, match: 'RECALL', steps: [{ text: 'ctx: {{historyUserTexts}}' }] }],
      default: { steps: [{ text: 'ack' }] },
    };
    const t = tmpEnv({ FAKE_CLAUDE_SCRIPT_JSON: JSON.stringify(script), FAKE_CLAUDE_PERSIST: '1' });
    const slow = path.join(t.root, 'slow-hook');
    const pidFile = path.join(t.root, 'hook.pid');
    const cmd = `if [ -f '${slow}' ]; then echo $$ > '${pidFile}'; exec sleep ${SLEEP}; fi; echo spawned`;
    for (const name of ['crew', 'other']) {
      writeAgent(path.join(t.work, '.kiro'), name, { description: `${name} agent`, tools: ['*'], includeMcpJson: false, hooks: { agentSpawn: [{ command: cmd, timeout_ms: 0 }] } });
    }
    const c = new TestClient({ args: ['--agent', 'crew'], env: t.env, cwd: t.work });
    clients.push(c);
    try {
      await c.initialize();
      const { sessionId: sid } = (await c.call('session/new', { cwd: t.work, mcpServers: [] }, 30_000)) as { sessionId: string };
      await c.call('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'alpha' }] }, 30_000);
      fs.writeFileSync(slow, '');
      const mode = send(c, 'session/set_mode', { sessionId: sid, modeId: 'other' });
      await until(() => hookRuns(hookPid(pidFile)), 10_000, "the swap's agentSpawn hook runs");
      const from = c.frames.length;
      const prompt = send(c, 'session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'RECALL' }] });
      await sleep(50);
      fs.rmSync(slow);
      c.notify('$/cancel_request', { requestId: mode.id });
      const r = await within(mode.response, 3000, 'set_mode after $/cancel_request');
      assert.equal(r.error?.code, -32800, JSON.stringify(r));
      const p = await within(prompt.response, 30_000, 'the queued prompt');
      assert.equal(p.result?.stopReason, 'end_turn', JSON.stringify(p));
      assert.match(chunks(c, from), /alpha/, 'the conversation is kept');
      const modeFrames = c.frames.slice(from).filter((f) => f.method === '_kiro.dev/agent/switched' || (f.method === 'session/update' && f.params.update.sessionUpdate === 'current_mode_update'));
      assert.deepEqual(modeFrames, []);
      const a = await c.call('_kiro.dev/commands/execute', { sessionId: sid, command: { command: 'agent', args: {} } }, 15_000);
      assert.deepEqual(a.data, { agent: { name: 'crew' } });
      assert.equal(await c.close(15_000), 0);
    } finally {
      killHook(pidFile);
    }
  });
});

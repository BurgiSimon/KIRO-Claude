/**
 * Round 5 fixes, group acp.
 *
 * #11 `_kiro.dev/commands/execute compact` honours cancels like every other command (C3):
 * - withdrawn by its own `$/cancel_request` while queued: it never runs (no compaction status, no
 *   compact_boundary in Claude's transcript) and answers `{success:false,message:"Command cancelled"}`;
 * - withdrawn while it runs, or cancelled by `session/cancel` or the session's close: the compaction
 *   turn is interrupted, its status says `failed`, and it answers `Command cancelled` last
 *   (nothing for the session follows the answer);
 * - a cancel that loses the race to a finished compaction (compact_boundary seen) answers what
 *   happened: `completed`, `{success:true}`.
 * #8 (session group) seen from ACP: `/compact` of a session with no messages fails with Claude's
 * message ("No messages to compact"): `{success:false,message:…}` as a command, a `failed` status
 * (never `completed`) as prompt text, and with the reason when a restored history is pending.
 * g1 `session/set_mode` (and `set_config_option` `mode`) is cancelled by its own `$/cancel_request`:
 * queued, it never runs; while the target agent's agentSpawn hooks run, they are killed and it
 * answers `-32800` with the agent unchanged; a swap past its hooks finishes and answers `{}`.
 * `session/cancel` still leaves a mode change alone (05 §4.6).
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

let nextId = 610_000;
/** Sends a request; returns its id and a promise of its response frame. */
function send(c: TestClient, method: string, params: unknown, ms = 30_000): { id: number; response: Promise<Frame> } {
  const id = nextId++;
  const response = c.waitFor((f) => f.id === id && f.method === undefined && ('result' in f || 'error' in f), ms, `response to ${method}#${id}`, c.frames.length);
  c.send({ jsonrpc: '2.0', id, method, params });
  return { id, response };
}

/** Resolves with the frame, or rejects after `ms` (the cancel must answer promptly). */
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, sleep(ms).then(() => Promise.reject(new Error(`${what}: no answer within ${ms} ms`)))]);
}

const compactStatuses = (c: TestClient, from: number): Frame[] => c.frames.slice(from).filter((f) => f.method === '_kiro.dev/compaction/status').map((f) => f.params);
const statusTypes = (c: TestClient, from: number): string[] => compactStatuses(c, from).map((p) => p.status.type);
const frameIndex = (c: TestClient, f: Frame): number => c.frames.indexOf(f);

/** `"compact_boundary"` lines in every transcript under the temp CLAUDE_CONFIG_DIR. */
function compactBoundaries(t: TmpEnv): number {
  const dir = path.join(t.claudeConfig, 'projects');
  let n = 0;
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) n += fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.includes('"compact_boundary"')).length;
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return n;
}

/** Delete every Claude transcript under the temp CLAUDE_CONFIG_DIR (a lost transcript). */
function dropTranscripts(t: TmpEnv): number {
  const dir = path.join(t.claudeConfig, 'projects');
  let n = 0;
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) {
        fs.rmSync(p);
        n++;
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return n;
}

// ───────────── #11 with the real session module and the fake Claude Code ─────────────

const SCRIPT = {
  turns: [{ repeat: true, match: '^slow', steps: [{ sleepMs: 1500 }, { text: 'slow done' }] }],
  default: { steps: [{ text: 'ok {{historyCount}}' }] },
};

async function realSetup(compactMs: number, turns = ['first turn', 'second turn']): Promise<{ t: TmpEnv; c: TestClient; sid: string }> {
  const t = tmpEnv({ FAKE_CLAUDE_SCRIPT_JSON: JSON.stringify(SCRIPT), FAKE_CLAUDE_PERSIST: '1', FAKE_CLAUDE_COMPACT_MS: String(compactMs) });
  const c = new TestClient({ args: [], env: t.env, cwd: t.work });
  clients.push(c);
  await c.initialize();
  const { sessionId } = (await c.call('session/new', { cwd: t.work, mcpServers: [] }, 30_000)) as { sessionId: string };
  for (const text of turns) await c.call('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, 30_000);
  // the post-answer reports of session/new and the turns are out
  await sleep(100);
  return { t, c, sid: sessionId };
}

const compactCmd = (sid: string, args: Record<string, unknown> = {}): Record<string, unknown> => ({ sessionId: sid, command: { command: 'compact', args } });

/** Nothing of session `sid` follows frame index `i` (no status, metadata or update). */
function nothingAfter(c: TestClient, i: number, sid: string): Frame[] {
  return c.frames.slice(i + 1).filter((f) => f.method !== undefined && f.params?.sessionId === sid);
}

describe('#11: commands/execute compact honours $/cancel_request and session/cancel (C3)', () => {
  test('withdrawn by $/cancel_request while queued behind a prompt: never runs, answers Command cancelled', async () => {
    const { t, c, sid } = await realSetup(5);
    const prompt = send(c, 'session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'slow one' }] });
    await sleep(200);
    const before = c.frames.length;
    const queued = send(c, '_kiro.dev/commands/execute', compactCmd(sid));
    await sleep(50);
    c.notify('$/cancel_request', { requestId: queued.id });
    assert.equal((await prompt.response).result?.stopReason, 'end_turn');
    const r = await queued.response;
    await sleep(300);
    const info = `answer ${JSON.stringify(r.result ?? r.error)}; statuses ${JSON.stringify(statusTypes(c, before))}; boundaries ${compactBoundaries(t)}`;
    assert.deepEqual(r.result, { success: false, message: 'Command cancelled' }, info);
    assert.deepEqual(statusTypes(c, before), [], info);
    assert.equal(compactBoundaries(t), 0, info);
    // the conversation is whole: the next turn still sees every earlier line
    const from = c.frames.length;
    await c.call('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'after' }] }, 30_000);
    const text = c.frames.slice(from).filter((f) => f.method === 'session/update' && f.params.update.sessionUpdate === 'agent_message_chunk').map((f) => f.params.update.content.text).join('');
    assert.match(text, /^ok 4\b/, text);
    assert.equal(await c.close(15_000), 0);
  });

  test('withdrawn by its own $/cancel_request while it runs: interrupted, status failed, Command cancelled at once and nothing after it', async () => {
    const { t, c, sid } = await realSetup(3000);
    const before = c.frames.length;
    const req = send(c, '_kiro.dev/commands/execute', compactCmd(sid));
    await c.waitFor((f) => f.method === '_kiro.dev/compaction/status' && f.params.status.type === 'started', 10_000, 'started', before);
    await sleep(100);
    const t0 = Date.now();
    c.notify('$/cancel_request', { requestId: req.id });
    const r = await within(req.response, 2000, 'a withdrawn compaction');
    const ms = Date.now() - t0;
    await sleep(500);
    const info = `answer ${JSON.stringify(r.result ?? r.error)} after ${ms} ms; statuses ${JSON.stringify(compactStatuses(c, before))}; boundaries ${compactBoundaries(t)}`;
    assert.deepEqual(r.result, { success: false, message: 'Command cancelled' }, info);
    assert.deepEqual(statusTypes(c, before), ['started', 'failed'], info);
    assert.equal(compactStatuses(c, before)[1]!.summary, 'Compaction cancelled', info);
    assert.equal(compactBoundaries(t), 0, info);
    assert.deepEqual(nothingAfter(c, frameIndex(c, r), sid), [], 'frames of the session after the answer');
    const p = await c.call('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'after' }] }, 30_000);
    assert.equal(p.stopReason, 'end_turn');
    assert.equal(await c.close(15_000), 0);
  });

  test('session/cancel while it runs: interrupted, status failed, Command cancelled (as runOp commands answer)', async () => {
    const { t, c, sid } = await realSetup(3000);
    const before = c.frames.length;
    const req = send(c, '_kiro.dev/commands/execute', compactCmd(sid));
    await c.waitFor((f) => f.method === '_kiro.dev/compaction/status' && f.params.status.type === 'started', 10_000, 'started', before);
    await sleep(100);
    c.notify('session/cancel', { sessionId: sid });
    const r = await within(req.response, 2000, 'a cancelled compaction');
    await sleep(300);
    assert.deepEqual(r.result, { success: false, message: 'Command cancelled' });
    assert.deepEqual(statusTypes(c, before), ['started', 'failed']);
    assert.equal(compactBoundaries(t), 0);
    assert.deepEqual(nothingAfter(c, frameIndex(c, r), sid), []);
    assert.equal(await c.close(15_000), 0);
  });

  test('not cancelled: it still compacts and answers success (regression)', async () => {
    const { t, c, sid } = await realSetup(5);
    const before = c.frames.length;
    const r = await c.call('_kiro.dev/commands/execute', compactCmd(sid), 30_000);
    assert.deepEqual(r, { success: true, message: 'Conversation compacted' });
    assert.deepEqual(statusTypes(c, before), ['started', 'completed']);
    assert.equal(compactBoundaries(t), 1);
    assert.equal(await c.close(15_000), 0);
  });
});

describe('#8 seen from ACP: /compact of a session with no messages fails with Claude\'s message', () => {
  test('commands/execute compact of a new session: {success:false} with "No messages to compact"; status failed, never completed', async () => {
    const { t, c, sid } = await realSetup(5, []);
    const before = c.frames.length;
    const r = await c.call('_kiro.dev/commands/execute', compactCmd(sid), 30_000);
    assert.deepEqual(r, { success: false, message: 'No messages to compact' });
    assert.deepEqual(statusTypes(c, before), ['started', 'failed']);
    assert.equal(compactStatuses(c, before)[1]!.summary, 'No messages to compact');
    assert.equal(compactBoundaries(t), 0);
    // the chat goes on
    const p = await c.call('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'hello' }] }, 30_000);
    assert.equal(p.stopReason, 'end_turn');
    assert.equal(await c.close(15_000), 0);
  });

  test('"/compact" as prompt text of a new session: end_turn first (05 §4.5.4), then status failed with Claude\'s message, then metadata; no success claimed', async () => {
    const { c, sid } = await realSetup(5, []);
    const before = c.frames.length;
    const r = await c.call('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: '/compact' }] }, 30_000);
    assert.deepEqual(r, { stopReason: 'end_turn' });
    const failed = await c.waitFor((f) => f.method === '_kiro.dev/compaction/status' && f.params.status.type !== 'started', 10_000, 'the compaction end', before);
    assert.deepEqual(failed.params.status, { type: 'failed' });
    assert.equal(failed.params.summary, 'No messages to compact');
    await c.waitFor((f) => f.method === '_kiro.dev/metadata' && f.params.sessionId === sid, 10_000, 'metadata', frameIndex(c, failed));
    assert.deepEqual(statusTypes(c, before), ['started', 'failed']);
    const chunks = c.frames.slice(before).filter((f) => f.method === 'session/update' && f.params.update.sessionUpdate === 'agent_message_chunk').map((f) => f.params.update.content.text as string);
    assert.deepEqual(chunks, ['Compacting conversation...\n'], 'no answer text claims anything');
    assert.equal(await c.close(15_000), 0);
  });

  test('a session whose Claude transcript was lost (restored history pending): {success:false} says Claude gets the history with the next message', async () => {
    const { t, c, sid } = await realSetup(5, ['remember ALPHA']);
    await c.call('_kiro.dev/session/terminate', { sessionId: sid }, 15_000);
    assert.ok(dropTranscripts(t) >= 1, 'a transcript to lose');
    await c.call('session/load', { sessionId: sid, cwd: t.work, mcpServers: [] }, 30_000);
    await sleep(100);
    const before = c.frames.length;
    const r = await c.call('_kiro.dev/commands/execute', compactCmd(sid), 30_000);
    assert.equal(r.success, false, JSON.stringify(r));
    assert.match(String(r.message), /^No messages to compact: Claude Code gets the restored conversation with your next message/, JSON.stringify(r));
    assert.deepEqual(statusTypes(c, before), ['started', 'failed']);
    // the restored history still goes with the next line
    const from = c.frames.length;
    await c.call('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'and now' }] }, 30_000);
    const text = c.frames.slice(from).filter((f) => f.method === 'session/update' && f.params.update.sessionUpdate === 'agent_message_chunk').map((f) => f.params.update.content.text).join('');
    assert.match(text, /^ok 1\b/, text);
    assert.equal(await c.close(15_000), 0);
  });
});

// ───────────── #11 with mock sessions: races and the session's close ─────────────

interface Ctl {
  /** What the next compaction does. */
  compact: 'finish-after-interrupt' | 'until-closed';
}

function compactFactory(world: MockWorld, ctl: Ctl): (opts: KiroSessionOptions) => Promise<KiroSession> {
  class CompactSession extends MockSession {
    override async *compact(instructions?: string): AsyncGenerator<SessionEvent, TurnResult> {
      if (ctl.compact === 'finish-after-interrupt') {
        // the cancel lost the race: Claude finishes the compaction all the same
        world.calls.push('compact(racing)');
        yield { type: 'compaction', state: 'started' };
        await until(() => world.calls.includes('interrupt'), 5000, 'the interrupt');
        return yield* super.compact(instructions);
      }
      world.calls.push('compact(until-closed)');
      yield { type: 'compaction', state: 'started' };
      await until(() => this.closed, 10_000, 'the session closed');
      return { stopReason: 'cancelled', isError: false, text: '', permissionDenials: [] };
    }
  }
  return async (opts) => {
    world.created.push(opts);
    const s = new CompactSession(world, opts);
    world.sessions.push(s);
    return s;
  };
}

function mockSetup(ctl: Ctl): { t: TmpEnv; world: MockWorld; c: TestClient } {
  const t = tmpEnv();
  const world = createWorld([{ steps: [{ text: 'hello back' }] }]);
  const c = new TestClient({ args: [], env: t.env, cwd: t.work, createSession: compactFactory(world, ctl), timings: { cancelGraceMs: 2000, closeTimeoutMs: 1000 } });
  clients.push(c);
  return { t, world, c };
}

async function mockSession(c: TestClient, t: TmpEnv): Promise<string> {
  await c.initialize();
  const { sessionId } = (await c.call('session/new', { cwd: t.work, mcpServers: [] })) as { sessionId: string };
  await c.waitFor((f) => f.method === 'session/update' && f.params?.update?.sessionUpdate === 'available_commands_update' && f.params.sessionId === sessionId, 5000);
  await c.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hi' }] });
  return sessionId;
}

describe('#11 (mock sessions): what a cancelled compaction answers', () => {
  test('$/cancel_request that loses the race to a finished compaction (boundary seen): completed, {success:true}', async () => {
    const { t, world, c } = mockSetup({ compact: 'finish-after-interrupt' });
    const sid = await mockSession(c, t);
    const before = c.frames.length;
    const req = send(c, '_kiro.dev/commands/execute', compactCmd(sid));
    await until(() => world.calls.includes('compact(racing)'), 5000, 'compaction running');
    c.notify('$/cancel_request', { requestId: req.id });
    const r = await within(req.response, 3000, 'the compaction');
    assert.deepEqual(r.result, { success: true, message: 'Conversation compacted' }, JSON.stringify(r));
    assert.ok(world.calls.includes('interrupt'), 'the cancel interrupted the compaction turn');
    assert.deepEqual(statusTypes(c, before), ['started', 'completed']);
    assert.equal(await c.close(), 0);
  });

  test('session/cancel that loses the race to a finished "/compact" (prompt text): completed, not failed', async () => {
    const { t, world, c } = mockSetup({ compact: 'finish-after-interrupt' });
    const sid = await mockSession(c, t);
    const before = c.frames.length;
    const r = await c.call('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: '/compact' }] });
    assert.deepEqual(r, { stopReason: 'end_turn' });
    await until(() => world.calls.includes('compact(racing)'), 5000, 'compaction running');
    c.notify('session/cancel', { sessionId: sid });
    await c.waitFor((f) => f.method === '_kiro.dev/compaction/status' && f.params.status.type !== 'started', 5000, 'the compaction end', before);
    assert.deepEqual(statusTypes(c, before), ['started', 'completed']);
    assert.equal(await c.close(), 0);
  });

  test('the session terminated while a commands/execute compact runs: Command cancelled', async () => {
    const { t, world, c } = mockSetup({ compact: 'until-closed' });
    const sid = await mockSession(c, t);
    const req = send(c, '_kiro.dev/commands/execute', compactCmd(sid));
    await until(() => world.calls.includes('compact(until-closed)'), 5000, 'compaction running');
    assert.deepEqual(await c.call('_kiro.dev/session/terminate', { sessionId: sid }, 10_000), {});
    const r = await within(req.response, 5000, 'the compaction of a terminated session');
    assert.deepEqual(r.result, { success: false, message: 'Command cancelled' }, JSON.stringify(r));
    assert.equal(await c.close(), 0);
  });
});

// ───────────── g1: session/set_mode cancelled by its own $/cancel_request ─────────────

/** A pid this test's hook wrote, while it still runs `sleep <SLEEP>` (never another process). */
const SLEEP = '28.6173';
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

/**
 * Agents `crew` and `other`, whose agentSpawn hook (timeout 0) is fast until `slow` exists, then
 * writes its pid to `pidFile` and sleeps for good.
 */
function hookSetup(): { t: TmpEnv; slow: string; pidFile: string; c: TestClient } {
  const SCRIPT_H = {
    turns: [
      { repeat: true, match: '^slow', steps: [{ sleepMs: 1500 }, { text: 'slow done' }] },
      { repeat: true, match: 'RECALL', steps: [{ text: 'claude-context: {{historyUserTexts}}' }] },
    ],
    default: { steps: [{ text: 'ack' }] },
  };
  const t = tmpEnv({ FAKE_CLAUDE_SCRIPT_JSON: JSON.stringify(SCRIPT_H), FAKE_CLAUDE_PERSIST: '1' });
  const slow = path.join(t.root, 'slow-hook');
  const pidFile = path.join(t.root, 'hook.pid');
  const cmd = `if [ -f '${slow}' ]; then echo $$ > '${pidFile}'; exec sleep ${SLEEP}; fi; echo spawned`;
  for (const name of ['crew', 'other']) {
    writeAgent(path.join(t.work, '.kiro'), name, { description: `${name} agent`, tools: ['*'], includeMcpJson: false, hooks: { agentSpawn: [{ command: cmd, timeout_ms: 0 }] } });
  }
  const c = new TestClient({ args: ['--agent-engine', 'v2', '--agent', 'crew'], env: t.env, cwd: t.work });
  clients.push(c);
  return { t, slow, pidFile, c };
}

async function hookSession(c: TestClient, t: TmpEnv): Promise<string> {
  await c.initialize();
  const { sessionId } = (await c.call('session/new', { cwd: t.work, mcpServers: [] }, 30_000)) as { sessionId: string };
  await c.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'alpha' }] }, 30_000);
  return sessionId;
}

const agentNow = async (c: TestClient, sid: string): Promise<unknown> => (await c.call('_kiro.dev/commands/execute', { sessionId: sid, command: { command: 'agent', args: {} } }, 15_000)).data;
const modeFrames = (c: TestClient, from: number): Frame[] =>
  c.frames.slice(from).filter((f) => f.method === '_kiro.dev/agent/switched' || (f.method === 'session/update' && f.params.update.sessionUpdate === 'current_mode_update'));

describe('g1: session/set_mode is cancelled by its own $/cancel_request', { skip: process.platform !== 'linux' ? 'needs /proc' : false }, () => {
  test('withdrawn while the target agent\'s agentSpawn hook hangs: -32800 within 2 s, the hook killed, still agent crew; the next prompt runs on crew', async () => {
    const { t, slow, pidFile, c } = hookSetup();
    try {
      const sid = await hookSession(c, t);
      fs.writeFileSync(slow, '');
      const before = c.frames.length;
      const { id, response } = send(c, 'session/set_mode', { sessionId: sid, modeId: 'other' });
      await until(() => hookRuns(hookPid(pidFile)), 10_000, 'the swap\'s agentSpawn hook runs');
      c.notify('$/cancel_request', { requestId: id });
      const r = await within(response, 2000, 'set_mode after $/cancel_request');
      assert.equal(r.error?.code, -32800, JSON.stringify(r));
      await until(() => !hookRuns(hookPid(pidFile)), 3000, 'the hook is killed');
      assert.deepEqual(modeFrames(c, before), [], 'a cancelled set_mode reported a mode change');
      fs.rmSync(slow);
      assert.deepEqual(await agentNow(c, sid), { agent: { name: 'crew' } });
      const from = c.frames.length;
      const p = await c.call('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'RECALL' }] }, 30_000);
      assert.equal(p.stopReason, 'end_turn');
      const text = c.frames.slice(from).filter((f) => f.method === 'session/update' && f.params.update.sessionUpdate === 'agent_message_chunk').map((f) => f.params.update.content.text).join('');
      assert.match(text, /alpha/, 'the conversation is kept');
      // a set_mode that is not withdrawn still switches
      const ok = await c.call('session/set_mode', { sessionId: sid, modeId: 'other' }, 30_000);
      assert.deepEqual(ok, {});
      assert.deepEqual(await agentNow(c, sid), { agent: { name: 'other' } });
    } finally {
      killHook(pidFile);
    }
  });

  test('withdrawn while queued behind a prompt: it never runs (no hook, no mode change) and answers -32800', async () => {
    const { t, slow, pidFile, c } = hookSetup();
    try {
      const sid = await hookSession(c, t);
      fs.writeFileSync(slow, '');
      const before = c.frames.length;
      const prompt = send(c, 'session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'slow one' }] });
      await sleep(200);
      const queued = send(c, 'session/set_mode', { sessionId: sid, modeId: 'other' });
      await sleep(50);
      c.notify('$/cancel_request', { requestId: queued.id });
      assert.equal((await prompt.response).result?.stopReason, 'end_turn');
      const r = await within(queued.response, 3000, 'a withdrawn queued set_mode');
      assert.equal(r.error?.code, -32800, JSON.stringify(r));
      await sleep(300);
      assert.equal(hookPid(pidFile), undefined, 'the withdrawn swap ran its hook');
      assert.deepEqual(modeFrames(c, before), []);
      fs.rmSync(slow);
      assert.deepEqual(await agentNow(c, sid), { agent: { name: 'crew' } });
    } finally {
      killHook(pidFile);
    }
  });

  test('set_config_option mode withdrawn while the hook hangs: -32800, the agent unchanged', async () => {
    const { t, slow, pidFile, c } = hookSetup();
    try {
      const sid = await hookSession(c, t);
      fs.writeFileSync(slow, '');
      const before = c.frames.length;
      const { id, response } = send(c, 'session/set_config_option', { sessionId: sid, configId: 'mode', value: 'other' });
      await until(() => hookRuns(hookPid(pidFile)), 10_000, 'the swap\'s agentSpawn hook runs');
      c.notify('$/cancel_request', { requestId: id });
      const r = await within(response, 2000, 'set_config_option mode after $/cancel_request');
      assert.equal(r.error?.code, -32800, JSON.stringify(r));
      await until(() => !hookRuns(hookPid(pidFile)), 3000, 'the hook is killed');
      assert.deepEqual(modeFrames(c, before), []);
      fs.rmSync(slow);
      assert.deepEqual(await agentNow(c, sid), { agent: { name: 'crew' } });
    } finally {
      killHook(pidFile);
    }
  });

  test('session/cancel does not cancel a set_mode (05 §4.6): it switches once its hook ends', async () => {
    const { t, slow, pidFile, c } = hookSetup();
    try {
      const sid = await hookSession(c, t);
      fs.writeFileSync(slow, '');
      const before = c.frames.length;
      const { response } = send(c, 'session/set_mode', { sessionId: sid, modeId: 'other' });
      await until(() => hookRuns(hookPid(pidFile)), 10_000, 'the swap\'s agentSpawn hook runs');
      let answered = false;
      void response.then(() => (answered = true));
      c.notify('session/cancel', { sessionId: sid });
      await sleep(500);
      assert.equal(answered, false, 'session/cancel answered the set_mode');
      assert.ok(hookRuns(hookPid(pidFile)), 'session/cancel killed the set_mode hook');
      // the hook ends (this test's own process): the swap goes on
      fs.rmSync(slow);
      killHook(pidFile);
      const r = await within(response, 10_000, 'set_mode once its hook ends');
      assert.equal(r.error, undefined, JSON.stringify(r));
      assert.equal(modeFrames(c, before).length, 2);
      assert.deepEqual(await agentNow(c, sid), { agent: { name: 'other' } });
    } finally {
      killHook(pidFile);
    }
  });
});

describe('g1 (mock session): a set_mode withdrawn after its swap can no longer stop answers what it did', () => {
  test('the swap finishes despite the cancel: {} with current_mode_update and agent/switched; never half-switched', async () => {
    const t = tmpEnv();
    writeAgent(path.join(t.work, '.kiro'), 'crew', { description: 'crew agent', tools: ['*'], includeMcpJson: false });
    writeAgent(path.join(t.work, '.kiro'), 'other', { description: 'other agent', tools: ['*'], includeMcpJson: false });
    const world = createWorld([{ steps: [{ text: 'hello back' }] }]);
    class LateSwap extends MockSession {
      override async swapAgent(name: string): Promise<void> {
        world.calls.push(`swapAgent(late):${name}`);
        // past its hooks: an interrupt no longer stops it (the session's restart)
        await until(() => world.calls.includes('interrupt'), 5000, 'the interrupt');
        await sleep(50);
        return super.swapAgent(name);
      }
    }
    const factory = async (opts: KiroSessionOptions): Promise<KiroSession> => {
      world.created.push(opts);
      const s = new LateSwap(world, opts);
      world.sessions.push(s);
      return s;
    };
    const c = new TestClient({ args: ['--agent', 'crew'], env: t.env, cwd: t.work, createSession: factory });
    clients.push(c);
    await c.initialize();
    const { sessionId } = (await c.call('session/new', { cwd: t.work, mcpServers: [] })) as { sessionId: string };
    const before = c.frames.length;
    const { id, response } = send(c, 'session/set_mode', { sessionId, modeId: 'other' });
    await until(() => world.calls.includes('swapAgent(late):other'), 5000, 'the swap runs');
    c.notify('$/cancel_request', { requestId: id });
    const r = await within(response, 5000, 'set_mode');
    assert.deepEqual(r.result, {}, JSON.stringify(r));
    const frames = modeFrames(c, before);
    assert.equal(frames.length, 2, JSON.stringify(frames));
    assert.deepEqual(await agentNow(c, sessionId), { agent: { name: 'other' } });
    assert.equal(await c.close(), 0);
  });
});

/**
 * Round 5, group crew-acp, C3: cancel paths of ACP commands and session starts.
 *
 * - A `_kiro.dev/commands/execute` (or a Kiro command sent as prompt text) that waits for a slow
 *   Claude Code control request (`usage()`: get_context_usage, `mcpStatus()`: mcp_status, the MCP
 *   init wait) answers at once on `session/cancel`, its own `$/cancel_request` or the connection
 *   closing, and whatever the wait produces later is dropped: no MCP notification and no message
 *   chunk of it lands in later output.
 * - `session/cancel` during a `/clear` whose agentSpawn hooks run kills them (K3): the clear is
 *   cancelled, the conversation kept.
 * - A connection that closes while `session/new` or `session/load` runs a slow agentSpawn hook
 *   cancels that start (start signal): the hook is killed, no half-started session, record or lock
 *   stays behind.
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { KiroSession, KiroSessionOptions, McpStatusEntry, UsageReport } from '../../src/types.js';
import { MockSession, createWorld, type MockWorld } from './mockSession.js';
import { TestClient, sleep, tmpEnv, until, writeAgent, type Frame, type TmpEnv } from './helpers.js';

const clients: TestClient[] = [];
after(async () => {
  await Promise.allSettled(clients.filter((c) => c.exitCode === undefined).map((c) => c.close(15_000)));
});

interface Gate {
  promise: Promise<void>;
  open(): void;
}
function gate(): Gate {
  let open!: () => void;
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
}

/** Knobs of {@link slowFactory}'s sessions: `usage()` / `mcpStatus()` wait for `gate` while slow. */
interface Ctl {
  slowUsage: boolean;
  slowMcp: boolean;
  usageCalls: number;
  mcpCalls: number;
  gate: Gate;
  /** What a slow `mcpStatus()` answers once the gate opens (a server the session never reported). */
  lateMcp?: McpStatusEntry[];
}

function slowFactory(world: MockWorld, ctl: Ctl): (opts: KiroSessionOptions) => Promise<KiroSession> {
  class SlowSession extends MockSession {
    override async usage(): Promise<UsageReport> {
      if (ctl.slowUsage) {
        ctl.usageCalls++;
        await ctl.gate.promise;
      }
      return super.usage();
    }
    override async mcpStatus(): Promise<McpStatusEntry[]> {
      if (ctl.slowMcp) {
        ctl.mcpCalls++;
        await ctl.gate.promise;
        return ctl.lateMcp ?? super.mcpStatus();
      }
      return super.mcpStatus();
    }
  }
  return async (opts) => {
    world.created.push(opts);
    const s = new SlowSession(world, opts);
    world.sessions.push(s);
    return s;
  };
}

function mockSetup(): { t: TmpEnv; world: MockWorld; ctl: Ctl; c: TestClient } {
  const t = tmpEnv();
  writeAgent(path.join(t.work, '.kiro'), 'crew', { description: 'crew agent', tools: ['*'], mcpServers: { probe: { command: 'node', args: ['x.js'] } }, includeMcpJson: false });
  const world = createWorld([{ steps: [{ text: 'hello back' }] }]);
  const ctl: Ctl = { slowUsage: false, slowMcp: false, usageCalls: 0, mcpCalls: 0, gate: gate() };
  const c = new TestClient({ args: ['--agent-engine', 'v2', '--agent', 'crew'], env: t.env, cwd: t.work, createSession: slowFactory(world, ctl) });
  clients.push(c);
  return { t, world, ctl, c };
}

async function newSession(c: TestClient, t: TmpEnv): Promise<string> {
  await c.initialize();
  const { sessionId } = (await c.call('session/new', { cwd: t.work, mcpServers: [] })) as { sessionId: string };
  // its post-answer reports (MCP, metadata, available commands) are out
  await c.waitFor((f) => f.method === 'session/update' && f.params?.update?.sessionUpdate === 'available_commands_update' && f.params.sessionId === sessionId, 5000);
  return sessionId;
}

/** Sends a request; returns its id and a promise of its response frame. */
function send(c: TestClient, method: string, params: unknown): { id: number; response: Promise<Frame> } {
  const id = 9000 + Math.floor(Math.random() * 1_000_000);
  const response = c.waitFor((f) => f.id === id && f.method === undefined && ('result' in f || 'error' in f), 20_000, `response to ${method}#${id}`, c.frames.length);
  c.send({ jsonrpc: '2.0', id, method, params });
  return { id, response };
}

/** Resolves with the frame, or rejects after `ms` (the cancel must answer promptly). */
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, sleep(ms).then(() => Promise.reject(new Error(`${what}: no answer within ${ms} ms`)))]);
}

describe('C3: a command waiting for a slow control request answers promptly on cancel, and its late answer is dropped', () => {
  test('commands/execute usage: session/cancel → {success:false} at once; the late usage answer writes nothing', async () => {
    const { t, ctl, c } = mockSetup();
    try {
      const sid = await newSession(c, t);
      ctl.slowUsage = true;
      const { response } = send(c, '_kiro.dev/commands/execute', { sessionId: sid, command: { command: 'usage', args: {} } });
      await until(() => ctl.usageCalls > 0, 5000, 'usage() called');
      const sent = Date.now();
      c.notify('session/cancel', { sessionId: sid });
      const r = await within(response, 1500, 'commands/execute usage after session/cancel');
      assert.ok(Date.now() - sent < 1500);
      assert.deepEqual(r.result, { success: false, message: 'Command cancelled' });
      const n = c.frames.length;
      ctl.slowUsage = false;
      ctl.gate.open();
      await sleep(100);
      assert.deepEqual(c.frames.slice(n), [], 'the late usage answer produced output');
      // the session's queue goes on
      const p = await c.call('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'hi' }] });
      assert.equal(p.stopReason, 'end_turn');
    } finally {
      ctl.gate.open();
    }
  });

  test('commands/execute usage: its own $/cancel_request ends the wait the same way', async () => {
    const { t, ctl, c } = mockSetup();
    try {
      const sid = await newSession(c, t);
      ctl.slowUsage = true;
      const { id, response } = send(c, '_kiro.dev/commands/execute', { sessionId: sid, command: { command: 'usage', args: {} } });
      await until(() => ctl.usageCalls > 0, 5000, 'usage() called');
      c.notify('$/cancel_request', { requestId: id });
      const r = await within(response, 1500, 'commands/execute usage after $/cancel_request');
      assert.deepEqual(r.result, { success: false, message: 'Command cancelled' });
    } finally {
      ctl.gate.open();
    }
  });

  test('a commands/execute withdrawn by $/cancel_request while it waits in the queue never runs', async () => {
    const { t, world, ctl, c } = mockSetup();
    try {
      const sid = await newSession(c, t);
      ctl.slowUsage = true;
      const first = send(c, '_kiro.dev/commands/execute', { sessionId: sid, command: { command: 'usage', args: {} } });
      await until(() => ctl.usageCalls > 0, 5000, 'usage() called');
      const queued = send(c, '_kiro.dev/commands/execute', { sessionId: sid, command: { command: 'clear', args: {} } });
      await sleep(50);
      c.notify('$/cancel_request', { requestId: queued.id });
      await sleep(50);
      ctl.slowUsage = false;
      ctl.gate.open();
      assert.equal((await first.response).result?.success, true);
      assert.deepEqual((await queued.response).result, { success: false, message: 'Command cancelled' });
      assert.equal(world.calls.includes('clear'), false, 'the withdrawn /clear ran');
    } finally {
      ctl.gate.open();
    }
  });

  test('commands/execute mcp: session/cancel → {success:false} at once; the late mcp_status answer reports no server', async () => {
    const { t, ctl, c } = mockSetup();
    try {
      const sid = await newSession(c, t);
      ctl.slowMcp = true;
      ctl.lateMcp = [
        { name: 'probe', status: 'connected', toolCount: 1 },
        { name: 'late', status: 'connected', toolCount: 2 },
      ];
      const { response } = send(c, '_kiro.dev/commands/execute', { sessionId: sid, command: { command: 'mcp', args: {} } });
      await until(() => ctl.mcpCalls > 0, 5000, 'mcpStatus() called');
      c.notify('session/cancel', { sessionId: sid });
      const r = await within(response, 1500, 'commands/execute mcp after session/cancel');
      assert.deepEqual(r.result, { success: false, message: 'Command cancelled' });
      const n = c.frames.length;
      ctl.slowMcp = false;
      ctl.gate.open();
      await sleep(100);
      assert.deepEqual(c.frames.slice(n), [], 'the late mcp_status answer produced output');
      await c.call('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'hi' }] });
      assert.deepEqual(
        c.notifications('_kiro.dev/mcp/server_initialized').filter((f) => f.params.serverName === 'late'),
        [],
        'a server only the cancelled command\'s late answer named was reported',
      );
    } finally {
      ctl.gate.open();
    }
  });

  test('"/usage" sent as prompt text: session/cancel → stopReason cancelled at once; its text never lands in the next prompt\'s output', async () => {
    const { t, ctl, c } = mockSetup();
    try {
      const sid = await newSession(c, t);
      ctl.slowUsage = true;
      const { response } = send(c, 'session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: '/usage' }] });
      await until(() => ctl.usageCalls > 0, 5000, 'usage() called');
      c.notify('session/cancel', { sessionId: sid });
      const r = await within(response, 1500, '/usage prompt after session/cancel');
      assert.deepEqual(r.result, { stopReason: 'cancelled' });
      const n = c.frames.length;
      ctl.slowUsage = false;
      ctl.gate.open();
      const p = await c.call('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'hi' }] });
      assert.equal(p.stopReason, 'end_turn');
      const chunks = c.frames
        .slice(n)
        .filter((f) => f.method === 'session/update' && f.params.update.sessionUpdate === 'agent_message_chunk')
        .map((f) => f.params.update.content.text as string)
        .join('');
      assert.equal(chunks, 'hello back', 'the cancelled /usage wrote its answer into the next prompt\'s output');
    } finally {
      ctl.gate.open();
    }
  });

  test('the connection closes while commands/execute waits: it is answered before the server exits, and the exit does not wait for the control request', async () => {
    const { t, ctl, c } = mockSetup();
    try {
      const sid = await newSession(c, t);
      ctl.slowUsage = true;
      const { id } = send(c, '_kiro.dev/commands/execute', { sessionId: sid, command: { command: 'usage', args: {} } });
      await until(() => ctl.usageCalls > 0, 5000, 'usage() called');
      const t0 = Date.now();
      c.stdin.end();
      await within(c.exited, 1500, 'server exit after stdin EOF');
      assert.ok(Date.now() - t0 < 1500, `exit took ${Date.now() - t0} ms`);
      const r = c.frames.find((f) => f.id === id && f.method === undefined);
      assert.deepEqual(r?.result, { success: false, message: 'Command cancelled' }, 'the command was never answered');
    } finally {
      ctl.gate.open();
    }
  });
});

// ─────────────── real sessions (fake claude) ───────────────

/** get_context_usage control requests the fake claude has read so far (its stdin log). */
function usageRequests(log: string): number {
  try {
    return fs
      .readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { event?: string; line?: { type?: string; request?: { subtype?: string } } })
      .filter((e) => e.event === 'stdin' && e.line?.type === 'control_request' && e.line.request?.subtype === 'get_context_usage').length;
  } catch {
    return 0;
  }
}

test('C3, real session: commands/execute usage while Claude Code is slow to answer get_context_usage → session/cancel answers at once; the late control_response corrupts nothing', async () => {
  const SCRIPT = { turns: [{ repeat: true, match: 'RECALL', steps: [{ text: 'claude-context: {{historyUserTexts}}' }] }], default: { steps: [{ text: 'ack' }] } };
  const t = tmpEnv({ FAKE_CLAUDE_SCRIPT_JSON: JSON.stringify(SCRIPT), FAKE_CLAUDE_CONTROL_DELAYS: JSON.stringify({ get_context_usage: 2500 }) });
  const log = path.join(t.root, 'fake.jsonl');
  t.env.FAKE_CLAUDE_LOG = log;
  writeAgent(path.join(t.work, '.kiro'), 'crew', { description: 'crew agent', tools: ['*'], includeMcpJson: false });
  const c = new TestClient({ args: ['--agent-engine', 'v2', '--agent', 'crew'], env: t.env, cwd: t.work });
  clients.push(c);
  await c.initialize();
  const { sessionId: sid } = (await c.call('session/new', { cwd: t.work, mcpServers: [] }, 30_000)) as { sessionId: string };
  await c.waitFor((f) => f.method === 'session/update' && f.params?.update?.sessionUpdate === 'available_commands_update', 10_000);
  const before = usageRequests(log);
  const { response } = send(c, '_kiro.dev/commands/execute', { sessionId: sid, command: { command: 'usage', args: {} } });
  await until(() => usageRequests(log) > before, 5000, 'the get_context_usage request reached Claude Code');
  const asked = Date.now();
  c.notify('session/cancel', { sessionId: sid });
  const r = await within(response, 1500, 'commands/execute usage after session/cancel');
  assert.deepEqual(r.result, { success: false, message: 'Command cancelled' });
  // a turn runs while the late control_response comes in, and one after it
  const from = c.frames.length;
  const p1 = await c.call('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'alpha' }] }, 30_000);
  await sleep(Math.max(0, 2500 + 300 - (Date.now() - asked)));
  const p2 = await c.call('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'RECALL' }] }, 30_000);
  assert.deepEqual([p1.stopReason, p2.stopReason], ['end_turn', 'end_turn']);
  const text = c.frames
    .slice(from)
    .filter((f) => f.method === 'session/update' && f.params.update.sessionUpdate === 'agent_message_chunk')
    .map((f) => f.params.update.content.text as string)
    .join('|');
  assert.match(text, /^ack\|claude-context: .*alpha/, `unexpected output: ${text}`);
  assert.doesNotMatch(text, /[Cc]ontext window|tokens/, 'the cancelled /usage answer landed in later output');
  assert.equal(c.frames.filter((f) => f.id === r.id).length, 1, 'the cancelled command was answered twice');
});

// ─────────────── real sessions (fake claude) with agentSpawn hooks ───────────────

/** A pid this test's hook wrote, while it still runs `sleep <SLEEP>` (never another process). */
const SLEEP = '29.4813';
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
    const argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    return argv.includes(SLEEP);
  } catch {
    return false;
  }
}
function killHook(file: string): void {
  const pid = hookPid(file);
  if (pid !== undefined && hookRuns(pid)) process.kill(pid, 'SIGKILL');
}

/**
 * An agent whose agentSpawn hook (timeout 0: never times out) is fast until `slow` exists, then
 * writes its pid to `pidFile` and sleeps for good.
 */
function hookSetup(): { t: TmpEnv; slow: string; pidFile: string; dir: string; c: TestClient } {
  const SCRIPT = { turns: [{ repeat: true, match: 'RECALL', steps: [{ text: 'claude-context: {{historyUserTexts}}' }] }], default: { steps: [{ text: 'ack' }] } };
  const t = tmpEnv({ FAKE_CLAUDE_SCRIPT_JSON: JSON.stringify(SCRIPT), FAKE_CLAUDE_PERSIST: '1' });
  const slow = path.join(t.root, 'slow-hook');
  const pidFile = path.join(t.root, 'hook.pid');
  const cmd = `if [ -f '${slow}' ]; then echo $$ > '${pidFile}'; exec sleep ${SLEEP}; fi; echo spawned`;
  writeAgent(path.join(t.work, '.kiro'), 'crew', { description: 'crew agent', tools: ['*'], includeMcpJson: false, hooks: { agentSpawn: [{ command: cmd, timeout_ms: 0 }] } });
  const c = new TestClient({ args: ['--agent-engine', 'v2', '--agent', 'crew'], env: t.env, cwd: t.work });
  clients.push(c);
  return { t, slow, pidFile, dir: path.join(t.kiroHome, 'sessions', 'cli'), c };
}

const sessionFiles = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.(json|jsonl|lock)$/.test(f)).sort() : []);

describe('C3: agentSpawn hooks of a command or a session start are cancelled with it', { skip: process.platform !== 'linux' ? 'needs /proc' : false }, () => {
  test('session/cancel during a /clear whose agentSpawn hook hangs: the hook is killed, the clear answers cancelled, the conversation is kept', async () => {
    const { t, slow, pidFile, c } = hookSetup();
    try {
      await c.initialize();
      const { sessionId: sid } = (await c.call('session/new', { cwd: t.work, mcpServers: [] }, 30_000)) as { sessionId: string };
      await c.call('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'alpha' }] }, 30_000);
      fs.writeFileSync(slow, '');
      const { response } = send(c, '_kiro.dev/commands/execute', { sessionId: sid, command: { command: 'clear', args: {} } });
      await until(() => hookRuns(hookPid(pidFile)), 10_000, 'the /clear agentSpawn hook runs');
      c.notify('session/cancel', { sessionId: sid });
      const r = await within(response, 3000, 'commands/execute clear after session/cancel');
      assert.equal(r.result?.success, false, JSON.stringify(r));
      assert.match(String(r.result?.message), /cancelled/i);
      await until(() => !hookRuns(hookPid(pidFile)), 3000, 'the hook is killed');
      assert.deepEqual(c.notifications('_kiro.dev/clear/status'), [], 'a cancelled clear reported clear/status');
      fs.rmSync(slow);
      const from = c.frames.length;
      await c.call('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'RECALL' }] }, 30_000);
      const text = c.frames
        .slice(from)
        .filter((f) => f.method === 'session/update' && f.params.update.sessionUpdate === 'agent_message_chunk')
        .map((f) => f.params.update.content.text as string)
        .join('');
      assert.match(text, /alpha/, 'the conversation was cleared after all');
    } finally {
      killHook(pidFile);
    }
  });

  test('the connection closes while session/new runs a hanging agentSpawn hook: the start is cancelled, nothing stays (no record, no lock, no hook)', async () => {
    const { t, slow, pidFile, dir, c } = hookSetup();
    try {
      fs.writeFileSync(slow, '');
      await c.initialize();
      send(c, 'session/new', { cwd: t.work, mcpServers: [] });
      await until(() => hookRuns(hookPid(pidFile)), 10_000, 'the agentSpawn hook runs');
      assert.ok(sessionFiles(dir).some((f) => f.endsWith('.lock')), 'the starting session holds its lock');
      const t0 = Date.now();
      c.stdin.end();
      await until(() => !hookRuns(hookPid(pidFile)), 2000, 'the agentSpawn hook is killed when the connection closes');
      await within(c.exited, 5000, 'server exit');
      assert.ok(Date.now() - t0 < 5000);
      assert.deepEqual(sessionFiles(dir), [], 'a half-started session left files behind');
    } finally {
      killHook(pidFile);
    }
  });

  test('the connection closes while session/load runs a hanging agentSpawn hook: the start is cancelled, the saved record stays as it was, its lock is released', async () => {
    const { t, slow, pidFile, dir, c } = hookSetup();
    try {
      await c.initialize();
      const { sessionId: sid } = (await c.call('session/new', { cwd: t.work, mcpServers: [] }, 30_000)) as { sessionId: string };
      await c.call('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'alpha' }] }, 30_000);
      await c.call('_kiro.dev/session/terminate', { sessionId: sid }, 15_000);
      const before = fs.readFileSync(path.join(dir, `${sid}.json`), 'utf8');
      fs.writeFileSync(slow, '');
      send(c, 'session/load', { sessionId: sid, cwd: t.work, mcpServers: [] });
      await until(() => hookRuns(hookPid(pidFile)), 10_000, 'the agentSpawn hook runs');
      c.stdin.end();
      await until(() => !hookRuns(hookPid(pidFile)), 2000, 'the agentSpawn hook is killed when the connection closes');
      await within(c.exited, 5000, 'server exit');
      assert.equal(fs.existsSync(path.join(dir, `${sid}.lock`)), false, 'the lock is left behind');
      assert.equal(fs.readFileSync(path.join(dir, `${sid}.json`), 'utf8'), before, 'the saved record changed');
    } finally {
      killHook(pidFile);
    }
  });
});

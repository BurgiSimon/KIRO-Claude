/**
 * Round 5, group crew-acp, verifier of C3 (cancel paths of ACP commands and session starts).
 *
 * - A Kiro command sent as prompt text that a `session/cancel` cancels (a `/clear` or an agent
 *   swap whose agentSpawn hooks it kills) answers `stopReason:"cancelled"` (05 §4.6, KC-ACP-07:
 *   a cancelled prompt answers `cancelled`), not `end_turn`, and nothing was changed.
 * - `commands/execute agent` (a swap) cancelled while the target agent's agentSpawn hook runs:
 *   the hook is killed, the swap answers `{success:false}` and the agent is unchanged.
 * - A `session/new` withdrawn by its own `$/cancel_request` while its agentSpawn hook runs answers
 *   `-32800` at once, kills the hook and leaves no record or lock; the server keeps serving.
 * - The server's stop (its SIGTERM/SIGHUP handler) while `session/new` runs a hanging agentSpawn
 *   hook: the hook is killed, nothing stays behind, and the server exits promptly.
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { MockSession, createWorld } from './mockSession.js';
import { TestClient, sleep, tmpEnv, until, writeAgent, type Frame, type TmpEnv } from './helpers.js';

const clients: TestClient[] = [];
after(async () => {
  await Promise.allSettled(clients.filter((c) => c.exitCode === undefined).map((c) => c.close(15_000)));
});

/** A pid this test's hook wrote, while it still runs `sleep <SLEEP>` (never another process). */
const SLEEP = '29.4871';
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

/** Sends a request; returns its id and a promise of its response frame. */
function send(c: TestClient, method: string, params: unknown): { id: number; response: Promise<Frame> } {
  const id = 7000 + Math.floor(Math.random() * 1_000_000);
  const response = c.waitFor((f) => f.id === id && f.method === undefined && ('result' in f || 'error' in f), 20_000, `response to ${method}#${id}`, c.frames.length);
  c.send({ jsonrpc: '2.0', id, method, params });
  return { id, response };
}

function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, sleep(ms).then(() => Promise.reject(new Error(`${what}: no answer within ${ms} ms`)))]);
}

/**
 * Agents `crew` and `other`, whose agentSpawn hook (timeout 0) is fast until `slow` exists, then
 * writes its pid to `pidFile` and sleeps for good.
 */
function hookSetup(): { t: TmpEnv; slow: string; pidFile: string; dir: string; c: TestClient } {
  const SCRIPT = { turns: [{ repeat: true, match: 'RECALL', steps: [{ text: 'claude-context: {{historyUserTexts}}' }] }], default: { steps: [{ text: 'ack' }] } };
  const t = tmpEnv({ FAKE_CLAUDE_SCRIPT_JSON: JSON.stringify(SCRIPT), FAKE_CLAUDE_PERSIST: '1' });
  const slow = path.join(t.root, 'slow-hook');
  const pidFile = path.join(t.root, 'hook.pid');
  const cmd = `if [ -f '${slow}' ]; then echo $$ > '${pidFile}'; exec sleep ${SLEEP}; fi; echo spawned`;
  for (const name of ['crew', 'other']) {
    writeAgent(path.join(t.work, '.kiro'), name, { description: `${name} agent`, tools: ['*'], includeMcpJson: false, hooks: { agentSpawn: [{ command: cmd, timeout_ms: 0 }] } });
  }
  const c = new TestClient({ args: ['--agent-engine', 'v2', '--agent', 'crew'], env: t.env, cwd: t.work });
  clients.push(c);
  return { t, slow, pidFile, dir: path.join(t.kiroHome, 'sessions', 'cli'), c };
}

const sessionFiles = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.(json|jsonl|lock)$/.test(f)).sort() : []);

const chunksFrom = (c: TestClient, from: number): string =>
  c.frames
    .slice(from)
    .filter((f) => f.method === 'session/update' && f.params.update.sessionUpdate === 'agent_message_chunk')
    .map((f) => f.params.update.content.text as string)
    .join('');

async function newSession(c: TestClient, t: TmpEnv): Promise<string> {
  await c.initialize();
  const { sessionId } = (await c.call('session/new', { cwd: t.work, mcpServers: [] }, 30_000)) as { sessionId: string };
  await c.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'alpha' }] }, 30_000);
  return sessionId;
}

describe('C3 (verifier): cancelled commands and starts', { skip: process.platform !== 'linux' ? 'needs /proc' : false }, () => {
  test('"/clear" as prompt text, session/cancel while its agentSpawn hook hangs → stopReason cancelled within 2 s (KC-ACP-07); the hook is killed and the conversation kept', async () => {
    const { t, slow, pidFile, c } = hookSetup();
    try {
      const sid = await newSession(c, t);
      fs.writeFileSync(slow, '');
      const { response } = send(c, 'session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: '/clear' }] });
      await until(() => hookRuns(hookPid(pidFile)), 10_000, 'the /clear agentSpawn hook runs');
      c.notify('session/cancel', { sessionId: sid });
      const r = await within(response, 2000, '/clear prompt after session/cancel');
      assert.deepEqual(r.result, { stopReason: 'cancelled' }, `a cancelled /clear prompt answered ${JSON.stringify(r)}`);
      await until(() => !hookRuns(hookPid(pidFile)), 3000, 'the hook is killed');
      assert.deepEqual(c.notifications('_kiro.dev/clear/status'), []);
      fs.rmSync(slow);
      const from = c.frames.length;
      await c.call('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'RECALL' }] }, 30_000);
      assert.match(chunksFrom(c, from), /alpha/, 'the conversation was cleared after all');
    } finally {
      killHook(pidFile);
    }
  });

  test('"/agent swap other" as prompt text, session/cancel while the target\'s agentSpawn hook hangs → stopReason cancelled; still agent crew', async () => {
    const { t, slow, pidFile, c } = hookSetup();
    try {
      const sid = await newSession(c, t);
      fs.writeFileSync(slow, '');
      const { response } = send(c, 'session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: '/agent swap other' }] });
      await until(() => hookRuns(hookPid(pidFile)), 10_000, 'the swap\'s agentSpawn hook runs');
      c.notify('session/cancel', { sessionId: sid });
      const r = await within(response, 2000, '/agent swap prompt after session/cancel');
      assert.deepEqual(r.result, { stopReason: 'cancelled' }, `a cancelled agent swap prompt answered ${JSON.stringify(r)}`);
      await until(() => !hookRuns(hookPid(pidFile)), 3000, 'the hook is killed');
      assert.deepEqual(c.notifications('_kiro.dev/agent/switched'), []);
      fs.rmSync(slow);
      const list = await c.call('_kiro.dev/commands/execute', { sessionId: sid, command: { command: 'agent', args: {} } }, 15_000);
      assert.deepEqual(list.data, { agent: { name: 'crew' } });
    } finally {
      killHook(pidFile);
    }
  });

  test('commands/execute agent swap, session/cancel while the target\'s agentSpawn hook hangs → {success:false} at once, the hook killed, the agent unchanged', async () => {
    const { t, slow, pidFile, c } = hookSetup();
    try {
      const sid = await newSession(c, t);
      fs.writeFileSync(slow, '');
      const { response } = send(c, '_kiro.dev/commands/execute', { sessionId: sid, command: { command: 'agent', args: { value: 'swap other' } } });
      await until(() => hookRuns(hookPid(pidFile)), 10_000, 'the swap\'s agentSpawn hook runs');
      c.notify('session/cancel', { sessionId: sid });
      const r = await within(response, 2000, 'commands/execute agent swap after session/cancel');
      assert.equal(r.result?.success, false, JSON.stringify(r));
      assert.match(String(r.result?.message), /cancelled/i);
      await until(() => !hookRuns(hookPid(pidFile)), 3000, 'the hook is killed');
      assert.deepEqual(c.notifications('_kiro.dev/agent/switched'), []);
      fs.rmSync(slow);
      const list = await c.call('_kiro.dev/commands/execute', { sessionId: sid, command: { command: 'agent', args: {} } }, 15_000);
      assert.deepEqual(list.data, { agent: { name: 'crew' } });
      const p = await c.call('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'RECALL' }] }, 30_000);
      assert.equal(p.stopReason, 'end_turn');
    } finally {
      killHook(pidFile);
    }
  });

  test('session/new withdrawn by its own $/cancel_request while its agentSpawn hook hangs → -32800 at once, the hook killed, no record or lock; the server keeps serving', async () => {
    const { t, slow, pidFile, dir, c } = hookSetup();
    try {
      fs.writeFileSync(slow, '');
      await c.initialize();
      const { id, response } = send(c, 'session/new', { cwd: t.work, mcpServers: [] });
      await until(() => hookRuns(hookPid(pidFile)), 10_000, 'the agentSpawn hook runs');
      c.notify('$/cancel_request', { requestId: id });
      const r = await within(response, 2000, 'session/new after $/cancel_request');
      assert.equal(r.error?.code, -32800, JSON.stringify(r));
      await until(() => !hookRuns(hookPid(pidFile)), 3000, 'the hook is killed');
      assert.deepEqual(sessionFiles(dir), [], 'a withdrawn session/new left files behind');
      fs.rmSync(slow);
      const { sessionId } = (await c.call('session/new', { cwd: t.work, mcpServers: [] }, 30_000)) as { sessionId: string };
      const p = await c.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hi' }] }, 30_000);
      assert.equal(p.stopReason, 'end_turn');
    } finally {
      killHook(pidFile);
    }
  });

  test('the server is stopped (its SIGTERM handler) while session/new runs a hanging agentSpawn hook: the hook is killed, nothing stays behind, it exits promptly', async () => {
    const { t, slow, pidFile, dir, c } = hookSetup();
    try {
      fs.writeFileSync(slow, '');
      await c.initialize();
      // a stopped server closes the connection at once: this request is never answered
      send(c, 'session/new', { cwd: t.work, mcpServers: [] }).response.catch(() => undefined);
      await until(() => hookRuns(hookPid(pidFile)), 10_000, 'the agentSpawn hook runs');
      const t0 = Date.now();
      assert.ok(c.server, 'the server');
      c.server.stop();
      await until(() => !hookRuns(hookPid(pidFile)), 2000, 'the agentSpawn hook is killed when the server stops');
      await within(c.exited, 5000, 'server exit');
      assert.ok(Date.now() - t0 < 5000);
      assert.deepEqual(sessionFiles(dir), [], 'a half-started session left files behind');
    } finally {
      killHook(pidFile);
    }
  });
});

describe('C3 (verifier): the MCP init wait of a command', () => {
  test('commands/execute mcp while a server stays pending (the init poll): session/cancel answers at once; the poll stops and reports nothing later', async () => {
    const t = tmpEnv();
    writeAgent(path.join(t.work, '.kiro'), 'crew', { description: 'crew agent', tools: ['*'], mcpServers: { probe: { command: 'node', args: ['x.js'] } }, includeMcpJson: false });
    const world = createWorld([{ steps: [{ text: 'hello back' }] }]);
    let polls = 0;
    class Counting extends MockSession {
      override async mcpStatus() {
        polls++;
        return super.mcpStatus();
      }
    }
    const c = new TestClient({
      args: ['--agent-engine', 'v2', '--agent', 'crew'],
      env: t.env,
      cwd: t.work,
      timings: { mcpWaitMs: 60_000, mcpPollMs: 20 },
      createSession: async (opts) => {
        world.created.push(opts);
        const s = new Counting(world, opts);
        world.sessions.push(s);
        return s;
      },
    });
    clients.push(c);
    await c.initialize();
    const { sessionId: sid } = (await c.call('session/new', { cwd: t.work, mcpServers: [] })) as { sessionId: string };
    await c.waitFor((f) => f.method === 'session/update' && f.params?.update?.sessionUpdate === 'available_commands_update' && f.params.sessionId === sid, 5000);
    // a server that is (re)starting: pending until the test says otherwise
    world.mcp = [{ name: 'probe', status: 'pending', toolCount: 0 }, { name: 'late', status: 'pending', toolCount: 0 }];
    const { response } = send(c, '_kiro.dev/commands/execute', { sessionId: sid, command: { command: 'mcp', args: {} } });
    const p0 = polls;
    await until(() => polls > p0 + 2, 5000, 'the MCP init poll runs');
    c.notify('session/cancel', { sessionId: sid });
    const r = await within(response, 1000, 'commands/execute mcp (pending) after session/cancel');
    assert.deepEqual(r.result, { success: false, message: 'Command cancelled' });
    const n = c.frames.length;
    const p1 = polls;
    world.mcp = [{ name: 'probe', status: 'connected', toolCount: 1 }, { name: 'late', status: 'connected', toolCount: 2 }];
    await sleep(200);
    assert.ok(polls <= p1 + 1, `the cancelled command kept polling (${polls - p1} more polls)`);
    assert.deepEqual(c.frames.slice(n), [], 'the cancelled MCP wait reported a server later');
    const p = await c.call('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'hi' }] });
    assert.equal(p.stopReason, 'end_turn');
  });
});

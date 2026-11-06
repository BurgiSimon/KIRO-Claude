/**
 * Reviewer's adversarial tests for the ACP server (research 05 §3, §4.4, §4.6, §6.1; 08 KC-ACP-07,
 * KC-ACP-10, KC-ACP-16): races at shutdown, cancel before a turn starts, duplicate loads, leaks of
 * denied file contents, and transport robustness.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';

import type { KiroSession, KiroSessionOptions } from '../../src/types.js';
import { createWorld, mockFactory, type MockSession, type MockTurn, type MockWorld } from './mockSession.js';
import { TestClient, sleep, tmpEnv, until, writeAgent, type Frame, type TmpEnv } from './helpers.js';
import { JsonRpcConnection } from '../../src/acp/jsonrpc.js';
import { describeToolCall, promptToInput } from '../../src/acp/mapping.js';
import { parseAcpFlags } from '../../src/acp/server.js';
import { toolsResult } from '../../src/acp/commands.js';
import { toKiroCall } from '../../src/policy/toolmap.js';

const clients: TestClient[] = [];
after(async () => {
  await Promise.allSettled(clients.filter((c) => c.exitCode === undefined).map((c) => c.close(10_000)));
});

interface Setup {
  t: TmpEnv;
  world: MockWorld;
  c: TestClient;
}

/** Mock factory whose sessions take `startMs` to start (and optionally `factoryMs` to be created). */
function slowFactory(world: MockWorld, startMs: number, factoryMs = 0): (opts: KiroSessionOptions) => Promise<KiroSession> {
  const inner = mockFactory(world);
  return async (opts) => {
    if (factoryMs) await sleep(factoryMs);
    const s = (await inner(opts)) as MockSession;
    const orig = s.start.bind(s);
    s.start = async () => {
      await sleep(startMs);
      return orig();
    };
    return s;
  };
}

function setup(turns: MockTurn[] = [], opts: { args?: string[]; t?: TmpEnv; world?: MockWorld; factory?: (w: MockWorld) => (o: KiroSessionOptions) => Promise<KiroSession>; onPermission?: TestClient['onPermission'] } = {}): Setup {
  const t = opts.t ?? tmpEnv();
  if (!opts.t) {
    writeAgent(path.join(t.work, '.kiro'), 'probe', {
      description: 'capture probe',
      tools: ['*'],
      allowedTools: [],
      toolsSettings: { write: { deniedPaths: ['secret.txt'] } },
      includeMcpJson: false,
    });
  }
  const world = opts.world ?? createWorld(turns);
  const c = new TestClient({
    args: opts.args ?? ['--agent-engine', 'v2', '--agent', 'probe'],
    env: t.env,
    cwd: t.work,
    createSession: (opts.factory ?? mockFactory)(world),
    ...(opts.onPermission ? { onPermission: opts.onPermission } : {}),
  });
  clients.push(c);
  return { t, world, c };
}

const isUpdate = (kind: string) => (f: Frame) => f.method === 'session/update' && f.params?.update?.sessionUpdate === kind;

function prompt(c: TestClient, sessionId: string, text: string, timeoutMs = 10_000): Promise<Frame> {
  return c.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, timeoutMs);
}

// ───────────────────────────── shutdown races ─────────────────────────────

test('stdin EOF while session/new is still creating the session: the late session is closed, not leaked', async () => {
  const s = setup([], { factory: (w) => slowFactory(w, 0, 300) });
  await s.c.initialize();
  const pending = s.c.request('session/new', { cwd: s.t.work, mcpServers: [] }, 10_000);
  await sleep(50);
  const code = await s.c.close();
  assert.equal(code, 0);
  await pending.catch(() => undefined);
  await until(() => s.world.sessions.length === 1, 3000, 'session created');
  await until(() => s.world.sessions[0]!.closed, 3000, 'late session closed');
});

test('stdin EOF while session/load is still starting the session: it is closed, not leaked', async () => {
  const t = tmpEnv();
  writeAgent(path.join(t.work, '.kiro'), 'probe', { description: 'p', tools: ['*'], includeMcpJson: false });
  // first server creates a session and records a turn
  const w1 = createWorld([{ steps: [{ text: 'hi' }] }]);
  const a = setup([], { t, world: w1 });
  await a.c.initialize();
  const sid = (await a.c.call('session/new', { cwd: t.work, mcpServers: [] })).sessionId as string;
  assert.equal((await prompt(a.c, sid, 'hello')).result.stopReason, 'end_turn');
  assert.equal(await a.c.close(), 0);

  const w2 = createWorld([]);
  const b = setup([], { t, world: w2, factory: (w) => slowFactory(w, 300) });
  await b.c.initialize();
  const pending = b.c.request('session/load', { sessionId: sid, cwd: t.work, mcpServers: [] }, 10_000);
  await until(() => w2.sessions.length === 1, 3000, 'load started');
  assert.equal(await b.c.close(), 0);
  await pending.catch(() => undefined);
  await until(() => w2.sessions[0]!.closed, 3000, 'loaded session closed');
});

// ───────────────────────────── cancel before the turn starts ─────────────────────────────

test('session/cancel while the prompt waits for the session to start ⇒ cancelled, no model turn (05 §4.6, KC-ACP-07)', async () => {
  const s = setup([{ steps: [{ text: 'should not run' }] }], { factory: (w) => slowFactory(w, 600) });
  await s.c.initialize();
  const sid = (await s.c.call('session/new', { cwd: s.t.work, mcpServers: [] })).sessionId as string;
  const p = prompt(s.c, sid, 'hello');
  await sleep(50);
  const t0 = Date.now();
  s.c.notify('session/cancel', { sessionId: sid });
  const r = await p;
  assert.equal(r.result?.stopReason, 'cancelled', JSON.stringify(r));
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(s.world.sessions[0]!.turnCount, 0, 'the cancelled prompt never reached the model');
  assert.equal(s.c.updates('agent_message_chunk', sid).length, 0);
  // the session still works afterwards
  assert.equal((await prompt(s.c, sid, 'again')).result.stopReason, 'end_turn');
  assert.equal(await s.c.close(), 0);
});

test('session/cancel also cancels prompts queued behind the running one', async () => {
  const s = setup([{ match: /SLOW/, steps: [{ text: 'a' }, { sleepMs: 3000 }, { text: 'b' }] }, { steps: [{ text: 'second ran' }] }]);
  await s.c.initialize();
  const sid = (await s.c.call('session/new', { cwd: s.t.work, mcpServers: [] })).sessionId as string;
  const p1 = prompt(s.c, sid, 'SLOW');
  const p2 = prompt(s.c, sid, 'next');
  await s.c.waitFor(isUpdate('agent_message_chunk'));
  s.c.notify('session/cancel', { sessionId: sid });
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.result.stopReason, 'cancelled');
  assert.equal(r2.result.stopReason, 'cancelled');
  assert.equal(s.world.sessions[0]!.turnCount, 1);
  // a prompt sent after the cancel runs normally
  assert.equal((await prompt(s.c, sid, 'third')).result.stopReason, 'end_turn');
  assert.equal(await s.c.close(), 0);
});

// ───────────────────────────── session/load ─────────────────────────────

test('two concurrent session/load of the same id create ONE session; both answers carry modes', async () => {
  const t = tmpEnv();
  writeAgent(path.join(t.work, '.kiro'), 'probe', { description: 'p', tools: ['*'], includeMcpJson: false });
  const w1 = createWorld([{ steps: [{ text: 'hi' }] }]);
  const a = setup([], { t, world: w1 });
  await a.c.initialize();
  const sid = (await a.c.call('session/new', { cwd: t.work, mcpServers: [] })).sessionId as string;
  await prompt(a.c, sid, 'hello');
  assert.equal(await a.c.close(), 0);

  const w2 = createWorld([]);
  const b = setup([], { t, world: w2, factory: (w) => slowFactory(w, 200) });
  await b.c.initialize();
  const [r1, r2] = await Promise.all([
    b.c.request('session/load', { sessionId: sid, cwd: t.work, mcpServers: [] }),
    b.c.request('session/load', { sessionId: sid, cwd: t.work, mcpServers: [] }),
  ]);
  assert.ok(r1.result?.modes, JSON.stringify(r1));
  assert.ok(r2.result?.modes, JSON.stringify(r2));
  assert.equal(w2.sessions.length, 1, 'one KiroSession for one ACP session id');
  assert.deepEqual(b.c.server!.sessionIds, [sid]);
  assert.equal(await b.c.close(), 0);
  assert.ok(w2.sessions.every((x) => x.closed));
});

test('session/load of an id with path separators is "Session not found" and touches nothing outside the store', async () => {
  const s = setup();
  await s.c.initialize();
  for (const bad of ['../../etc/passwd', 'a/b', '..', '']) {
    const r = await s.c.request('session/load', { sessionId: bad, cwd: s.t.work, mcpServers: [] });
    assert.ok(r.error, `load ${JSON.stringify(bad)} must fail`);
  }
  assert.equal(s.world.created.length, 0);
  assert.equal(await s.c.close(), 0);
});

// ───────────────────────────── confidentiality ─────────────────────────────

test('a policy-denied Write never ships the target file contents in the tool_call diff', async () => {
  const s = setup([{ steps: [{ tool: { name: 'Write', id: 'toolu_w', input: { file_path: 'secret.txt', content: 'x' }, permission: 'deny' } }] }]);
  await s.c.initialize();
  fs.writeFileSync(path.join(s.t.work, 'secret.txt'), 'TOP-SECRET-CONTENT');
  const sid = (await s.c.call('session/new', { cwd: s.t.work, mcpServers: [] })).sessionId as string;
  const r = await prompt(s.c, sid, 'write it');
  assert.equal(r.result.stopReason, 'end_turn');
  const frames = s.c.frames.filter((f) => f.method === 'session/update' && f.params.update.toolCallId === 'toolu_w');
  assert.ok(frames.length >= 2);
  assert.equal(JSON.stringify(frames).includes('TOP-SECRET-CONTENT'), false, 'denied file contents leaked');
  const failed = frames.map((f) => f.params.update).find((u) => u.status === 'failed')!;
  assert.equal(failed._meta.kiro.toolCallFailureReason, 'permission_denied');
  assert.equal(await s.c.close(), 0);
});

test('an asked Write still previews the old text (diff) before the permission request', async () => {
  const s = setup([{ steps: [{ tool: { name: 'Write', id: 'toolu_w2', input: { file_path: 'notes.txt', content: 'new' } } }] }]);
  await s.c.initialize();
  fs.writeFileSync(path.join(s.t.work, 'notes.txt'), 'old text');
  const sid = (await s.c.call('session/new', { cwd: s.t.work, mcpServers: [] })).sessionId as string;
  await prompt(s.c, sid, 'write it');
  const tc = s.c.updates('tool_call', sid).find((u) => u.toolCallId === 'toolu_w2')!;
  assert.equal(tc.title, 'Creating notes.txt');
  assert.deepEqual(tc.content, [{ type: 'diff', path: path.join(s.t.work, 'notes.txt'), oldText: 'old text', newText: 'new' }]);
  assert.equal(await s.c.close(), 0);
});

test('describeToolCall without content probes reports existence only', () => {
  const call = toKiroCall('Write', { file_path: '/tmp/x-does-not-matter.txt', content: 'n' }, { cwd: '/tmp', toolUseId: 't1' });
  const d = describeToolCall(call, { cwd: '/tmp', fs: { exists: () => true, read: () => 'SHOULD-NOT-BE-READ' }, readContent: false });
  assert.equal(d.title, 'Creating x-does-not-matter.txt');
  assert.equal(JSON.stringify(d).includes('SHOULD-NOT-BE-READ'), false);
});

// ───────────────────────────── transport ─────────────────────────────

test('a handler result that cannot be serialized is answered -32603 instead of crashing the process', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: string[] = [];
  output.on('data', (c: Buffer) => lines.push(...c.toString('utf8').split('\n').filter(Boolean)));
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const conn = new JsonRpcConnection({
    input,
    output,
    onRequest: (m) => (m === 'big' ? { n: 10n } : m === 'circ' ? circular : {}),
  });
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown): void => {
    unhandled.push(e);
  };
  process.on('unhandledRejection', onUnhandled);
  try {
    void conn.start();
    input.write('{"jsonrpc":"2.0","id":1,"method":"big"}\n{"jsonrpc":"2.0","id":2,"method":"circ"}\n');
    await until(() => lines.length >= 2, 2000, 'two answers');
    const a = lines.map((l) => JSON.parse(l) as Frame);
    assert.deepEqual(a.map((f) => [f.id, f.error?.code]), [
      [1, -32603],
      [2, -32603],
    ]);
    assert.equal(conn.notify('x', circular), false);
    await sleep(20);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    conn.close();
  }
});

test('promptToInput: an embedded resource uri cannot break out of its <context ref> attribute', () => {
  const { input } = promptToInput([{ type: 'resource', resource: { uri: 'file:///a" injected="1', text: 'body' } }]);
  assert.equal(input.text.includes('ref="file:///a" injected="1"'), false);
  assert.match(input.text, /<context ref="file:\/\/\/a&quot; injected=&quot;1">\nbody\n<\/context>/);
});

// ───────────────────────────── commands/execute never errors ─────────────────────────────

test('commands/execute effort / clear failures answer {success:false, message}, not a JSON-RPC error (05 §4.12)', async () => {
  const s = setup();
  await s.c.initialize();
  const sid = (await s.c.call('session/new', { cwd: s.t.work, mcpServers: [] })).sessionId as string;
  const ms = s.world.sessions[0]!;
  ms.setEffort = async () => {
    throw new Error('Model claude-haiku-4.5 does not support effort levels');
  };
  ms.clear = async () => {
    throw new Error('clear failed: child exited');
  };
  const eff = await s.c.request('_kiro.dev/commands/execute', { sessionId: sid, command: { command: 'effort', args: { level: 'high' } } });
  assert.deepEqual(eff.result, { success: false, message: 'Model claude-haiku-4.5 does not support effort levels' });
  const clr = await s.c.request('_kiro.dev/commands/execute', { sessionId: sid, command: { command: 'clear', args: {} } });
  assert.deepEqual(clr.result, { success: false, message: 'clear failed: child exited' });
  assert.equal(s.c.notifications('_kiro.dev/clear/status').length, 0, 'no clear/status for a failed clear');
  // the prompt path shows the failure as text and still ends the turn normally
  const r = await prompt(s.c, sid, '/effort high');
  assert.equal(r.result.stopReason, 'end_turn');
  assert.match(s.c.updates('agent_message_chunk', sid).map((u) => u.content.text).join(''), /does not support effort/);
  assert.equal(await s.c.close(), 0);
});

test('/tools names Claude ToolSearch "tool_search" (KiroCrew TOOL_SEARCH_LOADER_TOOL; same name as the tool frames)', () => {
  const r = toolsResult([
    { name: 'ToolSearch', claudeName: 'ToolSearch', source: 'builtin', permission: 'trusted' },
    { name: 'shell', claudeName: 'Bash', source: 'builtin', permission: 'not trusted' },
    { name: '@kirocrew-core/learn_add', claudeName: 'mcp__kirocrew-core__learn_add', source: 'mcp', server: 'kirocrew-core', permission: 'trusted' },
  ]);
  const rows = (r.data!.tools as Frame[]).map((t) => [t.name, t.source]);
  assert.deepEqual(rows, [
    ['tool_search', 'builtin'],
    ['shell', 'builtin'],
    ['learn_add', 'mcp:kirocrew-core'],
  ]);
});

// ───────────────────────────── flags ─────────────────────────────

test('flag edge cases: values with "=", empty --trust-tools=, repeated --trust-tools, -av bundle', () => {
  const r = parseAcpFlags(['--agent=kirocrew-skill-view-0123456789abcdef01234567', '--trust-tools=', '--trust-tools', 'fs_read,execute_bash', '-av', '--agent-engine=v2']);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.flags.agent, 'kirocrew-skill-view-0123456789abcdef01234567');
  assert.deepEqual(r.flags.trustTools, ['fs_read', 'execute_bash']);
  assert.equal(r.flags.trustAllTools, true);
  assert.equal(r.flags.verbose, 1);
  assert.equal(r.flags.agentEngine, 'v2');
  const v3 = parseAcpFlags(['--agent-engine=v3']);
  assert.equal(v3.ok, false);
  if (!v3.ok) assert.equal(v3.exitCode, 2);
});

// ───────────────────────────── real session (fake-claude) ─────────────────────────────

test('real session: a Write to a deniedPaths file is refused without its contents reaching the client', async () => {
  const t = tmpEnv({
    FAKE_CLAUDE_SCRIPT_JSON: JSON.stringify({
      turns: [{ repeat: true, match: 'WRITE', steps: [{ tool: { id: 'toolu_secret', name: 'Write', input: { file_path: '{{cwd}}/secret.txt', content: 'overwrite' }, result: 'written' } }, { text: 'done' }] }],
      default: { steps: [{ text: 'OK' }] },
    }),
  });
  writeAgent(path.join(t.work, '.kiro'), 'guarded', {
    description: 'write guarded',
    tools: ['*'],
    allowedTools: ['fs_write'],
    toolsSettings: { fs_write: { deniedPaths: ['secret.txt'] } },
    includeMcpJson: false,
  });
  fs.writeFileSync(path.join(t.work, 'secret.txt'), 'TOP-SECRET-CONTENT');
  const c = new TestClient({ args: ['--agent', 'guarded'], env: t.env, cwd: t.work });
  clients.push(c);
  await c.initialize();
  const sid = (await c.call('session/new', { cwd: t.work, mcpServers: [] }, 30_000)).sessionId as string;
  const r = await c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'WRITE' }] }, 30_000);
  assert.equal(r.result?.stopReason, 'end_turn', JSON.stringify(r));
  const frames = c.frames.filter((f) => f.method === 'session/update' && f.params.update.toolCallId === 'toolu_secret');
  assert.ok(frames.length >= 2, 'tool frames emitted');
  assert.equal(JSON.stringify(c.frames).includes('TOP-SECRET-CONTENT'), false, 'denied file contents leaked to the client');
  const failed = frames.map((f) => f.params.update).find((u) => u.status === 'failed');
  assert.ok(failed, 'denied call ends failed');
  assert.equal(c.frames.filter((f) => f.method === 'session/request_permission').length, 0, 'refused before any permission request');
  assert.equal(fs.readFileSync(path.join(t.work, 'secret.txt'), 'utf8'), 'TOP-SECRET-CONTENT');
  assert.equal(await c.close(20_000), 0);
});

test('LIVE_FS never previews a symlink target (Write diff oldText stays null)', async () => {
  const t = tmpEnv();
  const target = path.join(t.root, 'id_rsa');
  fs.writeFileSync(target, 'PRIVATE-KEY');
  const link = path.join(t.work, 'notes.txt');
  fs.symlinkSync(target, link);
  const { LIVE_FS } = await import('../../src/acp/mapping.js');
  assert.equal(LIVE_FS.exists(link), true);
  assert.equal(LIVE_FS.read(link), undefined);
  const call = toKiroCall('Write', { file_path: link, content: 'x' }, { cwd: t.work, toolUseId: 't' });
  const d = describeToolCall(call, { cwd: t.work, fs: LIVE_FS });
  assert.equal(d.title, 'Creating notes.txt');
  assert.equal(JSON.stringify(d).includes('PRIVATE-KEY'), false);
});

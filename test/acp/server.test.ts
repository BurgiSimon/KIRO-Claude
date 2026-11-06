/**
 * The ACP server driven by a scripted client over in-memory stdio, with a mock KiroSession
 * (test/acp/mockSession.ts) behind it. Covers the KiroCrew acceptance checklist (05 §9.5 +
 * 08 §2.5 KC-ACP-01…22 / scenarios S1–S13), the 05 §10 worked example and error paths.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { createWorld, mockFactory, type MockTurn, type MockWorld } from './mockSession.js';
import { TestClient, sleep, tmpEnv, until, writeAgent, type Frame, type TmpEnv } from './helpers.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface Setup {
  t: TmpEnv;
  world: MockWorld;
  c: TestClient;
}

function probeSpec(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    description: 'capture probe',
    tools: ['*'],
    allowedTools: ['@probe/probe_codeword'],
    mcpServers: { probe: { command: 'node', args: ['probe-server.js'] } },
    includeMcpJson: false,
    ...extra,
  };
}

const clients: TestClient[] = [];
after(async () => {
  await Promise.allSettled(clients.filter((c) => c.exitCode === undefined).map((c) => c.close(10_000)));
});

function setup(turns: MockTurn[] = [], opts: { args?: string[]; t?: TmpEnv; world?: MockWorld; onPermission?: TestClient['onPermission']; timings?: Record<string, number> } = {}): Setup {
  const t = opts.t ?? tmpEnv({ KIRO_API_KEY: 'kiro-secret' });
  if (!opts.t) {
    writeAgent(path.join(t.work, '.kiro'), 'probe', probeSpec());
    writeAgent(t.kiroHome, 'other', { description: 'another agent', tools: ['*'] });
    writeAgent(t.kiroHome, 'probe-zero', { description: 'capture probe with no tools', tools: [] });
  }
  const world = opts.world ?? createWorld(turns);
  const c = new TestClient({
    args: opts.args ?? ['--agent-engine', 'v2', '--agent', 'probe'],
    env: t.env,
    cwd: t.work,
    createSession: mockFactory(world),
    ...(opts.onPermission ? { onPermission: opts.onPermission } : {}),
    ...(opts.timings ? { timings: opts.timings } : {}),
  });
  clients.push(c);
  return { t, world, c };
}

async function newSession(s: Setup, params: Record<string, unknown> = {}): Promise<string> {
  await s.c.initialize();
  const r = await s.c.call('session/new', { cwd: s.t.work, mcpServers: [], ...params });
  return r.sessionId as string;
}

function prompt(c: TestClient, sessionId: string, text: string, timeoutMs = 10_000): Promise<Frame> {
  return c.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, timeoutMs);
}

function respIndex(c: TestClient, r: Frame): number {
  return c.frames.indexOf(r);
}

function idx(c: TestClient, pred: (f: Frame) => boolean): number {
  return c.frames.findIndex(pred);
}

const isUpdate = (kind: string) => (f: Frame) => f.method === 'session/update' && f.params?.update?.sessionUpdate === kind;

async function done(s: Setup): Promise<void> {
  const code = await s.c.close();
  assert.equal(code, 0);
  assert.deepEqual(s.c.nonJson, [], 'stdout carries only JSON-RPC frames');
}

// ───────────────────────────── S1 ─────────────────────────────

test('S1 initialize: KiroCrew string protocolVersion and Zed integer both answer 1; static capabilities; compat version', async () => {
  const s = setup();
  const r = await s.c.initialize();
  assert.deepEqual(r, {
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true, audio: false, embeddedContext: true },
      mcpCapabilities: { http: true, sse: true },
      sessionCapabilities: { list: {}, close: {} },
    },
    authMethods: [],
    agentInfo: { name: 'kiro-claude', title: 'kiro-claude 0.1.0 (Claude Code)', version: '1.26.0' },
  });
  assert.equal(JSON.stringify(r).includes('extensionMethods'), false);
  const z = await s.c.call('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true } });
  assert.equal(z.protocolVersion, 1);
  assert.deepEqual(await s.c.call('authenticate', { methodId: 'x' }), {});
  assert.equal(s.world.created.length, 0, 'initialize never spawns');
  await done(s);
});

test('S1 session/new: modes with --agent current, models, eager spawn, MCP reports after the response, metadata, commands', async () => {
  const s = setup();
  await s.c.initialize();
  const resp = await s.c.request('session/new', {
    cwd: s.t.work,
    mcpServers: [{ name: 'gw-stub', command: '/venv/bin/kirocrew', args: ['mcp-core'], env: [{ name: 'KIROCREW_STUB_SESSION_TOKEN', value: 'tok-1' }], type: 'stdio' }],
  });
  const r = resp.result;
  assert.match(r.sessionId, UUID_RE);
  assert.equal(r.modes.currentModeId, 'probe');
  const ids = r.modes.availableModes.map((m: Frame) => m.id);
  for (const id of ['probe', 'other', 'probe-zero', 'kiro_default']) assert.ok(ids.includes(id), id);
  assert.deepEqual(r.modes.availableModes.find((m: Frame) => m.id === 'probe'), { id: 'probe', name: 'probe', description: 'capture probe' });
  assert.equal(r.models.currentModelId, 'auto');
  assert.ok(r.models.availableModels.some((m: Frame) => m.modelId === 'auto'));
  assert.ok(r.models.availableModels.some((m: Frame) => m.modelId === 'claude-haiku-5.5'));
  assert.ok(Array.isArray(r.configOptions));

  const opts = s.world.created[0]!;
  assert.equal(opts.origin, 'acp');
  assert.equal(opts.interactive, true);
  assert.equal(opts.agentName, 'probe');
  assert.equal(opts.ws.cwd, s.t.work);
  assert.deepEqual(opts.extraMcpServers!.map((m) => [m.name, m.type, m.command, m.args, m.env]), [['gw-stub', 'stdio', '/venv/bin/kirocrew', ['mcp-core'], { KIROCREW_STUB_SESSION_TOKEN: 'tok-1' }]]);
  assert.equal(opts.env!.KIRO_API_KEY, undefined, 'KIRO_API_KEY never reaches Claude');
  assert.equal(opts.env!.HOME, s.t.home);
  assert.ok(s.world.calls.includes('start'), 'eager spawn at session/new');

  const sid = r.sessionId;
  const init1 = await s.c.waitFor((f) => f.method === '_kiro.dev/mcp/server_initialized' && f.params.serverName === 'probe');
  const init2 = await s.c.waitFor((f) => f.method === '_kiro.dev/mcp/server_initialized' && f.params.serverName === 'gw-stub');
  assert.deepEqual(init1.params, { sessionId: sid, serverName: 'probe' });
  assert.ok(respIndex(s.c, init1) > respIndex(s.c, resp) && respIndex(s.c, init2) > respIndex(s.c, resp), 'MCP reports follow the response');
  const meta = await s.c.waitFor((f) => f.method === '_kiro.dev/metadata');
  assert.deepEqual(meta.params, { sessionId: sid, contextUsagePercentage: 0 });
  assert.ok(respIndex(s.c, meta) > respIndex(s.c, init2));
  const cmds = await s.c.waitFor(isUpdate('available_commands_update'));
  const names = cmds.params.update.availableCommands.map((x: Frame) => x.name);
  for (const n of ['compact', 'clear', 'help', 'model', 'agent', 'effort', 'tools', 'mcp']) assert.ok(names.includes(n), n);
  assert.ok(fs.existsSync(path.join(s.t.kiroHome, 'sessions', 'cli', `${sid}.json`)), 'session file written by the session module');
  await done(s);
});

test('session/new: missing or broken --agent spec is an error naming the file, never a silent fallback (08 KC-ACP-02)', async () => {
  const t = tmpEnv();
  fs.mkdirSync(path.join(t.work, '.kiro', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(t.work, '.kiro', 'agents', 'broken.json'), '{ "name": "broken", "tools": [');
  const s1 = setup([], { t, args: ['--agent', 'nope'] });
  await s1.c.initialize();
  const r1 = await s1.c.request('session/new', { cwd: t.work, mcpServers: [] });
  assert.equal(r1.error.code, -32603);
  assert.match(r1.error.data, /^Agent 'nope' not found: no .*\.kiro\/agents\/nope\.json or .*\/agents\/nope\.json/);
  assert.equal(s1.world.created.length, 0);
  await done(s1);
  const s2 = setup([], { t, args: ['--agent', 'broken'] });
  await s2.c.initialize();
  const r2 = await s2.c.request('session/new', { cwd: t.work, mcpServers: [] });
  assert.equal(r2.error.code, -32603);
  assert.match(r2.error.data, /^Failed to load agent 'broken' from .*broken\.json/);
  await done(s2);
});

test('session/new without --agent uses chat.defaultAgent, else kiro_default; _meta.kiro overrides; bad cwd', async () => {
  const s = setup([], { args: [] });
  await s.c.initialize();
  const a = await s.c.call('session/new', { cwd: s.t.work, mcpServers: [] });
  assert.equal(a.modes.currentModeId, 'kiro_default');
  fs.mkdirSync(path.join(s.t.kiroHome, 'settings'), { recursive: true });
  fs.writeFileSync(path.join(s.t.kiroHome, 'settings', 'cli.json'), JSON.stringify({ 'chat.defaultAgent': 'other' }));
  const b = await s.c.call('session/new', { cwd: s.t.work, mcpServers: [] });
  assert.equal(b.modes.currentModeId, 'other');
  const c = await s.c.call('session/new', { cwd: s.t.work, mcpServers: [], _meta: { kiro: { modeId: 'probe', modelId: 'claude-haiku-5.5', effortLevel: 'high' } } });
  assert.equal(c.modes.currentModeId, 'probe');
  assert.equal(c.models.currentModelId, 'claude-haiku-5.5');
  assert.equal(s.world.created[2]!.effort, 'high');
  // missing mcpServers is tolerated (kiro-cli exits; we are lenient, 05 §4.3)
  const d = await s.c.call('session/new', { cwd: s.t.work });
  assert.match(d.sessionId, UUID_RE);
  for (const cwd of ['relative/dir', '', path.join(s.t.root, 'missing')]) {
    const e = await s.c.request('session/new', { cwd, mcpServers: [] });
    assert.equal(e.error.code, -32602, cwd);
  }
  const f = await s.c.request('session/new', { cwd: s.t.work, mcpServers: 'nope' });
  assert.equal(f.error.code, -32602);
  await done(s);
});

test('launch flags reach every session: --model, --effort, --trust-all-tools, --trust-tools', async () => {
  const s = setup([], { args: ['--agent', 'probe', '--model', 'claude-haiku-5.5', '--effort', 'high', '-a', '--trust-tools', 'fs_read,execute_bash'] });
  const sid = await newSession(s);
  const o = s.world.created[0]!;
  assert.equal(o.model, 'claude-haiku-5.5');
  assert.equal(o.effort, 'high');
  assert.equal(o.trustAllTools, true);
  assert.deepEqual(o.trustTools, ['fs_read', 'execute_bash']);
  const r = await s.c.call('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'hi' }] });
  assert.equal(r.stopReason, 'end_turn');
  await done(s);
});

// ───────────────────────────── S2 ─────────────────────────────

test('S2 set_mode: same id ⇒ {} + current_mode_update before the response; switch ⇒ swap + agent/switched; unknown ⇒ Mode not found', async () => {
  const s = setup();
  const sid = await newSession(s);
  const r1 = await s.c.request('session/set_mode', { sessionId: sid, modeId: 'probe' });
  assert.deepEqual(r1.result, {});
  const cmu = idx(s.c, (f) => isUpdate('current_mode_update')(f) && f.params.update.currentModeId === 'probe');
  assert.ok(cmu >= 0 && cmu < respIndex(s.c, r1));
  assert.equal(s.world.calls.filter((x) => x.startsWith('swapAgent')).length, 0);

  const r2 = await s.c.request('session/set_mode', { sessionId: sid, modeId: 'other' });
  assert.deepEqual(r2.result, {});
  assert.ok(s.world.calls.includes('swapAgent:other'));
  const sw = s.c.notifications('_kiro.dev/agent/switched');
  assert.deepEqual(sw.map((f) => f.params), [{ sessionId: sid, agentName: 'other' }]);
  assert.ok(respIndex(s.c, sw[0]!) < respIndex(s.c, r2));
  await s.c.waitFor((f) => isUpdate('available_commands_update')(f), 2000, 'commands', respIndex(s.c, r2));

  const r3 = await s.c.request('session/set_mode', { sessionId: sid, modeId: 'ghost' });
  assert.deepEqual(r3.error, { code: -32603, message: 'Internal error', data: "Mode 'ghost' not found" });
  const r4 = await s.c.request('session/set_mode', { sessionId: sid });
  assert.equal(r4.error.code, -32602);
  await done(s);
});

test('S2 commands/execute mcp and tools: the data shapes KiroCrew reads (08 KC-ACP-05)', async () => {
  const s = setup();
  const sid = await newSession(s, { mcpServers: [{ name: 'gw-stub', command: 'x', args: [], env: [] }] });
  const mcp = await s.c.call('_kiro.dev/commands/execute', { sessionId: sid, command: { command: 'mcp', args: {} } });
  assert.equal(mcp.success, true);
  assert.match(mcp.message, /^2 MCP servers/);
  assert.deepEqual(mcp.data, { servers: [{ name: 'probe', status: 'running', toolCount: 1 }, { name: 'gw-stub', status: 'running', toolCount: 1 }] });
  const tools = await s.c.call('_kiro.dev/commands/execute', { sessionId: sid, command: { command: 'tools', args: {} } });
  assert.equal(tools.success, true);
  assert.match(tools.message, /^4 tools/);
  assert.deepEqual(
    tools.data.tools.map((x: Frame) => [x.name, x.source]),
    [
      ['read', 'builtin'],
      ['shell', 'builtin'],
      ['do_thing', 'mcp:probe'],
      ['do_thing', 'mcp:gw-stub'],
    ],
  );
  // status mapping
  s.world.mcp = [
    { name: 'a', status: 'connected', toolCount: 3 },
    { name: 'b', status: 'needs-auth' },
    { name: 'c', status: 'failed', error: 'spawn ENOENT' },
    { name: 'd', status: 'disabled' },
  ];
  const m2 = await s.c.call('_kiro.dev/commands/execute', { sessionId: sid, command: { command: 'mcp', args: {} } });
  assert.deepEqual(
    m2.data.servers.map((x: Frame) => [x.name, x.status]),
    [
      ['a', 'running'],
      ['b', 'failed'],
      ['c', 'failed'],
      ['d', 'disabled'],
    ],
  );
  const fails = s.c.notifications('_kiro.dev/mcp/server_init_failure').map((f) => f.params);
  assert.deepEqual(fails, [
    { sessionId: sid, serverName: 'b', error: 'needs authentication; run `claude mcp` to authenticate' },
    { sessionId: sid, serverName: 'c', error: 'spawn ENOENT' },
  ]);
  await done(s);
});

test('MCP servers still pending are reported once they connect (polling)', async () => {
  const world = createWorld();
  world.mcp = [{ name: 'slow', status: 'pending' }];
  const s = setup([], { world });
  const sid = await newSession(s);
  await sleep(50);
  assert.equal(s.c.notifications('_kiro.dev/mcp/server_initialized').length, 0);
  world.mcp = [{ name: 'slow', status: 'connected', toolCount: 2 }];
  const n = await s.c.waitFor((f) => f.method === '_kiro.dev/mcp/server_initialized');
  assert.deepEqual(n.params, { sessionId: sid, serverName: 'slow' });
  await s.c.waitFor((f) => f.method === '_kiro.dev/metadata');
  await done(s);
});

// ───────────────────────────── S3 / worked example ─────────────────────────────

test('S3 prompt: 45 KB preamble verbatim, chunks, metadata + usage_update before end_turn with usage', async () => {
  const s = setup([{ match: /PING/, steps: [{ text: 'PONG', chunks: ['PO', 'NG'] }] }]);
  const sid = await newSession(s);
  await s.c.waitFor((f) => f.method === '_kiro.dev/metadata');
  const text = `[AGENT SYSTEM PROMPT]\n${'x'.repeat(45_000)}\n[END AGENT SYSTEM PROMPT]\nPING`;
  const before = s.c.frames.length;
  const r = await prompt(s.c, sid, text);
  assert.deepEqual(r.result, { stopReason: 'end_turn', usage: { totalTokens: 370, inputTokens: 10, outputTokens: 20, cachedReadTokens: 300, cachedWriteTokens: 40 } });
  const after = s.c.frames.slice(before, respIndex(s.c, r));
  assert.deepEqual(
    after.filter(isUpdate('agent_message_chunk')).map((f) => f.params.update.content),
    [
      { type: 'text', text: 'PO' },
      { type: 'text', text: 'NG' },
    ],
  );
  const meta = after.find((f) => f.method === '_kiro.dev/metadata')!;
  assert.equal(meta.params.sessionId, sid);
  assert.equal(meta.params.contextUsagePercentage, 0.5);
  assert.equal(typeof meta.params.turnDurationMs, 'number');
  assert.equal('meteringUsage' in meta.params, false, 'no credit metering');
  const uu = after.find(isUpdate('usage_update'))!;
  assert.deepEqual(uu.params.update, { sessionUpdate: 'usage_update', used: 1000, size: 200_000 });
  assert.ok(after.indexOf(meta) > after.indexOf(after.filter(isUpdate('agent_message_chunk'))[1]!));
  // what the session got
  assert.equal(s.world.sessions[0]!.turnCount, 1);
  const journal = fs.readFileSync(path.join(s.t.kiroHome, 'sessions', 'cli', `${sid}.jsonl`), 'utf8');
  assert.ok(journal.includes('"kind":"Prompt"') && journal.includes('"kind":"AssistantMessage"'));
  assert.ok(journal.includes('x'.repeat(1000)));
  await done(s);
});

test('05 §10 worked example: frame order for a shell tool with an allow_once permission', async () => {
  const s = setup([
    {
      match: /run echo hi/,
      steps: [{ tool: { name: 'Bash', id: 'toolu_01A', input: { command: 'echo hi', description: 'Print hi' }, result: 'hi', response: { stdout: 'hi\n', stderr: '' } } }, { text: 'It printed `hi`.' }],
    },
  ]);
  const sid = await newSession(s);
  await s.c.waitFor((f) => f.method === '_kiro.dev/metadata');
  const start = s.c.frames.length;
  const r = await prompt(s.c, sid, 'run echo hi');
  const seq = s.c.frames.slice(start, respIndex(s.c, r) + 1).map((f) => (f.method === 'session/update' ? `update:${f.params.update.sessionUpdate}${f.params.update.status ? `:${f.params.update.status}` : ''}` : f.method ?? 'response'));
  assert.deepEqual(seq, [
    'update:tool_call:pending',
    'session/request_permission',
    'update:tool_call_update:in_progress',
    'update:tool_call_update',
    'update:tool_call_update:completed',
    'update:agent_message_chunk',
    '_kiro.dev/metadata',
    'update:usage_update',
    'response',
  ]);
  const frames = s.c.frames.slice(start);
  const tc = frames.find(isUpdate('tool_call'))!.params.update;
  assert.deepEqual(tc, {
    sessionUpdate: 'tool_call',
    toolCallId: 'toolu_01A',
    title: 'Running: echo hi',
    kind: 'execute',
    status: 'pending',
    rawInput: { __tool_use_purpose: 'Print hi', command: 'echo hi', description: 'Print hi' },
    _meta: { kiro: { toolName: 'shell' }, claudeCode: { toolName: 'Bash' } },
  });
  const perm = frames.find((f) => f.method === 'session/request_permission')!;
  assert.match(perm.id, UUID_RE, 'agent → client ids are UUID strings');
  assert.deepEqual(perm.params.toolCall, { toolCallId: 'toolu_01A', title: 'Running: echo hi', rawInput: tc.rawInput });
  assert.deepEqual(perm.params.options, [
    { optionId: 'allow_once', name: 'Yes', kind: 'allow_once' },
    { optionId: 'allow_always', name: 'Always', kind: 'allow_always' },
    { optionId: 'reject_once', name: 'No', kind: 'reject_once' },
  ]);
  assert.equal(perm.params.sessionId, sid);
  assert.equal(perm.params._meta.trustOptions[0].label, 'Full command');
  const done1 = frames.find((f) => isUpdate('tool_call_update')(f) && f.params.update.status === 'completed')!.params.update;
  assert.deepEqual(done1.rawOutput, { items: [{ Json: { exit_status: 'exit status: 0', stdout: 'hi\n', stderr: '' } }] });
  assert.equal(r.result.stopReason, 'end_turn');
  await done(s);
});

// ───────────────────────────── S4 ─────────────────────────────

test('S4r reject_once ⇒ failed update with toolCallFailureReason permission_denied; the tool never runs', async () => {
  const s = setup([{ match: /RUN-ECHO/, steps: [{ tool: { name: 'Bash', id: 'toolu_r', input: { command: 'echo kc-e2e' }, result: 'SHOULD-NOT-RUN' } }, { text: 'done' }] }], {
    onPermission: () => ({ outcome: { outcome: 'selected', optionId: 'reject_once' } }),
  });
  const sid = await newSession(s);
  const r = await prompt(s.c, sid, 'RUN-ECHO');
  assert.equal(r.result.stopReason, 'end_turn');
  const ups = s.c.updates(undefined, sid).filter((u) => u.toolCallId === 'toolu_r');
  assert.equal(ups[0]!.sessionUpdate, 'tool_call');
  assert.deepEqual(ups[ups.length - 1], {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'toolu_r',
    kind: 'execute',
    status: 'failed',
    title: 'shell',
    content: [{ type: 'content', content: { type: 'text', text: 'User denied tool execution' } }],
    rawInput: { command: 'echo kc-e2e' },
    _meta: { kiro: { toolName: 'shell', toolCallFailureReason: 'permission_denied' }, claudeCode: { toolName: 'Bash' } },
  });
  assert.equal(ups.some((u) => u.status === 'in_progress' || u.status === 'completed'), false);
  assert.equal(JSON.stringify(s.c.frames).includes('SHOULD-NOT-RUN'), false);
  await done(s);
});

test('S4b allowedTools (@probe/probe_codeword) runs with no permission request; MCP identity meta', async () => {
  const s = setup([
    { match: /codeword/, steps: [{ tool: { name: 'mcp__probe__probe_codeword', id: 'toolu_mcp', input: {}, result: 'tangerine-42', response: [{ type: 'text', text: 'tangerine-42' }] } }, { text: 'tangerine-42' }] },
  ]);
  const sid = await newSession(s);
  const r = await prompt(s.c, sid, 'what is the codeword');
  assert.equal(r.result.stopReason, 'end_turn');
  assert.equal(s.c.frames.filter((f) => f.method === 'session/request_permission').length, 0);
  const tc = s.c.updates('tool_call', sid)[0]!;
  assert.equal(tc.title, 'Running: @probe/probe_codeword');
  assert.equal('kind' in tc, false);
  assert.deepEqual(tc._meta.kiro, { toolName: 'probe_codeword', mcpServerName: 'probe' });
  const fin = s.c.updates('tool_call_update', sid).find((u) => u.status === 'completed')!;
  assert.equal(fin.kind, 'other');
  assert.deepEqual(fin.rawOutput, { items: [{ Json: { content: [{ type: 'text', text: 'tangerine-42' }] } }] });
  await done(s);
});

test('allow_always trusts the tool for the rest of the session (one request for two calls)', async () => {
  const s = setup(
    [{ steps: [{ tool: { name: 'Bash', id: 't1', input: { command: 'ls' } } }, { tool: { name: 'Bash', id: 't2', input: { command: 'pwd' } } }, { text: 'ok' }] }],
    { onPermission: () => ({ outcome: { outcome: 'selected', optionId: 'allow_always' } }) },
  );
  const sid = await newSession(s);
  await prompt(s.c, sid, 'go');
  assert.equal(s.c.frames.filter((f) => f.method === 'session/request_permission').length, 1);
  assert.deepEqual(s.world.sessions[0]!.trust.allowedTools, ['execute_bash']);
  assert.equal(s.c.updates('tool_call_update', sid).filter((u) => u.status === 'completed').length, 2);
  await done(s);
});

test('permission answered cancelled / malformed / with an error ⇒ denial frames', async () => {
  const answers: unknown[] = [{ outcome: { outcome: 'selected', optionId: 'weird' } }, { nope: true }];
  const s = setup([{ steps: [{ tool: { name: 'Bash', id: 'a', input: { command: 'x' } } }, { tool: { name: 'Bash', id: 'b', input: { command: 'y' } } }, { tool: { name: 'Bash', id: 'c', input: { command: 'z' } } }, { text: 'end' }] }], {
    onPermission: (req) => {
      const a = answers.shift();
      if (a === undefined) {
        s.c.send({ jsonrpc: '2.0', id: req.id, error: { code: -32603, message: 'client failure' } });
        return undefined;
      }
      return a;
    },
  });
  const sid = await newSession(s);
  const r = await prompt(s.c, sid, 'go');
  assert.equal(r.result.stopReason, 'end_turn');
  const failed = s.c.updates('tool_call_update', sid).filter((u) => u.status === 'failed');
  assert.deepEqual(
    failed.map((u) => [u.toolCallId, u.content[0].content.text, u._meta.kiro.toolCallFailureReason]),
    [
      ['a', 'Permission request failed', 'permission_denied'],
      ['b', 'Permission request failed', 'permission_denied'],
      ['c', 'Permission request failed', 'permission_denied'],
    ],
  );
  await done(s);

  const s2 = setup([{ steps: [{ tool: { name: 'Bash', id: 'k', input: { command: 'x' } } }, { text: 'never' }] }], { onPermission: () => ({ outcome: { outcome: 'cancelled' } }) });
  const sid2 = await newSession(s2);
  const r2 = await prompt(s2.c, sid2, 'go');
  assert.equal(r2.result.stopReason, 'cancelled');
  const f2 = s2.c.updates('tool_call_update', sid2).find((u) => u.status === 'failed')!;
  assert.equal(f2._meta.kiro.toolCallFailureReason, 'permission_denied');
  assert.equal(f2.content[0].content.text, 'Cancelled by user');
  await done(s2);
});

test('policy denial (tool_denied) ⇒ failed frame with the reason', async () => {
  const s = setup([{ steps: [{ tool: { name: 'Read', id: 'd1', input: { file_path: '/etc/shadow' }, permission: 'deny' } }, { text: 'blocked' }] }]);
  const sid = await newSession(s);
  await prompt(s.c, sid, 'read it');
  const f = s.c.updates('tool_call_update', sid).find((u) => u.toolCallId === 'd1')!;
  assert.equal(f.status, 'failed');
  assert.equal(f.title, 'read');
  assert.equal(f.content[0].content.text, 'Tool use denied by agent policy');
  assert.equal(s.c.frames.filter((x) => x.method === 'session/request_permission').length, 0);
  await done(s);
});

// ───────────────────────────── S5 ─────────────────────────────

test('S5 set_model, bogus model, effort, unknown command (08 KC-ACP-05/08)', async () => {
  const s = setup();
  const sid = await newSession(s);
  const r1 = await s.c.request('session/set_model', { sessionId: sid, modelId: 'claude-haiku-5.5' });
  assert.deepEqual(r1.result, {});
  assert.ok(s.world.calls.includes('setModel:claude-haiku-5.5'));
  const cou = s.c.updates('config_option_update', sid).pop()!;
  assert.equal(cou.configOptions[0].currentValue, 'claude-haiku-5.5');
  const r2 = await s.c.request('session/set_model', { sessionId: sid, modelId: 'bogus' });
  assert.equal(r2.error.code, -32602);
  assert.match(r2.error.message, /Invalid model ID: bogus/);
  assert.deepEqual(await s.c.call('session/set_model', { sessionId: sid, modelId: 'auto' }), {});
  assert.deepEqual(await s.c.call('_kiro.dev/commands/execute', { sessionId: sid, command: { command: 'effort', args: { level: 'high' } } }), { success: true, message: 'Effort set to high' });
  assert.ok(s.world.calls.includes('setEffort:high'));
  assert.deepEqual(await s.c.call('_kiro.dev/commands/execute', { sessionId: sid, command: '/effort max' }), { success: true, message: 'Effort set to max' });
  const bad = await s.c.call('_kiro.dev/commands/execute', { sessionId: sid, command: { command: 'effort', args: { level: 'turbo' } } });
  assert.equal(bad.success, false);
  assert.match(bad.message, /Invalid effort level: turbo/);
  assert.deepEqual(await s.c.call('_kiro.dev/commands/execute', { sessionId: sid, command: { command: 'foo', args: {} } }), { success: false, message: 'Unknown command: /foo' });
  await done(s);
});

test('commands/execute clear, model, agent, help, context, usage', async () => {
  const s = setup();
  const sid = await newSession(s);
  const ex = (command: unknown) => s.c.call('_kiro.dev/commands/execute', { sessionId: sid, command });
  const clear = await ex({ command: 'clear', args: {} });
  assert.equal(clear.success, true);
  assert.ok(s.world.calls.includes('clear'));
  assert.deepEqual(s.c.notifications('_kiro.dev/clear/status').map((f) => f.params), [{ sessionId: sid, status: 'completed' }]);
  const list = await ex({ command: 'model', args: {} });
  assert.match(list.message, /^Current model: auto\n/);
  const set = await ex({ command: 'model', args: { value: 'claude-opus-5.5' } });
  assert.deepEqual(set, { success: true, message: 'Model set to claude-opus-5.5', data: { model: { id: 'claude-opus-5.5' } } });
  assert.equal((await ex({ command: 'model', args: { value: 'nah' } })).success, false);
  const ag = await ex({ command: 'agent', args: { value: 'swap other' } });
  assert.deepEqual(ag.data, { agent: { name: 'other' } });
  assert.ok(s.world.calls.includes('swapAgent:other'));
  const ag2 = await ex({ command: 'agent', args: {} });
  assert.deepEqual(ag2.data, { agent: { name: 'other' } });
  assert.match(ag2.message, /\* other/);
  assert.equal((await ex({ command: 'agent', args: { value: 'ghost' } })).success, false);
  assert.match((await ex({ command: 'help', args: {} })).message, /\/compact/);
  assert.match((await ex({ command: 'context', args: {} })).message, /Context files/);
  assert.match((await ex({ command: 'usage', args: {} })).message, /Model: claude-opus-5.5/);
  const opts = await s.c.call('_kiro.dev/commands/options', { sessionId: sid, partial: '/co' });
  assert.deepEqual(opts.options.map((o: Frame) => o.name), ['compact', 'context']);
  await done(s);
});

test('set_config_option: model, effortLevel, mode; unknown ⇒ -32602', async () => {
  const s = setup();
  const sid = await newSession(s);
  const a = await s.c.call('session/set_config_option', { sessionId: sid, configId: 'effortLevel', value: 'max' });
  assert.equal(a.configOptions[1].currentValue, 'max');
  const b = await s.c.call('session/set_config_option', { sessionId: sid, configId: 'model', value: 'claude-sonnet-5.5' });
  assert.equal(b.configOptions[0].currentValue, 'claude-sonnet-5.5');
  await s.c.call('session/set_config_option', { sessionId: sid, configId: 'mode', value: 'other' });
  assert.ok(s.world.calls.includes('swapAgent:other'));
  assert.equal((await s.c.request('session/set_config_option', { sessionId: sid, configId: 'colour', value: 'x' })).error.code, -32602);
  assert.equal((await s.c.request('session/set_config_option', { sessionId: sid, configId: 'effort', value: 'ultra' })).error.code, -32602);
  await done(s);
});

// ───────────────────────────── S6 ─────────────────────────────

test('S6 /compact: chunk, end_turn, then started → completed{summary}, then metadata; a prompt sent meanwhile waits', async () => {
  const s = setup([{ match: /PING/, steps: [{ text: 'PONG' }] }]);
  const sid = await newSession(s);
  await prompt(s.c, sid, 'remember cobalt');
  const start = s.c.frames.length;
  const r = await prompt(s.c, sid, '/compact');
  const ping = prompt(s.c, sid, 'PING');
  assert.deepEqual(r.result, { stopReason: 'end_turn' });
  const chunk = idx(s.c, (f) => s.c.frames.indexOf(f) >= start && isUpdate('agent_message_chunk')(f));
  assert.deepEqual(s.c.frames[chunk]!.params.update.content, { type: 'text', text: 'Compacting conversation...\n' });
  assert.ok(chunk < respIndex(s.c, r));
  const started = await s.c.waitFor((f) => f.method === '_kiro.dev/compaction/status' && f.params.status.type === 'started');
  const completed = await s.c.waitFor((f) => f.method === '_kiro.dev/compaction/status' && f.params.status.type === 'completed');
  assert.ok(respIndex(s.c, started) > respIndex(s.c, r), 'statuses follow the response (kiro-cli order)');
  assert.deepEqual(started.params, { sessionId: sid, status: { type: 'started' }, summary: null });
  assert.equal(completed.params.summary, 'remember cobalt');
  const meta = await s.c.waitFor((f) => f.method === '_kiro.dev/metadata' && s.c.frames.indexOf(f) > s.c.frames.indexOf(completed));
  assert.deepEqual(meta.params, { sessionId: sid, contextUsagePercentage: 1 });
  const pr = await ping;
  assert.ok(respIndex(s.c, pr) > s.c.frames.indexOf(meta), 'queued behind the compaction');
  assert.ok(s.world.calls.includes('compact'));
  // instructions are passed through
  await prompt(s.c, sid, '/compact keep the code words');
  await s.c.waitFor((f) => f.method === '_kiro.dev/compaction/status' && f.params.status.type === 'completed' && s.c.frames.indexOf(f) > s.c.frames.indexOf(completed));
  assert.ok(s.world.calls.includes('compact:keep the code words'));
  await done(s);
});

test('auto-compaction inside a turn ⇒ compaction/status started/completed with the summary', async () => {
  const s = setup([{ steps: [{ compaction: true }, { text: 'after' }] }]);
  const sid = await newSession(s);
  const r = await prompt(s.c, sid, 'go');
  const st = s.c.notifications('_kiro.dev/compaction/status');
  assert.deepEqual(
    st.map((f) => [f.params.status.type, f.params.summary]),
    [
      ['started', null],
      ['completed', 'auto summary'],
    ],
  );
  assert.ok(respIndex(s.c, st[1]!) < respIndex(s.c, r));
  await done(s);
});

// ───────────────────────────── S7 ─────────────────────────────

test('S7 session/cancel ⇒ stopReason cancelled within 2 s', async () => {
  const s = setup([{ steps: [{ text: 'thinking...' }, { sleepMs: 8000 }, { text: 'too late' }] }]);
  const sid = await newSession(s);
  const p = prompt(s.c, sid, 'slow');
  await s.c.waitFor((f) => isUpdate('agent_message_chunk')(f) && f.params.update.content.text === 'thinking...');
  const t0 = Date.now();
  s.c.notify('session/cancel', { sessionId: sid });
  const r = await p;
  assert.ok(Date.now() - t0 < 2000);
  assert.deepEqual(r.result, { stopReason: 'cancelled' });
  assert.ok(s.world.calls.includes('interrupt'));
  assert.equal(JSON.stringify(s.c.frames).includes('too late'), false);
  // cancelling an idle session is a no-op; the session keeps working
  s.c.notify('session/cancel', { sessionId: sid });
  assert.equal((await prompt(s.c, sid, 'again')).result.stopReason, 'end_turn');
  await done(s);
});

test('cancel while a permission request is pending ⇒ $/cancel_request withdraws it, open tool fails, cancelled', async () => {
  const s = setup([{ match: /^go$/, steps: [{ tool: { name: 'Bash', id: 'tp', input: { command: 'rm -rf x' } } }, { text: 'nope' }] }], { onPermission: () => undefined });
  const sid = await newSession(s);
  const p = prompt(s.c, sid, 'go');
  const perm = await s.c.waitFor((f) => f.method === 'session/request_permission');
  s.c.notify('session/cancel', { sessionId: sid });
  const r = await p;
  assert.equal(r.result.stopReason, 'cancelled');
  const withdraw = s.c.frames.find((f) => f.method === '$/cancel_request')!;
  assert.deepEqual(withdraw.params, { requestId: perm.id });
  assert.ok(respIndex(s.c, withdraw) < respIndex(s.c, r));
  const fin = s.c.updates('tool_call_update', sid).find((u) => u.toolCallId === 'tp')!;
  assert.equal(fin.status, 'failed');
  // a late answer is ignored
  s.c.respond(perm.id, { outcome: { outcome: 'selected', optionId: 'allow_once' } });
  await sleep(20);
  assert.equal((await prompt(s.c, sid, 'again')).result.stopReason, 'end_turn');
  await done(s);
});

test('$/cancel_request for an in-flight session/prompt cancels the turn (05 §4.14)', async () => {
  const s = setup([{ steps: [{ sleepMs: 8000 }] }]);
  const sid = await newSession(s);
  const id = 'prompt-xyz';
  const p = s.c.waitFor((f) => f.id === id && 'result' in f);
  s.c.send({ jsonrpc: '2.0', id, method: 'session/prompt', params: { sessionId: sid, prompt: [{ type: 'text', text: 'slow' }] } });
  await until(() => s.world.sessions[0]!.turnCount === 1);
  s.c.notify('$/cancel_request', { requestId: id });
  assert.equal((await p).result.stopReason, 'cancelled');
  await done(s);
});

test('a turn that does not stop after cancel is answered cancelled after the grace period; the queue waits for it', async () => {
  const world = createWorld();
  const s = setup([], { world, timings: { cancelGraceMs: 100 } });
  const sid = await newSession(s);
  const sess = world.sessions[0]!;
  const orig = sess.prompt.bind(sess);
  let stuckDone = false;
  // a child that ignores the interrupt for 600 ms
  sess.prompt = async function* (input, o) {
    if (input.text !== 'stuck') return yield* orig(input, o);
    yield { type: 'text_delta', text: 'working' };
    await sleep(600);
    stuckDone = true;
    yield { type: 'text_delta', text: 'late text' };
    return { stopReason: 'end_turn', isError: false, text: '', permissionDenials: [] };
  };
  const t0 = Date.now();
  const p = prompt(s.c, sid, 'stuck');
  await s.c.waitFor((f) => isUpdate('agent_message_chunk')(f));
  s.c.notify('session/cancel', { sessionId: sid });
  const next = prompt(s.c, sid, 'next');
  const r = await p;
  assert.equal(r.result.stopReason, 'cancelled');
  assert.ok(Date.now() - t0 < 500, 'answered after the grace period, not after the child');
  assert.equal(stuckDone, false);
  assert.equal((await next).result.stopReason, 'end_turn');
  assert.equal(stuckDone, true, 'the next prompt waited for the stuck turn');
  assert.equal(JSON.stringify(s.c.frames).includes('late text'), false, 'late events of a detached turn are dropped');
  await done(s);
});

// ───────────────────────────── S8 ─────────────────────────────

test('S8 terminate ⇒ {}; files kept; later requests on that id ⇒ -32603 Session not found; idempotent', async () => {
  const s = setup();
  const sid = await newSession(s);
  await prompt(s.c, sid, 'hello');
  assert.deepEqual(await s.c.call('_kiro.dev/session/terminate', { sessionId: sid }), {});
  assert.ok(s.world.calls.includes('close'));
  const dir = path.join(s.t.kiroHome, 'sessions', 'cli');
  assert.ok(fs.existsSync(path.join(dir, `${sid}.json`)));
  assert.ok(fs.statSync(path.join(dir, `${sid}.jsonl`)).size >= 10);
  const notFound = { code: -32603, message: 'Internal error', data: 'Session not found' };
  assert.deepEqual((await s.c.request('session/set_mode', { sessionId: sid, modeId: 'probe' })).error, notFound);
  assert.deepEqual((await prompt(s.c, sid, 'x')).error, notFound);
  assert.deepEqual((await s.c.request('session/set_model', { sessionId: sid, modelId: 'auto' })).error, notFound);
  assert.deepEqual((await s.c.request('_kiro.dev/commands/execute', { sessionId: sid, command: { command: 'mcp', args: {} } })).error, notFound);
  assert.deepEqual((await s.c.request('_session/steer', { sessionId: sid, message: 'x' })).error, notFound);
  assert.deepEqual(await s.c.call('_kiro.dev/session/terminate', { sessionId: sid }), {});
  assert.deepEqual(await s.c.call('_kiro.dev/session/terminate', { sessionId: 'never-existed' }), {});
  assert.deepEqual(await s.c.call('_kiro.dev/session/terminate', {}), {});
  // standard session/close and the _session/terminate notification behave the same
  const sid2 = await newSession(s);
  assert.deepEqual(await s.c.call('session/close', { sessionId: sid2 }), {});
  const sid3 = await newSession(s);
  s.c.notify('_session/terminate', { sessionId: sid3 });
  await until(() => s.world.calls.filter((x) => x === 'close').length === 3);
  await done(s);
});

test('terminate during a running prompt answers the prompt cancelled', async () => {
  const s = setup([{ steps: [{ sleepMs: 5000 }] }]);
  const sid = await newSession(s);
  const p = prompt(s.c, sid, 'long');
  await until(() => s.world.sessions[0]!.turnCount === 1);
  assert.deepEqual(await s.c.call('_kiro.dev/session/terminate', { sessionId: sid }), {});
  assert.equal((await p).result.stopReason, 'cancelled');
  await done(s);
});

// ───────────────────────────── S9 ─────────────────────────────

test('S9 session/load from a NEW server instance replays history before the response and remembers context', async () => {
  const t = tmpEnv();
  writeAgent(path.join(t.work, '.kiro'), 'probe', probeSpec());
  const turns: MockTurn[] = [
    { match: /code word/, steps: [{ text: 'history: {{history}}' }] },
    { match: /tool time/, steps: [{ tool: { name: 'Bash', id: 'toolu_h', input: { command: 'echo h' }, result: 'h', permission: 'allow' } }, { text: 'ran' }] },
    { steps: [{ text: 'OK' }] },
  ];
  const s1 = setup(turns, { t });
  const sid = await newSession(s1);
  await prompt(s1.c, sid, 'Remember the secret KC-42. Reply OK');
  await prompt(s1.c, sid, 'tool time');
  await s1.c.call('_kiro.dev/session/terminate', { sessionId: sid });
  await done(s1);

  const sessionFile = path.join(t.kiroHome, 'sessions', 'cli', `${sid}.json`);
  assert.ok(fs.existsSync(sessionFile));
  const s2 = setup(turns, { t });
  await s2.c.initialize();
  const resp = await s2.c.request('session/load', { sessionId: sid, cwd: t.work, mcpServers: [], _meta: { '_kiro.dev/session_file': sessionFile } });
  assert.ok(resp.result, JSON.stringify(resp.error));
  assert.equal(resp.result.modes.currentModeId, 'probe');
  assert.ok(Array.isArray(resp.result.modes.availableModes));
  assert.equal(resp.result.models.currentModelId, 'auto');
  assert.equal('sessionId' in resp.result, false);
  const replayed = s2.c.frames.slice(0, respIndex(s2.c, resp)).filter((f) => f.method === 'session/update').map((f) => f.params.update);
  assert.deepEqual(
    replayed.map((u) => [u.sessionUpdate, u.content?.text ?? u.title ?? u.status]),
    [
      ['user_message_chunk', 'Remember the secret KC-42. Reply OK'],
      ['agent_message_chunk', 'OK'],
      ['user_message_chunk', 'tool time'],
      ['tool_call', 'Tool'],
      ['agent_message_chunk', 'ran'],
    ],
  );
  assert.ok(replayed.every((u) => u._meta?.kiro?.replay === true));
  assert.deepEqual(s2.world.created[0]!.resume, { sessionId: sid });
  assert.equal(s2.world.created[0]!.agentName, 'probe');
  const r = await prompt(s2.c, sid, 'What is the code word?');
  const text = s2.c.updates('agent_message_chunk', sid).map((u) => u.content.text).join('');
  assert.match(text, /KC-42/, 'the resumed session remembers the earlier conversation');
  assert.equal(r.result.stopReason, 'end_turn');
  await s2.c.waitFor((f) => f.method === '_kiro.dev/metadata');

  // re-attach to the live session in the same process: no new session object, still replays
  const before = s2.world.created.length;
  const again = await s2.c.request('session/load', { sessionId: sid, cwd: t.work, mcpServers: [] });
  assert.ok(again.result.modes);
  assert.equal(s2.world.created.length, before);

  // unknown id
  const missing = await s2.c.request('session/load', { sessionId: '00000000-0000-4000-8000-000000000000', cwd: t.work, mcpServers: [] });
  assert.deepEqual(missing.error, { code: -32603, message: 'Internal error', data: 'Session not found' });
  const unsafe = await s2.c.request('session/load', { sessionId: '../../etc/passwd', cwd: t.work, mcpServers: [] });
  assert.equal(unsafe.error.data, 'Session not found');
  await done(s2);
});

test('session/load start failure (lock held elsewhere) fails the load with the session error text', async () => {
  const t = tmpEnv();
  writeAgent(path.join(t.work, '.kiro'), 'probe', probeSpec());
  const s1 = setup([], { t });
  const sid = await newSession(s1);
  await prompt(s1.c, sid, 'hi');
  await done(s1);
  const world = createWorld();
  world.startError = 'Failed to start session: Session is active in another process (PID 4242)';
  const s2 = setup([], { t, world });
  await s2.c.initialize();
  const r = await s2.c.request('session/load', { sessionId: sid, cwd: t.work, mcpServers: [] });
  assert.equal(r.error.code, -32603);
  assert.match(r.error.data, /active in another process/);
  assert.ok(world.calls.includes('close'));
  await done(s2);
});

// ───────────────────────────── S10 / S11 ─────────────────────────────

test('S10 many concurrent sessions in one process; prompts on one session are serialized', async () => {
  const s = setup([{ match: /slow/, steps: [{ sleepMs: 150 }, { text: 'S:{{user}}' }] }, { steps: [{ text: 'F:{{user}}' }] }]);
  await s.c.initialize();
  const ids = await Promise.all([0, 1, 2, 3, 4].map(() => s.c.call('session/new', { cwd: s.t.work, mcpServers: [] }).then((r) => r.sessionId as string)));
  assert.equal(new Set(ids).size, 5);
  const rs = await Promise.all(ids.map((id, i) => prompt(s.c, id, `slow ${i}`)));
  assert.ok(rs.every((r) => r.result.stopReason === 'end_turn'));
  for (const [i, id] of ids.entries()) {
    assert.deepEqual(s.c.updates('agent_message_chunk', id).map((u) => u.content.text), [`S:slow ${i}`]);
  }
  assert.equal(s.world.sessions.length, 5);
  assert.deepEqual(s.c.server!.sessionIds.sort(), [...ids].sort());
  // two prompts to one session: the second starts only after the first answered
  const a = prompt(s.c, ids[0]!, 'slow A');
  const b = prompt(s.c, ids[0]!, 'fast B');
  const [ra, rb] = await Promise.all([a, b]);
  const bChunk = idx(s.c, (f) => isUpdate('agent_message_chunk')(f) && f.params.update.content.text === 'F:fast B');
  assert.ok(bChunk > respIndex(s.c, ra));
  assert.equal(rb.result.stopReason, 'end_turn');
  for (const id of ids.slice(3)) await s.c.call('_kiro.dev/session/terminate', { sessionId: id });
  assert.equal(s.c.server!.sessionIds.length, 3);
  await done(s);
});

test('S11 stdin EOF: running turns are cancelled and answered, every session closed, exit 0', async () => {
  const s = setup([{ steps: [{ sleepMs: 8000 }] }]);
  const a = await newSession(s);
  await s.c.call('session/new', { cwd: s.t.work, mcpServers: [] });
  const p = prompt(s.c, a, 'long');
  await until(() => s.world.sessions[0]!.turnCount === 1);
  const t0 = Date.now();
  const code = await s.c.close();
  assert.equal(code, 0);
  assert.ok(Date.now() - t0 < 5000);
  assert.equal((await p).result.stopReason, 'cancelled');
  assert.equal(s.world.calls.filter((x) => x === 'close').length, 2);
  assert.deepEqual(s.c.nonJson, []);
});

// ───────────────────────────── S12 ─────────────────────────────

test('S12 _session/steer mid-tool ⇒ {queued:true}, Queued, then Injected after the tool result; obeyed in the same turn', async () => {
  const s = setup([{ steps: [{ tool: { name: 'Bash', id: 'ts', input: { command: 'sleep 1' }, durationMs: 300, permission: 'allow', result: 'first-done' } }, { text: 'answer. {{steers}}' }] }]);
  const sid = await newSession(s);
  const p = prompt(s.c, sid, 'go');
  await s.c.waitFor(isUpdate('tool_call'));
  const steerText = '<user_message>\nAlso end your answer with the word pineapple.\n</user_message>';
  const sr = await s.c.request('_session/steer', { sessionId: sid, message: steerText });
  assert.deepEqual(sr.result, { queued: true });
  const q = await s.c.waitFor((f) => f.method === '_kiro.dev/session/update' && f.params.update.sessionUpdate === 'AgentExecutionUserMessageQueued');
  assert.ok(respIndex(s.c, q) > respIndex(s.c, sr));
  assert.match(q.params.update.messageId, /^steer-[0-9a-f]{32}$/);
  assert.deepEqual(q.params, { sessionId: sid, update: { sessionUpdate: 'AgentExecutionUserMessageQueued', messageId: q.params.update.messageId, content: steerText } });
  const r = await p;
  assert.equal(r.result.stopReason, 'end_turn');
  const inj = s.c.frames.find((f) => f.method === '_kiro.dev/session/update' && f.params.update.sessionUpdate === 'AgentExecutionSteeringInjected')!;
  assert.deepEqual(inj.params.update, { sessionUpdate: 'AgentExecutionSteeringInjected', messageId: q.params.update.messageId, content: steerText });
  const completed = idx(s.c, (f) => isUpdate('tool_call_update')(f) && f.params.update.status === 'completed');
  assert.ok(respIndex(s.c, inj) > completed, 'injected at the tool boundary');
  assert.match(s.c.updates('agent_message_chunk', sid).map((u) => u.content.text).join(''), /pineapple/);
  // no active turn
  assert.deepEqual(await s.c.call('_session/steer', { sessionId: sid, message: 'x' }), { queued: false });
  assert.deepEqual(await s.c.call('_session/steer/clear', { sessionId: sid }), { cleared: true });
  assert.equal(s.c.frames.filter((f) => f.params?.update?.sessionUpdate === 'AgentExecutionUserMessageCleared').length, 0);
  await done(s);
});

test('S12 steer, steer, clear, steer: only the last one is injected (steering-clear-live)', async () => {
  const s = setup([{ steps: [{ tool: { name: 'Bash', id: 'tc', input: { command: 'sleep 15' }, durationMs: 400, permission: 'allow' } }, { text: 'steers={{steers}}' }] }]);
  const sid = await newSession(s);
  const p = prompt(s.c, sid, 'go');
  await s.c.waitFor(isUpdate('tool_call'));
  const A = '<user_message>\nAlso end your answer with the word pineapple.\n</user_message>';
  const B = '<user_message>\nAlso start your answer with the word mango.\n</user_message>';
  await s.c.call('_session/steer', { sessionId: sid, message: A });
  await s.c.call('_session/steer', { sessionId: sid, message: B });
  const queued = await until(() => s.c.frames.filter((f) => f.params?.update?.sessionUpdate === 'AgentExecutionUserMessageQueued').length === 2).then(() =>
    s.c.frames.filter((f) => f.params?.update?.sessionUpdate === 'AgentExecutionUserMessageQueued'),
  );
  assert.equal(queued[1]!.params.update.content, `${A}\n\n${B}`);
  const cr = await s.c.request('_session/steer/clear', { sessionId: sid });
  assert.deepEqual(cr.result, { cleared: true });
  const cleared = await s.c.waitFor((f) => f.params?.update?.sessionUpdate === 'AgentExecutionUserMessageCleared');
  assert.deepEqual(cleared.params.update.messageIds, queued.map((f) => f.params.update.messageId));
  assert.ok(respIndex(s.c, cleared) > respIndex(s.c, cr));
  await s.c.call('_session/steer', { sessionId: sid, message: B });
  await p;
  const inj = s.c.frames.filter((f) => f.params?.update?.sessionUpdate === 'AgentExecutionSteeringInjected');
  assert.equal(inj.length, 1);
  assert.equal(inj[0]!.params.update.content, B);
  assert.deepEqual(s.world.calls.filter((x) => x.startsWith('steer:')), [`steer:${B}`]);
  await done(s);
});

test('a steer still held when the turn ends runs as a continuation inside the same prompt request', async () => {
  const s = setup([
    { match: /pineapple/, steps: [{ text: 'second' }] },
    { steps: [{ sleepMs: 200 }, { text: 'first' }] },
  ]);
  const sid = await newSession(s);
  const p = prompt(s.c, sid, 'go');
  await until(() => s.world.sessions[0]!.turnCount === 1);
  await s.c.call('_session/steer', { sessionId: sid, message: 'say pineapple' });
  const r = await p;
  assert.equal(r.result.stopReason, 'end_turn');
  assert.deepEqual(s.c.updates('agent_message_chunk', sid).map((u) => u.content.text), ['first', 'second']);
  const inj = s.c.frames.find((f) => f.params?.update?.sessionUpdate === 'AgentExecutionSteeringInjected')!;
  assert.ok(respIndex(s.c, inj) < respIndex(s.c, r));
  assert.equal(s.world.sessions[0]!.turnCount, 2);
  await done(s);
});

test('steers held when a turn is cancelled are dropped and reported cleared; no steering during /compact', async () => {
  const s = setup([{ match: /slow/, steps: [{ sleepMs: 5000 }] }, { steps: [{ tool: { name: 'Bash', id: 'n1', input: { command: 'ls' }, permission: 'allow' } }, { text: 'next={{steers}}' }] }]);
  const sid = await newSession(s);
  const p = prompt(s.c, sid, 'slow');
  await until(() => s.world.sessions[0]!.turnCount === 1);
  assert.deepEqual(await s.c.call('_session/steer', { sessionId: sid, message: 'late steer' }), { queued: true });
  const q = await s.c.waitFor((f) => f.params?.update?.sessionUpdate === 'AgentExecutionUserMessageQueued');
  s.c.notify('session/cancel', { sessionId: sid });
  assert.equal((await p).result.stopReason, 'cancelled');
  const cl = await s.c.waitFor((f) => f.params?.update?.sessionUpdate === 'AgentExecutionUserMessageCleared');
  assert.deepEqual(cl.params.update.messageIds, [q.params.update.messageId]);
  await prompt(s.c, sid, 'next turn');
  assert.equal(s.c.updates('agent_message_chunk', sid).pop()!.content.text, 'next=', 'the dropped steer never reaches the next turn');
  assert.deepEqual(s.world.calls.filter((x) => x.startsWith('steer:')), []);
  await done(s);
});

test('thinking deltas ⇒ agent_thought_chunk; commands/execute compact runs the compaction', async () => {
  const s = setup([{ steps: [{ thinking: 'pondering' }, { thinking: '' }, { text: 'answer' }] }]);
  const sid = await newSession(s);
  await prompt(s.c, sid, 'think');
  assert.deepEqual(s.c.updates('agent_thought_chunk', sid).map((u) => u.content), [{ type: 'text', text: 'pondering' }]);
  const r = await s.c.call('_kiro.dev/commands/execute', { sessionId: sid, command: { command: 'compact', args: {} } });
  assert.deepEqual(r, { success: true, message: 'Conversation compacted' });
  const st = s.c.notifications('_kiro.dev/compaction/status').map((f) => f.params.status.type);
  assert.deepEqual(st, ['started', 'completed']);
  assert.ok(s.world.calls.includes('compact'));
  await done(s);
});

// ───────────────────────────── S13 and other frames ─────────────────────────────

test('S13 zero-tools agent: no tool frames, no permission requests, empty /tools', async () => {
  const s = setup([{ steps: [{ tool: { name: 'Bash', input: { command: 'ls' } } }, { text: 'I have no tools.' }] }], { args: ['--agent', 'probe-zero'] });
  const sid = await newSession(s);
  for (let i = 0; i < 3; i++) assert.equal((await prompt(s.c, sid, `turn ${i}`)).result.stopReason, 'end_turn');
  assert.equal(s.c.updates('tool_call').length + s.c.updates('tool_call_update').length, 0);
  assert.equal(s.c.frames.filter((f) => f.method === 'session/request_permission').length, 0);
  const tools = await s.c.call('_kiro.dev/commands/execute', { sessionId: sid, command: { command: 'tools', args: {} } });
  assert.deepEqual(tools, { success: true, message: '0 tools', data: { tools: [] } });
  await done(s);
});

test('todos: plan update and the todo_list snapshot on the tool result', async () => {
  const todos = [
    { id: '1', subject: 'Write tests', status: 'in_progress' as const },
    { id: '2', subject: 'Ship', status: 'pending' as const },
  ];
  const s = setup([{ steps: [{ todos }, { tool: { name: 'TaskCreate', id: 'tt', input: { subject: 'Ship' }, result: 'Task #2 created successfully: Ship' } }, { text: 'planned' }] }]);
  const sid = await newSession(s);
  await prompt(s.c, sid, 'plan it');
  assert.deepEqual(s.c.updates('plan', sid)[0], {
    sessionUpdate: 'plan',
    entries: [
      { content: 'Write tests', priority: 'medium', status: 'in_progress' },
      { content: 'Ship', priority: 'medium', status: 'pending' },
    ],
  });
  const tc = s.c.updates('tool_call', sid)[0]!;
  assert.equal(tc._meta.kiro.toolName, 'todo_list');
  const fin = s.c.updates('tool_call_update', sid).find((u) => u.status === 'completed')!;
  assert.deepEqual(fin.rawOutput, {
    items: [{ Json: { description: 'Tasks', tasks: [{ id: '1', task_description: 'Write tests', completed: false }, { id: '2', task_description: 'Ship', completed: false }] } }],
  });
  await done(s);
});

test('subagent inner tool calls are reported under the parent sessionId with parentToolUseId (08 KC-ACP-21)', async () => {
  const s = setup([
    {
      steps: [
        { subagent: { state: 'started', agentType: 'general-purpose', toolUseId: 'toolu_agent' } },
        { tool: { name: 'Read', id: 'toolu_inner', input: { file_path: '/work/x.txt' }, parentToolUseId: 'toolu_agent', result: 'X' } },
        { subagent: { state: 'finished', agentType: 'general-purpose', toolUseId: 'toolu_agent' } },
        { text: 'done' },
      ],
    },
  ]);
  const sid = await newSession(s);
  await prompt(s.c, sid, 'delegate');
  const inner = s.c.frames.filter((f) => f.method === 'session/update' && f.params.update.toolCallId === 'toolu_inner');
  assert.ok(inner.every((f) => f.params.sessionId === sid));
  assert.equal(inner[0]!.params.update.sessionUpdate, 'tool_call');
  assert.deepEqual(inner[0]!.params.update._meta, { kiro: { toolName: 'read' }, claudeCode: { toolName: 'Read', parentToolUseId: 'toolu_agent' } });
  assert.equal(inner[inner.length - 1]!.params.update.status, 'completed');
  const lists = s.c.notifications('_kiro.dev/subagent/list_update').map((f) => f.params.subagents);
  assert.deepEqual(lists, [[{ id: 'toolu_agent', name: 'general-purpose', status: 'running' }], [{ id: 'toolu_agent', name: 'general-purpose', status: 'completed' }]]);
  await done(s);
});

test('refusal ⇒ CONTENT_FILTERED metadata before stopReason refusal (08 KC-ACP-19)', async () => {
  const s = setup([{ steps: [{ text: 'I cannot help with that.' }, { result: { stopReason: 'refusal' } }] }]);
  const sid = await newSession(s);
  const r = await prompt(s.c, sid, 'bad');
  assert.equal(r.result.stopReason, 'refusal');
  const m = s.c.frames.find((f) => f.method === '_kiro.dev/metadata' && f.params.stopReason === 'CONTENT_FILTERED')!;
  assert.deepEqual(m.params, { sessionId: sid, stopReason: 'CONTENT_FILTERED', refusal: { category: 'OTHER', explanation: 'I cannot help with that.', recommendedModel: null }, modelId: 'auto' });
  assert.ok(respIndex(s.c, m) < respIndex(s.c, r));
  await done(s);
});

test('turn errors end the prompt with JSON-RPC errors: auth ⇒ -32000 HTTP 401; others ⇒ -32603; max_tokens / max_turns', async () => {
  const s = setup([
    { match: /auth/, steps: [{ result: { stopReason: 'error', isError: true, authError: true, error: 'Not logged in · Please run /login' } }] },
    { match: /limit/, steps: [{ raw: { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' } } }, { result: { stopReason: 'error', isError: true, error: "You've hit your session limit" } }] },
    { match: /boom/, steps: [{ result: { stopReason: 'error', isError: true, error: 'Claude Code exited (code 1): oops' } }] },
    { match: /long/, steps: [{ text: 'cut' }, { raw: { type: 'result', stop_reason: 'max_tokens', usage: {} } }] },
    { match: /turns/, steps: [{ result: { stopReason: 'max_turns' } }] },
  ]);
  const sid = await newSession(s);
  const a = await prompt(s.c, sid, 'auth');
  assert.equal(a.error.code, -32000);
  assert.match(a.error.message, /HTTP 401/);
  const l = await prompt(s.c, sid, 'limit');
  assert.match(l.error.data, /You've hit your 5-hour limit/);
  const b = await prompt(s.c, sid, 'boom');
  assert.deepEqual(b.error, { code: -32603, message: 'Internal error', data: 'Claude Code exited (code 1): oops' });
  assert.equal((await prompt(s.c, sid, 'long')).result.stopReason, 'max_tokens');
  assert.equal((await prompt(s.c, sid, 'turns')).result.stopReason, 'max_turn_requests');
  assert.equal((await prompt(s.c, sid, 'fine')).result.stopReason, 'end_turn', 'the session survives errors');
  await done(s);
});

test('slow or failing session calls never leave unhandled rejections (listModels / usage timeouts)', async () => {
  const world = createWorld([{ steps: [{ text: 'ok' }] }]);
  const s = setup([], { world, timings: { usageTimeoutMs: 20 } });
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown): void => void unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    const sid = await newSession(s);
    const sess = world.sessions[0]!;
    sess.usage = () => new Promise((_, rej) => setTimeout(() => rej(new Error('late usage failure')), 60));
    const r = await prompt(s.c, sid, 'go');
    assert.equal(r.result.stopReason, 'end_turn');
    const meta = s.c.frames.filter((f) => f.method === '_kiro.dev/metadata' && 'turnDurationMs' in f.params).pop()!;
    assert.equal(typeof meta.params.contextUsagePercentage, 'number', 'falls back when usage() times out');
    await sleep(120);
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
  await done(s);
});

test('session start failure is reported by later operations', async () => {
  const world = createWorld();
  world.startError = 'Claude Code CLI (claude) was not found';
  const s = setup([], { world });
  const sid = await newSession(s);
  const r = await prompt(s.c, sid, 'hi');
  assert.equal(r.error.code, -32603);
  assert.equal(r.error.data, 'Failed to start the session: Claude Code CLI (claude) was not found');
  await done(s);
});

// ───────────────────────────── slash prompts ─────────────────────────────

test('slash prompts: Kiro commands answered locally (never sent to the model), Kiro prompts expanded, others forwarded', async () => {
  const s = setup([{ steps: [{ text: 'model got: {{user}}' }] }]);
  fs.mkdirSync(path.join(s.t.work, '.kiro', 'prompts'), { recursive: true });
  fs.writeFileSync(path.join(s.t.work, '.kiro', 'prompts', 'greet.md'), 'Say hello to ${1} politely.');
  const sid = await newSession(s);
  const h = await prompt(s.c, sid, '/help');
  assert.deepEqual(h.result, { stopReason: 'end_turn' });
  assert.match(s.c.updates('agent_message_chunk', sid).pop()!.content.text, /\/compact/);
  await prompt(s.c, sid, '/model claude-haiku-5.5');
  assert.ok(s.world.calls.includes('setModel:claude-haiku-5.5'));
  await prompt(s.c, sid, '/clear');
  assert.ok(s.world.calls.includes('clear'));
  assert.equal(s.world.sessions[0]!.turnCount, 0, 'no model turn for local commands');
  await prompt(s.c, sid, '/greet Bob');
  assert.equal(s.c.updates('agent_message_chunk', sid).pop()!.content.text, 'model got: Say hello to Bob politely.');
  await prompt(s.c, sid, '/unknown-thing with args');
  assert.equal(s.c.updates('agent_message_chunk', sid).pop()!.content.text, 'model got: /unknown-thing with args');
  const cmds = s.c.updates('available_commands_update', sid)[0]!;
  assert.ok(cmds.availableCommands.some((x: Frame) => x.name === 'greet' && x.description.startsWith('Prompt:')));
  await done(s);
});

test('prompt content blocks: images and resources reach the session; legacy params.content accepted', async () => {
  const s = setup([{ steps: [{ text: 'seen' }] }]);
  const sid = await newSession(s);
  const seen: unknown[] = [];
  const sess = s.world.sessions[0]!;
  const orig = sess.prompt.bind(sess);
  sess.prompt = (input, o) => {
    seen.push(input);
    return orig(input, o);
  };
  await s.c.call('session/prompt', {
    sessionId: sid,
    prompt: [
      { type: 'text', text: 'look' },
      { type: 'image', data: 'iVBOR', mimeType: 'image/png' },
      { type: 'resource', resource: { uri: 'file:///work/a.md', text: 'A' } },
    ],
  });
  await s.c.call('session/prompt', { sessionId: sid, content: [{ type: 'text', text: 'old style' }] });
  assert.deepEqual(seen[0], { text: 'look\n[@a.md](file:///work/a.md)\n<context ref="file:///work/a.md">\nA\n</context>', images: [{ mediaType: 'image/png', dataBase64: 'iVBOR' }] });
  assert.deepEqual(seen[1], { text: 'old style' });
  assert.equal((await s.c.request('session/prompt', { sessionId: sid })).error.code, -32602);
  await done(s);
});

// ───────────────────────────── misc protocol ─────────────────────────────

test('unknown methods ⇒ -32601; unknown notifications ignored; parse errors answered; unknown session ⇒ Session not found', async () => {
  const s = setup();
  await s.c.initialize();
  const r = await s.c.request('_kiro/auth/getAccessToken', {});
  assert.deepEqual(r.error, { code: -32601, message: 'Method not found', data: '_kiro/auth/getAccessToken' });
  s.c.notify('_kiro.dev/telemetry/whatever', { x: 1 });
  s.c.sendRaw('{broken json\n');
  await s.c.waitFor((f) => f.id === null && f.error?.code === -32700);
  assert.deepEqual((await prompt(s.c, 'nope', 'hi')).error, { code: -32603, message: 'Internal error', data: 'Session not found' });
  assert.deepEqual(await s.c.call('initialize', {}), await s.c.call('initialize', { protocolVersion: 1 }));
  await done(s);
});

test('session/list lists stored sessions newest first, filtered by cwd', async () => {
  const s = setup();
  const a = await newSession(s);
  await prompt(s.c, a, 'first session');
  const b = await s.c.call('session/new', { cwd: s.t.work, mcpServers: [] });
  await prompt(s.c, b.sessionId, 'second session');
  const r = await s.c.call('session/list', {});
  assert.deepEqual(r.sessions.map((x: Frame) => x.sessionId), [b.sessionId, a]);
  assert.equal(r.sessions[0].cwd, s.t.work);
  assert.equal(r.sessions[0].title, 'second session');
  assert.equal((await s.c.call('session/list', { cwd: '/elsewhere' })).sessions.length, 0);
  await done(s);
});

test('amazon-internal sandbox:true is warned about on stderr (05 §2.6)', async () => {
  const t = tmpEnv();
  fs.mkdirSync(path.join(t.kiroHome, 'settings'), { recursive: true });
  fs.writeFileSync(path.join(t.kiroHome, 'settings', 'amazon-internal.json'), JSON.stringify({ sandbox: true }));
  writeAgent(path.join(t.work, '.kiro'), 'probe', probeSpec());
  const s = setup([], { t });
  await s.c.initialize();
  assert.match(s.c.stderrText, /no internal sandbox/);
  await done(s);
});

/**
 * End-to-end: the ACP server with the REAL session module (src/session/kiroSession.ts) and the
 * fake Claude Code CLI (test/fixtures/fake-claude.mjs via KIRO_CLAUDE_BIN). Reproduces the
 * KiroCrew stage-B scenarios (08 §5.2 S1–S13) as far as the fake allows.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { TestClient, tmpEnv, until, writeAgent, type Frame, type TmpEnv } from './helpers.js';

let sessionModuleOk = true;
try {
  await import('../../src/session/kiroSession.js');
} catch {
  sessionModuleOk = false;
}
const skip = sessionModuleOk ? false : 'src/session/kiroSession.ts is not available';

const SCRIPT = {
  turns: [
    { repeat: true, match: 'PING', steps: [{ text: 'PONG' }] },
    {
      repeat: true,
      match: 'RUN-ECHO',
      steps: [
        { tool: { name: 'Bash', input: { command: 'echo kc-e2e', description: 'Echo it' }, result: 'kc-e2e', tool_use_result: { stdout: 'kc-e2e\n', stderr: '', interrupted: false } } },
        { text: 'saw: {{lastToolResult}}' },
      ],
    },
    { repeat: true, match: 'HISTORY', steps: [{ text: 'history: {{historyUserTexts}}' }] },
    { repeat: true, match: 'SLOW', steps: [{ text: 'starting' }, { sleepMs: 8000 }, { text: 'late' }] },
    {
      repeat: true,
      match: 'STEER',
      // sleepMs after the tool stands in for the model call that follows every tool result
      steps: [{ tool: { name: 'Bash', input: { command: 'sleep 1' }, durationMs: 800, result: 'first-done' } }, { sleepMs: 300 }, { text: 'after the tool' }],
    },
    {
      repeat: true,
      match: 'DELEGATE',
      steps: [
        { tool: { id: 'toolu_agent', name: 'Agent', input: { description: 'Look around', prompt: 'look', subagent_type: 'general-purpose' }, result: 'report' } },
        { tool: { id: 'toolu_inner', name: 'Read', input: { file_path: '{{cwd}}/x.txt' }, parent_tool_use_id: 'toolu_agent', agent_id: 'a1', agent_type: 'general-purpose' } },
        { text: 'delegated' },
      ],
    },
  ],
  default: { steps: [{ text: 'OK' }] },
};

interface E2E {
  t: TmpEnv;
  c: TestClient;
  log: string;
}

const clients: TestClient[] = [];
after(async () => {
  // a failed test must not leave a server (and its fake-claude children) keeping the run alive
  await Promise.allSettled(clients.filter((c) => c.exitCode === undefined).map((c) => c.close(10_000)));
});

function start(t: TmpEnv, args: string[], onPermission?: TestClient['onPermission']): TestClient {
  const c = new TestClient({ args, env: t.env, cwd: t.work, ...(onPermission ? { onPermission } : {}) });
  clients.push(c);
  return c;
}

function setup(args = ['--agent-engine', 'v2', '--agent', 'kc-probe'], onPermission?: TestClient['onPermission']): E2E {
  const log = '';
  const t = tmpEnv({ FAKE_CLAUDE_SCRIPT_JSON: JSON.stringify(SCRIPT), FAKE_CLAUDE_PERSIST: '1', FAKE_CLAUDE_COMPACT_MS: '5' });
  const logFile = path.join(t.root, 'fake-claude.jsonl');
  t.env.FAKE_CLAUDE_LOG = logFile;
  t.env.KIROCREW_SPAWNED = '1';
  writeAgent(path.join(t.work, '.kiro'), 'kc-probe', {
    description: 'capture probe',
    tools: ['*'],
    allowedTools: [],
    mcpServers: { probe: { command: 'node', args: ['probe-server.js'] } },
    includeMcpJson: false,
  });
  writeAgent(path.join(t.work, '.kiro'), 'kc-allow', { description: 'shell allowed', tools: ['*'], allowedTools: ['execute_bash'], includeMcpJson: false });
  writeAgent(path.join(t.work, '.kiro'), 'kc-zero', { description: 'no tools', tools: [], includeMcpJson: false });
  void log;
  return { t, c: start(t, args, onPermission), log: logFile };
}

function fakeLog(file: string): Frame[] {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Frame);
  } catch {
    return [];
  }
}

async function newSession(e: E2E, params: Record<string, unknown> = {}): Promise<string> {
  await e.c.initialize();
  const r = await e.c.call('session/new', { cwd: e.t.work, mcpServers: [], ...params }, 30_000);
  return r.sessionId as string;
}

const promptReq = (c: TestClient, sid: string, text: string, ms = 30_000) => c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text }] }, ms);
const isUpdate = (kind: string) => (f: Frame) => f.method === 'session/update' && f.params?.update?.sessionUpdate === kind;

async function finish(e: E2E): Promise<void> {
  assert.equal(await e.c.close(20_000), 0);
  assert.deepEqual(e.c.nonJson, [], 'stdout carries only JSON-RPC frames');
  // no fake-claude child outlives the server
  await until(() => fakeLog(e.log).filter((x) => x.event === 'start' && !x.argv?.includes('--version')).length <= fakeLog(e.log).filter((x) => x.event === 'exit' || x.event === 'sigterm').length, 8000, 'children exit');
}

test('S1/S2: initialize, session/new with an MCP stub, eager spawn, server_initialized, set_mode, /mcp, /tools', { skip }, async () => {
  const e = setup();
  const sid = await newSession(e, {
    mcpServers: [{ name: 'gw-stub', command: 'node', args: ['stub.js'], env: [{ name: 'KIROCREW_STUB_SESSION_TOKEN', value: 'tok-123' }], type: 'stdio' }],
  });
  const resp = e.c.frames.find((f) => f.id === 2)!;
  assert.equal(resp.result.modes.currentModeId, 'kc-probe');
  assert.ok(resp.result.models.availableModels.some((m: Frame) => m.modelId === resp.result.models.currentModelId));
  const a = await e.c.waitFor((f) => f.method === '_kiro.dev/mcp/server_initialized' && f.params.serverName === 'probe', 15_000);
  const b = await e.c.waitFor((f) => f.method === '_kiro.dev/mcp/server_initialized' && f.params.serverName === 'gw-stub', 15_000);
  assert.ok(e.c.frames.indexOf(a) > e.c.frames.indexOf(resp) && e.c.frames.indexOf(b) > e.c.frames.indexOf(resp));
  // the child was spawned with the stub server (and its env) in --mcp-config, before any prompt
  const starts = fakeLog(e.log).filter((x) => x.event === 'start' && x.argv.includes('-p'));
  assert.equal(starts.length, 1, 'eager spawn');
  const argv: string[] = starts[0]!.argv;
  const mcpArg = argv[argv.indexOf('--mcp-config') + 1]!;
  const mcpJson = mcpArg.trim().startsWith('{') ? mcpArg : fs.readFileSync(mcpArg, 'utf8');
  assert.match(mcpJson, /tok-123/);
  assert.equal(starts[0]!.env.KIRO_API_KEY, undefined);
  const sm = await e.c.request('session/set_mode', { sessionId: sid, modeId: 'kc-probe' }, 30_000);
  assert.deepEqual(sm.result, {});
  assert.ok(e.c.frames.some((f) => isUpdate('current_mode_update')(f) && f.params.update.currentModeId === 'kc-probe'));
  const mcp = await e.c.call('_kiro.dev/commands/execute', { sessionId: sid, command: { command: 'mcp', args: {} } }, 40_000);
  assert.equal(mcp.success, true);
  const names = mcp.data.servers.map((s: Frame) => `${s.name}:${s.status}`).sort();
  assert.deepEqual(names, ['gw-stub:running', 'probe:running']);
  const tools = await e.c.call('_kiro.dev/commands/execute', { sessionId: sid, command: { command: 'tools', args: {} } }, 40_000);
  assert.equal(tools.success, true);
  assert.ok(tools.data.tools.some((x: Frame) => x.name === 'shell' && x.source === 'builtin'));
  await finish(e);
});

test('S3: PING ⇒ PONG chunks, _kiro.dev/metadata contextUsagePercentage, end_turn; journal written', { skip }, async () => {
  const e = setup();
  const sid = await newSession(e);
  const r = await promptReq(e.c, sid, `[AGENT SYSTEM PROMPT]\n${'p'.repeat(45_000)}\n[END AGENT SYSTEM PROMPT]\nPING`);
  assert.equal(r.result.stopReason, 'end_turn');
  assert.match(e.c.updates('agent_message_chunk', sid).map((u) => u.content.text).join(''), /PONG/);
  const meta = e.c.frames.filter((f) => f.method === '_kiro.dev/metadata' && 'turnDurationMs' in f.params);
  assert.equal(meta.length, 1);
  assert.equal(typeof meta[0]!.params.contextUsagePercentage, 'number');
  assert.ok(e.c.frames.indexOf(meta[0]!) < e.c.frames.indexOf(r));
  const dir = path.join(e.t.kiroHome, 'sessions', 'cli');
  const journal = fs.readFileSync(path.join(dir, `${sid}.jsonl`), 'utf8');
  assert.ok(journal.length >= 10);
  assert.match(journal, /"kind":"Prompt"/);
  assert.match(journal, /"kind":"AssistantMessage"/);
  const env = JSON.parse(fs.readFileSync(path.join(dir, `${sid}.json`), 'utf8'));
  assert.equal(env.session_id, sid);
  assert.equal(env.session_state.agent_name, 'kc-probe');
  await finish(e);
});

test('S4: tool_call before request_permission with the 3 options; allow_once ⇒ completed with stdout', { skip }, async () => {
  const e = setup();
  const sid = await newSession(e);
  const r = await promptReq(e.c, sid, 'RUN-ECHO');
  assert.equal(r.result.stopReason, 'end_turn');
  const tc = e.c.frames.findIndex(isUpdate('tool_call'));
  const perm = e.c.frames.findIndex((f) => f.method === 'session/request_permission');
  assert.ok(tc >= 0 && perm > tc, 'tool_call precedes the permission request');
  const tcu = e.c.frames[tc]!.params.update;
  assert.equal(tcu._meta.kiro.toolName, 'shell');
  assert.equal(tcu.status, 'pending');
  assert.equal(tcu.rawInput.__tool_use_purpose, 'Echo it');
  assert.deepEqual(e.c.frames[perm]!.params.options.map((o: Frame) => o.optionId), ['allow_once', 'allow_always', 'reject_once']);
  const done = e.c.updates('tool_call_update', sid).find((u) => u.status === 'completed')!;
  assert.equal(done.rawOutput.items[0].Json.stdout, 'kc-e2e\n');
  await finish(e);
});

test('S4r: reject_once ⇒ failed + toolCallFailureReason permission_denied; Claude got a deny', { skip }, async () => {
  const e = setup(undefined, () => ({ outcome: { outcome: 'selected', optionId: 'reject_once' } }));
  const sid = await newSession(e);
  const r = await promptReq(e.c, sid, 'RUN-ECHO');
  assert.equal(r.result.stopReason, 'end_turn');
  const failed = e.c.updates('tool_call_update', sid).find((u) => u.status === 'failed')!;
  assert.equal(failed._meta.kiro.toolCallFailureReason, 'permission_denied');
  assert.equal(failed.title, 'shell');
  assert.equal(e.c.updates('tool_call_update', sid).some((u) => u.status === 'completed'), false);
  const denies = fakeLog(e.log).filter((x) => x.event === 'stdin' && x.line?.type === 'control_response' && JSON.stringify(x.line).includes('"behavior":"deny"'));
  assert.ok(denies.length >= 1, 'the fake saw a deny');
  assert.match(JSON.stringify(denies[0]), /User denied tool execution/);
  await finish(e);
});

test('S4b: allowedTools execute_bash ⇒ no permission request', { skip }, async () => {
  const e = setup(['--agent', 'kc-allow']);
  const sid = await newSession(e);
  const r = await promptReq(e.c, sid, 'RUN-ECHO');
  assert.equal(r.result.stopReason, 'end_turn');
  assert.equal(e.c.frames.filter((f) => f.method === 'session/request_permission').length, 0);
  assert.ok(e.c.updates('tool_call_update', sid).some((u) => u.status === 'completed'));
  await finish(e);
});

test('S5: set_model, bogus model, effort, unknown command', { skip }, async () => {
  const e = setup();
  const sid = await newSession(e);
  assert.deepEqual(await e.c.call('session/set_model', { sessionId: sid, modelId: 'claude-haiku-5.5' }, 30_000), {});
  const bad = await e.c.request('session/set_model', { sessionId: sid, modelId: 'bogus' }, 30_000);
  assert.match(bad.error.message, /Invalid model ID: bogus/);
  assert.deepEqual(await e.c.call('_kiro.dev/commands/execute', { sessionId: sid, command: { command: 'effort', args: { level: 'high' } } }, 30_000), { success: true, message: 'Effort set to high' });
  assert.deepEqual(await e.c.call('_kiro.dev/commands/execute', { sessionId: sid, command: { command: 'foo', args: {} } }, 30_000), { success: false, message: 'Unknown command: /foo' });
  assert.equal((await promptReq(e.c, sid, 'PING')).result.stopReason, 'end_turn');
  await finish(e);
});

test('S6: /compact ⇒ chunk, end_turn, compaction started → completed{summary}, metadata', { skip }, async () => {
  const e = setup();
  const sid = await newSession(e);
  await promptReq(e.c, sid, 'remember cobalt');
  const r = await promptReq(e.c, sid, '/compact');
  assert.deepEqual(r.result, { stopReason: 'end_turn' });
  const started = await e.c.waitFor((f) => f.method === '_kiro.dev/compaction/status' && f.params.status.type === 'started', 15_000);
  const completed = await e.c.waitFor((f) => f.method === '_kiro.dev/compaction/status' && f.params.status.type !== 'started', 15_000);
  assert.ok(e.c.frames.indexOf(started) > e.c.frames.indexOf(r));
  assert.equal(completed.params.status.type, 'completed');
  assert.match(completed.params.summary, /remember cobalt/);
  await e.c.waitFor((f) => f.method === '_kiro.dev/metadata' && e.c.frames.indexOf(f) > e.c.frames.indexOf(completed), 15_000);
  assert.ok(fs.readFileSync(path.join(e.t.kiroHome, 'sessions', 'cli', `${sid}.jsonl`), 'utf8').includes('"kind":"Compaction"'));
  await finish(e);
});

test('S7: session/cancel ⇒ cancelled within 2 s', { skip }, async () => {
  const e = setup();
  const sid = await newSession(e);
  const p = promptReq(e.c, sid, 'SLOW');
  await e.c.waitFor((f) => isUpdate('agent_message_chunk')(f), 15_000);
  const t0 = Date.now();
  e.c.notify('session/cancel', { sessionId: sid });
  const r = await p;
  assert.equal(r.result.stopReason, 'cancelled');
  assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
  assert.equal((await promptReq(e.c, sid, 'PING')).result.stopReason, 'end_turn', 'usable after cancel');
  await finish(e);
});

test('S8 + S9: terminate keeps files; a NEW server loads the session, replays history and remembers it', { skip }, async () => {
  const e = setup();
  const sid = await newSession(e);
  await promptReq(e.c, sid, 'Remember the code word KC-77. Reply OK');
  assert.deepEqual(await e.c.call('_kiro.dev/session/terminate', { sessionId: sid }, 30_000), {});
  const sm = await e.c.request('session/set_mode', { sessionId: sid, modeId: 'kc-probe' });
  assert.deepEqual(sm.error, { code: -32603, message: 'Internal error', data: 'Session not found' });
  await finish(e);
  const dir = path.join(e.t.kiroHome, 'sessions', 'cli');
  assert.ok(fs.existsSync(path.join(dir, `${sid}.json`)) && fs.existsSync(path.join(dir, `${sid}.jsonl`)));

  const c2 = start(e.t, ['--agent-engine', 'v2', '--agent', 'kc-probe']);
  await c2.initialize();
  const resp = await c2.request('session/load', { sessionId: sid, cwd: e.t.work, mcpServers: [], _meta: { '_kiro.dev/session_file': path.join(dir, `${sid}.json`) } }, 30_000);
  assert.ok(resp.result?.modes, JSON.stringify(resp.error));
  assert.equal(resp.result.modes.currentModeId, 'kc-probe');
  assert.ok(resp.result.models);
  const replay = c2.frames.slice(0, c2.frames.indexOf(resp)).filter((f) => f.method === 'session/update').map((f) => f.params.update);
  assert.ok(replay.some((u) => u.sessionUpdate === 'user_message_chunk' && /KC-77/.test(u.content.text)));
  assert.ok(replay.some((u) => u.sessionUpdate === 'agent_message_chunk' && u.content.text === 'OK'));
  const r = await promptReq(c2, sid, 'HISTORY');
  assert.equal(r.result.stopReason, 'end_turn');
  assert.match(c2.updates('agent_message_chunk', sid).map((u) => u.content.text).join(''), /KC-77/, 'Claude resumed the conversation');
  const resumes = fakeLog(e.log).filter((x) => x.event === 'start' && x.argv.includes('--resume'));
  assert.ok(resumes.length >= 1, 'fake log shows --resume');
  assert.equal(await c2.close(20_000), 0);
});

test('S10: several sessions in one process, each with its own child', { skip }, async () => {
  const e = setup();
  await e.c.initialize();
  const ids = await Promise.all([0, 1, 2].map(() => e.c.call('session/new', { cwd: e.t.work, mcpServers: [] }, 30_000).then((r) => r.sessionId as string)));
  const rs = await Promise.all(ids.map((id) => promptReq(e.c, id, 'PING')));
  assert.ok(rs.every((r) => r.result.stopReason === 'end_turn'));
  for (const id of ids) assert.match(e.c.updates('agent_message_chunk', id).map((u) => u.content.text).join(''), /PONG/);
  const children = fakeLog(e.log).filter((x) => x.event === 'start' && x.argv.includes('-p'));
  assert.equal(children.length, 3);
  for (const id of ids.slice(1)) assert.deepEqual(await e.c.call('_kiro.dev/session/terminate', { sessionId: id }, 30_000), {});
  await finish(e);
});

test('S12: steer mid-tool is queued, injected after the tool result, inside the same prompt', { skip }, async () => {
  const e = setup(['--agent', 'kc-allow']);
  const sid = await newSession(e);
  const p = promptReq(e.c, sid, 'STEER');
  await e.c.waitFor(isUpdate('tool_call'), 15_000);
  assert.deepEqual(await e.c.call('_session/steer', { sessionId: sid, message: '<user_message>\nAlso say pineapple.\n</user_message>' }), { queued: true });
  const r = await p;
  assert.equal(r.result.stopReason, 'end_turn');
  const q = e.c.frames.findIndex((f) => f.params?.update?.sessionUpdate === 'AgentExecutionUserMessageQueued');
  const inj = e.c.frames.findIndex((f) => f.params?.update?.sessionUpdate === 'AgentExecutionSteeringInjected');
  assert.ok(q >= 0 && inj > q && inj < e.c.frames.indexOf(r));
  const sent = fakeLog(e.log).filter((x) => x.event === 'stdin' && x.line?.type === 'user' && JSON.stringify(x.line).includes('pineapple'));
  assert.equal(sent.length, 1, 'the steer reached Claude once');
  await finish(e);
});

test('S13: a "tools": [] agent gets no tools (fake argv --tools "") and produces no tool frames', { skip }, async () => {
  const e = setup(['--agent', 'kc-zero']);
  const sid = await newSession(e);
  assert.equal((await promptReq(e.c, sid, 'PING')).result.stopReason, 'end_turn');
  assert.equal(e.c.updates('tool_call').length, 0);
  assert.equal(e.c.frames.filter((f) => f.method === 'session/request_permission').length, 0);
  const argv: string[] = fakeLog(e.log).find((x) => x.event === 'start' && x.argv.includes('-p'))!.argv;
  assert.equal(argv[argv.indexOf('--tools') + 1], '');
  await finish(e);
});

test('subagent inner tool frames are reported under the parent session with parentToolUseId', { skip }, async () => {
  const e = setup(['--agent', 'kc-allow', '--trust-all-tools']);
  const sid = await newSession(e);
  fs.writeFileSync(path.join(e.t.work, 'x.txt'), 'x');
  const r = await promptReq(e.c, sid, 'DELEGATE');
  assert.equal(r.result.stopReason, 'end_turn');
  const inner = e.c.frames.filter((f) => f.method === 'session/update' && f.params.update.toolCallId === 'toolu_inner');
  assert.ok(inner.length >= 1, 'inner tool reported');
  assert.ok(inner.every((f) => f.params.sessionId === sid));
  const tc = inner.find((f) => f.params.update.sessionUpdate === 'tool_call')!;
  assert.equal(tc.params.update._meta.claudeCode.parentToolUseId, 'toolu_agent');
  assert.equal(tc.params.update._meta.kiro.toolName, 'read');
  const agent = e.c.updates('tool_call', sid).find((u) => u.toolCallId === 'toolu_agent')!;
  assert.equal(agent._meta.kiro.toolName, 'use_subagent');
  await finish(e);
});

test('--agent naming a missing spec fails session/new with the file named', { skip }, async () => {
  const e = setup(['--agent', 'kc-missing']);
  await e.c.initialize();
  const r = await e.c.request('session/new', { cwd: e.t.work, mcpServers: [] }, 30_000);
  assert.equal(r.error.code, -32603);
  assert.match(r.error.data, /kc-missing\.json/);
  await finish(e);
});

/**
 * Regression tests for the ACP fix round:
 *  1. a `claude` child that never answers an interrupt (05 §4.6 step 5): the prompt answers
 *     `cancelled` after the grace period AND the session is re-created (`--resume` of the same
 *     Kiro session id, same agent / model / MCP servers), so later prompts on the same id answer;
 *  2. one title function for live `tool_call` frames and `session/load` replay;
 *  3. `usage_update` is refreshed from Claude's `get_context_usage` after every turn;
 *  4. subagent inner MCP calls use the session's Claude ⇄ Kiro MCP server name map;
 *  5. `_kiro.dev/subagent/list_update` is the current list: finished subagents are reported once
 *     as `completed`, then pruned;
 *  6. the stuck-cancel restart resumes the record's per-agent trust and never re-applies the
 *     launch `--trust-tools` to the agent active now (F2);
 *  7. `PromptResponse.usage` and `turnDurationMs` cover every Claude turn of the prompt request
 *     (held-steer and Stop-hook continuations) (F6).
 * Integration tests run the REAL session module with test/fixtures/fake-claude.mjs; the others
 * use the mock session (test/acp/mockSession.ts).
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { KiroSession, KiroSessionOptions, SessionEvent, TurnResult } from '../../src/types.js';
import { LIVE_FS, describeToolCall, toolCallTitle } from '../../src/acp/mapping.js';
import { replayFromJournal, replayFromTranscript } from '../../src/acp/replay.js';
import { toKiroCall } from '../../src/policy/toolmap.js';
import { createWorld, mockFactory, type MockSession, type MockTurn, type MockWorld } from './mockSession.js';
import { TestClient, tmpEnv, until, writeAgent, type Frame, type TmpEnv } from './helpers.js';

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
const promptReq = (c: TestClient, sid: string, text: string, ms = 30_000) => c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text }] }, ms);

/** A client-supplied MCP server whose name Claude has to normalize (`kc.mcp` ⇒ `kc_mcp`). */
const DOTTED_MCP = [{ name: 'kc.mcp', command: 'node', args: ['srv.js'], env: [] }];

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

interface E2E {
  t: TmpEnv;
  c: TestClient;
  log: string;
}

function e2e(script: unknown, extraEnv: Record<string, string> = {}, timings: Record<string, number> = {}): E2E {
  const t = tmpEnv({ FAKE_CLAUDE_SCRIPT_JSON: JSON.stringify(script), FAKE_CLAUDE_PERSIST: '1', ...extraEnv });
  const log = path.join(t.root, 'fake-claude.jsonl');
  t.env.FAKE_CLAUDE_LOG = log;
  writeAgent(path.join(t.work, '.kiro'), 'kc-probe', { description: 'probe', tools: ['*'], allowedTools: [], includeMcpJson: false });
  writeAgent(path.join(t.work, '.kiro'), 'kc-other', { description: 'other', tools: ['*'], allowedTools: [], includeMcpJson: false });
  const c = new TestClient({ args: ['--agent-engine', 'v2', '--agent', 'kc-probe'], env: t.env, cwd: t.work, timings });
  clients.push(c);
  return { t, c, log };
}

/** Stream-mode `claude` starts recorded by the fake (probes such as `--version` excluded). */
const streamStarts = (log: string): Frame[] => fakeLog(log).filter((x) => x.event === 'start' && Array.isArray(x.argv) && x.argv.includes('-p'));

async function finish(e: E2E): Promise<void> {
  assert.equal(await e.c.close(20_000), 0);
  assert.deepEqual(e.c.nonJson, [], 'stdout carries only JSON-RPC frames');
  await until(
    () => streamStarts(e.log).length <= fakeLog(e.log).filter((x) => x.event === 'exit' || x.event === 'sigterm').length,
    10_000,
    'every fake claude child exits',
  );
}

const argAfter = (argv: string[], flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

// ───────────────────────────── 1. hung child after cancel ─────────────────────────────

test('hung child: no result after cancel ⇒ cancelled after the grace period, session re-created with --resume, next prompt answers (05 §4.6 step 5)', { skip, timeout: 90_000 }, async () => {
  const e = e2e(
    {
      turns: [
        { repeat: true, match: 'PING', steps: [{ text: 'PONG' }] },
        { repeat: true, match: 'HANG', steps: [{ text: 'starting' }, { sleepMs: 120_000 }, { text: 'late' }] },
        { repeat: true, match: 'HISTORY', steps: [{ text: 'history: {{historyUserTexts}}' }] },
      ],
    },
    // the child never acts on the interrupt: its answer (and the abort) would come after 2 minutes
    { FAKE_CLAUDE_CONTROL_DELAYS: JSON.stringify({ interrupt: 120_000 }) },
    { cancelGraceMs: 300 },
  );
  await e.c.initialize();
  const sid = (await e.c.call('session/new', { cwd: e.t.work, mcpServers: DOTTED_MCP }, 30_000)).sessionId as string;
  assert.equal((await promptReq(e.c, sid, 'PING')).result.stopReason, 'end_turn');

  const from = e.c.frames.length;
  const hung = promptReq(e.c, sid, 'HANG', 30_000);
  await e.c.waitFor((f) => isUpdate('agent_message_chunk')(f) && f.params.update.content.text.includes('starting'), 20_000, 'HANG started', from);
  const t0 = Date.now();
  e.c.notify('session/cancel', { sessionId: sid });
  const r = await hung;
  assert.deepEqual(r.result, { stopReason: 'cancelled' });
  assert.ok(Date.now() - t0 < 5_000, `cancelled within the grace period (took ${Date.now() - t0} ms)`);

  // the queue is not stuck behind the hung turn: the same session id answers again
  const after1 = e.c.frames.length;
  const p2 = await promptReq(e.c, sid, 'PING', 30_000);
  assert.equal(p2.result?.stopReason, 'end_turn', JSON.stringify(p2));
  const text = e.c.frames
    .slice(after1)
    .filter((f) => isUpdate('agent_message_chunk')(f) && f.params.sessionId === sid)
    .map((f) => f.params.update.content.text)
    .join('');
  assert.ok(text.includes('PONG'), text);
  assert.equal(text.includes('late'), false, 'nothing of the hung turn leaks into the next one');
  assert.deepEqual(e.c.server!.sessionIds, [sid], 'the client keeps its session id');

  // the old child was torn down and a new one resumed the same Claude conversation with the same setup
  const starts = streamStarts(e.log);
  assert.ok(starts.length >= 2, `a second claude child was spawned (${starts.length})`);
  const first = starts[0]!.argv as string[];
  const last = starts[starts.length - 1]!.argv as string[];
  const claudeSid = argAfter(first, '--session-id') ?? argAfter(first, '--resume');
  assert.ok(claudeSid);
  assert.equal(argAfter(last, '--resume'), claudeSid, `resumed the same Claude session: ${JSON.stringify(last)}`);
  assert.ok((argAfter(last, '--mcp-config') ?? '').includes('kc_mcp') || fs.readFileSync(argAfter(last, '--mcp-config')!, 'utf8').includes('kc_mcp'), 'client MCP servers kept');
  const exits = fakeLog(e.log).filter((x) => x.event === 'exit' || x.event === 'sigterm');
  assert.ok(exits.length >= 1, 'the hung child is gone');

  // resumed memory: the conversation (including the cancelled prompt) is still there
  const after2 = e.c.frames.length;
  assert.equal((await promptReq(e.c, sid, 'HISTORY')).result.stopReason, 'end_turn');
  const hist = e.c.frames
    .slice(after2)
    .filter((f) => isUpdate('agent_message_chunk')(f))
    .map((f) => f.params.update.content.text)
    .join('');
  assert.ok(hist.includes('PING') && hist.includes('HANG'), hist);
  await finish(e);
});

/** A mock session whose turn ignores interrupts and the abort signal until it is closed. */
function hangingFactory(world: MockWorld): (opts: KiroSessionOptions) => Promise<KiroSession> {
  const base = mockFactory(world);
  return async (opts) => {
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
    };
    s.prompt = async function* (): AsyncGenerator<SessionEvent, TurnResult> {
      const ev: SessionEvent = { type: 'text_delta', text: 'starting' };
      s.emit('event', ev);
      yield ev;
      await closed;
      throw new Error('Claude Code exited (code 143)');
    };
    return s;
  };
}

test('hung child (mock): the replacement keeps the session id, current agent / model / effort, client MCP servers and additional dirs', { timeout: 30_000 }, async () => {
  const t = tmpEnv();
  writeAgent(path.join(t.work, '.kiro'), 'probe', { description: 'probe', tools: ['*'], includeMcpJson: false });
  writeAgent(path.join(t.work, '.kiro'), 'other', { description: 'other', tools: ['*'], includeMcpJson: false });
  const extraDir = path.join(t.root, 'extra');
  fs.mkdirSync(extraDir);
  const world = createWorld([{ match: /PING/, steps: [{ text: 'PONG' }] }]);
  const c = new TestClient({ args: ['--agent', 'probe'], env: t.env, cwd: t.work, createSession: hangingFactory(world), timings: { cancelGraceMs: 100 } });
  clients.push(c);
  await c.initialize();
  const sid = (await c.call('session/new', { cwd: t.work, mcpServers: DOTTED_MCP, additionalDirectories: [extraDir] })).sessionId as string;
  await c.call('session/set_mode', { sessionId: sid, modeId: 'other' });
  await c.call('session/set_model', { sessionId: sid, modelId: 'claude-sonnet-5.5' });
  await c.call('session/set_config_option', { sessionId: sid, configId: 'effortLevel', value: 'high' });

  const hung = promptReq(c, sid, 'HANG', 10_000);
  await c.waitFor((f) => isUpdate('agent_message_chunk')(f) && f.params.update.content.text === 'starting', 5_000, 'hung turn started');
  c.notify('session/cancel', { sessionId: sid });
  assert.deepEqual((await hung).result, { stopReason: 'cancelled' });

  const r = await promptReq(c, sid, 'PING', 10_000);
  assert.equal(r.result?.stopReason, 'end_turn', JSON.stringify(r));
  assert.equal(world.sessions.length, 2, 'one replacement session');
  assert.equal(world.sessions[0]!.closed, true, 'the stuck session (and its child) was closed');
  const o0 = world.created[0]!;
  const o1 = world.created[1]!;
  assert.deepEqual(o1.resume, { sessionId: sid });
  assert.equal(o1.agentName, 'other');
  assert.equal(o1.model, 'claude-sonnet-5.5');
  assert.equal(o1.effort, 'high');
  assert.equal(o1.origin, 'acp');
  assert.equal(o1.interactive, true);
  assert.equal(o1.ws.cwd, t.work);
  assert.deepEqual(o1.extraMcpServers, o0.extraMcpServers);
  assert.deepEqual(o1.additionalDirectories, [extraDir]);
  assert.equal(o1.ui, o0.ui, 'the same permission bridge');
  // events of the replacement are mapped under the same id
  assert.ok(c.frames.some((f) => isUpdate('agent_message_chunk')(f) && f.params.sessionId === sid && f.params.update.content.text === 'PONG'));
  assert.deepEqual(c.server!.sessionIds, [sid]);
  assert.equal(await c.close(), 0);
  assert.equal(world.sessions[1]!.closed, true, 'the replacement is closed at shutdown');
});

test('hung child (mock): a failed re-creation is reported to the next prompt instead of hanging', { timeout: 30_000 }, async () => {
  const t = tmpEnv();
  writeAgent(path.join(t.work, '.kiro'), 'probe', { description: 'probe', tools: ['*'], includeMcpJson: false });
  const world = createWorld([]);
  const hanging = hangingFactory(world);
  const factory = async (opts: KiroSessionOptions): Promise<KiroSession> => {
    if (world.sessions.length >= 1) throw new Error('Failed to start session: boom');
    return hanging(opts);
  };
  const c = new TestClient({ args: ['--agent', 'probe'], env: t.env, cwd: t.work, createSession: factory, timings: { cancelGraceMs: 100 } });
  clients.push(c);
  await c.initialize();
  const sid = (await c.call('session/new', { cwd: t.work, mcpServers: [] })).sessionId as string;
  const hung = promptReq(c, sid, 'HANG', 10_000);
  await c.waitFor((f) => isUpdate('agent_message_chunk')(f), 5_000, 'hung turn started');
  c.notify('session/cancel', { sessionId: sid });
  assert.deepEqual((await hung).result, { stopReason: 'cancelled' });
  const r = await promptReq(c, sid, 'again', 10_000);
  assert.ok(r.error, JSON.stringify(r));
  assert.match(JSON.stringify(r.error), /Failed to start the session: .*boom/);
  assert.equal(await c.close(), 0);
});

// ───────────────────────────── 2. tool titles: live == replay ─────────────────────────────

test('tool titles are identical live and on session/load replay (Write/Edit/Bash/Read/Glob/Grep/WebFetch/MCP)', { skip, timeout: 90_000 }, async () => {
  const e = e2e({
    turns: [
      {
        match: 'TOOLS',
        steps: [
          { tool: { id: 'toolu_write', name: 'Write', input: { file_path: '{{cwd}}/acp.txt', content: 'hello' } } },
          { tool: { id: 'toolu_edit', name: 'Edit', input: { file_path: '{{cwd}}/acp.txt', old_string: 'hello', new_string: 'bye' } } },
          { tool: { id: 'toolu_bash', name: 'Bash', input: { command: 'ls -la', description: 'List files' }, result: 'x', tool_use_result: { stdout: 'x\n', stderr: '', interrupted: false } } },
          { tool: { id: 'toolu_read', name: 'Read', input: { file_path: '{{cwd}}/acp.txt', offset: 3 } } },
          { tool: { id: 'toolu_glob', name: 'Glob', input: { pattern: '**/*.ts' } } },
          { tool: { id: 'toolu_grep', name: 'Grep', input: { pattern: 'foo', path: 'src' } } },
          { tool: { id: 'toolu_fetch', name: 'WebFetch', input: { url: 'https://example.com/a', prompt: 'summarize' } } },
          { tool: { id: 'toolu_mcp', name: 'mcp__kc_mcp__echo', input: { text: 'x' }, result: 'echo x' } },
          { text: 'all done' },
        ],
      },
    ],
  });
  await e.c.initialize();
  const sid = (await e.c.call('session/new', { cwd: e.t.work, mcpServers: DOTTED_MCP }, 30_000)).sessionId as string;
  await e.c.waitFor((f) => f.method === '_kiro.dev/mcp/server_initialized', 15_000, 'mcp up');
  assert.equal((await promptReq(e.c, sid, 'TOOLS')).result.stopReason, 'end_turn');
  const live = new Map<string, string>();
  for (const u of e.c.updates('tool_call', sid)) if (!u._meta?.kiro?.replay) live.set(u.toolCallId, u.title);
  assert.equal(live.size, 8, JSON.stringify([...live]));
  assert.equal(live.get('toolu_write'), 'Creating acp.txt');
  assert.equal(live.get('toolu_mcp'), 'Running: @kc.mcp/echo');

  await e.c.call('_kiro.dev/session/terminate', { sessionId: sid });
  const from = e.c.frames.length;
  await e.c.call('session/load', { sessionId: sid, cwd: e.t.work, mcpServers: DOTTED_MCP }, 30_000);
  const replay = new Map<string, string>();
  for (const f of e.c.frames.slice(from)) {
    if (isUpdate('tool_call')(f) && f.params.update._meta?.kiro?.replay === true) replay.set(f.params.update.toolCallId, f.params.update.title);
  }
  assert.deepEqual(Object.fromEntries(replay), Object.fromEntries(live));
  await finish(e);
});

test('one title function: live (with fs probes, existing or new file) and replay (journal / transcript) agree', () => {
  const t = tmpEnv();
  fs.writeFileSync(path.join(t.work, 'exists.txt'), 'old');
  const names = { kc_mcp: 'kc.mcp' };
  const calls: [string, string, Record<string, unknown>][] = [
    ['w_new', 'Write', { file_path: path.join(t.work, 'new.txt'), content: 'a' }],
    ['w_old', 'Write', { file_path: path.join(t.work, 'exists.txt'), content: 'b' }],
    ['e', 'Edit', { file_path: 'exists.txt', old_string: 'old', new_string: 'b' }],
    ['b', 'Bash', { command: 'make test', description: 'Run tests' }],
    ['r', 'Read', { file_path: path.join(t.work, 'exists.txt') }],
    ['g', 'Glob', { pattern: '*.md', path: 'docs' }],
    ['s', 'Grep', { pattern: 'TODO' }],
    ['f', 'WebFetch', { url: 'https://example.com', prompt: 'x' }],
    ['m', 'mcp__kc_mcp__echo', { text: 'x' }],
  ];
  const live = Object.fromEntries(
    calls.map(([id, name, input]) => [id, describeToolCall(toKiroCall(name, input, { cwd: t.work, toolUseId: id, mcpServerNames: names }), { cwd: t.work, fs: LIVE_FS }).title]),
  );
  assert.equal(live.w_new, 'Creating new.txt');
  assert.equal(live.w_old, 'Creating exists.txt', 'existence does not change the title');
  assert.equal(live.m, 'Running: @kc.mcp/echo');
  for (const [id, name, input] of calls) assert.equal(toolCallTitle(toKiroCall(name, input, { cwd: t.work, mcpServerNames: names }), t.work), live[id]);
  const journal = [{ kind: 'AssistantMessage', data: { content: calls.map(([id, name, input]) => ({ kind: 'toolUse', data: { toolUseId: id, name, input } })) } }];
  const fromJournal = Object.fromEntries(replayFromJournal(journal, t.work, { mcpServerNames: names }).filter((u) => u.sessionUpdate === 'tool_call').map((u) => [u.toolCallId, u.title]));
  assert.deepEqual(fromJournal, live);
  const transcript = [{ type: 'assistant', message: { content: calls.map(([id, name, input]) => ({ type: 'tool_use', id, name, input })) } }];
  const fromTranscript = Object.fromEntries(replayFromTranscript(transcript, t.work, { mcpServerNames: names }).filter((u) => u.sessionUpdate === 'tool_call').map((u) => [u.toolCallId, u.title]));
  assert.deepEqual(fromTranscript, live);
});

// ───────────────────────────── 3. usage_update freshness ─────────────────────────────

test('usage_update.used is refreshed from get_context_usage after every turn', { skip, timeout: 60_000 }, async () => {
  const e = e2e({
    turns: [
      { repeat: true, match: 'PING', steps: [{ text: 'PONG' }] },
      {
        repeat: true,
        match: 'ECHO',
        steps: [{ tool: { name: 'Bash', input: { command: 'echo hi' }, result: 'hi', tool_use_result: { stdout: 'hi\n', stderr: '', interrupted: false } } }, { text: 'saw {{lastToolResult}}' }],
      },
    ],
  });
  await e.c.initialize();
  const sid = (await e.c.call('session/new', { cwd: e.t.work, mcpServers: [] }, 30_000)).sessionId as string;
  const used: number[] = [];
  for (const text of ['PING', 'ECHO', 'PING']) {
    const from = e.c.frames.length;
    const r = await promptReq(e.c, sid, text);
    assert.equal(r.result.stopReason, 'end_turn');
    const ups = e.c.frames.slice(from, e.c.frames.indexOf(r)).filter(isUpdate('usage_update'));
    assert.equal(ups.length, 1, `one usage_update before the ${text} response`);
    used.push(ups[0]!.params.update.used as number);
    assert.ok(ups[0]!.params.update.size > 0);
  }
  assert.ok(used[0]! < used[1]! && used[1]! < used[2]!, `used grows turn by turn: ${used.join(' → ')}`);
  const asked = fakeLog(e.log).filter((x) => x.event === 'stdin' && x.line?.request?.subtype === 'get_context_usage').length;
  assert.ok(asked >= 3, `get_context_usage asked after every turn (${asked})`);
  await finish(e);
});

// ───────────────────────────── 4. subagent inner MCP names ─────────────────────────────

test('subagent inner MCP calls use the session MCP name map (Claude kc_mcp ⇒ Kiro kc.mcp)', { skip, timeout: 60_000 }, async () => {
  const e = e2e({
    turns: [
      {
        match: 'DELEGATE',
        steps: [
          { tool: { id: 'toolu_agent', name: 'Agent', input: { description: 'Look around', prompt: 'look', subagent_type: 'general-purpose' }, result: 'report' } },
          { tool: { id: 'toolu_inner_mcp', name: 'mcp__kc_mcp__echo', input: { text: 'x' }, result: 'echo x', parent_tool_use_id: 'toolu_agent', agent_id: 'a1', agent_type: 'general-purpose' } },
          { text: 'delegated' },
        ],
      },
    ],
  });
  await e.c.initialize();
  const sid = (await e.c.call('session/new', { cwd: e.t.work, mcpServers: DOTTED_MCP }, 30_000)).sessionId as string;
  await e.c.waitFor((f) => f.method === '_kiro.dev/mcp/server_initialized', 15_000, 'mcp up');
  assert.equal((await promptReq(e.c, sid, 'DELEGATE')).result.stopReason, 'end_turn');
  const tc = e.c.updates('tool_call', sid).find((u) => u.toolCallId === 'toolu_inner_mcp');
  assert.ok(tc, 'inner MCP tool_call reported');
  assert.equal(tc.title, 'Running: @kc.mcp/echo');
  assert.deepEqual(tc._meta, { kiro: { toolName: 'echo', mcpServerName: 'kc.mcp' }, claudeCode: { toolName: 'mcp__kc_mcp__echo', parentToolUseId: 'toolu_agent' } });
  await finish(e);
});

// ───────────────────────────── 5. subagent list pruning ─────────────────────────────

test('_kiro.dev/subagent/list_update lists current subagents: a finished one is reported once, then pruned', async () => {
  const t = tmpEnv();
  writeAgent(path.join(t.work, '.kiro'), 'probe', { description: 'probe', tools: ['*'], includeMcpJson: false });
  const turns: MockTurn[] = [
    {
      match: /first/,
      steps: [
        { subagent: { state: 'started', agentType: 'reviewer', toolUseId: 't1' } },
        { subagent: { state: 'finished', agentType: 'reviewer', toolUseId: 't1' } },
        { subagent: { state: 'started', agentType: 'writer', toolUseId: 't2' } },
        { subagent: { state: 'started', agentType: 'tester', toolUseId: 't3' } },
        { subagent: { state: 'finished', agentType: 'writer', toolUseId: 't2' } },
        { text: 'ok' },
      ],
    },
    { match: /second/, steps: [{ subagent: { state: 'started', agentType: 'again', toolUseId: 't4' } }, { text: 'ok' }] },
  ];
  const world = createWorld(turns);
  const c = new TestClient({ args: ['--agent', 'probe'], env: t.env, cwd: t.work, createSession: mockFactory(world) });
  clients.push(c);
  await c.initialize();
  const sid = (await c.call('session/new', { cwd: t.work, mcpServers: [] })).sessionId as string;
  await promptReq(c, sid, 'first');
  // KiroCrew keys entries on `sessionId` and reads `status` as {type,message} (review C4)
  const lists = () => c.notifications('_kiro.dev/subagent/list_update').map((f) => (f.params.subagents as Frame[]).map((s) => `${s.sessionId}:${s.status.type}`));
  assert.deepEqual(lists(), [
    ['t1:working'],
    ['t1:completed'],
    ['t2:working'],
    ['t2:working', 't3:working'],
    ['t2:completed', 't3:working'],
    // the turn ended with t3 never finishing: it is gone from the next (and last) list
    [],
  ]);
  await promptReq(c, sid, 'second');
  assert.deepEqual(lists().slice(6), [['t4:working'], []]);
  assert.equal(await c.close(), 0);
});

// ───────────────────────────── 6. stuck-cancel restart keeps per-agent trust (F2) ─────────────────────────────

/** `--trust-tools shell` on kc-a; kc-a and kc-b both ask for everything else (`allowedTools: []`). */
function trustE2E(answer: () => string = () => 'allow_once'): E2E & { asks: () => number } {
  const t = tmpEnv({
    FAKE_CLAUDE_SCRIPT_JSON: JSON.stringify({
      turns: [
        { repeat: true, match: 'RUN', steps: [{ tool: { name: 'Bash', input: { command: 'echo hi' } } }, { text: 'ran' }] },
        { repeat: true, match: 'HANG', steps: [{ text: 'starting' }, { sleepMs: 120_000 }, { text: 'late' }] },
      ],
    }),
    FAKE_CLAUDE_PERSIST: '1',
    // the child never acts on the interrupt (05 §4.6 step 5 path)
    FAKE_CLAUDE_CONTROL_DELAYS: JSON.stringify({ interrupt: 120_000 }),
  });
  const log = path.join(t.root, 'fake-claude.jsonl');
  t.env.FAKE_CLAUDE_LOG = log;
  writeAgent(path.join(t.work, '.kiro'), 'kc-a', { description: 'a', tools: ['*'], allowedTools: [], includeMcpJson: false });
  writeAgent(path.join(t.work, '.kiro'), 'kc-b', { description: 'b', tools: ['*'], allowedTools: [], includeMcpJson: false });
  let asks = 0;
  const c = new TestClient({
    args: ['--agent-engine', 'v2', '--agent', 'kc-a', '--trust-tools', 'shell'],
    env: t.env,
    cwd: t.work,
    timings: { cancelGraceMs: 300 },
    onPermission: () => {
      asks++;
      return { outcome: { outcome: 'selected', optionId: answer() } };
    },
  });
  clients.push(c);
  return { t, c, log, asks: () => asks };
}

async function runShell(c: TestClient, sid: string): Promise<void> {
  const r = await promptReq(c, sid, 'RUN');
  assert.equal(r.result?.stopReason, 'end_turn', JSON.stringify(r));
}

async function hangAndCancel(c: TestClient, sid: string): Promise<void> {
  const from = c.frames.length;
  const hung = promptReq(c, sid, 'HANG');
  await c.waitFor((f) => isUpdate('agent_message_chunk')(f) && f.params.update.content.text.includes('starting'), 20_000, 'HANG started', from);
  c.notify('session/cancel', { sessionId: sid });
  assert.deepEqual((await hung).result, { stopReason: 'cancelled' });
}

test('stuck-cancel restart does not re-apply the launch --trust-tools to the agent set_mode switched to (F2)', { skip, timeout: 90_000 }, async () => {
  const e = trustE2E();
  await e.c.initialize();
  const sid = (await e.c.call('session/new', { cwd: e.t.work, mcpServers: [] }, 30_000)).sessionId as string;
  await runShell(e.c, sid);
  assert.equal(e.asks(), 0, 'kc-a: shell trusted by --trust-tools');
  await e.c.call('session/set_mode', { sessionId: sid, modeId: 'kc-b' }, 30_000);
  await runShell(e.c, sid);
  assert.equal(e.asks(), 1, 'kc-b: shell asks (per-agent trust)');

  await hangAndCancel(e.c, sid);
  await runShell(e.c, sid); // the first prompt on the re-created session
  assert.ok(streamStarts(e.log).some((s) => (s.argv as string[]).includes('--resume')), 'Claude Code was restarted with --resume');
  assert.equal(e.asks(), 2, 'kc-b after the restart: shell still asks');
  const rec = JSON.parse(fs.readFileSync(path.join(e.t.kiroHome, 'sessions', 'cli', `${sid}.json`), 'utf8')) as Frame;
  assert.equal(rec.agent, 'kc-b');
  assert.ok(!(rec.trust.allowedTools as string[]).includes('execute_bash'), `kc-b's own trust is untouched: ${JSON.stringify(rec.trust)}`);
  assert.ok((rec.trust.byAgent['kc-a'].allowedTools as string[]).includes('execute_bash'), 'kc-a keeps its --trust-tools trust');
  await e.c.call('session/set_mode', { sessionId: sid, modeId: 'kc-a' }, 30_000);
  await runShell(e.c, sid);
  assert.equal(e.asks(), 2, 'back on kc-a: shell is still trusted');
  await finish(e);
});

test('stuck-cancel restart of the first prompt keeps the launch --trust-tools trust (it comes back with the record) (F2)', { skip, timeout: 90_000 }, async () => {
  const e = trustE2E();
  await e.c.initialize();
  const sid = (await e.c.call('session/new', { cwd: e.t.work, mcpServers: [] }, 30_000)).sessionId as string;
  await hangAndCancel(e.c, sid);
  await runShell(e.c, sid);
  assert.equal(e.asks(), 0, 'kc-a after the restart: shell still trusted');
  await finish(e);
});

test('stuck-cancel restart keeps an allow_always grant made under the set_mode agent (it comes back with the record) (F2)', { skip, timeout: 90_000 }, async () => {
  let answer = 'allow_always';
  const e = trustE2E(() => answer);
  await e.c.initialize();
  const sid = (await e.c.call('session/new', { cwd: e.t.work, mcpServers: [] }, 30_000)).sessionId as string;
  await e.c.call('session/set_mode', { sessionId: sid, modeId: 'kc-b' }, 30_000);
  await runShell(e.c, sid);
  assert.equal(e.asks(), 1, 'kc-b asks once: allow_always');
  answer = 'allow_once';
  await hangAndCancel(e.c, sid);
  await runShell(e.c, sid);
  assert.equal(e.asks(), 1, 'kc-b after the restart: the allow_always grant still holds');
  await e.c.call('session/set_mode', { sessionId: sid, modeId: 'kc-a' }, 30_000);
  await runShell(e.c, sid);
  assert.equal(e.asks(), 1, 'kc-a: still trusted by --trust-tools');
  await finish(e);
});

test('hung child (mock): the replacement resumes without the launch --trust-tools (the record carries per-agent trust) (F2)', { timeout: 30_000 }, async () => {
  const t = tmpEnv();
  writeAgent(path.join(t.work, '.kiro'), 'probe', { description: 'probe', tools: ['*'], includeMcpJson: false });
  const world = createWorld([{ match: /PING/, steps: [{ text: 'PONG' }] }]);
  const c = new TestClient({ args: ['--agent', 'probe', '--trust-tools', 'shell,read'], env: t.env, cwd: t.work, createSession: hangingFactory(world), timings: { cancelGraceMs: 100 } });
  clients.push(c);
  await c.initialize();
  const sid = (await c.call('session/new', { cwd: t.work, mcpServers: [] })).sessionId as string;
  const hung = promptReq(c, sid, 'HANG', 10_000);
  await c.waitFor((f) => isUpdate('agent_message_chunk')(f) && f.params.update.content.text === 'starting', 5_000, 'hung turn started');
  c.notify('session/cancel', { sessionId: sid });
  assert.deepEqual((await hung).result, { stopReason: 'cancelled' });
  assert.equal((await promptReq(c, sid, 'PING', 10_000)).result?.stopReason, 'end_turn');
  assert.deepEqual(world.created[0]!.trustTools, ['shell', 'read'], 'a new session gets the launch flag');
  assert.deepEqual(world.created[1]!.resume, { sessionId: sid });
  assert.equal(world.created[1]!.trustTools, undefined, 'the resumed record is not re-trusted with the launch flag');
  assert.equal(await c.close(), 0);
});

// ───────────────────────────── 7. prompt usage / duration cover every Claude turn (F6) ─────────────────────────────

const U = (input: number, output: number, read = 0, write = 0) => ({ inputTokens: input, outputTokens: output, cacheReadTokens: read, cacheCreationTokens: write });

test('held-steer continuation (mock): PromptResponse.usage sums every Claude turn of the prompt; turnDurationMs is the prompt wall time (F6)', { timeout: 30_000 }, async () => {
  const t = tmpEnv();
  writeAgent(path.join(t.work, '.kiro'), 'probe', { description: 'probe', tools: ['*'], includeMcpJson: false });
  const world = createWorld([
    { match: /pineapple/, steps: [{ text: 'second' }, { raw: { type: 'result', subtype: 'success', duration_ms: 1 } }, { result: { usage: U(200, 3, 50, 5) } }] },
    { steps: [{ sleepMs: 250 }, { text: 'first' }, { raw: { type: 'result', subtype: 'success', duration_ms: 2 } }, { result: { usage: U(100, 15, 10, 1) } }] },
  ]);
  const c = new TestClient({ args: ['--agent', 'probe'], env: t.env, cwd: t.work, createSession: mockFactory(world) });
  clients.push(c);
  await c.initialize();
  const sid = (await c.call('session/new', { cwd: t.work, mcpServers: [] })).sessionId as string;
  const t0 = Date.now();
  const p = promptReq(c, sid, 'go', 10_000);
  await until(() => world.sessions[0]!.turnCount === 1, 5_000, 'first turn');
  await c.call('_session/steer', { sessionId: sid, message: 'say pineapple' });
  const r = await p;
  const wall = Date.now() - t0;
  assert.equal(r.result.stopReason, 'end_turn');
  assert.equal(world.sessions[0]!.turnCount, 2, 'the held steer ran as a continuation');
  assert.deepEqual(r.result.usage, { totalTokens: 300 + 18 + 60 + 6, inputTokens: 300, outputTokens: 18, cachedReadTokens: 60, cachedWriteTokens: 6 });
  const durs = c.notifications('_kiro.dev/metadata').filter((f) => 'turnDurationMs' in f.params).map((f) => f.params.turnDurationMs as number);
  assert.equal(durs.length, 1);
  assert.ok(durs[0]! >= 200 && durs[0]! <= wall, `turnDurationMs ${durs[0]} is the prompt's duration (wall ${wall} ms), not the last Claude result's duration_ms`);
  assert.equal(await c.close(), 0);
});

/** `result` frames the fake claude wrote (FAKE_CLAUDE_LOG_STDOUT=1): what Claude reported per turn. */
const fakeResults = (log: string): Frame[] => fakeLog(log).filter((x) => x.event === 'stdout' && x.frame?.type === 'result').map((x) => x.frame as Frame);
const sumOf = (rs: Frame[], k: string): number => rs.reduce((a, r) => a + ((r.usage?.[k] as number | undefined) ?? 0), 0);

test('held-steer continuation (real session): PromptResponse.usage and turnDurationMs cover both Claude turns (F6)', { skip, timeout: 60_000 }, async () => {
  const e = e2e(
    {
      turns: [
        { match: '^TASK', steps: [{ text: 'first part of a long answer here' }, { sleepMs: 600 }, { text: 'and the rest of it' }] },
        { match: 'PAPAYA', steps: [{ text: 'PAPAYA' }] },
      ],
    },
    { FAKE_CLAUDE_LOG_STDOUT: '1' },
  );
  await e.c.initialize();
  const sid = (await e.c.call('session/new', { cwd: e.t.work, mcpServers: [] }, 30_000)).sessionId as string;
  const t0 = Date.now();
  const p = promptReq(e.c, sid, 'TASK: answer');
  await e.c.waitFor(isUpdate('agent_message_chunk'), 15_000, 'first chunk');
  assert.deepEqual(await e.c.call('_session/steer', { sessionId: sid, message: 'say PAPAYA' }), { queued: true });
  const r = await p;
  const wall = Date.now() - t0;
  assert.equal(r.result.stopReason, 'end_turn');
  const results = fakeResults(e.log);
  assert.equal(results.length, 2, 'two Claude turns ran for this prompt');
  assert.match(e.c.updates('agent_message_chunk', sid).map((u) => u.content.text).join(''), /PAPAYA/);
  assert.equal(r.result.usage.outputTokens, sumOf(results, 'output_tokens'));
  assert.equal(r.result.usage.inputTokens, sumOf(results, 'input_tokens'));
  const durs = e.c.notifications('_kiro.dev/metadata').filter((f) => 'turnDurationMs' in f.params).map((f) => f.params.turnDurationMs as number);
  const claudeMs = results.reduce((a, x) => a + (x.duration_ms as number), 0);
  assert.ok(durs.at(-1)! >= claudeMs && durs.at(-1)! <= wall, `turnDurationMs ${durs.at(-1)} covers both Claude turns (${results.map((x) => x.duration_ms)}; wall ${wall})`);
  await finish(e);
});

test('Stop-hook continuation (real session): PromptResponse.usage covers both Claude turns (F6)', { skip, timeout: 60_000 }, async () => {
  const e = e2e(
    {
      turns: [
        { match: '^start', steps: [{ text: 'first answer with several words in it' }] },
        { match: '^keep going', steps: [{ text: 'continued' }] },
      ],
    },
    { FAKE_CLAUDE_LOG_STDOUT: '1' },
  );
  const marker = path.join(e.t.root, 'stop-once');
  fs.mkdirSync(path.join(e.t.work, '.kiro', 'hooks'), { recursive: true });
  fs.writeFileSync(
    path.join(e.t.work, '.kiro', 'hooks', 'stop.json'),
    JSON.stringify({ version: 'v1', hooks: [{ name: 'more', trigger: 'Stop', action: { type: 'command', command: `if [ ! -f ${marker} ]; then touch ${marker}; echo '{"decision":"block","reason":"keep going"}'; fi` } }] }),
  );
  await e.c.initialize();
  const sid = (await e.c.call('session/new', { cwd: e.t.work, mcpServers: [] }, 30_000)).sessionId as string;
  const r = await promptReq(e.c, sid, 'start');
  assert.equal(r.result.stopReason, 'end_turn');
  const results = fakeResults(e.log);
  assert.equal(results.length, 2, 'two Claude turns ran for this prompt (Stop-hook continuation)');
  assert.equal(r.result.usage.outputTokens, sumOf(results, 'output_tokens'));
  assert.equal(r.result.usage.inputTokens, sumOf(results, 'input_tokens'));
  await finish(e);
});

test('Stop-hook continuation AND a held-steer continuation in one prompt: PromptResponse.usage and turnDurationMs cover all three Claude turns (F6)', { skip, timeout: 60_000 }, async () => {
  const e = e2e(
    {
      turns: [
        { match: '^start', steps: [{ text: 'first part of a long answer here' }, { sleepMs: 600 }, { text: 'and the rest of it' }] },
        { match: '^keep going', steps: [{ text: 'continued after the hook' }] },
        { match: 'PAPAYA', steps: [{ text: 'PAPAYA' }] },
      ],
    },
    { FAKE_CLAUDE_LOG_STDOUT: '1' },
  );
  const marker = path.join(e.t.root, 'stop-once');
  fs.mkdirSync(path.join(e.t.work, '.kiro', 'hooks'), { recursive: true });
  fs.writeFileSync(
    path.join(e.t.work, '.kiro', 'hooks', 'stop.json'),
    JSON.stringify({ version: 'v1', hooks: [{ name: 'more', trigger: 'Stop', action: { type: 'command', command: `if [ ! -f ${marker} ]; then touch ${marker}; echo '{"decision":"block","reason":"keep going"}'; fi` } }] }),
  );
  await e.c.initialize();
  const sid = (await e.c.call('session/new', { cwd: e.t.work, mcpServers: [] }, 30_000)).sessionId as string;
  const t0 = Date.now();
  const p = promptReq(e.c, sid, 'start now');
  await e.c.waitFor(isUpdate('agent_message_chunk'), 15_000, 'first chunk');
  assert.deepEqual(await e.c.call('_session/steer', { sessionId: sid, message: 'say PAPAYA' }), { queued: true });
  const r = await p;
  const wall = Date.now() - t0;
  assert.equal(r.result.stopReason, 'end_turn');
  const results = fakeResults(e.log);
  assert.equal(results.length, 3, 'the first turn, the Stop-hook continuation and the held-steer continuation');
  assert.match(e.c.updates('agent_message_chunk', sid).map((u) => u.content.text).join(''), /continued after the hook[\s\S]*PAPAYA/);
  assert.equal(r.result.usage.outputTokens, sumOf(results, 'output_tokens'), 'each Claude turn counted once');
  assert.equal(r.result.usage.inputTokens, sumOf(results, 'input_tokens'));
  const durs = e.c.notifications('_kiro.dev/metadata').filter((f) => 'turnDurationMs' in f.params).map((f) => f.params.turnDurationMs as number);
  const claudeMs = results.reduce((a, x) => a + (x.duration_ms as number), 0);
  assert.ok(durs.at(-1)! >= claudeMs && durs.at(-1)! <= wall, `turnDurationMs ${durs.at(-1)} (Claude ${results.map((x) => x.duration_ms)}; wall ${wall})`);
  await finish(e);
});

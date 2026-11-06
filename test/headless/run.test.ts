import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import { HEADLESS_DENIAL, NO_INPUT_ERROR, notLoggedInMessage, runHeadless, waitForMcpStartup } from '../../src/headless/run.js';
import { HEADLESS_USAGE_TEXT, classifyHeadlessInput, renderToolListing } from '../../src/headless/local.js';
import { formatToolDuration } from '../../src/headless/render.js';
import { makeCtx, makeEnv, type TestEnv } from '../cli/helpers.js';
import { call, mockFactory, type MockScript } from './mockSession.js';

let t: TestEnv;
beforeEach(() => {
  t = makeEnv();
});
afterEach(() => t.cleanup());

async function headless(
  input: string,
  script: MockScript = {},
  opts: { stdin?: string; stdinTTY?: boolean; outputFormat?: 'text' | 'stream-json'; requireMcpStartup?: boolean; mcpStartupTimeoutMs?: number } = {},
) {
  const { ctx, stdout, stderr } = makeCtx(t, { ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}), stdinTTY: opts.stdinTTY ?? false });
  const f = mockFactory(script);
  const code = await runHeadless({
    ctx,
    sessionOptions: { agentName: 'kiro_default', env: t.env },
    input,
    createSession: f.create,
    ...(opts.outputFormat ? { outputFormat: opts.outputFormat } : {}),
    ...(opts.requireMcpStartup ? { requireMcpStartup: true } : {}),
    ...(opts.mcpStartupTimeoutMs !== undefined ? { mcpStartupTimeoutMs: opts.mcpStartupTimeoutMs, mcpPollMs: 5 } : {}),
  });
  return { code, stdout: stdout.text, stderr: stderr.text, calls: f.calls };
}

test('assistant text goes to stdout (streamed), tool lines to stderr', async () => {
  const c = call();
  const r = await headless('list files', {
    events: [
      { type: 'text_delta', text: 'Let me ' },
      { type: 'text_delta', text: 'look.' },
      { type: 'tool_start', toolUseId: 'toolu_1', call: c, trusted: true },
      { type: 'tool_end', toolUseId: 'toolu_1', call: c, isError: false, output: 'a\nb', durationMs: 1234 },
      { type: 'text', text: 'Done.' },
    ],
    result: { text: 'Done.' },
  });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'Let me look.\nDone.\n');
  assert.equal(
    r.stderr,
    '\n🛠️  Using tool: shell (trusted)\n ⋮ \n ● I will run the following shell command: ls -la\n ⋮ \n ↳ Purpose: List files\n ⋮ \n ● Completed in 1.234s\n\n',
  );
  assert.equal(r.calls.prompts.length, 1);
  assert.equal(r.calls.prompts[0]!.text, 'list files');
  assert.equal(r.calls.closed, 1);
  const o = r.calls.created[0]!;
  assert.equal(o.interactive, false);
  assert.equal(o.origin, 'headless');
  assert.equal(o.agentName, 'kiro_default');
  assert.equal(o.ws.cwd, t.cwd);
});

test('failed tool, denied tool (failed end suppressed), MCP display', async () => {
  const mcpCall = call({ claudeName: 'mcp__fetch__get', mcp: { server: 'fetch', tool: 'get' }, displayName: 'get', summary: 'Running get', input: {} });
  const r = await headless('go', {
    events: [
      { type: 'tool_start', toolUseId: 't1', call: mcpCall, trusted: false },
      { type: 'tool_end', toolUseId: 't1', isError: true, output: 'boom', durationMs: 5 },
      { type: 'tool_start', toolUseId: 't2', call: call(), trusted: false },
      { type: 'tool_denied', toolUseId: 't2', call: call(), reason: HEADLESS_DENIAL },
      { type: 'tool_end', toolUseId: 't2', isError: true, output: 'PreToolUse:Bash hook error: x' },
    ],
  });
  assert.equal(r.code, 0);
  assert.ok(r.stderr.includes('🛠️  Using tool: get from mcp server fetch\n ⋮ \n ● Running get\n ⋮ \n ● Execution failed after 0.5s:\nboom\n\n'));
  assert.ok(r.stderr.includes(` ⋮ \n ● Denied: ${HEADLESS_DENIAL}\n\n`));
  assert.ok(!r.stderr.includes('PreToolUse:Bash hook error'));
  assert.equal(r.stdout, '');
});

test('formatToolDuration keeps Q millis quirk', () => {
  assert.equal(formatToolDuration(5), '0.5s');
  assert.equal(formatToolDuration(50), '0.50s');
  assert.equal(formatToolDuration(1234), '1.234s');
  assert.equal(formatToolDuration(2000), '2.0s');
});

test('result text is printed when nothing was streamed', async () => {
  const r = await headless('/cost', { result: { text: 'Total cost: $0.00', stopReason: 'local_command' } });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'Total cost: $0.00\n');
});

test('isError ⇒ exit 1 with error text on stderr', async () => {
  const r = await headless('hi', { result: { isError: true, stopReason: 'error', error: 'API Error: 529 overloaded_error' } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /error: API Error: 529 overloaded_error\n$/);
});

test('auth error ⇒ not-logged-in message, exit 1', async () => {
  const r = await headless('hi', { result: { isError: true, authError: true, stopReason: 'error', text: 'Not logged in · Please run /login' } });
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes(notLoggedInMessage('kiro-claude')));
  const r2 = await headless('hi', { startError: new Error('Not logged in · Please run /login') });
  assert.equal(r2.code, 1);
  assert.equal(r2.stderr, 'You are not logged in, please log in with kiro-claude login\n');
  assert.equal(r2.calls.closed, 1);
});

test('start failure ⇒ error text, exit 1', async () => {
  const r = await headless('hi', { startError: new Error('Claude Code CLI (claude) was not found.') });
  assert.equal(r.code, 1);
  assert.equal(r.stderr, 'error: Claude Code CLI (claude) was not found.\n');
  const r2 = await headless('hi', { startError: new Error('Failed to start session: Session is active in another process (PID 7)') });
  assert.equal(r2.stderr, 'Failed to start session: Session is active in another process (PID 7)\n');
});

test('prompt generator throwing ⇒ exit 1', async () => {
  const r = await headless('hi', { events: [{ type: 'text_delta', text: 'par' }], promptError: new Error('claude exited (code 1)') });
  assert.equal(r.code, 1);
  assert.equal(r.stdout, 'par\n');
  assert.match(r.stderr, /error: claude exited \(code 1\)/);
});

test('cancelled turn ⇒ exit 130', async () => {
  const r = await headless('hi', { result: { stopReason: 'cancelled', isError: true } });
  assert.equal(r.code, 130);
});

test('/usage: exact text, no session at all', async () => {
  const r = await headless('/usage');
  assert.equal(r.code, 0);
  assert.equal(r.stdout, `${HEADLESS_USAGE_TEXT}\n`);
  assert.equal(r.stderr, '');
  assert.equal(r.calls.created.length, 0);
  assert.ok(!r.stdout.includes('Estimated Usage'));
});

test('stdin input rule: read only when INPUT is empty and stdin is not a TTY', async () => {
  const r = await headless('', { result: { text: 'ok' } }, { stdin: '  piped task \n' });
  assert.equal(r.code, 0);
  assert.equal(r.calls.prompts[0]!.text, 'piped task');
  const r2 = await headless('', {}, { stdin: '   \n' });
  assert.equal(r2.code, 1);
  assert.equal(r2.stderr, `${NO_INPUT_ERROR}\n`);
  assert.equal(r2.calls.created.length, 0);
  const r3 = await headless('', {}, { stdin: 'ignored', stdinTTY: true });
  assert.equal(r3.code, 1);
  assert.equal(r3.stderr, 'error: Input must be supplied when running in non-interactive mode\n');
  const r4 = await headless('given', { result: { text: 'x' } }, { stdin: 'other' });
  assert.equal(r4.calls.prompts[0]!.text, 'given');
});

test('local commands answered from the session without a user turn', async () => {
  const tools = await headless('/tools');
  assert.equal(tools.code, 0);
  assert.equal(tools.calls.started, 1);
  assert.equal(tools.calls.prompts.length, 0);
  assert.match(tools.stdout, /^Tool {18}Permission\n▔+\nBuilt-in:\n- read {16}trusted\n- shell {15}not trusted\n\nfetch \(MCP\):\n- @fetch\/get {10}not trusted\n$/);

  const mcp = await headless('/mcp', { mcp: [[{ name: 'fetch', status: 'connected', toolCount: 2 }, { name: 'bad', status: 'failed', error: 'Connection failed' }]] });
  assert.equal(mcp.stdout, 'fetch  connected  2 tools\nbad    failed  Connection failed\n');
  assert.equal(mcp.calls.prompts.length, 0);

  const model = await headless('/model', { model: 'claude-haiku-5.5' });
  assert.equal(model.stdout, '  auto              Default (recommended)\n* claude-haiku-5.5  Haiku 5.5 | Fastest\n');

  const ctxr = await headless('/context show');
  assert.ok(ctxr.stdout.startsWith('👤 Agent (kiro_default):\n    file://AGENTS.md (1 match)\n        /w/AGENTS.md (~12 tkns)\n\n💬 Session (temporary):\n    <none>\n'));
  assert.ok(ctxr.stdout.includes('Total: ~17 tokens (1.7% of the context window)'));

  const hooks = await headless('/hooks', {
    hooks: [
      {
        dialect: 'v2', source: 'agent', name: 'agentSpawn-0', trigger: 'SessionStart', rawTrigger: 'agentSpawn',
        action: { type: 'command', command: 'git status' }, timeoutMs: 30000, maxOutputBytes: 10240, cacheTtlSec: 0, enabled: true,
      },
    ],
  });
  assert.equal(hooks.stdout, 'agentSpawn  agentSpawn-0: git status\n');
  const noHooks = await headless('/hooks');
  assert.equal(noHooks.stdout, 'No hooks are configured.\n');
});

test('/help, /agent, /prompts, /quit need no session; interactive-only commands fail', async () => {
  const h = await headless('/help');
  assert.match(h.stdout, /Commands available with --no-interactive:/);
  assert.equal(h.calls.created.length, 0);
  const a = await headless('/agent list');
  assert.match(a.stdout, /^\* kiro_default {4}\*\*No path found\*\*$/m);
  assert.equal(a.calls.created.length, 0);
  const q = await headless('/quit');
  assert.equal(q.code, 0);
  assert.equal(q.stdout + q.stderr, '');
  const c = await headless('/clear');
  assert.equal(c.code, 1);
  assert.equal(c.stderr, 'error: /clear is only available in interactive chat\n');
  assert.equal(c.calls.created.length, 0);
  const sub = await headless('/context add x');
  assert.equal(sub.code, 1);
  assert.match(sub.stderr, /only available in interactive chat/);
});

test('/compact runs the session compaction', async () => {
  const r = await headless('/compact keep the API notes', { events: [{ type: 'compaction', state: 'started' }, { type: 'compaction', state: 'finished' }] });
  assert.equal(r.code, 0);
  assert.deepEqual(r.calls.compacts, ['keep the API notes']);
  assert.equal(r.calls.prompts.length, 0);
  assert.match(r.stderr, /Compacting conversation\.\.\.\n✔ Conversation compacted\n/);
});

test('saved prompts: @name and /name are expanded; unknown /x is sent verbatim', async () => {
  t.write(path.join(t.cwd, '.kiro', 'prompts', 'review.md'), 'Review ${1} carefully. All: $ARGUMENTS');
  const a = await headless('@review src/a.ts now', { result: { text: 'ok' } });
  assert.equal(a.calls.prompts[0]!.text, 'Review src/a.ts carefully. All: src/a.ts now');
  const b = await headless('/review x', { result: { text: 'ok' } });
  assert.equal(b.calls.prompts[0]!.text, 'Review x carefully. All: x');
  const c = await headless('/frobnicate please', { result: { text: 'ok' } });
  assert.equal(c.calls.prompts[0]!.text, '/frobnicate please');
  const d = await headless('@nofile.ts explain', { result: { text: 'ok' } });
  assert.equal(d.calls.prompts[0]!.text, '@nofile.ts explain');
});

test('skills: /<skill> args expands the agent skill body', async () => {
  t.write(path.join(t.cwd, '.kiro', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: Deploy things\n---\nDeploy to $ARGUMENTS now.');
  const r = await headless('/deploy staging', { result: { text: 'ok' } });
  assert.equal(r.calls.prompts[0]!.text, 'Deploy to staging now.');
});

test('the UI never asks: approvals are denied, notices go to stderr', async () => {
  const { ctx, stderr } = makeCtx(t);
  const f = mockFactory({ result: { text: 'x' } });
  await runHeadless({ ctx, sessionOptions: {}, input: 'hi', createSession: f.create });
  const ui = f.calls.created[0]!.ui;
  const ans = await ui.requestApproval({ call: call(), requestId: 'r', reasons: [], agentName: 'a' }, new AbortController().signal);
  assert.deepEqual(ans, { kind: 'deny', message: HEADLESS_DENIAL });
  ui.notice('warn', '✗ agentSpawn "x" failed with exit code: 1, stderr: )');
  assert.ok(stderr.text.includes('✗ agentSpawn "x" failed'));
  assert.equal(await ui.confirmStopHook!({ hook: 'h', question: 'q', options: [] }), undefined);
});

test('--require-mcp-startup: waits for pending servers; failure or timeout ⇒ exit 3', async () => {
  const ok = await headless('hi', { mcp: [[{ name: 'a', status: 'pending' }], [{ name: 'a', status: 'connected' }]], result: { text: 'x' } }, { requireMcpStartup: true, mcpStartupTimeoutMs: 2000 });
  assert.equal(ok.code, 0);
  assert.ok(ok.calls.mcpCalls >= 2);
  const failed = await headless('hi', { mcp: [[{ name: 'a', status: 'connected' }, { name: 'b', status: 'failed', error: 'spawn ENOENT' }]] }, { requireMcpStartup: true, mcpStartupTimeoutMs: 2000 });
  assert.equal(failed.code, 3);
  assert.equal(failed.stderr, "error: MCP server 'b' failed to start: spawn ENOENT\n");
  assert.equal(failed.calls.prompts.length, 0);
  const auth = await headless('hi', { mcp: [[{ name: 'gh', status: 'needs-auth' }]] }, { requireMcpStartup: true, mcpStartupTimeoutMs: 2000 });
  assert.equal(auth.code, 3);
  const slow = await headless('hi', { mcp: [[{ name: 'slow', status: 'pending' }]] }, { requireMcpStartup: true, mcpStartupTimeoutMs: 40 });
  assert.equal(slow.code, 3);
  assert.match(slow.stderr, /MCP server 'slow' did not start within 0 s/);
  const none = await headless('hi', { result: { text: 'x' } }, { requireMcpStartup: true, mcpStartupTimeoutMs: 100 });
  assert.equal(none.code, 0);
});

test('waitForMcpStartup: unknown status is a failure; disabled is fine', async () => {
  const f = mockFactory({ mcp: [[{ name: 'x', status: 'disabled' }, { name: 'y', status: 'weird' }]] });
  const s = await f.create({} as never);
  assert.equal(await waitForMcpStartup(s, 100, 5), "error: MCP server 'y' failed to start (status: weird)");
});

test('stream-json: one JSON object per line on stdout', async () => {
  const c = call();
  const r = await headless(
    'go',
    {
      events: [
        { type: 'text_delta', text: 'Hi' },
        { type: 'tool_start', toolUseId: 't1', call: c, trusted: false },
        { type: 'tool_end', toolUseId: 't1', call: c, isError: false, output: 'ok', durationMs: 3 },
        { type: 'raw', frame: { type: 'system' } },
        { type: 'notice', level: 'warn', message: 'careful' },
      ],
      result: { text: 'Hi', usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 }, numTurns: 1 },
    },
    { outputFormat: 'stream-json' },
  );
  assert.equal(r.code, 0);
  assert.equal(r.stderr, '');
  const lines = r.stdout.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.deepEqual(
    lines.map((l) => l.type),
    ['session', 'text_delta', 'tool_start', 'tool_end', 'notice', 'result'],
  );
  assert.equal(lines[0]!.agent, 'kiro_default');
  assert.equal(lines[2]!.tool, 'shell');
  assert.equal(lines[2]!.claudeName, 'Bash');
  assert.deepEqual(lines[2]!.input, c.input);
  assert.equal(lines[5]!.stopReason, 'end_turn');
  assert.equal(lines[5]!.isError, false);
  assert.deepEqual(lines[5]!.usage, { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 });

  const u = await headless('/usage', {}, { outputFormat: 'stream-json' });
  const ul = u.stdout.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.deepEqual(ul.map((l) => l.type), ['text', 'result']);
  assert.equal(ul[1]!.localCommand, '/usage');

  const e = await headless('', {}, { outputFormat: 'stream-json', stdin: '' });
  assert.equal(e.code, 1);
  assert.deepEqual(JSON.parse(e.stdout.trim()), { type: 'error', message: NO_INPUT_ERROR });
  assert.equal(e.stderr, `${NO_INPUT_ERROR}\n`);

  const cancelled = await headless('x', { result: { stopReason: 'cancelled', isError: true } }, { outputFormat: 'stream-json' });
  assert.equal(cancelled.code, 130);
  assert.equal(JSON.parse(cancelled.stdout.trim().split('\n').pop()!).type, 'interrupted');
});

test('stream-json: local commands always end with a result line (/quit, failures, interactive-only commands)', async () => {
  const lines = (out: string): Array<Record<string, unknown>> => out.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  for (const cmd of ['/quit', '/exit', '/q']) {
    const q = await headless(cmd, {}, { outputFormat: 'stream-json' });
    assert.equal(q.code, 0);
    assert.equal(q.stderr, '');
    assert.equal(q.calls.created.length, 0);
    assert.deepEqual(lines(q.stdout), [{ type: 'result', stopReason: 'local_command', isError: false, text: '', localCommand: cmd, permissionDenials: [] }]);
  }
  // text mode stays silent for /quit
  const qt = await headless('/quit');
  assert.equal(qt.stdout + qt.stderr, '');

  const c = await headless('/clear', {}, { outputFormat: 'stream-json' });
  assert.equal(c.code, 1);
  const cl = lines(c.stdout);
  assert.deepEqual(cl.map((l) => l.type), ['error', 'result']);
  assert.deepEqual(cl[1], {
    type: 'result', stopReason: 'error', isError: true, text: '', error: 'error: /clear is only available in interactive chat', localCommand: '/clear', permissionDenials: [],
  });

  // a session-local command whose session call fails
  const f = mockFactory({});
  const { ctx, stdout } = makeCtx(t);
  const failing = async (o: Parameters<typeof f.create>[0]) => {
    const s = await f.create(o);
    (s as unknown as { mcpStatus: () => Promise<never> }).mcpStatus = async () => {
      throw new Error('control request timed out');
    };
    return s;
  };
  const code = await runHeadless({ ctx, sessionOptions: { agentName: 'kiro_default', env: t.env }, input: '/mcp', createSession: failing, outputFormat: 'stream-json' });
  assert.equal(code, 1);
  const ml = lines(stdout.text);
  assert.deepEqual(ml.map((l) => l.type), ['session', 'error', 'result']);
  assert.equal(ml[2]!.isError, true);
  assert.equal(ml[2]!.localCommand, '/mcp');
  assert.equal(ml[2]!.error, 'error: /mcp: control request timed out');

  // /compact whose stream fails
  const cf = await headless('/compact', { promptError: new Error('compaction failed') }, { outputFormat: 'stream-json' });
  assert.equal(cf.code, 1);
  const cfl = lines(cf.stdout);
  assert.equal(cfl[cfl.length - 1]!.type, 'result');
  assert.equal(cfl[cfl.length - 1]!.localCommand, '/compact');
  assert.equal(cfl[cfl.length - 1]!.isError, true);

  // successful local commands keep their text + result pair
  const ok = await headless('/tools', {}, { outputFormat: 'stream-json' });
  assert.deepEqual(lines(ok.stdout).map((l) => l.type), ['session', 'text', 'result']);
});

test('classifyHeadlessInput table', () => {
  const { ctx } = makeCtx(t);
  const cases: Array<[string, string]> = [
    ['/usage', 'output'],
    ['/USAGE', 'output'],
    ['/help', 'output'],
    ['/exit', 'quit'],
    ['/tools', 'session-local'],
    ['/tools trust x', 'error'],
    ['/model', 'session-local'],
    ['/model sonnet', 'error'],
    ['/compact', 'compact'],
    ['/spec new x', 'error'],
    ['hello', 'prompt'],
    ['//not a command', 'prompt'],
    ['/usr/bin/env explain', 'prompt'],
  ];
  for (const [input, kind] of cases) assert.equal(classifyHeadlessInput(input, ctx.ws, ctx.settings).kind, kind, input);
});

test('renderToolListing: none', () => {
  assert.equal(renderToolListing([]), 'No tools are currently enabled.');
});

test('stream-json: a local command whose session cannot start, or whose MCP servers fail, still ends with a result line', async () => {
  const lines = (out: string): Array<Record<string, unknown>> => out.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  for (const cmd of ['/tools', '/mcp', '/compact']) {
    const r = await headless(cmd, { startError: new Error('Claude Code CLI (claude) was not found.') }, { outputFormat: 'stream-json' });
    assert.equal(r.code, 1, cmd);
    const l = lines(r.stdout);
    assert.deepEqual(l.map((x) => x.type), ['error', 'result'], `${cmd}: ${r.stdout}`);
    assert.deepEqual(l[1], {
      type: 'result', stopReason: 'error', isError: true, text: '', error: 'error: Claude Code CLI (claude) was not found.', localCommand: cmd, permissionDenials: [],
    });
  }
  // an agent that cannot be found (exit 4): both error lines, then the result
  const gone = Object.assign(new Error('Error: no agent with name ghost found'), { exitCode: 4 });
  const g = await headless('/context', { startError: gone }, { outputFormat: 'stream-json' });
  assert.equal(g.code, 4);
  const gl = lines(g.stdout);
  assert.deepEqual(gl.map((x) => x.type), ['error', 'error', 'result'], g.stdout);
  assert.equal(gl[2]!.localCommand, '/context');
  assert.equal(gl[2]!.error, 'Error: no agent with name ghost found');
  // --require-mcp-startup failure before a local command (exit 3)
  const m = await headless('/tools', { mcp: [[{ name: 'b', status: 'failed', error: 'spawn ENOENT' }]] }, { outputFormat: 'stream-json', requireMcpStartup: true, mcpStartupTimeoutMs: 2000 });
  assert.equal(m.code, 3);
  const ml = lines(m.stdout);
  assert.deepEqual(ml.map((x) => x.type), ['session', 'error', 'result'], m.stdout);
  assert.equal(ml[2]!.localCommand, '/tools');
  assert.equal(ml[2]!.error, "error: MCP server 'b' failed to start: spawn ENOENT");
  // text mode is unchanged: the error on stderr only
  const tx = await headless('/tools', { startError: new Error('Claude Code CLI (claude) was not found.') });
  assert.equal(tx.code, 1);
  assert.equal(tx.stdout, '');
  assert.equal(tx.stderr, 'error: Claude Code CLI (claude) was not found.\n');
});

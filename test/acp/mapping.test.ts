/**
 * SessionEvent/KiroToolCall ⇒ ACP frame mapping (05 §5.2, §6.1, §7.3–§7.7), checked against
 * the captured kiro-cli frames in KiroCrew's corpus (`acp_frames/kiro/*.jsonl`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { toKiroCall } from '../../src/policy/toolmap.js';
import {
  KIRO_PERMISSION_OPTIONS,
  abandonedUpdate,
  inProgressUpdate,
  toolMeta,
  USER_DENIED_TEXT,
  acpMcpServersToConfigs,
  capText,
  configOptions,
  contextFromResult,
  deniedUpdate,
  describeToolCall,
  displayPath,
  kiroToolNameOf,
  mapStopReason,
  modeState,
  modelState,
  permissionToolCall,
  planUpdate,
  promptToInput,
  promptUsage,
  resolveModelId,
  rustRegexEscape,
  stripReadDecorations,
  stripSubagentTrailer,
  stripToolUseError,
  todoSnapshot,
  toolCallUpdate,
  toolResultUpdates,
  trustOptionsFor,
  turnErrorToRpc,
  type DescribeOptions,
} from '../../src/acp/mapping.js';
import { ErrorCodes } from '../../src/acp/jsonrpc.js';
import { buildModelList } from '../../src/models/models.js';
import type { TurnResult } from '../../src/types.js';

const CWD = '/work';

function d(name: string, input: Record<string, unknown>, opts: Partial<DescribeOptions> = {}, id = 'toolu_1') {
  const call = toKiroCall(name, input, { cwd: CWD, toolUseId: id, mcpServerNames: { probe: 'probe', 'kirocrew-core': 'kirocrew-core' } });
  return describeToolCall(call, { cwd: CWD, ...opts });
}

const noFiles: NonNullable<DescribeOptions['fs']> = { exists: () => false, read: () => undefined };
const SHELL_META = { kiro: { toolName: 'shell' }, claudeCode: { toolName: 'Bash' } };

test('tool titles / kinds / kiro identity table (05 §7.3)', () => {
  const rows: Array<[string, Record<string, unknown>, string, string | undefined, string, string?]> = [
    ['Bash', { command: 'echo hello-from-corpus', description: 'Run the echo' }, 'Running: echo hello-from-corpus', 'execute', 'shell'],
    ['Read', { file_path: '/work/note.txt' }, 'Reading note.txt:1', 'read', 'read'],
    ['Read', { file_path: '/work/src/a.ts', offset: 40 }, 'Reading src/a.ts:40', 'read', 'read'],
    ['Read', { file_path: '/etc/hosts' }, 'Reading /etc/hosts:1', 'read', 'read'],
    ['Write', { file_path: '/work/created.txt', content: 'x' }, 'Creating created.txt', 'edit', 'write'],
    ['Edit', { file_path: '/work/a.ts', old_string: 'a', new_string: 'b' }, 'Editing a.ts', 'edit', 'write'],
    ['MultiEdit', { file_path: '/work/a.ts', edits: [{ old_string: 'a', new_string: 'b' }] }, 'Editing a.ts', 'edit', 'write'],
    ['NotebookEdit', { notebook_path: '/work/n.ipynb', new_source: 'x' }, 'Editing n.ipynb', 'edit', 'write'],
    ['Grep', { pattern: 'hello' }, "Searching for 'hello'", 'search', 'grep'],
    ['Glob', { pattern: '**/*.ts', path: '/work/src' }, "Finding '**/*.ts'", 'search', 'glob'],
    ['WebFetch', { url: 'https://example.com', prompt: 'x' }, 'Fetching https://example.com', 'fetch', 'web_fetch'],
    ['WebSearch', { query: 'kiro acp' }, 'Searching the web for "kiro acp"', 'fetch', 'web_search'],
    ['Agent', { description: 'Find the bug', prompt: 'look', subagent_type: 'general-purpose' }, 'Find the bug', 'think', 'use_subagent'],
    ['Task', { prompt: 'look', subagent_type: 'reviewer' }, 'Subagent: reviewer', 'think', 'use_subagent'],
    ['TaskCreate', { subject: 'Write tests' }, 'Create task: Write tests', 'think', 'todo_list'],
    ['TaskUpdate', { taskId: '2', status: 'completed' }, 'Update task #2: completed', 'think', 'todo_list'],
    ['TaskList', {}, 'List tasks', 'think', 'todo_list'],
    ['TaskGet', { taskId: '3' }, 'Get task #3', 'think', 'todo_list'],
    ['Skill', { skill: 'pdf' }, 'Load skill: pdf', 'other', 'skill'],
    ['ToolSearch', { query: 'select:x' }, 'Searching tools: select:x', 'other', 'tool_search'],
    ['mcp__probe__probe_codeword', {}, 'Running: @probe/probe_codeword', undefined, 'probe_codeword', 'probe'],
    ['mcp__kirocrew-core__learn_add', { text: 'x' }, 'Running: @kirocrew-core/learn_add', undefined, 'learn_add', 'kirocrew-core'],
    ['SomethingNew', { a: 1 }, 'SomethingNew', 'other', 'SomethingNew'],
  ];
  for (const [name, input, title, kind, toolName, server] of rows) {
    const x = d(name, input, { fs: noFiles });
    assert.equal(x.title, title, name);
    assert.equal(x.kind, kind, `${name} kind`);
    assert.equal(x.kiroToolName, toolName, `${name} toolName`);
    assert.equal(x.mcpServerName, server, `${name} server`);
    if (name.startsWith('mcp__')) assert.equal(x.updateKind, 'other');
  }
});

test('tool_call frame for Bash matches the captured kiro-cli frame plus status/claudeCode meta', () => {
  const x = d('Bash', { command: 'echo hello-from-corpus', description: 'Run the requested echo command exactly as specified' }, {}, 'toolu_bdrk_01K2');
  assert.deepEqual(toolCallUpdate(x), {
    sessionUpdate: 'tool_call',
    toolCallId: 'toolu_bdrk_01K2',
    title: 'Running: echo hello-from-corpus',
    kind: 'execute',
    status: 'pending',
    rawInput: {
      __tool_use_purpose: 'Run the requested echo command exactly as specified',
      command: 'echo hello-from-corpus',
      description: 'Run the requested echo command exactly as specified',
    },
    _meta: { kiro: { toolName: 'shell' }, claudeCode: { toolName: 'Bash' } },
  });
  // __tool_use_purpose is the first key (kiro-cli order)
  assert.equal(Object.keys(toolCallUpdate(x).rawInput as object)[0], '__tool_use_purpose');
  assert.deepEqual(permissionToolCall(x), { toolCallId: 'toolu_bdrk_01K2', title: 'Running: echo hello-from-corpus', rawInput: x.rawInput });
});

test('MCP tool_call: no kind, toolName + mcpServerName (saved-spec-live)', () => {
  const x = d('mcp__probe__probe_codeword', {}, {}, 'toolu_bdrk_01UH');
  const u = toolCallUpdate(x);
  assert.equal('kind' in u, false);
  assert.deepEqual(u._meta, { kiro: { toolName: 'probe_codeword', mcpServerName: 'probe' }, claudeCode: { toolName: 'mcp__probe__probe_codeword' } });
  const res = toolResultUpdates(x, { isError: false, output: 'tangerine-42', response: [{ type: 'text', text: 'tangerine-42' }] });
  assert.deepEqual(res, [
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'toolu_bdrk_01UH',
      kind: 'other',
      status: 'completed',
      title: 'Running: @probe/probe_codeword',
      _meta: { kiro: { toolName: 'probe_codeword', mcpServerName: 'probe' }, claudeCode: { toolName: 'mcp__probe__probe_codeword' } },
      content: [{ type: 'content', content: { type: 'text', text: 'tangerine-42' } }],
      rawInput: {},
      rawOutput: { items: [{ Json: { content: [{ type: 'text', text: 'tangerine-42' }] } }] },
    },
  ]);
  // structured {content:[…]} response and plain text fallback
  assert.deepEqual((toolResultUpdates(x, { isError: false, output: 'z', response: { content: [{ type: 'text', text: 'y' }] } })[0]!.rawOutput as any).items[0].Json.content, [{ type: 'text', text: 'y' }]);
  assert.deepEqual((toolResultUpdates(x, { isError: false, output: 'plain' })[0]!.rawOutput as any).items[0].Json.content, [{ type: 'text', text: 'plain' }]);
});

test('shell results: content-only update then final with the Json exit/stdout/stderr envelope (session.jsonl)', () => {
  const x = d('Bash', { command: 'echo hello-from-corpus' });
  assert.deepEqual(toolResultUpdates(x, { isError: false, output: 'hello-from-corpus', response: { stdout: 'hello-from-corpus\n', stderr: '', interrupted: false } }), [
    { sessionUpdate: 'tool_call_update', toolCallId: 'toolu_1', content: [{ type: 'content', content: { type: 'text', text: 'hello-from-corpus\n' } }], _meta: SHELL_META },
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'toolu_1',
      kind: 'execute',
      status: 'completed',
      title: 'Running: echo hello-from-corpus',
      _meta: SHELL_META,
      rawInput: { command: 'echo hello-from-corpus' },
      rawOutput: { items: [{ Json: { exit_status: 'exit status: 0', stdout: 'hello-from-corpus\n', stderr: '' } }] },
    },
  ]);
  // no structured response: text becomes stdout; Claude's empty marker yields no content update
  const plain = toolResultUpdates(x, { isError: false, output: 'abc' });
  assert.equal((plain[1]!.rawOutput as any).items[0].Json.stdout, 'abc');
  const empty = toolResultUpdates(x, { isError: false, output: '(Bash completed with no output)' });
  assert.equal(empty.length, 1);
  assert.equal((empty[0]!.rawOutput as any).items[0].Json.stdout, '');
  // failure: exit code parsed, stderr kept, failed status
  const failed = toolResultUpdates(x, { isError: true, output: 'Exit code 2\nls: cannot access' });
  assert.equal(failed[1]!.status, 'failed');
  assert.deepEqual((failed[1]!.rawOutput as any).items[0].Json, { exit_status: 'exit status: 2', stdout: '', stderr: 'ls: cannot access' });
  const stderrToo = toolResultUpdates(x, { isError: false, output: '', response: { stdout: 'out', stderr: 'warn' } });
  assert.equal((stderrToo[0]!.content as any)[0].content.text, 'out\nwarn');
});

test('read / write / edit / search / todo / failure result envelopes', () => {
  const r = d('Read', { file_path: '/work/note.txt' });
  assert.deepEqual(r.locations, [{ path: '/work/note.txt', line: 1 }]);
  const rr = toolResultUpdates(r, { isError: false, output: '     1\thello from the probe', response: { type: 'text', file: { filePath: '/work/note.txt', content: 'hello from the probe' } } });
  assert.deepEqual(rr[0]!.rawOutput, { items: [{ Text: 'hello from the probe' }] });
  assert.equal(rr[0]!.kind, 'read');
  assert.deepEqual(rr[0]!.locations, [{ path: '/work/note.txt', line: 1 }]);
  // cat -n fallback stripped
  assert.deepEqual(toolResultUpdates(r, { isError: false, output: '     1\ta\n     2\tb' })[0]!.rawOutput, { items: [{ Text: 'a\nb' }] });

  const w = d('Write', { file_path: '/work/created.txt', content: 'x' }, { fs: noFiles });
  assert.deepEqual(w.content, [{ type: 'diff', path: '/work/created.txt', oldText: null, newText: 'x' }]);
  assert.deepEqual(w.locations, [{ path: '/work/created.txt', line: 1 }]);
  const wr = toolResultUpdates(w, { isError: false, output: 'File created successfully at: /work/created.txt' });
  assert.equal('content' in wr[0]!, false, 'diff kept from the tool_call');
  assert.deepEqual(wr[0]!.rawOutput, { items: [{ Text: 'File created successfully at: /work/created.txt' }] });
  const existing = d('Write', { file_path: '/work/a.txt', content: 'new' }, { fs: { exists: () => true, read: () => 'old' } });
  assert.equal(existing.title, 'Writing a.txt');
  assert.deepEqual(existing.content, [{ type: 'diff', path: '/work/a.txt', oldText: 'old', newText: 'new' }]);
  assert.equal(d('Write', { file_path: '/work/a.txt', content: 'n' }).title, 'Writing a.txt', 'no fs probes ⇒ Writing');

  const e = d('Edit', { file_path: '/work/a.ts', old_string: 'foo', new_string: 'bar' });
  assert.deepEqual(e.content, [{ type: 'diff', path: '/work/a.ts', oldText: 'foo', newText: 'bar' }]);
  assert.equal(d('MultiEdit', { file_path: '/work/a.ts', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] }).content!.length, 2);

  const g = d('Grep', { pattern: 'hello', path: 'src' });
  assert.deepEqual(g.locations, [{ path: '/work/src' }]);
  assert.deepEqual(toolResultUpdates(g, { isError: false, output: 'src/a.ts:1:hello' })[0]!.rawOutput, { items: [{ Text: 'src/a.ts:1:hello' }] });

  const t = d('TaskCreate', { subject: 'Write tests' });
  const tr = toolResultUpdates(t, {
    isError: false,
    output: 'Task #1 created successfully: Write tests',
    todos: [
      { id: '1', subject: 'Write tests', status: 'pending' },
      { id: '2', subject: 'Ship', status: 'completed' },
      { id: '3', subject: 'gone', status: 'deleted' },
    ],
  });
  assert.deepEqual(tr[0]!.rawOutput, {
    items: [{ Json: { description: 'Tasks', tasks: [{ id: '1', task_description: 'Write tests', completed: false }, { id: '2', task_description: 'Ship', completed: true }] } }],
  });

  const fail = toolResultUpdates(r, { isError: true, output: '<tool_use_error>File does not exist.</tool_use_error>' });
  assert.deepEqual(fail[0], {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'toolu_1',
    kind: 'read',
    status: 'failed',
    title: 'Reading note.txt:1',
    _meta: { kiro: { toolName: 'read' }, claudeCode: { toolName: 'Read' } },
    content: [{ type: 'content', content: { type: 'text', text: 'File does not exist.' } }],
    rawInput: { file_path: '/work/note.txt' },
    rawOutput: { items: [{ Text: 'File does not exist.' }] },
  });

  const sub = d('Agent', { description: 'x', prompt: 'do it' });
  assert.deepEqual(sub.content, [{ type: 'content', content: { type: 'text', text: 'do it' } }]);
  assert.equal((toolResultUpdates(sub, { isError: false, output: 'Report.\nagentId: abc123' })[0]!.content as any)[0].content.text, 'Report.');
});

test('denial frame matches side-read-only-live exactly (+ claudeCode meta)', () => {
  const x = d('Bash', { command: 'ls', description: 'Run ls as requested.' }, {}, 'toolu_bdrk_01DL');
  assert.deepEqual(deniedUpdate(x), {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'toolu_bdrk_01DL',
    kind: 'execute',
    status: 'failed',
    title: 'shell',
    content: [{ type: 'content', content: { type: 'text', text: USER_DENIED_TEXT } }],
    rawInput: { __tool_use_purpose: 'Run ls as requested.', command: 'ls', description: 'Run ls as requested.' },
    _meta: { kiro: { toolName: 'shell', toolCallFailureReason: 'permission_denied' }, claudeCode: { toolName: 'Bash' } },
  });
  const w = d('Write', { file_path: '/work/created.txt', content: 'x' }, { fs: noFiles });
  assert.equal(deniedUpdate(w).title, 'write');
  assert.equal(deniedUpdate(w).kind, 'edit');
});

test('permission options are kiro-cli exact; trustOptions per the captures', () => {
  assert.deepEqual(KIRO_PERMISSION_OPTIONS, [
    { optionId: 'allow_once', name: 'Yes', kind: 'allow_once' },
    { optionId: 'allow_always', name: 'Always', kind: 'allow_always' },
    { optionId: 'reject_once', name: 'No', kind: 'reject_once' },
  ]);
  assert.deepEqual(trustOptionsFor(d('Bash', { command: 'echo hello-from-corpus' }), CWD), [
    { label: 'Full command', display: 'echo hello-from-corpus', setting_key: 'allowedCommands', patterns: ['echo hello\\-from\\-corpus'] },
    { label: 'Partial command', display: 'echo hello-from-corpus *', setting_key: 'allowedCommands', patterns: ['echo hello\\-from\\-corpus( .*)?'] },
    { label: 'Base command', display: 'echo *', setting_key: 'allowedCommands', patterns: ['echo( .*)?'] },
  ]);
  assert.deepEqual(trustOptionsFor(d('Bash', { command: 'ls' }), CWD), [
    { label: 'Full command', display: 'ls', setting_key: 'allowedCommands', patterns: ['ls'] },
    { label: 'Base command', display: 'ls *', setting_key: 'allowedCommands', patterns: ['ls( .*)?'] },
  ]);
  assert.deepEqual(trustOptionsFor(d('Write', { file_path: '/work/created.txt', content: 'x' }, { fs: noFiles }), CWD), [
    { label: 'Specific paths', display: 'created.txt', setting_key: 'runtime_write_paths', patterns: ['/work/created.txt'] },
    { label: 'Complete directory', display: '/work', setting_key: 'runtime_write_paths', patterns: ['/work'] },
  ]);
  assert.equal(trustOptionsFor(d('Read', { file_path: '/work/a' }), CWD), undefined);
  assert.equal(trustOptionsFor(d('Bash', { command: 'a\nb' }), CWD), undefined);
  assert.equal(rustRegexEscape('a.b*c(d)|[e]{f}^$#&-~\\'), 'a\\.b\\*c\\(d\\)\\|\\[e\\]\\{f\\}\\^\\$\\#\\&\\-\\~\\\\');
});

test('every tool update carries the identity meta (in_progress, abandoned, results)', () => {
  const x = d('mcp__probe__probe_codeword', {});
  const want = { kiro: { toolName: 'probe_codeword', mcpServerName: 'probe' }, claudeCode: { toolName: 'mcp__probe__probe_codeword' } };
  assert.deepEqual(inProgressUpdate(x), { sessionUpdate: 'tool_call_update', toolCallId: 'toolu_1', status: 'in_progress', _meta: want });
  assert.deepEqual(abandonedUpdate(x)._meta, want);
  for (const u of toolResultUpdates(x, { isError: true, output: 'e' })) assert.deepEqual(u._meta, want);
  assert.deepEqual(toolMeta(x), want);
});

test('subagent parent meta; kiroToolNameOf', () => {
  const call = toKiroCall('Read', { file_path: '/work/x' }, { cwd: CWD, toolUseId: 'inner' });
  const x = describeToolCall(call, { cwd: CWD, parentToolUseId: 'toolu_parent' });
  assert.deepEqual(toolCallUpdate(x)._meta, { kiro: { toolName: 'read' }, claudeCode: { toolName: 'Read', parentToolUseId: 'toolu_parent' } });
  assert.equal(kiroToolNameOf({ claudeName: 'PowerShell', kiro2Name: 'PowerShell' }), 'shell');
});

test('mapStopReason (05 §7.6)', () => {
  const r = (x: Partial<TurnResult>): TurnResult => ({ stopReason: 'end_turn', isError: false, text: '', permissionDenials: [], ...x });
  assert.equal(mapStopReason(r({})), 'end_turn');
  assert.equal(mapStopReason(r({}), { stop_reason: 'max_tokens' }), 'max_tokens');
  assert.equal(mapStopReason(r({ stopReason: 'cancelled' })), 'cancelled');
  assert.equal(mapStopReason(r({ stopReason: 'refusal' })), 'refusal');
  assert.equal(mapStopReason(r({ stopReason: 'max_turns' })), 'max_turn_requests');
  assert.equal(mapStopReason(r({ stopReason: 'local_command' })), 'end_turn');
  assert.equal(mapStopReason(r({ stopReason: 'error', isError: false })), 'end_turn');
  assert.equal(mapStopReason(r({ stopReason: 'error', isError: true })), undefined);
  assert.equal(mapStopReason(r({ stopReason: 'end_turn', isError: true })), undefined);
});

test('turnErrorToRpc uses KiroCrew vocabulary (08a §2.6)', () => {
  const r = (x: Partial<TurnResult>): TurnResult => ({ stopReason: 'error', isError: true, text: '', permissionDenials: [], ...x });
  const auth = turnErrorToRpc(r({ authError: true, error: 'Not logged in · Please run /login' }));
  assert.equal(auth.code, ErrorCodes.AUTH_REQUIRED);
  assert.match(auth.message, /HTTP 401/);
  assert.equal(turnErrorToRpc(r({ error: 'Failed to authenticate: OAuth token revoked' })).code, -32000);
  assert.equal(turnErrorToRpc(r({}), { assistantError: 'authentication_failed' }).code, -32000);
  assert.match(String(turnErrorToRpc(r({ error: 'x' }), { rateLimit: { status: 'rejected', rateLimitType: 'five_hour' } }).data), /You've hit your 5-hour limit/);
  assert.match(String(turnErrorToRpc(r({}), { rateLimit: { status: 'rejected', rateLimitType: 'seven_day' } }).data), /weekly usage limit/);
  assert.match(String(turnErrorToRpc(r({}), { assistantError: 'rate_limit' }).data), /rate limit exceeded, please try again/);
  assert.match(String(turnErrorToRpc(r({}), { assistantError: 'overloaded' }).data), /API Error: 529 overloaded_error/);
  assert.match(String(turnErrorToRpc(r({}), { assistantError: 'model_not_found', model: 'claude-x-9' }).data), /Invalid model ID: claude-x-9/);
  const other = turnErrorToRpc(r({ error: 'boom' }));
  assert.deepEqual(other.toJSON(), { code: -32603, message: 'Internal error', data: 'boom' });
});

test('promptUsage sums all four counters (05 §10)', () => {
  assert.deepEqual(promptUsage({ inputTokens: 12, outputTokens: 180, cacheReadTokens: 19000, cacheCreationTokens: 2208 }), {
    totalTokens: 21400,
    inputTokens: 12,
    outputTokens: 180,
    cachedReadTokens: 19000,
    cachedWriteTokens: 2208,
  });
  assert.equal(promptUsage(undefined), undefined);
});

test('promptToInput (05 §4.5.1)', () => {
  const { input, skipped } = promptToInput([
    { type: 'text', text: 'Look at' },
    { type: 'resource_link', uri: 'file:///work/src/a%20b.ts', name: 'a b.ts' },
    { type: 'resource_link', uri: 'https://example.com/x' },
    { type: 'resource', resource: { uri: 'file:///work/c.md', text: 'C body' } },
    { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' },
    { type: 'resource', resource: { uri: 'file:///work/p.png', blob: 'BBBB', mimeType: 'image/png' } },
    { type: 'resource', resource: { uri: 'file:///work/d.pdf', blob: 'CCCC', mimeType: 'application/pdf' } },
    { type: 'audio', data: 'x', mimeType: 'audio/wav' },
    { type: 'image', uri: 'https://example.com/i.png' },
  ]);
  assert.equal(input.text, 'Look at\n[@a b.ts](file:///work/src/a%20b.ts)\nhttps://example.com/x\n[@c.md](file:///work/c.md)\nhttps://example.com/i.png\n<context ref="file:///work/c.md">\nC body\n</context>');
  assert.deepEqual(input.images, [
    { mediaType: 'image/jpeg', dataBase64: 'AAAA' },
    { mediaType: 'image/png', dataBase64: 'BBBB' },
  ]);
  assert.deepEqual(skipped, ['resource file:///work/d.pdf (application/pdf)', 'audio']);
  assert.deepEqual(promptToInput('nope').input, { text: '' });
  const big = `[AGENT SYSTEM PROMPT]\n${'x'.repeat(45_000)}`;
  assert.equal(promptToInput([{ type: 'text', text: big }]).input.text, big, 'text passed verbatim');
});

test('acpMcpServersToConfigs (05 §4.3, 08 KC-ENV-02): env/headers verbatim, last duplicate wins', () => {
  const { servers, warnings } = acpMcpServersToConfigs([
    { name: 'kirocrew-core', command: '/venv/bin/kirocrew', args: ['mcp-core'], env: [{ name: 'KIROCREW_STUB_SESSION_TOKEN', value: 'tok-${X}' }], type: 'stdio' },
    { type: 'http', name: 'remote', url: 'https://h/mcp', headers: [{ name: 'Authorization', value: 'Bearer t' }] },
    { type: 'sse', name: 'events', url: 'https://h/sse', headers: [] },
    { name: 'noCommand' },
    { type: 'http', name: 'noUrl' },
    { type: 'ws', name: 'weird', url: 'ws://x' },
    { name: 'dup', command: 'a' },
    { name: 'dup', command: 'b', env: { K: 'v' } },
    'garbage',
  ]);
  assert.deepEqual(
    servers.map((s) => [s.name, s.type, s.command ?? s.url, s.args, s.env, s.headers]),
    [
      ['kirocrew-core', 'stdio', '/venv/bin/kirocrew', ['mcp-core'], { KIROCREW_STUB_SESSION_TOKEN: 'tok-${X}' }, {}],
      ['remote', 'http', 'https://h/mcp', [], {}, { Authorization: 'Bearer t' }],
      ['events', 'sse', 'https://h/sse', [], {}, {}],
      ['dup', 'stdio', 'b', [], { K: 'v' }, {}],
    ],
  );
  assert.ok(servers.every((s) => s.disabled === false && s.origin === 'agent'));
  assert.equal(warnings.length, 4);
  assert.deepEqual(acpMcpServersToConfigs(undefined), { servers: [], warnings: [] });
  assert.throws(() => acpMcpServersToConfigs({}), (e: any) => e.code === -32602);
});

test('modes / models / configOptions / resolveModelId', () => {
  assert.deepEqual(modeState([{ name: 'kiro_default', description: 'Default agent' }, { name: 'probe', description: 'capture probe' }, { name: 'bare' }], 'probe'), {
    currentModeId: 'probe',
    availableModes: [
      { id: 'kiro_default', name: 'kiro_default', description: 'Default agent' },
      { id: 'probe', name: 'probe', description: 'capture probe' },
      { id: 'bare', name: 'bare' },
    ],
  });
  assert.deepEqual((modeState([], 'x') as any).availableModes, [{ id: 'x', name: 'x' }]);
  const entries = buildModelList();
  const ms = modelState(entries, 'auto') as any;
  assert.equal(ms.currentModelId, 'auto');
  assert.deepEqual(ms.availableModels[0], { modelId: 'auto', name: 'auto', description: 'Claude Code default model for your account' });
  assert.ok(ms.availableModels.some((m: any) => m.modelId === 'claude-haiku-5.5' && m.name === 'Haiku 5.5'));
  assert.ok((modelState(entries, 'opus') as any).availableModels.some((m: any) => m.modelId === 'opus'), 'current always listed');
  const co = configOptions(entries, 'claude-opus-5.5', 'high') as any[];
  assert.equal(co[0].id, 'model');
  assert.equal(co[0].currentValue, 'claude-opus-5.5');
  assert.deepEqual(co[1].options.map((o: any) => o.value), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(co[1].currentValue, 'high');
  assert.equal((configOptions(entries, 'auto', undefined) as any[])[1].currentValue, 'medium');
  assert.equal(resolveModelId(entries, 'claude-haiku-5.5'), 'claude-haiku-5.5');
  assert.equal(resolveModelId(entries, 'claude-haiku-5-5'), 'claude-haiku-5.5');
  assert.equal(resolveModelId(entries, 'Haiku 5.5'), 'claude-haiku-5.5');
  assert.equal(resolveModelId(entries, 'auto'), 'auto');
  assert.equal(resolveModelId(entries, 'Opus'), 'opus');
  assert.equal(resolveModelId(entries, 'sonnet[1m]'), 'sonnet[1m]');
  assert.equal(resolveModelId(entries, 'bogus'), undefined);
  assert.equal(resolveModelId(entries, 'claude-made-up-9'), undefined);
  assert.equal(resolveModelId(entries, ''), undefined);
});

test('plan update and todo snapshot', () => {
  const todos = [
    { id: '1', subject: 'a', status: 'in_progress' as const },
    { id: '2', subject: 'b', status: 'deleted' as const },
  ];
  assert.deepEqual(planUpdate(todos), { sessionUpdate: 'plan', entries: [{ content: 'a', priority: 'medium', status: 'in_progress' }] });
  assert.deepEqual(todoSnapshot([]), { items: [{ Json: { description: 'Tasks', tasks: [] } }] });
});

test('small helpers', () => {
  assert.equal(stripToolUseError('<tool_use_error>nope</tool_use_error>'), 'nope');
  assert.equal(stripToolUseError('plain'), 'plain');
  assert.equal(stripReadDecorations('     1\ta\n     2\tb\n<system-reminder>x</system-reminder>'), 'a\nb');
  assert.equal(stripReadDecorations('not numbered'), 'not numbered');
  assert.equal(stripSubagentTrailer('R\n<usage>tokens</usage>'), 'R');
  assert.equal(displayPath('/work/a/b', '/work'), path.join('a', 'b'));
  assert.equal(displayPath('/work', '/work'), '.');
  assert.equal(displayPath('/other', '/work'), '/other');
  assert.equal(capText('abc', 2), 'ab\n… [truncated 1 characters]');
  assert.deepEqual(contextFromResult({ usage: { input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 5 }, modelUsage: { m: { contextWindow: 1000 } } }), { used: 115, size: 1000 });
  assert.equal(contextFromResult({ usage: {} }), undefined);
});

test('live fs probes: existing file gives Writing + old text', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-acp-map-'));
  const f = path.join(dir, 'a.txt');
  fs.writeFileSync(f, 'before');
  const call = toKiroCall('Write', { file_path: f, content: 'after' }, { cwd: dir, toolUseId: 't' });
  const x = describeToolCall(call, { cwd: dir, fs: { exists: (p) => fs.existsSync(p), read: (p) => fs.readFileSync(p, 'utf8') } });
  assert.equal(x.title, 'Writing a.txt');
  assert.deepEqual(x.content, [{ type: 'diff', path: f, oldText: 'before', newText: 'after' }]);
});

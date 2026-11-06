import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildPayload, hookEventName, toKiroToolResponse, toV2ToolInput, toV3ToolInput } from '../../src/hooks/payload.js';
import type { WorkspaceContext } from '../../src/types.js';
import { mkCall, v2Hook, v3Hook } from './helpers.js';

const ws: WorkspaceContext = { cwd: '/ws/sub', workspaceRoot: '/ws', kiroHome: '/h/.kiro', home: '/h', env: {} };
const SID = 'sess-123';

// ───────────────────────────── tool_input per Claude tool (00 §4.4) ─────────────────────────────

const ROWS: { name: string; claude: string; input: Record<string, unknown>; v2: unknown; v3: unknown }[] = [
  {
    name: 'Read (whole file)',
    claude: 'Read',
    input: { file_path: '/ws/docs/hooks.md' },
    v2: { operations: [{ mode: 'Line', path: '/ws/docs/hooks.md', start_line: 1, end_line: -1 }] },
    v3: { path: '/ws/docs/hooks.md' },
  },
  {
    name: 'Read (offset+limit)',
    claude: 'Read',
    input: { file_path: '/ws/a.txt', offset: 10, limit: 5 },
    v2: { operations: [{ mode: 'Line', path: '/ws/a.txt', start_line: 10, end_line: 14 }] },
    v3: { path: '/ws/a.txt' },
  },
  {
    name: 'Read (limit only)',
    claude: 'Read',
    input: { file_path: 'rel.txt', limit: 20 },
    v2: { operations: [{ mode: 'Line', path: '/ws/rel.txt', start_line: 1, end_line: 20 }] },
    v3: { path: '/ws/rel.txt' },
  },
  {
    name: 'Glob (no path => cwd)',
    claude: 'Glob',
    input: { pattern: '**/*.ts' },
    v2: { path: '/ws', pattern: '**/*.ts' },
    v3: { pattern: '**/*.ts', path: '/ws' },
  },
  {
    name: 'Glob (path)',
    claude: 'Glob',
    input: { pattern: '*.md', path: 'docs' },
    v2: { path: '/ws/docs', pattern: '*.md' },
    v3: { pattern: '*.md', path: '/ws/docs' },
  },
  {
    name: 'Grep',
    claude: 'Grep',
    input: { pattern: 'TODO', path: '/ws/src', glob: '*.ts', output_mode: 'content' },
    v2: { path: '/ws/src', pattern: 'TODO' },
    v3: { pattern: 'TODO', path: '/ws/src' },
  },
  {
    name: 'Write',
    claude: 'Write',
    input: { file_path: '/ws/new.txt', content: 'hello' },
    v2: { command: 'create', path: '/ws/new.txt', file_text: 'hello' },
    v3: { path: '/ws/new.txt', content: 'hello' },
  },
  {
    name: 'Edit',
    claude: 'Edit',
    input: { file_path: '/ws/a.ts', old_string: 'a', new_string: 'b', replace_all: true },
    v2: { command: 'str_replace', path: '/ws/a.ts', old_str: 'a', new_str: 'b' },
    v3: { path: '/ws/a.ts', old_str: 'a', new_str: 'b' },
  },
  {
    name: 'MultiEdit (tolerant alias, first edit)',
    claude: 'MultiEdit',
    input: { file_path: '/ws/a.ts', edits: [{ old_string: 'x', new_string: 'y' }, { old_string: 'p', new_string: 'q' }] },
    v2: { command: 'str_replace', path: '/ws/a.ts', old_str: 'x', new_str: 'y' },
    v3: { path: '/ws/a.ts', old_str: 'x', new_str: 'y' },
  },
  {
    name: 'NotebookEdit (replace)',
    claude: 'NotebookEdit',
    input: { notebook_path: '/ws/n.ipynb', new_source: 'print(1)', cell_id: 'c1' },
    v2: { command: 'str_replace', path: '/ws/n.ipynb', new_str: 'print(1)' },
    v3: { path: '/ws/n.ipynb', content: 'print(1)' },
  },
  {
    name: 'NotebookEdit (insert)',
    claude: 'NotebookEdit',
    input: { notebook_path: '/ws/n.ipynb', new_source: 'x', edit_mode: 'insert' },
    v2: { command: 'insert', path: '/ws/n.ipynb', new_str: 'x' },
    v3: { path: '/ws/n.ipynb', content: 'x' },
  },
  {
    name: 'Bash (description => summary)',
    claude: 'Bash',
    input: { command: 'npm test', description: 'Run tests', timeout: 1000 },
    v2: { command: 'npm test', summary: 'Run tests' },
    v3: { command: 'npm test' },
  },
  {
    name: 'Bash (no description)',
    claude: 'Bash',
    input: { command: 'ls' },
    v2: { command: 'ls' },
    v3: { command: 'ls' },
  },
  {
    name: 'WebFetch',
    claude: 'WebFetch',
    input: { url: 'https://example.com', prompt: 'summarize' },
    v2: { url: 'https://example.com' },
    v3: { url: 'https://example.com' },
  },
  {
    name: 'WebSearch',
    claude: 'WebSearch',
    input: { query: 'kiro hooks', allowed_domains: ['kiro.dev'] },
    v2: { query: 'kiro hooks' },
    v3: { query: 'kiro hooks' },
  },
  {
    name: 'Agent',
    claude: 'Agent',
    input: { description: 'plan', prompt: 'Plan the work', subagent_type: 'planner' },
    v2: { agent_name: 'planner', task: 'Plan the work' },
    v3: { agent_name: 'planner', task: 'Plan the work' },
  },
  {
    name: 'Agent (default type)',
    claude: 'Agent',
    input: { description: 'd', prompt: 'p' },
    v2: { agent_name: 'general-purpose', task: 'p' },
    v3: { agent_name: 'general-purpose', task: 'p' },
  },
  {
    name: 'Task (legacy subagent alias)',
    claude: 'Task',
    input: { description: 'd', prompt: 'p', subagent_type: 'x' },
    v2: { agent_name: 'x', task: 'p' },
    v3: { agent_name: 'x', task: 'p' },
  },
  {
    name: 'MCP (raw input)',
    claude: 'mcp__git__status',
    input: { repo: '.', verbose: true },
    v2: { repo: '.', verbose: true },
    v3: { repo: '.', verbose: true },
  },
  {
    name: 'TaskCreate (raw input)',
    claude: 'TaskCreate',
    input: { subject: 's', description: 'd' },
    v2: { subject: 's', description: 'd' },
    v3: { subject: 's', description: 'd' },
  },
  {
    name: 'Skill (raw input)',
    claude: 'Skill',
    input: { skill: 'kiro:review' },
    v2: { skill: 'kiro:review' },
    v3: { skill: 'kiro:review' },
  },
];

for (const r of ROWS) {
  test(`tool_input: ${r.name}`, () => {
    const call = mkCall(r.claude, r.input, '/ws');
    assert.deepEqual(toV2ToolInput(call), r.v2);
    assert.deepEqual(toV3ToolInput(call), r.v3);
  });
}

test('tool_input: key order matches the Q / 00 §4.4 shapes', () => {
  assert.equal(JSON.stringify(toV2ToolInput(mkCall('Write', { content: 'c', file_path: '/f' }))), '{"command":"create","path":"/f","file_text":"c"}');
  assert.equal(
    JSON.stringify(toV2ToolInput(mkCall('Read', { file_path: '/f' }))),
    '{"operations":[{"mode":"Line","path":"/f","start_line":1,"end_line":-1}]}',
  );
  assert.equal(JSON.stringify(toV3ToolInput(mkCall('Grep', { path: '/p', pattern: 'x' }))), '{"pattern":"x","path":"/p"}');
});

test('tool_input: raw input is copied, not shared', () => {
  const input = { a: 1 };
  const out = toV2ToolInput(mkCall('mcp__s__t', input));
  assert.notEqual(out, input);
});

// ───────────────────────────── tool_response ─────────────────────────────

test('tool_response: Bash success => exit_status "0" item (06 §3.7)', () => {
  const r = toKiroToolResponse(mkCall('Bash', { command: 'ls' }), {
    success: true,
    response: { stdout: 'a\nb', stderr: '', interrupted: false, isImage: false, noOutputExpected: false },
  });
  assert.deepEqual(r, { success: true, result: [{ exit_status: '0', stdout: 'a\nb', stderr: '' }] });
  assert.equal(JSON.stringify(r), '{"success":true,"result":[{"exit_status":"0","stdout":"a\\nb","stderr":""}]}');
});

test('tool_response: Read => file.content string', () => {
  const r = toKiroToolResponse(mkCall('Read', { file_path: '/f' }), {
    success: true,
    response: { type: 'text', file: { filePath: '/f', content: '# Hooks\n', numLines: 1, startLine: 1, totalLines: 1 } },
  });
  assert.deepEqual(r, { success: true, result: ['# Hooks\n'] });
});

test('tool_response: other tools => JSON text; strings kept as is', () => {
  const resp = { type: 'create', filePath: '/f', content: 'x' };
  assert.deepEqual(toKiroToolResponse(mkCall('Write'), { success: true, response: resp }), { success: true, result: [JSON.stringify(resp)] });
  assert.deepEqual(toKiroToolResponse(mkCall('mcp__s__t'), { success: true, response: 'plain' }), { success: true, result: ['plain'] });
  assert.deepEqual(toKiroToolResponse(mkCall('WebFetch'), { success: true }), { success: true, result: [''] });
  const mcp = [{ type: 'text', text: 'hi' }];
  assert.deepEqual(toKiroToolResponse(mkCall('mcp__s__t'), { success: true, response: mcp }), { success: true, result: ['[{"type":"text","text":"hi"}]'] });
  assert.deepEqual(toKiroToolResponse(mkCall('Bash'), { success: true, response: 'out' }), { success: true, result: [{ exit_status: '0', stdout: 'out', stderr: '' }] });
});

test('tool_response: failure => Q error block', () => {
  assert.deepEqual(toKiroToolResponse(mkCall('Bash'), { success: false, error: 'Exit code 1' }), {
    success: false,
    error: ['An error occurred processing the tool: \nExit code 1'],
  });
  assert.deepEqual(toKiroToolResponse(mkCall('Read'), { success: false, response: 'File does not exist.' }), {
    success: false,
    error: ['An error occurred processing the tool: \nFile does not exist.'],
  });
  assert.deepEqual(toKiroToolResponse(mkCall('Read'), { success: false }), { success: false, error: ['An error occurred processing the tool: \n'] });
});

// ───────────────────────────── whole payloads ─────────────────────────────

test('hookEventName: V2 canonical camelCase, V3 echoes the configured trigger', () => {
  assert.equal(hookEventName(v2Hook('SessionStart', 'x')), 'agentSpawn');
  assert.equal(hookEventName(v2Hook('SessionStart', 'x', { rawTrigger: 'conversation_start' })), 'agentSpawn');
  assert.equal(hookEventName(v2Hook('UserPromptSubmit', 'x')), 'userPromptSubmit');
  assert.equal(hookEventName(v2Hook('PreToolUse', 'x')), 'preToolUse');
  assert.equal(hookEventName(v2Hook('PostToolUse', 'x')), 'postToolUse');
  assert.equal(hookEventName(v2Hook('Stop', 'x')), 'stop');
  assert.equal(hookEventName(v3Hook('SessionStart', 'x', { rawTrigger: 'agentSpawn' })), 'agentSpawn');
  assert.equal(hookEventName(v3Hook('SessionStart', 'x')), 'SessionStart');
  assert.equal(hookEventName(v3Hook('Stop', 'x', { rawTrigger: '' })), 'Stop');
});

test('V2 payloads (02 §7.1 exact shapes)', () => {
  const read = mkCall('Read', { file_path: '/ws/docs/hooks.md' }, '/ws/sub');
  assert.equal(JSON.stringify(buildPayload(v2Hook('SessionStart', 'x'), { trigger: 'SessionStart', ws, sessionId: SID })), '{"hook_event_name":"agentSpawn","cwd":"/ws/sub"}');
  assert.equal(
    JSON.stringify(buildPayload(v2Hook('SessionStart', 'x'), { trigger: 'SessionStart', ws, sessionId: SID, prompt: 'hi' })),
    '{"hook_event_name":"agentSpawn","cwd":"/ws/sub","prompt":"hi"}',
  );
  assert.equal(
    JSON.stringify(buildPayload(v2Hook('UserPromptSubmit', 'x'), { trigger: 'UserPromptSubmit', ws, sessionId: SID, prompt: 'do it' })),
    '{"hook_event_name":"userPromptSubmit","cwd":"/ws/sub","prompt":"do it"}',
  );
  assert.equal(
    JSON.stringify(buildPayload(v2Hook('PreToolUse', 'x'), { trigger: 'PreToolUse', ws, sessionId: SID, call: read })),
    '{"hook_event_name":"preToolUse","cwd":"/ws/sub","tool_name":"fs_read","tool_tags":["read","@builtin"],"tool_input":{"operations":[{"mode":"Line","path":"/ws/docs/hooks.md","start_line":1,"end_line":-1}]}}',
  );
  const post = buildPayload(v2Hook('PostToolUse', 'x'), {
    trigger: 'PostToolUse',
    ws,
    sessionId: SID,
    call: read,
    outcome: { success: true, response: { type: 'text', file: { content: '# Hooks' } } },
  });
  assert.deepEqual(Object.keys(post), ['hook_event_name', 'cwd', 'tool_name', 'tool_tags', 'tool_input', 'tool_response']);
  assert.deepEqual(post.tool_response, { success: true, result: ['# Hooks'] });
  assert.equal(JSON.stringify(buildPayload(v2Hook('Stop', 'x'), { trigger: 'Stop', ws, sessionId: SID })), '{"hook_event_name":"stop","cwd":"/ws/sub"}');
  const mcp = buildPayload(v2Hook('PreToolUse', 'x'), { trigger: 'PreToolUse', ws, sessionId: SID, call: mkCall('mcp__git__status', { a: 1 }) });
  assert.equal(mcp.tool_name, '@git/status');
  assert.deepEqual(mcp.tool_tags, ['@mcp', '@git', '@git/status']);
  assert.deepEqual(mcp.tool_input, { a: 1 });
  assert.equal('session_id' in mcp, false);
});

test('V3 payloads (02 §7.5 exact shapes)', () => {
  const read = mkCall('Read', { file_path: '/ws/docs/hooks.md' }, '/ws/sub');
  assert.equal(
    JSON.stringify(buildPayload(v3Hook('SessionStart', 'x', { rawTrigger: 'agentSpawn' }), { trigger: 'SessionStart', ws, sessionId: SID, prompt: 'p' })),
    '{"hook_event_name":"agentSpawn","cwd":"/ws/sub","session_id":"sess-123"}',
  );
  assert.equal(
    JSON.stringify(buildPayload(v3Hook('UserPromptSubmit', 'x'), { trigger: 'UserPromptSubmit', ws, sessionId: SID, prompt: "user's input prompt" })),
    '{"hook_event_name":"UserPromptSubmit","cwd":"/ws/sub","session_id":"sess-123","prompt":"user\'s input prompt"}',
  );
  assert.equal(
    JSON.stringify(buildPayload(v3Hook('PreToolUse', 'x'), { trigger: 'PreToolUse', ws, sessionId: SID, call: read })),
    '{"hook_event_name":"PreToolUse","cwd":"/ws/sub","session_id":"sess-123","tool_name":"read_file","tool_input":{"path":"/ws/docs/hooks.md"}}',
  );
  assert.equal(
    JSON.stringify(
      buildPayload(v3Hook('PostToolUse', 'x'), {
        trigger: 'PostToolUse',
        ws,
        sessionId: SID,
        call: read,
        outcome: { success: true, response: { file: { content: '# Hooks\n\nHooks allow you to execute...' } } },
      }),
    ),
    '{"hook_event_name":"PostToolUse","cwd":"/ws/sub","session_id":"sess-123","tool_name":"read_file","tool_input":{"path":"/ws/docs/hooks.md"},"tool_response":{"success":true,"result":["# Hooks\\n\\nHooks allow you to execute..."]}}',
  );
  assert.equal(JSON.stringify(buildPayload(v3Hook('Stop', 'x'), { trigger: 'Stop', ws, sessionId: SID })), '{"hook_event_name":"Stop","cwd":"/ws/sub","session_id":"sess-123"}');
  assert.equal(JSON.stringify(buildPayload(v3Hook('SessionEnd', 'x'), { trigger: 'SessionEnd', ws, sessionId: SID })), '{"hook_event_name":"SessionEnd","cwd":"/ws/sub","session_id":"sess-123"}');
  const mcp = buildPayload(v3Hook('PreToolUse', 'x'), { trigger: 'PreToolUse', ws, sessionId: SID, call: mkCall('mcp__my-srv__Do It', { a: 1 }) });
  assert.equal(mcp.tool_name, 'mcp_my_srv_do_it');
  assert.equal('tool_tags' in mcp, false);
  const todo = buildPayload(v3Hook('PreToolUse', 'x'), { trigger: 'PreToolUse', ws, sessionId: SID, call: mkCall('TaskCreate', { subject: 's' }) });
  assert.equal(todo.tool_name, 'todo_list');
  // PreToolUse never carries a response even if an outcome is passed by mistake.
  const pre = buildPayload(v3Hook('PreToolUse', 'x'), { trigger: 'PreToolUse', ws, sessionId: SID, call: read, outcome: { success: true } });
  assert.equal('tool_response' in pre, false);
});

test('file trigger payload (03 §2.5 DECISION)', () => {
  const call = mkCall('Write', { file_path: '/ws/src/a.ts', content: '' });
  assert.equal(
    JSON.stringify(buildPayload(v3Hook('PostFileSave', 'x', { rawTrigger: 'fileEdited' }), { trigger: 'PostFileSave', ws, sessionId: SID, filePath: '/ws/src/a.ts', call })),
    '{"hook_event_name":"fileEdited","cwd":"/ws/sub","session_id":"sess-123","file_path":"/ws/src/a.ts","tool_name":"fs_write"}',
  );
  const rel = buildPayload(v3Hook('PostFileCreate', 'x'), { trigger: 'PostFileCreate', ws, sessionId: SID, filePath: 'b.ts' });
  assert.deepEqual(rel, { hook_event_name: 'PostFileCreate', cwd: '/ws/sub', session_id: SID, file_path: '/ws/sub/b.ts' });
});

test('task trigger payloads (03 §1.7.3 DECISION)', () => {
  const task = { specName: 'user-authentication', taskId: '2.1', title: 'Create data models module' };
  assert.equal(
    JSON.stringify(buildPayload(v3Hook('PreTaskExec', 'x'), { trigger: 'PreTaskExec', ws, sessionId: SID, task })),
    '{"hook_event_name":"PreTaskExec","cwd":"/ws/sub","session_id":"sess-123","spec_name":"user-authentication","spec_dir":"/ws/.kiro/specs/user-authentication","task_id":"2.1","task_title":"Create data models module","task_optional":false}',
  );
  const post = buildPayload(v3Hook('PostTaskExec', 'x'), {
    trigger: 'PostTaskExec',
    ws,
    sessionId: SID,
    task: { ...task, optional: true, status: 'failed', specDir: '/elsewhere' },
  });
  assert.equal(post.task_status, 'failed');
  assert.equal(post.task_optional, true);
  assert.equal(post.spec_dir, '/elsewhere');
  const pre = buildPayload(v3Hook('PreTaskExec', 'x'), { trigger: 'PreTaskExec', ws, sessionId: SID, task: { ...task, status: 'completed' } });
  assert.equal('task_status' in pre, false);
});

test('Manual payload', () => {
  assert.deepEqual(buildPayload(v3Hook('Manual', 'x', { rawTrigger: 'userTriggered' }), { trigger: 'Manual', ws, sessionId: SID }), {
    hook_event_name: 'userTriggered',
    cwd: '/ws/sub',
    session_id: SID,
  });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TurnRenderer, describeTool, displayPath, formatTodos, formatToolDuration, formatToolUse, toolHeaderLine, type RenderSettings } from '../../src/repl/render.js';
import type { SessionEvent, TurnResult } from '../../src/types.js';
import { setColorEnabled, stripAnsi } from '../../src/util/ansi.js';
import { call } from './mockSession.js';

setColorEnabled(false);

const S: RenderSettings = { markdown: true, showThinking: true, autoExpandToolOutput: false, ascii: false, cwd: '/work' };

function render(events: SessionEvent[], result?: TurnResult, settings: Partial<RenderSettings> = {}): string {
  let out = '';
  let t = 1000;
  const r = new TurnRenderer((s) => (out += s), { ...S, ...settings }, () => (t += 100));
  r.beginTurn();
  for (const e of events) r.handle(e);
  r.endTurn(result, { progName: 'kiro-claude' });
  return out;
}

const OK: TurnResult = { stopReason: 'end_turn', isError: false, text: '', permissionDenials: [] };

test('render: Q duration format (millis not zero-padded)', () => {
  assert.equal(formatToolDuration(5), '0.5s');
  assert.equal(formatToolDuration(1050), '1.50s');
  assert.equal(formatToolDuration(1200), '1.200s');
  assert.equal(formatToolDuration(0), '0.0s');
  assert.equal(formatToolDuration(61_001), '61.1s');
});

test('render: displayPath (Q tools/mod.rs rule)', () => {
  assert.equal(displayPath('/work/src/a.ts', '/work'), 'src/a.ts');
  assert.equal(displayPath('/work', '/work'), '.');
  assert.equal(displayPath('/x/y', '/work'), '../x/y');
  assert.equal(displayPath('/a', '/work/b/c'), '/a');
});

test('render: tool descriptions per tool', () => {
  const d = (n: string, i: Record<string, unknown>): string => describeTool(call(n, i), { cwd: '/work', expand: false });
  assert.equal(d('Bash', { command: 'ls' }), 'I will run the following shell command: ls\n');
  assert.equal(
    d('Bash', { command: 'git log --oneline -n 20', description: 'Show history' }),
    'I will run the following shell command: \ngit log --oneline -n 20\n ⋮ \n ↳ Purpose: Show history\n',
  );
  assert.equal(d('Read', { file_path: '/work/src/a.ts' }), 'Reading file: src/a.ts, all lines\n');
  assert.equal(d('Read', { file_path: 'src/a.ts', offset: 10 }), 'Reading file: src/a.ts, from line 10 to end of file\n');
  assert.equal(d('Read', { file_path: 'src/a.ts', offset: 10, limit: 5 }), 'Reading file: src/a.ts, from line 10 to 14\n');
  assert.equal(d('Read', { file_path: 'src/a.ts', limit: 5 }), 'Reading file: src/a.ts, from line 1 to 5\n');
  assert.equal(d('Grep', { pattern: 'TODO', path: '/work/src' }), 'Searching: src for pattern: TODO\n');
  assert.equal(d('Glob', { pattern: '**/*.ts' }), 'Searching for files matching: **/*.ts in .\n');
  assert.equal(d('Write', { file_path: '/work/n.txt', content: 'a\nb' }), 'Path: n.txt\n\n+ a\n+ b\n');
  assert.equal(d('Edit', { file_path: '/work/n.txt', old_string: 'x', new_string: 'y' }), 'Path: n.txt\n\n- x\n+ y\n');
  assert.equal(d('WebFetch', { url: 'https://e.x', prompt: 'summarize' }), 'Fetching: https://e.x\n ⋮ \n ↳ Purpose: summarize\n');
  assert.equal(d('WebSearch', { query: 'node 22' }), 'Searching the web for: node 22\n');
  assert.equal(d('Agent', { subagent_type: 'planner', description: 'plan it', prompt: 'p' }), 'Delegating to subagent planner\n ⋮ \n ↳ Purpose: plan it\n');
  assert.equal(d('TaskCreate', { subject: 's', description: 'd' }), '');
  assert.equal(d('mcp__github__create_issue', {}), 'Running create_issue\n');
  assert.equal(d('mcp__github__create_issue', { title: 'x' }), 'Running create_issue with the param:\n ⋮  {\n ⋮    "title": "x"\n ⋮  }\n');
  // previews are capped unless expanded
  const big = Array.from({ length: 15 }, (_, i) => `l${i}`).join('\n');
  const capped = d('Write', { file_path: 'f', content: big });
  assert.ok(capped.includes('+ l9\n... (5 more lines)\n'), capped);
  assert.ok(describeTool(call('Write', { file_path: 'f', content: big }), { cwd: '/work', expand: true }).includes('+ l14\n'));
});

test('render: tool header (06 §5.4)', () => {
  assert.equal(toolHeaderLine(call('Bash', { command: 'ls' }), false), '🛠️  Using tool: shell');
  assert.equal(toolHeaderLine(call('Bash', { command: 'ls' }), true), '🛠️  Using tool: shell (trusted)');
  assert.equal(toolHeaderLine(call('mcp__github__create_issue', {}), true), '🛠️  Using tool: create_issue (trusted) from mcp server github');
  assert.equal(toolHeaderLine(call('Read', { file_path: 'a' }), false, { cont: ' : ', bullet: ' * ', arrow: ' > ', tool: '' }), 'Using tool: read');
  assert.equal(
    formatToolUse(call('Bash', { command: 'ls' }), false, { cwd: '/work', expand: false }),
    '🛠️  Using tool: shell\n ⋮ \n ● I will run the following shell command: ls\n',
  );
  assert.equal(formatToolUse(call('TaskList', {}), true, { cwd: '/work', expand: false }), '🛠️  Using tool: todo_list (trusted)\n');
});

test('render: assistant text gets one green "> " per response', () => {
  const out = render([{ type: 'text_delta', text: '\n\nHello ' }, { type: 'text_delta', text: '**world**\n- item' }], OK);
  assert.equal(out, '> Hello world\n• item\n\n');
});

test('render: complete text blocks and the result-text fallback', () => {
  assert.equal(render([{ type: 'text', text: 'Block one' }, { type: 'text', text: 'Block two' }], OK), '> Block one\nBlock two\n\n');
  assert.equal(render([], { ...OK, text: 'From result' }), '> From result\n\n');
  // a local command result is not echoed
  assert.equal(render([], { ...OK, stopReason: 'local_command', text: 'Set effort' }), '');
});

test('render: markdown can be disabled', () => {
  assert.equal(render([{ type: 'text_delta', text: '**raw** `x`' }], OK, { markdown: false }), '> **raw** `x`\n\n');
});

test('render: thinking shown or hidden (chat.showThinking)', () => {
  const ev: SessionEvent[] = [{ type: 'thinking_delta', text: 'pondering\nmore' }, { type: 'text_delta', text: 'Answer' }];
  assert.equal(render(ev, OK), 'pondering\nmore\n\n> Answer\n\n');
  assert.equal(render(ev, OK, { showThinking: false }), '> Answer\n\n');
});

test('render: tool lifecycle (start, output, completed) and a new "> " after tools', () => {
  const c1 = call('Bash', { command: 'ls' }, 't1');
  const out = render(
    [
      { type: 'text_delta', text: 'Listing.' },
      { type: 'tool_start', toolUseId: 't1', call: c1, trusted: true },
      { type: 'tool_end', toolUseId: 't1', call: c1, isError: false, output: 'a\nb\n', durationMs: 1234 },
      { type: 'text_delta', text: 'Done.' },
    ],
    OK,
  );
  assert.equal(
    out,
    '> Listing.\n\n🛠️  Using tool: shell (trusted)\n ⋮ \n ● I will run the following shell command: ls\n\na\nb\n ⋮ \n ● Completed in 1.234s\n\n> Done.\n\n',
  );
});

test('render: tool failure, measured duration, header once', () => {
  const c1 = call('Read', { file_path: '/work/x' }, 't9');
  const out = render(
    [
      { type: 'tool_start', toolUseId: 't9', call: c1, trusted: false },
      { type: 'tool_start', toolUseId: 't9', call: c1, trusted: false },
      { type: 'tool_end', toolUseId: 't9', isError: true, output: 'ENOENT: no such file' },
    ],
    OK,
  );
  assert.equal(out, '🛠️  Using tool: read\n ⋮ \n ● Reading file: x, all lines\n ⋮ \n ● Execution failed after 0.100s:\nENOENT: no such file\n\n');
});

test('render: read tools print no output; tool_end without start shows the header', () => {
  const c1 = call('Read', { file_path: '/work/x' }, 't2');
  const out = render([{ type: 'tool_end', toolUseId: 't2', call: c1, isError: false, output: 'file content', durationMs: 5 }], OK);
  assert.equal(out, '🛠️  Using tool: read\n ⋮ \n ● Reading file: x, all lines\n ⋮ \n ● Completed in 0.5s\n\n');
});

test('render: denied tool', () => {
  const c1 = call('Bash', { command: 'rm -rf /' }, 't3');
  const out = render([{ type: 'tool_denied', toolUseId: 't3', call: c1, reason: 'Command execute_bash is rejected because it matches one or more rules on the denied list:\n  - rm .*' }], OK);
  assert.equal(
    out,
    '🛠️  Using tool: shell\n ⋮ \n ● I will run the following shell command: rm -rf /\n ⋮ \n ● Command execute_bash is rejected because it matches one or more rules on the denied list:\n  - rm .*\n\n',
  );
});

test('render: todos, compaction, notices, subagents, rate limits, ignored events', () => {
  const out = render(
    [
      {
        type: 'todo_update',
        todos: [
          { id: '1', subject: 'first', status: 'completed' },
          { id: '2', subject: 'second', status: 'in_progress' },
          { id: '3', subject: 'third', status: 'pending' },
          { id: '4', subject: 'gone', status: 'deleted' },
        ],
      },
      { type: 'compaction', state: 'started' },
      { type: 'compaction', state: 'finished', preTokens: 5000, postTokens: 800 },
      { type: 'notice', level: 'warn', message: 'careful' },
      { type: 'subagent', state: 'started', agentType: 'planner', description: 'make a plan' },
      { type: 'subagent', state: 'finished', agentType: 'planner' },
      { type: 'rate_limit', status: 'allowed_warning', utilization: 0.85 },
      { type: 'rate_limit', status: 'allowed' },
      { type: 'session_id', claudeSessionId: 'x' },
      { type: 'raw', frame: {} },
    ],
    OK,
  );
  assert.equal(
    out,
    'TODO:\n[x] first\n[ ] second (in progress)\n[ ] third\n' +
      'Summarizing the conversation history...\n' +
      '✔ Conversation history has been compacted successfully! (5000 → 800 tokens)\n\n' +
      'careful\n' +
      ' ↳ Subagent planner started: make a plan\n' +
      ' ↳ Subagent planner finished\n' +
      'You are approaching your Claude usage limit (85% used).\n\n',
  );
  const rej = render([{ type: 'rate_limit', status: 'rejected', resetsAt: 1_800_000_000 }], OK);
  assert.match(rej, /^You have reached your Claude usage limit\. It resets at \d{4}-\d\d-\d\d \d\d:\d\d\.\n/);
  assert.equal(formatTodos([]), 'TODO: (empty)\n');
});

test('render: end-of-turn messages', () => {
  assert.equal(render([], { ...OK, isError: true, stopReason: 'error', error: 'API Error: overloaded' }), 'Kiro is having trouble responding right now: API Error: overloaded\n\n');
  assert.equal(render([], { ...OK, isError: true, stopReason: 'error', authError: true, error: 'x' }), 'You are not logged in, please log in with kiro-claude login\n');
  assert.equal(render([{ type: 'text_delta', text: 'partial' }], { ...OK, stopReason: 'cancelled' }), '> partial\n\n');
  assert.equal(render([], { ...OK, stopReason: 'max_turns' }), 'The turn stopped after reaching the maximum number of agent turns.\n\n');
  assert.equal(render([], { ...OK, stopReason: 'refusal' }), 'The model declined to answer this request.\n\n');
});

test('render: ascii glyphs', () => {
  const c1 = call('Bash', { command: 'ls' }, 't1');
  const out = render([{ type: 'tool_start', toolUseId: 't1', call: c1, trusted: false }, { type: 'tool_end', toolUseId: 't1', isError: false, output: '', durationMs: 5 }], OK, { ascii: true });
  assert.equal(out, 'Using tool: shell\n : \n * I will run the following shell command: ls\n : \n * Completed in 0.5s\n\n');
});

test('render: colours are applied and strip to the plain text', () => {
  setColorEnabled(true);
  try {
    const c1 = call('Bash', { command: 'ls' }, 't1');
    const out = render([{ type: 'tool_start', toolUseId: 't1', call: c1, trusted: true }, { type: 'text_delta', text: 'hi' }], OK);
    assert.ok(out.includes('\u001b[35m🛠️  Using tool: shell\u001b[39m'), out);
    assert.ok(out.includes('\u001b[32m (trusted)\u001b[39m'));
    assert.ok(out.includes('\u001b[32m> \u001b[39m'));
    assert.equal(stripAnsi(out), '🛠️  Using tool: shell (trusted)\n ⋮ \n ● I will run the following shell command: ls\n\n> hi\n\n');
  } finally {
    setColorEnabled(false);
  }
});

/**
 * Tool map (00 §4.1 master table, §4.2 selectors, §4.3 names): every master-table row through
 * toKiroCall, name normalization, V3 MCP ids, display labels and selector expansion.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import {
  BUILTIN_CLAUDE_TOOLS,
  NEVER_EXPOSE_TOOLS,
  claudeMcpName,
  expandToolSelectors,
  globPatternRoot,
  isMcpToolSelected,
  isSubagentSelected,
  isTodoTool,
  normalizeV2Name,
  splitMcpName,
  toKiroCall,
  toolDisplay,
  v3IdForMcp,
  type McpServerSelectorInfo,
} from '../../src/policy/toolmap.js';
import { homeDir } from '../../src/util/paths.js';

const CWD = '/work/proj';

interface Row {
  claude: string;
  input: Record<string, unknown>;
  v3Id: string | undefined;
  tags: string[];
  capability: string;
  subjects: string[];
  kiro2Name: string;
  v2Name: string;
  display: string;
  mutating: boolean;
}

const MASTER: Row[] = [
  { claude: 'Read', input: { file_path: '/a/b.txt' }, v3Id: 'read_file', tags: ['read', '@builtin'], capability: 'fs_read', subjects: ['/a/b.txt'], kiro2Name: 'read', v2Name: 'fs_read', display: 'read', mutating: false },
  { claude: 'Read', input: { file_path: 'rel/b.txt' }, v3Id: 'read_file', tags: ['read', '@builtin'], capability: 'fs_read', subjects: ['/work/proj/rel/b.txt'], kiro2Name: 'read', v2Name: 'fs_read', display: 'read', mutating: false },
  { claude: 'Glob', input: { pattern: '**/*.ts' }, v3Id: 'file_search', tags: ['read', '@builtin'], capability: 'fs_read', subjects: [CWD], kiro2Name: 'glob', v2Name: 'glob', display: 'glob', mutating: false },
  { claude: 'Glob', input: { pattern: '*.ts', path: '/x/src' }, v3Id: 'file_search', tags: ['read', '@builtin'], capability: 'fs_read', subjects: ['/x/src'], kiro2Name: 'glob', v2Name: 'glob', display: 'glob', mutating: false },
  { claude: 'Grep', input: { pattern: 'TODO' }, v3Id: 'grep_search', tags: ['read', '@builtin'], capability: 'fs_read', subjects: [CWD], kiro2Name: 'grep', v2Name: 'grep', display: 'grep', mutating: false },
  { claude: 'Grep', input: { pattern: 'TODO', path: 'src' }, v3Id: 'grep_search', tags: ['read', '@builtin'], capability: 'fs_read', subjects: ['/work/proj/src'], kiro2Name: 'grep', v2Name: 'grep', display: 'grep', mutating: false },
  { claude: 'Write', input: { file_path: '/a/new.txt', content: 'x' }, v3Id: 'fs_write', tags: ['write', '@builtin'], capability: 'fs_write', subjects: ['/a/new.txt'], kiro2Name: 'write', v2Name: 'fs_write', display: 'write', mutating: true },
  { claude: 'Edit', input: { file_path: '/a/b.txt', old_string: 'a', new_string: 'b' }, v3Id: 'str_replace', tags: ['write', '@builtin'], capability: 'fs_write', subjects: ['/a/b.txt'], kiro2Name: 'write', v2Name: 'fs_write', display: 'write', mutating: true },
  { claude: 'MultiEdit', input: { file_path: '/a/b.txt', edits: [] }, v3Id: 'str_replace', tags: ['write', '@builtin'], capability: 'fs_write', subjects: ['/a/b.txt'], kiro2Name: 'write', v2Name: 'fs_write', display: 'write', mutating: true },
  { claude: 'NotebookEdit', input: { notebook_path: 'nb.ipynb', new_source: 'x' }, v3Id: 'fs_write', tags: ['write', '@builtin'], capability: 'fs_write', subjects: ['/work/proj/nb.ipynb'], kiro2Name: 'write', v2Name: 'fs_write', display: 'write', mutating: true },
  { claude: 'Bash', input: { command: 'git status && npm test', description: 'd' }, v3Id: 'execute_bash', tags: ['shell', '@builtin'], capability: 'shell', subjects: ['git status', 'npm test'], kiro2Name: 'shell', v2Name: 'execute_bash', display: 'shell', mutating: true },
  { claude: 'WebFetch', input: { url: 'https://example.com/x', prompt: 'p' }, v3Id: 'web_fetch', tags: ['web', '@builtin'], capability: 'web_fetch', subjects: ['https://example.com/x'], kiro2Name: 'web_fetch', v2Name: 'web_fetch', display: 'web_fetch', mutating: false },
  { claude: 'WebSearch', input: { query: 'kiro cli' }, v3Id: 'remote_web_search', tags: ['web', '@builtin'], capability: 'web_search', subjects: ['kiro cli'], kiro2Name: 'web_search', v2Name: 'web_search', display: 'web_search', mutating: false },
  { claude: 'Agent', input: { description: 'd', prompt: 'p', subagent_type: 'reviewer' }, v3Id: 'invoke_sub_agent', tags: ['subagent', '@builtin'], capability: 'subagent', subjects: ['reviewer'], kiro2Name: 'subagent', v2Name: 'use_subagent', display: 'subagent', mutating: true },
  { claude: 'Task', input: { description: 'd', prompt: 'p', subagent_type: 'reviewer' }, v3Id: 'invoke_sub_agent', tags: ['subagent', '@builtin'], capability: 'subagent', subjects: ['reviewer'], kiro2Name: 'subagent', v2Name: 'use_subagent', display: 'subagent', mutating: true },
  { claude: 'Agent', input: { description: 'd', prompt: 'p' }, v3Id: 'invoke_sub_agent', tags: ['subagent', '@builtin'], capability: 'subagent', subjects: ['general-purpose'], kiro2Name: 'subagent', v2Name: 'use_subagent', display: 'subagent', mutating: true },
  { claude: 'TaskCreate', input: { subject: 's', description: 'd' }, v3Id: undefined, tags: ['@builtin'], capability: 'utility', subjects: [], kiro2Name: 'todo_list', v2Name: 'todo_list', display: 'todo_list', mutating: false },
  { claude: 'TaskUpdate', input: { taskId: '1', status: 'completed' }, v3Id: undefined, tags: ['@builtin'], capability: 'utility', subjects: [], kiro2Name: 'todo_list', v2Name: 'todo_list', display: 'todo_list', mutating: false },
  { claude: 'TaskList', input: {}, v3Id: undefined, tags: ['@builtin'], capability: 'utility', subjects: [], kiro2Name: 'todo_list', v2Name: 'todo_list', display: 'todo_list', mutating: false },
  { claude: 'TaskGet', input: { taskId: '1' }, v3Id: undefined, tags: ['@builtin'], capability: 'utility', subjects: [], kiro2Name: 'todo_list', v2Name: 'todo_list', display: 'todo_list', mutating: false },
  { claude: 'TaskStop', input: {}, v3Id: undefined, tags: ['@builtin'], capability: 'utility', subjects: [], kiro2Name: 'todo_list', v2Name: 'todo_list', display: 'todo_list', mutating: false },
  { claude: 'TodoWrite', input: { todos: [] }, v3Id: undefined, tags: ['@builtin'], capability: 'utility', subjects: [], kiro2Name: 'todo_list', v2Name: 'todo_list', display: 'todo_list', mutating: false },
  { claude: 'Skill', input: { skill: 'kiro:backend-patterns' }, v3Id: 'disclose_context', tags: ['context', '@builtin'], capability: 'skill', subjects: ['backend-patterns'], kiro2Name: 'skill', v2Name: 'skill', display: 'skill', mutating: false },
  { claude: 'Skill', input: { skill: 'pdf' }, v3Id: 'disclose_context', tags: ['context', '@builtin'], capability: 'skill', subjects: ['pdf'], kiro2Name: 'skill', v2Name: 'skill', display: 'skill', mutating: false },
  { claude: 'mcp__git__status', input: { repo: '.' }, v3Id: 'mcp_git_status', tags: ['@mcp', '@git', '@git/status'], capability: 'mcp', subjects: ['git/status'], kiro2Name: '@git/status', v2Name: '@git/status', display: 'status', mutating: true },
  { claude: 'mcp__my-srv__get_thing', input: {}, v3Id: 'mcp_my_srv_get_thing', tags: ['@mcp', '@my-srv', '@my-srv/get_thing'], capability: 'mcp', subjects: ['my-srv/get_thing'], kiro2Name: '@my-srv/get_thing', v2Name: '@my-srv/get_thing', display: 'get_thing', mutating: true },
  { claude: 'mcp__srv__a__b', input: {}, v3Id: 'mcp_srv_a__b', tags: ['@mcp', '@srv', '@srv/a__b'], capability: 'mcp', subjects: ['srv/a__b'], kiro2Name: '@srv/a__b', v2Name: '@srv/a__b', display: 'a__b', mutating: true },
  { claude: 'LSP', input: { op: 'x' }, v3Id: undefined, tags: ['@builtin'], capability: 'utility', subjects: [], kiro2Name: 'LSP', v2Name: 'LSP', display: 'LSP', mutating: false },
  { claude: 'ToolSearch', input: {}, v3Id: undefined, tags: ['@builtin'], capability: 'utility', subjects: [], kiro2Name: 'tool_search', v2Name: 'tool_search', display: 'tool_search', mutating: false },
];

describe('toKiroCall: master table (00 §4.1)', () => {
  for (const r of MASTER) {
    it(`${r.claude} ${JSON.stringify(r.input)}`, () => {
      const c = toKiroCall(r.claude, r.input, { cwd: CWD });
      assert.equal(c.claudeName, r.claude);
      assert.equal(c.v3Id, r.v3Id);
      assert.deepEqual(c.tags, r.tags);
      assert.equal(c.capability, r.capability);
      assert.deepEqual(c.subjects, r.subjects);
      assert.equal(c.kiro2Name, r.kiro2Name);
      assert.equal(c.v2Name, r.v2Name);
      assert.equal(c.displayName, r.display);
      assert.equal(c.mutating, r.mutating);
      assert.equal(c.cwd, CWD);
      assert.equal(c.input, r.input, 'input is passed through unmodified');
      assert.equal(c.parseable, true);
      assert.equal(c.toolUseId, undefined);
      assert.equal(c.subagent, undefined);
      if (r.capability === 'mcp') assert.ok(c.mcp);
      else assert.equal(c.mcp, undefined);
    });
  }

  it('v3Id property is absent (not undefined-valued) when V3 has no tool', () => {
    const c = toKiroCall('TaskCreate', {}, { cwd: CWD });
    assert.ok(!Object.prototype.hasOwnProperty.call(c, 'v3Id'));
  });

  it('carries toolUseId and subagent', () => {
    const c = toKiroCall('Read', { file_path: '/x' }, { cwd: CWD, toolUseId: 'toolu_1', subagent: { id: 'a1', type: 'reviewer' } });
    assert.equal(c.toolUseId, 'toolu_1');
    assert.deepEqual(c.subagent, { id: 'a1', type: 'reviewer' });
  });

  it('expands ~ in file paths', () => {
    const c = toKiroCall('Read', { file_path: '~/notes.md' }, { cwd: CWD });
    assert.deepEqual(c.subjects, [path.join(homeDir(process.env), 'notes.md')]);
  });

  it('normalizes .. in paths', () => {
    const c = toKiroCall('Write', { file_path: '../other/x.txt' }, { cwd: CWD });
    assert.deepEqual(c.subjects, ['/work/other/x.txt']);
  });

  it('Bash: unparseable command ⇒ parseable:false, whole command as only subject', () => {
    for (const cmd of ["echo 'unterminated", 'echo $(rm -rf /)', 'echo `id`', 'cat <(ls)']) {
      const c = toKiroCall('Bash', { command: cmd }, { cwd: CWD });
      assert.equal(c.parseable, false, cmd);
      assert.deepEqual(c.subjects, [cmd]);
    }
  });

  it('Bash: splits on ; && || | & and newline', () => {
    const c = toKiroCall('Bash', { command: 'a; b && c || d | e & f\ng' }, { cwd: CWD });
    assert.deepEqual(c.subjects, ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
    assert.equal(c.parseable, true);
  });

  it('Bash: empty command yields one empty subject', () => {
    const c = toKiroCall('Bash', { command: '' }, { cwd: CWD });
    assert.deepEqual(c.subjects, ['']);
    assert.equal(c.summary, '');
  });

  it('Bash: missing command is tolerated', () => {
    const c = toKiroCall('Bash', {}, { cwd: CWD });
    assert.equal(c.capability, 'shell');
  });

  it('summaries', () => {
    assert.equal(toKiroCall('Bash', { command: 'ls -la\necho hi' }, { cwd: CWD }).summary, 'ls -la …');
    assert.equal(toKiroCall('Read', { file_path: 'a' }, { cwd: CWD }).summary, '/work/proj/a');
    assert.equal(toKiroCall('Glob', { pattern: '*.ts', path: 'src' }, { cwd: CWD }).summary, '*.ts in /work/proj/src');
    assert.equal(toKiroCall('Grep', { pattern: 'x' }, { cwd: CWD }).summary, 'x');
    assert.equal(toKiroCall('Agent', { subagent_type: 'r', description: 'review' }, { cwd: CWD }).summary, 'r: review');
    assert.equal(toKiroCall('TaskCreate', { subject: 'Do it' }, { cwd: CWD }).summary, 'Do it');
    assert.equal(toKiroCall('mcp__s__t', { a: 1 }, { cwd: CWD }).summary, '{"a":1}');
    const long = 'x'.repeat(500);
    assert.equal(toKiroCall('WebSearch', { query: long }, { cwd: CWD }).summary.length, 200);
  });

  it('MCP: Claude-normalized server name mapped back to the configured name', () => {
    const c = toKiroCall('mcp__my_srv__do_it', { a: 1 }, { cwd: CWD, mcpServerNames: { my_srv: 'my.srv' } });
    assert.deepEqual(c.mcp, { server: 'my.srv', tool: 'do_it' });
    assert.equal(c.v2Name, '@my.srv/do_it');
    assert.equal(c.v3Id, 'mcp_mysrv_do_it');
    assert.deepEqual(c.subjects, ['my.srv/do_it']);
    assert.deepEqual(c.tags, ['@mcp', '@my.srv', '@my.srv/do_it']);
  });

  it('MCP: a known server name containing __ wins over the first-__ split', () => {
    const c = toKiroCall('mcp__a__b__tool', {}, { cwd: CWD, mcpServerNames: { a__b: 'a__b' } });
    assert.deepEqual(c.mcp, { server: 'a__b', tool: 'tool' });
    const d = toKiroCall('mcp__a__b__tool', {}, { cwd: CWD });
    assert.deepEqual(d.mcp, { server: 'a', tool: 'b__tool' });
  });

  it('malformed mcp names are unidentified MCP calls (never harmless utility tools)', () => {
    for (const n of ['mcp__', 'mcp__srv', 'mcp____tool']) {
      const c = toKiroCall(n, {}, { cwd: CWD });
      assert.equal(c.capability, 'mcp', n);
      assert.equal(c.mutating, true, n);
      assert.equal(c.mcp, undefined, n);
      assert.equal(c.v2Name, n);
      assert.deepEqual(c.tags, ['@mcp'], n);
    }
  });
});

describe('Glob pattern roots (extra fs_read subject)', () => {
  const v: Array<[string, string, string | undefined]> = [
    ['**/*.ts', CWD, undefined],
    ['*.ts', CWD, undefined],
    ['src/**', CWD, '/work/proj/src'],
    ['src/*/x/**', CWD, '/work/proj/src'],
    ['/etc/**/*.conf', CWD, '/etc'],
    ['../../secret/*', CWD, '/secret'],
    ['../sibling/*.md', CWD, '/work/sibling'],
    ['/work/proj/src/*.ts', CWD, '/work/proj/src'],
    ['/work/projX/*', CWD, '/work/projX'],
    ['package.json', CWD, undefined],
    ['/etc/passwd', CWD, '/etc'],
    ['{a,b}/*', CWD, undefined],
    ['*', '/', undefined],
    ['', CWD, undefined],
  ];
  for (const [pat, root, exp] of v) it(`${pat} in ${root} → ${exp}`, () => assert.equal(globPatternRoot(pat, root), exp));

  it('toKiroCall adds the pattern root for Glob only', () => {
    const c = toKiroCall('Glob', { pattern: '/etc/**' }, { cwd: CWD });
    assert.deepEqual(c.subjects, [CWD, '/etc']);
    const g = toKiroCall('Grep', { pattern: '/etc/**' }, { cwd: CWD });
    assert.deepEqual(g.subjects, [CWD], 'Grep pattern is a regex, not a path');
  });
});

describe('isTodoTool / claudeMcpName / splitMcpName', () => {
  it('todo tools', () => {
    for (const t of ['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TaskStop', 'TaskOutput', 'TodoWrite']) assert.ok(isTodoTool(t), t);
    for (const t of ['Task', 'Tasks', 'Taskcreate', 'Agent', 'Read']) assert.ok(!isTodoTool(t), t);
  });
  it('claudeMcpName', () => {
    assert.equal(claudeMcpName('my.server name'), 'my_server_name');
    assert.equal(claudeMcpName('ok-name_1'), 'ok-name_1');
  });
  it('splitMcpName', () => {
    assert.deepEqual(splitMcpName('mcp__git__status'), { claudeServer: 'git', tool: 'status' });
    assert.equal(splitMcpName('Read'), undefined);
    assert.equal(splitMcpName('mcp__x'), undefined);
  });
});

describe('normalizeV2Name (00 §4.3)', () => {
  const v: Array<[string, string]> = [
    ['read', 'fs_read'], ['fsRead', 'fs_read'], ['fs_read', 'fs_read'],
    ['write', 'fs_write'], ['fsWrite', 'fs_write'], ['fs_write', 'fs_write'],
    ['shell', 'execute_bash'], ['execute_cmd', 'execute_bash'], ['executeCmd', 'execute_bash'], ['execute_bash', 'execute_bash'],
    ['aws', 'use_aws'], ['use_aws', 'use_aws'],
    ['subagent', 'use_subagent'], ['agent_crew', 'use_subagent'], ['use_subagent', 'use_subagent'],
    ['todo', 'todo_list'], ['task', 'todo_list'], ['todo_list', 'todo_list'],
    ['glob', 'glob'], ['grep', 'grep'], ['web_fetch', 'web_fetch'], ['web_search', 'web_search'],
    ['@git', '@git'], ['@git/status', '@git/status'], ['@builtin', '@builtin'], ['@builtin/', '@builtin/'], ['@builtin/*', '@builtin/*'],
    ['@builtin/read', '@builtin/fs_read'], ['@builtin/shell', '@builtin/execute_bash'],
    // V3 ids (column 2)
    ['read_file', 'fs_read'], ['list_directory', 'fs_read'], ['str_replace', 'fs_write'], ['fs_append', 'fs_write'],
    ['delete_file', 'fs_write'], ['file_search', 'glob'], ['grep_search', 'grep'], ['remote_web_search', 'web_search'],
    ['invoke_sub_agent', 'use_subagent'], ['execute_pwsh', 'execute_bash'], ['disclose_context', 'skill'],
    ['knowledge', 'knowledge'], ['custom_thing', 'custom_thing'], ['*', '*'], ['fs_*', 'fs_*'],
    ['constructor', 'constructor'], ['toString', 'toString'],
  ];
  for (const [a, b] of v) it(`${a} → ${b}`, () => assert.equal(normalizeV2Name(a), b));
});

describe('v3IdForMcp (00 §4.1)', () => {
  const v: Array<[string, string, string]> = [
    ['git', 'status', 'mcp_git_status'],
    ['My Server', 'Get-Thing', 'mcp_my_server_get_thing'],
    ['my.srv', 'do.it', 'mcp_mysrv_doit'],
    ['a\tb', 'c d', 'mcp_a_b_c_d'],
    ['srv', 'tool@v2!', 'mcp_srv_toolv2'],
    ['x'.repeat(40), 'y'.repeat(40), `mcp_${'x'.repeat(40)}_${'y'.repeat(19)}`],
  ];
  for (const [s, t, e] of v) it(`${s}/${t} → ${e}`, () => {
    const id = v3IdForMcp(s, t);
    assert.equal(id, e);
    assert.ok(id.length <= 64);
  });
});

describe('toolDisplay (Classic display name, 06 §5.4)', () => {
  it('built-ins use the display name, MCP tools add the server', () => {
    assert.equal(toolDisplay(toKiroCall('Bash', { command: 'ls' }, { cwd: CWD })), 'shell');
    assert.equal(toolDisplay(toKiroCall('Read', { file_path: '/x' }, { cwd: CWD })), 'read');
    assert.equal(toolDisplay(toKiroCall('TaskCreate', {}, { cwd: CWD })), 'todo_list');
    assert.equal(toolDisplay(toKiroCall('mcp__git__status', {}, { cwd: CWD })), 'status from mcp server git');
  });
});

describe('constants', () => {
  it('BUILTIN_CLAUDE_TOOLS is the @builtin expansion', () => {
    assert.deepEqual([...BUILTIN_CLAUDE_TOOLS], [
      'Read', 'Glob', 'Grep', 'Write', 'Edit', 'NotebookEdit', 'Bash', 'WebFetch', 'WebSearch', 'Agent',
      'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet',
    ]);
    assert.ok(Object.isFrozen(BUILTIN_CLAUDE_TOOLS));
  });
  it('NEVER_EXPOSE_TOOLS', () => {
    for (const t of ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode']) assert.ok(NEVER_EXPOSE_TOOLS.includes(t), t);
    // ToolSearch is exposed when an agent selects Kiro's tool_search (KiroCrew specs do, 08 KC-SPEC-02)
    assert.ok(!NEVER_EXPOSE_TOOLS.includes('ToolSearch'));
    for (const t of BUILTIN_CLAUDE_TOOLS) assert.ok(!NEVER_EXPOSE_TOOLS.includes(t), t);
  });
});

// ───────────────────────────── selector expansion ─────────────────────────────

const SERVERS: McpServerSelectorInfo[] = [
  { name: 'git', claudeName: 'git', disabledTools: [] },
  { name: 'fs', claudeName: 'fs', disabledTools: ['delete'] },
  { name: 'my.srv', claudeName: 'my_srv', disabledTools: [] },
];
const AGENTS = ['reviewer', 'planner', 'writer'];
const ALL_BUILTIN = [...BUILTIN_CLAUDE_TOOLS];

function expand(tools: string[], excludedTools: string[] = [], skillsLoaded = false) {
  return expandToolSelectors({ tools, excludedTools, skillsLoaded, mcpServers: SERVERS, agentNames: AGENTS });
}

describe('expandToolSelectors (00 §4.2)', () => {
  interface Case {
    tools: string[];
    excluded?: string[];
    skills?: boolean;
    claudeTools: string[];
    mcpServers: string[];
    disallowed?: string[];
    subagents: 'all' | string[];
    partial?: Record<string, string[]>;
    warnings?: number;
  }
  const cases: Case[] = [
    { tools: [], claudeTools: [], mcpServers: [], subagents: [] },
    { tools: ['*'], claudeTools: ALL_BUILTIN, mcpServers: ['git', 'fs', 'my.srv'], disallowed: ['mcp__fs__delete'], subagents: 'all' },
    { tools: ['*'], skills: true, claudeTools: [...ALL_BUILTIN, 'Skill'], mcpServers: ['git', 'fs', 'my.srv'], disallowed: ['mcp__fs__delete'], subagents: 'all' },
    { tools: ['@builtin'], claudeTools: ALL_BUILTIN, mcpServers: [], subagents: 'all' },
    { tools: ['@builtin/*'], claudeTools: ALL_BUILTIN, mcpServers: [], subagents: 'all' },
    { tools: ['@builtin', '@mcp'], claudeTools: ALL_BUILTIN, mcpServers: ['git', 'fs', 'my.srv'], disallowed: ['mcp__fs__delete'], subagents: 'all' },
    { tools: ['@mcp'], claudeTools: [], mcpServers: ['git', 'fs', 'my.srv'], disallowed: ['mcp__fs__delete'], subagents: [] },
    { tools: ['read'], claudeTools: ['Read', 'Glob', 'Grep'], mcpServers: [], subagents: [] },
    { tools: ['fs_read'], claudeTools: ['Read', 'Glob', 'Grep'], mcpServers: [], subagents: [] },
    { tools: ['fsRead'], claudeTools: ['Read', 'Glob', 'Grep'], mcpServers: [], subagents: [] },
    { tools: ['read_file'], claudeTools: ['Read'], mcpServers: [], subagents: [] },
    { tools: ['file_search'], claudeTools: ['Glob'], mcpServers: [], subagents: [] },
    { tools: ['glob'], claudeTools: ['Glob'], mcpServers: [], subagents: [] },
    { tools: ['grep_search'], claudeTools: ['Grep'], mcpServers: [], subagents: [] },
    { tools: ['grep'], claudeTools: ['Grep'], mcpServers: [], subagents: [] },
    { tools: ['write'], claudeTools: ['Write', 'Edit', 'NotebookEdit'], mcpServers: [], subagents: [] },
    { tools: ['fs_write'], claudeTools: ['Write', 'Edit', 'NotebookEdit'], mcpServers: [], subagents: [] },
    { tools: ['str_replace'], claudeTools: ['Write', 'Edit', 'NotebookEdit'], mcpServers: [], subagents: [] },
    { tools: ['fs_append'], claudeTools: ['Write', 'Edit', 'NotebookEdit'], mcpServers: [], subagents: [] },
    { tools: ['delete_file'], claudeTools: ['Write', 'Edit', 'NotebookEdit'], mcpServers: [], subagents: [] },
    { tools: ['shell'], claudeTools: ['Bash'], mcpServers: [], subagents: [] },
    { tools: ['execute_bash'], claudeTools: ['Bash'], mcpServers: [], subagents: [] },
    { tools: ['execute_cmd'], claudeTools: ['Bash'], mcpServers: [], subagents: [] },
    { tools: ['web'], claudeTools: ['WebFetch', 'WebSearch'], mcpServers: [], subagents: [] },
    { tools: ['web_fetch'], claudeTools: ['WebFetch'], mcpServers: [], subagents: [] },
    { tools: ['remote_web_search'], claudeTools: ['WebSearch'], mcpServers: [], subagents: [] },
    { tools: ['web_search'], claudeTools: ['WebSearch'], mcpServers: [], subagents: [] },
    { tools: ['subagent'], claudeTools: ['Agent'], mcpServers: [], subagents: 'all' },
    { tools: ['invoke_sub_agent'], claudeTools: ['Agent'], mcpServers: [], subagents: 'all' },
    { tools: ['use_subagent'], claudeTools: ['Agent'], mcpServers: [], subagents: 'all' },
    { tools: ['subagent/reviewer', 'subagent/planner'], claudeTools: ['Agent'], mcpServers: [], subagents: ['reviewer', 'planner'] },
    { tools: ['subagent/*'], claudeTools: ['Agent'], mcpServers: [], subagents: 'all' },
    { tools: ['todo_list'], claudeTools: ['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'], mcpServers: [], subagents: [] },
    { tools: ['todo'], claudeTools: ['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'], mcpServers: [], subagents: [] },
    { tools: ['task'], claudeTools: ['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'], mcpServers: [], subagents: [] },
    { tools: ['skill'], claudeTools: [], mcpServers: [], subagents: [] },
    { tools: ['skill'], skills: true, claudeTools: ['Skill'], mcpServers: [], subagents: [] },
    { tools: ['@git'], claudeTools: [], mcpServers: ['git'], subagents: [] },
    { tools: ['@git/'], claudeTools: [], mcpServers: ['git'], subagents: [] },
    { tools: ['@git/*'], claudeTools: [], mcpServers: ['git'], subagents: [] },
    { tools: ['@git/status', '@git/log'], claudeTools: [], mcpServers: ['git'], subagents: [], partial: { git: ['status', 'log'] } },
    { tools: ['@git/status', '@git'], claudeTools: [], mcpServers: ['git'], subagents: [] },
    { tools: ['@my.srv'], claudeTools: [], mcpServers: ['my.srv'], subagents: [] },
    { tools: ['@my_srv'], claudeTools: [], mcpServers: ['my.srv'], subagents: [] },
    { tools: ['@f*'], claudeTools: [], mcpServers: ['fs'], disallowed: ['mcp__fs__delete'], subagents: [] },
    { tools: ['@fs'], claudeTools: [], mcpServers: ['fs'], disallowed: ['mcp__fs__delete'], subagents: [] },
    // unsupported Kiro tools: nothing + warning
    // introspect/code/session/report have no Claude equivalent and are ignored silently (every Kiro and
    // KiroCrew default spec selects them); knowledge/use_aws still warn
    { tools: ['knowledge', 'introspect', 'code', 'use_aws'], claudeTools: [], mcpServers: [], subagents: [], warnings: 2 },
    { tools: ['session', 'report'], claudeTools: [], mcpServers: [], subagents: [], warnings: 0 },
    { tools: ['fs_read', 'tool_search'], claudeTools: ['Read', 'Glob', 'Grep', 'ToolSearch'], mcpServers: [], subagents: [], warnings: 0 },
    { tools: ['nonsense'], claudeTools: [], mcpServers: [], subagents: [], warnings: 1 },
    { tools: ['@nope'], claudeTools: [], mcpServers: [], subagents: [], warnings: 1 },
    // NEVER_EXPOSE names are not selectors at all
    { tools: ['ToolSearch', 'AskUserQuestion'], claudeTools: [], mcpServers: [], subagents: [], warnings: 2 },
    // excludedTools subtraction
    { tools: ['*'], excluded: ['shell'], claudeTools: ALL_BUILTIN.filter((t) => t !== 'Bash'), mcpServers: ['git', 'fs', 'my.srv'], disallowed: ['mcp__fs__delete'], subagents: 'all' },
    { tools: ['*'], excluded: ['write', 'web'], claudeTools: ['Read', 'Glob', 'Grep', 'Bash', 'Agent', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'], mcpServers: ['git', 'fs', 'my.srv'], disallowed: ['mcp__fs__delete'], subagents: 'all' },
    { tools: ['*'], excluded: ['@mcp'], claudeTools: ALL_BUILTIN, mcpServers: [], subagents: 'all' },
    { tools: ['*'], excluded: ['@git'], claudeTools: ALL_BUILTIN, mcpServers: ['fs', 'my.srv'], disallowed: ['mcp__fs__delete'], subagents: 'all' },
    { tools: ['*'], excluded: ['@git/push', '@my.srv/a.b'], claudeTools: ALL_BUILTIN, mcpServers: ['git', 'fs', 'my.srv'], disallowed: ['mcp__git__push', 'mcp__fs__delete', 'mcp__my_srv__a_b'], subagents: 'all' },
    { tools: ['*'], excluded: ['@git/push_*'], claudeTools: ALL_BUILTIN, mcpServers: ['git', 'fs', 'my.srv'], disallowed: ['mcp__fs__delete'], subagents: 'all' },
    { tools: ['*'], excluded: ['@builtin'], claudeTools: [], mcpServers: ['git', 'fs', 'my.srv'], disallowed: ['mcp__fs__delete'], subagents: [] },
    { tools: ['*'], excluded: ['*'], claudeTools: [], mcpServers: [], subagents: [] },
    { tools: ['*'], excluded: ['subagent'], claudeTools: ALL_BUILTIN.filter((t) => t !== 'Agent'), mcpServers: ['git', 'fs', 'my.srv'], disallowed: ['mcp__fs__delete'], subagents: [] },
    { tools: ['*'], excluded: ['subagent/planner'], claudeTools: ALL_BUILTIN, mcpServers: ['git', 'fs', 'my.srv'], disallowed: ['mcp__fs__delete'], subagents: ['reviewer', 'writer'] },
    { tools: ['subagent/reviewer', 'subagent/planner'], excluded: ['subagent/planner'], claudeTools: ['Agent'], mcpServers: [], subagents: ['reviewer'] },
    { tools: ['read', 'write'], excluded: ['read_file'], claudeTools: ['Glob', 'Grep', 'Write', 'Edit', 'NotebookEdit'], mcpServers: [], subagents: [] },
    { tools: ['@builtin/read', '@builtin/shell'], claudeTools: ['Read', 'Glob', 'Grep', 'Bash'], mcpServers: [], subagents: [] },
    { tools: ['  read  ', ''], claudeTools: ['Read', 'Glob', 'Grep'], mcpServers: [], subagents: [] },
  ];
  for (const c of cases) {
    it(`tools=${JSON.stringify(c.tools)} excluded=${JSON.stringify(c.excluded ?? [])}${c.skills ? ' +skills' : ''}`, () => {
      const r = expand(c.tools, c.excluded ?? [], c.skills ?? false);
      assert.deepEqual(r.claudeTools, c.claudeTools);
      assert.deepEqual(r.mcpServers, c.mcpServers);
      assert.deepEqual(r.disallowedTools, c.disallowed ?? []);
      assert.deepEqual(r.subagents, c.subagents);
      assert.deepEqual(r.partialMcp, c.partial ?? {});
      assert.equal(r.warnings.length, c.warnings ?? 0, r.warnings.join('\n'));
      for (const t of NEVER_EXPOSE_TOOLS) assert.ok(!r.claudeTools.includes(t));
    });
  }

  it('warns for subagent/<name> naming an unknown agent', () => {
    const r = expand(['subagent/ghost']);
    assert.deepEqual(r.subagents, ['ghost']);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0]!, /ghost/);
  });

  it('server disabledTools are disallowed even under partial selection', () => {
    const r = expand(['@fs/read']);
    assert.deepEqual(r.mcpServers, ['fs']);
    assert.deepEqual(r.partialMcp, { fs: ['read'] });
    assert.deepEqual(r.disallowedTools, ['mcp__fs__delete']);
  });

  it('canonical --tools order regardless of selector order', () => {
    const r = expand(['shell', 'read', 'todo', 'web_fetch', 'write']);
    assert.deepEqual(r.claudeTools, ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'NotebookEdit', 'Bash', 'WebFetch', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']);
  });
});

describe('isMcpToolSelected / isSubagentSelected (gate P1 enforcement)', () => {
  const v: Array<[string[], string[], string, string, boolean]> = [
    [['*'], [], 'git', 'status', true],
    [['@git'], [], 'git', 'push', true],
    [['@git/status'], [], 'git', 'status', true],
    [['@git/status'], [], 'git', 'push', false],
    [['@git/read_*'], [], 'git', 'read_file', true],
    [['@git/read_*'], [], 'git', 'write_file', false],
    [['*'], ['@git/push'], 'git', 'push', false],
    [['*'], ['@git/push_*'], 'git', 'push_force', false],
    [['*'], ['@git/push_*'], 'git', 'status', true],
    [['*'], ['@git'], 'git', 'status', false],
    [['*'], ['@mcp'], 'git', 'status', false],
    [['@mcp'], [], 'git', 'status', true],
    [['read'], [], 'git', 'status', true],
  ];
  for (const [tools, exc, s, t, e] of v) {
    it(`mcp ${JSON.stringify(tools)} - ${JSON.stringify(exc)}: ${s}/${t} = ${e}`, () => assert.equal(isMcpToolSelected(tools, exc, s, t), e));
  }
  const sv: Array<[string[], string[], string, boolean]> = [
    [['*'], [], 'anyone', true],
    [['@builtin'], [], 'anyone', true],
    [['subagent'], [], 'anyone', true],
    [['subagent/reviewer'], [], 'reviewer', true],
    [['subagent/reviewer'], [], 'planner', false],
    [['subagent/reviewer'], [], 'general-purpose', false],
    [['*'], ['subagent/reviewer'], 'reviewer', false],
    [['*'], ['subagent/reviewer'], 'planner', true],
    [['*'], ['subagent'], 'planner', false],
    [['read'], [], 'reviewer', false],
    [[], [], 'reviewer', false],
  ];
  for (const [tools, exc, n, e] of sv) {
    it(`subagent ${JSON.stringify(tools)} - ${JSON.stringify(exc)}: ${n} = ${e}`, () => assert.equal(isSubagentSelected(tools, exc, n), e));
  }
});

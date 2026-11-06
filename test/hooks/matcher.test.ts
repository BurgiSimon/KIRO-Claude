import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  compileHookRegex,
  filePathForms,
  hookMatchesCall,
  hookMatchesFile,
  matchesFileGlobs,
  matchesFileHook,
  matchesToolTypes,
  matchesV2,
  matchesV3,
  qHookMatchesTool,
  qPatternMatches,
  v3MatchIds,
  v3ToolId,
} from '../../src/hooks/matcher.js';
import type { KiroHook } from '../../src/types.js';
import { mkCall, v2Hook, v3Hook } from './helpers.js';

// ───────────────────────────── V2 / Q ─────────────────────────────

/** Q unit-test vectors (`Q:cli/chat/cli/hooks.rs:449-547`, 06 §3.6, scratchpad test.mjs). */
const Q_VECTORS: [string | undefined, string, boolean][] = [
  [undefined, 'fs_write', true],
  [undefined, 'execute_bash', true],
  [undefined, '@git/status', true],
  ['fs_write', 'fs_write', true],
  ['fs_write', 'fs_read', false],
  ['fs_*', 'fs_write', true],
  ['fs_*', 'fs_read', true],
  ['fs_*', 'execute_bash', false],
  ['*', 'fs_write', true],
  ['*', 'execute_bash', true],
  ['*', '@git/status', true],
  ['@builtin', 'fs_write', true],
  ['@builtin', 'execute_bash', true],
  ['@builtin', '@git/status', false],
  ['@git', '@git/status', true],
  ['@git', '@other/tool', false],
  ['@git', 'fs_write', false],
  ['@git/status', '@git/status', true],
  ['@git/status', '@git/commit', false],
  ['@git/status', 'fs_write', false],
];

test('qHookMatchesTool: Q vectors', () => {
  for (const [m, name, want] of Q_VECTORS) assert.equal(qHookMatchesTool(m, name), want, `${m} vs ${name}`);
});

test('qHookMatchesTool: globset globs from 02 §7.1 (`@git/*`, `@git-*/*`)', () => {
  const rows: [string, string, boolean][] = [
    ['@git/*', '@git/status', true],
    ['@git/*', '@github/status', false],
    ['@git-*/*', '@git-server/log', true],
    ['@git-*/*', '@git/log', false],
    ['fs_?ead', 'fs_read', true],
    ['*bash', 'execute_bash', true],
    ['@*', '@srv/a/b', true], // globset `*` crosses `/`
    ['[', '[', true], // exact equality wins before glob parsing
    ['fs_[', 'fs_x', false], // invalid glob without wildcard: exact only
    ['fs_[*', 'fs_x', false], // invalid glob: never matches
  ];
  for (const [m, name, want] of rows) assert.equal(qHookMatchesTool(m, name), want, `${m} vs ${name}`);
});

test('qPatternMatches: exact first, glob only with * or ?', () => {
  assert.equal(qPatternMatches('fs_read', 'fs_read'), true);
  assert.equal(qPatternMatches('fs_{read,write}', 'fs_read'), false);
  assert.equal(qPatternMatches('fs_{read,write}*', 'fs_read'), true);
});

test('matchesV2: Q vectors through KiroToolCall.v2Name', () => {
  const byName: Record<string, ReturnType<typeof mkCall>> = {
    fs_write: mkCall('Write', { file_path: '/ws/a' }),
    fs_read: mkCall('Read', { file_path: '/ws/a' }),
    execute_bash: mkCall('Bash', { command: 'ls' }),
    '@git/status': mkCall('mcp__git__status', {}),
    '@git/commit': mkCall('mcp__git__commit', {}),
    '@other/tool': mkCall('mcp__other__tool', {}),
  };
  for (const [m, name, want] of Q_VECTORS) {
    const call = byName[name];
    assert.ok(call, name);
    assert.equal(call.v2Name, name);
    assert.equal(matchesV2(m, call), want, `${m} vs ${name}`);
  }
});

test('matchesV2: Kiro 2.x groups and aliases (02 §7.1)', () => {
  const read = mkCall('Read');
  const glob = mkCall('Glob');
  const grep = mkCall('Grep');
  const write = mkCall('Write');
  const edit = mkCall('Edit');
  const bash = mkCall('Bash');
  const fetch = mkCall('WebFetch');
  const search = mkCall('WebSearch');
  const agent = mkCall('Agent');
  const todo = mkCall('TaskCreate');
  const mcp = mkCall('mcp__read__write');
  const rows: [string, ReturnType<typeof mkCall>, boolean][] = [
    ['read', read, true],
    ['read', glob, true],
    ['read', grep, true],
    ['read', write, false],
    ['write', write, true],
    ['write', edit, true],
    ['write', read, false],
    ['shell', bash, true],
    ['shell', read, false],
    ['web', fetch, true],
    ['web', search, true],
    ['web', bash, false],
    ['subagent', agent, true],
    ['subagent', bash, false],
    ['fsRead', read, true],
    ['fsWrite', edit, true],
    ['execute_cmd', bash, true],
    ['executeCmd', bash, true],
    ['agent_crew', agent, true],
    ['use_subagent', agent, true],
    ['todo', todo, true],
    ['task', todo, true],
    ['todo_list', todo, true],
    ['glob', glob, true],
    ['glob', grep, false],
    ['grep', grep, true],
    ['web_fetch', fetch, true],
    ['web_search', search, true],
    // Groups never match MCP tools.
    ['read', mcp, false],
    ['write', mcp, false],
    ['@read', mcp, true],
    ['@builtin', todo, true],
    ['@builtin', mcp, false],
    // V3 names are not V2 names.
    ['read_file', read, false],
    ['str_replace', edit, false],
    ['', read, false],
  ];
  for (const [m, call, want] of rows) assert.equal(matchesV2(m, call), want, `${m} vs ${call.claudeName}`);
});

// ───────────────────────────── V3 ─────────────────────────────

test('v3ToolId / v3MatchIds', () => {
  assert.equal(v3ToolId(mkCall('Read')), 'read_file');
  assert.equal(v3ToolId(mkCall('TaskCreate')), 'todo_list');
  assert.deepEqual(v3MatchIds(mkCall('Bash')), ['execute_bash', 'execute_pwsh']);
  assert.deepEqual(v3MatchIds(mkCall('Agent', { subagent_type: 'planner' })), ['invoke_sub_agent', 'subagent/planner']);
  assert.deepEqual(v3MatchIds(mkCall('Agent', {})), ['invoke_sub_agent', 'subagent/general-purpose']);
  assert.deepEqual(v3MatchIds(mkCall('Write'), { ideAliases: true }), ['fs_write', 'fsWrite', 'fsAppend', 'strReplace']);
  assert.deepEqual(v3MatchIds(mkCall('mcp__github__merge_pull_request'), { ideAliases: true }), ['mcp_github_merge_pull_request', 'merge_pull_request']);
});

test('matchesV3: selector / regex table (02 §7.4)', () => {
  const read = mkCall('Read');
  const glob = mkCall('Glob');
  const grep = mkCall('Grep');
  const write = mkCall('Write');
  const edit = mkCall('Edit');
  const nb = mkCall('NotebookEdit');
  const bash = mkCall('Bash');
  const fetch = mkCall('WebFetch');
  const search = mkCall('WebSearch');
  const agent = mkCall('Agent', { subagent_type: 'planner' });
  const skill = mkCall('Skill', { skill: 'x' });
  const todo = mkCall('TaskCreate');
  const gh = mkCall('mcp__GitHub__create_issue');
  const thread = mkCall('mcp__thread__reader');
  const rows: [string | undefined, ReturnType<typeof mkCall>, boolean][] = [
    [undefined, read, true],
    ['', bash, true],
    ['*', gh, true],
    // ids
    ['read_file', read, true],
    ['read_file', glob, false],
    ['file_search', glob, true],
    ['grep_search', grep, true],
    ['fs_write', write, true],
    ['fs_write', nb, true],
    ['fs_write', edit, false],
    ['str_replace', edit, true],
    ['execute_bash', bash, true],
    ['execute_pwsh', bash, true],
    ['web_fetch', fetch, true],
    ['remote_web_search', search, true],
    ['invoke_sub_agent', agent, true],
    ['subagent/planner', agent, true],
    ['subagent/other', agent, false],
    ['disclose_context', skill, true],
    ['todo_list', todo, true],
    // tags
    ['read', read, true],
    ['read', glob, true],
    ['read', grep, true],
    ['read', write, false],
    ['write', write, true],
    ['write', edit, true],
    ['write', nb, true],
    ['write', read, false],
    ['shell', bash, true],
    ['web', fetch, true],
    ['web', search, true],
    ['subagent', agent, true],
    ['context', skill, true],
    ['@builtin', read, true],
    ['@builtin', todo, true],
    ['@builtin', gh, false],
    ['@mcp', gh, true],
    ['@mcp', read, false],
    ['@GitHub', gh, true],
    ['@github', gh, true], // V3 display names are lowercased
    ['@GitHub/create_issue', gh, true],
    ['@GitHub/close_issue', gh, false],
    ['@other', gh, false],
    // wildcards against ids and tags
    ['mcp_github_*', gh, true],
    ['@GitHub/*', gh, true],
    ['*_file', read, true],
    ['read_fil?', read, true],
    // unanchored regex fallback for selectors
    ['read', thread, true], // `read` matches any id containing "read" (02 §7.4)
    ['.*invoke_sub_agent.*', agent, true],
    ['grep', grep, true],
    ['bash', bash, true],
    // V3 does not expand 2.x names
    ['fs_read', read, false],
    ['use_subagent', agent, false],
    ['glob', glob, false],
    // regex matchers (metachar present) test ids only
    ['^read_file$', read, true],
    ['^read$', read, false], // tags are not regex subjects
    ['^(fs_write|fs_append|str_replace|delete_file)$', edit, true],
    ['^(fs_write|fs_append|str_replace|delete_file)$', read, false],
    ['^(read_file|list_directory)$', read, true],
    ['^execute_pwsh$', bash, true],
    ['mcp_github_.+', gh, true],
    ['^mcp_', read, false],
    ['(', read, false], // invalid regex never matches
    ['[a-', bash, false],
    ['\\Aread_file\\z', read, true],
    ['(?i)^READ_FILE$', read, true],
  ];
  for (const [m, call, want] of rows) assert.equal(matchesV3(m, call), want, `${JSON.stringify(m)} vs ${call.claudeName}`);
});

test('matchesV3: IDE aliases only for legacy matching', () => {
  const write = mkCall('Write');
  const edit = mkCall('Edit');
  const mcp = mkCall('mcp__github__merge_pull_request');
  assert.equal(matchesV3('.*fsWrite.*', write), false);
  assert.equal(matchesV3('.*fsWrite.*', write, { ideAliases: true }), true);
  assert.equal(matchesV3('strReplace', edit, { ideAliases: true }), true);
  assert.equal(matchesV3('.*merge_pull_request.*', mcp), true);
  assert.equal(matchesV3('^merge_pull_request$', mcp), false);
  assert.equal(matchesV3('^merge_pull_request$', mcp, { ideAliases: true }), true);
});

test('matchesToolTypes: any-of legacy toolTypes (03 §2.2 survey)', () => {
  const agent = mkCall('Agent', { subagent_type: 'x' });
  const write = mkCall('Write');
  const bash = mkCall('Bash', { command: 'rm -rf x' });
  assert.equal(matchesToolTypes(['write'], write), true);
  assert.equal(matchesToolTypes(['write'], bash), false);
  assert.equal(matchesToolTypes(['read', 'shell'], bash), true);
  assert.equal(matchesToolTypes(['.*invoke_sub_agent.*'], agent), true);
  assert.equal(matchesToolTypes(['invoke_sub_agent'], agent), true);
  assert.equal(matchesToolTypes(['.*delete.*'], bash), false);
  assert.equal(matchesToolTypes(['*'], bash), true);
  assert.equal(matchesToolTypes([], bash), true);
  assert.equal(matchesToolTypes(['  '], bash), true);
});

test('compileHookRegex: Rust translations and cache', () => {
  assert.ok(compileHookRegex('(?i)abc')!.test('xABCx'));
  assert.ok(compileHookRegex('\\Aab\\z')!.test('ab'));
  assert.ok(!compileHookRegex('\\Aab\\z')!.test('xab'));
  assert.ok(compileHookRegex('\\\\A')!.test('\\A')); // escaped backslash is kept
  assert.equal(compileHookRegex('(?P<w>read)')!.exec('read_file')!.groups!.w, 'read');
  assert.equal(compileHookRegex('('), null);
  assert.equal(compileHookRegex('('), null);
  assert.ok(compileHookRegex('\\d+')!.test('a1'));
});

// ───────────────────────────── file triggers ─────────────────────────────

const WS = { cwd: '/ws/sub', workspaceRoot: '/ws' };

test('filePathForms: absolute + workspace-relative POSIX', () => {
  assert.deepEqual(filePathForms('/ws/src/a.ts', WS), { abs: '/ws/src/a.ts', rel: 'src/a.ts' });
  assert.deepEqual(filePathForms('b.ts', WS), { abs: '/ws/sub/b.ts', rel: 'sub/b.ts' });
});

test('matchesFileHook: V3 regex against relative or absolute path', () => {
  const rows: [string | undefined, string, boolean][] = [
    [undefined, '/ws/a.ts', true],
    ['', '/ws/a.ts', true],
    ['\\.ts$', '/ws/src/a.ts', true],
    ['\\.ts$', '/ws/src/a.js', false],
    ['^src/', '/ws/src/a.ts', true],
    ['^src/', '/ws/lib/src/a.ts', false],
    ['^/ws/src/', '/ws/src/a.ts', true],
    ['src/.*\\.tsx?$', '/ws/src/deep/c.tsx', true],
    ['README', '/ws/README.md', true],
    ['^sub/b\\.ts$', 'b.ts', true], // relative input resolved against cwd
    // invalid regex => glob fallback
    ['*.ts', '/ws/src/a.ts', true],
    ['*.ts', '/ws/src/a.js', false],
    ['**/*.md', '/ws/docs/x.md', true],
  ];
  for (const [m, p, want] of rows) assert.equal(matchesFileHook(m, p, WS), want, `${m} vs ${p}`);
});

test('matchesFileHook: legacy globs (03 §2.3)', () => {
  const rows: [string, string, boolean][] = [
    ['*.css', '/ws/styles/site.css', true], // no `/` => basename
    ['*.css', '/ws/site.css', true],
    ['*.css', '/ws/site.scss', false],
    ['cdk.json', '/ws/cdk.json', true],
    ['cdk.json', '/ws/infra/cdk.json', true],
    ['**/*.ts', '/ws/a.ts', true], // `**/` matches zero directories
    ['**/*.ts', '/ws/src/x/y.ts', true],
    ['src/**/*.ts', '/ws/src/a.ts', true],
    ['src/**/*.ts', '/ws/src/x/a.ts', true],
    ['src/**/*.ts', '/ws/lib/a.ts', false],
    ['src/*.ts', '/ws/src/x/a.ts', false], // `*` does not cross `/`
    ['src/locales/en/*.json', '/ws/src/locales/en/app.json', true],
    ['**/*Stack.ts', '/ws/lib/MyStack.ts', true],
    ['./src/*.ts', '/ws/src/a.ts', true],
    ['**/*.{ts,tsx}', '/ws/src/a.tsx', true],
    ['**/*.{ts,tsx}', '/ws/src/a.js', false],
    ['/ws/src/*.ts', '/ws/src/a.ts', true],
    ['src/', '/ws/src', true],
  ];
  for (const [g, p, want] of rows) assert.equal(matchesFileHook(g, p, WS, 'glob'), want, `${g} vs ${p}`);
});

test('matchesFileGlobs: any-of, empty => match', () => {
  assert.equal(matchesFileGlobs(['**/*.py', '**/*.ts'], '/ws/a.ts', WS), true);
  assert.equal(matchesFileGlobs(['**/*.py'], '/ws/a.ts', WS), false);
  assert.equal(matchesFileGlobs([], '/ws/a.ts', WS), true);
});

// ───────────────────────────── per hook ─────────────────────────────

test('hookMatchesCall: dialect dispatch and legacy toolTypes', () => {
  const read = mkCall('Read');
  const write = mkCall('Write');
  assert.equal(hookMatchesCall(v2Hook('PreToolUse', 'x', { matcher: 'read' }), read), true);
  assert.equal(hookMatchesCall(v2Hook('PreToolUse', 'x', { matcher: 'fs_read' }), read), true);
  assert.equal(hookMatchesCall(v3Hook('PreToolUse', 'x', { matcher: 'fs_read' }), read), false);
  assert.equal(hookMatchesCall(v3Hook('PreToolUse', 'x', { matcher: 'read' }), read), true);
  const legacy = { ...v3Hook('PreToolUse', 'x', { source: 'legacy-ide', matcher: '^(?:nothing)$' }), toolTypes: ['write', 'shell'] } as KiroHook;
  assert.equal(hookMatchesCall(legacy, write), true); // list wins over the converted matcher
  assert.equal(hookMatchesCall(legacy, read), false);
  const legacyRegex = v3Hook('PreToolUse', 'x', { source: 'legacy-ide', matcher: '.*fsWrite.*' });
  assert.equal(hookMatchesCall(legacyRegex, write), true);
  assert.equal(hookMatchesCall(v3Hook('PreToolUse', 'x', { matcher: '.*fsWrite.*' }), write), false);
});

test('hookMatchesFile: legacy filePatterns vs v3 regex', () => {
  const legacy = { ...v3Hook('PostFileSave', 'x', { source: 'legacy-ide', matcher: 'unused-regex-zzz' }), filePatterns: ['**/*.ts'] } as KiroHook;
  assert.equal(hookMatchesFile(legacy, '/ws/src/a.ts', WS), true);
  assert.equal(hookMatchesFile(legacy, '/ws/src/a.js', WS), false);
  assert.equal(hookMatchesFile(v3Hook('PostFileSave', 'x', { matcher: '\\.js$' }), '/ws/src/a.js', WS), true);
  assert.equal(hookMatchesFile(v3Hook('PostFileSave', 'x'), '/ws/anything', WS), true);
});

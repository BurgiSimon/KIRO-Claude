/**
 * Adversarial review tests for config/ (boundary conditions, research test vectors, ordering,
 * prototype-named keys, Windows-ish paths, unicode, error paths).
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  agentCreateTemplate,
  allHooksFor,
  buildSkillsPluginDir,
  claudeMcpNameMap,
  claudeServerName,
  compileKiroIgnore,
  convertLegacyHook,
  createWorkspaceContext,
  discoverSkills,
  expandFileRefs,
  expandPrompt,
  expandSkillInvocation,
  fileGlobsToRegex,
  fileMatchMatches,
  findAgentsMd,
  findPrompt,
  formatPermissionsYaml,
  isInsideRel,
  loadAgents,
  loadHookFiles,
  loadMcpFile,
  loadPrompts,
  loadSteering,
  normalizeAgentHooks,
  normalizeHookTrigger,
  normalizeMcpServer,
  openSettings,
  parseAgent,
  parseFileRef,
  parseInclusion,
  parsePermissionsYaml,
  parsePromptInvocation,
  parseSettingValue,
  parseSteeringText,
  pluginSkillDirNames,
  presetRules,
  readSkill,
  removeMcpServer,
  addMcpServer,
  resolveMcpServers,
  resolveResources,
  selectAgent,
  settingDefault,
  steeringScopeOf,
  substituteEnv,
  toClaudeMcpConfig,
  toolTypesToMatcher,
  validateAgentObject,
  workspaceKiroDir,
} from '../../src/config/index.js';
import type { KiroAgent, McpServerConfig, PromptFile, SkillInfo } from '../../src/types.js';
import { codes, makeFixture, type Fixture } from './helpers.js';

let fx: Fixture;
beforeEach(() => {
  fx = makeFixture('kc-review-');
});
afterEach(() => {
  fx.cleanup();
});

// ───────────────────────────── prototype-named keys ─────────────────────────────

describe('review: prototype-named keys never resolve to Object.prototype members', () => {
  it('hook trigger aliases', () => {
    for (const k of ['constructor', '__proto__', 'hasOwnProperty', 'toString', 'valueOf', 'prototype']) {
      assert.equal(normalizeHookTrigger(k), undefined, k);
    }
  });

  it('steering inclusion aliases', () => {
    for (const k of ['constructor', '__proto__', 'toString']) assert.equal(parseInclusion(k), undefined, k);
    const r = parseSteeringText('---\ninclusion: constructor\n---\nbody\n', { path: '/x/s.md', scope: 'workspace' });
    assert.equal(r.file.inclusion, 'always');
    assert.deepEqual(codes(r.warnings), ['steering-inclusion']);
  });

  it('legacy when.type and tool tag lookups do not throw', () => {
    const w: { code: string; message: string }[] = [];
    assert.equal(convertLegacyHook({ when: { type: 'constructor' }, then: { type: 'runCommand', command: 'x' } }, 'l', undefined, w), undefined);
    assert.deepEqual(codes(w), ['hook-trigger']);
    const m = toolTypesToMatcher(['constructor', '__proto__', 'read']);
    assert.ok(m);
    const re = new RegExp(m);
    assert.ok(re.test('read_file'));
    assert.ok(re.test('xconstructorx'));
    assert.ok(!re.test('execute_bash'));
  });

  it('presets and settings schema', () => {
    assert.deepEqual(presetRules(['constructor', '__proto__', 'toString']), []);
    assert.equal(settingDefault('constructor'), undefined);
    assert.equal(settingDefault('__proto__'), undefined);
    const p = parsePermissionsYaml('policies: [constructor, allow-all]\n', 'user');
    assert.deepEqual(p.presets, ['allow-all']);
    assert.deepEqual(codes(p.warnings), ['unknown-preset']);
  });

  it('V3 hook with trigger "constructor" is ignored with a warning', () => {
    const r = normalizeAgentHooks([{ name: 'x', trigger: 'constructor', action: { type: 'command', command: 'x' } }], 'a');
    assert.equal(r.hooks.length, 0);
    assert.deepEqual(codes(r.warnings), ['hook-trigger']);
  });

  it('an MCP server named __proto__ is kept as data', () => {
    const p = fx.write('home/.kiro/settings/mcp.json', '{"mcpServers":{"__proto__":{"command":"x"},"b":{"command":"y"}}}');
    const r = loadMcpFile(p, 'global', fx.env);
    assert.deepEqual(Object.keys(r.servers).sort(), ['__proto__', 'b']);
    assert.equal(Object.getPrototypeOf(r.servers), Object.prototype);
    const cfg = toClaudeMcpConfig(Object.values(r.servers));
    assert.deepEqual(Object.keys(cfg.mcpServers).sort(), ['__proto__', 'b']);
    assert.match(JSON.stringify(cfg), /"__proto__":\{"type":"stdio","command":"x"/);
    assert.deepEqual(Object.keys(claudeMcpNameMap(Object.values(r.servers))).sort(), ['__proto__', 'b']);
  });

  it('an agent mcpServers entry named __proto__ is kept', () => {
    const ws = fx.ctx();
    const r = parseAgent('{"name":"a","tools":[],"mcpServers":{"__proto__":{"command":"x"}}}', { scope: 'workspace', format: 'json', ws });
    assert.ok(r.agent);
    assert.deepEqual(Object.keys(r.agent.mcpServers), ['__proto__']);
    assert.equal(r.agent.mcpServers['__proto__']!.command, 'x');
  });

  it('settings keep a literal __proto__ key', () => {
    const s = openSettings(fx.ctx());
    s.set('__proto__', '{"polluted":1}');
    assert.deepEqual(s.get('__proto__'), { polluted: 1 });
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    s.set('a', 'x');
    const onDisk = JSON.parse(fs.readFileSync(s.pathFor('a', 'global'), 'utf8')) as Record<string, unknown>;
    assert.deepEqual(Object.keys(onDisk).sort(), ['__proto__', 'a']);
    assert.deepEqual(Object.keys(s.list()).sort(), ['__proto__', 'a']);
    assert.deepEqual(s.delete('__proto__'), ['__proto__']);
    assert.deepEqual(s.list(), { a: 'x' });
  });

  it('addMcpServer accepts the name __proto__', () => {
    const p = path.join(fx.root, 'm.json');
    addMcpServer(p, '__proto__', { command: 'x' }, { force: false });
    const data = JSON.parse(fs.readFileSync(p, 'utf8')) as { mcpServers: Record<string, unknown> };
    assert.deepEqual(Object.keys(data.mcpServers), ['__proto__']);
    assert.equal(removeMcpServer(p, '__proto__'), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')), { mcpServers: {} });
  });
});

// ───────────────────────────── settings ─────────────────────────────

describe('review: settings value parsing (serde_json::from_str ∥ string)', () => {
  const table: [string, unknown][] = [
    ['true', true],
    ['false', false],
    ['5000', 5000],
    [' 42 ', 42],
    ['-1.5', -1.5],
    ['null', null],
    ['"quoted"', 'quoted'],
    ['["a","b"]', ['a', 'b']],
    ['{"k":{"n":1}}', { k: { n: 1 } }],
    ['claude-sonnet-4.6', 'claude-sonnet-4.6'],
    ['True', 'True'],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['', ''],
    ['1e400', '1e400'],
    ['[1, 1e400]', '[1, 1e400]'],
    ['{"a":-1e999}', '{"a":-1e999}'],
    ["'single'", "'single'"],
    ['{bad json', '{bad json'],
    ['héllo wörld ✓', 'héllo wörld ✓'],
  ];
  for (const [raw, want] of table) {
    it(`parseSettingValue(${JSON.stringify(raw)})`, () => {
      assert.deepEqual(parseSettingValue(raw), want);
    });
  }

  it('set() rejects values JSON cannot represent', () => {
    const s = openSettings(fx.ctx());
    assert.throws(() => s.set('x', Number.POSITIVE_INFINITY), /Invalid value/);
    assert.throws(() => s.set('x', [Number.NaN]), /Invalid value/);
    assert.throws(() => s.set('x', () => 1), /Invalid value/);
    assert.throws(() => s.set('x', undefined), /Invalid value/);
    assert.equal(fs.existsSync(s.pathFor('x', 'global')), false);
    s.set('x', '1e400');
    assert.equal(s.get('x'), '1e400');
  });

  it('typed getters accept the string forms and fall back otherwise', () => {
    const s = openSettings(fx.ctx());
    s.set('a.bool', JSON.stringify('true'));
    s.set('a.num', '"5000"');
    s.set('a.bad', '"maybe"');
    s.set('a.obj', '{"x":1}');
    assert.equal(s.get('a.bool'), 'true');
    assert.equal(s.getBoolean('a.bool', false), true);
    assert.equal(s.getNumber('a.num', 1), 5000);
    assert.equal(s.getBoolean('a.bad', true), true);
    assert.equal(s.getNumber('a.bad', 7), 7);
    assert.equal(s.getString('a.obj'), undefined);
    assert.equal(s.getString('missing'), undefined);
  });

  it('workspace overrides global except for global-only keys; adapter keys go to kiro-claude.json', () => {
    fx.mkdir('proj/.kiro');
    const s = openSettings(fx.ctx());
    s.set('chat.defaultModel', 'g-model');
    s.set('chat.defaultModel', 'w-model', 'workspace');
    s.set('chat.agentEngine', 'v2');
    fx.write('proj/.kiro/settings/cli.json', { 'chat.defaultModel': 'w-model', 'chat.agentEngine': 'v1' });
    assert.equal(s.get('chat.defaultModel'), 'w-model');
    assert.equal(s.get('chat.agentEngine'), 'v2');
    assert.throws(() => s.set('chat.agentEngine', 'v1', 'workspace'), /only be set globally/);
    // launch keys are global-only; other adapter keys may be set per workspace
    assert.throws(() => s.set('kiroClaude.allowApiKey', 'true', 'workspace'), /only be set globally/);
    assert.equal(s.getBoolean('kiroClaude.allowApiKey', false), false);
    s.set('kiroClaude.spec.maxParallelTasks', '2', 'workspace');
    assert.equal(s.pathFor('kiroClaude.spec.maxParallelTasks', 'workspace'), path.join(fx.ws, '.kiro', 'settings', 'kiro-claude.json'));
    assert.equal(s.getNumber('kiroClaude.spec.maxParallelTasks', 1), 2);
    const cli = JSON.parse(fs.readFileSync(path.join(fx.ws, '.kiro', 'settings', 'cli.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(cli['kiroClaude.spec.maxParallelTasks'], undefined);
    assert.deepEqual(Object.keys(s.list()), [...Object.keys(s.list())].sort());
  });

  it('glob delete removes matches from both files of the scope and reports sorted keys', () => {
    const s = openSettings(fx.ctx());
    s.set('chat.b', '1');
    s.set('chat.a', '1');
    s.set('chatty', '1');
    s.set('kiroClaude.x', '1');
    assert.deepEqual(s.delete('chat.?'), ['chat.a', 'chat.b']);
    assert.deepEqual(s.delete('nothing.*'), []);
    assert.deepEqual(s.delete('*'), ['chatty', 'kiroClaude.x']);
    assert.deepEqual(s.list(), {});
  });

  it('an invalid workspace file is read as empty with a warning and never overwritten', () => {
    fx.mkdir('proj/.kiro');
    const bad = fx.write('proj/.kiro/settings/cli.json', '{"chat.defaultAgent": "x",}');
    fx.write('home/.kiro/settings/cli.json', { 'chat.defaultAgent': 'g' });
    const s = openSettings(fx.ctx());
    assert.equal(s.get('chat.defaultAgent'), 'g');
    assert.deepEqual(codes(s.warnings), ['invalid-settings']);
    assert.throws(() => s.set('chat.defaultAgent', 'y', 'workspace'), /Refusing to modify/);
    assert.equal(fs.readFileSync(bad, 'utf8'), '{"chat.defaultAgent": "x",}');
  });
});

// ───────────────────────────── MCP ─────────────────────────────

describe('review: MCP', () => {
  it('a higher-priority {"disabled": true} entry suppresses a server defined elsewhere', () => {
    fx.mkdir('proj/.kiro');
    fx.write('home/.kiro/settings/mcp.json', { mcpServers: { github: { command: 'gh-mcp' }, other: { url: 'https://o' } } });
    fx.write('proj/.kiro/settings/mcp.json', { mcpServers: { github: { disabled: true } } });
    const ws = fx.ctx();
    const r = resolveMcpServers(ws, { mcpServers: {}, includeMcpJson: true, useLegacyMcpJson: false });
    assert.deepEqual(r.warnings, []);
    const gh = r.servers.find((s) => s.name === 'github')!;
    assert.equal(gh.disabled, true);
    assert.equal(gh.origin, 'workspace');
    assert.equal(gh.command, undefined);
    assert.deepEqual(Object.keys(toClaudeMcpConfig(r.servers).mcpServers), ['other']);
  });

  it('agent disabled entry suppresses the same name from mcp.json and legacy files', () => {
    fx.write('home/.kiro/settings/mcp.json', { mcpServers: { a: { command: 'g' } } });
    fx.write('home/.aws/amazonq/mcp.json', { mcpServers: { a: { command: 'legacy' } } });
    const ws = fx.ctx();
    const agentSrv = normalizeMcpServer('a', { disabled: true, url: 'https://x' }, 'agent', fx.env).server!;
    const r = resolveMcpServers(ws, { mcpServers: { a: agentSrv }, includeMcpJson: true, useLegacyMcpJson: true });
    assert.equal(r.servers.length, 1);
    assert.equal(r.servers[0]!.origin, 'agent');
    assert.deepEqual(codes(r.warnings), ['mcp-duplicate']);
    assert.equal(r.warnings[0]!.message, "WARNING: MCP server 'a' is already configured in agent config. Skipping duplicate from legacy mcp.json.");
    assert.deepEqual(toClaudeMcpConfig(r.servers), { mcpServers: {} });
  });

  it('includeMcpJson absent ⇒ true (kiro-cli, 08a §4.1); explicit false honored (KC-SPEC-01)', () => {
    fx.write('home/.kiro/settings/mcp.json', { mcpServers: { fromJson: { command: 'x' } } });
    const ws = fx.ctx();
    const parse = (o: Record<string, unknown>) => parseAgent(JSON.stringify({ tools: ['*'], ...o }), { scope: 'global', format: 'json', ws }).agent!;
    const absent = parse({ name: 'a' });
    const off = parse({ name: 'b', includeMcpJson: false, mcpServers: { own: { command: 'y' } } });
    const bad = parse({ name: 'c', includeMcpJson: 'no' });
    assert.equal(absent.includeMcpJson, true);
    assert.equal(off.includeMcpJson, false);
    assert.equal(bad.includeMcpJson, true);
    assert.deepEqual(resolveMcpServers(ws, absent).servers.map((s) => s.name), ['fromJson']);
    assert.deepEqual(resolveMcpServers(ws, off).servers.map((s) => s.name), ['own']);
    const md = parseAgent('---\ntools: ["*"]\n---\nP', { scope: 'global', format: 'md', ws }).agent!;
    assert.equal(md.includeMcpJson, true);
  });

  it('precedence: workspace mcp.json > global > legacy workspace > legacy global', () => {
    fx.mkdir('proj/.kiro');
    fx.write('proj/.kiro/settings/mcp.json', { mcpServers: { a: { command: 'ws' } } });
    fx.write('home/.kiro/settings/mcp.json', { mcpServers: { a: { command: 'g' }, b: { command: 'g' } } });
    fx.write('proj/.amazonq/mcp.json', { mcpServers: { b: { command: 'lw' }, c: { command: 'lw' } } });
    fx.write('home/.aws/amazonq/mcp.json', { mcpServers: { c: { command: 'lg' }, d: { command: 'lg' } } });
    const r = resolveMcpServers(fx.ctx(), { mcpServers: {}, includeMcpJson: true, useLegacyMcpJson: true });
    assert.deepEqual(
      r.servers.map((s) => `${s.name}=${s.command}/${s.origin}`),
      ['a=ws/workspace', 'b=g/global', 'c=lw/legacy-workspace', 'd=lg/legacy-global'],
    );
    // Not a legacy-vs-agent clash ⇒ no Q duplicate warning.
    assert.deepEqual(r.warnings, []);
  });

  it('a disabled entry with unset variables does not warn; an enabled one does', () => {
    const d = normalizeMcpServer('s', { command: 'x', env: { T: '${NOPE}' }, disabled: true }, 'global', {});
    assert.deepEqual(d.warnings, []);
    assert.equal(d.server!.env.T, '${NOPE}');
    const e = normalizeMcpServer('s', { command: 'x', env: { T: '${NOPE}' } }, 'global', {});
    assert.deepEqual(codes(e.warnings), ['mcp-env-unset']);
  });

  it('an enabled entry without command/url still fails', () => {
    assert.deepEqual(codes(normalizeMcpServer('s', {}, 'global', {}).warnings), ['mcp-invalid']);
    assert.deepEqual(codes(normalizeMcpServer('s', { type: 'http' }, 'global', {}).warnings), ['mcp-invalid']);
    assert.deepEqual(codes(normalizeMcpServer('s', { disabled: false, command: '  ' }, 'global', {}).warnings), ['mcp-invalid']);
  });

  it('environment substitution vectors (02 §5.3, Q regex)', () => {
    const env = { A: 'alpha', B: '', DOLLAR: '$X' };
    const t = (s: string, dollar = false): [string, string[]] => {
      const r = substituteEnv(s, env, { dollar });
      return [r.value, r.missing];
    };
    assert.deepEqual(t('${env:A}'), ['alpha', []]);
    assert.deepEqual(t('${A}-${A}'), ['alpha-alpha', []]);
    assert.deepEqual(t('Bearer ${B}'), ['Bearer ', []]);
    assert.deepEqual(t('${env:NOPE} ${NOPE}'), ['${NOPE} ${NOPE}', ['NOPE']]);
    assert.deepEqual(t('$A'), ['$A', []]);
    assert.deepEqual(t('$A/bin', true), ['alpha/bin', []]);
    assert.deepEqual(t('${DOLLAR}'), ['$X', []]); // no recursive expansion
    // kiro-cli regex `\$\{(?:env:)?([^}]+)\}`: any name up to `}`; misses stay literal
    assert.deepEqual(t('${env:}'), ['${env:}', ['env:']]);
    assert.deepEqual(t('${1BAD}'), ['${1BAD}', ['1BAD']]);
    assert.deepEqual(t('${env:A}${env:B}x'), ['alphax', []]);
    assert.deepEqual(t('${A'), ['${A', []]);
    assert.deepEqual(t('${constructor} ${toString}'), ['${constructor} ${toString}', ['constructor', 'toString']]);
    assert.deepEqual(t('${env:NOPE}/$NOPE', true), ['${NOPE}/$NOPE', ['NOPE']]);
    assert.deepEqual(t('$$ and $ alone', true), ['$$ and $ alone', []]);
  });

  it('type inference and transport aliases', () => {
    const n = (raw: Record<string, unknown>) => normalizeMcpServer('s', raw, 'global', {});
    assert.equal(n({ url: 'https://x' }).server!.type, 'http');
    assert.equal(n({ url: 'https://x', command: 'c' }).server!.type, 'stdio');
    assert.equal(n({ type: 'streamable-http', url: 'https://x' }).server!.type, 'http');
    assert.equal(n({ type: 'SSE', url: 'https://x' }).server!.type, 'sse');
    const unk = n({ type: 'websocket', url: 'wss://x' });
    assert.equal(unk.server!.type, 'http');
    assert.deepEqual(codes(unk.warnings), ['mcp-invalid']);
    assert.deepEqual(n({ command: 'c', args: 'single' }).server!.args, ['single']);
    assert.deepEqual(n({ command: 'c', args: ['a', 1, true] }).server!.args, ['a', '1', 'true']);
  });

  it('Claude server names', () => {
    assert.equal(claudeServerName('my.server'), 'my_server');
    assert.equal(claudeServerName('a b/c'), 'a_b_c');
    assert.equal(claudeServerName('über'), '_ber');
    assert.equal(claudeServerName(''), '_');
    assert.equal(claudeServerName('ok_name-1'), 'ok_name-1');
    const mk = (name: string, disabled = false): McpServerConfig => ({
      name,
      type: 'stdio',
      command: 'x',
      args: [],
      env: {},
      headers: {},
      disabled,
      autoApprove: [],
      disabledTools: [],
      origin: 'global',
    });
    const servers = [mk('a.b'), mk('a_b'), mk('off', true), mk('a b')];
    assert.deepEqual(Object.keys(toClaudeMcpConfig(servers).mcpServers), ['a_b', 'a_b_2', 'a_b_3']);
    assert.deepEqual(claudeMcpNameMap(servers), { a_b: 'a.b', a_b_2: 'a_b', a_b_3: 'a b' });
  });

  it('file errors: invalid JSON, no mcpServers, array root, empty file', () => {
    const p1 = fx.write('a.json', '{"mcpServers": {"x": }');
    assert.deepEqual(codes(loadMcpFile(p1, 'global', {}).warnings), ['invalid-json']);
    const p2 = fx.write('b.json', '{"servers": {}}');
    assert.equal(loadMcpFile(p2, 'global', {}).warnings[0]!.message, `${p2}: No mcp servers found in config`);
    const p3 = fx.write('c.json', '[]');
    assert.deepEqual(codes(loadMcpFile(p3, 'global', {}).warnings), ['mcp-file']);
    const p4 = fx.write('d.json', '  \n');
    assert.deepEqual(loadMcpFile(p4, 'global', {}), { servers: {}, warnings: [] });
    assert.deepEqual(loadMcpFile(path.join(fx.root, 'missing.json'), 'global', {}), { servers: {}, warnings: [] });
  });

  it('add/remove helpers keep other keys and refuse silent overwrite', () => {
    const p = fx.write('m.json', { other: 1, mcpServers: { a: { command: 'x' } } });
    assert.throws(() => addMcpServer(p, 'a', { command: 'y' }, { force: false }), /already exists in .*Use --force to overwrite\./);
    addMcpServer(p, 'a', { command: 'y' }, { force: true });
    addMcpServer(p, 'b', { url: 'https://b' }, { force: false });
    assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')), { other: 1, mcpServers: { a: { command: 'y' }, b: { url: 'https://b' } } });
    assert.equal(removeMcpServer(p, 'zzz'), false);
    assert.equal(removeMcpServer(path.join(fx.root, 'nope.json'), 'a'), false);
    assert.equal(fs.existsSync(path.join(fx.root, 'nope.json')), false);
    assert.throws(() => addMcpServer(p, '  ', {}, { force: true }), /must not be empty/);
    const bad = fx.write('bad.json', '{"mcpServers": []}');
    assert.throws(() => addMcpServer(bad, 'a', {}, { force: true }), /must be an object/);
  });
});

// ───────────────────────────── hooks ─────────────────────────────

describe('review: hooks', () => {
  it('trigger alias vectors (case / separators insensitive)', () => {
    const table: [string, string][] = [
      ['agentSpawn', 'SessionStart'],
      ['AgentSpawn', 'SessionStart'],
      ['agent_spawn', 'SessionStart'],
      ['SessionStart', 'SessionStart'],
      ['conversation_start', 'SessionStart'],
      ['userPromptSubmit', 'UserPromptSubmit'],
      ['promptSubmit', 'UserPromptSubmit'],
      ['per_prompt', 'UserPromptSubmit'],
      ['PRE_TOOL_USE', 'PreToolUse'],
      ['post-tool-use', 'PostToolUse'],
      ['stop', 'Stop'],
      ['agentStop', 'Stop'],
      ['SessionEnd', 'SessionEnd'],
      ['fileEdited', 'PostFileSave'],
      ['fileCreated', 'PostFileCreate'],
      ['fileDeleted', 'PostFileDelete'],
      ['preTaskExecution', 'PreTaskExec'],
      ['PostTaskExec', 'PostTaskExec'],
      ['userTriggered', 'Manual'],
      ['Manual', 'Manual'],
    ];
    for (const [raw, want] of table) assert.equal(normalizeHookTrigger(raw), want, raw);
    for (const bad of ['', 'start', 'pre', 'toolUse', '🙂']) assert.equal(normalizeHookTrigger(bad), undefined, bad);
  });

  it('a non-string matcher drops the hook instead of matching every tool', () => {
    const v2 = normalizeAgentHooks({ preToolUse: [{ command: 'a', matcher: ['fs_read'] }, { command: 'b', matcher: null }, { command: 'c', matcher: '' }] }, 'ag');
    assert.deepEqual(v2.hooks.map((h) => h.name), ['preToolUse-1', 'preToolUse-2']);
    assert.equal(v2.hooks[0]!.matcher, undefined);
    assert.equal(v2.hooks[1]!.matcher, ''); // Q: "" matches only the tool named "" (never)
    assert.deepEqual(codes(v2.warnings), ['hook-invalid']);
    const v3 = normalizeAgentHooks(
      [
        { name: 'x', trigger: 'PreToolUse', matcher: 42, action: { type: 'command', command: 'a' } },
        { name: 'y', trigger: 'PreToolUse', matcher: null, action: { type: 'command', command: 'b' } },
      ],
      'ag',
    );
    assert.deepEqual(v3.hooks.map((h) => h.name), ['y']);
    assert.equal(v3.hooks[0]!.matcher, undefined);
    assert.deepEqual(codes(v3.warnings), ['hook-invalid']);
  });

  it('V2 and V3 defaults and timeouts', () => {
    const v2 = normalizeAgentHooks({ agentSpawn: [{ command: 'git status', description: 'Add git context' }, { command: 'x', timeout_ms: '5', max_output_size: -1 }] }, 'ag', '/a.json');
    assert.equal(v2.hooks[0]!.timeoutMs, 30000);
    assert.equal(v2.hooks[0]!.maxOutputBytes, 10240);
    assert.equal(v2.hooks[0]!.cacheTtlSec, 0);
    assert.equal(v2.hooks[0]!.rawTrigger, 'agentSpawn');
    assert.equal(v2.hooks[0]!.dialect, 'v2');
    assert.equal(v2.hooks[0]!.sourcePath, '/a.json');
    assert.equal(v2.hooks[1]!.timeoutMs, 30000);
    assert.equal(v2.hooks[1]!.maxOutputBytes, 10240);
    assert.deepEqual(codes(v2.warnings), ['hook-invalid']);
    const v3 = normalizeAgentHooks(
      [
        { name: 'a', trigger: 'Stop', action: { type: 'command', command: 'x' }, timeout: 0 },
        { name: 'b', trigger: 'Stop', action: { type: 'agent', prompt: 'p' }, timeout: 1.5 },
        { name: 'c', trigger: 'Stop', action: { type: 'command', command: 'x' } },
      ],
      'ag',
    );
    assert.deepEqual(v3.hooks.map((h) => h.timeoutMs), [0, 1500, 60000]);
    assert.deepEqual(v3.hooks.map((h) => h.maxOutputBytes), [10240, 10240, 10240]);
  });

  it('legacy conversion table (03 §2.3)', () => {
    const table: [string, string][] = [
      ['agentSpawn', 'SessionStart'],
      ['sessionStart', 'SessionStart'],
      ['promptSubmit', 'UserPromptSubmit'],
      ['agentStop', 'Stop'],
      ['preToolUse', 'PreToolUse'],
      ['postToolUse', 'PostToolUse'],
      ['fileCreated', 'PostFileCreate'],
      ['fileEdited', 'PostFileSave'],
      ['fileDeleted', 'PostFileDelete'],
      ['preTaskExecution', 'PreTaskExec'],
      ['postTaskExecution', 'PostTaskExec'],
      ['userTriggered', 'Manual'],
    ];
    for (const [type, trig] of table) {
      const w: { code: string; message: string }[] = [];
      const h = convertLegacyHook({ name: 'n', version: '1', when: { type }, then: { type: 'runCommand', command: 'c' } }, 'l', undefined, w);
      assert.equal(h?.trigger, trig, type);
      assert.equal(h?.source, 'legacy-ide');
      assert.equal(h?.dialect, 'v3');
      assert.deepEqual(w, []);
    }
  });

  it('real legacy files (03 §2.2 examples)', () => {
    const w: { code: string; message: string }[] = [];
    const lint = convertLegacyHook(
      {
        enabled: true,
        name: 'Lint and Format on Save',
        version: '1',
        when: { type: 'fileEdited', patterns: ['**/*.ts', '**/*.js', '**/*.tsx', '**/*.jsx', '**/*.py', '**/*.json'] },
        then: { type: 'askAgent', prompt: 'A code file has been saved.' },
      },
      'lint',
      '/ws/.kiro/hooks/lint-and-format-on-save.kiro.hook',
      w,
    )!;
    assert.equal(lint.trigger, 'PostFileSave');
    assert.deepEqual(lint.action, { type: 'agent', prompt: 'A code file has been saved.' });
    const re = new RegExp(lint.matcher!);
    for (const ok of ['a.ts', 'src/deep/b.tsx', '/abs/path/c.py', 'x.json']) assert.ok(re.test(ok), ok);
    for (const no of ['a.tsx.bak', 'README.md', 'ts']) assert.ok(!re.test(no), no);
    const audit = convertLegacyHook(
      { version: '1.0.0', enabled: true, name: 'aidlc-write-audit-log', when: { type: 'postToolUse', toolTypes: ['write'] }, then: { type: 'runCommand', command: '{{INVOKE}} x' } },
      'audit',
      undefined,
      w,
    )!;
    assert.equal(audit.trigger, 'PostToolUse');
    assert.equal(audit.matcher, 'write');
    const sec = convertLegacyHook(
      { name: 'Security Check on Write', version: '1.0.0', when: { type: 'preToolUse', toolTypes: ['write'] }, then: { type: 'askAgent', prompt: 'check' } },
      'sec',
      undefined,
      w,
    )!;
    assert.equal(sec.trigger, 'PreToolUse');
    assert.equal(sec.action.type, 'agent');
    const disabled = convertLegacyHook({ enabled: false, name: 'd', when: { type: 'agentStop' }, then: { type: 'runCommand', command: 'x' } }, 'd', undefined, w)!;
    assert.equal(disabled.enabled, false);
    assert.deepEqual(w, []);
  });

  it('fileGlobsToRegex vectors (03 §2.2 observed patterns)', () => {
    const m = (globs: string[], p: string): boolean => new RegExp(fileGlobsToRegex(globs)!).test(p);
    assert.ok(m(['cdk.json'], 'cdk.json'));
    assert.ok(m(['cdk.json'], 'infra/cdk.json'));
    assert.ok(!m(['cdk.json'], 'xcdk.json'));
    assert.ok(!m(['cdk.json'], 'cdkxjson'));
    assert.ok(m(['src/locales/en/*.json'], 'src/locales/en/a.json'));
    assert.ok(!m(['src/locales/en/*.json'], 'src/locales/en/x/a.json'));
    assert.ok(!m(['src/locales/en/*.json'], 'other/src/locales/en/a.json'));
    assert.ok(m(['**/*Stack.ts'], 'lib/FooStack.ts'));
    assert.ok(m(['**/*Stack.ts'], 'FooStack.ts'));
    assert.ok(!m(['**/*Stack.ts'], 'lib/Stack.tsx'));
    assert.ok(m(['src/**/*.ts'], 'src/a.ts'));
    assert.ok(m(['src/**/*.ts'], 'src/a/b/c.ts'));
    assert.ok(!m(['src/**/*.ts'], 'lib/src/a.ts'));
    assert.ok(m(['*.css'], 'a/b/c.css'));
    assert.ok(m(['./src/*.ts'], 'src/x.ts'));
    assert.ok(m(['/src/*.ts'], 'src/x.ts'));
    assert.ok(m(['*.{md,txt}'], 'docs/a.txt'));
    assert.ok(m(['[!x]y.md'], 'ay.md'));
    assert.ok(!m(['[!x]y.md'], 'xy.md'));
    assert.ok(m(['a?.md'], 'ab.md'));
    assert.ok(!m(['a?.md'], 'a/.md'));
    assert.ok(m(['docs/**'], 'docs/a/b'));
    assert.ok(m(['file (1).txt'], 'file (1).txt'));
    assert.ok(!m(['file (1).txt'], 'file 1.txt'));
    assert.equal(fileGlobsToRegex([]), undefined);
    assert.equal(fileGlobsToRegex(['  ']), undefined);
  });

  it('toolTypesToMatcher: lists become one regex with tags expanded', () => {
    assert.equal(toolTypesToMatcher([]), undefined);
    assert.equal(toolTypesToMatcher([' write ']), 'write');
    const re = new RegExp(toolTypesToMatcher(['write', '.*delete.*'])!);
    assert.ok(re.test('fs_write'));
    assert.ok(re.test('str_replace'));
    assert.ok(re.test('delete_file'));
    assert.ok(re.test('mcp_github_delete_branch'));
    assert.ok(!re.test('read_file'));
    const re2 = new RegExp(toolTypesToMatcher(['@builtin', '@my-server'])!);
    assert.ok(re2.test('read_file'));
    assert.ok(re2.test('mcp_my_server_x'));
    const re3 = new RegExp(toolTypesToMatcher(['shell', 'subagent'])!);
    assert.ok(re3.test('execute_bash'));
    assert.ok(re3.test('execute_pwsh'));
    assert.ok(re3.test('invoke_sub_agent'));
    assert.ok(re3.test('subagent/planner'));
    assert.ok(!re3.test('mcp_x_shellish'));
  });

  it('definition order: global files, workspace files, agent, legacy (files sorted by name)', () => {
    fx.mkdir('proj/.kiro');
    const hook = (name: string) => ({ version: 'v1', hooks: [{ name, trigger: 'Stop', action: { type: 'command', command: name } }] });
    fx.write('home/.kiro/hooks/b.json', hook('g-b'));
    fx.write('home/.kiro/hooks/a.json', hook('g-a'));
    fx.write('proj/.kiro/hooks/z.json', hook('w-z'));
    fx.write('proj/.kiro/hooks/._junk.json', '{');
    fx.write('proj/.kiro/hooks/legacy.kiro.hook', { name: 'leg', when: { type: 'agentStop' }, then: { type: 'runCommand', command: 'l' } });
    fx.write('proj/.kiro/hooks/bare.json', { name: 'bare', when: { type: 'agentStop' }, then: { type: 'runCommand', command: 'b' } });
    const ws = fx.ctx();
    const agentHooks = normalizeAgentHooks({ stop: [{ command: 'agent' }] }, 'ag').hooks;
    assert.deepEqual(
      allHooksFor(ws, { hooks: agentHooks }).map((h) => `${h.source}:${h.name}`),
      ['global-file:g-a', 'global-file:g-b', 'workspace-file:bare', 'workspace-file:w-z', 'agent:stop-0', 'legacy-ide:leg'],
    );
    assert.deepEqual(loadHookFiles(ws).warnings, []);
  });

  it('workspace == home: ~/.kiro/hooks are loaded once', () => {
    fx.write('home/.kiro/hooks/a.json', { version: 'v1', hooks: [{ name: 'a', trigger: 'Stop', action: { type: 'command', command: 'a' } }] });
    const ws = createWorkspaceContext(fx.home, fx.env);
    assert.equal(workspaceKiroDir(ws), undefined);
    assert.deepEqual(loadHookFiles(ws).hooks.map((h) => h.name), ['a']);
  });
});

// ───────────────────────────── steering ─────────────────────────────

describe('review: steering', () => {
  it('inclusion aliases and fileMatchPattern forms', () => {
    const t = (fm: string) => parseSteeringText(`---\n${fm}\n---\nB\n`, { path: '/w/.kiro/steering/x.md', scope: 'workspace' });
    assert.equal(t('inclusion: Always').file.inclusion, 'always');
    assert.equal(t('inclusion: file_match').file.inclusion, 'fileMatch');
    assert.equal(t('inclusion: FILE-MATCH').file.inclusion, 'fileMatch');
    assert.equal(t('inclusion: manual').file.inclusion, 'manual');
    assert.deepEqual(t('inclusion: fileMatch\nfileMatchPattern: "components/**/*.tsx"').file.fileMatchPatterns, ['components/**/*.tsx']);
    assert.deepEqual(t('inclusion: fileMatch\nfileMatchPattern: ["**/*.ts", "**/*.tsx", 3, ""]').file.fileMatchPatterns, ['**/*.ts', '**/*.tsx']);
    assert.deepEqual(t('inclusion: fileMatch').file.fileMatchPatterns, []);
    const bool = t('inclusion: true');
    assert.equal(bool.file.inclusion, 'always');
    assert.deepEqual(codes(bool.warnings), ['steering-inclusion']);
    const auto = t('inclusion: auto\nname: api-guide\ndescription: When designing REST APIs');
    assert.equal(auto.file.name, 'api-guide');
    assert.equal(auto.file.description, 'When designing REST APIs');
    assert.deepEqual(auto.warnings, []);
    assert.deepEqual(codes(t('inclusion: auto').warnings), ['steering-auto']);
    assert.equal(t('inclusion: manual\nname: other').file.name, 'x');
  });

  it('front matter must be the first bytes; BOM and CRLF are tolerated', () => {
    const late = parseSteeringText('\n---\ninclusion: manual\n---\nB', { path: '/x.md', scope: 'workspace' });
    assert.equal(late.file.inclusion, 'always');
    assert.match(late.file.body, /inclusion: manual/);
    const crlf = parseSteeringText('\uFEFF---\r\ninclusion: manual\r\n---\r\nline1\r\nline2\r\n', { path: '/x.md', scope: 'workspace' });
    assert.equal(crlf.file.inclusion, 'manual');
    assert.equal(crlf.file.body, 'line1\nline2\n');
  });

  it('load order: global, legacy rules, workspace; nested dirs; sidecars and global AGENTS.md skipped', () => {
    fx.mkdir('proj/.kiro');
    fx.write('home/.kiro/steering/g.md', 'G');
    fx.write('home/.kiro/steering/AGENTS.md', 'global agents');
    fx.write('home/.kiro/steering/sub/AGENTS.md', 'nested global agents is steering');
    fx.write('proj/.amazonq/rules/r.md', 'R');
    fx.write('proj/.kiro/steering/b/w2.md', 'W2');
    fx.write('proj/.kiro/steering/a.md', 'W1');
    fx.write('proj/.kiro/steering/._a.md', 'junk');
    fx.write('proj/.kiro/steering/notes.txt', 'no');
    const r = loadSteering(fx.ctx());
    assert.deepEqual(
      r.files.map((f) => `${f.scope}:${path.relative(fx.root, f.path)}`),
      [
        'global:home/.kiro/steering/g.md',
        'global:home/.kiro/steering/sub/AGENTS.md',
        'legacy:proj/.amazonq/rules/r.md',
        'workspace:proj/.kiro/steering/a.md',
        'workspace:proj/.kiro/steering/b/w2.md',
      ],
    );
  });

  it('KIRO_HOME pointing at the workspace .kiro loads each file once (as global)', () => {
    fx.write('proj/.kiro/steering/a.md', 'A');
    const ws = fx.ctx(undefined, { KIRO_HOME: path.join(fx.ws, '.kiro') });
    const r = loadSteering(ws);
    assert.deepEqual(r.files.map((f) => f.scope), ['global']);
  });

  it('expandFileRefs: ranges, clamping, CRLF/BOM, tilde, folders, missing, ignored, untouched text', () => {
    fx.write('proj/f.txt', '\uFEFFl1\r\nl2\r\nl3\r\nl4\r\n');
    fx.write('home/notes.md', 'home note\n');
    fx.write('proj/dir/b.txt', 'b');
    fx.write('proj/dir/a/x', 'x');
    fx.write('proj/secret.env', 'TOKEN');
    fx.write('proj/.kiroignore', 'secret.env\n');
    const ws = fx.ctx();
    const e = (s: string) => expandFileRefs(s, fx.ws, ws);
    assert.equal(e('#[[file:f.txt]]'), '[f.txt]\nl1\nl2\nl3\nl4');
    assert.equal(e('#[[file:f.txt:2]]'), '[f.txt:2]\nl2');
    assert.equal(e('#[[file:f.txt:2-3]]'), '[f.txt:2-3]\nl2\nl3');
    assert.equal(e('#[[file:f.txt:3-2]]'), '[f.txt:2-3]\nl2\nl3');
    assert.equal(e('#[[file:f.txt:0]]'), '[f.txt:1]\nl1');
    assert.equal(e('#[[file:f.txt:3-99]]'), '[f.txt:3-99]\nl3\nl4');
    assert.equal(e('#[[file:~/notes.md]]'), '[~/notes.md]\nhome note');
    assert.equal(e('#[[folder:dir/]]'), '[dir/]\na/\nb.txt');
    assert.equal(e('#[[file:nope.md]]'), '[missing: nope.md]');
    assert.equal(e('#[[folder:nope]]'), '[missing: nope]');
    assert.equal(e('#[[file:dir]]'), '[missing: dir]');
    assert.equal(e('#[[file:secret.env]]'), '[ignored: secret.env]');
    assert.equal(e('a #[[file:f.txt:1]] b #[[file:f.txt:4]] c'), 'a [f.txt:1]\nl1 b [f.txt:4]\nl4 c');
    for (const s of ['no refs', '#[file:f.txt]', '#[[unknown:f.txt]]', '#[[file:]]', '#[[file:f\n.txt]]']) assert.equal(e(s), s);
  });

  it('parseFileRef vectors', () => {
    assert.deepEqual(parseFileRef('a.md'), { path: 'a.md' });
    assert.deepEqual(parseFileRef('a.md:7'), { path: 'a.md', start: 7, end: 7 });
    assert.deepEqual(parseFileRef(' a.md:2-9 '), { path: 'a.md', start: 2, end: 9 });
    assert.deepEqual(parseFileRef('C:\\x\\a.md:3'), { path: 'C:\\x\\a.md', start: 3, end: 3 });
    assert.deepEqual(parseFileRef('a:b.md'), { path: 'a:b.md' });
    assert.deepEqual(parseFileRef(':5'), { path: ':5' });
  });

  it('fileMatchMatches vectors (03 §3)', () => {
    assert.ok(fileMatchMatches(['*.tsx'], 'src/components/Button.tsx'));
    assert.ok(fileMatchMatches(['components/**/*.tsx'], 'components/ui/Button.tsx'));
    assert.ok(!fileMatchMatches(['components/**/*.tsx'], 'src/components/ui/Button.tsx'));
    assert.ok(fileMatchMatches(['**/*.ts', '**/*.tsx'], 'index.ts'));
    assert.ok(fileMatchMatches(['README*'], 'docs/README.md'));
    assert.ok(fileMatchMatches(['*.md'], './x.md'));
    assert.ok(fileMatchMatches(['src/*.ts'], 'src\\a.ts'));
    assert.ok(fileMatchMatches(['./src/*.ts'], '/src/a.ts'));
    assert.ok(!fileMatchMatches([], 'a.ts'));
    assert.ok(!fileMatchMatches([''], 'a.ts'));
    assert.ok(!fileMatchMatches(['*.ts'], ''));
    assert.ok(!fileMatchMatches(['*.ts'], 'a.tsx'));
  });

  it('isInsideRel / steeringScopeOf: names starting with ".." are inside', () => {
    assert.equal(isInsideRel('a/b'), true);
    assert.equal(isInsideRel('..foo'), true);
    assert.equal(isInsideRel('..foo/x.md'), true);
    assert.equal(isInsideRel('..'), false);
    assert.equal(isInsideRel(`..${path.sep}x`), false);
    assert.equal(isInsideRel('../x'), false);
    assert.equal(isInsideRel(path.resolve('/abs')), false);
    fx.mkdir('proj/.kiro');
    const p = fx.write('proj/.kiro/steering/..odd.md', 'x');
    const ws = fx.ctx();
    assert.equal(steeringScopeOf(ws, p), 'workspace');
    assert.equal(steeringScopeOf(ws, fx.write('proj/.kiro/other.md', 'x')), undefined);
    assert.equal(steeringScopeOf(ws, path.join(fx.ws, '.kiro', 'steering', 'x.txt')), undefined);
  });

  it('findAgentsMd: global first, root, nested sorted; skips dot dirs, node_modules and ignored dirs', () => {
    fx.write('home/.kiro/steering/AGENTS.md', 'g');
    fx.write('proj/AGENTS.md', 'root');
    fx.write('proj/b/AGENTS.md', 'b');
    fx.write('proj/a/z/AGENTS.md', 'az');
    fx.write('proj/a/AGENTS.md', 'a');
    fx.write('proj/node_modules/pkg/AGENTS.md', 'no');
    fx.write('proj/.git/AGENTS.md', 'no');
    fx.write('proj/.hidden/AGENTS.md', 'no');
    fx.write('proj/vendor/AGENTS.md', 'ignored');
    fx.write('proj/c/agents.md', 'wrong case');
    fx.write('proj/.kiroignore', 'vendor/\n');
    const got = findAgentsMd(fx.ctx()).map((p) => path.relative(fx.root, p));
    const want = ['home/.kiro/steering/AGENTS.md', 'proj/AGENTS.md', 'proj/a/AGENTS.md', 'proj/a/z/AGENTS.md', 'proj/b/AGENTS.md'];
    if (fs.existsSync(path.join(fx.ws, 'c', 'AGENTS.md'))) want.push('proj/c/agents.md'); // case-insensitive FS
    assert.deepEqual(got, want);
  });

  it('findAgentsMd from home does not walk the home directory', () => {
    fx.write('home/AGENTS.md', 'h');
    fx.write('home/projects/x/AGENTS.md', 'deep');
    const ws = createWorkspaceContext(fx.home, fx.env);
    assert.deepEqual(findAgentsMd(ws), [path.join(fx.home, 'AGENTS.md')]);
  });
});

// ───────────────────────────── kiroignore ─────────────────────────────

describe('review: kiroignore', () => {
  const root = path.resolve('/ws-root');
  const ig = (text: string) => compileKiroIgnore(text, root);
  const p = (...parts: string[]) => path.join(root, ...parts);

  it('basics, anchoring, negation, comments, escapes, CRLF', () => {
    const i = ig('# comment\r\n*.log\r\n!keep.log\r\n/build\r\ndocs/*.tmp\r\n\\#hash\r\n\\!bang\r\ntrail   \r\n');
    assert.ok(i.isIgnored(p('a.log')));
    assert.ok(i.isIgnored(p('x', 'y.log')));
    assert.ok(!i.isIgnored(p('keep.log')));
    assert.ok(i.isIgnored(p('build')));
    assert.ok(i.isIgnored(p('build', 'out.js')));
    assert.ok(!i.isIgnored(p('src', 'build')));
    assert.ok(i.isIgnored(p('docs', 'a.tmp')));
    assert.ok(!i.isIgnored(p('docs', 'sub', 'a.tmp')));
    assert.ok(i.isIgnored(p('#hash')));
    assert.ok(i.isIgnored(p('!bang')));
    assert.ok(i.isIgnored(p('trail')));
    assert.deepEqual(i.patterns, ['*.log', '!keep.log', '/build', 'docs/*.tmp', '\\#hash', '\\!bang', 'trail']);
  });

  it('a file below an ignored directory cannot be re-included; ** forms', () => {
    const i = ig('secret/\n!secret/ok.txt\n**/cache\nlogs/**\na/**/z\n');
    assert.ok(i.isIgnored(p('secret', 'ok.txt')));
    assert.ok(i.isIgnored(p('deep', 'er', 'cache')));
    assert.ok(i.isIgnored(p('cache', 'f')));
    assert.ok(i.isIgnored(p('logs', 'x', 'y')));
    assert.ok(!i.isIgnored(p('logs')));
    assert.ok(i.isIgnored(p('a', 'z')));
    assert.ok(i.isIgnored(p('a', 'b', 'c', 'z')));
  });

  it('paths outside the root and names starting with ".." ', () => {
    const i = ig('*\n');
    assert.ok(!i.isIgnored(path.resolve(root, '..', 'other')));
    assert.ok(!i.isIgnored(root));
    assert.ok(i.isIgnored(p('..foo')));
    assert.ok(i.isIgnored(p('..', 'ws-root', 'x')));
  });

  it('empty / comment-only files ignore nothing', () => {
    assert.ok(!ig('').isIgnored(p('a')));
    assert.ok(!ig('#x\n\n   \n/\n!\n').isIgnored(p('a')));
  });
});

// ───────────────────────────── prompts ─────────────────────────────

describe('review: prompts', () => {
  const pf = (body: string): PromptFile => ({ name: 'p', path: '/p.md', scope: 'workspace', body });

  it('placeholder expansion vectors (00 §8 C4)', () => {
    const args = ['one', 'two words', '$&', '$1'];
    assert.equal(expandPrompt(pf('A=${1} B=${2} C=${3} D=${4}'), args), 'A=one B=two words C=$& D=$1');
    assert.equal(expandPrompt(pf('all: $ARGUMENTS / ${@}'), args), 'all: one two words $& $1 / one two words $& $1');
    assert.equal(expandPrompt(pf('${5}|${10}|${11}|$ARGUMENTSX'), args), '||${11}|$ARGUMENTSX');
    assert.equal(expandPrompt(pf('${10}'), ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'ten']), 'ten');
    assert.equal(expandPrompt(pf('${1}0'), ['x']), 'x0');
    assert.equal(expandPrompt(pf('no placeholders'), args), 'no placeholders');
    assert.equal(expandPrompt(pf('$1 and $ARGUMENTS'), []), '$1 and ');
  });

  it('invocation parsing (06 §8.1)', () => {
    assert.deepEqual(parsePromptInvocation('@review "performance issue" detailed'), {
      name: 'review',
      args: ['performance issue', 'detailed'],
      rawArgs: '"performance issue" detailed',
    });
    assert.deepEqual(parsePromptInvocation('  /Fix   a  '), { name: 'Fix', args: ['a'], rawArgs: 'a' });
    assert.deepEqual(parsePromptInvocation('@'), { error: 'Prompt name needs to be specified' });
    assert.deepEqual(parsePromptInvocation('@x "open'), { error: 'Error splitting prompt command' });
    assert.deepEqual(parsePromptInvocation('@ünï ç'), { name: 'ünï', args: ['ç'], rawArgs: 'ç' });
  });

  it('lookup: workspace over global, exact case first, then case-insensitive', () => {
    fx.mkdir('proj/.kiro');
    fx.write('home/.kiro/prompts/Review.md', 'global Review');
    fx.write('home/.kiro/prompts/review.md', 'global review');
    fx.write('proj/.kiro/prompts/review.md', '---\ndescription: ws review\n---\nws review');
    fx.write('proj/.kiro/prompts/notes.txt', 'no');
    const ps = loadPrompts(fx.ctx());
    assert.deepEqual(ps.map((p) => `${p.name}:${p.scope}`), ['Review:global', 'review:workspace']);
    assert.equal(findPrompt(ps, 'review')!.body, 'ws review');
    assert.equal(findPrompt(ps, 'review')!.description, 'ws review');
    assert.equal(findPrompt(ps, 'Review')!.body, 'global Review');
    assert.equal(findPrompt(ps, 'REVIEW')!.name, 'Review');
    assert.equal(findPrompt(ps, 'missing'), undefined);
  });
});

// ───────────────────────────── skills ─────────────────────────────

describe('review: skills', () => {
  it('rebuilding the plugin dir never deletes the linked skill sources', () => {
    const dir = path.dirname(fx.write('proj/.kiro/skills/foo/SKILL.md', '---\nname: foo\ndescription: d\n---\nbody'));
    fx.write('proj/.kiro/skills/foo/scripts/run.sh', 'echo');
    const skill = readSkill(dir, 'workspace')!;
    const target = path.join(fx.root, 'rt');
    const first = buildSkillsPluginDir([skill], target)!;
    const second = buildSkillsPluginDir([skill], target)!;
    assert.equal(first, second);
    assert.ok(fs.existsSync(path.join(dir, 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(dir, 'scripts', 'run.sh')));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(first, '.claude-plugin', 'plugin.json'), 'utf8')), { name: 'kiro', version: '0.0.0' });
    assert.equal(fs.readFileSync(path.join(first, 'skills', 'foo', 'SKILL.md'), 'utf8'), '---\nname: "foo"\ndescription: "d"\n---\n\nbody\n');
    assert.equal(fs.readFileSync(path.join(first, 'skills', 'foo', 'scripts', 'run.sh'), 'utf8'), 'echo', 'other entries are linked next to SKILL.md');
    assert.equal(buildSkillsPluginDir([], target), undefined);
  });

  it('the plugin SKILL.md is inert for Claude Code: no hooks/allowed-tools, no live !`cmd` or ```! blocks; the source is untouched', () => {
    const src = [
      '---',
      'name: probe',
      'description: probe skill',
      'allowed-tools: Bash(touch:*)',
      'hooks:',
      '  Stop:',
      '    - hooks: [{ type: command, command: "touch HOOK_RAN" }]',
      'model: haiku',
      '---',
      'Status: !`touch PWNED`',
      '```!',
      'touch PWNED2',
      '```',
      '  ~~~ !',
      'cat secret',
      '~~~',
      'Plain `code` and a bang! stay.',
    ].join('\n');
    const file = fx.write('proj/.kiro/skills/probe/SKILL.md', src);
    const skill = readSkill(path.dirname(file), 'workspace')!;
    const plugin = buildSkillsPluginDir([skill], path.join(fx.root, 'rt2'))!;
    const out = fs.readFileSync(path.join(plugin, 'skills', 'probe', 'SKILL.md'), 'utf8');
    const fm = out.split('---')[1]!;
    assert.deepEqual(fm.trim().split('\n'), ['name: "probe"', 'description: "probe skill"']);
    assert.ok(!/!`/.test(out), 'no live inline shell');
    assert.ok(!/^[ \t]*(`{3,}|~{3,})[ \t]*!/m.test(out), 'no live shell fence');
    assert.ok(out.includes('touch PWNED') && out.includes('Plain `code` and a bang! stay.'), 'text kept visible');
    assert.equal(fs.readFileSync(file, 'utf8'), src, 'source skill unchanged');
    assert.equal(fs.lstatSync(path.join(plugin, 'skills', 'probe')).isSymbolicLink(), false, 'a real directory, not a link to the source');
  });

  it('plugin directory names are sanitized and unique, in input order', () => {
    const mk = (name: string): SkillInfo => ({ name, dir: '/x', skillFile: '/x/SKILL.md', scope: 'workspace' });
    assert.deepEqual(pluginSkillDirNames([mk('Backend Patterns'), mk('backend-patterns'), mk('!!!'), mk('a'.repeat(80)), mk('ü')]), [
      'backend-patterns',
      'backend-patterns-2',
      'skill',
      'a'.repeat(64),
      'skill-2',
    ]);
  });

  it('discovery: workspace beats global; short names; globs; resource scope', () => {
    fx.mkdir('proj/.kiro');
    fx.write('proj/.kiro/skills/shared/SKILL.md', '---\nname: shared\ndescription: ws\n---\n');
    fx.write('home/.kiro/skills/shared/SKILL.md', '---\nname: shared\ndescription: global\n---\n');
    fx.write('home/.kiro/skills/only-global/SKILL.md', '---\ndescription: g\n---\n');
    fx.write('proj/extra/tools/SKILL.md', '---\nname: extra-tools\n---\n');
    fx.write('proj/.kiro/skills/nofile/README.md', 'x');
    const ws = fx.ctx();
    const all = discoverSkills(ws, ['skill://extra/*/SKILL.md', 'skill://only-global', 'skill://missing']);
    assert.deepEqual(
      all.map((s) => `${s.name}:${s.scope}:${s.description ?? ''}`),
      ['shared:workspace:ws', 'extra-tools:resource:', 'only-global:global:g'],
    );
    const none = discoverSkills(ws, [], { includeDefaults: false });
    assert.deepEqual(none, []);
  });

  it('skill invocation: placeholders substituted, else ARGUMENTS appended', () => {
    const d1 = path.dirname(fx.write('s1/SKILL.md', '---\nname: s1\n---\nRun ${1} on $ARGUMENTS\n'));
    const d2 = path.dirname(fx.write('s2/SKILL.md', '---\nname: s2\n---\nPlain body\n'));
    const s1 = readSkill(d1, 'resource')!;
    const s2 = readSkill(d2, 'resource')!;
    assert.equal(expandSkillInvocation(s1, ' "a b" c '), 'Run a b on "a b" c');
    assert.equal(expandSkillInvocation(s1, ''), 'Run  on ');
    assert.equal(expandSkillInvocation(s1, 'unbalanced "x'), 'Run unbalanced on unbalanced "x');
    assert.equal(expandSkillInvocation(s2, 'go now'), 'Plain body\n\nARGUMENTS: go now');
    assert.equal(expandSkillInvocation(s2, '   '), 'Plain body');
  });
});

// ───────────────────────────── agents ─────────────────────────────

describe('review: agents', () => {
  it('file selection: BOM, upper-case extensions, backups, examples, sidecars, hidden dirs, legacy md', () => {
    fx.mkdir('proj/.kiro');
    fx.write('proj/.kiro/agents/bom.json', '\uFEFF{"tools":[]}');
    fx.write('proj/.kiro/agents/UPPER.JSON', '{"tools":[]}');
    fx.write('proj/.kiro/agents/old.json.bak', '{"tools":[]}');
    fx.write('proj/.kiro/agents/old.json.bak.1', '{"tools":[]}');
    fx.write('proj/.kiro/agents/agent_config.json.example', '{"tools":[]}');
    fx.write('proj/.kiro/agents/._bom.json', 'garbage');
    fx.write('proj/.kiro/agents/.hidden/x.json', '{"tools":[]}');
    fx.write('proj/.kiro/agents/node_modules/y.json', '{"tools":[]}');
    fx.write('proj/.kiro/agents/team/planner.md', '---\ntools: ["read"]\n---\nPlan.');
    const r = loadAgents(fx.ctx());
    const names = [...r.agents.values()].filter((a) => a.scope !== 'builtin').map((a) => a.name);
    assert.deepEqual(names, ['UPPER', 'bom', 'team/planner']);
    assert.deepEqual(r.warnings, []);
  });

  it('02 §2.12 Markdown example parses completely', () => {
    const md = `---
name: backend-dev
description: Backend development agent
model: claude-sonnet-4.6
tools: ["read", "write", "shell", "web"]
excludedTools: ["knowledge"]
includeMcpJson: true
includePowers: false
mcpServers:
  postgres:
    command: npx
    args: ["-y", "@modelcontextprotocol/server-postgres"]
    env:
      DATABASE_URL: "\${DATABASE_URL}"
resources:
  - file://./ARCHITECTURE.md
  - skill://backend-patterns
permissions:
  rules:
    - capability: shell
      match: ["npm *", "node *"]
      effect: allow
welcomeMessage: "Ready to work on backend code."
---

You are a backend developer focused on Node.js and TypeScript.
`;
    const ws = fx.ctx(undefined, { DATABASE_URL: 'postgres://db' });
    const r = parseAgent(md, { scope: 'workspace', format: 'md', ws, path: path.join(fx.ws, '.kiro', 'agents', 'backend.md') });
    assert.deepEqual(r.warnings, []);
    const a = r.agent!;
    assert.equal(a.name, 'backend-dev');
    assert.equal(a.dialect, 'v3');
    assert.equal(a.model, 'claude-sonnet-4.6');
    assert.deepEqual(a.tools, ['read', 'write', 'shell', 'web']);
    assert.deepEqual(a.excludedTools, ['knowledge']);
    assert.equal(a.includeMcpJson, true);
    assert.equal(a.mcpServers.postgres!.env.DATABASE_URL, 'postgres://db');
    assert.deepEqual(a.mcpServers.postgres!.args, ['-y', '@modelcontextprotocol/server-postgres']);
    assert.deepEqual(a.resources, [
      { kind: 'file', uri: 'file://./ARCHITECTURE.md' },
      { kind: 'skill', uri: 'skill://backend-patterns' },
    ]);
    assert.deepEqual(a.permissions, [{ capability: 'shell', match: ['npm *', 'node *'], effect: 'allow', scope: 'agent' }]);
    assert.equal(a.welcomeMessage, 'Ready to work on backend code.');
    assert.equal(a.prompt, 'You are a backend developer focused on Node.js and TypeScript.');
    assert.deepEqual(a.allowedTools, []);
    assert.equal(a.format, 'md');
  });

  it('02 §2.12 CLI 2.x JSON example parses as a V2 agent', () => {
    fx.write('proj/.kiro/agents/resources/MY_PROMPT.md', 'Be helpful.\n');
    const file = fx.write('proj/.kiro/agents/my-agent.json', {
      name: 'my-agent',
      description: 'A development agent',
      prompt: 'file://resources/MY_PROMPT.md',
      model: 'claude-sonnet-4.6',
      tools: ['fs_read', 'fs_write', 'execute_bash', 'grep', 'glob', 'code'],
      toolsSettings: {
        execute_bash: { allowedCommands: ['^git status$', '^cargo build[^&;]*$'], deniedCommands: ['^rm -rf'], denyByDefault: false },
        fs_read: { allowedPaths: ['src/**', 'docs/**'], deniedPaths: ['.env', 'secrets/**'] },
        fs_write: { allowedPaths: ['src/**'], deniedPaths: ['*.lock'] },
      },
      resources: ['file://AGENTS.md'],
      hooks: { agentSpawn: [{ command: 'git status', description: 'Add git context' }] },
      welcomeMessage: 'Hello! How can I help?',
    });
    const r = loadAgents(fx.ctx());
    const a = r.agents.get('my-agent')!;
    assert.deepEqual(r.warnings, []);
    assert.equal(a.path, file);
    assert.equal(a.dialect, 'v2');
    assert.equal(a.prompt, 'Be helpful.\n');
    assert.deepEqual(a.toolsSettings.execute_bash!.allowedCommands, ['^git status$', '^cargo build[^&;]*$']);
    assert.equal(a.hooks.length, 1);
    assert.equal(a.hooks[0]!.name, 'agentSpawn-0');
    assert.equal(a.hooks[0]!.dialect, 'v2');
    // the prompt Markdown file is not itself an agent
    assert.equal(r.agents.has('resources/MY_PROMPT'), false);
  });

  it('selection: both missing ⇒ two Q errors, kiro_default, both names reported', () => {
    fx.write('home/.kiro/settings/cli.json', { 'chat.defaultAgent': 'ghost' });
    const ws = fx.ctx();
    const s = openSettings(ws);
    const { agents } = loadAgents(ws, { settings: s });
    const r = selectAgent(ws, agents, s, 'nobody', { interactive: false });
    assert.equal(r.agent.name, 'kiro_default');
    assert.equal(r.missingRequested, 'nobody');
    assert.equal(r.missingDefault, 'ghost');
    assert.deepEqual(
      r.warnings.map((w) => w.message),
      ['Error: no agent with name nobody found. Falling back to user specified default', 'Error: user defined default ghost not found. Falling back to in-memory default'],
    );
    const empty = selectAgent(ws, agents, s, '');
    assert.equal(empty.missingRequested, undefined);
    assert.equal(empty.agent.name, 'kiro_default');
    // even with an empty map the built-in default is returned
    assert.equal(selectAgent(ws, new Map<string, KiroAgent>(), openSettings(fx.ctx(fx.home)), undefined).agent.name, 'kiro_default');
  });

  it('validateAgentObject on non-objects and known extras', () => {
    for (const v of [null, [], 'x', 3]) assert.deepEqual(codes(validateAgentObject(v)), ['invalid-agent']);
    assert.deepEqual(validateAgentObject({ kiroUpgrade: { v: 1 }, includeCrewContext: true, tools: '*' }), []);
    assert.deepEqual(codes(validateAgentObject({ tools: 'read' })), ['invalid-field']);
    assert.deepEqual(codes(validateAgentObject({ resources: ['https://x', 'FILE://ok', { type: 'knowledgeBase', source: 's' }] })), ['invalid-field', 'invalid-field']);
  });

  it('create template: Q key order, Kiro adaptations, JSON round-trip', () => {
    const t = agentCreateTemplate('reviewer', { description: 'Reviews', tools: ['read'], mcpServers: { a: { command: 'x' } } });
    assert.deepEqual(Object.keys(t), [
      '$schema',
      'name',
      'description',
      'prompt',
      'mcpServers',
      'tools',
      'toolAliases',
      'allowedTools',
      'resources',
      'hooks',
      'toolsSettings',
      'includeMcpJson',
      'model',
    ]);
    const ws = fx.ctx();
    const r = parseAgent(JSON.stringify(t, null, 2), { scope: 'workspace', format: 'json', ws });
    assert.deepEqual(r.warnings, []);
    assert.equal(r.agent!.name, 'reviewer');
    assert.deepEqual(r.agent!.tools, ['read']);
    assert.equal(r.agent!.mcpServers.a!.command, 'x');
  });

  it('prompt file:// errors: directory, empty URI, missing', () => {
    fx.mkdir('proj/.kiro/agents/adir');
    const ws = fx.ctx();
    const at = path.join(fx.ws, '.kiro', 'agents', 'x.json');
    const run = (prompt: string) => parseAgent(JSON.stringify({ tools: [], prompt }), { scope: 'workspace', format: 'json', ws, path: at });
    const dir = run('file://adir');
    assert.equal(dir.agent, undefined);
    assert.equal(dir.warnings.at(-1)!.message, `File URI not found: file://adir (resolved to ${path.join(fx.ws, '.kiro', 'agents', 'adir')})`);
    assert.equal(run('file://').warnings.at(-1)!.message, 'Invalid file URI format: file://');
    assert.equal(run('FILE://nope.md').agent, undefined);
    // a non-file:// prompt is literal text
    assert.equal(run('https://example.com/prompt').agent!.prompt, 'https://example.com/prompt');
  });
});

// ───────────────────────────── resources ─────────────────────────────

describe('review: resources', () => {
  it('kiro_default: README included, steering/AGENTS.md left to steering.ts, ignored files dropped', () => {
    fx.mkdir('proj/.kiro');
    fx.write('proj/README.md', 'r');
    fx.write('proj/AGENTS.md', 'a');
    fx.write('proj/AmazonQ.md', 'q');
    fx.write('proj/.kiro/steering/s.md', 's');
    fx.write('home/.kiro/steering/g.md', 'g');
    fx.write('proj/.amazonq/rules/r.md', 'r');
    fx.write('proj/.kiroignore', 'AmazonQ.md\n');
    const ws = fx.ctx();
    const def = loadAgents(ws).agents.get('kiro_default')!;
    const r = resolveResources(ws, def);
    const all = r.files.flatMap((f) => f.paths).map((p) => path.relative(fx.root, p));
    assert.deepEqual(all, ['proj/README.md']);
    assert.deepEqual(r.steeringFiles, []);
    assert.ok(r.skillUris.includes('skill://.kiro/skills/*/SKILL.md'));
  });

  it('custom agent without inheritance: steering matched by its globs is returned for inclusion handling', () => {
    fx.mkdir('proj/.kiro');
    fx.write('proj/.kiro/steering/s.md', '---\ninclusion: manual\n---\ns');
    fx.write('proj/docs/a.md', 'a');
    fx.write('proj/docs/sub/b.md', 'b');
    fx.write('home/.kiro/steering/g.md', 'g');
    const ws = fx.ctx(undefined, { KIRO_HOME: path.join(fx.root, 'kh') });
    fs.mkdirSync(path.join(fx.root, 'kh', 'steering'), { recursive: true });
    fs.writeFileSync(path.join(fx.root, 'kh', 'steering', 'k.md'), 'k');
    const agent = {
      name: 'c',
      inheritDefaultResources: false,
      resources: [
        { kind: 'file' as const, uri: 'file://.kiro/steering/**/*.md' },
        { kind: 'file' as const, uri: 'file://~/.kiro/steering/*.md' },
        { kind: 'file' as const, uri: 'file://docs/*.md' },
        { kind: 'file' as const, uri: 'file://docs' },
        { kind: 'file' as const, uri: 'file://docs/**/*.md' },
        { kind: 'skill' as const, uri: 'skill://x' },
        { kind: 'knowledgeBase' as const, source: 'file://./docs', name: 'Docs' },
      ],
    };
    const r = resolveResources(ws, agent);
    assert.deepEqual(r.steeringFiles.map((p) => path.relative(fx.root, p)), ['proj/.kiro/steering/s.md', 'kh/steering/k.md']);
    assert.deepEqual(
      r.files.map((f) => [f.pattern, f.paths.map((p) => path.relative(fx.root, p))]),
      [
        ['.kiro/steering/**/*.md', []],
        ['~/.kiro/steering/*.md', []],
        ['docs/*.md', ['proj/docs/a.md']],
        ['docs', []],
        ['docs/**/*.md', ['proj/docs/sub/b.md']],
      ],
    );
    assert.deepEqual(r.skillUris, ['skill://x']);
    assert.equal(r.knowledgeBases.length, 1);
  });

  it('a glob ending in "/" never yields directories as resources', () => {
    fx.write('proj/docs/a/x.md', 'x');
    fx.write('proj/docs/f.md', 'f');
    const r = resolveResources(fx.ctx(), {
      name: 'g',
      inheritDefaultResources: false,
      resources: [
        { kind: 'file', uri: 'file://docs/*/' },
        { kind: 'file', uri: 'file://docs/*' },
      ],
    });
    assert.deepEqual(r.files[0]!.paths, []);
    assert.deepEqual(r.files[1]!.paths, [path.join(fx.ws, 'docs', 'f.md')]);
  });

  it('unicode and spaces in paths and agent names', () => {
    fx.mkdir('proj/.kiro');
    fx.write('proj/.kiro/agents/équipe/plan ificateur.md', '---\ntools: ["read"]\n---\nBonjour ✓');
    fx.write('proj/doc s/ünï.md', 'u');
    fx.write('proj/.kiro/steering/日本.md', '---\ninclusion: manual\n---\n本文');
    const ws = fx.ctx();
    const a = loadAgents(ws).agents.get('équipe/plan ificateur')!;
    assert.equal(a.prompt, 'Bonjour ✓');
    const r = resolveResources(ws, { name: 'u', inheritDefaultResources: false, resources: [{ kind: 'file', uri: 'file://doc s/*.md' }] });
    assert.deepEqual(r.files[0]!.paths, [path.join(fx.ws, 'doc s', 'ünï.md')]);
    const st = loadSteering(ws).files.find((f) => f.name === '日本')!;
    assert.equal(st.inclusion, 'manual');
    assert.equal(st.body, '本文');
  });

  it('invalid glob is reported, other rules still resolve', () => {
    fx.write('proj/ok.md', 'x');
    const ws = fx.ctx();
    const r = resolveResources(ws, {
      name: 'g',
      inheritDefaultResources: false,
      resources: [
        { kind: 'file', uri: 'file://[unclosed*.md' },
        { kind: 'file', uri: 'file://ok.md' },
      ],
    });
    assert.deepEqual(codes(r.warnings), ['resource-glob']);
    assert.deepEqual(r.files[1]!.paths, [path.join(fx.ws, 'ok.md')]);
  });
});

// ───────────────────────────── permissions.yaml ─────────────────────────────

describe('review: permissions.yaml', () => {
  it('format/parse round trip keeps special characters', () => {
    const rules = [
      { capability: 'shell', match: ['git commit -m "x: y"', "it's", 'a\\b', 'ünï *'], exclude: ['# not a comment'], effect: 'allow' as const, scope: 'user' as const },
      { capability: 'fs_write', effect: 'deny' as const, scope: 'user' as const },
    ];
    const text = formatPermissionsYaml({ rules, presets: ['read-all'], workspaceTrusted: true, workspaceRoot: '/a b/c: d' });
    const back = parsePermissionsYaml(text, 'user');
    assert.deepEqual(back.warnings, []);
    assert.deepEqual(back.rules, rules);
    assert.deepEqual(back.presets, ['read-all']);
    assert.equal(back.workspaceTrusted, true);
    assert.equal(back.workspaceRoot, '/a b/c: d');
  });

  it('invalid rules are dropped with warnings; scalars accepted for match/policies', () => {
    const r = parsePermissionsYaml(
      'rules:\n  - capability: shell\n    match: "npm *"\n    effect: allow\n  - capability: shell\n    effect: Allow\n  - effect: deny\n  - capability: mcp\n    match: [1]\n    effect: ask\npolicies: dev-shell\n',
      'workspace',
    );
    assert.deepEqual(r.rules, [{ capability: 'shell', match: ['npm *'], effect: 'allow', scope: 'workspace' }]);
    assert.deepEqual(r.presets, ['dev-shell']);
    assert.deepEqual(codes(r.warnings), ['permissions-invalid', 'permissions-invalid', 'permissions-invalid']);
  });
});

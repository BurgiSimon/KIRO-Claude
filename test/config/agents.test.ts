import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  AGENT_SCHEMA,
  AGENT_SCHEMA_URL,
  agentCreateTemplate,
  agentDirs,
  agentLocation,
  builtinAgents,
  KIRO_DEFAULT_RESOURCES,
  loadAgentFile,
  loadAgents,
  parseAgent,
  resolveFilePrompt,
  selectAgent,
  validateAgentObject,
} from '../../src/config/agents.js';
import { openSettings } from '../../src/config/settings.js';
import { codes, makeFixture, type Fixture } from './helpers.js';

const V2_AGENT = {
  name: 'my-agent',
  description: 'A development agent',
  prompt: 'file://resources/MY_PROMPT.md',
  model: 'claude-sonnet-4.6',
  tools: ['fs_read', 'fs_write', 'execute_bash', 'grep', 'glob', 'code', '@git'],
  allowedTools: ['fs_read', '@git/status', 'fs_read'],
  toolsSettings: {
    execute_bash: { allowedCommands: ['^git status$', '^cargo build[^&;]*$'], deniedCommands: ['^rm -rf'], denyByDefault: false },
    fs_read: { allowedPaths: ['src/**', 'docs/**'], deniedPaths: ['.env', 'secrets/**'] },
    fs_write: { allowedPaths: ['src/**'], deniedPaths: ['*.lock'] },
  },
  toolAliases: { '@git/status': 'gstatus' },
  mcpServers: { git: { command: 'uvx', args: ['mcp-server-git'], env: { TOKEN: '${env:GIT_TOKEN}' } } },
  resources: ['file://AGENTS.md', 'skill://backend', { type: 'knowledgeBase', source: 'file://./docs', name: 'Docs', description: 'd' }],
  hooks: { agentSpawn: [{ command: 'git status', description: 'Add git context' }], preToolUse: [{ command: 'audit', matcher: 'execute_bash', timeout_ms: 1000 }] },
  welcomeMessage: 'Hello! How can I help?',
  keyboardShortcut: 'ctrl+shift+a',
  useLegacyMcpJson: true,
};

const V3_AGENT = {
  name: 'v3-agent',
  description: 'V3 agent',
  prompt: 'Be careful.',
  tools: ['read', 'write', 'shell', '@git'],
  excludedTools: ['web'],
  includeMcpJson: true,
  permissions: {
    rules: [
      { capability: 'shell', match: ['npm *', 'git *'], exclude: ['npm publish*'], effect: 'allow' },
      { capability: 'fs_write', match: '.env', effect: 'deny' },
      { capability: 'web_fetch', effect: 'sometimes' },
    ],
  },
  hooks: [
    { name: 'lint', trigger: 'PreToolUse', matcher: 'write', action: { type: 'command', command: 'npm run lint' }, timeout: 30 },
    { name: 'ctx', trigger: 'agentSpawn', action: { type: 'agent', prompt: 'Summarize the repo' } },
  ],
  allowedTools: ['fs_read'],
  toolsSettings: { fs_read: { allowedPaths: ['x'] } },
};

describe('config/agents parseAgent', () => {
  let fx: Fixture;
  afterEach(() => fx?.cleanup());

  it('V2 JSON agent: file:// prompt relative to the agent file, V2 fields, object hooks', () => {
    fx = makeFixture();
    fx.write('home/.kiro/agents/resources/MY_PROMPT.md', 'You are my agent.\n');
    const file = fx.write('home/.kiro/agents/my-agent.json', V2_AGENT);
    const r = loadAgentFile(file, { scope: 'global', ws: fx.ctx(undefined, { GIT_TOKEN: 'secret' }) });
    const a = r.agent!;
    assert.deepEqual(codes(r.warnings), []);
    assert.equal(a.name, 'my-agent');
    assert.equal(a.path, file);
    assert.equal(a.format, 'json');
    assert.equal(a.scope, 'global');
    assert.equal(a.dialect, 'v2');
    assert.equal(a.prompt, 'You are my agent.\n');
    assert.equal(a.model, 'claude-sonnet-4.6');
    assert.equal(a.description, 'A development agent');
    assert.equal(a.welcomeMessage, 'Hello! How can I help?');
    assert.equal(a.keyboardShortcut, 'ctrl+shift+a');
    assert.deepEqual(a.tools, V2_AGENT.tools);
    assert.deepEqual(a.excludedTools, []);
    assert.deepEqual(a.allowedTools, ['fs_read', '@git/status']);
    assert.deepEqual(a.toolsSettings, V2_AGENT.toolsSettings);
    assert.deepEqual(a.toolAliases, { '@git/status': 'gstatus' });
    assert.deepEqual(a.permissions, []);
    assert.equal(a.includeMcpJson, false);
    assert.equal(a.useLegacyMcpJson, true);
    assert.equal(a.inheritDefaultResources, true);
    assert.deepEqual(a.resources, [
      { kind: 'file', uri: 'file://AGENTS.md' },
      { kind: 'skill', uri: 'skill://backend' },
      { kind: 'knowledgeBase', source: 'file://./docs', name: 'Docs', description: 'd' },
    ]);
    assert.equal(a.mcpServers.git!.env.TOKEN, 'secret');
    assert.equal(a.mcpServers.git!.origin, 'agent');
    assert.equal(a.mcpServers.git!.sourcePath, file);
    assert.deepEqual(
      a.hooks.map((h) => [h.dialect, h.name, h.trigger, h.rawTrigger, h.timeoutMs, h.matcher, h.agentName]),
      [
        ['v2', 'agentSpawn-0', 'SessionStart', 'agentSpawn', 30000, undefined, 'my-agent'],
        ['v2', 'preToolUse-0', 'PreToolUse', 'preToolUse', 1000, 'execute_bash', 'my-agent'],
      ],
    );
  });

  it('V3 JSON agent: permissions ⇒ v3, rules validated, V2 fields emptied, array hooks', () => {
    fx = makeFixture();
    const r = parseAgent(V3_AGENT, { scope: 'workspace', format: 'json', ws: fx.ctx(), path: path.join(fx.ws, '.kiro/agents/v3-agent.json') });
    const a = r.agent!;
    assert.equal(a.dialect, 'v3');
    assert.deepEqual(a.permissions, [
      { capability: 'shell', match: ['npm *', 'git *'], exclude: ['npm publish*'], effect: 'allow', scope: 'agent' },
      { capability: 'fs_write', match: ['.env'], effect: 'deny', scope: 'agent' },
    ]);
    assert.deepEqual(codes(r.warnings), ['permissions-invalid']);
    assert.deepEqual(a.allowedTools, []);
    assert.deepEqual(a.toolsSettings, {});
    assert.deepEqual(a.excludedTools, ['web']);
    assert.equal(a.includeMcpJson, true);
    assert.equal(a.prompt, 'Be careful.');
    assert.deepEqual(
      a.hooks.map((h) => [h.dialect, h.name, h.trigger, h.rawTrigger, h.timeoutMs, h.action.type]),
      [
        ['v3', 'lint', 'PreToolUse', 'PreToolUse', 30000, 'command'],
        ['v3', 'ctx', 'SessionStart', 'agentSpawn', 60000, 'agent'],
      ],
    );
  });

  it('Markdown agent: front matter fields, body is the prompt (02 §2.12 example)', () => {
    fx = makeFixture();
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
    const file = fx.write('proj/.kiro/agents/backend.md', md);
    const r = loadAgentFile(file, { scope: 'workspace', ws: fx.ctx(undefined, { DATABASE_URL: 'pg://db' }) });
    const a = r.agent!;
    assert.deepEqual(r.warnings, []);
    assert.equal(a.format, 'md');
    assert.equal(a.name, 'backend-dev');
    assert.equal(a.dialect, 'v3');
    assert.equal(a.prompt, 'You are a backend developer focused on Node.js and TypeScript.');
    assert.deepEqual(a.tools, ['read', 'write', 'shell', 'web']);
    assert.deepEqual(a.excludedTools, ['knowledge']);
    assert.equal(a.mcpServers.postgres!.env.DATABASE_URL, 'pg://db');
    assert.deepEqual(a.mcpServers.postgres!.args, ['-y', '@modelcontextprotocol/server-postgres']);
    assert.deepEqual(a.permissions, [{ capability: 'shell', match: ['npm *', 'node *'], effect: 'allow', scope: 'agent' }]);
    assert.deepEqual(a.resources, [
      { kind: 'file', uri: 'file://./ARCHITECTURE.md' },
      { kind: 'skill', uri: 'skill://backend-patterns' },
    ]);
    assert.equal(a.welcomeMessage, 'Ready to work on backend code.');
  });

  it('Markdown agent without front matter: whole text is the prompt, tools missing warning', () => {
    fx = makeFixture();
    const r = parseAgent('Just a prompt.\n', { scope: 'global', format: 'md', ws: fx.ctx(), defaultName: 'team/plain' });
    assert.equal(r.agent!.name, 'team/plain');
    assert.equal(r.agent!.prompt, 'Just a prompt.');
    assert.deepEqual(r.agent!.tools, []);
    assert.deepEqual(codes(r.warnings), ['tools-missing']);
  });

  it('Markdown agent: prompt field ignored when a body exists; broken front matter fails', () => {
    fx = makeFixture();
    const r = parseAgent('---\nprompt: x\ntools: ["*"]\n---\nBody\n', { scope: 'global', format: 'md', ws: fx.ctx(), defaultName: 'p' });
    assert.equal(r.agent!.prompt, 'Body');
    assert.deepEqual(codes(r.warnings), ['md-prompt-ignored']);
    const bad = parseAgent('---\ntools: [a, b\n---\nBody\n', { scope: 'global', format: 'md', ws: fx.ctx(), path: '/x/bad.md' });
    assert.equal(bad.agent, undefined);
    assert.equal(bad.warnings[0]!.code, 'invalid-front-matter');
  });

  it('invalid JSON warns with Q text and line/column', () => {
    fx = makeFixture();
    const r = parseAgent('{\n  "name": "x",\n  "tools": [,]\n}', { scope: 'global', format: 'json', ws: fx.ctx(), path: '/a/x.json' });
    assert.equal(r.agent, undefined);
    assert.equal(r.warnings[0]!.code, 'invalid-json');
    assert.match(r.warnings[0]!.message, /^Json supplied at \/a\/x\.json is invalid: .* at line 3 column 13$/);
    assert.equal(r.warnings[0]!.path, '/a/x.json');
  });

  it('non-object roots fail', () => {
    fx = makeFixture();
    assert.equal(parseAgent('[1]', { scope: 'global', format: 'json', ws: fx.ctx() }).agent, undefined);
    assert.equal(parseAgent(42, { scope: 'global', format: 'json', ws: fx.ctx() }).warnings[0]!.code, 'invalid-agent');
  });

  it('unknown fields and wrong types warn but load', () => {
    fx = makeFixture();
    const r = parseAgent(
      { name: 'w', tools: 'read', foo: 1, kiroUpgrade: {}, includeCrewContext: true, model: 5, resources: ['README.md', 7], useLegacyMcpJson: 'yes' },
      { scope: 'global', format: 'json', ws: fx.ctx() },
    );
    assert.ok(r.agent);
    assert.deepEqual(r.agent!.tools, []);
    assert.equal(r.agent!.model, undefined);
    assert.deepEqual(r.agent!.resources, []);
    assert.equal(r.agent!.useLegacyMcpJson, false);
    assert.deepEqual(codes(r.warnings).sort(), ['invalid-field', 'invalid-field', 'invalid-field', 'invalid-field', 'invalid-field', 'unknown-field'].sort());
    assert.ok(r.warnings.some((w) => w.message === "Agent config w has unknown field 'foo' (ignored)"));
    assert.ok(r.warnings.some((w) => w.message.startsWith('WARNING Agent config w is malformed at /tools: expected array of strings')));
  });

  it('tools "*" string accepted (IDE form)', () => {
    fx = makeFixture();
    assert.deepEqual(parseAgent({ tools: '*' }, { scope: 'global', format: 'json', ws: fx.ctx(), defaultName: 'x' }).agent!.tools, ['*']);
  });

  it('prompt file errors use Q texts and fail the agent', () => {
    fx = makeFixture();
    const f = path.join(fx.root, 'agents', 'a.json');
    const r = parseAgent({ name: 'a', tools: [], prompt: 'file://missing.md' }, { scope: 'global', format: 'json', ws: fx.ctx(), path: f });
    assert.equal(r.agent, undefined);
    assert.equal(r.warnings[0]!.message, `File URI not found: file://missing.md (resolved to ${path.join(fx.root, 'agents', 'missing.md')})`);
    assert.equal(resolveFilePrompt('file://', '/x', fx.env).error, 'Invalid file URI format: file://');
    fx.mkdir('agents/dir.md');
    assert.match(resolveFilePrompt('file://dir.md', path.join(fx.root, 'agents'), fx.env).error!, /^File URI not found/);
  });

  it('prompt file:// with ~/ and absolute paths', () => {
    fx = makeFixture();
    fx.write('home/prompts/p.md', 'HOME PROMPT');
    const abs = fx.write('abs/p.md', 'ABS PROMPT');
    assert.equal(resolveFilePrompt('file://~/prompts/p.md', '/nowhere', fx.env).text, 'HOME PROMPT');
    assert.equal(resolveFilePrompt(`file://${abs}`, '/nowhere', fx.env).text, 'ABS PROMPT');
  });

  it('inheritDefaultResources follows chat.disableInheritingDefaultResources', () => {
    fx = makeFixture();
    fx.write('home/.kiro/settings/cli.json', { 'chat.disableInheritingDefaultResources': true });
    const ws = fx.ctx();
    const settings = openSettings(ws);
    assert.equal(parseAgent({ tools: [] }, { scope: 'global', format: 'json', ws, settings, defaultName: 'x' }).agent!.inheritDefaultResources, false);
    assert.equal(parseAgent({ tools: [] }, { scope: 'global', format: 'json', ws, defaultName: 'x' }).agent!.inheritDefaultResources, true);
  });

  it('permissions as a bare list (lenient) and empty permissions object', () => {
    fx = makeFixture();
    const a = parseAgent({ tools: [], permissions: [{ capability: 'all', effect: 'ask' }] }, { scope: 'global', format: 'json', ws: fx.ctx(), defaultName: 'x' }).agent!;
    assert.equal(a.dialect, 'v3');
    assert.deepEqual(a.permissions, [{ capability: 'all', effect: 'ask', scope: 'agent' }]);
    const b = parseAgent({ tools: [], permissions: {} }, { scope: 'global', format: 'json', ws: fx.ctx(), defaultName: 'x' }).agent!;
    assert.equal(b.dialect, 'v3');
    assert.deepEqual(b.permissions, []);
    const c = parseAgent({ tools: [], permissions: null }, { scope: 'global', format: 'json', ws: fx.ctx(), defaultName: 'x' }).agent!;
    assert.equal(c.dialect, 'v2');
  });
});

describe('config/agents validateAgentObject', () => {
  const table: [unknown, string[]][] = [
    [{}, []],
    [{ name: 'a', tools: ['*'], hooks: {}, permissions: { rules: [] } }, []],
    [{ hooks: 'x' }, ['invalid-field']],
    [{ toolsSettings: { a: 1 } }, ['invalid-field']],
    [{ mcpServers: { a: [] } }, ['invalid-field']],
    [{ toolAliases: { a: 1 } }, ['invalid-field']],
    [{ resources: ['skill://x', 'file://y', { type: 'knowledgeBase', source: 's', name: 'n' }] }, []],
    [{ resources: ['http://x'] }, ['invalid-field']],
    [{ permissions: { rules: {} } }, ['invalid-field']],
    [{ description: null, prompt: null, model: null }, []],
    [{ bogus: 1, other: 2 }, ['unknown-field', 'unknown-field']],
    ['str', ['invalid-agent']],
  ];
  for (const [obj, want] of table) it(JSON.stringify(obj), () => assert.deepEqual(codes(validateAgentObject(obj)), want));
});

describe('config/agents loadAgents', () => {
  let fx: Fixture;
  afterEach(() => fx?.cleanup());

  it('workspace + global + nested names + conflicts + built-ins', () => {
    fx = makeFixture();
    fx.write('proj/.kiro/agents/reviewer.json', { tools: ['read'], description: 'ws reviewer' });
    fx.write('home/.kiro/agents/reviewer.json', { tools: ['read'], description: 'global reviewer' });
    fx.write('home/.kiro/agents/team/planner.md', '---\ntools: ["read"]\n---\nPlan things.\n');
    fx.write('home/.kiro/agents/named.json', { name: 'custom-name', tools: [] });
    fx.write('home/.kiro/agents/._sidecar.json', 'garbage');
    fx.write('home/.kiro/agents/old.json.bak', '{}');
    fx.write('home/.kiro/agents/agent_config.json.example', '{}');
    fx.write('home/.kiro/agents/.hidden/x.json', { tools: [] });
    const r = loadAgents(fx.ctx());
    assert.deepEqual([...r.agents.keys()], ['reviewer', 'custom-name', 'team/planner', 'kiro_default', 'kiro_planner', 'kiro_help']);
    assert.equal(r.agents.get('reviewer')!.description, 'ws reviewer');
    assert.equal(r.agents.get('reviewer')!.scope, 'workspace');
    assert.equal(r.agents.get('team/planner')!.prompt, 'Plan things.');
    assert.deepEqual(
      r.warnings.map((w) => w.message),
      ['WARNING: Agent conflict for reviewer. Using workspace version.'],
    );
    assert.equal(r.failed.size, 0);
  });

  it('duplicate names within one scope keep the first (Q text)', () => {
    fx = makeFixture();
    fx.write('home/.kiro/agents/a.json', { name: 'dup', tools: [], description: 'first' });
    fx.write('home/.kiro/agents/b.json', { name: 'dup', tools: [], description: 'second' });
    const r = loadAgents(fx.ctx());
    assert.equal(r.agents.get('dup')!.description, 'first');
    assert.deepEqual(r.warnings.map((w) => w.message), ['WARNING: Duplicate agent with name dup was found in the global directory.']);
  });

  it('invalid files are skipped with a warning and listed in failed', () => {
    fx = makeFixture();
    const bad = fx.write('proj/.kiro/agents/broken.json', '{ "tools": [ }');
    fx.write('proj/.kiro/agents/ok.json', { tools: [] });
    const r = loadAgents(fx.ctx());
    assert.ok(r.agents.has('ok'));
    assert.ok(!r.agents.has('broken'));
    assert.equal(r.failed.get('broken')!.code, 'invalid-json');
    assert.equal(r.failed.get('broken')!.path, bad);
    assert.match(r.warnings[0]!.message, /^Json supplied at .*broken\.json is invalid: .* at line 1 column 14$/);
  });

  it('user agent overrides a built-in of the same name', () => {
    fx = makeFixture();
    fx.write('home/.kiro/agents/kiro_default.json', { tools: ['read'], description: 'mine' });
    const r = loadAgents(fx.ctx());
    assert.equal(r.agents.get('kiro_default')!.description, 'mine');
    assert.equal(r.agents.get('kiro_default')!.scope, 'global');
  });

  it('legacy dirs are used only when the Kiro dirs are absent', () => {
    fx = makeFixture();
    fx.write('proj/.amazonq/cli-agents/qa.json', { name: 'qa', tools: [] });
    fx.write('proj/.amazonq/cli-agents/sub/nested.json', { tools: [] });
    fx.write('home/.aws/amazonq/cli-agents/qg.json', { name: 'qg', tools: [] });
    fx.write('home/.aws/amazonq/cli-agents/x.md', 'md ignored in legacy dirs');
    let r = loadAgents(fx.ctx());
    assert.ok(r.agents.has('qa'));
    assert.ok(r.agents.has('qg'));
    assert.ok(!r.agents.has('sub/nested'));
    assert.ok(!r.agents.has('x'));
    // With .kiro present in the workspace and ~/.kiro/agents present, legacy dirs are ignored.
    fx.write('proj/.kiro/steering/a.md', 'x');
    fx.mkdir('home/.kiro/agents');
    r = loadAgents(fx.ctx());
    assert.ok(!r.agents.has('qa'));
    assert.ok(!r.agents.has('qg'));
    assert.deepEqual(codes(r.warnings), ['legacy-ignored']);
  });

  it('KIRO_AGENT_CONFIG_DIR replaces the global dir and skips the workspace', () => {
    fx = makeFixture();
    fx.write('proj/.kiro/agents/wsagent.json', { tools: [] });
    fx.write('home/.kiro/agents/gagent.json', { tools: [] });
    const custom = fx.mkdir('custom');
    fx.write('custom/cagent.json', { tools: [] });
    const ws = fx.ctx(undefined, { KIRO_AGENT_CONFIG_DIR: custom });
    assert.equal(agentDirs(ws).global, custom);
    const r = loadAgents(ws);
    assert.deepEqual([...r.agents.keys()].filter((k) => !k.startsWith('kiro_')), ['cagent']);
    assert.equal(r.agents.get('cagent')!.scope, 'global');
  });

  it('running from home does not load ~/.kiro/agents twice', () => {
    fx = makeFixture();
    fx.write('home/.kiro/agents/a.json', { tools: [] });
    const r = loadAgents(fx.ctx(fx.home));
    assert.deepEqual(r.warnings, []);
    assert.equal(r.agents.get('a')!.scope, 'global');
  });

  it('agentDirs default', () => {
    fx = makeFixture();
    const d = agentDirs(fx.ctx());
    assert.equal(d.workspace, path.join(fx.ws, '.kiro', 'agents'));
    assert.equal(d.global, path.join(fx.kiroHome, 'agents'));
  });
});

describe('config/agents built-ins and selection', () => {
  let fx: Fixture;
  afterEach(() => fx?.cleanup());

  it('built-in agents', () => {
    fx = makeFixture();
    const [def, planner, help] = builtinAgents(fx.ctx());
    assert.equal(def!.name, 'kiro_default');
    assert.deepEqual(def!.tools, ['*']);
    assert.equal(def!.includeMcpJson, true);
    assert.equal(def!.useLegacyMcpJson, true);
    assert.equal(def!.dialect, 'v3');
    assert.equal(def!.format, 'builtin');
    assert.equal(def!.inheritDefaultResources, true);
    assert.deepEqual(def!.resources.map((r) => (r.kind === 'knowledgeBase' ? r.name : r.uri)), [...KIRO_DEFAULT_RESOURCES]);
    assert.equal(planner!.name, 'kiro_planner');
    assert.deepEqual(planner!.tools, ['read', 'web']);
    assert.ok(planner!.permissions.some((r) => r.capability === 'fs_write' && r.effect === 'deny'));
    assert.match(planner!.prompt!, /\*\*Implementation Plan - <Title>\*\*/);
    assert.equal(help!.name, 'kiro_help');
    assert.ok(help!.prompt);
    assert.equal(agentLocation(def!), '**No path found**');
  });

  it('selection order: --agent > chat.defaultAgent > kiro_default, with Q texts', () => {
    fx = makeFixture();
    fx.write('home/.kiro/agents/a.json', { tools: [] });
    fx.write('home/.kiro/agents/b.json', { tools: [] });
    const ws = fx.ctx();
    const { agents } = loadAgents(ws);
    const settings = openSettings(ws);
    assert.equal(selectAgent(ws, agents, settings).agent.name, 'kiro_default');
    assert.equal(selectAgent(ws, agents, settings, 'a').agent.name, 'a');
    settings.set('chat.defaultAgent', 'b');
    assert.equal(selectAgent(ws, agents, settings).agent.name, 'b');
    let r = selectAgent(ws, agents, settings, 'zzz', { interactive: false });
    assert.equal(r.agent.name, 'b');
    assert.equal(r.missingRequested, 'zzz');
    assert.deepEqual(r.warnings.map((w) => w.message), ['Error: no agent with name zzz found. Falling back to user specified default']);
    settings.set('chat.defaultAgent', 'gone');
    r = selectAgent(ws, agents, settings, 'zzz');
    assert.equal(r.agent.name, 'kiro_default');
    assert.equal(r.missingDefault, 'gone');
    assert.deepEqual(r.warnings.map((w) => w.message), [
      'Error: no agent with name zzz found. Falling back to user specified default',
      'Error: user defined default gone not found. Falling back to in-memory default',
    ]);
    // a map without kiro_default still yields the built-in
    assert.equal(selectAgent(ws, new Map(), settings).agent.name, 'kiro_default');
  });

  it('create template follows Q key order (Kiro-adapted)', () => {
    const t = agentCreateTemplate('rev', { description: 'd', tools: ['read'] });
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
    assert.equal(t.$schema, AGENT_SCHEMA_URL);
    assert.equal(t.name, 'rev');
    assert.equal(t.prompt, null);
    assert.deepEqual(t.tools, ['read']);
    assert.deepEqual(agentCreateTemplate('x').tools, ['*']);
    // The template loads cleanly.
    fx = makeFixture();
    const r = parseAgent(JSON.stringify(agentCreateTemplate('x'), null, 2), { scope: 'global', format: 'json', ws: fx.ctx() });
    assert.deepEqual(r.warnings, []);
    assert.equal(r.agent!.name, 'x');
  });

  it('AGENT_SCHEMA has the V3 fields and the Q base', () => {
    const props = AGENT_SCHEMA.properties as Record<string, unknown>;
    for (const k of ['name', 'prompt', 'mcpServers', 'tools', 'toolAliases', 'allowedTools', 'resources', 'hooks', 'toolsSettings', 'useLegacyMcpJson', 'model']) {
      assert.ok(props[k], k);
    }
    for (const k of ['permissions', 'excludedTools', 'includeMcpJson', 'welcomeMessage']) assert.ok(props[k], k);
    assert.equal(AGENT_SCHEMA.additionalProperties, false);
    assert.doesNotThrow(() => JSON.stringify(AGENT_SCHEMA));
  });

  it('loadAgentFile reports a missing file', () => {
    fx = makeFixture();
    const r = loadAgentFile(path.join(fx.root, 'nope.json'), { scope: 'global', ws: fx.ctx() });
    assert.equal(r.agent, undefined);
    assert.match(r.warnings[0]!.message, /Agent config not found/);
    assert.equal(fs.existsSync(path.join(fx.root, 'nope.json')), false);
  });
});

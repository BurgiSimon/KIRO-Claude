/**
 * End-to-end use of the config loaders the way a session launch does: agent discovery and
 * selection, MCP resolution + Claude translation, resources, steering, skills, hooks and
 * permission scopes over one fixture tree.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  allHooksFor,
  buildSkillsPluginDir,
  claudeMcpNameMap,
  discoverSkills,
  expandFileRefs,
  findAgentsMd,
  loadAgents,
  loadPermissionScopes,
  loadSteering,
  loadSteeringPaths,
  openSettings,
  permissionsPaths,
  resolveMcpServers,
  resolveResources,
  selectAgent,
  steeringRefBase,
  toClaudeMcpConfig,
} from '../../src/config/index.js';
import { makeFixture, type Fixture } from './helpers.js';

function buildTree(fx: Fixture): void {
  // settings: global default agent, workspace override
  fx.write('home/.kiro/settings/cli.json', { 'chat.defaultAgent': 'kiro_planner', 'chat.defaultModel': 'claude-sonnet-4.6' });
  fx.write('proj/.kiro/settings/cli.json', { 'chat.defaultAgent': 'dev' });
  fx.write('home/.kiro/settings/kiro-claude.json', { 'kiroClaude.allowApiKey': false });
  // agents
  fx.write('proj/.kiro/agents/dev.json', {
    name: 'dev',
    description: 'Dev agent',
    prompt: 'file://prompts/dev.md',
    tools: ['read', 'write', 'shell', '@github'],
    includeMcpJson: true,
    mcpServers: { github: { command: 'gh-mcp', env: { TOKEN: '${GH_TOKEN}' } } },
    resources: ['file://docs/*.md', 'skill://backend-patterns'],
    permissions: { rules: [{ capability: 'shell', match: ['npm test'], effect: 'allow' }] },
    hooks: [{ name: 'fmt', trigger: 'PostFileSave', matcher: '\\.ts$', action: { type: 'command', command: 'prettier -w {{filePath}}' } }],
  });
  fx.write('proj/.kiro/agents/prompts/dev.md', 'You are the dev agent.\n');
  // mcp.json files
  fx.write('home/.kiro/settings/mcp.json', { mcpServers: { github: { command: 'global-gh' }, 'web search': { url: 'https://s.example/mcp', headers: { Authorization: 'Bearer ${env:API}' } } } });
  fx.write('proj/.kiro/settings/mcp.json', { mcpServers: { db: { command: 'db-mcp', disabled: true } } });
  // context
  fx.write('proj/docs/arch.md', 'Architecture');
  fx.write('proj/AGENTS.md', 'Root agents rules');
  fx.write('proj/.kiro/steering/tech.md', 'Use TS. See #[[file:docs/arch.md]]');
  fx.write('proj/.kiro/steering/react.md', '---\ninclusion: fileMatch\nfileMatchPattern: "*.tsx"\n---\nReact');
  fx.write('home/.kiro/steering/global.md', 'Global rule');
  // skills
  fx.write('proj/.kiro/skills/backend-patterns/SKILL.md', '---\nname: backend-patterns\ndescription: Backend patterns\n---\nUse $ARGUMENTS');
  fx.write('home/.kiro/skills/release/SKILL.md', '---\nname: release\ndescription: Release flow\n---\nRelease');
  // hooks files
  fx.write('home/.kiro/hooks/g.json', { version: 'v1', hooks: [{ name: 'global-stop', trigger: 'Stop', action: { type: 'command', command: 'notify' } }] });
  fx.write('proj/.kiro/hooks/lint.kiro.hook', { name: 'Lint', version: '1', when: { type: 'fileEdited', patterns: ['**/*.ts'] }, then: { type: 'askAgent', prompt: 'Lint it' } });
}

describe('config integration', () => {
  let fx: Fixture;
  afterEach(() => fx?.cleanup());

  it('launch pipeline over one fixture tree', () => {
    fx = makeFixture();
    buildTree(fx);
    const ws = fx.ctx(fx.mkdir('proj/src'), { GH_TOKEN: 'tok', API: 'k' });
    assert.equal(ws.workspaceRoot, fx.ws);
    const settings = openSettings(ws);
    assert.deepEqual(settings.warnings, []);

    // agents
    const { agents, warnings } = loadAgents(ws, { settings });
    assert.deepEqual(warnings, []);
    const sel = selectAgent(ws, agents, settings, undefined, { interactive: false });
    assert.equal(sel.agent.name, 'dev'); // workspace chat.defaultAgent beats global
    const dev = sel.agent;
    assert.equal(dev.dialect, 'v3');
    assert.equal(dev.prompt, 'You are the dev agent.\n');
    assert.equal(dev.inheritDefaultResources, true);
    const missing = selectAgent(ws, agents, settings, 'ghost', { interactive: false });
    assert.equal(missing.missingRequested, 'ghost');
    assert.equal(missing.agent.name, 'dev');

    // MCP: agent github beats global github; workspace db disabled but listed; env substituted
    const mcp = resolveMcpServers(ws, dev);
    assert.deepEqual(mcp.warnings, []);
    assert.deepEqual(
      mcp.servers.map((s) => [s.name, s.origin, s.disabled]),
      [
        ['github', 'agent', false],
        ['db', 'workspace', true],
        ['web search', 'global', false],
      ],
    );
    const cfg = toClaudeMcpConfig(mcp.servers);
    assert.deepEqual(cfg, {
      mcpServers: {
        github: { type: 'stdio', command: 'gh-mcp', args: [], env: { TOKEN: 'tok' } },
        web_search: { type: 'http', url: 'https://s.example/mcp', headers: { Authorization: 'Bearer k' } },
      },
    });
    assert.deepEqual(claudeMcpNameMap(mcp.servers), { github: 'github', web_search: 'web search' });

    // resources + steering + AGENTS.md
    const res = resolveResources(ws, dev);
    assert.deepEqual(res.files.map((f) => [f.pattern, f.paths.map((p) => path.relative(fx.ws, p))]), [['docs/*.md', ['docs/arch.md']]]);
    assert.deepEqual(res.skillUris, ['skill://backend-patterns', 'skill://.kiro/skills/*/SKILL.md', 'skill://~/.kiro/skills/*/SKILL.md']);
    const steering = loadSteering(ws);
    assert.deepEqual(steering.files.map((f) => [f.name, f.scope, f.inclusion]), [
      ['global', 'global', 'always'],
      ['react', 'workspace', 'fileMatch'],
      ['tech', 'workspace', 'always'],
    ]);
    const tech = steering.files.find((f) => f.name === 'tech')!;
    assert.equal(expandFileRefs(tech.body, steeringRefBase(ws, tech), ws), 'Use TS. See [docs/arch.md]\nArchitecture');
    assert.deepEqual(findAgentsMd(ws).map((p) => path.relative(fx.root, p)), ['proj/AGENTS.md']);

    // skills ⇒ plugin dir
    const skills = discoverSkills(ws, res.skillUris, { includeDefaults: dev.inheritDefaultResources });
    assert.deepEqual(skills.map((s) => [s.name, s.scope]), [['backend-patterns', 'workspace'], ['release', 'global']]);
    const pluginDir = buildSkillsPluginDir(skills, fx.mkdir('runtime'))!;
    assert.deepEqual(fs.readdirSync(path.join(pluginDir, 'skills')).sort(), ['backend-patterns', 'release']);

    // hooks: global file, agent, legacy
    assert.deepEqual(
      allHooksFor(ws, dev).map((h) => [h.name, h.source, h.trigger]),
      [
        ['global-stop', 'global-file', 'Stop'],
        ['fmt', 'agent', 'PostFileSave'],
        ['Lint', 'legacy-ide', 'PostFileSave'],
      ],
    );

    // permission scopes
    fx.write(permissionsPaths(ws).user, 'rules:\n  - capability: web_fetch\n    effect: ask\n');
    const scopes = loadPermissionScopes(ws);
    assert.deepEqual(scopes.user.map((r) => [r.capability, r.effect, r.scope]), [['web_fetch', 'ask', 'user']]);
    assert.deepEqual(dev.permissions.map((r) => [r.capability, r.effect, r.scope]), [['shell', 'allow', 'agent']]);
  });

  it('custom agent with inheritance disabled gets its own steering globs with inclusion semantics', () => {
    fx = makeFixture();
    buildTree(fx);
    fx.write('proj/.kiro/settings/cli.json', { 'chat.defaultAgent': 'dev', 'chat.disableInheritingDefaultResources': true });
    fx.write('proj/.kiro/agents/lean.json', { tools: ['read'], resources: ['file://.kiro/steering/**/*.md', 'file://AGENTS.md'] });
    const ws = fx.ctx();
    const settings = openSettings(ws);
    const lean = loadAgents(ws, { settings }).agents.get('lean')!;
    assert.equal(lean.inheritDefaultResources, false);
    const res = resolveResources(ws, lean);
    assert.deepEqual(res.skillUris, []);
    assert.deepEqual(res.files.map((f) => f.paths.map((p) => path.relative(fx.ws, p))), [[], ['AGENTS.md']]);
    const st = loadSteeringPaths(ws, res.steeringFiles);
    assert.deepEqual(st.files.map((f) => [f.name, f.inclusion]), [
      ['react', 'fileMatch'],
      ['tech', 'always'],
    ]);
    assert.deepEqual(discoverSkills(ws, res.skillUris, { includeDefaults: lean.inheritDefaultResources }), []);
    // built-ins always inherit
    assert.equal(loadAgents(ws, { settings }).agents.get('kiro_default')!.inheritDefaultResources, true);
  });
});

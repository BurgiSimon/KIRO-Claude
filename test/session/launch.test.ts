import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { makeCapabilities, type ClaudeCapabilities } from '../../src/claude/binary.js';
import { loadAgents } from '../../src/config/agents.js';
import { openSettings } from '../../src/config/settings.js';
import { buildInitializeHooks } from '../../src/policy/gate.js';
import {
  buildLaunch,
  CORE_ARGS,
  mandatoryMcpNames,
  mergeMcpServers,
  sanitizeExtraArgs,
  withSkillShellDisabled,
  subagentDefinition,
  type LaunchInput,
} from '../../src/session/launch.js';
import type { KiroAgent, McpServerConfig } from '../../src/types.js';
import { fakeBinary, fakeCaps, flagValue, mkSandbox, type Sandbox } from './helpers.js';

let caps: ClaudeCapabilities;
before(async () => {
  caps = await fakeCaps();
});

const SID = '0f8fad5b-d9cb-469f-a165-70867728950e';

function agentsOf(sb: Sandbox): Map<string, KiroAgent> {
  return loadAgents(sb.ws, { settings: openSettings(sb.ws) }).agents;
}

function launchFor(sb: Sandbox, name: string, over: Partial<LaunchInput> = {}): ReturnType<typeof buildLaunch> {
  const all = agentsOf(sb);
  const agent = all.get(name);
  assert.ok(agent, `agent ${name} loaded`);
  return buildLaunch({
    ws: sb.ws,
    settings: openSettings(sb.ws),
    agent,
    allAgents: all,
    binary: fakeBinary(),
    caps,
    claudeSessionId: SID,
    sessionContextGlobs: [],
    agentSpawnOutputs: [],
    contextWindowTokens: 200_000,
    runtimeDir: path.join(sb.root, 'rt'),
    ...over,
  });
}

function mcp(name: string, over: Partial<McpServerConfig> = {}): McpServerConfig {
  return { name, type: 'stdio', command: `${name}-cmd`, args: [], env: {}, headers: {}, disabled: false, autoApprove: [], disabledTools: [], origin: 'agent', ...over };
}

describe('launch: argv goldens', () => {
  it('V2 agent with toolsSettings: full argv in 00 §3.1 order', () => {
    const sb = mkSandbox();
    sb.agent('v2dev', {
      description: 'dev',
      prompt: 'Be careful.',
      tools: ['fs_read', 'execute_bash'],
      allowedTools: ['fs_read'],
      toolsSettings: { execute_bash: { allowedCommands: ['ls'] }, fs_read: { deniedPaths: ['/etc'] } },
      includeMcpJson: false,
    });
    const rt = path.join(sb.root, 'rt');
    const l = launchFor(sb, 'v2dev');
    assert.deepEqual(l.args, [
      ...CORE_ARGS,
      '--include-partial-messages',
      '--permission-mode', 'default',
      '--setting-sources', '',
      '--strict-mcp-config',
      '--tools', 'Read,Glob,Grep,Bash',
      '--append-system-prompt-file', path.join(rt, 'context.md'),
      '--system-prompt-snapshot', 'off',
      '--session-id', SID,
      '--settings', '{"disableSkillShellExecution":true}',
    ]);
    assert.equal(l.sessionId, SID);
    assert.deepEqual(l.initialize, { hooks: buildInitializeHooks(), skills: [] });
    assert.deepEqual(l.files, { systemPrompt: path.join(rt, 'context.md') });
    const sp = fs.readFileSync(l.files.systemPrompt, 'utf8');
    assert.match(sp, /Follow this instruction: Be careful\.\n$/);
    assert.equal(fs.statSync(l.files.systemPrompt).mode & 0o777, 0o600);
    assert.equal(fs.statSync(rt).mode & 0o777, 0o700);
    assert.equal(l.agentsMd.length, 0);
    assert.deepEqual(l.subagents, []);
  });

  it('V3 agent with permissions: same argv shape; tools wildcard + subagents', () => {
    const sb = mkSandbox();
    sb.agent('v3dev', { tools: ['read', 'write', 'shell'], permissions: { rules: [{ capability: 'shell', match: ['git *'], effect: 'allow' }] } });
    const l = launchFor(sb, 'v3dev');
    assert.equal(agentsOf(sb).get('v3dev')!.dialect, 'v3');
    assert.equal(flagValue(l.args, '--tools'), 'Read,Glob,Grep,Write,Edit,NotebookEdit,Bash');
    assert.equal(l.args.includes('--agents'), false);
  });

  it('tools: [] ⇒ --tools "" and no MCP config even with servers configured', () => {
    const sb = mkSandbox();
    sb.write(path.join(sb.kiroHome, 'settings', 'mcp.json'), JSON.stringify({ mcpServers: { g: { command: 'g' } } }));
    sb.agent('none', { tools: [], includeMcpJson: true, mcpServers: { a: { command: 'a' } } });
    const l = launchFor(sb, 'none');
    assert.equal(flagValue(l.args, '--tools'), '');
    assert.equal(l.args.includes('--mcp-config'), false);
    assert.equal(l.args.includes('--strict-mcp-config'), true);
    assert.equal(l.files.mcpConfig, undefined);
    assert.deepEqual(l.mcpServers, []);
    assert.deepEqual(l.toolSelection.claudeTools, []);
  });

  it('MCP: agent + mcp.json + client servers (client wins), disabled dropped, file 0600', () => {
    const sb = mkSandbox();
    sb.write(path.join(sb.kiroHome, 'settings', 'mcp.json'), JSON.stringify({ mcpServers: { g: { command: 'global-g' }, b: { command: 'global-b' } } }));
    sb.agent('mcpa', {
      tools: ['*'],
      includeMcpJson: true,
      mcpServers: { a: { command: 'agent-a', env: { X: '1' } }, b: { command: 'agent-b', disabled: true } },
    });
    const l = launchFor(sb, 'mcpa', { extraMcpServers: [mcp('a', { command: 'client-a', env: { TOKEN: 's3cret' } }), mcp('d', { type: 'http', command: undefined, url: 'http://x/mcp', headers: { H: 'v' } })] });
    const file = flagValue(l.args, '--mcp-config')!;
    assert.equal(file, path.join(sb.root, 'rt', 'mcp.json'));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8')) as { mcpServers: Record<string, Record<string, unknown>> };
    assert.deepEqual(Object.keys(cfg.mcpServers).sort(), ['a', 'd', 'g']);
    assert.deepEqual(cfg.mcpServers.a, { type: 'stdio', command: 'client-a', args: [], env: { TOKEN: 's3cret' } });
    assert.deepEqual(cfg.mcpServers.d, { type: 'http', url: 'http://x/mcp', headers: { H: 'v' } });
    assert.equal(cfg.mcpServers.g!.command, 'global-g');
    assert.deepEqual(l.mcpServers.map((s) => s.name).sort(), ['a', 'd', 'g']);
    assert.ok(l.allMcpServers.some((s) => s.name === 'b' && s.disabled));
    // --strict-mcp-config precedes --mcp-config
    assert.ok(l.args.indexOf('--strict-mcp-config') < l.args.indexOf('--mcp-config'));
  });

  it('includeMcpJson:false is honoured (KC-SPEC-01)', () => {
    const sb = mkSandbox();
    sb.write(path.join(sb.kiroHome, 'settings', 'mcp.json'), JSON.stringify({ mcpServers: { onlyjson: { command: 'x' } } }));
    sb.agent('crew', { tools: ['*'], includeMcpJson: false, mcpServers: { own: { command: 'own' } } });
    const l = launchFor(sb, 'crew');
    const cfg = JSON.parse(fs.readFileSync(l.files.mcpConfig!, 'utf8')) as { mcpServers: Record<string, unknown> };
    assert.deepEqual(Object.keys(cfg.mcpServers), ['own']);
  });

  it('@server selection, excludedTools and disabledTools ⇒ --disallowedTools; unselected servers omitted', () => {
    const sb = mkSandbox();
    sb.agent('sel', {
      tools: ['read', '@s1', '@s2/only'],
      excludedTools: ['@s1/bad'],
      mcpServers: { s1: { command: 's1', disabledTools: ['off'] }, s2: { command: 's2' }, s3: { command: 's3' } },
    });
    const l = launchFor(sb, 'sel');
    assert.equal(flagValue(l.args, '--tools'), 'Read,Glob,Grep');
    assert.deepEqual(l.mcpServers.map((s) => s.name), ['s1', 's2']);
    assert.equal(flagValue(l.args, '--disallowedTools'), 'mcp__s1__bad,mcp__s1__off');
    assert.deepEqual(l.toolSelection.partialMcp, { s2: ['only'] });
    assert.deepEqual(l.mcpNameMap, { s1: 's1', s2: 's2' });
  });

  it('server names are normalized for Claude and mapped back', () => {
    const sb = mkSandbox();
    sb.agent('names', { tools: ['@mcp'], mcpServers: { 'my.srv': { command: 'x' } } });
    const l = launchFor(sb, 'names');
    const cfg = JSON.parse(fs.readFileSync(l.files.mcpConfig!, 'utf8')) as { mcpServers: Record<string, unknown> };
    assert.deepEqual(Object.keys(cfg.mcpServers), ['my_srv']);
    assert.deepEqual(l.mcpNameMap, { my_srv: 'my.srv' });
  });

  it('ASBX_KIRO_MANDATORY_MCPS ⇒ alwaysLoad on the named servers (KC-ENV-03)', () => {
    const sb = mkSandbox({ env: { ASBX_KIRO_MANDATORY_MCPS: 'core, other' } });
    sb.agent('m', { tools: ['*'], mcpServers: { core: { command: 'c' }, side: { command: 's' } } });
    const l = launchFor(sb, 'm');
    const cfg = JSON.parse(fs.readFileSync(l.files.mcpConfig!, 'utf8')) as { mcpServers: Record<string, Record<string, unknown>> };
    assert.equal(cfg.mcpServers.core!.alwaysLoad, true);
    assert.equal(cfg.mcpServers.side!.alwaysLoad, undefined);
    assert.deepEqual(mandatoryMcpNames({ ASBX_KIRO_MANDATORY_MCPS: 'a,b c' }), ['a', 'b', 'c']);
    assert.deepEqual(mandatoryMcpNames({}), []);
  });

  it('skills ⇒ --plugin-dir <rt>/kiro, Skill tool, initialize.skills kiro:<n>', () => {
    const sb = mkSandbox();
    sb.write('.kiro/skills/backend-patterns/SKILL.md', '---\nname: backend-patterns\ndescription: d\n---\nBody');
    const l = launchFor(sb, 'kiro_default');
    const dir = flagValue(l.args, '--plugin-dir')!;
    assert.equal(dir, path.join(sb.root, 'rt', 'kiro'));
    assert.ok(fs.existsSync(path.join(dir, '.claude-plugin', 'plugin.json')));
    assert.ok(fs.existsSync(path.join(dir, 'skills', 'backend-patterns', 'SKILL.md')));
    assert.deepEqual(l.initialize.skills, ['kiro:backend-patterns']);
    assert.ok(flagValue(l.args, '--tools')!.split(',').includes('Skill'));
    assert.equal(l.skills[0]!.name, 'backend-patterns');
  });

  it('subagents: other Kiro agents allowed by tools ⇒ --agents <file> JSON', () => {
    const sb = mkSandbox();
    sb.agent('lead', { tools: ['read', 'subagent/reviewer', 'subagent/ghost'] });
    sb.agent('reviewer', { description: 'Reviews code', prompt: 'Review it.', tools: ['read'], model: 'claude-haiku-4.5' });
    sb.agent('writer', { tools: ['*'] });
    const l = launchFor(sb, 'lead');
    assert.equal(flagValue(l.args, '--tools'), 'Read,Glob,Grep,Agent');
    const file = flagValue(l.args, '--agents')!;
    assert.equal(file, path.join(sb.root, 'rt', 'agents.json'));
    const defs = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>>;
    assert.deepEqual(Object.keys(defs), ['reviewer']);
    assert.deepEqual(defs.reviewer, { description: 'Reviews code', prompt: 'Follow this instruction: Review it.', model: 'claude-haiku-4-5', tools: ['Read', 'Glob', 'Grep'] });
    assert.deepEqual(l.subagents, ['reviewer']);
    assert.ok(l.warnings.some((w) => /ghost/.test(w)));
  });

  it('tools ["*"] exposes every other agent; "*" subagents inherit tools; self excluded', () => {
    const sb = mkSandbox();
    sb.agent('boss', { tools: ['*'] });
    sb.agent('helper', { tools: ['*'], description: 'h' });
    const l = launchFor(sb, 'boss');
    const defs = JSON.parse(fs.readFileSync(flagValue(l.args, '--agents')!, 'utf8')) as Record<string, Record<string, unknown>>;
    assert.ok(defs.helper);
    assert.equal(defs.boss, undefined);
    assert.equal(defs.helper!.tools, undefined);
    assert.equal(defs.helper!.model, 'inherit');
    assert.ok(defs.kiro_default);
  });

  it('subagentDefinition carries the agent file:// resources as context entries', () => {
    const sb = mkSandbox();
    sb.write('docs/guide.md', 'GUIDE-TEXT');
    sb.agent('doc', { tools: ['read'], resources: ['file://docs/guide.md'] });
    const d = subagentDefinition(sb.ws, agentsOf(sb).get('doc')!, undefined);
    assert.match(d.prompt, /--- CONTEXT ENTRY BEGIN ---/);
    assert.match(d.prompt, /GUIDE-TEXT/);
    assert.match(d.prompt, /You are the Kiro agent "doc"\./);
    assert.equal(d.description, 'Kiro agent doc');
  });

  it('resume / fork / resume-session-at', () => {
    const sb = mkSandbox();
    sb.agent('r', { tools: ['read'] });
    const res = launchFor(sb, 'r', { resume: { claudeSessionId: 'aaa' } });
    assert.deepEqual(res.args.slice(-4, -2), ['--resume', 'aaa']);
    assert.equal(res.args.includes('--session-id'), false);
    assert.equal(res.sessionId, undefined);
    const fork = launchFor(sb, 'r', { resume: { claudeSessionId: 'aaa', fork: true, at: 'uuid-1' } });
    assert.deepEqual(fork.args.slice(-9, -2), ['--resume', 'aaa', '--fork-session', '--resume-session-at', 'uuid-1', '--session-id', SID]);
    assert.equal(fork.sessionId, SID);
  });

  it('model mapping, effort and KIRO_CLAUDE_FORCE_MODEL', () => {
    const sb = mkSandbox();
    sb.agent('m', { tools: ['read'] });
    const a = launchFor(sb, 'm', { model: 'claude-sonnet-4.6', effort: 'High' });
    assert.equal(flagValue(a.args, '--model'), 'claude-sonnet-4-6');
    assert.equal(flagValue(a.args, '--effort'), 'high');
    assert.deepEqual(a.model, { claudeValue: 'claude-sonnet-4-6', forced: false });
    assert.equal(a.effort, 'high');
    assert.equal(launchFor(sb, 'm', { model: 'auto' }).args.includes('--model'), false);
    const bad = launchFor(sb, 'm', { model: 'gpt-5', effort: 'ultra' });
    assert.equal(bad.args.includes('--model'), false);
    assert.equal(bad.args.includes('--effort'), false);
    assert.ok(bad.warnings.some((w) => /Model 'gpt-5' does not exist/.test(w)));
    assert.ok(bad.warnings.some((w) => /Unknown effort level 'ultra'/.test(w)));
    sb.refresh({ KIRO_CLAUDE_FORCE_MODEL: 'haiku' });
    const f = launchFor(sb, 'm', { model: 'claude-opus-5.5' });
    assert.equal(flagValue(f.args, '--model'), 'haiku');
    assert.deepEqual(f.model, { claudeValue: 'haiku', forced: true });
  });

  it('effort is dropped for models whose live entry does not support it', () => {
    const sb = mkSandbox();
    sb.agent('m', { tools: ['read'] });
    const liveModels = [
      { value: 'default', resolvedModel: 'claude-opus-5-5', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { value: 'claude-haiku-4-5-20251001', supportedEffortLevels: null },
      { value: 'claude-sonnet-4-6', supportedEffortLevels: ['low', 'medium', 'high', 'max'] },
    ];
    const none = launchFor(sb, 'm', { model: 'claude-haiku-4.5', effort: 'high', liveModels });
    assert.equal(flagValue(none.args, '--model'), 'claude-haiku-4-5-20251001');
    assert.equal(none.args.includes('--effort'), false);
    assert.ok(none.warnings.some((w) => /does not support effort levels/.test(w)));
    const noX = launchFor(sb, 'm', { model: 'claude-sonnet-4.6', effort: 'xhigh', liveModels });
    assert.equal(noX.args.includes('--effort'), false);
    assert.equal(flagValue(launchFor(sb, 'm', { model: 'claude-sonnet-4.6', effort: 'max', liveModels }).args, '--effort'), 'max');
    assert.equal(flagValue(launchFor(sb, 'm', { effort: 'xhigh', liveModels }).args, '--effort'), 'xhigh');
  });

  it('--add-dir per directory, setting sources and sanitized extraClaudeArgs', () => {
    const sb = mkSandbox();
    sb.agent('x', { tools: ['read'] });
    const s = openSettings(sb.ws);
    s.set('kiroClaude.claudeSettingSources', 'user');
    s.set('kiroClaude.extraClaudeArgs', ['--bare', '--debug-file', '/tmp/d', '--permission-mode', 'bypassPermissions', '--allowedTools=Bash']);
    const l = launchFor(sb, 'x', { additionalDirectories: ['/a', '/b'] });
    assert.equal(flagValue(l.args, '--setting-sources'), 'user');
    const i = l.args.indexOf('--add-dir');
    assert.deepEqual(l.args.slice(i, i + 4), ['--add-dir', '/a', '--add-dir', '/b']);
    assert.deepEqual(l.args.slice(-4), ['--debug-file', '/tmp/d', '--settings', '{"disableSkillShellExecution":true}']);
    assert.equal(l.args.includes('--bare'), false);
    assert.equal(l.args.filter((a) => a === '--permission-mode').length, 1);
    assert.equal(flagValue(l.args, '--permission-mode'), 'default');
    assert.ok(l.warnings.some((w) => /--bare is not allowed/.test(w)));
  });

  it('always passes --settings {disableSkillShellExecution:true} (skill !`cmd` blocks bypass the gate), merging a user --settings', () => {
    const sb = mkSandbox();
    sb.agent('g', { tools: ['*'] });
    const l = launchFor(sb, 'g');
    assert.equal(l.args.filter((a) => a === '--settings').length, 1);
    assert.deepEqual(JSON.parse(flagValue(l.args, '--settings')!), { disableSkillShellExecution: true });

    const w: string[] = [];
    const file = sb.write('my-settings.json', JSON.stringify({ cleanupPeriodDays: 3, disableSkillShellExecution: false }));
    const merged = withSkillShellDisabled(['--x', '--settings', '{"a":1}', '--settings=' + file, '--y'], true, sb.root, w);
    assert.deepEqual(merged.slice(0, 2), ['--x', '--y']);
    assert.deepEqual(merged.slice(2, 3), ['--settings']);
    assert.deepEqual(JSON.parse(merged[3]!), { a: 1, cleanupPeriodDays: 3, disableSkillShellExecution: true }, 'user values kept, safety wins');
    assert.deepEqual(w, []);
    const bad = withSkillShellDisabled(['--settings', 'missing.json'], true, sb.root, w);
    assert.deepEqual(JSON.parse(bad[1]!), { disableSkillShellExecution: true });
    assert.match(w[0]!, /--settings missing\.json could not be read/);
    assert.deepEqual(withSkillShellDisabled(['--settings', '{"a":1}'], false, sb.root, []), ['--settings', '{"a":1}'], 'unsupported: untouched');
  });

  it('sanitizeExtraArgs accepts a string (shlex) and drops forbidden flags with their values', () => {
    const w: string[] = [];
    assert.deepEqual(sanitizeExtraArgs('--x "a b" --allowedTools Bash --y', w), ['--x', 'a b', '--y']);
    assert.equal(w.length, 1);
    assert.deepEqual(sanitizeExtraArgs(undefined, w), []);
  });

  it('capability gating: an old CLI without optional flags gets only core flags', () => {
    const sb = mkSandbox();
    sb.write('.kiro/skills/s/SKILL.md', 'S');
    sb.agent('g', { tools: ['*'] });
    const old = makeCapabilities('2.0.0', ['--print', '--input-format', '--output-format', '--verbose', '--permission-mode', '--model', '--resume', '--session-id']);
    const l = launchFor(sb, 'g', { caps: old, effort: 'high', additionalDirectories: ['/x'], resume: { claudeSessionId: 'z', fork: true, at: 'u' } });
    for (const f of ['--include-partial-messages', '--setting-sources', '--strict-mcp-config', '--tools', '--append-system-prompt-file', '--system-prompt-snapshot', '--effort', '--agents', '--plugin-dir', '--add-dir', '--resume-session-at']) {
      assert.equal(l.args.includes(f), false, f);
    }
    assert.ok(l.args.includes('--fork-session'));
    assert.ok(l.warnings.some((w) => /--tools/.test(w)));
    assert.ok(l.warnings.some((w) => /--resume-session-at/.test(w)));
  });

  it('system prompt: steering (always inlined), conditional index, AGENTS.md, hook outputs, session context', () => {
    const sb = mkSandbox();
    sb.write('.kiro/steering/style.md', 'STEERING-MARKER');
    sb.write('.kiro/steering/api.md', '---\ninclusion: fileMatch\nfileMatchPattern: "src/api/**"\n---\nAPI rules');
    sb.write('AGENTS.md', 'AGENTS-MARKER');
    sb.write('notes/n1.txt', 'SESSION-CONTEXT-MARKER');
    const l = launchFor(sb, 'kiro_default', { agentSpawnOutputs: ['HOOK-OUTPUT'], sessionContextGlobs: ['notes/*.txt'] });
    const text = fs.readFileSync(l.files.systemPrompt, 'utf8');
    for (const m of ['STEERING-MARKER', 'AGENTS-MARKER', 'HOOK-OUTPUT', 'SESSION-CONTEXT-MARKER', 'for the entire conversation']) assert.ok(text.includes(m), m);
    assert.equal(text.includes('API rules'), false);
    assert.equal(l.conditionalSteering.length, 1);
    assert.equal(l.conditionalSteering[0]!.name, 'api');
    assert.deepEqual(l.sessionContext, [{ pattern: 'notes/*.txt', paths: [path.join(sb.cwd, 'notes', 'n1.txt')] }]);
  });

  it('files from a previous launch are removed when no longer needed', () => {
    const sb = mkSandbox();
    sb.agent('with', { tools: ['*'], mcpServers: { a: { command: 'a' } } });
    sb.agent('without', { tools: ['read'] });
    const a = launchFor(sb, 'with');
    assert.ok(fs.existsSync(a.files.mcpConfig!));
    assert.ok(fs.existsSync(a.files.agents!));
    launchFor(sb, 'without');
    assert.equal(fs.existsSync(a.files.mcpConfig!), false);
    assert.equal(fs.existsSync(a.files.agents!), false);
  });
});

describe('launch: helpers', () => {
  it('mergeMcpServers: client entries replace configured ones by name', () => {
    const merged = mergeMcpServers([mcp('a'), mcp('b')], [mcp('b', { command: 'client' }), mcp('c')]);
    assert.deepEqual(merged.map((s) => `${s.name}:${s.command}`), ['a:a-cmd', 'b:client', 'c:c-cmd']);
  });
});

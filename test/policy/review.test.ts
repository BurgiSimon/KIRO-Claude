/**
 * Adversarial review tests for the policy module: boundary conditions, regressions for bugs
 * found in review (Rust `.` semantics, Glob roots under bracketed workspaces, malformed MCP
 * names, prototype-key server names, quoted-assignment deny bypass, substitution bypass of
 * conditional deny rules under trust-all, built-in subagents inheriting the parent's tool
 * selection), plus empty/missing inputs, unicode paths and ordering.
 */
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CanUseToolRequest, HookInput } from '../../src/claude/protocol.js';
import type { ApprovalResponse, KiroAgent, PermissionRule, WorkspaceContext } from '../../src/types.js';
import { anchoredRustRegex, compileRustRegex, translateRustRegex } from '../../src/policy/rustregex.js';
import { evalExecuteBash, evaluateQ } from '../../src/policy/qengine.js';
import { SHELL_PARSE_DENY, evaluateCap, type CapScopes } from '../../src/policy/capengine.js';
import { checkInvariants } from '../../src/policy/invariants.js';
import { requiresAcceptance } from '../../src/policy/readonly.js';
import {
  BUILTIN_CLAUDE_TOOLS,
  NEVER_EXPOSE_TOOLS,
  expandToolSelectors,
  globPatternRoot,
  isMcpToolSelected,
  normalizeV2Name,
  toKiroCall,
  toolDisplay,
  v3IdForMcp,
} from '../../src/policy/toolmap.js';
import { Gate, NON_INTERACTIVE_DENY, PLAN_MODE_DENY, hookBlockedMessage, type GateDeps } from '../../src/policy/gate.js';
import { FakeHooks, emptyTrust, makeAgent, makeWs, type TempWs } from './helpers.js';

const scopes = (p: Partial<CapScopes> = {}): CapScopes => ({
  agentRules: [],
  userRules: [],
  workspaceRules: [],
  presetRules: [],
  sessionRules: [],
  trustAll: false,
  ...p,
});

// ───────────────────────────── Rust regex ─────────────────────────────

describe('review: Rust regex `.` and code points', () => {
  const m = (p: string, s: string): boolean | null => {
    const re = anchoredRustRegex(p);
    return re === null ? null : re.test(s);
  };
  it('Rust `.` matches \\r, U+2028, U+2029 (JS `.` does not)', () => {
    assert.equal(m('git .*', 'git status\rrm -rf /'), true);
    assert.equal(m('rm .*', 'rm  x'), true);
    assert.equal(m('rm .*', 'rm  x'), true);
  });
  it('`.` still excludes \\n unless (?s)', () => {
    assert.equal(m('a.b', 'a\nb'), false);
    assert.equal(m('(?s)a.b', 'a\nb'), true);
    assert.equal(m('a(?s:.)b', 'a\nb'), true, 'scoped flag approximated globally');
  });
  it('`.` and negated classes match one code point (astral characters)', () => {
    assert.equal(m('rm .', 'rm 😀'), true);
    assert.equal(m('rm [^a]', 'rm 😀'), true);
    assert.equal(m('rm ..', 'rm 😀'), false);
  });
  it('a dot in a class or escaped stays literal', () => {
    assert.equal(m('a[.]b', 'axb'), false);
    assert.equal(m('a[.]b', 'a.b'), true);
    assert.equal(m('a\\.b', 'a\rb'), false);
  });
  it('translation output', () => {
    assert.deepEqual(translateRustRegex('a.b'), { source: 'a[^\\n]b', flags: '' });
    assert.deepEqual(translateRustRegex('(?s)a.b'), { source: 'a[\\s\\S]b', flags: 's' });
  });
  it('unicode-mode compilation keeps previously valid patterns valid', () => {
    for (const p of ['git .*', 'a{2,3}', '[[:punct:]]+', '[a\\-z]', 'x\\]y', '[]a]', '\\x41', 'a\\/b', '[\\[\\]]', 'npm (run|test)']) {
      assert.notEqual(compileRustRegex(p), null, p);
    }
  });
  it('deny `git .*` is not bypassed by a carriage return even when execute_bash is trusted', () => {
    const s = { deniedCommands: ['git .*'] };
    assert.deepEqual(evalExecuteBash('git status\rrm -rf /', ['execute_bash'], s), { kind: 'deny', reasons: ['\\Agit .*\\z'] });
  });
  it('empty deny pattern only matches the empty command', () => {
    assert.equal(evalExecuteBash('ls', ['execute_bash'], { deniedCommands: [''] }).kind, 'allow');
    assert.equal(evalExecuteBash('', [], { deniedCommands: [''] }).kind, 'deny');
  });
});

// ───────────────────────────── toolmap ─────────────────────────────

describe('review: globPatternRoot treats only the pattern as glob syntax', () => {
  const v: Array<[string, string, string | undefined]> = [
    ['**/*', '/w/proj [old]', undefined],
    ['*.ts', '/w/proj {x}', undefined],
    ['src/*', '/w/proj [old]', '/w/proj [old]/src'],
    ['../x/*', '/w/p*j', '/w/x'],
    ['/*', '/w', '/'],
    ['/', '/w', '/'],
    ['./**', '/w', undefined],
    ['a/b/c.txt', '/w', '/w/a/b'],
    ['./', '/w', undefined],
    ['sub/', '/w', '/w/sub'],
    ['../', '/w/p', '/w'],
  ];
  for (const [pat, root, exp] of v) it(`${pat} in ${root} → ${exp}`, () => assert.equal(globPatternRoot(pat, root), exp));
  it('Glob in a bracketed cwd has just the cwd as subject', () => {
    const c = toKiroCall('Glob', { pattern: '**/*.ts' }, { cwd: '/w/proj [old]' });
    assert.deepEqual(c.subjects, ['/w/proj [old]']);
  });
});

describe('review: toKiroCall robustness', () => {
  it('every mapped tool tolerates an empty input', () => {
    for (const t of [...BUILTIN_CLAUDE_TOOLS, 'Skill', 'Task', 'MultiEdit', 'TaskStop', 'TodoWrite', 'mcp__git__x', 'Unknown', '']) {
      const c = toKiroCall(t, {}, { cwd: '/w' });
      assert.equal(typeof c.v2Name, 'string', t);
      assert.ok(Array.isArray(c.subjects), t);
      assert.ok(c.tags.length > 0, t);
    }
  });
  it('non-string fields are treated as missing', () => {
    assert.deepEqual(toKiroCall('Read', { file_path: 42 }, { cwd: '/w' }).subjects, ['/w']);
    assert.deepEqual(toKiroCall('Bash', { command: ['rm'] }, { cwd: '/w' }).subjects, ['']);
    assert.deepEqual(toKiroCall('Agent', { subagent_type: 7 }, { cwd: '/w' }).subjects, ['general-purpose']);
    assert.deepEqual(toKiroCall('Glob', { path: null, pattern: 1 }, { cwd: '/w' }).subjects, ['/w']);
  });
  it('MCP server names that are Object.prototype keys stay literal', () => {
    for (const n of ['constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      const c = toKiroCall(`mcp__${n}__tool`, {}, { cwd: '/w', mcpServerNames: {} });
      assert.deepEqual(c.mcp, { server: n, tool: 'tool' }, n);
      assert.equal(c.v2Name, `@${n}/tool`);
    }
  });
  it('a non-string mapping value falls back to the Claude server name', () => {
    const names = { git: 5 } as unknown as Record<string, string>;
    assert.deepEqual(toKiroCall('mcp__git__x', {}, { cwd: '/w', mcpServerNames: names }).mcp, { server: 'git', tool: 'x' });
  });
  it('malformed MCP names are mutating MCP calls: asked by both engines, denied in plan mode', async () => {
    const tw = makeWs();
    try {
      const c = toKiroCall('mcp__srvonly', {}, { cwd: tw.ws.cwd });
      assert.equal(evaluateQ(c, makeAgent(), emptyTrust(), tw.ws).kind, 'ask');
      assert.equal(evaluateCap(c, scopes(), tw.ws).kind, 'ask');
      assert.equal(evaluateCap(c, scopes({ agentRules: [{ capability: 'builtin', effect: 'allow' }] }), tw.ws).kind, 'ask');
      assert.equal(evaluateCap(c, scopes({ trustAll: true }), tw.ws).kind, 'allow');
    } finally {
      tw.cleanup();
    }
  });
  it('unicode paths and commands survive unchanged', () => {
    const c = toKiroCall('Write', { file_path: '/w/café/naïve 😀.txt' }, { cwd: '/w' });
    assert.deepEqual(c.subjects, ['/w/café/naïve 😀.txt']);
    assert.deepEqual(toKiroCall('Bash', { command: 'echo "héllo" && ls café' }, { cwd: '/w' }).subjects, ['echo "héllo"', 'ls café']);
  });
  it('v3IdForMcp: unicode is dropped, length capped at 64', () => {
    assert.equal(v3IdForMcp('Café-Srv', 'Get Ünïcode'), 'mcp_caf_srv_get_ncode');
    assert.equal(v3IdForMcp('s'.repeat(80), 't').length, 64);
  });
  it('toolDisplay puts (trusted) before the MCP server part (Classic order)', () => {
    const m = toKiroCall('mcp__git__status', {}, { cwd: '/w' });
    assert.equal(toolDisplay(m), 'status from mcp server git');
    assert.equal(toolDisplay(m, true), 'status (trusted) from mcp server git');
    const r = toKiroCall('Read', { file_path: '/w/a' }, { cwd: '/w' });
    assert.equal(toolDisplay(r), 'read');
    assert.equal(toolDisplay(r, true), 'read (trusted)');
  });
  it('normalizeV2Name leaves prototype keys alone', () => {
    for (const n of ['constructor', '__proto__', 'toString']) assert.equal(normalizeV2Name(n), n);
  });
});

describe('review: selector expansion edge cases', () => {
  const servers = [
    { name: 'git', claudeName: 'git', disabledTools: ['danger zone'] },
    { name: 'my.srv', claudeName: 'my_srv', disabledTools: [] },
  ];
  const ex = (tools: string[], excludedTools: string[] = [], skillsLoaded = false) =>
    expandToolSelectors({ tools, excludedTools, skillsLoaded, mcpServers: servers, agentNames: ['a', 'b'] });
  it('never exposes Claude-only tools, even when named', () => {
    const r = ex(['AskUserQuestion', 'ExitPlanMode', 'ToolSearch', '*']);
    for (const t of NEVER_EXPOSE_TOOLS) assert.ok(!r.claudeTools.includes(t), t);
    assert.ok(r.warnings.some((w) => w.includes('AskUserQuestion')));
  });
  it('whitespace and duplicates are tolerated', () => {
    const r = ex([' read ', 'read', 'fs_read', '']);
    assert.deepEqual(r.claudeTools, ['Read', 'Glob', 'Grep']);
    assert.deepEqual(r.warnings, []);
  });
  it('excludedTools `*` removes everything', () => {
    const r = ex(['*'], ['*']);
    assert.deepEqual(r.claudeTools, []);
    assert.deepEqual(r.mcpServers, []);
    assert.deepEqual(r.subagents, []);
  });
  it('disabledTools names are Claude-normalized for --disallowedTools', () => {
    assert.deepEqual(ex(['@git']).disallowedTools, ['mcp__git__danger_zone']);
  });
  it('a configured server is matched by its Claude-normalized name too', () => {
    assert.deepEqual(ex(['@my_srv']).mcpServers, ['my.srv']);
  });
  it('subagent/* selects all agents; excluding one keeps the rest', () => {
    assert.equal(ex(['subagent/*']).subagents, 'all');
    assert.deepEqual(ex(['subagent'], ['subagent/a']).subagents, ['b']);
  });
  it('isMcpToolSelected honors exclusion globs and partial selection', () => {
    assert.equal(isMcpToolSelected(['@git/st*'], [], 'git', 'status'), true);
    assert.equal(isMcpToolSelected(['@git/st*'], [], 'git', 'push'), false);
    assert.equal(isMcpToolSelected(['*'], ['@git/pu*'], 'git', 'push'), false);
    assert.equal(isMcpToolSelected(['@mcp'], ['@git'], 'git', 'status'), false);
  });
});

// ───────────────────────────── capability engine ─────────────────────────────

describe('review: capability engine vs hidden commands', () => {
  const ws: WorkspaceContext = { cwd: '/w', workspaceRoot: '/w', kiroHome: '/h/.kiro', home: '/h', env: { HOME: '/h' } };
  const bash = (command: string) => toKiroCall('Bash', { command }, { cwd: '/w' });
  const denyRm: PermissionRule = { capability: 'shell', match: ['rm *'], effect: 'deny' };
  it('trust-all + conditional deny rule: unparseable command ⇒ parse denial', () => {
    assert.deepEqual(evaluateCap(bash('echo $(rm -rf /)'), scopes({ agentRules: [denyRm], trustAll: true }), ws), {
      kind: 'deny',
      reasons: [SHELL_PARSE_DENY],
    });
    assert.equal(evaluateCap(bash('echo `rm -rf /`'), scopes({ agentRules: [denyRm], trustAll: true }), ws).kind, 'deny');
  });
  it('trust-all + conditional ask rule: unparseable command ⇒ ask', () => {
    const r = evaluateCap(bash('echo $(npm publish)'), scopes({ agentRules: [{ capability: 'shell', match: ['npm publish*'], effect: 'ask' }], trustAll: true }), ws);
    assert.equal(r.kind, 'ask');
    assert.ok(r.reasons.includes(SHELL_PARSE_DENY));
  });
  it('trust-all without conditional rules: unparseable command allowed; unconditional deny still wins', () => {
    assert.equal(evaluateCap(bash('echo "$(date)"'), scopes({ trustAll: true }), ws).kind, 'allow');
    assert.equal(evaluateCap(bash('echo "$(date)"'), scopes({ trustAll: true, userRules: [{ capability: 'shell', effect: 'deny' }] }), ws).kind, 'deny');
    assert.deepEqual(evaluateCap(bash('echo "$(date)"'), scopes(), ws), { kind: 'deny', reasons: [SHELL_PARSE_DENY] });
  });
  it('conditional deny rules for OTHER capabilities do not block unparseable shell', () => {
    const r = evaluateCap(bash('echo "$(date)"'), scopes({ trustAll: true, agentRules: [{ capability: 'fs_write', match: ['/etc/**'], effect: 'deny' }] }), ws);
    assert.equal(r.kind, 'allow');
  });
  it('leading assignments cannot hide a denied command (quoted values too)', () => {
    for (const c of ['X=1 rm -rf /', 'X="a b" rm -rf /', "X='a b' Y=2 rm -rf /", 'A= rm x']) {
      assert.equal(evaluateCap(bash(c), scopes({ agentRules: [denyRm], trustAll: true }), ws).kind, 'deny', c);
    }
  });
  it('allow rules do not see through assignments (they could change what runs)', () => {
    const allowGit: PermissionRule = { capability: 'shell', match: ['git status*'], effect: 'allow' };
    assert.equal(evaluateCap(bash('GIT_DIR="a b" git status'), scopes({ agentRules: [allowGit] }), ws).kind, 'ask');
  });
  it('a command that is only assignments is not stripped to nothing', () => {
    assert.equal(evaluateCap(bash('X=1'), scopes({ agentRules: [denyRm] }), ws).kind, 'ask');
  });
  it('default policy: write-ish variants of read-only commands ask', () => {
    for (const c of ['date -s 2020-01-01', 'hostname evil', 'which', 'git branch -vD main', 'git log --output=x', 'git diff > p', 'GIT_PAGER=sh git log', 'git -c core.pager=sh log']) {
      assert.equal(evaluateCap(bash(c), scopes(), ws).kind, 'ask', c);
    }
    for (const c of ['git status', 'git log --oneline -5', 'pwd && whoami', 'git status &', '(git status)', 'which git']) {
      assert.equal(evaluateCap(bash(c), scopes(), ws).kind, 'allow', c);
    }
  });
  it('malformed rules are ignored, not fatal', () => {
    const bad = [null, 1, 'x', { capability: 'shell' }, { capability: 'shell', effect: 'maybe' }, { capability: 1, effect: 'allow' }, { capability: 'shell', match: 'git *', effect: 'deny' }, { capability: 'shell', match: [1], effect: 'deny' }];
    const r = evaluateCap(bash('git status'), scopes({ userRules: bad as unknown as PermissionRule[] }), ws);
    assert.equal(r.kind, 'allow', 'falls back to the default policy');
  });
  it('configured rules replace the default policy for a subject they match', () => {
    assert.equal(evaluateCap(bash('git status'), scopes({ userRules: [{ capability: 'shell', match: ['git *'], effect: 'ask' }] }), ws).kind, 'ask');
  });
  it('`builtin` does not cover MCP; `all` does', () => {
    const mcp = toKiroCall('mcp__git__push', {}, { cwd: '/w' });
    assert.equal(evaluateCap(mcp, scopes({ agentRules: [{ capability: 'builtin', effect: 'allow' }] }), ws).kind, 'ask');
    assert.equal(evaluateCap(mcp, scopes({ agentRules: [{ capability: 'all', effect: 'allow' }] }), ws).kind, 'allow');
  });
  it('utility tools are allowed even under an all-deny rule', () => {
    assert.equal(evaluateCap(toKiroCall('TaskCreate', { subject: 'x' }, { cwd: '/w' }), scopes({ agentRules: [{ capability: 'all', effect: 'deny' }] }), ws).kind, 'allow');
  });
});

describe('review: path engines in a workspace whose path has glob metacharacters', () => {
  let tw: TempWs;
  let ws: WorkspaceContext;
  let root: string;
  before(() => {
    tw = makeWs({ cwdSub: 'x' });
    // move the workspace under a bracketed / braced directory name
    root = path.join(tw.home, 'proj [old] {v2}');
    fs.mkdirSync(path.join(root, '.kiro'), { recursive: true });
    fs.mkdirSync(path.join(root, 'café'), { recursive: true });
    fs.writeFileSync(path.join(root, 'café', 'naïve.txt'), 'x');
    ws = { ...tw.ws, cwd: root, workspaceRoot: root };
  });
  after(() => tw.cleanup());

  it('V3 default `./**` covers Read, Glob and Grep in the workspace', () => {
    for (const c of [
      toKiroCall('Read', { file_path: path.join(root, 'café', 'naïve.txt') }, { cwd: root }),
      toKiroCall('Glob', { pattern: '**/*.txt' }, { cwd: root }),
      toKiroCall('Glob', { pattern: 'café/*' }, { cwd: root }),
      toKiroCall('Grep', { pattern: 'x' }, { cwd: root }),
    ]) {
      assert.equal(evaluateCap(c, scopes(), ws).kind, 'allow', `${c.claudeName} ${c.subjects.join(',')}`);
    }
  });
  it('V2 cwd auto-allow covers Read, Glob and Grep in the workspace', () => {
    for (const c of [
      toKiroCall('Read', { file_path: path.join(root, 'café', 'naïve.txt') }, { cwd: root }),
      toKiroCall('Glob', { pattern: '**/*.txt' }, { cwd: root }),
      toKiroCall('Grep', { pattern: 'x', path: path.join(root, 'café') }, { cwd: root }),
    ]) {
      assert.equal(evaluateQ(c, makeAgent(), emptyTrust(), ws).kind, 'allow', c.claudeName);
    }
  });
  it('relative deny rules with unicode names apply', () => {
    const c = toKiroCall('Read', { file_path: path.join(root, 'café', 'naïve.txt') }, { cwd: root });
    assert.equal(evaluateCap(c, scopes({ agentRules: [{ capability: 'fs_read', match: ['café'], effect: 'deny' }] }), ws).kind, 'deny');
    const agent = makeAgent({ toolsSettings: { fs_read: { deniedPaths: ['café/*.txt'] } } });
    assert.deepEqual(evaluateQ(c, agent, emptyTrust(), ws), { kind: 'deny', reasons: ['café/*.txt'] });
  });
  it('Glob escaping the workspace still asks', () => {
    const c = toKiroCall('Glob', { pattern: '../**' }, { cwd: root });
    assert.equal(evaluateCap(c, scopes(), ws).kind, 'ask');
    assert.equal(evaluateQ(c, makeAgent(), emptyTrust(), ws).kind, 'ask');
  });
});

// ───────────────────────────── invariants ─────────────────────────────

describe('review: invariants edge cases', () => {
  let tw: TempWs;
  before(() => {
    tw = makeWs();
    fs.mkdirSync(path.join(tw.home, '.kiro', 'settings'), { recursive: true });
    fs.symlinkSync(path.join(tw.home, '.kiro', 'settings'), path.join(tw.root, 'innocent'));
  });
  after(() => tw.cleanup());
  const w = (p: string, tool = 'Write') =>
    toKiroCall(tool, tool === 'NotebookEdit' ? { notebook_path: p } : { file_path: p }, { cwd: tw.root });

  it('a symlink into ~/.kiro/settings is denied', () => {
    assert.equal(checkInvariants(w(path.join(tw.root, 'innocent', 'cli.json')), tw.ws)?.effect, 'deny');
  });
  it('custom KIRO_HOME roots are protected too', () => {
    const custom = makeWs({ kiroHome: path.join(tw.home, 'custom-kiro') });
    try {
      const ws = custom.ws;
      const mk = (p: string) => toKiroCall('Edit', { file_path: p }, { cwd: custom.root });
      assert.equal(checkInvariants(mk(path.join(ws.kiroHome, 'settings', 'cli.json')), ws)?.effect, 'deny');
      assert.equal(checkInvariants(mk(path.join(ws.kiroHome, 'workspace-roots', 'abc', 'permissions.yaml')), ws)?.effect, 'deny');
      assert.equal(checkInvariants(mk(path.join(ws.kiroHome, 'agents', 'a.json')), ws)?.effect, 'ask');
      assert.equal(checkInvariants(mk(path.join(ws.home, '.kiro', 'settings', 'x')), ws)?.effect, 'deny');
    } finally {
      custom.cleanup();
    }
  });
  it('NotebookEdit and Edit are writes; Read of .kiroignore is not denied', () => {
    assert.equal(checkInvariants(w(path.join(tw.root, 'sub', '.kiroignore'), 'Edit'), tw.ws)?.effect, 'deny');
    assert.equal(checkInvariants(w(path.join(tw.root, '.vscode', 'n.ipynb'), 'NotebookEdit'), tw.ws)?.effect, 'ask');
    const r = toKiroCall('Read', { file_path: path.join(tw.root, '.kiroignore') }, { cwd: tw.root });
    assert.equal(checkInvariants(r, tw.ws), undefined);
  });
  it('look-alike names are not protected dirs', () => {
    for (const p of ['.gitignore', '.github/workflows/ci.yml', '.kiro/steering/x.md', '.kiro/specs/f/design.md', 'kiro/settings/x', 'my.kiroignore.bak']) {
      assert.equal(checkInvariants(w(path.join(tw.root, p)), tw.ws), undefined, p);
    }
  });
  it('a nested installed power file other than its top-level mcp.json asks (powers dir), not denies', () => {
    const p = path.join(tw.home, '.kiro', 'powers', 'installed', 'p', 'sub', 'mcp.json');
    assert.equal(checkInvariants(w(p), tw.ws)?.effect, 'ask');
  });
  it('a throwing isIgnored does not crash and does not deny', () => {
    const r = toKiroCall('Read', { file_path: path.join(tw.root, 'a') }, { cwd: tw.root });
    assert.equal(
      checkInvariants(r, tw.ws, {
        isIgnored: () => {
          throw new Error('boom');
        },
      }),
      undefined,
    );
  });
  it('non-file capabilities are untouched', () => {
    assert.equal(checkInvariants(toKiroCall('Bash', { command: 'rm -rf ~/.kiro/settings' }, { cwd: tw.root }), tw.ws), undefined);
  });
});

describe('review: readonly corner cases', () => {
  it('unicode and odd whitespace', () => {
    assert.equal(requiresAcceptance('ls café', undefined, true), false);
    assert.equal(requiresAcceptance('ls -la', undefined, true), true, 'NBSP is not a separator: `ls\\u00a0-la` is one word');
    assert.equal(requiresAcceptance('\tls\t-la\t', undefined, true), false);
  });
  it('allowedCommands see the original (not normalized) command', () => {
    assert.equal(requiresAcceptance('npm  test', ['npm test'], false), true);
    assert.equal(requiresAcceptance("npm 'test'", ['npm test'], false), true);
  });
});

// ───────────────────────────── gate ─────────────────────────────

interface G {
  tw: TempWs;
  gate: Gate;
  hooks: FakeHooks;
  deps: GateDeps;
  state: { agent: KiroAgent; agents: Record<string, KiroAgent>; plan: boolean; spec?: { name: string; allowedWritePaths: string[] } };
}

function harness(p: { agent?: Partial<KiroAgent>; interactive?: boolean; agents?: KiroAgent[]; names?: Record<string, string> } = {}): G {
  const tw = makeWs();
  const hooks = new FakeHooks();
  const state: G['state'] = {
    agent: makeAgent({ name: 'main', ...p.agent }),
    agents: Object.fromEntries((p.agents ?? []).map((a) => [a.name, a])),
    plan: false,
  };
  const deps: GateDeps = {
    ws: tw.ws,
    sessionId: () => 's',
    agent: () => state.agent,
    resolveAgent: (n) => (Object.prototype.hasOwnProperty.call(state.agents, n) ? state.agents[n] : undefined),
    hooks: () => hooks,
    trust: emptyTrust(),
    interactive: p.interactive ?? true,
    v3Scopes: () => ({ userRules: [], workspaceRules: [], presetRules: [] }),
    mcpServerNames: () => p.names ?? { git: 'git' },
    mcpAutoApprove: () => [],
    planMode: () => state.plan,
    specPhase: () => state.spec,
    notify: () => {},
  };
  return { tw, gate: new Gate(deps), hooks, deps, state };
}

let seq = 0;
const pre = (tool_name: string, tool_input: Record<string, unknown>, extra: Partial<HookInput> = {}): HookInput => ({
  hook_event_name: 'PreToolUse',
  tool_name,
  tool_input,
  tool_use_id: `toolu_r${++seq}`,
  ...extra,
});

describe('review: gate', () => {
  let h: G;
  beforeEach(() => {
    h = harness();
  });
  afterEach(() => h.tw.cleanup());
  const decide = async (name: string, input: Record<string, unknown>, extra: Partial<HookInput> = {}) =>
    (await h.gate.preToolUse({ cwd: h.tw.ws.cwd, ...pre(name, input, extra) })).decision;

  it('a Claude built-in subagent inherits the parent tool selection (partial MCP)', async () => {
    h.state.agent = makeAgent({ name: 'main', tools: ['read', '@git/status', 'subagent'], allowedTools: ['@git'] });
    h.state.agents.kid = makeAgent({ name: 'kid', tools: ['@git'], allowedTools: ['@git'] });
    assert.equal((await decide('mcp__git__push', {})).kind, 'deny');
    const gp = await decide('mcp__git__push', {}, { agent_type: 'general-purpose', agent_id: 'a1' });
    assert.equal(gp.kind, 'deny');
    assert.match((gp as { reason: string }).reason, /not enabled for agent main/);
    assert.equal((await decide('mcp__git__status', {}, { agent_type: 'general-purpose', agent_id: 'a1' })).kind, 'allow');
    // a resolved Kiro child agent uses its own selection
    assert.equal((await decide('mcp__git__push', {}, { agent_type: 'kid', agent_id: 'a2' })).kind, 'allow');
  });
  it('agent types named like Object.prototype keys do not resolve to garbage', async () => {
    assert.equal((await decide('Read', { file_path: path.join(h.tw.root, 'a') }, { agent_type: 'constructor' })).kind, 'allow');
  });
  it('plan mode: every mutating capability denied, reads and utilities allowed, even under trust-all', async () => {
    h.state.plan = true;
    h.deps.trust.trustAll = true;
    for (const [n, i] of [
      ['Write', { file_path: path.join(h.tw.root, 'a') }],
      ['Edit', { file_path: path.join(h.tw.root, 'a') }],
      ['NotebookEdit', { notebook_path: path.join(h.tw.root, 'a.ipynb') }],
      ['Bash', { command: 'ls' }],
      ['Agent', { subagent_type: 'x', prompt: 'p' }],
      ['mcp__git__status', {}],
      ['mcp__broken', {}],
    ] as Array<[string, Record<string, unknown>]>) {
      const d = await decide(n, i);
      assert.deepEqual(d, { kind: 'deny', reason: PLAN_MODE_DENY }, n);
    }
    for (const [n, i] of [
      ['Read', { file_path: path.join(h.tw.root, 'a') }],
      ['Glob', { pattern: '*' }],
      ['Grep', { pattern: 'x' }],
      ['WebFetch', { url: 'https://x' }],
      ['WebSearch', { query: 'q' }],
      ['TaskCreate', { subject: 's' }],
    ] as Array<[string, Record<string, unknown>]>) {
      assert.equal((await decide(n, i)).kind, 'allow', n);
    }
  });
  it('never-exposed tools are denied under trust-all', async () => {
    h.deps.trust.trustAll = true;
    for (const t of NEVER_EXPOSE_TOOLS) assert.equal((await decide(t, {})).kind, 'deny', t);
  });
  it('non-interactive + always-ask invariant + trust-all ⇒ headless denial', async () => {
    const g = harness({ interactive: false });
    try {
      g.deps.trust.trustAll = true;
      const d = (await g.gate.preToolUse(pre('Write', { file_path: path.join(g.tw.root, '.git', 'config') }, { cwd: g.tw.ws.cwd }))).decision;
      assert.deepEqual(d, { kind: 'deny', reason: NON_INTERACTIVE_DENY });
    } finally {
      g.tw.cleanup();
    }
  });
  it('hook block with an empty reason keeps the exact Q prefix', async () => {
    h.hooks.pre = () => ({ blocked: true, warnings: [] });
    assert.deepEqual(await decide('Read', { file_path: '/x' }), { kind: 'deny', reason: hookBlockedMessage('') });
    assert.equal(hookBlockedMessage(''), 'PreToolHook blocked the tool execution: ');
  });
  it('subagent: a V3 child deny beats a V2 parent under trust-all', async () => {
    h.state.agents.kid = makeAgent({ name: 'kid', dialect: 'v3', permissions: [{ capability: 'web_fetch', effect: 'deny' }] });
    h.deps.trust.trustAll = true;
    assert.equal((await decide('WebFetch', { url: 'https://x' })).kind, 'allow');
    assert.equal((await decide('WebFetch', { url: 'https://x' }, { agent_type: 'kid' })).kind, 'deny');
  });
  it('spec phase: empty allowed list denies every write; Bash is not affected', async () => {
    h.state.spec = { name: 'requirements', allowedWritePaths: [] };
    const d = await decide('Write', { file_path: path.join(h.tw.root, 'x.md') });
    assert.deepEqual(d, { kind: 'deny', reason: 'Spec phase requirements: only (nothing) may be written now' });
    h.deps.trust.trustAll = true;
    assert.equal((await decide('Bash', { command: 'ls' })).kind, 'allow');
  });
  it('spec phase: relative paths resolve against the workspace root, not a sub-directory cwd', async () => {
    h.state.spec = { name: 'design', allowedWritePaths: ['.kiro/specs/f/design.md'] };
    const sub = path.join(h.tw.root, 'pkg');
    fs.mkdirSync(sub, { recursive: true });
    const ok = (await h.gate.preToolUse(pre('Write', { file_path: path.join(h.tw.root, '.kiro/specs/f/design.md') }, { cwd: sub }))).decision;
    assert.equal(ok.kind, 'allow');
    const bad = (await h.gate.preToolUse(pre('Write', { file_path: path.join(sub, '.kiro/specs/f/design.md') }, { cwd: sub }))).decision;
    assert.equal(bad.kind, 'deny');
  });
  it('canUseTool without tool_use_id matches the PreToolUse by name + input', async () => {
    const input = { file_path: path.join(h.tw.root, 'n.txt'), content: 'x' };
    const i: HookInput = { hook_event_name: 'PreToolUse', cwd: h.tw.ws.cwd, tool_name: 'Write', tool_input: input };
    assert.equal((await h.gate.preToolUse(i)).decision.kind, 'ask');
    let seen: string | undefined;
    const req: CanUseToolRequest = { tool_name: 'Write', input };
    const r = await h.gate.canUseTool(
      req,
      async (a) => {
        seen = a.call.claudeName;
        return { kind: 'allow-once' } as ApprovalResponse;
      },
      new AbortController().signal,
    );
    assert.deepEqual(r.result, { behavior: 'allow', updatedInput: input });
    assert.equal(seen, 'Write');
    await h.gate.postToolUse({ ...i, hook_event_name: 'PostToolUse', tool_response: { type: 'create' } });
    assert.deepEqual(h.hooks.log.file.map((f) => f.trigger), ['PostFileCreate']);
  });
  it('canUseTool in a non-interactive gate never calls the UI', async () => {
    const g = harness({ interactive: false });
    try {
      const r = await g.gate.canUseTool(
        { tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 't1' },
        async () => {
          throw new Error('UI must not be called');
        },
        new AbortController().signal,
      );
      assert.deepEqual(r.result, { behavior: 'deny', message: NON_INTERACTIVE_DENY });
    } finally {
      g.tw.cleanup();
    }
  });
  it('a pre-aborted signal is cancelled without prompting', async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await h.gate.canUseTool(
      { tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 't2' },
      async () => {
        throw new Error('UI must not be called');
      },
      ac.signal,
    );
    assert.deepEqual(r.result, { behavior: 'deny', message: 'Tool use was cancelled by the user', interrupt: true });
  });
  it('MCP server named `constructor` keeps its name through the gate', async () => {
    const g = harness({ names: {}, agent: { allowedTools: ['@constructor'] } });
    try {
      const out = await g.gate.preToolUse(pre('mcp__constructor__run', {}, { cwd: g.tw.ws.cwd }));
      assert.deepEqual(out.call.mcp, { server: 'constructor', tool: 'run' });
      assert.equal(out.decision.kind, 'allow');
    } finally {
      g.tw.cleanup();
    }
  });
  it('trustTools: empty and whitespace names are ignored; results are normalized', () => {
    assert.deepEqual(h.gate.trustTools(['', '  ', 'read', 'shell', '@git/status']), ['fs_read', 'execute_bash', '@git/status']);
    assert.deepEqual(h.deps.trust.allowedTools, ['fs_read', 'execute_bash', '@git/status']);
    assert.deepEqual(h.gate.trustTools(['read']), ['fs_read']);
    assert.equal(h.deps.trust.allowedTools.length, 3, 'no duplicates');
  });
});

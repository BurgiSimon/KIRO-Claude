/**
 * Kiro V3 capability engine (02 §2.8, 00 §5.1 capEngine, §5.3 defaults): matching per
 * capability, exclude lists, meta capabilities, effect ordering, default policy, presets,
 * shell splitting / normalization, unparseable commands, trust-all.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { KiroToolCall, PermissionRule } from '../../src/types.js';
import {
  PRESET_IDS,
  SHELL_PARSE_DENY,
  V3_DEFAULT_RULES,
  collectRules,
  describeRule,
  evaluateCap,
  isUnconditional,
  presetRules,
  ruleAppliesTo,
  type CapScopes,
} from '../../src/policy/capengine.js';
import { toKiroCall } from '../../src/policy/toolmap.js';
import { makeWs, type TempWs } from './helpers.js';

const R = (capability: string, effect: PermissionRule['effect'], match?: string[], exclude?: string[]): PermissionRule => ({
  capability,
  effect,
  ...(match ? { match } : {}),
  ...(exclude ? { exclude } : {}),
});

function scopes(p: Partial<CapScopes> = {}): CapScopes {
  return { agentRules: [], userRules: [], workspaceRules: [], presetRules: [], sessionRules: [], trustAll: false, ...p };
}

let tw: TempWs;
before(() => {
  // cwd is a subdirectory: relative V3 patterns must resolve against the WORKSPACE ROOT
  tw = makeWs({ cwdSub: 'pkg' });
  fs.mkdirSync(path.join(tw.root, 'src', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(tw.root, 'secrets'), { recursive: true });
  fs.mkdirSync(path.join(tw.home, 'notes', 'sub'), { recursive: true });
  fs.symlinkSync(path.join(tw.root, 'src'), path.join(tw.home, 'src-link'));
});
after(() => tw.cleanup());

const call = (name: string, input: Record<string, unknown>): KiroToolCall => toKiroCall(name, input, { cwd: tw.ws.cwd });
const ev = (name: string, input: Record<string, unknown>, s: Partial<CapScopes> = {}) => evaluateCap(call(name, input), scopes(s), tw.ws);
const kind = (name: string, input: Record<string, unknown>, s: Partial<CapScopes> = {}) => ev(name, input, s).kind;
const rd = (p: string) => ({ file_path: p });
const sh = (command: string) => ({ command });

describe('fs_read / fs_write path globs (v3path dialect)', () => {
  it('relative patterns resolve against the workspace root, not the cwd', () => {
    const agentRules = [R('fs_write', 'allow', ['./src/**'])];
    assert.equal(kind('Write', rd(path.join(tw.root, 'src', 'a.ts')), { agentRules }), 'allow');
    assert.equal(kind('Write', rd(path.join(tw.root, 'pkg', 'src', 'a.ts')), { agentRules }), 'ask');
    assert.equal(kind('Write', rd('../src/b.ts'), { agentRules }), 'allow', 'tool path relative to the call cwd');
  });
  it('* stays within a component, ** crosses', () => {
    const agentRules = [R('fs_write', 'allow', ['./src/*.ts'])];
    assert.equal(kind('Write', rd(path.join(tw.root, 'src', 'a.ts')), { agentRules }), 'allow');
    assert.equal(kind('Write', rd(path.join(tw.root, 'src', 'deep', 'a.ts')), { agentRules }), 'ask');
    const deep = [R('fs_write', 'allow', ['./src/**/*.ts'])];
    assert.equal(kind('Write', rd(path.join(tw.root, 'src', 'deep', 'a.ts')), { agentRules: deep }), 'allow');
    assert.equal(kind('Write', rd(path.join(tw.root, 'src', 'a.ts')), { agentRules: deep }), 'allow');
  });
  it('braces, ? and classes', () => {
    const agentRules = [R('fs_write', 'allow', ['./{src,lib}/**', './doc?.md', './v[0-9].txt'])];
    assert.equal(kind('Write', rd(path.join(tw.root, 'lib', 'x')), { agentRules }), 'allow');
    assert.equal(kind('Write', rd(path.join(tw.root, 'docs.md')), { agentRules }), 'allow');
    assert.equal(kind('Write', rd(path.join(tw.root, 'docs2.md')), { agentRules }), 'ask');
    assert.equal(kind('Write', rd(path.join(tw.root, 'v7.txt')), { agentRules }), 'allow');
    assert.equal(kind('Write', rd(path.join(tw.root, 'vx.txt')), { agentRules }), 'ask');
  });
  it('a pattern without wildcards matches the path and its children; ~ expands to home', () => {
    const agentRules = [R('fs_read', 'allow', ['~/notes'])];
    assert.equal(kind('Read', rd(path.join(tw.home, 'notes')), { agentRules }), 'allow');
    assert.equal(kind('Read', rd(path.join(tw.home, 'notes', 'sub', 'x.md')), { agentRules }), 'allow');
    assert.equal(kind('Read', rd(path.join(tw.home, 'notesX')), { agentRules }), 'ask');
  });
  it('absolute patterns; symlinked tool paths are canonicalized', () => {
    const agentRules = [R('fs_write', 'allow', [path.join(tw.root, 'src')])];
    assert.equal(kind('Write', rd(path.join(tw.home, 'src-link', 'new.ts')), { agentRules }), 'allow');
  });
  it('exclude carves out of match', () => {
    const agentRules = [R('fs_write', 'allow', ['./**'], ['./secrets/**', '**/*.pem'])];
    assert.equal(kind('Write', rd(path.join(tw.root, 'src', 'a.ts')), { agentRules }), 'allow');
    assert.equal(kind('Write', rd(path.join(tw.root, 'secrets', 'k')), { agentRules }), 'ask');
    assert.equal(kind('Write', rd(path.join(tw.root, 'src', 'k.pem')), { agentRules }), 'ask');
  });
  it('deny with exclude', () => {
    const agentRules = [R('fs_read', 'deny', ['./secrets/**'], ['./secrets/public/**'])];
    assert.equal(kind('Read', rd(path.join(tw.root, 'secrets', 'k')), { agentRules }), 'deny');
    assert.equal(kind('Read', rd(path.join(tw.root, 'secrets', 'public', 'k')), { agentRules }), 'allow', 'falls to defaults (./** read)');
  });
  it('Glob/Grep search roots: the workspace root itself is covered by ./**', () => {
    assert.equal(kind('Grep', { pattern: 'x', path: tw.root }), 'allow');
    assert.equal(kind('Glob', { pattern: '**/*.ts' }), 'allow');
    assert.equal(kind('Grep', { pattern: 'x', path: '/' }), 'ask');
    assert.equal(kind('Glob', { pattern: '/etc/**' }), 'ask', 'escaping pattern root is a subject too');
  });
  it('NotebookEdit and Edit use the same subjects', () => {
    const agentRules = [R('fs_write', 'deny', ['**/*.ipynb'])];
    assert.equal(kind('NotebookEdit', { notebook_path: path.join(tw.root, 'n.ipynb') }, { agentRules }), 'deny');
    assert.equal(kind('Edit', rd(path.join(tw.root, 'n.py')), { agentRules }), 'ask');
  });
});

describe('shell (wildcard dialect, every sub-command must pass)', () => {
  it('each sub-command is evaluated', () => {
    const agentRules = [R('shell', 'allow', ['git *', 'npm test'])];
    assert.equal(kind('Bash', sh('git add . && npm test'), { agentRules }), 'allow');
    assert.equal(kind('Bash', sh('git add . && rm -rf /'), { agentRules }), 'ask');
    assert.equal(kind('Bash', sh('git log | head'), { agentRules }), 'ask');
  });
  it('* matches any sequence incl. spaces and /', () => {
    const agentRules = [R('shell', 'allow', ['cat /etc/*'])];
    assert.equal(kind('Bash', sh('cat /etc/a/b c'), { agentRules }), 'allow');
    assert.equal(kind('Bash', sh('cat /var/x'), { agentRules }), 'ask');
  });
  it('? and [] are literal in the wildcard dialect', () => {
    const agentRules = [R('shell', 'allow', ['ls ?', 'ls [ab]'])];
    assert.equal(kind('Bash', sh('ls x'), { agentRules }), 'ask');
    assert.equal(kind('Bash', sh("ls '?'"), { agentRules }), 'allow');
  });
  it('any denied sub-command denies the call', () => {
    const agentRules = [R('shell', 'allow', ['*']), R('shell', 'deny', ['rm *'])];
    assert.equal(kind('Bash', sh('echo hi; rm -rf /'), { agentRules }), 'deny');
    assert.equal(kind('Bash', sh('echo hi'), { agentRules }), 'allow');
  });
  it('quoting cannot dodge deny rules (normalized form)', () => {
    const agentRules = [R('shell', 'deny', ['rm *'])];
    for (const c of ['"rm" -rf /', "r'm' -rf /", 'rm  -rf   /', "$'\\x72\\x6d' -rf /"]) {
      assert.equal(kind('Bash', sh(c), { agentRules }), 'deny', c);
    }
  });
  it('env assignments: deny/ask rules see through them, allow rules do not', () => {
    assert.equal(kind('Bash', sh('X=1 rm -rf /'), { agentRules: [R('shell', 'deny', ['rm *'])] }), 'deny');
    assert.equal(kind('Bash', sh('X=1 npm publish'), { agentRules: [R('shell', 'ask', ['npm publish*']), R('shell', 'allow', ['X=1 npm *'])] }), 'ask');
    assert.equal(kind('Bash', sh('GIT_PAGER=evil git log'), { agentRules: [R('shell', 'allow', ['git log*'])] }), 'ask');
    assert.equal(kind('Bash', sh('GIT_PAGER=evil git log'), {}), 'ask', 'default git read-only allow is strict too');
    assert.equal(kind('Bash', sh('CI=1 npm test'), { agentRules: [R('shell', 'allow', ['CI=1 npm test'])] }), 'allow');
  });
  it('allow-rule excludes see through env assignments', () => {
    const agentRules = [R('shell', 'allow', ['*'], ['rm *'])];
    assert.equal(kind('Bash', sh('X=1 rm -rf /'), { agentRules }), 'ask');
  });
  it('unparseable commands are denied with the rewrite message', () => {
    for (const c of ['echo $(date)', "echo 'unterminated", 'cat <(ls)', 'echo `id`']) {
      assert.deepEqual(ev('Bash', sh(c)), { kind: 'deny', reasons: [SHELL_PARSE_DENY] }, c);
    }
    assert.equal(SHELL_PARSE_DENY, 'Command could not be parsed; rewrite it as simple commands.');
    assert.equal(kind('Bash', sh('echo $(date)'), { agentRules: [R('shell', 'allow', ['echo *'])] }), 'deny', 'pattern allow rules cannot judge hidden commands');
  });
  it('unparseable under an unconditional allow (trust-all, allow-all, shell:allow) is judged whole', () => {
    assert.equal(kind('Bash', sh('echo $(date)'), { trustAll: true }), 'allow');
    assert.equal(kind('Bash', sh('echo $(date)'), { presetRules: presetRules('allow-all')! }), 'allow');
    assert.equal(kind('Bash', sh('echo $(date)'), { sessionRules: [R('shell', 'allow')] }), 'allow');
    assert.equal(kind('Bash', sh('echo $(rm -rf /)'), { trustAll: true, userRules: [R('shell', 'deny', ['*rm -rf*'])] }), 'deny');
    assert.equal(kind('Bash', sh('npm publish $(x)'), { trustAll: true, userRules: [R('shell', 'ask', ['npm publish*'])] }), 'ask');
    assert.equal(kind('Bash', sh('echo $(date)'), { sessionRules: [R('shell', 'allow', undefined, ['rm *'])] }), 'deny', 'conditional (exclude) allow is not enough');
    assert.equal(kind('Bash', sh('echo $(date)'), { trustAll: true, agentRules: [R('shell', 'deny')] }), 'deny');
  });
  it('empty command', () => {
    assert.equal(kind('Bash', sh('')), 'ask');
    assert.equal(kind('Bash', sh(''), { trustAll: true }), 'allow');
  });
});

describe('other capabilities (wildcard dialect)', () => {
  it('web_fetch matches the URL', () => {
    const agentRules = [R('web_fetch', 'allow', ['https://docs.rs/*'])];
    assert.equal(kind('WebFetch', { url: 'https://docs.rs/serde/latest' }, { agentRules }), 'allow');
    assert.equal(kind('WebFetch', { url: 'https://evil.com/?https://docs.rs/' }, { agentRules }), 'ask');
  });
  it('web_search matches the query', () => {
    assert.equal(kind('WebSearch', { query: 'rust serde' }, { agentRules: [R('web_search', 'allow')] }), 'allow');
    assert.equal(kind('WebSearch', { query: 'rust serde' }, { agentRules: [R('web_search', 'deny', ['*password*'])] }), 'ask');
    assert.equal(kind('WebSearch', { query: 'leak password list' }, { agentRules: [R('web_search', 'deny', ['*password*'])] }), 'deny');
  });
  it('mcp matches server/tool', () => {
    const agentRules = [R('mcp', 'allow', ['git/*']), R('mcp', 'deny', ['git/push'])];
    assert.equal(kind('mcp__git__status', {}, { agentRules }), 'allow');
    assert.equal(kind('mcp__git__push', {}, { agentRules }), 'deny');
    assert.equal(kind('mcp__other__x', {}, { agentRules }), 'ask');
    assert.equal(kind('mcp__other__x', {}, { agentRules: [R('mcp', 'allow', ['*/x'])] }), 'allow');
  });
  it('subagent matches the agent name', () => {
    const agentRules = [R('subagent', 'allow', ['rev*'])];
    assert.equal(kind('Agent', { subagent_type: 'reviewer' }, { agentRules }), 'allow');
    assert.equal(kind('Agent', { subagent_type: 'planner' }, { agentRules }), 'ask');
  });
  it('skill matches the skill name (kiro: prefix stripped); no default ⇒ ask', () => {
    assert.equal(kind('Skill', { skill: 'kiro:pdf' }, { agentRules: [R('skill', 'allow', ['pdf'])] }), 'allow');
    assert.equal(kind('Skill', { skill: 'kiro:pdf' }), 'ask');
  });
  it('utility (unknown Claude tools) allowed by default, todo tools always', () => {
    assert.equal(kind('LSP', {}), 'allow');
    assert.equal(kind('LSP', {}, { agentRules: [R('all', 'deny')] }), 'deny');
    for (const t of ['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']) {
      assert.equal(kind(t, {}, { agentRules: [R('all', 'deny')], userRules: [R('utility', 'deny')] }), 'allow', t);
    }
  });
});

describe('meta capabilities', () => {
  it('ruleAppliesTo table', () => {
    const caps = ['fs_read', 'fs_write', 'shell', 'web_fetch', 'web_search', 'mcp', 'subagent', 'skill', 'utility', 'sandbox_network'] as const;
    const exp: Record<string, string[]> = {
      all: caps.filter((c) => c !== 'sandbox_network'),
      builtin: caps.filter((c) => c !== 'mcp' && c !== 'sandbox_network'),
      filesystem: ['fs_read', 'fs_write'],
      shell: ['shell'],
      mcp: ['mcp'],
      sandbox_network: ['sandbox_network'],
    };
    for (const [rc, hits] of Object.entries(exp)) {
      for (const c of caps) assert.equal(ruleAppliesTo(R(rc, 'allow'), { capability: c }), hits.includes(c), `${rc} → ${c}`);
    }
  });
  it('all / builtin / filesystem end to end', () => {
    assert.equal(kind('mcp__a__b', {}, { agentRules: [R('all', 'allow')] }), 'allow');
    assert.equal(kind('mcp__a__b', {}, { agentRules: [R('builtin', 'allow')] }), 'ask');
    assert.equal(kind('Bash', sh('make'), { agentRules: [R('builtin', 'allow')] }), 'allow');
    assert.equal(kind('Bash', sh('make'), { agentRules: [R('filesystem', 'allow')] }), 'ask');
    assert.equal(kind('Write', rd('/tmp/x'), { agentRules: [R('filesystem', 'allow')] }), 'allow');
    assert.equal(kind('Read', rd('/etc/passwd'), { agentRules: [R('filesystem', 'deny', ['/etc/**'])] }), 'deny');
  });
});

describe('effects: deny > ask > allow > evaluate, no scope precedence', () => {
  it('ordering', () => {
    const f = rd('/opt/x');
    assert.equal(kind('Read', f, { agentRules: [R('fs_read', 'allow'), R('fs_read', 'deny')] }), 'deny');
    assert.equal(kind('Read', f, { agentRules: [R('fs_read', 'allow'), R('fs_read', 'ask')] }), 'ask');
    assert.equal(kind('Read', f, { agentRules: [R('fs_read', 'allow'), R('fs_read', 'evaluate')] }), 'allow');
    assert.equal(kind('Read', f, { agentRules: [R('fs_read', 'evaluate')] }), 'ask', 'evaluate alone ⇒ ask (no classifier)');
    assert.equal(kind('Read', f, { agentRules: [R('fs_read', 'deny')], sessionRules: [R('fs_read', 'allow')] }), 'deny');
  });
  it('rules from every scope are combined', () => {
    const f = rd('/opt/x');
    for (const k of ['agentRules', 'userRules', 'workspaceRules', 'presetRules', 'sessionRules'] as const) {
      assert.equal(kind('Read', f, { [k]: [R('fs_read', 'allow')] }), 'allow', k);
      assert.equal(kind('Read', f, { [k]: [R('fs_read', 'deny')], agentRules: k === 'agentRules' ? [R('fs_read', 'deny')] : [R('fs_read', 'allow')] }), 'deny', k);
    }
    assert.equal(kind('Read', f, { userRules: [R('fs_read', 'deny')], agentRules: [R('fs_read', 'allow')], trustAll: true }), 'deny', 'user deny beats agent allow and trust-all');
    assert.equal(kind('Read', f, { workspaceRules: [R('fs_read', 'ask')], sessionRules: [R('fs_read', 'allow')] }), 'ask');
  });
  it('matching configured rules take precedence over the defaults (even a weaker one)', () => {
    // a configured ask on a workspace path wins although the default policy would allow it
    assert.equal(kind('Read', rd(path.join(tw.root, 'src', 'x')), { agentRules: [R('fs_read', 'ask', ['./src/**'])] }), 'ask');
    // a configured allow outside the workspace
    assert.equal(kind('Read', rd('/opt/data/x'), { agentRules: [R('fs_read', 'allow', ['/opt/**'])] }), 'allow');
  });
  it('trust-all is a session allow-all rule', () => {
    assert.equal(kind('Bash', sh('rm -rf build'), { trustAll: true }), 'allow');
    assert.equal(kind('mcp__x__y', {}, { trustAll: true }), 'allow');
    assert.equal(kind('Bash', sh('rm -rf build'), { trustAll: true, agentRules: [R('shell', 'deny', ['rm *'])] }), 'deny');
    assert.equal(kind('Bash', sh('rm -rf build'), { trustAll: true, agentRules: [R('shell', 'ask', ['rm *'])] }), 'ask');
  });
  it('malformed rules are ignored', () => {
    const bad = [
      { capability: 'fs_read', effect: 'nope' },
      { capability: 'fs_read', effect: 'constructor' },
      { capability: 7, effect: 'allow' },
      { capability: 'fs_read', effect: 'allow', match: 'x' },
      { capability: 'fs_read', effect: 'allow', match: [1] },
      null,
      'x',
    ] as unknown as PermissionRule[];
    assert.equal(kind('Read', rd('/opt/x'), { agentRules: bad }), 'ask');
    assert.equal(collectRules(scopes({ agentRules: bad })).length, 0);
  });
});

describe('V3 default policy (00 §5.3)', () => {
  it('fs_read within the workspace root', () => {
    assert.equal(kind('Read', rd(path.join(tw.root, 'README.md'))), 'allow');
    assert.equal(kind('Read', rd(path.join(tw.root, 'pkg', 'x'))), 'allow');
    assert.equal(kind('Read', rd(path.join(tw.home, 'other'))), 'ask');
    assert.equal(kind('Write', rd(path.join(tw.root, 'README.md'))), 'ask', 'writes always ask by default');
  });
  const allowed = [
    'git status', 'git status --porcelain', 'git log --oneline -5', 'git diff HEAD~1', 'git show HEAD', 'git branch', 'git branch -a',
    'git branch -r', 'git branch -v', 'git branch -vv', 'git branch --list', 'git rev-parse HEAD', 'git remote -v', 'git ls-files',
    'git blame src/a.ts', 'pwd', 'whoami', 'uname -a', 'hostname', 'date', 'id', 'uptime', 'which node', 'git status && pwd',
  ];
  const asked = [
    'ls', 'git push', 'git commit -m x', 'git branch -D main', 'git branch -d main', 'git branch -vD main', 'git branch -v -D x',
    'git branch newbranch', 'git branch -m a b', 'git log --output=/tmp/x', 'git diff --ext-diff', 'git diff > patch.txt',
    'pwd > f', 'date -s 2020-01-01', 'hostname evil', 'git remote add x y', 'git status; rm -rf /', 'whoami | sh',
    'git log -c', 'npm test',
  ];
  for (const c of allowed) it(`shell allow: ${c}`, () => assert.equal(kind('Bash', sh(c)), 'allow'));
  for (const c of asked) it(`shell ask: ${c}`, () => assert.equal(kind('Bash', sh(c)), 'ask'));
  it('the default list is not consulted when a configured rule matches', () => {
    assert.equal(kind('Bash', sh('git status'), { agentRules: [R('shell', 'ask', ['git *'])] }), 'ask');
  });
  it('V3_DEFAULT_RULES shape and immutability', () => {
    assert.equal(V3_DEFAULT_RULES.length, 3);
    assert.deepEqual(V3_DEFAULT_RULES[0], { capability: 'fs_read', match: ['./**'], effect: 'allow', scope: 'kiro' });
    assert.equal(V3_DEFAULT_RULES[1]!.capability, 'shell');
    assert.ok(V3_DEFAULT_RULES[1]!.match!.includes('git status*'));
    assert.deepEqual(V3_DEFAULT_RULES[2], { capability: 'utility', effect: 'allow', scope: 'kiro' });
    assert.ok(Object.isFrozen(V3_DEFAULT_RULES));
    assert.ok(Object.isFrozen(V3_DEFAULT_RULES[1]));
    assert.ok(Object.isFrozen(V3_DEFAULT_RULES[1]!.match));
    assert.throws(() => (V3_DEFAULT_RULES as PermissionRule[]).push(R('all', 'allow')));
  });
});

describe('presets (02 §2.8)', () => {
  it('known ids', () => {
    for (const id of PRESET_IDS) {
      const r = presetRules(id);
      assert.ok(r && r.length > 0, id);
      for (const x of r) assert.equal(x.scope, 'preset');
    }
    assert.equal(presetRules('nope'), undefined);
    assert.equal(presetRules('constructor'), undefined);
  });
  it('returns fresh copies', () => {
    const a = presetRules('edit-workspace')!;
    a[0]!.match!.push('/etc/**');
    assert.deepEqual(presetRules('edit-workspace')![0]!.match, ['./**']);
  });
  const P = (id: string) => ({ presetRules: presetRules(id)! });
  it('allow-all', () => {
    assert.equal(kind('Bash', sh('rm -rf x'), P('allow-all')), 'allow');
    assert.equal(kind('mcp__a__b', {}, P('allow-all')), 'allow');
  });
  it('edit-workspace / read-workspace', () => {
    assert.equal(kind('Write', rd(path.join(tw.root, 'a')), P('edit-workspace')), 'allow');
    assert.equal(kind('Write', rd('/tmp/a'), P('edit-workspace')), 'ask');
    assert.equal(kind('Write', rd(path.join(tw.root, 'a')), P('read-workspace')), 'ask');
    assert.equal(kind('Read', rd(path.join(tw.root, 'a')), P('read-workspace')), 'allow');
  });
  it('read-all', () => {
    assert.equal(kind('Read', rd('/etc/hosts'), P('read-all')), 'allow');
    assert.equal(kind('WebFetch', { url: 'https://x' }, P('read-all')), 'allow');
    assert.equal(kind('WebSearch', { query: 'q' }, P('read-all')), 'allow');
    assert.equal(kind('Write', rd('/tmp/a'), P('read-all')), 'ask');
  });
  it('read-only-shell / dev-shell', () => {
    assert.equal(kind('Bash', sh('npm ls --depth 0'), P('read-only-shell')), 'allow');
    assert.equal(kind('Bash', sh('kubectl get pods'), P('read-only-shell')), 'allow');
    assert.equal(kind('Bash', sh('npm install'), P('read-only-shell')), 'ask');
    assert.equal(kind('Bash', sh('npm install'), P('dev-shell')), 'allow');
    assert.equal(kind('Bash', sh('git commit -m "x"'), P('dev-shell')), 'allow');
    assert.equal(kind('Bash', sh('mkdir -p a/b && touch a/b/c'), P('dev-shell')), 'allow');
    assert.equal(kind('Bash', sh('npm publish'), P('dev-shell')), 'ask');
    assert.equal(kind('Bash', sh('cargo publish --dry-run'), P('dev-shell')), 'ask');
    assert.equal(kind('Bash', sh('rm -rf /'), P('dev-shell')), 'ask');
  });
  it('approve-for-me: edit-workspace + read-only shell + evaluate (⇒ ask)', () => {
    assert.equal(kind('Write', rd(path.join(tw.root, 'a')), P('approve-for-me')), 'allow');
    assert.equal(kind('Bash', sh('git status'), P('approve-for-me')), 'allow');
    assert.equal(kind('Bash', sh('make'), P('approve-for-me')), 'ask');
    assert.equal(kind('WebFetch', { url: 'https://x' }, P('approve-for-me')), 'ask');
  });
});

describe('reasons and helpers', () => {
  it('describeRule', () => {
    assert.equal(describeRule({ capability: 'shell', match: ['git *'], effect: 'allow', scope: 'user' }), 'shell: git * → allow [user]');
    assert.equal(describeRule({ capability: 'fs_read', match: ['./**'], exclude: ['./secrets/**'], effect: 'deny' }), 'fs_read: ./** (except ./secrets/**) → deny [agent]');
    assert.equal(describeRule({ capability: 'all', effect: 'allow', scope: 'session' }), 'all: * → allow [session]');
  });
  it('deny reasons list the denying rules', () => {
    const r = ev('Bash', sh('rm -rf x'), { userRules: [{ ...R('shell', 'deny', ['rm *']), scope: 'user' }] });
    assert.deepEqual(r, { kind: 'deny', reasons: ['shell: rm * → deny [user]'] });
  });
  it('ask reasons name the subject when nothing matched', () => {
    const r = ev('Bash', sh('make all'));
    assert.deepEqual(r, { kind: 'ask', reasons: ['no permission rule allows shell: make all'] });
  });
  it('collectRules tags scopes and appends the trust-all rule', () => {
    const rules = collectRules(scopes({ agentRules: [R('shell', 'allow')], userRules: [R('mcp', 'deny')], trustAll: true }));
    assert.deepEqual(rules.map((r) => r.scope), ['agent', 'user', 'session']);
    assert.deepEqual(rules[2], { capability: 'all', effect: 'allow', scope: 'session' });
  });
  it('isUnconditional', () => {
    assert.ok(isUnconditional(R('shell', 'allow')));
    assert.ok(isUnconditional(R('shell', 'allow', [])));
    assert.ok(!isUnconditional(R('shell', 'allow', ['x'])));
    assert.ok(!isUnconditional(R('shell', 'allow', undefined, ['x'])));
  });
});

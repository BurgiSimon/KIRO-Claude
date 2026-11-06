/**
 * Q / Kiro 2.x engine (06 §1.2–§1.6): every evaluator vector from 06 Appendix A test.mjs
 * (`eval_perm`), plus fs_read / fs_write path evaluators (06 §1.4.2–§1.5), web_fetch,
 * use_subagent, use_aws, MCP allowlist/autoApprove, todo_list, trust-all and session trust.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { KiroAgent, PolicyVerdict } from '../../src/types.js';
import {
  effectiveAllowedTools,
  evalExecuteBash,
  evalFsReadPaths,
  evalFsWritePath,
  evalSubagent,
  evalUseAws,
  evalWebFetch,
  evaluateQ,
  evaluateQRaw,
  toolSettings,
} from '../../src/policy/qengine.js';
import { toKiroCall } from '../../src/policy/toolmap.js';
import { emptyTrust, makeAgent, makeWs, type TempWs } from './helpers.js';

const kind = (v: PolicyVerdict): string => v.kind;

describe('evalExecuteBash — 06 Appendix A eval_perm vectors', () => {
  it('allowedCommands + deniedCommands', () => {
    const s = { allowedCommands: ['allow_wild_card .*', 'allow_exact'], deniedCommands: ['git .*'] };
    assert.deepEqual(evalExecuteBash('git status', [], s), { kind: 'deny', reasons: ['\\Agit .*\\z'] });
    assert.equal(evalExecuteBash('this_is_not_a_read_only_command', [], s).kind, 'ask');
    assert.equal(evalExecuteBash('allow_wild_card some_arg', [], s).kind, 'allow');
    assert.equal(evalExecuteBash('allow_exact some_arg', [], s).kind, 'ask');
    assert.equal(evalExecuteBash('allow_exact', [], s).kind, 'allow');
    // after trusting execute_bash: everything allowed except the deny list
    assert.equal(evalExecuteBash('this_is_not_a_read_only_command', ['execute_bash'], s).kind, 'allow');
    assert.equal(evalExecuteBash('git status', ['execute_bash'], s).kind, 'deny');
  });
  it('no settings: every non-empty command asks (even ls)', () => {
    assert.equal(evalExecuteBash('ls -la', [], undefined).kind, 'ask');
    assert.equal(evalExecuteBash('rm file.txt', [], undefined).kind, 'ask');
    assert.equal(evalExecuteBash('rm file.txt', ['execute_bash'], undefined).kind, 'allow');
    assert.equal(evalExecuteBash('', [], undefined).kind, 'allow', 'empty command ⇒ Allow');
  });
  it('empty settings object behaves like defaults', () => {
    assert.equal(evalExecuteBash('ls -la', [], {}).kind, 'ask');
  });
  it('autoAllowReadonly', () => {
    const r = { autoAllowReadonly: true };
    assert.equal(evalExecuteBash('ls -la', [], r).kind, 'allow');
    assert.equal(evalExecuteBash('rm file.txt', [], r).kind, 'ask');
    assert.equal(evalExecuteBash('cat a | grep b | head -n 1', [], r).kind, 'allow');
    assert.equal(evalExecuteBash('cat a > b', [], r).kind, 'ask');
  });
  it('autoAllowReadonly + deniedCommands', () => {
    const rd = { autoAllowReadonly: true, deniedCommands: ['ls .*'] };
    assert.deepEqual(evalExecuteBash('ls -la', [], rd), { kind: 'deny', reasons: ['\\Als .*\\z'] });
    assert.equal(evalExecuteBash('cat file.txt', [], rd).kind, 'allow');
  });
  it('invalid deny regex (look-around) denies every command', () => {
    const inv = { deniedCommands: ['^(?!ls$).*'] };
    assert.deepEqual(evalExecuteBash('pwd', [], inv), { kind: 'deny', reasons: ['\\A.*\\z'] });
    assert.equal(evalExecuteBash('ls', ['execute_bash'], inv).kind, 'deny', 'deny-all beats allowedTools');
  });
  it('denyByDefault', () => {
    const dbd = { allowedCommands: ['ls'], denyByDefault: true };
    assert.equal(evalExecuteBash('ls', [], dbd).kind, 'allow');
    assert.deepEqual(evalExecuteBash('pwd', [], dbd), { kind: 'deny', reasons: ['not in allowed commands list'] });
  });
  it('several matching deny rules are all reported', () => {
    const s = { deniedCommands: ['git .*', '.*push.*', 'rm .*'] };
    assert.deepEqual(evalExecuteBash('git push', [], s), { kind: 'deny', reasons: ['\\Agit .*\\z', '\\A.*push.*\\z'] });
  });
  it('anchoring is concatenation, not grouping (a|b = starts with a OR ends with b)', () => {
    const s = { deniedCommands: ['rm|shutdown'] };
    assert.equal(evalExecuteBash('rm -rf x', [], s).kind, 'deny');
    assert.equal(evalExecuteBash('sudo shutdown', [], s).kind, 'deny');
    assert.equal(evalExecuteBash('echo rm x', [], s).kind, 'ask');
  });
  it('Rust syntax in allow/deny lists is translated', () => {
    assert.equal(evalExecuteBash('GIT status', [], { allowedCommands: ['(?i)git status'] }).kind, 'allow');
    assert.equal(evalExecuteBash('npm 123', [], { allowedCommands: ['npm [[:digit:]]+'] }).kind, 'allow');
    assert.equal(evalExecuteBash('npm x', [], { allowedCommands: ['npm [[:digit:]]+'] }).kind, 'ask');
  });
  it('allowedCommands cannot approve dangerous commands (checked first)', () => {
    const s = { allowedCommands: ['echo .*'] };
    assert.equal(evalExecuteBash('echo ok', [], s).kind, 'allow');
    assert.equal(evalExecuteBash('echo $(rm -rf /)', [], s).kind, 'ask');
    assert.equal(evalExecuteBash('echo a; rm b', [], s).kind, 'ask');
  });
  it('malformed settings ⇒ ask', () => {
    for (const bad of [[], 'x', 1, { allowedCommands: 'ls' }, { deniedCommands: [1] }, { autoAllowReadonly: 'yes' }, null]) {
      assert.equal(evalExecuteBash('ls', [], bad).kind, 'ask', JSON.stringify(bad));
    }
  });
});

describe('evalUseAws (06 §1.4.4)', () => {
  const t = (service_name: string, operation_name: string) => ({ service_name, operation_name });
  it('no settings', () => {
    assert.equal(evalUseAws(t('s3', 'list-buckets'), false, undefined).kind, 'ask');
    assert.equal(evalUseAws(t('s3', 'delete-bucket'), true, undefined).kind, 'allow');
  });
  it('deny / allow services, read-only ops', () => {
    const s = { allowedServices: ['lambda'], deniedServices: ['iam'], autoAllowReadonly: true };
    assert.deepEqual(evalUseAws(t('iam', 'list-users'), true, s), { kind: 'deny', reasons: ['iam'] });
    assert.equal(evalUseAws(t('lambda', 'invoke'), false, s).kind, 'allow');
    for (const op of ['get-object', 'describe-instances', 'list-buckets', 'ls', 'search-x', 'batch_get_item', 'lsx']) {
      assert.equal(evalUseAws(t('s3', op), false, s).kind, 'allow', op);
    }
    assert.equal(evalUseAws(t('s3', 'put-object'), false, s).kind, 'ask');
    assert.equal(evalUseAws(t('s3', 'list-buckets'), false, { autoAllowReadonly: false }).kind, 'ask');
  });
});

describe('path evaluators (06 §1.4.2–§1.5)', () => {
  let tw: TempWs;
  let outside: string;
  before(() => {
    tw = makeWs();
    fs.mkdirSync(path.join(tw.root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tw.root, 'src', 'a.ts'), 'x');
    fs.mkdirSync(path.join(tw.home, 'temp', 'sub'), { recursive: true });
    fs.mkdirSync(path.join(tw.home, 'secret'), { recursive: true });
    outside = path.join(tw.home, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(path.join(tw.root, 'src'), path.join(tw.home, 'link-to-src'));
  });
  after(() => tw.cleanup());

  it('fs_read: cwd always allowed, outside asks', () => {
    const ws = tw.ws;
    assert.equal(kind(evalFsReadPaths([path.join(tw.root, 'src/a.ts')], false, undefined, ws)), 'allow');
    assert.equal(kind(evalFsReadPaths([tw.root], false, undefined, ws)), 'allow');
    assert.equal(kind(evalFsReadPaths([path.join(outside, 'x')], false, undefined, ws)), 'ask');
    assert.equal(kind(evalFsReadPaths(['/etc/passwd'], false, {}, ws)), 'ask');
  });
  it('fs_read: symlinks are canonicalized (realpath)', () => {
    assert.equal(kind(evalFsReadPaths([path.join(tw.home, 'link-to-src', 'a.ts')], false, undefined, tw.ws)), 'allow');
  });
  it('fs_read: allowedPaths are gitignore-style (~ expanded, children match)', () => {
    const s = { allowedPaths: ['~/temp'] };
    assert.equal(kind(evalFsReadPaths([path.join(tw.home, 'temp')], false, s, tw.ws)), 'allow');
    assert.equal(kind(evalFsReadPaths([path.join(tw.home, 'temp', 'sub', 'f')], false, s, tw.ws)), 'allow');
    assert.equal(kind(evalFsReadPaths([path.join(tw.home, 'tempX')], false, s, tw.ws)), 'ask');
  });
  it('fs_read: $VAR expansion in allowedPaths', () => {
    assert.equal(kind(evalFsReadPaths([path.join(tw.home, 'outside', 'f')], false, { allowedPaths: ['$HOME/outside'] }, tw.ws)), 'allow');
    assert.equal(kind(evalFsReadPaths([path.join(tw.home, 'outside', 'f')], false, { allowedPaths: ['${HOME}/outside'] }, tw.ws)), 'allow');
  });
  it('fs_read: deniedPaths win, reasons are the original strings', () => {
    const s = { allowedPaths: ['~'], deniedPaths: ['~/secret'] };
    assert.deepEqual(evalFsReadPaths([path.join(tw.home, 'secret', 'k')], false, s, tw.ws), { kind: 'deny', reasons: ['~/secret'] });
    assert.deepEqual(evalFsReadPaths([path.join(tw.home, 'secret')], true, s, tw.ws), { kind: 'deny', reasons: ['~/secret'] });
    assert.equal(kind(evalFsReadPaths([path.join(tw.home, 'temp')], false, s, tw.ws)), 'allow');
  });
  it('fs_read: deny beats the cwd auto-allow; * crosses / (globset)', () => {
    const s = { deniedPaths: ['*.env'] };
    assert.deepEqual(evalFsReadPaths([path.join(tw.root, 'a', 'b.env')], false, s, tw.ws), { kind: 'deny', reasons: ['*.env'] });
    assert.equal(kind(evalFsReadPaths([path.join(tw.root, 'a', 'b.txt')], false, s, tw.ws)), 'allow');
  });
  it('fs_read: ** patterns', () => {
    const s = { deniedPaths: ['./src/**'] };
    assert.equal(kind(evalFsReadPaths([path.join(tw.root, 'src', 'a.ts')], false, s, tw.ws)), 'deny');
    assert.equal(kind(evalFsReadPaths([path.join(tw.root, 'other.ts')], false, s, tw.ws)), 'allow');
  });
  it('fs_read: allowReadOnly / allowlisted read anywhere (deny still wins)', () => {
    assert.equal(kind(evalFsReadPaths(['/etc/passwd'], false, { allowReadOnly: true }, tw.ws)), 'allow');
    assert.equal(kind(evalFsReadPaths(['/etc/passwd'], true, undefined, tw.ws)), 'allow');
    assert.equal(kind(evalFsReadPaths(['/etc/passwd'], true, { deniedPaths: ['/etc'] }, tw.ws)), 'deny');
  });
  it('fs_read: several paths — any deny wins, any outside asks', () => {
    const a = path.join(tw.root, 'x');
    assert.equal(kind(evalFsReadPaths([a, '/etc/passwd'], false, undefined, tw.ws)), 'ask');
    assert.equal(kind(evalFsReadPaths([a, '/etc/passwd'], false, { deniedPaths: ['/etc/passwd'] }, tw.ws)), 'deny');
  });
  it('fs_read: malformed settings ⇒ ask', () => {
    assert.equal(kind(evalFsReadPaths([path.join(tw.root, 'x')], false, { allowedPaths: 'x' }, tw.ws)), 'ask');
    assert.equal(kind(evalFsReadPaths([path.join(tw.root, 'x')], false, [], tw.ws)), 'ask');
  });
  it('fs_write: no settings ⇒ allowedTools decides; no cwd auto-allow', () => {
    const p = path.join(tw.root, 'src', 'a.ts');
    assert.equal(kind(evalFsWritePath(p, false, undefined, tw.ws)), 'ask');
    assert.equal(kind(evalFsWritePath(p, true, undefined, tw.ws)), 'allow');
    assert.equal(kind(evalFsWritePath(p, false, {}, tw.ws)), 'ask');
  });
  it('fs_write: allowedPaths / deniedPaths (deny beats allowedTools)', () => {
    const s = { allowedPaths: ['./src'], deniedPaths: ['./src/generated', '**/*.lock'] };
    assert.equal(kind(evalFsWritePath(path.join(tw.root, 'src', 'a.ts'), false, s, tw.ws)), 'allow');
    assert.equal(kind(evalFsWritePath(path.join(tw.root, 'src', 'new', 'b.ts'), false, s, tw.ws)), 'allow');
    assert.equal(kind(evalFsWritePath(path.join(tw.root, 'README.md'), false, s, tw.ws)), 'ask');
    assert.deepEqual(evalFsWritePath(path.join(tw.root, 'src', 'generated', 'x.ts'), true, s, tw.ws), { kind: 'deny', reasons: ['./src/generated'] });
    assert.deepEqual(evalFsWritePath(path.join(tw.root, 'Cargo.lock'), true, s, tw.ws), { kind: 'deny', reasons: ['**/*.lock'] });
    assert.equal(kind(evalFsWritePath(path.join(tw.root, 'x'), false, { deniedPaths: 7 }, tw.ws)), 'ask');
  });
  it('fs_write: not-yet-existing files resolve through their existing ancestor', () => {
    const viaLink = path.join(tw.home, 'link-to-src', 'brand-new.ts');
    assert.equal(kind(evalFsWritePath(viaLink, false, { allowedPaths: ['./src'] }, tw.ws)), 'allow');
  });
});

describe('evalWebFetch / evalSubagent (Kiro 2.x toolsSettings)', () => {
  it('web_fetch', () => {
    assert.equal(evalWebFetch('https://x', false, undefined).kind, 'ask');
    assert.equal(evalWebFetch('https://x', true, undefined).kind, 'allow');
    const s = { trusted: ['https://docs\\.rs/.*'], blocked: ['.*evil.*'] };
    assert.equal(evalWebFetch('https://docs.rs/serde', false, s).kind, 'allow');
    assert.equal(evalWebFetch('https://docs.rs.evil.com/', false, s).kind, 'deny');
    assert.deepEqual(evalWebFetch('https://evil.com', true, s), { kind: 'deny', reasons: ['.*evil.*'] });
    assert.equal(evalWebFetch('https://other.org', false, s).kind, 'ask');
    assert.equal(evalWebFetch('https://other.org', true, s).kind, 'allow');
    assert.equal(evalWebFetch('https://a', true, { blocked: ['('] }).kind, 'deny', 'invalid blocked regex ⇒ deny all');
    assert.equal(evalWebFetch('https://a', false, { trusted: ['(', 'https://a'] }).kind, 'allow', 'invalid trusted regex skipped');
    assert.equal(evalWebFetch('https://a', false, { trusted: 'x' }).kind, 'ask');
  });
  it('use_subagent', () => {
    assert.equal(evalSubagent('rev', false, undefined).kind, 'ask');
    assert.equal(evalSubagent('rev', true, undefined).kind, 'allow');
    const s = { availableAgents: ['rev*', 'planner'], trustedAgents: ['reviewer'] };
    assert.equal(evalSubagent('reviewer', false, s).kind, 'allow');
    assert.equal(evalSubagent('rev2', false, s).kind, 'ask');
    assert.equal(evalSubagent('rev2', true, s).kind, 'allow');
    assert.equal(evalSubagent('writer', true, s).kind, 'deny', 'not in availableAgents beats allowedTools');
    assert.equal(evalSubagent('writer', false, { trustedAgents: ['*'] }).kind, 'allow', 'availableAgents absent = all');
    assert.equal(evalSubagent('writer', false, { availableAgents: [1] }).kind, 'ask');
  });
});

describe('evaluateQ dispatcher (06 §1.4, §1.6, 00 §4.3)', () => {
  let tw: TempWs;
  before(() => {
    tw = makeWs();
  });
  after(() => tw.cleanup());
  const call = (name: string, input: Record<string, unknown>) => toKiroCall(name, input, { cwd: tw.ws.cwd });
  const q = (name: string, input: Record<string, unknown>, a: Partial<KiroAgent> = {}, t = emptyTrust(), opts = {}) =>
    evaluateQ(call(name, input), makeAgent(a), t, tw.ws, opts);

  it('Bash uses the full command (execute_bash settings by alias key `shell`)', () => {
    assert.equal(q('Bash', { command: 'ls' }).kind, 'ask');
    assert.equal(q('Bash', { command: 'ls' }, { toolsSettings: { shell: { autoAllowReadonly: true } } }).kind, 'allow');
    assert.equal(q('Bash', { command: 'git push' }, { toolsSettings: { execute_bash: { deniedCommands: ['git push.*'] } } }).kind, 'deny');
    assert.equal(q('Bash', { command: 'ls; rm x' }, { toolsSettings: { execute_bash: { autoAllowReadonly: true } } }).kind, 'ask');
  });
  it('allowedTools aliases (shell, read, write, @builtin)', () => {
    assert.equal(q('Bash', { command: 'rm x' }, { allowedTools: ['shell'] }).kind, 'allow');
    assert.equal(q('Bash', { command: 'rm x' }, { allowedTools: ['execute_cmd'] }).kind, 'allow');
    assert.equal(q('Read', { file_path: '/etc/passwd' }, { allowedTools: ['read'] }).kind, 'allow');
    assert.equal(q('Write', { file_path: '/tmp/x' }, { allowedTools: ['write'] }).kind, 'allow');
    assert.equal(q('Write', { file_path: '/tmp/x' }, { allowedTools: ['@builtin'] }).kind, 'allow');
    assert.equal(q('Write', { file_path: '/tmp/x' }, { allowedTools: ['fs_*'] }).kind, 'allow');
    assert.equal(q('Write', { file_path: '/tmp/x' }, { allowedTools: ['fs_read'] }).kind, 'ask');
  });
  it('Read: cwd auto-allow and toolsSettings.read alias', () => {
    assert.equal(q('Read', { file_path: path.join(tw.root, 'x') }).kind, 'allow');
    assert.equal(q('Read', { file_path: '/etc/passwd' }).kind, 'ask');
    assert.equal(q('Read', { file_path: path.join(tw.root, '.env') }, { toolsSettings: { read: { deniedPaths: ['.env'] } } }).kind, 'deny');
  });
  it('Glob/Grep: own settings first, else fs_read settings; allowlist glob|grep|fs_read', () => {
    const fsRead = { fs_read: { allowedPaths: ['/opt'] } };
    assert.equal(q('Grep', { pattern: 'x', path: '/opt/lib' }, { toolsSettings: fsRead }).kind, 'allow');
    assert.equal(q('Grep', { pattern: 'x', path: '/opt/lib' }, { toolsSettings: { ...fsRead, grep: { allowedPaths: ['/srv'] } } }).kind, 'ask');
    assert.equal(q('Grep', { pattern: 'x', path: '/srv/a' }, { toolsSettings: { ...fsRead, grep: { allowedPaths: ['/srv'] } } }).kind, 'allow');
    assert.equal(q('Glob', { pattern: '*', path: '/var' }, { allowedTools: ['glob'] }).kind, 'allow');
    assert.equal(q('Glob', { pattern: '*', path: '/var' }, { allowedTools: ['fs_read'] }).kind, 'allow');
    assert.equal(q('Glob', { pattern: '*', path: '/var' }, { allowedTools: ['grep'] }).kind, 'ask');
    assert.equal(q('Glob', { pattern: '**/*.ts' }).kind, 'allow', 'search of the cwd');
    assert.equal(q('Glob', { pattern: '/etc/**' }).kind, 'ask', 'absolute pattern escapes the cwd');
    assert.equal(q('Grep', { pattern: 'k', path: '/etc' }, { toolsSettings: { glob: { allowReadOnly: true } } }).kind, 'ask', 'glob settings do not apply to grep');
    assert.equal(q('Glob', { pattern: 'k', path: '/etc' }, { toolsSettings: { glob: { allowReadOnly: true } } }).kind, 'allow');
  });
  it('Write/Edit/NotebookEdit', () => {
    assert.equal(q('Edit', { file_path: path.join(tw.root, 'a') }).kind, 'ask', 'no cwd auto-allow for writes');
    assert.equal(q('NotebookEdit', { notebook_path: path.join(tw.root, 'n.ipynb') }, { toolsSettings: { fs_write: { allowedPaths: ['.'] } } }).kind, 'allow');
    assert.equal(q('Edit', { file_path: path.join(tw.root, 'k.pem') }, { allowedTools: ['fs_write'], toolsSettings: { write: { deniedPaths: ['*.pem'] } } }).kind, 'deny');
  });
  it('WebFetch / WebSearch', () => {
    assert.equal(q('WebFetch', { url: 'https://a.b' }).kind, 'ask');
    assert.equal(q('WebFetch', { url: 'https://docs.rs/x' }, { toolsSettings: { web_fetch: { trusted: ['https://docs\\.rs/.*'] } } }).kind, 'allow');
    assert.equal(q('WebSearch', { query: 'x' }).kind, 'ask');
    assert.equal(q('WebSearch', { query: 'x' }, { allowedTools: ['web_search'] }).kind, 'allow');
  });
  it('Agent (use_subagent) with alias settings key `subagent`', () => {
    assert.equal(q('Agent', { subagent_type: 'rev', prompt: 'p' }).kind, 'ask');
    assert.equal(q('Agent', { subagent_type: 'rev', prompt: 'p' }, { allowedTools: ['subagent'] }).kind, 'allow');
    assert.equal(q('Agent', { subagent_type: 'rev', prompt: 'p' }, { toolsSettings: { subagent: { trustedAgents: ['rev'] } } }).kind, 'allow');
    assert.equal(q('Task', { subagent_type: 'x', prompt: 'p' }, { toolsSettings: { use_subagent: { availableAgents: ['rev'] } } }).kind, 'deny');
  });
  it('todo_list / skill always allowed', () => {
    for (const t of ['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TaskStop']) assert.equal(q(t, {}).kind, 'allow', t);
    assert.equal(q('Skill', { skill: 'kiro:x' }).kind, 'allow');
  });
  it('unknown tools: allowlisted ? allow : ask', () => {
    assert.equal(q('LSP', {}).kind, 'ask');
    assert.equal(q('LSP', {}, { allowedTools: ['LSP'] }).kind, 'allow');
    assert.equal(q('LSP', {}, { allowedTools: ['*'] }).kind, 'allow');
  });
  it('MCP: only @-entries count; server and tool level; autoApprove', () => {
    const c = 'mcp__git__status';
    assert.equal(q(c, {}).kind, 'ask');
    assert.equal(q(c, {}, { allowedTools: ['*'] }).kind, 'ask', '"*" trusts no MCP tools');
    assert.equal(q(c, {}, { allowedTools: ['@builtin'] }).kind, 'ask');
    assert.equal(q(c, {}, { allowedTools: ['@*'] }).kind, 'allow');
    assert.equal(q(c, {}, { allowedTools: ['@git'] }).kind, 'allow');
    assert.equal(q(c, {}, { allowedTools: ['@git/status'] }).kind, 'allow');
    assert.equal(q(c, {}, { allowedTools: ['@git/st*'] }).kind, 'allow');
    assert.equal(q(c, {}, { allowedTools: ['@git/push'] }).kind, 'ask');
    assert.equal(q(c, {}, {}, emptyTrust(), { mcpAutoApprove: ['status'] }).kind, 'allow');
    assert.equal(q(c, {}, {}, emptyTrust(), { mcpAutoApprove: ['*'] }).kind, 'allow');
    assert.equal(q(c, {}, {}, emptyTrust(), { mcpAutoApprove: ['push'] }).kind, 'ask');
  });
  it('trust-all: ask ⇒ allow, deny stays deny (06 §1.6)', () => {
    const t = emptyTrust({ trustAll: true });
    assert.equal(q('Bash', { command: 'rm -rf x' }, {}, t).kind, 'allow');
    assert.equal(q('mcp__a__b', {}, {}, t).kind, 'allow');
    assert.equal(q('Bash', { command: 'git push' }, { toolsSettings: { execute_bash: { deniedCommands: ['git .*'] } } }, t).kind, 'deny');
    assert.equal(q('Read', { file_path: '/etc/shadow' }, { toolsSettings: { fs_read: { deniedPaths: ['/etc/shadow'] } } }, t).kind, 'deny');
    assert.equal(q('Bash', { command: 'x' }, { toolsSettings: { execute_bash: { allowedCommands: ['ls'], denyByDefault: true } } }, t).kind, 'deny');
  });
  it('session allowedTools are appended (and normalized)', () => {
    assert.equal(q('Bash', { command: 'make' }, {}, emptyTrust({ allowedTools: ['shell'] })).kind, 'allow');
    assert.equal(q('mcp__git__push', {}, {}, emptyTrust({ allowedTools: ['@git/push'] })).kind, 'allow');
    assert.equal(q('Write', { file_path: '/tmp/z' }, {}, emptyTrust({ allowedTools: ['fsWrite'] })).kind, 'allow');
    assert.equal(q('Bash', { command: 'git push' }, { toolsSettings: { shell: { deniedCommands: ['git .*'] } } }, emptyTrust({ allowedTools: ['shell'] })).kind, 'deny');
  });
  it('evaluateQRaw ignores trust-all', () => {
    const r = evaluateQRaw(call('Bash', { command: 'rm x' }), makeAgent(), emptyTrust({ trustAll: true }), tw.ws);
    assert.equal(r.kind, 'ask');
  });
});

describe('helpers', () => {
  it('toolSettings resolves alias keys in priority order', () => {
    const a = makeAgent({ toolsSettings: { shell: { a: 1 }, execute_bash: { b: 2 } } });
    assert.deepEqual(toolSettings(a, 'execute_bash'), { b: 2 });
    assert.deepEqual(toolSettings(makeAgent({ toolsSettings: { fsRead: { c: 3 } } }), 'fs_read'), { c: 3 });
    assert.equal(toolSettings(makeAgent(), 'fs_read'), undefined);
    assert.equal(toolSettings(makeAgent(), 'toString'), undefined, 'prototype keys are not settings');
  });
  it('effectiveAllowedTools keeps raw and normalized spellings', () => {
    const r = effectiveAllowedTools(makeAgent({ allowedTools: ['read', '@git'] }), emptyTrust({ allowedTools: ['shell'] }));
    assert.deepEqual(new Set(r), new Set(['read', 'fs_read', '@git', 'shell', 'execute_bash']));
  });
});

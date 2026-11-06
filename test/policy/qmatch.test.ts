/**
 * Q pattern primitives — every vector from 06 Appendix A test.mjs (pattern_matching.rs,
 * tool_permission_checker.rs, globset shapes, hook matcher vectors).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hookMatchesTool, isToolInAllowlist, matchesAnyPattern } from '../../src/policy/qmatch.js';
import { globMatch } from '../../src/util/glob.js';

describe('matchesAnyPattern (pattern_matching.rs)', () => {
  it('exact', () => {
    assert.ok(matchesAnyPattern(['fs_read'], 'fs_read'));
    assert.ok(!matchesAnyPattern(['fs_read'], 'fs_write'));
  });
  it('wildcard', () => {
    assert.ok(matchesAnyPattern(['fs_*'], 'fs_read'));
    assert.ok(matchesAnyPattern(['fs_*'], 'fs_write'));
    assert.ok(!matchesAnyPattern(['fs_*'], 'execute_bash'));
  });
  it('mcp', () => {
    assert.ok(matchesAnyPattern(['@mcp-server/*'], '@mcp-server/tool1'));
    assert.ok(!matchesAnyPattern(['@mcp-server/*'], '@other-server/tool'));
  });
  it('question mark', () => {
    assert.ok(matchesAnyPattern(['fs_?ead'], 'fs_read'));
    assert.ok(!matchesAnyPattern(['fs_?ead'], 'fs_write'));
  });
  it('glob only when the pattern has * or ?', () => {
    assert.ok(!matchesAnyPattern(['[f]s_read'], 'fs_read'));
    assert.ok(matchesAnyPattern(['[f]s_rea?'], 'fs_read'));
    assert.ok(!matchesAnyPattern(['{fs_read,x}'], 'fs_read'));
  });
  it('invalid globs are skipped', () => {
    assert.ok(!matchesAnyPattern(['fs_[*'], 'fs_['));
    assert.ok(matchesAnyPattern(['fs_[*', 'fs_*'], 'fs_read'));
  });
  it('* crosses / (globset literal_separator=false)', () => {
    assert.ok(matchesAnyPattern(['@*'], '@git/status'));
  });
});

describe('isToolInAllowlist (tool_permission_checker.rs)', () => {
  it('native vs mcp', () => {
    const a = new Set(['fs_*', '@git']);
    assert.ok(isToolInAllowlist(a, 'fs_read'));
    assert.ok(!isToolInAllowlist(a, 'fs_read', 'server'));
    assert.ok(isToolInAllowlist(a, 'status', 'git'));
    assert.ok(!isToolInAllowlist(a, 'git'));
  });
  it('mcp wildcard', () => {
    const a = new Set(['@*quip*', '@git/read_*']);
    assert.ok(isToolInAllowlist(a, 'tool', 'quip-server'));
    assert.ok(isToolInAllowlist(a, 'read_file', 'git'));
    assert.ok(!isToolInAllowlist(a, 'write_file', 'git'));
  });
  it('builtin', () => {
    let a = new Set(['@builtin', '@builtin/', '@builtin/*']);
    assert.ok(isToolInAllowlist(a, 'fs_read'));
    assert.ok(!isToolInAllowlist(a, 'tool', 'server'));
    a = new Set(['@builtin/fs_read']);
    assert.ok(isToolInAllowlist(a, 'fs_read'));
    assert.ok(!isToolInAllowlist(a, 'fs_write'));
    a = new Set(['@builtin/fs_*']);
    assert.ok(isToolInAllowlist(a, 'fs_read'));
    assert.ok(isToolInAllowlist(a, 'fs_write'));
  });
  it('each @builtin spelling alone trusts natives', () => {
    for (const s of ['@builtin', '@builtin/', '@builtin/*']) assert.ok(isToolInAllowlist([s], 'execute_bash'), s);
  });
  it('star', () => {
    const a = new Set(['*']);
    assert.ok(isToolInAllowlist(a, 'fs_write'));
    assert.ok(!isToolInAllowlist(a, 'x', 'git'));
    assert.ok(isToolInAllowlist(new Set(['@*']), 'x', 'git'));
  });
  it('empty allowlist trusts nothing', () => {
    assert.ok(!isToolInAllowlist([], 'fs_read'));
    assert.ok(!isToolInAllowlist([], 'x', 'git'));
  });
});

describe('globset shapes (Appendix A)', () => {
  const g = (p: string, s: string): boolean => globMatch(p, s, 'globset');
  const vectors: Array<[string, string, boolean]> = [
    ['**', 'anything/at/all', true],
    ['/a/**', '/a/b/c', true],
    ['/a/**', '/a', false],
    ['/a/**', '/a/', true],
    ['/a/**/b', '/a/b', true],
    ['/a/**/b', '/a/x/y/b', true],
    ['**/foo', 'foo', true],
    ['**/foo', 'x/y/foo', true],
    ['**/foo', '/foo', true],
    ['/cwd/*.env', '/cwd/a/b.env', true],
    ['/x/{a,b}/y', '/x/b/y', true],
    ['/x/{a,b}/y', '/x/c/y', false],
    ['/x/[!a]', '/x/b', true],
    ['/x/[!a]', '/x/a', false],
    ['a**', 'abc/def', true],
    ['\\*', '*', true],
    ['\\*', 'a', false],
  ];
  for (const [p, s, e] of vectors) it(`${p} ~ ${s} = ${e}`, () => assert.equal(g(p, s), e));
});

describe('hookMatchesTool (hooks.rs vectors)', () => {
  const v: Array<[string | undefined, string, boolean]> = [
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
  for (const [m, tn, e] of v) it(`${String(m)} vs ${tn} = ${e}`, () => assert.equal(hookMatchesTool(m, tn), e));
  it('null matcher matches', () => assert.ok(hookMatchesTool(null, 'fs_read')));
});

/** Rust regex → JS translation (06 §1.4.1). */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { anchoredRustRegex, compileRustRegex, translateRustRegex } from '../../src/policy/rustregex.js';

const m = (p: string, s: string): boolean | null => {
  const re = anchoredRustRegex(p);
  return re === null ? null : re.test(s);
};

describe('anchoredRustRegex — faithful concatenated anchoring', () => {
  const table: Array<[string, string, boolean | null]> = [
    ['git .*', 'git status', true],
    ['git .*', 'xgit status', false],
    ['git status', 'git status --short', false],
    ['ls', 'ls', true],
    // `\A a|b \z` = starts with a OR ends with b (06 §1.4.1)
    ['a|b', 'axxx', true],
    ['a|b', 'xxxb', true],
    ['a|b', 'xxx', false],
    ['^git status$', 'git status', true],
    ['^rm -rf', 'rm -rf', true],
    ['^rm -rf', 'rm -rf /', false],
    ['command subcommand a=[0-9]{10} b=[0-9]{10}', 'command subcommand a=0123456789 b=0123456789', true],
    // JS `$` does not match before a trailing newline (Rust \z)
    ['ls', 'ls\n', false],
  ];
  for (const [p, s, e] of table) it(`${p} ~ ${JSON.stringify(s)}`, () => assert.equal(m(p, s), e));
});

describe('unsupported Rust constructs are invalid (null)', () => {
  for (const p of ['^(?!ls$).*', '(?=a)a', '(?<=a)b', '(?<!a)b', '(a)\\1', '\\k<x>', '(?P<x>a)(?P=x)', '[a&&b]', '[a--b]', '[a~~b]', '[[:^alpha:]]', '\\q', 'a{', '{', '(?U)a+', '[abc', '(a', '\\0']) {
    it(p, () => assert.equal(compileRustRegex(p), null));
  }
});

describe('Rust syntax translated', () => {
  it('inline flags', () => {
    assert.equal(m('(?i)git status', 'GIT STATUS'), true);
    assert.equal(m('(?i:git) status', 'GIT status'), true);
    assert.equal(m('(?s)a.b', 'a\nb'), true);
    assert.equal(m('a.b', 'a\nb'), false);
    assert.equal(m('(?x) git \\ status # comment', 'git status'), true);
  });
  it('named groups', () => {
    assert.equal(m('(?P<cmd>git) (?<sub>status)', 'git status'), true);
  });
  it('\\A and \\z inside the pattern', () => {
    assert.equal(m('\\Agit\\z', 'git'), true);
    assert.equal(m('(?m)a\\z', 'a\nb'), false);
  });
  it('multiline flag keeps whole-input anchoring', () => {
    assert.equal(m('(?m)a', 'a\nb'), false);
    assert.equal(m('(?m)a\nb', 'a\nb'), true);
  });
  it('POSIX classes and nested classes', () => {
    assert.equal(m('[[:digit:]]+', '123'), true);
    assert.equal(m('[[:digit:]]+', '12a'), false);
    assert.equal(m('[[:alpha:][:digit:]_]+', 'ab_12'), true);
    assert.equal(m('[a[bc]]+', 'abcab'), true);
    assert.equal(m('[]a]+', ']a]'), true);
  });
  it('unicode escapes and properties', () => {
    assert.equal(m('\\pL+', 'héllo'), true);
    assert.equal(m('\\p{L}+', 'abc'), true);
    assert.equal(m('\\x{e9}', 'é'), true);
    assert.equal(m('\\u{e9}', 'é'), true);
    assert.equal(m('\\x41', 'A'), true);
  });
  it('escaped punctuation works in unicode mode', () => {
    assert.equal(m('\\pL+\\-\\#\\ x', 'ab-# x'), true);
    assert.equal(m('a\\.b', 'a.b'), true);
    assert.equal(m('a\\.b', 'axb'), false);
  });
  it('word boundary forms', () => {
    assert.equal(m('.*\\bgit\\b.*', 'run git now'), true);
    assert.equal(m('.*\\<git\\>.*', 'run git now'), true);
  });
  it('counted repetitions are kept', () => {
    assert.equal(m('a{2,3}', 'aaa'), true);
    assert.equal(m('a{2,}', 'aaaa'), true);
    assert.equal(m('a{2}', 'aaa'), false);
  });
  it('translation output shape', () => {
    assert.deepEqual(translateRustRegex('(?i)ab'), { source: 'ab', flags: 'i' });
    assert.deepEqual(translateRustRegex('a/b'), { source: 'a\\/b', flags: '' });
  });
});

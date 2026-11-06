import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  expandBraces,
  GlobPatternError,
  globMatch,
  globToRegExp,
  hasGlobMeta,
  validateGlob,
  walkGlob,
  wildcardMatch,
  type GlobDialect,
} from '../../src/util/glob.js';

const posixOnly = process.platform === 'win32' ? { skip: 'POSIX path semantics' } : {};

/**
 * globset 0.4.17 `matches!` / `nmatches!` vectors with default options, extracted verbatim from
 * the crate's src/glob.rs test module (Unix variants). [name, pattern, subject, expected]
 */
const GLOBSET_VECTORS: Array<[string, string, string, boolean]> = [
  ['match1', 'a', 'a', true],
  ['match2', 'a*b', 'a_b', true],
  ['match3', 'a*b*c', 'abc', true],
  ['match4', 'a*b*c', 'a_b_c', true],
  ['match5', 'a*b*c', 'a___b___c', true],
  ['match6', 'abc*abc*abc', 'abcabcabcabcabcabcabc', true],
  ['match7', 'a*a*a*a*a*a*a*a*a', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', true],
  ['match8', 'a*b[xyz]c*d', 'abxcdbxcddd', true],
  ['match9', '*.rs', '.rs', true],
  ['match10', '☃', '☃', true],
  ['matchrec1', 'some/**/needle.txt', 'some/needle.txt', true],
  ['matchrec2', 'some/**/needle.txt', 'some/one/needle.txt', true],
  ['matchrec3', 'some/**/needle.txt', 'some/one/two/needle.txt', true],
  ['matchrec4', 'some/**/needle.txt', 'some/other/needle.txt', true],
  ['matchrec5', '**', 'abcde', true],
  ['matchrec6', '**', '', true],
  ['matchrec7', '**', '.asdf', true],
  ['matchrec8', '**', '/x/.asdf', true],
  ['matchrec9', 'some/**/**/needle.txt', 'some/needle.txt', true],
  ['matchrec10', 'some/**/**/needle.txt', 'some/one/needle.txt', true],
  ['matchrec11', 'some/**/**/needle.txt', 'some/one/two/needle.txt', true],
  ['matchrec12', 'some/**/**/needle.txt', 'some/other/needle.txt', true],
  ['matchrec13', '**/test', 'one/two/test', true],
  ['matchrec14', '**/test', 'one/test', true],
  ['matchrec15', '**/test', 'test', true],
  ['matchrec16', '/**/test', '/one/two/test', true],
  ['matchrec17', '/**/test', '/one/test', true],
  ['matchrec18', '/**/test', '/test', true],
  ['matchrec19', '**/.*', '.abc', true],
  ['matchrec20', '**/.*', 'abc/.abc', true],
  ['matchrec21', '**/foo/bar', 'foo/bar', true],
  ['matchrec22', '.*/**', '.abc/abc', true],
  ['matchrec23', 'test/**', 'test/', true],
  ['matchrec24', 'test/**', 'test/one', true],
  ['matchrec25', 'test/**', 'test/one/two', true],
  ['matchrec26', 'some/*/needle.txt', 'some/one/needle.txt', true],
  ['matchrange1', 'a[0-9]b', 'a0b', true],
  ['matchrange2', 'a[0-9]b', 'a9b', true],
  ['matchrange3', 'a[!0-9]b', 'a_b', true],
  ['matchrange4', '[a-z123]', '1', true],
  ['matchrange5', '[1a-z23]', '1', true],
  ['matchrange6', '[123a-z]', '1', true],
  ['matchrange7', '[abc-]', '-', true],
  ['matchrange8', '[-abc]', '-', true],
  ['matchrange9', '[-a-c]', 'b', true],
  ['matchrange10', '[a-c-]', 'b', true],
  ['matchrange11', '[-]', '-', true],
  ['matchrange12', 'a[^0-9]b', 'a_b', true],
  ['matchpat1', '*hello.txt', 'hello.txt', true],
  ['matchpat2', '*hello.txt', 'gareth_says_hello.txt', true],
  ['matchpat3', '*hello.txt', 'some/path/to/hello.txt', true],
  ['matchpat4', '*hello.txt', 'some\\path\\to\\hello.txt', true],
  ['matchpat5', '*hello.txt', '/an/absolute/path/to/hello.txt', true],
  ['matchpat6', '*some/path/to/hello.txt', 'some/path/to/hello.txt', true],
  ['matchpat7', '*some/path/to/hello.txt', 'a/bigger/some/path/to/hello.txt', true],
  ['matchescape', '_[[]_[]]_[?]_[*]_!_', '_[_]_?_*_!_', true],
  ['matchalt1', 'a,b', 'a,b', true],
  ['matchalt2', ',', ',', true],
  ['matchalt3', '{a,b}', 'a', true],
  ['matchalt4', '{a,b}', 'b', true],
  ['matchalt5', '{**/src/**,foo}', 'abc/src/bar', true],
  ['matchalt6', '{**/src/**,foo}', 'foo', true],
  ['matchalt7', '{[}],foo}', '}', true],
  ['matchalt8', '{foo}', 'foo', true],
  ['matchalt9', '{}', '', true],
  ['matchalt10', '{,}', '', true],
  ['matchalt11', '{*.foo,*.bar,*.wat}', 'test.foo', true],
  ['matchalt12', '{*.foo,*.bar,*.wat}', 'test.bar', true],
  ['matchalt13', '{*.foo,*.bar,*.wat}', 'test.wat', true],
  ['matchalt14', 'foo{,.txt}', 'foo.txt', true],
  ['matchalt15', 'foo{,.txt}', 'foo', false],
  ['matchalt17', '{a,b{c,d}}', 'bc', true],
  ['matchalt18', '{a,b{c,d}}', 'bd', true],
  ['matchalt19', '{a,b{c,d}}', 'a', true],
  ['matchbackslash7', '\\a', 'a', true],
  ['matchnot1', 'a*b*c', 'abcd', false],
  ['matchnot2', 'abc*abc*abc', 'abcabcabcabcabcabcabca', false],
  ['matchnot3', 'some/**/needle.txt', 'some/other/notthis.txt', false],
  ['matchnot4', 'some/**/**/needle.txt', 'some/other/notthis.txt', false],
  ['matchnot5', '/**/test', 'test', false],
  ['matchnot6', '/**/test', '/one/notthis', false],
  ['matchnot7', '/**/test', '/notthis', false],
  ['matchnot8', '**/.*', 'ab.c', false],
  ['matchnot9', '**/.*', 'abc/ab.c', false],
  ['matchnot10', '.*/**', 'a.bc', false],
  ['matchnot11', '.*/**', 'abc/a.bc', false],
  ['matchnot12', 'a[0-9]b', 'a_b', false],
  ['matchnot13', 'a[!0-9]b', 'a0b', false],
  ['matchnot14', 'a[!0-9]b', 'a9b', false],
  ['matchnot15', '[!-]', '-', false],
  ['matchnot16', '*hello.txt', 'hello.txt-and-then-some', false],
  ['matchnot17', '*hello.txt', 'goodbye.txt', false],
  ['matchnot18', '*some/path/to/hello.txt', 'some/path/to/hello.txt-and-then-some', false],
  ['matchnot19', '*some/path/to/hello.txt', 'some/other/path/to/hello.txt', false],
  ['matchnot20', 'a', 'foo/a', false],
  ['matchnot21', './foo', 'foo', false],
  ['matchnot22', '**/foo', 'foofoo', false],
  ['matchnot23', '**/foo/bar', 'foofoo/bar', false],
  ['matchnot24', '/*.c', 'mozilla-sha1/sha1.c', false],
  ['matchnot27', 'a[^0-9]b', 'a0b', false],
  ['matchnot28', 'a[^0-9]b', 'a9b', false],
  ['matchnot29', '[^-]', '-', false],
  ['matchnot30', 'some/*/needle.txt', 'some/needle.txt', false],
  ['matchrec33', '.*/**', '.abc', false],
  ['matchrec34', 'foo/**', 'foo', false],
];

describe('glob: globset dialect (Rust globset defaults, 06 §1.2)', () => {
  it(`passes all ${GLOBSET_VECTORS.length} globset crate vectors`, () => {
    const failures: string[] = [];
    for (const [name, pat, subj, want] of GLOBSET_VECTORS) {
      if (globMatch(pat, subj, 'globset') !== want) failures.push(`${name}: ${JSON.stringify(pat)} vs ${JSON.stringify(subj)} expected ${want}`);
    }
    assert.deepEqual(failures, []);
  });

  it('`*` and `?` cross `/` (literal_separator = false)', () => {
    assert.equal(globMatch('*.env', '/cwd/a/b.env', 'globset'), true);
    assert.equal(globMatch('a?b', 'a/b', 'globset'), true);
    assert.equal(globMatch('@*', '@git/status', 'globset'), true);
    assert.equal(globMatch('@*/status', '@git/status', 'globset'), true);
    assert.equal(globMatch('@git-*/*', '@git-x/y', 'globset'), true);
  });

  it('Q allowedTools style patterns (06 §1.3 consequences)', () => {
    assert.equal(globMatch('fs_*', 'fs_read', 'globset'), true);
    assert.equal(globMatch('fs_*', 'fs_write', 'globset'), true);
    assert.equal(globMatch('fs_*', 'execute_bash', 'globset'), false);
    assert.equal(globMatch('@git/read_*', '@git/read_file', 'globset'), true);
    assert.equal(globMatch('@*quip*', '@my-quip-server', 'globset'), true);
    assert.equal(globMatch('*', 'anything/at all', 'globset'), true);
  });

  it('`**` translation rules (06 §1.2 table)', () => {
    assert.equal(globToRegExp('**', 'globset').source, '^[\\s\\S]*$');
    assert.equal(globToRegExp('a/**', 'globset').source, '^a\\/[\\s\\S]*$');
    assert.equal(globToRegExp('a/**/b', 'globset').source, '^a(?:\\/|\\/[\\s\\S]*\\/)b$');
    assert.equal(globToRegExp('**/b', 'globset').source, '^(?:\\/?|[\\s\\S]*\\/)b$');
    assert.equal(globToRegExp('a**', 'globset').source, '^a[\\s\\S]*[\\s\\S]*$');
    assert.equal(globToRegExp('{a,{b,c}}', 'globset').source, '^(?:a|(?:b|c))$');
    assert.equal(globMatch('a/**', 'a', 'globset'), false);
    assert.equal(globMatch('a/**/b', 'a/b', 'globset'), true);
  });

  it('dot matches newline and literal regex characters are escaped', () => {
    assert.equal(globMatch('a*c', 'a\nb\nc', 'globset'), true);
    assert.equal(globMatch('a?c', 'a\nc', 'globset'), true);
    assert.equal(globMatch('a.c', 'abc', 'globset'), false);
    assert.equal(globMatch('(x)+$^|', '(x)+$^|', 'globset'), true);
    assert.equal(globMatch('[.]', '.', 'globset'), true);
    assert.equal(globMatch('[a-]', '-', 'globset'), true);
    assert.equal(globMatch('[\\]', '\\', 'globset'), true);
  });

  it('is case sensitive unless caseInsensitive', () => {
    assert.equal(globMatch('aBcDeFg', 'abcdefg', 'globset'), false);
    assert.equal(globMatch('aBcDeFg', 'abcdefg', 'globset', { caseInsensitive: true }), true);
    assert.equal(globMatch('aBcDeFg', 'ABCDEFG', 'globset', { caseInsensitive: true }), true);
  });

  it('invalid patterns throw from globToRegExp and never match', () => {
    for (const bad of ['[abc', '{a,b', 'a}', 'abc\\', '[z-a]']) {
      assert.throws(() => globToRegExp(bad, 'globset'), GlobPatternError, bad);
      assert.equal(globMatch(bad, bad, 'globset'), false, bad);
      assert.match(validateGlob(bad, 'globset') ?? '', /invalid globset glob/);
    }
    assert.equal(validateGlob('a*b', 'globset'), undefined);
  });

  it('handles non-BMP characters as single characters', () => {
    assert.equal(globMatch('?', '😀', 'globset'), true);
    assert.equal(globMatch('[😀x]', '😀', 'globset'), true);
  });
});

/** glob 0.3.3 Pattern tests, evaluated with require_literal_separator = true. */
describe("glob: 'path' dialect (Rust glob crate, 06 Appendix B)", () => {
  const yes = (p: string, s: string): void => assert.equal(globMatch(p, s, 'path'), true, `${p} should match ${s}`);
  const no = (p: string, s: string): void => assert.equal(globMatch(p, s, 'path'), false, `${p} should not match ${s}`);

  it('wildcards (test_wildcards)', () => {
    yes('a*b', 'a_b');
    yes('a*b*c', 'abc');
    no('a*b*c', 'abcd');
    yes('a*b*c', 'a_b_c');
    yes('a*b*c', 'a___b___c');
    yes('abc*abc*abc', 'abcabcabcabcabcabcabc');
    no('abc*abc*abc', 'abcabcabcabcabcabcabca');
    yes('a*a*a*a*a*a*a*a*a', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    yes('a*b[xyz]c*d', 'abxcdbxcddd');
  });

  it('recursive wildcards (test_recursive_wildcards)', () => {
    for (const p of ['some/**/needle.txt', 'some/**/**/needle.txt']) {
      yes(p, 'some/needle.txt');
      yes(p, 'some/one/needle.txt');
      yes(p, 'some/one/two/needle.txt');
      yes(p, 'some/other/needle.txt');
      no(p, 'some/other/notthis.txt');
    }
    for (const s of ['abcde', '', '.asdf', '/x/.asdf']) yes('**', s);
    yes('**/test', 'one/two/test');
    yes('**/test', 'one/test');
    yes('**/test', 'test');
    yes('/**/test', '/one/two/test');
    yes('/**/test', '/one/test');
    yes('/**/test', '/test');
    no('/**/test', '/one/notthis');
    no('/**/test', '/notthis');
    yes('**/.*', '.abc');
    yes('**/.*', 'abc/.abc');
    no('**/.*', 'ab.c');
    no('**/.*', 'abc/ab.c');
  });

  it('ranges (test_range_pattern)', () => {
    for (let i = 0; i < 10; i++) {
      yes('a[0-9]b', `a${i}b`);
      no('a[!0-9]b', `a${i}b`);
    }
    no('a[0-9]b', 'a_b');
    yes('a[!0-9]b', 'a_b');
    for (const p of ['[a-z123]', '[1a-z23]', '[123a-z]']) {
      for (const ch of 'abcdefghijklmnopqrstuvwxyz') yes(p, ch);
      for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') assert.equal(globMatch(p, ch, 'path', { caseInsensitive: true }), true);
      yes(p, '1');
      yes(p, '2');
      yes(p, '3');
    }
    for (const p of ['[abc-]', '[-abc]', '[a-c-]']) {
      yes(p, 'a');
      yes(p, 'b');
      yes(p, 'c');
      yes(p, '-');
      no(p, 'd');
    }
    no('[2-1]', '1');
    no('[2-1]', '2');
    yes('[-]', '-');
    no('[!-]', '-');
  });

  it('pattern matches (test_pattern_matches) under literal separators', () => {
    yes('*hello.txt', 'hello.txt');
    yes('*hello.txt', 'gareth_says_hello.txt');
    no('*hello.txt', 'some/path/to/hello.txt'); // `*` does not cross `/`
    no('*hello.txt', 'hello.txt-and-then-some');
    no('*hello.txt', 'goodbye.txt');
    yes('*some/path/to/hello.txt', 'some/path/to/hello.txt');
    no('*some/path/to/hello.txt', 'a/bigger/some/path/to/hello.txt');
  });

  it('escape via brackets (test_pattern_escape)', () => {
    yes('_[[]_[]]_[?]_[*]_!_', '_[_]_?_*_!_');
  });

  it('require_literal_separator vectors', () => {
    yes('abc/def', 'abc/def');
    no('abc?def', 'abc/def');
    no('abc*def', 'abc/def');
    no('abc[/]def', 'abc/def');
    no('abc[!x]def', 'abc/def');
  });

  it('`**` semantics: zero or more whole directories; trailing `**` swallows the rest', () => {
    yes('src/**/*.ts', 'src/a.ts');
    yes('src/**/*.ts', 'src/x/y/a.ts');
    no('src/**/*.ts', 'src/x/y/a.tsx');
    no('src/**/*.ts', 'srcx/a.ts');
    yes('docs/**', 'docs/a/b.md');
    yes('docs/**', 'docs/');
    no('docs/**', 'docs');
    yes('/home/u/.kiro/steering/**/*.md', '/home/u/.kiro/steering/team/x.md');
    yes('.kiro/steering/*.md', '.kiro/steering/product.md');
    no('.kiro/steering/*.md', '.kiro/steering/a/product.md');
  });

  it('braces are literal and `\\` is a literal character (POSIX)', posixOnly, () => {
    yes('{a,b}', '{a,b}');
    no('{a,b}', 'a');
    yes('a\\b', 'a\\b');
    yes('a\\*', 'a\\xyz');
  });

  it('`^` is literal inside classes (only `!` negates)', () => {
    yes('[^a]', '^');
    yes('[^a]', 'a');
    no('[^a]', 'b');
  });

  it('dot-files are matched by wildcards', () => {
    yes('*', '.hidden');
    yes('**/*', 'a/.b/.c');
  });

  it('error cases (test_wildcard_errors / test_unclosed_bracket_errors)', () => {
    const errs: Array<[string, number]> = [
      ['a/**b', 4],
      ['a/bc**', 3],
      ['a/*****', 4],
      ['a/b**c**d', 2],
      ['a**b', 0],
      ['abc[def', 3],
      ['abc[!def', 3],
      ['abc[', 3],
      ['abc[!', 3],
      ['abc[d', 3],
      ['abc[!d', 3],
      ['abc[]', 3],
      ['abc[!]', 3],
    ];
    for (const [p, pos] of errs) {
      let caught: unknown;
      try {
        globToRegExp(p, 'path');
      } catch (e) {
        caught = e;
      }
      assert.ok(caught instanceof GlobPatternError, `${p} should be invalid`);
      assert.equal((caught as GlobPatternError).pos, pos, `${p} error position`);
      assert.equal(globMatch(p, 'abc', 'path'), false);
    }
    yes('[]]', ']');
    yes('[!]]', 'a');
    no('[!]]', ']');
  });

  it('windows option treats backslashes as separators', () => {
    assert.equal(globMatch('src/*.ts', 'src\\a.ts', 'path', { windows: true }), true);
    assert.equal(globMatch('src\\**\\*.ts', 'src/x/a.ts', 'path', { windows: true }), true);
    assert.equal(globMatch('src/*.ts', 'src\\a.ts', 'path', { windows: false }), false);
  });
});

describe("glob: 'v3path' dialect (Kiro V3 permission paths, 02 §2.8)", () => {
  const yes = (p: string, s: string): void => assert.equal(globMatch(p, s, 'v3path'), true, `${p} should match ${s}`);
  const no = (p: string, s: string): void => assert.equal(globMatch(p, s, 'v3path'), false, `${p} should not match ${s}`);

  it('`*` stays within one component, `**` crosses', () => {
    yes('/w/*.ts', '/w/a.ts');
    no('/w/*.ts', '/w/x/a.ts');
    yes('/w/**/*.ts', '/w/x/a.ts');
    yes('/w/**/*.ts', '/w/a.ts');
    yes('/w/**', '/w/a/b/c');
    no('/w/**', '/w');
    no('/w/?', '/w/ab');
    yes('/w/?', '/w/a');
    no('/w/a?b', '/w/a/b');
  });

  it('braces and classes', () => {
    yes('/w/{src,test}/**/*.ts', '/w/src/a/b.ts');
    yes('/w/{src,test}/**/*.ts', '/w/test/b.ts');
    no('/w/{src,test}/**/*.ts', '/w/lib/b.ts');
    yes('/w/*.{js,ts}', '/w/a.ts');
    yes('/w/[abc].md', '/w/b.md');
    no('/w/[!abc].md', '/w/b.md');
    yes('/w/[^abc].md', '/w/d.md');
    no('/w/[^abc]x', '/w//x');
  });

  it('a pattern without wildcards implicitly matches its children', () => {
    yes('/home/u/temp', '/home/u/temp');
    yes('/home/u/temp', '/home/u/temp/a');
    yes('/home/u/temp', '/home/u/temp/a/b.txt');
    no('/home/u/temp', '/home/u/temporary');
    yes('/home/u/temp/', '/home/u/temp/a');
    yes('/home/u/temp/', '/home/u/temp');
    yes('{/a,/b}', '/b/c');
    yes('/', '/anything/at/all');
    // wildcard present ⇒ no implicit children
    no('/home/u/*.txt', '/home/u/a.txt/x');
  });

  it('Kiro invariants style patterns', () => {
    yes('**/.kiroignore', '/w/sub/.kiroignore');
    yes('**/*.code-workspace', '/w/x.code-workspace');
    yes('/w/.git/**', '/w/.git/config');
    yes('/home/u/.kiro/{agents,hooks,workflows,powers}/**', '/home/u/.kiro/hooks/x.json');
    no('/home/u/.kiro/{agents,hooks,workflows,powers}/**', '/home/u/.kiro/settings/cli.json');
  });

  it('lenient `a**` and backslash escapes (POSIX)', posixOnly, () => {
    yes('/w/a**', '/w/abc');
    no('/w/a**', '/w/a/bc');
    yes('/w/\\*', '/w/*');
    no('/w/\\*', '/w/x');
  });

  it('hasGlobMeta drives the implicit-children rule (braces alone are not wildcards)', () => {
    assert.equal(hasGlobMeta('{a,b}', 'v3path'), true);
    yes('/r/{a,b}', '/r/a/deep/file');
  });
});

describe("glob: 'wildcard' dialect (Kiro V3 shell/mcp/subagent)", () => {
  const cases: Array<[string, string, boolean]> = [
    ['git status*', 'git status', true],
    ['git status*', 'git status --short', true],
    ['git status*', 'git stash', false],
    ['npm *', 'npm run build && x', true],
    ['npm *', 'npm', false],
    ['my-server/*', 'my-server/tool_a', true],
    ['my-server/*', 'other/tool_a', false],
    ['*', '', true],
    ['*', 'a b/c', true],
    ['', '', true],
    ['', 'x', false],
    ['a?c', 'abc', false],
    ['a?c', 'a?c', true],
    ['[ab]', 'a', false],
    ['[ab]', '[ab]', true],
    ['{a,b}', '{a,b}', true],
    ['**', 'x/y', true],
    ['which *', 'which node', true],
    ['*.md', 'docs/a.md', true],
    ['a*b*c', 'a_b_c', true],
    ['a*b*c', 'acb', false],
    ['*abc', 'xxabcabc', true],
    ['a*', 'b', false],
    ['git branch', 'git branch -D x', false],
    ['line1*', 'line1\nline2', true],
  ];
  it('matches per table', () => {
    for (const [p, s, want] of cases) {
      assert.equal(globMatch(p, s, 'wildcard'), want, `${p} vs ${s}`);
      assert.equal(globToRegExp(p, 'wildcard').test(s), want, `regex ${p} vs ${s}`);
    }
  });
  it('case-insensitive option', () => {
    assert.equal(globMatch('GIT *', 'git log', 'wildcard', { caseInsensitive: true }), true);
    assert.equal(globMatch('GIT *', 'git log', 'wildcard'), false);
  });
  it('is fast on long subjects (no exponential backtracking)', () => {
    const s = 'a'.repeat(200_000);
    const t0 = Date.now();
    assert.equal(wildcardMatch('*a*a*a*a*a*b', s), false);
    assert.ok(Date.now() - t0 < 2000);
  });
});

describe('glob: hasGlobMeta', () => {
  const table: Array<[string, GlobDialect | undefined, boolean]> = [
    ['plain/path.txt', undefined, false],
    ['a*', undefined, true],
    ['a?', 'globset', true],
    ['[ab]', 'globset', true],
    ['{a,b}', 'globset', true],
    ['\\*', 'globset', false],
    ['{a,b}', 'path', false],
    ['a?', 'path', true],
    ['x[1]', 'path', true],
    ['a?', 'wildcard', false],
    ['a*', 'wildcard', true],
    ['{a,b}', 'v3path', true],
    ['~/temp', 'v3path', false],
  ];
  for (const [s, d, want] of table) {
    it(`${JSON.stringify(s)} in ${d ?? 'default'} ⇒ ${want}`, () => assert.equal(hasGlobMeta(s, d), want));
  }
});

describe('glob: expandBraces', () => {
  it('expands nested alternatives (globset semantics)', () => {
    assert.deepEqual(expandBraces('{a,b}/x'), ['a/x', 'b/x']);
    assert.deepEqual(expandBraces('x{a,b{c,d}}y'), ['xay', 'xbcy', 'xbdy']);
    assert.deepEqual(expandBraces('{.kiro,~/.kiro}/{agents,hooks}/**'), [
      '.kiro/agents/**',
      '.kiro/hooks/**',
      '~/.kiro/agents/**',
      '~/.kiro/hooks/**',
    ]);
    assert.deepEqual(expandBraces('no-braces'), ['no-braces']);
    assert.deepEqual(expandBraces('foo{,.txt}'), ['foo.txt']); // empty alternatives dropped
    assert.deepEqual(expandBraces('{}'), ['']);
    assert.deepEqual(expandBraces('[{]x'), ['[{]x']); // class content is literal
    assert.deepEqual(expandBraces('\\{a,b\\}'), ['\\{a,b\\}']);
    assert.deepEqual(expandBraces('a,b'), ['a,b']);
  });
  it('rejects unbalanced braces and explosions', () => {
    assert.throws(() => expandBraces('{a,b'), GlobPatternError);
    assert.throws(() => expandBraces('a}'), GlobPatternError);
    assert.throws(() => expandBraces('{a,b}'.repeat(13)), /exceeds/);
  });
  it('agrees with v3path matching', () => {
    const pat = '/r/{src,lib}/{a,b}*.ts';
    const subjects = ['/r/src/a1.ts', '/r/lib/b.ts', '/r/src/c.ts', '/r/x/a.ts'];
    for (const s of subjects) {
      const direct = globMatch(pat, s, 'v3path');
      const viaExpand = expandBraces(pat).some((p) => globMatch(p, s, 'v3path'));
      assert.equal(direct, viaExpand, s);
    }
  });
});

describe('glob: walkGlob over a temp tree', () => {
  let root: string;
  const rel = (xs: string[]): string[] => xs.map((x) => path.relative(root, x).split(path.sep).join('/'));

  before(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kc-walk-')));
    const files = [
      'README.md',
      'AGENTS.md',
      '.hidden.md',
      'src/a.ts',
      'src/b.ts',
      'src/b.tsx',
      'src/lib/c.ts',
      'src/lib/deep/d.ts',
      'src/.dot/e.ts',
      'docs/guide.md',
      'docs/api/ref.md',
      'node_modules/pkg/index.ts',
      '.git/config',
      'src/node_modules/x.ts',
      '.kiro/steering/product.md',
      '.kiro/steering/team/tech.md',
      'weird[1].md',
      'sp ace/x.md',
    ];
    for (const f of files) {
      const p = path.join(root, f);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, f);
    }
    fs.mkdirSync(path.join(root, 'emptydir'));
  });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it('single-level wildcard', () => {
    assert.deepEqual(rel(walkGlob('*.md', { cwd: root })), ['.hidden.md', 'AGENTS.md', 'README.md', 'weird[1].md']);
    assert.deepEqual(rel(walkGlob('src/*.ts', { cwd: root })), ['src/a.ts', 'src/b.ts']);
    assert.deepEqual(rel(walkGlob('src/?.ts*', { cwd: root })), ['src/a.ts', 'src/b.ts', 'src/b.tsx']);
  });

  it('recursive `**` (dot-dirs included, ignored dirs skipped)', () => {
    assert.deepEqual(rel(walkGlob('src/**/*.ts', { cwd: root })), [
      'src/.dot/e.ts',
      'src/a.ts',
      'src/b.ts',
      'src/lib/c.ts',
      'src/lib/deep/d.ts',
    ]);
    assert.deepEqual(rel(walkGlob('**/*.md', { cwd: root })), [
      '.hidden.md',
      '.kiro/steering/product.md',
      '.kiro/steering/team/tech.md',
      'AGENTS.md',
      'README.md',
      'docs/api/ref.md',
      'docs/guide.md',
      'sp ace/x.md',
      'weird[1].md',
    ]);
  });

  it('steering-style patterns', () => {
    assert.deepEqual(rel(walkGlob('.kiro/steering/**/*.md', { cwd: root })), [
      '.kiro/steering/product.md',
      '.kiro/steering/team/tech.md',
    ]);
    assert.deepEqual(rel(walkGlob('.kiro/steering/*.md', { cwd: root })), ['.kiro/steering/product.md']);
  });

  it('trailing `**` returns every file below (deviation from the Rust walker)', () => {
    assert.deepEqual(rel(walkGlob('docs/**', { cwd: root })), ['docs/api/ref.md', 'docs/guide.md']);
    assert.deepEqual(rel(walkGlob('docs/**', { cwd: root, onlyFiles: false })), ['docs/api', 'docs/api/ref.md', 'docs/guide.md']);
  });

  it('ignoreDirs apply to wildcard traversal but not to literal components', () => {
    assert.deepEqual(rel(walkGlob('**/index.ts', { cwd: root })), []);
    assert.deepEqual(rel(walkGlob('node_modules/**/*.ts', { cwd: root })), ['node_modules/pkg/index.ts']);
    assert.deepEqual(rel(walkGlob('**/index.ts', { cwd: root, ignoreDirs: [] })), ['node_modules/pkg/index.ts']);
    assert.deepEqual(rel(walkGlob('**/config', { cwd: root })), []);
    assert.deepEqual(rel(walkGlob('src/**/x.ts', { cwd: root })), []);
  });

  it('literal patterns (no meta) return the path when it exists', () => {
    assert.deepEqual(rel(walkGlob('README.md', { cwd: root })), ['README.md']);
    assert.deepEqual(walkGlob('missing.md', { cwd: root }), []);
    assert.deepEqual(walkGlob('src', { cwd: root }), []); // a directory with onlyFiles (default)
    assert.deepEqual(rel(walkGlob('src', { cwd: root, onlyFiles: false })), ['src']);
    assert.deepEqual(rel(walkGlob(path.join(root, 'docs', 'guide.md'), { cwd: '/' })), ['docs/guide.md']);
  });

  it('absolute and ~ patterns', () => {
    assert.deepEqual(rel(walkGlob(`${root.split(path.sep).join('/')}/docs/*.md`, { cwd: os.tmpdir() })), ['docs/guide.md']);
    const env = { ...process.env, HOME: root, USERPROFILE: root };
    assert.deepEqual(rel(walkGlob('~/docs/**/*.md', { cwd: os.tmpdir(), env })), ['docs/api/ref.md', 'docs/guide.md']);
  });

  it('onlyFiles=false and trailing slash (directories only)', () => {
    assert.deepEqual(rel(walkGlob('src/*', { cwd: root, onlyFiles: false })), ['src/.dot', 'src/a.ts', 'src/b.ts', 'src/b.tsx', 'src/lib']);
    // dot-dirs match `*`; .git and node_modules are ignored by default
    assert.deepEqual(rel(walkGlob('*/', { cwd: root })), ['.kiro', 'docs', 'emptydir', 'sp ace', 'src']);
  });

  it('classes and escapes via brackets', () => {
    assert.deepEqual(rel(walkGlob('weird[[]1[]].md', { cwd: root })), ['weird[1].md']);
    assert.deepEqual(rel(walkGlob('src/[ab].ts', { cwd: root })), ['src/a.ts', 'src/b.ts']);
    assert.deepEqual(rel(walkGlob('src/[!a].ts', { cwd: root })), ['src/b.ts']);
  });

  it('maxResults caps the output', () => {
    assert.equal(walkGlob('**/*', { cwd: root, maxResults: 3 }).length, 3);
  });

  it('invalid patterns and missing dirs yield [] without throwing', () => {
    assert.deepEqual(walkGlob('src/a**', { cwd: root }), []);
    assert.deepEqual(walkGlob('nope/*/x', { cwd: root }), []);
    assert.deepEqual(walkGlob('[', { cwd: root }), []);
  });

  it('agrees with globMatch(path) for every entry', () => {
    const all = walkGlob('**', { cwd: root, onlyFiles: false, ignoreDirs: [] });
    const patterns = ['**/*.ts', 'src/*', '*/*.md', '**/.*', 'src/**', '.kiro/**/*.md', '*'];
    for (const p of patterns) {
      const walked = walkGlob(p, { cwd: root, onlyFiles: false, ignoreDirs: [] });
      const abs = `${root.split(path.sep).join('/')}/${p}`;
      const filtered = all.filter((f) => globMatch(abs, f.split(path.sep).join('/'), 'path'));
      assert.deepEqual(walked, filtered, p);
    }
  });

  it('symlinks: not followed by default, followed with loop protection when asked', posixOnly, () => {
    const linkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-walk-ln-'));
    try {
      fs.mkdirSync(path.join(linkRoot, 'real/sub'), { recursive: true });
      fs.writeFileSync(path.join(linkRoot, 'real/sub/f.md'), 'x');
      fs.symlinkSync(path.join(linkRoot, 'real'), path.join(linkRoot, 'link'));
      fs.symlinkSync(linkRoot, path.join(linkRoot, 'real/sub/loop')); // cycle
      fs.symlinkSync(path.join(linkRoot, 'real/sub/f.md'), path.join(linkRoot, 'file-link.md'));
      const r = (xs: string[]): string[] => xs.map((x) => path.relative(linkRoot, x));
      assert.deepEqual(r(walkGlob('**/*.md', { cwd: linkRoot })), ['file-link.md', 'real/sub/f.md']);
      const followed = r(walkGlob('**/*.md', { cwd: linkRoot, followSymlinks: true }));
      assert.ok(followed.includes('link/sub/f.md'));
      assert.ok(followed.includes('real/sub/f.md'));
      assert.ok(followed.length < 50, 'cycle must not explode');
    } finally {
      fs.rmSync(linkRoot, { recursive: true, force: true });
    }
  });

  it('skips unreadable directories', { skip: process.platform === 'win32' || process.getuid?.() === 0 ? 'needs non-root POSIX' : false }, () => {
    const d = path.join(root, 'locked');
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, 'x.md'), 'x');
    fs.chmodSync(d, 0);
    try {
      assert.deepEqual(walkGlob('locked/*.md', { cwd: root }), []);
    } finally {
      fs.chmodSync(d, 0o755);
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
});

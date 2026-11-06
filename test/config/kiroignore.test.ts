import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { compileKiroIgnore, loadKiroIgnore, parseIgnoreLine } from '../../src/config/kiroignore.js';
import { makeFixture, type Fixture } from './helpers.js';

const ROOT = '/ws';

/** [patterns, path relative to ROOT, ignored?] — paths here do not exist, so they are files. */
const table: [string, string, boolean][] = [
  // plain names match at any depth
  ['secret.txt', 'secret.txt', true],
  ['secret.txt', 'a/b/secret.txt', true],
  ['secret.txt', 'a/secret.txt.bak', false],
  // wildcards stay within one component
  ['*.env', '.env', true],
  ['*.env', 'config/prod.env', true],
  ['*.log', 'logs/a/b.log', true],
  ['a*b', 'a/b', false],
  ['?.txt', 'x.txt', true],
  ['?.txt', 'xy.txt', false],
  ['[ab].txt', 'b.txt', true],
  ['[!ab].txt', 'b.txt', false],
  ['[!ab].txt', 'c.txt', true],
  ['[^ab].txt', 'c.txt', true],
  // anchored patterns (contain a slash)
  ['/build', 'build', true],
  ['/build', 'src/build', false],
  ['docs/internal', 'docs/internal', true],
  ['docs/internal', 'x/docs/internal', false],
  ['docs/internal', 'docs/internal/a.md', true],
  // trailing slash = directories only (ancestors are directories)
  ['private/', 'private', false],
  ['private/', 'private/a.md', true],
  ['private/', 'x/private/a.md', true],
  // ** forms
  ['**/temp', 'temp', true],
  ['**/temp', 'a/b/temp', true],
  ['**/temp/x', 'a/temp/x', true],
  ['logs/**', 'logs/a/b.txt', true],
  ['logs/**', 'logs', false],
  ['a/**/b', 'a/b', true],
  ['a/**/b', 'a/x/y/b', true],
  ['a/**/b', 'a/x/y/c', false],
  ['foo**bar', 'fooXbar', true],
  // negation: last match wins
  ['*.md\n!README.md', 'README.md', false],
  ['*.md\n!README.md', 'docs/a.md', true],
  ['!README.md\n*.md', 'README.md', true],
  // re-including below an ignored directory does not work (git rule)
  ['private/\n!private/keep.md', 'private/keep.md', true],
  // comments, blanks, escapes, trailing spaces
  ['# comment\n\n   \nsecret', 'secret', true],
  ['# comment', '# comment', false],
  ['\\#hash', '#hash', true],
  ['\\!bang', '!bang', true],
  ['trail   ', 'trail', true],
  ['a\\*b', 'a*b', true],
  ['a\\*b', 'aXb', false],
  // CRLF files
  ['one\r\ntwo\r\n', 'two', true],
  // dots are literal
  ['a.b', 'axb', false],
];

describe('config/kiroignore matching (gitignore subset, 02 §6.4)', () => {
  for (const [pats, rel, want] of table) {
    it(`${JSON.stringify(pats)} ~ ${rel} ⇒ ${want}`, () => {
      assert.equal(compileKiroIgnore(pats, ROOT).isIgnored(path.join(ROOT, rel)), want);
    });
  }

  it('paths outside the root, and the root itself, are never ignored', () => {
    const ig = compileKiroIgnore('*\n', ROOT);
    assert.equal(ig.isIgnored('/elsewhere/a.txt'), false);
    assert.equal(ig.isIgnored(ROOT), false);
    assert.equal(ig.isIgnored('/ws-other/a.txt'), false);
    assert.equal(ig.isIgnored(path.join(ROOT, 'a.txt')), true);
  });

  it('patterns lists effective lines only', () => {
    assert.deepEqual(compileKiroIgnore('# c\n\n*.env\n!keep.env\n/\n', ROOT).patterns, ['*.env', '!keep.env']);
  });

  it('parseIgnoreLine ignores blanks, comments and empty patterns', () => {
    for (const l of ['', '   ', '# x', '/', '!', '!/']) assert.equal(parseIgnoreLine(l), undefined, JSON.stringify(l));
    assert.ok(parseIgnoreLine('x'));
  });

  it('no rules ⇒ nothing ignored', () => {
    assert.equal(compileKiroIgnore('', ROOT).isIgnored(path.join(ROOT, 'a')), false);
  });
});

describe('config/kiroignore files', () => {
  let fx: Fixture;
  afterEach(() => fx?.cleanup());

  it('workspace .kiroignore + global ~/.kiro/settings/kiroignore; dir-only rules stat the path', () => {
    fx = makeFixture();
    fx.write('proj/.kiroignore', 'secrets/\n*.pem\n!public.pem\n');
    fx.write('home/.kiro/settings/kiroignore', '*.key\npublic.pem\n');
    fx.write('proj/secrets/a.txt', 'x');
    fx.write('proj/notsecrets', 'file named like the dir rule');
    fx.mkdir('proj/.kiro');
    const ig = loadKiroIgnore(fx.ctx());
    assert.deepEqual(ig.patterns, ['*.key', 'public.pem', 'secrets/', '*.pem', '!public.pem']);
    const at = (rel: string): boolean => ig.isIgnored(path.join(fx.ws, rel));
    assert.equal(at('secrets'), true); // existing directory
    assert.equal(at('secrets/a.txt'), true);
    assert.equal(at('notsecrets'), false);
    assert.equal(at('x/id.key'), true);
    assert.equal(at('cert.pem'), true);
    assert.equal(at('public.pem'), false); // workspace negation after the global rule
    assert.equal(at('src/a.ts'), false);
  });

  it('missing files ⇒ nothing ignored', () => {
    fx = makeFixture();
    const ig = loadKiroIgnore(fx.ctx());
    assert.deepEqual(ig.patterns, []);
    assert.equal(ig.isIgnored(path.join(fx.ws, 'a')), false);
  });

  it('a trailing-slash rule does not match an existing regular file', () => {
    fx = makeFixture();
    fx.write('proj/.kiroignore', 'build/\n');
    fx.write('proj/build', 'file');
    fx.write('proj/sub/build/out.js', 'x');
    const ig = loadKiroIgnore(fx.ctx());
    assert.equal(ig.isIgnored(path.join(fx.ws, 'build')), false);
    assert.equal(ig.isIgnored(path.join(fx.ws, 'sub/build')), true);
    assert.equal(ig.isIgnored(path.join(fx.ws, 'sub/build/out.js')), true);
  });
});

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { cleanJsonReason, jsonErrorMessage, jsonErrorReason } from '../../src/config/diag.js';
import { resolveSpec, stripScheme } from '../../src/config/uri.js';
import { parseJsonText } from '../../src/util/fsx.js';
import { makeFixture, type Fixture } from './helpers.js';

describe('config/uri stripScheme', () => {
  const table: [string, 'file' | 'skill', string | undefined][] = [
    ['file://a.md', 'file', 'a.md'],
    ['FILE://a.md', 'file', 'a.md'],
    ['file:///abs/a.md', 'file', '/abs/a.md'],
    ['skill://name', 'skill', 'name'],
    ['skill://name', 'file', undefined],
    ['http://x', 'file', undefined],
    ['a.md', 'file', undefined],
    ['file://', 'file', ''],
  ];
  for (const [uri, scheme, want] of table) it(`${uri} (${scheme})`, () => assert.equal(stripScheme(uri, scheme), want));
});

describe('config/uri resolveSpec', () => {
  let fx: Fixture;
  afterEach(() => fx?.cleanup());

  it('relative ⇒ workspace root, ~ ⇒ home, ~/.kiro ⇒ KIRO_HOME, absolute ⇒ filesystem root', () => {
    fx = makeFixture();
    fx.mkdir('proj/.kiro');
    const kh = fx.mkdir('kh');
    const ws = fx.ctx(fx.mkdir('proj/sub'), { KIRO_HOME: kh });
    assert.deepEqual(resolveSpec('docs/*.md', ws), { cwd: fx.ws, pattern: 'docs/*.md', abs: path.join(fx.ws, 'docs/*.md'), glob: true });
    assert.deepEqual(resolveSpec('./README.md', ws), { cwd: fx.ws, pattern: 'README.md', abs: path.join(fx.ws, 'README.md'), glob: false });
    assert.deepEqual(resolveSpec('~/notes/x.md', ws), { cwd: fx.home, pattern: 'notes/x.md', abs: path.join(fx.home, 'notes/x.md'), glob: false });
    assert.deepEqual(resolveSpec('~/.kiro/steering/**/*.md', ws), {
      cwd: kh,
      pattern: 'steering/**/*.md',
      abs: path.join(kh, 'steering/**/*.md'),
      glob: true,
    });
    assert.deepEqual(resolveSpec('~/.kiro', ws), { cwd: kh, pattern: '.', abs: kh, glob: false });
    assert.deepEqual(resolveSpec('~', ws), { cwd: fx.home, pattern: '.', abs: fx.home, glob: false });
    assert.deepEqual(resolveSpec('/etc/hosts', ws), { cwd: '/', pattern: 'etc/hosts', abs: '/etc/hosts', glob: false });
    assert.deepEqual(resolveSpec('~/.kirofoo/x', ws).cwd, fx.home); // not the Kiro home
  });

  it('~/.kiro without KIRO_HOME is <home>/.kiro', () => {
    fx = makeFixture();
    assert.equal(resolveSpec('~/.kiro/x.md', fx.ctx()).abs, path.join(fx.home, '.kiro', 'x.md'));
  });
});

describe('config/diag JSON error text', () => {
  const reasonOf = (text: string): string => {
    try {
      parseJsonText(text, '/f.json');
    } catch (e) {
      return jsonErrorReason(e);
    }
    throw new Error('parsed');
  };

  it('one line, location appended, V8 snippets removed', () => {
    const r = reasonOf('{\n  "name": "x",\n  "tools": [,]\n}');
    assert.ok(!r.includes('\n'));
    assert.ok(!r.includes('is not valid JSON'));
    assert.match(r, / at line 3 column 13$/);
    assert.match(reasonOf('{"a":1,}'), /at line 1 column 8$/);
    assert.match(reasonOf('{'), /at line 1 column 2$/);
    assert.match(reasonOf('[1] x'), /at line 1 column 5$/);
  });

  it('long inputs with truncated snippets', () => {
    const long = `{"a": [${'1,'.repeat(200)} ,]}`;
    const r = reasonOf(long);
    assert.ok(!r.includes('...'), r);
    assert.match(r, /^Unexpected token ',' at line 1 column \d+$/);
  });

  const cleanTable: [string, string][] = [
    ['Unexpected token \',\', "{\n \\"a\\": [,]\n}" is not valid JSON', "Unexpected token ','"],
    ['Unexpected token \'}\', ..."ools": [,]\n}" is not valid JSON', "Unexpected token '}'"],
    ["Expected property name or '}' in JSON at position 1 (line 1 column 2)", "Expected property name or '}'"],
    ['Unexpected end of JSON input', 'Unexpected end of JSON input'],
    ['multi\nline\n  reason', 'multi line reason'],
  ];
  for (const [raw, want] of cleanTable) it(`cleanJsonReason(${JSON.stringify(raw)})`, () => assert.equal(cleanJsonReason(raw), want));

  it('jsonErrorMessage and non-JSON errors', () => {
    try {
      parseJsonText('{x', '/m.json');
    } catch (e) {
      assert.match(jsonErrorMessage(e, '/m.json'), /^\/m\.json: invalid JSON: .* at line 1 column 2$/);
    }
    assert.equal(jsonErrorReason(new Error('boom')), 'boom');
    assert.equal(jsonErrorReason('str'), 'str');
  });
});

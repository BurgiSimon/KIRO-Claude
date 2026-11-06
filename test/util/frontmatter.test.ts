import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontMatter } from '../../src/util/frontmatter.js';

describe('frontmatter: parseFrontMatter (02 §4, 03 §3)', () => {
  it('always-steering file without front matter', () => {
    const text = '# Tech stack\n\nUse TypeScript.\n';
    assert.deepEqual(parseFrontMatter(text), { data: {}, body: text, hasFrontMatter: false });
  });

  it('fileMatch steering', () => {
    const r = parseFrontMatter('---\ninclusion: fileMatch\nfileMatchPattern: "components/**/*.tsx"\n---\n\n# React rules\n');
    assert.equal(r.hasFrontMatter, true);
    assert.equal(r.error, undefined);
    assert.deepEqual(r.data, { inclusion: 'fileMatch', fileMatchPattern: 'components/**/*.tsx' });
    assert.equal(r.body, '\n# React rules\n');
  });

  it('fileMatch with a pattern list, manual, auto', () => {
    assert.deepEqual(parseFrontMatter('---\ninclusion: fileMatch\nfileMatchPattern: ["**/*.ts", "**/*.tsx"]\n---\nbody').data, {
      inclusion: 'fileMatch',
      fileMatchPattern: ['**/*.ts', '**/*.tsx'],
    });
    assert.deepEqual(parseFrontMatter('---\ninclusion: manual\n---\nbody').data, { inclusion: 'manual' });
    const auto = parseFrontMatter('---\ninclusion: auto\nname: api-design\ndescription: Use for REST endpoints\n---\nRules');
    assert.deepEqual(auto.data, { inclusion: 'auto', name: 'api-design', description: 'Use for REST endpoints' });
    assert.equal(auto.body, 'Rules');
  });

  it('Markdown agent (body = prompt)', () => {
    const r = parseFrontMatter(
      '---\nname: backend-dev\ntools: ["read", "write"]\npermissions:\n  rules:\n    - capability: shell\n      match: ["npm *"]\n      effect: allow\n---\n\nYou are a backend developer.\n',
    );
    assert.deepEqual(r.data, {
      name: 'backend-dev',
      tools: ['read', 'write'],
      permissions: { rules: [{ capability: 'shell', match: ['npm *'], effect: 'allow' }] },
    });
    assert.equal(r.body, '\nYou are a backend developer.\n');
  });

  it('BOM and CRLF are tolerated; body keeps CRLF', () => {
    const r = parseFrontMatter('﻿---\r\ninclusion: manual\r\n---\r\nline1\r\nline2');
    assert.equal(r.hasFrontMatter, true);
    assert.deepEqual(r.data, { inclusion: 'manual' });
    assert.equal(r.body, 'line1\r\nline2');
  });

  it('closing `...` and trailing whitespace on delimiters', () => {
    const r = parseFrontMatter('---  \na: 1\n...\t\nbody');
    assert.deepEqual(r.data, { a: 1 });
    assert.equal(r.body, 'body');
  });

  it('empty front matter and closing at EOF', () => {
    assert.deepEqual(parseFrontMatter('---\n---\nbody'), { data: {}, body: 'body', hasFrontMatter: true });
    assert.deepEqual(parseFrontMatter('---\na: 1\n---'), { data: { a: 1 }, body: '', hasFrontMatter: true });
    assert.deepEqual(parseFrontMatter('---\n# only a comment\n---\nx'), { data: {}, body: 'x', hasFrontMatter: true });
  });

  it('front matter must be the very first bytes', () => {
    for (const t of ['\n---\na: 1\n---\nbody', ' ---\na: 1\n---\n', 'text\n---\na: 1\n---\n', '----\na: 1\n----\n', '--- x\na: 1\n---\n']) {
      const r = parseFrontMatter(t);
      assert.equal(r.hasFrontMatter, false, JSON.stringify(t));
      assert.deepEqual(r.data, {});
    }
  });

  it('no closing delimiter ⇒ no front matter', () => {
    const t = '---\na: 1\nbody without close';
    assert.deepEqual(parseFrontMatter(t), { data: {}, body: t, hasFrontMatter: false });
    assert.equal(parseFrontMatter('---').hasFrontMatter, false);
  });

  it('a closing delimiter must be the whole line', () => {
    const r = parseFrontMatter('---\na: "x --- y"\n--- not close\n---\nbody');
    // `--- not close` is not a delimiter, so it lands inside the YAML block and makes it invalid
    assert.equal(r.hasFrontMatter, true);
    assert.equal(r.body, 'body');
    assert.ok(r.error);
  });

  it('invalid YAML ⇒ data {}, error set, body after the block', () => {
    const r = parseFrontMatter('---\ninclusion: [unclosed\n---\nThe body\n');
    assert.equal(r.hasFrontMatter, true);
    assert.deepEqual(r.data, {});
    assert.match(r.error ?? '', /invalid front matter: .*line 2/);
    assert.equal(r.body, 'The body\n');
  });

  it('non-mapping YAML ⇒ error', () => {
    const r = parseFrontMatter('---\n- a\n- b\n---\nbody');
    assert.deepEqual(r.data, {});
    assert.match(r.error ?? '', /expected a mapping/);
    assert.equal(parseFrontMatter('---\njust text\n---\nbody').error !== undefined, true);
  });
});

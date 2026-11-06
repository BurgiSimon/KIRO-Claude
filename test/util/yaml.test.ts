import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseYaml, YamlError } from '../../src/util/yaml.js';

const y = (s: string): unknown => parseYaml(s);

function throwsAt(src: string, line: number, re?: RegExp): void {
  let caught: unknown;
  try {
    parseYaml(src);
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof YamlError, `expected YamlError for ${JSON.stringify(src)}, got ${String(caught)}`);
  assert.equal((caught as YamlError).line, line, `line for ${JSON.stringify(src)}: ${(caught as Error).message}`);
  if (re) assert.match((caught as Error).message, re);
}

describe('yaml: Kiro documents', () => {
  it('permissions.yaml (02 §2.8)', () => {
    const doc = `rules:
  - capability: shell            # required
    match: ["npm *", "git *"]    # optional glob list; absent = everything for that capability
    exclude: ["npm publish*"]    # optional; patterns that must NOT match
    effect: allow                # required: allow | ask | deny | evaluate
policies:                        # optional (user/workspace files only): preset IDs
  - approve-for-me
workspaceTrusted: true           # workspace-root file only (written by trust screen)
`;
    assert.deepEqual(y(doc), {
      rules: [{ capability: 'shell', match: ['npm *', 'git *'], exclude: ['npm publish*'], effect: 'allow' }],
      policies: ['approve-for-me'],
      workspaceTrusted: true,
    });
  });

  it('permissions.yaml with several rules and block-style match lists', () => {
    const doc = `
# user permissions
rules:
- capability: fs_read
  match:
    - "./**"
    - ~/notes
  effect: allow
- capability: fs_write
  match: [ "./src/**" ,
           "./test/**" ]
  exclude:
    - "**/*.lock"
  effect: ask
- capability: mcp
  match: ['my-server/*']
  effect: deny
- capability: all
  effect: evaluate
`;
    assert.deepEqual(y(doc), {
      rules: [
        { capability: 'fs_read', match: ['./**', '~/notes'], effect: 'allow' },
        { capability: 'fs_write', match: ['./src/**', './test/**'], exclude: ['**/*.lock'], effect: 'ask' },
        { capability: 'mcp', match: ['my-server/*'], effect: 'deny' },
        { capability: 'all', effect: 'evaluate' },
      ],
    });
  });

  it('Markdown agent front matter (02 §2.12)', () => {
    const doc = `name: backend-dev
description: Backend development agent
model: claude-sonnet-4.6
tools: ["read", "write", "shell", "web"]
excludedTools: ["knowledge"]
includeMcpJson: true
includePowers: false
mcpServers:
  postgres:
    command: npx
    args: ["-y", "@modelcontextprotocol/server-postgres"]
    env:
      DATABASE_URL: "\${DATABASE_URL}"
resources:
  - file://./ARCHITECTURE.md
  - skill://backend-patterns
permissions:
  rules:
    - capability: shell
      match: ["npm *", "node *"]
      effect: allow
welcomeMessage: "Ready to work on backend code."
`;
    assert.deepEqual(y(doc), {
      name: 'backend-dev',
      description: 'Backend development agent',
      model: 'claude-sonnet-4.6',
      tools: ['read', 'write', 'shell', 'web'],
      excludedTools: ['knowledge'],
      includeMcpJson: true,
      includePowers: false,
      mcpServers: {
        postgres: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-postgres'],
          env: { DATABASE_URL: '${DATABASE_URL}' },
        },
      },
      resources: ['file://./ARCHITECTURE.md', 'skill://backend-patterns'],
      permissions: { rules: [{ capability: 'shell', match: ['npm *', 'node *'], effect: 'allow' }] },
      welcomeMessage: 'Ready to work on backend code.',
    });
  });

  it('steering front matter variants (03 §3)', () => {
    assert.deepEqual(y('inclusion: fileMatch\nfileMatchPattern: "components/**/*.tsx"'), {
      inclusion: 'fileMatch',
      fileMatchPattern: 'components/**/*.tsx',
    });
    assert.deepEqual(y('inclusion: fileMatch\nfileMatchPattern: ["**/*.ts", "**/*.tsx"]'), {
      inclusion: 'fileMatch',
      fileMatchPattern: ['**/*.ts', '**/*.tsx'],
    });
    assert.deepEqual(y("inclusion: fileMatch\nfileMatchPattern: 'README*'"), { inclusion: 'fileMatch', fileMatchPattern: 'README*' });
    assert.deepEqual(y('inclusion: auto\nname: api-design\ndescription: REST API design rules; use when adding endpoints'), {
      inclusion: 'auto',
      name: 'api-design',
      description: 'REST API design rules; use when adding endpoints',
    });
    assert.deepEqual(y('inclusion: manual'), { inclusion: 'manual' });
  });

  it('SKILL.md front matter with metadata map', () => {
    assert.deepEqual(
      y(`name: pdf-tools
description: >-
  Extract text and tables
  from PDF files.
license: MIT
metadata:
  author: me
  version: "1.0"`),
      {
        name: 'pdf-tools',
        description: 'Extract text and tables from PDF files.',
        license: 'MIT',
        metadata: { author: 'me', version: '1.0' },
      },
    );
  });
});

describe('yaml: scalars', () => {
  const table: Array<[string, unknown]> = [
    ['a: plain text', { a: 'plain text' }],
    ['a: 42', { a: 42 }],
    ['a: -17', { a: -17 }],
    ['a: +5', { a: 5 }],
    ['a: 007', { a: 7 }],
    ['a: 0x1F', { a: 31 }],
    ['a: 0o17', { a: 15 }],
    ['a: 3.14', { a: 3.14 }],
    ['a: -1.5e3', { a: -1500 }],
    ['a: .5', { a: 0.5 }],
    ['a: 1.', { a: 1 }],
    ['a: .inf', { a: Infinity }],
    ['a: -.Inf', { a: -Infinity }],
    ['a: 1.2.3', { a: '1.2.3' }],
    ['a: 1_000', { a: '1_000' }],
    ['a: true', { a: true }],
    ['a: False', { a: false }],
    ['a: TRUE', { a: true }],
    ['a: yes', { a: 'yes' }],
    ['a: no', { a: 'no' }],
    ['a: on', { a: 'on' }],
    ['a: null', { a: null }],
    ['a: ~', { a: null }],
    ['a: NULL', { a: null }],
    ['a:', { a: null }],
    ['a:   # only a comment', { a: null }],
    ["a: 'single ''quoted'' # not comment'", { a: "single 'quoted' # not comment" }],
    ['a: "double \\"q\\" \\t tab \\n nl \\\\ bs \\/ sl"', { a: 'double "q" \t tab \n nl \\ bs / sl' }],
    ['a: "\\x41\\u00e9\\U0001F600\\0\\e\\N\\_\\L\\P\\a\\b\\v\\f\\r\\ "', { a: 'Aé😀\0\u001b\u0085\u00a0\u2028\u2029\u0007\b\v\f\r ' }],
    ['a: "true"', { a: 'true' }],
    ["a: '42'", { a: '42' }],
    ['a: value # trailing comment', { a: 'value' }],
    ['a: value#not-comment', { a: 'value#not-comment' }],
    ['a: #fff', { a: null }],
    ['a: http://example.com:8080/x', { a: 'http://example.com:8080/x' }],
    ['a: Note: lenient colon', { a: 'Note: lenient colon' }],
    ['a: @builtin', { a: '@builtin' }],
    ['a: *.md', { a: '*.md' }],
    ['a: -x', { a: '-x' }],
    ['a: "quoted" # comment', { a: 'quoted' }],
    ['a: !!str 123', { a: '123' }],
    ['a: !!int "42"', { a: 42 }],
    ['a: !!float 1', { a: 1 }],
    ['a: !!null x', { a: null }],
    ['a: !!str', { a: '' }],
    ['a: !custom value', { a: 'value' }],
    ['key with spaces: v', { 'key with spaces': 'v' }],
    ['"quoted key": v', { 'quoted key': 'v' }],
    ["'k''q': v", { "k'q": 'v' }],
    ['"a":1', { a: 1 }],
    ['1: one', { '1': 'one' }],
    ['true: t', { true: 't' }],
    ['a:\tb', { a: 'b' }],
  ];
  for (const [src, want] of table) {
    it(JSON.stringify(src), () => assert.deepEqual(y(src), want));
  }

  it('.nan', () => assert.ok(Number.isNaN((y('a: .nan') as { a: number }).a)));

  it('top-level scalars and empty documents', () => {
    assert.equal(y('hello'), 'hello');
    assert.equal(y('42'), 42);
    assert.equal(y('"x"'), 'x');
    assert.equal(y(''), null);
    assert.equal(y('# just a comment\n\n'), null);
    assert.equal(y('---\n'), null);
    assert.equal(y('hello\nworld'), 'hello world');
  });

  it('multi-line plain scalars fold', () => {
    assert.deepEqual(y('a: first\n  second\n  third\nb: x'), { a: 'first second third', b: 'x' });
    assert.deepEqual(y('a: first\n\n  after blank\nb: x'), { a: 'first\nafter blank', b: 'x' });
    assert.deepEqual(y('a:\n  just\n  nested'), { a: 'just nested' });
    assert.deepEqual(y('- a\n  b\n- c'), ['a b', 'c']);
  });

  it('multi-line quoted scalars fold', () => {
    assert.deepEqual(y('a: "one\n  two\n\n  three"'), { a: 'one two\nthree' });
    assert.deepEqual(y("a: 'one  \n   two'"), { a: 'one two' });
    assert.deepEqual(y('a: "join\\\n   ed"'), { a: 'joined' });
    assert.deepEqual(y('a: "keep\\t\n  x"'), { a: 'keep\t x' });
  });
});

describe('yaml: block scalars', () => {
  it('literal | with clip/strip/keep', () => {
    assert.deepEqual(y('a: |\n  line1\n  line2\n\nb: x'), { a: 'line1\nline2\n', b: 'x' });
    assert.deepEqual(y('a: |-\n  line1\n  line2\n\nb: x'), { a: 'line1\nline2', b: 'x' });
    assert.deepEqual(y('a: |+\n  line1\n  line2\n\nb: x'), { a: 'line1\nline2\n\n', b: 'x' });
  });
  it('preserves inner indentation, blank lines and # characters', () => {
    assert.deepEqual(y('script: |\n  if x; then\n    echo "#not comment"\n\n  fi\n'), {
      script: 'if x; then\n  echo "#not comment"\n\nfi\n',
    });
  });
  it('folded > joins lines, keeps paragraphs and more-indented lines', () => {
    assert.deepEqual(y('a: >\n  one\n  two\n\n  three\n'), { a: 'one two\nthree\n' });
    assert.deepEqual(y('a: >\n  one\n    indented\n  two\n'), { a: 'one\n  indented\ntwo\n' });
    assert.deepEqual(y('a: >-\n  x\n  y\n'), { a: 'x y' });
  });
  it('explicit indentation indicator', () => {
    assert.deepEqual(y('a: |2\n    two extra\n  base\n'), { a: '  two extra\nbase\n' });
    assert.deepEqual(y('a: |-2\n   x\n'), { a: ' x' });
    assert.deepEqual(y('a: |2-\n   x\n'), { a: ' x' });
  });
  it('empty block scalars', () => {
    assert.deepEqual(y('a: |\nb: 1'), { a: '', b: 1 });
    assert.deepEqual(y('a: |+\n\nb: 1'), { a: '\n', b: 1 });
  });
  it('block scalar in a sequence and at top level, with header comment', () => {
    assert.deepEqual(y('- |\n  x\n  y\n- z'), ['x\ny\n', 'z']);
    assert.deepEqual(y('|\n top\n'), 'top\n');
    assert.deepEqual(y('a: | # comment\n  body\n'), { a: 'body\n' });
  });
  it('tabs after indentation are content', () => {
    assert.deepEqual(y('mk: |\n  all:\n  \techo hi\n'), { mk: 'all:\n\techo hi\n' });
  });
  it('rejects bad headers', () => {
    throwsAt('a: |x\n  y', 1, /block scalar header/);
  });
});

describe('yaml: collections', () => {
  it('nested maps and sequences', () => {
    assert.deepEqual(y('a:\n  b:\n    c: 1\n  d: [1, 2]\ne: 3'), { a: { b: { c: 1 }, d: [1, 2] }, e: 3 });
    assert.deepEqual(y('- - a\n  - b\n- - c'), [['a', 'b'], ['c']]);
    assert.deepEqual(y('-\n  x: 1\n-\n  - y'), [{ x: 1 }, ['y']]);
    assert.deepEqual(y('- \n- a'), [null, 'a']);
    assert.deepEqual(y('list:\n- a\n- b\nnext: 1'), { list: ['a', 'b'], next: 1 });
    assert.deepEqual(y('- name: x\n  value: y\n- name: z'), [{ name: 'x', value: 'y' }, { name: 'z' }]);
    assert.deepEqual(y('- a: 1\n  b:\n    - c\n    - d: e\n      f: g'), [{ a: 1, b: ['c', { d: 'e', f: 'g' }] }]);
  });

  it('flow collections', () => {
    assert.deepEqual(y('a: []'), { a: [] });
    assert.deepEqual(y('a: {}'), { a: {} });
    assert.deepEqual(y("a: [x, 'y', \"z\", 1, true, null, ~]"), { a: ['x', 'y', 'z', 1, true, null, null] });
    assert.deepEqual(y('a: {b: 1, c: x y, "d": [1, {e: f}]}'), { a: { b: 1, c: 'x y', d: [1, { e: 'f' }] } });
    assert.deepEqual(y('a: [1, 2, ]'), { a: [1, 2] });
    assert.deepEqual(y('a: {b, c: 1}'), { a: { b: null, c: 1 } });
    assert.deepEqual(y('a: [k: v, x]'), { a: [{ k: 'v' }, 'x'] });
    assert.deepEqual(y('a: [http://x.y/z, "a,b"]'), { a: ['http://x.y/z', 'a,b'] });
    assert.deepEqual(y('a: [\n  one,   # c1\n  two\n]\nb: 2'), { a: ['one', 'two'], b: 2 });
    assert.deepEqual(y('{"json": [1, 2.5, "s"], "o": {"k": false}}'), { json: [1, 2.5, 's'], o: { k: false } });
    assert.deepEqual(y('[a, [b, [c]]]'), ['a', ['b', ['c']]]);
    assert.deepEqual(y('- [a, b]\n- {c: d}'), [['a', 'b'], { c: 'd' }]);
    assert.deepEqual(y('a: [multi\n  word, x]'), { a: ['multi word', 'x'] });
    assert.deepEqual(y('a: {"x":1,"y":2}'), { a: { x: 1, y: 2 } });
  });

  it('duplicate keys: last wins', () => {
    assert.deepEqual(y('a: 1\nb: 2\na: 3'), { a: 3, b: 2 });
    assert.deepEqual(y('a: {x: 1, x: 2}'), { a: { x: 2 } });
  });

  it('__proto__ keys become own properties', () => {
    const v = y('__proto__: {polluted: true}') as Record<string, unknown>;
    assert.deepEqual(Object.keys(v), ['__proto__']);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    assert.equal(Object.getPrototypeOf(v), Object.prototype);
  });

  it('anchors and aliases', () => {
    assert.deepEqual(y('base: &b {x: 1}\nother: *b'), { base: { x: 1 }, other: { x: 1 } });
    assert.deepEqual(y('a: &s hello\nb: *s'), { a: 'hello', b: 'hello' });
    assert.deepEqual(y('defaults: &d\n  k: v\nuse: *d'), { defaults: { k: 'v' }, use: { k: 'v' } });
    assert.deepEqual(y('list: [&x 1, *x]'), { list: [1, 1] });
    const v = y('a: &o {k: [1]}\nb: *o') as { a: { k: number[] }; b: { k: number[] } };
    v.b.k.push(2);
    assert.deepEqual(v.a.k, [1], 'aliases are copies');
    assert.deepEqual(y('a: *unknown'), { a: '*unknown' });
  });
});

describe('yaml: documents, comments, line endings', () => {
  it('leading --- and directives, trailing ...', () => {
    assert.deepEqual(y('%YAML 1.2\n---\na: 1\n...\nignored: [\n'), { a: 1 });
    assert.deepEqual(y('--- # comment\na: 1'), { a: 1 });
    assert.equal(y('--- plain'), 'plain');
    assert.deepEqual(y('---\na: 1\n---\n'), { a: 1 });
  });
  it('BOM and CRLF', () => {
    assert.deepEqual(y('\ufeffa: 1\r\nb:\r\n  - x\r\n'), { a: 1, b: ['x'] });
    assert.deepEqual(y('a: |\r\n  l1\r\n  l2\r\n'), { a: 'l1\nl2\n' });
  });
  it('comments everywhere', () => {
    assert.deepEqual(y('# head\na: 1 # c\n# mid\n  # indented comment\nb:\n  # inside\n  - x # c\n# tail'), { a: 1, b: ['x'] });
  });
});

describe('yaml: errors carry 1-based line numbers', () => {
  it('reports problems', () => {
    throwsAt('a: 1\n b: 2', 2, /check the indentation/);
    throwsAt('capability: shell\n  effect: allow', 2, /check the indentation/);
    throwsAt('a: 1\nplain line', 2, /expected a "key: value"/);
    throwsAt('a:\n\t- x', 2, /tab/);
    throwsAt('a: "unterminated\nb: 1', 1, /unterminated/);
    throwsAt("a: 'x", 1, /unterminated/);
    throwsAt('a: [1, 2', 1, /unterminated flow sequence/);
    throwsAt('a: {b: 1', 1, /unterminated flow mapping/);
    throwsAt('a: [1,, 2]', 1, /unexpected ','/);
    throwsAt('a: [1] x', 1, /after a flow collection/);
    throwsAt('a: "x" y', 1, /after a quoted scalar/);
    throwsAt('a: "\\q"', 1, /unknown escape/);
    throwsAt('a: "\\xZZ"', 1, /invalid \\x escape/);
    throwsAt('- a\nb: 1', 2, /unexpected content|expected/);
    throwsAt('a: 1\n- b', 2, /sequence entry/);
    throwsAt('? complex\n: v', 1, /complex/);
    throwsAt('a: 1\n---\nb: 2', 2, /multiple YAML documents/);
    throwsAt('x:\n  a: 1\n    b: 2', 3, /check the indentation/);
    throwsAt('a: {[x]: 1}', 1, /flow collections as mapping keys/);
  });
  it('error message includes the location', () => {
    try {
      parseYaml('a: [1, 2');
      assert.fail('should throw');
    } catch (e) {
      assert.ok(e instanceof YamlError);
      assert.match(e.message, /at line 1/);
      assert.equal(e.name, 'YamlError');
    }
  });
});

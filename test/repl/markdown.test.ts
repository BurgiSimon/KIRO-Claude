import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MarkdownStream, renderMarkdown } from '../../src/repl/markdown.js';
import { setColorEnabled, stripAnsi } from '../../src/util/ansi.js';

setColorEnabled(false);

const RULE80 = '━'.repeat(80);

const CASES: [string, string, string][] = [
  ['plain', 'Hello world', 'Hello world\n'],
  ['bold', 'Hello **world**', 'Hello world\n'],
  ['heading', '# Title\nbody', '# Title\nbody\n'],
  ['heading level 3', '### Sub title', '### Sub title\n'],
  ['hashtag is not a heading', '#hashtag here', '#hashtag here\n'],
  ['bullets', '- a\n* b\n+ c', '• a\n• b\n• c\n'],
  ['nested bullet', '  - inner', '  • inner\n'],
  ['ordered', '1. one\n2) two', '1. one\n2) two\n'],
  ['number is not a list', '2024 was a year', '2024 was a year\n'],
  ['rule dashes', '---', `${RULE80}\n`],
  ['rule stars', '***', `${RULE80}\n`],
  ['rule spaced', '* * *', `${RULE80}\n`],
  ['fence with lang', '```js\nconst x = 1;\n```\nafter', 'js\nconst x = 1;\nafter\n'],
  ['fence without lang', '```\ncode\n```', 'code\n'],
  ['tilde fence', '~~~\nx\n~~~', 'x\n'],
  ['unclosed fence', '```py\nprint(1)', 'py\nprint(1)\n'],
  ['fence keeps markdown literal', '```\n# not a heading **x**\n```', '# not a heading **x**\n'],
  ['inline code', 'use `npm test` now', 'use npm test now\n'],
  ['double backtick code', 'a ``x `y` z`` b', 'a x `y` z b\n'],
  ['unmatched backtick', "don`t panic", "don`t panic\n"],
  ['quote', '> quoted text', '│ quoted text\n'],
  ['link', 'see [docs](https://x.y/z)', 'see docs https://x.y/z\n'],
  ['link same text', '[https://x.y](https://x.y)', 'https://x.y\n'],
  ['not a link', 'array[0] = 1', 'array[0] = 1\n'],
  ['entities', '&lt;div&gt; &amp; &quot;q&quot; &#39;s&#39;', '<div> & "q" \'s\'\n'],
  ['unknown entity', '&copy; &x', '&copy; &x\n'],
  ['single stars stay', 'a * b * c', 'a * b * c\n'],
  ['underscores stay', 'snake_case_name __init__', 'snake_case_name __init__\n'],
  ['blank lines kept', 'para1\n\npara2', 'para1\n\npara2\n'],
  ['indentation kept', '    indented code', '    indented code\n'],
  ['crlf', 'a\r\nb', 'a\nb\n'],
  ['bold resets at newline', '**open\nnext', 'open\nnext\n'],
];

test('markdown: golden renderings (no colour)', () => {
  for (const [name, input, want] of CASES) assert.equal(renderMarkdown(input), want, name);
});

test('markdown: output does not depend on chunk boundaries', () => {
  for (const color of [false, true]) {
    setColorEnabled(color);
    for (const [name, input] of CASES) {
      const whole = renderMarkdown(input);
      // one character at a time
      let out = '';
      const md = new MarkdownStream((s) => (out += s));
      for (const ch of input) md.push(ch);
      md.end();
      // with colours, partial words may be styled as separate (identical) segments
      const norm = (x: string): string => (color ? stripAnsi(x) : x);
      assert.equal(norm(out), norm(whole), `${name} (char by char, color=${color})`);
      // every two-way split
      for (let i = 1; i < input.length; i++) {
        let o2 = '';
        const m2 = new MarkdownStream((s) => (o2 += s));
        m2.push(input.slice(0, i));
        m2.push(input.slice(i));
        m2.end();
        assert.equal(norm(o2), norm(whole), `${name} split at ${i} (color=${color})`);
      }
    }
  }
  setColorEnabled(false);
});

test('markdown: colours (bold, code, heading, link)', () => {
  setColorEnabled(true);
  try {
    assert.equal(renderMarkdown('**b**'), '\u001b[1mb\u001b[22m\n');
    assert.equal(renderMarkdown('`x`'), '\u001b[32mx\u001b[39m\n');
    const h = renderMarkdown('# T');
    assert.ok(h.includes('\u001b[35m') && h.includes('\u001b[1m'), h);
    assert.equal(stripAnsi(h), '# T\n');
    const l = renderMarkdown('[a](u)');
    assert.ok(l.includes('\u001b[34ma\u001b[39m'), l);
    assert.ok(l.includes('\u001b[90mu\u001b[39m'), l);
  } finally {
    setColorEnabled(false);
  }
});

test('markdown: word wrapping', () => {
  assert.equal(renderMarkdown('aaa bbb ccc ddd eee fff ggg', { width: 20 }), 'aaa bbb ccc ddd eee\nfff ggg\n');
  assert.equal(renderMarkdown('- aaaa bbbb cccc dddd eeee', { width: 15 }), '• aaaa bbbb\n  cccc dddd\n  eeee\n');
  assert.equal(renderMarkdown('> aaaa bbbb cccc', { width: 12 }), '│ aaaa bbbb\n│ cccc\n');
  // a word longer than the width is never split
  assert.equal(renderMarkdown('x supercalifragilistic y', { width: 10 }), 'x\nsupercalifragilistic\ny\n');
  // no width ⇒ no wrapping
  assert.equal(renderMarkdown('a '.repeat(100).trim()), `${'a '.repeat(100).trim()}\n`);
  // code blocks are not wrapped
  assert.equal(renderMarkdown('```\naaaa bbbb cccc\n```', { width: 5 }), 'aaaa bbbb cccc\n');
});

test('markdown: setColumn accounts for a prefix', () => {
  let out = '';
  const md = new MarkdownStream((s) => (out += s), { width: 10 });
  md.setColumn(2);
  md.push('aaaa bbbb cccc');
  md.end();
  assert.equal(out, 'aaaa\nbbbb cccc\n');
});

test('markdown: rule width and ascii glyphs', () => {
  assert.equal(renderMarkdown('---', { columns: 10 }), `${'━'.repeat(10)}\n`);
  assert.equal(renderMarkdown('- a\n---\n> q', { ascii: true, columns: 5 }), '- a\n-----\n| q\n');
});

test('markdown: streaming flushes complete words without wrapping', () => {
  let out = '';
  const md = new MarkdownStream((s) => (out += s));
  md.push('Hello wor');
  assert.equal(out, 'Hello wor');
  md.push('ld');
  assert.equal(out, 'Hello world');
  md.push('\n# He');
  assert.equal(out, 'Hello world\n# He');
  md.end();
  assert.equal(out, 'Hello world\n# He\n');
  assert.equal(md.dirty, false);
});

test('markdown: ambiguous line starts are held until decided', () => {
  let out = '';
  const md = new MarkdownStream((s) => (out += s));
  md.push('-');
  assert.equal(out, '');
  md.push('-');
  assert.equal(out, '');
  md.push('-\n');
  assert.equal(out, `${RULE80}\n`);
  md.push('``');
  assert.equal(out, `${RULE80}\n`);
  md.push('`sh\necho');
  assert.equal(out, `${RULE80}\nsh\necho`);
  md.end();
});

test('markdown: multiple spaces after markers are stable across chunks', () => {
  for (const input of ['#   Wide heading', '-   wide bullet', '1.   wide item', '>   wide quote']) {
    const whole = renderMarkdown(input);
    for (let i = 1; i < input.length; i++) {
      let o = '';
      const m = new MarkdownStream((s) => (o += s));
      m.push(input.slice(0, i));
      m.push(input.slice(i));
      m.end();
      assert.equal(o, whole, `${input} @${i}`);
    }
  }
});

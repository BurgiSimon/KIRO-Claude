import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  byteLength,
  indent,
  normalizeNewlines,
  plural,
  pluralWord,
  sanitizeControlChars,
  stripBom,
  truncateBytes,
  utf8SafePrefixLength,
} from '../../src/util/text.js';

describe('text: truncateBytes (Q truncate_safe, 06 §3.3)', () => {
  it('returns the input when it fits', () => {
    assert.equal(truncateBytes('hello', 5), 'hello');
    assert.equal(truncateBytes('hello', 100, ' ... truncated'), 'hello');
    assert.equal(truncateBytes('', 0), '');
  });
  it('cuts to the byte budget and appends the suffix only when truncated', () => {
    assert.equal(truncateBytes('hello world', 5), 'hello');
    assert.equal(truncateBytes('hello world', 5, ' ... truncated'), 'hello ... truncated');
    assert.equal(truncateBytes('abc', 0, '…'), '…');
  });
  it('never splits a multi-byte character', () => {
    // é = 2 bytes, € = 3 bytes, 😀 = 4 bytes
    assert.equal(truncateBytes('aé', 2), 'a');
    assert.equal(truncateBytes('aé', 3), 'aé');
    assert.equal(truncateBytes('€€', 4), '€');
    assert.equal(truncateBytes('€€', 5), '€');
    assert.equal(truncateBytes('€€', 6), '€€');
    assert.equal(truncateBytes('x😀y', 4), 'x');
    assert.equal(truncateBytes('x😀y', 5), 'x😀');
    for (let n = 0; n < 20; n++) {
      const out = truncateBytes('ü€😀aé𝄞', n);
      assert.ok(byteLength(out) <= n);
      assert.ok(!out.includes('�'));
    }
  });
  it('USER_PROMPT style: 4096 bytes', () => {
    const s = 'é'.repeat(3000); // 6000 bytes
    const out = truncateBytes(s, 4096);
    assert.equal(byteLength(out), 4096);
  });
  it('utf8SafePrefixLength', () => {
    const b = Buffer.from('a€', 'utf8'); // 61 e2 82 ac
    assert.equal(utf8SafePrefixLength(b, 0), 0);
    assert.equal(utf8SafePrefixLength(b, 1), 1);
    assert.equal(utf8SafePrefixLength(b, 2), 1);
    assert.equal(utf8SafePrefixLength(b, 3), 1);
    assert.equal(utf8SafePrefixLength(b, 4), 4);
    assert.equal(utf8SafePrefixLength(b, 10), 4);
  });
});

describe('text: sanitizeControlChars', () => {
  it('removes Cc characters except \\n\\r\\t by default', () => {
    assert.equal(sanitizeControlChars('a\u0000b\u0007c\u001bd\u007fe\u0085f\n\r\tg'), 'abcdef\n\r\tg');
  });
  it('keeps printable unicode', () => {
    assert.equal(sanitizeControlChars('héllo 😀  '), 'héllo 😀  ');
  });
  it('custom keep set', () => {
    assert.equal(sanitizeControlChars('a\nb\tc', ''), 'abc');
    assert.equal(sanitizeControlChars('a\nb\tc\u0007', '\u0007'), 'abc\u0007');
  });
});

describe('text: indent / plural / misc', () => {
  it('indent prefixes non-empty lines', () => {
    assert.equal(indent('a\nb', '  '), '  a\n  b');
    assert.equal(indent('a\n\nb\n', '> '), '> a\n\n> b\n');
    assert.equal(indent('a\r\nb', '-'), '-a\r\n-b');
    assert.equal(indent('', '  '), '');
    assert.equal(indent('x', ''), 'x');
  });
  it('plural includes the count', () => {
    assert.equal(plural(0, 'file'), '0 files');
    assert.equal(plural(1, 'file'), '1 file');
    assert.equal(plural(2, 'file'), '2 files');
    assert.equal(plural(3, 'entry', 'entries'), '3 entries');
    assert.equal(plural(1, 'entry', 'entries'), '1 entry');
    assert.equal(pluralWord(2, 'hook'), 'hooks');
    assert.equal(pluralWord(1, 'hook'), 'hook');
  });
  it('stripBom / normalizeNewlines / byteLength', () => {
    assert.equal(stripBom('﻿x'), 'x');
    assert.equal(stripBom('x﻿'), 'x﻿');
    assert.equal(normalizeNewlines('a\r\nb\rc\n'), 'a\nb\nc\n');
    assert.equal(byteLength('€'), 3);
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  compareBytes,
  contextFilesLimit,
  estimateTokens,
  estimateTokensFromBytes,
  selectWithinLimit,
} from '../../src/context/tokens.js';

describe('tokens: estimateTokens (Q count_tokens, 06 §4.3)', () => {
  const cases: [string, number][] = [
    ['', 0],
    ['abcd', 0], // 1 token -> round10(1) = 0
    ['a'.repeat(19), 0], // 4 tokens -> 0
    ['a'.repeat(20), 10], // 5 tokens -> 10 (rounds half up)
    ['a'.repeat(59), 10], // 14 -> 10
    ['a'.repeat(60), 20], // 15 -> 20
    ['a'.repeat(100), 30], // 25 -> 30
    ['a'.repeat(4000), 1000],
    ['a'.repeat(4019), 1000], // 1004 -> 1000
    ['a'.repeat(4020), 1010], // 1005 -> 1010
  ];
  for (const [s, n] of cases) {
    it(`${s.length} ASCII bytes -> ${n}`, () => assert.equal(estimateTokens(s), n));
  }
  it('counts UTF-8 bytes, not UTF-16 units', () => {
    // 'é' is 2 bytes: 10 chars = 20 bytes = 5 tokens -> 10
    assert.equal(estimateTokens('é'.repeat(10)), 10);
    // '😀' is 4 bytes: 5 = 20 bytes -> 10
    assert.equal(estimateTokens('😀'.repeat(5)), 10);
    assert.equal(estimateTokens('é'.repeat(10)), estimateTokensFromBytes(20));
  });
  it('estimateTokensFromBytes clamps and floors', () => {
    assert.equal(estimateTokensFromBytes(-5), 0);
    assert.equal(estimateTokensFromBytes(20.9), 10);
  });
});

describe('tokens: contextFilesLimit (75% of window)', () => {
  const cases: [number | undefined, number][] = [
    [undefined, 150_000],
    [200_000, 150_000],
    [1_000_000, 750_000],
    [101, 75],
    [0, 150_000],
    [-1, 150_000],
    [Number.NaN, 150_000],
  ];
  for (const [w, n] of cases) it(`${String(w)} -> ${n}`, () => assert.equal(contextFilesLimit(w), n));
  it('default window constant', () => assert.equal(DEFAULT_CONTEXT_WINDOW_TOKENS, 200_000));
});

describe('tokens: selectWithinLimit (Q drop algorithm)', () => {
  it('keeps largest first while they fit, drops the rest', () => {
    const items = [
      { path: '/a', tokens: 20 },
      { path: '/b', tokens: 40 },
      { path: '/c', tokens: 30 },
    ];
    const r = selectWithinLimit(items, 75);
    assert.deepEqual(r.kept.map((x) => x.path), ['/b', '/c']);
    assert.deepEqual(r.dropped.map((x) => x.path), ['/a']);
    assert.equal(r.total, 70);
  });
  it('a small file still fits after a large one was dropped', () => {
    const r = selectWithinLimit(
      [
        { path: '/big', tokens: 100 },
        { path: '/mid', tokens: 50 },
        { path: '/small', tokens: 10 },
      ],
      60,
    );
    assert.deepEqual(r.kept.map((x) => x.path), ['/mid', '/small']);
    assert.deepEqual(r.dropped.map((x) => x.path), ['/big']);
  });
  it('ties are evaluated in path byte order', () => {
    const r = selectWithinLimit(
      [
        { path: '/z', tokens: 10 },
        { path: '/B', tokens: 10 },
        { path: '/a', tokens: 10 },
      ],
      20,
    );
    assert.deepEqual(r.kept.map((x) => x.path), ['/B', '/a']);
    assert.deepEqual(r.dropped.map((x) => x.path), ['/z']);
  });
  it('limit equality fits (total + n <= limit)', () => {
    const r = selectWithinLimit([{ path: '/x', tokens: 10 }], 10);
    assert.equal(r.kept.length, 1);
  });
  it('zero-token files always fit', () => {
    const r = selectWithinLimit([{ path: '/e', tokens: 0 }, { path: '/f', tokens: 5 }], 0);
    assert.deepEqual(r.kept.map((x) => x.path), ['/e']);
  });
  it('compareBytes is byte order', () => {
    assert.ok(compareBytes('B', 'a') < 0);
    assert.ok(compareBytes('é', 'z') > 0);
    assert.equal(compareBytes('x', 'x'), 0);
  });
});

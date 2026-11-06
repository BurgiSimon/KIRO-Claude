import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import {
  LineReader,
  appendHistoryFile,
  countFences,
  historyFilePath,
  loadHistoryFile,
  needsContinuation,
  sanitizeUnicodeTags,
} from '../../src/repl/input.js';
import { createWorkspaceContext } from '../../src/config/workspace.js';

function pipeReader(): { r: LineReader; input: PassThrough; out: () => string } {
  const input = new PassThrough();
  const output = new PassThrough();
  let o = '';
  output.on('data', (d: Buffer) => (o += d.toString()));
  const r = new LineReader({ input, output, terminal: false });
  return { r, input, out: () => o };
}

function ttyReader(onHistory?: (e: string) => void, history?: string[]): { r: LineReader; input: PassThrough; out: () => string } {
  const input = new PassThrough();
  Object.assign(input, { isTTY: true, setRawMode: () => input });
  const output = new PassThrough();
  Object.assign(output, { isTTY: true, columns: 80 });
  let o = '';
  output.on('data', (d: Buffer) => (o += d.toString()));
  const r = new LineReader({ input, output, terminal: true, ...(onHistory ? { onHistory } : {}), ...(history ? { history } : {}) });
  return { r, input, out: () => o };
}

const tick = (): Promise<void> => new Promise((res) => setTimeout(res, 5));

test('input: helpers', () => {
  assert.equal(countFences('a ``` b ``` c ```'), 3);
  assert.equal(countFences('````'), 1);
  assert.equal(needsContinuation('```js\nx'), true);
  assert.equal(needsContinuation('```js\nx\n```'), false);
  assert.equal(needsContinuation('plain'), false);
  assert.equal(sanitizeUnicodeTags('a\u{E0041}b\u{E007F}c'), 'abc');
  assert.equal(sanitizeUnicodeTags('héllo 👋'), 'héllo 👋');
});

test('input: pipe mode queues lines, echoes them, then reports eof', async () => {
  const { r, input, out } = pipeReader();
  input.write('first\nsecond\n');
  input.end();
  assert.deepEqual(await r.read('> '), { kind: 'line', text: 'first' });
  assert.deepEqual(await r.read('? '), { kind: 'line', text: 'second' });
  assert.deepEqual(await r.read('> '), { kind: 'eof' });
  assert.deepEqual(await r.read('> '), { kind: 'eof' });
  assert.equal(out(), '> first\n? second\n> > ');
  r.close();
});

test('input: pipe mode control lines (Ctrl+C, Ctrl+D)', async () => {
  const { r, input } = pipeReader();
  input.write('\u0003\n\u0004\nok\n');
  assert.deepEqual(await r.read('> '), { kind: 'interrupt' });
  assert.deepEqual(await r.read('> '), { kind: 'ctrl-d' });
  assert.deepEqual(await r.read('> '), { kind: 'line', text: 'ok' });
  // Ctrl+C while nobody reads and a turn listens ⇒ 'interrupt' event, not queued
  let fired = 0;
  const on = (): void => {
    fired++;
  };
  r.on('interrupt', on);
  input.write('\u0003\n');
  await tick();
  assert.equal(fired, 1);
  r.off('interrupt', on);
  input.write('after\n');
  assert.deepEqual(await r.read('> '), { kind: 'line', text: 'after' });
  r.close();
});

test('input: logical input continuation (backslash, fences)', async () => {
  const { r, input } = pipeReader();
  input.write('one \\\ntwo\n```js\nconst a = 1;\n```\nlast\n');
  input.end();
  assert.deepEqual(await r.readInput('> '), { kind: 'line', text: 'one \ntwo' });
  assert.deepEqual(await r.readInput('> '), { kind: 'line', text: '```js\nconst a = 1;\n```' });
  assert.deepEqual(await r.readInput('> '), { kind: 'line', text: 'last' });
  assert.deepEqual(await r.readInput('> '), { kind: 'eof' });
  r.close();
});

test('input: an interrupt inside a continuation aborts the whole input', async () => {
  const { r, input } = pipeReader();
  input.write('```\npartial\n\u0003\nnext\n');
  assert.deepEqual(await r.readInput('> '), { kind: 'interrupt' });
  assert.deepEqual(await r.readInput('> '), { kind: 'line', text: 'next' });
  r.close();
});

test('input: nested reads take lines in stack order and the lower prompt is shown again', async () => {
  const { r, input, out } = pipeReader();
  const outer = r.read('main> ');
  await tick();
  const inner = r.read('approve> ');
  input.write('y\n');
  assert.deepEqual(await inner, { kind: 'line', text: 'y' });
  await tick();
  input.write('hello\n');
  assert.deepEqual(await outer, { kind: 'line', text: 'hello' });
  assert.equal(out(), 'main> approve> y\nmain> hello\n');
  r.close();
});

test('input: abort signal cancels a read', async () => {
  const { r, input } = pipeReader();
  const ac = new AbortController();
  const p = r.read('> ', { signal: ac.signal });
  ac.abort();
  assert.deepEqual(await p, { kind: 'aborted' });
  const pre = new AbortController();
  pre.abort();
  assert.deepEqual(await r.read('> ', { signal: pre.signal }), { kind: 'aborted' });
  input.write('still here\n');
  assert.deepEqual(await r.read('> '), { kind: 'line', text: 'still here' });
  r.close();
});

test('input: printAbove re-prints the prompt in pipe mode', async () => {
  const { r, input, out } = pipeReader();
  const p = r.read('> ');
  r.printAbove('notice\n');
  input.write('x\n');
  await p;
  assert.equal(out(), '> \nnotice\n> x\n');
  r.close();
});

test('input: terminal mode Enter, Ctrl+J, Alt+Enter, paste, backslash', async () => {
  const { r, input } = ttyReader();
  let p = r.readInput('> ');
  input.write('abc\r');
  assert.deepEqual(await p, { kind: 'line', text: 'abc' });
  p = r.readInput('> ');
  input.write('ab');
  input.write('\n'); // Ctrl+J
  input.write('cd\r');
  assert.deepEqual(await p, { kind: 'line', text: 'ab\ncd' });
  p = r.readInput('> ');
  input.write('x\u001b\r'); // Alt+Enter
  await tick();
  input.write('y\r');
  assert.deepEqual(await p, { kind: 'line', text: 'x\ny' });
  p = r.readInput('> ');
  input.write('\u001b[200~line1\r\nline2\u001b[201~\r');
  assert.deepEqual(await p, { kind: 'line', text: 'line1\nline2' });
  p = r.readInput('> ');
  input.write('cont\\\r');
  await tick();
  input.write('more\r');
  assert.deepEqual(await p, { kind: 'line', text: 'cont\nmore' });
  r.close();
});

test('input: terminal mode Ctrl+C / Ctrl+D / Shift+Tab and swallowed keys', async () => {
  const { r, input } = ttyReader();
  let p = r.read('> ');
  input.write('typed\u0003');
  assert.deepEqual(await p, { kind: 'interrupt' });
  p = r.read('> ');
  input.write('\u0004');
  assert.deepEqual(await p, { kind: 'ctrl-d' });
  // Ctrl+D with text on the line is readline's delete-char, not EOF
  p = r.read('> ');
  input.write('ab\u0004\r');
  assert.deepEqual(await p, { kind: 'line', text: 'ab' });
  let tabs = 0;
  r.on('shift-tab', () => tabs++);
  p = r.read('> ');
  input.write('\u001b[Z');
  await tick();
  input.write('q\r');
  assert.deepEqual(await p, { kind: 'line', text: 'q' });
  assert.equal(tabs, 1);
  // no read active: keys are swallowed, Ctrl+C becomes an event
  let ints = 0;
  r.on('interrupt', () => ints++);
  input.write('ignored text\r');
  input.write('\u0003');
  await tick();
  assert.equal(ints, 1);
  p = r.read('> ');
  input.write('fresh\r');
  assert.deepEqual(await p, { kind: 'line', text: 'fresh' });
  r.close();
});

test('input: terminal history keeps logical inputs only', async () => {
  const seen: string[] = [];
  const { r, input } = ttyReader((e) => seen.push(e), ['old1', 'old2']);
  assert.deepEqual(r.history(), ['old2', 'old1']);
  let p = r.readInput('> ', { history: true });
  input.write('a\nb\r');
  await p;
  p = r.read('> ');
  input.write('y\r'); // approval answer: not recorded
  await p;
  assert.deepEqual(r.history(), ['a\nb', 'old2', 'old1']);
  assert.deepEqual(seen, ['a\nb']);
  // an answer equal to the newest entry does not remove that entry
  p = r.read('> ');
  input.write('a\nb\r');
  await p;
  assert.deepEqual(r.history(), ['a\nb', 'old2', 'old1']);
  // Up arrow recalls the newest entry
  p = r.readInput('> ', { history: true });
  input.write('\u001b[A');
  await tick();
  input.write('\r');
  const got = await p;
  assert.equal(got.kind, 'line');
  r.close();
});

test('input: history files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-hist-'));
  try {
    const ws = createWorkspaceContext(root, { HOME: root, PATH: process.env.PATH ?? '' });
    const g = historyFilePath(ws, 'global', 'abc');
    const s = historyFilePath(ws, 'session', '0f8fad5b-d9cb-469f-a165-70867728950e');
    assert.equal(g, path.join(ws.kiroHome, 'kiro-claude', 'history', 'global.jsonl'));
    assert.equal(s, path.join(ws.kiroHome, 'kiro-claude', 'history', '0f8fad5b-d9cb-469f-a165-70867728950e.jsonl'));
    assert.equal(historyFilePath(ws, undefined, '../evil'), g);
    assert.deepEqual(loadHistoryFile(s), []);
    appendHistoryFile(s, 'one');
    appendHistoryFile(s, 'multi\nline');
    fs.appendFileSync(s, 'not json\n');
    assert.deepEqual(loadHistoryFile(s), ['one', 'multi\nline']);
    assert.deepEqual(loadHistoryFile(s, 1), ['multi\nline']);
    assert.equal(fs.statSync(s).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

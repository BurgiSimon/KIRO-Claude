/** NDJSON JSON-RPC 2.0 transport (05 §3, 08 KC-ACP-16). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { ErrorCodes, JsonRpcConnection, MAX_FRAME_BYTES, RpcError, internalError, respondThen, serializeBounded } from '../../src/acp/jsonrpc.js';
import { sleep, until } from './helpers.js';

interface Harness {
  conn: JsonRpcConnection;
  input: PassThrough;
  output: PassThrough;
  frames: any[];
  lines: string[];
  notifications: Array<[string, unknown]>;
  send(o: unknown): void;
}

function harness(onRequest: (m: string, p: unknown, c: { id: string | number; signal: AbortSignal }) => unknown, opts: { maxFrameBytes?: number; maxInboundLineBytes?: number } = {}): Harness {
  const input = new PassThrough();
  const output = new PassThrough();
  const frames: any[] = [];
  const lines: string[] = [];
  const notifications: Array<[string, unknown]> = [];
  let buf = '';
  output.on('data', (c: Buffer) => {
    buf += c.toString();
    let i = buf.indexOf('\n');
    while (i >= 0) {
      const l = buf.slice(0, i);
      buf = buf.slice(i + 1);
      lines.push(l);
      frames.push(JSON.parse(l));
      i = buf.indexOf('\n');
    }
  });
  const conn = new JsonRpcConnection({ input, output, onRequest, onNotification: (m, p) => void notifications.push([m, p]), ...opts });
  void conn.start();
  return { conn, input, output, frames, lines, notifications, send: (o) => input.write(`${typeof o === 'string' ? o : JSON.stringify(o)}\n`) };
}

test('request → response with exact id echo (int and string); undefined result ⇒ {}', async () => {
  const h = harness((m, p) => (m === 'echo' ? { got: p } : undefined));
  h.send({ jsonrpc: '2.0', id: 7, method: 'echo', params: { a: 1 } });
  h.send({ jsonrpc: '2.0', id: 'abc', method: 'echo', params: [1] });
  h.send({ jsonrpc: '2.0', id: 0, method: 'nothing' });
  await until(() => h.frames.length === 3);
  assert.deepEqual(h.frames[0], { jsonrpc: '2.0', id: 7, result: { got: { a: 1 } } });
  assert.deepEqual(h.frames[1], { jsonrpc: '2.0', id: 'abc', result: { got: [1] } });
  assert.deepEqual(h.frames[2], { jsonrpc: '2.0', id: 0, result: {} });
});

test('errors: RpcError shape, thrown Error ⇒ -32603 with data, parse error, invalid request', async () => {
  const h = harness((m) => {
    if (m === 'rpc') throw internalError('Session not found');
    if (m === 'boom') throw new Error('kaput');
    if (m === 'async') return Promise.reject(new RpcError(-32602, 'Invalid params', 'bad'));
    return {};
  });
  h.send({ jsonrpc: '2.0', id: 1, method: 'rpc' });
  h.send({ jsonrpc: '2.0', id: 2, method: 'boom' });
  h.send({ jsonrpc: '2.0', id: 3, method: 'async' });
  h.send('this is not json');
  h.send('42');
  h.send({ jsonrpc: '2.0', id: { x: 1 }, method: 'bad-id' });
  h.send({ jsonrpc: '2.0', id: 9 });
  await until(() => h.frames.length === 7);
  assert.deepEqual(h.frames[0], { jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'Internal error', data: 'Session not found' } });
  assert.deepEqual(h.frames[1], { jsonrpc: '2.0', id: 2, error: { code: -32603, message: 'Internal error', data: 'kaput' } });
  const byId = (id: number) => h.frames.find((f) => f.id === id);
  assert.deepEqual(byId(3), { jsonrpc: '2.0', id: 3, error: { code: -32602, message: 'Invalid params', data: 'bad' } });
  const nulls = h.frames.filter((f) => f.id === null);
  assert.deepEqual(nulls[0], { jsonrpc: '2.0', id: null, error: { code: ErrorCodes.PARSE_ERROR, message: 'Parse error' } });
  assert.equal(nulls[1].error.code, ErrorCodes.INVALID_REQUEST);
  assert.equal(nulls[2].error.code, ErrorCodes.INVALID_REQUEST);
  assert.equal(byId(9).error.code, ErrorCodes.INVALID_REQUEST);
});

test('notifications reach the handler, never answered; blank lines and CRLF tolerated; split chunks', async () => {
  const h = harness(() => ({ ok: true }));
  h.input.write('\n\r\n   \n');
  h.input.write('{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"s"}}\r\n');
  const line = JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'x', params: { t: 'é😀' } });
  const buf = Buffer.from(`${line}\n`);
  // split inside a multi-byte character
  const cut = buf.indexOf(Buffer.from('😀')) + 2;
  h.input.write(buf.subarray(0, cut));
  await sleep(5);
  h.input.write(buf.subarray(cut));
  await until(() => h.frames.length === 1);
  assert.deepEqual(h.notifications, [['session/cancel', { sessionId: 's' }]]);
  assert.deepEqual(h.frames[0], { jsonrpc: '2.0', id: 5, result: { ok: true } });
});

test('batches are answered element by element; empty batch is invalid', async () => {
  const h = harness((m) => ({ m }));
  h.send([{ jsonrpc: '2.0', id: 1, method: 'a' }, { jsonrpc: '2.0', method: 'n' }, { jsonrpc: '2.0', id: 2, method: 'b' }]);
  h.send([]);
  await until(() => h.frames.length === 3);
  assert.deepEqual(
    h.frames.filter((f) => f.id !== null).map((f) => f.result.m),
    ['a', 'b'],
  );
  assert.equal(h.frames.find((f) => f.id === null).error.code, ErrorCodes.INVALID_REQUEST);
});

test('outgoing requests use UUID ids and correlate responses (result and error)', async () => {
  const h = harness(() => ({}));
  const a = h.conn.request('session/request_permission', { x: 1 });
  const b = h.conn.request('other', {});
  await until(() => h.frames.length === 2);
  assert.match(a.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(h.frames[0], { jsonrpc: '2.0', id: a.id, method: 'session/request_permission', params: { x: 1 } });
  h.send({ jsonrpc: '2.0', id: b.id, error: { code: -32601, message: 'nope', data: 'd' } });
  h.send({ jsonrpc: '2.0', id: a.id, result: { outcome: { outcome: 'selected', optionId: 'allow_once' } } });
  assert.deepEqual(await a.promise, { outcome: { outcome: 'selected', optionId: 'allow_once' } });
  await assert.rejects(b.promise, (e: unknown) => e instanceof RpcError && e.code === -32601 && e.data === 'd');
  assert.deepEqual(h.conn.pendingRequestIds, []);
  // unknown response ids are ignored
  h.send({ jsonrpc: '2.0', id: 'nobody', result: {} });
  await sleep(10);
  assert.equal(h.frames.length, 2);
});

test('aborting an outgoing request withdraws it with $/cancel_request; a late answer is ignored', async () => {
  const h = harness(() => ({}));
  const ac = new AbortController();
  const r = h.conn.request('session/request_permission', {}, { signal: ac.signal });
  await until(() => h.frames.length === 1);
  ac.abort();
  await assert.rejects(r.promise, (e: unknown) => e instanceof RpcError && e.code === ErrorCodes.REQUEST_CANCELLED);
  await until(() => h.frames.length === 2);
  assert.deepEqual(h.frames[1], { jsonrpc: '2.0', method: '$/cancel_request', params: { requestId: r.id } });
  h.send({ jsonrpc: '2.0', id: r.id, result: {} });
  await sleep(10);
  assert.equal(h.frames.length, 2);
});

test('incoming $/cancel_request aborts the matching handler signal and is forwarded', async () => {
  let seen: AbortSignal | undefined;
  const h = harness((_m, _p, c) => {
    seen = c.signal;
    return new Promise((resolve) => c.signal.addEventListener('abort', () => resolve({ aborted: true })));
  });
  h.send({ jsonrpc: '2.0', id: 'p1', method: 'session/prompt' });
  await until(() => seen !== undefined);
  assert.deepEqual(h.conn.inFlightRequestIds, ['p1']);
  h.send({ jsonrpc: '2.0', method: '$/cancel_request', params: { requestId: 'p1' } });
  await until(() => h.frames.length === 1);
  assert.deepEqual(h.frames[0].result, { aborted: true });
  assert.deepEqual(h.notifications[0], ['$/cancel_request', { requestId: 'p1' }]);
});

test('respondThen writes the response before the follow-up frames', async () => {
  const h = harness(function (this: unknown) {
    return respondThen({ sessionId: 's' }, () => {
      h.conn.notify('_kiro.dev/mcp/server_initialized', { sessionId: 's', serverName: 'a' });
    });
  });
  h.send({ jsonrpc: '2.0', id: 1, method: 'session/new' });
  await until(() => h.frames.length === 2);
  assert.deepEqual(h.frames[0], { jsonrpc: '2.0', id: 1, result: { sessionId: 's' } });
  assert.equal(h.frames[1].method, '_kiro.dev/mcp/server_initialized');
});

test('outbound frames are capped: long strings truncated; an unshrinkable frame is dropped / answered -32603', async () => {
  assert.equal(serializeBounded({ a: 'x' }), '{"a":"x"}');
  const big = 'y'.repeat(MAX_FRAME_BYTES + 10);
  const s = serializeBounded({ text: big })!;
  assert.ok(Buffer.byteLength(s) <= MAX_FRAME_BYTES);
  assert.match(s, /truncated/);
  const h = harness(() => ({ huge: 'z'.repeat(5000) }), { maxFrameBytes: 2000 });
  h.send({ jsonrpc: '2.0', id: 1, method: 'x' });
  await until(() => h.frames.length === 1);
  assert.ok(h.lines[0]!.length <= 2000);
  assert.match(h.frames[0].result.huge, /truncated/);
  // thousands of short keys cannot be shrunk by truncating strings
  const many: Record<string, number> = {};
  for (let i = 0; i < 2000; i++) many[`k${i}`] = i;
  const h2 = harness(() => many, { maxFrameBytes: 2000 });
  h2.send({ jsonrpc: '2.0', id: 2, method: 'x' });
  await until(() => h2.frames.length === 1);
  assert.deepEqual(h2.frames[0].error, { code: -32603, message: 'Internal error', data: 'Response too large' });
  assert.equal(h2.conn.notify('n', many), false);
});

test('inbound lines over the limit are discarded with a parse error; the connection keeps working', async () => {
  const h = harness((m) => ({ m }), { maxInboundLineBytes: 100 });
  h.input.write('{"jsonrpc":"2.0","id":1,"method":"' + 'a'.repeat(60));
  h.input.write('b'.repeat(60) + '"}\n');
  h.send({ jsonrpc: '2.0', id: 2, method: 'ok' });
  await until(() => h.frames.length === 2);
  assert.equal(h.frames[0].id, null);
  assert.equal(h.frames[0].error.code, ErrorCodes.PARSE_ERROR);
  assert.deepEqual(h.frames[1], { jsonrpc: '2.0', id: 2, result: { m: 'ok' } });
});

test('EOF resolves start(); pending outgoing requests reject; output works until close()', async () => {
  const h = harness(() => ({}));
  const r = h.conn.request('x');
  h.input.end();
  await h.conn.done();
  assert.equal(h.conn.inputEnded, true);
  assert.equal(h.conn.closed, false);
  await assert.rejects(r.promise, (e: unknown) => e instanceof RpcError && e.code === ErrorCodes.REQUEST_CANCELLED);
  await assert.rejects(h.conn.request('after').promise);
  assert.equal(h.conn.notify('still', {}), true);
  h.conn.close();
  assert.equal(h.conn.closed, true);
  const before = h.frames.length;
  assert.equal(h.conn.notify('late', {}), false);
  await sleep(5);
  assert.equal(h.frames.length, before);
});

test('a final line without newline is still handled at EOF', async () => {
  const h = harness(() => ({ ok: 1 }));
  h.input.write('{"jsonrpc":"2.0","id":3,"method":"x"}');
  h.input.end();
  await until(() => h.frames.length === 1);
  assert.deepEqual(h.frames[0], { jsonrpc: '2.0', id: 3, result: { ok: 1 } });
});

test('a broken output (EPIPE) closes the connection', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const conn = new JsonRpcConnection({ input, output, onRequest: () => ({}) });
  const done = conn.start();
  output.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
  await done;
  assert.equal(conn.closed, true);
});

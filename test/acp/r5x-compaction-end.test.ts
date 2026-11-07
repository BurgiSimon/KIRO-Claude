/**
 * r5x X2 (group compaction-end), ACP: an automatic compaction inside a prompt turn that Claude
 * reports failed (`system/status` `compact_result:'failed'` with `compact_error`, no boundary) now
 * has its `_kiro.dev/compaction/status` end. Before the fix ACP sent `started` and never an end.
 *
 * What KiroCrew does with that end (its kiro-cli backend; KiroCrew source, read-only):
 * - acp/session_handle_dispatch.py and acp/client_turn.py: a `failed` read inside a turn arms a
 *   60 s post-failure budget (`_COMPACTION_FAILED_TURN_BUDGET`); if no frame at all follows for
 *   60 s (and no tool is in flight), it ends the turn itself as `error: compaction failed` and the
 *   channel layers reset the session and may replay the prompt (messaging/dispatch.py). A prompt
 *   response that arrives first ends the turn as usual.
 * - The notice text of a `failed` read inside a turn is `compaction_failure_detail(params)`
 *   (acp/compaction_errors.py): the first reason-bearing key (`userFacingSessionErrorMessage`,
 *   `reason`, `message`, `error`, `detail`, `name`), never `summary`.
 * - dashboard/chat_turn/session_events.py: a `started` shows the compacting state until a
 *   terminal, and "the provider layer guarantees a terminal arrives"; a real terminal is a segment
 *   boundary: text streamed before it is dropped from the turn's answer, text after it is kept.
 * So kiro-claude sends the `failed` frame (with the reason in `summary` AND in `reason`) after
 * what came before the failure and before the turn's next frame (the answer), or before the
 * prompt response when nothing follows; a started compaction still open when the turn ends gets
 * `failed` before the response as well. The turn's stop reason is what Claude answered.
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import { createWorld, mockFactory, type MockTurn } from './mockSession.js';
import { TestClient, sleep, tmpEnv, writeAgent, type Frame, type TmpEnv } from './helpers.js';

const clients: TestClient[] = [];
after(async () => {
  await Promise.allSettled(clients.filter((c) => c.exitCode === undefined).map((c) => c.close(15_000)));
});

const TOO_LONG = 'Conversation too long. Press esc twice to go up a few messages and try again.';

// ───────────── KiroCrew's reading of the frames (see the module doc) ─────────────

const KC_DETAIL_KEYS = ['userFacingSessionErrorMessage', 'reason', 'message', 'error', 'detail', 'name'];
const KC_PLACEHOLDERS = new Set(['error', 'errored', 'failed', 'failure', 'none', 'null', 'unknown', 'unknown error']);

/** KiroCrew's `compaction_failure_detail`: what its in-turn notice says for a `failed` frame. */
function kcFailureDetail(params: Frame): string {
  let best = KC_DETAIL_KEYS.length;
  let detail = '';
  const walk = (v: unknown, depth: number): void => {
    if (depth > 6 || typeof v !== 'object' || v === null) return;
    for (const [k, x] of Array.isArray(v) ? v.map((y, i) => [String(i), y] as const) : Object.entries(v)) {
      if (typeof x === 'object' && x !== null) walk(x, depth + 1);
      else if (typeof x === 'string' && x.trim() && !KC_PLACEHOLDERS.has(x.trim().toLowerCase())) {
        const rank = KC_DETAIL_KEYS.indexOf(k);
        if (rank >= 0 && rank < best) {
          best = rank;
          detail = x.trim();
        }
      }
    }
  };
  walk(params, 0);
  return detail || `no reason reported by the agent (raw: ${JSON.stringify(params)})`;
}

interface KcTurn {
  /** Compaction status types in order. */
  statuses: string[];
  /** Every `started` got a terminal before the prompt response (the dashboard leaves its compacting state). */
  settled: boolean;
  /** The answer the dashboard keeps: the text after the last real compaction terminal. */
  kept: string;
  /** All text of the turn. */
  all: string;
  stopReason: string | undefined;
}

/** The frames of session `sid` from `from` up to and including the prompt response `resp`, read the way KiroCrew reads them. */
function kcTurn(c: TestClient, sid: string, from: number, resp: Frame): KcTurn {
  const end = c.frames.indexOf(resp);
  const statuses: string[] = [];
  let open = 0;
  let kept = '';
  let all = '';
  for (const f of c.frames.slice(from, end)) {
    if (f.params?.sessionId !== sid) continue;
    if (f.method === '_kiro.dev/compaction/status') {
      const type = String(f.params.status?.type);
      statuses.push(type);
      if (type === 'started') open++;
      else {
        open = Math.max(0, open - 1);
        kept = '';
      }
    } else if (f.method === 'session/update' && f.params.update?.sessionUpdate === 'agent_message_chunk') {
      kept += String(f.params.update.content?.text ?? '');
      all += String(f.params.update.content?.text ?? '');
    }
  }
  return { statuses, settled: open === 0, kept, all, stopReason: resp.result?.stopReason };
}

const statusFrames = (c: TestClient, from: number): Frame[] => c.frames.slice(from).filter((f) => f.method === '_kiro.dev/compaction/status');

/** The next frame for session `sid` after frame index `i`. */
const nextFor = (c: TestClient, i: number, sid: string): Frame | undefined => c.frames.slice(i + 1).find((f) => f.method !== undefined && f.params?.sessionId === sid);

let nextId = 640_000;
function send(c: TestClient, method: string, params: unknown, ms = 30_000): { id: number; response: Promise<Frame> } {
  const id = nextId++;
  const response = c.waitFor((f) => f.id === id && f.method === undefined && ('result' in f || 'error' in f), ms, `response to ${method}#${id}`, c.frames.length);
  c.send({ jsonrpc: '2.0', id, method, params });
  return { id, response };
}

// ───────────── the real session module and the fake Claude Code ─────────────

const SCRIPT = {
  turns: [
    { repeat: true, match: '^autofail', steps: [{ text: 'before the compaction ' }, { autoCompact: 'failed', error: TOO_LONG }, { text: 'ANSWER after' }] },
    { repeat: true, match: '^autolate', steps: [{ autoCompact: 'failed', error: TOO_LONG }, { sleepMs: 1500 }, { text: 'ANSWER late' }] },
    { repeat: true, match: '^autosilent', steps: [{ autoCompact: 'failed', error: TOO_LONG }, { sleepMs: 300 }] },
    { repeat: true, match: '^autoslow', steps: [{ autoCompact: 'failed', durationMs: 8000, error: TOO_LONG }, { text: 'never' }] },
    { repeat: true, match: '^dangling', steps: [{ frame: { type: 'system', subtype: 'status', status: 'compacting' } }, { text: 'ANSWER dangling' }] },
  ],
  default: { steps: [{ text: 'ok' }] },
};

async function realSetup(): Promise<{ t: TmpEnv; c: TestClient; sid: string }> {
  const t = tmpEnv({ FAKE_CLAUDE_SCRIPT_JSON: JSON.stringify(SCRIPT), FAKE_CLAUDE_PERSIST: '1' });
  const c = new TestClient({ args: [], env: t.env, cwd: t.work });
  clients.push(c);
  await c.initialize();
  const { sessionId } = (await c.call('session/new', { cwd: t.work, mcpServers: [] }, 30_000)) as { sessionId: string };
  await sleep(100); // session/new's post-answer reports are out
  return { t, c, sid: sessionId };
}

const promptOf = (sid: string, text: string): Record<string, unknown> => ({ sessionId: sid, prompt: [{ type: 'text', text }] });

describe('r5x X2: a failed automatic compaction inside a prompt turn (real session + fake)', () => {
  test('started, then failed with the reason before the answer; end_turn; KiroCrew neither hangs nor loses the answer', async () => {
    const { c, sid } = await realSetup();
    const from = c.frames.length;
    const r = await send(c, 'session/prompt', promptOf(sid, 'autofail now')).response;
    const kc = kcTurn(c, sid, from, r);
    assert.deepEqual(kc.statuses, ['started', 'failed'], JSON.stringify(statusFrames(c, from)));
    assert.equal(kc.settled, true, 'KiroCrew would wait for the end of a started compaction');
    assert.equal(kc.stopReason, 'end_turn', 'a turn that otherwise succeeded reads as failed');
    assert.equal(kc.kept, 'ANSWER after', `the dashboard keeps the text after the terminal: ${JSON.stringify(kc)}`);
    assert.equal(kc.all, 'before the compaction ANSWER after');
    const failed = statusFrames(c, from)[1]!;
    assert.deepEqual(failed.params.status, { type: 'failed' }, 'kiro-cli shape of the status');
    assert.equal(failed.params.summary, TOO_LONG, 'the reason in summary (05 §4.5.4)');
    assert.equal(kcFailureDetail(failed.params), TOO_LONG, 'KiroCrew\'s in-turn notice reads a reason-bearing key');
    // the turn's metadata after the end, as for any turn
    const meta = c.frames.slice(c.frames.indexOf(failed)).find((f) => f.method === '_kiro.dev/metadata' && f.params.sessionId === sid);
    assert.ok(meta && c.frames.indexOf(meta) < c.frames.indexOf(r), 'metadata before the response');
    // the next automatic compaction is reported from its start again
    const from2 = c.frames.length;
    const r2 = await send(c, 'session/prompt', promptOf(sid, 'autofail again')).response;
    assert.deepEqual(kcTurn(c, sid, from2, r2).statuses, ['started', 'failed']);
    assert.equal(await c.close(15_000), 0);
  });

  test('the failed frame waits for the turn\'s next frame: not sent while Claude is silent after the failure (KiroCrew\'s 60 s post-failure clock)', async () => {
    const { c, sid } = await realSetup();
    const from = c.frames.length;
    const p = send(c, 'session/prompt', promptOf(sid, 'autolate'));
    await c.waitFor((f) => f.method === '_kiro.dev/compaction/status' && f.params.status.type === 'started', 10_000, 'started', from);
    await sleep(500);
    assert.deepEqual(
      statusFrames(c, from).map((f) => f.params.status.type),
      ['started'],
      'the failed frame went out while Claude was still silent: KiroCrew\'s post-failure budget runs during that silence',
    );
    const r = await p.response;
    const kc = kcTurn(c, sid, from, r);
    assert.deepEqual(kc.statuses, ['started', 'failed']);
    assert.equal(kc.kept, 'ANSWER late');
    const failed = statusFrames(c, from)[1]!;
    const next = nextFor(c, c.frames.indexOf(failed), sid)!;
    assert.equal(next.params.update?.sessionUpdate, 'agent_message_chunk', JSON.stringify(next));
    assert.equal(r.result.stopReason, 'end_turn');
    assert.equal(await c.close(15_000), 0);
  });

  test('nothing after the failure: failed before the prompt response', async () => {
    const { c, sid } = await realSetup();
    const from = c.frames.length;
    const r = await send(c, 'session/prompt', promptOf(sid, 'autosilent')).response;
    const kc = kcTurn(c, sid, from, r);
    assert.deepEqual(kc.statuses, ['started', 'failed']);
    assert.equal(kc.settled, true);
    assert.equal(r.result.stopReason, 'end_turn');
    assert.equal(statusFrames(c, from)[1]!.params.summary, TOO_LONG);
    assert.equal(await c.close(15_000), 0);
  });

  test('a compaction Claude reports started and never ends: failed before the end_turn response', async () => {
    const { c, sid } = await realSetup();
    const from = c.frames.length;
    const r = await send(c, 'session/prompt', promptOf(sid, 'dangling')).response;
    const kc = kcTurn(c, sid, from, r);
    assert.deepEqual(kc.statuses, ['started', 'failed'], JSON.stringify(statusFrames(c, from)));
    assert.equal(kc.settled, true);
    assert.equal(r.result.stopReason, 'end_turn');
    assert.match(kcFailureDetail(statusFrames(c, from)[1]!.params), /did not finish/i);
    assert.equal(await c.close(15_000), 0);
  });

  test('session/cancel while Claude compacts: failed (Compaction cancelled) before the cancelled response', async () => {
    const { c, sid } = await realSetup();
    const from = c.frames.length;
    const p = send(c, 'session/prompt', promptOf(sid, 'autoslow'));
    await c.waitFor((f) => f.method === '_kiro.dev/compaction/status' && f.params.status.type === 'started', 10_000, 'started', from);
    c.notify('session/cancel', { sessionId: sid });
    const r = await p.response;
    const kc = kcTurn(c, sid, from, r);
    assert.equal(r.result.stopReason, 'cancelled');
    assert.deepEqual(kc.statuses, ['started', 'failed']);
    assert.equal(kc.settled, true);
    assert.match(kcFailureDetail(statusFrames(c, from)[1]!.params), /cancelled/i);
    assert.equal(await c.close(15_000), 0);
  });

  test('a manual /compact Claude refuses (after /effort): still exactly started then failed, the reason readable both ways', async () => {
    const { c, sid } = await realSetup();
    await c.call('_kiro.dev/commands/execute', { sessionId: sid, command: { command: 'effort', args: { value: 'low' } } }, 30_000);
    await sleep(100);
    const from = c.frames.length;
    const r = await send(c, 'session/prompt', promptOf(sid, '/compact')).response;
    assert.equal(r.result.stopReason, 'end_turn');
    await c.waitFor((f) => f.method === '_kiro.dev/metadata' && f.params.sessionId === sid, 10_000, 'metadata after the compaction', c.frames.indexOf(r));
    const st = statusFrames(c, from);
    assert.deepEqual(
      st.map((f) => f.params.status.type),
      ['started', 'failed'],
    );
    assert.match(String(st[1]!.params.summary), /not enough messages to compact/i);
    assert.match(kcFailureDetail(st[1]!.params), /not enough messages to compact/i);
    assert.equal(await c.close(15_000), 0);
  });
});

// ───────────── the mock session (the SessionEvent contract alone) ─────────────

function mockSetup(turns: MockTurn[]): { t: TmpEnv; c: TestClient } {
  const t = tmpEnv();
  writeAgent(path.join(t.work, '.kiro'), 'probe', { description: 'probe', tools: ['*'] });
  const c = new TestClient({ args: ['--agent-engine', 'v2', '--agent', 'probe'], env: t.env, cwd: t.work, createSession: mockFactory(createWorld(turns)) });
  clients.push(c);
  return { t, c };
}

describe('r5x X2: compaction_failed from the session (mock)', () => {
  test('started, compaction_failed, text: failed with the reason right before the answer; a second compaction in the turn starts after it', async () => {
    const { t, c } = mockSetup([
      { steps: [{ compactionFailed: 'first reason' }, { text: 'mid ' }, { compactionFailed: 'second reason' }, { compaction: true }, { text: 'end' }] },
    ]);
    await c.initialize();
    const { sessionId: sid } = (await c.call('session/new', { cwd: t.work, mcpServers: [] })) as { sessionId: string };
    const from = c.frames.length;
    const r = await send(c, 'session/prompt', promptOf(sid, 'go')).response;
    const kc = kcTurn(c, sid, from, r);
    assert.deepEqual(kc.statuses, ['started', 'failed', 'started', 'failed', 'started', 'completed'], JSON.stringify(statusFrames(c, from)));
    assert.equal(kc.settled, true);
    assert.equal(kc.kept, 'end');
    const st = statusFrames(c, from);
    assert.equal(kcFailureDetail(st[1]!.params), 'first reason');
    assert.equal(kcFailureDetail(st[3]!.params), 'second reason');
    assert.equal(nextFor(c, c.frames.indexOf(st[1]!), sid)?.params.update?.content?.text, 'mid ');
    assert.equal(r.result.stopReason, 'end_turn');
    assert.equal(await c.close(15_000), 0);
  });

  test('a compaction_failed with no started reported (nothing to close) sends nothing', async () => {
    const { t, c } = mockSetup([{ steps: [{ raw: { type: 'noop' } }, { compactionFailedOnly: 'stray' }, { text: 'end' }] }]);
    await c.initialize();
    const { sessionId: sid } = (await c.call('session/new', { cwd: t.work, mcpServers: [] })) as { sessionId: string };
    const from = c.frames.length;
    const r = await send(c, 'session/prompt', promptOf(sid, 'go')).response;
    assert.deepEqual(kcTurn(c, sid, from, r).statuses, []);
    assert.equal(await c.close(15_000), 0);
  });
});

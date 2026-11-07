/**
 * r5x X2 verifier (group compaction-end), ACP, read the way KiroCrew reads the frames (its
 * kiro-cli backend; KiroCrew source, read-only):
 *
 * - dashboard/chat_turn/session_events.py: a real (not synthesized) compaction terminal is a
 *   segment boundary: the text streamed before it is dropped from the turn's answer, the text
 *   after it is kept. A compaction Claude reports `started` and never ends was closed `failed`
 *   only at the turn's end, AFTER the answer Claude streamed once it went on: the dashboard
 *   dropped that answer. Its `failed` now goes out before the answer (the session ends such a
 *   compaction at Claude's first main-thread output: Claude streams nothing while it compacts).
 * - acp/session_handle_dispatch.py: a `failed` arms a 60 s post-failure budget whose clock runs
 *   from the last frame of the session; the held `failed` of an automatic compaction is meant to
 *   go out with the frame that ends Claude's silence after the failure. A `_session/steer` sent
 *   during that silence made its `AgentExecutionUserMessageQueued` answer carry the `failed` out
 *   early (the clock then ran while Claude was still silent); the frames that answer the client
 *   (steer queued, steer cleared) no longer release it.
 * - A tool call after the failure: `failed` before its `tool_call` and before the
 *   `session/request_permission` it asks (regression guard).
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { TestClient, sleep, tmpEnv, type Frame } from './helpers.js';

const clients: TestClient[] = [];
after(async () => {
  await Promise.allSettled(clients.filter((c) => c.exitCode === undefined).map((c) => c.close(15_000)));
});

const TOO_LONG = 'Conversation too long. Press esc twice to go up a few messages and try again.';
const COMPACTING = { frame: { type: 'system', subtype: 'status', status: 'compacting' } };

const SCRIPT = {
  turns: [
    { repeat: true, match: '^dangling-text', steps: [{ text: 'before ' }, COMPACTING, { text: 'ANSWER dangling' }] },
    { repeat: true, match: '^dangling-tool', steps: [COMPACTING, { tool: { name: 'Read', input: { file_path: '/etc/hostname' } } }, { text: 'ANSWER after the tool' }] },
    { repeat: true, match: '^autoask', steps: [{ autoCompact: 'failed', error: TOO_LONG }, { tool: { name: 'Bash', input: { command: 'touch made-by-test' } } }, { text: 'ANSWER asked' }] },
    { repeat: true, match: '^autolate', steps: [{ autoCompact: 'failed', error: TOO_LONG }, { sleepMs: 4000 }, { text: 'ANSWER late' }] },
  ],
  default: { steps: [{ text: 'ok' }] },
};

/** The answer the dashboard keeps (the text after the last real compaction terminal), the statuses, and whether every `started` was ended. */
function kcTurn(c: TestClient, sid: string, from: number, resp: Frame): { statuses: string[]; kept: string; settled: boolean } {
  const end = c.frames.indexOf(resp);
  const statuses: string[] = [];
  let open = 0;
  let kept = '';
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
    }
  }
  return { statuses, kept, settled: open === 0 };
}

const isStatus = (type: string) => (f: Frame): boolean => f.method === '_kiro.dev/compaction/status' && f.params?.status?.type === type;

let nextId = 650_000;
function send(c: TestClient, method: string, params: unknown, ms = 30_000): Promise<Frame> {
  const id = nextId++;
  const response = c.waitFor((f) => f.id === id && f.method === undefined && ('result' in f || 'error' in f), ms, `response to ${method}#${id}`, c.frames.length);
  c.send({ jsonrpc: '2.0', id, method, params });
  return response;
}

async function setup(): Promise<{ c: TestClient; sid: string }> {
  const t = tmpEnv({ FAKE_CLAUDE_SCRIPT_JSON: JSON.stringify(SCRIPT), FAKE_CLAUDE_PERSIST: '1' });
  const c = new TestClient({ args: [], env: t.env, cwd: t.work });
  clients.push(c);
  await c.initialize();
  const { sessionId } = (await c.call('session/new', { cwd: t.work, mcpServers: [] }, 30_000)) as { sessionId: string };
  await sleep(100); // session/new's post-answer reports are out
  return { c, sid: sessionId };
}

const promptOf = (sid: string, text: string): Record<string, unknown> => ({ sessionId: sid, prompt: [{ type: 'text', text }] });

describe('r5x X2 verifier: compaction status frames as KiroCrew reads them', () => {
  test('a compaction Claude never ends, then an answer: failed BEFORE the answer, so the dashboard keeps it', async () => {
    const { c, sid } = await setup();
    const from = c.frames.length;
    const r = await send(c, 'session/prompt', promptOf(sid, 'dangling-text'));
    assert.equal(r.result?.stopReason, 'end_turn', JSON.stringify(r));
    const kc = kcTurn(c, sid, from, r);
    assert.deepEqual(kc.statuses, ['started', 'failed']);
    assert.equal(kc.settled, true);
    assert.equal(kc.kept, 'ANSWER dangling', `the failed frame came after the answer: KiroCrew's dashboard drops it (${JSON.stringify(kc)})`);
    assert.equal(await c.close(15_000), 0);
  });

  test('a compaction Claude never ends, then a tool call: failed before the tool_call; the answer after it is kept', async () => {
    const { c, sid } = await setup();
    const from = c.frames.length;
    const r = await send(c, 'session/prompt', promptOf(sid, 'dangling-tool'));
    const failed = c.frames.findIndex((f, i) => i >= from && isStatus('failed')(f));
    const call = c.frames.findIndex((f, i) => i >= from && f.method === 'session/update' && f.params.update?.sessionUpdate === 'tool_call');
    assert.ok(failed >= 0 && call > failed, `failed ${failed}, tool_call ${call}`);
    assert.equal(kcTurn(c, sid, from, r).kept, 'ANSWER after the tool');
    assert.equal(await c.close(15_000), 0);
  });

  test('a failed automatic compaction, then a tool that asks: failed before its tool_call and its session/request_permission', async () => {
    const { c, sid } = await setup();
    const from = c.frames.length;
    const r = await send(c, 'session/prompt', promptOf(sid, 'autoask'));
    assert.equal(r.result?.stopReason, 'end_turn', JSON.stringify(r));
    const failed = c.frames.findIndex((f, i) => i >= from && isStatus('failed')(f));
    const call = c.frames.findIndex((f, i) => i >= from && f.method === 'session/update' && f.params.update?.sessionUpdate === 'tool_call');
    const ask = c.frames.findIndex((f, i) => i >= from && f.method === 'session/request_permission');
    assert.ok(ask >= 0, 'the tool asked');
    assert.ok(failed >= 0 && call > failed && ask > failed, `failed ${failed}, tool_call ${call}, request_permission ${ask}`);
    assert.equal(c.frames[failed]!.params.reason, TOO_LONG);
    assert.equal(kcTurn(c, sid, from, r).kept, 'ANSWER asked');
    assert.equal(await c.close(15_000), 0);
  });

  test('a steer sent while Claude is silent after a failed automatic compaction does not carry the failed frame out early', async () => {
    const { c, sid } = await setup();
    const from = c.frames.length;
    const p = send(c, 'session/prompt', promptOf(sid, 'autolate'));
    await c.waitFor(isStatus('started'), 10_000, 'started', from);
    await sleep(300); // Claude reported the failure and is silent now (4 s)
    const steer = await send(c, '_session/steer', { sessionId: sid, message: 'also this' }, 10_000);
    assert.equal(steer.result?.queued, true, JSON.stringify(steer));
    await c.waitFor((f) => f.params?.update?.sessionUpdate === 'AgentExecutionUserMessageQueued', 5_000, 'queued', from);
    await sleep(200);
    assert.equal(
      c.frames.slice(from).filter(isStatus('failed')).length,
      0,
      'the failed frame went out with the steer\'s queued frame, while Claude was still silent: KiroCrew\'s 60 s post-failure clock runs from there',
    );
    const r = await p;
    assert.equal(r.result?.stopReason, 'end_turn', JSON.stringify(r));
    const kc = kcTurn(c, sid, from, r);
    assert.deepEqual(kc.statuses, ['started', 'failed']);
    assert.equal(kc.settled, true);
    // the failed frame goes out right before Claude's next frame, the answer
    const iFailed = c.frames.findIndex((f, i) => i >= from && isStatus('failed')(f));
    const next = c.frames.slice(iFailed + 1).find((f) => f.method !== undefined && f.params?.sessionId === sid);
    assert.equal(next?.params.update?.sessionUpdate, 'agent_message_chunk', JSON.stringify(next));
    assert.equal(await c.close(15_000), 0);
  });
});

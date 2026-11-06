/**
 * The `priority:"next"` queue of claude 2.1.319 (VERIFIED with haiku, see test/fixtures/README.md)
 * and what ClaudeProcess makes of it:
 *  - Claude snapshots its queue right after a tool boundary's results: a `next` line written
 *    after the host SAW those frames is folded in at the FOLLOWING boundary, or — when the model's
 *    next step is final text — answered in a turn of its own after the result. `turn()` keeps the
 *    caller's turn open until such a line is answered (review C3).
 *  - The plain `interrupt` keeps queued lines (they run after the interrupted result);
 *    `cancel_queued:true` drops them. An aborted turn must drop them (review C2).
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ClaudeFrame } from '../../src/claude/protocol.js';
import { ClaudeProcess } from '../../src/claude/process.js';
import { allowAllHandlers, collectTurn, fakeEnv, mkTmp, startFake, waitFor, type FakeHandle, type StartFakeOptions } from './helpers.js';

const open: ClaudeProcess[] = [];
after(async () => {
  await Promise.all(open.map((p) => p.close({ graceMs: 200 }).catch(() => undefined)));
});

async function fake(opts: StartFakeOptions): Promise<FakeHandle> {
  const h = await startFake(opts);
  open.push(h.proc);
  return h;
}

const isToolResult = (f: ClaudeFrame): boolean => {
  const c = (f as { message?: { content?: unknown } }).message?.content;
  return f.type === 'user' && Array.isArray(c) && c.some((b) => (b as { type?: string }).type === 'tool_result');
};
const assistantText = (frames: ClaudeFrame[]): string[] =>
  frames
    .filter((f) => f.type === 'assistant')
    .flatMap((f) => ((f as { message?: { content?: Array<{ type: string; text?: string }> } }).message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? ''));
const lifecycles = (frames: ClaudeFrame[], uuid: string): string[] =>
  frames.filter((f) => f.type === 'command_lifecycle' && (f as { command_uuid?: string }).command_uuid === uuid).map((f) => String((f as { state?: string }).state));

const STEER = '33333333-3333-4333-8333-333333333333';

describe('priority "next" written at a live tool boundary (review C3)', () => {
  it('a steer that misses the last boundary is answered inside the same turn() (not in a turn nobody sees)', { timeout: 15_000 }, async () => {
    const h = await fake({
      script: {
        turns: [
          { match: '^task', steps: [{ tool: { name: 'Bash', input: { command: 'sleep 1' }, permission: 'allow' } }, { text: 'OK' }] },
          { match: 'BANANA', steps: [{ text: 'BANANA' }] },
        ],
      },
    });
    let steered = false;
    // the live frame stream (what the ACP server watches): Claude has already snapshotted its
    // queue for this boundary when the host sees the tool_result
    h.proc.on('frame', (f) => {
      if (!steered && isToolResult(f)) {
        steered = true;
        h.proc.sendUserMessage('Also add the word BANANA.', { uuid: STEER, priority: 'next' });
      }
    });
    const { frames, result } = await collectTurn(h.proc.turn('task: run a tool'));
    assert.ok(steered);
    assert.deepEqual(assistantText(frames), ['OK', 'BANANA'], 'the steer turn is part of the prompt turn');
    const own = h.stdinLines().find((l) => l.type === 'user' && !l.priority)!.uuid as string;
    assert.deepEqual(result.user_message_uuids, [own, STEER], 'the returned result answers the prompt and its steer');
    assert.equal(result.result, 'BANANA');
    assert.equal(frames.filter((f) => f.type === 'result').length, 2, 'both results are yielded');
    assert.ok(lifecycles(frames, STEER).includes('started'));
    assert.equal(h.proc.busy, false);
    // the next turn starts at once (no invisible background turn left)
    const r2 = await collectTurn(h.proc.turn('task again'));
    assert.equal(r2.result.result, 'ok');
  });

  it('usage and num_turns of the continued turn are summed over its results', { timeout: 15_000 }, async () => {
    const h = await fake({
      script: {
        turns: [
          { match: '^task', steps: [{ tool: { name: 'Bash', input: { command: 'true' }, permission: 'allow' } }, { text: 'OK' }] },
          { match: 'more', steps: [{ text: 'MORE' }] },
        ],
      },
    });
    const results: ClaudeFrame[] = [];
    let steered = false;
    h.proc.on('frame', (f) => {
      if (f.type === 'result') results.push(f);
      if (!steered && isToolResult(f)) {
        steered = true;
        h.proc.sendUserMessage('more', { priority: 'next' });
      }
    });
    const { result } = await collectTurn(h.proc.turn('task'));
    assert.equal(results.length, 2);
    const sum = (k: 'input_tokens' | 'output_tokens'): number => results.reduce((n, r) => n + Number((r as { usage?: Record<string, number> }).usage?.[k] ?? 0), 0);
    assert.equal(result.usage?.input_tokens, sum('input_tokens'));
    assert.equal(result.usage?.output_tokens, sum('output_tokens'));
    assert.equal(result.num_turns, results.reduce((n, r) => n + Number((r as { num_turns?: number }).num_turns ?? 0), 0));
    assert.equal(result.total_cost_usd, (results[1] as { total_cost_usd?: number }).total_cost_usd, 'cumulative cost: the last one');
  });

  it('a steer written during a tool run is folded in at that boundary: one result lists both lines', { timeout: 15_000 }, async () => {
    const h = await fake({
      script: { turns: [{ match: '^task', steps: [{ tool: { name: 'Bash', input: { command: 'sleep 1' }, permission: 'allow', durationMs: 400 } }, { text: 'OK {{steerText}}' }] }] },
    });
    // written while the tool runs (before its result), as kiro-cli's own steers are
    h.proc.on('frame', (f) => {
      if (f.type === 'assistant' && JSON.stringify(f).includes('"tool_use"')) h.proc.sendUserMessage('also BANANA', { uuid: STEER, priority: 'next' });
    });
    const { frames, result } = await collectTurn(h.proc.turn('task'));
    assert.deepEqual(result.user_message_uuids?.slice().sort(), [STEER, h.stdinLines().find((l) => l.type === 'user' && !l.priority)!.uuid as string].sort());
    assert.equal(result.result, 'OK also BANANA');
    assert.equal(frames.filter((f) => f.type === 'result').length, 1);
    // `started` right after the boundary's tool_result, `completed` before the result (VERIFIED order)
    const i = (pred: (f: ClaudeFrame) => boolean): number => frames.findIndex(pred);
    const started = i((f) => f.type === 'command_lifecycle' && (f as { command_uuid?: string }).command_uuid === STEER && (f as { state?: string }).state === 'started');
    assert.ok(started > i(isToolResult));
    assert.equal(h.proc.busy, false);
  });
});

describe('aborting a turn with a queued "next" line (review C2)', () => {
  it('interrupts with cancel_queued, so a written steer never runs afterwards', { timeout: 15_000 }, async () => {
    const h = await fake({
      script: {
        turns: [
          { match: '^run', steps: [{ tool: { name: 'Bash', input: { command: 'sleep 3' }, permission: 'allow', durationMs: 50 } }, { tool: { name: 'Bash', input: { command: 'sleep 20' }, permission: 'allow', durationMs: 20_000 } }, { text: 'DONE' }] },
          { match: 'STEERED', steps: [{ tool: { name: 'Bash', input: { command: 'echo STEERED > steered.txt' }, permission: 'allow' } }, { text: 'steered' }] },
          { match: '^follow', steps: [{ text: 'FOLLOWUP' }] },
        ],
      },
    });
    const ac = new AbortController();
    let toolResults = 0;
    let toolUses = 0;
    h.proc.on('frame', (f) => {
      if (isToolResult(f) && ++toolResults === 1) h.proc.sendUserMessage('Additionally run: echo STEERED > steered.txt', { uuid: STEER, priority: 'next' });
      if (f.type === 'assistant' && JSON.stringify(f).includes('"tool_use"') && ++toolUses === 2) setTimeout(() => ac.abort(), 100);
    });
    const { frames, result } = await collectTurn(h.proc.turn('run two tools', { signal: ac.signal }));
    assert.equal(result.subtype, 'error_during_execution');
    const interrupts = h.stdinLines().filter((l) => l.type === 'control_request' && (l.request as { subtype?: string }).subtype === 'interrupt');
    assert.ok(interrupts.length >= 1, 'an interrupt was sent');
    for (const l of interrupts) assert.equal((l.request as { cancel_queued?: unknown }).cancel_queued, true, `interrupt without cancel_queued: ${JSON.stringify(l.request)}`);
    assert.ok(lifecycles(frames, STEER).includes('cancelled'), 'the steer is reported cancelled inside the turn');
    assert.equal(h.proc.busy, false, 'nothing left queued in Claude');
    // the steer never runs: the next prompt is answered at once and is the only turn after the cancel
    const t0 = Date.now();
    const r2 = await collectTurn(h.proc.turn('follow up'));
    assert.equal(r2.result.result, 'FOLLOWUP');
    assert.ok(Date.now() - t0 < 3000);
    const turns = h.log().filter((e) => e.event === 'turn').map((e) => String(e.userText));
    assert.deepEqual(turns, ['run two tools', 'follow up'], `no turn ran for the steer: ${JSON.stringify(turns)}`);
  });

  it('interrupt() returns the CLI answer and settles the lines it lists as cancelled', { timeout: 15_000 }, async () => {
    const h = await fake({ script: { turns: [{ match: '^run', steps: [{ tool: { name: 'Bash', input: { command: 'sleep 20' }, permission: 'allow', durationMs: 20_000 } }, { text: 'DONE' }] }] } });
    const frames: ClaudeFrame[] = [];
    h.proc.on('frame', (f) => frames.push(f));
    const prompt = h.proc.sendUserMessage('run it');
    await waitFor(() => frames.some((f) => f.type === 'assistant'), 5000, 'tool_use');
    const steer = h.proc.sendUserMessage('steer', { priority: 'next' });
    await waitFor(() => lifecycles(frames, steer).includes('queued'), 5000, 'steer queued');
    const answer = await h.proc.interrupt();
    assert.deepEqual(answer, { still_queued: [], cancelled: [steer] });
    await waitFor(() => !h.proc.busy, 5000, 'idle');
    assert.ok(frames.some((f) => f.type === 'result' && ((f as { user_message_uuids?: string[] }).user_message_uuids ?? []).includes(prompt)));
  });
});

describe('withdrawing a queued "next" line (control cancel_async_message, _session/steer/clear)', () => {
  it('drops a line not read yet: `cancelled`, true, and the turn ends at its own result without it', { timeout: 15_000 }, async () => {
    const h = await fake({
      script: {
        turns: [
          {
            match: '^task',
            steps: [
              { tool: { name: 'Bash', input: { command: 'sleep 1' }, permission: 'allow', durationMs: 50 } },
              { tool: { name: 'Bash', input: { command: 'sleep 2' }, permission: 'allow', durationMs: 600 } },
              { text: 'DONE[{{steerText}}]' },
            ],
          },
          { match: 'PAPAYA', steps: [{ text: 'steered' }] },
        ],
      },
    });
    let toolResults = 0;
    let toolUses = 0;
    let withdrawn: Promise<boolean> | undefined;
    h.proc.on('frame', (f) => {
      // written after tool 1's results: Claude would read it at tool 2's boundary
      if (isToolResult(f) && ++toolResults === 1) h.proc.sendUserMessage('PAPAYA', { uuid: STEER, priority: 'next' });
      if (f.type === 'assistant' && JSON.stringify(f).includes('"tool_use"') && ++toolUses === 2) withdrawn = h.proc.cancelQueuedMessage(STEER);
    });
    const { frames, result } = await collectTurn(h.proc.turn('task'));
    assert.equal(await withdrawn, true);
    assert.equal(result.result, 'DONE[]', 'the model never read it');
    assert.deepEqual(lifecycles(frames, STEER), ['queued', 'cancelled']);
    assert.equal(frames.filter((f) => f.type === 'result').length, 1);
    assert.equal(h.proc.busy, false);
    const req = h.stdinLines().find((l) => l.type === 'control_request' && (l.request as { subtype?: string }).subtype === 'cancel_async_message')!;
    assert.deepEqual(req.request, { message_uuid: STEER, subtype: 'cancel_async_message' });
    const turns = h.log().filter((e) => e.event === 'turn').map((e) => String(e.userText));
    assert.deepEqual(turns, ['task']);
  });

  it('answers false for a line already read (folded in): it stays answered by the result', { timeout: 15_000 }, async () => {
    const h = await fake({
      script: { turns: [{ match: '^task', steps: [{ tool: { name: 'Bash', input: { command: 'sleep 1' }, permission: 'allow', durationMs: 300 } }, { sleepMs: 300 }, { text: 'OK {{steerText}}' }] }] },
    });
    let withdrawn: Promise<boolean> | undefined;
    h.proc.on('frame', (f) => {
      if (f.type === 'assistant' && JSON.stringify(f).includes('"tool_use"')) h.proc.sendUserMessage('also BANANA', { uuid: STEER, priority: 'next' });
      if (f.type === 'command_lifecycle' && (f as { command_uuid?: string }).command_uuid === STEER && (f as { state?: string }).state === 'started') withdrawn = h.proc.cancelQueuedMessage(STEER);
    });
    const { result } = await collectTurn(h.proc.turn('task'));
    assert.equal(await withdrawn, false);
    assert.equal(result.result, 'OK also BANANA');
    assert.ok(result.user_message_uuids?.includes(STEER));
  });
});

describe('fake-claude models the real queue (README "Wire behaviour")', () => {
  it('a plain interrupt keeps the queued line: it is listed in still_queued and runs after the interrupted result', { timeout: 15_000 }, async () => {
    const h = await fake({
      script: {
        turns: [
          { match: '^run', steps: [{ tool: { name: 'Bash', input: { command: 'sleep 20' }, permission: 'allow', durationMs: 20_000 } }, { text: 'DONE' }] },
          { match: '^steer', steps: [{ text: 'STEERED' }] },
        ],
      },
    });
    const frames: ClaudeFrame[] = [];
    h.proc.on('frame', (f) => frames.push(f));
    const prompt = h.proc.sendUserMessage('run it');
    await waitFor(() => frames.some((f) => f.type === 'assistant'), 5000, 'tool_use');
    const steer = h.proc.sendUserMessage('steer me', { priority: 'next' });
    await waitFor(() => lifecycles(frames, steer).includes('queued'), 5000, 'steer queued');
    const answer = await h.proc.interrupt({ cancelQueued: false });
    assert.deepEqual(answer, { still_queued: [steer] });
    await waitFor(() => !h.proc.busy, 5000, 'idle');
    const results = frames.filter((f) => f.type === 'result') as Array<{ user_message_uuids?: string[]; result?: string; subtype?: string }>;
    assert.deepEqual(results.map((r) => [r.user_message_uuids, r.subtype]), [
      [[prompt], 'error_during_execution'],
      [[steer], 'success'],
    ]);
    assert.equal(results[1]!.result, 'STEERED');
    // VERIFIED order: interrupted result → own `cancelled` → steer `started` → system/init
    const seq = frames
      .filter((f) => f.type === 'result' || f.type === 'command_lifecycle' || (f.type === 'system' && (f as { subtype?: string }).subtype === 'init'))
      .map((f) => (f.type === 'command_lifecycle' ? `${(f as { command_uuid?: string }).command_uuid === steer ? 'steer' : 'prompt'}:${(f as { state?: string }).state}` : f.type === 'result' ? 'result' : 'init'));
    assert.deepEqual(seq, ['prompt:queued', 'prompt:started', 'init', 'steer:queued', 'result', 'prompt:cancelled', 'steer:started', 'init', 'result', 'steer:completed']);
  });
});

describe('robustness of the continued turn (raw child)', () => {
  // A child that answers the prompt, keeps a steer queued without lifecycle frames, and only
  // reports the steer through the interrupt answer.
  const RAW = `
import * as readline from 'node:readline';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
const sid = '0f8fad5b-d9cb-469f-a165-70867728950e';
let prompt;
let steer;
rl.on('line', (l) => {
  const m = JSON.parse(l);
  if (m.type === 'control_request' && m.request.subtype === 'initialize') {
    out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });
  } else if (m.type === 'user' && !m.priority) {
    prompt = m.uuid;
    out({ type: 'system', subtype: 'init', session_id: sid });
    out({ type: 'assistant', message: { content: [{ type: 'text', text: 'OK' }] }, session_id: sid });
  } else if (m.type === 'user') {
    steer = m.uuid;
    out({ type: 'result', subtype: 'success', is_error: false, result: 'OK', session_id: sid, user_message_uuids: [prompt] });
  } else if (m.type === 'control_request' && m.request.subtype === 'interrupt') {
    out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: m.request.cancel_queued ? { still_queued: [], cancelled: [steer] } : { still_queued: [steer] } } });
  }
});`;

  it('a steer the CLI drops only in the interrupt answer closes the turn (no hang, not busy)', { timeout: 10_000 }, async () => {
    const dir = mkTmp('kc-steer-raw-');
    const file = path.join(dir, 'raw-claude.mjs');
    fs.writeFileSync(file, RAW);
    const proc = await ClaudeProcess.start({
      binary: { path: file, version: '2.1.318', rawVersion: '2.1.318 (Claude Code)' },
      args: ['-p'],
      cwd: dir,
      env: fakeEnv(),
      initialize: {},
      handlers: allowAllHandlers,
      initializeTimeoutMs: 10_000,
    });
    open.push(proc);
    let ownResult = false;
    proc.on('frame', (f) => {
      if (f.type === 'assistant') proc.sendUserMessage('steer', { priority: 'next' });
      if (f.type === 'result') {
        ownResult = true;
        // the turn stays open for the steer; an explicit interrupt drops it
        setTimeout(() => void proc.interrupt(), 50);
      }
    });
    const { result } = await collectTurn(proc.turn('go'));
    assert.ok(ownResult);
    assert.equal(result.result, 'OK');
    assert.equal(proc.busy, false);
  });
});

describe('a folded steer the result does not list (raw child)', () => {
  // A child that folds the steer in at the tool boundary (`started` … `completed`) but lists only
  // the prompt in the result: its `completed` must close the steer, or turn() never ends.
  const RAW_FOLD = `
import * as readline from 'node:readline';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
const sid = '0f8fad5b-d9cb-469f-a165-70867728950e';
let prompt;
rl.on('line', (l) => {
  const m = JSON.parse(l);
  if (m.type === 'control_request' && m.request.subtype === 'initialize') {
    out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });
  } else if (m.type === 'user' && !m.priority) {
    prompt = m.uuid;
    out({ type: 'command_lifecycle', command_uuid: prompt, state: 'queued' });
    out({ type: 'command_lifecycle', command_uuid: prompt, state: 'started' });
    out({ type: 'system', subtype: 'init', session_id: sid });
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_x', name: 'Bash', input: { command: 'true' } }] }, session_id: sid });
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: '' }] }, session_id: sid });
  } else if (m.type === 'user') {
    out({ type: 'command_lifecycle', command_uuid: m.uuid, state: 'queued' });
    out({ type: 'command_lifecycle', command_uuid: m.uuid, state: 'started' });
    out({ type: 'assistant', message: { content: [{ type: 'text', text: 'OK' }] }, session_id: sid });
    out({ type: 'command_lifecycle', command_uuid: m.uuid, state: 'completed' });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'OK', session_id: sid, user_message_uuids: [prompt] });
    out({ type: 'command_lifecycle', command_uuid: prompt, state: 'completed' });
  }
});`;

  it('its `completed` closes it: the turn ends at the result', { timeout: 10_000 }, async () => {
    const dir = mkTmp('kc-steer-fold-');
    const file = path.join(dir, 'raw-claude.mjs');
    fs.writeFileSync(file, RAW_FOLD);
    const proc = await ClaudeProcess.start({
      binary: { path: file, version: '2.1.318', rawVersion: '2.1.318 (Claude Code)' },
      args: ['-p'],
      cwd: dir,
      env: fakeEnv(),
      initialize: {},
      handlers: allowAllHandlers,
      initializeTimeoutMs: 10_000,
    });
    open.push(proc);
    proc.on('frame', (f) => {
      if (isToolResult(f)) proc.sendUserMessage('steer', { priority: 'next' });
    });
    const outcome = await Promise.race([collectTurn(proc.turn('go')).then((r) => r.result.result), new Promise((r) => setTimeout(() => r('HANG'), 3000))]);
    assert.equal(outcome, 'OK');
    assert.equal(proc.busy, false);
  });
});

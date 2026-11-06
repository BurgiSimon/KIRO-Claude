/**
 * `_session/steer` against the REAL session module and test/fixtures/fake-claude.mjs, whose
 * `priority:"next"` queue behaves like claude 2.1.319 (VERIFIED with haiku): Claude snapshots its
 * queue right after a tool boundary's results, so the steer this server writes at the live
 * `tool_end` is read at the FOLLOWING boundary, or — after the last tool — in a turn of its own
 * right after the prompt's result.
 *
 *  C2: a session/cancel while such a steer is queued in Claude must drop it (interrupt
 *      `cancel_queued`) and report it `AgentExecutionUserMessageCleared`; nothing may run after
 *      the `cancelled` answer, and the next prompt is answered at once.
 *  C3: a steer written at the last tool boundary is answered inside the same prompt request:
 *      `AgentExecutionSteeringInjected` when Claude starts it, its reply as agent_message_chunk
 *      before the response, and the journal in the order the model saw it.
 *  C4: `_kiro.dev/subagent/list_update` roster entries in the shape KiroCrew reads.
 *  `_session/steer/clear` while such a steer waits in Claude's queue withdraws it
 *      (`cancel_async_message`) and names it in the one `AgentExecutionUserMessageCleared`.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { TestClient, tmpEnv, until, writeAgent, type Frame, type TmpEnv } from './helpers.js';

let sessionModuleOk = true;
try {
  await import('../../src/session/kiroSession.js');
} catch {
  sessionModuleOk = false;
}
const skip = sessionModuleOk ? false : 'src/session/kiroSession.ts is not available';

const clients: TestClient[] = [];
after(async () => {
  await Promise.allSettled(clients.filter((c) => c.exitCode === undefined).map((c) => c.close(15_000)));
});

interface E2E {
  t: TmpEnv;
  c: TestClient;
  log: string;
}

function e2e(script: unknown, args: string[] = ['--trust-all-tools']): E2E {
  const t = tmpEnv({ FAKE_CLAUDE_SCRIPT_JSON: JSON.stringify(script), FAKE_CLAUDE_PERSIST: '1' });
  const log = path.join(t.root, 'fake-claude.jsonl');
  t.env.FAKE_CLAUDE_LOG = log;
  writeAgent(path.join(t.work, '.kiro'), 'kc-probe', { description: 'probe', tools: ['*'], allowedTools: [], includeMcpJson: false });
  const c = new TestClient({ args: ['--agent-engine', 'v2', '--agent', 'kc-probe', ...args], env: t.env, cwd: t.work });
  clients.push(c);
  return { t, c, log };
}

function fakeLog(file: string): Frame[] {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Frame);
  } catch {
    return [];
  }
}

async function newSession(e: E2E): Promise<string> {
  await e.c.initialize();
  return (await e.c.call('session/new', { cwd: e.t.work, mcpServers: [] }, 30_000)).sessionId as string;
}

const promptReq = (c: TestClient, sid: string, text: string, ms = 30_000) => c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text }] }, ms);
const isUpdate = (kind: string) => (f: Frame) => f.method === 'session/update' && f.params?.update?.sessionUpdate === kind;
const isKiro = (kind: string) => (f: Frame) => f.method === '_kiro.dev/session/update' && f.params?.update?.sessionUpdate === kind;
const journal = (e: E2E, sid: string): Frame[] =>
  fs
    .readFileSync(path.join(e.t.kiroHome, 'sessions', 'cli', `${sid}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Frame);
const recText = (r: Frame): string => ((r.data?.content ?? []) as Frame[]).filter((b) => b.kind === 'text').map((b) => String(b.data)).join('');

async function finish(e: E2E): Promise<void> {
  assert.equal(await e.c.close(20_000), 0);
  assert.deepEqual(e.c.nonJson, [], 'stdout carries only JSON-RPC frames');
}

// ───────────────────────────── C3 ─────────────────────────────

test('C3: a steer written at the last tool boundary is answered inside the same prompt (Injected when Claude starts it)', { skip, timeout: 60_000 }, async () => {
  const e = e2e({
    turns: [
      { match: '^TASK', steps: [{ tool: { id: 'toolu_s1', name: 'Bash', input: { command: 'sleep 1' }, durationMs: 400 } }, { text: 'OK' }] },
      { match: 'BANANA', steps: [{ text: 'BANANA' }] },
      { match: '^NEXT', steps: [{ text: 'NEXT-OK' }] },
    ],
  });
  const sid = await newSession(e);
  const steerText = '<user_message>\nAlso, at the very end of your reply, add the word BANANA.\n</user_message>';
  const p = promptReq(e.c, sid, 'TASK: run a tool');
  await e.c.waitFor(isUpdate('tool_call'), 15_000, 'tool_call');
  assert.deepEqual(await e.c.call('_session/steer', { sessionId: sid, message: steerText }), { queued: true });
  const r = await p;
  assert.equal(r.result.stopReason, 'end_turn');
  const resp = e.c.frames.indexOf(r);
  const chunks = e.c.frames.map((f, i) => [f, i] as const).filter(([f]) => isUpdate('agent_message_chunk')(f) && f.params.sessionId === sid);
  const banana = chunks.find(([f]) => String(f.params.update.content.text).includes('BANANA'));
  assert.ok(banana, `the steered reply reaches the client: ${JSON.stringify(chunks.map(([f]) => f.params.update.content.text))}`);
  assert.ok(banana[1] < resp, 'before the prompt response');
  // the steer's answer is a new paragraph, not glued onto the pre-steer reply ("OKBANANA")
  assert.equal(chunks.map(([f]) => f.params.update.content.text).join(''), 'OK\n\nBANANA');
  const q = e.c.frames.findIndex(isKiro('AgentExecutionUserMessageQueued'));
  const inj = e.c.frames.findIndex(isKiro('AgentExecutionSteeringInjected'));
  const done = e.c.frames.findIndex((f) => isUpdate('tool_call_update')(f) && f.params.update.toolCallId === 'toolu_s1' && f.params.update.status === 'completed');
  const ok = chunks.find(([f]) => f.params.update.content.text === 'OK')![1];
  assert.ok(q >= 0 && done > q, 'queued while the tool ran');
  assert.ok(inj > ok, 'Injected when Claude starts the steer (after the pre-steer reply), not at the tool result');
  assert.ok(inj < banana[1], 'Injected before the steered reply');
  assert.equal(e.c.frames[inj]!.params.update.messageId, e.c.frames[q]!.params.update.messageId);
  assert.equal(e.c.frames[inj]!.params.update.content, steerText);
  assert.equal(e.c.frames.filter(isKiro('AgentExecutionSteeringInjected')).length, 1);
  assert.equal(e.c.frames.filter(isKiro('AgentExecutionUserMessageCleared')).length, 0);
  // the journal records the steer where the model read it
  const recs = journal(e, sid).map((x) => `${x.kind}:${recText(x)}`);
  assert.deepEqual(recs, ['Prompt:TASK: run a tool', 'AssistantMessage:', 'ToolResults:', 'AssistantMessage:OK', `Prompt:${steerText}`, 'AssistantMessage:BANANA']);
  // nothing left running in Claude: the next prompt is answered at once
  const t0 = Date.now();
  const r2 = await promptReq(e.c, sid, 'NEXT');
  assert.equal(r2.result.stopReason, 'end_turn');
  assert.ok(Date.now() - t0 < 5000, `next prompt took ${Date.now() - t0} ms`);
  assert.equal(e.c.updates('agent_message_chunk', sid).pop()!.content.text, 'NEXT-OK');
  await finish(e);
});

test('a steer written during a tool that is followed by another tool is injected at that next boundary, same prompt', { skip, timeout: 60_000 }, async () => {
  const e = e2e({
    turns: [
      {
        match: '^TWO',
        steps: [
          { tool: { id: 'toolu_a', name: 'Bash', input: { command: 'sleep 1' }, durationMs: 400 } },
          { tool: { id: 'toolu_b', name: 'Bash', input: { command: 'sleep 1' }, durationMs: 200 } },
          { text: 'DONE {{steerText}}' },
        ],
      },
    ],
  });
  const sid = await newSession(e);
  const p = promptReq(e.c, sid, 'TWO tools');
  await e.c.waitFor((f) => isUpdate('tool_call')(f) && f.params.update.toolCallId === 'toolu_a', 15_000, 'tool_call a');
  await e.c.call('_session/steer', { sessionId: sid, message: 'PAPAYA' });
  const r = await p;
  assert.equal(r.result.stopReason, 'end_turn');
  const inj = e.c.frames.findIndex(isKiro('AgentExecutionSteeringInjected'));
  const bDone = e.c.frames.findIndex((f) => isUpdate('tool_call_update')(f) && f.params.update.toolCallId === 'toolu_b' && f.params.update.status === 'completed');
  assert.ok(inj > bDone, 'Injected after the boundary Claude read it at');
  assert.match(e.c.updates('agent_message_chunk', sid).map((u) => u.content.text).join(''), /DONE PAPAYA/);
  const recs = journal(e, sid).map((x) => x.kind);
  assert.deepEqual(recs, ['Prompt', 'AssistantMessage', 'ToolResults', 'AssistantMessage', 'ToolResults', 'Prompt', 'AssistantMessage']);
  await finish(e);
});

// ───────────────────────────── C2 ─────────────────────────────

test('C2: session/cancel while a written steer is queued in Claude drops it (cleared), nothing runs after the cancel', { skip, timeout: 60_000 }, async () => {
  const e = e2e({
    turns: [
      {
        match: '^RUN',
        steps: [
          { tool: { id: 'toolu_1', name: 'Bash', input: { command: 'sleep 3' }, durationMs: 400 } },
          { tool: { id: 'toolu_2', name: 'Bash', input: { command: 'sleep 20' }, durationMs: 20_000 } },
          { text: 'DONE' },
        ],
      },
      { match: 'STEERED', steps: [{ tool: { name: 'Bash', input: { command: 'sleep 20' } } }, { tool: { name: 'Bash', input: { command: 'echo STEERED > steered.txt' } } }, { text: 'steered' }] },
      { match: '^FOLLOW', steps: [{ text: 'FOLLOWUP' }] },
    ],
  });
  const sid = await newSession(e);
  const p = promptReq(e.c, sid, 'RUN sleep 3, then sleep 20, then say DONE');
  await e.c.waitFor((f) => isUpdate('tool_call')(f) && f.params.update.toolCallId === 'toolu_1', 15_000, 'tool 1');
  assert.deepEqual(await e.c.call('_session/steer', { sessionId: sid, message: 'Additionally run exactly: echo STEERED > steered.txt' }), { queued: true });
  await e.c.waitFor((f) => isUpdate('tool_call')(f) && f.params.update.toolCallId === 'toolu_2', 15_000, 'tool 2');
  // the steer has been written to Claude (at tool 1's result) and waits in its queue
  await until(() => fakeLog(e.log).some((x) => x.event === 'stdin' && x.line?.type === 'user' && x.line.priority === 'next'), 5000, 'steer written');
  const queuedId = e.c.frames.find(isKiro('AgentExecutionUserMessageQueued'))!.params.update.messageId as string;
  await new Promise((r) => setTimeout(r, 200));
  e.c.notify('session/cancel', { sessionId: sid });
  const r = await p;
  assert.equal(r.result.stopReason, 'cancelled');
  const resp = e.c.frames.indexOf(r);
  const cleared = e.c.frames.filter(isKiro('AgentExecutionUserMessageCleared'));
  assert.equal(cleared.length, 1, 'the dropped steer is reported cleared');
  assert.deepEqual(cleared[0]!.params.update.messageIds, [queuedId]);
  assert.ok(e.c.frames.indexOf(cleared[0]!) < resp, 'before the cancelled answer');
  assert.equal(e.c.frames.filter(isKiro('AgentExecutionSteeringInjected')).length, 0, 'never reported injected');
  const interrupts = fakeLog(e.log).filter((x) => x.event === 'stdin' && x.line?.type === 'control_request' && x.line.request?.subtype === 'interrupt');
  assert.ok(interrupts.length >= 1 && interrupts.every((x) => x.line.request.cancel_queued === true), 'interrupt with cancel_queued');
  // a follow-up prompt answers at once and nothing ran for the steer
  const t0 = Date.now();
  const r2 = await promptReq(e.c, sid, 'FOLLOW up');
  assert.equal(r2.result.stopReason, 'end_turn');
  assert.ok(Date.now() - t0 < 5000, `follow-up took ${Date.now() - t0} ms`);
  const turns = fakeLog(e.log).filter((x) => x.event === 'turn').map((x) => String(x.userText));
  assert.equal(turns.length, 2, `no turn ran for the steer: ${JSON.stringify(turns)}`);
  assert.ok(!fs.existsSync(path.join(e.t.work, 'steered.txt')));
  // the cancelled steer is not in the journal (the model never read it)
  assert.ok(!journal(e, sid).some((x) => x.kind === 'Prompt' && recText(x).includes('STEERED')));
  await finish(e);
});

// ─────────────── _session/steer/clear after the steer was written ───────────────
// KiroCrew (agent_sdk/backends_turns.py ACP_BACKENDS_STEER_RETRACT, dashboard/steer_retract.py)
// takes back a steer that is still pending (Queued, not Injected) with `_session/steer/clear`, and
// reads the clear as dropping EVERY pending steer: one AgentExecutionUserMessageCleared, after
// which it resends the pending steers it did not mean to take back. A steer written to Claude but
// not read yet (Injected only on its `started`, review C3) is pending in that sense, so the clear
// must withdraw it from Claude's queue too (control `cancel_async_message`, VERIFIED 2.1.319).

const writtenSteers = (log: string): Frame[] => fakeLog(log).filter((x) => x.event === 'stdin' && x.line?.type === 'user' && x.line.priority === 'next');

test('_session/steer/clear withdraws a steer written to Claude but not read yet: Cleared names it, the model never reads it', { skip, timeout: 60_000 }, async () => {
  const e = e2e({
    turns: [
      {
        match: '^CLR',
        steps: [
          { tool: { id: 'toolu_c1', name: 'Bash', input: { command: 'sleep 1' }, durationMs: 300 } },
          { tool: { id: 'toolu_c2', name: 'Bash', input: { command: 'sleep 3' }, durationMs: 2500 } },
          { text: 'DONE[{{steerText}}]' },
        ],
      },
      { match: 'PAPAYA', steps: [{ text: 'steered' }] },
      { match: '^NEXT', steps: [{ text: 'NEXT-OK' }] },
    ],
  });
  const sid = await newSession(e);
  const p = promptReq(e.c, sid, 'CLR two tools');
  await e.c.waitFor((f) => isUpdate('tool_call')(f) && f.params.update.toolCallId === 'toolu_c1', 15_000, 'tool 1');
  assert.deepEqual(await e.c.call('_session/steer', { sessionId: sid, message: 'PAPAYA' }), { queued: true });
  const queuedId = (await e.c.waitFor(isKiro('AgentExecutionUserMessageQueued'))).params.update.messageId as string;
  await e.c.waitFor((f) => isUpdate('tool_call')(f) && f.params.update.toolCallId === 'toolu_c2', 15_000, 'tool 2');
  await until(() => writtenSteers(e.log).length === 1, 5000, 'steer written to Claude');
  // Claude has it queued for tool 2's boundary: still pending, so the clear takes it back
  assert.deepEqual(await e.c.call('_session/steer/clear', { sessionId: sid }), { cleared: true });
  const cleared = await e.c.waitFor(isKiro('AgentExecutionUserMessageCleared'), 5000, 'cleared');
  assert.deepEqual(cleared.params.update.messageIds, [queuedId]);
  const r = await p;
  assert.equal(r.result.stopReason, 'end_turn');
  assert.equal(e.c.updates('agent_message_chunk', sid).map((u) => u.content.text).join(''), 'DONE[]', 'the model never read the steer');
  assert.equal(e.c.frames.filter(isKiro('AgentExecutionSteeringInjected')).length, 0, 'never reported injected');
  assert.equal(e.c.frames.filter(isKiro('AgentExecutionUserMessageCleared')).length, 1);
  const cams = fakeLog(e.log).filter((x) => x.event === 'stdin' && x.line?.type === 'control_request' && x.line.request?.subtype === 'cancel_async_message');
  assert.deepEqual(cams.map((x) => x.line.request.message_uuid), [writtenSteers(e.log)[0]!.line.uuid]);
  assert.ok(!journal(e, sid).some((x) => x.kind === 'Prompt' && recText(x).includes('PAPAYA')), 'not journaled');
  // nothing left queued in Claude: the next prompt is answered at once, and only it runs
  const t0 = Date.now();
  assert.equal((await promptReq(e.c, sid, 'NEXT')).result.stopReason, 'end_turn');
  assert.ok(Date.now() - t0 < 5000, `next prompt took ${Date.now() - t0} ms`);
  const turns = fakeLog(e.log).filter((x) => x.event === 'turn').map((x) => String(x.userText));
  assert.equal(turns.length, 2, `no turn ran for the steer: ${JSON.stringify(turns)}`);
  await finish(e);
});

test('_session/steer/clear with one steer written and one held: ONE Cleared names both; a steer sent after the clear is injected', { skip, timeout: 60_000 }, async () => {
  const e = e2e({
    turns: [
      {
        match: '^MIX',
        steps: [
          { tool: { id: 'toolu_m1', name: 'Bash', input: { command: 'sleep 1' }, durationMs: 300 } },
          { tool: { id: 'toolu_m2', name: 'Bash', input: { command: 'sleep 3' }, durationMs: 2500 } },
          { tool: { id: 'toolu_m3', name: 'Bash', input: { command: 'sleep 1' }, durationMs: 300 } },
          { text: 'DONE[{{steerText}}]' },
        ],
      },
    ],
  });
  const sid = await newSession(e);
  const p = promptReq(e.c, sid, 'MIX three tools');
  await e.c.waitFor((f) => isUpdate('tool_call')(f) && f.params.update.toolCallId === 'toolu_m1', 15_000, 'tool 1');
  await e.c.call('_session/steer', { sessionId: sid, message: 'ALPHA' });
  await e.c.waitFor((f) => isUpdate('tool_call')(f) && f.params.update.toolCallId === 'toolu_m2', 15_000, 'tool 2');
  await until(() => writtenSteers(e.log).length === 1, 5000, 'ALPHA written to Claude');
  await e.c.call('_session/steer', { sessionId: sid, message: 'BETA' }); // held by the server
  const ids = e.c.frames.filter(isKiro('AgentExecutionUserMessageQueued')).map((f) => f.params.update.messageId as string);
  assert.equal(ids.length, 2);
  assert.deepEqual(await e.c.call('_session/steer/clear', { sessionId: sid }), { cleared: true });
  const cleared = await e.c.waitFor(isKiro('AgentExecutionUserMessageCleared'), 5000, 'cleared');
  assert.deepEqual([...cleared.params.update.messageIds].sort(), [...ids].sort(), 'one Cleared names every pending steer');
  // a steer sent after the clear is not dropped by it: written at tool 2's end, read at tool 3's
  await e.c.call('_session/steer', { sessionId: sid, message: 'GAMMA' });
  const r = await p;
  assert.equal(r.result.stopReason, 'end_turn');
  assert.equal(e.c.frames.filter(isKiro('AgentExecutionUserMessageCleared')).length, 1);
  const inj = e.c.frames.filter(isKiro('AgentExecutionSteeringInjected'));
  assert.deepEqual(inj.map((f) => f.params.update.content), ['GAMMA']);
  assert.equal(e.c.updates('agent_message_chunk', sid).map((u) => u.content.text).join(''), 'DONE[GAMMA]');
  await finish(e);
});

// ───────────────────────────── C4 ─────────────────────────────

const AGENT_INPUT = { description: 'count files', prompt: 'Count the files.', subagent_type: 'general-purpose' };

test('C4: subagent/list_update entries carry sessionId, initialQuery, agentName and status {type,message} (KiroCrew shape)', { skip, timeout: 60_000 }, async () => {
  const e = e2e({
    turns: [
      { match: '^OK', steps: [{ tool: { id: 'toolu_sub1', name: 'Agent', input: AGENT_INPUT, result: 'There are 3 files.' } }, { text: 'done' }] },
      { match: '^FAIL', steps: [{ tool: { id: 'toolu_sub2', name: 'Agent', input: AGENT_INPUT, result: 'boom', is_error: true } }, { text: 'failed' }] },
    ],
  });
  const sid = await newSession(e);
  assert.equal((await promptReq(e.c, sid, 'OK delegate')).result.stopReason, 'end_turn');
  const lists = () => e.c.notifications('_kiro.dev/subagent/list_update').map((f) => f.params);
  const ok = lists();
  assert.equal(ok.length, 2);
  for (const p of ok) assert.equal(p.sessionId, sid, 'top-level sessionId routes the roster to its owner');
  const entry = (status: Record<string, unknown>) => ({
    sessionId: 'toolu_sub1',
    sessionName: 'count files',
    agentName: 'general-purpose',
    role: 'general-purpose',
    initialQuery: 'Count the files.',
    status,
  });
  assert.deepEqual(ok[0]!.subagents, [entry({ type: 'working', message: '' })]);
  assert.deepEqual(ok[1]!.subagents, [entry({ type: 'completed', message: '' })]);

  assert.equal((await promptReq(e.c, sid, 'FAIL delegate')).result.stopReason, 'end_turn');
  const fail = lists().slice(2);
  assert.equal(fail.length, 2);
  assert.equal(fail[0]!.subagents[0].status.type, 'working');
  assert.equal(fail[1]!.subagents[0].sessionId, 'toolu_sub2');
  assert.equal(fail[1]!.subagents[0].status.type, 'failed', 'an Agent tool_result error is a failed subagent');
  assert.match(fail[1]!.subagents[0].status.message, /boom/);
  await finish(e);
});

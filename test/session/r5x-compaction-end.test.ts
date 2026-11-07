/**
 * r5x X2 (group compaction-end): a compaction that Claude reports `started` and that ends without
 * compacting has an end the front ends can show.
 *
 * claude 2.1.319 reports a compaction that did not happen as `system/status` `compacting`, then
 * `system/status` `{status:null, compact_result:'failed', compact_error}` and no compact_boundary
 * (VERIFIED for the manual refusal "Not enough messages to compact.", r5 #8 verifier; the same
 * frames for an automatic compaction inside a prompt turn, which the fake scripts with the
 * `autoCompact` step). Before this fix KiroSession published no event for it: the REPL left
 * "Summarizing the conversation history..." open and ACP sent `compaction/status` `started` with
 * no end frame. KiroSession now publishes `compaction_failed` (with Claude's reason) for every
 * `started` that ends that way, in any turn, and for one still open when the turn ends (the
 * interrupt, a child that died, a compaction Claude never ended).
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import type { ClaudeCapabilities } from '../../src/claude/binary.js';
import type { SessionEvent } from '../../src/types.js';
import { readJournal } from '../../src/session/kiroFiles.js';
import { KiroSessionImpl, type KiroSessionInternalOptions } from '../../src/session/kiroSession.js';
import { STREAM_ARGS, fakeEnv } from '../claude/helpers.js';
import { closeAll, drain, fakeBinary, fakeCaps, fakeClaudePath, mkSandbox, recordingUI, semantic, type RecordingUI, type Sandbox } from './helpers.js';

let caps: ClaudeCapabilities;
before(async () => {
  caps = await fakeCaps();
});

const TOO_LONG = 'Conversation too long. Press esc twice to go up a few messages and try again.';
const NOT_ENOUGH = 'Not enough messages to compact.';

const SCRIPT = {
  turns: [
    { repeat: true, match: '^autofail', steps: [{ text: 'before ' }, { autoCompact: 'failed', error: TOO_LONG }, { text: 'ANSWER after the failed compaction' }] },
    { repeat: true, match: '^autodefault', steps: [{ autoCompact: 'failed' }, { text: 'ANSWER default' }] },
    { repeat: true, match: '^autoslow', steps: [{ autoCompact: 'failed', durationMs: 5000, error: TOO_LONG }, { text: 'never' }] },
    // Claude reports the start and never the end of it
    { repeat: true, match: '^dangling', steps: [{ frame: { type: 'system', subtype: 'status', status: 'compacting' } }, { text: 'ANSWER dangling' }] },
  ],
  default: { steps: [{ text: 'ok' }] },
};

const open = (sb: Sandbox, over: Partial<KiroSessionInternalOptions> = {}, ui: RecordingUI = recordingUI()): Promise<KiroSessionImpl> =>
  KiroSessionImpl.create({ ws: sb.ws, origin: 'repl', interactive: true, ui, binary: fakeBinary(), caps, env: sb.env, ...over });

/** The compaction events in order, as `started` / `finished` / `failed:<reason>`. */
function compactions(events: SessionEvent[]): string[] {
  const out: string[] = [];
  for (const e of semantic(events)) {
    if (e.type === 'compaction') out.push(e.state);
    else if (e.type === 'compaction_failed') out.push(`failed${e.cancelled ? '(cancelled)' : ''}:${e.reason}`);
  }
  return out;
}

const answerText = (events: SessionEvent[]): string =>
  semantic(events)
    .filter((e): e is Extract<SessionEvent, { type: 'text' | 'text_delta' }> => e.type === 'text' || e.type === 'text_delta')
    .map((e) => e.text)
    .join('');

/** Every frame the fake writes for one scripted line in a new `--session-id` session. */
async function fakeTurn(sb: Sandbox, text: string, interruptAfterMs?: number): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fakeClaudePath(), ...STREAM_ARGS, '--session-id', randomUUID()], { cwd: sb.cwd, env: fakeEnv({ ...sb.env }), stdio: ['pipe', 'pipe', 'pipe'] });
    const got: Array<Record<string, unknown>> = [];
    let buf = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('fake timed out'));
    }, 20_000);
    child.stdout.on('data', (x: Buffer) => {
      buf += x.toString();
      let k: number;
      while ((k = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, k);
        buf = buf.slice(k + 1);
        try {
          const f = JSON.parse(l) as Record<string, unknown>;
          got.push(f);
          if (f.type === 'result') child.stdin.end();
          if (interruptAfterMs !== undefined && f.type === 'system' && f.subtype === 'status' && f.status === 'compacting') {
            setTimeout(() => child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'int-1', request: { subtype: 'interrupt' } }) + '\n'), interruptAfterMs);
          }
        } catch {
          /* not JSON */
        }
      }
    });
    child.on('exit', () => {
      clearTimeout(timer);
      resolve(got);
    });
    child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '', uuid: randomUUID() }) + '\n');
  });
}

const statusFrames = (frames: Array<Record<string, unknown>>): unknown[][] =>
  frames.filter((f) => f.type === 'system' && f.subtype === 'status' && f.status !== 'requesting').map((f) => [f.status, f.compact_result, f.compact_error]);

describe('r5x X2: the fake scripts an automatic compaction that fails, as 2.1.319 reports one', () => {
  it('{autoCompact:"failed", error}: status compacting, then status null with compact_result failed and the error; no boundary; the turn goes on', async () => {
    const sb = mkSandbox({ script: SCRIPT });
    const frames = await fakeTurn(sb, 'autofail now');
    assert.deepEqual(statusFrames(frames), [
      ['compacting', undefined, undefined],
      [null, 'failed', TOO_LONG],
    ]);
    assert.equal(frames.some((f) => f.type === 'system' && f.subtype === 'compact_boundary'), false, 'a failed compaction has no boundary');
    const result = frames.find((f) => f.type === 'result')!;
    assert.equal(result.is_error, false, JSON.stringify(result));
    assert.equal(result.result, 'ANSWER after the failed compaction');
    // the compaction sits between two assistant messages: the text before it is a message of its own
    const iStatus = frames.findIndex((f) => f.type === 'system' && f.subtype === 'status' && f.status === 'compacting');
    const before = frames.slice(0, iStatus).filter((f) => f.type === 'assistant');
    const after = frames.slice(iStatus).filter((f) => f.type === 'assistant');
    assert.equal(before.length, 1);
    assert.equal(after.length, 1);
    assert.notEqual((before[0]!.message as { id: string }).id, (after[0]!.message as { id: string }).id);
  });

  it('without an error: a default compact_error; interrupted while it runs: compact_result failed with no error, then the interrupted result', async () => {
    const sb = mkSandbox({ script: SCRIPT });
    const plain = await fakeTurn(sb, 'autodefault');
    const failed = statusFrames(plain)[1]!;
    assert.equal(failed[1], 'failed');
    assert.equal(typeof failed[2], 'string');
    assert.ok(String(failed[2]).length > 0);
    const cut = await fakeTurn(sb, 'autoslow', 100);
    assert.deepEqual(statusFrames(cut), [
      ['compacting', undefined, undefined],
      [null, 'failed', undefined],
    ]);
    const result = cut.find((f) => f.type === 'result')!;
    assert.equal(result.subtype, 'error_during_execution', JSON.stringify(result));
    assert.equal(cut.some((f) => f.type === 'assistant' && JSON.stringify(f).includes('never')), false);
  });
});

describe('r5x X2: KiroSession publishes the end of a compaction that failed', () => {
  it('an automatic compaction that fails inside a prompt turn: started, then compaction_failed with the reason; the turn answers as usual', async () => {
    const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const s = await open(sb);
    try {
      const { events, result } = await drain(s.prompt({ text: 'autofail one' }));
      assert.deepEqual(compactions(events), ['started', `failed:${TOO_LONG}`], JSON.stringify(semantic(events)));
      assert.equal(result.isError, false, JSON.stringify(result));
      assert.equal(result.stopReason, 'end_turn');
      assert.equal(result.text, 'ANSWER after the failed compaction');
      // the end comes where Claude reported it: after the text before it, before the answer after it
      const sem = semantic(events);
      const iFailed = sem.findIndex((e) => e.type === 'compaction_failed');
      assert.match(answerText(sem.slice(0, iFailed)), /^before/);
      assert.match(answerText(sem.slice(iFailed)), /^ANSWER after/);
      assert.deepEqual(readJournal(sb.sessionsDir, s.id).filter((j) => j.kind === 'Compaction'), [], 'a failed compaction is journaled');
      // the failed compaction ended Claude's "compacting" state: the next one is reported whole
      const { events: again } = await drain(s.prompt({ text: 'autofail two' }));
      assert.deepEqual(compactions(again), ['started', `failed:${TOO_LONG}`]);
      const { events: manual, result: ok } = await drain(s.compact());
      assert.equal(ok.isError, false, JSON.stringify(ok));
      assert.deepEqual(compactions(manual), ['started', 'finished']);
    } finally {
      await closeAll(s);
    }
  });

  it('the live "event" stream carries the same end (ACP and other listeners)', async () => {
    const sb = mkSandbox({ script: SCRIPT });
    const s = await open(sb);
    const live: SessionEvent[] = [];
    s.on('event', (e: SessionEvent) => live.push(e));
    try {
      await drain(s.prompt({ text: 'autodefault' }));
      const got = compactions(live);
      assert.equal(got.length, 2, JSON.stringify(got));
      assert.equal(got[0], 'started');
      assert.match(got[1]!, /^failed:./);
    } finally {
      await closeAll(s);
    }
  });

  it('a manual /compact Claude refuses after a local command: started, then compaction_failed once with the same reason as the turn error', async () => {
    const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const s = await open(sb);
    try {
      await s.setEffort('high');
      const { events, result } = await drain(s.compact());
      assert.equal(result.isError, true);
      assert.equal(result.error, NOT_ENOUGH);
      assert.deepEqual(compactions(events), ['started', `failed:${NOT_ENOUGH}`]);
    } finally {
      await closeAll(s);
    }
  });

  it('a manual /compact of a new session (refused with no status): no compaction event at all, as before', async () => {
    const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const s = await open(sb);
    try {
      const { events, result } = await drain(s.compact());
      assert.equal(result.isError, true);
      assert.deepEqual(compactions(events), []);
    } finally {
      await closeAll(s);
    }
  });

  it('a compaction Claude reports started and never ends: compaction_failed when the turn ends, before its result; the next one starts again', async () => {
    const sb = mkSandbox({ script: SCRIPT });
    const s = await open(sb);
    try {
      const { events, result } = await drain(s.prompt({ text: 'dangling' }));
      assert.equal(result.isError, false, JSON.stringify(result));
      const got = compactions(events);
      assert.equal(got.length, 2, JSON.stringify(got));
      assert.equal(got[0], 'started');
      assert.match(got[1]!, /^failed:.*did not finish/i);
      const { events: again } = await drain(s.prompt({ text: 'autodefault' }));
      assert.equal(compactions(again)[0], 'started', 'the compacting state stayed set after a turn that never ended it');
    } finally {
      await closeAll(s);
    }
  });

  it('an interrupt while Claude compacts: compaction_failed marked cancelled; the turn is cancelled', async () => {
    const sb = mkSandbox({ script: SCRIPT });
    const s = await open(sb);
    try {
      const gen = s.prompt({ text: 'autoslow' });
      const events: SessionEvent[] = [];
      let n = await gen.next();
      while (!n.done) {
        events.push(n.value);
        if (n.value.type === 'compaction' && n.value.state === 'started') void s.interrupt();
        n = await gen.next();
      }
      assert.equal(n.value.stopReason, 'cancelled', JSON.stringify(n.value));
      const got = compactions(events);
      assert.equal(got.length, 2, JSON.stringify(got));
      assert.equal(got[0], 'started');
      assert.match(got[1]!, /^failed\(cancelled\):/);
    } finally {
      await closeAll(s);
    }
  });
});

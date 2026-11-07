/**
 * r5 #8, verifier (session group): the OTHER way claude 2.1.319 refuses a `/compact` of a
 * session that holds no message of the conversation.
 *
 * VERIFIED with the real claude 2.1.319 (verifier probe, no model call; `--session-id` session):
 *  - `/compact` as the session's first line: the failed synthetic frame ("Error: No messages to
 *    compact", `local_command_outcome` `failed`, no status) — r5 #8, already handled;
 *  - `/compact` after a local command (`/effort low`, or a first `/compact`), so the session holds
 *    only local-command entries: `system/status` `compacting`, then `system/status`
 *    `{status:null, compact_result:'failed', compact_error:'Not enough messages to compact.'}`,
 *    `system/init`, a synthetic assistant frame with the text `Not enough messages to compact.`,
 *    `local_command_source` `<local-command-stdout>…`, `local_command_run` `{command:'compact'}`
 *    and NO `local_command_outcome`, then a result `{subtype:'success', is_error:false,
 *    result:'Not enough messages to compact.', local_command:'compact', num_turns:0}`; no
 *    compact_boundary; the transcript gets the caveat and command entries and a
 *    `system`/`local_command` entry with that stdout.
 * Before this fix that compaction was a success for the front ends (ACP answered
 * `{success:true, 'Conversation compacted'}`), its text was published as the answer, and the
 * session's "compacting" state stayed set, so the next compaction published no `started`.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ClaudeCapabilities } from '../../src/claude/binary.js';
import { readJournal } from '../../src/session/kiroFiles.js';
import { KiroSessionImpl, type KiroSessionInternalOptions } from '../../src/session/kiroSession.js';
import { STREAM_ARGS, fakeEnv } from '../claude/helpers.js';
import { closeAll, drain, fakeBinary, fakeCaps, fakeClaudePath, mkSandbox, recordingUI, semantic, type RecordingUI, type Sandbox } from './helpers.js';

let caps: ClaudeCapabilities;
before(async () => {
  caps = await fakeCaps();
});

const SCRIPT = { default: { steps: [{ text: 'hist={{historyUserTexts}}' }] } };
const NOT_ENOUGH = 'Not enough messages to compact.';

const open = (sb: Sandbox, over: Partial<KiroSessionInternalOptions> = {}, ui: RecordingUI = recordingUI()): Promise<KiroSessionImpl> =>
  KiroSessionImpl.create({ ws: sb.ws, origin: 'repl', interactive: true, ui, binary: fakeBinary(), caps, env: sb.env, ...over });

/** Every frame the fake writes for `lines` sent to a new `--session-id` session. */
async function fakeFrames(sb: Sandbox, sid: string, lines: string[]): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fakeClaudePath(), ...STREAM_ARGS, '--session-id', sid], { cwd: sb.cwd, env: fakeEnv({ ...sb.env, FAKE_CLAUDE_PERSIST: '1' }), stdio: ['pipe', 'pipe', 'pipe'] });
    const got: Array<Record<string, unknown>> = [];
    let buf = '';
    let results = 0;
    const send = (): void => {
      const content = lines[results];
      if (content === undefined) child.stdin.end();
      else child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: '', uuid: randomUUID() }) + '\n');
    };
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
          if (f.type === 'result') {
            results++;
            send();
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
    send();
  });
}

function transcriptOf(sb: Sandbox, sid: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === `${sid}.jsonl`) for (const l of fs.readFileSync(p, 'utf8').split('\n')) if (l.trim()) out.push(JSON.parse(l) as Record<string, unknown>);
    }
  };
  walk(sb.claudeConfig);
  return out;
}

/** The frames of the last turn (after the next-to-last result). */
function lastTurn(frames: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const ends = frames.map((f, i) => (f.type === 'result' ? i : -1)).filter((i) => i >= 0);
  return frames.slice((ends.at(-2) ?? -1) + 1);
}

describe('r5 #8 (verifier): the fake refuses /compact of a session holding only local-command entries like 2.1.319', () => {
  for (const first of ['/compact', '/effort low']) {
    it(`${first}, then /compact: a failed compaction status, the stdout frame, a result with the text; no boundary`, async () => {
      const sb = mkSandbox();
      const sid = randomUUID();
      const turn = lastTurn(await fakeFrames(sb, sid, [first, '/compact']));
      const status = turn.filter((f) => f.type === 'system' && f.subtype === 'status');
      assert.deepEqual(
        status.map((f) => [f.status, f.compact_result, f.compact_error]),
        [
          ['compacting', undefined, undefined],
          [null, 'failed', NOT_ENOUGH],
        ],
        JSON.stringify(turn),
      );
      assert.equal(turn.some((f) => f.type === 'system' && f.subtype === 'compact_boundary'), false, 'the fake compacted a session with no messages');
      assert.equal(turn.some((f) => f.type === 'user'), false, 'no summary frame');
      const a = turn.filter((f) => f.type === 'assistant');
      assert.equal(a.length, 1);
      assert.deepEqual((a[0]!.message as { content: unknown }).content, [{ type: 'text', text: NOT_ENOUGH }]);
      assert.equal(a[0]!.local_command_source, `<local-command-stdout>${NOT_ENOUGH}</local-command-stdout>`);
      assert.equal(a[0]!.local_command_outcome, undefined);
      assert.equal((a[0]!.local_command_run as { command?: string }).command, 'compact');
      const result = turn.find((f) => f.type === 'result')!;
      assert.equal(result.subtype, 'success');
      assert.equal(result.is_error, false);
      assert.equal(result.result, NOT_ENOUGH);
      assert.equal(result.local_command, 'compact');
      assert.equal(result.num_turns, 0);
      const t = transcriptOf(sb, sid);
      assert.ok(t.some((l) => l.type === 'system' && l.subtype === 'local_command' && String(l.content) === `<local-command-stdout>${NOT_ENOUGH}</local-command-stdout>`), JSON.stringify(t));
      assert.equal(t.some((l) => l.type === 'system' && l.subtype === 'compact_boundary'), false);
    });
  }
});

describe('r5 #8 (verifier): KiroSession makes the "Not enough messages" refusal an error', () => {
  for (const first of ['compact', 'effort'] as const) {
    it(`a new chat, ${first === 'compact' ? 'a first /compact' : '/effort high'}, then /compact: isError with Claude's reason, published once, no compaction journaled`, async () => {
      const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
      const s = await open(sb);
      try {
        if (first === 'compact') await drain(s.compact());
        else await s.setEffort('high');
        const { events, result } = await drain(s.compact());
        assert.equal(result.isError, true, `a compaction Claude refused reads as a success: ${JSON.stringify(result)}`);
        assert.equal(result.stopReason, 'local_command');
        assert.equal(result.error, NOT_ENOUGH);
        const ev = semantic(events);
        assert.equal(ev.some((e) => (e.type === 'text' || e.type === 'text_delta') && e.text.includes('Not enough messages')), false, 'the refusal is published as an answer too');
        assert.equal(ev.some((e) => e.type === 'compaction' && e.state === 'finished'), false);
        assert.deepEqual(readJournal(sb.sessionsDir, s.id).filter((j) => j.kind === 'Compaction'), []);
        // the failed compaction ended Claude's "compacting" state: the next one is reported whole
        await drain(s.prompt({ text: 'now a message' }));
        const { events: ok, result: done } = await drain(s.compact());
        assert.equal(done.isError, false, JSON.stringify(done));
        assert.deepEqual(
          semantic(ok)
            .filter((e) => e.type === 'compaction')
            .map((e) => (e as { state: string }).state),
          ['started', 'finished'],
          'a compaction after the refused one reported no start',
        );
      } finally {
        await closeAll(s);
      }
    });
  }

  it('a chat whose transcript was lost, /compact twice: the second error also says why there is nothing to compact', async () => {
    const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const s = await open(sb);
    let r: KiroSessionImpl | undefined;
    try {
      await drain(s.prompt({ text: 'alpha ALPHA_1' }));
      const id = s.id;
      const claudeId = s.claudeSessionId!;
      await s.close();
      const walk = (d: string): void => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.name === `${claudeId}.jsonl`) fs.rmSync(p);
        }
      };
      walk(sb.claudeConfig);
      r = await open(sb, { resume: { sessionId: id } });
      assert.ok(r.record.pendingHistory, 'precondition: the history is pending');
      await drain(r.compact());
      const { result } = await drain(r.compact());
      assert.equal(result.isError, true, JSON.stringify(result));
      assert.match(result.error ?? '', /^Not enough messages to compact: Claude Code gets the restored conversation with your next message/);
      assert.ok(r.record.pendingHistory, 'the restored history is still pending');
      const { result: next } = await drain(r.prompt({ text: 'beta' }));
      assert.match(next.text, /ALPHA_1/, 'the next line carries the restored history');
    } finally {
      await closeAll(r, s);
    }
  });
});

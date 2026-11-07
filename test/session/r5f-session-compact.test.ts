/**
 * r5 #8 (session group): `/compact` of a session Claude holds no messages for.
 *
 * VERIFIED with the real claude 2.1.319 (round-5 review probe, no model call): `/compact` as the
 * only line of a `--session-id` session answers one synthetic assistant frame with the text
 * `Error: No messages to compact`, `local_command_source` `<local-command-stderr>…`,
 * `local_command_run` `{command:'compact'}` and `local_command_outcome` `{kind:'failed'}`, then a
 * result `{subtype:'success', is_error:false, result:'', local_command:'compact'}`: no status, no
 * compact_boundary, no summary; the transcript gets the command and its stderr.
 *  - The fake answers like that (a new session, a fresh one after a fallback).
 *  - KiroSession makes that turn an error (`TurnResult.isError`, the text as its error, no
 *    assistant text), so no front end reports a compaction; a fallen-back chat whose restored
 *    history is still pending says why there is nothing to compact; a session with messages still
 *    compacts.
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

function baseOptions(sb: Sandbox, ui: RecordingUI = recordingUI()): KiroSessionInternalOptions {
  return { ws: sb.ws, origin: 'repl', interactive: true, ui, binary: fakeBinary(), caps, env: sb.env };
}
const open = (sb: Sandbox, over: Partial<KiroSessionInternalOptions> = {}, ui?: RecordingUI): Promise<KiroSessionImpl> =>
  KiroSessionImpl.create({ ...baseOptions(sb, ui), ...over });

/** Every frame the fake writes for `lines` sent to a new `--session-id` session. */
async function fakeFrames(sb: Sandbox, sid: string, lines: string[]): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fakeClaudePath(), ...STREAM_ARGS, '--session-id', sid], { cwd: sb.cwd, env: fakeEnv({ ...sb.env, FAKE_CLAUDE_PERSIST: '1' }), stdio: ['pipe', 'pipe', 'pipe'] });
    const got: Array<Record<string, unknown>> = [];
    let buf = '';
    let results = 0;
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
          if (f.type === 'result' && ++results === lines.length) child.stdin.end();
        } catch {
          /* not JSON */
        }
      }
    });
    child.on('exit', () => {
      clearTimeout(timer);
      resolve(got);
    });
    for (const content of lines) child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: '', uuid: randomUUID() }) + '\n');
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

describe('r5 #8: the fake answers /compact of a session with no messages like claude 2.1.319', () => {
  it('no status, boundary or summary; the failed synthetic frame; a result that says success; the command and its stderr in the transcript', async () => {
    const sb = mkSandbox();
    const sid = randomUUID();
    const frames = await fakeFrames(sb, sid, ['/compact']);
    assert.equal(frames.some((f) => f.type === 'system' && (f.subtype === 'compact_boundary' || f.subtype === 'status')), false, 'the fake compacted a session with no messages');
    assert.equal(frames.some((f) => f.type === 'user'), false, 'no summary frame');
    const a = frames.filter((f) => f.type === 'assistant');
    assert.equal(a.length, 1);
    assert.deepEqual((a[0]!.message as { content: unknown }).content, [{ type: 'text', text: 'Error: No messages to compact' }]);
    assert.equal(a[0]!.local_command_source, '<local-command-stderr>Error: No messages to compact</local-command-stderr>');
    assert.deepEqual(a[0]!.local_command_outcome, { kind: 'failed' });
    assert.equal((a[0]!.local_command_run as { command?: string }).command, 'compact');
    const result = frames.find((f) => f.type === 'result')!;
    assert.equal(result.subtype, 'success');
    assert.equal(result.is_error, false);
    assert.equal(result.result, '');
    assert.equal(result.local_command, 'compact');
    const t = transcriptOf(sb, sid);
    assert.ok(t.some((l) => l.type === 'system' && l.subtype === 'local_command' && String(l.content).includes('No messages to compact')), JSON.stringify(t));
    assert.equal(t.some((l) => l.type === 'system' && l.subtype === 'compact_boundary'), false);
  });

  it('a session with a message still compacts', async () => {
    const sb = mkSandbox({ script: SCRIPT });
    const frames = await fakeFrames(sb, randomUUID(), ['hello', '/compact']);
    assert.ok(frames.some((f) => f.type === 'system' && f.subtype === 'compact_boundary'));
  });
});

describe('r5 #8: KiroSession makes a failed /compact an error', () => {
  it('a new chat: isError with Claude\'s reason, no assistant text, no compaction; the chat goes on', async () => {
    const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const s = await open(sb);
    try {
      const { events, result } = await drain(s.compact());
      assert.equal(result.isError, true, `a compaction Claude refused reads as a success: ${JSON.stringify(result)}`);
      assert.equal(result.stopReason, 'local_command');
      assert.equal(result.error, 'No messages to compact');
      const ev = semantic(events);
      assert.equal(ev.some((e) => e.type === 'compaction'), false);
      assert.equal(ev.some((e) => (e.type === 'text' || e.type === 'text_delta') && /No messages to compact/.test(e.text)), false, 'the error is published as an answer too');
      assert.deepEqual(readJournal(sb.sessionsDir, s.id).filter((j) => j.kind === 'Compaction'), []);
      const { result: next } = await drain(s.prompt({ text: 'after' }));
      assert.equal(next.isError, false);
      assert.equal(next.text, 'hist=after');
    } finally {
      await closeAll(s);
    }
  });

  it('a chat whose transcript was lost (restored history pending): the error says why, and the history still goes with the next line', async () => {
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
      const ui = recordingUI();
      r = await open(sb, { resume: { sessionId: id } }, ui);
      assert.ok(r.record.pendingHistory, 'precondition: the history is pending');
      const { result } = await drain(r.compact());
      assert.equal(result.isError, true);
      assert.match(result.error ?? '', /^No messages to compact: Claude Code gets the restored conversation with your next message/);
      assert.ok(r.record.pendingHistory, 'the restored history is still pending');
      const { result: next } = await drain(r.prompt({ text: 'beta' }));
      assert.match(next.text, /ALPHA_1/, 'the next line carries the restored history');
    } finally {
      await closeAll(r, s);
    }
  });

  it('a chat with messages still compacts (no error)', async () => {
    const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const s = await open(sb);
    try {
      await drain(s.prompt({ text: 'alpha' }));
      const { events, result } = await drain(s.compact());
      assert.equal(result.isError, false, JSON.stringify(result));
      assert.ok(semantic(events).some((e) => e.type === 'compaction'));
    } finally {
      await closeAll(s);
    }
  });
});

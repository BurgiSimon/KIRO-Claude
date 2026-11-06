/**
 * Adversarial tests written during the independent review of src/claude/ (edge cases the
 * original suites did not cover). Each block names the defect or invariant it pins down.
 *
 * Several tests drive a tiny "raw" child (a generated .mjs speaking just enough of the 00 §3
 * wire protocol) instead of fake-claude, so that exact frame orderings can be produced.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';

import { getAuthStatus, parseAuthText } from '../../src/claude/auth.js';
import { ClaudeNotFoundError, findClaudeBinary, runCaptured, type ClaudeBinary } from '../../src/claude/binary.js';
import { ClaudeProcess, ClaudeProcessError, LineSplitter, sessionIdFromArgs, type ClaudeHandlers } from '../../src/claude/process.js';
import type { ClaudeFrame } from '../../src/claude/protocol.js';
import { rewriteTranscriptSessionId } from '../../src/claude/transcript.js';
import { collectTurn, fakeEnv, mkTmp, waitFor } from './helpers.js';

/* ------------------------------------------------------------------------------------------ */
/* Raw child helper                                                                            */
/* ------------------------------------------------------------------------------------------ */

const RAW_PRELUDE = `
import * as readline from 'node:readline';
import { spawn } from 'node:child_process';
const out = (o, cb) => process.stdout.write(JSON.stringify(o) + '\\n', cb);
const rl = readline.createInterface({ input: process.stdin });
const sid = '0f8fad5b-d9cb-469f-a165-70867728950e';
void spawn;
function onLine(fn) {
  rl.on('line', (l) => {
    let m;
    try { m = JSON.parse(l); } catch { return; }
    if (m.type === 'control_request' && m.request && m.request.subtype === 'initialize') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { pid: process.pid } } });
      return;
    }
    fn(m);
  });
}
`;

function rawChild(body: string): ClaudeBinary {
  const dir = mkTmp('kc-review-raw-');
  const file = path.join(dir, 'raw-claude.mjs');
  fs.writeFileSync(file, RAW_PRELUDE + body);
  return { path: file, version: '2.1.318', rawVersion: '2.1.318 (Claude Code)' };
}

const open: ClaudeProcess[] = [];
after(async () => {
  await Promise.all(open.map((p) => p.close({ graceMs: 100 }).catch(() => undefined)));
});

async function startRaw(body: string, handlers: Partial<ClaudeHandlers> = {}): Promise<ClaudeProcess> {
  const dir = mkTmp('kc-review-cwd-');
  const proc = await ClaudeProcess.start({
    binary: rawChild(body),
    args: ['-p'],
    cwd: dir,
    env: fakeEnv(),
    initialize: {},
    handlers: {
      onHookCallback: async () => ({}),
      onCanUseTool: async () => ({ behavior: 'allow' }),
      ...handlers,
    },
    initializeTimeoutMs: 10_000,
  });
  open.push(proc);
  return proc;
}

/* ------------------------------------------------------------------------------------------ */
/* binary.ts: runCaptured must never reject (TDZ on synchronous spawn errors)                  */
/* ------------------------------------------------------------------------------------------ */

describe('review: runCaptured never rejects', () => {
  it('resolves with error when spawn throws synchronously (NUL byte in argv)', async () => {
    const r = await runCaptured(process.execPath, ['-e', 'a\0b']);
    assert.ok(r.error, 'spawn error reported');
    assert.equal(r.code, null);
    assert.equal(r.timedOut, false);
  });

  it('resolves with error for an empty command', async () => {
    const r = await runCaptured('', []);
    assert.ok(r.error);
  });

  it('getAuthStatus maps a synchronous spawn failure to ClaudeNotFoundError', async () => {
    const bin: ClaudeBinary = { path: '/bin/cla\0ude', version: '2.1.318', rawVersion: '2.1.318' };
    await assert.rejects(getAuthStatus(bin, {}), (e: unknown) => e instanceof ClaudeNotFoundError);
  });

  it('findClaudeBinary reports the real spawn problem for a broken explicit path', async () => {
    await assert.rejects(
      findClaudeBinary({ explicitPath: '/opt/x\0/claude', env: { PATH: '' } }),
      (e: unknown) => e instanceof ClaudeNotFoundError && !/before initialization/.test(e.message),
    );
  });
});

/* ------------------------------------------------------------------------------------------ */
/* binary.ts: minimum version (00 §2.1 "require 2.1.x+")                                       */
/* ------------------------------------------------------------------------------------------ */

describe('review: findClaudeBinary minimum version', { skip: process.platform === 'win32' }, () => {
  function versionScript(dir: string, rel: string, version: string): string {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `#!/bin/sh\necho "${version} (Claude Code)"\n`, { mode: 0o755 });
    return p;
  }

  it('an explicitly configured Claude Code older than 2.1.0 is a clear error', async () => {
    const dir = mkTmp('kc-review-ver-');
    const p = versionScript(dir, 'old/claude', '2.0.5');
    await assert.rejects(
      findClaudeBinary({ explicitPath: p, env: { PATH: '', HOME: dir } }),
      (e: unknown) => e instanceof ClaudeNotFoundError && /2\.0\.5 is too old/.test(e.message) && /2\.1\.0/.test(e.message),
    );
    const bin = await findClaudeBinary({ explicitPath: p, env: { PATH: '', HOME: dir }, minVersion: null });
    assert.equal(bin.version, '2.0.5');
  });

  it('a too-old claude on PATH is skipped in favour of a newer well-known install', async () => {
    const dir = mkTmp('kc-review-ver-');
    versionScript(dir, 'bin/claude', '1.0.99');
    const good = versionScript(dir, '.local/bin/claude', '2.1.318');
    const bin = await findClaudeBinary({ env: { PATH: path.join(dir, 'bin'), HOME: dir } });
    assert.equal(bin.path, good);
    assert.equal(bin.version, '2.1.318');
  });

  it('a too-old candidate is never returned; the error lists why', async () => {
    const dir = mkTmp('kc-review-ver-');
    versionScript(dir, 'bin/claude', '1.0.99');
    try {
      const bin = await findClaudeBinary({ env: { PATH: path.join(dir, 'bin'), HOME: dir } });
      // A system-wide install at a well-known location (/opt/claude-code, …) may be found.
      assert.notEqual(bin.version, '1.0.99');
      assert.ok(!bin.path.startsWith(dir));
    } catch (e) {
      assert.ok(e instanceof ClaudeNotFoundError);
      assert.ok(e.tried.some((t) => /1\.0\.99 is too old/.test(t)), e.tried.join('\n'));
    }
  });
});

/* ------------------------------------------------------------------------------------------ */
/* process.ts: LineSplitter                                                                    */
/* ------------------------------------------------------------------------------------------ */

describe('review: LineSplitter', () => {
  it('is linear for one huge line delivered in 64 KiB pipe chunks (Read/Write tool results)', () => {
    const s = new LineSplitter();
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    const n = (32 * 1024 * 1024) / chunk.length;
    const t0 = Date.now();
    let lines: string[] = [];
    for (let i = 0; i < n; i++) lines = lines.concat(s.push(chunk));
    lines = lines.concat(s.push(Buffer.from('\r\nnext\n')));
    const ms = Date.now() - t0;
    assert.equal(lines.length, 2);
    assert.equal(lines[0]!.length, 32 * 1024 * 1024);
    assert.equal(lines[1], 'next');
    assert.ok(ms < 2500, `took ${ms} ms`);
  });

  it('joins a line split over many chunks, CR at a chunk boundary, multibyte split', () => {
    const s = new LineSplitter();
    const text = Buffer.from('{"t":"h€llo"}\r\n{"t":"✓"}\n', 'utf8');
    const got: string[] = [];
    for (let i = 0; i < text.length; i++) got.push(...s.push(text.subarray(i, i + 1)));
    got.push(...s.end());
    assert.deepEqual(got, ['{"t":"h€llo"}', '{"t":"✓"}']);
  });

  it('several lines in one chunk, partial tail kept, end() flushes it', () => {
    const s = new LineSplitter();
    assert.deepEqual(s.push(Buffer.from('a\nb\n\nc')), ['a', 'b', '']);
    assert.deepEqual(s.push(Buffer.from('d')), []);
    assert.deepEqual(s.end(), ['cd']);
    assert.deepEqual(s.end(), []);
    assert.deepEqual(s.push(Buffer.from('e\n')), ['e'], 'reusable after end()');
  });

  it('end() decodes a dangling partial UTF-8 sequence as U+FFFD instead of losing it', () => {
    const s = new LineSplitter();
    const euro = Buffer.from('€', 'utf8');
    assert.deepEqual(s.push(Buffer.concat([Buffer.from('x'), euro.subarray(0, 2)])), []);
    assert.deepEqual(s.end(), ['x�']);
  });

  it('string chunks after a Buffer with an incomplete sequence keep their order', () => {
    const s = new LineSplitter();
    const euro = Buffer.from('€', 'utf8');
    assert.deepEqual(s.push(Buffer.concat([Buffer.from('a'), euro.subarray(0, 1)])), []);
    assert.deepEqual(s.push('b\n'), ['a�b']);
  });
});

/* ------------------------------------------------------------------------------------------ */
/* process.ts: wire edge cases                                                                 */
/* ------------------------------------------------------------------------------------------ */

describe('review: ClaudeProcess wire edge cases', () => {
  it('a result for a different (background) user line does not end the running turn', async () => {
    const proc = await startRaw(`
onLine((m) => {
  if (m.type !== 'user') return;
  out({ type: 'system', subtype: 'init', session_id: sid });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'bg', session_id: sid, user_message_uuids: ['99999999-9999-4999-8999-999999999999'] });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] }, session_id: sid });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'mine', session_id: sid, user_message_uuids: [m.uuid] });
});`);
    const { frames, result } = await collectTurn(proc.turn('go'));
    assert.equal(result.result, 'mine');
    assert.deepEqual(frames.map((f) => f.type), ['system', 'result', 'assistant', 'result']);
    assert.equal(proc.busy, false);
    assert.equal(proc.sessionId, '0f8fad5b-d9cb-469f-a165-70867728950e');
  });

  it('CLI requests arriving after stdin was closed are not handed to handlers (no answer is possible)', async () => {
    let calls = 0;
    const proc = await startRaw(
      `
onLine(() => {});
rl.on('close', () => {
  out({ type: 'control_request', request_id: 'late-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'touch x' } } });
  out({ type: 'control_request', request_id: 'late-2', request: { subtype: 'hook_callback', callback_id: 'kiro_pre', input: { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} } } });
  setTimeout(() => process.exit(0), 300);
});`,
      {
        onCanUseTool: async () => {
          calls++;
          return { behavior: 'allow' };
        },
        onHookCallback: async () => {
          calls++;
          return {};
        },
      },
    );
    const info = await proc.close({ graceMs: 3000 });
    assert.equal(info.code, 0);
    assert.equal(calls, 0, 'no permission prompt / gate run for a request that can never be answered');
  });

  it('no frame is emitted after "exit", even if a grandchild keeps stdout open', async () => {
    const proc = await startRaw(`
onLine((m) => {
  if (m.type !== 'user') return;
  spawn(process.execPath, ['-e', 'setTimeout(() => process.stdout.write(JSON.stringify({ type: "late_frame" }) + "\\\\n"), 1500)'],
    { stdio: ['ignore', 'inherit', 'ignore'], detached: true }).unref();
  out({ type: 'system', subtype: 'init', session_id: sid }, () => process.exit(3));
});`);
    const events: string[] = [];
    proc.on('frame', (f: ClaudeFrame) => events.push(`frame:${f.type}`));
    proc.on('exit', () => events.push('exit'));
    proc.sendUserMessage('go');
    const info = await proc.exited;
    assert.equal(info.code, 3);
    // Give the grandchild time to write its late line.
    await new Promise((r) => setTimeout(r, 1200));
    const exitAt = events.indexOf('exit');
    assert.ok(exitAt >= 0);
    assert.deepEqual(events.slice(exitAt + 1), [], `events after exit: ${events.join(', ')}`);
    assert.ok(events.includes('frame:system'));
  });

  it('a handler result that is not JSON-serialisable is answered with an error (never left unanswered)', { timeout: 10_000 }, async () => {
    const proc = await startRaw(
      `
onLine((m) => {
  if (m.type === 'user') {
    out({ type: 'control_request', request_id: 'perm-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } } });
    out({ type: 'control_request', request_id: 'hook-1', request: { subtype: 'hook_callback', callback_id: 'kiro_pre', input: { hook_event_name: 'PreToolUse' } } });
    globalThis.uuid = m.uuid;
    globalThis.answers = [];
    return;
  }
  if (m.type === 'control_response') {
    globalThis.answers.push(m.response);
    if (globalThis.answers.length === 2) {
      out({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(globalThis.answers), session_id: sid, user_message_uuids: [globalThis.uuid] });
    }
  }
});`,
      {
        onCanUseTool: async () => ({ behavior: 'allow', updatedInput: { n: 10n as unknown } }),
        onHookCallback: async () => {
          const circular: Record<string, unknown> = {};
          circular.self = circular;
          return { hookSpecificOutput: { hookEventName: 'PreToolUse', extra: circular } };
        },
      },
    );
    const { result } = await collectTurn(proc.turn('go'));
    const answers = JSON.parse(result.result!) as Array<{ subtype: string; request_id: string; error?: string }>;
    assert.deepEqual(answers.map((a) => [a.request_id, a.subtype]).sort(), [['hook-1', 'error'], ['perm-1', 'error']]);
    assert.ok(answers.every((a) => /serial/i.test(a.error ?? '')), JSON.stringify(answers));
  });

  it('aborting a turn whose line is still queued interrupts it again once it starts', { timeout: 10_000 }, async () => {
    // The line is queued behind a CLI-initiated turn; the first interrupt stops that one, and
    // the default interrupt keeps queued sends (04 §8: cancel_queued is opt-in), so our line
    // would otherwise run to completion although the caller aborted it.
    const proc = await startRaw(`
let interrupts = 0;
onLine((m) => {
  if (m.type === 'user') {
    globalThis.uuid = m.uuid;
    out({ type: 'command_lifecycle', command_uuid: m.uuid, state: 'queued', session_id: sid });
    return;
  }
  if (m.type === 'control_request' && m.request.subtype === 'interrupt') {
    interrupts++;
    out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { still_queued: [globalThis.uuid] } } });
    if (interrupts === 1) {
      out({ type: 'command_lifecycle', command_uuid: globalThis.uuid, state: 'started', session_id: sid });
      out({ type: 'system', subtype: 'init', session_id: sid });
    } else {
      out({ type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming', result: 'interrupts=' + interrupts, session_id: sid, user_message_uuids: [globalThis.uuid] });
    }
  }
});`);
    const ac = new AbortController();
    const gen = proc.turn('go', { signal: ac.signal });
    const first = await gen.next();
    assert.equal((first.value as ClaudeFrame).type, 'command_lifecycle');
    ac.abort();
    const { result } = await collectTurn(gen);
    assert.equal(result.is_error, true);
    assert.equal(result.result, 'interrupts=2');
    assert.equal(proc.busy, false);
  });

  it('a queued line cancelled by the CLI ends its turn (no result will ever come)', { timeout: 10_000 }, async () => {
    const proc = await startRaw(`
onLine((m) => {
  if (m.type === 'user') {
    globalThis.uuid = m.uuid;
    out({ type: 'command_lifecycle', command_uuid: m.uuid, state: 'queued', session_id: sid });
    return;
  }
  if (m.type === 'control_request' && m.request.subtype === 'interrupt') {
    out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { still_queued: [] } } });
    out({ type: 'command_lifecycle', command_uuid: globalThis.uuid, state: 'cancelled', session_id: sid });
  }
});`);
    const frames: string[] = [];
    proc.on('frame', (f: ClaudeFrame) => frames.push(f.type));
    const ac = new AbortController();
    const gen = proc.turn('go', { signal: ac.signal });
    await gen.next();
    ac.abort();
    const { result } = await collectTurn(gen);
    assert.equal(result.type, 'result');
    assert.equal(result.is_error, true);
    assert.equal(result.subtype, 'error_during_execution');
    assert.equal(result.terminal_reason, 'cancelled');
    assert.equal(result.synthetic, true);
    assert.equal(proc.busy, false);
    assert.ok(!frames.includes('result'), 'the synthetic result is not emitted as a raw CLI frame');
    // The process is still usable.
    assert.equal(proc.running, true);
  });

  it('a "cancelled" lifecycle for a line that already started does not end the turn early', { timeout: 10_000 }, async () => {
    const proc = await startRaw(`
onLine((m) => {
  if (m.type !== 'user') return;
  out({ type: 'command_lifecycle', command_uuid: m.uuid, state: 'queued', session_id: sid });
  out({ type: 'command_lifecycle', command_uuid: m.uuid, state: 'started', session_id: sid });
  out({ type: 'command_lifecycle', command_uuid: m.uuid, state: 'cancelled', session_id: sid });
  out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'real', session_id: sid, user_message_uuids: [m.uuid] });
});`);
    const { result } = await collectTurn(proc.turn('go'));
    assert.equal(result.result, 'real');
    assert.equal(result.synthetic, undefined);
  });

  it('a hook_callback that arrives before the initialize response is still answered', async () => {
    const seen: string[] = [];
    const dir = mkTmp('kc-review-cwd-');
    const bin = rawChild(`
rl.on('line', (l) => {
  const m = JSON.parse(l);
  if (m.type === 'control_request' && m.request.subtype === 'initialize') {
    out({ type: 'control_request', request_id: 'early-1', request: { subtype: 'hook_callback', callback_id: 'kiro_pre', input: { hook_event_name: 'SessionStart' } } });
    globalThis.initId = m.request_id;
    return;
  }
  if (m.type === 'control_response' && m.response.request_id === 'early-1') {
    out({ type: 'control_response', response: { subtype: 'success', request_id: globalThis.initId, response: { echoed: m.response.response } } });
  }
});`);
    const proc = await ClaudeProcess.start({
      binary: bin,
      args: [],
      cwd: dir,
      env: fakeEnv(),
      initialize: {},
      handlers: {
        onHookCallback: async (req) => {
          seen.push(String(req.input.hook_event_name));
          return { systemMessage: 'ok' };
        },
        onCanUseTool: async () => ({ behavior: 'allow' }),
      },
      initializeTimeoutMs: 10_000,
    });
    open.push(proc);
    assert.deepEqual(seen, ['SessionStart']);
    assert.deepEqual(proc.initializeResponse, { echoed: { systemMessage: 'ok' } });
  });

  it('a turn whose child exits with code 0 mid-turn throws ClaudeProcessError after its frames', async () => {
    const proc = await startRaw(`
onLine((m) => {
  if (m.type !== 'user') return;
  out({ type: 'system', subtype: 'init', session_id: sid }, () => process.exit(0));
});`);
    const frames: ClaudeFrame[] = [];
    const gen = proc.turn('go');
    await assert.rejects(
      (async () => {
        for (;;) {
          const r = await gen.next();
          if (r.done) return;
          frames.push(r.value);
        }
      })(),
      (e: unknown) => e instanceof ClaudeProcessError && e.exitCode === 0,
    );
    assert.deepEqual(frames.map((f) => f.type), ['system']);
    await waitFor(() => proc.exitInfo !== undefined, 3000, 'exit info');
    assert.equal(proc.running, false);
  });
});

/* ------------------------------------------------------------------------------------------ */
/* process.ts: sessionIdFromArgs                                                               */
/* ------------------------------------------------------------------------------------------ */

describe('review: sessionIdFromArgs', () => {
  it('handles = forms, fork with explicit id, picker form and short -r', () => {
    assert.equal(sessionIdFromArgs(['--resume=A', '--fork-session', '--session-id', 'B']), 'B');
    assert.equal(sessionIdFromArgs(['--resume', '--fork-session']), undefined);
    assert.equal(sessionIdFromArgs(['-r', 'A']), 'A');
    assert.equal(sessionIdFromArgs(['--resume', 'A', '--fork-session']), undefined);
    assert.equal(sessionIdFromArgs(['--model', 'haiku', '--session-id=C']), 'C');
  });
});

/* ------------------------------------------------------------------------------------------ */
/* auth.ts: real 2.1.318 text format                                                           */
/* ------------------------------------------------------------------------------------------ */

describe('review: parseAuthText on the real 2.1.318 `auth status --text` output', () => {
  it('logged in (captured from the real CLI)', () => {
    const text =
      'Login method: Claude API account\nAnthropic base URL: https://api.anthropic.com\nProxy: http://127.0.0.1:42325\n';
    const s = parseAuthText(text, 0);
    assert.equal(s.loggedIn, true);
    assert.equal(s.authMethod, 'Claude API account');
  });
});

/* ------------------------------------------------------------------------------------------ */
/* transcript.ts: rewriteTranscriptSessionId                                                   */
/* ------------------------------------------------------------------------------------------ */

describe('review: rewriteTranscriptSessionId', () => {
  const NEW = '11111111-1111-4111-8111-111111111111';
  const OLD = '22222222-2222-4222-8222-222222222222';

  it('keeps "__proto__" keys (JSON data, not a prototype)', () => {
    const line = `{"sessionId":"${OLD}","message":{"content":[{"type":"tool_use","input":{"__proto__":{"a":1},"b":2}}]}}`;
    const out = rewriteTranscriptSessionId(line, NEW);
    assert.equal(out, line.replace(OLD, NEW));
  });

  it('does not rewrite unrelated nested session ids inside tool inputs/outputs', () => {
    const line = JSON.stringify({
      type: 'assistant',
      sessionId: OLD,
      message: { content: [{ type: 'tool_use', name: 'mcp__tmux__attach', input: { session_id: 'tmux-7' } }] },
    });
    const out = JSON.parse(rewriteTranscriptSessionId(line, NEW)) as {
      sessionId: string;
      message: { content: Array<{ input: { session_id: string } }> };
    };
    assert.equal(out.sessionId, NEW);
    assert.equal(out.message.content[0]!.input.session_id, 'tmux-7');
  });

  it('nested fields that carry the transcript session id are rewritten (also across lines)', () => {
    const text = [
      JSON.stringify({ type: 'summary', summary: 'x', meta: { sessionId: OLD } }),
      JSON.stringify({ type: 'user', sessionId: OLD, attachment: { hookInput: { session_id: OLD } } }),
    ].join('\n');
    const [a, b] = rewriteTranscriptSessionId(text, NEW).split('\n').map((l) => JSON.parse(l) as Record<string, any>);
    assert.equal(a!.meta.sessionId, NEW);
    assert.equal(b!.sessionId, NEW);
    assert.equal(b!.attachment.hookInput.session_id, NEW);
  });

  it('leaves lines without anything to rewrite byte-identical', () => {
    const line = '{"type":"summary",  "summary":"x","n":1.50}';
    assert.equal(rewriteTranscriptSessionId(line, NEW), line);
  });
});

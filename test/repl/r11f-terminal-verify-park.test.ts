/**
 * Round-11 verification of the "terminal-b" fix for finding #0 (repl/input.ts heartbeat park).
 *
 * After a stop from elsewhere (`kill -STOP` / `kill -TSTP`, then `fg`) the heartbeat parks the
 * input in the timers phase after the continue, so that the keys the shell queued in its cooked
 * mode stay in the terminal until the SIGCONT of the next poll decides the park (libuv dispatches
 * signals after the other I/O of a poll). But readline's prompt() resumes a paused input first,
 * and an I/O callback of that same poll that draws a prompt (Claude Code's output, queued during
 * the stop: a notice printed above the prompt, an approval or another question asked, the next
 * prompt after a turn) resumed the parked input before the stdin event of the same poll: the
 * queued keys were read raw before the SIGCONT, a queued Return was Ctrl+J (a soft newline) and a
 * queued Ctrl+D a canonical end of file, as before r11.
 *
 * A child process over pipes that the test really stops and continues (SIGSTOP / SIGCONT to the
 * pid it started, never its own process group): its stdin is the reader's input (marked as a TTY
 * with a stub setRawMode), fd 3 stands for Claude Code's output, which draws on the terminal when
 * it arrives. The parent makes fd 3 ready before stdin during the stop, so the poll after the
 * continue reports fd 3 first, then stdin, then the signal pipe.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { INPUT_GAP_MS } from '../../src/repl/input.js';
import { removeOnExit } from '../tmpdirs.js';

const skip = process.platform === 'win32' ? 'POSIX job control' : false;
const tick = (ms = 10): Promise<void> => new Promise((res) => setTimeout(res, ms));

const INPUT_JS = new URL('../../src/repl/input.js', import.meta.url).href;

/**
 * `KC_DRAW` says what Claude Code's output (a line on fd 3) draws when it arrives: `printAbove` (a
 * notice above the prompt), `read` (a question: a nested read, its prompt drawn), `updatePrompt`;
 * a line `block` keeps its event loop busy for 700 ms instead (no stop). One JSON line per event on
 * stdout.
 */
const CHILD = String.raw`
import { Writable } from 'node:stream';
import * as net from 'node:net';
const { LineReader } = await import(process.env.KC_INPUT_JS);
const input = process.stdin;
const raw = [];
Object.assign(input, { isTTY: true, setRawMode(on) { raw.push('raw:' + on); return input; } });
let out = '';
const output = new Writable({ write(c, _e, cb) { out += c.toString(); cb(); } });
Object.assign(output, { isTTY: true, columns: 80 });
const r = new LineReader({ input, output, terminal: true, foreground: () => true, stopInBackground: () => false });
const say = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const claude = new net.Socket({ fd: 3, readable: true, writable: false });
claude.on('data', (d) => {
  const what = d.toString().trim();
  if (what === 'block') {
    // a long synchronous step (no stop)
    const end = performance.now() + 700;
    while (performance.now() < end) {}
    say({ blocked: true });
    return;
  }
  if (process.env.KC_DRAW === 'printAbove') r.printAbove('NOTICE ' + what + '\n');
  else if (process.env.KC_DRAW === 'updatePrompt') r.updatePrompt('>> ');
  else r.read('Q? ').then((res) => say({ question: res }));
});
say({ ready: true });
const res = await r.readInput('> ');
say({ res, raw: raw.splice(0), out });
r.close();
claude.destroy();
process.exit(0);
`;

interface Child {
  proc: ChildProcess;
  events: Record<string, unknown>[];
  next(key: string, from: number, ms?: number): Promise<Record<string, unknown> | undefined>;
}

function child(t: TestContext, draw: string): Child {
  const dir = removeOnExit(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kc-r11f-tv-'))));
  const script = path.join(dir, 'reader.mjs');
  fs.writeFileSync(script, CHILD);
  const proc = spawn(process.execPath, [script], {
    env: { ...process.env, KC_INPUT_JS: INPUT_JS, KC_DRAW: draw },
    stdio: ['pipe', 'pipe', 'inherit', 'pipe'],
  });
  const events: Record<string, unknown>[] = [];
  let buf = '';
  proc.stdout!.on('data', (d: Buffer) => {
    buf += d.toString();
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      events.push(JSON.parse(buf.slice(0, i)) as Record<string, unknown>);
      buf = buf.slice(i + 1);
    }
  });
  t.after(() => {
    // only the child this test started
    if (proc.exitCode === null && proc.signalCode === null) {
      try {
        proc.kill('SIGCONT');
        proc.kill('SIGKILL');
      } catch {
        // gone
      }
    }
  });
  return {
    proc,
    events,
    async next(key, from, ms = 5000) {
      const end = Date.now() + ms;
      for (;;) {
        const e = events.slice(from).find((x) => key in x);
        if (e || Date.now() > end) return e;
        await tick(5);
      }
    },
  };
}

/**
 * The prompt shows `typed`; stopped (SIGSTOP) from elsewhere; meanwhile Claude Code's output arrives
 * (fd 3), then the shell's cooked mode queues `keys` on stdin; continued after a stop the
 * heartbeat sees.
 */
async function stoppedWithOutputAndKeys(c: Child, keys: string, typed = 'ab'): Promise<number> {
  assert.ok(await c.next('ready', 0), 'the reader did not start');
  if (typed) c.proc.stdin!.write(typed);
  await tick(150);
  const pid = c.proc.pid!;
  process.kill(pid, 'SIGSTOP');
  await tick(50);
  (c.proc.stdio[3] as NodeJS.WritableStream).write('from-claude\n');
  await tick(50);
  c.proc.stdin!.write(keys);
  await tick(INPUT_GAP_MS + 300);
  const mark = c.events.length;
  process.kill(pid, 'SIGCONT');
  return mark;
}

test('r11f verify #0: a notice printed above the prompt in the poll after a stop from elsewhere does not unpark the input: the queued Return is read as typed after the continue', { skip }, async (t) => {
  const c = child(t, 'printAbove');
  const mark = await stoppedWithOutputAndKeys(c, 'cd\n');
  let e = await c.next('res', mark, 3000);
  if (!e) {
    // the newline was read raw (Ctrl+J, a soft newline) before the continue was seen: finish the read to report it
    c.proc.stdin!.write('\r');
    e = await c.next('res', mark, 3000);
  }
  assert.deepEqual(e?.res, { kind: 'line', text: 'abcd' }, `the queued keys were read before the continue: ${JSON.stringify(e)}`);
  // the reader's own raw mode at its start, then one retake after the stop
  assert.deepEqual(e?.raw, ['raw:true', 'raw:false', 'raw:true'], JSON.stringify(e));
  assert.match(String(e?.out), /NOTICE from-claude/, 'the notice was not printed');
});

test('r11f verify #0: a question asked in the poll after a stop from elsewhere (its prompt drawn) does not unpark the input: the queued Return answers it as typed', { skip }, async (t) => {
  const c = child(t, 'read');
  // (nothing half-typed at the prompt below: readline's line is the nested read's too)
  const mark = await stoppedWithOutputAndKeys(c, 'yes\n', '');
  let e = await c.next('question', mark, 3000);
  if (!e) {
    c.proc.stdin!.write('\r');
    e = await c.next('question', mark, 3000);
  }
  assert.deepEqual(e?.question, { kind: 'line', text: 'yes' }, `the queued keys were read before the continue: ${JSON.stringify(e)}`);
  const end = c.events.length;
  c.proc.stdin!.write('ab\r');
  const r = await c.next('res', end, 3000);
  assert.deepEqual(r?.res, { kind: 'line', text: 'ab' }, JSON.stringify(r));
});

test('r11f verify #0: a prompt updated in the poll after a stop from elsewhere does not unpark the input: a queued Ctrl+D (canonical end of file) is Ctrl+D, not the end of the input', { skip }, async (t) => {
  const c = child(t, 'updatePrompt');
  assert.ok(await c.next('ready', 0), 'the reader did not start');
  // (the child's reads of stdin and fd 3 are up, and it waits in its poll)
  await tick(150);
  const pid = c.proc.pid!;
  process.kill(pid, 'SIGSTOP');
  await tick(50);
  (c.proc.stdio[3] as NodeJS.WritableStream).write('from-claude\n');
  await tick(50);
  // canonical mode's end of file at a line start: a 0-byte read; over a pipe, its end (the
  // reader's terminal-mode cooked mapping turns the NUL placeholder a raw read returns into
  // Ctrl+D; a pipe has no placeholder, so the end itself stands for the read that ends the input)
  c.proc.stdin!.end();
  await tick(INPUT_GAP_MS + 300);
  const mark = c.events.length;
  process.kill(pid, 'SIGCONT');
  // parked until the continue, then the retake; the end comes after it, not before the SIGCONT
  const e = await c.next('res', mark, 3000);
  assert.ok(e, 'no result');
  // the end was read after the retake: one retake (raw off, then on) before readline's close
  // turned raw mode off (read before the continue, the close came first and no retake followed)
  assert.deepEqual((e?.raw as string[]).slice(0, 3), ['raw:true', 'raw:false', 'raw:true'], `the end of the input was read before the continue was seen: ${JSON.stringify(e)}`);
});

test('r11f verify #0: a blocked event loop (no stop) with a notice printed while the input is parked: the input is given back, the keys raw and in order, no retake', { skip }, async (t) => {
  const c = child(t, 'printAbove');
  assert.ok(await c.next('ready', 0), 'the reader did not start');
  await tick(150);
  const fd3 = c.proc.stdio[3] as NodeJS.WritableStream;
  fd3.write('block\n');
  await tick(200);
  // during the block: Claude Code's notice, then raw keys (x, Ctrl+J: a soft newline, y, Return)
  fd3.write('from-claude\n');
  await tick(50);
  c.proc.stdin!.write('x\ny\r');
  const e = await c.next('res', 0, 5000);
  assert.ok(await c.next('blocked', 0, 100), 'the child did not block');
  assert.deepEqual(e?.res, { kind: 'line', text: 'x\ny' }, `keys lost, reordered or re-mapped: ${JSON.stringify(e)}`);
  assert.deepEqual(e?.raw, ['raw:true'], `the terminal mode was switched (a retake): ${JSON.stringify(e)}`);
  assert.match(String(e?.out), /NOTICE from-claude/);
});

/**
 * Round-11 fix "terminal-b", finding #0, unit level (repl/input.ts). After a stop from elsewhere
 * (`kill -TSTP <pid>` / `kill -STOP <pid>`, not Ctrl+Z, whose jobStop pauses the input before its
 * stop), keys queued while the shell had the terminal were read by the still flowing input before
 * LineReader.continued() (the SIGCONT listener) could pause it: libuv dispatches signals after the
 * other I/O of the same poll. A queued Return (a newline in the shell's cooked mode) was Ctrl+J, a
 * soft newline; a queued Ctrl+D (canonical mode's end of file, a 0-byte read) ended the input as
 * if the terminal hung up. Now an unref'd heartbeat runs while the input flows in terminal mode:
 * the poll the stop interrupted returns to the timers phase first, where the beat sees the gap and
 * parks the input (no read) until the check phase after the next poll; a SIGCONT there is a stop
 * (continued() takes the terminal back and reads the queued keys as typed), none a blocked event
 * loop (the input goes on as if nothing happened).
 *
 * Two layers: a child process over a pipe that the test really stops and continues (SIGSTOP /
 * SIGCONT to a pid it started; never its own process group), and in-process fake TTYs with
 * mocked timers and kill (nothing is really stopped). The real terminal under bash is in
 * r11f-tb-stop-elsewhere-pty.test.ts.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough, Writable } from 'node:stream';

import { INPUT_BEAT_MS, INPUT_GAP_MS, LineReader } from '../../src/repl/input.js';
import { removeOnExit } from '../tmpdirs.js';

const posix = process.platform !== 'win32';
/** The real process.kill (the fake terminals mock it: a Ctrl+Z must never stop the test runner). */
const realKill = process.kill.bind(process);
const skip = posix ? false : 'POSIX job control';

const tick = (ms = 10): Promise<void> => new Promise((res) => setTimeout(res, ms));
/** Keep the event loop busy (no stop): a long synchronous step, a GC pause, a slow machine. */
const block = (ms: number): void => {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // busy
  }
};
async function until(cond: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await tick(5);
  return cond();
}

// ───────────────────────────── a real process, really stopped ─────────────────────────────

const INPUT_JS = new URL('../../src/repl/input.js', import.meta.url).href;

/**
 * A LineReader in terminal mode over the child's stdin (a pipe, marked as a TTY with a stub
 * setRawMode), reading logical inputs. One JSON line per event on stdout. A line `block` keeps the
 * event loop busy for 700 ms (no stop) before the next read.
 */
const CHILD = String.raw`
import { Writable } from 'node:stream';
const { LineReader } = await import(process.env.KC_INPUT_JS);
const input = process.stdin;
const raw = [];
Object.assign(input, { isTTY: true, setRawMode(on) { raw.push('raw:' + on); return input; } });
let pauses = 0;
input.on('pause', () => pauses++);
let out = '';
const output = new Writable({ write(c, _e, cb) { out += c.toString(); cb(); } });
Object.assign(output, { isTTY: true, columns: 80 });
const r = new LineReader({ input, output, terminal: true, foreground: () => true, stopInBackground: () => false });
const say = (o) => process.stdout.write(JSON.stringify(o) + '\n');
say({ ready: true, pauses });
for (;;) {
  const res = await r.readInput('> ');
  say({ res, raw: raw.splice(0), pauses, out });
  out = '';
  if (res.kind !== 'line' || res.text === 'quit') break;
  if (res.text === 'block') {
    say({ blocking: true });
    const end = performance.now() + 700;
    while (performance.now() < end) {}
  }
}
r.close();
process.exit(0);
`;

interface Child {
  proc: ChildProcess;
  events: Record<string, unknown>[];
  /** The next event after `from` that has `key`. */
  next(key: string, from: number, ms?: number): Promise<Record<string, unknown> | undefined>;
}

function child(t: TestContext): Child {
  const dir = removeOnExit(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kc-r11f-tb-'))));
  const script = path.join(dir, 'reader.mjs');
  fs.writeFileSync(script, CHILD);
  const proc = spawn(process.execPath, [script], { env: { ...process.env, KC_INPUT_JS: INPUT_JS }, stdio: ['pipe', 'pipe', 'inherit'] });
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

test('r11f #0: stopped from elsewhere (SIGSTOP) with a line queued, continued: the queued Return submits (read after the continue, as typed), one retake', { skip }, async (t) => {
  const c = child(t);
  assert.ok(await c.next('ready', 0), 'the reader did not start');
  c.proc.stdin!.write('ab');
  await tick(150);
  const pid = c.proc.pid!;
  realKill(pid, 'SIGSTOP');
  await tick(50);
  // what the shell's cooked mode queues meanwhile: Return arrives as a newline (ICRNL)
  c.proc.stdin!.write('cd\n');
  await tick(INPUT_GAP_MS + 300);
  const mark = c.events.length;
  realKill(pid, 'SIGCONT');
  let e = await c.next('res', mark, 3000);
  if (!e) {
    // the newline was a soft newline (read before the continue was seen): finish the read to report it
    c.proc.stdin!.write('\r');
    e = await c.next('res', mark, 3000);
  }
  assert.deepEqual(e?.res, { kind: 'line', text: 'abcd' }, `the queued line was read before the continue (its newline a soft newline): ${JSON.stringify(e)}`);
  // the reader's own raw mode at its start, then one retake after the stop
  assert.deepEqual(e?.raw, ['raw:true', 'raw:false', 'raw:true'], `not one retake after the stop: ${JSON.stringify(e)}`);
  const end = c.events.length;
  c.proc.stdin!.write('quit\r');
  assert.ok(await c.next('res', end, 3000));
});

test('r11f #0: a blocked event loop (no stop): the input is parked and given back, keys intact and in order, nothing re-mapped, redrawn or switched', { skip }, async (t) => {
  const c = child(t);
  assert.ok(await c.next('ready', 0));
  c.proc.stdin!.write('block\r');
  const b = await c.next('blocking', 0);
  assert.ok(b, 'no block');
  const before = (await c.next('res', 0))!.pauses as number;
  const mark = c.events.length;
  // typed raw while the loop is busy: x, Ctrl+J (a soft newline), y, Return
  c.proc.stdin!.write('x\ny\r');
  const e = await c.next('res', mark, 5000);
  assert.deepEqual(e?.res, { kind: 'line', text: 'x\ny' }, `keys lost, reordered or re-mapped: ${JSON.stringify(e)}`);
  assert.deepEqual(e?.raw, [], `the terminal mode was switched: ${JSON.stringify(e)}`);
  assert.ok((e!.pauses as number) > before, `the heartbeat never parked the input after the block: ${JSON.stringify(e)}`);
  const out = String(e!.out);
  assert.equal(out.match(/> /g)?.length ?? 0, 1, `the prompt was drawn again (a retake): ${JSON.stringify(out)}`);
  const end = c.events.length;
  c.proc.stdin!.write('quit\r');
  assert.ok(await c.next('res', end, 3000));
});

// ───────────────────────────── in-process fake terminals ─────────────────────────────

interface Tty {
  r: LineReader;
  input: PassThrough;
  log: string[];
}

/** Nothing is really stopped: process.kill returns at once (the continue), after `onKill`. Once per test. */
function mockKill(t: TestContext, onKill?: (sig: string) => void): void {
  t.mock.method(process, 'kill', (_pid: number, sig?: string | number) => {
    onKill?.(String(sig));
    return true;
  });
}

function ttyReader(t: TestContext, opts: { foreground?: () => boolean; stop?: () => boolean; controlling?: () => boolean } = {}): Tty {
  const log: string[] = [];
  const input = new PassThrough();
  Object.assign(input, {
    isTTY: true,
    setRawMode: (on: boolean) => {
      log.push(`raw:${on}`);
      return input;
    },
  });
  input.on('pause', () => log.push('pause'));
  const output = new Writable({
    write(chunk: Buffer, _enc, cb) {
      log.push(`out:${chunk.toString()}`);
      cb();
    },
  });
  Object.assign(output, { isTTY: true, columns: 80 });
  const before = new Set(process.listeners('SIGCONT'));
  t.after(() => {
    for (const l of process.listeners('SIGCONT')) if (!before.has(l)) process.removeListener('SIGCONT', l as () => void);
  });
  const r = new LineReader({
    input,
    output,
    terminal: true,
    foreground: opts.foreground ?? (() => true),
    ...(opts.stop ? { stopInBackground: opts.stop } : {}),
    ...(opts.controlling ? { controlling: opts.controlling } : {}),
  });
  t.after(() => r.close());
  return { r, input, log };
}

const outText = (entries: string[]): string =>
  entries
    .filter((e) => e.startsWith('out:'))
    .map((e) => e.slice(4))
    .join('');
const prompts = (entries: string[]): number => outText(entries).match(/> /g)?.length ?? 0;

test('r11f #0: the heartbeat runs only while the input flows in terminal mode (unref\'d; none away after a stop, while a child owns the terminal, in line mode or once closed)', { skip }, async (t) => {
  const live = new Map<unknown, { unref: boolean }>();
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  t.mock.method(globalThis, 'setInterval', (fn: () => void, ms?: number) => {
    const h = realSet(fn, ms);
    if (ms === INPUT_BEAT_MS) {
      const rec = { unref: false };
      live.set(h, rec);
      const unref = h.unref.bind(h);
      h.unref = () => {
        rec.unref = true;
        return unref();
      };
    }
    return h;
  });
  t.mock.method(globalThis, 'clearInterval', (h?: NodeJS.Timeout) => {
    live.delete(h);
    realClear(h);
  });
  const beats = (): number => live.size;
  mockKill(t);
  // line mode: none
  const pipe = new LineReader({ input: new PassThrough(), output: new PassThrough(), terminal: false });
  assert.equal(beats(), 0, 'a heartbeat in line mode');
  pipe.close();
  let fg = true;
  const x = ttyReader(t, { foreground: () => fg });
  assert.equal(beats(), 1, 'no heartbeat while the terminal input flows');
  assert.ok([...live.values()].every((v) => v.unref), 'the heartbeat keeps the process alive');
  const p = x.r.readInput('> ');
  await tick();
  // a child owns the terminal
  x.r.suspend();
  assert.equal(beats(), 0, 'a heartbeat while a child owns the terminal');
  x.r.resume();
  assert.equal(beats(), 1);
  // Ctrl+Z: away from the stop until the terminal is taken back
  fg = false;
  x.input.write('\u001a');
  await tick();
  assert.equal(beats(), 0, 'a heartbeat while away after a stop');
  fg = true;
  process.emit('SIGCONT');
  assert.ok(await until(() => beats() === 1), 'no heartbeat after the terminal was taken back');
  x.input.write('z\r');
  assert.deepEqual(await p, { kind: 'line', text: 'z' });
  x.r.close();
  assert.equal(beats(), 0, 'a heartbeat after close');
});

test('r11f #0: park, then the SIGCONT in the next poll (a stop from elsewhere): continued() takes the terminal back once, the queued keys read as typed, one redraw', { skip }, async (t) => {
  const x = ttyReader(t);
  const p = x.r.readInput('> ');
  x.input.write('ab');
  await tick();
  const mark = x.log.length;
  // the beat that sees the gap parks the input; what the shell queued meanwhile is there, and
  // the stop's SIGCONT is dispatched in the poll that follows (a real signal to this process,
  // which is running: nothing stops)
  x.input.once('pause', () => {
    x.input.write('cd\n');
    realKill(process.pid, 'SIGCONT');
  });
  setTimeout(() => block(INPUT_GAP_MS + 150), 0);
  const r = await Promise.race([p, tick(3000).then(() => undefined)]);
  const after = x.log.slice(mark);
  assert.deepEqual(r, { kind: 'line', text: 'abcd' }, `the queued Return was not read as typed: ${JSON.stringify(after)}`);
  assert.deepEqual(after.filter((e) => e.startsWith('raw:')), ['raw:false', 'raw:true'], `not exactly one retake: ${JSON.stringify(after)}`);
  assert.equal(prompts(after), 1, `the prompt was drawn ${prompts(after)} times: ${JSON.stringify(outText(after))}`);
});

test('r11f #0: Ctrl+Z is never taken for a stop from elsewhere: no park, one retake, one redraw', { skip }, async (t) => {
  // the stop lasts (the mocked kill keeps the loop busy as long), then `fg`
  mockKill(t, (sig) => {
    if (sig === 'SIGTSTP') block(INPUT_GAP_MS + 150);
  });
  {
    const x = ttyReader(t);
    const p = x.r.readInput('> ');
    x.input.write('ab');
    await tick();
    const mark = x.log.length;
    x.input.write('\u001a');
    await tick();
    process.emit('SIGCONT');
    assert.ok(await until(() => x.log.slice(mark).includes('raw:true')), 'not taken back after the stop');
    await tick(INPUT_BEAT_MS * 2 + 50);
    const after = x.log.slice(mark);
    assert.deepEqual(after.filter((e) => e.startsWith('raw:')), ['raw:false', 'raw:true'], JSON.stringify(after));
    assert.equal(prompts(after), 1, JSON.stringify(outText(after)));
    assert.equal(after.filter((e) => e === 'pause').length, 1, `parked besides the stop's own pause: ${JSON.stringify(after)}`);
    x.input.write('c\r');
    assert.deepEqual(await p, { kind: 'line', text: 'abc' });
  }
});

test('r11f #0: the reader\'s own stop in the background (Ctrl+Z, `bg`, r11 #1/#2) is never taken for a stop from elsewhere: no park, one retake, one redraw', { skip }, async (t) => {
  mockKill(t);
  {
    let fg = true;
    let stops = 0;
    const x = ttyReader(t, {
      foreground: () => fg,
      stop: () => {
        stops++;
        block(INPUT_GAP_MS + 150);
        fg = true;
        return true;
      },
    });
    const p = x.r.readInput('> ');
    x.input.write('ab');
    await tick();
    const mark = x.log.length;
    fg = false;
    x.input.write('\u001a');
    await tick();
    process.emit('SIGCONT'); // `bg`
    assert.ok(await until(() => stops === 1 && x.log.slice(mark).includes('raw:true')), `not taken back after the self-stop: ${JSON.stringify(x.log.slice(mark))}`);
    await tick(INPUT_BEAT_MS * 2 + 50);
    const after = x.log.slice(mark);
    assert.deepEqual(after.filter((e) => e.startsWith('raw:')), ['raw:false', 'raw:true'], JSON.stringify(after));
    assert.equal(prompts(after), 1, JSON.stringify(outText(after)));
    x.input.write('c\r');
    assert.deepEqual(await p, { kind: 'line', text: 'abc' });
  }
});

test('r11f #0: an end of input right after a stop gap, the input still the controlling terminal: a canonical end of file (Ctrl+D typed in the shell), not a hangup', { skip }, async (t) => {
  const ended = async (opts: { gap: boolean; controlling: boolean }): Promise<boolean> => {
    const x = ttyReader(t, { controlling: () => opts.controlling });
    const p = x.r.readInput('> ');
    await tick(INPUT_BEAT_MS + 20);
    await new Promise<void>((res) =>
      setTimeout(() => {
        if (opts.gap) block(INPUT_GAP_MS + 150);
        x.input.end();
        res();
      }, 0),
    );
    assert.deepEqual(await p, { kind: 'eof' });
    const hungUp = x.r.hungUp;
    x.r.close();
    return hungUp;
  };
  assert.equal(await ended({ gap: true, controlling: true }), false, 'taken for a hangup (the REPL waits for a SIGHUP that does not come)');
  assert.equal(await ended({ gap: false, controlling: true }), true, 'control: an end of input with no stop before it is a hangup');
  assert.equal(await ended({ gap: true, controlling: false }), true, 'control: the terminal is gone (no longer the controlling one): a hangup');
});

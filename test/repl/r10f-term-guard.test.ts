/**
 * Round-10 fix "terminal-a" #0, unit level: ExitSignals.childOwnsTerminal, the guard the chat puts
 * up while a child program (`$EDITOR` for /editor and the spec's "Open in $EDITOR", `!cmd`) owns
 * the terminal (repl/core.ts openEditor / runBang, between the reader's suspend() and handBack's
 * resume()). The child runs in kiro-claude's process group: a terminal mode change it makes from
 * the background (vim at SIGTERM or after `bg`, a trap running `stty`) makes the kernel send
 * SIGTTOU to the whole group, which stopped kiro-claude before its SIGTERM close ran (`kill %1`
 * of a chat stopped with Ctrl+Z inside vim stayed 'Stopped (tty output)' with its lock until fg).
 *
 *  - While the guard is up a process SIGTTOU listener is installed: after a fatal signal the
 *    SIGTTOU is dropped (the close goes on), otherwise kiro-claude stops itself (SIGTSTP) two loop
 *    turns later, as the default action would have, and the listener stays for the next continue.
 *  - A caught SIGTTOU makes a terminal mode change or a `stty tostop` write that kiro-claude ITSELF
 *    issues from the background restart forever (SA_RESTART: a livelock, 100% CPU, no JS runs). So
 *    while the guard is up what kiro-claude writes to a terminal output is held (written at the
 *    release in the foreground, dropped after a fatal signal), and the listener is removed at the
 *    release (before the reader's resume()) and by dispose() (the re-raise, before any exit).
 *
 * In-process: process.emit stands for the signals, process.kill is mocked (nothing really stops).
 * The real terminal is in r10f-term-child-pty.test.ts.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';

import { ExitSignals } from '../../src/repl/exitSignals.js';

const skip = process.platform === 'win32' ? 'POSIX signals' : false;

const turns = (n = 3): Promise<void> =>
  new Promise((res) => {
    const step = (k: number): void => {
      if (k === 0) res();
      else setImmediate(() => step(k - 1));
    };
    step(n);
  });

/** A fake output: `isTTY` as given, its writes logged in order (callbacks called). */
function output(isTTY: boolean, log: string[], name: string): NodeJS.WritableStream & { isTTY: boolean } {
  const s = {
    isTTY,
    write(chunk: unknown, a?: unknown, b?: unknown): boolean {
      log.push(`${name}:${String(chunk)}`);
      const cb = [a, b].find((x) => typeof x === 'function') as (() => void) | undefined;
      cb?.();
      return true;
    },
  };
  return s as unknown as NodeJS.WritableStream & { isTTY: boolean };
}

function exits(t: TestContext): { ex: ExitSignals; kills: string[] } {
  const kills: string[] = [];
  t.mock.method(process, 'kill', (pid: number, sig?: string | number) => {
    kills.push(`${pid === process.pid ? 'self' : pid}:${String(sig)}`);
    return true;
  });
  const ex = new ExitSignals(async () => undefined, []);
  // never let a test's signal reach its re-raise (its fallback would exit the test process)
  t.after(() => ex.dispose());
  return { ex, kills };
}

const ttouListeners = (): number => process.listenerCount('SIGTTOU');

test('r10f #0: the SIGTTOU listener exists only while a child owns the terminal: release and dispose remove it, none after dispose', { skip }, (t) => {
  const before = ttouListeners();
  const { ex } = exits(t);
  assert.equal(ttouListeners(), before, 'installed before any child (the reader is active)');
  const release = ex.childOwnsTerminal([]);
  assert.equal(ttouListeners(), before + 1);
  assert.equal(ex.childOwnsTerminal([]) !== release, true);
  assert.equal(ttouListeners(), before + 1, 'a second guard while one is up adds no listener');
  release(true);
  assert.equal(ttouListeners(), before, 'release() leaves the listener behind (the reader would set raw mode with SIGTTOU caught)');
  release(true);
  assert.equal(ttouListeners(), before);
  ex.childOwnsTerminal([]);
  assert.equal(ttouListeners(), before + 1);
  ex.dispose();
  assert.equal(ttouListeners(), before, 'dispose() (the re-raise) leaves the listener behind: an exit then resets the terminal with SIGTTOU caught');
  ex.childOwnsTerminal([]);
  assert.equal(ttouListeners(), before, 'installed after dispose');
});

test('r10f #0: a SIGTTOU with no fatal signal stops kiro-claude (SIGTSTP) two loop turns later, as the default action did; the listener stays', { skip }, async (t) => {
  const { ex, kills } = exits(t);
  const release = ex.childOwnsTerminal([]);
  process.emit('SIGTTOU' as NodeJS.Signals);
  assert.deepEqual(kills, [], 'decided inside the SIGTTOU dispatch (a SIGTERM that came with the same continue is dispatched after it)');
  await turns();
  assert.deepEqual(kills, ['self:SIGTSTP']);
  assert.equal(ttouListeners() > 0, true, 'the listener went with the stop: the next continue (kill %1) finds none');
  // the next stop (bg again, the child redraws)
  process.emit('SIGTTOU' as NodeJS.Signals);
  process.emit('SIGTTOU' as NodeJS.Signals);
  await turns();
  assert.deepEqual(kills, ['self:SIGTSTP', 'self:SIGTSTP'], 'two SIGTTOUs of one dispatch are one stop');
  release(true);
  process.emit('SIGTTOU' as NodeJS.Signals);
  await turns();
  assert.deepEqual(kills, ['self:SIGTSTP', 'self:SIGTSTP']);
});

test('r10f #0: after a fatal signal a SIGTTOU is dropped, also one dispatched just before it (the close goes on, nothing stops it)', { skip }, async (t) => {
  {
    const { ex, kills } = exits(t);
    ex.childOwnsTerminal([]);
    process.emit('SIGTERM');
    process.emit('SIGTTOU' as NodeJS.Signals);
    await turns();
    assert.deepEqual(kills, [], 'kiro-claude stopped itself after the SIGTERM (kill %1 of a chat stopped inside vim)');
    ex.dispose();
  }
  {
    const { ex, kills } = exits(t);
    ex.childOwnsTerminal([]);
    process.emit('SIGTTOU' as NodeJS.Signals);
    process.emit('SIGHUP');
    await turns();
    assert.deepEqual(kills, [], 'a SIGHUP dispatched right after the SIGTTOU still wins');
    ex.dispose();
  }
});

test('r10f #0: what is written to a terminal output meanwhile is held (pipes are not): written at release(true) in order, dropped at release(false) and at dispose', { skip }, (t) => {
  const log: string[] = [];
  const tty = output(true, log, 'tty');
  const pipe = output(false, log, 'pipe');
  const ownWrite = tty.write;
  {
    const { ex } = exits(t);
    const release = ex.childOwnsTerminal([tty, pipe, undefined]);
    let called = 0;
    tty.write('a');
    tty.write('b', () => called++);
    pipe.write('p');
    assert.deepEqual(log, ['pipe:p'], 'a write to the terminal while the child owns it (from the background with `stty tostop` it spins forever with SIGTTOU caught)');
    release(true);
    assert.deepEqual(log, ['pipe:p', 'tty:a', 'tty:b']);
    assert.equal(called, 1);
    assert.equal(tty.write, ownWrite, 'the write method is restored');
    tty.write('c');
    assert.deepEqual(log.slice(-1), ['tty:c']);
  }
  log.length = 0;
  {
    const { ex } = exits(t);
    const release = ex.childOwnsTerminal([tty]);
    let called = 0;
    tty.write('dropped', () => called++);
    release(false);
    assert.deepEqual(log, []);
    tty.write('d');
    assert.deepEqual(log, ['tty:d']);
    ex.childOwnsTerminal([tty]);
    tty.write('gone');
    ex.dispose();
    tty.write('e');
    assert.deepEqual(log, ['tty:d', 'tty:e'], 'dispose() writes what was held or keeps holding');
    return new Promise<void>((res) => setImmediate(() => {
      assert.equal(called, 1, 'the callback of a dropped write is still called');
      res();
    }));
  }
});

test('r10f #0: a prototype write method is restored as such (no own property left behind)', { skip }, (t) => {
  class Out {
    isTTY = true;
    seen: string[] = [];
    write(s: string): boolean {
      this.seen.push(s);
      return true;
    }
  }
  const o = new Out();
  const { ex } = exits(t);
  const release = ex.childOwnsTerminal([o]);
  o.write('x');
  assert.deepEqual(o.seen, []);
  release(true);
  assert.deepEqual(o.seen, ['x']);
  assert.equal(Object.prototype.hasOwnProperty.call(o, 'write'), false);
});

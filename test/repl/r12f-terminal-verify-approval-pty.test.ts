/**
 * Round-12 verification of #0 end to end in a pty: a terminal that does not drain stalls the chat
 * after Claude Code's permission request was read and before its question is drawn.
 *
 * Writes to a terminal are synchronous in Node: when the terminal stops reading what the chat
 * writes (a slow `ssh` link, a terminal emulator that falls behind), the chat's event loop blocks
 * inside a write. Here the pty's reader (the test's driver) stops reading while the pty's output
 * buffer is full, Claude Code (the fake, held at the tool call as in r12f-ta-pty-helpers.ts) then
 * sends its can_use_tool, the chat is seen blocked in the terminal's write (/proc/<pid>/stack:
 * n_tty_write), and `y` + Enter is typed meanwhile: before the approval question could be drawn.
 * When the terminal reads again the question is drawn, and those keys must not answer it (they
 * allowed the tool: the stall ended in the callbacks that read the request, so the approval read
 * started with the heartbeat overdue, the input neither parked nor away). Then `n` typed at the
 * question answers it.
 *
 * The chat leads the pty's session (no shell; `ssh -t host kiro-claude chat`). Deterministic: the
 * stall is held until the test lets the terminal drain, and every step waits for a state (the fake
 * stopped, its can_use_tool sent, the chat inside the tty write). Temp dirs only. Skipped without
 * Linux, python3, or a readable /proc/<pid>/stack (root).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { builtBin } from '../cli/helpers.js';
import { APPROVAL_WAITING, heldRoot, type Held } from './r12f-ta-pty-helpers.js';
import { procState, skipPty, sleep, waitUntil } from './r11f-ta-pty-helpers.js';

/** The chat leads the pty's session; SIGUSR1 stops reading what it writes (the terminal does not drain), SIGUSR2 reads again. */
const DRIVER = String.raw`
import os, pty, sys, select, signal, struct, fcntl, termios, time
argv = sys.argv[1:]
pid, master = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 160, 0, 0))
os.write(1, b'CHILD %d\n' % pid)
stop = [False]
drain = [True]
signal.signal(signal.SIGTERM, lambda s, f: stop.__setitem__(0, True))
signal.signal(signal.SIGUSR1, lambda s, f: drain.__setitem__(0, False))
signal.signal(signal.SIGUSR2, lambda s, f: drain.__setitem__(0, True))
inp = sys.stdin.fileno()
inp_open = True
while not stop[0]:
    fds = ([master] if drain[0] else []) + ([inp] if inp_open else [])
    try:
        r, _, _ = select.select(fds, [], [], 0.05)
    except InterruptedError:
        continue
    if master in r:
        try:
            d = os.read(master, 65536)
        except OSError:
            break
        if not d:
            break
        os.write(1, d)
    if inp_open and inp in r:
        d = os.read(inp, 65536)
        if d:
            os.write(master, d)
        else:
            inp_open = False
    w, _ = os.waitpid(pid, os.WNOHANG)
    if w == pid:
        break
try:
    os.kill(pid, signal.SIGCONT)
    os.kill(pid, signal.SIGKILL)
except ProcessLookupError:
    pass
`;

const stackReadable = ((): boolean => {
  try {
    fs.readFileSync(`/proc/${process.pid}/stack`, 'utf8');
    return true;
  } catch {
    return false;
  }
})();
const skip = skipPty || (stackReadable ? false : 'needs a readable /proc/<pid>/stack (root)');

interface Chat {
  pid: number;
  py: ChildProcess;
  write(s: string): void;
  screen(): string;
  waitFor(re: RegExp, what: string, from?: number, ms?: number): Promise<void>;
  dispose(): Promise<void>;
}

async function chat(h: Held): Promise<Chat> {
  const { r } = h;
  const driver = path.join(r.root, 'drain.py');
  fs.writeFileSync(driver, DRIVER);
  const fakeLog = /FAKE_CLAUDE_LOG='([^']+)'/.exec(h.prefix)![1]!;
  const py = spawn('python3', ['-I', driver, process.execPath, builtBin(), 'chat', ...h.args.trim().split(' ')], {
    cwd: r.ws,
    env: r.env({ TERM: 'xterm', FAKE_CLAUDE_LOG: fakeLog, FAKE_CLAUDE_LOG_STDOUT: '1', TMPDIR: r.root }),
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  let out = '';
  py.stdout!.on('data', (d: Buffer) => (out += d.toString()));
  py.stdin!.on('error', () => undefined);
  const screen = (): string => out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  let pid = 0;
  const c: Chat = {
    get pid() {
      return pid;
    },
    py,
    write: (s) => {
      py.stdin!.write(s);
    },
    screen,
    async waitFor(re, what, from = 0, ms = 20_000) {
      const t0 = Date.now();
      while (!re.test(screen().slice(from))) {
        if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}\n--- screen:\n${JSON.stringify(screen().slice(from).slice(-1500))}`);
        await sleep(10);
      }
    },
    async dispose() {
      py.kill('SIGUSR2');
      py.kill('SIGTERM');
      await sleep(300);
      // only the chat this test started
      if (pid && procState(pid) !== 'gone') {
        try {
          process.kill(pid, 'SIGCONT');
          process.kill(pid, 'SIGKILL');
        } catch {
          // gone
        }
      }
      await sleep(100);
      r.cleanup();
    },
  };
  try {
    await waitUntil(() => /CHILD (\d+)/.test(out), 'the chat starts', 15_000);
    pid = Number(/CHILD (\d+)/.exec(out)![1]);
    await c.waitFor(/Welcome to[\s\S]*> $/, 'the chat prompt', 0, 30_000);
  } catch (e) {
    await c.dispose();
    throw e;
  }
  return c;
}

/** Fill the pty's output buffer (the driver no longer reads it): the chat's next write blocks. */
function fill(chatPid: number): number {
  const tty = fs.readlinkSync(`/proc/${chatPid}/fd/1`);
  const fd = fs.openSync(tty, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOCTTY);
  const chunk = Buffer.alloc(1024, '.');
  let n = 0;
  try {
    for (let i = 0; i < 100_000; i++) {
      try {
        n += fs.writeSync(fd, chunk);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EAGAIN') break;
        throw e;
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  return n;
}

const inTtyWrite = (pid: number): boolean => {
  try {
    return fs.readFileSync(`/proc/${pid}/stack`, 'utf8').includes('n_tty_write');
  } catch {
    return false;
  }
};

test('r12f verify #0: a terminal that does not drain stalls the chat after the permission request was read: `y` + Enter typed before its question was drawn does not answer it; `n` typed at the question does', { skip, timeout: 120_000 }, async () => {
  const h = heldRoot();
  const c = await chat(h);
  try {
    const fake = h.armHold(c.pid);
    c.write('go\r');
    await h.held(fake);
    // the terminal stops reading the chat's output, and its buffer is full
    c.py.kill('SIGUSR1');
    await sleep(200);
    assert.ok(fill(c.pid) > 0, 'the pty took no output');
    // Claude Code asks; the chat blocks writing the approval (the tool block, its question)
    process.kill(fake, 'SIGCONT');
    await waitUntil(() => h.sent('can_use_tool') >= 1, 'can_use_tool sent', 15_000);
    await waitUntil(() => inTtyWrite(c.pid), 'the chat blocks in a write to the terminal', 15_000);
    await sleep(300);
    // typed while nothing of the question could be on the screen
    c.write('y\r');
    await sleep(600);
    assert.ok(inTtyWrite(c.pid), 'the chat left the write before the terminal drained');
    const mark = c.screen().length;
    c.py.kill('SIGUSR2');
    await c.waitFor(/Allow this action\?/, 'the approval question is drawn', mark, 20_000);
    await sleep(1000);
    assert.deepEqual(h.behaviors(), [], `keys typed before the question was drawn answered it: ${JSON.stringify(h.behaviors())}`);
    await c.waitFor(APPROVAL_WAITING, 'the approval question waits, nothing typed at it', mark, 5000);
    c.write('n\r');
    await waitUntil(() => h.behaviors().length > 0, 'the answer typed at the question', 15_000);
    assert.deepEqual(h.behaviors(), ['deny']);
  } finally {
    await c.dispose();
  }
});

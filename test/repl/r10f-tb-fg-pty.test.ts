/**
 * Round-10 fix "terminal-b" #2 in a real terminal: a python3 pty driver running an interactive bash
 * (job control), the built CLI over test/fixtures/fake-claude.mjs, temp dirs only.
 *
 * After Ctrl+Z and `bg` (and after a `!cmd` that ends in the background after Ctrl+Z and `bg`:
 * Repl.handBack), bash's `fg` of the RUNNING chat sends no SIGCONT, so the chat took the terminal
 * back only at its next foreground poll, up to 250 ms later. Until then the terminal is in the
 * shell's cooked mode: a line typed in that window was echoed by the terminal and its Return
 * queued as LF, which the reader read as Ctrl+J (a soft newline): not submitted; a Ctrl+D (a NUL
 * placeholder in canonical mode) was dropped. Now the chat asks every 20 ms while in the background,
 * and the keys queued in the cooked mode are read as typed there (Return submits, Ctrl+D is
 * Ctrl+D). `sleep 0.6; fg` with keys typed during the sleep puts them in that window every time
 * (bash runs the sleep in the foreground, in cooked mode). Control: `fg` of the stopped chat.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { builtBin } from '../cli/helpers.js';
import { mkRoot, sleep, type Root } from '../headless/r5f-signals-helpers.js';
import { removeOnExit } from '../tmpdirs.js';

const PTY_DRIVER = String.raw`
import os, pty, sys, select, signal, struct, fcntl, termios, time
argv = sys.argv[1:]
pid, master = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 160, 0, 0))
stop = [False]
signal.signal(signal.SIGTERM, lambda s, f: stop.__setitem__(0, True))
inp = sys.stdin.fileno()
inp_open = True
status = None
while status is None:
    if stop[0]:
        try:
            os.close(master)
        except OSError:
            pass
        end = time.time() + 3
        while status is None and time.time() < end:
            w, st = os.waitpid(pid, os.WNOHANG)
            if w == pid:
                status = st
            else:
                time.sleep(0.02)
        if status is None:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            _, status = os.waitpid(pid, 0)
        break
    fds = [master] + ([inp] if inp_open else [])
    try:
        r, _, _ = select.select(fds, [], [], 0.05)
    except InterruptedError:
        continue
    if master in r:
        try:
            d = os.read(master, 65536)
        except OSError:
            d = b''
        if d:
            os.write(1, d)
    if inp_open and inp in r:
        d = os.read(inp, 65536)
        if d:
            os.write(master, d)
        else:
            inp_open = False
    w, st = os.waitpid(pid, os.WNOHANG)
    if w == pid:
        status = st
`;

const BASH = spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout?.trim() ?? '';
const HAVE_PTY =
  process.platform === 'linux' && spawnSync('python3', ['-I', '-c', 'import pty, termios, fcntl'], { stdio: 'ignore' }).status === 0;
const skip = HAVE_PTY ? (BASH ? false : 'needs bash') : 'needs Linux and python3 (pty)';

const SCRIPT = { turns: [{ repeat: true, steps: [{ text: 'ANSWER to {{userText}}' }] }] };

async function waitUntil(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`);
    await sleep(10);
  }
}

/** The state letter of /proc/<pid>/stat, or 'gone'. */
function procState(pid: number): string {
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return s.slice(s.lastIndexOf(')') + 2).split(' ')[0] ?? 'gone';
  } catch {
    return 'gone';
  }
}

interface Term {
  write(s: string): void;
  screen(): string;
  waitFor(re: RegExp, what: string, from?: number, ms?: number): Promise<void>;
  chatPid(): number;
  dispose(): Promise<void>;
}

function underBash(r: Root, extra: Record<string, string> = {}): Term {
  const driver = path.join(r.root, 'pty.py');
  fs.writeFileSync(driver, PTY_DRIVER);
  const env = r.env({ TERM: 'xterm', PS1: 'BASH$ ', ...extra });
  const py = spawn('python3', ['-I', driver, BASH, '--norc', '--noprofile', '-i'], { cwd: r.ws, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let done = false;
  py.stdout.on('data', (d: Buffer) => (out += d.toString()));
  py.stderr.on('data', () => undefined);
  py.stdin.on('error', () => undefined);
  const exited = new Promise((res) =>
    py.on('exit', () => {
      done = true;
      res(undefined);
    }),
  );
  const screen = (): string => out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  let pid: number | undefined;
  const ours = (p: number): boolean => {
    try {
      return fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').includes(builtBin());
    } catch {
      return false;
    }
  };
  return {
    write: (s) => {
      if (!done) py.stdin.write(s);
    },
    screen,
    async waitFor(re, what, from = 0, ms = 20_000) {
      const t0 = Date.now();
      while (!re.test(screen().slice(from))) {
        if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}\n--- screen:\n${JSON.stringify(screen().slice(from).slice(-2000))}`);
        await sleep(10);
      }
    },
    chatPid() {
      if (pid === undefined) {
        const lock = r.locks()[0];
        assert.ok(lock, 'no session lock');
        pid = (JSON.parse(fs.readFileSync(path.join(r.sessions, lock), 'utf8')) as { pid: number }).pid;
      }
      return pid;
    },
    async dispose() {
      if (!done) {
        py.kill('SIGTERM');
        await Promise.race([exited, sleep(5000)]);
        if (!done) py.kill('SIGKILL');
      }
      // only the kiro-claude this test started, should it outlive its terminal
      if (pid !== undefined && ours(pid)) {
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
}

async function startChat(t: Term): Promise<number> {
  await t.waitFor(/BASH\$ $/, 'bash prompt');
  t.write(`'${process.execPath}' '${builtBin()}' chat\r`);
  await t.waitFor(/chat[^\n]*\r?\n[\s\S]*> $/, 'chat prompt');
  return t.chatPid();
}

/** Ctrl+Z (at the prompt, or in a running `!cmd`), then `bg`: the chat runs on in the background. */
async function stopAndBg(t: Term, pid: number): Promise<void> {
  let mark = t.screen().length;
  t.write('\x1a');
  await t.waitFor(/Stopped[\s\S]*BASH\$ $/, 'bash reports the job stopped', mark);
  mark = t.screen().length;
  t.write('bg\r');
  await t.waitFor(/BASH\$ $/, 'bash prompt after bg', mark);
  await waitUntil(() => procState(pid) === 'S' || procState(pid) === 'R', 'running in the background', 5000);
}

/** `line` is answered exactly once after `mark`, and the next prompt is up. */
async function answeredOnce(t: Term, line: string, mark: number): Promise<void> {
  const re = new RegExp(`ANSWER to ${line}`, 'g');
  await t.waitFor(new RegExp(`ANSWER to ${line}[\\s\\S]*> $`), `the answer to ${line} (the Return typed in the cooked window was a soft newline?)`, mark, 8000);
  await sleep(300);
  assert.equal(t.screen().slice(mark).match(re)?.length, 1, t.screen().slice(mark));
}

function setup(): { r: Root; t: Term } {
  const r = mkRoot(SCRIPT);
  removeOnExit(r.root);
  return { r, t: underBash(r) };
}

test('r10f #2: Ctrl+Z, `bg`, `fg`, then a line + Enter 30 ms after fg: submitted once (three phases of the foreground poll)', { skip, timeout: 120_000 }, async () => {
  const { t } = setup();
  try {
    const pid = await startChat(t);
    for (const [i, wait] of [1000, 1007, 1013].entries()) {
      await stopAndBg(t, pid);
      await sleep(wait);
      const mark = t.screen().length;
      t.write('fg\r');
      await sleep(30);
      t.write(`hello${i}\r`);
      await answeredOnce(t, `hello${i}`, mark);
    }
  } finally {
    await t.dispose();
  }
});

test('r10f #2: Ctrl+Z, `bg`, `sleep 0.6; fg` with a line + Enter typed during the sleep (queued cooked): submitted once', { skip, timeout: 120_000 }, async () => {
  const { t } = setup();
  try {
    const pid = await startChat(t);
    await stopAndBg(t, pid);
    const mark = t.screen().length;
    t.write('sleep 0.6; fg\r');
    await sleep(250);
    t.write('hello\r');
    await answeredOnce(t, 'hello', mark);
  } finally {
    await t.dispose();
  }
});

test('r10f #2: Ctrl+Z, `bg`, `sleep 0.6; fg` with Ctrl+D typed during the sleep: it acts as Ctrl+D (the exit hint)', { skip, timeout: 120_000 }, async () => {
  const { t } = setup();
  try {
    const pid = await startChat(t);
    await stopAndBg(t, pid);
    const mark = t.screen().length;
    t.write('sleep 0.6; fg\r');
    await sleep(250);
    t.write('\x04');
    await t.waitFor(/press Ctrl\+C or Ctrl\+D again[\s\S]*> $/, 'the exit hint of a Ctrl+D (it was dropped?)', mark, 8000);
    assert.equal(procState(pid) !== 'gone', true);
    const m2 = t.screen().length;
    t.write('hello\r');
    await answeredOnce(t, 'hello', m2);
  } finally {
    await t.dispose();
  }
});

test('r10f #2: `!sleep 1`, Ctrl+Z, `bg` (the child ends in the background), `sleep 0.6; fg` with a line typed during the sleep: submitted once', { skip, timeout: 120_000 }, async () => {
  const { t } = setup();
  try {
    const pid = await startChat(t);
    t.write('!sleep 1\r');
    await sleep(400);
    await stopAndBg(t, pid);
    await sleep(1500); // the child is done; the chat waits for the foreground (Repl.handBack)
    const mark = t.screen().length;
    t.write('sleep 0.6; fg\r');
    await sleep(250);
    t.write('hello\r');
    await answeredOnce(t, 'hello', mark);
  } finally {
    await t.dispose();
  }
});

test('r10f #2: `!sleep 1`, Ctrl+Z, `bg` (the child ends in the background), `fg`, a line + Enter 30 ms later: submitted once', { skip, timeout: 120_000 }, async () => {
  const { t } = setup();
  try {
    const pid = await startChat(t);
    t.write('!sleep 1\r');
    await sleep(400);
    await stopAndBg(t, pid);
    await sleep(1500);
    const mark = t.screen().length;
    t.write('fg\r');
    await sleep(30);
    t.write('hello\r');
    await answeredOnce(t, 'hello', mark);
  } finally {
    await t.dispose();
  }
});

test('r10f #2 control: Ctrl+Z, `fg` of the stopped chat (SIGCONT), a line + Enter 30 ms later: submitted once', { skip, timeout: 120_000 }, async () => {
  const { t } = setup();
  try {
    await startChat(t);
    let mark = t.screen().length;
    t.write('\x1a');
    await t.waitFor(/Stopped[\s\S]*BASH\$ $/, 'bash reports the job stopped', mark);
    mark = t.screen().length;
    t.write('fg\r');
    await sleep(30);
    t.write('hello\r');
    await answeredOnce(t, 'hello', mark);
  } finally {
    await t.dispose();
  }
});

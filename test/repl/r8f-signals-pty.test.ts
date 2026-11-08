/**
 * Round-8 fix "signals-docs" #6 over a real pty (the built CLI over test/fixtures/fake-claude.mjs,
 * temp dirs; a python3 driver runs the chat on a fresh pty, relays our pipe to it and back,
 * resizes the window on SIGUSR2 and reports the chat's status):
 *  - After a SIGTERM at the prompt or at a command's question, a `kill -INT` is a second signal:
 *    kiro-claude dies of the SIGTERM at once (the slow SessionEnd hook is cut short). A terminal
 *    resize and keys typed before it, during the grace, still draw nothing, and nothing is
 *    written after the SIGTERM at all: the REPL's own SIGINT handling (the interrupt of its muted
 *    read) runs too and draws no fresh line.
 *  - In the interactive terminal the input stays in raw mode during the grace, so a Ctrl+C KEY is
 *    a key, which the muted reader drops, not a SIGINT: the close runs to its end.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { builtBin } from '../cli/helpers.js';
import { mkRoot, sessionEndHook, sleep, type Root } from '../headless/r5f-signals-helpers.js';
import { removeOnExit } from '../tmpdirs.js';

const PTY_DRIVER = String.raw`
import os, pty, sys, select, signal, struct, fcntl, termios
argv = sys.argv[1:]
pid, master = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
sizes = [(30, 90), (40, 120)]
resized = [0]
def resize(s, f):
    rows, cols = sizes[resized[0] % 2]
    resized[0] += 1
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
signal.signal(signal.SIGUSR2, resize)
inp = sys.stdin.fileno()
inp_open = True
status = None
while status is None:
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
if os.WIFSIGNALED(status):
    sys.stderr.write('STATUS signal %d\n' % os.WTERMSIG(status))
else:
    sys.stderr.write('STATUS code %d\n' % os.WEXITSTATUS(status))
sys.stderr.flush()
`;

const HAVE_PTY = process.platform === 'linux' && spawnSync('python3', ['-I', '-c', 'import pty, termios, fcntl'], { stdio: 'ignore' }).status === 0;
const skip = HAVE_PTY ? false : 'needs Linux and python3 (pty)';

interface Pty {
  raw: () => string;
  screen: () => string;
  write: (s: string) => void;
  resize: () => void;
  exited: Promise<unknown>;
  status: () => string | undefined;
  waitFor: (fn: () => boolean, what: string, ms?: number) => Promise<void>;
  kill: () => void;
}

function startPty(r: Root, cmd: string[], env: NodeJS.ProcessEnv): Pty {
  const driver = path.join(r.root, 'ptydrv.py');
  fs.writeFileSync(driver, PTY_DRIVER);
  const py = spawn('python3', ['-I', driver, ...cmd], { cwd: r.ws, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let perr = '';
  py.stdout.on('data', (d: Buffer) => (out += d.toString('latin1')));
  py.stderr.on('data', (d: Buffer) => (perr += d.toString()));
  py.stdin.on('error', () => undefined);
  const exited = new Promise((res) => py.on('exit', res));
  const screen = (): string => out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  return {
    raw: () => out,
    screen,
    write: (s) => py.stdin.write(s),
    resize: () => py.kill('SIGUSR2'),
    exited,
    status: () => /STATUS (.*)/.exec(perr)?.[1],
    waitFor: async (fn, what, ms = 20_000) => {
      const t0 = Date.now();
      while (!fn()) {
        if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}\n--- screen:\n${screen().slice(-3000)}\n--- driver:\n${perr}`);
        await sleep(10);
      }
    },
    kill: () => py.kill('SIGKILL'),
  };
}

function lockPid(r: Root): number {
  return (JSON.parse(fs.readFileSync(path.join(r.sessions, r.locks()[0]!), 'utf8')) as { pid: number }).pid;
}

function killQuietly(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(pid, 'SIGKILL'); // only the kiro-claude this test started, should it hang
  } catch {
    // gone
  }
}

/** The chat on a pty after one answer (at `/clear`'s question with `question`); its pid. */
async function chatAtPrompt(question: boolean): Promise<{ r: Root; p: Pty; pid: number; done: string }> {
  const r = mkRoot({ turns: [{ repeat: true, steps: [{ text: 'ANSWER to {{userText}}' }] }] });
  removeOnExit(r.root);
  const done = path.join(r.root, 'end.done');
  sessionEndHook(r, `cat > /dev/null; sleep 1.5; touch '${done}'`);
  const p = startPty(r, [process.execPath, builtBin(), 'chat'], r.env({ TERM: 'xterm' }));
  await p.waitFor(() => /> $/.test(p.screen()), 'chat prompt');
  p.write('hello\r');
  await p.waitFor(() => /ANSWER to hello[\s\S]*> $/.test(p.screen()), 'first answer');
  const pid = lockPid(r);
  if (question) {
    const m = p.screen().length;
    p.write('/clear\r');
    await p.waitFor(() => /\[y\/n\]:[\s\S]*> $/.test(p.screen().slice(m)), "/clear's question");
  }
  p.write('half typed');
  await sleep(300);
  return { r, p, pid, done };
}

for (const where of ['prompt', 'question'] as const) {
  test(`r8f #6 (pty): after a SIGTERM (chat ${where === 'prompt' ? 'at the prompt' : "at /clear's question"}), a resize and keys draw nothing, and a kill -INT then ends it at once (nothing written)`, { skip, timeout: 60_000 }, async () => {
    let pid: number | undefined;
    let p: Pty | undefined;
    try {
      const c = await chatAtPrompt(where === 'question');
      pid = c.pid;
      p = c.p;
      const at = p.raw().length;
      const t0 = Date.now();
      process.kill(pid, 'SIGTERM');
      await sleep(100);
      p.resize();
      await sleep(100);
      p.write(' and more\ry\r');
      await sleep(100);
      process.kill(pid, 'SIGINT');
      await p.exited;
      const ms = Date.now() - t0;
      const after = p.raw().slice(at);
      assert.equal(p.status(), 'signal 15', `died ${ms} ms after the SIGTERM`);
      assert.ok(ms < 1200, `died ${ms} ms after the SIGTERM, not at the SIGINT 300 ms after it`);
      assert.ok(!fs.existsSync(c.done), 'the SessionEnd hook completed: the SIGINT did not cut the close short');
      assert.equal(after, '', `written after the signal: ${JSON.stringify(after)}`);
    } finally {
      p?.kill();
      killQuietly(pid);
    }
  });
}

test('r8f #6 (pty): after a SIGTERM at the prompt, a Ctrl+C key (raw mode) is a key the muted reader drops, not a SIGINT: the close runs to its end, nothing written', { skip, timeout: 60_000 }, async () => {
  let pid: number | undefined;
  let p: Pty | undefined;
  try {
    const c = await chatAtPrompt(false);
    pid = c.pid;
    p = c.p;
    const at = p.raw().length;
    process.kill(pid, 'SIGTERM');
    await sleep(150);
    p.write('\x03');
    await p.exited;
    const after = p.raw().slice(at);
    assert.equal(p.status(), 'signal 15');
    assert.ok(fs.existsSync(c.done), 'the Ctrl+C key cut the close short');
    assert.deepEqual(c.r.locks(), []);
    assert.equal(after, '', `written after the signal: ${JSON.stringify(after)}`);
  } finally {
    p?.kill();
    killQuietly(pid);
  }
});

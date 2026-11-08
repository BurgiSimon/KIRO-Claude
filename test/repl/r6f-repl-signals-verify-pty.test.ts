/**
 * Round-6 verification of the "repl-signals" fixes over a real pty (built CLI over
 * test/fixtures/fake-claude.mjs, temp dirs):
 *
 *  - #3 under an interactive bash (the usual setup: kiro-claude is a foreground job, not the
 *    session leader). Closing the terminal after a forced stop: the hangup's EIO reaches
 *    kiro-claude before bash's SIGHUP (bash forwards it to its jobs, then the kernel sends its own
 *    when bash exits), later than the kernel's to a session leader. kiro-claude must still die of
 *    SIGHUP, not exit 0. r5f-signals-pty.test.ts never looks at kiro-claude's own status under
 *    bash; here a wrapper that ignores SIGHUP records it.
 *  - After a fatal signal nothing more is printed, also when a terminal resize comes during the
 *    grace, or keys are typed (at the prompt, at a command's question): readline redrew the
 *    prompt line at the resize. (A process SIGINT during the grace used to be checked here too;
 *    since r8 #6 it is a second signal that ends kiro-claude at once, see r8f-signals-pty.)
 *  - Controls: a resize at the prompt still redraws the prompt line; one while an answer streams
 *    draws no stale prompt over it, and the answer is intact.
 *
 * The pty driver (python3) runs a command on a fresh pty as its session leader, relays our pipe
 * to the pty and back, on SIGUSR1 closes the master (the window closes) and reports the child's
 * status, and on SIGUSR2 changes the window size (SIGWINCH; it alternates between two sizes, since
 * the kernel signals only a change).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { builtBin } from '../cli/helpers.js';
import { mkRoot, sessionEndHook, sleep } from '../headless/r5f-signals-helpers.js';

const PTY_DRIVER = String.raw`
import os, pty, sys, select, signal, struct, fcntl, termios
argv = sys.argv[1:]
pid, master = pty.fork()
if pid == 0:
    errf = os.environ.get('PTYHUP_STDERR')
    if errf:
        e = os.open(errf, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        os.dup2(e, 2)
        os.close(e)
    os.execvp(argv[0], argv)
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
want_hang = [False]
signal.signal(signal.SIGUSR1, lambda s, f: want_hang.__setitem__(0, True))
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
    if want_hang[0]:
        os.close(master)
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
if os.WIFSIGNALED(status):
    sys.stderr.write('STATUS signal %d\n' % os.WTERMSIG(status))
else:
    sys.stderr.write('STATUS code %d\n' % os.WEXITSTATUS(status))
sys.stderr.flush()
`;

/** Runs a command ignoring SIGHUP itself (it shares the job's process group) and records its status. */
const WRAPPER = `import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
process.on('SIGHUP', () => undefined);
const [file, cmd, ...args] = process.argv.slice(2);
const c = spawn(cmd, args, { stdio: 'inherit' });
c.on('exit', (code, sig) => fs.writeFileSync(file, sig ? 'signal ' + sig : 'code ' + code));
`;

const HAVE_PTY =
  process.platform === 'linux' &&
  spawnSync('python3', ['-I', '-c', 'import pty, termios, fcntl'], { stdio: 'ignore' }).status === 0 &&
  spawnSync('bash', ['--version'], { stdio: 'ignore' }).status === 0;
const skip = HAVE_PTY ? false : 'needs Linux, python3 (pty) and bash';

interface Pty {
  /** The screen so far (raw bytes as latin1). */
  raw: () => string;
  /** The screen without CSI sequences. */
  screen: () => string;
  write: (s: string) => void;
  /** The driver's own SIGUSR1 (close the master) / SIGUSR2 (resize). */
  signal: (sig: 'SIGUSR1' | 'SIGUSR2') => void;
  exited: Promise<unknown>;
  status: () => string | undefined;
  waitFor: (fn: () => boolean, what: string, ms?: number) => Promise<void>;
  kill: () => void;
}

function startPty(r: ReturnType<typeof mkRoot>, cmd: string[], env: NodeJS.ProcessEnv): Pty {
  const driver = path.join(r.root, 'ptydrv.py');
  fs.writeFileSync(driver, PTY_DRIVER);
  const py = spawn('python3', ['-I', driver, ...cmd], { cwd: r.ws, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let perr = '';
  py.stdout.on('data', (d: Buffer) => (out += d.toString('latin1')));
  py.stderr.on('data', (d: Buffer) => (perr += d.toString()));
  const exited = new Promise((res) => py.on('exit', res));
  const screen = (): string => out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  return {
    raw: () => out,
    screen,
    write: (s) => py.stdin.write(s),
    signal: (sig) => py.kill(sig),
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

function lockPid(r: ReturnType<typeof mkRoot>): number {
  return (JSON.parse(fs.readFileSync(path.join(r.sessions, r.locks()[0]!), 'utf8')) as { pid: number }).pid;
}

async function gone(pid: number): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await sleep(10);
  }
}

function killQuietly(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(pid, 'SIGKILL'); // only the kiro-claude this test started, should it hang
  } catch {
    // gone
  }
}

test('r6f verify #3: started from an interactive bash, a forced stop, then the terminal closes: kiro-claude dies of SIGHUP (not exit 0)', { skip, timeout: 90_000 }, async (t) => {
  const r = mkRoot({
    turns: [
      { repeat: true, match: 'slow', steps: [{ text: 'partial ' }, { sleepMs: 60_000 }] },
      { repeat: true, steps: [{ text: 'ANSWER to {{userText}}' }] },
    ],
  });
  const wrapper = path.join(r.root, 'wrap.mjs');
  fs.writeFileSync(wrapper, WRAPPER);
  const statusFile = path.join(r.root, 'status.txt');
  const endFile = path.join(r.root, 'ended.txt');
  const errFile = path.join(r.root, 'kc-stderr.txt');
  sessionEndHook(r, `cat >> '${endFile}'; echo >> '${endFile}'`);
  const env = r.env({ TERM: 'xterm', PS1: 'BASH$ ', FAKE_CLAUDE_CONTROL_DELAYS: JSON.stringify({ interrupt: 120_000 }) });
  const p = startPty(r, ['bash', '--norc', '--noprofile', '-i'], env);
  let pid: number | undefined;
  try {
    await p.waitFor(() => /BASH\$ $/.test(p.screen()), 'bash prompt');
    p.write(`'${process.execPath}' '${wrapper}' '${statusFile}' '${process.execPath}' '${builtBin()}' chat 2>>'${errFile}'\r`);
    await p.waitFor(() => /> $/.test(p.screen()), 'chat prompt');
    p.write('hello\r');
    await p.waitFor(() => /ANSWER to hello[\s\S]*> $/.test(p.screen()), 'first answer');
    pid = lockPid(r);
    const from = p.screen().length;
    p.write('slow one\r');
    await p.waitFor(() => /partial/.test(p.screen().slice(from)), 'slow answer streaming');
    await sleep(300);
    p.write('\x03');
    await sleep(300);
    p.write('\x03');
    await p.waitFor(() => /did not stop after the interrupt[\s\S]*> $/.test(p.screen().slice(from)), 'forced stop, back at the prompt', 15_000);
    await p.waitFor(() => r.locks().length === 0, 'stopped session closed (lock released)', 10_000);
    await sleep(1000);
    const t0 = performance.now();
    p.signal('SIGUSR1'); // the terminal window closes
    await p.exited;
    await p.waitFor(() => fs.existsSync(statusFile), 'kiro-claude status recorded', 10_000);
    t.diagnostic(`window closed -> kiro-claude ended: ${(performance.now() - t0).toFixed(0)} ms`);
    await gone(pid);
    await sleep(200);
    const stderr = fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf8') : '';
    assert.doesNotMatch(stderr, /Unhandled 'error'|throw e/, stderr);
    assert.deepEqual(r.locks(), []);
    // the stopped session's SessionEnd ran at the forced stop; nothing runs it twice
    assert.equal(fs.readFileSync(endFile, 'utf8').split('\n').filter((l) => l.trim()).length, 1);
    assert.equal(fs.readFileSync(statusFile, 'utf8'), 'signal SIGHUP', `stderr:\n${stderr}`);
  } finally {
    p.kill();
    killQuietly(pid);
    await sleep(200);
    r.cleanup();
  }
});

for (const where of ['prompt', 'question'] as const) {
  // r8 #6: a SIGINT after the SIGTERM is now a second signal and ends kiro-claude at once (covered
  // by r8f-signals-pty); here the grace runs to its end under a resize and typed keys
  test(`r6f verify: after a SIGTERM (chat ${where === 'prompt' ? 'at the prompt' : "at /clear's question"}), a terminal resize and keys typed during the grace print nothing`, { skip, timeout: 60_000 }, async () => {
    const r = mkRoot({ turns: [{ repeat: true, steps: [{ text: 'ANSWER to {{userText}}' }] }] });
    const endFile = path.join(r.root, 'ended.txt');
    const errFile = path.join(r.root, 'kc-stderr.txt');
    sessionEndHook(r, `cat > /dev/null; sleep 1.5; echo end >> '${endFile}'`);
    const p = startPty(r, [process.execPath, builtBin(), 'chat'], r.env({ TERM: 'xterm', PTYHUP_STDERR: errFile }));
    let pid: number | undefined;
    try {
      await p.waitFor(() => /> $/.test(p.screen()), 'chat prompt');
      p.write('hello\r');
      await p.waitFor(() => /ANSWER to hello[\s\S]*> $/.test(p.screen()), 'first answer');
      pid = lockPid(r);
      if (where === 'question') {
        const m = p.screen().length;
        p.write('/clear\r');
        await p.waitFor(() => /\[y\/n\]:[\s\S]*> $/.test(p.screen().slice(m)), "/clear's question");
      }
      p.write('half typed');
      await sleep(300);
      const at = p.raw().length;
      process.kill(pid, 'SIGTERM');
      await sleep(250);
      p.signal('SIGUSR2'); // the window is resized
      await sleep(100);
      p.write(' and more\ry\r');
      await p.exited;
      const after = p.raw().slice(at);
      assert.equal(p.status(), 'signal 15', `stderr:\n${fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf8') : ''}`);
      assert.equal(fs.readFileSync(endFile, 'utf8').trim(), 'end');
      assert.equal(after, '', `written after the signal: ${JSON.stringify(after)}`);
      assert.deepEqual(r.locks(), []);
    } finally {
      p.kill();
      killQuietly(pid);
      await sleep(200);
      r.cleanup();
    }
  });
}

test('r6f verify: a terminal resize redraws the prompt line at the prompt (control), and draws no stale prompt over an answer that streams', { skip, timeout: 60_000 }, async () => {
  const r = mkRoot({
    turns: [
      { repeat: true, match: 'slow', steps: [{ text: 'partial ' }, { sleepMs: 1500 }, { text: 'REST-OF-IT' }] },
      { repeat: true, steps: [{ text: 'ANSWER to {{userText}}' }] },
    ],
  });
  const p = startPty(r, [process.execPath, builtBin(), 'chat'], r.env({ TERM: 'xterm' }));
  let pid: number | undefined;
  try {
    await p.waitFor(() => /> $/.test(p.screen()), 'chat prompt');
    p.write('hello\r');
    await p.waitFor(() => /ANSWER to hello[\s\S]*> $/.test(p.screen()), 'first answer');
    pid = lockPid(r);
    p.write('half typed');
    await sleep(200);
    let at = p.raw().length;
    p.signal('SIGUSR2');
    await p.waitFor(() => /> half typed/.test(p.raw().slice(at)), 'the prompt line redrawn at the resize', 5000);
    p.write('\x15'); // Ctrl+U: clear the line
    await sleep(100);
    p.write('slow one\r');
    await p.waitFor(() => /partial/.test(p.screen().split('slow one').pop() ?? ''), 'slow answer streaming');
    await sleep(200);
    at = p.raw().length;
    p.signal('SIGUSR2');
    await sleep(200);
    assert.equal(p.raw().slice(at), '', 'a resize while the answer streams wrote over it');
    await p.waitFor(() => /partial REST-OF-IT/.test(p.screen()), 'the answer, intact');
    await p.waitFor(() => /> $/.test(p.screen()), 'back at the prompt');
  } finally {
    p.kill();
    killQuietly(pid);
    await sleep(200);
    r.cleanup();
  }
});

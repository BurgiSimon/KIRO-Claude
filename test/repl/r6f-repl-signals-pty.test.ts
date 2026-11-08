/**
 * Round-6 fix "repl-signals" #3: a hung-up terminal ends the chat's input (EOF / EIO) a moment
 * before Node dispatches the SIGHUP that comes with it. After a forced stop (second Ctrl+C, Claude
 * ignored the interrupt) the current session is the stopped one, whose close has already settled,
 * so before the fix the quit path finished within that moment: the resume hint went to the dead
 * terminal, the SIGHUP listener was removed and kiro-claude, the pty's session leader, exited 0
 * instead of dying of SIGHUP. Now the REPL waits (bounded) for the signal when the terminal input
 * hung up, and dies of it.
 *
 * Also: a Ctrl+D quit in the terminal (a key in raw mode, not an end of input) still exits 0 at
 * once with the resume hint.
 *
 * The "terminal" is the python3 pty driver of r5f-signals-pty.test.ts: it runs kiro-claude on a
 * fresh pty as its session leader, relays our pipe to the pty and back, and on SIGUSR1 closes the
 * master (the window closes) and reports the child's status. Built CLI over
 * test/fixtures/fake-claude.mjs, temp dirs.
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

const HAVE_PTY =
  process.platform === 'linux' && spawnSync('python3', ['-I', '-c', 'import pty, termios, fcntl'], { stdio: 'ignore' }).status === 0;
const skip = HAVE_PTY ? false : 'needs Linux and python3 (pty)';

type Ending = 'hangup' | 'forced-stop-hangup' | 'ctrl-d';

interface Outcome {
  status: string | undefined;
  /** SessionEnd hook runs. */
  ended: number;
  locks: string[];
  stderr: string;
  /** The screen after the ending began. */
  tail: string;
  /** ms from the ending (the master closed, the second Ctrl+D) until the driver reported. */
  ms: number;
}

async function run(ending: Ending): Promise<Outcome> {
  const r = mkRoot({
    turns: [
      { repeat: true, match: 'slow', steps: [{ text: 'partial ' }, { sleepMs: 60_000 }] },
      { repeat: true, steps: [{ text: 'ANSWER to {{userText}}' }] },
    ],
  });
  const driver = path.join(r.root, 'ptyhup.py');
  fs.writeFileSync(driver, PTY_DRIVER);
  const endFile = path.join(r.root, 'ended.txt');
  const errFile = path.join(r.root, 'kc-stderr.txt');
  sessionEndHook(r, `cat >> '${endFile}'; echo >> '${endFile}'`);
  const env = r.env({
    TERM: 'xterm',
    PTYHUP_STDERR: errFile,
    // Claude never answers (nor acts on) the interrupt: the second Ctrl+C force-stops it
    FAKE_CLAUDE_CONTROL_DELAYS: JSON.stringify({ interrupt: 120_000 }),
  });
  const py = spawn('python3', ['-I', driver, process.execPath, builtBin(), 'chat'], { cwd: r.ws, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let perr = '';
  py.stdout.on('data', (d: Buffer) => (out += d.toString()));
  py.stderr.on('data', (d: Buffer) => (perr += d.toString()));
  const exited = new Promise((res) => py.on('exit', res));
  const screen = (): string => out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const waitFor = async (fn: () => boolean, what: string, ms = 20_000): Promise<void> => {
    const t0 = Date.now();
    while (!fn()) {
      if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}\n--- screen:\n${screen().slice(-3000)}\n--- driver:\n${perr}`);
      await sleep(10);
    }
  };
  let pid: number | undefined;
  try {
    await waitFor(() => /> $/.test(screen()), 'chat prompt');
    py.stdin.write('hello\r');
    await waitFor(() => /ANSWER to hello[\s\S]*> $/.test(screen()), 'first answer');
    pid = (JSON.parse(fs.readFileSync(path.join(r.sessions, r.locks()[0]!), 'utf8')) as { pid: number }).pid;
    if (ending === 'forced-stop-hangup') {
      const from = screen().length;
      py.stdin.write('slow one\r');
      await waitFor(() => /partial/.test(screen().slice(from)), 'slow answer streaming');
      await sleep(300);
      py.stdin.write('\x03');
      await sleep(300);
      py.stdin.write('\x03');
      await waitFor(() => /did not stop after the interrupt[\s\S]*> $/.test(screen().slice(from)), 'forced stop, back at the prompt', 15_000);
      await waitFor(() => r.locks().length === 0, 'stopped session closed (lock released)', 10_000);
      await sleep(1000);
    } else {
      await sleep(300);
    }
    const from = screen().length;
    let t0: number;
    if (ending === 'ctrl-d') {
      py.stdin.write('\x04');
      await waitFor(() => /press Ctrl\+C or Ctrl\+D again/.test(screen().slice(from)), 'exit hint');
      t0 = performance.now();
      py.stdin.write('\x04');
    } else {
      t0 = performance.now();
      py.kill('SIGUSR1'); // the terminal window closes
    }
    await exited;
    const ms = performance.now() - t0;
    const p = pid;
    await waitFor(() => {
      try {
        process.kill(p, 0);
        return false;
      } catch {
        return true;
      }
    }, 'kiro-claude gone', 10_000);
    await sleep(200);
    return {
      status: /STATUS (.*)/.exec(perr)?.[1],
      ended: fs.existsSync(endFile) ? fs.readFileSync(endFile, 'utf8').split('\n').filter((l) => l.trim()).length : 0,
      locks: r.locks(),
      stderr: fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf8') : '',
      tail: screen().slice(from),
      ms,
    };
  } finally {
    py.kill('SIGKILL');
    if (pid !== undefined) {
      try {
        process.kill(pid, 'SIGKILL'); // only the kiro-claude this test started, should it hang
      } catch {
        // gone
      }
    }
    await sleep(200);
    r.cleanup();
  }
}

test('r6f #3 control: the terminal closes at the prompt, kiro-claude (session leader) closes the chat and dies of SIGHUP', { skip, timeout: 60_000 }, async (t) => {
  const o = await run('hangup');
  t.diagnostic(`master closed -> status reported: ${o.ms.toFixed(0)} ms`);
  assert.doesNotMatch(o.stderr, /Unhandled 'error'|throw e/, o.stderr);
  assert.deepEqual(o.locks, []);
  assert.equal(o.ended, 1, 'the SessionEnd hook did not run (once)');
  assert.equal(o.status, 'signal 1', `stderr:\n${o.stderr}`);
});

test('r6f #3: after a forced stop the terminal closes at the prompt: kiro-claude (session leader) dies of SIGHUP, not exit 0', { skip, timeout: 60_000 }, async (t) => {
  const o = await run('forced-stop-hangup');
  t.diagnostic(`master closed -> status reported: ${o.ms.toFixed(0)} ms`);
  assert.doesNotMatch(o.stderr, /Unhandled 'error'|throw e/, o.stderr);
  assert.deepEqual(o.locks, []);
  // the stopped session's SessionEnd ran at the forced stop; nothing runs it twice
  assert.equal(o.ended, 1, 'the SessionEnd hook did not run (once)');
  assert.equal(o.status, 'signal 1', `stderr:\n${o.stderr}`);
});

test('r6f #3: a Ctrl+D quit in the terminal (a key, not a hangup) still exits 0 with the resume hint, without waiting for a signal', { skip, timeout: 60_000 }, async (t) => {
  const o = await run('ctrl-d');
  t.diagnostic(`second Ctrl+D -> status reported: ${o.ms.toFixed(0)} ms`);
  assert.equal(o.status, 'code 0', `stderr:\n${o.stderr}`);
  assert.match(o.tail, /To resume this session: kiro-claude chat --resume-id /);
  assert.deepEqual(o.locks, []);
  assert.equal(o.ended, 1, 'the SessionEnd hook did not run (once)');
});

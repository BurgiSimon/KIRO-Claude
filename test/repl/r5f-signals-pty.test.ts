/**
 * Round-5 fix "signals" #1: closing the terminal (a real pty hangup, not `kill -HUP`) closes the
 * interactive chat the way ExitSignals promises: the SessionEnd hook runs, the session lock is
 * released, nothing crashes (no unhandled `setRawMode EIO` on the readline Interface, no rethrown
 * `write EIO`), and as the session leader kiro-claude dies of SIGHUP. Under an interactive bash the
 * closing tab delivers two SIGHUPs within a millisecond (bash's hangup_all_jobs, then the kernel's
 * when the session leader exits): the duplicate must not cut the close short.
 *
 * The "terminal" is a small python3 pty driver (written to the temp root): it runs a command on a
 * fresh pty as its session leader, relays our pipe to the pty and back, and on SIGUSR1 closes the
 * master (the window closes) and reports the child's status. Idle, streaming and approval states,
 * and a streaming `chat --no-interactive`, as the session leader and under bash. Built CLI over
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
  process.platform === 'linux' &&
  spawnSync('python3', ['-I', '-c', 'import pty, termios, fcntl'], { stdio: 'ignore' }).status === 0 &&
  spawnSync('bash', ['--version'], { stdio: 'ignore' }).status === 0;

const SCRIPTS = {
  idle: { turns: [{ repeat: true, steps: [{ text: 'ANSWER-ONE' }] }] },
  stream: { turns: [{ steps: [{ text: 'ANSWER-ONE' }] }, { steps: [{ text: 'partial ' }, { sleepMs: 60_000 }, { text: 'never' }] }] },
  approval: { turns: [{ steps: [{ text: 'ANSWER-ONE' }] }, { steps: [{ tool: { name: 'Bash', input: { command: 'touch made.txt' } } }, { text: 'after' }] }] },
  // `chat --no-interactive` streaming its answer
  headless: { turns: [{ steps: [{ text: 'partial ' }, { sleepMs: 60_000 }, { text: 'never' }] }] },
} as const;

interface Outcome {
  status: string | undefined;
  ended: number;
  locks: string[];
  stderr: string;
}

async function hangup(shell: boolean, state: keyof typeof SCRIPTS): Promise<Outcome> {
  const r = mkRoot(SCRIPTS[state]);
  const driver = path.join(r.root, 'ptyhup.py');
  fs.writeFileSync(driver, PTY_DRIVER);
  const endFile = path.join(r.root, 'ended.txt');
  const errFile = path.join(r.root, 'kc-stderr.txt');
  sessionEndHook(r, `cat >> '${endFile}'; echo >> '${endFile}'`);
  const env = r.env({ TERM: 'xterm', PS1: 'BASH$ ' });
  if (!shell) env.PTYHUP_STDERR = errFile;
  const chatArgs = state === 'headless' ? ['chat', '--no-interactive', 'a question'] : ['chat'];
  const cmd = shell ? ['bash', '--norc', '--noprofile', '-i'] : [process.execPath, builtBin(), ...chatArgs];
  const py = spawn('python3', ['-I', driver, ...cmd], { cwd: r.ws, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let perr = '';
  py.stdout.on('data', (d: Buffer) => (out += d.toString()));
  py.stderr.on('data', (d: Buffer) => (perr += d.toString()));
  const exited = new Promise((res) => py.on('exit', res));
  const screen = (): string => out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const waitFor = async (fn: () => boolean, what: string, ms = 20_000): Promise<void> => {
    const t0 = Date.now();
    while (!fn()) {
      if (Date.now() - t0 > ms) {
        py.kill('SIGKILL');
        throw new Error(`timeout: ${what}\n--- screen:\n${screen()}\n--- driver:\n${perr}`);
      }
      await sleep(25);
    }
  };
  let pid: number | undefined;
  try {
    if (shell) {
      await waitFor(() => /BASH\$ $/.test(screen()), 'bash prompt');
      py.stdin.write(`${process.execPath} ${builtBin()} ${chatArgs.map((a) => `'${a}'`).join(' ')} 2>>'${errFile}'\r`);
    }
    if (state === 'headless') {
      await waitFor(() => /partial/.test(screen()) && r.locks().length === 1, 'headless answer streaming');
    } else {
      await waitFor(() => /> $/.test(screen()), 'chat prompt');
      py.stdin.write('hello\r');
      await waitFor(() => /ANSWER-ONE[\s\S]*> $/.test(screen()), 'first answer');
    }
    pid = (JSON.parse(fs.readFileSync(path.join(r.sessions, r.locks()[0]!), 'utf8')) as { pid: number }).pid;
    if (state === 'stream') {
      py.stdin.write('again\r');
      await waitFor(() => /partial/.test(screen()), 'streaming');
    } else if (state === 'approval') {
      py.stdin.write('make it\r');
      await waitFor(() => /\[y\/n\/t\]/i.test(screen().split('ANSWER-ONE').pop() ?? ''), 'approval prompt');
    }
    await sleep(300);
    py.kill('SIGUSR1'); // the terminal window closes
    await exited;
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
    r.cleanup();
  }
}

function check(o: Outcome, shell: boolean): void {
  assert.doesNotMatch(o.stderr, /Unhandled 'error'|EIO|throw e/, `kiro-claude crashed:\n${o.stderr.slice(0, 1500)}`);
  assert.deepEqual(o.locks, [], 'the session lock was left behind');
  assert.equal(o.ended, 1, 'the SessionEnd hook did not run (once)');
  // as the session leader its own status is observable: it dies of SIGHUP (not exit 1)
  if (!shell) assert.equal(o.status, 'signal 1');
}

const skip = HAVE_PTY ? false : 'needs Linux, python3 (pty) and bash';

for (const shell of [false, true]) {
  for (const state of ['idle', 'stream', 'approval', 'headless'] as const) {
    const where = shell ? 'started from an interactive bash (the tab closes: two SIGHUPs)' : 'as the pty session leader';
    const what = state === 'headless' ? 'chat --no-interactive (answer streaming)' : `chat (${state})`;
    test(`r5f #1: the terminal closes, kiro-claude ${what} ${where}: SessionEnd runs, no lock, no crash`, { skip, timeout: 60_000 }, async () => {
      check(await hangup(shell, state), shell);
    });
  }
}

/**
 * Round-8 verification of the "signals-docs" fix #6 over a real pty (the built CLI over
 * test/fixtures/fake-claude.mjs, temp dirs; a python3 driver runs the chat on a fresh pty as its
 * session leader, relays our pipe to it and back, and reports the chat's status): where the
 * interactive chat's terminal is NOT in raw mode, a Ctrl+C key after a SIGTERM is the terminal's
 * SIGINT, which reaches kiro-claude too, and so a second signal: it dies of the SIGTERM at once.
 *  - While a `!cmd` runs: the line reader is suspended and the child, in kiro-claude's process
 *    group, has the terminal in cooked mode. The `!cmd` gets the SIGINT too.
 *  - While the chat is still starting (its SessionStart hook runs): no line reader yet.
 * (At the prompt and while the chat answers, the Ctrl+C key is a key the muted reader drops:
 * r8f-signals-pty.test.ts.) The docs say so: r8f-signals-docs-verify.test.ts.
 * Also: during a turn a `kill -INT` after a SIGTERM reaches the REPL's own handler, which then
 * interrupts the turn being closed (no read is active), and still writes nothing.
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
import os, pty, sys, select
argv = sys.argv[1:]
pid, master = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)
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

const HAVE_PTY = process.platform === 'linux' && spawnSync('python3', ['-I', '-c', 'import pty'], { stdio: 'ignore' }).status === 0;
const skip = HAVE_PTY ? false : 'needs Linux and python3 (pty)';

interface Pty {
  raw: () => string;
  screen: () => string;
  write: (s: string) => void;
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

function killQuietly(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(pid, 'SIGKILL'); // only a process this test started, should it hang
  } catch {
    // gone
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitPidFile(file: string, p: Pty, what: string): Promise<void> {
  return p.waitFor(() => fs.existsSync(file) && /^\d+\s*$/.test(fs.readFileSync(file, 'utf8')), what);
}

function root(): { r: Root; done: string } {
  const r = mkRoot({ turns: [{ repeat: true, steps: [{ text: 'ANSWER to {{userText}}' }] }] });
  removeOnExit(r.root);
  const done = path.join(r.root, 'end.done');
  sessionEndHook(r, `cat > /dev/null; sleep 1.5; touch '${done}'`);
  return { r, done };
}

test('r8f verify (pty): while a `!cmd` runs (cooked terminal), a Ctrl+C key after a SIGTERM is the terminal\'s SIGINT: kiro-claude dies of the SIGTERM at once, the `!cmd` stops', { skip, timeout: 60_000 }, async () => {
  const { r, done } = root();
  const bangPid = path.join(r.root, 'bang.pid');
  const p = startPty(r, [process.execPath, builtBin(), 'chat'], r.env({ TERM: 'xterm' }));
  let pid: number | undefined;
  let bang: number | undefined;
  try {
    await p.waitFor(() => /> $/.test(p.screen()), 'chat prompt');
    p.write('hello\r');
    await p.waitFor(() => /ANSWER to hello[\s\S]*> $/.test(p.screen()), 'first answer');
    pid = (JSON.parse(fs.readFileSync(path.join(r.sessions, r.locks()[0]!), 'utf8')) as { pid: number }).pid;
    p.write(`!echo $$ > '${bangPid}'; exec sleep 30\r`);
    await waitPidFile(bangPid, p, 'the !cmd runs');
    bang = Number(fs.readFileSync(bangPid, 'utf8').trim());
    await sleep(200);
    const t0 = Date.now();
    process.kill(pid, 'SIGTERM');
    await sleep(200);
    p.write('\x03'); // the Ctrl+C key: in cooked mode the terminal sends SIGINT to the foreground group
    await p.exited;
    const ms = Date.now() - t0;
    const info = `status ${p.status()} after ${ms} ms; hook done ${fs.existsSync(done)}`;
    assert.equal(p.status(), 'signal 15', info);
    // at once at the SIGINT: not after the 1.5 s SessionEnd hook, nor at the 2 s grace
    assert.ok(!fs.existsSync(done), `the close ran to its end: the Ctrl+C was no signal to kiro-claude\n${info}`);
    assert.ok(ms < 1400, info);
    await p.waitFor(() => !alive(bang!), 'the !cmd ended by the SIGINT', 5_000);
  } finally {
    p.kill();
    killQuietly(pid);
    killQuietly(bang);
  }
});

test('r8f verify (pty): during a turn, a SIGTERM then a `kill -INT` (the REPL\'s own handler interrupts the turn being closed) ends it at once; nothing is written after the SIGTERM', { skip, timeout: 60_000 }, async () => {
  const r = mkRoot({ turns: [{ repeat: true, match: 'slow', steps: [{ text: 'WORKING ' }, { sleepMs: 60_000 }] }, { repeat: true, steps: [{ text: 'ANSWER to {{userText}}' }] }] });
  removeOnExit(r.root);
  const done = path.join(r.root, 'end.done');
  sessionEndHook(r, `cat > /dev/null; sleep 1.5; touch '${done}'`);
  const p = startPty(r, [process.execPath, builtBin(), 'chat'], r.env({ TERM: 'xterm' }));
  let pid: number | undefined;
  try {
    await p.waitFor(() => /> $/.test(p.screen()), 'chat prompt');
    p.write('run the slow one\r');
    await p.waitFor(() => /WORKING/.test(p.screen()), 'the turn streams');
    pid = (JSON.parse(fs.readFileSync(path.join(r.sessions, r.locks()[0]!), 'utf8')) as { pid: number }).pid;
    await sleep(300);
    const at = p.raw().length;
    const t0 = Date.now();
    process.kill(pid, 'SIGTERM');
    await sleep(200);
    process.kill(pid, 'SIGINT');
    await p.exited;
    const ms = Date.now() - t0;
    const after = p.raw().slice(at);
    assert.equal(p.status(), 'signal 15', `after ${ms} ms`);
    assert.ok(!fs.existsSync(done), 'the SIGINT did not cut the close short');
    assert.ok(ms < 1400, `died ${ms} ms after the SIGTERM`);
    assert.equal(after, '', `written after the signal: ${JSON.stringify(after)}`);
  } finally {
    p.kill();
    killQuietly(pid);
  }
});

test('r8f verify (pty): while the chat is still starting (its SessionStart hook runs), a Ctrl+C key is a SIGINT to kiro-claude: it dies of SIGINT, the start cancelled', { skip, timeout: 60_000 }, async () => {
  const { r } = root();
  const hookPid = path.join(r.root, 'start.pid');
  // the start hook records kiro-claude's pid (its parent) and takes long; the start signal kills it
  fs.writeFileSync(
    path.join(r.ws, '.kiro', 'hooks', 'spawn.json'),
    JSON.stringify({ version: 'v1', hooks: [{ name: 'spawn', trigger: 'SessionStart', timeout: 0, action: { type: 'command', command: `echo $PPID > '${hookPid}'; sleep 20` } }] }),
  );
  const p = startPty(r, [process.execPath, builtBin(), 'chat'], r.env({ TERM: 'xterm' }));
  let pid: number | undefined;
  try {
    await waitPidFile(hookPid, p, 'the SessionStart hook runs');
    pid = Number(fs.readFileSync(hookPid, 'utf8').trim());
    assert.match(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'), /kiro-claude/, 'the hook\'s parent is not kiro-claude');
    await sleep(200);
    // a key the chat would take (a raw-mode reader) could not end it: it dies of the SIGINT the
    // terminal makes of it (so after a SIGHUP / SIGTERM such a Ctrl+C is a second signal)
    p.write('\x03');
    await p.exited;
    assert.equal(p.status(), 'signal 2');
    assert.deepEqual(r.locks(), []);
  } finally {
    p.kill();
    killQuietly(pid);
  }
});

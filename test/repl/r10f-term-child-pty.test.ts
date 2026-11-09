/**
 * Round-10 fix "terminal-a" #0 in a real terminal: a python3 pty driver running an interactive bash
 * (job control), the built CLI over test/fixtures/fake-claude.mjs, temp dirs only.
 *
 * A child program the chat hands the terminal to (`/editor` with vim, `!vim`, a `!cmd`) runs in
 * kiro-claude's process group. Ctrl+Z there stops the whole job; `kill %1` then sends SIGTERM and
 * SIGCONT to the group. A child that changes the terminal mode on SIGTERM (vim's deadly-signal
 * path, a trap running `stty`) does so from the background, and the kernel answers with SIGTTOU to
 * the whole group: kiro-claude stopped again ('Stopped (tty output)') before or during its SIGTERM
 * close, with its lock held and no SessionEnd until `fg` (and, the 2 s grace run out meanwhile,
 * the close cut short). Now, while a child owns the terminal, kiro-claude catches SIGTTOU: after a
 * fatal signal the stop is dropped and the close runs (exit 143, lock released, SessionEnd ran,
 * nothing printed after the signal); otherwise it stops as before, so Ctrl+Z, `bg`, `fg` and :wq
 * still work. A child that leaves the terminal alone (the control) closed correctly before too.
 *
 * The SIGTTOU listener exists only while the child owns the terminal (checked in /proc SigCgt):
 * a caught SIGTTOU would make kiro-claude's own terminal mode changes from the background spin
 * forever (r10f-term-guard.test.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { builtBin } from '../cli/helpers.js';
import { mkRoot, sleep, type Root } from '../headless/r5f-signals-helpers.js';
import { removeOnExit } from '../tmpdirs.js';
import { stoppedJobState } from './r11f-ta-pty-helpers.js';

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
const HAVE_VIM = spawnSync('sh', ['-c', 'command -v vim'], { stdio: 'ignore' }).status === 0;
const skipVim = skip || (HAVE_VIM ? false : 'needs vim');

const VIM = 'vim -u NONE -N -n -i NONE';
const SCRIPT = { turns: [{ repeat: true, steps: [{ text: 'ANSWER to {{userText}}' }] }] };

/** `!cmd` children: a SIGTERM trap that leaves the terminal alone, one that runs `stty`, one that ignores SIGTERM. */
const LOOP = 'while :; do sleep 0.1; done';
const PLAIN = `!sh -c 'trap "exit 1" TERM; ${LOOP}'`;
const STTY = `!sh -c 'trap "stty sane; exit 1" TERM; ${LOOP}'`;
const IGNORES = `!sh -c 'trap "" TERM; ${LOOP}'`;

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

function cmdline(pid: number): string {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
  } catch {
    return '';
  }
}

/** The chat's children other than Claude Code (the fake): the child program and its shell. */
function terminalChildren(pid: number): number[] {
  try {
    return fs
      .readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number)
      .filter((k) => !cmdline(k).includes('fake-claude'));
  } catch {
    return [];
  }
}

/** Whether `pid` catches SIGTTOU (/proc/<pid>/status SigCgt, bit 22 - 1). */
function catchesSigttou(pid: number): boolean {
  const m = /^SigCgt:\s*([0-9a-f]+)$/m.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
  assert.ok(m, 'no SigCgt');
  return (BigInt(`0x${m[1]}`) & (1n << 21n)) !== 0n;
}

/** A SessionEnd hook (workspace hooks file) appending each closed session's payload to `file`. */
function sessionEndHook(r: Root, file: string, before = ''): void {
  const dir = path.join(r.ws, '.kiro', 'hooks');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'end.json'),
    JSON.stringify({ version: 'v1', hooks: [{ name: 'end', trigger: 'SessionEnd', timeout: 0, action: { type: 'command', command: `${before}cat >> '${file}'; echo >> '${file}'` } }] }),
  );
}

interface Term {
  write(s: string): void;
  /** The screen so far, CSI sequences removed. */
  screen(): string;
  waitFor(re: RegExp, what: string, from?: number, ms?: number): Promise<void>;
  chatPid(): number;
  /** Close the terminal (the driver closes the pty master: a hangup) and wait for the driver. */
  hangup(): Promise<void>;
  dispose(): Promise<void>;
}

function underBash(r: Root, extraEnv: Record<string, string> = {}): Term {
  const driver = path.join(r.root, 'pty.py');
  fs.writeFileSync(driver, PTY_DRIVER);
  const env = r.env({ TERM: 'xterm', PS1: 'BASH$ ', EDITOR: VIM, ...extraEnv });
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
  const ours = (p: number): boolean => cmdline(p).includes(builtBin());
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
    async hangup() {
      if (!done) py.kill('SIGTERM');
      await Promise.race([exited, sleep(8000)]);
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

async function startChat(t: Term, cmd = 'chat'): Promise<number> {
  await t.waitFor(/BASH\$ $/, 'bash prompt');
  t.write(`'${process.execPath}' '${builtBin()}' ${cmd}\r`);
  await t.waitFor(/chat[^\n]*\r?\n[\s\S]*> $/, 'chat prompt');
  return t.chatPid();
}

/** Kill only the processes the chat started (its child programs), should they outlive it. */
function killLeft(pids: number[], what: RegExp): void {
  for (const p of pids) {
    if (!what.test(cmdline(p))) continue;
    try {
      process.kill(p, 'SIGCONT');
      process.kill(p, 'SIGKILL');
    } catch {
      // gone
    }
  }
}

/** Start the child `command` and wait until it runs (vim: its screen, typed into). */
async function runChild(t: Term, pid: number, command: string, vim: boolean): Promise<number[]> {
  t.write(`${command}\r`);
  await waitUntil(() => terminalChildren(pid).length > 0, 'the child runs');
  if (vim) {
    await sleep(1500);
    t.write('ihello\x1b');
    await sleep(400);
  } else await sleep(400);
  return terminalChildren(pid);
}

/**
 * The chat answers once, runs `command` (a child that gets the terminal), Ctrl+Z stops the job,
 * `kill %1`: the chat is gone within the grace, exit status 143, its lock released and its
 * SessionEnd hook run, nothing printed after the signal. Returns the child's pids (still there).
 */
async function killStoppedChild(command: string, opts: { vim?: boolean; cmd?: string; endBefore?: string } = {}): Promise<{ kids: number[]; r: Root; t: Term; ended: string; diedAfterMs: number }> {
  const r = mkRoot(SCRIPT);
  removeOnExit(r.root);
  const ended = path.join(r.root, 'ended.jsonl');
  sessionEndHook(r, ended, opts.endBefore);
  const t = underBash(r);
  let kids: number[] = [];
  try {
    const pid = await startChat(t, opts.cmd);
    let mark = t.screen().length;
    t.write('hello\r');
    await t.waitFor(/ANSWER to hello[\s\S]*> $/, 'the answer', mark);
    assert.equal(catchesSigttou(pid), false, 'SIGTTOU is caught at the prompt (the reader is active)');
    kids = await runChild(t, pid, command, opts.vim === true);
    mark = t.screen().length;
    t.write('\x1a');
    await t.waitFor(/Stopped[\s\S]*BASH\$ $/, 'bash reports the job stopped', mark);
    mark = t.screen().length;
    const t0 = Date.now();
    t.write('kill %1\r');
    await waitUntil(() => procState(pid) === 'gone', `the chat ends after \`kill %1\` (state ${procState(pid)})`, 10_000);
    const diedAfterMs = Date.now() - t0;
    // bash knows the job's status once it has reaped it (see r9f-stop-input-pty)
    t.write('wait %1; echo "EXIT=$?"\r');
    await t.waitFor(/EXIT=\d+/, 'the job status', mark, 10_000);
    assert.match(t.screen().slice(mark), /EXIT=143/, t.screen().slice(mark));
    await sleep(300);
    const after = t.screen().slice(mark).replace(/BASH\$ /g, '');
    assert.doesNotMatch(after, /> |Error opening editor|Self exited|To resume/, `printed after the signal:\n${JSON.stringify(after)}`);
    return { kids, r, t, ended, diedAfterMs };
  } catch (e) {
    // nothing of this run is left behind (the chat, stopped, and its child)
    killLeft(kids, /trap|sleep|stty|vim/);
    await t.dispose();
    throw e;
  }
}

async function closedCleanly(r: Root, ended: string): Promise<void> {
  assert.deepEqual(r.locks(), [], 'the session lock is left');
  await waitUntil(() => fs.existsSync(ended) && fs.readFileSync(ended, 'utf8').trim() !== '', 'the SessionEnd hook ran', 5000);
}

test('r10f #0 control: Ctrl+Z in a `!cmd` that leaves the terminal alone, then `kill %1`: the chat closes and dies of SIGTERM', { skip, timeout: 120_000 }, async () => {
  const { kids, r, t, ended } = await killStoppedChild(PLAIN);
  try {
    await closedCleanly(r, ended);
  } finally {
    killLeft(kids, /trap|sleep/);
    await t.dispose();
  }
});

test("r10f #0: Ctrl+Z in a `!cmd` whose SIGTERM trap runs `stty`, then `kill %1`: the chat closes and dies of SIGTERM (no fg)", { skip, timeout: 120_000 }, async () => {
  const { kids, r, t, ended } = await killStoppedChild(STTY);
  try {
    await closedCleanly(r, ended);
  } finally {
    killLeft(kids, /trap|sleep|stty/);
    await t.dispose();
  }
});

test('r10f #0: Ctrl+Z inside /editor (vim), then `kill %1`: the chat closes and dies of SIGTERM (no fg)', { skip: skipVim, timeout: 120_000 }, async () => {
  const { kids, r, t, ended } = await killStoppedChild('/editor', { vim: true });
  try {
    await closedCleanly(r, ended);
  } finally {
    killLeft(kids, /vim/);
    await t.dispose();
  }
});

test('r10f #0: Ctrl+Z inside `!vim`, then `kill %1`: the chat closes and dies of SIGTERM (no fg)', { skip: skipVim, timeout: 120_000 }, async () => {
  const { kids, r, t, ended } = await killStoppedChild(`!${VIM} x.txt`, { vim: true });
  try {
    await closedCleanly(r, ended);
  } finally {
    killLeft(kids, /vim/);
    await t.dispose();
  }
});

test('r10f #0: `kiro-claude chat | tee log`: Ctrl+Z in a `!cmd` whose trap runs `stty`, then `kill %1`: the chat closes and dies of SIGTERM', { skip, timeout: 120_000 }, async () => {
  const { kids, r, t, ended } = await killStoppedChild(STTY, { cmd: 'chat | tee chat.log' });
  try {
    await closedCleanly(r, ended);
  } finally {
    killLeft(kids, /trap|sleep|stty/);
    await t.dispose();
  }
});

test('r10f #0: a slow SessionEnd hook: Ctrl+Z in the `stty` `!cmd`, `kill %1`: the 2 s grace still bounds the close', { skip, timeout: 120_000 }, async () => {
  const { kids, t, diedAfterMs } = await killStoppedChild(STTY, { endBefore: 'sleep 20; ' });
  try {
    assert.ok(diedAfterMs < 6000, `the chat ended ${diedAfterMs} ms after kill %1`);
  } finally {
    killLeft(kids, /trap|sleep|stty/);
    await t.dispose();
  }
});

test('r10f #0: a `!cmd` that ignores SIGTERM: Ctrl+Z, `kill %1`: the chat closes and dies; the child goes on (as a member of any killed job)', { skip, timeout: 120_000 }, async () => {
  const { kids, r, t, ended } = await killStoppedChild(IGNORES);
  try {
    await closedCleanly(r, ended);
    const sh = kids.find((k) => /trap/.test(cmdline(k)));
    assert.ok(sh !== undefined, `no child shell among ${JSON.stringify(kids.map(cmdline))}`);
    assert.ok(!['gone', 'T', 'Z'].includes(procState(sh)), `the child is ${procState(sh)}`);
  } finally {
    killLeft(kids, /trap|sleep/);
    await t.dispose();
  }
});

test('r10f #0: Ctrl+Z inside /editor (vim), `bg` (vim redraws: the job stops again), `fg`, :wq: the edit is sent and the chat reads again', { skip: skipVim, timeout: 120_000 }, async () => {
  const r = mkRoot(SCRIPT);
  removeOnExit(r.root);
  const t = underBash(r);
  try {
    const pid = await startChat(t);
    await runChild(t, pid, '/editor', true);
    let mark = t.screen().length;
    t.write('\x1a');
    await t.waitFor(/Stopped[\s\S]*BASH\$ $/, 'bash reports the job stopped', mark);
    mark = t.screen().length;
    t.write('bg\r');
    // vim takes the terminal back in the background: SIGTTOU stops the job again, as before
    await sleep(300);
    await waitUntil(() => procState(pid) === 'T', `the chat runs on in the background while vim is stopped (state ${procState(pid)})`, 10_000);
    // (bash may not count the job stopped yet, and reports a change only at its next prompt:
    // `jobs -l` is asked until it does, r12g T1)
    assert.match(await stoppedJobState(t), /^Stopped/, 'bash reports the job stopped again');
    mark = t.screen().length;
    t.write('fg\r');
    await sleep(1500);
    t.write('A world\x1b:wq\r');
    await t.waitFor(/ANSWER to [^\n]*hello[^\n]*\r?\n[\s\S]*> $/, 'the edit is sent', mark, 20_000);
    await sleep(200);
    assert.equal(catchesSigttou(pid), false, 'SIGTTOU is still caught after the child');
    mark = t.screen().length;
    t.write('again\r');
    await t.waitFor(/ANSWER to again[\s\S]*> $/, 'the chat reads again', mark, 15_000);
  } finally {
    await t.dispose();
  }
});

test('r10f #0: SIGTTOU is caught only while the child owns the terminal: not at the prompt, not after the child (`!cat`, Ctrl+C in `!sleep`)', { skip, timeout: 120_000 }, async () => {
  const r = mkRoot(SCRIPT);
  removeOnExit(r.root);
  const t = underBash(r);
  const got = path.join(r.ws, 'got.txt');
  try {
    const pid = await startChat(t);
    assert.equal(catchesSigttou(pid), false);
    let mark = t.screen().length;
    t.write('!cat > got.txt\r');
    await waitUntil(() => fs.existsSync(got), 'cat runs', 10_000);
    await sleep(200);
    assert.equal(catchesSigttou(pid), true);
    t.write('typed for cat\r');
    await sleep(200);
    t.write('\x04');
    await t.waitFor(/> $/, 'the chat prompt after cat', mark, 10_000);
    await sleep(200);
    assert.equal(fs.readFileSync(got, 'utf8'), 'typed for cat\n');
    assert.equal(catchesSigttou(pid), false, 'after the child ended');
    mark = t.screen().length;
    t.write('!sleep 30\r');
    await waitUntil(() => terminalChildren(pid).length > 0, 'sleep runs');
    await sleep(300);
    assert.equal(catchesSigttou(pid), true);
    t.write('\x03');
    await t.waitFor(/> $/, 'the chat prompt after Ctrl+C', mark, 10_000);
    await sleep(200);
    assert.equal(catchesSigttou(pid), false, 'after a Ctrl+C ended the child');
    mark = t.screen().length;
    t.write('next\r');
    await t.waitFor(/ANSWER to next[\s\S]*> $/, 'the chat reads again', mark, 15_000);
  } finally {
    await t.dispose();
  }
});

test('r10f #0: the terminal closes while the chat is stopped inside vim: the chat closes (lock released, SessionEnd ran)', { skip: skipVim, timeout: 120_000 }, async () => {
  const r = mkRoot(SCRIPT);
  removeOnExit(r.root);
  const ended = path.join(r.root, 'ended.jsonl');
  sessionEndHook(r, ended);
  const t = underBash(r);
  let kids: number[] = [];
  try {
    const pid = await startChat(t);
    const mark = t.screen().length;
    t.write('hello\r');
    await t.waitFor(/ANSWER to hello[\s\S]*> $/, 'the answer', mark);
    kids = await runChild(t, pid, '/editor', true);
    const m2 = t.screen().length;
    t.write('\x1a');
    await t.waitFor(/Stopped[\s\S]*BASH\$ $/, 'bash reports the job stopped', m2);
    await t.hangup();
    await waitUntil(() => procState(pid) === 'gone', `the chat ends after the hangup (state ${procState(pid)})`, 10_000);
    await closedCleanly(r, ended);
  } finally {
    killLeft(kids, /vim/);
    await t.dispose();
  }
});

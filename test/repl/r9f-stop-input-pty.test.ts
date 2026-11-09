/**
 * Round-9 fix "stop-input" in a real terminal: a python3 pty driver running an interactive bash
 * (job control), the built CLI over test/fixtures/fake-claude.mjs, temp dirs only.
 *
 *  - #0: `kill -STOP` of the chat from elsewhere while a blocking preToolUse hook runs, then
 *    `kill -CONT` while bash holds the terminal. The reader's SIGCONT listener set raw mode from
 *    the background: SIGTTOU stopped the chat again inside the SIGCONT dispatch, the stop clock
 *    credited only one of the two stops, and the hook that exited 2 during the second stop was
 *    killed as "timed out" (never a block): the trusted Read ran and printed the secret. Now the
 *    chat runs on in the background, off the terminal, the hook blocks, and `fg` brings the
 *    prompt back. Control: `kill -STOP`, then `fg`.
 *  - #1: Ctrl+Z at the prompt, then `kill %1` (bash: SIGTERM, then SIGCONT): retake() set raw mode
 *    from the background right after the stop returned, SIGTTOU stopped the chat again before its
 *    SIGTERM listener ran ('Stopped (tty output)', lock held, no SessionEnd) until `fg`, which then
 *    drew '> ' before it died. Now it closes and dies of SIGTERM (143) at once, printing nothing.
 *    The same for `kill -STOP`, then `kill -TERM` and `kill -CONT` from elsewhere.
 *  - the background (the documented gap changes): after Ctrl+Z and `bg` the chat stays off the
 *    terminal (before, it set raw mode from there and SIGTTOU stopped it inside that ioctl), and
 *    `fg` takes it back. Since r11 #2 it stops again by itself there once it needs the terminal,
 *    like a background job that reads it ('Stopped (tty input)'; between r9 and r11 it ran on, and
 *    under `sudo` that never came up after `fg`), so `fg` continues it with a SIGCONT.
 *  - #8: while `!cat` owns the terminal bracketed paste is off; at the next prompt on again.
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

const SECRET_READ = { name: 'Read', input: { file_path: '{{cwd}}/secret.env' }, result: 'SECRET=hunter2' };
const SCRIPT = {
  turns: [
    { repeat: true, match: '^read secret', steps: [{ tool: SECRET_READ }, { text: 'DONE {{lastToolResult}}' }] },
    { repeat: true, steps: [{ text: 'ANSWER to {{userText}}' }] },
  ],
};

const HOOK_TIMEOUT_MS = 1500;
/** From the hook's start: kill -STOP; kill -CONT (after the timeout); the hook exits 2; fg. */
const STOP_AT = 200;
const CONT_AT = 2400;
const HOOK_EXITS_AT = 3000;
const FG_AT = 4200;

/** A root whose guard agent's preToolUse hook blocks reads of secret.env (exit 2) after 3 s. */
function guardRoot(): { r: Root; hookLog: () => string } {
  const r = mkRoot(SCRIPT);
  removeOnExit(r.root);
  const log = path.join(r.root, 'hook.log');
  fs.writeFileSync(path.join(r.ws, 'secret.env'), 'SECRET=hunter2\n');
  const agents = path.join(r.home, '.kiro', 'agents');
  fs.mkdirSync(agents, { recursive: true });
  const cmd = `p=$(cat); case "$p" in *secret.env*) echo start >> '${log}'; sleep ${HOOK_EXITS_AT / 1000}; echo block >> '${log}'; echo NO-SECRETS >&2; exit 2;; esac; exit 0`;
  fs.writeFileSync(
    path.join(agents, 'guard.json'),
    JSON.stringify({ name: 'guard', description: 'guards secret.env', tools: ['*'], hooks: { preToolUse: [{ matcher: '*', command: cmd, timeout_ms: HOOK_TIMEOUT_MS }] } }),
  );
  return { r, hookLog: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '') };
}

/** A SessionEnd hook (workspace hooks file) appending each closed session's payload to `file`. */
function sessionEndHook(r: Root, file: string): void {
  const dir = path.join(r.ws, '.kiro', 'hooks');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'end.json'), JSON.stringify({ version: 'v1', hooks: [{ name: 'end', trigger: 'SessionEnd', timeout: 0, action: { type: 'command', command: `cat >> '${file}'; echo >> '${file}'` } }] }));
}

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
  /** The screen so far, CSI sequences removed. */
  screen(): string;
  /** Everything written to the terminal so far. */
  raw(): string;
  waitFor(re: RegExp, what: string, from?: number, ms?: number): Promise<void>;
  chatPid(): number;
  dispose(): Promise<void>;
}

function underBash(r: Root): Term {
  const driver = path.join(r.root, 'pty.py');
  fs.writeFileSync(driver, PTY_DRIVER);
  const env = r.env({ TERM: 'xterm', PS1: 'BASH$ ' });
  const py = spawn('python3', ['-I', driver, BASH, '--norc', '--noprofile', '-i'], { cwd: r.ws, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let done = false;
  py.stdout.on('data', (d: Buffer) => (out += d.toString()));
  py.stderr.on('data', () => undefined);
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
    write: (s) => py.stdin.write(s),
    screen,
    raw: () => out,
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

async function startChat(t: Term, args = ''): Promise<number> {
  await t.waitFor(/BASH\$ $/, 'bash prompt');
  t.write(`'${process.execPath}' '${builtBin()}' chat${args}\r`);
  await t.waitFor(/chat[^\n]*\r?\n[\s\S]*> $/, 'chat prompt');
  return t.chatPid();
}

/** The guard scenario: the hook runs, kill -STOP; with `contInBackground` kill -CONT; then fg. */
async function guardScenario(contInBackground: boolean): Promise<{ s: string; stateAfterCont: string | undefined }> {
  const { r, hookLog } = guardRoot();
  const t = underBash(r);
  try {
    const pid = await startChat(t, ' --agent guard');
    const mark = t.screen().length;
    t.write('read secret\r');
    await waitUntil(() => /start/.test(hookLog()), 'the guard hook starts', 20_000);
    const t0 = Date.now();
    await sleep(STOP_AT);
    const stopMark = t.screen().length;
    process.kill(pid, 'SIGSTOP'); // kill -STOP from elsewhere
    await t.waitFor(/Stopped[\s\S]*BASH\$ $/, 'bash reports the job stopped', stopMark, 5000);
    let stateAfterCont: string | undefined;
    if (contInBackground) {
      await sleep(CONT_AT - (Date.now() - t0));
      process.kill(pid, 'SIGCONT'); // kill -CONT from elsewhere: a background job while bash holds the terminal
      await sleep(300);
      stateAfterCont = procState(pid);
    }
    await sleep(FG_AT - (Date.now() - t0));
    assert.match(hookLog(), /block/, 'precondition: the hook exited 2 before fg');
    t.write('fg\r');
    await t.waitFor(/DONE [^\n]*[\s\S]*> $/, 'the turn ends and the prompt is back', mark, 20_000);
    // the chat reads again
    const m2 = t.screen().length;
    t.write('again\r');
    await t.waitFor(/ANSWER to again[\s\S]*> $/, 'the next answer', m2, 15_000);
    return { s: t.screen().slice(mark), stateAfterCont };
  } finally {
    await t.dispose();
  }
}

test('r9f #0: kill -STOP, then kill -CONT while bash holds the terminal, then fg: the chat runs on in the background, the hook still blocks', { skip, timeout: 120_000 }, async () => {
  const { s, stateAfterCont } = await guardScenario(true);
  assert.notEqual(stateAfterCont, 'T', 'the chat stopped again in the background (it touched the terminal: SIGTTOU)');
  assert.doesNotMatch(s, /timed out after/, `the hook that exited 2 counted as timed out:\n${s}`);
  assert.doesNotMatch(s, /hunter2/, `the guarded, trusted Read ran:\n${s}`);
  assert.match(s, /NO-SECRETS/);
});

test('r9f #0 control: kill -STOP, then fg: the hook still blocks', { skip, timeout: 120_000 }, async () => {
  const { s } = await guardScenario(false);
  assert.doesNotMatch(s, /timed out after|hunter2/, s);
  assert.match(s, /NO-SECRETS/);
});

/** A chat stopped (Ctrl+Z, or kill -STOP) at the prompt under bash, then killed. */
async function killStopped(how: 'ctrlz' | 'stop'): Promise<void> {
  const r = mkRoot(SCRIPT);
  removeOnExit(r.root);
  const ended = path.join(r.root, 'ended.jsonl');
  sessionEndHook(r, ended);
  const t = underBash(r);
  try {
    const pid = await startChat(t);
    let mark = t.screen().length;
    t.write('hello\r');
    await t.waitFor(/ANSWER to hello[\s\S]*> $/, 'the answer', mark);
    mark = t.screen().length;
    if (how === 'ctrlz') t.write('\x1a');
    else process.kill(pid, 'SIGSTOP');
    await t.waitFor(/Stopped[\s\S]*BASH\$ $/, 'bash reports the job stopped', mark);
    assert.equal(procState(pid), 'T');
    mark = t.screen().length;
    const t0 = Date.now();
    if (how === 'ctrlz') {
      // bash's kill of a stopped job: SIGTERM, then SIGCONT (no terminal handed over). Not
      // `kill %1; wait %1`: bash marks the job running only once the job's continue reaches it
      // (SIGCHLD), so an immediate `wait` can find it still stopped and return 148 (verification:
      // a third of the runs under load). The chat is gone from /proc once bash has reaped it, and
      // its job's status is then known to `wait`.
      t.write('kill %1\r');
      await waitUntil(() => procState(pid) === 'gone', 'the chat ends after `kill %1` (it stays stopped: SIGTTOU)', 10_000);
      t.write('wait %1; echo "EXIT=$?"\r');
      await t.waitFor(/EXIT=\d+/, 'the job status', mark, 10_000);
      assert.match(t.screen().slice(mark), /EXIT=143/, t.screen().slice(mark));
    } else {
      process.kill(pid, 'SIGTERM');
      process.kill(pid, 'SIGCONT');
      await waitUntil(() => procState(pid) === 'gone', `the chat ends (state ${procState(pid)})`, 10_000);
    }
    // README: the close gets at most 2 s
    assert.ok(Date.now() - t0 < 6000, `the chat ended after ${Date.now() - t0} ms`);
    assert.deepEqual(r.locks(), [], 'the session lock is left');
    await waitUntil(() => fs.existsSync(ended) && fs.readFileSync(ended, 'utf8').trim() !== '', 'the SessionEnd hook ran', 5000);
    await sleep(300);
    // after the signal nothing more is printed (no prompt drawn before it died)
    const after = t.screen().slice(mark);
    assert.doesNotMatch(after.replace(/BASH\$ /g, ''), /> /, `printed after the signal:\n${JSON.stringify(after)}`);
  } finally {
    await t.dispose();
  }
}

test('r9f #1: Ctrl+Z at the prompt, then `kill %1`: the chat closes (lock released, SessionEnd) and dies of SIGTERM at once, printing nothing', { skip, timeout: 90_000 }, async () => {
  await killStopped('ctrlz');
});

test('r9f #1: kill -STOP, then kill -TERM and kill -CONT from elsewhere: the chat closes and dies at once, printing nothing', { skip, timeout: 90_000 }, async () => {
  await killStopped('stop');
});

test('r9f: Ctrl+Z, then `bg`: the chat stays off the terminal (stopped again by itself, r11 #2); `fg` takes it back', { skip, timeout: 90_000 }, async () => {
  const r = mkRoot(SCRIPT);
  removeOnExit(r.root);
  const t = underBash(r);
  try {
    const pid = await startChat(t);
    let mark = t.screen().length;
    t.write('half');
    await t.waitFor(/half$/, 'the half-typed line', mark);
    t.write('\x1a');
    await t.waitFor(/Stopped[\s\S]*BASH\$ $/, 'bash reports the job stopped', mark);
    mark = t.screen().length;
    t.write('bg\r');
    await t.waitFor(/BASH\$ $/, 'bash prompt after bg', mark + 3);
    await sleep(800);
    // stopped again by itself (r11 #2: its own SIGTTIN, 'Stopped (tty input)'), never by a mode
    // change from the background (SIGTTOU, 'Stopped (tty output)')
    assert.equal(procState(pid), 'T', 'the chat did not stop again in the background once it needed the terminal');
    // nothing of the chat's own is drawn over the shell meanwhile; typing at bash works
    t.write('echo SHELL-OK; jobs -l\r');
    await t.waitFor(/SHELL-OK[\s\S]*\[1\][\s\S]*BASH\$ $/, 'bash runs a command', mark);
    assert.match(t.screen().slice(mark), /\[1\][+-]? +\d+ +Stopped \(tty input\)/, t.screen().slice(mark));
    assert.doesNotMatch(t.screen().slice(mark), /> half/, 'the chat drew its prompt in the background');
    mark = t.screen().length;
    t.write('fg\r');
    await t.waitFor(/> half$/, 'the prompt and the half-typed line are back', mark, 10_000);
    t.write(' line\r');
    await t.waitFor(/ANSWER to half line[\s\S]*> $/, 'the input is read again', mark, 15_000);
  } finally {
    await t.dispose();
  }
});

const lastBracketedPaste = (s: string): string | undefined => [...s.matchAll(/\u001b\[\?2004([hl])/g)].pop()?.[1];

test('r9f #8: while `!cat` owns the terminal bracketed paste is off; at the next prompt it is on again', { skip, timeout: 90_000 }, async () => {
  const r = mkRoot(SCRIPT);
  removeOnExit(r.root);
  const t = underBash(r);
  const got = path.join(r.ws, 'got.txt');
  try {
    await startChat(t);
    assert.equal(lastBracketedPaste(t.raw()), 'h', 'bracketed paste on at the chat prompt');
    const mark = t.screen().length;
    t.write('!cat > got.txt\r');
    await waitUntil(() => fs.existsSync(got), 'cat runs', 10_000);
    await sleep(300);
    assert.equal(lastBracketedPaste(t.raw()), 'l', 'the child runs on a terminal in bracketed-paste mode');
    t.write('typed for cat\r');
    await sleep(200);
    t.write('\x04');
    await t.waitFor(/> $/, 'the chat prompt after cat', mark, 10_000);
    await sleep(200);
    assert.equal(fs.readFileSync(got, 'utf8'), 'typed for cat\n');
    assert.equal(lastBracketedPaste(t.raw()), 'h', 'bracketed paste is not on again at the chat prompt');
  } finally {
    await t.dispose();
  }
});

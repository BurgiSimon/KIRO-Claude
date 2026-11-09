/**
 * Round-12 follow-up "terminal" T2: the foreground probe (input.ts probeForeground, r12 #2) in a
 * PID namespace with its own /proc and no job-control shell inside it, where the job's IDs read 0.
 *
 * A probe that finds kiro-claude in the background stops its job (the kernel's SIGTTOU to the
 * probe's group: bash says 'Stopped (tty output)'), so no probe may run after the continue of a
 * `kill %1` (SIGTERM, then SIGCONT) before its SIGTERM is handled, nor after a fatal signal is in:
 * it stops the job again, and the chat (or the `unshare` that waits for it) stays stopped until a
 * second `kill %1` or `kill -CONT`.
 *  - The probe's answer was reused per file descriptor: a write held while the chat starts
 *    (exitSignals.ts holdTerminalOutput asks about stdout, fd 1) right after the start's wait asked
 *    about stdin (fd 0), or the other way round, in the same event-loop turn, probed again. Now the
 *    answer is one per terminal, and a background answer stands until the signals that came with
 *    the continue were dispatched.
 *  - The REPL's hand-back after a `!cmd` probed before it looked at the fatal-signal state: Ctrl+Z
 *    in the `!cmd`, then `kill %1`, stopped `unshare` again while the chat closed, and the job stayed
 *    'Stopped (tty output)' after the chat had exited.
 *
 * As PID 2 under a plain `bash -c` in the namespace, started with `&` (or stopped with Ctrl+Z):
 * one `kill %1` ends it. Deterministic: states are polled (/proc, bash's `jobs -l`). Temp dirs only
 * (r11f-ta-pty-helpers, TMPDIR inside them). Skipped without Linux, python3, bash, stty, or a
 * permitted `unshare --fork --pid --mount-proc` (it needs CAP_SYS_ADMIN).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { builtBin } from '../cli/helpers.js';
import { chatCommand, procState, setup, skipPty, sleep, stoppedJobState, waitUntil, type Setup } from './r11f-ta-pty-helpers.js';

const UNSHARE = 'unshare --fork --pid --mount-proc';
const skip =
  skipPty ||
  (spawnSync('unshare', ['--fork', '--pid', '--mount-proc', 'true'], { stdio: 'ignore', timeout: 10_000 }).status === 0 ? false : 'unshare --fork --pid --mount-proc is not permitted') ||
  (spawnSync('stty', ['--version'], { stdio: 'ignore' }).status === 0 ? false : 'needs stty');

/** A setup whose processes keep their temp files in its root (the test may SIGKILL them). */
function nsSetup(opts: Parameters<typeof setup>[0] = {}): Setup {
  const s = setup(opts);
  const tmp = path.join(s.r.root, 'tmp');
  fs.mkdirSync(tmp);
  s.t.write(`export TMPDIR='${tmp}'\r`);
  return s;
}

/** The pid (as this test's /proc sees it) of the process whose argv[1] is `script`, under `root`. */
function outerPid(script: string, root: string): number | undefined {
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const argv = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0');
      if (argv[0] !== process.execPath || argv[1] !== script) continue;
      if (!fs.readlinkSync(`/proc/${d}/cwd`).startsWith(root)) continue;
      return Number(d);
    } catch {
      // gone
    }
  }
  return undefined;
}

const ppidOf = (pid: number): number => {
  const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  return Number(s.slice(s.lastIndexOf(')') + 2).split(' ')[1]);
};

/** SIGKILL what this test started, should it outlive the test (the namespace goes with its PID 1). */
function killAll(pids: (number | undefined)[]): void {
  for (const pid of pids) {
    if (pid === undefined) continue;
    try {
      process.kill(pid, 'SIGCONT');
      process.kill(pid, 'SIGKILL');
    } catch {
      // gone
    }
  }
}

/**
 * Asks what the chat asks while it starts in the background: the start's wait about stdin
 * (terminalInForeground), and a write held while it starts (holdTerminalOutput asking about
 * stdout), in the same event-loop turn, in the order given; SIGTERM handled as the chat's
 * ExitSignals does (exit 143). Its log: PID, the verdict, TURN once the turn is done, SIGTERM.
 */
const PROBES = `
import * as fs from 'node:fs';
const [, , inputJs, exitsJs, logFile, order] = process.argv;
const m = await import(inputJs);
const ex = await import(exitsJs);
const log = (s) => fs.appendFileSync(logFile, s + '\\n');
process.on('SIGTERM', () => {
  log('SIGTERM');
  process.exit(143);
});
log('PID=' + process.pid);
ex.holdTerminalOutput([process.stdout], (s) => !m.terminalInForeground(s));
setTimeout(() => {
  if (order !== 'write-first') log('FG=' + m.terminalInForeground(process.stdin));
  if (order !== 'probe-only') process.stdout.write('HELD\\n');
  if (order === 'write-first') log('FG=' + m.terminalInForeground(process.stdin));
  log('TURN');
}, 300);
setInterval(() => undefined, 1000);
`;

test('r12g T2: as PID 2 started with `&`, the start\'s wait about stdin and a write held about stdout in the same turn probe once: one `kill %1` ends it (both orders; a probe alone as the control)', { skip, timeout: 180_000 }, async () => {
  for (const order of ['probe-only', 'probe-then-write', 'write-first'] as const) {
    const s = nsSetup();
    let pid: number | undefined;
    let unshare: number | undefined;
    try {
      const dist = path.dirname(path.dirname(builtBin()));
      const script = path.join(s.r.root, 'probes.mjs');
      fs.writeFileSync(script, PROBES);
      const logFile = path.join(s.r.root, `probes-${order}.log`);
      const args = [path.join(dist, 'repl', 'input.js'), path.join(dist, 'repl', 'exitSignals.js'), logFile, order].map((a) => `'${a}'`).join(' ');
      await s.t.waitFor(/BASH\$ $/, 'bash prompt');
      s.t.write(`${UNSHARE} bash -c "'${process.execPath}' '${script}' ${args}; true" &\r`);
      await waitUntil(() => (pid = outerPid(script, s.r.root)) !== undefined, `${order}: the script runs`, 20_000);
      unshare = ppidOf(ppidOf(pid!));
      const log = (): string => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '');
      await waitUntil(() => /PID=2\n/.test(log()), `${order}: PID 2 in the namespace`);
      // the first probe found the background and stopped the job
      await waitUntil(() => procState(pid!) === 'T', `${order}: stopped by the probe (state ${procState(pid!)})`, 10_000);
      assert.equal(await stoppedJobState(s.t), 'Stopped (tty output)', order);
      s.t.write('kill %1\r');
      // one kill: the SIGTERM is handled before any further probe could stop the job again
      await waitUntil(() => procState(pid!) === 'gone', `${order}: still there after one \`kill %1\` (state ${procState(pid!)}, unshare ${procState(unshare!)}); log:\n${log()}`, 8000);
      assert.match(log(), /FG=false\n[\s\S]*TURN\n[\s\S]*SIGTERM\n/, `${order}: ${log()}`);
      await waitUntil(() => procState(unshare!) === 'gone', `${order}: unshare ends (state ${procState(unshare!)})`, 8000);
    } finally {
      killAll([pid, unshare]);
      await s.t.dispose();
    }
  }
});

test('r12g T2: as PID 2, Ctrl+Z inside a `!cmd`, then `kill %1`: the hand-back after the child does not probe after the signal; the job ends (unshare not left stopped), SessionEnd ran, the lock is released', { skip, timeout: 120_000 }, async () => {
  const s = nsSetup();
  let chat: number | undefined;
  let unshare: number | undefined;
  try {
    await s.t.waitFor(/BASH\$ $/, 'bash prompt');
    let mark = s.t.screen().length;
    s.t.write(`${UNSHARE} bash -c "${chatCommand().replace(/"/g, '\\"')}; true"\r`);
    await waitUntil(() => s.r.locks().length === 1, 'the session lock', 20_000);
    await waitUntil(() => (chat = outerPid(builtBin(), s.r.root)) !== undefined, 'the chat runs', 20_000);
    unshare = ppidOf(ppidOf(chat!));
    await s.t.waitFor(/Welcome to[\s\S]*> $/, 'the chat prompt', mark, 30_000);
    mark = s.t.screen().length;
    s.t.write("!printf 'CHILD-''RUNS\\n'; sleep 60\r");
    await s.t.waitFor(/CHILD-RUNS/, 'the child runs', mark);
    mark = s.t.screen().length;
    s.t.write('\x1a');
    await s.t.waitFor(/Stopped[\s\S]*BASH\$ $/, 'bash reports the job stopped', mark);
    await waitUntil(() => procState(chat!) === 'T', 'the chat is stopped', 5000);
    mark = s.t.screen().length;
    s.t.write('kill %1\r');
    await waitUntil(() => procState(chat!) === 'gone', `the chat ends (state ${procState(chat!)})`, 10_000);
    await waitUntil(() => procState(unshare!) === 'gone', `the job ends: unshare left in state ${procState(unshare!)} (stopped again by a probe after the signal)`, 8000);
    s.t.write('wait %1; echo "EXIT=$?"\r');
    await s.t.waitFor(/EXIT=\d+/, 'the job status', mark, 10_000);
    assert.deepEqual(s.r.locks(), [], 'the session lock is left');
    await waitUntil(() => fs.existsSync(s.ended) && fs.readFileSync(s.ended, 'utf8').trim() !== '', 'the SessionEnd hook ran', 5000);
  } finally {
    killAll([chat, unshare]);
    await s.t.dispose();
  }
});

test('r12g T2: as PID 2 started with `&` (plain, and with start output held: a failing agentSpawn hook\'s warning), one `kill %1` closes the chat (SessionEnd, lock released)', { skip, timeout: 180_000 }, async () => {
  for (const held of [false, true]) {
    const s = nsSetup({
      prepare: held
        ? (r) => {
            const dir = path.join(r.ws, '.kiro', 'hooks');
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'spawn.json'), JSON.stringify({ version: 'v1', hooks: [{ name: 'spawn', trigger: 'SessionStart', timeout: 30, action: { type: 'command', command: 'echo spawn-failed >&2; exit 1' } }] }));
          }
        : undefined,
    });
    let chat: number | undefined;
    let unshare: number | undefined;
    try {
      await s.t.waitFor(/BASH\$ $/, 'bash prompt');
      const mark = s.t.screen().length;
      s.t.write(`${UNSHARE} bash -c "${chatCommand().replace(/"/g, '\\"')}; true" &\r`);
      await waitUntil(() => s.r.locks().length === 1, 'the session lock', 20_000);
      await waitUntil(() => (chat = outerPid(builtBin(), s.r.root)) !== undefined, 'the chat runs', 20_000);
      unshare = ppidOf(ppidOf(chat!));
      // stopped by a probe: the held warning's write (held) or the start's wait (plain)
      await waitUntil(() => procState(chat!) === 'T', `held ${held}: the chat stops in the background (state ${procState(chat!)})`, 30_000);
      assert.equal(await stoppedJobState(s.t), 'Stopped (tty output)', `held ${held}`);
      await sleep(300);
      s.t.write('kill %1\r');
      await waitUntil(() => procState(chat!) === 'gone', `held ${held}: the chat is still there after one \`kill %1\` (state ${procState(chat!)})`, 8000);
      await waitUntil(() => procState(unshare!) === 'gone', `held ${held}: unshare left in state ${procState(unshare!)}`, 8000);
      assert.deepEqual(s.r.locks(), [], `held ${held}: the session lock is left`);
      await waitUntil(() => fs.existsSync(s.ended) && fs.readFileSync(s.ended, 'utf8').trim() !== '', `held ${held}: the SessionEnd hook ran`, 5000);
      assert.doesNotMatch(s.t.screen().slice(mark).replace(/BASH\$ /g, ''), /Welcome to|spawn-failed|failed with exit code/, `held ${held}: drawn from the background`);
    } finally {
      killAll([chat, unshare]);
      await s.t.dispose();
    }
  }
});

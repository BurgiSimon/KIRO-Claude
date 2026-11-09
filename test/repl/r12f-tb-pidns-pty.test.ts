/**
 * Round-12 fix "terminal-b" #2, end to end in a pty: the chat in a PID namespace with its own
 * /proc and no job-control shell inside it (`unshare --fork --pid --mount-proc kiro-claude chat`).
 *
 * There /proc/self/stat reads the job's process group, its session and the terminal's foreground
 * group as 0 (they belong to the parent namespace), which read as "cannot be told", i.e. the
 * foreground. As the namespace's PID 1 the kernel also ignores every default-action stop signal
 * for the chat: Ctrl+Z's SIGTSTP stopped only `unshare` (bash got its prompt back) while the chat
 * ran on, and its terminal mode change from the background then restarted forever in the kernel
 * (SIGTTOU dropped for init: 100% CPU, no JS ran, `kill %1` never closed it); a start with `&` spun
 * the same way. As PID 2 (under a plain `bash -c`) Ctrl+Z, `bg` stopped it inside that ioctl and
 * `kill %1` left it stopped with its lock (r9 #1). Now:
 *  - as PID 1, Ctrl+Z does nothing (as for a session leader): the chat stays, answers, quits;
 *  - where /proc cannot tell, a short-lived `stty` child re-applies the terminal's mode
 *    (input.ts probeForeground): in the foreground it exits 0; in the background the kernel stops
 *    it and the job with it ('Stopped (tty output)'), and the chat stays off the terminal; `fg`
 *    brings the greeting and prompt, `kill %1` closes it (SessionEnd, lock released, 143);
 *  - as PID 2, Ctrl+Z, `bg` stops it ('Stopped (tty output)') and `kill %1` closes it; `fg` works.
 *
 * Deterministic: states are polled (bash's `jobs -l`, /proc). Temp dirs only (r11f-ta-pty-helpers,
 * TMPDIR inside them). Skipped without Linux, python3, bash, or a permitted `unshare --fork --pid
 * --mount-proc` (it needs CAP_SYS_ADMIN).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { builtBin } from '../cli/helpers.js';
import { answers, chatCommand, jobState, nothingDrawn, procState, setup, skipPty, sleep, waitUntil, type Setup } from './r11f-ta-pty-helpers.js';

const UNSHARE = 'unshare --fork --pid --mount-proc';
const skip =
  skipPty ||
  (spawnSync('unshare', ['--fork', '--pid', '--mount-proc', 'true'], { stdio: 'ignore', timeout: 10_000 }).status === 0 ? false : 'unshare --fork --pid --mount-proc is not permitted') ||
  (spawnSync('stty', ['--version'], { stdio: 'ignore' }).status === 0 ? false : 'needs stty');

/** A setup whose processes keep their temp files in its root (the test may SIGKILL the chat). */
function nsSetup(): Setup {
  const s = setup();
  const tmp = path.join(s.r.root, 'tmp');
  fs.mkdirSync(tmp);
  s.t.write(`export TMPDIR='${tmp}'\r`);
  return s;
}

/** The chat's pid as this test's /proc sees it (the lock records its pid inside the namespace: 1 or 2). */
function outerChatPid(s: Setup): number | undefined {
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const argv = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0');
      if (argv[0] !== process.execPath || argv[1] !== builtBin() || argv[2] !== 'chat') continue;
      if (!fs.readlinkSync(`/proc/${d}/cwd`).startsWith(s.r.root)) continue;
      return Number(d);
    } catch {
      // gone
    }
  }
  return undefined;
}

async function chatPidOf(s: Setup): Promise<number> {
  let pid: number | undefined;
  await waitUntil(() => (pid = outerChatPid(s)) !== undefined && s.r.locks().length === 1, 'the chat holds its lock', 20_000);
  return pid!;
}

/** CPU clock ticks (utime + stime) `pid` uses over `ms` (100 Hz: 200 ticks in 2 s is one full core). */
async function ticksOver(pid: number, ms = 2000): Promise<number> {
  const ticks = (): number => {
    const f = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const v = f.slice(f.lastIndexOf(')') + 2).split(' ');
    return Number(v[11]) + Number(v[12]);
  };
  const a = ticks();
  await sleep(ms);
  return ticks() - a;
}

/** Kill the chat this test started, should it outlive the test (the namespace's processes go with a PID 1). */
function killChat(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    const argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    if (argv[1] !== builtBin()) return;
    process.kill(pid, 'SIGCONT');
    process.kill(pid, 'SIGKILL');
  } catch {
    // gone
  }
}

async function closed(s: Setup, pid: number, status: RegExp): Promise<void> {
  await waitUntil(() => procState(pid) === 'gone', `the chat ends (state ${procState(pid)})`, 10_000);
  const mark = s.t.screen().length;
  s.t.write('wait %1; echo "EXIT=$?"\r');
  await s.t.waitFor(/EXIT=\d+/, 'the job status', mark, 10_000);
  assert.match(s.t.screen().slice(mark), status);
  assert.deepEqual(s.r.locks(), [], 'the session lock is left');
  await waitUntil(() => fs.existsSync(s.ended) && fs.readFileSync(s.ended, 'utf8').trim() !== '', 'the SessionEnd hook ran', 5000);
}

test('r12f #2: inside a PID namespace the foreground is told by the probe (job IDs read 0): true in the foreground, false in the background', { skip, timeout: 60_000 }, async () => {
  const s = nsSetup();
  try {
    await s.t.waitFor(/BASH\$ $/, 'bash prompt');
    const input = path.join(path.dirname(path.dirname(builtBin())), 'repl', 'input.js');
    const script = path.join(s.r.root, 'probe.mjs');
    // prints its pid, pgrp, session and the terminal's foreground group as /proc reads them, and the verdict
    fs.writeFileSync(
      script,
      `import * as fs from 'node:fs';\n` +
        `const m = await import(${JSON.stringify(input)});\n` +
        `const st = fs.readFileSync('/proc/self/stat', 'utf8'); const f = st.slice(st.lastIndexOf(')') + 2).split(' ');\n` +
        `console.log('IDS=' + [process.pid, f[2], f[3], f[5]].join(','), 'FG=' + m.terminalInForeground(process.stdin));\n`,
    );
    let mark = s.t.screen().length;
    s.t.write(`${UNSHARE} '${process.execPath}' '${script}'\r`);
    await s.t.waitFor(/FG=\w+[\s\S]*BASH\$ $/, 'the probe in the foreground', mark, 20_000);
    assert.match(s.t.screen().slice(mark), /IDS=1,0,0,0 FG=true/, 'in the foreground');
    mark = s.t.screen().length;
    s.t.write(`${UNSHARE} '${process.execPath}' '${script}' &\r`);
    await s.t.waitFor(/FG=\w+/, 'the probe in the background', mark, 20_000);
    assert.match(s.t.screen().slice(mark), /IDS=1,0,0,0 FG=false/, 'in the background');
    // the probe stopped the job as a background job's mode change does (`unshare`: the job's leader)
    assert.equal(await jobState(s.t), 'Stopped (tty output)');
    mark = s.t.screen().length;
    s.t.write('fg\r');
    await s.t.waitFor(/BASH\$ $/, 'the job ends after fg', mark + 4, 20_000);
  } finally {
    await s.t.dispose();
  }
});

test('r12f #2: as PID 1 of a PID namespace, Ctrl+Z at the prompt does nothing (no spin): the chat answers and /quit closes it', { skip, timeout: 120_000 }, async () => {
  const s = nsSetup();
  let pid: number | undefined;
  try {
    await s.t.waitFor(/BASH\$ $/, 'bash prompt');
    let mark = s.t.screen().length;
    s.t.write(`${UNSHARE} ${chatCommand()}\r`);
    pid = await chatPidOf(s);
    await s.t.waitFor(/Welcome to[\s\S]*> $/, 'the chat prompt', mark, 30_000);
    const atPrompt = s.t.screen().length - 2;
    mark = s.t.screen().length;
    s.t.write('\x1a');
    await sleep(1000);
    assert.equal(s.t.screen().slice(mark), '', 'Ctrl+Z changed something (the shell took the terminal while the chat runs on)');
    assert.notEqual(procState(pid), 'T');
    const ticks = await ticksOver(pid);
    assert.ok(ticks < 40, `CPU ticks over 2 s after Ctrl+Z: ${ticks} (200: one full core)`);
    // the prompt is still the one drawn before Ctrl+Z, the input unchanged
    await answers(s.t, atPrompt, 'one');
    mark = s.t.screen().length;
    s.t.write('/quit\r');
    await waitUntil(() => procState(pid!) === 'gone', 'the chat ends after /quit', 15_000);
    s.t.write('echo "EXIT=$?"\r');
    await s.t.waitFor(/EXIT=\d+/, 'the exit status', mark, 10_000);
    assert.match(s.t.screen().slice(mark), /EXIT=0/);
    assert.deepEqual(s.r.locks(), []);
  } finally {
    killChat(pid);
    await s.t.dispose();
  }
});

test('r12f #2: as PID 1 of a PID namespace, a start with `&` stays off the terminal (no spin, \'Stopped (tty output)\'); `fg` brings the greeting and prompt', { skip, timeout: 120_000 }, async () => {
  const s = nsSetup();
  let pid: number | undefined;
  try {
    await s.t.waitFor(/BASH\$ $/, 'bash prompt');
    let mark = s.t.screen().length;
    s.t.write(`${UNSHARE} ${chatCommand()} &\r`);
    pid = await chatPidOf(s);
    // the start finishes, the probe finds the background and stops the job (the chat cannot stop)
    await waitUntil(() => /Stopped \(tty output\)/.test(s.t.screen().slice(mark)), 'bash reports the job stopped', 30_000).catch(() => undefined);
    await sleep(1500);
    const ticks = await ticksOver(pid);
    assert.ok(ticks < 40, `CPU ticks over 2 s in the background: ${ticks} (200: one full core)`);
    assert.equal(await jobState(s.t), 'Stopped (tty output)');
    nothingDrawn(s.t, mark);
    mark = s.t.screen().length;
    s.t.write('fg\r');
    await s.t.waitFor(/Welcome to[\s\S]*> $/, 'the greeting and the prompt after fg', mark, 20_000);
    await answers(s.t, mark, 'two');
    mark = s.t.screen().length;
    s.t.write('/quit\r');
    await waitUntil(() => procState(pid!) === 'gone', 'the chat ends after /quit', 15_000);
    assert.deepEqual(s.r.locks(), []);
  } finally {
    killChat(pid);
    await s.t.dispose();
  }
});

test('r12f #2: as PID 1 of a PID namespace started with `&`, `kill %1` closes the chat at once (SessionEnd, lock released, 143)', { skip, timeout: 120_000 }, async () => {
  const s = nsSetup();
  let pid: number | undefined;
  try {
    await s.t.waitFor(/BASH\$ $/, 'bash prompt');
    const mark = s.t.screen().length;
    s.t.write(`${UNSHARE} ${chatCommand()} &\r`);
    pid = await chatPidOf(s);
    await waitUntil(() => /Stopped \(tty output\)/.test(s.t.screen().slice(mark)), 'bash reports the job stopped', 30_000).catch(() => undefined);
    await sleep(1000);
    const t0 = Date.now();
    s.t.write('kill %1\r');
    await closed(s, pid, /EXIT=143/);
    assert.ok(Date.now() - t0 < 7000, `the chat ended ${Date.now() - t0} ms after \`kill %1\``);
  } finally {
    killChat(pid);
    await s.t.dispose();
  }
});

test('r12f #2: as PID 2 of a PID namespace (`bash -c`), Ctrl+Z then `bg` stops the chat (\'Stopped (tty output)\'), `kill %1` closes it; `fg` brings it back', { skip, timeout: 120_000 }, async () => {
  for (const end of ['kill', 'fg'] as const) {
    const s = nsSetup();
    let pid: number | undefined;
    try {
      await s.t.waitFor(/BASH\$ $/, 'bash prompt');
      let mark = s.t.screen().length;
      s.t.write(`${UNSHARE} bash -c "${chatCommand().replace(/"/g, '\\"')}; true"\r`);
      pid = await chatPidOf(s);
      await s.t.waitFor(/Welcome to[\s\S]*> $/, 'the chat prompt', mark, 30_000);
      mark = s.t.screen().length;
      s.t.write('\x1a');
      await s.t.waitFor(/Stopped[\s\S]*BASH\$ $/, 'bash reports the job stopped', mark);
      await waitUntil(() => procState(pid!) === 'T', 'the chat is stopped', 5000);
      mark = s.t.screen().length;
      s.t.write('bg\r');
      await s.t.waitFor(/BASH\$ $/, 'bash prompt after bg', mark + 3);
      // continued in the background, the chat finds it there (the probe) and is stopped again
      await waitUntil(() => procState(pid!) === 'T', `the chat stops again in the background (state ${procState(pid!)})`, 10_000);
      await sleep(300);
      assert.equal(procState(pid), 'T');
      assert.equal(await jobState(s.t), 'Stopped (tty output)');
      nothingDrawn(s.t, mark);
      if (end === 'kill') {
        s.t.write('kill %1\r');
        await closed(s, pid, /EXIT=(143|0)/);
      } else {
        mark = s.t.screen().length;
        s.t.write('fg\r');
        await answers(s.t, mark, 'three');
      }
    } finally {
      killChat(pid);
      await s.t.dispose();
    }
  }
});

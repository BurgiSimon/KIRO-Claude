/**
 * Round-12 follow-up "terminal" T3 and T4, end to end in a pty: a chat off the terminal in an
 * orphaned background process group, whose terminal session then ends (r12 #4: no SIGHUP reaches
 * such a group; the loss of the controlling terminal ends the chat as a hangup).
 *
 * T3: running out of file descriptors is not the end of the terminal session. The chat waiting
 * off the terminal (`bash -mc '(kiro-claude chat …) & sleep 1'`, its start finished once that
 * shell exited) gets its RLIMIT_NOFILE lowered to its lowest free descriptor from outside
 * (`prlimit`), so its /proc/self/stat reads fail with EMFILE: before, that read as "not the
 * controlling terminal any more" and the chat closed its session silently with exit 0; now it
 * cannot be told, and the chat keeps waiting. With the limit restored, the end of the terminal
 * session still closes it (exit 0, SessionEnd, no lock).
 *
 * T4: the hand-back after a `!cmd` that ends in an orphaned background group whose terminal
 * session then ends (the fixer's residual: no pty test of it). The chat runs as the foreground job
 * of a `bash -mc` shell inside the terminal's bash; that shell is SIGKILLed while the `!cmd` runs,
 * so the terminal's bash takes the terminal back and the chat's group is orphaned in the
 * background; the `!cmd` ends; the terminal closes. The chat closes as at a hangup (SessionEnd, no
 * lock, exit 0) and writes nothing to the hung-up terminal: before, the next prompt, the resume
 * hint and the bracketed-paste switch were written there (EIO ignored). strace on the chat shows
 * its writes (none to its stdin, stdout or stderr).
 *
 * Deterministic: states are polled, the `!cmd` waits for a file the test creates. Temp dirs only
 * (r11f-ta-pty-helpers, TMPDIR inside them). Skipped without Linux, python3, bash; T3 without
 * prlimit, T4 without strace (or ptrace) permission.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { BASH, SLOW_START, answers, chatCommand, procState, setup, skipPty, sleep, waitUntil } from './r11f-ta-pty-helpers.js';

const skipPrlimit = skipPty || (spawnSync('prlimit', ['--version'], { stdio: 'ignore' }).status === 0 ? false : 'needs prlimit');
const skipStrace = skipPty || (spawnSync('strace', ['-qq', '-e', 'trace=none', 'true'], { stdio: 'ignore', timeout: 10_000 }).status === 0 ? false : 'needs strace (ptrace permitted)');

/** The soft and hard RLIMIT_NOFILE of `pid` (/proc/<pid>/limits). */
function nofile(pid: number): { soft: string; hard: string } {
  const m = /^Max open files\s+(\S+)\s+(\S+)/m.exec(fs.readFileSync(`/proc/${pid}/limits`, 'utf8'));
  assert.ok(m, 'no Max open files line');
  return { soft: m[1]!, hard: m[2]! };
}

/** The lowest file descriptor number `pid` has free: a limit there makes its next open fail with EMFILE. */
function lowestFreeFd(pid: number): number {
  const used = new Set(fs.readdirSync(`/proc/${pid}/fd`).map(Number));
  let n = 0;
  while (used.has(n)) n++;
  return n;
}

test('r12g T3: a chat waiting off the terminal in an orphaned group that runs out of file descriptors keeps waiting (EMFILE is no end of the terminal session); the session\'s end still closes it', { skip: skipPrlimit, timeout: 120_000 }, async () => {
  const s = setup({ env: { ...SLOW_START } });
  const tmp = path.join(s.r.root, 'tmp');
  fs.mkdirSync(tmp);
  const status = path.join(s.r.root, 'orphan-status');
  let pid: number | undefined;
  try {
    await s.t.waitFor(/BASH\$ $/, 'bash prompt');
    const inner = `(TMPDIR='${tmp}' ${chatCommand()} 2>/dev/null; echo EXIT=\\$? > '${status}') & sleep 1`;
    s.t.write(`'${BASH}' -mc "${inner}"\r`);
    await waitUntil(() => s.r.locks().length === 1, 'the session lock', 20_000);
    pid = s.t.chatPid();
    // the start finishes after `bash -mc` exited: orphaned, it waits off the terminal
    await sleep(4000);
    assert.ok(['S', 'R'].includes(procState(pid)), `the chat waits off the terminal (state ${procState(pid)})`);
    assert.ok(!fs.existsSync(status), 'the chat ended before the test began');
    const was = nofile(pid);
    const low = lowestFreeFd(pid);
    assert.equal(spawnSync('prlimit', [`--pid=${pid}`, `--nofile=${low}:`]).status, 0, 'prlimit failed');
    assert.equal(nofile(pid).soft, String(low));
    // its looks at /proc/self/stat now fail with EMFILE (every 20 ms)
    await sleep(2000);
    const st = procState(pid);
    const ended = fs.existsSync(status) ? fs.readFileSync(status, 'utf8').trim() : '';
    assert.ok(['S', 'R'].includes(st) && ended === '', `the chat ended out of file descriptors (state ${st}, ${ended}): EMFILE taken for the end of its terminal session`);
    assert.equal(s.r.locks().length, 1, 'the chat holds its lock while it waits');
    assert.ok(!fs.existsSync(s.ended) || fs.readFileSync(s.ended, 'utf8').trim() === '', 'its SessionEnd ran');
    // file descriptors again, then the end of the terminal session (r12 #4, unchanged)
    assert.equal(spawnSync('prlimit', [`--pid=${pid}`, `--nofile=${was.soft}:`]).status, 0, 'prlimit failed');
    await sleep(300);
    await s.t.hangup();
    await waitUntil(() => procState(pid!) === 'gone', `the chat ends with its terminal session (state ${procState(pid!)})`, 15_000);
    await waitUntil(() => fs.existsSync(status), 'the exit status', 5000);
    assert.equal(fs.readFileSync(status, 'utf8').trim(), 'EXIT=0');
    assert.deepEqual(s.r.locks(), []);
    await waitUntil(() => fs.existsSync(s.ended) && fs.readFileSync(s.ended, 'utf8').trim() !== '', 'the SessionEnd hook ran', 5000);
  } finally {
    await s.t.dispose();
  }
});

test('r12g T4: a `!cmd` that ends in an orphaned background group whose terminal session then ends: the chat closes as at a hangup (SessionEnd, no lock, exit 0) and writes nothing to the hung-up terminal (strace)', { skip: skipStrace, timeout: 120_000 }, async () => {
  const s = setup();
  const tmp = path.join(s.r.root, 'tmp');
  fs.mkdirSync(tmp);
  const go = path.join(s.r.ws, 'go');
  const trace = path.join(s.r.root, 'chat.strace');
  let strace: ReturnType<typeof spawn> | undefined;
  try {
    await s.t.waitFor(/BASH\$ $/, 'bash prompt');
    let mark = s.t.screen().length;
    // the chat: the foreground job of a job-control shell inside the terminal's bash
    s.t.write(`'${BASH}' -mc "TMPDIR='${tmp}' ${chatCommand().replace(/"/g, '\\"')}; true"\r`);
    await s.t.waitFor(/Welcome to[\s\S]*> $/, 'the chat prompt', mark, 30_000);
    const pid = s.t.chatPid();
    // (a conversation to resume: the resume hint names it)
    await answers(s.t, mark, 'one');
    const ppid = Number(fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]!.split(' ')[1]);
    assert.match(fs.readFileSync(`/proc/${ppid}/cmdline`, 'utf8'), /bash/);
    mark = s.t.screen().length;
    s.t.write("!printf 'CHILD-''RUNS\\n'; while [ ! -e go ]; do sleep 0.05; done\r");
    await s.t.waitFor(/CHILD-RUNS/, 'the child runs', mark);
    // the job-control shell dies: the terminal's bash takes the terminal back, the chat's group
    // (the chat and its child) is orphaned in the background
    mark = s.t.screen().length;
    process.kill(ppid, 'SIGKILL');
    await s.t.waitFor(/BASH\$ $/, 'the terminal\'s bash has the terminal again', mark, 10_000);
    // the chat's terminal (libuv opens it again for stdout and stderr, under other descriptors)
    const pts = fs.readlinkSync(`/proc/${pid}/fd/0`);
    assert.match(pts, /^\/dev\/pts\/\d+$/);
    // every write of the chat from here on
    strace = spawn('strace', ['-q', '-y', '-e', 'trace=write,writev', '-e', 'signal=none', '-s', '80', '-o', trace, '-p', String(pid)], { stdio: 'ignore', env: { ...process.env, TMPDIR: tmp } });
    await waitUntil(() => /^TracerPid:\s*[1-9]/m.test(fs.readFileSync(`/proc/${pid}/status`, 'utf8')), 'strace attached', 10_000);
    fs.writeFileSync(go, '');
    // the child ends; the hand-back waits off the terminal (orphaned: its self-stop is discarded)
    await sleep(1500);
    assert.ok(['S', 'R', 't'].includes(procState(pid)), `the chat waits off the terminal (state ${procState(pid)})`);
    assert.equal(s.r.locks().length, 1);
    // the end of the terminal session: no SIGHUP for this group
    await s.t.hangup();
    await waitUntil(() => procState(pid) === 'gone', `the chat ends with its terminal session (state ${procState(pid)})`, 15_000);
    await waitUntil(() => strace!.exitCode !== null || strace!.signalCode !== null, 'strace ends', 10_000);
    const log = fs.readFileSync(trace, 'utf8');
    // (-y names each descriptor's file; a write of nothing, Node's own at its exit, is no output)
    const toTerminal = log.split('\n').filter((l) => {
      // (once the terminal closed its device node is gone: `<…>(deleted)`)
      const m = /^(?:write|writev)\(\d+<([^>]*)>(?:\(deleted\))?, (.*)/.exec(l);
      return m !== null && m[1] === pts && !/^"", 0\)/.test(m[2]!);
    });
    assert.deepEqual(toTerminal, [], 'written to the hung-up terminal after its session ended');
    // (the check sees the terminal's descriptors: Node's empty writes at its exit name it)
    assert.ok(log.includes(`<${pts}>`), `strace named no write to ${pts}:\n${log.slice(-600)}`);
    assert.match(log, /\+\+\+ exited with 0 \+\+\+/, `exit status:\n${log.split('\n').slice(-5).join('\n')}`);
    assert.deepEqual(s.r.locks(), [], 'the session lock is left');
    await waitUntil(() => fs.existsSync(s.ended) && fs.readFileSync(s.ended, 'utf8').trim() !== '', 'the SessionEnd hook ran', 5000);
  } finally {
    if (strace && strace.exitCode === null && strace.signalCode === null) strace.kill('SIGKILL');
    await s.t.dispose();
  }
});

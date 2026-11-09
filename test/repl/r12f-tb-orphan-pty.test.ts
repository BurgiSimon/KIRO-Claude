/**
 * Round-12 fix "terminal-b" #4/#8, end to end in a pty: a chat waiting off the terminal in an
 * orphaned background process group closes its session when the terminal session ends.
 *
 * `bash -mc '(kiro-claude chat; echo EXIT=$? > status) & sleep 1'` at an interactive bash: the
 * chat's start finishes (Claude Code answers initialize after 2.5 s) once that `bash -mc` has
 * exited, so its process group is orphaned, the kernel discards its self-stop, and it waits off
 * the terminal with its lock (README). Then the terminal closes (the pty master is closed). Such a
 * group gets no SIGHUP; the hangup takes its controlling terminal away, which /proc then cannot
 * tell from "the foreground", so the wait ended, the reader's raw switch failed with EIO outside
 * the try that closes the session, and the chat ended with 'setRawMode EIO', exit status 1, no
 * SessionEnd and its lock left. Now the loss of the controlling terminal ends the wait as a hangup
 * whose SIGHUP never comes: the session is closed (SessionEnd runs, the lock is released) and the
 * chat exits 0, writing nothing.
 *
 * Deterministic: the start is slowed at a known point (the fake's initialize delay) and the test
 * polls for states. Temp dirs only (r11f-ta-pty-helpers); skipped without Linux, python3 or bash.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { BASH, SLOW_START, chatCommand, procState, setup, skipPty, sleep, waitUntil } from './r11f-ta-pty-helpers.js';

test('r12f #4/#8: an orphaned chat waiting off the terminal closes its session when the terminal session ends (exit 0, SessionEnd, no lock, no EIO)', { skip: skipPty, timeout: 120_000 }, async () => {
  const s = setup({ env: { ...SLOW_START } });
  const tmp = path.join(s.r.root, 'tmp');
  fs.mkdirSync(tmp);
  const status = path.join(s.r.root, 'orphan-status');
  const stderr = path.join(s.r.root, 'orphan-stderr');
  try {
    await s.t.waitFor(/BASH\$ $/, 'bash prompt');
    // (the chat may be SIGKILLed by dispose(): its temp files go to a dir the test removes)
    const inner = `(TMPDIR='${tmp}' ${chatCommand()} 2>'${stderr}'; echo EXIT=\\$? > '${status}') & sleep 1`;
    s.t.write(`'${BASH}' -mc "${inner}"\r`);
    await waitUntil(() => s.r.locks().length === 1, 'the session lock', 20_000);
    const pid = s.t.chatPid();
    // the start finishes after `bash -mc` exited: orphaned, the self-stop discarded, it waits (a
    // hangup during the start instead ends it the same way: the reader's EIO is the input's end)
    await sleep(4000);
    const st = procState(pid);
    assert.ok(st === 'S' || st === 'R', `the chat waits off the terminal (state ${st})`);
    assert.equal(s.r.locks().length, 1, 'the chat holds its lock while it waits');
    assert.ok(!fs.existsSync(status), 'the chat ended before the terminal closed');
    // the end of the terminal session
    await s.t.hangup();
    await waitUntil(() => procState(pid) === 'gone', `the chat ends with its terminal session (state ${procState(pid)})`, 15_000);
    await waitUntil(() => fs.existsSync(status), 'the exit status', 5000);
    const log = fs.existsSync(path.join(s.r.root, 'kiro.log')) ? fs.readFileSync(path.join(s.r.root, 'kiro.log'), 'utf8') : '';
    const got = {
      exit: fs.readFileSync(status, 'utf8').trim(),
      stderr: fs.existsSync(stderr) ? fs.readFileSync(stderr, 'utf8').trim() : '',
      failed: log.split('\n').filter((l) => /command failed|EIO/.test(l)),
      locks: s.r.locks(),
    };
    assert.deepEqual(got, { exit: 'EXIT=0', stderr: '', failed: [], locks: [] }, `kiro.log tail:\n${log.split('\n').slice(-20).join('\n')}`);
    await waitUntil(() => fs.existsSync(s.ended) && fs.readFileSync(s.ended, 'utf8').trim() !== '', 'the SessionEnd hook ran', 5000);
  } finally {
    await s.t.dispose();
  }
});

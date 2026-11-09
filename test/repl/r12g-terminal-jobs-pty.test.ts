/**
 * Round-12 follow-up "terminal" T1 (a test flake): the pty tests checked bash's job state once,
 * right after /proc showed the chat in state T (r9f-editor-verify-pty's stoppedForTerminal failed
 * that way once in a full suite: `jobs -l` still listed the job Running). bash learns of a stop
 * from its SIGCHLD and counts a job stopped only once every process of it has stopped (`| cat`, a
 * wrapper), so /proc can be ahead of it. The tests now ask `jobs -l` again until bash counts the
 * job stopped (r11f-ta-pty-helpers stoppedJobState).
 *
 * This shows the race with a forced delay and that the new wait holds: a job `sleep | python3`
 * gets SIGTTIN; `sleep` stops at once (/proc: T), the python3 process catches it and stops itself
 * only once the test lets it (no timing): the one-shot check reads Running, the new wait reads
 * 'Stopped (tty input)' once the job has stopped.
 *
 * Temp dirs only (r11f-ta-pty-helpers); skipped without Linux, python3 or bash.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { jobState, procPgrp, procState, setup, skipPty, sleep, stoppedJobState, waitUntil } from './r11f-ta-pty-helpers.js';

/** Holds SIGTTIN off until `go` exists, then stops itself with it (`ready`: its handler is in place). */
const LATE_STOP = String.raw`
import os, signal, sys, time
ready, go = sys.argv[1], sys.argv[2]
got = []
signal.signal(signal.SIGTTIN, lambda s, f: got.append(s))
open(ready, 'w').write(str(os.getpid()))
while not got or not os.path.exists(go):
    time.sleep(0.01)
signal.signal(signal.SIGTTIN, signal.SIG_DFL)
os.kill(os.getpid(), signal.SIGTTIN)
time.sleep(600)
`;

test('r12g T1: /proc shows a process of the job stopped before bash counts the job stopped (one-shot `jobs -l`: Running); stoppedJobState waits until it does', { skip: skipPty, timeout: 60_000 }, async () => {
  const s = setup();
  const tmp = path.join(s.r.root, 'tmp');
  fs.mkdirSync(tmp);
  const script = path.join(s.r.root, 'late-stop.py');
  fs.writeFileSync(script, LATE_STOP);
  const ready = path.join(s.r.root, 'ready');
  const go = path.join(s.r.root, 'go');
  let pgrp: number | undefined;
  try {
    await s.t.waitFor(/BASH\$ $/, 'bash prompt');
    // (the job is SIGKILLed at the end: its temp files go to a dir the test removes)
    s.t.write(`export TMPDIR='${tmp}'\r`);
    let mark = s.t.screen().length;
    s.t.write(`sleep 600 | python3 -I '${script}' '${ready}' '${go}' &\r`);
    await s.t.waitFor(/\[1\] \d+[\s\S]*BASH\$ $/, 'the job runs', mark);
    await waitUntil(() => fs.existsSync(ready) && fs.readFileSync(ready, 'utf8') !== '', 'python3 holds SIGTTIN off');
    const py = Number(fs.readFileSync(ready, 'utf8'));
    pgrp = procPgrp(py);
    const sleeper = pgrp; // the job's first process leads its group
    process.kill(-pgrp, 'SIGTTIN');
    await waitUntil(() => procState(sleeper) === 'T', `sleep stops (state ${procState(sleeper)})`);
    // the race the tests had: /proc says T, bash still counts the job running
    assert.equal(procState(py) === 'T', false);
    assert.equal(await jobState(s.t), 'Running', 'a one-shot `jobs -l` right after /proc showed T');
    // the new wait: asked again until bash counts the job stopped
    mark = s.t.screen().length;
    const state = stoppedJobState(s.t, 20_000);
    await waitUntil(() => (s.t.screen().slice(mark).match(/Running/g)?.length ?? 0) >= 2, 'the wait asks again while the job runs', 20_000);
    fs.writeFileSync(go, '');
    assert.equal(await state, 'Stopped (tty input)');
    assert.equal(procState(py), 'T');
  } finally {
    if (pgrp !== undefined) {
      try {
        process.kill(-pgrp, 'SIGKILL');
      } catch {
        // gone
      }
    }
    await sleep(100);
    await s.t.dispose();
  }
});

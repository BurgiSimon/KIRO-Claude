/**
 * Round-12 fix "terminal-b" #5: the self-stop under a wrapper that ignores SIGTTIN (GNU `timeout`,
 * also with `--foreground`, sets SIGTTIN and SIGTTOU to SIG_IGN in itself).
 *
 * Since r11 the chat stops its whole process group with SIGTTIN when it needs the terminal in the
 * background (input.ts stopForTerminal). bash counts a job stopped only once none of its processes
 * runs: under `timeout` the SIGTTIN stopped the chat alone, the job stayed 'Running', `fg` sent no
 * SIGCONT, and the chat stayed stopped for good (Ctrl+Z, `bg`, `fg`; `timeout 600 kiro-claude chat
 * &`, `fg`). Now a self-stop looks at the other processes of its group first (/proc, input.ts
 * groupHoldsOff): when one ignores or catches SIGTTIN and none SIGTSTP, the stop is a SIGTSTP, which
 * stops `timeout` too: bash shows the job 'Stopped', and `fg` continues it. README and
 * ARCHITECTURE say which wrappers that covers.
 *
 * Unit: groupHoldsOff on process groups this test starts (detached, killed after). pty: an
 * interactive bash (r11f-ta-pty-helpers, temp dirs only); skipped without Linux, python3, bash or
 * GNU `timeout`. Deterministic: states are polled (bash's `jobs -l`, /proc).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as inputMod from '../../src/repl/input.js';
import { SLOW_START, answers, bg, chatCommand, ctrlZ, killedCleanly, procPgrp, procState, setup, skipPty, sleep, stoppedJobState, waitUntil } from './r11f-ta-pty-helpers.js';

const haveTimeout = spawnSync('timeout', ['--version'], { stdio: 'ignore' }).status === 0;
const skip = skipPty || (haveTimeout ? false : 'needs GNU timeout');
const skipUnit = process.platform !== 'linux' ? 'Linux /proc' : haveTimeout ? false : 'needs GNU timeout';

/** A process group of its own led by `argv` (killed with its group at the end). */
function group(...argv: string[]): ChildProcess {
  return spawn(argv[0]!, argv.slice(1), { detached: true, stdio: 'ignore' });
}

function members(pgid: number): string[] {
  const out: string[] = [];
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      if (procPgrp(Number(d)) === pgid) out.push(fs.readFileSync(`/proc/${d}/comm`, 'utf8').trim());
    } catch {
      // gone
    }
  }
  return out;
}

test('r12f #5 groupHoldsOff: a group with GNU timeout holds SIGTTIN off but not SIGTSTP; `trap \'\' TTIN TSTP` holds off both; plain sleep neither', { skip: skipUnit, timeout: 30_000 }, async (t) => {
  // (`timeout` leads its group, as under an interactive shell, where the job's first process does;
  // without --foreground it would leave a group it does not lead)
  const groups = [group('timeout', '30', 'sleep', '30'), group('bash', '-c', "trap '' TTIN TSTP; sleep 30 & wait"), group('bash', '-c', 'sleep 30 & wait')];
  t.after(() => {
    for (const g of groups) {
      try {
        if (g.pid !== undefined) process.kill(-g.pid, 'SIGKILL');
      } catch {
        // gone
      }
    }
  });
  const [tmo, trapped, plain] = groups.map((g) => g.pid!);
  await waitUntil(() => members(tmo!).includes('timeout') && members(trapped!).includes('sleep') && members(plain!).includes('sleep'), 'the groups are up', 10_000);
  // (the namespace import: a missing export fails this check alone)
  const holds = inputMod.groupHoldsOff;
  assert.equal(typeof holds, 'function', 'no look at the group before a self-stop');
  assert.deepEqual(holds(tmo!), { SIGTTIN: true, SIGTSTP: false });
  assert.deepEqual(holds(trapped!), { SIGTTIN: true, SIGTSTP: true });
  assert.deepEqual(holds(plain!), { SIGTTIN: false, SIGTSTP: false });
  assert.deepEqual(holds(0), { SIGTTIN: false, SIGTSTP: false }, 'a group outside the PID namespace (0) is not looked at');
});

test('r12f #5: `timeout 600 kiro-claude chat`, Ctrl+Z, `bg`: the chat stops the whole job (\'Stopped\', timeout too), and `fg` brings it back', { skip, timeout: 120_000 }, async () => {
  const s = setup();
  try {
    await s.t.waitFor(/BASH\$ $/, 'bash prompt');
    let mark = s.t.screen().length;
    s.t.write(`timeout 600 ${chatCommand()}\r`);
    await waitUntil(() => s.r.locks().length === 1, 'the session lock', 20_000);
    const pid = s.t.chatPid();
    const wrapper = Number(fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]!.split(' ')[1]);
    assert.match(fs.readFileSync(`/proc/${wrapper}/comm`, 'utf8'), /^timeout/);
    await s.t.waitFor(/Welcome to[\s\S]*> $/, 'the chat prompt', mark, 30_000);
    await answers(s.t, mark, 'one');
    await ctrlZ(s.t, pid);
    await bg(s.t);
    // continued in the background, the chat needs the terminal and stops its job again
    await waitUntil(() => procState(pid) === 'T' && procState(wrapper) === 'T', `the job stops again (chat ${procState(pid)}, timeout ${procState(wrapper)})`, 10_000);
    // (asked until bash counts the job stopped, r12g T1; before r12 #5 it stayed Running for good)
    assert.equal(await stoppedJobState(s.t), 'Stopped', 'bash still counts the job running: its fg sends no SIGCONT');
    mark = s.t.screen().length;
    s.t.write('fg\r');
    await answers(s.t, mark, 'two');
  } finally {
    await s.t.dispose();
  }
});

test('r12f #5: `timeout 600 kiro-claude chat &` (still starting): it stops the job before its greeting; `fg` brings the greeting and prompt', { skip, timeout: 120_000 }, async () => {
  const s = setup({ env: SLOW_START });
  try {
    await s.t.waitFor(/BASH\$ $/, 'bash prompt');
    s.t.write(`timeout 600 ${chatCommand()} &\r`);
    await waitUntil(() => s.r.locks().length === 1, 'the session lock', 20_000);
    const pid = s.t.chatPid();
    await waitUntil(() => procState(pid) === 'T', `the chat stops in the background once started (state ${procState(pid)})`, 20_000);
    assert.equal(await stoppedJobState(s.t), 'Stopped');
    const mark = s.t.screen().length;
    s.t.write('fg\r');
    await s.t.waitFor(/Welcome to[\s\S]*> $/, 'the greeting and the prompt after fg', mark, 15_000);
    await answers(s.t, mark);
  } finally {
    await s.t.dispose();
  }
});

test('r12f #5: under `timeout`, `kill %1` of the self-stopped chat closes it at once (SessionEnd, lock released)', { skip, timeout: 120_000 }, async () => {
  const s = setup();
  try {
    await s.t.waitFor(/BASH\$ $/, 'bash prompt');
    const mark = s.t.screen().length;
    s.t.write(`timeout --foreground 600 ${chatCommand()}\r`);
    await waitUntil(() => s.r.locks().length === 1, 'the session lock', 20_000);
    const pid = s.t.chatPid();
    await s.t.waitFor(/Welcome to[\s\S]*> $/, 'the chat prompt', mark, 30_000);
    await ctrlZ(s.t, pid);
    await bg(s.t);
    await waitUntil(() => procState(pid) === 'T', 'the chat stops again in the background', 10_000);
    await sleep(200);
    assert.equal(await stoppedJobState(s.t), 'Stopped');
    await killedCleanly(s, pid);
  } finally {
    await s.t.dispose();
  }
});

// ───────────────────────────── docs ─────────────────────────────

/** A file of the repository (the tests run from its root). */
function repoFile(rel: string): string {
  let dir = process.cwd();
  for (;;) {
    if (fs.existsSync(path.join(dir, 'src', 'repl', 'input.ts')) && fs.existsSync(path.join(dir, rel))) return fs.readFileSync(path.join(dir, rel), 'utf8');
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('run the tests from the repository root');
    dir = parent;
  }
}

function bullet(text: string, start: RegExp): string {
  const i = text.search(start);
  assert.ok(i >= 0, 'bullet not found');
  const rest = text.slice(i + 1);
  const j = rest.search(/\n\* |\n#/);
  return text.slice(i, j < 0 ? undefined : i + 1 + j);
}

test('r12f #5 docs: README\'s Ctrl+Z bullet says which wrappers the stop in the background works through (GNU timeout included) and which not', () => {
  const b = bullet(repoFile('README.md'), /\n\* \*\*Ctrl\+Z\*\*/).replace(/\s+/g, ' ');
  assert.match(b, /works through wrappers/);
  assert.match(b, /`timeout`/, 'GNU timeout (it ignores SIGTTIN) is not named');
  assert.match(b, /ignores or catches both|ignores both|both SIGTTIN and SIGTSTP|`trap '' TTIN TSTP`/, 'the wrapper the stop still cannot stop is not named');
});

test('r12f #5 docs: ARCHITECTURE\'s self-stop text names the SIGTSTP for a group member that holds SIGTTIN off, and what is left', () => {
  const b = bullet(repoFile('docs/ARCHITECTURE.md'), /\n\* Ctrl\+Z \(POSIX\) at a prompt/).replace(/\s+/g, ' ');
  assert.match(b, /r11 #2, `stopForTerminal`/);
  assert.match(b, /r12 #5/);
  assert.match(b, /`timeout`/);
  assert.match(b, /groupHoldsOff/);
});

/**
 * Round-12 follow-up "terminal", verification: a fatal signal of kiro-claude as the init (PID 1)
 * of a PID namespace whose close overruns its grace (repl/exitSignals.ts reraise, r12 #2).
 *
 * README: "The close gets at most 2 s; then kiro-claude exits with the signal … and ends any Claude
 * Code process or hook command still running". As PID 1 the kernel drops a default-action signal
 * the namespace's init sends itself, so r12 #2 exits with the signal's status at once when no
 * listener for it is left. But while Claude Code is still running (a close that overran the 2 s
 * grace: a slow machine, a Claude Code that does not end at the end of its input) one is left:
 * claude/lifecycle.ts's forwarder, which forwards the signal to Claude Code, SIGKILLs what is left
 * after its 1 s grace and re-raises it with its listener removed, a re-raise the kernel drops the
 * same way. The chat then lived on until ExitSignals' 5 s fallback: 7 s after `kill %1` instead of
 * about 2 s, as under a plain shell (the control below). Under a heavy load a normal close overran
 * the grace too (the likely cause of one failure of r12f-tb-pidns-pty's "PID 1 started with `&`,
 * `kill %1`").
 *
 * The fake Claude Code ignores the end of its input (FAKE_CLAUDE_HANG_ON_EOF): every close
 * overruns the grace, deterministically. Times are bounded from below by timers (2 s grace, 5 s
 * fallback), so the bound checked (6 s) is far from both outcomes. Temp dirs only
 * (r11f-ta-pty-helpers, TMPDIR inside them); skipped without Linux, python3, bash or a permitted
 * `unshare --fork --pid --mount-proc`.
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

/** The chat's pid as this test's /proc sees it (its argv names the built CLI, its cwd is under the root). */
function outerChatPid(s: Setup): number | undefined {
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const argv = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0');
      if (argv[1] !== builtBin() || argv[2] !== 'chat') continue;
      if (!fs.readlinkSync(`/proc/${d}/cwd`).startsWith(s.r.root)) continue;
      return Number(d);
    } catch {
      // gone
    }
  }
  return undefined;
}

/**
 * The fake Claude Code processes of this test (its argv names the fixture, its cwd is under the
 * root); `session`: only a session's (stream-json input), not a short probe of the CLI.
 */
function fakePids(s: Setup, session = false): number[] {
  const out: number[] = [];
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const cmd = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8');
      if (!cmd.includes('fake-claude') || (session && !cmd.includes('--input-format'))) continue;
      if (!fs.readlinkSync(`/proc/${d}/cwd`).startsWith(s.r.root)) continue;
      out.push(Number(d));
    } catch {
      // gone
    }
  }
  return out;
}

/**
 * SIGKILL what this test started (the chat, Claude Code) should it outlive the test, only while
 * its pid still names one of those.
 */
function killAll(pids: (number | undefined)[]): void {
  for (const pid of pids) {
    if (pid === undefined) continue;
    try {
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      if (!cmd.includes(builtBin()) && !cmd.includes('fake-claude')) continue;
      process.kill(pid, 'SIGCONT');
      process.kill(pid, 'SIGKILL');
    } catch {
      // gone
    }
  }
}

for (const [label, prefix] of [
  ['as PID 1 of a PID namespace', `${UNSHARE} `],
  ['control: under the shell', ''],
] as const) {
  test(`r12g verify: ${label}, started with \`&\`, \`kill %1\` while Claude Code does not end at the end of its input: the chat exits with 143 about 2 s later (the close's grace), not after the 5 s fallback`, { skip, timeout: 120_000 }, async () => {
    const s = setup({ env: { FAKE_CLAUDE_HANG_ON_EOF: '1' } });
    const tmp = path.join(s.r.root, 'tmp');
    fs.mkdirSync(tmp);
    s.t.write(`export TMPDIR='${tmp}'\r`);
    let pid: number | undefined;
    let fakes: number[] = [];
    try {
      await s.t.waitFor(/BASH\$ $/, 'bash prompt');
      s.t.write(`${prefix}${chatCommand()} &\r`);
      await waitUntil(() => (pid = outerChatPid(s)) !== undefined && s.r.locks().length === 1, 'the chat holds its lock', 20_000);
      await waitUntil(() => (fakes = fakePids(s, true)).length > 0, 'Claude Code runs', 20_000);
      // off the terminal in the background: the job is stopped (its own stop, or the probe's)
      assert.match(await stoppedJobState(s.t, 30_000), /^Stopped/, 'the job is not stopped in the background');
      await sleep(500);
      const t0 = Date.now();
      s.t.write('kill %1\r');
      await waitUntil(() => procState(pid!) === 'gone', `the chat ends (state ${procState(pid!)})`, 15_000);
      const ms = Date.now() - t0;
      assert.ok(ms < 6000, `the chat ended ${ms} ms after \`kill %1\` (the 5 s fallback after the 2 s grace)`);
      const m2 = s.t.screen().length;
      s.t.write('wait %1; echo "EXIT=$?"\r');
      await s.t.waitFor(/EXIT=\d+/, 'the job status', m2, 10_000);
      assert.match(s.t.screen().slice(m2), /EXIT=143/);
      // Claude Code was ended too
      await waitUntil(() => fakes.every((p) => procState(p) === 'gone'), `Claude Code left running (${fakes.map(procState).join(' ')})`, 5000);
    } finally {
      // (Claude Code here ignores the end of its input: none may outlive a failed test)
      killAll([pid, ...fakes, ...fakePids(s)]);
      await s.t.dispose();
    }
  });
}

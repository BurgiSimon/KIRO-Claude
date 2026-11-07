/**
 * runShell's post-exit kills (lifecycle L1). After the shell exited, runShell waits up to
 * `closeGraceMs` for its pipes; a timeout or an abort in that window still SIGKILLs the
 * process group, to end background members that hold the pipes. That is right while members of
 * the group live (they keep the group id reserved), but once the group is empty its id may
 * already be the pid and group of an unrelated process (pid_max is 32768 here). The reuse cases
 * make the kernel hand the freed pid to a detached `sleep` (test/claude/pid-reuse-helpers.ts,
 * Linux and root only); the guards check that our own leftover members are still killed.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';

import { runShell } from '../../src/util/process.js';
import { alive } from '../claude/hang-helpers.js';
import { canChoosePid, exitedWithin, killIfSame, spawnWithPid, startTicksOf, waitReaped } from '../claude/pid-reuse-helpers.js';

const reuse = canChoosePid() ? {} : { skip: 'needs Linux and root to steer pid allocation (ns_last_pid)' };
const unix = process.platform === 'win32' ? { skip: 'POSIX process groups' } : {};
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kc-pid-reuse-')));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;

/**
 * A command whose shell exits at once, leaving a holder in its own session (so not in the
 * shell's group) that keeps the pipes open for 3 s; `<dir>/shell` gets the shell's pid,
 * `<dir>/holder` the holder's.
 */
function holderCommand(): { dir: string; command: string } {
  const dir = path.join(tmp, `c${++n}`);
  fs.mkdirSync(dir);
  const js = `const h = require('child_process').spawn('sleep', ['3'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] }); h.unref(); require('fs').writeFileSync(${JSON.stringify(path.join(dir, 'holder'))}, String(h.pid));`;
  const command = `echo $$ > ${JSON.stringify(path.join(dir, 'shell'))}; ${JSON.stringify(process.execPath)} -e ${shq(js)}; exit 0`;
  return { dir, command };
}

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

async function readPid(file: string, ms = 5000): Promise<number> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fs.existsSync(file) ? Number.parseInt(fs.readFileSync(file, 'utf8'), 10) : NaN;
    if (v > 0) return v;
    if (Date.now() > end) throw new Error(`no pid in ${file}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('runShell: post-exit kills and pid reuse (L1)', () => {
  for (const how of ['timeout', 'abort'] as const) {
    it(`${how === 'abort' ? 'an' : 'a'} ${how} during the pipe grace spares a new group that reused the shell's pid`, reuse, async (t) => {
      const { dir, command } = holderCommand();
      const ac = new AbortController();
      const running = runShell(command, {
        cwd: dir,
        closeGraceMs: 6000,
        ...(how === 'timeout' ? { timeoutMs: 900 } : { signal: ac.signal }),
      });
      const shell = await readPid(path.join(dir, 'shell'));
      const holder = await readPid(path.join(dir, 'holder'));
      const holderStart = startTicksOf(holder);
      t.after(() => killIfSame(holder, holderStart));
      assert.ok(await waitReaped(shell, 5000), 'the shell exited');
      const victim = spawnWithPid(shell);
      if (!victim) {
        ac.abort();
        await running;
        return t.skip('the kernel did not hand out the freed pid');
      }
      t.after(() => victim.kill('SIGKILL'));
      if (how === 'abort') ac.abort();
      const r = await running;
      assert.equal(r.exitCode, 0, JSON.stringify(r));
      assert.equal(how === 'timeout' ? r.timedOut : r.aborted, true, JSON.stringify(r));
      assert.equal(await exitedWithin(victim, 300), undefined, `group ${shell} (a new process that reused the pid) was killed`);
    });
  }

  for (const how of ['timeout', 'abort'] as const) {
    it(`${how === 'abort' ? 'an' : 'a'} ${how} during the pipe grace still kills a background member left in the shell's group`, unix, async (t) => {
      const dir = path.join(tmp, `g${++n}`);
      fs.mkdirSync(dir);
      const pidFile = path.join(dir, 'member');
      const ac = new AbortController();
      const t0 = Date.now();
      const running = runShell(`sleep 30 & echo $! > ${JSON.stringify(pidFile)}; exit 0`, {
        cwd: dir,
        closeGraceMs: 8000,
        ...(how === 'timeout' ? { timeoutMs: 400 } : { signal: ac.signal }),
      });
      const member = await readPid(pidFile);
      const start = startTicksOf(member);
      t.after(() => killIfSame(member, start));
      if (how === 'abort') setTimeout(() => ac.abort(), 400);
      const r = await running;
      assert.equal(r.exitCode, 0, JSON.stringify(r));
      assert.equal(how === 'timeout' ? r.timedOut : r.aborted, true, JSON.stringify(r));
      assert.ok(Date.now() - t0 < 4000, `settled after ${Date.now() - t0} ms: the member kept the pipes open`);
      for (let i = 0; i < 100 && alive(member); i++) await new Promise((res) => setTimeout(res, 10));
      assert.equal(alive(member), false, 'the background member was killed with the group');
    });
  }
});

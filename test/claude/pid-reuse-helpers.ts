/**
 * Pid reuse on demand, for the suites that check a kill sent after a child was reaped cannot
 * reach an unrelated process group (lifecycle L1).
 *
 * Linux hands out pids cyclically (pid_max is 32768 in many containers), so once a child is
 * reaped and its process group is empty, the same number can become the pid, process group id
 * and session id of a brand-new process: any detached spawn, a `setsid` command or a job of a
 * job-control shell (a `node --test` started from an interactive bash is one). A late
 * `kill(-pid)` then signals that group. Waiting for the counter to wrap is not a test, so
 * {@link spawnWithPid} steers the allocator through `/proc/sys/kernel/ns_last_pid` (the
 * mechanism CRIU uses to restore pids). That needs Linux and root (CAP_SYS_ADMIN over our pid
 * namespace); elsewhere {@link canChoosePid} is false and the suites skip those cases.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';

const NS_LAST_PID = '/proc/sys/kernel/ns_last_pid';

/** True when this process may steer pid allocation (Linux, root). */
export function canChoosePid(): boolean {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) return false;
  try {
    fs.accessSync(NS_LAST_PID, fs.constants.R_OK | fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function readLastPid(): number {
  return Number.parseInt(fs.readFileSync(NS_LAST_PID, 'utf8').trim(), 10);
}

/**
 * Spawns `sleep 30` with exactly `pid`, as the leader of a new session and process group
 * (`detached`), i.e. the shape of an unrelated group that reused a freed pid. Returns undefined
 * when that pid could not be had (still in use, or another fork in the namespace took it first
 * every time). The allocation counter is put back afterwards, so only `pid` itself is reused
 * early. The caller kills the returned child (its own handle, never by number).
 */
export function spawnWithPid(pid: number, tries = 25): ChildProcess | undefined {
  if (fs.existsSync(`/proc/${pid}`)) return undefined; // still in use
  for (let i = 0; i < tries; i++) {
    let before: number;
    try {
      before = readLastPid();
      fs.writeFileSync(NS_LAST_PID, String(pid - 1));
    } catch {
      return undefined;
    }
    const c = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    c.on('error', () => undefined);
    try {
      fs.writeFileSync(NS_LAST_PID, String(Math.max(before, readLastPid())));
    } catch {
      /* best effort */
    }
    if (c.pid === pid) return c;
    c.kill('SIGKILL');
    if (fs.existsSync(`/proc/${pid}`)) return undefined; // someone else got it
  }
  return undefined;
}

/** Resolves once `pid` is no longer in /proc (reaped), false after `ms`. */
export async function waitReaped(pid: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (fs.existsSync(`/proc/${pid}`)) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 2));
  }
  return true;
}

/** The signal that ended `child` if it exits within `ms`, else undefined (still running). */
export function exitedWithin(child: ChildProcess, ms: number): Promise<{ code: number | null; signal: NodeJS.Signals | null } | undefined> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(undefined), ms);
    child.once('exit', (code, signal) => {
      clearTimeout(t);
      resolve({ code, signal });
    });
  });
}

/** `/proc/<pid>/stat` start time (clock ticks since boot), or undefined when gone. */
export function startTicksOf(pid: number): number | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const state = fields[0];
    if (state === 'Z' || state === 'X') return undefined;
    const ticks = Number.parseInt(fields[19] ?? '', 10);
    return Number.isFinite(ticks) ? ticks : undefined;
  } catch {
    return undefined;
  }
}

/**
 * SIGKILLs `pid` only while it is still the process first seen with start time `startTicks`
 * (Linux), so test cleanup never hits a process that reused the number.
 */
export function killIfSame(pid: number, startTicks: number | undefined): void {
  if (startTicks === undefined || startTicksOf(pid) !== startTicks) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* gone */
  }
}

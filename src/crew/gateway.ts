/**
 * Gateway lifecycle: `crew start | stop | status | open | logs | exec` (08-kirocrew-integration
 * §0 item 9, §3.8; flags and READY handshake VERIFIED in 08b §2.2, helper `kc_gateway.sh`).
 *
 * - start: if `kirocrew gateway-pid` names a live holder, print status and exit 0. Else run
 *   `<KCDIR>/bin/kirocrew gateway --no-open --no-tunnel --json-ready --port <p>` detached (own
 *   session, stdin `/dev/null`, stdout/stderr → `$CS/run/gateway.{out,err}`), in `$KCDIR`, with the
 *   §3.7 env; wait up to 90 s for `^KIROCREW_READY:{…}`; store `ready.json` and `token` (0600).
 *   Prints `Kiro Crew gateway running at http://localhost:<port> (pid <n>). Open it with:
 *   kiro-claude crew open`. Timeout: last 20 lines of `gateway.err`, exit 1. `--foreground` runs it
 *   in place (systemd, containers).
 * - stop: `kirocrew stop`, wait for the holder to go, SIGTERM then (after 10 s) SIGKILL the
 *   recorded pid if still alive, then reap orphaned `kiro-claude acp` processes whose environ has
 *   `KIROCREW_SPAWNED=1` and the same `HOME`, and retire what is left of the gateway's own process
 *   tree (its history-index worker; {@link retireGatewayTree}); remove `run/token` (and `ready.json`, which holds the
 *   token too, and the token in `gateway.out`'s READY line). Prints `Stopped (pid <n>); <k> orphan
 *   agent process(es) reaped`. The gateway and its tree are known by pid and start time from a
 *   snapshot taken while it still ran, so a process that reuses one of their pids (or the
 *   gateway's process group id) once they are gone is never signalled nor taken for the gateway.
 *   The gateway's pid is the one `gateway-pid` names; for a `held` lock (KiroCrew cannot name its
 *   holder) it is `ready.json`'s only while that file provably still names the gateway `crew start`
 *   recorded there (same boot and start time; {@link gatewayRecord}). Otherwise nothing is
 *   signalled: stop waits for the lock to be released, or for `gateway-pid` to name the holder,
 *   which is signalled only when it provably ran before the stop (not a gateway restarted since).
 *   K7: a gateway that crashed while a child keeps the lock it inherited (`gateway-pid`: `held`,
 *   or `indeterminate` on Linux, where KiroCrew finds the dead acquirer in /proc/locks) is gone
 *   while its pid names nothing. When `ready.json` proves that (this boot, its start time, it led
 *   its group, no process has its pid), the members it left in its process group that carry this
 *   crew's HOME and KIROCREW_KIRO_BIN and started after it are retired (SIGTERM, then SIGKILL;
 *   {@link crashedGateway}), and the stop says so: `Stopped (pid <n>, which had already exited;
 *   <m> leftover process(es) of its process group retired); <k> orphan agent process(es) reaped`.
 *   A lock that is still held, or still `indeterminate`, after that (its holder may be outside the
 *   group) is reported with all that was signalled, exit 1 ({@link reportLockKept}).
 *   Every signal is identity-checked by start time right before it is sent ({@link CrewSys.kill}).
 * - `--approval auto` is passed as KiroCrew's `yolo` (its choices are reads|yolo|interactive).
 * - Every command uses one gateway env (context.gatewayEnvFor): a `--kiro-bin` given to the
 *   start that launched the running gateway is used by exec/stop/status/doctor too.
 * - status: `gateway-pid` plus cookie-authenticated `/api/status`, `/api/kiro-prerequisite`,
 *   `/api/acp-backends`. Exit 0 running and ready, 3 stopped, 4 running but not ready. A pid is
 *   shown from `ready.json` only while it provably is the running gateway's (as for stop), and its
 *   port is not used once it provably is not ({@link gatewayRecord}).
 * - open: `kirocrew token --port <p> --ttl <ttl>` → open with `xdg-open`/`open` unless `--print`;
 *   warns `This link signs you in; do not share it.`; not running: exit 3.
 * - logs: tail `$CS/run/gateway.err` and `$KIROCREW_HOME/gateway.log` (`--acp`: the newest
 *   `$KIROCREW_HOME/scratch/runtime-*\/kiro-log/kiro-chat.log`), `-f` follows.
 * - exec: `<KCDIR>/bin/kirocrew <args…>` with the §3.7 env; returns the child's exit code.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { backendInstalled, backendRow, GatewayAuthError, GatewayClient, prerequisiteProblems, summarizePrerequisite, type PrerequisiteSummary } from './api.js';
import { gatewayEnvFor, kirocrewFor, loadState, READY_IDENTITY_KEY, readReady, readToken, type CrewCtx, type ReadyRecord } from './context.js';
import { gatewayRunning, tokenFromUrl, type GatewayHolder, type KiroCrewCli } from './kirocrew.js';
import { kirocrewHome, kirocrewLauncher } from './paths.js';
import { lastLines, type ProcessInfo } from './runner.js';
import { writeState, type CrewState } from './state.js';
import { writeFileAtomic } from '../util/fsx.js';

export const READY_PREFIX = 'KIROCREW_READY:';

/** Parses the first `KIROCREW_READY:{…}` line of the gateway's stdout. */
export function parseReadyLine(text: string): Record<string, unknown> | undefined {
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith(READY_PREFIX)) continue;
    try {
      const v = JSON.parse(line.slice(READY_PREFIX.length)) as unknown;
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function readFileSafe(p: string): string {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

function exitCodeOf(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  if (signal) {
    const n = os.constants.signals[signal];
    return typeof n === 'number' ? 128 + n : 1;
  }
  return 1;
}

function printWarnings(c: CrewCtx, warnings: string[]): void {
  for (const w of warnings) c.err(`warning: ${w}`);
}

// ───────────────────────────── start ─────────────────────────────

export interface StartOptions {
  port?: number | 'auto';
  approval?: string;
  noCrons?: boolean;
  testMode?: boolean;
  foreground?: boolean;
  env?: Record<string, string>;
  kiroBin?: string;
}

export async function crewStart(c: CrewCtx, o: StartOptions): Promise<number> {
  const state = loadState(c);
  if (!state) return 1;
  const launcher = kirocrewLauncher(state.kirocrew.dir);
  if (!fs.existsSync(launcher)) {
    c.err(`kiro-claude: Kiro Crew is not available at ${state.kirocrew.dir} (bin/kirocrew is missing). Run: kiro-claude crew setup`);
    return 1;
  }
  if (!o.kiroBin && !fs.existsSync(state.shim || c.paths.shim)) {
    c.err(`kiro-claude: the kiro-cli shim ${state.shim || c.paths.shim} is missing. Run: kiro-claude crew setup`);
    return 1;
  }
  const override = o.kiroBin && o.kiroBin !== state.shim ? o.kiroBin : undefined;
  const { kc, gw } = kirocrewFor(c, state, { extra: o.env, kiroBin: override ?? (state.shim || c.paths.shim) });
  printWarnings(c, gw.warnings);

  const holder = await kc.gatewayPid();
  if (gatewayRunning(holder)) {
    // crew.json keeps describing the gateway that runs (its kiro-cli override is unchanged).
    await printStatus(c, state, kc, holder, false);
    return 0;
  }
  // Remember a foreign --kiro-bin for the gateway started now: every later crew command uses it
  // (context.gatewayEnvFor) and doctor skips the probe-contract rows for it (08 §5.1 A2).
  if (override !== state.kiroBinOverride) {
    state.kiroBinOverride = override;
    writeState(c.paths.stateFile, state);
  }
  // Nothing holds the gateway lock: run files left by an earlier gateway (its dashboard token,
  // its pid and port) are stale. Drop them so status/stop/open never act on a dead gateway's data.
  removeRunSecrets(c);
  const port = o.port ?? state.port;
  const args = ['gateway', '--no-open', '--no-tunnel', '--json-ready', '--port', String(port)];
  if (o.approval) args.push('--approval', o.approval);
  if (o.noCrons) args.push('--no-crons');
  if (o.testMode) args.push('--test-mode');

  if (o.foreground) {
    const r = await kc.run(args, {
      stdio: 'inherit',
      streams: { stdin: c.cli.stdin, stdout: c.cli.stdout, stderr: c.cli.stderr },
      timeoutMs: 0,
      forwardSignals: true,
    });
    if (r.error) {
      c.err(`kiro-claude: cannot run ${launcher}: ${r.error}`);
      return 1;
    }
    return exitCodeOf(r.code, r.signal);
  }

  fs.mkdirSync(c.paths.runDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(c.paths.runDir, 0o700); // run files hold the dashboard token
  } catch {
    // best effort
  }
  let pid: number;
  try {
    ({ pid } = c.deps.runner.spawnDetached(launcher, args, {
      cwd: state.kirocrew.dir,
      env: gw.env,
      stdoutFile: c.paths.gatewayOut,
      stderrFile: c.paths.gatewayErr,
    }));
  } catch (e) {
    c.err(`kiro-claude: cannot start the Kiro Crew gateway: ${(e as Error).message}`);
    return 1;
  }
  // Read now, while the pid is surely our child's (the launcher execs the gateway in place).
  const spawnStart = c.deps.sys.startTime(pid);

  const deadline = c.deps.sys.now() + c.deps.startTimeoutMs;
  let ready: Record<string, unknown> | undefined;
  let exited = false;
  for (;;) {
    ready = parseReadyLine(readFileSafe(c.paths.gatewayOut));
    if (ready) break;
    if (!c.deps.sys.isAlive(pid)) {
      // One last read: the line may have landed just before exit.
      ready = parseReadyLine(readFileSafe(c.paths.gatewayOut));
      exited = !ready;
      break;
    }
    if (c.deps.sys.now() >= deadline) break;
    await c.deps.sys.sleep(c.deps.pollMs);
  }
  if (!ready) {
    const tail = lastLines(readFileSafe(c.paths.gatewayErr), 20);
    c.err(
      exited
        ? `kiro-claude: the Kiro Crew gateway exited before it was ready. Last lines of ${c.paths.gatewayErr}:`
        : `kiro-claude: the Kiro Crew gateway did not become ready within ${Math.round(c.deps.startTimeoutMs / 1000)} s. Last lines of ${c.paths.gatewayErr}:`,
    );
    for (const l of tail) c.err(`  ${l}`);
    if (!exited) c.err(`It may still be starting (pid ${pid}); check with: kiro-claude crew status, or stop it with: kiro-claude crew stop`);
    return 1;
  }
  const realPid = typeof ready.pid === 'number' ? ready.pid : pid;
  // A pid outlives its process (this file can outlive the gateway: a crash, a reboot), so the
  // record also says which process it was: crew stop/status act on its pid only while it is that one.
  const startTime = realPid === pid ? spawnStart : c.deps.sys.startTime(realPid);
  const bootId = startTime !== undefined ? c.deps.sys.bootId() : undefined;
  // Its process group (it leads one: spawnDetached is setsid()), read back while the pid still has
  // that start time, so crew stop can retire what a crashed gateway leaves in it (K7).
  let pgid = startTime !== undefined ? c.deps.sys.processGroup(realPid) : undefined;
  if (pgid !== undefined && c.deps.sys.startTime(realPid) !== startTime) pgid = undefined;
  const identity = { pid: realPid, ...(startTime !== undefined ? { startTime } : {}), ...(bootId ? { bootId } : {}), ...(pgid !== undefined ? { pgid } : {}) };
  writeFileAtomic(c.paths.readyFile, `${JSON.stringify({ ...ready, pid: realPid, [READY_IDENTITY_KEY]: identity })}\n`, { mode: 0o600 });
  const token = typeof ready.token === 'string' ? ready.token : '';
  if (token) writeFileAtomic(c.paths.tokenFile, `${token}\n`, { mode: 0o600 });
  const realPort = typeof ready.port === 'number' ? ready.port : port;
  c.out(`Kiro Crew gateway running at http://localhost:${realPort} (pid ${realPid}). Open it with: kiro-claude crew open`);
  return 0;
}

// ───────────────────────────── stop ─────────────────────────────

export interface StopOptions {
  timeoutSec?: number;
}

/** `kiro-claude acp` processes left behind by a stopped gateway (08 §3.8 stop). */
export function findOrphanAgents(procs: ProcessInfo[], opts: { home: string; entry?: string; shim?: string; selfPid: number }): ProcessInfo[] {
  const names = new Set(['kiro-claude', 'kiro-claude.js']);
  return procs.filter((p) => {
    if (p.pid === opts.selfPid) return false;
    if (!p.env || p.env.KIROCREW_SPAWNED !== '1' || p.env.HOME !== opts.home) return false;
    if (!p.argv.includes('acp')) return false;
    return p.argv.some((a) => a === opts.entry || a === opts.shim || names.has(path.basename(a)));
  });
}

/** This process and its ancestors (by ppid): never signalled by `crew stop`. */
function selfAndAncestors(procs: ProcessInfo[], selfPid: number): Set<number> {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const out = new Set<number>();
  for (let p: number | undefined = selfPid; p !== undefined && p > 1 && !out.has(p); p = byPid.get(p)?.ppid) out.add(p);
  return out;
}

/**
 * The processes of the gateway's tree: `root`'s descendants (by ppid) plus, when `leader` (the
 * gateway led its own process group, as `crew start` runs it detached), every other member of
 * group `root` — so children already re-parented after the gateway exited are found too. Never
 * this process or its ancestors (a `crew stop` run from inside a crew agent).
 */
export function gatewayTree(procs: ProcessInfo[], root: number, selfPid: number, leader: boolean): ProcessInfo[] {
  const spare = selfAndAncestors(procs, selfPid);
  const children = new Map<number, ProcessInfo[]>();
  for (const p of procs) if (p.ppid !== undefined) (children.get(p.ppid) ?? children.set(p.ppid, []).get(p.ppid)!).push(p);
  const out = new Map<number, ProcessInfo>();
  const walk = (pid: number): void => {
    for (const ch of children.get(pid) ?? []) {
      if (out.has(ch.pid)) continue;
      out.set(ch.pid, ch);
      walk(ch.pid);
    }
  };
  walk(root);
  if (leader) for (const p of procs) if (p.pgid === root && p.pid !== root) out.set(p.pid, p);
  return [...out.values()].filter((p) => !spare.has(p.pid));
}

/** The same process: same pid and start time (same argv where a start time is unknown). */
function sameProcess(a: ProcessInfo, b: ProcessInfo): boolean {
  if (a.pid !== b.pid) return false;
  if (a.startTime !== undefined && b.startTime !== undefined) return a.startTime === b.startTime;
  return a.argv.join('\0') === b.argv.join('\0');
}

/** The gateway `crew stop` stops, as seen before the stop (while it still ran). */
interface GatewaySnapshot {
  pid: number;
  startTime?: number;
  /** It leads its own process group (`crew start` runs it detached; not `--foreground`). */
  leader: boolean;
  /** Its HOME and KIROCREW_KIRO_BIN, which every process it starts inherits. */
  home: string;
  kiroBin?: string;
  /** Its tree then ({@link gatewayTree}). */
  tree: ProcessInfo[];
}

/**
 * The gateway still runs: its pid is alive and still names the process of the snapshot. Its start
 * time must read back equal, after the liveness check: a pid whose stat cannot be read (gone
 * meanwhile, or another user's process that `hidepid` hides while signal 0 says EPERM) is not the
 * gateway, whose stat this process could read; and where none could be read for the gateway (no
 * /proc, a hidden holder), a pid that shows one now is another process (as for {@link CrewSys.kill}).
 */
function gatewayAlive(c: CrewCtx, g: { pid: number; startTime?: number }): boolean {
  if (!c.deps.sys.isAlive(g.pid)) return false;
  return c.deps.sys.startTime(g.pid) === g.startTime;
}

/**
 * SIGTERM the `targets` that still run (same pid and start time), then SIGKILL those left after
 * the grace, and wait (up to 2 s) for those to be gone. The set is fixed: nothing is added while waiting, a target whose pid another process
 * takes meanwhile is dropped, and each signal checks the start time once more ({@link CrewSys.kill}).
 * Never this process or its ancestors. Returns how many had to be signalled, and a check of
 * which of them still run.
 */
async function retireProcesses(c: CrewCtx, targets: readonly ProcessInfo[]): Promise<{ signalled: number; running: () => ProcessInfo[] }> {
  const running = (): ProcessInfo[] => {
    const list = c.deps.sys.listProcesses();
    const spare = selfAndAncestors(list, c.deps.sys.pid);
    const cur = new Map(list.map((p) => [p.pid, p]));
    return targets.filter((t) => !spare.has(t.pid) && cur.has(t.pid) && sameProcess(t, cur.get(t.pid)!));
  };
  let left = running();
  const signalled = left.length;
  if (signalled === 0) return { signalled, running };
  for (const p of left) c.deps.sys.kill(p.pid, 'SIGTERM', p.startTime);
  const deadline = c.deps.sys.now() + c.deps.killGraceMs;
  while ((left = running()).length > 0 && c.deps.sys.now() < deadline) await c.deps.sys.sleep(c.deps.pollMs);
  for (const p of left) c.deps.sys.kill(p.pid, 'SIGKILL', p.startTime);
  // a SIGKILLed process is gone only once it has run its exit (ms on a loaded machine): the stop
  // is reported, and the lock such a child kept is free, only after that
  if (left.length > 0) await waitGone(c, () => running().length > 0, 2000);
  return { signalled, running };
}

/**
 * After the gateway has exited: its children that are still running (KiroCrew's history-index
 * worker and multiprocessing's resource tracker retire themselves up to 5 s after an
 * `os._exit` shutdown) get SIGTERM — what KiroCrew's own supervisor sends them — then SIGKILL
 * after the grace. The set is fixed once, now: the processes of the snapshot's tree still running
 * (same pid and start time) plus, for a gateway that led its process group, the members of that
 * group it started after the snapshot (re-parented now, so found by group, and carrying its HOME
 * and KIROCREW_KIRO_BIN) — unless its pid is taken already, which means the group id may be
 * another process's too. Nothing is added while waiting, and the dead gateway's pid is never
 * walked: whatever takes that pid (or group id) later, of this crew or another, is left alone.
 * Returns how many processes had to be signalled.
 */
async function retireGatewayTree(c: CrewCtx, g: GatewaySnapshot): Promise<number> {
  const now = c.deps.sys.listProcesses();
  const byPid = new Map(now.map((p) => [p.pid, p]));
  const targets = new Map<number, ProcessInfo>();
  for (const k of g.tree) {
    const p = byPid.get(k.pid);
    if (p && sameProcess(k, p)) targets.set(p.pid, p);
  }
  if (g.leader && g.kiroBin !== undefined && !byPid.has(g.pid)) {
    for (const p of now) {
      if (p.pgid === g.pid && p.pid !== g.pid && p.env?.HOME === g.home && p.env.KIROCREW_KIRO_BIN === g.kiroBin) targets.set(p.pid, p);
    }
  }
  if (targets.size === 0) return 0;
  return (await retireProcesses(c, [...targets.values()])).signalled;
}

/** What `crew stop` retired of a gateway that had exited before the stop ({@link crashedGateway}). */
interface CrashedRetire {
  pid: number;
  /** Leftover members of its process group that had to be signalled. */
  retired: number;
  /** Those still running after the SIGKILL (and a short wait). */
  left: ProcessInfo[];
}

/**
 * The gateway `crew start` recorded in `run/ready.json`, when it provably has exited (a crash:
 * KiroCrew's history-index worker or another child can keep the gateway lock it inherited, so
 * `gateway-pid` answers `held`, or `indeterminate`, and names no holder), with the members it left
 * in its process group. Provable only from a record `crew start` wrote on this boot (pid, start
 * time, boot id) for a gateway that led its own group (pgid = pid), and only while no process
 * has that pid: a pid number stays reserved while any process still uses it as its process group
 * id, so group `<pid>` is then the gateway's own, unless the group emptied and a later process
 * that took the pid made one again. Which is why a member must also carry this crew's HOME and
 * KIROCREW_KIRO_BIN (every process the gateway starts inherits them) and have started after the
 * gateway: whatever else is in that group, of another crew, another user or older than the
 * gateway, is left alone, as are this process and its ancestors (a stop run from a crew agent).
 */
function crashedGateway(c: CrewCtx, gwEnv: NodeJS.ProcessEnv): { pid: number; leftovers: ProcessInfo[] } | undefined {
  const rec = readReady(c.paths);
  const g = rec?.pid;
  const since = rec?.startTime;
  if (g === undefined || since === undefined || rec?.bootId === undefined || rec.pgid !== g) return undefined;
  const boot = c.deps.sys.bootId();
  if (boot === undefined || boot !== rec.bootId) return undefined;
  const home = gwEnv.HOME ?? c.home;
  const kiroBin = gwEnv.KIROCREW_KIRO_BIN;
  if (kiroBin === undefined) return undefined;
  const procs = c.deps.sys.listProcesses();
  // its pid taken (by a later process, or one this process cannot see: EPERM): not provably gone
  if (procs.some((p) => p.pid === g) || c.deps.sys.isAlive(g)) return undefined;
  const spare = selfAndAncestors(procs, c.deps.sys.pid);
  const leftovers = procs.filter(
    (p) => p.pgid === g && p.pid !== g && !spare.has(p.pid) && p.env?.HOME === home && p.env.KIROCREW_KIRO_BIN === kiroBin && p.startTime !== undefined && p.startTime >= since,
  );
  return { pid: g, leftovers };
}

/** Retires what a crashed gateway left in its process group ({@link crashedGateway}); undefined when there is nothing. */
async function retireCrashedGateway(c: CrewCtx, gwEnv: NodeJS.ProcessEnv): Promise<CrashedRetire | undefined> {
  const found = crashedGateway(c, gwEnv);
  if (!found || found.leftovers.length === 0) return undefined;
  const { signalled, running } = await retireProcesses(c, found.leftovers);
  if (signalled === 0) return undefined;
  return { pid: found.pid, retired: signalled, left: running() };
}

/** `N leftover process(es) of its process group retired` (and which still run after the SIGKILL). */
function retiredText(r: CrashedRetire, whose = 'its process group'): string {
  const still = r.left.length > 0 ? `, ${r.left.length} of them still running after SIGKILL (pid ${r.left.map((p) => p.pid).join(', ')})` : '';
  return `${r.retired} leftover process(es) of ${whose} retired${still}`;
}

/**
 * A failed stop's account of a gateway it did not signal: `nothing was signalled`, unless it did
 * signal something else (a crashed gateway's leftovers, orphan agents): then `it was not
 * signalled (…what was…)`.
 */
function notSignalled(crashed: CrashedRetire | undefined, reaped: number): string {
  const what = [
    ...(crashed ? [`run/ready.json named pid ${crashed.pid}, which had already exited: ${retiredText(crashed)}`] : []),
    ...(reaped > 0 ? [`${reaped} orphan agent process(es) reaped`] : []),
  ];
  return what.length > 0 ? `it was not signalled (${what.join('; ')})` : 'nothing was signalled';
}

/**
 * The report of a crashed gateway's retire after which the lock is still not free (`after`:
 * `gateway-pid` then): what was signalled, all of it (its leftovers and the orphan agents reaped).
 */
function reportLockKept(c: CrewCtx, crashed: CrashedRetire, reaped: number, after: GatewayHolder): number {
  const lock = after.holder === 'indeterminate' ? `may still be held (kirocrew gateway-pid: indeterminate: ${after.reason})` : `is still held (kirocrew gateway-pid: ${after.holder})`;
  const orphans = reaped > 0 ? `; ${reaped} orphan agent process(es) reaped` : '';
  c.err(`kiro-claude: the Kiro Crew gateway lock ${lock}. run/ready.json named pid ${crashed.pid}, which had already exited: ${retiredText(crashed)}${orphans}. Nothing else names a holder, so nothing else was signalled.`);
  return 1;
}

/**
 * The gateway as it is now: pid `pid`, its start time, group leadership, env and tree. With
 * `expectStart` (the start time a record proved for `pid` a moment ago), a pid that names another
 * process by now is not the gateway: the snapshot then has no tree and never reads as alive.
 */
function snapshotGateway(c: CrewCtx, pid: number, gwEnv: NodeJS.ProcessEnv, expectStart?: number): GatewaySnapshot {
  const procs = c.deps.sys.listProcesses();
  const gwProc = procs.find((p) => p.pid === pid);
  const startTime = gwProc?.startTime ?? c.deps.sys.startTime(pid);
  if (expectStart !== undefined && startTime !== expectStart) {
    return { pid, startTime: expectStart, leader: false, home: c.home, kiroBin: gwEnv.KIROCREW_KIRO_BIN, tree: [] };
  }
  const leader = gwProc?.pgid === pid;
  return {
    pid,
    startTime,
    leader,
    home: gwProc?.env?.HOME ?? c.home,
    kiroBin: gwProc?.env ? gwProc.env.KIROCREW_KIRO_BIN : gwEnv.KIROCREW_KIRO_BIN,
    tree: gatewayTree(procs, pid, c.deps.sys.pid, leader),
  };
}

/** What `run/ready.json` tells about the running gateway ({@link gatewayRecord}). */
export interface GatewayRecordView {
  /**
   * The gateway's pid: the holder `gateway-pid` names, else (a `held` lock) the record's pid when
   * it provably still is that gateway. Undefined when nothing names it: never guessed.
   */
  pid?: number;
  /** The recorded start time of that pid, when the record proved it. */
  startTime?: number;
  /** The record's port, unless the record is provably another (earlier) gateway's; else crew.json's. */
  port: number;
  /**
   * `same`: the record is the running gateway's; `other`: provably not (its pid is gone, names
   * another process now, or is not the holder `gateway-pid` names); `unknown`: this process cannot
   * tell (no /proc, another user's process); `none`: there is no record.
   */
  verdict: 'same' | 'other' | 'unknown' | 'none';
  record?: ReadyRecord;
}

/** argv of KiroCrew's gateway as `crew start` runs it (`… kirocrew gateway … --json-ready …`). */
function isGatewayArgv(argv: readonly string[]): boolean {
  return argv.includes('gateway') && argv.includes('--json-ready');
}

/**
 * Whether `rec` (run/ready.json) still describes the running gateway. `named` is the holder pid
 * `gateway-pid` gave, if any. A record with an identity (crew start writes one: pid, start time,
 * boot) is that process only while the pid's boot and start time read back equal. A record without
 * one (an older kiro-claude's, or no /proc at READY) is checked against the process itself: a live
 * KiroCrew `gateway --json-ready` with the gateway env's HOME and KIROCREW_KIRO_BIN.
 */
function recordVerdict(c: CrewCtx, state: CrewState, rec: ReadyRecord, named: number | undefined): 'same' | 'other' | 'unknown' {
  const pid = rec.pid;
  if (pid === undefined) return 'unknown';
  if (named !== undefined && pid !== named) return 'other';
  if (!c.deps.sys.isAlive(pid)) return 'other';
  if (rec.startTime !== undefined) {
    if (rec.bootId !== undefined) {
      const boot = c.deps.sys.bootId();
      if (boot === undefined) return 'unknown';
      if (boot !== rec.bootId) return 'other';
    }
    const st = c.deps.sys.startTime(pid);
    if (st === undefined) return 'unknown';
    return st === rec.startTime ? 'same' : 'other';
  }
  if (named !== undefined) return 'same'; // the holder KiroCrew names is the pid the record names
  const p = c.deps.sys.listProcesses().find((x) => x.pid === pid);
  if (!p) return 'unknown';
  if (!isGatewayArgv(p.argv)) return 'other';
  if (!p.env) return 'unknown';
  const gw = gatewayEnvFor(c, state).env;
  return p.env.HOME === (gw.HOME ?? c.home) && p.env.KIROCREW_KIRO_BIN === gw.KIROCREW_KIRO_BIN ? 'same' : 'other';
}

/**
 * The running gateway's pid and port as `run/ready.json` and `gateway-pid` (`holder`) tell them.
 * The file survives its gateway (a crash, a reboot, a gateway started some other way), and a pid
 * is reused, so its pid is never taken on its own word: for a `held` lock it is used only when
 * {@link recordVerdict} proves it, and the file's port is ignored once it is provably stale.
 */
export function gatewayRecord(c: CrewCtx, state: CrewState, holder: GatewayHolder): GatewayRecordView {
  const record = readReady(c.paths);
  const named = holder.holder === 'process' ? holder.pid : undefined;
  const verdict = record ? recordVerdict(c, state, record, named) : 'none';
  const proven = holder.holder === 'held' && verdict === 'same' ? record?.pid : undefined;
  return {
    pid: named ?? proven,
    startTime: proven !== undefined ? record?.startTime : undefined,
    port: verdict !== 'other' && record?.port !== undefined ? record.port : state.port,
    verdict,
    record,
  };
}

/**
 * Whether the holder `pid` that `gateway-pid` names during a stop's wait is a process that ran
 * before the stop (`before`, listed then): `before` with its start time, `after` (provably started
 * since: a gateway restarted by a supervisor, holding the lock the stopped one released), or
 * `unknown` (no /proc, an unreadable stat). Only a `before` holder may be signalled.
 */
function ranBeforeStop(c: CrewCtx, before: readonly ProcessInfo[], pid: number): { when: 'before'; startTime: number } | { when: 'after' | 'unknown' } {
  const st = c.deps.sys.startTime(pid);
  if (st === undefined || before.length === 0) return { when: 'unknown' };
  const prior = before.find((p) => p.pid === pid);
  if (!prior) return { when: 'after' };
  if (prior.startTime === undefined) return { when: 'unknown' };
  return prior.startTime === st ? { when: 'before', startTime: st } : { when: 'after' };
}

async function waitGone(c: CrewCtx, alive: () => boolean, ms: number): Promise<boolean> {
  const deadline = c.deps.sys.now() + ms;
  while (alive()) {
    if (c.deps.sys.now() >= deadline) return false;
    await c.deps.sys.sleep(c.deps.pollMs);
  }
  return true;
}

function reapOrphans(c: CrewCtx, state: CrewState): number {
  const orphans = findOrphanAgents(c.deps.sys.listProcesses(), {
    home: c.home,
    entry: state.entry || undefined,
    shim: state.shim || undefined,
    selfPid: c.deps.sys.pid,
  });
  let n = 0;
  for (const p of orphans) if (c.deps.sys.kill(p.pid, 'SIGTERM', p.startTime)) n++;
  return n;
}

/**
 * Removes `run/token` and `run/ready.json` (both hold the dashboard token, valid up to 20 h) and
 * blanks the token in `gateway.out`'s READY line, so nothing of a stopped gateway's credential
 * is left behind (08 §3.8 stop: "Remove run/token").
 */
function removeRunSecrets(c: CrewCtx): void {
  for (const f of [c.paths.tokenFile, c.paths.readyFile]) fs.rmSync(f, { force: true });
  redactReadyToken(c.paths.gatewayOut);
}

/** Rewrites READY lines of a (stopped) gateway's stdout file without their token. */
export function redactReadyToken(file: string): void {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  if (!text.includes(READY_PREFIX)) return;
  const out = text
    .split('\n')
    .map((line) => {
      if (!line.startsWith(READY_PREFIX)) return line;
      const j = parseReadyLine(line);
      if (!j || !('token' in j)) return line;
      return `${READY_PREFIX}${JSON.stringify({ ...j, token: '<removed>' })}`;
    })
    .join('\n');
  if (out !== text) {
    try {
      writeFileAtomic(file, out, { mode: 0o600 });
    } catch {
      // best effort
    }
  }
}

export async function crewStop(c: CrewCtx, o: StopOptions = {}): Promise<number> {
  const state = loadState(c);
  if (!state) return 1;
  const { kc, gw: gwEnv } = kirocrewFor(c, state);
  const holder = fs.existsSync(kc.launcher) ? await kc.gatewayPid() : ({ holder: 'nobody' } as GatewayHolder);
  if (!gatewayRunning(holder)) {
    // `indeterminate` is also KiroCrew's answer (on Linux) for a lock that a crashed gateway's
    // child keeps (K7); `nobody` can still leave such a child running.
    const crashed = await retireCrashedGateway(c, gwEnv.env);
    const reaped = reapOrphans(c, state);
    removeRunSecrets(c);
    if (crashed) {
      // `indeterminate` is no proof that the retire freed the lock (its holder may be outside the
      // gateway's process group): ask again, and say so when it is still not free.
      const after = holder.holder === 'indeterminate' ? await kc.gatewayPid() : holder;
      if (after.holder === 'indeterminate' || after.holder === 'held') return reportLockKept(c, crashed, reaped, after);
      return reportCrashed(c, crashed, reaped);
    }
    c.out(reaped > 0 ? `Kiro Crew gateway is not running; ${reaped} orphan agent process(es) reaped` : 'Kiro Crew gateway is not running.');
    return 0;
  }
  // The pid `gateway-pid` names, else (a `held` lock) ready.json's only while it provably is still
  // that gateway: a stale file's pid may be anyone's by now, and is never signalled.
  const rec = gatewayRecord(c, state, holder);
  let pid = rec.pid;
  // the gateway and its own children, seen while it still runs (they are re-parented once it exits)
  let snap = pid !== undefined ? snapshotGateway(c, pid, gwEnv.env, rec.startTime) : undefined;
  const alive = (): boolean => snap !== undefined && gatewayAlive(c, snap);
  // With no pid to watch: what runs before the stop, to tell the held gateway from a later holder.
  const before = snap ? [] : c.deps.sys.listProcesses();
  const stopRun = await kc.stop();
  if (stopRun.code !== 0 && c.cli.verbosity > 0) c.err(`kirocrew stop: ${(stopRun.stderr || stopRun.stdout).trim()}`);
  // K7: a held lock and a record of a gateway that has exited (a crash) — what it left in its
  // process group may be what keeps the lock; retire that before waiting for the lock to go.
  const crashed = !snap && holder.holder === 'held' ? await retireCrashedGateway(c, gwEnv.env) : undefined;
  const deadline = c.deps.sys.now() + (o.timeoutSec ?? 30) * 1000;
  let gone = false;
  let unproven: number | undefined;
  if (!snap) {
    // Nothing names the gateway's pid: signal nothing, and wait for the lock to be released, or for
    // `gateway-pid` to name its holder. That pid is watched (and signalled after the timeout) only
    // when it already ran before the stop; one started since holds a lock the held gateway released.
    for (;;) {
      const h = await kc.gatewayPid();
      if (!gatewayRunning(h)) {
        gone = true;
        break;
      }
      if (h.holder === 'process') {
        const seen = ranBeforeStop(c, before, h.pid);
        if (seen.when === 'before') {
          pid = h.pid;
          snap = snapshotGateway(c, pid, gwEnv.env, seen.startTime);
          break;
        }
        if (seen.when === 'after') {
          gone = true;
          break;
        }
        unproven = h.pid;
      }
      if (c.deps.sys.now() >= deadline) break;
      await c.deps.sys.sleep(c.deps.pollMs);
    }
  }
  if (snap && !gone) gone = await waitGone(c, alive, Math.max(0, deadline - c.deps.sys.now()));
  if (!gone && snap) {
    c.deps.sys.kill(snap.pid, 'SIGTERM', snap.startTime);
    if (!(await waitGone(c, alive, c.deps.killGraceMs))) {
      c.deps.sys.kill(snap.pid, 'SIGKILL', snap.startTime);
      await waitGone(c, alive, 2000);
    }
  }
  // decided once: a process that takes the pid later (during the retire wait) is not the gateway
  const exited = snap ? !alive() : gone;
  const reaped = reapOrphans(c, state);
  if (snap && exited) await retireGatewayTree(c, snap);
  removeRunSecrets(c);
  if (!exited) {
    if (snap) c.err(`kiro-claude: the Kiro Crew gateway (pid ${pid}) did not exit.`);
    else if (unproven !== undefined) {
      c.err(`kiro-claude: the Kiro Crew gateway did not exit. kirocrew gateway-pid named pid ${unproven} only after the stop, and crew stop cannot tell it from a gateway started since, so ${notSignalled(crashed, reaped)}. To stop it, run: kiro-claude crew stop`);
    } else if (crashed) {
      return reportLockKept(c, crashed, reaped, holder);
    } else {
      const stale = rec.verdict === 'other' && rec.record?.pid !== undefined ? `; run/ready.json named pid ${rec.record.pid}, which is no longer that gateway` : '';
      c.err(`kiro-claude: the Kiro Crew gateway did not exit. Nothing names its pid (kirocrew gateway-pid: ${holder.holder}${stale}), so ${notSignalled(undefined, reaped)}.`);
    }
    return 1;
  }
  if (crashed && !snap) return reportCrashed(c, crashed, reaped);
  const earlier = crashed ? `; ${retiredText(crashed, `the process group of an earlier gateway (pid ${crashed.pid}, which had already exited)`)}` : '';
  c.out(`Stopped (pid ${pid ?? 'unknown'}); ${reaped} orphan agent process(es) reaped${earlier}`);
  return 0;
}

/**
 * Reports a stop that found the gateway already gone and retired what it had left (K7):
 * `Stopped (pid <n>, which had already exited; <m> leftover process(es) of its process group
 * retired); <k> orphan agent process(es) reaped`, exit 0; exit 1 when some survived the SIGKILL.
 */
function reportCrashed(c: CrewCtx, crashed: CrashedRetire, reaped: number): number {
  const line = `Stopped (pid ${crashed.pid}, which had already exited; ${retiredText(crashed)}); ${reaped} orphan agent process(es) reaped`;
  if (crashed.left.length === 0) {
    c.out(line);
    return 0;
  }
  c.err(`kiro-claude: ${line}`);
  return 1;
}

// ───────────────────────────── status ─────────────────────────────

export interface StatusReport {
  running: boolean;
  ready: boolean;
  holder: GatewayHolder['holder'];
  pid?: number;
  port?: number;
  url?: string;
  version?: string;
  reason?: string;
  prerequisite?: PrerequisiteSummary;
  backends: { main: string; members: string; mainInstalled?: boolean; membersInstalled?: boolean };
  kiroBin: string;
}

/**
 * A logged-in dashboard client: the stored token (`run/token`, else `ready.json`), re-minted with
 * `kirocrew token` when missing or refused (a restarted gateway or `kirocrew logout`).
 */
export async function gatewayApiClient(c: CrewCtx, kc: KiroCrewCli, port: number): Promise<GatewayClient> {
  let token = readToken(c.paths) ?? readReady(c.paths)?.token;
  const mint = async (): Promise<string | undefined> => {
    const { url } = await kc.token(port, '1h');
    const t = url ? tokenFromUrl(url) : undefined;
    if (t) writeFileAtomic(c.paths.tokenFile, `${t}\n`, { mode: 0o600 });
    return t;
  };
  if (!token) token = await mint();
  if (!token) throw new Error('no dashboard token (kirocrew token failed)');
  let client = new GatewayClient({ port, token, http: c.deps.http });
  try {
    await client.login();
  } catch (e) {
    if (!(e instanceof GatewayAuthError)) throw e;
    const fresh = await mint();
    if (!fresh) throw e;
    client = new GatewayClient({ port, token: fresh, http: c.deps.http });
    await client.login();
  }
  return client;
}

export async function gatherStatus(c: CrewCtx, state: CrewState, kc: KiroCrewCli, holderIn?: GatewayHolder): Promise<StatusReport> {
  const holder = holderIn ?? (await kc.gatewayPid());
  const report: StatusReport = {
    running: gatewayRunning(holder),
    ready: false,
    holder: holder.holder,
    backends: { main: 'kiro', members: state.members.backend },
    kiroBin: state.kiroBinOverride ?? state.shim,
  };
  if (!report.running) {
    report.reason = holder.holder === 'indeterminate' ? holder.reason : 'stopped';
    return report;
  }
  const rec = gatewayRecord(c, state, holder);
  report.pid = rec.pid;
  report.port = rec.port;
  report.url = `http://localhost:${report.port}`;
  try {
    const client = await gatewayApiClient(c, kc, report.port);
    const st = await client.get('/api/status');
    const v = st.json && typeof st.json === 'object' ? (st.json as { version?: unknown }).version : undefined;
    if (typeof v === 'string') report.version = v;
    const pre = await client.get('/api/kiro-prerequisite');
    report.prerequisite = summarizePrerequisite(pre.json);
    const be = await client.get('/api/acp-backends');
    report.backends.mainInstalled = backendInstalled(backendRow(be.json, 'kiro'));
    if (state.members.backend === 'claude') report.backends.membersInstalled = backendInstalled(backendRow(be.json, 'claude'));
    const problems = report.prerequisite ? prerequisiteProblems(report.prerequisite) : [`unexpected /api/kiro-prerequisite answer (HTTP ${pre.status})`];
    if (state.members.backend === 'claude' && report.backends.membersInstalled === false) problems.push('claude-agent-acp (members) not installed');
    report.ready = problems.length === 0;
    if (!report.ready) report.reason = problems.join('; ');
  } catch (e) {
    report.reason = `dashboard API not reachable: ${(e as Error).message}`;
  }
  return report;
}

function statusLines(r: StatusReport): string[] {
  if (!r.running) return [`Kiro Crew gateway: stopped${r.reason && r.reason !== 'stopped' ? ` (${r.reason})` : ''}`];
  const yesNo = (b: boolean | undefined): string => (b === undefined ? '' : b ? ' ✅' : ' ❌');
  const lines = [
    `Kiro Crew gateway: running (pid ${r.pid ?? 'unknown'}, port ${r.port})`,
    `  URL:       ${r.url}`,
    `  KiroCrew:  ${r.version ?? 'unknown'}`,
    `  Backends:  main = kiro (kiro-claude)${yesNo(r.backends.mainInstalled)}, members = ${r.backends.members === 'claude' ? 'claude (claude-agent-acp)' : 'none (Bots unavailable)'}${yesNo(r.backends.membersInstalled)}`,
    `  Ready:     ${r.ready ? 'yes' : `no (${r.reason ?? 'unknown'})`}`,
  ];
  return lines;
}

async function printStatus(c: CrewCtx, state: CrewState, kc: KiroCrewCli, holder: GatewayHolder | undefined, json: boolean): Promise<StatusReport> {
  const r = await gatherStatus(c, state, kc, holder);
  if (json) c.out(JSON.stringify(r));
  else for (const l of statusLines(r)) c.out(l);
  return r;
}

export async function crewStatus(c: CrewCtx, o: { json?: boolean } = {}): Promise<number> {
  const state = loadState(c, { quiet: o.json });
  if (!state) {
    if (o.json) c.out(JSON.stringify({ running: false, ready: false, holder: 'nobody', reason: 'not set up' }));
    return 3;
  }
  const { kc } = kirocrewFor(c, state);
  if (!fs.existsSync(kc.launcher)) {
    if (o.json) c.out(JSON.stringify({ running: false, ready: false, holder: 'nobody', reason: `bin/kirocrew missing in ${state.kirocrew.dir}` }));
    else c.out(`Kiro Crew gateway: stopped (bin/kirocrew missing in ${state.kirocrew.dir})`);
    return 3;
  }
  const r = await printStatus(c, state, kc, undefined, !!o.json);
  if (!r.running) return 3;
  return r.ready ? 0 : 4;
}

// ───────────────────────────── open ─────────────────────────────

export function browserOpener(platform: NodeJS.Platform, url: string): { file: string; args: string[] } {
  if (platform === 'darwin') return { file: 'open', args: [url] };
  if (platform === 'win32') return { file: 'cmd', args: ['/c', 'start', '""', url] };
  return { file: 'xdg-open', args: [url] };
}

export async function crewOpen(c: CrewCtx, o: { print?: boolean; ttl?: string } = {}): Promise<number> {
  const state = loadState(c);
  if (!state) return 1;
  const { kc } = kirocrewFor(c, state);
  const holder = fs.existsSync(kc.launcher) ? await kc.gatewayPid() : ({ holder: 'nobody' } as GatewayHolder);
  if (!gatewayRunning(holder)) {
    c.err('Kiro Crew gateway is not running. Start it with: kiro-claude crew start');
    return 3;
  }
  const { port } = gatewayRecord(c, state, holder);
  const { url, result } = await kc.token(port, o.ttl ?? '1h');
  if (!url) {
    c.err(`kiro-claude: kirocrew token failed: ${(result.stderr || result.stdout).trim() || `exit ${result.code}`}`);
    return 1;
  }
  const warning = 'This link signs you in; do not share it.';
  if (o.print) {
    c.out(url);
    c.err(warning);
    return 0;
  }
  const { file, args } = browserOpener(c.deps.sys.platform, url);
  const r = await c.deps.runner.run(file, args, { timeoutMs: 15_000, env: c.env });
  if (r.code === 0) {
    c.out('Opened the Kiro Crew dashboard.');
    c.err(warning);
    return 0;
  }
  c.err(`Could not open a browser (${file}); open this URL yourself:`);
  c.out(url);
  c.err(warning);
  return 0;
}

// ───────────────────────────── logs ─────────────────────────────

/** Newest `$KIROCREW_HOME/scratch/runtime-*\/kiro-log/kiro-chat.log` (our ACP log). */
export function newestAcpLog(kcHome: string): string | undefined {
  const scratch = path.join(kcHome, 'scratch');
  let best: { p: string; t: number } | undefined;
  let names: string[] = [];
  try {
    names = fs.readdirSync(scratch);
  } catch {
    return undefined;
  }
  for (const n of names) {
    if (!n.startsWith('runtime-')) continue;
    const p = path.join(scratch, n, 'kiro-log', 'kiro-chat.log');
    try {
      const t = fs.statSync(p).mtimeMs;
      if (!best || t > best.t) best = { p, t };
    } catch {
      // missing
    }
  }
  return best?.p;
}

/** Last `n` lines of a file (reads at most the last 8 MiB). */
export function tailFile(file: string, n: number): string[] {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return [];
  }
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 8 * 1024 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return n <= 0 ? [] : lastLines(buf.toString('utf8'), n);
  } finally {
    fs.closeSync(fd);
  }
}

export interface LogsOptions {
  follow?: boolean;
  acp?: boolean;
  lines?: number;
}

export async function crewLogs(c: CrewCtx, o: LogsOptions = {}): Promise<number> {
  const kcHome = kirocrewHome(c.env);
  const files: string[] = [];
  if (o.acp) {
    const acp = newestAcpLog(kcHome);
    if (acp) files.push(acp);
  } else {
    files.push(c.paths.gatewayErr, path.join(kcHome, 'gateway.log'));
  }
  const existing = files.filter((f) => fs.existsSync(f));
  if (existing.length === 0 && !o.follow) {
    c.err(o.acp ? `No ACP log found under ${path.join(kcHome, 'scratch')}` : `No gateway logs yet (${files.join(', ')})`);
    return 1;
  }
  const n = o.lines ?? 200;
  const multi = files.length > 1;
  for (const f of existing) {
    if (multi) c.out(`==> ${f} <==`);
    for (const l of tailFile(f, n)) c.out(l);
  }
  if (!o.follow) return 0;

  const offsets = new Map<string, number>();
  for (const f of files) {
    try {
      offsets.set(f, fs.statSync(f).size);
    } catch {
      offsets.set(f, 0);
    }
  }
  let last: string | undefined = existing[existing.length - 1];
  const signal = c.deps.signal;
  while (!signal?.aborted) {
    await c.deps.sys.sleep(c.deps.pollMs);
    for (const f of files) {
      let size: number;
      try {
        size = fs.statSync(f).size;
      } catch {
        continue;
      }
      let off = offsets.get(f) ?? 0;
      if (size < off) off = 0; // truncated or rotated in place
      if (size === off) continue;
      const fd = fs.openSync(f, 'r');
      try {
        const buf = Buffer.alloc(size - off);
        fs.readSync(fd, buf, 0, buf.length, off);
        if (multi && last !== f) c.cli.stdout.write(`\n==> ${f} <==\n`);
        c.cli.stdout.write(buf.toString('utf8'));
        last = f;
      } finally {
        fs.closeSync(fd);
      }
      offsets.set(f, size);
    }
  }
  return 0;
}

// ───────────────────────────── exec ─────────────────────────────

export async function crewExec(c: CrewCtx, args: string[], o: { env?: Record<string, string> } = {}): Promise<number> {
  const state = loadState(c);
  if (!state) return 1;
  const { kc, gw } = kirocrewFor(c, state, { extra: o.env, cwd: c.cwd });
  if (!fs.existsSync(kc.launcher)) {
    c.err(`kiro-claude: Kiro Crew is not available at ${state.kirocrew.dir} (bin/kirocrew is missing). Run: kiro-claude crew setup`);
    return 1;
  }
  printWarnings(c, gw.warnings);
  const r = await kc.run(args, {
    stdio: 'inherit',
    streams: { stdin: c.cli.stdin, stdout: c.cli.stdout, stderr: c.cli.stderr },
    timeoutMs: 0,
    forwardSignals: true,
  });
  if (r.error) {
    c.err(`kiro-claude: cannot run ${kc.launcher}: ${r.error}`);
    return 1;
  }
  return exitCodeOf(r.code, r.signal);
}

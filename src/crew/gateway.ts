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
 * - `--approval auto` is passed as KiroCrew's `yolo` (its choices are reads|yolo|interactive).
 * - Every command uses one gateway env (context.gatewayEnvFor): a `--kiro-bin` given to the
 *   start that launched the running gateway is used by exec/stop/status/doctor too.
 * - status: `gateway-pid` plus cookie-authenticated `/api/status`, `/api/kiro-prerequisite`,
 *   `/api/acp-backends`. Exit 0 running and ready, 3 stopped, 4 running but not ready.
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
import { kirocrewFor, loadState, readReady, readToken, type CrewCtx } from './context.js';
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
  writeFileAtomic(c.paths.readyFile, `${JSON.stringify(ready)}\n`, { mode: 0o600 });
  const token = typeof ready.token === 'string' ? ready.token : '';
  if (token) writeFileAtomic(c.paths.tokenFile, `${token}\n`, { mode: 0o600 });
  const realPort = typeof ready.port === 'number' ? ready.port : port;
  const realPid = typeof ready.pid === 'number' ? ready.pid : pid;
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
 * The gateway still runs: its pid is alive and still names the process of the snapshot. A known
 * start time must read back equal, after the liveness check: a pid whose stat cannot be read
 * (gone meanwhile, or another user's process that `hidepid` hides while signal 0 says EPERM) is
 * not the gateway, whose stat this process could read.
 */
function gatewayAlive(c: CrewCtx, g: { pid: number; startTime?: number }): boolean {
  if (!c.deps.sys.isAlive(g.pid)) return false;
  return g.startTime === undefined || c.deps.sys.startTime(g.pid) === g.startTime;
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
  const leftovers = (): ProcessInfo[] => {
    const list = c.deps.sys.listProcesses();
    const spare = selfAndAncestors(list, c.deps.sys.pid);
    const cur = new Map(list.map((p) => [p.pid, p]));
    return [...targets.values()].filter((t) => !spare.has(t.pid) && cur.has(t.pid) && sameProcess(t, cur.get(t.pid)!));
  };
  let left = leftovers();
  const n = left.length;
  for (const p of left) c.deps.sys.kill(p.pid, 'SIGTERM');
  const deadline = c.deps.sys.now() + c.deps.killGraceMs;
  while ((left = leftovers()).length > 0 && c.deps.sys.now() < deadline) await c.deps.sys.sleep(c.deps.pollMs);
  for (const p of left) c.deps.sys.kill(p.pid, 'SIGKILL');
  return n;
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
  for (const p of orphans) if (c.deps.sys.kill(p.pid, 'SIGTERM')) n++;
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
    const reaped = reapOrphans(c, state);
    removeRunSecrets(c);
    c.out(reaped > 0 ? `Kiro Crew gateway is not running; ${reaped} orphan agent process(es) reaped` : 'Kiro Crew gateway is not running.');
    return 0;
  }
  const pid = holder.holder === 'process' ? holder.pid : readReady(c.paths)?.pid;
  // the gateway and its own children, seen while it still runs (they are re-parented once it exits)
  let snap: GatewaySnapshot | undefined;
  if (pid !== undefined) {
    const procs = c.deps.sys.listProcesses();
    const gwProc = procs.find((p) => p.pid === pid);
    const leader = gwProc?.pgid === pid;
    snap = {
      pid,
      startTime: gwProc?.startTime ?? c.deps.sys.startTime(pid),
      leader,
      home: gwProc?.env?.HOME ?? c.home,
      kiroBin: gwProc?.env ? gwProc.env.KIROCREW_KIRO_BIN : gwEnv.env.KIROCREW_KIRO_BIN,
      tree: gatewayTree(procs, pid, c.deps.sys.pid, leader),
    };
  }
  const alive = (): boolean => snap !== undefined && gatewayAlive(c, snap);
  const stopRun = await kc.stop();
  if (stopRun.code !== 0 && c.cli.verbosity > 0) c.err(`kirocrew stop: ${(stopRun.stderr || stopRun.stdout).trim()}`);
  const timeoutMs = (o.timeoutSec ?? 30) * 1000;
  let gone = false;
  if (pid !== undefined) {
    gone = await waitGone(c, alive, timeoutMs);
  } else {
    const deadline = c.deps.sys.now() + timeoutMs;
    for (;;) {
      const h = await kc.gatewayPid();
      if (!gatewayRunning(h)) {
        gone = true;
        break;
      }
      if (c.deps.sys.now() >= deadline) break;
      await c.deps.sys.sleep(1000);
    }
  }
  if (!gone && pid !== undefined) {
    c.deps.sys.kill(pid, 'SIGTERM');
    if (!(await waitGone(c, alive, c.deps.killGraceMs))) {
      c.deps.sys.kill(pid, 'SIGKILL');
      await waitGone(c, alive, 2000);
    }
  }
  // decided once: a process that takes the pid later (during the retire wait) is not the gateway
  const exited = !alive();
  const reaped = reapOrphans(c, state);
  if (snap && exited) await retireGatewayTree(c, snap);
  removeRunSecrets(c);
  if (!exited) {
    c.err(`kiro-claude: the Kiro Crew gateway (pid ${pid}) did not exit.`);
    return 1;
  }
  c.out(`Stopped (pid ${pid ?? 'unknown'}); ${reaped} orphan agent process(es) reaped`);
  return 0;
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
  const ready = readReady(c.paths);
  report.pid = holder.holder === 'process' ? holder.pid : ready?.pid;
  report.port = ready?.port ?? state.port;
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
  const port = readReady(c.paths)?.port ?? state.port;
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

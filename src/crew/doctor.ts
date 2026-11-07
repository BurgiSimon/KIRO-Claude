/**
 * `kiro-claude crew doctor [--json] [--fix] [--no-gateway]` (08-kirocrew-integration §3.9).
 *
 * | # | Check | `--fix` |
 * |---|---|---|
 * | D1 | node / python / git versions (§3.3 step 0) | — |
 * | D2 | `$KCDIR` exists; `rev-parse HEAD` = pin; `status --porcelain --untracked-files=no` empty; not a linked worktree (V9) | `git -C $KCDIR checkout --detach <sha>` (only if clean) |
 * | D3 | built: `.venv/bin/kirocrew`, `src/kiro_crew/static/dist`, `bin/kirocrew --version` | rerun build |
 * | D4 | KiroCrew config (§3.6 values, via `kirocrew config get`) | `config set` |
 * | D5 | members adapter entry exists; `CLAUDE_CODE_EXECUTABLE` executable | reinstall |
 * | D6 | shim: KC-BIN-01/02, content equals the regenerated text | rewrite (gateway stopped) |
 * | D7 | probe contract KC-CLI-01/02/03/05/06/08/10 (+09) under the `$PROBE` env | — |
 * | D8 | Claude found, ≥ 2.1, `$PROBE $SHIM whoami` exits 0 (env-only sign-in detection) | — |
 * | D9 | identity: real store or our stub; no relocated `XDG_DATA_HOME` | write the stub |
 * | D10 | `$KIROCREW_HOME` ≤ 60 chars, ≥ 1 GB free (warnings) | — |
 * | D11 | gateway (if running): `/api/kiro-prerequisite` ready, `/api/acp-backends` main = kiro, members = claude | — |
 * | D12 | KiroCrew's own doctor: rows `kiro-cli:`, `kiro-cli-chat:`, `kiro auth:`, `claude-acp:` only (its exit code is not used) | — |
 *
 * Rows are printed as `✅ / ⚠ / ❌` (⏭ = skipped). Exit 0 if there is no ❌, else 1. For a foreign
 * `--kiro-bin` (stage A of the e2e plan) D7/D8 are skipped (08 §5.1 A2).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { kiroHome } from '../util/paths.js';
import { backendInstalled, backendRow, prerequisiteProblems, summarizePrerequisite } from './api.js';
import { atLeast, buildKiroCrew, builtState, detectBuildNode, detectGit, detectPython, fallbackNodeOf, findNpm, installMembersAdapter, membersAdapterInstalled, membersAdapterVersion } from './build.js';
import { kirocrewFor, type CrewCtx } from './context.js';
import { gatewayApiClient, gatewayRecord } from './gateway.js';
import { isRelocatedXdgDataHome, probeEnv } from './env.js';
import { gitHead } from './fetch.js';
import { createIdentityStub, inspectIdentityStore } from './identity.js';
import { configValueEquals, desiredConfig, dottedGet, gatewayRunning, isMissing, type GatewayHolder } from './kirocrew.js';
import { hiddenDirContaining, identityStorePath, inLinkedGitWorktree, kirocrewHome, resolveCheckout } from './paths.js';
import { CLAUDE_AGENT_ACP, DISK_NEEDS, FLOORS, KIROCREW_PIN, shortSha } from './pin.js';
import type { CrewRunner } from './runner.js';
import { checkShim, writeShim } from './shim.js';
import { readState, writeState, type CrewState } from './state.js';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface CheckRow {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
  /** What to do about it (printed under the row). */
  fix?: string;
  /** What `--fix` did. */
  fixed?: string;
}

export const STATUS_SYMBOL: Record<CheckStatus, string> = { ok: '✅', warn: '⚠', fail: '❌', skip: '⏭' };

export function renderRow(r: CheckRow): string[] {
  const lines = [`${STATUS_SYMBOL[r.status]} ${r.title}: ${r.detail}`];
  if (r.fixed) lines.push(`   fixed: ${r.fixed}`);
  if (r.fix && r.status !== 'ok' && r.status !== 'skip') lines.push(`   fix: ${r.fix}`);
  return lines;
}

// ───────────────────────────── probe contract (D7) ─────────────────────────────

export interface ProbeResult {
  id: string;
  label: string;
  ok: boolean;
  detail?: string;
  durationMs?: number;
}

/** KiroCrew's `parse_kiro_cli_version`: the version at the START of the last whitespace token (V8). */
export function parseKiroCliVersion(text: string): [number, number, number] | undefined {
  const tokens = text.trim().split(/\s+/);
  const last = tokens[tokens.length - 1] ?? '';
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(last);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

function cmpTriple(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) if (a[i]! !== b[i]!) return a[i]! - b[i]!;
  return 0;
}

/** `chat --help`: the `--agent-engine <ENGINE>` block lists `[possible values: v1, v2]` (KC-CLI-03). */
export function chatHelpEnginesOk(text: string): boolean {
  const start = text.indexOf('      --agent-engine <ENGINE>');
  if (start < 0) return false;
  const next = text.indexOf('\n      --', start + 1);
  const block = text.slice(start, next < 0 ? undefined : next);
  return block.includes('[possible values: v1, v2]');
}

/**
 * Runs the KiroCrew probe contract against `bin` with KiroCrew's probe env (D7; acceptance tests of
 * 08 §2.2 KC-CLI-01/02/03/05/06/08/10 and, when `agentSpec` exists, KC-CLI-09).
 */
export async function runProbeContract(runner: CrewRunner, bin: string, opts: { home: string; agentSpec?: string }): Promise<ProbeResult[]> {
  const env = probeEnv(opts.home);
  const run = (args: string[], timeoutMs = 15_000) => runner.run(bin, args, { env, timeoutMs, cwd: opts.home });
  const out: ProbeResult[] = [];
  const add = (id: string, label: string, ok: boolean, detail?: string, durationMs?: number): void => {
    out.push({ id, label, ok, detail, durationMs });
  };

  let r = await run(['--version']);
  {
    const v = parseKiroCliVersion(r.stdout);
    const ok = r.code === 0 && !!v && cmpTriple(v, [1, 26, 0]) >= 0 && cmpTriple(v, [2, 21, 0]) < 0;
    add('KC-CLI-01', '--version', ok, ok ? r.stdout.trim() : `exit ${r.code ?? r.error ?? r.signal}, printed ${JSON.stringify(r.stdout.trim().slice(0, 80))} (needs a kiro-cli version in [1.26.0, 2.21.0) as the last token)`);
  }

  r = await run(['acp', '--help']);
  {
    const t = r.stdout;
    const problems: string[] = [];
    if (r.code !== 0) problems.push(`exit ${r.code ?? r.error ?? r.signal}`);
    if (!t.includes('--agent-engine')) problems.push('no --agent-engine');
    if (!t.includes('[possible values: v1, v2]')) problems.push('no "[possible values: v1, v2]"');
    if (t.includes('v3')) problems.push('mentions v3');
    const slow = r.durationMs > 1000 ? ` (slow: ${r.durationMs} ms; Kiro Crew runs it before every spawn)` : '';
    add('KC-CLI-02', 'acp --help', problems.length === 0, problems.length ? problems.join(', ') : slow || undefined, r.durationMs);
  }

  r = await run(['chat', '--help']);
  {
    const problems: string[] = [];
    if (r.code !== 0) problems.push(`exit ${r.code ?? r.error ?? r.signal}`);
    if (!chatHelpEnginesOk(r.stdout)) problems.push('--agent-engine block lacks "[possible values: v1, v2]"');
    if (r.stdout.includes('v3')) problems.push('mentions v3');
    add('KC-CLI-03', 'chat --help', problems.length === 0, problems.join(', ') || undefined);
  }

  r = await run(['whoami', '--format', 'json'], 25_000);
  if (r.code === 0) {
    let obj: unknown;
    try {
      obj = JSON.parse(r.stdout.trim());
    } catch {
      obj = undefined;
    }
    const ok = !!obj && typeof obj === 'object' && !Array.isArray(obj) && !('accountType' in (obj as object));
    add('KC-CLI-05', 'whoami --format json', ok, ok ? undefined : `expected one JSON object without accountType, got ${JSON.stringify(r.stdout.trim().slice(0, 80))}`);
  } else {
    const ok = r.code === 1 && /not logged in/i.test(r.stderr);
    add('KC-CLI-05', 'whoami --format json', ok, ok ? 'signed out (see the Claude row)' : `exit ${r.code ?? r.error ?? r.signal}: ${r.stderr.trim().slice(0, 120)}`);
  }

  r = await run(['chat', '--list-models', '--format', 'json', '--no-interactive']);
  {
    let detail: string | undefined;
    let ok = false;
    if (r.code !== 0) detail = `exit ${r.code ?? r.error ?? r.signal}`;
    else {
      try {
        const d = JSON.parse(r.stdout) as unknown;
        const models = d && typeof d === 'object' && !Array.isArray(d) ? (d as { models?: unknown }).models : undefined;
        if (!Array.isArray(models) || models.length === 0) detail = 'expected a JSON object {"models":[…]} with at least one row';
        else {
          // KC-CLI-06: every row needs a string model_id/model_name and an integer window > 0
          // (KiroCrew's admit_catalog_rows ignores a bool, float or string window).
          const bad = models.find((m) => {
            if (!m || typeof m !== 'object' || Array.isArray(m)) return true;
            const row = m as { model_id?: unknown; model_name?: unknown; context_window_tokens?: unknown };
            const w = row.context_window_tokens;
            return typeof row.model_id !== 'string' || typeof row.model_name !== 'string' || typeof w !== 'number' || !Number.isInteger(w) || w <= 0;
          });
          if (bad) detail = `row without a string model_id/model_name and an integer context_window_tokens > 0: ${JSON.stringify(bad).slice(0, 80)}`;
          else {
            ok = true;
            detail = `${models.length} models`;
          }
        }
      } catch {
        detail = 'stdout is not JSON';
      }
    }
    add('KC-CLI-06', 'chat --list-models', ok, detail);
  }

  r = await run(['update'], 5_000);
  add('KC-CLI-08', 'update', r.code === 0, r.code === 0 ? undefined : `exit ${r.code ?? (r.timedOut ? 'timeout' : r.error ?? r.signal)}`);

  r = await run(['acp', '--agent-engine', 'v3', '--auth-method', 'cli'], 5_000);
  add('KC-CLI-10', 'acp --agent-engine v3', r.code === 2, r.code === 2 ? undefined : `expected exit 2, got ${r.code ?? (r.timedOut ? 'timeout' : r.error ?? r.signal)}`);

  if (opts.agentSpec && fs.existsSync(opts.agentSpec)) {
    r = await run(['agent', 'validate', '--path', opts.agentSpec]);
    const ok = r.code === 0 && r.stdout.trim() === '';
    add('KC-CLI-09', 'agent validate', ok, ok ? undefined : `exit ${r.code ?? r.error ?? r.signal}: ${r.stdout.trim().slice(0, 160)}`);
  }
  return out;
}

// ───────────────────────────── KiroCrew's own doctor (D12) ─────────────────────────────

const KC_DOCTOR_ROWS = ['kiro-cli', 'kiro-cli-chat', 'kiro auth', 'claude-acp'] as const;

/** Parses the rows of `kirocrew doctor` that concern the backends (D12). */
export function parseKiroCrewDoctor(text: string): Array<{ name: string; status: CheckStatus; text: string }> {
  const rows: Array<{ name: string; status: CheckStatus; text: string }> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    for (const name of KC_DOCTOR_ROWS) {
      if (!line.startsWith(`${name}:`)) continue;
      const rest = line.slice(name.length + 1).trim();
      const status: CheckStatus = rest.includes('❌') ? 'fail' : rest.includes('⚠') ? 'warn' : rest.includes('⏭') ? 'skip' : rest.includes('✅') ? 'ok' : 'warn';
      rows.push({ name, status, text: rest });
    }
  }
  return rows;
}

// ───────────────────────────── doctor ─────────────────────────────

export interface DoctorOptions {
  json?: boolean;
  fix?: boolean;
  noGateway?: boolean;
  kiroBin?: string;
  /** Print nothing (setup prints its own rows). */
  quiet?: boolean;
}

export interface DoctorReport {
  ok: boolean;
  rows: CheckRow[];
}

function worst(statuses: CheckStatus[]): CheckStatus {
  if (statuses.includes('fail')) return 'fail';
  if (statuses.includes('warn')) return 'warn';
  if (statuses.length && statuses.every((s) => s === 'skip')) return 'skip';
  return 'ok';
}

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function gb(n: number): string {
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

export async function runDoctor(c: CrewCtx, o: DoctorOptions = {}): Promise<DoctorReport> {
  const rows: CheckRow[] = [];
  const add = (row: CheckRow): CheckRow => {
    rows.push(row);
    return row;
  };
  const { runner } = c.deps;
  let state: CrewState | undefined;
  try {
    state = readState(c.paths.stateFile);
  } catch (e) {
    add({ id: 'D0', title: 'setup', status: 'fail', detail: (e as Error).message, fix: 'kiro-claude crew setup' });
  }
  if (!state && rows.length === 0) add({ id: 'D0', title: 'setup', status: 'fail', detail: `${c.paths.stateFile} does not exist`, fix: 'kiro-claude crew setup' });

  const dir = state?.kirocrew.dir ?? resolveCheckout({ cwd: c.cwd, env: c.env, packageRoot: c.deps.packageRoot }).dir;
  const membersBackend = state?.members.backend ?? 'claude';
  const kc = state ? kirocrewFor(c, state, { kiroBin: o.kiroBin }).kc : undefined;
  const launcherOk = fs.existsSync(path.join(dir, 'bin', 'kirocrew'));
  const built = builtState(dir);

  // D1 tools
  const node = await detectBuildNode(runner, c.env, c.deps.nodePath);
  const py = await detectPython(runner, c.env);
  const git = await detectGit(runner, c.env);
  {
    const parts: string[] = [];
    const statuses: CheckStatus[] = [];
    const problems: string[] = [];
    parts.push(node.version ? `node ${node.version}` : 'node ?');
    statuses.push(node.ok ? 'ok' : built.venv && built.dist ? 'warn' : 'fail');
    if (!node.ok && node.problem) problems.push(node.problem);
    parts.push(py.version ? `python ${py.version}` : 'python ?');
    statuses.push(py.ok ? 'ok' : 'fail');
    if (!py.ok && py.problem) problems.push(py.problem);
    parts.push(git.version ? `git ${git.version}` : 'git ?');
    statuses.push(git.ok ? 'ok' : 'warn');
    if (!git.ok && git.problem) problems.push(git.problem);
    add({ id: 'D1', title: 'tools', status: worst(statuses), detail: problems.length ? problems.join('; ') : parts.join(', ') });
  }

  // D2 checkout
  {
    const row = add({ id: 'D2', title: 'checkout', status: 'ok', detail: dir });
    if (!fs.existsSync(dir)) {
      row.status = 'fail';
      row.detail = `${dir} does not exist`;
      row.fix = 'kiro-claude crew setup';
    } else if (inLinkedGitWorktree(dir)) {
      row.status = 'fail';
      row.detail = `${dir} is inside a linked git worktree; Kiro Crew treats that as ephemeral and will not manage ~/.kiro/agents`;
      row.fix = 'use a primary clone of kiro-claude, or kiro-claude crew setup --dir <checkout elsewhere>';
    } else if (!git.ok) {
      row.status = 'warn';
      row.detail = `${dir} (cannot verify the commit without git)`;
    } else {
      const head = await gitHead(runner, git.path, dir, c.env);
      const st = await runner.run(git.path, ['-C', dir, 'status', '--porcelain', '--untracked-files=no'], { env: c.env, timeoutMs: 60_000 });
      const dirty = st.code === 0 ? st.stdout.trim() !== '' : undefined;
      if (head === undefined) {
        row.status = 'warn';
        row.detail = `${dir} is not a git checkout (cannot verify the pin)`;
      } else if (head !== KIROCREW_PIN.commit) {
        row.status = 'fail';
        row.detail = `KiroCrew checkout is at ${shortSha(head)}, expected ${shortSha(KIROCREW_PIN.commit)} (${dir})`;
        row.fix = `git -C ${dir} checkout --detach ${KIROCREW_PIN.commit}`;
        if (o.fix && dirty === false) {
          const r = await runner.run(git.path, ['-C', dir, 'checkout', '--detach', KIROCREW_PIN.commit], { env: c.env, timeoutMs: 120_000 });
          if (r.code === 0 && (await gitHead(runner, git.path, dir, c.env)) === KIROCREW_PIN.commit) {
            row.status = 'ok';
            row.fixed = `checked out ${shortSha(KIROCREW_PIN.commit)}`;
            row.detail = `${dir} at ${shortSha(KIROCREW_PIN.commit)}`;
          } else row.fixed = `checkout failed: ${(r.stderr || r.stdout).trim().split(/\r?\n/).pop() ?? ''}`;
        } else if (o.fix && dirty) row.fixed = 'not attempted: the checkout has local changes';
      } else if (dirty) {
        row.status = 'warn';
        row.detail = `${dir} at ${shortSha(head)} has modified tracked files`;
      } else {
        row.detail = `${dir} at ${shortSha(head)} (kirocrew ${KIROCREW_PIN.version})`;
      }
    }
  }

  // D3 built
  {
    const row = add({ id: 'D3', title: 'build', status: 'ok', detail: '' });
    const missing: string[] = [];
    if (!launcherOk) missing.push('bin/kirocrew');
    if (!built.venv) missing.push('.venv/bin/kirocrew');
    if (!built.dist) missing.push('src/kiro_crew/static/dist');
    if (missing.length) {
      row.status = 'fail';
      row.detail = `not built (missing ${missing.join(', ')})`;
      row.fix = 'kiro-claude crew setup';
      if (o.fix && launcherOk && py.ok && state) {
        try {
          await buildKiroCrew({ dir, kind: state.kirocrew.build === 'full' ? 'full' : 'light', python: py.path, node: node.ok ? node.path : undefined, npm: findNpm(c.env, fallbackNodeOf(node, c.env)), runner, env: c.env, paths: c.paths, logFile: c.paths.setupLog });
          row.fixed = 'rebuilt';
        } catch (e) {
          row.fixed = `rebuild failed: ${(e as Error).message}`;
        }
      }
    }
    if (row.status === 'ok' || row.fixed === 'rebuilt') {
      if (kc) {
        const v = await kc.version();
        if (v.ok) {
          row.status = 'ok';
          row.detail = v.line;
        } else {
          row.status = 'fail';
          row.detail = `bin/kirocrew --version printed ${JSON.stringify(v.line || v.result.stderr.trim().slice(0, 120))}, expected kirocrew ${KIROCREW_PIN.version}`;
          row.fix = 'kiro-claude crew setup';
        }
      } else row.detail = 'built';
    }
  }
  const kcUsable = !!kc && launcherOk && rows[rows.length - 1]!.status === 'ok';

  // Gateway state (used by D6 --fix and D11).
  let holder: GatewayHolder = { holder: 'nobody' };
  if (kc && kcUsable) holder = await kc.gatewayPid();
  const running = gatewayRunning(holder);

  // D4 config
  {
    const row = add({ id: 'D4', title: 'Kiro Crew config', status: 'ok', detail: '' });
    if (!kc || !kcUsable) {
      row.status = 'skip';
      row.detail = 'Kiro Crew is not built';
    } else {
      const { config, result } = await kc.configGetAll();
      if (!config) {
        row.status = 'fail';
        row.detail = `kirocrew config get failed: ${(result.stderr || result.stdout).trim().split(/\r?\n/).pop() ?? `exit ${result.code}`}`;
      } else {
        const wrong: Array<[string, unknown, unknown]> = [];
        for (const [k, v] of desiredConfig(membersBackend)) {
          const actual = dottedGet(config, k);
          if (isMissing(actual) || !configValueEquals(actual, v)) wrong.push([k, v, isMissing(actual) ? undefined : actual]);
        }
        if (wrong.length === 0) row.detail = desiredConfig(membersBackend).map(([k, v]) => `${k}=${String(v)}`).join(', ');
        else {
          row.status = 'fail';
          row.detail = wrong.map(([k, v, a]) => `${k} is ${a === undefined ? 'unset' : JSON.stringify(a)} (want ${JSON.stringify(v)})`).join('; ');
          row.fix = wrong.map(([k, v]) => `kiro-claude crew exec -- config set ${k} ${String(v)}`).join(' && ');
          if (o.fix) {
            const failed: string[] = [];
            for (const [k, v] of wrong) {
              const r = await kc.configSet(k, v);
              if (r.code !== 0) failed.push(k);
            }
            if (failed.length === 0) {
              row.status = 'ok';
              row.fixed = `set ${wrong.map(([k]) => k).join(', ')}`;
            } else row.fixed = `config set failed for ${failed.join(', ')}`;
          }
        }
      }
    }
  }

  // D5 members
  {
    const row = add({ id: 'D5', title: 'members (Bots)', status: 'ok', detail: '' });
    const claudeExe = state?.claude;
    if (membersBackend === 'none') {
      row.status = 'warn';
      row.detail = 'Bots are unavailable (setup ran with --members none)';
      row.fix = 'kiro-claude crew setup --members claude';
    } else {
      const problems: string[] = [];
      if (!membersAdapterInstalled(c.paths)) {
        const v = membersAdapterVersion(c.paths);
        problems.push(v ? `claude-agent-acp ${v} installed, expected ${CLAUDE_AGENT_ACP.version}` : `${c.paths.membersAdapter} does not exist`);
      }
      if (!claudeExe || !isExecutable(claudeExe)) problems.push(`CLAUDE_CODE_EXECUTABLE (${claudeExe ?? 'unset'}) is not executable`);
      if (problems.length === 0) row.detail = `${CLAUDE_AGENT_ACP.name}@${CLAUDE_AGENT_ACP.version} → ${claudeExe}`;
      else {
        row.status = 'fail';
        row.detail = problems.join('; ');
        row.fix = 'kiro-claude crew doctor --fix (reinstalls the adapter), or kiro-claude crew setup';
        if (o.fix && !membersAdapterInstalled(c.paths)) {
          const npm = findNpm(c.env, fallbackNodeOf(node, c.env));
          if (!npm) row.fixed = 'npm not found';
          else {
            try {
              await installMembersAdapter({ runner, npm, env: c.env, paths: c.paths, logFile: c.paths.setupLog, force: true });
              row.fixed = 'reinstalled claude-agent-acp';
              if (claudeExe && isExecutable(claudeExe)) {
                row.status = 'ok';
                row.detail = `${CLAUDE_AGENT_ACP.name}@${CLAUDE_AGENT_ACP.version} → ${claudeExe}`;
              }
            } catch (e) {
              row.fixed = `reinstall failed: ${(e as Error).message}`;
            }
          }
        }
      }
    }
  }

  // D6 shim
  const shim = state?.shim || c.paths.shim;
  const foreignKiroBin = o.kiroBin ?? state?.kiroBinOverride;
  {
    const row = add({ id: 'D6', title: 'shim', status: 'ok', detail: shim });
    const spec = state && state.node && state.entry && state.claude ? { node: state.node, entry: state.entry, claude: state.claude } : undefined;
    const check = checkShim(shim, spec);
    const hidden = hiddenDirContaining(shim, c.env);
    if (hidden) check.problems.push(`it is inside ${hidden}, which Kiro Crew hides from its kiro-cli probes`);
    if (check.problems.length) {
      row.status = 'fail';
      row.detail = `${shim}: ${check.problems.join('; ')}`;
      row.fix = 'kiro-claude crew setup (rewrites the shim; stop the gateway first)';
      if (o.fix && spec && !hidden) {
        if (running) row.fixed = 'not rewritten: the gateway is running (kiro-claude crew stop first)';
        else {
          try {
            writeShim(shim, spec);
            row.status = 'ok';
            row.fixed = 'rewrote the shim';
            row.detail = shim;
          } catch (e) {
            row.fixed = `rewrite failed: ${(e as Error).message}`;
          }
        }
      }
    }
  }
  const shimOk = rows[rows.length - 1]!.status === 'ok';

  // D7 probe contract
  {
    const row = add({ id: 'D7', title: 'kiro-cli probe contract', status: 'ok', detail: '' });
    if (foreignKiroBin && foreignKiroBin !== shim) {
      row.status = 'skip';
      row.detail = `foreign --kiro-bin ${foreignKiroBin}`;
    } else if (!shimOk && !fs.existsSync(shim)) {
      row.status = 'skip';
      row.detail = 'no shim';
    } else {
      const results = await runProbeContract(runner, shim, { home: c.home, agentSpec: path.join(kiroHome(c.env), 'agents', 'kirocrew.json') });
      const failed = results.filter((r) => !r.ok);
      if (failed.length) {
        row.status = 'fail';
        row.detail = failed.map((r) => `${r.label}: ${r.detail ?? 'failed'}`).join('; ');
        row.fix = 'update kiro-claude (npm run build), then touch the shim or restart the gateway (Kiro Crew caches help output by the shim mtime)';
      } else {
        const notes = results.filter((r) => r.detail && r.id === 'KC-CLI-02').map((r) => r.detail);
        row.detail = `${results.map((r) => r.label).join(', ')}${notes.length ? ` ${notes.join(' ')}` : ''}`;
        if (notes.length) row.status = 'warn';
      }
    }
  }

  // D8 Claude
  {
    const row = add({ id: 'D8', title: 'Claude Code', status: 'ok', detail: '' });
    try {
      const info = await c.deps.findClaude({ explicitPath: state?.claude || undefined, env: c.env });
      row.detail = `${info.path} ${info.version}`;
      if (!atLeast(info.version, FLOORS.claude)) {
        row.status = 'fail';
        row.detail = `${info.path} is ${info.version}; kiro-claude needs ${FLOORS.claude} or newer`;
        row.fix = 'claude update';
      }
    } catch (e) {
      row.status = 'fail';
      row.detail = (e as Error).message;
      row.fix = 'install Claude Code, or kiro-claude crew setup --claude-bin <path>';
    }
    if (row.status === 'ok') {
      if (foreignKiroBin && foreignKiroBin !== shim) {
        row.detail += ' (sign-in probe skipped for a foreign --kiro-bin)';
      } else if (!fs.existsSync(shim)) {
        row.detail += ' (no shim to probe sign-in with)';
      } else {
        const probe = await runner.run(shim, ['whoami'], { env: probeEnv(c.home), timeoutMs: 25_000, cwd: c.home });
        if (probe.code === 0) {
          row.detail = `${row.detail}; ${probe.stdout.trim().split(/\r?\n/)[0] ?? 'signed in'}`;
        } else {
          const gwEnv = state ? kirocrewFor(c, state).gw.env : c.env;
          const full = await runner.run(shim, ['whoami'], { env: gwEnv, timeoutMs: 25_000, cwd: c.home });
          row.status = 'fail';
          if (full.code === 0) {
            row.detail = `Claude Code sign-in is only in the environment; Kiro Crew's sign-in check cannot see it. Run "claude /login" (or "kiro-claude login").`;
          } else {
            row.detail = `${(probe.stderr || probe.stdout).trim().split(/\r?\n/)[0] || `whoami exit ${probe.code}`}`;
            row.fix = 'kiro-claude login';
          }
        }
      }
    }
  }

  // D9 identity
  {
    const row = add({ id: 'D9', title: 'kiro-cli identity', status: 'ok', detail: '' });
    const storePath = state?.identityStub.path || identityStorePath(c.home, c.deps.sys.platform);
    const python = state?.kirocrew.python && isExecutable(state.kirocrew.python) ? state.kirocrew.python : py.ok ? py.path : undefined;
    try {
      const ins = await inspectIdentityStore(storePath, { runner, python, env: c.env });
      if (ins.exists && ins.ours) row.detail = `kiro-claude identity stub (no credentials) at ${storePath}`;
      else if (ins.exists) row.detail = `kiro-cli identity store at ${storePath} (not ours; left untouched)`;
      else {
        const optOut = state?.identityStub.optOut === true;
        row.status = optOut ? 'warn' : 'fail';
        row.detail = `no kiro-cli identity store at ${storePath}: Kiro Crew restarts every idle agent on each dashboard turn${optOut ? ' (setup ran with --no-identity-stub)' : ''}`;
        row.fix = optOut ? 'kiro-claude crew setup (without --no-identity-stub)' : 'kiro-claude crew doctor --fix';
        if (o.fix && !optOut) {
          if (!python) row.fixed = 'Python 3.12+ is needed to write the stub';
          else {
            const r = await createIdentityStub(storePath, { runner, python, now: c.deps.now(), env: c.env });
            if (r.result === 'created') {
              row.status = 'ok';
              row.fixed = 'wrote the identity stub';
              row.detail = `kiro-claude identity stub (no credentials) at ${storePath}`;
              if (state) {
                state.identityStub = { ...state.identityStub, created: true, path: storePath, createdDir: state.identityStub.createdDir || r.createdDir || undefined };
                writeState(c.paths.stateFile, state);
              }
            } else row.fixed = 'a store appeared meanwhile; left untouched';
          }
        }
      }
    } catch (e) {
      row.status = 'warn';
      row.detail = `cannot inspect ${storePath}: ${(e as Error).message}`;
    }
    if (isRelocatedXdgDataHome(c.env)) {
      row.status = row.status === 'fail' ? 'fail' : 'warn';
      row.detail += `; XDG_DATA_HOME=${c.env.XDG_DATA_HOME} is relocated (crew commands drop it from the gateway env; a plain kirocrew run would read the identity as absent)`;
    }
  }

  // D10 paths
  {
    const kcHome = kirocrewHome(c.env);
    const statuses: CheckStatus[] = [];
    const notes: string[] = [];
    if (kcHome.length > 60) {
      statuses.push('warn');
      notes.push(`KIROCREW_HOME is ${kcHome.length} characters long (> 60): AF_UNIX sockets fall back to TCP`);
    }
    const free = c.deps.sys.freeBytes(kcHome);
    if (free !== undefined && free < DISK_NEEDS.doctorMin) {
      statuses.push('warn');
      notes.push(`only ${gb(free)} free at ${kcHome} (first boot downloads ~0.5 GB)`);
    }
    add({ id: 'D10', title: 'paths', status: worst(statuses.length ? statuses : ['ok']), detail: notes.length ? notes.join('; ') : `${kcHome}${free !== undefined ? ` (${gb(free)} free)` : ''}` });
  }

  // D11 gateway
  {
    const row = add({ id: 'D11', title: 'gateway', status: 'skip', detail: '' });
    if (o.noGateway) row.detail = 'skipped (--no-gateway)';
    else if (!running) row.detail = 'not running';
    else if (kc && state) {
      try {
        const { port } = gatewayRecord(c, state, holder);
        const client = await gatewayApiClient(c, kc, port);
        const pre = summarizePrerequisite((await client.get('/api/kiro-prerequisite')).json);
        const be = (await client.get('/api/acp-backends')).json;
        const problems = pre ? prerequisiteProblems(pre) : ['unexpected /api/kiro-prerequisite answer'];
        if (!backendInstalled(backendRow(be, 'kiro'))) problems.push('backend kiro not reported installed');
        if (membersBackend === 'claude' && !backendInstalled(backendRow(be, 'claude'))) problems.push('backend claude (members) not reported installed');
        row.status = problems.length ? 'fail' : 'ok';
        row.detail = problems.length ? problems.join('; ') : `port ${port}: installed, authenticated, ready; main = kiro, members = ${membersBackend}`;
      } catch (e) {
        row.status = 'fail';
        row.detail = `dashboard API not reachable: ${(e as Error).message}`;
      }
    }
  }

  // D12 KiroCrew's own doctor
  {
    const row = add({ id: 'D12', title: "Kiro Crew's doctor", status: 'skip', detail: '' });
    if (!kc || !kcUsable) row.detail = 'Kiro Crew is not built';
    else {
      const r = await kc.doctor();
      // KiroCrew prints some rows twice (e.g. `kiro-cli:` with the path and with the version):
      // keep one per name, with its worst status.
      const rank: Record<CheckStatus, number> = { fail: 3, warn: 2, ok: 1, skip: 0 };
      const byName = new Map<string, { name: string; status: CheckStatus; text: string }>();
      for (const f of parseKiroCrewDoctor(`${r.stdout}\n${r.stderr}`)) {
        const prev = byName.get(f.name);
        if (!prev || rank[f.status] > rank[prev.status]) byName.set(f.name, f);
      }
      const found = [...byName.values()];
      if (found.length === 0) {
        row.status = 'warn';
        row.detail = `no kiro-cli rows in its output (exit ${r.code ?? r.signal})`;
      } else {
        row.status = worst(found.map((f) => f.status));
        row.detail = found.map((f) => `${f.name} ${STATUS_SYMBOL[f.status]}${f.status === 'ok' ? '' : ` (${f.text.replace(/^[❌⚠️✅⏭\s]+/u, '')})`}`).join(', ');
      }
    }
  }

  return { ok: !rows.some((r) => r.status === 'fail'), rows };
}

export async function crewDoctor(c: CrewCtx, o: DoctorOptions = {}): Promise<number> {
  const report = await runDoctor(c, o);
  if (o.json) {
    c.out(JSON.stringify(report));
  } else if (!o.quiet) {
    for (const r of report.rows) for (const l of renderRow(r)) c.out(l);
    const fails = report.rows.filter((r) => r.status === 'fail').length;
    c.out(fails === 0 ? 'No problems found.' : `${fails} problem${fails === 1 ? '' : 's'} found.`);
  }
  return report.ok ? 0 : 1;
}

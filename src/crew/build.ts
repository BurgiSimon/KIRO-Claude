/**
 * `crew setup` steps 0 (tool preflight), 2 (build) and 4 (members adapter)
 * (08-kirocrew-integration §3.3; commands VERIFIED in 08b §1.2–§1.3 and 08 V11).
 *
 * Preflight floors: `node` ≥ 22.12.0 (KiroCrew's dashboard build; only required when building),
 * Python ≥ 3.12 (first of `$KIRO_CLAUDE_CREW_PYTHON`, `python3.13`, `python3.12` — plus, our
 * DECISION, `python3.14` and `python3` as later fallbacks), `git` ≥ 2.36 (when fetching).
 * Setup never runs KiroCrew's `ensure-*.sh` (they install `mise` through curl) nor
 * `minimal_install.sh` (global npm install).
 *
 * Light build (default), umask 022, npm/pip caches under `$CS/cache` (deleted afterwards):
 * ```sh
 * (cd $KCDIR/website && npm ci --no-audit --no-fund --cache $CS/cache/npm && npm run build)
 * $PY -m venv $KCDIR/.venv
 * $KCDIR/.venv/bin/pip install --cache-dir $CS/cache/pip --upgrade pip setuptools wheel
 * KIROCREW_SKIP_FRONTEND=1 $KCDIR/.venv/bin/pip install --cache-dir $CS/cache/pip --prefer-binary -e $KCDIR
 * $KCDIR/.venv/bin/python -m kiro_crew.frontend stage $KCDIR
 * ```
 * `--full`: `make -C $KCDIR build PY=$PY` (needed for KiroCrew's pytest suites).
 * Members: `npm i --prefix $CS/node @agentclientprotocol/claude-agent-acp@0.101.0 --omit=optional --no-audit --no-fund`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { compareVersions } from '../claude/binary.js';
import { findExecutable } from '../util/process.js';
import { CrewStepError } from './fetch.js';
import type { CrewPaths } from './paths.js';
import { CLAUDE_AGENT_ACP, FLOORS } from './pin.js';
import { formatCommand, lastLines, type CrewRunner } from './runner.js';

/** `v22.23.4`, `Python 3.13.1`, `git version 2.43.0 (Apple Git-154)` → `22.23.4` etc. */
export function parseToolVersion(text: string): string | undefined {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  if (!m) return undefined;
  return `${m[1]}.${m[2]}.${m[3] ?? '0'}`;
}

export function atLeast(version: string | undefined, floor: string): boolean {
  return version !== undefined && compareVersions(version, floor) >= 0;
}

export interface ToolInfo {
  path: string;
  version?: string;
  ok: boolean;
  problem?: string;
}

async function toolVersion(runner: CrewRunner, file: string, args: string[], env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const r = await runner.run(file, args, { env, timeoutMs: 30_000 });
  if (r.code !== 0) return undefined;
  return parseToolVersion(`${r.stdout}\n${r.stderr}`);
}

/**
 * The node used to build KiroCrew: `node` on PATH when ≥ 22.12, else kiro-claude's own node
 * (`fallbackNode`, i.e. `process.execPath`) when that one is new enough.
 */
export async function detectBuildNode(runner: CrewRunner, env: NodeJS.ProcessEnv, fallbackNode?: string): Promise<ToolInfo> {
  const onPath = findExecutable('node', env);
  let seen: ToolInfo | undefined;
  for (const candidate of [onPath, fallbackNode]) {
    if (!candidate) continue;
    const version = await toolVersion(runner, candidate, ['--version'], env);
    const info: ToolInfo = { path: candidate, version, ok: atLeast(version, FLOORS.node) };
    if (info.ok) return info;
    seen ??= info;
  }
  if (!seen) return { path: 'node', ok: false, problem: `Node.js ${FLOORS.node} or newer is required to build Kiro Crew, and no node was found on PATH` };
  return {
    ...seen,
    problem: `Node.js ${FLOORS.node} or newer is required to build Kiro Crew (found ${seen.version ? `v${seen.version}` : 'an unknown version'} at ${seen.path})`,
  };
}

/** Python candidates in order (08 §3.3 step 0, plus our two fallbacks). */
export function pythonCandidates(env: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  const explicit = env.KIRO_CLAUDE_CREW_PYTHON;
  if (explicit && explicit.trim()) out.push(explicit.trim());
  out.push('python3.13', 'python3.12', 'python3.14', 'python3');
  return out;
}

export async function detectPython(runner: CrewRunner, env: NodeJS.ProcessEnv): Promise<ToolInfo> {
  const explicit = env.KIRO_CLAUDE_CREW_PYTHON?.trim();
  const tried: string[] = [];
  for (const name of pythonCandidates(env)) {
    const p = findExecutable(name, env);
    if (!p) {
      if (explicit && name === explicit) {
        return { path: name, ok: false, problem: `KIRO_CLAUDE_CREW_PYTHON (${name}) is not an executable` };
      }
      continue;
    }
    const version = await toolVersion(runner, p, ['--version'], env);
    if (atLeast(version, FLOORS.python)) return { path: p, version, ok: true };
    tried.push(`${p} (${version ?? 'unknown version'})`);
    if (explicit && name === explicit) {
      return { path: p, version, ok: false, problem: `KIRO_CLAUDE_CREW_PYTHON (${p}) is Python ${version ?? '?'}; Kiro Crew needs Python 3.12 or newer` };
    }
  }
  return {
    path: 'python3',
    ok: false,
    problem: `Python 3.12 or newer is required (set KIRO_CLAUDE_CREW_PYTHON to its path)${tried.length ? `; found ${tried.join(', ')}` : '; none found on PATH'}`,
  };
}

export async function detectGit(runner: CrewRunner, env: NodeJS.ProcessEnv): Promise<ToolInfo> {
  const p = findExecutable('git', env);
  if (!p) return { path: 'git', ok: false, problem: 'git was not found on PATH' };
  const version = await toolVersion(runner, p, ['--version'], env);
  if (atLeast(version, FLOORS.git)) return { path: p, version, ok: true };
  return { path: p, version, ok: false, problem: `git ${FLOORS.git} or newer is required (found ${version ?? 'an unknown version'} at ${p})` };
}

/**
 * The npm to use: next to `preferNode` when given (a fallback build node that is not the PATH
 * one), else `npm` on PATH, else the npm next to kiro-claude's own node.
 */
export function findNpm(env: NodeJS.ProcessEnv, preferNode?: string): string | undefined {
  const sibling = (node: string): string | undefined => {
    if (!path.isAbsolute(node)) return undefined;
    const p = path.join(path.dirname(node), process.platform === 'win32' ? 'npm.cmd' : 'npm');
    return fs.existsSync(p) ? p : undefined;
  };
  if (preferNode) {
    const s = sibling(preferNode);
    if (s) return s;
  }
  return findExecutable('npm', env) ?? sibling(process.execPath);
}

/** `node.path` when it is a fallback node (not the one on PATH), for {@link findNpm}. */
export function fallbackNodeOf(node: ToolInfo | undefined, env: NodeJS.ProcessEnv): string | undefined {
  if (!node?.ok || !path.isAbsolute(node.path)) return undefined;
  const onPath = findExecutable('node', env);
  return onPath && path.resolve(onPath) === path.resolve(node.path) ? undefined : node.path;
}

/** Env with `dir` first on PATH (so npm scripts use the chosen node). */
export function withPathFirst(env: NodeJS.ProcessEnv, dir: string | undefined): NodeJS.ProcessEnv {
  if (!dir) return { ...env };
  const cur = env.PATH ?? '';
  const parts = cur.split(path.delimiter).filter((p) => p !== '' && path.resolve(p) !== path.resolve(dir));
  return { ...env, PATH: [dir, ...parts].join(path.delimiter) };
}

export interface BuildState {
  venv: boolean;
  dist: boolean;
}

/** What doctor D3 / setup look at: `.venv/bin/kirocrew` and `src/kiro_crew/static/dist`. */
export function builtState(dir: string): BuildState {
  return {
    venv: fs.existsSync(path.join(dir, '.venv', 'bin', 'kirocrew')),
    dist: fs.existsSync(path.join(dir, 'src', 'kiro_crew', 'static', 'dist')),
  };
}

export interface BuildOptions {
  dir: string;
  kind: 'light' | 'full';
  python: string;
  /** Node chosen by {@link detectBuildNode} (its dir goes first on PATH). */
  node?: string;
  npm?: string;
  runner: CrewRunner;
  env: NodeJS.ProcessEnv;
  paths: CrewPaths;
  logFile?: string;
  /** Called before each command (progress). */
  onCommand?: (cmd: string) => void;
}

function withUmask<T>(mask: number, fn: () => Promise<T>): Promise<T> {
  let previous: number | undefined;
  try {
    previous = process.umask(mask);
  } catch {
    previous = undefined; // worker threads cannot change the umask
  }
  return fn().finally(() => {
    if (previous !== undefined) {
      try {
        process.umask(previous);
      } catch {
        // ignore
      }
    }
  });
}

async function runStep(
  opts: BuildOptions,
  step: string,
  file: string,
  args: string[],
  extra: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  const cmd = formatCommand(file, args);
  opts.onCommand?.(cmd);
  const r = await opts.runner.run(file, args, {
    cwd: extra.cwd ?? opts.dir,
    env: extra.env ?? opts.env,
    logFile: opts.logFile,
    timeoutMs: 60 * 60_000,
  });
  if (r.code !== 0) {
    const output = lastLines(`${r.stdout}\n${r.stderr}`.trim(), 20).join('\n');
    throw new CrewStepError(step, `command failed (${r.error ?? `exit ${r.code ?? r.signal}`})`, cmd, output);
  }
  return cmd;
}

/** Runs the light or full build. Returns the commands run. */
export async function buildKiroCrew(opts: BuildOptions): Promise<string[]> {
  const commands: string[] = [];
  const nodeDir = opts.node && path.isAbsolute(opts.node) ? path.dirname(opts.node) : undefined;
  const env = withPathFirst(opts.env, nodeDir);
  const npm = opts.npm ?? findNpm(env) ?? 'npm';
  const { paths, dir, python } = opts;
  fs.mkdirSync(paths.cacheDir, { recursive: true });
  await withUmask(0o022, async () => {
    if (opts.kind === 'full') {
      commands.push(await runStep(opts, 'build', 'make', ['-C', dir, 'build', `PY=${python}`], { env }));
      return;
    }
    const website = path.join(dir, 'website');
    commands.push(await runStep(opts, 'build', npm, ['ci', '--no-audit', '--no-fund', '--cache', paths.npmCache], { cwd: website, env }));
    commands.push(await runStep(opts, 'build', npm, ['run', 'build'], { cwd: website, env }));
    const venv = path.join(dir, '.venv');
    commands.push(await runStep(opts, 'build', python, ['-m', 'venv', venv], { env }));
    const pip = path.join(venv, 'bin', 'pip');
    commands.push(await runStep(opts, 'build', pip, ['install', '--cache-dir', paths.pipCache, '--upgrade', 'pip', 'setuptools', 'wheel'], { env }));
    commands.push(
      await runStep(opts, 'build', pip, ['install', '--cache-dir', paths.pipCache, '--prefer-binary', '-e', dir], {
        env: { ...env, KIROCREW_SKIP_FRONTEND: '1' },
      }),
    );
    commands.push(await runStep(opts, 'build', path.join(venv, 'bin', 'python'), ['-m', 'kiro_crew.frontend', 'stage', dir], { env }));
  });
  // Only the two caches we pointed npm and pip at (`$CS` may be a user-chosen directory).
  for (const d of [paths.npmCache, paths.pipCache]) fs.rmSync(d, { recursive: true, force: true });
  try {
    fs.rmdirSync(paths.cacheDir);
  } catch {
    // not empty or gone
  }
  return commands;
}

/** Installed claude-agent-acp version under `$CS/node`, if any. */
export function membersAdapterVersion(paths: CrewPaths): string | undefined {
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(paths.membersPackageDir, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof pj.version === 'string' ? pj.version : undefined;
  } catch {
    return undefined;
  }
}

/** True when the pinned adapter version is installed and its entry exists. */
export function membersAdapterInstalled(paths: CrewPaths): boolean {
  return fs.existsSync(paths.membersAdapter) && membersAdapterVersion(paths) === CLAUDE_AGENT_ACP.version;
}

export async function installMembersAdapter(opts: {
  runner: CrewRunner;
  npm: string;
  env: NodeJS.ProcessEnv;
  paths: CrewPaths;
  logFile?: string;
  force?: boolean;
}): Promise<{ installed: boolean; command?: string }> {
  if (!opts.force && membersAdapterInstalled(opts.paths)) return { installed: false };
  fs.mkdirSync(opts.paths.membersPrefix, { recursive: true });
  const args = ['i', '--prefix', opts.paths.membersPrefix, `${CLAUDE_AGENT_ACP.name}@${CLAUDE_AGENT_ACP.version}`, '--omit=optional', '--no-audit', '--no-fund'];
  const cmd = formatCommand(opts.npm, args);
  const r = await opts.runner.run(opts.npm, args, { env: opts.env, logFile: opts.logFile, timeoutMs: 30 * 60_000, cwd: opts.paths.stateDir });
  if (r.code !== 0) {
    throw new CrewStepError('members', `command failed (${r.error ?? `exit ${r.code ?? r.signal}`})`, cmd, lastLines(`${r.stdout}\n${r.stderr}`.trim(), 20).join('\n'));
  }
  if (!fs.existsSync(opts.paths.membersAdapter)) {
    throw new CrewStepError('members', `npm finished but ${opts.paths.membersAdapter} does not exist`, cmd);
  }
  return { installed: true, command: cmd };
}

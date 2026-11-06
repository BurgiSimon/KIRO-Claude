/**
 * `kiro-claude crew setup`, `crew unstub` and `crew uninstall` (08-kirocrew-integration §3.3,
 * §3.5, §3.8; user decision 09 item 1).
 *
 * Setup steps, in order; each is idempotent and a re-run skips what is already satisfied:
 * 0. preflight (node ≥ 22.12 when building, Python ≥ 3.12, git ≥ 2.36 when fetching, free disk
 *    ≥ 3 GB light / 2.5 GB `--slim` / 4 GB `--full` when fetching or building, Claude found; sign-in
 *    is a warning only) and the path guards (linked worktree, temp dir without `--allow-tmp`,
 *    `$CS` inside a probe-hidden dir);
 * 1. fetch the pinned KiroCrew (fetch.ts; skipped with `--no-fetch`);
 * 2. build (build.ts; light default, `--full` = `make build`, `--no-build` skips);
 * 3. write the shim (shim.ts; prints the restart hint if the gateway runs and the bytes changed);
 * 4. members: private claude-agent-acp (skipped with `--members none` / `--no-claude-acp`);
 * 5. KiroCrew config via keyed `kirocrew config set` only, after recording the previous raw values
 *    of config.json into `previousConfig` (first setup only);
 * 6. identity stub (identity.ts; only when no store exists; `--no-identity-stub` skips);
 * 7. write crew.json, run `crew doctor --no-gateway`, print `kiro-claude crew start`.
 * Exit: 0 ready, 1 failed step (names the step and the command), 2 usage errors (cli.ts).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';

import { KIRO_CLAUDE_VERSION } from '../version.js';
import { builtState, buildKiroCrew, detectBuildNode, detectGit, detectPython, fallbackNodeOf, findNpm, installMembersAdapter, type ToolInfo } from './build.js';
import { kirocrewFor, loadState, type CrewCtx } from './context.js';
import { renderRow, runDoctor } from './doctor.js';
import { defaultStateEnv } from './env.js';
import { CrewStepError, fetchKiroCrew, gitHead } from './fetch.js';
import { createIdentityStub, inspectIdentityStore, removeIdentityStub } from './identity.js';
import { configValueEquals, desiredConfig, gatewayRunning, readRawConfigValues } from './kirocrew.js';
import { crewStop } from './gateway.js';
import { hiddenDirContaining, identityStorePath, inLinkedGitWorktree, isUnderTmp, kirocrewConfigFile, kirocrewLauncher, resolveCheckout, type CheckoutLocation } from './paths.js';
import { CLAUDE_AGENT_ACP, DEFAULT_PORT, DISK_NEEDS, KIROCREW_PIN, shortSha } from './pin.js';
import { isGeneratedShim, writeShim } from './shim.js';
import { readState, writeState, type CrewState, type MembersBackend } from './state.js';

export interface SetupOptions {
  dir?: string;
  slim?: boolean;
  build?: 'light' | 'full' | 'none';
  fetch?: boolean;
  members?: MembersBackend;
  claudeBin?: string;
  port?: number;
  identityStub?: boolean;
  withEmbeddings?: boolean;
  appStore?: boolean;
  allowTmp?: boolean;
  /** Test-only foreign kiro-cli for the gateway env (08 §3.7, §5.0 stage A); recorded as `kiroBinOverride`. */
  kiroBin?: string;
  yes?: boolean;
}

/** Every config key setup may touch (recorded in previousConfig). */
export const CREW_CONFIG_KEYS = ['agent.acp_backend', 'agent.kas_bundle', 'agent.member_acp_backend', 'auto_update'] as const;

function gbs(n: number): string {
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

async function confirm(c: CrewCtx, question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: c.cli.stdin, output: c.cli.stdout, terminal: false });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(question, resolve);
      rl.once('close', () => resolve(''));
    });
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

class SetupFailure extends Error {}

export async function crewSetup(c: CrewCtx, o: SetupOptions = {}): Promise<number> {
  const ok = (step: string, msg: string): void => c.out(`✅ ${step}: ${msg}`);
  const warn = (step: string, msg: string): void => c.out(`⚠ ${step}: ${msg}`);
  const fail = (step: string, msg: string, extra: string[] = []): never => {
    c.err(`❌ ${step}: ${msg}`);
    for (const l of extra) c.err(`   ${l}`);
    throw new SetupFailure(msg);
  };
  try {
    return await setupSteps(c, o, { ok, warn, fail });
  } catch (e) {
    if (e instanceof SetupFailure) return 1;
    if (e instanceof CrewStepError) {
      c.err(`❌ ${e.step}: ${e.message}`);
      if (e.command) c.err(`   command: ${e.command}`);
      if (e.output) for (const l of e.output.split(/\r?\n/)) c.err(`   ${l}`);
      c.err(`   full log: ${c.paths.setupLog}`);
      return 1;
    }
    throw e;
  }
}

interface Report {
  ok(step: string, msg: string): void;
  warn(step: string, msg: string): void;
  fail(step: string, msg: string, extra?: string[]): never;
}

async function setupSteps(c: CrewCtx, o: SetupOptions, rep: Report): Promise<number> {
  const { deps, paths } = c;
  const { runner, sys } = deps;
  const buildKind = o.build ?? 'light';
  const doFetch = o.fetch !== false;
  const members: MembersBackend = o.members ?? 'claude';
  const wantStub = o.identityStub !== false;

  c.out(`Setting up Kiro Crew ${KIROCREW_PIN.version} (${shortSha(KIROCREW_PIN.commit)}) on Claude Code with kiro-claude ${KIRO_CLAUDE_VERSION}`);

  let prev: CrewState | undefined;
  try {
    prev = readState(paths.stateFile);
  } catch (e) {
    rep.warn('state', `${(e as Error).message}; starting over`);
  }

  // Where KiroCrew lives (§3.1). A re-run without --dir keeps a directory chosen earlier.
  let loc: CheckoutLocation = resolveCheckout({ flagDir: o.dir, cwd: c.cwd, env: c.env, packageRoot: deps.packageRoot });
  if (!o.dir && !c.env.KIRO_CLAUDE_CREW_DIR && prev && (prev.kirocrew.source === 'flag' || prev.kirocrew.source === 'env')) {
    loc = { dir: prev.kirocrew.dir, source: 'flag' };
  }
  fs.mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });
  fs.appendFileSync(paths.setupLog, `\n=== kiro-claude crew setup ${deps.now().toISOString()} (${loc.dir}) ===\n`, { mode: 0o600 });

  // Guards.
  if (inLinkedGitWorktree(loc.dir)) {
    rep.fail('preflight', `${loc.dir} is inside a linked git worktree; Kiro Crew treats such checkouts as ephemeral and will not manage ~/.kiro/agents. Use a primary clone of kiro-claude, or pass --dir <path elsewhere>.`);
  }
  if (!o.allowTmp && isUnderTmp(loc.dir, sys.tmpdir())) {
    rep.fail('preflight', `${loc.dir} is under the system temp directory (${sys.tmpdir()}); Kiro Crew treats short-lived trees as ephemeral. Pass --allow-tmp to use it anyway.`);
  }
  const hidden = hiddenDirContaining(paths.stateDir, c.env);
  if (hidden) {
    rep.fail('preflight', `${paths.stateDir} is inside ${hidden}, which Kiro Crew hides from its kiro-cli probes. Set KIRO_CLAUDE_CREW_HOME to another directory.`);
  }

  // Step 0: preflight.
  const notes: string[] = [];
  let git: ToolInfo | undefined;
  let headBefore: string | undefined;
  if (doFetch) {
    git = await detectGit(runner, c.env);
    if (!git.ok) rep.fail('preflight', git.problem ?? 'git is required');
    notes.push(`git ${git.version}`);
    headBefore = await gitHead(runner, git.path, loc.dir, c.env);
  }
  const fetchNeeded = doFetch && headBefore !== KIROCREW_PIN.commit;
  const b = builtState(loc.dir);
  const alreadyBuilt = b.venv && b.dist && (buildKind !== 'full' || prev?.kirocrew.build === 'full');
  const buildLikely = buildKind !== 'none' && !alreadyBuilt;

  let node: ToolInfo | undefined;
  if (buildLikely) {
    node = await detectBuildNode(runner, c.env, deps.nodePath);
    if (!node.ok) rep.fail('preflight', node.problem ?? 'Node.js 22.12 or newer is required');
    notes.push(`node ${node.version}`);
  }
  const venvPython = path.join(loc.dir, '.venv', 'bin', 'python');
  const py = await detectPython(runner, c.env);
  let stubPython: string | undefined = fs.existsSync(venvPython) ? venvPython : py.ok ? py.path : undefined;
  if (py.ok) notes.push(`python ${py.version} (${py.path})`);
  else if (buildLikely || (wantStub && !stubPython)) rep.fail('preflight', py.problem ?? 'Python 3.12 or newer is required');

  if (fetchNeeded || buildLikely) {
    const need = buildKind === 'full' ? DISK_NEEDS.full : o.slim ? DISK_NEEDS.slim : DISK_NEEDS.light;
    const free = sys.freeBytes(loc.dir);
    if (free !== undefined && free < need) {
      rep.fail('preflight', `not enough free disk at ${loc.dir}: ${gbs(free)} free, about ${gbs(need)} needed`);
    }
  }

  let claudePath: string;
  let claudeVersion: string;
  try {
    const explicit = o.claudeBin ? path.resolve(c.cwd, o.claudeBin) : prev?.claude && fs.existsSync(prev.claude) ? prev.claude : undefined;
    const info = await deps.findClaude({ explicitPath: explicit, env: c.env });
    claudePath = info.path;
    claudeVersion = info.version;
  } catch (e) {
    rep.fail('preflight', `Claude Code was not found: ${(e as Error).message}`);
  }
  claudePath = path.resolve(claudePath!);
  const auth = await deps.claudeAuth({ path: claudePath, version: claudeVersion! }, c.env);
  notes.push(`Claude Code ${claudeVersion!} (${claudePath})`);
  rep.ok('preflight', notes.join(', '));
  if (!auth.loggedIn) rep.warn('preflight', 'Claude Code is not signed in; run: kiro-claude login (or claude auth login)');

  if ((fetchNeeded || buildLikely) && !o.yes && c.cli.stdin.isTTY && c.cli.stdout.isTTY) {
    const what = [fetchNeeded ? 'download' : '', buildLikely ? 'build' : ''].filter(Boolean).join(' and ');
    const okToGo = await confirm(c, `This will ${what} Kiro Crew in ${loc.dir} (about ${gbs(buildKind === 'full' ? 3.2 * 1024 ** 3 : 2.9 * 1024 ** 3)} on disk). Continue? [y/N] `);
    if (!okToGo) {
      c.err('Setup cancelled.');
      return 1;
    }
  }

  // Step 1: fetch.
  if (doFetch && git) {
    const r = await fetchKiroCrew({ location: loc, runner, git: git.path, env: c.env, slim: o.slim, logFile: paths.setupLog });
    rep.ok('fetch', r.fetched ? `KiroCrew ${shortSha(r.commit)} checked out in ${r.dir}` : `${r.dir} is already at ${shortSha(r.commit)}`);
  } else {
    rep.ok('fetch', `skipped (--no-fetch); using ${loc.dir}`);
  }
  const launcher = kirocrewLauncher(loc.dir);
  if (!fs.existsSync(launcher)) rep.fail('fetch', `${launcher} does not exist; ${loc.dir} is not a Kiro Crew checkout`);

  // Base state (the gateway env needs claude/members).
  const state: CrewState = {
    version: 1,
    kirocrew: {
      dir: loc.dir,
      url: KIROCREW_PIN.url,
      commit: KIROCREW_PIN.commit,
      build: prev?.kirocrew.dir === loc.dir ? prev.kirocrew.build : 'none',
      python: py.ok ? py.path : prev?.kirocrew.python,
      source: loc.source,
    },
    shim: paths.shim,
    node: deps.nodePath,
    entry: deps.entryPath,
    claude: claudePath,
    members: { backend: members, adapter: members === 'claude' ? paths.membersAdapter : undefined },
    port: o.port ?? prev?.port ?? DEFAULT_PORT,
    identityStub: prev?.identityStub ?? { created: false, path: identityStorePath(c.home, sys.platform) },
    previousConfig: prev?.previousConfig ?? {},
    env: defaultStateEnv({ withEmbeddings: o.withEmbeddings, appStore: o.appStore }),
    // Like `crew start`, a setup without --kiro-bin goes back to the shim.
    kiroBinOverride: o.kiroBin && o.kiroBin !== paths.shim ? o.kiroBin : undefined,
  };
  const { kc, gw } = kirocrewFor(c, state);
  for (const w of gw.warnings) rep.warn('env', w);
  // Record KiroCrew's original config values (first setup only) and persist them before any
  // step can change config.json, so a failed run never loses them.
  if (Object.keys(state.previousConfig).length === 0) state.previousConfig = readRawConfigValues(kirocrewConfigFile(c.env), CREW_CONFIG_KEYS);
  writeState(paths.stateFile, state);

  // Step 2: build.
  let running = false;
  if (buildKind === 'none') {
    rep.ok('build', `skipped (--no-build)${b.venv && b.dist ? '' : '; the checkout does not look built'}`);
  } else {
    let satisfied = false;
    if (alreadyBuilt) {
      const v = await kc.version();
      satisfied = v.ok;
      if (satisfied) {
        // A full build includes the light one.
        state.kirocrew.build = buildKind === 'full' || (prev?.kirocrew.dir === loc.dir && prev.kirocrew.build === 'full') ? 'full' : 'light';
        rep.ok('build', `already built (${v.line})`);
      }
    }
    if (!satisfied) {
      if (b.venv) {
        running = gatewayRunning(await kc.gatewayPid());
        if (running) rep.fail('build', 'the Kiro Crew gateway is running; stop it first: kiro-claude crew stop');
      }
      node ??= await detectBuildNode(runner, c.env, deps.nodePath);
      if (!node.ok) rep.fail('build', node.problem ?? 'Node.js 22.12 or newer is required');
      if (!py.ok) rep.fail('build', py.problem ?? 'Python 3.12 or newer is required');
      c.out(`   building Kiro Crew (${buildKind}); output goes to ${paths.setupLog}`);
      await buildKiroCrew({
        dir: loc.dir,
        kind: buildKind,
        python: py.path,
        node: node.path,
        npm: findNpm(c.env, fallbackNodeOf(node, c.env)),
        runner,
        env: c.env,
        paths,
        logFile: paths.setupLog,
        onCommand: (cmd) => c.out(`   $ ${cmd}`),
      });
      const v = await kc.version();
      if (!v.ok) rep.fail('build', `bin/kirocrew --version printed ${JSON.stringify(v.line || v.result.stderr.trim().split(/\r?\n/).pop() || '')}, expected kirocrew ${KIROCREW_PIN.version}`);
      state.kirocrew.build = buildKind;
      rep.ok('build', `${buildKind} build done (${v.line})`);
    }
  }
  if (fs.existsSync(venvPython)) stubPython = venvPython;

  // Step 3: shim.
  if (!running && builtState(loc.dir).venv) running = gatewayRunning(await kc.gatewayPid());
  const shim = writeShim(paths.shim, { node: state.node, entry: state.entry, claude: state.claude });
  rep.ok('shim', `${shim.path} (${shim.changed ? 'written' : 'unchanged'})`);
  if (shim.changed && running) c.out('   restart the gateway: kiro-claude crew stop && kiro-claude crew start');

  // Step 4: members.
  if (members === 'claude') {
    const npm = findNpm(c.env, fallbackNodeOf(node, c.env));
    if (!npm) rep.fail('members', 'npm was not found on PATH (needed to install claude-agent-acp); or pass --members none');
    const r = await installMembersAdapter({ runner, npm: npm!, env: c.env, paths, logFile: paths.setupLog });
    rep.ok('members', r.installed ? `installed claude-agent-acp in ${paths.membersPrefix}` : 'claude-agent-acp already installed');
  } else {
    rep.ok('members', 'skipped (--members none): Bots will be unavailable');
  }

  // Step 5: KiroCrew config. Every crew key is written explicitly into config.json (§3.3 step 5
  // lists all four `config set` calls): a key is skipped only when config.json itself already
  // holds the value. KiroCrew's effective config is not enough (e.g. agent.kas_bundle defaults to
  // false in 0.13.0, SRC config/sections_agent.py), and doctor D4 checks it afterwards.
  {
    const want = desiredConfig(members);
    const raw = readRawConfigValues(kirocrewConfigFile(c.env), want.map(([k]) => k));
    const set: string[] = [];
    for (const [key, value] of want) {
      const cur = raw[key];
      if (cur !== null && cur !== undefined && configValueEquals(cur, value)) continue;
      const r = await kc.configSet(key, value);
      if (r.code !== 0) {
        rep.fail('config', `kirocrew config set ${key} failed (exit ${r.code ?? r.signal})`, [
          `command: ${kc.launcher} config set ${key} ${String(value)}`,
          ...(r.stderr || r.stdout).trim().split(/\r?\n/).slice(-5),
        ]);
      }
      set.push(`${key}=${String(value)}`);
    }
    rep.ok('config', set.length ? `set ${set.join(', ')}` : 'already set');
  }

  // Step 6: identity stub.
  {
    const storePath = identityStorePath(c.home, sys.platform);
    state.identityStub.path = storePath;
    if (!wantStub) {
      state.identityStub.optOut = true;
      const ins = await inspectIdentityStore(storePath, { runner, python: stubPython, env: c.env }).catch(() => undefined);
      state.identityStub.created = ins?.exists === true && ins.ours;
      rep.ok('identity', `skipped (--no-identity-stub)${state.identityStub.created ? '; an earlier kiro-claude stub is still there (remove it with: kiro-claude crew unstub)' : ''}`);
    } else {
      state.identityStub.optOut = undefined;
      if (!stubPython) rep.fail('identity', 'Python 3.12+ is needed to write the identity stub');
      const before = await inspectIdentityStore(storePath, { runner, python: stubPython, env: c.env });
      if (before.exists) {
        state.identityStub.created = before.ours;
        rep.ok('identity', before.ours ? `kiro-claude identity stub already present (${storePath})` : `a kiro-cli identity store already exists at ${storePath}; left untouched`);
      } else {
        const r = await createIdentityStub(storePath, { runner, python: stubPython!, now: deps.now(), env: c.env });
        state.identityStub.created = r.result === 'created';
        if (r.createdDir) state.identityStub.createdDir = true;
        rep.ok(
          'identity',
          r.result === 'created'
            ? `wrote a token-less kiro-cli identity stub (no credentials) at ${storePath}; remove it with: kiro-claude crew unstub`
            : `a kiro-cli identity store appeared at ${storePath}; left untouched`,
        );
      }
    }
  }

  // Step 7: state + doctor.
  writeState(paths.stateFile, state);
  rep.ok('state', paths.stateFile);
  c.out('');
  c.out('Checking the installation (kiro-claude crew doctor --no-gateway):');
  const report = await runDoctor(c, { noGateway: true });
  for (const r of report.rows) for (const l of renderRow(r)) c.out(`  ${l}`);
  c.out('');
  if (!report.ok) {
    c.err('Setup finished, but the checks above report problems. Fix them and rerun: kiro-claude crew doctor');
    return 1;
  }
  c.out('Kiro Crew is ready. Next: kiro-claude crew start');
  return 0;
}

// ───────────────────────────── unstub ─────────────────────────────

async function pickPython(c: CrewCtx, state: CrewState | undefined): Promise<string | undefined> {
  const venv = state ? path.join(state.kirocrew.dir, '.venv', 'bin', 'python') : undefined;
  if (venv && fs.existsSync(venv)) return venv;
  if (state?.kirocrew.python && fs.existsSync(state.kirocrew.python)) return state.kirocrew.python;
  const py = await detectPython(c.deps.runner, c.env);
  return py.ok ? py.path : undefined;
}

/** `crew unstub`: delete the identity stub only if it is ours (09 item 1). */
export async function crewUnstub(c: CrewCtx): Promise<number> {
  let state: CrewState | undefined;
  try {
    state = readState(c.paths.stateFile);
  } catch {
    state = undefined;
  }
  const storePath = state?.identityStub.path || identityStorePath(c.home, c.deps.sys.platform);
  if (!fs.existsSync(storePath)) {
    c.out(`No kiro-cli identity store at ${storePath}; nothing to remove.`);
    if (state?.identityStub.created) {
      state.identityStub.created = false;
      writeState(c.paths.stateFile, state);
    }
    return 0;
  }
  const python = await pickPython(c, state);
  if (!python) {
    c.err('kiro-claude: Python 3.12+ is needed to check that the store is kiro-claude\'s stub before deleting it.');
    return 1;
  }
  const r = await removeIdentityStub(storePath, { runner: c.deps.runner, python, removeDir: state?.identityStub.createdDir === true, env: c.env });
  if (r.result === 'removed') {
    c.out(`Removed the kiro-claude identity stub at ${storePath}.`);
    c.out('Kiro Crew will now restart idle agents on every dashboard turn unless kiro-cli is signed in.');
    if (state) {
      state.identityStub = { ...state.identityStub, created: false, createdDir: undefined };
      writeState(c.paths.stateFile, state);
    }
    return 0;
  }
  if (r.result === 'absent') {
    c.out(`No kiro-cli identity store at ${storePath}; nothing to remove.`);
    return 0;
  }
  c.err(`kiro-claude: ${storePath} is not kiro-claude's identity stub (a real kiro-cli store, or one that has been changed since); left untouched.`);
  return 1;
}

// ───────────────────────────── uninstall ─────────────────────────────

/**
 * `crew uninstall [--purge]` (§3.8): stop; restore `previousConfig` (keyed `config set` for values;
 * keys that were absent are removed through KiroCrew's own locked config writer — only where the
 * value is still the one setup wrote); remove the shim (only if it carries our header) and our
 * stub. `--purge` also removes what crew created under `$CS`, and `$CS` itself when that leaves it
 * empty (see {@link purgeStateDir}). The KiroCrew data home and the checkout are never removed.
 */
export async function crewUninstall(c: CrewCtx, o: { purge?: boolean } = {}): Promise<number> {
  const state = loadState(c);
  if (!state) return 1;
  const stopCode = await crewStop(c, {});
  if (stopCode !== 0) {
    c.err('kiro-claude: the gateway did not stop; not uninstalling.');
    return 1;
  }
  const kcAvailable = fs.existsSync(kirocrewLauncher(state.kirocrew.dir));
  const { kc } = kirocrewFor(c, state);
  const configFile = kirocrewConfigFile(c.env);
  const ours = new Map(desiredConfig(state.members.backend));
  const raw = readRawConfigValues(configFile, Object.keys(state.previousConfig));
  const restored: string[] = [];
  const toDelete: string[] = [];
  for (const [key, prevValue] of Object.entries(state.previousConfig)) {
    if (!ours.has(key)) continue;
    const now = raw[key];
    if (now === null || !configValueEquals(now, ours.get(key))) continue; // changed since; leave it
    if (prevValue === null || prevValue === undefined) toDelete.push(key);
    else if (kcAvailable) {
      const r = await kc.configSet(key, prevValue);
      if (r.code === 0) restored.push(key);
      else c.err(`warning: could not restore ${key}: ${(r.stderr || r.stdout).trim().split(/\r?\n/).pop() ?? ''}`);
    } else c.err(`warning: could not restore ${key}=${JSON.stringify(prevValue)}: ${kc.launcher} is missing`);
  }
  if (toDelete.length) {
    // A key absent before setup is removed with a locked edit (KiroCrew has only get/set), while
    // the gateway is stopped (08 §3.8).
    const r = await kc.removeConfigKeys(toDelete, configFile);
    if (r.warning) c.err(`warning: ${r.warning}`);
    restored.push(...r.removed);
  }
  c.out(restored.length ? `Restored Kiro Crew config: ${restored.join(', ')}` : 'Kiro Crew config: nothing to restore');

  // Only files this module wrote are removed: crew.json's paths are not trusted blindly, and
  // $CS may be a user-chosen directory (KIRO_CLAUDE_CREW_HOME).
  for (const shim of new Set([state.shim || c.paths.shim, c.paths.shim])) {
    if (isGeneratedShim(shim)) {
      fs.rmSync(shim, { force: true });
      c.out(`Removed the shim ${shim}`);
    } else if (fs.existsSync(shim)) c.err(`warning: ${shim} is not a shim written by kiro-claude crew setup; left untouched`);
  }
  if (state.identityStub.created && fs.existsSync(state.identityStub.path)) {
    const python = await pickPython(c, state);
    if (python) {
      const r = await removeIdentityStub(state.identityStub.path, { runner: c.deps.runner, python, removeDir: state.identityStub.createdDir === true, env: c.env });
      c.out(r.result === 'removed' ? `Removed the identity stub ${state.identityStub.path}` : `Left ${state.identityStub.path} untouched (not kiro-claude's stub)`);
    } else c.err(`warning: no Python to verify ${state.identityStub.path}; left untouched`);
  }
  removeOwnRunFiles(c);
  fs.rmSync(c.paths.stateFile, { force: true });
  if (o.purge) {
    purgeStateDir(c);
    const keep = path.resolve(state.kirocrew.dir);
    c.out(`Purged ${c.paths.stateDir}${fs.existsSync(keep) && isSubpathOf(keep, c.paths.stateDir) ? ` (kept the Kiro Crew checkout ${keep})` : ''}`);
  }
  c.out(`Kiro Crew's data home and the checkout ${state.kirocrew.dir} were kept.`);
  return 0;
}

function isSubpathOf(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function rmdirIfEmpty(dir: string): void {
  try {
    fs.rmdirSync(dir);
  } catch {
    // not empty, or already gone
  }
}

/** Removes the files `crew` writes under `$CS/run` (never anything else there). */
function removeOwnRunFiles(c: CrewCtx): void {
  const p = c.paths;
  for (const f of [p.gatewayOut, p.gatewayErr, p.readyFile, p.tokenFile, p.setupLog]) fs.rmSync(f, { force: true });
  rmdirIfEmpty(p.runDir);
}

/**
 * `--purge`: removes what crew created in `$CS` — the shim dir (when empty), the run files, the
 * build caches, crew.json leftovers and the private claude-agent-acp prefix (only when its
 * package.json depends on nothing but that adapter) — then `$CS` itself when empty. Unknown
 * entries and a Kiro Crew checkout inside `$CS` are kept.
 */
function purgeStateDir(c: CrewCtx): void {
  const p = c.paths;
  rmdirIfEmpty(p.binDir);
  removeOwnRunFiles(c);
  for (const d of [p.npmCache, p.pipCache]) fs.rmSync(d, { recursive: true, force: true });
  rmdirIfEmpty(p.cacheDir);
  if (isOwnMembersPrefix(p.membersPrefix)) fs.rmSync(p.membersPrefix, { recursive: true, force: true });
  try {
    for (const e of fs.readdirSync(p.stateDir)) {
      if (/^\.crew\.json\..*\.tmp$/.test(e)) fs.rmSync(path.join(p.stateDir, e), { force: true });
    }
  } catch {
    // gone
  }
  rmdirIfEmpty(p.stateDir);
}

function isOwnMembersPrefix(prefix: string): boolean {
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(prefix, 'package.json'), 'utf8')) as { dependencies?: unknown };
    const deps = pj.dependencies && typeof pj.dependencies === 'object' ? Object.keys(pj.dependencies) : [];
    if (deps.length !== 1 || deps[0] !== CLAUDE_AGENT_ACP.name) return false;
    const allowed = new Set(['package.json', 'package-lock.json', 'node_modules']);
    return fs.readdirSync(prefix).every((e) => allowed.has(e));
  } catch {
    return false;
  }
}

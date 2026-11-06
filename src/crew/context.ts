/**
 * Dependencies and per-invocation context shared by the `kiro-claude crew` subcommands.
 *
 * Everything with a side effect outside the crew state dir goes through {@link CrewDeps} (runner,
 * process/system seams, HTTP, Claude discovery), so the test suite can substitute fakes; the
 * defaults are the real implementations. Output goes to the CLI context streams only.
 */
import * as fs from 'node:fs';

import { ClaudeNotFoundError, findClaudeBinary } from '../claude/binary.js';
import { getAuthStatus } from '../claude/auth.js';
import { buildChildEnv } from '../claude/env.js';
import type { CliContext } from '../types.js';
import { homeDir } from '../util/paths.js';
import { defaultHttp, type HttpFn } from './api.js';
import { computeGatewayEnv, type GatewayEnv } from './env.js';
import { KiroCrewCli } from './kirocrew.js';
import { crewPaths, defaultEntryPath, findPackageRoot, type CrewPaths } from './paths.js';
import { FLOORS } from './pin.js';
import { defaultRunner, defaultSys, type CrewRunner, type CrewSys } from './runner.js';
import { CrewStateError, readState, type CrewState } from './state.js';

export interface ClaudeInfo {
  path: string;
  version: string;
}

export interface CrewDeps {
  runner: CrewRunner;
  sys: CrewSys;
  http: HttpFn;
  /** kiro-claude package root (submodule lookup); `null` = not a package checkout. */
  packageRoot: string | null;
  /** node baked into the shim (`process.execPath`). */
  nodePath: string;
  /** kiro-claude JS entry baked into the shim. */
  entryPath: string;
  /** Locate and verify Claude Code (`explicitPath` = `--claude-bin` or crew.json). Throws ClaudeNotFoundError. */
  findClaude(opts: { explicitPath?: string; env: NodeJS.ProcessEnv }): Promise<ClaudeInfo>;
  /** `claude auth status --json` → loggedIn. Never throws. */
  claudeAuth(bin: ClaudeInfo, env: NodeJS.ProcessEnv): Promise<{ loggedIn: boolean; detail?: string }>;
  /** `crew start` readiness wait (08 §3.8: 90 s). */
  startTimeoutMs: number;
  /** Poll interval used by start/stop waits and `logs -f`. */
  pollMs: number;
  /** `crew stop`: SIGTERM → SIGKILL grace (08 §3.8: 10 s). */
  killGraceMs: number;
  now(): Date;
  /** Aborts `logs -f` / `start --foreground` waits (default: SIGINT). */
  signal?: AbortSignal;
}

export function defaultDeps(): CrewDeps {
  return {
    runner: defaultRunner,
    sys: defaultSys,
    http: defaultHttp,
    packageRoot: findPackageRoot() ?? null,
    nodePath: process.execPath,
    entryPath: defaultEntryPath(),
    async findClaude({ explicitPath, env }) {
      // KC-ENV-05 order: explicit (`--claude-bin` / crew.json), $KIRO_CLAUDE_BIN, PATH, well-known paths.
      const bin = await findClaudeBinary({ explicitPath, env, minVersion: FLOORS.claude });
      return { path: bin.path, version: bin.version };
    },
    async claudeAuth(bin, env) {
      try {
        const st = await getAuthStatus({ path: bin.path, version: bin.version, rawVersion: bin.version }, buildChildEnv(env));
        return { loggedIn: st.loggedIn, detail: st.authMethod ?? st.text };
      } catch (e) {
        return { loggedIn: false, detail: (e as Error).message };
      }
    },
    startTimeoutMs: 90_000,
    pollMs: 250,
    killGraceMs: 10_000,
    now: () => new Date(),
  };
}

export { ClaudeNotFoundError };

/** Per-invocation context. */
export interface CrewCtx {
  cli: CliContext;
  deps: CrewDeps;
  env: NodeJS.ProcessEnv;
  home: string;
  cwd: string;
  paths: CrewPaths;
  out(line?: string): void;
  err(line?: string): void;
}

export function makeCrewCtx(cli: CliContext, deps: CrewDeps): CrewCtx {
  const env = cli.ws.env;
  return {
    cli,
    deps,
    env,
    home: cli.ws.home || homeDir(env),
    cwd: cli.ws.cwd,
    paths: crewPaths(env),
    out: (line = '') => {
      cli.stdout.write(`${line}\n`);
    },
    err: (line = '') => {
      cli.stderr.write(`${line}\n`);
    },
  };
}

/** Reads crew.json, printing a hint when setup has not run. */
export function loadState(c: CrewCtx, opts: { quiet?: boolean } = {}): CrewState | undefined {
  let state: CrewState | undefined;
  try {
    state = readState(c.paths.stateFile);
  } catch (e) {
    if (e instanceof CrewStateError) {
      c.err(`kiro-claude: ${e.message}`);
      c.err('Run: kiro-claude crew setup');
      return undefined;
    }
    throw e;
  }
  if (!state && !opts.quiet) {
    c.err('Kiro Crew is not set up yet. Run: kiro-claude crew setup');
  }
  return state;
}

/**
 * Gateway env (08 §3.7) for a state. `KIROCREW_KIRO_BIN` is `opts.kiroBin`, else the test-only
 * override recorded by `crew start --kiro-bin` / `crew setup --kiro-bin`, else the shim — so every
 * crew command (exec, doctor's D12, stop, status) runs kirocrew with the same binary as the
 * gateway it manages (08 §0 item 9: "all with one computed gateway environment").
 */
export function gatewayEnvFor(c: CrewCtx, state: CrewState, opts: { extra?: Record<string, string>; kiroBin?: string } = {}): GatewayEnv {
  return computeGatewayEnv(c.env, {
    shim: state.shim || c.paths.shim,
    kiroBin: opts.kiroBin ?? state.kiroBinOverride,
    state,
    membersAdapter: state.members.adapter ?? c.paths.membersAdapter,
    extra: opts.extra,
    platform: c.deps.sys.platform,
  });
}

/** KiroCrew CLI wrapper bound to the state's checkout and the gateway env. */
export function kirocrewFor(c: CrewCtx, state: CrewState, opts: { extra?: Record<string, string>; kiroBin?: string; cwd?: string } = {}): { kc: KiroCrewCli; gw: GatewayEnv } {
  const gw = gatewayEnvFor(c, state, opts);
  return { kc: new KiroCrewCli({ dir: state.kirocrew.dir, env: gw.env, runner: c.deps.runner, cwd: opts.cwd }), gw };
}

/** Reads `run/ready.json` (the parsed `KIROCREW_READY:{…}` object). */
export function readReady(paths: CrewPaths): { port?: number; token?: string; pid?: number; home?: string } | undefined {
  try {
    const j = JSON.parse(fs.readFileSync(paths.readyFile, 'utf8')) as Record<string, unknown>;
    return {
      port: typeof j.port === 'number' ? j.port : undefined,
      token: typeof j.token === 'string' ? j.token : undefined,
      pid: typeof j.pid === 'number' ? j.pid : undefined,
      home: typeof j.home === 'string' ? j.home : undefined,
    };
  } catch {
    return undefined;
  }
}

export function readToken(paths: CrewPaths): string | undefined {
  try {
    const t = fs.readFileSync(paths.tokenFile, 'utf8').trim();
    return t || undefined;
  } catch {
    return undefined;
  }
}

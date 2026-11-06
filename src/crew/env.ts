/**
 * The gateway environment (08-kirocrew-integration §3.7), computed by every crew command that
 * runs `kirocrew`:
 *
 * 1. start from the process env;
 * 2. delete the 00 §3.2 scrub list (`CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION_ID`,
 *    `CLAUDE_CODE_REMOTE*`, `CCR_*`, `CLAUDE_SESSION_INGRESS*`, …) — the gateway passes its env to
 *    claude-agent-acp children, where a leaked session id is adopted (04 §15);
 * 3. delete a relocated `XDG_DATA_HOME` (≠ `$HOME/.local/share`) and warn (V7: KiroCrew then
 *    reads the identity store as absent and sweeps runtimes every turn);
 * 4. set `KIROCREW_KIRO_BIN`, `KIROCREW_SKIP_MODEL_DOWNLOAD=1` (unless `--with-embeddings`),
 *    `KIROCREW_SKIP_APP_STORE_FETCH=1` (unless `--app-store`), `PYTHONUNBUFFERED=1`,
 *    `CLAUDE_AGENT_ACP_BIN` (members = claude), `CLAUDE_CODE_EXECUTABLE`, then each `--env K=V`.
 *
 * Never sets `KIROCREW_HOME` or `KIRO_HOME` (§3.1, V13); a user-set non-default `KIRO_HOME` is kept
 * but reported.
 */
import * as path from 'node:path';

import { isScrubbedSessionVar } from '../claude/env.js';
import { homeDir } from '../util/paths.js';
import type { CrewState } from './state.js';

/** Default extra env recorded in crew.json by setup (§3.2 `env`). */
export function defaultStateEnv(opts: { withEmbeddings?: boolean; appStore?: boolean } = {}): Record<string, string> {
  const env: Record<string, string> = {};
  if (!opts.withEmbeddings) env.KIROCREW_SKIP_MODEL_DOWNLOAD = '1';
  if (!opts.appStore) env.KIROCREW_SKIP_APP_STORE_FETCH = '1';
  return env;
}

export interface GatewayEnvOptions {
  /** Shim path (`$CS/bin/kiro-claude`); `kiroBin` overrides it (test-only `--kiro-bin`). */
  shim: string;
  kiroBin?: string;
  /** crew.json fields used: `claude`, `members`, `env`. */
  state?: Pick<CrewState, 'claude' | 'members' | 'env'>;
  /** Members adapter entry (when state.members.backend === 'claude'). */
  membersAdapter?: string;
  /** `--env K=V` pairs, applied last. */
  extra?: Record<string, string>;
  platform?: NodeJS.Platform;
}

export interface GatewayEnv {
  env: NodeJS.ProcessEnv;
  warnings: string[];
}

export function isRelocatedXdgDataHome(env: NodeJS.ProcessEnv): boolean {
  const v = env.XDG_DATA_HOME;
  if (v === undefined || v.trim() === '') return false;
  return path.resolve(v.trim()) !== path.join(homeDir(env), '.local', 'share');
}

export function computeGatewayEnv(base: NodeJS.ProcessEnv, opts: GatewayEnvOptions): GatewayEnv {
  const platform = opts.platform ?? process.platform;
  const warnings: string[] = [];
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (isScrubbedSessionVar(k, platform)) continue;
    env[k] = v;
  }
  if (isRelocatedXdgDataHome(env)) {
    warnings.push(
      `XDG_DATA_HOME (${env.XDG_DATA_HOME}) is not ${path.join(homeDir(env), '.local', 'share')}; it is removed from the Kiro Crew gateway environment, because Kiro Crew reads a relocated kiro-cli identity store as signed out.`,
    );
    delete env.XDG_DATA_HOME;
  }
  const kh = env.KIRO_HOME;
  if (kh && kh.trim() && path.resolve(kh.trim()) !== path.join(homeDir(env), '.kiro')) {
    warnings.push(`KIRO_HOME is set to ${kh}; Kiro Crew only partly honours a non-default KIRO_HOME (unset it for Kiro Crew).`);
  }
  env.KIROCREW_KIRO_BIN = opts.kiroBin ?? opts.shim;
  // crew.json's recorded env (the download skips) goes on top of the inherited values.
  for (const [k, v] of Object.entries(opts.state?.env ?? defaultStateEnv())) env[k] = v;
  env.PYTHONUNBUFFERED = '1';
  if (opts.state?.members.backend !== 'none' && opts.membersAdapter) env.CLAUDE_AGENT_ACP_BIN = opts.membersAdapter;
  if (opts.state?.claude) env.CLAUDE_CODE_EXECUTABLE = opts.state.claude;
  if (opts.extra) for (const [k, v] of Object.entries(opts.extra)) env[k] = v;
  return { env, warnings };
}

/** Parses `K=V` (`--env`); throws on a malformed pair. */
export function parseEnvPair(pair: string): [string, string] {
  const eq = pair.indexOf('=');
  const key = eq > 0 ? pair.slice(0, eq) : '';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`invalid --env value '${pair}' (expected NAME=VALUE)`);
  return [key, pair.slice(eq + 1)];
}

/**
 * KiroCrew's credential-minimal probe environment (V5, §2.0 `$PROBE`):
 * `env -i HOME=$HOME PATH=/usr/bin:/bin LANG=C.UTF-8 NO_COLOR=1 TERM=dumb`.
 */
export function probeEnv(home: string): NodeJS.ProcessEnv {
  return { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', NO_COLOR: '1', TERM: 'dumb' };
}

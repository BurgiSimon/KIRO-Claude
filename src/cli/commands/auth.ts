/**
 * `login`, `logout`, `whoami` (01 §2.4, 00 §2.1 row "login / logout / whoami", 08 KC-CLI-04/05/11,
 * 08a §2.1 #7–#9).
 *
 * kiro-claude never touches credentials: these commands delegate to `claude auth …`.
 *
 * - `login`: Kiro's flags (`--license pro|free`, `--identity-provider`, `--region`, `--social`,
 *   `--use-device-flow`) are accepted; Kiro-only ones are ignored with a one-line note.
 *   Runs `claude auth login --claudeai` (subscription login; `--license pro` ⇒ `--sso`, 01 §2.4)
 *   with inherited stdio. Already signed in ⇒ Q's `Already logged in, please logout with
 *   <prog> logout first` (Q `cli/user.rs`), exit 1.
 * - `logout`: `claude auth logout`, then (stderr, like Q) `You are now logged out` /
 *   `Run <prog> login to log back in to Claude Code` (01 §2.4 with our names).
 * - `whoami [--format plain|json|json-pretty]` (08 KC-CLI-04/05, binding):
 *   signed in ⇒ stdout `Logged in with Claude Code (<authMethod>)` [+ `\nEmail: <email>`], exit 0;
 *   JSON ⇒ one object `{"email": …}` or `{}` (never `accountType`: any value would be a false claim);
 *   signed out ⇒ stderr `Not logged in. Run "<prog> login" to sign in to Claude Code.`, exit 1
 *   (KiroCrew looks for "not logged in", case-folded); `claude` missing or not answering within
 *   20 s ⇒ stderr `Not logged in: Claude Code not found (<path>)`, exit 1. Never prompts.
 */

import type { CliContext } from '../../types.js';
import { getAuthStatus, runAuthCommand, type AuthStatus } from '../../claude/auth.js';
import { ClaudeNotFoundError, findClaudeBinary, type ClaudeBinary } from '../../claude/binary.js';
import { buildChildEnv } from '../../claude/env.js';
import { levelFromVerbosity, log } from '../../util/log.js';
import type { CommandDef } from '../args.js';
import { err, errorText, out, parseOrExit } from '../io.js';
import { OUTPUT_FORMATS, VERBOSE_ARG } from './chatArgs.js';

export const WHOAMI_TIMEOUT_MS = 20_000;

export const LOGIN_DEF: CommandDef = {
  name: 'login',
  about: 'Sign in to Claude Code (runs claude auth login)',
  args: [
    { id: 'license', long: 'license', kind: 'value', valueName: 'LICENSE', possibleValues: ['pro', 'free'], help: 'Accepted for compatibility (pro signs in with SSO)' },
    { id: 'identity-provider', long: 'identity-provider', kind: 'value', valueName: 'URL', help: 'Accepted for compatibility (Kiro only)' },
    { id: 'region', long: 'region', kind: 'value', valueName: 'REGION', help: 'Accepted for compatibility (Kiro only)' },
    { id: 'social', long: 'social', kind: 'value', valueName: 'PROVIDER', possibleValues: ['google', 'github'], help: 'Accepted for compatibility (Kiro only)' },
    { id: 'use-device-flow', long: 'use-device-flow', kind: 'bool', help: 'Accepted for compatibility (Kiro only)' },
    { id: 'console', long: 'console', kind: 'bool', help: 'Sign in with an Anthropic Console account (API billing) instead of a Claude subscription' },
    VERBOSE_ARG,
  ],
};

export const LOGOUT_DEF: CommandDef = {
  name: 'logout',
  about: 'Sign out of Claude Code (runs claude auth logout)',
  args: [VERBOSE_ARG],
};

export const WHOAMI_DEF: CommandDef = {
  name: 'whoami',
  about: 'Prints details about the current user',
  args: [
    { id: 'format', long: 'format', short: 'f', kind: 'value', valueName: 'FORMAT', possibleValues: OUTPUT_FORMATS, defaultValue: 'plain', help: 'Output format' },
    VERBOSE_ARG,
  ],
};

/** The path we would run, for messages (`$KIRO_CLAUDE_BIN`, `kiroClaude.claudePath`, else `claude`). */
export function configuredClaudePath(ctx: CliContext): string {
  return ctx.settings.getString('kiroClaude.claudePath') || ctx.ws.env.KIRO_CLAUDE_BIN?.trim() || 'claude';
}

/** Locate `claude` with the session's discovery rules (claude/binary.ts). */
export async function locateClaude(ctx: CliContext): Promise<{ bin?: ClaudeBinary; error?: string }> {
  const explicitPath = ctx.settings.getString('kiroClaude.claudePath');
  try {
    // The setting ranks below $KIRO_CLAUDE_BIN (claude/binary.ts precedence, 08 KC-ENV-05).
    const bin = await findClaudeBinary({ ...(explicitPath ? { settingPath: explicitPath } : {}), env: ctx.ws.env });
    return { bin };
  } catch (e) {
    return { error: e instanceof ClaudeNotFoundError ? e.message : errorText(e) };
  }
}

/** Child env for `claude auth …` (same scrubbing as sessions). */
export function authEnv(ctx: CliContext): NodeJS.ProcessEnv {
  return buildChildEnv(ctx.ws.env, { allowApiKey: ctx.settings.getBoolean('kiroClaude.allowApiKey', false) });
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve('timeout'), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Signed-out message (08 KC-CLI-04). */
export function signedOutMessage(progName: string): string {
  return `Not logged in. Run "${progName} login" to sign in to Claude Code.`;
}

/** Query login state; `undefined` status means Claude Code could not be asked. */
export async function queryAuth(ctx: CliContext, timeoutMs = WHOAMI_TIMEOUT_MS): Promise<{ status?: AuthStatus; bin?: ClaudeBinary }> {
  const loc = await locateClaude(ctx);
  if (!loc.bin) return {};
  try {
    const r = await withTimeout(getAuthStatus(loc.bin, authEnv(ctx)), timeoutMs);
    if (r === 'timeout') return { bin: loc.bin };
    if (!r.loggedIn && r.text && /timed out/i.test(r.text)) return { bin: loc.bin };
    return { status: r, bin: loc.bin };
  } catch {
    return { bin: loc.bin };
  }
}

export async function runWhoamiCommand(args: string[], ctx: CliContext): Promise<number> {
  const p = parseOrExit(WHOAMI_DEF, args, ctx);
  if (typeof p === 'number') return p;
  if (p.count('verbose') > 0) log.setLevel(levelFromVerbosity(ctx.verbosity + p.count('verbose'), log.level));
  const format = (p.value('format') ?? 'plain') as 'plain' | 'json' | 'json-pretty';
  // One overall bound (08 KC-CLI-04: missing or > 20 s ⇒ "not found"); KiroCrew waits 30 s.
  const q = await withTimeout(queryAuth(ctx), WHOAMI_TIMEOUT_MS);
  const status = q === 'timeout' ? undefined : q.status;
  if (!status) {
    err(ctx, `Not logged in: Claude Code not found (${configuredClaudePath(ctx)})`);
    return 1;
  }
  if (!status.loggedIn) {
    err(ctx, signedOutMessage(ctx.progName));
    return 1;
  }
  if (format === 'plain') {
    out(ctx, `Logged in with Claude Code${status.authMethod ? ` (${status.authMethod})` : ''}`);
    if (status.email) out(ctx, `Email: ${status.email}`);
    return 0;
  }
  const obj = status.email ? { email: status.email } : {};
  out(ctx, format === 'json' ? JSON.stringify(obj) : JSON.stringify(obj, null, 2));
  return 0;
}

export async function runLoginCommand(args: string[], ctx: CliContext): Promise<number> {
  const p = parseOrExit(LOGIN_DEF, args, ctx);
  if (typeof p === 'number') return p;
  for (const k of ['identity-provider', 'region', 'social', 'use-device-flow']) {
    if (p.has(k)) err(ctx, `Note: --${k} is a Kiro sign-in option and is ignored; kiro-claude signs in to Claude Code.`);
  }
  const loc = await locateClaude(ctx);
  if (!loc.bin) {
    err(ctx, `error: ${loc.error}`);
    return 1;
  }
  try {
    const st = await withTimeout(getAuthStatus(loc.bin, authEnv(ctx)), WHOAMI_TIMEOUT_MS);
    if (st !== 'timeout' && st.loggedIn) {
      err(ctx, `error: Already logged in, please logout with ${ctx.progName} logout first`);
      return 1;
    }
  } catch {
    // status unavailable: let `claude auth login` decide
  }
  const loginArgs = p.has('console') ? ['--console'] : p.value('license') === 'pro' ? ['--sso'] : ['--claudeai'];
  try {
    return await runAuthCommand(loc.bin, 'login', loginArgs, authEnv(ctx));
  } catch (e) {
    err(ctx, `error: ${errorText(e)}`);
    return 1;
  }
}

export async function runLogoutCommand(args: string[], ctx: CliContext): Promise<number> {
  const p = parseOrExit(LOGOUT_DEF, args, ctx);
  if (typeof p === 'number') return p;
  const loc = await locateClaude(ctx);
  if (!loc.bin) {
    err(ctx, `error: ${loc.error}`);
    return 1;
  }
  let code: number;
  try {
    code = await runAuthCommand(loc.bin, 'logout', [], authEnv(ctx));
  } catch (e) {
    err(ctx, `error: ${errorText(e)}`);
    return 1;
  }
  if (code !== 0) return code;
  err(ctx, 'You are now logged out');
  err(ctx, `Run ${ctx.progName} login to log back in to Claude Code`);
  return 0;
}

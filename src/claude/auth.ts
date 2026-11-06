/**
 * Authentication helpers. kiro-claude never reads, stores or forwards credentials: login state
 * is owned by Claude Code and only *queried* here.
 *
 * Sources: 00-synthesis §2.1 rows "login / logout / whoami" (`claude auth login [--claudeai]`,
 * `claude auth logout`, `claude auth status --json` ⇒ `{loggedIn, authMethod, apiProvider, …}`)
 * and "Auth failure at runtime" (`assistant.error === "authentication_failed"` or
 * `result.is_error && /Please run \/login|Failed to authenticate|Invalid API key/`); 04 §14.
 *
 * - {@link getAuthStatus} runs `claude auth status --json`; when the output is not JSON it parses
 *   it as text, and when `--json` is rejected as an unknown option (older CLIs) it re-runs plain
 *   `claude auth status` (JSON on 2.1.318, text on older builds) and parses whichever it gets
 *   (the 2.1.318 `--text` form is `Login method: Claude API account\n…`, captured in review). It never throws because the user is logged out (that CLI exit code is
 *   UNVERIFIED, 00 §9 item 7, so a non-zero exit is simply `loggedIn:false` unless JSON says
 *   otherwise); it throws {@link ClaudeNotFoundError} only when the binary cannot be executed.
 * - {@link runAuthCommand} runs `claude auth login|logout …` with inherited stdio (interactive).
 * - {@link isAuthError} classifies runtime frames/text.
 */
import { spawn } from 'node:child_process';

import { ClaudeNotFoundError, resolveSpawn, runCaptured, type ClaudeBinary, type CaptureResult } from './binary.js';
import { buildChildEnv } from './env.js';

export interface AuthStatus {
  loggedIn: boolean;
  /** e.g. `claude.ai`, `oauth_token`, `api_key`. */
  authMethod?: string;
  /** e.g. `firstParty`, `bedrock`, `vertex`. */
  apiProvider?: string;
  email?: string;
  subscriptionType?: string;
  /** Parsed JSON (or `undefined` when only text was available). */
  raw: unknown;
  /** Raw text output (always set when JSON was unavailable; also on errors). */
  text?: string;
}

const AUTH_TIMEOUT_MS = 15_000;

/** Regex of result/assistant texts that mean "not authenticated" (00 §2.1). */
export const AUTH_ERROR_TEXT = /Please run \/login|Failed to authenticate|Invalid API key/i;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** Extracts the first JSON object from `text` (tolerates banners/warnings around it). */
export function extractJsonObject(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const c of candidates) {
    try {
      const v = JSON.parse(c) as unknown;
      if (isObj(v)) return v;
    } catch {
      /* try next */
    }
  }
  return undefined;
}

/** Maps `claude auth status --json` output to {@link AuthStatus}. */
export function parseAuthJson(json: Record<string, unknown>): AuthStatus {
  const account = isObj(json.account) ? json.account : {};
  const loggedIn =
    typeof json.loggedIn === 'boolean'
      ? json.loggedIn
      : typeof json.logged_in === 'boolean'
        ? json.logged_in
        : false;
  const status: AuthStatus = { loggedIn, raw: json };
  const authMethod = str(json.authMethod) ?? str(json.auth_method);
  const apiProvider = str(json.apiProvider) ?? str(json.api_provider) ?? str(account.apiProvider);
  const email = str(json.email) ?? str(account.email) ?? str(json.emailAddress);
  const subscriptionType = str(json.subscriptionType) ?? str(account.subscriptionType);
  if (authMethod) status.authMethod = authMethod;
  if (apiProvider) status.apiProvider = apiProvider;
  if (email) status.email = email;
  if (subscriptionType) status.subscriptionType = subscriptionType;
  return status;
}

/**
 * Heuristic parse of the human-readable status (`Login method: Claude API account\n…`,
 * `Not logged in…`). `exitCode` breaks ties: a non-zero exit with no positive marker is
 * "logged out".
 */
export function parseAuthText(text: string, exitCode: number | null): AuthStatus {
  const t = text.trim();
  const status: AuthStatus = { loggedIn: false, raw: undefined, text: t };
  if (/not\s+(logged|signed)\s+in|logged\s+out|no\s+(credentials|auth)|please run \/login/i.test(t)) return status;
  const method = /^\s*(?:Login method|Auth(?:entication)? method)\s*:\s*(.+)$/im.exec(t);
  const email = /^\s*(?:Email|Account)\s*:\s*(\S+@\S+)\s*$/im.exec(t);
  const org = /^\s*(?:Subscription|Plan)\s*:\s*(.+)$/im.exec(t);
  if (method?.[1]) status.authMethod = method[1].trim();
  if (email?.[1]) status.email = email[1].trim();
  if (org?.[1]) status.subscriptionType = org[1].trim();
  status.loggedIn = Boolean(method || email || /logged\s+in/i.test(t)) && exitCode === 0;
  return status;
}

function spawnFailure(bin: ClaudeBinary, r: CaptureResult): ClaudeNotFoundError {
  return new ClaudeNotFoundError(`cannot execute ${bin.path}: ${r.error?.code ?? r.error?.message ?? 'unknown error'}`, [bin.path]);
}

/**
 * `claude auth status --json`, with text fallback (see module doc). `env` defaults to the
 * scrubbed child environment ({@link buildChildEnv}) so the answer matches what the child sees.
 */
export async function getAuthStatus(bin: ClaudeBinary, env?: NodeJS.ProcessEnv): Promise<AuthStatus> {
  const childEnv = env ?? buildChildEnv(process.env);
  const r = await runCaptured(bin.path, ['auth', 'status', '--json'], { env: childEnv, timeoutMs: AUTH_TIMEOUT_MS });
  if (r.error) throw spawnFailure(bin, r);
  if (r.timedOut) return { loggedIn: false, raw: undefined, text: `claude auth status timed out after ${AUTH_TIMEOUT_MS / 1000}s` };

  const json = extractJsonObject(r.stdout);
  if (json) return parseAuthJson(json);

  // Not JSON: either an older CLI printing text, or `--json` rejected as an unknown option.
  const combined = `${r.stdout}\n${r.stderr}`;
  if (/unknown option|unexpected argument|error: option/i.test(combined)) {
    const t = await runCaptured(bin.path, ['auth', 'status'], { env: childEnv, timeoutMs: AUTH_TIMEOUT_MS });
    if (t.error) throw spawnFailure(bin, t);
    const tj = extractJsonObject(t.stdout);
    if (tj) return parseAuthJson(tj);
    return parseAuthText(`${t.stdout}\n${t.stderr}`, t.timedOut ? null : t.code);
  }
  return parseAuthText(combined, r.code);
}

/**
 * Runs `claude auth <sub> …args` interactively (stdio inherited) and resolves with its exit code
 * (`128 + n` style codes are not synthesised: a signal death resolves 1).
 * @throws ClaudeNotFoundError when the binary cannot be executed.
 */
export function runAuthCommand(
  bin: ClaudeBinary,
  sub: 'login' | 'logout',
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const spec = resolveSpawn(bin.path, ['auth', sub, ...args]);
    let child;
    try {
      child = spawn(spec.command, spec.args, {
        env: env ?? buildChildEnv(process.env),
        stdio: 'inherit',
        windowsVerbatimArguments: spec.windowsVerbatimArguments,
      });
    } catch (e) {
      reject(new ClaudeNotFoundError(`cannot execute ${bin.path}: ${(e as Error).message}`, [bin.path]));
      return;
    }
    let settled = false;
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      reject(new ClaudeNotFoundError(`cannot execute ${bin.path}: ${(e as NodeJS.ErrnoException).code ?? e.message}`, [bin.path]));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      resolve(code ?? 1);
    });
  });
}

/**
 * True when a frame or text means "Claude Code is not authenticated" (00 §2.1):
 * - an `assistant` frame with `error: "authentication_failed"`;
 * - a `result` frame with `is_error: true` whose `result` matches {@link AUTH_ERROR_TEXT};
 * - a string matching {@link AUTH_ERROR_TEXT}.
 */
export function isAuthError(frameOrText: unknown): boolean {
  if (typeof frameOrText === 'string') return AUTH_ERROR_TEXT.test(frameOrText);
  if (!isObj(frameOrText)) return false;
  const f = frameOrText;
  if (f.type === 'assistant') return f.error === 'authentication_failed';
  if (f.type === 'result') return f.is_error === true && typeof f.result === 'string' && AUTH_ERROR_TEXT.test(f.result);
  return false;
}

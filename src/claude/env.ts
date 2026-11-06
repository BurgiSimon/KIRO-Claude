/**
 * Child-process environment for the `claude` child (00-synthesis §3.2, from 04 §14–§15).
 *
 * Why: running `claude` from inside another Claude Code session (or a cloud container) leaks
 * session-scoped variables; VERIFIED (04 §15) that an inherited `CLAUDE_CODE_REMOTE_SESSION_ID`
 * made the child silently adopt the parent's session id. Separately, `ANTHROPIC_API_KEY`,
 * `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_PROFILE` and the Bedrock/Vertex/Foundry switches outrank the
 * user's subscription login, so they are removed unless the user opts into API-key billing
 * (`--use-api-key` / `kiroClaude.allowApiKey`).
 *
 * `buildChildEnv` implements EXACTLY the §3.2 list:
 * - delete the exact names in {@link SESSION_VARS} and every name starting with one of
 *   {@link SESSION_VAR_PREFIXES};
 * - delete {@link API_KEY_VARS} unless `allowApiKey`;
 * - set `CLAUDE_CODE_ENTRYPOINT=sdk-ts`, `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1`,
 *   `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`;
 * - keep everything else (`CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_OAUTH_TOKEN`, proxies, CA vars, …);
 * - finally apply `extra` (a string sets, `undefined` deletes).
 *
 * On Windows environment variable names are case-insensitive, so matching is done
 * case-insensitively there (cheap, and avoids `Claudecode=1` slipping through).
 */

/** Parent-session wiring that must never reach the child (exact names). */
export const SESSION_VARS: readonly string[] = Object.freeze([
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_PID',
  'CLAUDE_ENV_FILE',
  'CLAUDE_PROJECT_DIR',
  'CLAUDE_EFFORT',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_AFTER_LAST_COMPACT',
  'CLAUDE_CODE_TEE_SDK_STDOUT',
  'CLAUDE_CODE_DIAGNOSTICS_FILE',
  'AI_AGENT',
  'NODE_OPTIONS',
  'DEBUG',
]);

/** Parent cloud-session wiring (prefix match). */
export const SESSION_VAR_PREFIXES: readonly string[] = Object.freeze([
  'CLAUDE_CODE_REMOTE',
  'CLAUDE_CODE_CCR',
  'CCR_',
  'CLAUDE_SESSION_INGRESS',
]);

/** Variables that make Claude Code bypass the subscription login (04 §14 precedence 1–3, 6). */
export const API_KEY_VARS: readonly string[] = Object.freeze([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_PROFILE',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
]);

/** Boolean provider switches: a falsy-looking value does not enable the provider. */
const BOOLEAN_SWITCHES = new Set(['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']);

/** Values the adapter always sets on the child. */
export const CHILD_ENV_SETS: Readonly<Record<string, string>> = Object.freeze({
  CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
  CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1',
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
});

export interface BuildChildEnvOptions {
  /** Keep `ANTHROPIC_API_KEY` & co. (user opted into API-key / cloud-provider billing). */
  allowApiKey?: boolean;
  /** Applied last: a string value sets the variable, `undefined` deletes it. */
  extra?: Record<string, string | undefined>;
  /** For tests; defaults to `process.platform`. */
  platform?: NodeJS.Platform;
}

function norm(name: string, win: boolean): string {
  return win ? name.toUpperCase() : name;
}

/** True when `name` is one of the variables {@link buildChildEnv} always removes. */
export function isScrubbedSessionVar(name: string, platform: NodeJS.Platform = process.platform): boolean {
  const win = platform === 'win32';
  const n = norm(name, win);
  if (SESSION_VARS.some((v) => norm(v, win) === n)) return true;
  return SESSION_VAR_PREFIXES.some((p) => n.startsWith(norm(p, win)));
}

/**
 * Builds the environment for the `claude` child from `parent` (never mutated). See module doc.
 */
export function buildChildEnv(parent: NodeJS.ProcessEnv, opts: BuildChildEnvOptions = {}): NodeJS.ProcessEnv {
  const platform = opts.platform ?? process.platform;
  const win = platform === 'win32';
  const apiKeyNames = new Set(API_KEY_VARS.map((v) => norm(v, win)));
  const out: NodeJS.ProcessEnv = {};

  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    if (isScrubbedSessionVar(name, platform)) continue;
    if (!opts.allowApiKey && apiKeyNames.has(norm(name, win))) continue;
    out[name] = value;
  }

  const setVar = (name: string, value: string | undefined): void => {
    // Remove any differently-cased duplicate on Windows so exactly one spelling survives.
    if (win) {
      for (const k of Object.keys(out)) if (k !== name && k.toUpperCase() === name.toUpperCase()) delete out[k];
    }
    if (value === undefined) delete out[name];
    else out[name] = value;
  };

  for (const [name, value] of Object.entries(CHILD_ENV_SETS)) setVar(name, value);
  if (opts.extra) for (const [name, value] of Object.entries(opts.extra)) setVar(name, value);
  return out;
}

function isFalsyFlag(v: string): boolean {
  return /^(0|false|no|off)$/i.test(v.trim());
}

/**
 * Names of the variables set in `env` that would make Claude Code bill an API key or a cloud
 * provider instead of the subscription (for warnings / `doctor`). Empty values do not count;
 * for the `CLAUDE_CODE_USE_*` switches `0`/`false`/`no`/`off` do not count either.
 */
export function apiKeyOverrides(env: NodeJS.ProcessEnv): string[] {
  const win = process.platform === 'win32';
  const found: string[] = [];
  for (const wanted of API_KEY_VARS) {
    for (const [name, value] of Object.entries(env)) {
      if (norm(name, win) !== norm(wanted, win)) continue;
      if (value === undefined || value.trim() === '') continue;
      if (BOOLEAN_SWITCHES.has(wanted) && isFalsyFlag(value)) continue;
      found.push(name);
    }
  }
  return found;
}

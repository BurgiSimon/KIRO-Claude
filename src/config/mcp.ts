/**
 * Kiro MCP configuration: normalization, files, precedence and the Claude `--mcp-config`
 * translation (02 §5, 06 §7.4, 00 §2.3/§4.1).
 *
 * Entry normalization (02 §5.2):
 *  - `type`: `stdio` | `http` | `sse` (`streamable-http`/`streamableHttp` ⇒ `http`); when
 *    absent it is inferred: `url` present ⇒ `http`, else `stdio` (UNVERIFIED inference,
 *    02 §5.2). stdio requires a non-empty `command`, remote requires `url` — except for a
 *    `disabled: true` entry, which may be just `{"disabled": true}` (a higher-priority file
 *    switching off a server defined elsewhere, 02 §5.1); unset-variable warnings are not
 *    reported for disabled entries.
 *  - Environment substitution (02 §5.3, {@link substituteEnv}): `${env:VAR}` (Q source) and
 *    `${VAR}` (Kiro docs) in `env` values, `headers` values and `url`; `command` additionally
 *    gets `~` and `$VAR` expansion (Q `shellexpand::full`). An unset variable stays the
 *    literal `${VAR}` (kiro-cli drops the `env:` prefix) and is reported with a
 *    `mcp-env-unset` warning. `args` are passed verbatim.
 *  - `timeout` ⇒ `timeoutMs`; `disabled`; `autoApprove`; `disabledTools`; `cwd` (accepted,
 *    `~` expanded; not forwarded to Claude, which has no per-server cwd). Unknown fields
 *    (oauth, oauthScopes, requestTimeout, description, …) are accepted silently.
 *
 * Files (02 §5.1, 06 §7.4): `~/.kiro/settings/mcp.json` (global), `<ws>/.kiro/settings/mcp.json`
 * (workspace), legacy `~/.aws/amazonq/mcp.json` and `<ws>/.amazonq/mcp.json`. A file must
 * have a top-level `mcpServers` object (Q: "No mcp servers found in config").
 *
 * Precedence for one server name (02 §5.1): agent `mcpServers` > workspace mcp.json >
 * global mcp.json > legacy workspace > legacy global; whole-entry replacement; a
 * higher-priority `disabled: true` entry suppresses the server (it is kept in the result
 * with `disabled: true` and skipped by {@link toClaudeMcpConfig}). Kiro mcp.json files are
 * included when the agent has `includeMcpJson`, legacy files when it has `useLegacyMcpJson`
 * (Q prints `WARNING: MCP server '<n>' is already configured in agent config. Skipping
 * duplicate from legacy mcp.json.` when a legacy server collides with an agent server).
 *
 * Claude server names: characters outside `[a-zA-Z0-9_-]` become `_` (00 §4.1); collisions
 * after normalization get `_2`, `_3`, … ({@link claudeMcpNameMap} maps back).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ConfigWarning, KiroAgent, McpOrigin, McpServerConfig, WorkspaceContext } from '../types.js';
import { parseJsonText, readTextIfExists, writeJsonAtomic } from '../util/fsx.js';
import { jsonErrorMessage, setOwn } from './diag.js';
import { expandTilde } from '../util/paths.js';
import { legacyGlobalDir, workspaceAmazonqDir, workspaceKiroDir } from './workspace.js';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Result of {@link substituteEnv}. */
export interface EnvSubstitution {
  value: string;
  /** Variable names referenced but not set. */
  missing: string[];
}

/**
 * Replace `${env:VAR}` and `${VAR}` with values from `env` (02 §5.3), byte-for-byte like
 * kiro-cli's expander (regex `\$\{(?:env:)?([^}]+)\}`, recorded by KiroCrew's port of it, 08a
 * §4.1 / KC-SPEC-04): an unset variable is left as the literal `${VAR}` — for `${env:VAR}`
 * the `env:` prefix is dropped, as in Q (`format!("${{{}}}", name)`, 02 App. B). Values are
 * not expanded again. With `opts.dollar` also bare `$VAR` (shellexpand, used for `command`;
 * an unset `$VAR` stays as written).
 */
export function substituteEnv(input: string, env: NodeJS.ProcessEnv, opts: { dollar?: boolean } = {}): EnvSubstitution {
  const missing: string[] = [];
  const re = opts.dollar ? /\$\{(?:env:)?([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g : /\$\{(?:env:)?([^}]+)\}/g;
  const value = input.replace(re, (whole: string, braced: string | undefined, bare: string | undefined) => {
    const name = braced ?? bare ?? '';
    const v = Object.prototype.hasOwnProperty.call(env, name) ? env[name] : undefined;
    if (v === undefined) {
      if (!missing.includes(name)) missing.push(name);
      return braced !== undefined ? `\${${name}}` : whole;
    }
    return v;
  });
  return { value, missing };
}

function stringRecord(
  v: unknown,
  field: string,
  server: string,
  env: NodeJS.ProcessEnv,
  warnings: ConfigWarning[],
  sourcePath: string | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (v === undefined || v === null) return out;
  if (!isPlainObject(v)) {
    warnings.push({ code: 'mcp-invalid', message: `MCP server '${server}': "${field}" must be an object of strings`, path: sourcePath });
    return out;
  }
  for (const [k, raw] of Object.entries(v)) {
    if (raw === null || raw === undefined) continue;
    const s = typeof raw === 'string' ? raw : typeof raw === 'number' || typeof raw === 'boolean' ? String(raw) : undefined;
    if (s === undefined) {
      warnings.push({ code: 'mcp-invalid', message: `MCP server '${server}': ${field}.${k} must be a string`, path: sourcePath });
      continue;
    }
    const sub = substituteEnv(s, env);
    for (const m of sub.missing) {
      warnings.push({
        code: 'mcp-env-unset',
        message: `MCP server '${server}': environment variable ${m} referenced in ${field}.${k} is not set`,
        path: sourcePath,
      });
    }
    setOwn(out, k, sub.value);
  }
  return out;
}

function stringList(v: unknown, field: string, server: string, warnings: ConfigWarning[], sourcePath: string | undefined): string[] {
  if (v === undefined || v === null) return [];
  if (typeof v === 'string') return [v];
  if (!Array.isArray(v)) {
    warnings.push({ code: 'mcp-invalid', message: `MCP server '${server}': "${field}" must be an array of strings`, path: sourcePath });
    return [];
  }
  const out: string[] = [];
  for (const x of v) {
    if (typeof x === 'string') out.push(x);
    else if (typeof x === 'number' || typeof x === 'boolean') out.push(String(x));
    else warnings.push({ code: 'mcp-invalid', message: `MCP server '${server}': "${field}" entries must be strings`, path: sourcePath });
  }
  return out;
}

/** Normalize one raw Kiro MCP server entry (see module doc). */
export function normalizeMcpServer(
  name: string,
  raw: unknown,
  origin: McpOrigin,
  env: NodeJS.ProcessEnv,
  sourcePath?: string,
): { server?: McpServerConfig; warnings: ConfigWarning[] } {
  const warnings: ConfigWarning[] = [];
  if (!isPlainObject(raw)) {
    warnings.push({ code: 'mcp-invalid', message: `MCP server '${name}' must be an object`, path: sourcePath });
    return { warnings };
  }
  const url = typeof raw.url === 'string' && raw.url.trim() !== '' ? raw.url.trim() : undefined;
  const commandRaw = typeof raw.command === 'string' ? raw.command : undefined;

  let type: McpServerConfig['type'];
  const t = typeof raw.type === 'string' ? raw.type.trim().toLowerCase() : undefined;
  if (t === 'stdio') type = 'stdio';
  else if (t === 'http' || t === 'streamable-http' || t === 'streamablehttp' || t === 'streamable_http') type = 'http';
  else if (t === 'sse') type = 'sse';
  else {
    if (t !== undefined && t !== '') {
      warnings.push({ code: 'mcp-invalid', message: `MCP server '${name}': unknown type '${String(raw.type)}'`, path: sourcePath });
    }
    type = url !== undefined && (commandRaw === undefined || commandRaw.trim() === '') ? 'http' : 'stdio';
  }

  const server: McpServerConfig = {
    name,
    type,
    args: [],
    env: {},
    headers: {},
    disabled: raw.disabled === true,
    autoApprove: stringList(raw.autoApprove, 'autoApprove', name, warnings, sourcePath),
    disabledTools: stringList(raw.disabledTools, 'disabledTools', name, warnings, sourcePath),
    origin,
    ...(sourcePath ? { sourcePath } : {}),
  };
  if (raw.disabled !== undefined && typeof raw.disabled !== 'boolean') {
    warnings.push({ code: 'mcp-invalid', message: `MCP server '${name}': "disabled" must be a boolean`, path: sourcePath });
  }

  if (type === 'stdio') {
    if (commandRaw === undefined || commandRaw.trim() === '') {
      // A disabled entry only needs its name: `{"disabled": true}` in a higher-priority file
      // suppresses a server configured elsewhere (02 §5.1).
      if (!server.disabled) {
        warnings.push({ code: 'mcp-invalid', message: `MCP server '${name}': stdio servers need a "command"`, path: sourcePath });
        return { warnings };
      }
    } else {
      const sub = substituteEnv(expandTilde(commandRaw.trim(), env), env, { dollar: true });
      for (const m of sub.missing) {
        warnings.push({
          code: 'mcp-env-unset',
          message: `MCP server '${name}': environment variable ${m} referenced in command is not set`,
          path: sourcePath,
        });
      }
      server.command = sub.value;
    }
    server.args = stringList(raw.args, 'args', name, warnings, sourcePath);
    server.env = stringRecord(raw.env, 'env', name, env, warnings, sourcePath);
  } else {
    if (url === undefined) {
      if (!server.disabled) {
        warnings.push({ code: 'mcp-invalid', message: `MCP server '${name}': ${type} servers need a "url"`, path: sourcePath });
        return { warnings };
      }
    } else {
      const sub = substituteEnv(url, env);
      for (const m of sub.missing) {
        warnings.push({ code: 'mcp-env-unset', message: `MCP server '${name}': environment variable ${m} referenced in url is not set`, path: sourcePath });
      }
      server.url = sub.value;
    }
    // Kiro docs list `env` for remote servers too; keep it (unused by Claude for remote).
    server.env = stringRecord(raw.env, 'env', name, env, warnings, sourcePath);
  }
  server.headers = stringRecord(raw.headers, 'headers', name, env, warnings, sourcePath);

  if (typeof raw.timeout === 'number' && Number.isFinite(raw.timeout) && raw.timeout >= 0) server.timeoutMs = Math.floor(raw.timeout);
  else if (raw.timeout !== undefined && raw.timeout !== null) {
    warnings.push({ code: 'mcp-invalid', message: `MCP server '${name}': "timeout" must be a non-negative number (ms)`, path: sourcePath });
  }
  if (typeof raw.cwd === 'string' && raw.cwd.trim() !== '') server.cwd = expandTilde(raw.cwd.trim(), env);
  // A disabled server is never launched: unset variables in it are not worth a warning.
  if (server.disabled) return { server, warnings: warnings.filter((w) => w.code !== 'mcp-env-unset') };
  return { server, warnings };
}

/**
 * Load one mcp.json-style file (`{ "mcpServers": { … } }`). A missing file yields no servers
 * and no warning.
 */
export function loadMcpFile(
  filePath: string,
  origin: McpOrigin,
  env: NodeJS.ProcessEnv,
): { servers: Record<string, McpServerConfig>; warnings: ConfigWarning[] } {
  const warnings: ConfigWarning[] = [];
  const servers: Record<string, McpServerConfig> = {};
  let text: string | undefined;
  try {
    text = readTextIfExists(filePath);
  } catch (e) {
    warnings.push({ code: 'mcp-file', message: `Failed to read ${filePath}: ${e instanceof Error ? e.message : String(e)}`, path: filePath });
    return { servers, warnings };
  }
  if (text === undefined || text.trim() === '') return { servers, warnings };
  let data: unknown;
  try {
    data = parseJsonText(text, filePath);
  } catch (e) {
    warnings.push({ code: 'invalid-json', message: jsonErrorMessage(e, filePath), path: filePath });
    return { servers, warnings };
  }
  if (!isPlainObject(data) || !isPlainObject(data.mcpServers)) {
    warnings.push({ code: 'mcp-file', message: `${filePath}: No mcp servers found in config`, path: filePath });
    return { servers, warnings };
  }
  for (const [name, raw] of Object.entries(data.mcpServers)) {
    const r = normalizeMcpServer(name, raw, origin, env, filePath);
    warnings.push(...r.warnings);
    if (r.server) setOwn(servers, name, r.server);
  }
  return { servers, warnings };
}

/** The four mcp.json locations for `ws` (02 §1.2). */
export function mcpConfigPaths(ws: WorkspaceContext): { global: string; workspace: string; legacyGlobal: string; legacyWorkspace: string } {
  const wk = workspaceKiroDir(ws);
  const aq = workspaceAmazonqDir(ws);
  return {
    global: path.join(ws.kiroHome, 'settings', 'mcp.json'),
    workspace: wk ? path.join(wk, 'settings', 'mcp.json') : path.join(ws.workspaceRoot, '.kiro', 'settings', 'mcp.json'),
    legacyGlobal: path.join(legacyGlobalDir(ws), 'mcp.json'),
    legacyWorkspace: aq ? path.join(aq, 'mcp.json') : path.join(ws.workspaceRoot, '.amazonq', 'mcp.json'),
  };
}

/**
 * Effective MCP servers for `agent` (precedence in the module doc). Disabled servers are kept
 * (flagged) so UIs can list them; Claude never sees them.
 */
export function resolveMcpServers(
  ws: WorkspaceContext,
  agent: Pick<KiroAgent, 'mcpServers' | 'includeMcpJson' | 'useLegacyMcpJson'> & { name?: string },
): { servers: McpServerConfig[]; warnings: ConfigWarning[] } {
  const warnings: ConfigWarning[] = [];
  const out = new Map<string, McpServerConfig>();
  for (const [name, s] of Object.entries(agent.mcpServers)) out.set(name, s);
  const agentNames = new Set(out.keys());
  const paths = mcpConfigPaths(ws);
  const sameAsGlobal = workspaceKiroDir(ws) === undefined;
  const sameLegacy = workspaceAmazonqDir(ws) === undefined;

  const addFile = (p: string, origin: McpOrigin, legacy: boolean): void => {
    const r = loadMcpFile(p, origin, ws.env);
    warnings.push(...r.warnings);
    for (const [name, s] of Object.entries(r.servers)) {
      if (out.has(name)) {
        if (legacy && agentNames.has(name)) {
          warnings.push({
            code: 'mcp-duplicate',
            message: `WARNING: MCP server '${name}' is already configured in agent config. Skipping duplicate from legacy mcp.json.`,
            path: p,
          });
        }
        continue;
      }
      out.set(name, s);
    }
  };

  if (agent.includeMcpJson) {
    if (!sameAsGlobal) addFile(paths.workspace, 'workspace', false);
    addFile(paths.global, 'global', false);
  }
  if (agent.useLegacyMcpJson) {
    if (!sameLegacy) addFile(paths.legacyWorkspace, 'legacy-workspace', true);
    addFile(paths.legacyGlobal, 'legacy-global', true);
  }
  return { servers: [...out.values()], warnings };
}

/** Claude's server-name normalization: characters outside `[a-zA-Z0-9_-]` ⇒ `_`. */
export function claudeServerName(name: string): string {
  const s = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  return s === '' ? '_' : s;
}

/** Assign unique Claude names to the enabled servers, in order (collisions get `_2`, `_3`, …). */
function assignClaudeNames(servers: readonly McpServerConfig[]): Array<[string, McpServerConfig]> {
  const used = new Set<string>();
  const out: Array<[string, McpServerConfig]> = [];
  for (const s of servers) {
    if (s.disabled) continue;
    const base = claudeServerName(s.name);
    let n = base;
    for (let i = 2; used.has(n); i++) n = `${base}_${i}`;
    used.add(n);
    out.push([n, s]);
  }
  return out;
}

function copyStrings(r: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(r)) setOwn(out, k, v);
  return out;
}

/** Build the JSON for Claude `--mcp-config` (disabled servers skipped). */
export function toClaudeMcpConfig(servers: readonly McpServerConfig[]): { mcpServers: Record<string, Record<string, unknown>> } {
  const mcpServers: Record<string, Record<string, unknown>> = {};
  for (const [n, s] of assignClaudeNames(servers)) {
    if (s.type === 'stdio') {
      setOwn(mcpServers, n, { type: 'stdio', command: s.command ?? '', args: [...s.args], env: copyStrings(s.env) });
    } else {
      setOwn(mcpServers, n, { type: s.type, url: s.url ?? '', headers: copyStrings(s.headers) });
    }
  }
  return { mcpServers };
}

/** Claude server name ⇒ Kiro server name, consistent with {@link toClaudeMcpConfig}. */
export function claudeMcpNameMap(servers: readonly McpServerConfig[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [n, s] of assignClaudeNames(servers)) setOwn(out, n, s.name);
  return out;
}

// ───────────────────────────── editing helpers (`kiro-claude mcp …`) ─────────────────────────────

/**
 * Read an mcp.json file as raw JSON for editing. Missing ⇒ `{ mcpServers: {} }`. Throws
 * util/fsx `JsonFileError` on invalid JSON and an Error when the root is not an object.
 */
export function readMcpFileRaw(filePath: string): { mcpServers: Record<string, unknown>; [k: string]: unknown } {
  const text = readTextIfExists(filePath);
  if (text === undefined || text.trim() === '') return { mcpServers: {} };
  const data = parseJsonText<unknown>(text, filePath);
  if (!isPlainObject(data)) throw new Error(`${filePath}: expected a JSON object`);
  const servers = data.mcpServers;
  if (servers !== undefined && !isPlainObject(servers)) throw new Error(`${filePath}: "mcpServers" must be an object`);
  const copy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(servers ?? {})) setOwn(copy, k, v);
  return { ...data, mcpServers: copy };
}

/**
 * Add (or with `force` replace) a server entry. Throws when it exists and `force` is false:
 * `MCP server '<name>' already exists in <path>. Use --force to overwrite.`
 */
export function addMcpServer(filePath: string, name: string, entry: Record<string, unknown>, opts: { force: boolean }): void {
  if (name.trim() === '') throw new Error('MCP server name must not be empty');
  const raw = readMcpFileRaw(filePath);
  if (Object.prototype.hasOwnProperty.call(raw.mcpServers, name) && !opts.force) {
    throw new Error(`MCP server '${name}' already exists in ${filePath}. Use --force to overwrite.`);
  }
  setOwn(raw.mcpServers, name, entry);
  writeJsonAtomic(filePath, raw);
}

/** Remove a server entry; returns false when it was not present (file untouched). */
export function removeMcpServer(filePath: string, name: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  const raw = readMcpFileRaw(filePath);
  if (!Object.prototype.hasOwnProperty.call(raw.mcpServers, name)) return false;
  delete raw.mcpServers[name];
  writeJsonAtomic(filePath, raw);
  return true;
}

/**
 * Kiro V3 permission scopes stored in YAML (02 §2.8, 00 §2.3 / §5.3).
 *
 * Files:
 *  - user      `<kiroHome>/settings/permissions.yaml`
 *  - workspace `<kiroHome>/workspace-roots/<hash>/permissions.yaml`, where `<hash>` =
 *    first 16 hex chars of `sha256(realpath(workspaceRoot))` (02 §1.4: Kiro's algorithm is
 *    UNVERIFIED, so these files cannot be shared with real Kiro; the file also records
 *    `workspaceRoot: <abs path>` when kiro-claude writes it).
 *
 * Shape: `rules: [{capability, match?, exclude?, effect}]`, `policies: [<preset id>]`,
 * `workspaceTrusted: true` (workspace file only). `match` / `exclude` accept a string or a
 * list; `effect` ∈ allow | ask | deny | evaluate. Invalid rules and unknown preset ids are
 * dropped with a warning. Rules get `scope: 'user' | 'workspace'`.
 *
 * {@link PRESETS} implement the preset table of 02 §2.8. `read-only-shell` / `dev-shell`
 * command lists are UNVERIFIED in Kiro: they follow the 00 §5.3 DECISION (git read-only and
 * system-info commands) plus read-only queries of cargo / npm / docker / kubectl / rustup.
 * `approve-for-me` = edit-workspace + read-only-shell + `{capability: all, effect: evaluate}`:
 * kiro-claude has no trust classifier, so the capability engine maps `evaluate` to `ask`
 * (00 §5.1). The rule is kept as `evaluate` (lowest severity) rather than `ask` so the
 * preset's own allow rules still win — an `ask` rule would outrank them.
 *
 * Writers ({@link savePermissionsFile}, {@link addPermissionRule}, {@link setWorkspaceTrusted})
 * re-emit the whole file (comments are not preserved).
 */

import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type { ConfigWarning, PermissionRule, RuleEffect, WorkspaceContext } from '../types.js';
import { readTextIfExists, writeFileAtomic } from '../util/fsx.js';
import { realpathSafe } from '../util/paths.js';
import { parseYaml, YamlError } from '../util/yaml.js';

const EFFECTS: ReadonlySet<string> = new Set(['allow', 'ask', 'deny', 'evaluate']);

/** Known capabilities incl. meta capabilities (02 §2.8). */
export const CAPABILITIES: readonly string[] = [
  'fs_read',
  'fs_write',
  'shell',
  'web_fetch',
  'web_search',
  'mcp',
  'subagent',
  'skill',
  'power',
  'context',
  'diagnostics',
  'sandbox_network',
  'utility',
  'all',
  'builtin',
  'filesystem',
];

const GIT_READ_ONLY = [
  'git status*',
  'git log*',
  'git diff*',
  'git show*',
  'git branch',
  'git branch --list*',
  'git branch -a',
  'git branch -r',
  'git branch -v*',
  'git rev-parse*',
  'git remote -v',
  'git ls-files*',
  'git blame*',
];
const SYSINFO = ['pwd', 'whoami', 'uname*', 'hostname', 'date', 'id', 'uptime', 'which *'];

/** Shell match list of the 00 §5.3 V3 default policy (git read-only + system info). */
export const DEFAULT_SHELL_ALLOW: readonly string[] = [...GIT_READ_ONLY, ...SYSINFO];

const READ_ONLY_SHELL = [
  ...DEFAULT_SHELL_ALLOW,
  'git tag --list*',
  'git tag -l*',
  'git stash list*',
  'git config --get*',
  'git config --list*',
  'cargo --version',
  'cargo metadata*',
  'cargo tree*',
  'cargo search*',
  'npm --version',
  'npm ls*',
  'npm list*',
  'npm view*',
  'npm outdated*',
  'npm config get*',
  'docker ps*',
  'docker images*',
  'docker inspect*',
  'docker version*',
  'docker info*',
  'docker logs*',
  'kubectl get*',
  'kubectl describe*',
  'kubectl version*',
  'kubectl logs*',
  'kubectl config view*',
  'kubectl config get-contexts*',
  'kubectl config current-context*',
  'rustup --version',
  'rustup show*',
  'rustup toolchain list*',
  'rustup target list*',
];

const DEV_SHELL = [
  ...READ_ONLY_SHELL,
  'git add*',
  'git commit*',
  'git checkout*',
  'git switch*',
  'git restore*',
  'git stash*',
  'git merge*',
  'git rebase*',
  'git pull*',
  'git fetch*',
  'git tag*',
  'git branch *',
  'git mv *',
  'git rm *',
  'cargo *',
  'npm *',
  'bun *',
  'yarn *',
  'mkdir *',
  'touch *',
  'mv *',
  'cp *',
  'ls',
  'ls *',
  'cat *',
  'grep *',
  'echo',
  'echo *',
];

const editWorkspace = (): PermissionRule[] => [
  { capability: 'fs_read', match: ['./**'], effect: 'allow', scope: 'preset' },
  { capability: 'fs_write', match: ['./**'], effect: 'allow', scope: 'preset' },
];

/** Preset rule sets (02 §2.8). */
export const PRESETS: Record<string, PermissionRule[]> = {
  'allow-all': [{ capability: 'all', effect: 'allow', scope: 'preset' }],
  'edit-workspace': editWorkspace(),
  'read-workspace': [{ capability: 'fs_read', match: ['./**'], effect: 'allow', scope: 'preset' }],
  'read-all': [
    { capability: 'fs_read', effect: 'allow', scope: 'preset' },
    { capability: 'web_fetch', effect: 'allow', scope: 'preset' },
    { capability: 'web_search', effect: 'allow', scope: 'preset' },
  ],
  'read-only-shell': [{ capability: 'shell', match: [...READ_ONLY_SHELL], effect: 'allow', scope: 'preset' }],
  'dev-shell': [{ capability: 'shell', match: [...DEV_SHELL], effect: 'allow', scope: 'preset' }],
  'approve-for-me': [
    ...editWorkspace(),
    { capability: 'shell', match: [...READ_ONLY_SHELL], effect: 'allow', scope: 'preset' },
    { capability: 'all', effect: 'evaluate', scope: 'preset' },
  ],
};

/** `sha256(realpath(workspaceRoot))`, first 16 hex characters. */
export function workspaceRootHash(ws: WorkspaceContext): string {
  return createHash('sha256').update(realpathSafe(ws.workspaceRoot)).digest('hex').slice(0, 16);
}

/** The user and workspace permissions.yaml paths for `ws`. */
export function permissionsPaths(ws: WorkspaceContext): { user: string; workspace: string } {
  return {
    user: path.join(ws.kiroHome, 'settings', 'permissions.yaml'),
    workspace: path.join(ws.kiroHome, 'workspace-roots', workspaceRootHash(ws), 'permissions.yaml'),
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function strList(v: unknown): string[] | undefined | null {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') return [v];
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[];
  return null; // invalid
}

/**
 * Validate one rule object (agent `permissions.rules` or YAML). Returns the rule with
 * `scope` set, or a warning message.
 */
export function parsePermissionRule(raw: unknown, scope: NonNullable<PermissionRule['scope']>): { rule?: PermissionRule; error?: string } {
  if (!isPlainObject(raw)) return { error: 'rule must be a mapping' };
  if (typeof raw.capability !== 'string' || raw.capability.trim() === '') return { error: 'rule needs a "capability"' };
  if (typeof raw.effect !== 'string' || !EFFECTS.has(raw.effect)) {
    return { error: `rule for '${raw.capability}' has invalid effect ${JSON.stringify(raw.effect)} (allow|ask|deny|evaluate)` };
  }
  const match = strList(raw.match);
  const exclude = strList(raw.exclude);
  if (match === null) return { error: `rule for '${raw.capability}': "match" must be a string or a list of strings` };
  if (exclude === null) return { error: `rule for '${raw.capability}': "exclude" must be a string or a list of strings` };
  const rule: PermissionRule = { capability: raw.capability.trim(), effect: raw.effect as RuleEffect, scope };
  if (match) rule.match = match;
  if (exclude) rule.exclude = exclude;
  return { rule };
}

interface ParsedFile {
  rules: PermissionRule[];
  presets: string[];
  workspaceTrusted?: boolean;
  workspaceRoot?: string;
}

/** Parse permissions.yaml text (exported for tests). */
export function parsePermissionsYaml(text: string, scope: 'user' | 'workspace', filePath?: string): ParsedFile & { warnings: ConfigWarning[] } {
  const warnings: ConfigWarning[] = [];
  const out: ParsedFile = { rules: [], presets: [] };
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch (e) {
    const msg = e instanceof YamlError ? `${e.reason} at line ${e.line}` : String(e);
    warnings.push({ code: 'invalid-yaml', message: `${filePath ?? 'permissions.yaml'}: ${msg}`, path: filePath });
    return { ...out, warnings };
  }
  if (data === null || data === undefined) return { ...out, warnings };
  if (!isPlainObject(data)) {
    warnings.push({ code: 'permissions-invalid', message: `${filePath ?? 'permissions.yaml'}: expected a mapping`, path: filePath });
    return { ...out, warnings };
  }
  if (data.rules !== undefined && data.rules !== null) {
    if (!Array.isArray(data.rules)) {
      warnings.push({ code: 'permissions-invalid', message: `${filePath ?? 'permissions.yaml'}: "rules" must be a list`, path: filePath });
    } else {
      data.rules.forEach((r, i) => {
        const p = parsePermissionRule(r, scope);
        if (p.rule) out.rules.push(p.rule);
        else warnings.push({ code: 'permissions-invalid', message: `${filePath ?? 'permissions.yaml'}: rules[${i}]: ${p.error}`, path: filePath });
      });
    }
  }
  const pol = strList(data.policies);
  if (pol === null) {
    warnings.push({ code: 'permissions-invalid', message: `${filePath ?? 'permissions.yaml'}: "policies" must be a list of preset ids`, path: filePath });
  } else if (pol) {
    for (const id of pol) {
      if (Object.prototype.hasOwnProperty.call(PRESETS, id)) {
        if (!out.presets.includes(id)) out.presets.push(id);
      } else {
        warnings.push({ code: 'unknown-preset', message: `${filePath ?? 'permissions.yaml'}: unknown policy preset '${id}' (ignored)`, path: filePath });
      }
    }
  }
  if (typeof data.workspaceTrusted === 'boolean') out.workspaceTrusted = data.workspaceTrusted;
  if (typeof data.workspaceRoot === 'string') out.workspaceRoot = data.workspaceRoot;
  return { ...out, warnings };
}

function loadFile(p: string, scope: 'user' | 'workspace'): ParsedFile & { warnings: ConfigWarning[] } {
  let text: string | undefined;
  try {
    text = readTextIfExists(p);
  } catch (e) {
    return {
      rules: [],
      presets: [],
      warnings: [{ code: 'permissions-read', message: `Failed to read ${p}: ${e instanceof Error ? e.message : String(e)}`, path: p }],
    };
  }
  if (text === undefined) return { rules: [], presets: [], warnings: [] };
  return parsePermissionsYaml(text, scope, p);
}

/** Load the user and workspace scopes for `ws` (see module doc). */
export function loadPermissionScopes(ws: WorkspaceContext): {
  user: PermissionRule[];
  workspace: PermissionRule[];
  presets: string[];
  workspaceTrusted?: boolean;
  warnings: ConfigWarning[];
} {
  const p = permissionsPaths(ws);
  const u = loadFile(p.user, 'user');
  const w = loadFile(p.workspace, 'workspace');
  const presets = [...u.presets];
  for (const id of w.presets) if (!presets.includes(id)) presets.push(id);
  const out: ReturnType<typeof loadPermissionScopes> = {
    user: u.rules,
    workspace: w.rules,
    presets,
    warnings: [...u.warnings, ...w.warnings],
  };
  if (w.workspaceTrusted !== undefined) out.workspaceTrusted = w.workspaceTrusted;
  return out;
}

/** Rules of the given preset ids (unknown ids are skipped). */
export function presetRules(ids: readonly string[]): PermissionRule[] {
  const out: PermissionRule[] = [];
  for (const id of ids) {
    const rules = PRESETS[id];
    if (rules) out.push(...rules.map((r) => ({ ...r, ...(r.match ? { match: [...r.match] } : {}) })));
  }
  return out;
}

// ───────────────────────────── writing ─────────────────────────────

function yamlStr(s: string): string {
  return JSON.stringify(s); // JSON strings are valid YAML double-quoted scalars
}

/** Emit a permissions.yaml document. */
export function formatPermissionsYaml(data: { rules: PermissionRule[]; presets?: string[]; workspaceTrusted?: boolean; workspaceRoot?: string }): string {
  const lines: string[] = ['# Kiro permissions (written by kiro-claude)'];
  if (data.workspaceRoot !== undefined) lines.push(`workspaceRoot: ${yamlStr(data.workspaceRoot)}`);
  if (data.workspaceTrusted !== undefined) lines.push(`workspaceTrusted: ${data.workspaceTrusted ? 'true' : 'false'}`);
  if (data.presets && data.presets.length) {
    lines.push('policies:');
    for (const p of data.presets) lines.push(`  - ${yamlStr(p)}`);
  }
  lines.push(data.rules.length ? 'rules:' : 'rules: []');
  for (const r of data.rules) {
    lines.push(`  - capability: ${yamlStr(r.capability)}`);
    if (r.match) lines.push(`    match: [${r.match.map(yamlStr).join(', ')}]`);
    if (r.exclude) lines.push(`    exclude: [${r.exclude.map(yamlStr).join(', ')}]`);
    lines.push(`    effect: ${r.effect}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Write a whole permissions file (atomic; comments are not preserved). */
export function savePermissionsFile(
  filePath: string,
  data: { rules: PermissionRule[]; presets?: string[]; workspaceTrusted?: boolean; workspaceRoot?: string },
): void {
  writeFileAtomic(filePath, formatPermissionsYaml(data), { mode: 0o600 });
}

function current(ws: WorkspaceContext, scope: 'user' | 'workspace'): { file: string; parsed: ParsedFile } {
  const file = permissionsPaths(ws)[scope];
  const parsed = loadFile(file, scope);
  if (parsed.warnings.some((w) => w.code === 'invalid-yaml')) {
    throw new Error(`Refusing to rewrite ${file}: ${parsed.warnings[0]!.message}`);
  }
  return { file, parsed };
}

/** Append a rule to the user or workspace file (dedupes identical rules). */
export function addPermissionRule(ws: WorkspaceContext, scope: 'user' | 'workspace', rule: PermissionRule): string {
  const { file, parsed } = current(ws, scope);
  const strip = (r: PermissionRule): string => JSON.stringify({ c: r.capability, m: r.match ?? null, x: r.exclude ?? null, e: r.effect });
  const rules = parsed.rules.map((r) => ({ ...r }));
  if (!rules.some((r) => strip(r) === strip(rule))) rules.push({ ...rule, scope });
  savePermissionsFile(file, {
    rules,
    presets: parsed.presets,
    ...(parsed.workspaceTrusted !== undefined ? { workspaceTrusted: parsed.workspaceTrusted } : {}),
    ...(scope === 'workspace' ? { workspaceRoot: realpathSafe(ws.workspaceRoot) } : {}),
  });
  return file;
}

/** Record the trust-screen answer in the workspace file (02 §1.4). */
export function setWorkspaceTrusted(ws: WorkspaceContext, trusted: boolean): string {
  const { file, parsed } = current(ws, 'workspace');
  savePermissionsFile(file, {
    rules: parsed.rules,
    presets: parsed.presets,
    workspaceTrusted: trusted,
    workspaceRoot: realpathSafe(ws.workspaceRoot),
  });
  return file;
}

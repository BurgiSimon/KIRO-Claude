/**
 * Agent Skills (02 §6.2, 00 §2.2 "Skills").
 *
 * Discovery ({@link discoverSkills}), first match by name wins, in this order:
 *  1. workspace defaults `<workspaceRoot>/.kiro/skills/<dir>/SKILL.md` (when `includeDefaults`);
 *  2. `skill://` resources of the agent, in order (scope `resource`):
 *     - short name (`skill://backend-patterns`, no `/`, no glob, no `.md`) ⇒
 *       `.kiro/skills/<name>/SKILL.md` in the workspace, else `<kiroHome>/skills/<name>/SKILL.md`;
 *     - path or glob (`skill://.kiro/skills/**​/SKILL.md`, `skill://~/.kiro/skills/*​/SKILL.md`)
 *       relative to the workspace root, `~/` expanded (`~/.kiro/` maps to `$KIRO_HOME` when
 *       set); a match that is a directory means `<dir>/SKILL.md`;
 *  3. global defaults `<kiroHome>/skills/<dir>/SKILL.md` (when `includeDefaults`).
 * A skill directory reached twice is listed once. `name` / `description` come from the
 * SKILL.md front matter (name defaults to the directory name).
 *
 * Claude exposure ({@link buildSkillsPluginDir}): a plugin directory
 * `<targetDir>/kiro/.claude-plugin/plugin.json` = `{"name":"kiro","version":"0.0.0"}` plus
 * `<targetDir>/kiro/skills/<name>` symlinked to each skill directory (copied when symlinks
 * are not permitted). Claude namespaces them `kiro:<name>` (VERIFIED 04 e8).
 *
 * `/<skill> args` typed by the user ({@link expandSkillInvocation}): the SKILL.md body with
 * `$ARGUMENTS` / `${@}` (the raw argument text) and `${N}` (shlex-split words) substituted;
 * without placeholders the arguments are appended as `ARGUMENTS: <args>`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SkillInfo, WorkspaceContext } from '../types.js';
import { parseFrontMatter } from '../util/frontmatter.js';
import { mkdirp, writeJsonAtomic } from '../util/fsx.js';
import { hasGlobMeta, walkGlob } from '../util/glob.js';
import { realpathSafe } from '../util/paths.js';
import { shlexSplit } from '../util/shlex.js';
import { normalizeNewlines, stripBom } from '../util/text.js';
import { hasPromptPlaceholders, substituteArgs } from './prompts.js';
import { resolveSpec, stripScheme } from './uri.js';
import { workspaceKiroDir } from './workspace.js';

/** Default skill URIs (02 §2.11) — what `includeDefaults` scans. */
export const DEFAULT_SKILL_URIS = ['skill://.kiro/skills/*/SKILL.md', 'skill://~/.kiro/skills/*/SKILL.md'] as const;

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Read name/description of one skill directory; `undefined` if it has no SKILL.md. */
export function readSkill(dir: string, scope: SkillInfo['scope']): SkillInfo | undefined {
  const skillFile = path.join(dir, 'SKILL.md');
  if (!isFile(skillFile)) return undefined;
  let data: Record<string, unknown> = {};
  try {
    data = parseFrontMatter(stripBom(fs.readFileSync(skillFile, 'utf8'))).data;
  } catch {
    data = {};
  }
  const name = typeof data.name === 'string' && data.name.trim() !== '' ? data.name.trim() : path.basename(dir);
  const info: SkillInfo = { name, dir, skillFile, scope };
  if (typeof data.description === 'string' && data.description.trim() !== '') info.description = data.description.trim();
  return info;
}

function skillDirsIn(root: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(root).sort();
  } catch {
    return [];
  }
  return names.filter((n) => !n.startsWith('.')).map((n) => path.join(root, n)).filter(isDir);
}

/** Resolve one `skill://` URI to skill directories (see module doc). */
export function resolveSkillUri(ws: WorkspaceContext, uri: string): string[] {
  const spec = (stripScheme(uri, 'skill') ?? uri).trim();
  if (spec === '') return [];
  const wk = workspaceKiroDir(ws);
  if (!spec.includes('/') && !spec.includes('\\') && !hasGlobMeta(spec, 'path') && !spec.toLowerCase().endsWith('.md')) {
    const cands = [...(wk ? [path.join(wk, 'skills', spec)] : []), path.join(ws.kiroHome, 'skills', spec)];
    for (const c of cands) if (isFile(path.join(c, 'SKILL.md'))) return [c];
    return [];
  }
  const r = resolveSpec(spec, ws);
  const matches = r.glob ? walkGlob(r.pattern, { cwd: r.cwd, env: ws.env, onlyFiles: false }) : fs.existsSync(r.abs) ? [r.abs] : [];
  const out: string[] = [];
  for (const m of matches) {
    if (isDir(m)) {
      if (isFile(path.join(m, 'SKILL.md'))) out.push(m);
    } else if (path.basename(m).toLowerCase().endsWith('.md')) {
      out.push(path.dirname(m));
    }
  }
  return out;
}

/** Discover skills (see module doc). */
export function discoverSkills(ws: WorkspaceContext, skillUris: string[], opts: { includeDefaults: boolean } = { includeDefaults: true }): SkillInfo[] {
  const out: SkillInfo[] = [];
  const names = new Set<string>();
  const dirs = new Set<string>();
  const add = (dir: string, scope: SkillInfo['scope']): void => {
    const real = realpathSafe(dir);
    if (dirs.has(real)) return;
    const s = readSkill(dir, scope);
    if (!s) return;
    dirs.add(real);
    if (names.has(s.name)) return;
    names.add(s.name);
    out.push(s);
  };
  const wk = workspaceKiroDir(ws);
  if (opts.includeDefaults && wk) for (const d of skillDirsIn(path.join(wk, 'skills'))) add(d, 'workspace');
  for (const uri of skillUris) for (const d of resolveSkillUri(ws, uri)) add(d, 'resource');
  if (opts.includeDefaults) for (const d of skillDirsIn(path.join(ws.kiroHome, 'skills'))) add(d, 'global');
  return out;
}

/** Plugin-safe skill directory name (`[a-z0-9-]`, ≤ 64 chars). */
export function pluginSkillName(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return s === '' ? 'skill' : s;
}

function copyDir(src: string, dst: string, depth = 0): void {
  if (depth > 32) return;
  mkdirp(dst);
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    let st: fs.Stats;
    try {
      st = fs.statSync(s);
    } catch {
      continue;
    }
    if (st.isDirectory()) copyDir(s, d, depth + 1);
    else if (st.isFile()) fs.copyFileSync(s, d);
  }
}

/**
 * Build `<targetDir>/kiro` as a Claude plugin exposing `skills` (see module doc). Returns
 * the plugin directory, or `undefined` when `skills` is empty. Any previous `skills/`
 * content of that plugin directory is replaced.
 */
export function buildSkillsPluginDir(skills: SkillInfo[], targetDir: string): string | undefined {
  if (skills.length === 0) return undefined;
  const pluginDir = path.join(targetDir, 'kiro');
  const skillsDir = path.join(pluginDir, 'skills');
  mkdirp(path.join(pluginDir, '.claude-plugin'));
  writeJsonAtomic(path.join(pluginDir, '.claude-plugin', 'plugin.json'), { name: 'kiro', version: '0.0.0' });
  fs.rmSync(skillsDir, { recursive: true, force: true });
  mkdirp(skillsDir);
  const used = new Set<string>();
  for (const s of skills) {
    const base = pluginSkillName(s.name);
    let n = base;
    for (let i = 2; used.has(n); i++) n = `${base}-${i}`;
    used.add(n);
    const link = path.join(skillsDir, n);
    try {
      fs.symlinkSync(s.dir, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP' || code === 'EINVAL' || process.platform === 'win32') {
        copyDir(s.dir, link);
      } else {
        throw e;
      }
    }
  }
  return pluginDir;
}

/** The SKILL.md body (front matter stripped, CRLF normalized, trimmed). */
export function readSkillBody(skill: SkillInfo): string {
  const text = fs.readFileSync(skill.skillFile, 'utf8');
  return normalizeNewlines(parseFrontMatter(stripBom(text)).body).trim();
}

/** Text sent for `/<skill> args` (see module doc). */
export function expandSkillInvocation(skill: SkillInfo, args: string): string {
  const body = readSkillBody(skill);
  const raw = args.trim();
  if (hasPromptPlaceholders(body)) {
    const words = shlexSplit(raw) ?? raw.split(/\s+/).filter((w) => w !== '');
    return substituteArgs(body, words, raw);
  }
  return raw === '' ? body : `${body}\n\nARGUMENTS: ${raw}`;
}

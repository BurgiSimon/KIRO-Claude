/**
 * Steering files, `#[[file:…]]` references and AGENTS.md discovery (02 §4, 03 §3, 00 §2.2).
 *
 * Locations, in output order (global first so workspace instructions win on conflict):
 *  1. global `<kiroHome>/steering/**​/*.md` (scope `global`; its top-level `AGENTS.md` is
 *     skipped here because {@link findAgentsMd} returns it);
 *  2. legacy `<workspaceRoot>/.amazonq/rules/**​/*.md` (scope `legacy`);
 *  3. workspace `<workspaceRoot>/.kiro/steering/**​/*.md` (scope `workspace`).
 * Files are sorted by relative path within each root; a path seen twice (e.g. KIRO_HOME
 * pointing at the workspace `.kiro`) is loaded once.
 *
 * Front matter (03 §3, 02 §4): must start at the first byte (BOM tolerated). `inclusion`:
 *  - absent / no front matter / unknown value ⇒ `always` (unknown values add a warning);
 *  - `always`, `fileMatch` (aliases `filematch`, `file_match`, `file-match`), `manual`,
 *    `auto` (alias `automatic`), compared case-insensitively;
 *  - `fileMatchPattern`: string or string[] (alias `fileMatchPatterns`); missing ⇒ `[]`
 *    (never matches);
 *  - `description`; for `auto` the front matter `name` (if any) names the file, else the stem.
 * The body is front-matter-stripped with CRLF normalized; file references are NOT expanded
 * (call {@link expandFileRefs} with {@link steeringRefBase}).
 *
 * File references (02 §4 "File references"):
 *  - `#[[file:p]]` ⇒ `[<p>]\n<content>`; `#[[file:p:L]]` ⇒ line L; `#[[file:p:A-B]]` ⇒ lines
 *    A..B inclusive (1-based, clamped); `#[[folder:p]]` ⇒ `[<p>/]` + one-level listing
 *    (directories suffixed `/`, sorted).
 *  - Relative paths resolve against `baseDir`; `~/` expands; absolute paths are used as is.
 *  - Unresolvable ⇒ `[missing: p]`; `.kiroignore`d ⇒ `[ignored: p]`; contents over
 *    {@link FILE_REF_MAX_BYTES} are truncated with a note. Not recursive.
 *
 * fileMatch activation helper: {@link fileMatchMatches}. Steering files reached through an
 * agent's own `file://` resources (custom agents with default-resource inheritance off) are
 * parsed with {@link loadSteeringPaths} so their inclusion modes still apply.
 *
 * AGENTS.md (02 §4): `<kiroHome>/steering/AGENTS.md`, the workspace root `AGENTS.md`, then
 * nested `AGENTS.md` files in subdirectories (bounded breadth-first walk: depth ≤
 * {@link AGENTS_MD_MAX_DEPTH}, ≤ {@link AGENTS_MD_MAX_DIRS} directories, skipping `.git`,
 * `node_modules`, other dot-directories and `.kiroignore`d directories).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ConfigWarning, SteeringFile, SteeringInclusion, WorkspaceContext } from '../types.js';
import { parseFrontMatter } from '../util/frontmatter.js';
import { globMatch, walkGlob } from '../util/glob.js';
import { expandTilde, realpathSafe, toPosixPath } from '../util/paths.js';
import { normalizeNewlines, stripBom, truncateBytes } from '../util/text.js';
import { ownValue } from './diag.js';
import { isInsideRel, loadKiroIgnore, type KiroIgnore } from './kiroignore.js';
import { samePath, workspaceAmazonqDir, workspaceKiroDir } from './workspace.js';

/** Maximum bytes inlined per `#[[file:…]]` reference. */
export const FILE_REF_MAX_BYTES = 256 * 1024;
export const AGENTS_MD_MAX_DEPTH = 8;
export const AGENTS_MD_MAX_DIRS = 5000;

const INCLUSION_ALIASES: Record<string, SteeringInclusion> = {
  always: 'always',
  filematch: 'fileMatch',
  manual: 'manual',
  auto: 'auto',
  automatic: 'auto',
};

/** Parse an `inclusion` value; `undefined` for unknown values. */
export function parseInclusion(v: unknown): SteeringInclusion | undefined {
  if (typeof v !== 'string') return undefined;
  return ownValue(INCLUSION_ALIASES, v.trim().toLowerCase().replace(/[_\-\s]/g, ''));
}

function patternList(v: unknown): string[] {
  if (typeof v === 'string') return v.trim() === '' ? [] : [v.trim()];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim());
  return [];
}

/** Parse one steering file's text (exported for tests and for `#steering:` lookups). */
export function parseSteeringText(
  text: string,
  meta: { path: string; scope: SteeringFile['scope'] },
): { file: SteeringFile; warnings: ConfigWarning[] } {
  const warnings: ConfigWarning[] = [];
  const fm = parseFrontMatter(stripBom(text));
  if (fm.error) warnings.push({ code: 'steering-front-matter', message: `${meta.path}: ${fm.error}`, path: meta.path });
  const stem = path.basename(meta.path).replace(/\.md$/i, '');
  let inclusion: SteeringInclusion = 'always';
  if (fm.data.inclusion !== undefined && fm.data.inclusion !== null) {
    const inc = parseInclusion(fm.data.inclusion);
    if (inc) inclusion = inc;
    else {
      warnings.push({
        code: 'steering-inclusion',
        message: `${meta.path}: unknown inclusion ${JSON.stringify(fm.data.inclusion)} (treated as always)`,
        path: meta.path,
      });
    }
  }
  const patterns = patternList(fm.data.fileMatchPattern ?? fm.data.fileMatchPatterns);
  const description = typeof fm.data.description === 'string' && fm.data.description.trim() !== '' ? fm.data.description.trim() : undefined;
  let name = stem;
  if (inclusion === 'auto' && typeof fm.data.name === 'string' && fm.data.name.trim() !== '') name = fm.data.name.trim();
  if (inclusion === 'auto' && !description) {
    warnings.push({ code: 'steering-auto', message: `${meta.path}: inclusion auto needs a description`, path: meta.path });
  }
  const file: SteeringFile = {
    path: meta.path,
    scope: meta.scope,
    name,
    inclusion,
    fileMatchPatterns: patterns,
    body: normalizeNewlines(fm.body),
  };
  if (description) file.description = description;
  return { file, warnings };
}

/** Steering roots for `ws` in output order (see module doc). */
export function steeringDirs(ws: WorkspaceContext): { dir: string; scope: SteeringFile['scope'] }[] {
  const out: { dir: string; scope: SteeringFile['scope'] }[] = [{ dir: path.join(ws.kiroHome, 'steering'), scope: 'global' }];
  const aq = workspaceAmazonqDir(ws);
  if (aq) out.push({ dir: path.join(aq, 'rules'), scope: 'legacy' });
  const wk = workspaceKiroDir(ws);
  if (wk) out.push({ dir: path.join(wk, 'steering'), scope: 'workspace' });
  return out;
}

/** Load every steering file (see module doc). */
export function loadSteering(ws: WorkspaceContext): { files: SteeringFile[]; warnings: ConfigWarning[] } {
  const files: SteeringFile[] = [];
  const warnings: ConfigWarning[] = [];
  const seen = new Set<string>();
  const globalAgentsMd = path.join(ws.kiroHome, 'steering', 'AGENTS.md');
  for (const { dir, scope } of steeringDirs(ws)) {
    const paths = walkGlob('**/*.md', { cwd: dir, env: ws.env, ignoreDirs: ['.git', 'node_modules'] });
    for (const p of paths) {
      if (scope === 'global' && samePath(p, globalAgentsMd)) continue;
      if (path.basename(p).startsWith('._')) continue;
      const real = realpathSafe(p);
      if (seen.has(real)) continue;
      seen.add(real);
      let text: string;
      try {
        text = fs.readFileSync(p, 'utf8');
      } catch (e) {
        warnings.push({ code: 'steering-read', message: `Failed to read ${p}: ${e instanceof Error ? e.message : String(e)}`, path: p });
        continue;
      }
      const r = parseSteeringText(text, { path: p, scope });
      files.push(r.file);
      warnings.push(...r.warnings);
    }
  }
  return { files, warnings };
}

/**
 * Steering scope of `absPath` when it is a `.md` file inside one of {@link steeringDirs}
 * (used to give steering files matched by agent `file://` resources their inclusion
 * semantics, 02 §2.11 "Steering inclusion modes apply to the steering globs"), else undefined.
 */
export function steeringScopeOf(ws: WorkspaceContext, absPath: string): SteeringFile['scope'] | undefined {
  if (!absPath.toLowerCase().endsWith('.md')) return undefined;
  const real = realpathSafe(absPath);
  for (const { dir, scope } of steeringDirs(ws)) {
    const rel = path.relative(realpathSafe(dir), real);
    if (rel !== '' && isInsideRel(rel)) return scope;
  }
  return undefined;
}

/**
 * Parse specific steering files (e.g. {@link steeringScopeOf} matches of an agent's resources
 * when default resources are not inherited). Paths outside the steering dirs get scope
 * `workspace`. Unreadable files are skipped with a warning.
 */
export function loadSteeringPaths(ws: WorkspaceContext, paths: readonly string[]): { files: SteeringFile[]; warnings: ConfigWarning[] } {
  const files: SteeringFile[] = [];
  const warnings: ConfigWarning[] = [];
  const seen = new Set<string>();
  for (const p of paths) {
    const real = realpathSafe(p);
    if (seen.has(real)) continue;
    seen.add(real);
    let text: string;
    try {
      text = fs.readFileSync(p, 'utf8');
    } catch (e) {
      warnings.push({ code: 'steering-read', message: `Failed to read ${p}: ${e instanceof Error ? e.message : String(e)}`, path: p });
      continue;
    }
    const r = parseSteeringText(text, { path: p, scope: steeringScopeOf(ws, p) ?? 'workspace' });
    files.push(r.file);
    warnings.push(...r.warnings);
  }
  return { files, warnings };
}

/**
 * Whether a workspace-relative path matches `fileMatchPattern` globs (03 §3, UNVERIFIED CLI
 * semantics; DECISION after KiroCrew): each pattern is matched in the V3 path dialect
 * (`*` within a component, `**` = any directories, `{a,b}`); a pattern without `/` (after
 * dropping a leading `**​/`) also matches the basename anywhere (`*.tsx` ⇒ any `.tsx` file).
 * A leading `./` or `/` in either side is ignored; `\` separators are normalized. An empty
 * list never matches.
 */
export function fileMatchMatches(patterns: readonly string[], relPath: string): boolean {
  const subject = toPosixPath(relPath).replace(/^(?:\.\/)+/, '').replace(/^\/+/, '');
  if (subject === '') return false;
  const base = subject.slice(subject.lastIndexOf('/') + 1);
  for (const raw of patterns) {
    let p = raw.trim().replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/^\/+/, '');
    if (p === '') continue;
    if (globMatch(p, subject, 'v3path', { windows: false })) return true;
    while (p.startsWith('**/')) p = p.slice(3);
    if (p !== '' && !p.includes('/') && globMatch(p, base, 'v3path', { windows: false })) return true;
  }
  return false;
}

/** Base directory for `#[[file:…]]` refs in a steering file (02 §4). */
export function steeringRefBase(ws: WorkspaceContext, file: Pick<SteeringFile, 'scope' | 'path'>): string {
  if (file.scope === 'global') return path.join(ws.kiroHome, 'steering');
  if (path.basename(file.path) === 'AGENTS.md') return path.dirname(file.path);
  return ws.workspaceRoot;
}

const REF_RE = /#\[\[(file|folder):([^\]\n]+?)\]\]/g;

/** Split `p:L` / `p:A-B` into path and range (only a trailing numeric suffix counts). */
export function parseFileRef(spec: string): { path: string; start?: number; end?: number } {
  const m = /^(.*?):(\d+)(?:-(\d+))?$/.exec(spec.trim());
  if (m && m[1] !== '') {
    const start = Number(m[2]);
    const end = m[3] !== undefined ? Number(m[3]) : start;
    return { path: m[1]!, start, end };
  }
  return { path: spec.trim() };
}

/**
 * Expand `#[[file:…]]` / `#[[folder:…]]` references in `body` (see module doc). `ignore`
 * may be passed to avoid re-reading `.kiroignore` for every file.
 */
export function expandFileRefs(body: string, baseDir: string, ws: WorkspaceContext, ignore?: KiroIgnore): string {
  if (!body.includes('#[[')) return body;
  let ig = ignore;
  const ignoreOf = (): KiroIgnore => (ig ??= loadKiroIgnore(ws));
  return body.replace(REF_RE, (_whole, kind: string, specRaw: string) => {
    const spec = specRaw.trim();
    if (kind === 'folder') {
      const rel = spec.replace(/[\\/]+$/, '');
      const abs = path.resolve(baseDir, expandTilde(rel, ws.env));
      if (ignoreOf().isIgnored(abs)) return `[ignored: ${spec}]`;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(abs, { withFileTypes: true });
      } catch {
        return `[missing: ${spec}]`;
      }
      const names = entries
        .filter((e) => !ignoreOf().isIgnored(path.join(abs, e.name)))
        .map((e) => {
          let dir = e.isDirectory();
          if (!dir && e.isSymbolicLink()) {
            try {
              dir = fs.statSync(path.join(abs, e.name)).isDirectory();
            } catch {
              dir = false;
            }
          }
          return dir ? `${e.name}/` : e.name;
        })
        .sort();
      return `[${toPosixPath(rel)}/]\n${names.join('\n')}`;
    }
    const ref = parseFileRef(spec);
    const abs = path.resolve(baseDir, expandTilde(ref.path, ws.env));
    if (ignoreOf().isIgnored(abs)) return `[ignored: ${spec}]`;
    let text: string;
    try {
      if (!fs.statSync(abs).isFile()) return `[missing: ${spec}]`;
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      return `[missing: ${spec}]`;
    }
    text = normalizeNewlines(stripBom(text));
    let label = ref.path;
    if (ref.start !== undefined) {
      const lines = text.split('\n');
      if (lines.length > 0 && lines[lines.length - 1] === '' && text.endsWith('\n')) lines.pop();
      const end = ref.end ?? ref.start;
      const a = Math.max(1, Math.min(ref.start, end));
      const b = Math.max(a, ref.start, end);
      text = lines.slice(a - 1, b).join('\n');
      label = a === b ? `${ref.path}:${a}` : `${ref.path}:${a}-${b}`;
    } else {
      text = text.replace(/\n$/, '');
    }
    const cut = truncateBytes(text, FILE_REF_MAX_BYTES);
    const note = cut.length < text.length ? '\n[truncated]' : '';
    return `[${label}]\n${cut}${note}`;
  });
}

/** Directory names never entered by the nested AGENTS.md walk. */
const AGENTS_SKIP = new Set(['node_modules', '.git']);

/** AGENTS.md files in context order (see module doc). */
export function findAgentsMd(ws: WorkspaceContext): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (p: string): void => {
    try {
      if (!fs.statSync(p).isFile()) return;
    } catch {
      return;
    }
    const r = realpathSafe(p);
    if (seen.has(r)) return;
    seen.add(r);
    out.push(p);
  };
  add(path.join(ws.kiroHome, 'steering', 'AGENTS.md'));
  const root = ws.workspaceRoot;
  add(path.join(root, 'AGENTS.md'));
  if (samePath(root, ws.home)) return out; // never walk the whole home directory
  const ignore = loadKiroIgnore(ws);
  const nested: string[] = [];
  let queue: string[] = [root];
  let dirs = 0;
  for (let depth = 0; depth < AGENTS_MD_MAX_DEPTH && queue.length && dirs < AGENTS_MD_MAX_DIRS; depth++) {
    const next: string[] = [];
    for (const dir of queue) {
      if (dirs >= AGENTS_MD_MAX_DIRS) break;
      dirs++;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        if (AGENTS_SKIP.has(e.name) || e.name.startsWith('.')) continue;
        const sub = path.join(dir, e.name);
        if (ignore.isIgnored(sub)) continue;
        const candidate = path.join(sub, 'AGENTS.md');
        if (fs.existsSync(candidate) && !ignore.isIgnored(candidate)) nested.push(candidate);
        next.push(sub);
      }
    }
    queue = next;
  }
  nested.sort((a, b) => {
    const ra = toPosixPath(path.relative(root, a));
    const rb = toPosixPath(path.relative(root, b));
    return ra < rb ? -1 : ra > rb ? 1 : 0;
  });
  for (const p of nested) add(p);
  return out;
}

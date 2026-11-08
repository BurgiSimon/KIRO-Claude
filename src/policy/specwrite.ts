/**
 * The spec-phase write allowance (03 §1.2, §1.11.3): while a spec phase runs, the gate
 * auto-allows `fs_write` calls (Write, Edit, MultiEdit, NotebookEdit) on that phase's documents
 * (`<workspace>/.kiro/specs/<feature>/{requirements,bugfix,design,tasks}.md`, SpecPhaseRestriction
 * `allowedWritePaths`) and denies every other write; in plan mode the same documents are the one
 * exception to the plan-mode denial (gate.ts). {@link checkSpecWrite} decides whether a call's
 * subjects are such documents.
 *
 * The allowance is anchored to the spec folder and never follows a link AT the document (review
 * r5 #3: comparing realpaths let a document committed as a symlink make its target writable,
 * anywhere on disk and in plan mode, and a document linked to a directory the whole directory):
 *  - An entry without glob syntax (absolute, `~/…`, or relative to the workspace root) names one
 *    document, or a folder whose files are all allowed. Its parent folder is resolved with
 *    realpathDeep, so a symlinked `.kiro`, `.kiro/specs` or `.kiro/specs/<feature>` folder keeps
 *    working; its last component is not: the subject's canonical path (realpathDeep) must be that
 *    path, or lie inside it.
 *  - An entry that is itself a symbolic link (also a dangling one, or a chain) allows nothing.
 *  - A subject whose own path (tilde-expanded, joined to the call's cwd; trailing `/` ignored) is
 *    a symbolic link is refused: a write through it would follow the link.
 *  - A subject with a symbolic link above it that resolves to nothing (a dangling folder link, a
 *    chain whose last hop dangles, a loop) is refused: realpathDeep would resolve it lexically,
 *    as a folder inside the workspace, wherever the link points ({@link unresolvedLinkAbove}).
 *    So is one with a link above it whose target cannot be accessed (realpath fails with EACCES
 *    or EPERM: the target is behind a folder the user cannot enter), with that reason, not
 *    "dangling": nothing can tell where such a link leads, and the lexical fallback could place
 *    an outside target inside the workspace. DECISION (the research is silent): refuse rather
 *    than let the I/O error surface later, since the gate must never allow what it cannot check.
 *  - A subject whose path as written (the tool's `file_path` / `notebook_path`) has a `..` right
 *    after a symbolic link is refused: the OS and a lexical normalization disagree on where it
 *    lands.
 *  - The subject's canonical path must stay inside the realpath of the workspace root. DECISION:
 *    the research is silent on spec folders that are symlinks; one that resolves inside the
 *    workspace works, one that resolves outside it is refused, since such a write would ask
 *    under the user's own rules and the spec rule must not turn it into an allow (never fewer
 *    restrictions than the user set).
 *  - Only RELATIVE entries with glob syntax are patterns (pathmatch.canonicalizePattern, the
 *    workspace root escaped as literal text, the match also inside the pattern's literal prefix).
 *    Absolute and `~/` entries are literal paths, also when the workspace path holds
 *    `[ ] { } * ?`.
 * Hard links need no special case: a hard link is a regular file at its own path. Case is
 * compared as the file system reports it (realpath); a name that differs only in case is another
 * document on a case-sensitive file system and the stored name on a case-insensitive one.
 *
 * A refused subject that names an allowed document (or lies under an allowed folder, or matches
 * an allowed pattern) carries a `refused` explanation; the gate appends it to its spec-phase
 * denial, so the model and the user see why the phase cannot write its own document. So does a
 * subject that names a document the phase left out of the allowance (SpecPhaseRestriction
 * `refusedWritePaths`: a document that is not a regular file or that the user cannot read, which
 * the rules above would allow; r9 #7), with the reason the phase recorded, in plan mode too.
 *
 * kiro-claude's OWN reads and writes of spec files (review X1: listing, status, view, the task
 * context, the tasks.md repair, box updates, `.config.kiro`) follow the same subject rules:
 * {@link specFileRefusal} for a document or `.config.kiro` (a link at it, anything there that is
 * not a regular file, a link above it that resolves to nothing or whose target cannot be
 * accessed, a real path outside the workspace) and {@link specFolderRefusal} for a spec folder
 * or `.kiro/specs` (a link at the folder is followed when it resolves inside the workspace).
 * They also refuse what the user cannot access, which the gate leaves to the tool's own I/O
 * error: a document the user cannot read (whatever its size) and a folder it cannot enter, also
 * one a link points at, or a folder under such a folder (EACCES or EPERM: `<p> cannot be accessed
 * (permission denied)`, {@link isAccessRefusal}). DECISION (r7 #6; the research is silent): such
 * a file is refused rather than taken for a missing one, so it is never drafted over and no task
 * runs without it. src/spec/docfs.ts applies them, and words its advice by
 * {@link isLinkAccessRefusal} and {@link isAccessRefusal}.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { KiroToolCall, WorkspaceContext } from '../types.js';
import { globMatch, hasGlobMeta } from '../util/glob.js';
import { expandTilde, isSubpath, realpathDeep } from '../util/paths.js';
import { canonicalizePattern } from './pathmatch.js';

export interface SpecWriteCheck {
  /** Every subject (at least one) is an allowed spec document. */
  ok: boolean;
  /** When not ok: why a subject that names an allowed document was refused. */
  refused?: string;
}

/** `lstat` says symbolic link (false when missing or unreadable). */
function isLink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * A symbolic link that realpath cannot resolve, with realpath's error code at it: ENOENT, ENOTDIR
 * or ELOOP mean the link resolves to nothing (dangling, or a loop); EACCES or EPERM that its
 * target cannot be accessed (a folder on the way the user cannot enter); any other code that it
 * cannot be resolved either. Each is refused: none can be checked against the workspace.
 */
export interface UnresolvedLink {
  link: string;
  code: string | undefined;
}

/** realpath error codes at a link that mean it resolves to nothing (dangling, or a loop). */
const DANGLING_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR', 'ELOOP']);

function errCode(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : undefined;
}

/**
 * The symbolic link above `p` (its folder or an ancestor of it) that realpath cannot resolve: a
 * dangling link, a loop, or a link whose target cannot be accessed ({@link UnresolvedLink});
 * undefined when every link above `p` resolves. realpathDeep cannot see such a link: it resolves
 * the deepest ancestor it can and appends the rest LEXICALLY, as if the link were a plain folder
 * inside the workspace.
 */
export function unresolvedLinkAbove(p: string): UnresolvedLink | undefined {
  return unresolvedLinkFrom(path.dirname(path.resolve(p)));
}

/** Like {@link unresolvedLinkAbove}, starting at `start` itself (a folder that may be the link). */
function unresolvedLinkFrom(start: string): UnresolvedLink | undefined {
  let cur = start;
  for (;;) {
    let code: string | undefined;
    try {
      fs.realpathSync.native(cur);
      return undefined;
    } catch (e) {
      // missing, or a link on the way that resolves to nothing or cannot be accessed
      code = errCode(e);
    }
    // the first link from the bottom: lstat reached it, so realpath failed on its own target
    if (isLink(cur)) return { link: cur, code };
    const parent = path.dirname(cur);
    if (parent === cur) return undefined;
    cur = parent;
  }
}

/**
 * The first `..` of `raw` (joined to `cwd`) that follows a symbolic link, as the lexical path up
 * to it; undefined when there is none. A `..` after a regular directory pops the same component
 * lexically and physically (the walk keeps the lexical path; its ancestors are equivalent).
 */
export function dotDotAfterLink(raw: string, cwd: string, env: NodeJS.ProcessEnv): string | undefined {
  const p = expandTilde(raw, env);
  if (!/(^|[\\/])\.\.([\\/]|$)/.test(p)) return undefined;
  const abs = path.isAbsolute(p) ? p : `${cwd}${path.sep}${p}`;
  const root = path.parse(abs).root || path.sep;
  let cur = root;
  for (const seg of abs.slice(root.length).split(/[\\/]+/)) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (isLink(cur)) return cur;
      cur = path.dirname(cur);
      continue;
    }
    cur = path.join(cur, seg);
  }
  return undefined;
}

/**
 * `p` reaches the symbolic link `u.link` that realpath cannot resolve: it resolves to nothing
 * (dangling, or a loop), or its target cannot be accessed (permission denied, or another error).
 */
function unresolvedWhy(p: string, u: UnresolvedLink): string {
  if (u.code !== undefined && DANGLING_CODES.has(u.code)) return `${p}: the symbolic link ${u.link} resolves to nothing (dangling, or a loop)`;
  const what = u.code === 'EACCES' || u.code === 'EPERM' ? 'permission denied' : (u.code ?? 'unknown error');
  return `${p}: the target of the symbolic link ${u.link} cannot be accessed (${what})`;
}

/**
 * `why` (a reason of {@link specFileRefusal}, {@link specFolderRefusal} or checkSpecWrite) says
 * that a symbolic link's target cannot be accessed, not that the link dangles or leaves the
 * workspace: the link may well be fine, so replacing it or moving the folder is no remedy. The
 * paths in it may hold any character a file name may, a newline included (`s` flag).
 */
export function isLinkAccessRefusal(why: string): boolean {
  return /: the target of the symbolic link .+ cannot be accessed \([^()]+\)$/s.test(why);
}

/** Error codes meaning the user may not access a path (worded "permission denied"). */
const DENIED_CODES: ReadonlySet<string> = new Set(['EACCES', 'EPERM']);

/** The reason of a spec file or folder `p` that the user cannot access ({@link isAccessRefusal}). */
export function deniedWhy(p: string): string {
  return `${p} cannot be accessed (permission denied)`;
}

/**
 * `why` (a reason of {@link specFileRefusal} or {@link specFolderRefusal}) says that a spec file
 * or folder itself, or a folder above it, cannot be accessed by the user (EACCES or EPERM): not a
 * link problem, so the advice is to check permissions. Not a {@link isLinkAccessRefusal} reason.
 * The paths in it may hold any character a file name may, a newline included (`s` flag).
 */
export function isAccessRefusal(why: string): boolean {
  return !isLinkAccessRefusal(why) && / cannot be accessed \(permission denied\)$/s.test(why);
}

/** `stat(<d>/.)`: undefined when the folder `d` can be entered (searched), else the error code. */
function enterCode(d: string): string | undefined {
  try {
    fs.statSync(`${d}${path.sep}.`);
    return undefined;
  } catch (e) {
    return errCode(e) ?? 'EUNKNOWN';
  }
}

/**
 * `p` is, or lies under, a folder the user cannot enter: walking up from the folder `from` (`p`
 * itself or its folder), the topmost folder whose entering fails with EACCES or EPERM (`stat` of
 * `<folder>/.` fails so for that folder and everything below it), until one can be entered. The
 * reason names `p`, and that folder when it is another one; undefined when there is none (also
 * when `p` merely does not exist).
 */
function deniedFolderWhy(p: string, from: string): string | undefined {
  let denied: string | undefined;
  for (let cur = from; ; ) {
    const code = enterCode(cur);
    if (code === undefined) break;
    if (DENIED_CODES.has(code)) denied = cur;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  if (denied === undefined) return undefined;
  return denied === p ? deniedWhy(p) : `${p}: ${deniedWhy(denied)}`;
}

/**
 * The user cannot read the spec file `p` (`st`: its lstat, undefined when lstat failed with
 * `code`): an existing file it may not read, or a folder above it it cannot enter.
 */
function fileAccessWhy(p: string, st: fs.Stats | undefined, code: string | undefined): string | undefined {
  if (!st) return code !== undefined && DENIED_CODES.has(code) ? (deniedFolderWhy(p, path.dirname(p)) ?? deniedWhy(p)) : undefined;
  try {
    fs.accessSync(p, fs.constants.R_OK);
    return undefined;
  } catch (e) {
    return DENIED_CODES.has(errCode(e) ?? '') ? deniedWhy(p) : undefined;
  }
}

/** `p` (canonical `c`) is outside the workspace `base`. */
function outsideWhy(p: string, c: string, base: string): string {
  return `${p}${c === p ? ' is' : ` resolves to ${c},`} outside the workspace ${base}`;
}

/** Unresolvable link `unresolved` on the way to `p`, else `p`'s real path outside `base`. */
function placeRefusal(p: string, unresolved: UnresolvedLink | undefined, base: string): string | undefined {
  if (unresolved) return unresolvedWhy(p, unresolved);
  const c = realpathDeep(p);
  return isSubpath(c, realpathDeep(base)) ? undefined : outsideWhy(p, c, base);
}

/**
 * Why kiro-claude itself must not read or write `file`, a document or the `.config.kiro` of a
 * spec folder in the workspace `workspaceRoot` (module doc, review X1); undefined when it may,
 * also when `file` does not exist yet (and may be created). Refused: a symbolic link at `file`
 * (also one to another document of the folder), anything at `file` that is not a regular file,
 * a symbolic link above it that resolves to nothing or whose target cannot be accessed, a real
 * path outside the workspace; then a file the user cannot read, or one in a folder the user
 * cannot enter (EACCES or EPERM: {@link deniedWhy}, never taken for a missing file), whatever its
 * size.
 */
export function specFileRefusal(file: string, workspaceRoot: string): string | undefined {
  const p = path.resolve(file);
  let st: fs.Stats | undefined;
  let code: string | undefined;
  try {
    st = fs.lstatSync(p);
  } catch (e) {
    // missing, or in a folder that cannot be entered: the folder rules decide
    code = errCode(e);
  }
  if (st?.isSymbolicLink()) return `${p} is a symbolic link`;
  if (st && !st.isFile()) return `${p} is not a regular file`;
  return placeRefusal(p, unresolvedLinkAbove(p), workspaceRoot) ?? fileAccessWhy(p, st, code);
}

/**
 * Why kiro-claude itself must not use the spec folder `dir` (or `.kiro/specs`) of the workspace
 * `workspaceRoot`: a symbolic link at it or above it that resolves to nothing or whose target
 * cannot be accessed, or a real path outside the workspace; then a folder the user cannot enter,
 * also through a link that points at it, or one under such a folder ({@link deniedWhy}: its
 * documents could not even be told apart from missing ones). A folder that is a link resolving
 * inside the workspace may be used. Reading the folder (listing it) is not required: a
 * search-only folder may be used by name.
 */
export function specFolderRefusal(dir: string, workspaceRoot: string): string | undefined {
  const p = path.resolve(dir);
  return placeRefusal(p, unresolvedLinkFrom(p), workspaceRoot) ?? deniedFolderWhy(p, p);
}

/** The path a write tool's input names as written (before toolmap resolved it), else `fallback`. */
function rawPathOf(call: Pick<KiroToolCall, 'claudeName' | 'input'>, fallback: string): string {
  const v = call.claudeName === 'NotebookEdit' ? call.input.notebook_path : call.input.file_path;
  return typeof v === 'string' && v !== '' ? v : fallback;
}

type EntryVerdict = { kind: 'match' } | { kind: 'refused'; why: string } | { kind: 'none' };

/** A phase document left out of the allowance, with the reason (SpecPhaseRestriction `refusedWritePaths`). */
export interface SpecRefusedPath {
  path: string;
  why: string;
}

/**
 * The reason of the first `refused` document that subject `lexS` (canonical `c`) names: that
 * path, or a path inside it (a document that is a directory), as written or canonical.
 */
function leftOutWhy(lexS: string, c: string, refused: readonly SpecRefusedPath[]): string | undefined {
  for (const r of refused) {
    const p = path.resolve(r.path);
    if (isSubpath(lexS, p) || isSubpath(c, realpathDeep(p))) return r.why;
  }
  return undefined;
}

/**
 * Whether every subject of the `fs_write` call `call` is one of `allowed` (see module doc).
 * `ws` supplies the workspace root (relative entries and the anchor), the env (`~`; `$VAR` in
 * pattern entries) and the home directory. `refused`: phase documents the phase left out of
 * `allowed` (spec/workflow.restrictionFor: not a regular file, unreadable), each with its reason:
 * a subject that names one (as written or canonical, also a path inside it) is refused with that
 * reason, whatever an entry says (r9 #7: the gate's spec-phase denial then names it, in plan mode
 * too). It only ever refuses.
 */
export function checkSpecWrite(
  call: Pick<KiroToolCall, 'claudeName' | 'input' | 'subjects' | 'cwd'>,
  allowed: readonly string[],
  ws: Pick<WorkspaceContext, 'workspaceRoot' | 'cwd' | 'env' | 'home'>,
  refused: readonly SpecRefusedPath[] = [],
): SpecWriteCheck {
  if (call.subjects.length === 0 || (allowed.length === 0 && refused.length === 0)) return { ok: false };
  const base = ws.workspaceRoot || ws.cwd;
  const cwd = call.cwd || ws.cwd;
  const anchor = realpathDeep(base);
  const single = call.subjects.length === 1;
  for (const s of call.subjects) {
    const lexS = path.resolve(cwd, expandTilde(s, ws.env));
    const c = realpathDeep(lexS);
    // subject-level refusals: a link at the subject itself, a link above it that resolves to
    // nothing, a `..` that follows a link, a canonical path outside the workspace
    let why: string | undefined;
    const linked = isLink(lexS);
    const unresolved = linked ? undefined : unresolvedLinkAbove(lexS);
    if (linked) why = `${lexS} is a symbolic link`;
    else if (unresolved) why = unresolvedWhy(lexS, unresolved);
    else {
      const raw = single ? rawPathOf(call, s) : s;
      const dd = single ? dotDotAfterLink(raw, cwd, ws.env) : undefined;
      if (dd) why = `${raw} has '..' after the symbolic link ${dd}`;
    }
    if (!why && !isSubpath(c, anchor)) why = outsideWhy(lexS, c, base);
    const left = leftOutWhy(lexS, c, refused);
    if (left !== undefined) return { ok: false, refused: why ?? left };
    let matched = false;
    let note: string | undefined;
    for (const e of allowed) {
      const v = entryVerdict(e, lexS, c, base, ws);
      if (v.kind === 'none') continue;
      if (v.kind === 'match' && !why) {
        matched = true;
        break;
      }
      note ??= why ?? (v.kind === 'refused' ? v.why : undefined);
    }
    if (!matched) return note ? { ok: false, refused: note } : { ok: false };
  }
  return { ok: true };
}

/** One entry against one subject (`lexS` as written, `c` canonical). */
function entryVerdict(
  e: string,
  lexS: string,
  c: string,
  base: string,
  ws: Pick<WorkspaceContext, 'env' | 'home'>,
): EntryVerdict {
  const expanded = expandTilde(e, ws.env);
  if (!path.isAbsolute(expanded) && hasGlobMeta(e, 'v3path')) {
    const cp = canonicalizePattern(e, base, ws.env, ws.home, 'v3path');
    const hit = globMatch(cp.pattern, c, 'v3path') && isSubpath(c, cp.prefix);
    if (hit) return { kind: 'match' };
    return globMatch(cp.pattern, lexS, 'v3path') ? { kind: 'refused', why: `${lexS} resolves to ${c}` } : { kind: 'none' };
  }
  const lexE = path.resolve(base, expanded);
  const named = lexS === lexE || isSubpath(lexS, lexE);
  if (isLink(lexE)) return named ? { kind: 'refused', why: `${lexE} is a symbolic link` } : { kind: 'none' };
  // the entry's folder is resolved (a symlinked spec folder works), the entry itself is not
  const target = path.join(realpathDeep(path.dirname(lexE)), path.basename(lexE));
  if (isSubpath(c, target)) return { kind: 'match' };
  return named ? { kind: 'refused', why: `${lexS} resolves to ${c}` } : { kind: 'none' };
}

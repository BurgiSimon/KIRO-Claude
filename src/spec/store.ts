/**
 * Spec discovery and metadata: `<workspaceRoot>/.kiro/specs/<name>/`, `.config.kiro`, derived
 * phase state and status summaries.
 *
 * References (research 03):
 *  - §1.2 layout and naming (kebab-case `^[a-z0-9]+(?:-[a-z0-9]+)*$`; other names are normalized
 *    and confirmed by the caller); `#[[file:…]]` references in spec docs are expanded with the
 *    steering resolver (config/steering.expandFileRefs) when docs are injected as context.
 *  - §1.3 `.config.kiro`: single-line JSON with `", "` separators and no trailing newline
 *    (`{"specId": "<uuid>", "workflowType": "requirements-first", "specType": "feature"}`); legacy
 *    `{"generationMode": …}` is read as `workflowType`; missing/garbled ⇒ null and `specType`
 *    inferred from `bugfix.md`. Never add keys. Quick specs write `"feature"` and design-first
 *    writes `"design-first"` (both UNVERIFIED, 03 §7.2 — DECISION per 03 §1.3).
 *  - §1.5.2 a non-empty `bugfix.md` is the phase-1 document; an empty `requirements.md` next to it
 *    (KI:#9963) is ignored.
 *  - §1.11.1 status rows `name  type  phase  done/total`; §1.11.2 state derived from files:
 *    the phase is the first missing/empty document of the type's order, else `execution` while
 *    required tasks remain, else `done`; the document before the missing one awaits approval.
 *
 * Every read and write here goes through spec/docfs.ts (review X1; the research is silent on
 * links in spec folders, so this is the safest reading): a document or `.config.kiro` that is a
 * symbolic link (or not a regular file, or behind a link that resolves to nothing or whose target
 * cannot be accessed, or outside the workspace, or that the user cannot read, whatever its size)
 * is never read; its {@link SpecDocInfo.refused} and the spec's {@link SpecSummary.refused} say
 * why. Such a document counts as present when the phase is
 * derived (it is never offered for drafting as if it were missing), has no known content
 * (`nonEmpty` false) and is left out of the loaded texts and the context block. A spec folder
 * linked out of the workspace (or dangling, or to a target kiro-claude cannot access: a folder on
 * the way the user cannot enter), or that the user cannot enter itself (also through a link that
 * points at it), is listed with its reason, and nothing in it is read (`status` gives its phase as
 * unknown); such a `.kiro` or `.kiro/specs`, and a `.kiro/specs` the user cannot read, is not
 * enumerated at all ({@link specsDirRefused}: the list commands print why instead; `kiro-claude
 * spec list` and `status` exit 1), and a named spec that is not found under it gets that reason,
 * not "not found".
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WorkspaceContext } from '../types.js';
import { expandFileRefs } from '../config/steering.js';
import { SpecFileRefusedError, readSpecFile, specFileRefused, specFolderRefused, specRefusalText, specsListRefused, writeSpecFile } from './docfs.js';
import {
  SPEC_DOC_FILES,
  formatTaskLine,
  lintSpec,
  parseBugfix,
  parseDesign,
  parseRequirements,
  parseTasks,
  planRun,
  planTasks,
  taskProgress,
  type LintIssue,
  type ParsedBugfix,
  type ParsedDesign,
  type ParsedRequirements,
  type ParsedTasks,
  type SpecDocKind,
  type SpecType,
  type TaskProgress,
  type WorkflowType,
} from './model.js';

export interface SpecConfig {
  specId: string;
  workflowType: WorkflowType;
  specType: SpecType;
}

export type SpecPhase = SpecDocKind | 'execution' | 'done';

export interface SpecDocInfo {
  path: string;
  exists: boolean;
  /** Has non-whitespace content. */
  nonEmpty: boolean;
  bytes: number;
  mtimeMs: number;
  /**
   * Why kiro-claude does not read this document (docfs.specFileRefused): it is a symbolic link,
   * not a regular file, behind a link that resolves to nothing or whose target cannot be
   * accessed, or outside the workspace. It may still exist (`exists`); its content is unknown
   * (`nonEmpty` false).
   */
  refused?: string;
}

export interface SpecSummary {
  /** Folder name. */
  name: string;
  /** Absolute `.kiro/specs/<name>`. */
  dir: string;
  /** Parsed `.config.kiro` (null when absent/invalid). */
  config: SpecConfig | null;
  /** Effective type (config, else inferred from bugfix.md). */
  specType: SpecType;
  workflowType: WorkflowType;
  docs: Record<SpecDocKind, SpecDocInfo>;
  /** Document order of this spec's phases (03 §1.11.2). */
  order: SpecDocKind[];
  phase: SpecPhase;
  /** Document whose checkpoint is pending (exists, next one missing). */
  awaitingApproval?: SpecDocKind;
  progress?: TaskProgress;
  /**
   * The first reason kiro-claude does not read something of this spec: its folder, its
   * `.config.kiro`, or a document (each document's own reason is `docs[k].refused`).
   */
  refused?: string;
}

export const SPEC_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const CONFIG_FILE = '.config.kiro';

/** `<workspaceRoot>/.kiro/specs`. */
export function specsDir(ws: Pick<WorkspaceContext, 'workspaceRoot'>): string {
  return path.join(ws.workspaceRoot, '.kiro', 'specs');
}

/**
 * Why `.kiro/specs` itself is not used or not listed (a `.kiro` or `.kiro/specs` linked out of the
 * workspace, to nothing or to a target that cannot be accessed, one the user cannot enter: docfs;
 * or one it may enter but not read, so its entries cannot be enumerated), else undefined.
 * {@link listSpecs} then lists nothing (the entries are another folder's, or cannot be read), the
 * list commands print this reason instead of "no specs", and a named command whose spec is not
 * found prints it instead of "not found" (r7 #7). A search-only `.kiro/specs` still serves its
 * specs by their exact name ({@link resolveSpecDir}).
 */
export function specsDirRefused(ws: Pick<WorkspaceContext, 'workspaceRoot'>): string | undefined {
  return specsListRefused(ws.workspaceRoot);
}

export function isValidSpecName(name: string): boolean {
  return SPEC_NAME_RE.test(name);
}

/** Lowercase, non-alphanumerics ⇒ '-', runs collapsed, edges trimmed (03 §1.2). */
export function normalizeSpecName(raw: string): string {
  return raw
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Existing spec folder for `name` (exact, then case-insensitive); never escapes the specs dir.
 * A folder link that cannot be followed (dangling, a loop, a target that cannot be accessed) is
 * found too, so the commands can say why it cannot be used ({@link SpecSummary.refused}). Under a
 * `.kiro/specs` that is refused ({@link specsDirRefused}) only the exact name is looked up, and
 * only found when `.kiro/specs` can be followed and entered (one linked out of the workspace, a
 * search-only one);
 * otherwise undefined, and the commands print the `.kiro/specs` refusal instead of "not found".
 */
export function resolveSpecDir(ws: Pick<WorkspaceContext, 'workspaceRoot'>, name: string): string | undefined {
  const n = name.trim().replace(/[\\/]+$/, '');
  if (n === '' || n === '.' || n === '..' || /[\\/]/.test(n)) return undefined;
  const root = specsDir(ws);
  const direct = path.join(root, n);
  if (isSpecFolderEntry(direct)) return direct;
  // a refused .kiro/specs is not enumerated (the exact name above is found when it can be
  // reached, so its commands can say why; else the callers print the .kiro/specs refusal)
  if (specsDirRefused(ws)) return undefined;
  try {
    const hit = fs.readdirSync(root, { withFileTypes: true }).find((e) => (e.isDirectory() || e.isSymbolicLink()) && e.name.toLowerCase() === n.toLowerCase() && isSpecFolderEntry(path.join(root, e.name)));
    return hit ? path.join(root, hit.name) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `p` is a directory (also through a link), or a symbolic link `stat` cannot follow: dangling, a
 * loop, or a target behind a folder the user cannot enter. Such a link is listed, and
 * docfs.specFolderRefused gives the reason (DECISION: the research is silent; naming the link
 * with its true reason is more useful than leaving it out as if there were no spec).
 */
function isSpecFolderEntry(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    try {
      return fs.lstatSync(p).isSymbolicLink();
    } catch {
      return false;
    }
  }
}

// ───────────────────────────── .config.kiro (03 §1.3) ─────────────────────────────

/**
 * Read `.config.kiro`; null when missing, unusable or refused (a symbolic link, …: docfs).
 * Legacy `generationMode` ⇒ workflowType.
 */
export function readSpecConfig(dir: string): SpecConfig | null {
  let raw: unknown;
  try {
    const text = readSpecFile(path.join(dir, CONFIG_FILE));
    if (text === undefined) return null;
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const wf = o.workflowType ?? o.generationMode;
  const workflowType: WorkflowType = wf === 'design-first' ? 'design-first' : 'requirements-first';
  if (wf === undefined && o.specType === undefined && o.specId === undefined) return null;
  // No usable specType (legacy `{"generationMode": …}` files): infer it from bugfix.md (03 §1.3).
  const specType: SpecType =
    o.specType === 'bugfix' ? 'bugfix' : o.specType === 'feature' ? 'feature' : hasText(path.join(dir, SPEC_DOC_FILES.bugfix)) ? 'bugfix' : 'feature';
  return { specId: typeof o.specId === 'string' ? o.specId : '', workflowType, specType };
}

/** Exact Kiro shape: `{"specId": "…", "workflowType": "…", "specType": "…"}` (no newline). */
export function formatSpecConfig(cfg: SpecConfig): string {
  const entries: [string, string][] = [
    ['specId', cfg.specId],
    ['workflowType', cfg.workflowType],
    ['specType', cfg.specType],
  ];
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(', ')}}`;
}

/** Write `.config.kiro` (docfs: refused through a link; throws SpecFileRefusedError). */
export function writeSpecConfig(dir: string, cfg: SpecConfig): void {
  writeSpecFile(path.join(dir, CONFIG_FILE), formatSpecConfig(cfg));
}

/**
 * Create `.kiro/specs/<name>/` with its `.config.kiro` (the adapter creates the folder itself, no
 * permission prompt — 03 §1.2). Throws when the name is invalid, the folder already exists, or
 * the folder would not be a usable spec folder (a `.kiro` or `.kiro/specs` that is a link
 * resolving outside the workspace, to nothing or to a target that cannot be accessed:
 * docfs.specFolderRefused).
 */
export function createSpecFolder(
  ws: Pick<WorkspaceContext, 'workspaceRoot'>,
  name: string,
  opts: { specType: SpecType; workflowType: WorkflowType; specId?: string },
): string {
  if (!isValidSpecName(name)) throw new Error(`invalid spec name '${name}' (use kebab-case, e.g. user-authentication)`);
  const dir = path.join(specsDir(ws), name);
  const why = specFolderRefused(dir);
  if (why) throw new Error(specRefusalText(why));
  if (fs.existsSync(dir)) throw new Error(`spec '${name}' already exists (${dir})`);
  fs.mkdirSync(dir, { recursive: true });
  writeSpecConfig(dir, { specId: opts.specId ?? randomUUID(), workflowType: opts.workflowType, specType: opts.specType });
  return dir;
}

// ───────────────────────────── derived state (03 §1.11.2) ─────────────────────────────

/** Phase documents in order for a spec type / workflow. */
export function docOrder(specType: SpecType, workflowType: WorkflowType): SpecDocKind[] {
  if (specType === 'bugfix') return ['bugfix', 'design', 'tasks'];
  if (workflowType === 'design-first') return ['design', 'requirements', 'tasks'];
  return ['requirements', 'design', 'tasks'];
}

/** Metadata of one document (lstat: never through a link at it); `refused` per docfs. */
function docInfo(p: string): SpecDocInfo {
  const none: SpecDocInfo = { path: p, exists: false, nonEmpty: false, bytes: 0, mtimeMs: 0 };
  let st: fs.Stats | undefined;
  try {
    st = fs.lstatSync(p);
  } catch {
    // missing
  }
  const refused = specFileRefused(p);
  if (refused) return { ...none, exists: st !== undefined, mtimeMs: st?.mtimeMs ?? 0, refused };
  if (!st || !st.isFile()) return none;
  const info: SpecDocInfo = { path: p, exists: true, nonEmpty: st.size > 0, bytes: st.size, mtimeMs: st.mtimeMs };
  if (info.nonEmpty && st.size < 4096) info.nonEmpty = (readDoc(info) ?? '').trim() !== '';
  return info;
}

function hasText(p: string): boolean {
  return docInfo(p).nonEmpty;
}

/**
 * The text of document `d` (BOM removed) through docfs; undefined when it is refused, missing or
 * unreadable. A refusal found only now (a link that appeared since `d` was taken, a permission
 * that changed: docfs refuses an EACCES/EPERM) is recorded on `d`.
 */
function readDoc(d: SpecDocInfo): string | undefined {
  if (d.refused) return undefined;
  try {
    return readSpecFile(d.path)?.replace(/^﻿/, '');
  } catch (e) {
    if (e instanceof SpecFileRefusedError) {
      d.refused = e.why;
      d.nonEmpty = false;
    }
    return undefined;
  }
}

/**
 * Every distinct reason kiro-claude does not read something of spec `s` (its folder, its
 * `.config.kiro`, each document): empty when nothing is refused.
 */
export function specRefusals(s: Pick<SpecSummary, 'refused' | 'docs'>): string[] {
  return [...new Set([s.refused, ...(Object.keys(SPEC_DOC_FILES) as SpecDocKind[]).map((k) => s.docs[k].refused)].filter((r): r is string => !!r))];
}

/** A refused document that exists counts as present for the phase (never drafted over as missing). */
function present(d: SpecDocInfo): boolean {
  return d.nonEmpty || (d.refused !== undefined && d.exists);
}

/** Summary of one spec folder (never throws). */
export function summarizeSpecDir(dir: string): SpecSummary {
  // a folder linked out of the workspace (or to nothing, or to a target that cannot be
  // accessed): nothing in it is read
  const folderWhy = specFolderRefused(dir);
  const config = folderWhy ? null : readSpecConfig(dir);
  const configWhy = folderWhy ? undefined : specFileRefused(path.join(dir, CONFIG_FILE));
  const docs = {} as Record<SpecDocKind, SpecDocInfo>;
  for (const k of Object.keys(SPEC_DOC_FILES) as SpecDocKind[]) {
    const p = path.join(dir, SPEC_DOC_FILES[k]);
    docs[k] = folderWhy ? { path: p, exists: fs.existsSync(p), nonEmpty: false, bytes: 0, mtimeMs: 0, refused: folderWhy } : docInfo(p);
  }
  const specType: SpecType = config?.specType ?? (docs.bugfix.nonEmpty ? 'bugfix' : 'feature');
  const workflowType: WorkflowType = config?.workflowType ?? 'requirements-first';
  const order = docOrder(specType, workflowType);
  const s: SpecSummary = { name: path.basename(dir), dir, config, specType, workflowType, docs, order, phase: order[0]! };
  if (docs.tasks.nonEmpty) {
    const text = readDoc(docs.tasks);
    if (text !== undefined) s.progress = taskProgress(parseTasks(text));
  }
  const idx = order.findIndex((d) => !present(docs[d]));
  if (idx >= 0) {
    s.phase = order[idx]!;
    if (idx > 0) s.awaitingApproval = order[idx - 1]!;
  } else if (docs.tasks.refused) {
    // tasks.md exists but is not read: it is the document under review, never drafted over
    s.phase = 'tasks';
    s.awaitingApproval = 'tasks';
  } else if (!s.progress || s.progress.total === 0) {
    s.phase = 'tasks';
    s.awaitingApproval = order[1]!;
  } else {
    s.phase = s.progress.requiredDone < s.progress.requiredTotal ? 'execution' : 'done';
  }
  const docWhy = [...order, ...(Object.keys(SPEC_DOC_FILES) as SpecDocKind[])].map((k) => docs[k].refused).find((r) => r !== undefined);
  const refused = folderWhy ?? configWhy ?? docWhy;
  if (refused) s.refused = refused;
  return s;
}

/** Summary of spec `name`, undefined when the folder does not exist. */
export function summarizeSpec(ws: Pick<WorkspaceContext, 'workspaceRoot'>, name: string): SpecSummary | undefined {
  const dir = resolveSpecDir(ws, name);
  return dir ? summarizeSpecDir(dir) : undefined;
}

/**
 * Every spec folder under `.kiro/specs` (hidden folders skipped), sorted by name; also a folder
 * link that cannot be followed (listed with its {@link SpecSummary.refused} reason). Nothing when
 * `.kiro/specs` itself is refused ({@link specsDirRefused}): its entries are not read.
 */
export function listSpecs(ws: Pick<WorkspaceContext, 'workspaceRoot'>): SpecSummary[] {
  const root = specsDir(ws);
  if (specsDirRefused(ws)) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => !e.name.startsWith('.') && (e.isDirectory() || (e.isSymbolicLink() && isSpecFolderEntry(path.join(root, e.name)))))
    .map((e) => summarizeSpecDir(path.join(root, e.name)))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// ───────────────────────────── loaded spec ─────────────────────────────

export interface LoadedSpec extends SpecSummary {
  texts: Partial<Record<SpecDocKind, string>>;
  requirements?: ParsedRequirements;
  bugfix?: ParsedBugfix;
  design?: ParsedDesign;
  tasks?: ParsedTasks;
  /** Criterion ids of the phase-1 requirements document (requirements or bugfix). */
  criteriaIds: string[];
  lint: LintIssue[];
}

/** Read and parse every document of a spec folder (refused documents are left out: `docs[k].refused`). */
export function loadSpecDir(dir: string): LoadedSpec {
  const s = summarizeSpecDir(dir);
  const out: LoadedSpec = { ...s, texts: {}, criteriaIds: [], lint: [] };
  for (const k of Object.keys(SPEC_DOC_FILES) as SpecDocKind[]) {
    if (!s.docs[k].exists) continue;
    const t = readDoc(s.docs[k]);
    if (t !== undefined) out.texts[k] = t;
    else if (s.docs[k].refused) out.refused ??= s.docs[k].refused;
  }
  if (out.texts.requirements !== undefined && s.docs.requirements.nonEmpty) out.requirements = parseRequirements(out.texts.requirements);
  if (out.texts.bugfix !== undefined && s.docs.bugfix.nonEmpty) out.bugfix = parseBugfix(out.texts.bugfix);
  if (out.texts.design !== undefined) out.design = parseDesign(out.texts.design);
  if (out.texts.tasks !== undefined) out.tasks = parseTasks(out.texts.tasks);
  out.criteriaIds = s.specType === 'bugfix' ? out.bugfix?.criteriaIds ?? [] : out.requirements?.criteriaIds ?? [];
  const lintIn: Parameters<typeof lintSpec>[0] = { criteriaIds: out.criteriaIds };
  if (out.tasks) lintIn.tasks = out.tasks;
  if (out.design) lintIn.design = out.design;
  out.lint = lintSpec(lintIn);
  return out;
}

export function loadSpec(ws: Pick<WorkspaceContext, 'workspaceRoot'>, name: string): LoadedSpec | undefined {
  const dir = resolveSpecDir(ws, name);
  return dir ? loadSpecDir(dir) : undefined;
}

/** Absolute path of a spec document. */
export function specDocPath(dir: string, kind: SpecDocKind): string {
  return path.join(dir, SPEC_DOC_FILES[kind]);
}

// ───────────────────────────── context block ─────────────────────────────

function xmlAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * `<spec name=… path=…>` block with the requirements (or bugfix), design and tasks documents, each
 * as `[abs path]\ncontent`, `#[[file:…]]` references expanded (03 §1.10.8, §4 `#spec:`). A refused
 * document (`docs[k].refused`, also one found refused only now) is never read into it; one found
 * refused only now (it became a link, or unreadable, after `spec` was taken) has its reason
 * pushed to `refused`, so the caller never uses a block that silently lacks it.
 */
export function specContextBlock(ws: WorkspaceContext, spec: Pick<SpecSummary, 'name' | 'dir' | 'docs' | 'specType'>, refused: string[] = []): string | undefined {
  const kinds: SpecDocKind[] = spec.specType === 'bugfix' ? ['bugfix', 'design', 'tasks'] : ['requirements', 'bugfix', 'design', 'tasks'];
  const parts: string[] = [];
  for (const k of kinds) {
    const d = spec.docs[k];
    if (!d.exists || !d.nonEmpty || d.refused) continue;
    const now = { ...d };
    const raw = readDoc(now);
    if (now.refused) refused.push(now.refused);
    if (raw === undefined) continue;
    let body = raw.replace(/\r\n?/g, '\n');
    try {
      body = expandFileRefs(body, ws.workspaceRoot, ws);
    } catch {
      // keep unexpanded
    }
    parts.push(`[${d.path}]\n${body.replace(/\n+$/, '')}`);
  }
  if (parts.length === 0) return undefined;
  return `<spec name="${xmlAttr(spec.name)}" path="${xmlAttr(spec.dir)}">\n${parts.join('\n\n')}\n</spec>`;
}

// ───────────────────────────── formatting ─────────────────────────────

/**
 * Phase column: `new`, `<doc> ✓` (document written, next pending), `tasks ✓`, `done`; `refused`
 * when kiro-claude does not read some of the spec's files ({@link formatSpecRefusals} says why).
 */
export function phaseLabel(s: Pick<SpecSummary, 'phase' | 'awaitingApproval' | 'order'> & { refused?: string | undefined }): string {
  if (s.refused) return 'refused';
  if (s.phase === 'done') return 'done';
  if (s.phase === 'execution') return 'tasks ✓';
  if (s.awaitingApproval) return `${s.awaitingApproval} ✓`;
  return 'new';
}

/** `done/total` over leaf tasks, `-` without tasks. */
export function progressLabel(p: TaskProgress | undefined): string {
  return p && p.total > 0 ? `${p.done}/${p.total}` : '-';
}

/** One row per spec: `name  type  phase  done/total` (03 §1.11.1). */
export function formatSpecList(specs: readonly SpecSummary[]): string {
  if (specs.length === 0) return '';
  const rows = specs.map((s) => [s.name, s.specType, phaseLabel(s), progressLabel(s.progress)]);
  const widths = [0, 1, 2].map((i) => Math.max(...rows.map((r) => [...r[i]!].length)));
  return rows
    .map((r) => r.map((c, i) => (i < 3 ? c + ' '.repeat(widths[i]! - [...c].length) : c)).join('  '))
    .join('\n');
}

/**
 * One `⚠ <name>: <why>: <rule>` line per spec of `specs` that has a refusal (empty when none):
 * printed after {@link formatSpecList} (a warning, never a row of the table).
 */
export function formatSpecRefusals(specs: readonly Pick<SpecSummary, 'name' | 'refused'>[]): string[] {
  return specs.filter((s) => s.refused).map((s) => `⚠ ${s.name}: ${specRefusalText(s.refused!)}`);
}

/** Short description of a phase document's content ("8 requirements, 41 criteria"). */
export function docSummary(spec: LoadedSpec, kind: SpecDocKind): string {
  const n = (k: number, w: string): string => `${k} ${w}${k === 1 ? '' : 's'}`;
  switch (kind) {
    case 'requirements': {
      const r = spec.requirements;
      if (!r) return 'empty';
      return `${n(r.requirements.length, 'requirement')}, ${r.criteriaIds.length === 1 ? '1 criterion' : `${r.criteriaIds.length} criteria`}`;
    }
    case 'bugfix': {
      const b = spec.bugfix;
      if (!b) return 'empty';
      return `${n(b.current.length, 'defect')}, ${b.expected.length} expected, ${b.unchanged.length} unchanged`;
    }
    case 'design': {
      const d = spec.design;
      if (!d) return 'empty';
      return `${n(d.sections.length, 'section')}, ${n(d.properties.length, 'property').replace(/propertys$/, 'properties')}`;
    }
    case 'tasks': {
      const t = spec.tasks;
      if (!t) return 'empty';
      const p = taskProgress(t);
      return `${p.done}/${p.total} tasks done (required ${p.requiredDone}/${p.requiredTotal})`;
    }
  }
}

/** Detailed status for `/spec status <name>` / `kiro-claude spec status <name>`. */
export function formatSpecStatus(spec: LoadedSpec, opts: { showTasks?: boolean } = {}): string {
  const lines: string[] = [];
  lines.push(`Spec: ${spec.name} (${spec.specType}, ${spec.workflowType})`);
  lines.push(`Folder: ${spec.dir}`);
  for (const k of spec.order) {
    const d = spec.docs[k];
    const file = SPEC_DOC_FILES[k];
    lines.push(`  ${file.padEnd(16)}${d.refused ? '⚠  not read (below)' : d.nonEmpty ? `✓  ${docSummary(spec, k)}` : '—  not written yet'}`);
  }
  const phase =
    spec.phase === 'execution'
      ? 'execution'
      : spec.phase === 'done'
        ? 'done'
        : spec.awaitingApproval
          ? spec.awaitingApproval === spec.phase
            ? `${SPEC_DOC_FILES[spec.phase]} awaiting approval`
            : `${SPEC_DOC_FILES[spec.awaitingApproval]} awaiting approval (next: ${SPEC_DOC_FILES[spec.phase]})`
          : `drafting ${SPEC_DOC_FILES[spec.phase]}`;
  // the phase document is refused and not known to exist (a folder that cannot be followed or
  // entered): where the spec stands is not known
  const unknown = spec.phase !== 'execution' && spec.phase !== 'done' && spec.docs[spec.phase].refused !== undefined && !spec.docs[spec.phase].exists;
  lines.push(`Phase: ${unknown ? 'unknown (not read)' : phase}`);
  if (spec.tasks) {
    const next = planTasks(planRun(spec.tasks, { kind: 'next' }))[0];
    if (next) lines.push(`Next task: ${next.synthesized ? '' : `${next.id} `}${next.title}`);
    if (opts.showTasks !== false && spec.tasks.tasks.length) {
      lines.push('');
      for (const t of spec.tasks.tasks) lines.push(`  ${formatTaskLine(t, spec.tasks.byId)}`);
    }
  }
  if (spec.lint.length) {
    lines.push('');
    for (const i of spec.lint) lines.push(`⚠ ${i.message}`);
  }
  const why = specRefusals(spec);
  if (why.length) {
    lines.push('');
    for (const w of why) lines.push(`⚠ ${specRefusalText(w)}`);
  }
  return lines.join('\n');
}

/** JSON-friendly summary (`--format json`). */
export function specSummaryJson(s: SpecSummary): Record<string, unknown> {
  return {
    name: s.name,
    dir: s.dir,
    specType: s.specType,
    workflowType: s.workflowType,
    specId: s.config?.specId || null,
    phase: s.phase,
    awaitingApproval: s.awaitingApproval ?? null,
    documents: Object.fromEntries(s.order.map((k) => [k, s.docs[k].nonEmpty])),
    progress: s.progress ?? null,
    refused: s.refused ?? null,
  };
}

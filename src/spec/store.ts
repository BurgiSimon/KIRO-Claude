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
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WorkspaceContext } from '../types.js';
import { expandFileRefs } from '../config/steering.js';
import { writeFileAtomic } from '../util/fsx.js';
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
}

export const SPEC_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const CONFIG_FILE = '.config.kiro';

/** `<workspaceRoot>/.kiro/specs`. */
export function specsDir(ws: Pick<WorkspaceContext, 'workspaceRoot'>): string {
  return path.join(ws.workspaceRoot, '.kiro', 'specs');
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

/** Existing spec folder for `name` (exact, then case-insensitive); never escapes the specs dir. */
export function resolveSpecDir(ws: Pick<WorkspaceContext, 'workspaceRoot'>, name: string): string | undefined {
  const n = name.trim().replace(/[\\/]+$/, '');
  if (n === '' || n === '.' || n === '..' || /[\\/]/.test(n)) return undefined;
  const root = specsDir(ws);
  const direct = path.join(root, n);
  try {
    if (fs.statSync(direct).isDirectory()) return direct;
  } catch {
    // fall through
  }
  try {
    const hit = fs.readdirSync(root, { withFileTypes: true }).find((e) => e.isDirectory() && e.name.toLowerCase() === n.toLowerCase());
    return hit ? path.join(root, hit.name) : undefined;
  } catch {
    return undefined;
  }
}

// ───────────────────────────── .config.kiro (03 §1.3) ─────────────────────────────

/** Read `.config.kiro`; null when missing or unusable. Legacy `generationMode` ⇒ workflowType. */
export function readSpecConfig(dir: string): SpecConfig | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dir, CONFIG_FILE), 'utf8').replace(/^﻿/, ''));
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

export function writeSpecConfig(dir: string, cfg: SpecConfig): void {
  writeFileAtomic(path.join(dir, CONFIG_FILE), formatSpecConfig(cfg));
}

/**
 * Create `.kiro/specs/<name>/` with its `.config.kiro` (the adapter creates the folder itself, no
 * permission prompt — 03 §1.2). Throws when the name is invalid or the folder already exists.
 */
export function createSpecFolder(
  ws: Pick<WorkspaceContext, 'workspaceRoot'>,
  name: string,
  opts: { specType: SpecType; workflowType: WorkflowType; specId?: string },
): string {
  if (!isValidSpecName(name)) throw new Error(`invalid spec name '${name}' (use kebab-case, e.g. user-authentication)`);
  const dir = path.join(specsDir(ws), name);
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

function docInfo(p: string): SpecDocInfo {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return { path: p, exists: false, nonEmpty: false, bytes: 0, mtimeMs: 0 };
    let nonEmpty = st.size > 0;
    if (nonEmpty && st.size < 4096) nonEmpty = fs.readFileSync(p, 'utf8').trim() !== '';
    return { path: p, exists: true, nonEmpty, bytes: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return { path: p, exists: false, nonEmpty: false, bytes: 0, mtimeMs: 0 };
  }
}

function hasText(p: string): boolean {
  return docInfo(p).nonEmpty;
}

function readText(p: string): string | undefined {
  try {
    return fs.readFileSync(p, 'utf8').replace(/^﻿/, '');
  } catch {
    return undefined;
  }
}

/** Summary of one spec folder (never throws). */
export function summarizeSpecDir(dir: string): SpecSummary {
  const config = readSpecConfig(dir);
  const docs = {} as Record<SpecDocKind, SpecDocInfo>;
  for (const k of Object.keys(SPEC_DOC_FILES) as SpecDocKind[]) docs[k] = docInfo(path.join(dir, SPEC_DOC_FILES[k]));
  const specType: SpecType = config?.specType ?? (docs.bugfix.nonEmpty ? 'bugfix' : 'feature');
  const workflowType: WorkflowType = config?.workflowType ?? 'requirements-first';
  const order = docOrder(specType, workflowType);
  const s: SpecSummary = { name: path.basename(dir), dir, config, specType, workflowType, docs, order, phase: order[0]! };
  if (docs.tasks.nonEmpty) {
    const text = readText(docs.tasks.path);
    if (text !== undefined) s.progress = taskProgress(parseTasks(text));
  }
  const idx = order.findIndex((d) => !docs[d].nonEmpty);
  if (idx >= 0) {
    s.phase = order[idx]!;
    if (idx > 0) s.awaitingApproval = order[idx - 1]!;
  } else if (!s.progress || s.progress.total === 0) {
    s.phase = 'tasks';
    s.awaitingApproval = order[1]!;
  } else {
    s.phase = s.progress.requiredDone < s.progress.requiredTotal ? 'execution' : 'done';
  }
  return s;
}

/** Summary of spec `name`, undefined when the folder does not exist. */
export function summarizeSpec(ws: Pick<WorkspaceContext, 'workspaceRoot'>, name: string): SpecSummary | undefined {
  const dir = resolveSpecDir(ws, name);
  return dir ? summarizeSpecDir(dir) : undefined;
}

/** Every spec folder under `.kiro/specs` (hidden folders skipped), sorted by name. */
export function listSpecs(ws: Pick<WorkspaceContext, 'workspaceRoot'>): SpecSummary[] {
  const root = specsDir(ws);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => !e.name.startsWith('.') && (e.isDirectory() || (e.isSymbolicLink() && isDir(path.join(root, e.name)))))
    .map((e) => summarizeSpecDir(path.join(root, e.name)))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
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

/** Read and parse every document of a spec folder. */
export function loadSpecDir(dir: string): LoadedSpec {
  const s = summarizeSpecDir(dir);
  const out: LoadedSpec = { ...s, texts: {}, criteriaIds: [], lint: [] };
  for (const k of Object.keys(SPEC_DOC_FILES) as SpecDocKind[]) {
    if (!s.docs[k].exists) continue;
    const t = readText(s.docs[k].path);
    if (t !== undefined) out.texts[k] = t;
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
 * as `[abs path]\ncontent`, `#[[file:…]]` references expanded (03 §1.10.8, §4 `#spec:`).
 */
export function specContextBlock(ws: WorkspaceContext, spec: Pick<SpecSummary, 'name' | 'dir' | 'docs' | 'specType'>): string | undefined {
  const kinds: SpecDocKind[] = spec.specType === 'bugfix' ? ['bugfix', 'design', 'tasks'] : ['requirements', 'bugfix', 'design', 'tasks'];
  const parts: string[] = [];
  for (const k of kinds) {
    const d = spec.docs[k];
    if (!d.exists || !d.nonEmpty) continue;
    const raw = readText(d.path);
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

/** Phase column: `new`, `<doc> ✓` (document written, next pending), `tasks ✓`, `done`. */
export function phaseLabel(s: Pick<SpecSummary, 'phase' | 'awaitingApproval' | 'order'>): string {
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
    lines.push(`  ${file.padEnd(16)}${d.nonEmpty ? `✓  ${docSummary(spec, k)}` : '—  not written yet'}`);
  }
  const phase =
    spec.phase === 'execution'
      ? 'execution'
      : spec.phase === 'done'
        ? 'done'
        : spec.awaitingApproval
          ? `${SPEC_DOC_FILES[spec.awaitingApproval]} awaiting approval (next: ${SPEC_DOC_FILES[spec.phase]})`
          : `drafting ${SPEC_DOC_FILES[spec.phase]}`;
  lines.push(`Phase: ${phase}`);
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
  };
}

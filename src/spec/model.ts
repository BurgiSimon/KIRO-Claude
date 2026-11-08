/**
 * Kiro spec documents: parsing, status write-back, normalizer, coverage lint and run planning.
 *
 * References (research 03):
 *  - §1.5 document formats (2026 format generated, 2025 format parsed too): requirements.md
 *    (§1.5.1, EARS), bugfix.md (§1.5.2, `N.M` items), design.md (§1.5.3/§1.5.4, Correctness
 *    Properties), tasks.md (§1.5.5: `- [ ] N. Title`, sub-tasks `N.M`, optional `]*`, boxes
 *    `[ ]` `[x]` `[-]` and `[~]` (queued, UNVERIFIED — accepted, 03 §7.1), `_Requirements:_`,
 *    `**Property K:**`, `**Validates: Requirements …**`, checkpoints, `## Task Dependency Graph`).
 *  - §1.6.1 model, §1.6.2 regexes (scanning skips fenced code blocks), §1.6.3 tolerant graph
 *    parsing (`{id|wave,tasks}` objects or arrays of arrays; unknown ids dropped; omitted
 *    incomplete leaves appended; derived sequential graph otherwise; checkpoints are barriers),
 *    §1.6.4 status write-back (only the box character changes; parent `[x]` roll-up),
 *    §1.6.5 requirement coverage lint, §1.6.6 normalizer.
 *  - §1.7.2 run scope: "All remaining required tasks" (default) / include optional / selection.
 *
 * Everything here is pure text processing except {@link writeTaskStatus} (re-read + atomic
 * write, through spec/docfs.ts: never through a symbolic link at tasks.md or out of the
 * workspace, review X1). Unknown text is preserved byte for byte: edits replace single box
 * characters.
 */

import { createHash } from 'node:crypto';
import { readSpecFile, writeSpecFile } from './docfs.js';

// ───────────────────────────── types (03 §1.6.1) ─────────────────────────────

export type SpecType = 'feature' | 'bugfix';
export type WorkflowType = 'requirements-first' | 'design-first';
export type SpecDocKind = 'requirements' | 'bugfix' | 'design' | 'tasks';
/** Normalized box character: 'X' ⇒ 'x', '' ⇒ ' '. */
export type TaskBox = ' ' | 'x' | '-' | '~';
export type TaskStatus = 'not_started' | 'queued' | 'in_progress' | 'completed';

/** File name of each spec document (03 §1.2). */
export const SPEC_DOC_FILES: Readonly<Record<SpecDocKind, string>> = Object.freeze({
  requirements: 'requirements.md',
  bugfix: 'bugfix.md',
  design: 'design.md',
  tasks: 'tasks.md',
});

export interface SpecTask {
  /** "1", "2.1" (synthesized "#<n>" when the line has no number). */
  id: string;
  /** "2" for "2.1"; for unnumbered tasks the nearest less-indented preceding task. */
  parentId: string | null;
  /** Direct children ids in document order. */
  children: string[];
  /** Text after the number. */
  title: string;
  box: TaskBox;
  status: TaskStatus;
  /** Own `*` right after `]`. */
  optional: boolean;
  /** Title matches /^(final\s+)?checkpoint\b/i. */
  isCheckpoint: boolean;
  /** 0-based line index of the checkbox line. */
  line: number;
  /** Indentation width of the checkbox line (tabs count 4). */
  indent: number;
  /** Char offset of the box character within the whole text (of `]` for an empty `[]`). */
  boxOffset: number;
  /** 1, or 0 for an empty `[]` box (write-back inserts). */
  boxLength: 0 | 1;
  /** Detail lines (trimmed, leading "- " / "* " removed). */
  details: string[];
  /** From `_Requirements: …_`. */
  requirementRefs: string[];
  /** From `**Property K: …**`. */
  propertyRefs: number[];
  /** From `**Validates: Requirements …**`. */
  validates: string[];
  /** sha256 of raw title + details (stale-edit protection). */
  textHash: string;
  /** Id was synthesized ("#n"). */
  synthesized: boolean;
}

export interface TaskGraph {
  /** Leaf task ids per wave (checkpoints excluded). */
  waves: string[][];
  source: 'file' | 'derived';
}

export interface ParsedTasks {
  /** `# Implementation Plan: <Title>` title (or the whole H1 text). */
  title?: string;
  /** Document order. */
  tasks: SpecTask[];
  byId: Map<string, SpecTask>;
  graph: TaskGraph;
  /** Why the file's graph was ignored (invalid JSON / shape). */
  graphError?: string;
  eol: '\n' | '\r\n';
}

// ───────────────────────────── regexes (03 §1.6.2) ─────────────────────────────

/** Checkbox task line; tolerant of '*', '+' bullets, ordered markers, '[]', 'X', '-', '~'. */
export const TASK_RE =
  /^(?<indent>[ \t]*)(?:[-*+]|(?<ord>\d+)[.)])[ \t]+\[(?<box>[ xX~-]?)\](?<opt>\*)?[ \t]*(?:(?<id>\d+(?:\.\d+)*)\.?(?=[ \t]|$))?[ \t]*(?<title>.*?)[ \t]*$/;
export const REQ_REFS_RE = /^[ \t]*[-*][ \t]+_Requirements?:[ \t]*(?<refs>.+?)_[ \t]*$/;
export const PROPERTY_RE = /\*\*Property[ \t]+(?<k>\d+):[ \t]*(?<name>[^*]+?)\*\*/;
export const VALIDATES_RE = /\*\*Validates:[ \t]*Requirements?[ \t]+(?<refs>[^*]+?)\*\*/;
/** Variant seen in the wild: `(Validates R1.6, R3.5.)` (03 §1.5.5 "Requirement refs"). */
export const VALIDATES_PAREN_RE = /\(Validates:?[ \t]+(?<refs>R?\d[^)]*)\)/i;
export const CHECKPOINT_RE = /^(?:final[ \t]+)?checkpoint\b/i;
export const GRAPH_RE = /^##[ \t]+Task Dependency Graph[ \t]*$/;
export const REQ_HEAD_RE = /^###[ \t]+Requirement[ \t]+(?<n>\d+)(?:[ \t]*:[ \t]*(?<title>.+?))?[ \t]*$/;
export const AC_HEAD_RE = /^####[ \t]+Acceptance Criteria[ \t]*$/i;
export const AC_ITEM_RE = /^[ \t]*(?<k>\d+)\.[ \t]+(?<text>.+)$/;
export const GLOSSARY_RE = /^[ \t]*-[ \t]+\*\*(?<term>[^*]+)\*\*:[ \t]*(?<def>.+)$/;
export const BUG_ITEM_RE = /^[ \t]*(?:[-*][ \t]+)?(?<id>[123]\.\d+)[ \t]+(?<text>\S.*)$/;
export const PROP_HEAD_RE = /^###[ \t]+Property[ \t]+(?<k>\d+):[ \t]*(?<name>.+?)[ \t]*$/;

const FENCE_RE = /^[ \t]*(?<fence>`{3,}|~{3,})(?<info>.*)$/;
const HEADING_RE = /^#{1,6}[ \t]/;

// ───────────────────────────── line helpers ─────────────────────────────

interface Line {
  /** Text without the trailing "\r". */
  text: string;
  /** Offset of the first char in the whole text. */
  start: number;
  /** Inside a fenced code block (fence lines themselves count as inside). */
  fenced: boolean;
}

/** Split into lines with offsets and fence state (03 §1.6.2: scan outside fences). */
export function scanLines(text: string): Line[] {
  const out: Line[] = [];
  let pos = 0;
  let open: { ch: string; len: number } | undefined;
  const raw = text.split('\n');
  for (let i = 0; i < raw.length; i++) {
    let t = raw[i]!;
    const start = pos;
    pos += t.length + 1;
    if (t.endsWith('\r')) t = t.slice(0, -1);
    const m = FENCE_RE.exec(t);
    if (open) {
      out.push({ text: t, start, fenced: true });
      if (m && m.groups!.fence![0] === open.ch && m.groups!.fence!.length >= open.len && m.groups!.info!.trim() === '') open = undefined;
      continue;
    }
    if (m && !(m.groups!.fence![0] === '`' && m.groups!.info!.includes('`'))) {
      open = { ch: m.groups!.fence![0]!, len: m.groups!.fence!.length };
      out.push({ text: t, start, fenced: true });
      continue;
    }
    out.push({ text: t, start, fenced: false });
  }
  return out;
}

function indentWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    if (ch === ' ') w += 1;
    else if (ch === '\t') w += 4;
    else break;
  }
  return w;
}

function detectEol(text: string): '\n' | '\r\n' {
  const i = text.indexOf('\n');
  return i > 0 && text[i - 1] === '\r' ? '\r\n' : '\n';
}

function h1Title(lines: readonly Line[], prefixRe?: RegExp): string | undefined {
  for (const l of lines) {
    if (l.fenced) continue;
    const m = /^#[ \t]+(.+?)[ \t]*$/.exec(l.text);
    if (!m) continue;
    const t = m[1]!;
    if (prefixRe) {
      const p = prefixRe.exec(t);
      if (p) return t.slice(p[0].length).trim() || undefined;
    }
    return t;
  }
  return undefined;
}

/** Split a ref list (`1.1, 2.3`, `R1.6 R3.5.`) into ids. */
export function parseRefList(s: string): string[] {
  const out: string[] = [];
  for (const raw of s.split(/[,\s;]+/)) {
    const m = /^R?(\d+(?:\.\d+)*)\.?$/i.exec(raw.trim().replace(/^[([]+|[)\]]+$/g, ''));
    if (m && !out.includes(m[1]!)) out.push(m[1]!);
  }
  return out;
}

/** Numeric comparison of dotted ids ("2.10" > "2.9"); synthesized "#n" ids sort after numbers. */
export function compareTaskIds(a: string, b: string): number {
  const pa = a.replace(/^#/, '').split('.').map(Number);
  const pb = b.replace(/^#/, '').split('.').map(Number);
  const sa = a.startsWith('#') ? 1 : 0;
  const sb = b.startsWith('#') ? 1 : 0;
  if (sa !== sb) return sa - sb;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? -1;
    const y = pb[i] ?? -1;
    if (x !== y) return x - y;
  }
  return 0;
}

export function boxToStatus(box: TaskBox): TaskStatus {
  switch (box) {
    case 'x':
      return 'completed';
    case '-':
      return 'in_progress';
    case '~':
      return 'queued';
    default:
      return 'not_started';
  }
}

function normBox(raw: string): TaskBox {
  if (raw === 'x' || raw === 'X') return 'x';
  if (raw === '-') return '-';
  if (raw === '~') return '~';
  return ' ';
}

function hashText(title: string, details: readonly string[]): string {
  return createHash('sha256').update(`${title}\n${details.join('\n')}`).digest('hex');
}

// ───────────────────────────── tasks.md ─────────────────────────────

/** Parse tasks.md (03 §1.5.5, §1.6). Never throws. */
export function parseTasks(text: string): ParsedTasks {
  const lines = scanLines(text);
  const tasks: SpecTask[] = [];
  const byId = new Map<string, SpecTask>();
  let synth = 0;
  // stack of (indent, task) for indentation-based parents of unnumbered tasks
  const stack: { indent: number; task: SpecTask }[] = [];
  let cur: SpecTask | undefined;
  let curFence = false;

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (!l.fenced) {
      const m = TASK_RE.exec(l.text);
      if (m) {
        const g = m.groups!;
        const indent = indentWidth(g.indent!);
        while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();
        // `1. [ ] Title` (ordered-list marker carries the number, observed in w7 as `-` + an
        // indented `  1. [ ] …`) — only when no enclosing task contains the item: a nested ordered
        // checklist (`  1. [ ] step` under task 2) must not take a task number (it would steal the
        // id of the real task 1 further down).
        let id = g.id ?? (g.ord && indent <= 3 && stack.length === 0 ? g.ord : undefined);
        let synthesized = false;
        if (!id || byId.has(id)) {
          id = `#${++synth}`;
          synthesized = true;
        }
        const rawBox = g.box ?? '';
        const box = normBox(rawBox);
        const bracket = l.text.indexOf('[', g.indent!.length);
        const task: SpecTask = {
          id,
          parentId: null,
          children: [],
          title: g.title ?? '',
          box,
          status: boxToStatus(box),
          optional: g.opt === '*',
          isCheckpoint: CHECKPOINT_RE.test(g.title ?? ''),
          line: i,
          indent,
          boxOffset: l.start + bracket + 1,
          boxLength: rawBox === '' ? 0 : 1,
          details: [],
          requirementRefs: [],
          propertyRefs: [],
          validates: [],
          textHash: '',
          synthesized,
        };
        // Parent: numbering first (2025 flat format has unindented sub-tasks), else indentation.
        let parent: SpecTask | undefined;
        const top = stack.length ? stack[stack.length - 1]!.task : undefined;
        if (synthesized) parent = top;
        else if (id.includes('.')) parent = byId.get(id.slice(0, id.lastIndexOf('.'))) ?? (top?.synthesized ? top : undefined);
        else parent = top?.synthesized ? top : undefined; // "3" never nests under "2"
        if (parent) {
          task.parentId = parent.id;
          parent.children.push(id);
        }
        stack.push({ indent, task });
        tasks.push(task);
        byId.set(id, task);
        cur = task;
        curFence = false;
        continue;
      }
      if (HEADING_RE.test(l.text)) {
        cur = undefined;
        stack.length = 0;
        continue;
      }
    }
    if (!cur) continue;
    const t = l.text;
    if (t.trim() === '') continue;
    if (l.fenced) {
      // fenced block inside the task's details (indented under it) or a top-level block (ends details)
      if (!curFence && indentWidth(t) <= cur.indent) {
        cur = undefined;
        continue;
      }
      curFence = true;
      cur.details.push(t.trim());
      continue;
    }
    curFence = false;
    if (indentWidth(t) <= cur.indent) {
      cur = undefined;
      continue;
    }
    const detail = t.trim().replace(/^[-*+][ \t]+/, '');
    cur.details.push(detail);
    const rr = REQ_REFS_RE.exec(t) ?? VALIDATES_PAREN_RE.exec(t);
    if (rr) for (const r of parseRefList(rr.groups!.refs!)) if (!cur.requirementRefs.includes(r)) cur.requirementRefs.push(r);
    const pr = PROPERTY_RE.exec(t);
    if (pr) {
      const k = Number(pr.groups!.k);
      if (!cur.propertyRefs.includes(k)) cur.propertyRefs.push(k);
    }
    const vr = VALIDATES_RE.exec(t);
    if (vr) for (const r of parseRefList(vr.groups!.refs!)) if (!cur.validates.includes(r)) cur.validates.push(r);
  }
  for (const t of tasks) {
    const pr = PROPERTY_RE.exec(t.title);
    if (pr && !t.propertyRefs.includes(Number(pr.groups!.k))) t.propertyRefs.push(Number(pr.groups!.k));
    t.textHash = hashText(t.title, t.details);
  }
  const parsed: ParsedTasks = {
    tasks,
    byId,
    graph: { waves: [], source: 'derived' },
    eol: detectEol(text),
  };
  const title = h1Title(lines, /^Implementation Plan[ \t]*:?[ \t]*/i);
  if (title !== undefined) parsed.title = title;
  const g = readGraph(lines);
  if (g.error) parsed.graphError = g.error;
  parsed.graph = normalizeGraph(g.raw, parsed);
  return parsed;
}

/** Tasks without children (the unit of execution). */
export function leafTasks(parsed: Pick<ParsedTasks, 'tasks'>): SpecTask[] {
  return parsed.tasks.filter((t) => t.children.length === 0);
}

/** True when the task or one of its ancestors carries `*`. */
export function isOptionalTask(t: SpecTask, byId: ReadonlyMap<string, SpecTask>): boolean {
  let cur: SpecTask | undefined = t;
  for (let guard = 0; cur && guard < 64; guard++) {
    if (cur.optional) return true;
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return false;
}

export interface TaskProgress {
  total: number;
  done: number;
  requiredTotal: number;
  requiredDone: number;
}

/** Progress over leaf tasks (03 §1.6.1 SpecSummary.progress). */
export function taskProgress(parsed: Pick<ParsedTasks, 'tasks' | 'byId'>): TaskProgress {
  const p: TaskProgress = { total: 0, done: 0, requiredTotal: 0, requiredDone: 0 };
  for (const t of leafTasks(parsed)) {
    const done = t.box === 'x';
    p.total++;
    if (done) p.done++;
    if (!isOptionalTask(t, parsed.byId)) {
      p.requiredTotal++;
      if (done) p.requiredDone++;
    }
  }
  return p;
}

/** Incomplete leaves of `t` (itself when it is a leaf), document order. */
export function incompleteLeavesOf(t: SpecTask, byId: ReadonlyMap<string, SpecTask>): SpecTask[] {
  if (t.children.length === 0) return t.box === 'x' ? [] : [t];
  const out: SpecTask[] = [];
  for (const c of t.children) {
    const ct = byId.get(c);
    if (ct) out.push(...incompleteLeavesOf(ct, byId));
  }
  return out;
}

// ───────────────────────────── dependency graph (03 §1.6.3) ─────────────────────────────

function readGraph(lines: readonly Line[]): { raw?: unknown; error?: string } {
  const head = lines.findIndex((l) => !l.fenced && GRAPH_RE.test(l.text));
  if (head < 0) return {};
  let jsonError: string | undefined;
  for (let i = head + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (!l.fenced && /^##?[ \t]/.test(l.text)) break; // next section
    const m = FENCE_RE.exec(l.text);
    if (!m) continue; // whole blocks are skipped below, so every fence seen here opens one
    const info = m.groups!.info!.trim().toLowerCase();
    const fence = m.groups!.fence!;
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const t = lines[j]!.text;
      const c = FENCE_RE.exec(t);
      if (c && c.groups!.fence![0] === fence[0] && c.groups!.fence!.length >= fence.length && c.groups!.info!.trim() === '') break;
      body.push(t);
    }
    if (info === '' || info === 'json' || info === 'jsonc') {
      try {
        return { raw: JSON.parse(body.join('\n')) };
      } catch (e) {
        // an untagged fence may be prose/diagram text: keep looking; a json fence is an error
        if (info !== '') jsonError = `invalid JSON in the Task Dependency Graph (${e instanceof Error ? e.message : String(e)})`;
      }
    }
    i = j; // skip the block
  }
  return jsonError ? { error: jsonError } : {};
}

/**
 * Normalize a raw graph (03 §1.6.3) against the parsed tasks: waves of existing, non-checkpoint
 * leaf ids (a parent id expands to its leaves); every leaf the graph omits is appended as a final
 * wave; no / invalid graph ⇒ derived sequential waves in document order.
 */
export function normalizeGraph(raw: unknown, parsed: Pick<ParsedTasks, 'tasks' | 'byId'>): TaskGraph {
  const leaves = leafTasks(parsed).filter((t) => !t.isCheckpoint);
  const rawWaves = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { waves?: unknown }).waves : undefined;
  if (!Array.isArray(rawWaves)) return { waves: leaves.map((t) => [t.id]), source: 'derived' };
  const items: { key: number; ids: unknown[] }[] = [];
  rawWaves.forEach((w, idx) => {
    if (Array.isArray(w)) items.push({ key: idx, ids: w });
    else if (w && typeof w === 'object') {
      const o = w as { id?: unknown; wave?: unknown; tasks?: unknown };
      const key = typeof o.id === 'number' ? o.id : typeof o.wave === 'number' ? o.wave : idx;
      if (Array.isArray(o.tasks)) items.push({ key, ids: o.tasks });
    }
  });
  items.sort((a, b) => a.key - b.key);
  const seen = new Set<string>();
  const waves: string[][] = [];
  for (const it of items) {
    const wave: string[] = [];
    for (const r of it.ids) {
      const id = typeof r === 'number' ? String(r) : typeof r === 'string' ? r.trim().replace(/\.$/, '') : undefined;
      if (!id) continue;
      const t = parsed.byId.get(id);
      if (!t) continue;
      const expanded = t.children.length ? leafDescendants(t, parsed.byId) : [t];
      for (const l of expanded) {
        if (l.isCheckpoint || seen.has(l.id)) continue;
        seen.add(l.id);
        wave.push(l.id);
      }
    }
    if (wave.length) waves.push(wave);
  }
  const missing = leaves.filter((t) => !seen.has(t.id)).map((t) => t.id);
  if (missing.length) waves.push(missing);
  return { waves, source: 'file' };
}

function leafDescendants(t: SpecTask, byId: ReadonlyMap<string, SpecTask>): SpecTask[] {
  if (t.children.length === 0) return [t];
  const out: SpecTask[] = [];
  for (const c of t.children) {
    const ct = byId.get(c);
    if (ct) out.push(...leafDescendants(ct, byId));
  }
  return out;
}

// ───────────────────────────── run planning (03 §1.7.2, §1.6.3 step 5) ─────────────────────────────

export type TaskSelection =
  /** All remaining required tasks (default) or all remaining tasks incl. optional. */
  | { kind: 'scope'; includeOptional: boolean }
  /** The next task of the default plan. */
  | { kind: 'next'; includeOptional?: boolean }
  /** Explicit task ids (a parent expands to its incomplete leaves). */
  | { kind: 'ids'; ids: string[]; includeOptional?: boolean };

export type RunStep = { kind: 'wave'; tasks: SpecTask[] } | { kind: 'checkpoint'; task: SpecTask };

export interface RunPlan {
  steps: RunStep[];
  /** Explicit ids that do not exist. */
  unknownIds: string[];
}

/** Every task of a plan in execution order. */
export function planTasks(plan: RunPlan): SpecTask[] {
  return plan.steps.flatMap((s) => (s.kind === 'wave' ? s.tasks : [s.task]));
}

/**
 * Plan a run: selected incomplete leaves grouped by graph wave, with checkpoint tasks as
 * barriers (a checkpoint runs after every selected task above it in the document and before
 * any task below it).
 */
export function planRun(parsed: ParsedTasks, sel: TaskSelection): RunPlan {
  const unknownIds: string[] = [];
  let selected: SpecTask[];
  if (sel.kind === 'ids') {
    const set = new Map<string, SpecTask>();
    for (const raw of sel.ids) {
      const id = raw.trim().replace(/\.$/, '');
      const t = parsed.byId.get(id);
      if (!t) {
        unknownIds.push(raw);
        continue;
      }
      if (t.children.length === 0) {
        set.set(t.id, t); // an explicitly named leaf runs even when optional or already done
        continue;
      }
      for (const l of incompleteLeavesOf(t, parsed.byId)) {
        if (!sel.includeOptional && isOptionalTask(l, parsed.byId) && !isOptionalTask(t, parsed.byId)) continue;
        set.set(l.id, l);
      }
    }
    selected = parsed.tasks.filter((t) => set.has(t.id));
  } else {
    const includeOptional = sel.includeOptional ?? false;
    selected = leafTasks(parsed).filter((t) => t.box !== 'x' && (includeOptional || !isOptionalTask(t, parsed.byId)));
  }
  const waveOf = new Map<string, number>();
  parsed.graph.waves.forEach((w, i) => w.forEach((id) => waveOf.set(id, i)));
  const fallbackWave = parsed.graph.waves.length;
  const checkpoints = selected.filter((t) => t.isCheckpoint).sort((a, b) => a.line - b.line);
  const normal = selected.filter((t) => !t.isCheckpoint);
  const steps: RunStep[] = [];
  let prevLine = -1;
  const segments = [...checkpoints.map((c) => c.line), Number.POSITIVE_INFINITY];
  for (let s = 0; s < segments.length; s++) {
    const upto = segments[s]!;
    const inSeg = normal.filter((t) => t.line > prevLine && t.line < upto);
    const groups = new Map<number, SpecTask[]>();
    for (const t of inSeg) {
      const w = waveOf.get(t.id) ?? fallbackWave + t.line;
      const arr = groups.get(w) ?? [];
      arr.push(t);
      groups.set(w, arr);
    }
    for (const w of [...groups.keys()].sort((a, b) => a - b)) {
      steps.push({ kind: 'wave', tasks: groups.get(w)!.sort((a, b) => a.line - b.line) });
    }
    if (s < checkpoints.length) steps.push({ kind: 'checkpoint', task: checkpoints[s]! });
    prevLine = upto;
  }
  if (sel.kind === 'next') {
    const first = planTasks({ steps, unknownIds })[0];
    return { steps: first ? [first.isCheckpoint ? { kind: 'checkpoint', task: first } : { kind: 'wave', tasks: [first] }] : [], unknownIds };
  }
  return { steps, unknownIds };
}

// ───────────────────────────── status write-back (03 §1.6.4) ─────────────────────────────

export interface BoxChange {
  id: string;
  from: TaskBox;
  to: TaskBox;
}

/**
 * Set task `id` to `box` in `text` by replacing only box characters; when every child of a
 * parent is `[x]` the parent becomes `[x]` too (repeated upward). Returns the new text and the
 * changes (empty when nothing changed). Throws when the id does not exist.
 */
export function applyBoxChange(text: string, id: string, box: TaskBox): { text: string; changes: BoxChange[] } {
  const parsed = parseTasks(text);
  const task = parsed.byId.get(id);
  if (!task) throw new Error(`task ${id} not found in tasks.md`);
  const boxes = new Map<string, TaskBox>(parsed.tasks.map((t) => [t.id, t.box]));
  const changes: BoxChange[] = [];
  const set = (t: SpecTask, b: TaskBox): void => {
    const from = boxes.get(t.id)!;
    if (from === b && t.boxLength === 1) return;
    boxes.set(t.id, b);
    changes.push({ id: t.id, from, to: b });
  };
  set(task, box);
  let parentId = task.parentId;
  while (parentId) {
    const p = parsed.byId.get(parentId);
    if (!p) break;
    if (p.children.length && p.children.every((c) => boxes.get(c) === 'x') && boxes.get(p.id) !== 'x') set(p, 'x');
    parentId = p.parentId;
  }
  // Apply from the end so offsets stay valid.
  const edits = changes
    .map((c) => ({ t: parsed.byId.get(c.id)!, to: c.to }))
    .sort((a, b) => b.t.boxOffset - a.t.boxOffset);
  let out = text;
  for (const e of edits) out = out.slice(0, e.t.boxOffset) + e.to + out.slice(e.t.boxOffset + e.t.boxLength);
  return { text: out, changes };
}

export interface WriteStatusResult {
  changes: BoxChange[];
  /** The task's text changed since `expectHash` was taken (it was still found by id). */
  stale?: boolean;
}

/**
 * Re-read tasks.md, set the box of `id`, write atomically (03 §1.6.4). Throws when the file or
 * the id is gone, and docfs.SpecFileRefusedError when tasks.md is refused (a symbolic link, not a
 * regular file, behind a link that resolves to nothing or cannot be accessed, outside the
 * workspace: its target is
 * neither read nor written).
 */
export function writeTaskStatus(file: string, id: string, box: TaskBox, opts: { expectHash?: string } = {}): WriteStatusResult {
  const text = readSpecFile(file);
  if (text === undefined) throw new Error(`${file} no longer exists`);
  const parsed = parseTasks(text);
  const t = parsed.byId.get(id);
  if (!t) throw new Error(`task ${id} is no longer in ${file}`);
  const { text: next, changes } = applyBoxChange(text, id, box);
  if (next !== text) writeSpecFile(file, next);
  const res: WriteStatusResult = { changes };
  if (opts.expectHash && opts.expectHash !== t.textHash) res.stale = true;
  return res;
}

// ───────────────────────────── normalizer (03 §1.6.6) ─────────────────────────────

/**
 * Repair common tasks.md formatting problems: top-level numbered tasks without a checkbox
 * (when they have checkbox sub-tasks), `* [ ]` / `+ [ ]` bullets, `[]` boxes, `] *` ⇒ `]*`,
 * and a single trailing newline. Fenced blocks are untouched.
 */
export function normalizeTasksText(text: string): { text: string; changedLines: number } {
  if (text === '') return { text, changedLines: 0 };
  const eol = detectEol(text);
  const raw = text.split('\n');
  const lines = scanLines(text);
  let changed = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.fenced) continue;
    const orig = l.text;
    let t = orig;
    // `* [ ]` / `+ [ ]` ⇒ `- [ ]`
    t = t.replace(/^([ \t]*)[*+]([ \t]+\[[ xX~-]?\])/, '$1-$2');
    // `[]` ⇒ `[ ]` on task lines
    t = t.replace(/^([ \t]*(?:-|\d+[.)])[ \t]+)\[\]/, '$1[ ]');
    // `] *` ⇒ `]*` (optional marker separated by a space)
    t = t.replace(/^([ \t]*(?:-|\d+[.)])[ \t]+\[[ xX~-]\])[ \t]+\*(?=[ \t]*\d)/, '$1*');
    // top-level numbered task without a checkbox, followed by checkbox sub-tasks N.M (KI:#4803)
    const bare = /^-[ \t]+(\d+)\.[ \t]+(\S.*)$/.exec(t);
    if (bare) {
      const n = bare[1]!;
      for (let j = i + 1; j < lines.length; j++) {
        const nl = lines[j]!;
        if (nl.fenced || nl.text.trim() === '') continue;
        if (indentWidth(nl.text) === 0) break;
        const m = TASK_RE.exec(nl.text);
        if (m && m.groups!.id?.startsWith(`${n}.`)) {
          t = `- [ ] ${n}. ${bare[2]}`;
          break;
        }
      }
    }
    if (t !== orig) {
      raw[i] = t + (raw[i]!.endsWith('\r') ? '\r' : '');
      changed++;
    }
  }
  const joined = raw.join('\n');
  const trimmed = joined.replace(/(?:\r?\n)+$/, '');
  const final = trimmed + eol;
  if (final !== joined) changed++;
  return { text: final, changedLines: changed };
}

/** "Repaired tasks.md formatting (3 lines)" (03 §1.6.6). */
export function repairMessage(file: string, changedLines: number): string {
  return `Repaired ${file} formatting (${changedLines} ${changedLines === 1 ? 'line' : 'lines'})`;
}

// ───────────────────────────── requirements.md / bugfix.md / design.md ─────────────────────────────

export interface AcceptanceCriterion {
  /** `<requirement>.<position>` */
  id: string;
  text: string;
  line: number;
}

export interface Requirement {
  number: number;
  title?: string;
  userStory?: string;
  criteria: AcceptanceCriterion[];
  line: number;
}

export interface ParsedRequirements {
  title?: string;
  glossary: { term: string; definition: string }[];
  requirements: Requirement[];
  /** Every criterion id in document order. */
  criteriaIds: string[];
}

/** Parse requirements.md (03 §1.5.1; 2025 and 2026 formats). */
export function parseRequirements(text: string): ParsedRequirements {
  const lines = scanLines(text);
  const out: ParsedRequirements = { glossary: [], requirements: [], criteriaIds: [] };
  const title = h1Title(lines);
  if (title !== undefined) out.title = title;
  let section = '';
  let req: Requirement | undefined;
  let inAc = false;
  let last: AcceptanceCriterion | undefined;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.fenced) {
      last = undefined;
      continue;
    }
    const t = l.text;
    if (t.trim() === '') {
      last = undefined;
      continue;
    }
    const rh = REQ_HEAD_RE.exec(t);
    if (rh) {
      req = { number: Number(rh.groups!.n), criteria: [], line: i };
      if (rh.groups!.title) req.title = rh.groups!.title;
      out.requirements.push(req);
      inAc = false;
      last = undefined;
      continue;
    }
    if (AC_HEAD_RE.test(t)) {
      inAc = req !== undefined;
      last = undefined;
      continue;
    }
    const hm = /^(#{1,6})[ \t]+(.+?)[ \t]*$/.exec(t);
    if (hm) {
      if (hm[1]!.length <= 3) {
        req = undefined;
        section = hm[1]!.length === 2 ? hm[2]!.toLowerCase() : section;
      }
      inAc = false;
      last = undefined;
      continue;
    }
    if (section === 'glossary' && !req) {
      const gm = GLOSSARY_RE.exec(t);
      if (gm) out.glossary.push({ term: gm.groups!.term!.trim(), definition: gm.groups!.def!.trim() });
      continue;
    }
    if (req && !inAc) {
      const us = /^\*\*User Story:?\*\*:?[ \t]*(.+)$/i.exec(t.trim());
      if (us) req.userStory = us[1]!.trim();
      continue;
    }
    if (req && inAc) {
      const am = AC_ITEM_RE.exec(t);
      if (am) {
        const id = `${req.number}.${req.criteria.length + 1}`;
        last = { id, text: am.groups!.text!.trim(), line: i };
        req.criteria.push(last);
        out.criteriaIds.push(id);
        continue;
      }
      if (last && !/^[ \t]*[-*+][ \t]/.test(t) && !/^\*\*/.test(t.trim())) {
        last.text += ` ${t.trim()}`;
        continue;
      }
      last = undefined;
    }
  }
  return out;
}

export interface BugfixItem {
  id: string;
  section: 'current' | 'expected' | 'unchanged';
  text: string;
  line: number;
}

export interface ParsedBugfix {
  title?: string;
  current: BugfixItem[];
  expected: BugfixItem[];
  unchanged: BugfixItem[];
  criteriaIds: string[];
}

/** Parse bugfix.md (03 §1.5.2): `N.M` items under the three Bug Analysis subsections. */
export function parseBugfix(text: string): ParsedBugfix {
  const lines = scanLines(text);
  const out: ParsedBugfix = { current: [], expected: [], unchanged: [], criteriaIds: [] };
  const title = h1Title(lines);
  if (title !== undefined) out.title = title;
  let section: BugfixItem['section'] | undefined;
  let last: BugfixItem | undefined;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.fenced) {
      last = undefined;
      continue;
    }
    const t = l.text;
    if (t.trim() === '') {
      last = undefined;
      continue;
    }
    const hm = /^(#{1,6})[ \t]+(.+?)[ \t]*$/.exec(t);
    if (hm) {
      const h = hm[2]!.toLowerCase();
      if (h.startsWith('current behavior') || h.startsWith('current behaviour')) section = 'current';
      else if (h.startsWith('expected behavior') || h.startsWith('expected behaviour')) section = 'expected';
      else if (h.startsWith('unchanged behavior') || h.startsWith('unchanged behaviour')) section = 'unchanged';
      else section = undefined;
      last = undefined;
      continue;
    }
    if (!section) continue;
    const m = BUG_ITEM_RE.exec(t);
    if (m) {
      last = { id: m.groups!.id!, section, text: m.groups!.text!.trim(), line: i };
      out[section].push(last);
      if (!out.criteriaIds.includes(last.id)) out.criteriaIds.push(last.id);
      continue;
    }
    if (last) last.text += ` ${t.trim()}`;
  }
  return out;
}

export interface DesignProperty {
  number: number;
  name: string;
  validates: string[];
  line: number;
}

export interface ParsedDesign {
  title?: string;
  /** `##` section headings in order. */
  sections: string[];
  properties: DesignProperty[];
}

/** Parse design.md (03 §1.5.3/§1.5.4): sections and `### Property K: Name` + Validates. */
export function parseDesign(text: string): ParsedDesign {
  const lines = scanLines(text);
  const out: ParsedDesign = { sections: [], properties: [] };
  const title = h1Title(lines, /^Design Document[ \t]*:?[ \t]*/i);
  if (title !== undefined) out.title = title;
  let prop: DesignProperty | undefined;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.fenced) continue;
    const t = l.text;
    const s2 = /^##[ \t]+(.+?)[ \t]*$/.exec(t);
    if (s2) {
      out.sections.push(s2[1]!);
      prop = undefined;
      continue;
    }
    const ph = PROP_HEAD_RE.exec(t);
    if (ph) {
      prop = { number: Number(ph.groups!.k), name: ph.groups!.name!, validates: [], line: i };
      out.properties.push(prop);
      continue;
    }
    if (/^#{1,6}[ \t]/.test(t)) {
      prop = undefined;
      continue;
    }
    if (prop) {
      const v = VALIDATES_RE.exec(t);
      if (v) for (const r of parseRefList(v.groups!.refs!)) if (!prop.validates.includes(r)) prop.validates.push(r);
    }
  }
  return out;
}

// ───────────────────────────── coverage lint (03 §1.6.5) ─────────────────────────────

export interface LintIssue {
  code: 'uncovered-criterion' | 'unknown-ref' | 'property-without-task';
  message: string;
  ids: string[];
}

/** Lint requirement coverage without a model (03 §1.6.5). */
export function lintSpec(input: { criteriaIds: readonly string[]; tasks?: ParsedTasks; design?: ParsedDesign }): LintIssue[] {
  const issues: LintIssue[] = [];
  if (!input.tasks) return issues;
  const known = new Set(input.criteriaIds);
  const covered = new Set<string>();
  const unknown: string[] = [];
  for (const t of input.tasks.tasks) {
    for (const r of [...t.requirementRefs, ...t.validates]) {
      covered.add(r);
      // a bare requirement number ("5") covers all its criteria
      if (!r.includes('.')) for (const k of known) if (k.startsWith(`${r}.`)) covered.add(k);
      if (known.size && !known.has(r) && !(!r.includes('.') && [...known].some((k) => k.startsWith(`${r}.`)))) {
        const label = `${t.id} → ${r}`;
        if (!unknown.includes(label)) unknown.push(label);
      }
    }
  }
  const uncovered = input.criteriaIds.filter((id) => !covered.has(id));
  if (uncovered.length) {
    issues.push({ code: 'uncovered-criterion', message: `Acceptance criteria not covered by any task: ${uncovered.join(', ')}`, ids: uncovered });
  }
  if (unknown.length) {
    issues.push({ code: 'unknown-ref', message: `Tasks reference unknown requirements: ${unknown.join(', ')}`, ids: unknown });
  }
  if (input.design) {
    const props = new Set<number>();
    for (const t of input.tasks.tasks) for (const k of t.propertyRefs) props.add(k);
    const missing = input.design.properties.filter((p) => !props.has(p.number)).map((p) => String(p.number));
    if (missing.length) {
      issues.push({
        code: 'property-without-task',
        message: `Design properties without a property-test task: ${missing.join(', ')}`,
        ids: missing,
      });
    }
  }
  return issues;
}

// ───────────────────────────── rendering helpers ─────────────────────────────

/** `[x] 2.1 Title` / `[ ]* 2.2 Title` with two-space indentation per level. */
export function formatTaskLine(t: SpecTask, byId: ReadonlyMap<string, SpecTask>): string {
  let depth = 0;
  let p = t.parentId ? byId.get(t.parentId) : undefined;
  for (let guard = 0; p && guard < 16; guard++) {
    depth++;
    p = p.parentId ? byId.get(p.parentId) : undefined;
  }
  const num = t.synthesized ? '' : t.id.includes('.') ? `${t.id} ` : `${t.id}. `;
  return `${'  '.repeat(depth)}[${t.box}]${t.optional ? '*' : ''} ${num}${t.title}`;
}

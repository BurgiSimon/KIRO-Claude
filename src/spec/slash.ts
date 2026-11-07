/**
 * `/spec` slash command for the REPL (research 03 §1.1 command surface, §1.11.1 adapter
 * extensions, §1.11.4 checkpoint UI). Interacts only through ReplHost (print / ask / confirm /
 * choose / runTurn / createSession / replaceSession) via workflow.createReplRuntime.
 *
 * | Form | Behavior |
 * |---|---|
 * | `/spec` | picker over `.kiro/specs/*` (rows `name  type  phase  done/total`), then resume |
 * | `/spec new <name> [--type feature\|bugfix\|quick] [description]` | type picker (Build a Feature / Fix a Bug / Quick Spec), Requirements-First / Design-First picker for features (`kiroClaude.spec.defaultWorkflow` skips it), asks what the spec should cover (KCL:2-15), then the gated phases. Non-kebab names are normalized and confirmed (03 §1.2). |
 * | `/spec <name>` | resume: pending checkpoint, or step through tasks |
 * | `/spec list` · `/spec status [name]` | progress table / detailed status |
 * | `/spec view\|open <name> [requirements\|bugfix\|design\|tasks]` | print a document |
 * | `/spec run <name> [ids…\|--next\|--all\|--include-optional]` | scope picker (All remaining required tasks / include optional / Select tasks… / Cancel) then execution; Ctrl+C stops scheduling tasks and interrupts the running one, kills a running PreTaskExec/PostTaskExec command hook and cancels a task session start whose agentSpawn hooks run (the REPL command signal, via createReplRuntime) |
 * | `/spec analyze_requirements\|analyze [name]` | Analyze Requirements (picker over specs with requirements) |
 * | `/spec approve [name]` · `/spec revise [name] <feedback>` | approve / revise the pending checkpoint (scripted use) |
 * | `/spec sync <name>` | adapter extension (03 §1.7.4) |
 *
 * In plan mode `/spec run` (and running tasks from `/spec <name>`) is refused: Kiro's plan mode is
 * the read-only planner (workflow PLAN_MODE_RUN_REFUSED, T3); the spec phases still run there,
 * writing only their documents. Inside a tangent every form that runs spec turns (`new`, `approve`,
 * `revise`, `analyze`, `sync`, resuming a spec with a document to draft or review) is refused with
 * SPEC_IN_TANGENT_REFUSED: the continuation it hands over would replace the tangent, so `/tangent`
 * could no longer return to the main conversation (T4). A tangent with no message of its own yet is
 * left first instead (SPEC_TANGENT_LEFT; it holds nothing the main conversation lacks). `list`,
 * `status`, `view` and task runs work in a tangent.
 *
 * Not reproduced (gap): the V3 full-screen reader (Ctrl+X line comments) and "spec mode" for
 * later free-form turns (needs a REPL hook; ReplHost has none).
 */

import type { ReplHost, SlashCommand } from '../types.js';
import { SPEC_DOC_FILES, type SpecDocKind, type TaskSelection, type WorkflowType } from './model.js';
import { formatSpecList, formatSpecStatus, isValidSpecName, listSpecs, loadSpec, normalizeSpecName, resolveSpecDir, summarizeSpec } from './store.js';
import { SessionStore, sessionsDir } from '../session/store.js';
import {
  SPEC_IN_TANGENT_REFUSED,
  SPEC_TANGENT_LEFT,
  analyzeRequirements,
  approveSpec,
  canSetSpecPhase,
  conversationHasHistory,
  createNewSpec,
  createReplRuntime,
  resumeSpec,
  reviseSpec,
  runSpecTasks,
  syncSpec,
  type NewSpecRequest,
  type ReplRuntimeDeps,
  type SpecKindChoice,
  type SpecRuntime,
} from './workflow.js';

export const SPEC_USAGE = [
  '/spec                                   Pick a spec and continue it',
  '/spec new <feature-name> [--type feature|bugfix|quick] [description]',
  '/spec <feature-name>                    Resume a spec (review checkpoint or step through tasks)',
  '/spec list                              List specs',
  '/spec status [feature-name]             Progress table or detailed status',
  '/spec view <feature-name> [requirements|design|tasks]   Print a document (alias: open)',
  '/spec run <feature-name> [<task-id>…|--next|--all|--include-optional]',
  '/spec analyze_requirements [feature-name]               Analyze requirements (alias: analyze)',
  '/spec approve [feature-name]            Approve the pending checkpoint',
  '/spec revise [feature-name] <feedback>  Revise the document under review',
  '/spec sync <feature-name>               Update task boxes from the code',
].join('\n');

export const SPEC_TYPE_LABELS = ['Build a Feature', 'Fix a Bug', 'Quick Spec'] as const;
const SPEC_TYPES: SpecKindChoice[] = ['feature', 'bugfix', 'quick'];
export const WORKFLOW_LABELS = ['Requirements-First', 'Design-First'] as const;
export const DETAIL_LABELS = ['High Level Design', 'Low Level Design'] as const;
export const RUN_SCOPE_LABELS = ['All remaining required tasks', 'All remaining tasks (include optional *)', 'Select tasks…', 'Cancel'] as const;

/** Per-REPL state: the spec the user last worked on (for `/spec approve` / `revise` without a name). */
const replState = new WeakMap<ReplHost, { current?: string }>();

/** Test seam: dependencies for the REPL runtime (hook runner factory, editor). */
let runtimeDeps: ReplRuntimeDeps = {};
export function setSpecSlashDeps(deps: ReplRuntimeDeps): void {
  runtimeDeps = deps;
}

function stateOf(host: ReplHost): { current?: string } {
  let s = replState.get(host);
  if (!s) {
    s = {};
    replState.set(host, s);
  }
  return s;
}

function remember(host: ReplHost, name: string): void {
  stateOf(host).current = name;
}

/**
 * T4: the forms that run spec turns hand the chat a continuation when they end, which would
 * replace a tangent the chat is in (`/tangent` could no longer return to the main conversation).
 * A tangent with something of its own is kept: the command is refused with
 * {@link SPEC_IN_TANGENT_REFUSED} (Q disables checkpoints in tangent mode the same way, 06 §6.4).
 * A tangent that has no message of its own yet (just entered, directly under the main
 * conversation) holds nothing to lose: it is left first (`/tangent`), with
 * {@link SPEC_TANGENT_LEFT}, and the spec continues the main conversation (G0), in the plan mode
 * the user last set (plan mode is session state: KiroSession.exitTangent keeps it, r5 #0). `name`: only when
 * that spec still has a document to draft or review (a spec in task execution only steps through
 * its tasks, which runs no spec turn). True when the command must not run.
 */
async function tangentRefuses(host: ReplHost, name?: string): Promise<boolean> {
  const s = host.session;
  if (s.tangent === undefined || canSetSpecPhase(s)) return false;
  if (name !== undefined) {
    const phase = summarizeSpec(host.ws, name)?.phase;
    if (phase === undefined || phase === 'execution' || phase === 'done') return false;
  }
  if (emptyTangent(host)) {
    try {
      await s.exitTangent('discard');
    } catch {
      // could not leave it (busy, a respawn failed): keep it, refuse
    }
    if (host.session.tangent === undefined) {
      host.print(SPEC_TANGENT_LEFT);
      return false;
    }
  }
  host.print(SPEC_IN_TANGENT_REFUSED);
  return true;
}

/**
 * The chat is in a tangent of the main conversation (not of another tangent) that has no message
 * of its own yet: it is still a pending fork of the conversation it left (KiroSession.forkSource
 * answers that source) and its record holds no turn beyond its parent's, nor a carry.
 */
function emptyTangent(host: ReplHost): boolean {
  const s = host.session;
  const t = s.tangent;
  if (!t) return false;
  const src = s.forkSource();
  if (!src?.from || src.from === s.claudeSessionId) return false;
  let parent: ReturnType<SessionStore['read']>;
  try {
    parent = new SessionStore(sessionsDir(host.ws)).read(t.parentId);
  } catch {
    return false;
  }
  if (!parent || parent.forkKind === 'tangent') return false;
  const rec = s.record;
  return (rec?.turns?.length ?? 0) <= parent.turns.length && !rec?.pendingContext?.length;
}

function parseKind(v: string | undefined): SpecKindChoice | undefined {
  if (!v) return undefined;
  const x = v.toLowerCase();
  if (x === 'feature' || x === 'feat') return 'feature';
  if (x === 'bugfix' || x === 'bug' || x === 'fix' || x === 'bug-fix') return 'bugfix';
  if (x === 'quick' || x === 'quick-spec') return 'quick';
  return undefined;
}

function parseDoc(v: string | undefined): SpecDocKind | undefined {
  if (!v) return undefined;
  const x = v.toLowerCase().replace(/\.md$/, '');
  if (x === 'requirements' || x === 'req' || x === 'bugfix' || x === 'design' || x === 'tasks') return x === 'req' ? 'requirements' : x;
  return undefined;
}

/** Pick a spec when no name was given; `filter` narrows the candidates. */
async function pickSpec(host: ReplHost, question: string, filter?: (s: ReturnType<typeof listSpecs>[number]) => boolean, empty?: string): Promise<string | undefined> {
  const all = listSpecs(host.ws).filter((s) => !filter || filter(s));
  if (all.length === 0) {
    host.print(empty ?? 'No specs yet. Start one with /spec new <feature-name>');
    return undefined;
  }
  if (all.length === 1 && filter) return all[0]!.name;
  const rows = formatSpecList(all).split('\n');
  const i = await host.choose(question, rows);
  return i === undefined ? undefined : all[i]!.name;
}

/** Resolve an optional name: explicit, else the REPL's current spec, else the only candidate. */
async function resolveName(host: ReplHost, name: string | undefined, question: string, filter?: (s: ReturnType<typeof listSpecs>[number]) => boolean): Promise<string | undefined> {
  if (name) return name;
  const cur = stateOf(host).current;
  if (cur && resolveSpecDir(host.ws, cur)) return cur;
  return pickSpec(host, question, filter);
}

async function cmdNew(host: ReplHost, rt: SpecRuntime, args: string[]): Promise<void> {
  let kind: SpecKindChoice | undefined;
  let workflow: WorkflowType | undefined;
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const eq = a.indexOf('=');
    const flag = a.startsWith('--') ? (eq > 0 ? a.slice(0, eq) : a) : undefined;
    const val = (): string | undefined => (eq > 0 ? a.slice(eq + 1) : args[++i]);
    if (flag === '--type') {
      const v = val();
      kind = parseKind(v);
      if (!kind) {
        host.print(`Unknown spec type '${v ?? ''}'. Use feature, bugfix or quick.`);
        return;
      }
    } else if (flag === '--workflow') {
      const v = val();
      if (v !== 'requirements-first' && v !== 'design-first') {
        host.print(`Unknown workflow '${v ?? ''}'. Use requirements-first or design-first.`);
        return;
      }
      workflow = v;
    } else if (flag === '--quick' || flag === '--bugfix' || flag === '--feature') {
      kind = parseKind(flag.slice(2));
    } else words.push(a);
  }
  let raw = words.shift();
  if (!raw) raw = (await host.ask('Feature name (kebab-case, e.g. user-authentication):')).trim();
  if (!raw) return;
  let name = raw;
  if (!isValidSpecName(name)) {
    const norm = normalizeSpecName(raw);
    if (!norm) {
      host.print(`Invalid spec name '${raw}'. Use kebab-case, e.g. user-authentication.`);
      return;
    }
    if (!(await host.confirm(`Use "${norm}" as the spec name?`, true))) return;
    name = norm;
  }
  if (resolveSpecDir(host.ws, name)) {
    host.print(`Spec '${name}' already exists. Resume it with /spec ${name}`);
    return;
  }
  if (!kind) {
    const i = await host.choose('What kind of spec?', [...SPEC_TYPE_LABELS]);
    if (i === undefined) return;
    kind = SPEC_TYPES[i]!;
  }
  let detail: 'high' | 'low' | undefined;
  if (kind === 'feature' && !workflow) {
    const def = host.settings.getString('kiroClaude.spec.defaultWorkflow');
    if (def === 'requirements-first' || def === 'design-first') workflow = def;
    else {
      const i = await host.choose('Which workflow?', [...WORKFLOW_LABELS]);
      if (i === undefined) return;
      workflow = i === 1 ? 'design-first' : 'requirements-first';
    }
  }
  if (kind === 'feature' && workflow === 'design-first') {
    const i = await host.choose('Start with which level of design?', [...DETAIL_LABELS]);
    if (i === undefined) return;
    detail = i === 1 ? 'low' : 'high';
  }
  let description = words.join(' ').trim();
  if (!description) {
    const q = kind === 'bugfix' ? 'Describe the bug (symptom, where it happens, expected behavior):' : 'What should this spec cover? (used as the ground truth)';
    description = (await host.ask(q)).trim();
  }
  if (!description) {
    host.print('A description is needed to draft the spec.');
    return;
  }
  const req: NewSpecRequest = { name, kind, description };
  if (workflow) req.workflowType = workflow;
  if (detail) req.detail = detail;
  // the conversation the user continues: also a continuation a flow just handed over (no turn of
  // its own yet, its conversation carried)
  if (conversationHasHistory(host.session)) req.useConversation = true;
  remember(host, name);
  await createNewSpec(rt, req);
}

function parseRunArgs(args: string[]): { name?: string; sel?: TaskSelection; error?: string } {
  let name: string | undefined;
  let next = false;
  let all = false;
  let includeOptional = false;
  const ids: string[] = [];
  for (const a of args) {
    if (a === '--next') next = true;
    else if (a === '--all') all = true;
    else if (a === '--include-optional' || a === '--optional') includeOptional = true;
    else if (a.startsWith('--')) return { error: `Unknown option ${a}` };
    else if (!name) name = a;
    else ids.push(...a.split(',').filter(Boolean));
  }
  const out: { name?: string; sel?: TaskSelection } = {};
  if (name) out.name = name;
  if (ids.length) out.sel = { kind: 'ids', ids, includeOptional };
  else if (next) out.sel = { kind: 'next', includeOptional };
  else if (all || includeOptional) out.sel = { kind: 'scope', includeOptional };
  return out;
}

async function cmdRun(host: ReplHost, rt: SpecRuntime, args: string[]): Promise<void> {
  const p = parseRunArgs(args);
  if (p.error) {
    host.print(`${p.error}\nUsage: /spec run <feature-name> [<task-id>…|--next|--all|--include-optional]`);
    return;
  }
  const name = p.name ?? (await pickSpec(host, 'Run which spec?', (s) => s.docs.tasks.nonEmpty, 'No spec has a tasks.md yet. Create one with /spec new <feature-name>'));
  if (!name) return;
  let sel = p.sel;
  if (!sel) {
    const i = await host.choose(`Which tasks of ${name}?`, [...RUN_SCOPE_LABELS]);
    if (i === undefined || i === 3) return;
    if (i === 2) {
      const ids = (await host.ask('Task ids to run (e.g. "2.1 3"):')).trim();
      if (!ids) return;
      sel = { kind: 'ids', ids: ids.split(/[\s,]+/).filter(Boolean), includeOptional: true };
    } else sel = { kind: 'scope', includeOptional: i === 1 };
  }
  remember(host, name);
  await runSpecTasks(rt, name, sel);
}

function cmdView(host: ReplHost, args: string[]): void {
  const name = args[0];
  if (!name) {
    host.print('Usage: /spec view <feature-name> [requirements|design|tasks]');
    return;
  }
  const spec = loadSpec(host.ws, name);
  if (!spec) {
    host.print(`Spec '${name}' not found. Create it with /spec new ${name}`);
    return;
  }
  let doc = parseDoc(args[1]);
  if (args[1] && !doc) {
    host.print(`Unknown document '${args[1]}'. Use requirements, design or tasks.`);
    return;
  }
  if (doc === 'requirements' && spec.specType === 'bugfix') doc = 'bugfix';
  if (!doc) {
    const cands = spec.order.filter((k) => spec.docs[k].nonEmpty);
    doc = spec.awaitingApproval ?? cands[cands.length - 1];
  }
  if (!doc || !spec.docs[doc].nonEmpty) {
    host.print(`${SPEC_DOC_FILES[doc ?? spec.order[0]!]} has not been written yet.`);
    return;
  }
  host.print(`[${spec.docs[doc].path}]\n${(spec.texts[doc] ?? '').replace(/\s+$/, '')}`);
}

function cmdStatus(host: ReplHost, name: string | undefined): void {
  if (!name) {
    const all = listSpecs(host.ws);
    host.print(all.length ? formatSpecList(all) : 'No specs yet. Start one with /spec new <feature-name>');
    return;
  }
  const spec = loadSpec(host.ws, name);
  host.print(spec ? formatSpecStatus(spec) : `Spec '${name}' not found.`);
}

async function runSpec(args: string[], host: ReplHost): Promise<void> {
  const rt = createReplRuntime(host, runtimeDeps);
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case undefined: {
      const name = await pickSpec(host, 'Select a spec');
      if (!name) return;
      if (await tangentRefuses(host, name)) return;
      remember(host, name);
      await resumeSpec(rt, name);
      return;
    }
    case 'help':
    case '--help':
    case '-h':
      host.print(SPEC_USAGE);
      return;
    case 'list':
    case 'ls': {
      const all = listSpecs(host.ws);
      host.print(all.length ? formatSpecList(all) : 'No specs yet. Start one with /spec new <feature-name>');
      return;
    }
    case 'status':
      cmdStatus(host, rest[0]);
      return;
    case 'new':
      if (await tangentRefuses(host)) return;
      await cmdNew(host, rt, rest);
      return;
    case 'view':
    case 'open':
      cmdView(host, rest);
      return;
    case 'run':
      await cmdRun(host, rt, rest);
      return;
    case 'analyze_requirements':
    case 'analyze-requirements':
    case 'analyze': {
      if (await tangentRefuses(host)) return;
      const name = rest[0] ?? (await pickSpec(host, 'Analyze which spec?', (s) => s.docs.requirements.nonEmpty || s.docs.bugfix.nonEmpty, 'No spec has requirements yet. Create one with /spec new <feature-name>'));
      if (!name) return;
      remember(host, name);
      await analyzeRequirements(rt, name);
      return;
    }
    case 'approve': {
      const name = await resolveName(host, rest[0], 'Approve which spec?', (s) => s.awaitingApproval !== undefined);
      if (!name) return;
      if (await tangentRefuses(host, name)) return;
      remember(host, name);
      await approveSpec(rt, name);
      return;
    }
    case 'revise': {
      if (await tangentRefuses(host)) return;
      let name: string | undefined;
      let words = rest;
      if (rest[0] && resolveSpecDir(host.ws, rest[0])) {
        name = rest[0];
        words = rest.slice(1);
      }
      name = await resolveName(host, name, 'Revise which spec?', (s) => s.awaitingApproval !== undefined);
      if (!name) return;
      let feedback = words.join(' ').trim();
      if (!feedback) feedback = (await host.ask('What should change?')).trim();
      if (!feedback) return;
      remember(host, name);
      await reviseSpec(rt, name, feedback);
      return;
    }
    case 'sync': {
      if (await tangentRefuses(host)) return;
      const name = await resolveName(host, rest[0], 'Sync which spec?', (s) => s.docs.tasks.nonEmpty);
      if (!name) return;
      remember(host, name);
      await syncSpec(rt, name);
      return;
    }
    default: {
      if (!summarizeSpec(host.ws, sub)) {
        host.print(`Spec '${sub}' not found. Create it with /spec new ${sub}\n\n${SPEC_USAGE}`);
        return;
      }
      if (await tangentRefuses(host, sub)) return;
      remember(host, sub);
      await resumeSpec(rt, sub);
    }
  }
}

export const specSlashCommands: SlashCommand[] = [
  {
    name: 'spec',
    summary: 'Spec-driven development: requirements → design → tasks → run',
    usage: SPEC_USAGE,
    async run(args: string[], _raw: string, host: ReplHost): Promise<void> {
      await runSpec(args, host);
    },
  },
];

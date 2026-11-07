/**
 * The adapter-owned spec state machine (research 03 §1.4.2 "Port decision: the adapter owns the
 * gates", §1.7, §1.8, §1.11; 00 §2.5 "Specs" row, §2.4 PreTaskExec/PostTaskExec).
 *
 *   new feature/bugfix spec → draft phase 1 → checkpoint ─revise→ (revision turn) → checkpoint
 *                                            ─approve→ draft phase 2 → checkpoint … → tasks approved
 *   quick spec: clarifying questions → requirements → design → tasks with no gates in between,
 *   one final checkpoint on tasks (03 §1.10.7).
 *
 *  - Each phase is ONE turn of the spec conversation with a write restriction
 *    (KiroSessionOptions.specPhase: only the phase document may be written; the gate denies other
 *    writes with `Spec phase <name>: only <paths> may be written now`, 03 §1.11.3). The model never
 *    advances on its own: approval is a UI choice (never parsed from free text); free text is
 *    revision feedback (03 §1.4.2).
 *  - The restriction changes per phase. A session that implements the optional
 *    {@link SpecPhaseSettable.setSpecPhase} is switched in place (cheapest). Otherwise
 *    {@link SpecSessionDriver} creates a fresh session with `specPhase` that forks the current
 *    Claude conversation (`fork.kind:'main'`), so context carries over; when the flow ends it forks
 *    one more unrestricted session (REPL) or closes everything (CLI). Claude Code writes a fork's
 *    transcript only with its first message (VERIFIED 2.1.319), so a session forked from one that
 *    never got a message would start empty: the driver forks from the last session a turn reached
 *    (main when none did), and when no spec turn reached Claude (e.g. Ctrl+C while the phase
 *    session started) the REPL keeps its original session. A fork's parent RECORD (whose turns,
 *    journal, context rules and merged carry the fork's record copies) is the session the user is
 *    in, also a continuation an earlier flow handed over that has no message yet (its fork point is
 *    still its source's). The continuation takes the plan mode of the session it replaces (also
 *    plan mode the user turned on during the flow, e.g. Shift+Tab at a checkpoint); the phase
 *    sessions run without plan mode (they write the spec documents). The REPL runtime creates
 *    every session (phase sessions, the continuation, task sessions) under the command's Ctrl+C as
 *    its start signal (session/startSignal.ts): a press while one runs its agentSpawn hooks cancels
 *    that start (phase turn not sent, continuation not made: the chat keeps its session, task
 *    `interrupted`).
 *  - Analyze Requirements (03 §1.8): turn A with no writable paths, JSON findings, questions
 *    `Question i/N`, turn B applies all answers to the phase-1 document, then re-lint.
 *  - Task execution (03 §1.7): planned from tasks.md (model.planRun: waves, checkpoints as
 *    barriers); per task: PreTaskExec hooks (exit 2 ⇒ task skipped, box kept), box `[-]`, a fresh
 *    child session with the spec documents as context and the §1.10.8 prompt (PreTaskExec agent
 *    prompts prepended), `[x]` only for a successful turn ending in `TASK_RESULT: completed`, else
 *    `[ ]` and the run stops (03 §1.7.2, KI:#11786); PostTaskExec hooks (agent prompts ⇒ follow-up
 *    turn in the task session before it closes). Concurrency per wave = runtime.maxParallelTasks
 *    (REPL 1; CLI `kiroClaude.spec.maxParallelTasks`, ≤ 4 — documented deviation 03 §1.7.2).
 *    The run's signal (Ctrl+C) stops scheduling, interrupts running task sessions, kills running
 *    task hook commands (with their process groups, also with timeout 0) and cancels a task
 *    session start whose agentSpawn hooks run. A press during PreTaskExec ⇒ the task is
 *    `interrupted` before its box or a session is touched (no PostTaskExec). The PostTaskExec of
 *    an interrupted task still runs (status `interrupted`), without the already aborted signal, so
 *    it cannot be cancelled (known gap: a host signal for a LATER press does not exist).
 *
 * The workflow talks to its host only through {@link SpecRuntime}; {@link createReplRuntime}
 * adapts a ReplHost (slash commands) and spec/cli.ts builds a headless one.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  HookRunnerLike,
  HookWarning,
  KiroHook,
  KiroSession,
  KiroSessionOptions,
  PromptInput,
  ReplHost,
  SettingsStore,
  TurnResult,
  WorkspaceContext,
} from '../types.js';
import { HookRunner } from '../hooks/runner.js';
import { isSessionStartCancelled, withStartSignal } from '../session/startSignal.js';
import { writeFileAtomic } from '../util/fsx.js';
import { shlexSplit } from '../util/shlex.js';
import {
  SPEC_DOC_FILES,
  formatTaskLine,
  isOptionalTask,
  normalizeTasksText,
  parseRequirements,
  parseBugfix,
  parseTasks,
  planRun,
  planTasks,
  repairMessage,
  taskProgress,
  writeTaskStatus,
  type SpecDocKind,
  type SpecTask,
  type TaskBox,
  type TaskSelection,
  type WorkflowType,
} from './model.js';
import {
  analyzePrompt,
  applyFindingsPrompt,
  approveLabel,
  checkpointQuestion,
  parseAnalysis,
  parseTaskResult,
  phasePrompt,
  phaseWritableDocs,
  quickQuestionsPrompt,
  revisionPrompt,
  specModeBlock,
  syncPrompt,
  taskExecutionPrompt,
  type AnalysisFinding,
  type FindingAnswer,
  type PhasePromptContext,
  type SpecKindLabel,
} from './prompts.js';
import {
  createSpecFolder,
  docSummary,
  isValidSpecName,
  loadSpecDir,
  resolveSpecDir,
  specContextBlock,
  specDocPath,
  summarizeSpecDir,
  type LoadedSpec,
  type SpecSummary,
} from './store.js';

// ───────────────────────────── runtime contract ─────────────────────────────

/** KiroSessionOptions.specPhase. */
export type SpecPhaseRestriction = NonNullable<KiroSessionOptions['specPhase']>;

/**
 * Optional extension a KiroSession may implement to change its spec-phase write restriction in
 * place (not part of types.ts — DEVIATION reported; without it fresh forked sessions are used).
 */
export interface SpecPhaseSettable {
  setSpecPhase(phase: SpecPhaseRestriction | undefined): void | Promise<void>;
}

export function canSetSpecPhase(s: unknown): s is SpecPhaseSettable {
  return !!s && typeof (s as { setSpecPhase?: unknown }).setSpecPhase === 'function';
}

export interface TaskSessionHandle {
  readonly sessionId: string;
  run(input: PromptInput): Promise<TurnResult>;
  interrupt?(): Promise<void>;
  close(): Promise<void>;
}

/** Everything the workflow needs from its host (REPL or CLI). */
export interface SpecRuntime {
  readonly ws: WorkspaceContext;
  readonly settings?: SettingsStore;
  /** Checkpoints and pickers may ask the user. */
  readonly interactive: boolean;
  /** `/spec` (REPL) or `kiro-claude spec` (CLI): used in hints. */
  readonly commandPrefix: string;
  /** Max concurrently running task sessions per wave. */
  readonly maxParallelTasks: number;
  /**
   * The host's Ctrl+C for the running command (REPL: the slash command's signal): the default of
   * {@link RunOptions.signal} for task runs.
   */
  readonly signal?: AbortSignal | undefined;
  print(text: string): void;
  /** Final results (findings, run summary). Defaults to print. */
  result?(text: string): void;
  ask(question: string): Promise<string>;
  confirm(question: string, defaultYes?: boolean): Promise<boolean>;
  choose(question: string, options: string[]): Promise<number | undefined>;
  /**
   * One turn of the spec conversation under a write restriction. `quiet`: the answer is machine
   * output (analysis JSON) — UIs that can should not echo its text.
   */
  runSpecTurn(input: PromptInput, phase: SpecPhaseRestriction, opts?: TurnOptions): Promise<TurnResult>;
  /** A fresh child session for one task. */
  openTaskSession(label: string): Promise<TaskSessionHandle>;
  /** Runner for PreTaskExec/PostTaskExec and the payload session id. */
  taskHooks(): { runner: HookRunnerLike; sessionId: string } | undefined;
  /** "Open in $EDITOR" checkpoint option (absent ⇒ not offered). */
  openEditor?(file: string): Promise<void>;
  /** Hint printed when tasks are approved. */
  readyHint?(name: string): string;
  /** End of a flow: release/settle phase sessions. */
  finish(): Promise<void>;
}

// ───────────────────────────── session driver ─────────────────────────────

export interface TurnOptions {
  quiet?: boolean;
  /**
   * Ctrl+C for this turn: aborted by the time the turn's session is ready (spawning Claude Code
   * takes a while), the turn is not sent and the result is `cancelled`.
   */
  signal?: AbortSignal | undefined;
}

/** How the driver reaches sessions (REPL: host; CLI: createSession + own renderer). */
export interface SessionPort {
  active(): KiroSession | undefined;
  create(opts: Partial<KiroSessionOptions>): Promise<KiroSession>;
  activate(s: KiroSession): void;
  run(s: KiroSession, input: PromptInput, opts?: TurnOptions): Promise<TurnResult>;
}

function phaseKey(p: SpecPhaseRestriction): string {
  return JSON.stringify([p.name, [...p.allowedWritePaths].sort()]);
}

/** A spec turn that was not sent (Ctrl+C while its session started). */
function notSent(): TurnResult {
  return { stopReason: 'cancelled', isError: false, text: '', permissionDenials: [] };
}

/** Turns recorded in the session (kiroSession records a prompt turn once its result arrives). */
function recordedTurns(s: KiroSession): number {
  return s.record?.turns?.length ?? 0;
}

/** Where a fork of a session's conversation starts (KiroSessionOptions.fork). */
interface ForkPoint {
  claudeSessionId: string;
  at?: string;
  parentId: string;
}

/**
 * Sessions a driver forked (phase sessions, continuations) that have not had a turn yet. Claude
 * Code writes a fork's transcript only with its first message, so until then a
 * `--resume <it> --fork-session` finds no conversation and starts empty: a fork of such a session
 * starts where it started (`point`). Module-level: the continuation a flow hands to the REPL
 * outlives that flow's driver (the next `/spec` command forks from it).
 */
const unwritten = new WeakMap<
  KiroSession,
  {
    point: ForkPoint | undefined;
    turns: number;
    claudeSessionId: string | undefined;
    /** {@link forkSourceKey} when it was made. */
    source: string;
    /** The conversation it was forked from had history (its own record starts with none). */
    history: boolean;
  }
>();

/** What `s.forkSource()` answers, as a comparable key. */
function forkSourceKey(s: KiroSession): string {
  const f = s.forkSource();
  return JSON.stringify(f?.from ? [f.from, f.at ?? null] : null);
}

/**
 * `s`'s entry in {@link unwritten}, until a turn reaches it or its conversation changes (/clear, a
 * tangent), or the session itself no longer forks from where it started: its own Claude session
 * got a transcript without a recorded turn (a `/compact` in it: KiroSession.forkSource then answers
 * that session, and a fork from the old point would drop the compaction).
 */
function unwrittenEntry(s: KiroSession): ReturnType<typeof unwritten.get> {
  const u = unwritten.get(s);
  if (!u) return undefined;
  if (recordedTurns(s) <= u.turns && s.claudeSessionId === u.claudeSessionId && forkSourceKey(s) === u.source) return u;
  unwritten.delete(s);
  return undefined;
}

/**
 * The conversation `s` continues has history (`/spec new`: "Use the conversation so far as
 * input"): turns of its own (its record's turns; a tangent, rewind, resumed or imported record
 * carries those of the conversation it continues), or it is a fork a driver made that has no
 * message yet (the continuation a flow just handed over) of a conversation that had history. A
 * fork made by `create({fork})` carries its parent's turns, so the unwritten entry is only a
 * fallback (test doubles do not copy turns). The record's message count is not used.
 */
export function conversationHasHistory(s: KiroSession | undefined): boolean {
  if (!s) return false;
  if (recordedTurns(s) > 0) return true;
  return unwrittenEntry(s)?.history === true;
}

/** Where a fork of `s`'s conversation starts: never at a Claude session without a transcript. */
function forkPointOf(s: KiroSession | undefined): ForkPoint | undefined {
  if (!s) return undefined;
  const u = unwrittenEntry(s);
  if (u) return u.point;
  // KiroSession.forkSource: its own Claude session, or, while that is itself a fork without a
  // message yet (a /tangent or /rewind just entered), that fork's source
  const f = s.forkSource();
  if (f?.from) return { claudeSessionId: f.from, ...(f.at ? { at: f.at } : {}), parentId: s.id };
  return s.claudeSessionId ? { claudeSessionId: s.claudeSessionId, parentId: s.id } : undefined;
}

/**
 * Runs spec-conversation turns under a phase restriction (see module doc). Sessions it created are
 * closed when replaced; {@link finish} leaves an unrestricted continuation active (`keep`) or
 * closes everything it created.
 */
export class SpecSessionDriver {
  private readonly created = new Set<KiroSession>();
  private restricted: { session: KiroSession; key: string } | undefined;
  private original: KiroSession | undefined;
  private replacedOriginal = false;
  /** A turn of this flow reached Claude in a session this driver created. */
  private reached = false;
  /**
   * The user turned plan mode on in a session this driver created while it was the chat's
   * (Shift+Tab at a question of the flow, e.g. a checkpoint: the prompt showed `[plan]`). Phase
   * sessions start without plan mode, so plan mode on one of them is the user's.
   */
  private planTurnedOn = false;

  constructor(
    private readonly port: SessionPort,
    private readonly opts: { phaseOptions?: Partial<KiroSessionOptions>; finalOptions?: Partial<KiroSessionOptions> } = {},
  ) {}

  /** Sessions created by this driver and still open. */
  get openSessions(): KiroSession[] {
    return [...this.created];
  }

  async runTurn(input: PromptInput, phase: SpecPhaseRestriction, opts: TurnOptions = {}): Promise<TurnResult> {
    let s = this.port.active();
    if (s && canSetSpecPhase(s)) {
      await s.setSpecPhase(phase);
      try {
        if (opts.signal?.aborted) return notSent();
        return await this.port.run(s, input, opts);
      } finally {
        await s.setSpecPhase(undefined);
      }
    }
    const key = phaseKey(phase);
    if (!s || !this.restricted || this.restricted.session !== s || this.restricted.key !== key) {
      try {
        s = await this.fork(s, { ...this.opts.phaseOptions, specPhase: { name: phase.name, allowedWritePaths: [...phase.allowedWritePaths] } });
      } catch (e) {
        // Ctrl+C while the phase session ran its agentSpawn hooks (the host's start signal,
        // session/startSignal.ts): that start was cancelled and nothing changed, the turn is not sent
        if (isSessionStartCancelled(e)) return notSent();
        throw e;
      }
      this.restricted = { session: s, key };
    }
    // Ctrl+C while the phase session started: nothing is sent (the session gets no message)
    if (opts.signal?.aborted) return notSent();
    const before = recordedTurns(s);
    try {
      return await this.port.run(s, input, opts);
    } finally {
      if (recordedTurns(s) > before) this.reached = true;
    }
  }

  /**
   * A new session forking `prev`'s conversation, made active. `planMode`: it starts in plan mode
   * (set before the host sees it).
   */
  private async fork(prev: KiroSession | undefined, extra: Partial<KiroSessionOptions>, init: { planMode?: boolean } = {}): Promise<KiroSession> {
    const o: Partial<KiroSessionOptions> = { ...extra };
    // never from a session without a transcript yet (its fork would start empty): from its source
    const p = forkPointOf(prev);
    // The parent RECORD (create({fork}) builds the fork's record from it: turns, journal, title,
    // context rules, a merged carry) is the session the user is in when it is not one of this
    // driver's: also a continuation an earlier flow handed over that has no message yet, whose fork
    // point is its source's but whose record holds what the user added since (a `/tangent merge`
    // carry, `/context add` rules, r4 #8). A phase session of this flow that got no message is
    // skipped: the fork's parent is its source (G0).
    if (p) o.fork = { fromClaudeSessionId: p.claudeSessionId, ...(p.at ? { at: p.at } : {}), kind: 'main', parentId: prev && !this.created.has(prev) ? prev.id : p.parentId };
    const history = !!p && conversationHasHistory(prev);
    const next = await this.port.create(o);
    unwritten.set(next, { point: p, turns: recordedTurns(next), claudeSessionId: next.claudeSessionId, source: forkSourceKey(next), history });
    if (init.planMode) next.planMode = true;
    if (prev && !this.created.has(prev) && this.original === undefined) this.original = prev;
    this.port.activate(next);
    if (prev && this.created.has(prev)) {
      if (prev.planMode) this.planTurnedOn = true;
      this.created.delete(prev);
      await prev.close().catch(() => undefined);
    } else if (prev) {
      this.replacedOriginal = true;
    }
    this.created.add(next);
    return next;
  }

  /**
   * End of a flow. `keep`: when a restricted session is active, fork an unrestricted continuation
   * (keeps the spec conversation, 03 §1.7.2) from the last session a turn reached, and close the
   * restricted one and the replaced original; when no turn of the flow reached Claude the original
   * stays (nothing to carry). The continuation takes the plan mode of the session it replaces (the
   * phase sessions run without it: they write the spec documents; r4 #0), or plan mode when the
   * user turned it on during the flow (in a phase session); so does an original the host gets
   * back. Then, and for `close`, close every session this driver created, the host never left on
   * one of them.
   */
  async finish(mode: 'keep' | 'close'): Promise<void> {
    const active = this.port.active();
    if (active && this.created.has(active) && active.planMode) this.planTurnedOn = true;
    // never out of plan mode the chat was in, or that the user turned on during the flow (the
    // prompt showed `[plan]`); a phase session in plan mode is the user's doing (they start without)
    const planMode = this.original?.planMode === true || this.planTurnedOn;
    const giveBack = (s: KiroSession): void => {
      if (planMode && !s.planMode) s.planMode = true;
      this.port.activate(s);
    };
    if (mode === 'keep' && active && this.restricted && this.restricted.session === active && (this.reached || !this.original)) {
      this.restricted = undefined;
      try {
        const next = await this.fork(active, { ...this.opts.finalOptions }, { planMode });
        this.created.delete(next); // handed over to the host
        if (this.replacedOriginal && this.original) await this.original.close().catch(() => undefined);
      } catch {
        // could not fork a continuation: give the host its original session back
        if (this.original) giveBack(this.original);
      }
    } else if (active && this.created.has(active) && this.original) {
      giveBack(this.original);
    }
    for (const s of this.created) await s.close().catch(() => undefined);
    this.created.clear();
    this.restricted = undefined;
    this.original = undefined;
    this.replacedOriginal = false;
    this.reached = false;
    this.planTurnedOn = false;
  }
}

// ───────────────────────────── flow results ─────────────────────────────

export type FlowState = 'drafting' | 'review' | 'revising' | 'analyzing' | 'approved' | 'stopped' | 'ready' | 'error';

export interface FlowTransition {
  state: FlowState;
  doc?: SpecDocKind;
}

export interface FlowResult {
  status: 'ready' | 'stopped' | 'error';
  spec: string;
  /** Document whose checkpoint is pending when stopped. */
  awaiting?: SpecDocKind;
  message?: string;
  /** State-machine trace (tests, debugging). */
  transitions: FlowTransition[];
}

export type SpecKindChoice = 'feature' | 'bugfix' | 'quick';

export interface NewSpecRequest {
  name: string;
  kind: SpecKindChoice;
  /** Feature specs only (default requirements-first). */
  workflowType?: WorkflowType;
  /** Design-first only (default high). */
  detail?: 'high' | 'low';
  description: string;
  /** `/spec new` mid-conversation: include the conversation as input. */
  useConversation?: boolean;
  /** Approve every checkpoint automatically (CLI `--yes`). */
  autoApprove?: boolean;
}

interface FlowCtx {
  rt: SpecRuntime;
  dir: string;
  name: string;
  kindLabel: SpecKindLabel;
  prompt: PhasePromptContext;
  order: SpecDocKind[];
  autoApprove: boolean;
  quick: boolean;
  trace: FlowTransition[];
}

function out(rt: SpecRuntime, text: string): void {
  (rt.result ?? rt.print).call(rt, text);
}

/** Why a turn failed, or undefined when it completed normally. */
export function turnFailure(r: TurnResult): string | undefined {
  if (r.stopReason === 'cancelled') return 'interrupted';
  // Claude's own text says "Please run /login", a command the chat does not have
  if (r.authError) return 'you are not logged in to Claude Code (run kiro-claude login)';
  if (r.isError || r.stopReason === 'error') return r.error || 'the turn ended with an error';
  if (r.stopReason === 'max_turns') return 'the turn hit the maximum number of turns';
  if (r.stopReason === 'refusal') return 'the model refused the request';
  return undefined;
}

/** runSpecTurn that never throws: session start failures become an error TurnResult. */
async function specTurn(rt: SpecRuntime, input: PromptInput, phase: SpecPhaseRestriction, opts?: TurnOptions): Promise<TurnResult> {
  try {
    return await rt.runSpecTurn(input, phase, opts);
  } catch (e) {
    return { stopReason: 'error', isError: true, text: '', error: e instanceof Error ? e.message : String(e), permissionDenials: [] };
  }
}

function nextDoc(order: readonly SpecDocKind[], doc: SpecDocKind): SpecDocKind | undefined {
  const i = order.indexOf(doc);
  return i >= 0 ? order[i + 1] : undefined;
}

function restrictionFor(c: Pick<FlowCtx, 'dir' | 'prompt'>, doc: SpecDocKind): SpecPhaseRestriction {
  return { name: doc, allowedWritePaths: phaseWritableDocs(doc, c.prompt).map((k) => specDocPath(c.dir, k)) };
}

function baseBlock(c: Pick<FlowCtx, 'name' | 'dir' | 'kindLabel' | 'rt'>): string {
  return specModeBlock({ name: c.name, dir: c.dir, ws: c.rt.ws.workspaceRoot, type: c.kindLabel });
}

function specInput(c: FlowCtx, text: string): PromptInput {
  return { text, extraContext: [baseBlock(c)], skipPromptHooks: true };
}

function flowCtx(rt: SpecRuntime, s: SpecSummary, o: { desc?: string; kind?: SpecKindChoice; detail?: 'high' | 'low'; useConversation?: boolean; autoApprove?: boolean }): FlowCtx {
  const kindLabel: SpecKindLabel = o.kind === 'quick' ? 'quick' : s.specType;
  const prompt: PhasePromptContext = {
    name: s.name,
    dir: s.dir,
    ws: rt.ws.workspaceRoot,
    specType: s.specType,
    workflowType: s.workflowType,
    desc: o.desc ?? '',
  };
  if (o.detail) prompt.detail = o.detail;
  if (o.useConversation) prompt.useConversation = true;
  return {
    rt,
    dir: s.dir,
    name: s.name,
    kindLabel,
    prompt,
    order: s.order,
    autoApprove: o.autoApprove === true,
    quick: o.kind === 'quick',
    trace: [],
  };
}

function result(c: FlowCtx, status: FlowResult['status'], extra: { awaiting?: SpecDocKind; message?: string } = {}): FlowResult {
  const r: FlowResult = { status, spec: c.name, transitions: c.trace };
  if (extra.awaiting) r.awaiting = extra.awaiting;
  if (extra.message) r.message = extra.message;
  return r;
}

function errorResult(name: string, message: string): FlowResult {
  return { status: 'error', spec: name, message, transitions: [{ state: 'error' }] };
}

// ───────────────────────────── phases ─────────────────────────────

/** Normalize tasks.md after a turn that may have written it (03 §1.6.6). */
function repairTasks(rt: SpecRuntime, dir: string): void {
  const file = specDocPath(dir, 'tasks');
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  const n = normalizeTasksText(text);
  if (n.changedLines > 0 && n.text !== text) {
    try {
      writeFileAtomic(file, n.text);
      rt.print(repairMessage('tasks.md', n.changedLines));
    } catch {
      // leave it
    }
  }
}

function docReady(c: FlowCtx, doc: SpecDocKind): boolean {
  const s = summarizeSpecDir(c.dir);
  return s.docs[doc].nonEmpty;
}

async function draftPhase(c: FlowCtx, doc: SpecDocKind): Promise<string | undefined> {
  c.trace.push({ state: 'drafting', doc });
  const r = await specTurn(c.rt, specInput(c, phasePrompt(doc, c.prompt)), restrictionFor(c, doc));
  const fail = turnFailure(r);
  if (fail) return fail;
  if (doc === 'tasks' || phaseWritableDocs(doc, c.prompt).includes('tasks')) repairTasks(c.rt, c.dir);
  reportDoc(c, doc);
  return undefined;
}

function reportDoc(c: FlowCtx, doc: SpecDocKind): void {
  const file = SPEC_DOC_FILES[doc];
  if (!docReady(c, doc)) {
    c.rt.print(`⚠ ${file} was not written (expected at ${specDocPath(c.dir, doc)}).`);
    return;
  }
  const spec = loadSpecDir(c.dir);
  c.rt.print(`${file} ready (${docSummary(spec, doc)})`);
}

type CheckpointDecision = { kind: 'approve' } | { kind: 'revise'; feedback: string } | { kind: 'analyze' } | { kind: 'editor' } | { kind: 'stop' };

async function checkpoint(c: FlowCtx, doc: SpecDocKind, next: SpecDocKind | undefined): Promise<CheckpointDecision> {
  const exists = docReady(c, doc);
  if (!c.rt.interactive) {
    if (c.autoApprove && exists) return { kind: 'approve' };
    return { kind: 'stop' };
  }
  const options: { label: string; d: CheckpointDecision['kind'] }[] = [];
  if (exists) options.push({ label: approveLabel(doc, next), d: 'approve' });
  options.push({ label: 'Request changes…', d: 'revise' });
  if (exists && (doc === 'requirements' || doc === 'bugfix')) options.push({ label: 'Analyze requirements', d: 'analyze' });
  if (exists && c.rt.openEditor) options.push({ label: 'Open in $EDITOR', d: 'editor' });
  options.push({ label: `Stop here (resume later with ${c.rt.commandPrefix} ${c.name})`, d: 'stop' });
  for (;;) {
    const i = await c.rt.choose(checkpointQuestion(doc, next), options.map((o) => o.label));
    const pick = i === undefined ? undefined : options[i];
    if (!pick || pick.d === 'stop') return { kind: 'stop' };
    if (pick.d === 'revise') {
      const feedback = (await c.rt.ask(`What should change in ${SPEC_DOC_FILES[doc]}? (empty to go back)`)).trim();
      if (feedback === '') continue;
      return { kind: 'revise', feedback };
    }
    return { kind: pick.d } as CheckpointDecision;
  }
}

function readyHint(c: FlowCtx): string {
  if (c.rt.readyHint) return c.rt.readyHint(c.name);
  return `Spec ready. Run all tasks: ${c.rt.commandPrefix} run ${c.name} · Step through: ${c.rt.commandPrefix} ${c.name}`;
}

function onReady(c: FlowCtx): void {
  const spec = loadSpecDir(c.dir);
  for (const i of spec.lint) c.rt.print(`⚠ ${i.message}`);
  c.rt.print(readyHint(c));
}

/**
 * The gate loop starting at `doc` (drafted first when `draft`), see module doc. Never throws for
 * turn failures (returns status 'error').
 */
async function phaseLoop(c: FlowCtx, start: SpecDocKind, draft: boolean): Promise<FlowResult> {
  let doc = start;
  let mustDraft = draft;
  for (let guard = 0; guard < 1000; guard++) {
    if (mustDraft) {
      const fail = await draftPhase(c, doc);
      if (fail) {
        c.trace.push({ state: 'error', doc });
        c.rt.print(`✗ Drafting ${SPEC_DOC_FILES[doc]} failed: ${fail}`);
        return result(c, 'error', { awaiting: doc, message: fail });
      }
      // Headless: nobody can "Request changes" at the checkpoint, so a phase turn that did not
      // write its document is a failure (exit 1), not a document "waiting for review".
      if (!c.rt.interactive && !docReady(c, doc)) {
        c.trace.push({ state: 'error', doc });
        return result(c, 'error', { awaiting: doc, message: `${SPEC_DOC_FILES[doc]} was not written` });
      }
    }
    const next = nextDoc(c.order, doc);
    if (c.quick && next) {
      if (!docReady(c, doc)) {
        c.trace.push({ state: 'error', doc });
        return result(c, 'error', { awaiting: doc, message: `${SPEC_DOC_FILES[doc]} was not written` });
      }
      doc = next;
      mustDraft = true;
      continue;
    }
    c.trace.push({ state: 'review', doc });
    const d = await checkpoint(c, doc, next);
    switch (d.kind) {
      case 'approve':
        c.trace.push({ state: 'approved', doc });
        if (!next) {
          c.trace.push({ state: 'ready' });
          onReady(c);
          return result(c, 'ready');
        }
        doc = next;
        mustDraft = true;
        continue;
      case 'revise': {
        c.trace.push({ state: 'revising', doc });
        const r = await specTurn(c.rt, specInput(c, revisionPrompt({ file: specDocPath(c.dir, doc), feedback: d.feedback })), restrictionFor(c, doc));
        const fail = turnFailure(r);
        if (fail) {
          c.trace.push({ state: 'error', doc });
          c.rt.print(`✗ Revising ${SPEC_DOC_FILES[doc]} failed: ${fail}`);
          return result(c, 'error', { awaiting: doc, message: fail });
        }
        if (doc === 'tasks') repairTasks(c.rt, c.dir);
        reportDoc(c, doc);
        mustDraft = false;
        continue;
      }
      case 'analyze':
        c.trace.push({ state: 'analyzing', doc });
        await analyzeWithin(c, { autoApply: false });
        mustDraft = false;
        continue;
      case 'editor':
        await c.rt.openEditor?.(specDocPath(c.dir, doc));
        mustDraft = false;
        continue;
      case 'stop': {
        c.trace.push({ state: 'stopped', doc });
        const hint = c.rt.interactive
          ? `Stopped at the ${SPEC_DOC_FILES[doc]} checkpoint. Resume later with ${c.rt.commandPrefix} ${c.name}.`
          : `${SPEC_DOC_FILES[doc]} is waiting for review. Approve with: ${c.rt.commandPrefix} approve ${c.name} · Request changes: ${c.rt.commandPrefix} revise ${c.name} <feedback>`;
        c.rt.print(hint);
        return result(c, 'stopped', { awaiting: doc });
      }
    }
  }
  return result(c, 'error', { message: 'checkpoint loop limit reached' });
}

async function withFinish<T>(rt: SpecRuntime, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } finally {
    await rt.finish();
  }
}

// ───────────────────────────── public flows ─────────────────────────────

/** `/spec new` / `kiro-claude spec new`: create the folder and run the gated phases. */
export async function createNewSpec(rt: SpecRuntime, req: NewSpecRequest): Promise<FlowResult> {
  if (!isValidSpecName(req.name)) return errorResult(req.name, `Invalid spec name '${req.name}'. Use kebab-case, e.g. user-authentication.`);
  if (resolveSpecDir(rt.ws, req.name)) {
    const msg = `Spec '${req.name}' already exists. Resume it with ${rt.commandPrefix} ${req.name}`;
    rt.print(msg);
    return errorResult(req.name, msg);
  }
  const specType = req.kind === 'bugfix' ? 'bugfix' : 'feature';
  const workflowType: WorkflowType = req.kind === 'feature' ? req.workflowType ?? 'requirements-first' : 'requirements-first';
  let dir: string;
  try {
    dir = createSpecFolder(rt.ws, req.name, { specType, workflowType });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    rt.print(`✗ ${msg}`);
    return errorResult(req.name, msg);
  }
  rt.print(`Created ${path.relative(rt.ws.workspaceRoot, dir) || dir}/`);
  const s = summarizeSpecDir(dir);
  const o: Parameters<typeof flowCtx>[2] = { desc: req.description, kind: req.kind, autoApprove: req.autoApprove === true };
  if (req.detail) o.detail = req.detail;
  if (req.useConversation) o.useConversation = true;
  const c = flowCtx(rt, s, o);
  return withFinish(rt, async () => {
    if (c.quick) {
      // a cancelled (Ctrl+C) or failed questions turn ends the flow like a failed phase turn:
      // no document is drafted after it (CLI exit 1)
      const fail = await quickClarify(c);
      if (fail) {
        c.trace.push({ state: 'error' });
        c.rt.print(`✗ Quick Spec clarifying questions failed: ${fail}`);
        return result(c, 'error', { message: fail });
      }
    }
    return phaseLoop(c, c.order[0]!, true);
  });
}

/**
 * Quick Spec clarifying-questions turn (03 §1.10.7); answers feed the requirements prompt.
 * Returns why the turn failed ({@link turnFailure}), else undefined.
 */
async function quickClarify(c: FlowCtx): Promise<string | undefined> {
  if (!c.rt.interactive) {
    c.prompt.clarifications =
      'No clarifying questions were asked (non-interactive run): use your recommended defaults for every open question and state the assumptions in the Introduction.';
    return undefined;
  }
  const r = await specTurn(c.rt, specInput(c, quickQuestionsPrompt({ desc: c.prompt.desc })), { name: 'quick-questions', allowedWritePaths: [] });
  const fail = turnFailure(r);
  if (fail) return fail;
  const ans = (await c.rt.ask('Answer with "1=a, 2=b", your own answers, or "skip":')).trim();
  c.prompt.clarifications =
    ans === '' || ans.toLowerCase() === 'skip' ? 'The user skipped the questions: use your recommended defaults for every open question.' : ans;
  return undefined;
}

export interface ResumeOptions {
  autoApprove?: boolean;
  /** Description used when no document exists yet (else asked interactively). */
  description?: string;
}

function findSpec(rt: SpecRuntime, name: string): SpecSummary | undefined {
  const dir = resolveSpecDir(rt.ws, name);
  return dir ? summarizeSpecDir(dir) : undefined;
}

function notFound(rt: SpecRuntime, name: string): FlowResult {
  const msg = `Spec '${name}' not found in ${path.join(rt.ws.workspaceRoot, '.kiro', 'specs')}. Create it with ${rt.commandPrefix} new ${name}`;
  rt.print(msg);
  return errorResult(name, msg);
}

/** `/spec <name>`: resume at the derived state (03 §1.1, §1.11.2). */
export async function resumeSpec(rt: SpecRuntime, name: string, opts: ResumeOptions = {}): Promise<FlowResult> {
  const s = findSpec(rt, name);
  if (!s) return notFound(rt, name);
  if (s.phase === 'execution' || s.phase === 'done') return stepThroughTasks(rt, s, opts);
  return withFinish(rt, async () => {
    if (s.awaitingApproval) {
      const c = flowCtx(rt, s, { autoApprove: opts.autoApprove === true });
      return phaseLoop(c, s.awaitingApproval, false);
    }
    let desc = opts.description ?? '';
    if (!desc && rt.interactive) desc = (await rt.ask(`What should the spec "${s.name}" cover?`)).trim();
    if (!desc) {
      const msg = `Spec '${s.name}' has no documents yet; a description is needed to draft ${SPEC_DOC_FILES[s.order[0]!]}.`;
      rt.print(msg);
      return errorResult(s.name, msg);
    }
    const c = flowCtx(rt, s, { desc, autoApprove: opts.autoApprove === true });
    return phaseLoop(c, s.order[0]!, true);
  });
}

async function stepThroughTasks(rt: SpecRuntime, s: SpecSummary, opts: ResumeOptions): Promise<FlowResult> {
  const spec = loadSpecDir(s.dir);
  const trace: FlowTransition[] = [];
  const tasks = spec.tasks!;
  const p = taskProgress(tasks);
  rt.print(`${s.name}: ${p.done}/${p.total} tasks done (required ${p.requiredDone}/${p.requiredTotal})`);
  if (!rt.interactive) {
    out(rt, tasks.tasks.map((t) => formatTaskLine(t, tasks.byId)).join('\n'));
    return { status: s.phase === 'done' ? 'ready' : 'stopped', spec: s.name, transitions: trace };
  }
  const next = planTasks(planRun(tasks, { kind: 'next' }))[0];
  const options: { label: string; act: () => Promise<unknown> }[] = [];
  if (next) options.push({ label: `Run next task: ${taskLabel(next)}`, act: () => runSpecTasks(rt, s.name, { kind: 'next' }) });
  if (p.requiredDone < p.requiredTotal) options.push({ label: 'Run all remaining required tasks', act: () => runSpecTasks(rt, s.name, { kind: 'scope', includeOptional: false }) });
  if (p.done < p.total) options.push({ label: 'Run all remaining tasks (include optional *)', act: () => runSpecTasks(rt, s.name, { kind: 'scope', includeOptional: true }) });
  options.push({ label: 'Select tasks…', act: () => selectAndRun(rt, s.name) });
  options.push({
    label: 'Review tasks.md (checkpoint)',
    act: () => withFinish(rt, () => phaseLoop(flowCtx(rt, s, { autoApprove: opts.autoApprove === true }), 'tasks', false)),
  });
  options.push({ label: 'Stop', act: async () => undefined });
  if (s.phase === 'done') rt.print('All required tasks are complete.');
  const i = await rt.choose(`What next for ${s.name}?`, options.map((o) => o.label));
  if (i === undefined || i === options.length - 1) return { status: 'stopped', spec: s.name, transitions: trace };
  const r = await options[i]!.act();
  if (r && typeof r === 'object' && 'transitions' in r) return r as FlowResult;
  return { status: 'ready', spec: s.name, transitions: trace };
}

function taskLabel(t: SpecTask): string {
  return `${t.synthesized ? '' : `${t.id} `}${t.title}`;
}

async function selectAndRun(rt: SpecRuntime, name: string): Promise<RunSummary> {
  const ids = (await rt.ask('Task ids to run (e.g. "2.1 3"):')).trim();
  if (!ids) return { status: 'nothing', outcomes: [], remainingRequired: 0 };
  return runSpecTasks(rt, name, { kind: 'ids', ids: ids.split(/[\s,]+/).filter(Boolean), includeOptional: true });
}

/** `/spec approve [name]`: approve the pending checkpoint, draft the next phase. */
export async function approveSpec(rt: SpecRuntime, name: string, opts: ResumeOptions = {}): Promise<FlowResult> {
  const s = findSpec(rt, name);
  if (!s) return notFound(rt, name);
  if (s.phase === 'execution' || s.phase === 'done') {
    const c = flowCtx(rt, s, {});
    c.trace.push({ state: 'approved', doc: 'tasks' }, { state: 'ready' });
    onReady(c);
    return result(c, 'ready');
  }
  if (!s.awaitingApproval) {
    const msg = `Nothing to approve yet: ${SPEC_DOC_FILES[s.phase]} has not been written.`;
    rt.print(msg);
    return errorResult(s.name, msg);
  }
  const c = flowCtx(rt, s, { autoApprove: opts.autoApprove === true, ...(opts.description ? { desc: opts.description } : {}) });
  c.trace.push({ state: 'approved', doc: s.awaitingApproval });
  return withFinish(rt, () => phaseLoop(c, s.phase as SpecDocKind, true));
}

/** `/spec revise [name] <feedback>`: revise the document under review, then show its checkpoint. */
export async function reviseSpec(rt: SpecRuntime, name: string, feedback: string, opts: ResumeOptions = {}): Promise<FlowResult> {
  const s = findSpec(rt, name);
  if (!s) return notFound(rt, name);
  const doc: SpecDocKind | undefined = s.awaitingApproval ?? (s.phase === 'execution' || s.phase === 'done' ? 'tasks' : undefined);
  if (!doc) {
    const msg = `Nothing to revise yet: ${SPEC_DOC_FILES[s.phase as SpecDocKind]} has not been written.`;
    rt.print(msg);
    return errorResult(s.name, msg);
  }
  if (!feedback.trim()) return errorResult(s.name, 'Feedback is required');
  const c = flowCtx(rt, s, { autoApprove: opts.autoApprove === true });
  return withFinish(rt, async () => {
    c.trace.push({ state: 'revising', doc });
    const r = await specTurn(rt, specInput(c, revisionPrompt({ file: specDocPath(c.dir, doc), feedback })), restrictionFor(c, doc));
    const fail = turnFailure(r);
    if (fail) {
      c.trace.push({ state: 'error', doc });
      rt.print(`✗ Revising ${SPEC_DOC_FILES[doc]} failed: ${fail}`);
      return result(c, 'error', { awaiting: doc, message: fail });
    }
    if (doc === 'tasks') repairTasks(rt, c.dir);
    reportDoc(c, doc);
    return phaseLoop(c, doc, false);
  });
}

// ───────────────────────────── analyze requirements (03 §1.8) ─────────────────────────────

export interface AnalyzeResult {
  status: 'applied' | 'none' | 'reported' | 'dismissed' | 'error';
  findings: AnalysisFinding[];
  answers: FindingAnswer[];
  message?: string;
}

function formatFinding(f: AnalysisFinding, i: number, n: number): string {
  const lines = [`Question ${i}/${n} · ${f.category} · ${f.severity}${f.requirements.length ? ` · requirements ${f.requirements.join(', ')}` : ''}`];
  if (f.explanation) lines.push(f.explanation);
  if (f.question) lines.push(`? ${f.question}`);
  return lines.join('\n');
}

async function analyzeWithin(c: FlowCtx, o: { autoApply: boolean }): Promise<AnalyzeResult> {
  const rt = c.rt;
  const doc: SpecDocKind = c.prompt.specType === 'bugfix' ? 'bugfix' : 'requirements';
  const file = SPEC_DOC_FILES[doc];
  if (!docReady(c, doc)) {
    const msg = `No ${file} yet. Start with ${rt.commandPrefix} new <feature-name>`;
    rt.print(msg);
    return { status: 'error', findings: [], answers: [], message: msg };
  }
  rt.print(`Analyzing ${file}…`);
  const r = await specTurn(rt, specInput(c, analyzePrompt({ dir: c.dir, file })), { name: 'analyze', allowedWritePaths: [] }, { quiet: true });
  const fail = turnFailure(r);
  if (fail) {
    rt.print(`✗ Analysis failed: ${fail}`);
    return { status: 'error', findings: [], answers: [], message: fail };
  }
  const parsed = parseAnalysis(r.text);
  if ('error' in parsed) {
    rt.print(`✗ Could not read the analysis: ${parsed.error}`);
    return { status: 'error', findings: [], answers: [], message: parsed.error };
  }
  const findings = parsed.findings;
  if (findings.length === 0) {
    out(rt, `No issues found in ${file}.`);
    return { status: 'none', findings, answers: [] };
  }
  const answers: FindingAnswer[] = [];
  if (!rt.interactive) {
    out(
      rt,
      findings
        .map((f, i) => `${formatFinding(f, i + 1, findings.length)}\n${f.options.map((op, k) => `  ${String.fromCharCode(97 + k)}. ${op.label}${op.edit && op.edit !== op.label ? ` — ${op.edit}` : ''}`).join('\n')}`)
        .join('\n\n'),
    );
    if (!o.autoApply) return { status: 'reported', findings, answers };
    for (const f of findings) if (f.options[0]) answers.push({ finding: f, resolution: f.options[0].edit });
  } else {
    for (let i = 0; i < findings.length; i++) {
      const f = findings[i]!;
      rt.print(formatFinding(f, i + 1, findings.length));
      const labels = [...f.options.map((op) => op.label), 'Other (type answer)', 'Dismiss (intentional)'];
      const k = await rt.choose(f.question || 'How should this be resolved?', labels);
      if (k === undefined || k === labels.length - 1) continue;
      if (k === labels.length - 2) {
        const own = (await rt.ask('Your answer:')).trim();
        if (own) answers.push({ finding: f, resolution: own });
        continue;
      }
      answers.push({ finding: f, resolution: f.options[k]!.edit });
    }
  }
  if (answers.length === 0) {
    rt.print('All findings dismissed; requirements unchanged.');
    return { status: 'dismissed', findings, answers };
  }
  const r2 = await specTurn(rt, specInput(c, applyFindingsPrompt({ dir: c.dir, file, answers })), restrictionFor(c, doc));
  const fail2 = turnFailure(r2);
  if (fail2) {
    rt.print(`✗ Updating ${file} failed: ${fail2}`);
    return { status: 'error', findings, answers, message: fail2 };
  }
  // re-lint the ids (03 §1.8 step 3)
  const text = fs.readFileSync(specDocPath(c.dir, doc), 'utf8');
  const ids = doc === 'bugfix' ? parseBugfix(text).criteriaIds : parseRequirements(text).criteriaIds;
  const missing = answers.flatMap((a) => a.finding.requirements).filter((id) => !ids.includes(id));
  rt.print(`${file} updated (${ids.length} criteria)`);
  if (missing.length) rt.print(`⚠ Criteria referenced by findings no longer exist: ${[...new Set(missing)].join(', ')}`);
  return { status: 'applied', findings, answers };
}

/** `/spec analyze_requirements <name>`. `autoApply` (CLI `--yes`) applies each finding's first option. */
export async function analyzeRequirements(rt: SpecRuntime, name: string, opts: { autoApply?: boolean } = {}): Promise<AnalyzeResult> {
  const s = findSpec(rt, name);
  if (!s) {
    notFound(rt, name);
    return { status: 'error', findings: [], answers: [], message: `spec '${name}' not found` };
  }
  const c = flowCtx(rt, s, {});
  return withFinish(rt, () => analyzeWithin(c, { autoApply: opts.autoApply === true }));
}

// ───────────────────────────── sync (03 §1.7.4, adapter extension) ─────────────────────────────

/** `/spec sync <name>`: update boxes / add tasks from the code, then show the status diff. */
export async function syncSpec(rt: SpecRuntime, name: string): Promise<{ status: 'ok' | 'error'; changes: string[] }> {
  const s = findSpec(rt, name);
  if (!s) {
    notFound(rt, name);
    return { status: 'error', changes: [] };
  }
  if (!s.docs.tasks.nonEmpty) {
    rt.print(`Spec '${s.name}' has no tasks.md yet.`);
    return { status: 'error', changes: [] };
  }
  const before = parseTasks(fs.readFileSync(s.docs.tasks.path, 'utf8'));
  const c = flowCtx(rt, s, {});
  return withFinish(rt, async () => {
    const r = await specTurn(rt, specInput(c, syncPrompt({ dir: s.dir, ws: rt.ws.workspaceRoot })), restrictionFor(c, 'tasks'));
    const fail = turnFailure(r);
    if (fail) {
      rt.print(`✗ Sync failed: ${fail}`);
      return { status: 'error' as const, changes: [] };
    }
    repairTasks(rt, s.dir);
    const after = parseTasks(fs.readFileSync(s.docs.tasks.path, 'utf8'));
    const changes: string[] = [];
    for (const t of after.tasks) {
      const b = before.byId.get(t.id);
      if (!b) changes.push(`+ ${taskLabel(t)}`);
      else if (b.box !== t.box) changes.push(`${t.id}: [${b.box}] → [${t.box}]`);
    }
    out(rt, changes.length ? changes.join('\n') : 'tasks.md unchanged.');
    return { status: 'ok' as const, changes };
  });
}

// ───────────────────────────── task execution (03 §1.7) ─────────────────────────────

export type TaskOutcomeStatus = 'completed' | 'blocked' | 'failed' | 'interrupted' | 'skipped';

export interface TaskOutcome {
  id: string;
  title: string;
  status: TaskOutcomeStatus;
  reason?: string;
}

export interface RunSummary {
  status: 'completed' | 'stopped' | 'nothing' | 'error';
  outcomes: TaskOutcome[];
  /** Required leaf tasks still incomplete after the run. */
  remainingRequired: number;
  message?: string;
}

export interface RunOptions {
  /** Stop scheduling new tasks; running ones are interrupted. Default: {@link SpecRuntime.signal}. */
  signal?: AbortSignal;
}

function hookStatus(s: TaskOutcomeStatus): 'completed' | 'failed' | 'interrupted' {
  return s === 'completed' ? 'completed' : s === 'interrupted' ? 'interrupted' : 'failed';
}

function printWarnings(rt: SpecRuntime, ws: readonly HookWarning[]): void {
  for (const w of ws) rt.print(w.message);
}

function setBox(rt: SpecRuntime, file: string, t: SpecTask, box: TaskBox): boolean {
  try {
    const r = writeTaskStatus(file, t.id, box, { expectHash: t.textHash });
    if (r.stale) rt.print(`⚠ Task ${t.id} changed in tasks.md since the run started.`);
    return true;
  } catch (e) {
    rt.print(`⚠ ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

async function executeTask(
  rt: SpecRuntime,
  spec: { name: string; dir: string },
  t: SpecTask,
  optional: boolean,
  running: Set<TaskSessionHandle>,
  signal?: AbortSignal,
): Promise<TaskOutcome> {
  const file = specDocPath(spec.dir, 'tasks');
  const info = { specName: spec.name, taskId: t.id, title: t.title, specDir: spec.dir, optional };
  const hooks = rt.taskHooks();
  // the run's Ctrl+C kills a task hook's command with its process group (also with timeout 0 or a
  // command that ignores SIGTERM: hooks/runner.ts), as for `/hooks run` and agentSpawn hooks
  const hctx = hooks ? { ws: rt.ws, sessionId: hooks.sessionId, ...(signal ? { signal } : {}) } : undefined;
  rt.print(`▶ Task ${taskLabel(t)}`);
  let hookPrompts: string[] = [];
  if (hooks && hctx) {
    let pre: Awaited<ReturnType<HookRunnerLike['runTaskHook']>>;
    try {
      pre = await hooks.runner.runTaskHook(hctx, 'PreTaskExec', info);
    } catch (e) {
      // a broken hook runner must not leave the run half-done: report and fail the task (box untouched)
      const reason = `PreTaskExec hooks failed: ${e instanceof Error ? e.message : String(e)}`;
      rt.print(`✗ Task ${t.id} failed: ${reason}`);
      return { id: t.id, title: t.title, status: 'failed', reason };
    }
    printWarnings(rt, pre.warnings);
    // Ctrl+C while the PreTaskExec hooks ran (a killed hook reports neither a block nor a
    // warning): the task never started, so no box change, no task session, no PostTaskExec
    if (signal?.aborted) {
      rt.print(`✗ Task ${t.id} interrupted`);
      return { id: t.id, title: t.title, status: 'interrupted' };
    }
    if (pre.blocked) {
      const reason = (pre.blockReason ?? '').trim() || 'blocked by a PreTaskExec hook';
      rt.print(`⏭ Task ${t.id} skipped: PreTaskExec hook blocked it: ${reason}`);
      return { id: t.id, title: t.title, status: 'skipped', reason };
    }
    hookPrompts = pre.agentPrompts;
  }
  const finishTask = async (o: TaskOutcome, session?: TaskSessionHandle): Promise<TaskOutcome> => {
    try {
      setBox(rt, file, t, o.status === 'completed' ? 'x' : ' ');
      if (hooks && hctx) {
        const postInfo = { ...info, status: hookStatus(o.status) };
        let post: Awaited<ReturnType<HookRunnerLike['runTaskHook']>> | undefined;
        try {
          // A press during the hook kills it. One that already came (it interrupted the task) is
          // not passed on: the hook is meant to run with status `interrupted`, and an aborted
          // signal would skip it before it starts. Such a hook cannot be cancelled (known gap:
          // the REPL exposes no signal for a later press, only the command's, which stays aborted).
          post = await hooks.runner.runTaskHook(signal?.aborted ? { ws: hctx.ws, sessionId: hctx.sessionId } : hctx, 'PostTaskExec', postInfo);
        } catch (e) {
          rt.print(`⚠ PostTaskExec hooks for task ${t.id} failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        if (post) printWarnings(rt, post.warnings);
        if (post && session && post.agentPrompts.length && o.status !== 'interrupted' && !signal?.aborted) {
          try {
            const fr = await session.run({ text: post.agentPrompts.join('\n\n'), skipPromptHooks: true });
            const f = turnFailure(fr);
            if (f) rt.print(`⚠ PostTaskExec follow-up for task ${t.id} failed: ${f}`);
          } catch (e) {
            rt.print(`⚠ PostTaskExec follow-up for task ${t.id} failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
    } finally {
      // the task's child session is always released (no leaked claude processes)
      if (session) {
        running.delete(session);
        await session.close().catch(() => undefined);
      }
    }
    rt.print(o.status === 'completed' ? `✓ Task ${t.id} completed` : `✗ Task ${t.id} ${o.status}${o.reason ? `: ${o.reason}` : ''}`);
    return o;
  };

  if (!setBox(rt, file, t, '-')) return { id: t.id, title: t.title, status: 'failed', reason: 'task is no longer in tasks.md' };
  let session: TaskSessionHandle;
  try {
    // the run's Ctrl+C is the start signal of the task session (session/startSignal.ts, K3): a
    // press while it runs its agentSpawn hooks (which may never end with timeout 0) kills them and
    // cancels the start; a host whose sessions take no start signal just ignores it
    session = await withStartSignal(signal && !signal.aborted ? signal : undefined, () => rt.openTaskSession(`task ${t.id}`));
  } catch (e) {
    // that start was cancelled: the task is interrupted, it did not fail
    if (isSessionStartCancelled(e)) return finishTask({ id: t.id, title: t.title, status: 'interrupted' });
    return finishTask({ id: t.id, title: t.title, status: 'failed', reason: `could not start a session: ${e instanceof Error ? e.message : String(e)}` });
  }
  running.add(session);
  // Ctrl+C / abort while the child was starting (spawning claude takes a while): the abort handler
  // could not interrupt a session it did not know yet, so do not start the turn at all.
  if (signal?.aborted) return finishTask({ id: t.id, title: t.title, status: 'interrupted' }, session);
  const s = summarizeSpecDir(spec.dir);
  const ctxBlock = specContextBlock(rt.ws, s);
  const input: PromptInput = {
    text: taskExecutionPrompt({
      id: t.id,
      title: t.title,
      name: spec.name,
      dir: spec.dir,
      requirementRefs: [...t.requirementRefs, ...t.validates.filter((v) => !t.requirementRefs.includes(v))],
      details: t.details,
      isCheckpoint: t.isCheckpoint,
      hookPrompts,
    }),
    skipPromptHooks: true,
  };
  if (ctxBlock) input.extraContext = [ctxBlock];
  let r: TurnResult;
  try {
    r = await session.run(input);
  } catch (e) {
    return finishTask({ id: t.id, title: t.title, status: 'failed', reason: e instanceof Error ? e.message : String(e) }, session);
  }
  const fail = turnFailure(r);
  if (fail) return finishTask({ id: t.id, title: t.title, status: fail === 'interrupted' ? 'interrupted' : 'failed', ...(fail === 'interrupted' ? {} : { reason: fail }) }, session);
  const sig = parseTaskResult(r.text);
  if (!sig) {
    const reason = /TASK_RESULT:/i.test(r.text)
      ? 'ambiguous TASK_RESULT (expected the final line to be exactly "TASK_RESULT: completed")'
      : 'the task session ended without a TASK_RESULT line';
    return finishTask({ id: t.id, title: t.title, status: 'failed', reason }, session);
  }
  if (sig.status === 'blocked') return finishTask({ id: t.id, title: t.title, status: 'blocked', reason: sig.reason ?? 'blocked' }, session);
  return finishTask({ id: t.id, title: t.title, status: 'completed' }, session);
}

/**
 * `/spec run <name> [scope]` / `kiro-claude spec run`: execute the selected tasks, stopping at
 * the first failure (03 §1.7.2).
 */
export async function runSpecTasks(rt: SpecRuntime, name: string, sel: TaskSelection, opts: RunOptions = {}): Promise<RunSummary> {
  const s = findSpec(rt, name);
  if (!s) {
    notFound(rt, name);
    return { status: 'error', outcomes: [], remainingRequired: 0, message: `spec '${name}' not found` };
  }
  if (!s.docs.tasks.nonEmpty) {
    const msg = `Spec '${s.name}' has no tasks.md yet. Continue the spec with ${rt.commandPrefix} ${s.name}`;
    rt.print(msg);
    return { status: 'error', outcomes: [], remainingRequired: 0, message: msg };
  }
  repairTasks(rt, s.dir);
  const spec: LoadedSpec = loadSpecDir(s.dir);
  const parsed = spec.tasks!;
  const plan = planRun(parsed, sel);
  if (plan.unknownIds.length) {
    const msg = `Unknown task ${plan.unknownIds.length === 1 ? 'id' : 'ids'}: ${plan.unknownIds.join(', ')}`;
    rt.print(msg);
    if (planTasks(plan).length === 0) return { status: 'error', outcomes: [], remainingRequired: taskProgress(parsed).requiredTotal - taskProgress(parsed).requiredDone, message: msg };
  }
  const all = planTasks(plan);
  if (all.length === 0) {
    out(rt, sel.kind === 'scope' && !sel.includeOptional ? 'No remaining required tasks.' : 'No remaining tasks to run.');
    const p = taskProgress(parsed);
    return { status: 'nothing', outcomes: [], remainingRequired: p.requiredTotal - p.requiredDone };
  }
  rt.print(`Running ${all.length} ${all.length === 1 ? 'task' : 'tasks'} of ${s.name}: ${all.map((t) => t.id).join(', ')}`);
  const outcomes: TaskOutcome[] = [];
  const running = new Set<TaskSessionHandle>();
  let stop = false;
  const signal = opts.signal ?? rt.signal;
  const onAbort = (): void => {
    stop = true;
    for (const h of running) void h.interrupt?.().catch(() => undefined);
  };
  if (signal) {
    if (signal.aborted) stop = true;
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    for (const step of plan.steps) {
      if (stop) break;
      const tasks = step.kind === 'wave' ? step.tasks : [step.task];
      const width = step.kind === 'checkpoint' ? 1 : Math.max(1, Math.min(4, Math.floor(rt.maxParallelTasks) || 1));
      let idx = 0;
      const worker = async (): Promise<void> => {
        while (!stop && idx < tasks.length) {
          const t = tasks[idx++]!;
          let o: TaskOutcome;
          try {
            o = await executeTask(rt, spec, t, isOptionalTask(t, parsed.byId), running, signal);
          } catch (e) {
            // never let one task's unexpected error reject the wave while sibling workers keep running
            o = { id: t.id, title: t.title, status: 'failed', reason: e instanceof Error ? e.message : String(e) };
            rt.print(`✗ Task ${t.id} failed: ${o.reason}`);
          }
          outcomes.push(o);
          if (o.status !== 'completed' && o.status !== 'skipped') stop = true;
        }
      };
      await Promise.all(Array.from({ length: Math.min(width, tasks.length) }, () => worker()));
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  const after = taskProgress(parseTasks(fs.readFileSync(s.docs.tasks.path, 'utf8')));
  const remainingRequired = after.requiredTotal - after.requiredDone;
  const count = (st: TaskOutcomeStatus): number => outcomes.filter((o) => o.status === st).length;
  const bad = outcomes.filter((o) => o.status !== 'completed');
  const parts = [`${count('completed')} completed`];
  for (const st of ['blocked', 'failed', 'interrupted', 'skipped'] as const) if (count(st)) parts.push(`${count(st)} ${st}`);
  const lines = [`Spec run finished: ${parts.join(', ')}. ${remainingRequired} required ${remainingRequired === 1 ? 'task remains' : 'tasks remain'}.`];
  for (const b of bad) lines.push(`  ${b.id}: ${b.status}${b.reason ? ` — ${b.reason}` : ''}`);
  if (remainingRequired > 0 || bad.length) lines.push(`Continue with ${rt.commandPrefix} run ${s.name}`);
  out(rt, lines.join('\n'));
  const stopped = bad.some((o) => o.status !== 'skipped') || outcomes.length < all.length;
  return { status: stopped ? 'stopped' : 'completed', outcomes, remainingRequired };
}

// ───────────────────────────── REPL runtime ─────────────────────────────

export interface ReplRuntimeDeps {
  /** Build the task-hook runner from the session's hooks (default hooks/runner HookRunner). */
  hookRunnerFactory?: (hooks: readonly KiroHook[]) => HookRunnerLike;
  /** Override "Open in $EDITOR" (default: $VISUAL/$EDITOR with inherited stdio, if set). */
  openEditor?: ((file: string) => Promise<void>) | null;
}

/** Open a file in $VISUAL / $EDITOR (inherited stdio). undefined when no editor is configured. */
export function editorOpener(env: NodeJS.ProcessEnv): ((file: string) => Promise<void>) | undefined {
  const editor = (env.VISUAL || env.EDITOR || '').trim();
  if (!editor) return undefined;
  return async (file: string) => {
    const argv = shlexSplit(editor) ?? [editor];
    spawnSync(argv[0]!, [...argv.slice(1), file], { stdio: 'inherit', env });
  };
}

/**
 * The REPL's per-command Ctrl+C signal (repl/types.ts ReplContext.commandSignal). ReplHost (the
 * shared contract) does not declare it, so it is read duck-typed; undefined for other hosts.
 */
function commandSignalOf(host: ReplHost): AbortSignal | undefined {
  const s = (host as { commandSignal?: unknown }).commandSignal;
  return s && typeof s === 'object' && typeof (s as AbortSignal).addEventListener === 'function' && 'aborted' in s ? (s as AbortSignal) : undefined;
}

/**
 * SpecRuntime over a ReplHost: questions through ask/confirm/choose, turns through runTurn (full
 * REPL rendering and y/n/t approvals), task sessions via host.createSession + replaceSession
 * (restored afterwards), one task at a time; the REPL command's Ctrl+C signal stops task runs,
 * cancels a spec turn whose phase session is still starting, and is the start signal of every
 * session this runtime creates (a press while one runs its agentSpawn hooks cancels that start).
 */
export function createReplRuntime(host: ReplHost, deps: ReplRuntimeDeps = {}): SpecRuntime & { readonly driver: SpecSessionDriver } {
  /**
   * Create a session under the command's Ctrl+C as its start signal (K3, session/startSignal.ts):
   * a press while it runs its agentSpawn hooks (which may never end with timeout 0) kills them and
   * cancels the start. Not a press an earlier step of the command handled (the signal stays
   * aborted; it would cancel every later start at once).
   */
  const createUnderPress = (o: Partial<KiroSessionOptions>): Promise<KiroSession> => {
    const sig = commandSignalOf(host);
    return withStartSignal(sig && !sig.aborted ? sig : undefined, () => host.createSession(o));
  };
  const port: SessionPort = {
    active: () => host.session,
    // phase sessions and the continuation (a cancelled continuation start gives the chat its own
    // session back, SpecSessionDriver.finish)
    create: createUnderPress,
    activate: (s) => host.replaceSession(s),
    run: (_s, input) => host.runTurn(input),
  };
  const driver = new SpecSessionDriver(port, { phaseOptions: { origin: 'spec' }, finalOptions: {} });
  const factory = deps.hookRunnerFactory ?? ((hooks: readonly KiroHook[]) => new HookRunner([...hooks]));
  const editor = deps.openEditor === null ? undefined : deps.openEditor ?? editorOpener(host.ws.env);
  const rt: SpecRuntime & { readonly driver: SpecSessionDriver } = {
    driver,
    ws: host.ws,
    settings: host.settings,
    interactive: true,
    commandPrefix: '/spec',
    maxParallelTasks: 1,
    get signal() {
      return commandSignalOf(host);
    },
    print: (t) => host.print(t),
    ask: (q) => host.ask(q),
    confirm: (q, d) => host.confirm(q, d),
    choose: (q, o) => host.choose(q, o),
    runSpecTurn(input, phase, o) {
      // The command's Ctrl+C signal when this turn was requested and not aborted yet: a press while
      // the driver starts the turn's phase session (Claude Code spawning) cancels the turn before
      // it is sent. A press an earlier turn handled does not cancel the later ones.
      const sig = commandSignalOf(host);
      return driver.runTurn(input, phase, { ...o, ...(sig && !sig.aborted ? { signal: sig } : {}) });
    },
    async openTaskSession(): Promise<TaskSessionHandle> {
      const prev = host.session;
      // created under the run's start signal (executeTask), the command's Ctrl+C by default
      const child = await host.createSession({ origin: 'spec' });
      let closed = false;
      return {
        get sessionId() {
          return child.id;
        },
        async run(input: PromptInput): Promise<TurnResult> {
          host.replaceSession(child);
          try {
            return await host.runTurn(input);
          } finally {
            host.replaceSession(prev);
          }
        },
        interrupt: () => child.interrupt(),
        async close(): Promise<void> {
          if (closed) return;
          closed = true;
          if (host.session === child) host.replaceSession(prev);
          await child.close();
        },
      };
    },
    taskHooks() {
      const s = host.session;
      const hooks = s.hooks();
      if (!hooks.some((h) => h.trigger === 'PreTaskExec' || h.trigger === 'PostTaskExec')) return undefined;
      return { runner: factory(hooks), sessionId: s.id };
    },
    finish: () => driver.finish('keep'),
  };
  if (editor) rt.openEditor = editor;
  return rt;
}

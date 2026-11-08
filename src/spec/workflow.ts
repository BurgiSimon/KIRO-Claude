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
 *    still its source's). Every session the driver creates (phase sessions, the continuation)
 *    starts from the trust and plan mode of the session it continues as the chat has them, every
 *    `/spec run` task session from the chat's trust (KiroSessionOptions.initialTrust: `/tools untrust`, a revoked agent tool,
 *    a `t` answer hold; never the launch `--trust-tools` / agent allowedTools again, T1), so a
 *    Shift+Tab or `t` while a phase session is the chat's reaches the continuation. Phase sessions
 *    of a plan-mode chat run in plan mode (the prompt shows `[plan]`): the gate denies every
 *    mutating tool except writes of the phase's own documents (policy/gate.ts, T2), and the turn
 *    says so ({@link specPlanModeBlock}). `/spec run` in plan mode is refused (Kiro's plan mode is
 *    the read-only planner, T3); a spec command that would hand over a continuation is refused
 *    inside a tangent with messages of its own (it would replace the tangent; an empty one is left
 *    first, slash.ts, T4). When a flow ends, the records of its
 *    phase sessions that a later session holds in full are removed (T5,
 *    {@link SpecSessionDriver.finish}). The REPL runtime creates
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
 *    A REPL task session starts from the chat's trust (T1). While its task runs it is the chat's:
 *    a restriction the user adds there (Shift+Tab into plan mode, `/tools untrust` at its approval
 *    prompt) carries back to the chat when the task hands it back, so it holds for the later tasks,
 *    and a run in which plan mode came on starts no further task (T3). Trust given in it with `t`
 *    stays in that task session (the next task and the chat start from the chat's: known gap, only
 *    ever more restrictive than Kiro, whose tasks run in the chat itself). The run's signal (Ctrl+C) stops scheduling, interrupts running task sessions, kills running
 *    task hook commands (with their process groups, also with timeout 0) and cancels a task
 *    session start whose agentSpawn hooks run. A press during PreTaskExec ⇒ the task is
 *    `interrupted` before its box or a session is touched (no PostTaskExec). The PostTaskExec of
 *    an interrupted task still runs (status `interrupted`), not under the already aborted signal
 *    but under the host's NEXT press (SpecRuntime.nextPressSignal; REPL ReplContext.nextPressSignal):
 *    a second Ctrl+C kills it. Likewise the REPL runtime starts a phase session or the
 *    continuation that comes after a press under the next press (r5 P1); a cancelled
 *    continuation start gives the chat its own session back with a notice.
 *  - Spec files are read and written only through spec/docfs.ts (review X1): a document that is a
 *    symbolic link, not a regular file, behind a link that resolves to nothing or to a target that
 *    cannot be accessed, outside the workspace, or that the user cannot read (or in a folder it
 *    cannot enter: r7 #6, never taken for a missing document) is never read or written by the
 *    workflow itself (the tasks.md repair, box updates,
 *    re-lint, sync diff, task context). Such a "refused" document is never drafted (`✗ Cannot
 *    draft …`); its checkpoint names the reason and offers no Approve (headless: the flow ends with
 *    an error); a revision turn still runs (the gate denies its write through the link, with the
 *    reason). The same holds for every phase of a spec with ANY refused file (an input document
 *    such as requirements.md, or `.config.kiro`, whose type and workflow kiro-claude then does
 *    not know): no phase is drafted from it, every checkpoint names each reason and offers no
 *    Approve, and `approve` refuses. `analyze` with a refused phase-1 document (the one file it
 *    reads), and `sync` (it builds on requirements and design too) and `run` of a spec with any
 *    refused file are refused before any turn; a
 *    task fails with the reason when a spec file became refused during the run (before its box
 *    is touched, while its session started, or when its context is read: store.specContextBlock
 *    reports it, so its context never silently lacks a document; a box that cannot be ticked
 *    fails it too, and the target is left alone). A box that cannot be marked in progress for
 *    another reason (a spec folder the user cannot write) fails the task with that error, never
 *    "task is no longer in tasks.md". A named spec that
 *    is not found under a `.kiro/specs` kiro-claude does not use or cannot list
 *    (store.specsDirRefused) gets that refusal, never "not found … Create it with … new" (r7 #7).
 *  - Resume hints (the checkpoint's Stop label and stop hint, `new` on an existing spec, `run` and
 *    `analyze` without their document) come from {@link SpecRuntime.resumeHint}: `/spec <name>` in
 *    the REPL, commands it accepts in the spec CLI (r7 #8).
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
import { cloneTrust } from '../policy/gate.js';
import { journalPath } from '../session/kiroFiles.js';
import { isSessionStartCancelled, withStartSignal } from '../session/startSignal.js';
import { SessionStore, sessionsDir } from '../session/store.js';
import { shlexSplit } from '../util/shlex.js';
import { SpecFileRefusedError, readSpecFile, specRefusalText, writeSpecFile } from './docfs.js';
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
  specPlanModeBlock,
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
  specRefusals,
  specsDirRefused,
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

/** `/spec run` in plan mode (T3), followed by how to leave it. */
export const PLAN_MODE_RUN_REFUSED = 'Plan mode is read-only: running spec tasks implements code (it edits files and runs commands).';

/**
 * A spec command that hands the chat a continuation, run inside a tangent that has something of
 * its own (T4): the continuation would replace the tangent, so `/tangent` could no longer return
 * to the main conversation. Same shape as Q's `Checkpoint is disabled while in tangent mode`
 * (06 §6.4).
 */
export const SPEC_IN_TANGENT_REFUSED =
  '⚠️ Spec drafting is disabled while in tangent mode: its spec conversation would replace this tangent. Return to the main conversation first (/tangent, or /tangent merge to keep what this tangent found), then run the /spec command again.';

/** A spec command run in a tangent that has no message of its own left it first (T4). */
export const SPEC_TANGENT_LEFT = 'Left the tangent (↯): it had no messages of its own, so the spec continues the main conversation.';

/** The failure a spec turn reports when its phase session would fork a tangent (T4 backstop). */
export const SPEC_IN_TANGENT_ERROR = 'spec drafting is disabled while in tangent mode (return to the main conversation with /tangent first)';

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
  /**
   * A signal the host's NEXT Ctrl+C aborts (REPL: ReplContext.nextPressSignal; spec CLI: its
   * NextPress, spec/cli.ts), for work that runs after {@link signal} fired and stays aborted: the
   * PostTaskExec hooks of an interrupted task. Absent (the spec CLI's other commands, which run
   * no tasks; test runtimes): such work runs without a signal.
   */
  nextPressSignal?(): AbortSignal | undefined;
  /**
   * The chat is in plan mode (REPL `/plan`, Shift+Tab; the CLI has none): Kiro's plan mode is the
   * read-only planner, so task execution, which implements code, is refused (T3); the spec phases
   * still run, writing only their documents.
   */
  readonly planMode?: boolean;
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
  /**
   * The command(s) that resume spec `name` from where it stands, for the checkpoint's Stop label
   * and stop hint, `new` on an existing spec, `run` and `analyze` without the document they need
   * (r7 #8). Default `${commandPrefix} <name>` (the REPL's `/spec <name>`); the spec CLI, which has
   * no such form, names commands it accepts (spec/cli.ts).
   */
  resumeHint?(name: string): string;
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
  /**
   * Remove the saved record of a closed phase session whose conversation a later session of the
   * flow holds in full (its turns and journal copied into that session's record): the duplicate
   * would only clutter `--list-sessions` ({@link SpecSessionDriver.finish}). Absent: records stay.
   */
  discard?(s: KiroSession): void | Promise<void>;
}

/**
 * {@link SessionPort.discard} over the session index: delete the record `id` (index file, lock,
 * journal) when it is a spec-phase record (origin `spec`, never a tangent / rewind) that no live
 * process holds open (this one included). The Claude transcript is never touched: a later
 * session's pending fork may still start from it. True when it was removed.
 */
export function discardSpecRecord(ws: WorkspaceContext, id: string): boolean {
  try {
    const store = new SessionStore(sessionsDir(ws));
    const rec = store.read(id);
    if (!rec || rec.origin !== 'spec' || rec.forkKind !== 'main') return false;
    if (store.lockInfo(id)?.live) return false;
    if (!store.delete(id)) return false;
    fs.rmSync(journalPath(store.dir, id), { force: true });
    return true;
  } catch {
    return false;
  }
}

/** Every turn `s`'s record holds is in `keeper`'s record too (a fork carries its parent's turns, K1). */
function recordHolds(keeper: KiroSession, s: KiroSession): boolean {
  const own = s.record?.turns ?? [];
  const kept = new Set((keeper.record?.turns ?? []).map((t) => t.userUuid));
  return own.length > 0 && own.every((t) => kept.has(t.userUuid));
}

/**
 * The trust a session that continues `prev` starts from (KiroSessionOptions.initialTrust): `prev`'s
 * as the chat has it (`/tools untrust`, a revoked agent tool, `t` answers, other agents' trust),
 * never the launch `--trust-tools` / agent allowedTools again.
 */
function trustOf(prev: KiroSession): KiroSessionOptions['initialTrust'] | undefined {
  const t = prev.trust;
  if (!t) return undefined;
  return { trust: cloneTrust(t), ...(prev.agent?.name ? { agent: prev.agent.name } : {}) };
}

/**
 * `to` gets back the chat while `from` (a task session, or a phase session whose flow hands no
 * continuation over) was the chat's: the restrictions the user added in `from` apply to `to` too,
 * through its public trust methods (KiroSession has no SessionTrust setter): trust-all turned off,
 * a tool `from` no longer trusts or has revoked (`/tools untrust` typed at an approval prompt,
 * `/tools reset`) untrusted, and plan mode turned on. Trust `from` gained (a `t` answer) is not
 * copied back: only ever more restrictive than the user set. Per-tool trust only when both run the
 * same agent (the flat fields are that agent's).
 */
function carryRestrictions(from: KiroSession, to: KiroSession): void {
  if (from === to) return;
  if (from.planMode && !to.planMode) to.planMode = true;
  const f = from.trust;
  const t = to.trust;
  if (!f || !t) return;
  if (t.trustAll && !f.trustAll) to.setTrustAll(false);
  if (from.agent?.name !== to.agent?.name) return;
  const kept = new Set(f.allowedTools ?? []);
  const revokedHere = new Set(t.revokedTools ?? []);
  const names = new Set<string>();
  for (const n of t.allowedTools ?? []) if (!kept.has(n)) names.add(n);
  for (const n of f.revokedTools ?? []) if (!revokedHere.has(n)) names.add(n);
  if (names.size) to.untrustTools([...names]);
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
  /** See {@link continuationCancelled} (r5 P1). */
  private handOverCancelled = false;
  /** The sessions this driver created that a turn of this flow reached, in order (T5). */
  private readonly reachedSessions: KiroSession[] = [];

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
        return await this.port.run(s, withPlanNote(s, input, phase), opts);
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
      return await this.port.run(s, withPlanNote(s, input, phase), opts);
    } finally {
      if (recordedTurns(s) > before) {
        this.reached = true;
        if (!this.reachedSessions.includes(s)) this.reachedSessions.push(s);
      }
    }
  }

  /**
   * A new session forking `prev`'s conversation, made active. It starts with `prev`'s trust
   * (KiroSessionOptions.initialTrust) and plan mode (`init.planMode` overrides that), set before the
   * host sees it: the chat's as it is, never the launch flags again (a `/tools untrust`, a revoked
   * agent tool, a `t` answer in an earlier phase session hold; the prompt shows the true plan mode).
   */
  private async fork(prev: KiroSession | undefined, extra: Partial<KiroSessionOptions>, init: { planMode?: boolean } = {}): Promise<KiroSession> {
    const o: Partial<KiroSessionOptions> = { ...extra };
    const trust = prev && !o.initialTrust ? trustOf(prev) : undefined;
    if (trust) o.initialTrust = trust;
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
    // a phase session of a plan-mode chat runs in plan mode too: the gate still lets it write the
    // phase's own spec documents, nothing else (policy/gate.ts, T2)
    const plan = init.planMode ?? prev?.planMode;
    if (plan !== undefined && next.planMode !== plan) next.planMode = plan;
    if (prev && !this.created.has(prev) && this.original === undefined) this.original = prev;
    this.port.activate(next);
    if (prev && this.created.has(prev)) {
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
   * stays (nothing to carry). The continuation takes the plan mode and trust of the session it
   * replaces: the chat's as they are at the end of the flow (every phase session starts with those
   * of the session it replaced, so a Shift+Tab or a `t` answer while one was the chat's carries on;
   * r4 #0, T1/T2); an original the host gets back takes that plan mode and the restrictions the
   * user added meanwhile (trust-all off, a `/tools untrust`: {@link carryRestrictions}; trust a
   * phase session gained is not copied back: only ever more restrictive). Then, and for `close`, close every
   * session this driver created, the host never left on one of them, and remove the records of
   * the phase sessions a later session holds in full ({@link discardSuperseded}, T5).
   * {@link continuationCancelled} tells whether the continuation's start was cancelled.
   */
  async finish(mode: 'keep' | 'close'): Promise<void> {
    this.handOverCancelled = false;
    const active = this.port.active();
    // the plan mode the chat shows at the end of the flow (the prompt's `[plan]`): the session it
    // is in, a phase session that started with the plan mode of the one it replaced
    const shown = active && this.created.has(active) ? active : this.original;
    const planMode = shown?.planMode === true;
    const giveBack = (s: KiroSession): void => {
      // a revocation the user made while a phase session was the chat's (`/tools untrust` at its
      // approval prompt) holds for the session the chat gets back; trust it gained does not
      if (shown && shown !== s) carryRestrictions(shown, s);
      if (s.planMode !== planMode) s.planMode = planMode;
      this.port.activate(s);
    };
    let keeper: KiroSession | undefined;
    if (mode === 'keep' && active && this.restricted && this.restricted.session === active && (this.reached || !this.original)) {
      this.restricted = undefined;
      try {
        const next = await this.fork(active, { ...this.opts.finalOptions }, { planMode });
        this.created.delete(next); // handed over to the host
        keeper = next;
        if (this.replacedOriginal && this.original) await this.original.close().catch(() => undefined);
      } catch (e) {
        // could not fork a continuation: give the host its original session back
        if (this.original) giveBack(this.original);
        if (isSessionStartCancelled(e)) this.handOverCancelled = true;
      }
    } else if (active && this.created.has(active) && this.original) {
      giveBack(this.original);
    }
    for (const s of this.created) await s.close().catch(() => undefined);
    this.created.clear();
    await this.discardSuperseded(keeper);
    this.restricted = undefined;
    this.original = undefined;
    this.replacedOriginal = false;
    this.reached = false;
  }

  /**
   * The last {@link finish} could not hand the continuation over because its start was cancelled
   * (a Ctrl+C while it ran its agentSpawn hooks: the command's press or, after one, the next press;
   * r5 P1): the chat has its original session back, nothing half-started is current.
   */
  get continuationCancelled(): boolean {
    return this.handOverCancelled;
  }

  /**
   * T5: remove the saved records of this flow's phase sessions that a later session holds in full
   * (each phase session forks the last one a turn reached, and its record carries that one's turns
   * and journal, K1/S1): with a continuation (`keeper`, the user's chat) every one of them, else
   * all but the last a turn reached, which keeps the spec conversation (the CLI's `close`; a
   * continuation that could not be made). All are closed by now; their Claude transcripts stay (a
   * pending fork of the keeper may start from one). The chat's own records are never touched.
   */
  private async discardSuperseded(keeper: KiroSession | undefined): Promise<void> {
    const reached = this.reachedSessions.splice(0);
    const discard = this.port.discard;
    if (!discard) return;
    const holder = keeper ?? reached.pop();
    if (!holder) return;
    for (const s of reached) {
      if (s === holder || !recordHolds(holder, s)) continue;
      try {
        await discard.call(this.port, s);
      } catch {
        // best effort: a duplicate record is clutter, not harm
      }
    }
  }
}

/**
 * The phase turn's input, with the {@link specPlanModeBlock} when `s` is in plan mode: the
 * `<kiro-plan-mode>` block every plan-mode turn carries says "do not write files", but the phase's
 * spec documents may be written (the gate allows exactly those, T2).
 */
function withPlanNote(s: KiroSession, input: PromptInput, phase: SpecPhaseRestriction): PromptInput {
  if (!s.planMode || phase.allowedWritePaths.length === 0) return input;
  return { ...input, extraContext: [...(input.extraContext ?? []), specPlanModeBlock(phase.allowedWritePaths)] };
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
  /** The refusal {@link reportDoc} just printed (the checkpoint after it does not repeat it). */
  reported?: string | undefined;
}

/** Why kiro-claude does not read or write document `doc` of the spec folder `dir` (docfs), else undefined. */
function docRefusal(dir: string, doc: SpecDocKind): string | undefined {
  return summarizeSpecDir(dir).docs[doc].refused;
}

/**
 * The first reason kiro-claude does not read some file of the spec folder `dir` (its folder,
 * `.config.kiro`, any document: docfs), else undefined. A phase is never drafted then: its
 * prompt has the model build on the other documents (and the spec's type and workflow come from
 * `.config.kiro`), which kiro-claude could not vouch for.
 */
function specRefusal(dir: string): string | undefined {
  return summarizeSpecDir(dir).refused;
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

/**
 * Normalize tasks.md after a turn that may have written it (03 §1.6.6). A refused tasks.md (a
 * symbolic link, …: docfs) is neither read nor written; the reason is printed.
 */
function repairTasks(rt: SpecRuntime, dir: string): void {
  const file = specDocPath(dir, 'tasks');
  let text: string | undefined;
  try {
    text = readSpecFile(file);
  } catch (e) {
    if (e instanceof SpecFileRefusedError) rt.print(`⚠ tasks.md was not repaired: ${e.message}`);
    return;
  }
  if (text === undefined) return;
  const n = normalizeTasksText(text);
  if (n.changedLines > 0 && n.text !== text) {
    try {
      writeSpecFile(file, n.text);
      rt.print(repairMessage('tasks.md', n.changedLines));
    } catch (e) {
      // leave it
      if (e instanceof SpecFileRefusedError) rt.print(`⚠ tasks.md was not repaired: ${e.message}`);
    }
  }
}

/** The document has content kiro-claude may read (false for a refused one). */
function docReady(c: FlowCtx, doc: SpecDocKind): boolean {
  const s = summarizeSpecDir(c.dir);
  return s.docs[doc].nonEmpty;
}

/** Why the flow cannot go on with `doc` that is not ready: its refusal, else "<file> was not written". */
function notWritten(c: FlowCtx, doc: SpecDocKind): string {
  const why = docRefusal(c.dir, doc);
  return why ? specRefusalText(why) : `${SPEC_DOC_FILES[doc]} was not written`;
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
  const why = docRefusal(c.dir, doc);
  if (why) {
    c.rt.print(`⚠ ${specRefusalText(why)}`);
    c.reported = why;
    return;
  }
  if (!docReady(c, doc)) {
    c.rt.print(`⚠ ${file} was not written (expected at ${specDocPath(c.dir, doc)}).`);
    return;
  }
  const spec = loadSpecDir(c.dir);
  c.rt.print(`${file} ready (${docSummary(spec, doc)})`);
}

type CheckpointDecision = { kind: 'approve' } | { kind: 'revise'; feedback: string } | { kind: 'analyze' } | { kind: 'editor' } | { kind: 'stop' };

async function checkpoint(c: FlowCtx, doc: SpecDocKind, next: SpecDocKind | undefined): Promise<CheckpointDecision> {
  // a refused document (docfs) is not ready: no Approve, Analyze or $EDITOR; the reason is shown.
  // Any other refused file of the spec (an input document, `.config.kiro`) is named too and
  // withholds Approve: the next phase would be drafted from it.
  const exists = docReady(c, doc);
  const whys = specRefusals(summarizeSpecDir(c.dir));
  if (!c.rt.interactive) {
    if (c.autoApprove && exists && whys.length === 0) return { kind: 'approve' };
    return { kind: 'stop' };
  }
  for (const why of whys) if (c.reported !== why) c.rt.print(`⚠ ${specRefusalText(why)}`);
  c.reported = undefined;
  const options: { label: string; d: CheckpointDecision['kind'] }[] = [];
  if (exists && whys.length === 0) options.push({ label: approveLabel(doc, next), d: 'approve' });
  options.push({ label: 'Request changes…', d: 'revise' });
  if (exists && (doc === 'requirements' || doc === 'bugfix')) options.push({ label: 'Analyze requirements', d: 'analyze' });
  if (exists && c.rt.openEditor) options.push({ label: 'Open in $EDITOR', d: 'editor' });
  options.push({ label: `Stop here (resume later with ${resumeHint(c.rt, c.name)})`, d: 'stop' });
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

/** {@link SpecRuntime.resumeHint}, else `${commandPrefix} <name>`. */
function resumeHint(rt: SpecRuntime, name: string): string {
  return rt.resumeHint ? rt.resumeHint(name) : `${rt.commandPrefix} ${name}`;
}

function readyHint(c: FlowCtx): string {
  if (c.rt.readyHint) return c.rt.readyHint(c.name);
  return `Spec ready. Run all tasks: ${c.rt.commandPrefix} run ${c.name} · Step through: ${c.rt.commandPrefix} ${c.name}`;
}

function onReady(c: FlowCtx): void {
  const spec = loadSpecDir(c.dir);
  for (const i of spec.lint) c.rt.print(`⚠ ${i.message}`);
  // a refused file (docfs): `run` will refuse the spec, say why now
  for (const why of specRefusals(spec)) c.rt.print(`⚠ ${specRefusalText(why)}`);
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
      // never draft over a document kiro-claude does not read (a symbolic link, …: docfs), nor
      // from a spec with any other such file ({@link specRefusal})
      const now = summarizeSpecDir(c.dir);
      const refused = now.docs[doc].refused ?? now.refused;
      if (refused) {
        c.trace.push({ state: 'error', doc });
        c.rt.print(`✗ Cannot draft ${SPEC_DOC_FILES[doc]}: ${specRefusalText(refused)}`);
        return result(c, 'error', { awaiting: doc, message: refused });
      }
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
        return result(c, 'error', { awaiting: doc, message: notWritten(c, doc) });
      }
    }
    const next = nextDoc(c.order, doc);
    if (c.quick && next) {
      if (!docReady(c, doc)) {
        c.trace.push({ state: 'error', doc });
        return result(c, 'error', { awaiting: doc, message: notWritten(c, doc) });
      }
      doc = next;
      mustDraft = true;
      continue;
    }
    // Headless: a document kiro-claude does not read cannot be reviewed or approved (exit 1),
    // nor one of a spec with any other such file
    const refused = c.rt.interactive ? undefined : (docRefusal(c.dir, doc) ?? specRefusal(c.dir));
    if (refused) {
      c.trace.push({ state: 'error', doc });
      if (c.reported !== refused) c.rt.print(`✗ ${specRefusalText(refused)}`);
      return result(c, 'error', { awaiting: doc, message: refused });
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
          ? `Stopped at the ${SPEC_DOC_FILES[doc]} checkpoint. Resume later with ${resumeHint(c.rt, c.name)}.`
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
    const msg = `Spec '${req.name}' already exists. Resume it with ${resumeHint(rt, req.name)}`;
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

/**
 * `name` was not found: "not found … Create it with … new", or, under a `.kiro/specs` kiro-claude
 * does not use or cannot list (store.specsDirRefused: linked out of the workspace, dangling, into
 * a folder the user cannot enter, …), that refusal (r7 #7): the spec may well exist there, and
 * `new` would refuse.
 */
function notFound(rt: SpecRuntime, name: string): FlowResult {
  return errorResult(name, reportNotFound(rt, name).msg);
}

/** Print why `name` was not found ({@link notFound}); `dirWhy`: the `.kiro/specs` refusal. */
function reportNotFound(rt: SpecRuntime, name: string): { msg: string; dirWhy?: string } {
  const dirWhy = specsDirRefused(rt.ws);
  if (dirWhy) {
    rt.print(`✗ ${specRefusalText(dirWhy)}`);
    return { msg: dirWhy, dirWhy };
  }
  const msg = `Spec '${name}' not found in ${path.join(rt.ws.workspaceRoot, '.kiro', 'specs')}. Create it with ${rt.commandPrefix} new ${name}`;
  rt.print(msg);
  return { msg };
}

/** The `message` of a run/analyze/sync result whose spec is not found (printed by {@link reportNotFound}). */
function notFoundMessage(rt: SpecRuntime, name: string): string {
  return reportNotFound(rt, name).dirWhy ?? `spec '${name}' not found`;
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
    // a first document kiro-claude does not read (its folder linked out of the workspace, …), or
    // a spec with any other such file (`.config.kiro`: its type and workflow are unknown), is
    // never drafted: say so before asking what the spec covers
    const refused = s.docs[s.order[0]!].refused ?? s.refused;
    if (refused) {
      const msg = `✗ Cannot draft ${SPEC_DOC_FILES[s.order[0]!]}: ${specRefusalText(refused)}`;
      rt.print(msg);
      return errorResult(s.name, refused);
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
  // a file kiro-claude does not read (docfs): running tasks is refused (runSpecTasks), say why now
  for (const why of specRefusals(spec)) rt.print(`⚠ ${specRefusalText(why)}`);
  if (!spec.tasks) return errorResult(s.name, spec.refused ?? 'tasks.md could not be read');
  const tasks = spec.tasks;
  const p = taskProgress(tasks);
  rt.print(`${s.name}: ${p.done}/${p.total} tasks done (required ${p.requiredDone}/${p.requiredTotal})`);
  if (!rt.interactive) {
    out(rt, tasks.tasks.map((t) => formatTaskLine(t, tasks.byId)).join('\n'));
    return { status: s.phase === 'done' ? 'ready' : 'stopped', spec: s.name, transitions: trace };
  }
  const next = planTasks(planRun(tasks, { kind: 'next' }))[0];
  const options: { label: string; act: () => Promise<unknown> }[] = [];
  // a refused file: runSpecTasks would refuse every run, so none is offered (the review is)
  const runnable = !spec.refused;
  if (runnable && next) options.push({ label: `Run next task: ${taskLabel(next)}`, act: () => runSpecTasks(rt, s.name, { kind: 'next' }) });
  if (runnable && p.requiredDone < p.requiredTotal) options.push({ label: 'Run all remaining required tasks', act: () => runSpecTasks(rt, s.name, { kind: 'scope', includeOptional: false }) });
  if (runnable && p.done < p.total) options.push({ label: 'Run all remaining tasks (include optional *)', act: () => runSpecTasks(rt, s.name, { kind: 'scope', includeOptional: true }) });
  if (runnable) options.push({ label: 'Select tasks…', act: () => selectAndRun(rt, s.name) });
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
    // a spec file kiro-claude does not read (its folder a dangling link, …: docfs) is the reason,
    // not a document "not written yet"
    const msg = s.refused ? `✗ Spec '${s.name}' cannot continue: ${specRefusalText(s.refused)}` : `Nothing to approve yet: ${SPEC_DOC_FILES[s.phase]} has not been written.`;
    rt.print(msg);
    return errorResult(s.name, s.refused ?? msg);
  }
  // a document kiro-claude does not read (a symbolic link, …: docfs) is never approved, nor one
  // of a spec with any other such file: the next phase would be drafted from it
  const refused = s.docs[s.awaitingApproval].refused ?? s.refused;
  if (refused) {
    rt.print(`✗ Cannot approve ${SPEC_DOC_FILES[s.awaitingApproval]}: ${specRefusalText(refused)}`);
    return errorResult(s.name, refused);
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
    const msg = s.refused
      ? `✗ Spec '${s.name}' cannot continue: ${specRefusalText(s.refused)}`
      : `Nothing to revise yet: ${SPEC_DOC_FILES[s.phase as SpecDocKind]} has not been written.`;
    rt.print(msg);
    return errorResult(s.name, s.refused ?? msg);
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
  const refused = docRefusal(c.dir, doc);
  if (refused) {
    const msg = `✗ Cannot analyze ${file}: ${specRefusalText(refused)}`;
    rt.print(msg);
    return { status: 'error', findings: [], answers: [], message: refused };
  }
  if (!docReady(c, doc)) {
    const msg = `No ${file} yet. Continue the spec with ${resumeHint(rt, c.name)}`;
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
  // re-lint the ids (03 §1.8 step 3); never through a link the turn left there (docfs)
  let text: string;
  try {
    const t = readSpecFile(specDocPath(c.dir, doc));
    if (t === undefined) throw new Error(`${file} no longer exists`);
    text = t;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    rt.print(`✗ Could not re-read ${file}: ${msg}`);
    return { status: 'error', findings, answers, message: msg };
  }
  const ids = doc === 'bugfix' ? parseBugfix(text).criteriaIds : parseRequirements(text).criteriaIds;
  const missing = answers.flatMap((a) => a.finding.requirements).filter((id) => !ids.includes(id));
  rt.print(`${file} updated (${ids.length} criteria)`);
  if (missing.length) rt.print(`⚠ Criteria referenced by findings no longer exist: ${[...new Set(missing)].join(', ')}`);
  return { status: 'applied', findings, answers };
}

/** `/spec analyze_requirements <name>`. `autoApply` (CLI `--yes`) applies each finding's first option. */
export async function analyzeRequirements(rt: SpecRuntime, name: string, opts: { autoApply?: boolean } = {}): Promise<AnalyzeResult> {
  const s = findSpec(rt, name);
  if (!s) return { status: 'error', findings: [], answers: [], message: notFoundMessage(rt, name) };
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
  // tasks.md kiro-claude does not read (a symbolic link, …: docfs): nothing to compare or repair
  const read = (): string | { error: string } => {
    try {
      return readSpecFile(s.docs.tasks.path) ?? { error: 'tasks.md no longer exists' };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  };
  // nor a spec with any other such file: the sync turn compares tasks.md "with requirements/design"
  // and adds tasks for their uncovered criteria (prompts.syncPrompt), so it builds on them
  const refused = s.docs.tasks.refused ?? s.refused;
  if (refused) {
    rt.print(`✗ Cannot sync tasks.md: ${specRefusalText(refused)}`);
    return { status: 'error', changes: [] };
  }
  if (!s.docs.tasks.nonEmpty) {
    rt.print(`Spec '${s.name}' has no tasks.md yet.`);
    return { status: 'error', changes: [] };
  }
  const t0 = read();
  if (typeof t0 !== 'string') {
    rt.print(`✗ Cannot sync tasks.md: ${t0.error}`);
    return { status: 'error', changes: [] };
  }
  const before = parseTasks(t0);
  const c = flowCtx(rt, s, {});
  return withFinish(rt, async () => {
    const r = await specTurn(rt, specInput(c, syncPrompt({ dir: s.dir, ws: rt.ws.workspaceRoot })), restrictionFor(c, 'tasks'));
    const fail = turnFailure(r);
    if (fail) {
      rt.print(`✗ Sync failed: ${fail}`);
      return { status: 'error' as const, changes: [] };
    }
    repairTasks(rt, s.dir);
    const t1 = read();
    if (typeof t1 !== 'string') {
      rt.print(`✗ Sync: could not re-read tasks.md: ${t1.error}`);
      return { status: 'error' as const, changes: [] };
    }
    const after = parseTasks(t1);
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

/**
 * Set task `t`'s box in tasks.md; undefined when done, else why not (printed): the task or the
 * file is gone (`refused` absent), or tasks.md is refused (a symbolic link, …: docfs; its target
 * is neither read nor written).
 */
function setBox(rt: SpecRuntime, file: string, t: SpecTask, box: TaskBox): { refused?: string; error: string } | undefined {
  try {
    const r = writeTaskStatus(file, t.id, box, { expectHash: t.textHash });
    if (r.stale) rt.print(`⚠ Task ${t.id} changed in tasks.md since the run started.`);
    return undefined;
  } catch (e) {
    // `error`: what went wrong, also a write the user may not make (EACCES: a spec folder it
    // cannot write), never taken for a task that is no longer in tasks.md (r7 verifier)
    const error = e instanceof Error ? e.message : String(e);
    rt.print(`⚠ ${error}`);
    return e instanceof SpecFileRefusedError ? { refused: e.why, error } : { error };
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
  const finishTask = async (done: TaskOutcome, session?: TaskSessionHandle): Promise<TaskOutcome> => {
    let o = done;
    try {
      // a completed task whose box cannot be ticked because tasks.md became a file kiro-claude
      // does not write (a link the turn left, docfs) is not reported as completed: the run stops
      const boxFail = setBox(rt, file, t, o.status === 'completed' ? 'x' : ' ');
      if (boxFail?.refused && o.status === 'completed') o = { ...o, status: 'failed', reason: `its box could not be ticked: ${boxFail.refused}` };
      if (hooks && hctx) {
        const postInfo = { ...info, status: hookStatus(o.status) };
        let post: Awaited<ReturnType<HookRunnerLike['runTaskHook']>> | undefined;
        try {
          // A press during the hook kills it. One that already came (it interrupted the task) is
          // not passed on: the hook is meant to run with status `interrupted`, and an aborted
          // signal would skip it before it starts. It runs under the host's NEXT press instead
          // (SpecRuntime.nextPressSignal: the REPL's, r5 P1, and the spec CLI's NextPress), so a
          // press still kills it (also with timeout 0); a host without one runs it without a signal.
          const later = signal?.aborted ? rt.nextPressSignal?.() : undefined;
          post = await hooks.runner.runTaskHook(
            signal?.aborted ? { ws: hctx.ws, sessionId: hctx.sessionId, ...(later ? { signal: later } : {}) } : hctx,
            'PostTaskExec',
            postInfo,
          );
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

  // a spec file that became one kiro-claude does not read during the run (a link a task left,
  // docfs): the task is not started (its box is not touched, its documents are not read)
  const refusedNow = summarizeSpecDir(spec.dir).refused;
  if (refusedNow) {
    rt.print(`✗ Task ${t.id} failed: ${specRefusalText(refusedNow)}`);
    return { id: t.id, title: t.title, status: 'failed', reason: refusedNow };
  }
  const boxFail = setBox(rt, file, t, '-');
  if (boxFail) return { id: t.id, title: t.title, status: 'failed', reason: boxFail.refused ?? boxFail.error };
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
  // a file that became one kiro-claude does not read while the session started (a parallel
  // task's turn left a link): the task's context would silently lack it, so the task fails
  if (s.refused) return finishTask({ id: t.id, title: t.title, status: 'failed', reason: specRefusalText(s.refused) }, session);
  // nor one that became so after that check, when its text is read for the context (r7 #6)
  const refusedAtRead: string[] = [];
  const ctxBlock = specContextBlock(rt.ws, s, refusedAtRead);
  if (refusedAtRead.length) return finishTask({ id: t.id, title: t.title, status: 'failed', reason: specRefusalText(refusedAtRead[0]!) }, session);
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
  if (!s) return { status: 'error', outcomes: [], remainingRequired: 0, message: notFoundMessage(rt, name) };
  const planRefusal = (): string => `${PLAN_MODE_RUN_REFUSED} Exit plan mode (/plan or Shift+Tab), then run ${rt.commandPrefix} run ${s.name} again.`;
  if (rt.planMode) {
    // Kiro's plan mode is the read-only planner (00 §2.5, 03 §5.4); a task session in it could
    // implement nothing, and one without it would edit code the user asked not to touch (T3)
    const msg = planRefusal();
    rt.print(msg);
    return { status: 'error', outcomes: [], remainingRequired: 0, message: msg };
  }
  // a spec file kiro-claude does not read or write (a symbolic link, …: docfs): the run would tick
  // boxes in tasks.md and put the documents into each task's context, so nothing runs
  if (s.refused) {
    const msg = `✗ Spec '${s.name}' cannot run: ${specRefusalText(s.refused)}`;
    rt.print(msg);
    return { status: 'error', outcomes: [], remainingRequired: 0, message: msg };
  }
  if (!s.docs.tasks.nonEmpty) {
    const msg = `Spec '${s.name}' has no tasks.md yet. Continue the spec with ${resumeHint(rt, s.name)}`;
    rt.print(msg);
    return { status: 'error', outcomes: [], remainingRequired: 0, message: msg };
  }
  repairTasks(rt, s.dir);
  const spec: LoadedSpec = loadSpecDir(s.dir);
  if (spec.refused || !spec.tasks) {
    const msg = spec.refused ? `✗ Spec '${s.name}' cannot run: ${specRefusalText(spec.refused)}` : `✗ Spec '${s.name}': tasks.md could not be read`;
    rt.print(msg);
    return { status: 'error', outcomes: [], remainingRequired: 0, message: msg };
  }
  const parsed = spec.tasks;
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
          if (rt.planMode) {
            // the user turned plan mode on during the run (Shift+Tab while a task session was the
            // chat's; it carries back to the chat): no further task starts (T3)
            stop = true;
            rt.print(planRefusal());
            break;
          }
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
  // the progress after the run, never through a link a task left at tasks.md (docfs): then the
  // plan's own view, with the reason
  let after = taskProgress(parsed);
  try {
    const t = readSpecFile(s.docs.tasks.path);
    if (t !== undefined) after = taskProgress(parseTasks(t));
  } catch (e) {
    rt.print(`⚠ ${e instanceof Error ? e.message : String(e)}`);
  }
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
 * A signal the REPL's NEXT Ctrl+C aborts (repl/types.ts ReplContext.nextPressSignal, read
 * duck-typed like {@link commandSignalOf}); undefined for hosts without it.
 */
function nextPressSignalOf(host: ReplHost): AbortSignal | undefined {
  const f = (host as { nextPressSignal?: unknown }).nextPressSignal;
  if (typeof f !== 'function') return undefined;
  const s: unknown = f.call(host);
  return s && typeof s === 'object' && typeof (s as AbortSignal).addEventListener === 'function' && 'aborted' in s ? (s as AbortSignal) : undefined;
}

/** What the REPL runtime prints when a Ctrl+C cancelled the start of a flow's continuation (r5 P1). */
export const CONTINUATION_CANCELLED_NOTICE =
  'Ctrl+C: the chat keeps its own conversation; the spec conversation was not carried over (the spec documents are saved).';

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
   * aborted; it would cancel every later start at once): after one, the start runs under the NEXT
   * press (ReplContext.nextPressSignal, r5 P1), so a later phase session or the continuation that
   * a hook keeps from starting is still cancelled by a press (G0 holds: only a new press cancels).
   */
  const createUnderPress = (o: Partial<KiroSessionOptions>): Promise<KiroSession> => {
    const sig = commandSignalOf(host);
    const start = sig ? (sig.aborted ? nextPressSignalOf(host) : sig) : undefined;
    return withStartSignal(start, () => host.createSession(o));
  };
  const port: SessionPort = {
    active: () => host.session,
    // phase sessions and the continuation (a cancelled continuation start gives the chat its own
    // session back, SpecSessionDriver.finish)
    create: createUnderPress,
    activate: (s) => host.replaceSession(s),
    run: (_s, input) => host.runTurn(input),
    // a phase record the continuation (or a later phase record) holds in full (T5)
    discard: (s) => {
      discardSpecRecord(host.ws, s.id);
    },
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
    nextPressSignal: () => nextPressSignalOf(host),
    get planMode() {
      return host.session.planMode === true;
    },
    print: (t) => host.print(t),
    ask: (q) => host.ask(q),
    confirm: (q, d) => host.confirm(q, d),
    choose: (q, o) => host.choose(q, o),
    runSpecTurn(input, phase, o) {
      // T4 (backstop of the /spec command's own check): a phase session forked from a tangent and
      // the continuation after it would replace the tangent; /tangent could not return to main
      const cur = host.session;
      if (cur.tangent !== undefined && !driver.openSessions.includes(cur) && !canSetSpecPhase(cur)) {
        return Promise.resolve({ stopReason: 'error', isError: true, text: '', error: SPEC_IN_TANGENT_ERROR, permissionDenials: [] });
      }
      // The command's Ctrl+C signal when this turn was requested and not aborted yet: a press while
      // the driver starts the turn's phase session (Claude Code spawning) cancels the turn before
      // it is sent. A press an earlier turn handled does not cancel the later ones.
      const sig = commandSignalOf(host);
      return driver.runTurn(input, phase, { ...o, ...(sig && !sig.aborted ? { signal: sig } : {}) });
    },
    async openTaskSession(): Promise<TaskSessionHandle> {
      const prev = host.session;
      // created under the run's start signal (executeTask), the command's Ctrl+C by default; with
      // the chat's trust as it is (T1: never the launch --trust-tools / agent allowedTools again)
      const trust = trustOf(prev);
      const child = await host.createSession({ origin: 'spec', ...(trust ? { initialTrust: trust } : {}) });
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
            // the task session was the chat's: a restriction the user added in it (Shift+Tab into
            // plan mode, `/tools untrust` at its approval prompt) holds for the chat and so for
            // the later tasks of the run (runSpecTasks stops at plan mode)
            carryRestrictions(child, prev);
            host.replaceSession(prev);
          }
        },
        interrupt: () => child.interrupt(),
        async close(): Promise<void> {
          if (closed) return;
          closed = true;
          if (host.session === child) {
            carryRestrictions(child, prev);
            host.replaceSession(prev);
          }
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
    finish: async () => {
      // a Ctrl+C cancelled the continuation's start: the chat is back in its own session (r5 P1)
      await driver.finish('keep');
      if (driver.continuationCancelled) host.print(CONTINUATION_CANCELLED_NOTICE);
    },
  };
  if (editor) rt.openEditor = editor;
  return rt;
}

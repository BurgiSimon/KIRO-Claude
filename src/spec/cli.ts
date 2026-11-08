/**
 * `kiro-claude spec …` — Kiro specs from the command line (adapter extension; Kiro itself only has
 * `/spec` inside chat, research 03 §1.1). Same workflow as the REPL (spec/workflow.ts) over a
 * headless-style runtime:
 *
 *   spec list [--format plain|json]
 *   spec status [<name>] [--format plain|json]
 *   spec view <name> [requirements|bugfix|design|tasks]
 *   spec new <name> [--type feature|bugfix|quick] [--workflow requirements-first|design-first]
 *                   [--detail high|low] [--description <text> | <text…>] [--yes]
 *   spec approve <name> [--yes]          spec revise <name> <feedback…> [--yes]
 *   spec run <name> [<task-id>…|--next|--all] [--include-optional]
 *   spec analyze <name> [--yes]          spec sync <name>
 *   common: --agent <name> --model <id> --trust-all-tools|-a --trust-tools <a,b> --no-interactive
 *
 * Interactive only when stdin and stdout are TTYs and neither `--yes` nor `--no-interactive` is
 * given; otherwise checkpoints stop after each phase (03 §1.11.4 headless), or are approved with
 * `--yes` (the `--spec-auto-approve` extension), and the gate denies tool approvals unless
 * `--trust-all-tools` / `--trust-tools` cover them (00 §2.3 Headless). Progress, tool lines and
 * warnings go to stderr; assistant text and results (list, status, findings, run summary) to
 * stdout (00 §2.5 "Headless output"). Exit codes: 0 ok, 1 failure/stopped run, 2 usage error.
 *
 * Spec files are read and written through spec/docfs.ts (review X1): a document (or
 * `.config.kiro`) that is a symbolic link, not a regular file, behind a link that resolves to
 * nothing or outside the workspace, or that the user cannot read (or in a folder it cannot enter)
 * is never read or written. `list` / `status` show such a spec
 * with the phase `refused` and print why on stderr; `status <name>` marks the document and says
 * why; `view` of it is an error (exit 1); `new`, `run`, `sync`, `analyze` and `approve` refuse
 * with the reason (spec/workflow.ts). A `.kiro/specs` linked out of the workspace (or dangling,
 * or into a folder the user cannot enter), or one it cannot enter or read, is not
 * enumerated: `list` and `status` without a name are an error with the reason (exit 1), and a
 * named spec not found under it is that error too, not "not found" (r7 #7). Resume hints name
 * commands this CLI accepts ({@link cliResumeHint}, r7 #8); a checkpoint's Stop resumes its
 * review (`approve` / `revise`), also at tasks.md (r8 #10), unless its document was not written
 * (then the hint is the one outside a checkpoint).
 *
 * Ctrl+C during `spec run`: the first press stops scheduling and interrupts the running tasks.
 * The PostTaskExec hooks of a task it interrupted run under the NEXT press, as in the REPL
 * (SpecRuntime.nextPressSignal, {@link NextPress}): the second press kills them with their process
 * group and the run ends normally (summary, sessions closed, exit 1). A second press with no such
 * hook running exits at once (the default SIGINT action). SIGTERM / SIGHUP are not handled here:
 * claude/lifecycle.ts forwards them to every tracked child (task hooks included) and re-raises.
 *
 * Sessions come from session/kiroSession.ts `createSession` (loaded lazily; injectable for tests).
 */

import { randomUUID } from 'node:crypto';
import * as readline from 'node:readline';
import type {
  ApprovalRequest,
  ApprovalResponse,
  CliContext,
  HookRunContext,
  HookRunnerLike,
  KiroHook,
  KiroSession,
  KiroSessionOptions,
  PromptInput,
  SessionEvent,
  SessionUI,
  SubcommandRunner,
  TurnResult,
} from '../types.js';
import { allHooksFor } from '../config/hooks.js';
import { loadAgents, selectAgent } from '../config/agents.js';
import { HookRunner } from '../hooks/runner.js';
import { SPEC_DOC_FILES, type SpecDocKind, type TaskSelection, type WorkflowType } from './model.js';
import { formatSpecList, formatSpecRefusals, formatSpecStatus, isValidSpecName, listSpecs, loadSpec, normalizeSpecName, specSummaryJson, specsDirRefused, summarizeSpec } from './store.js';
import { specRefusalText } from './docfs.js';
import {
  SpecSessionDriver,
  discardSpecRecord,
  analyzeRequirements,
  approveSpec,
  createNewSpec,
  reviseSpec,
  runSpecTasks,
  syncSpec,
  type NewSpecRequest,
  type SessionPort,
  type SpecKindChoice,
  type SpecRuntime,
  type TaskSessionHandle,
} from './workflow.js';

export type CreateSessionFn = (opts: KiroSessionOptions) => Promise<KiroSession>;

export interface SpecCliIO {
  /** Ask a free-form question (interactive only); '' once the input has ended. */
  question(prompt: string): Promise<string>;
  /** True once the input has ended (Ctrl+D, closed pipe): every later answer is ''. */
  isClosed?(): boolean;
  close(): void;
}

export interface SpecCliDeps {
  createSession?: CreateSessionFn;
  hookRunnerFactory?: (hooks: readonly KiroHook[]) => HookRunnerLike;
  /** Force TTY detection (tests). */
  isTTY?: boolean;
  /** Line input for interactive prompts (default readline over ctx.stdin). */
  io?: SpecCliIO;
}

export const SPEC_HELP_TEXT = `Spec-driven development (Kiro specs: requirements → design → tasks → run)

Usage: kiro-claude spec <COMMAND> [OPTIONS]

Commands:
  list                       List the specs in .kiro/specs
  status [name]              Show a spec's documents, phase and tasks (all specs without a name)
  view <name> [doc]          Print a spec document (requirements, bugfix, design or tasks)
  new <name> [description]   Create a spec and draft its documents phase by phase
  approve <name>             Approve the document under review and draft the next one
  revise <name> <feedback>   Revise the document under review
  run <name> [task-id...]    Execute tasks (default: all remaining required tasks)
  analyze <name>             Analyze requirements for ambiguities, conflicts and gaps
  sync <name>                Update task boxes and add missing tasks from the current code
  help                       Print this message

Options:
      --type <TYPE>          new: feature, bugfix or quick [default: feature]
      --workflow <WORKFLOW>  new: requirements-first or design-first [default: requirements-first]
      --detail <LEVEL>       new (design-first): high or low [default: high]
  -d, --description <TEXT>   new: what the spec should cover
  -y, --yes                  Approve every checkpoint automatically (analyze: apply the first fix of each finding)
      --spec-auto-approve    Same as --yes
      --next                 run: only the next task
      --all                  run: all remaining required tasks
      --include-optional     run: include optional (*) tasks
      --agent <NAME>         Agent to use
      --model <MODEL>        Model to use
  -a, --trust-all-tools      Allow every tool without asking
      --trust-tools <NAMES>  Trust only these tools (comma-separated)
      --no-interactive       Never ask; stop at each checkpoint
      --format <FORMAT>      list/status: plain or json [default: plain]
  -h, --help                 Print help
`;

// ───────────────────────────── argv parsing ─────────────────────────────

interface Parsed {
  positionals: string[];
  flags: Map<string, string | true>;
}

const VALUE_FLAGS = new Set(['--type', '--workflow', '--detail', '--description', '--agent', '--model', '--trust-tools', '--format']);
const BOOL_FLAGS = new Set(['--yes', '--spec-auto-approve', '--next', '--all', '--include-optional', '--trust-all-tools', '--no-interactive', '--help']);
const SHORT: Record<string, string> = { '-y': '--yes', '-a': '--trust-all-tools', '-d': '--description', '-h': '--help' };

class UsageError extends Error {}

function parseArgs(args: readonly string[]): Parsed {
  const p: Parsed = { positionals: [], flags: new Map() };
  for (let i = 0; i < args.length; i++) {
    let a = args[i]!;
    if (a === '--') {
      p.positionals.push(...args.slice(i + 1));
      break;
    }
    if (SHORT[a]) a = SHORT[a]!;
    if (!a.startsWith('--') || a === '-') {
      p.positionals.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (VALUE_FLAGS.has(name)) {
      const v = eq > 0 ? a.slice(eq + 1) : args[++i];
      if (v === undefined) throw new UsageError(`error: a value is required for '${name} <VALUE>' but none was supplied`);
      p.flags.set(name, v);
    } else if (BOOL_FLAGS.has(name) && eq < 0) {
      p.flags.set(name, true);
    } else {
      throw new UsageError(`error: unexpected argument '${a}' found`);
    }
  }
  return p;
}

function str(p: Parsed, k: string): string | undefined {
  const v = p.flags.get(k);
  return typeof v === 'string' ? v : undefined;
}

// ───────────────────────────── terminal I/O ─────────────────────────────

function readlineIO(ctx: CliContext): SpecCliIO {
  let rl: readline.Interface | undefined;
  const lines: string[] = [];
  const waiters: ((l: string) => void)[] = [];
  let closed = false;
  const ensure = (): void => {
    if (rl) return;
    rl = readline.createInterface({ input: ctx.stdin, terminal: false });
    rl.on('line', (l) => {
      const w = waiters.shift();
      if (w) w(l);
      else lines.push(l);
    });
    rl.on('close', () => {
      closed = true;
      while (waiters.length) waiters.shift()!('');
    });
  };
  return {
    question(prompt: string): Promise<string> {
      ensure();
      ctx.stdout.write(prompt);
      const l = lines.shift();
      if (l !== undefined) return Promise.resolve(l);
      if (closed) return Promise.resolve('');
      return new Promise((resolve) => waiters.push(resolve));
    },
    isClosed: () => closed,
    close(): void {
      rl?.close();
    },
  };
}

/** Classic tool lines (01 §4.7) for stderr. */
class Renderer {
  private atLineStart = true;
  private buffer = '';

  constructor(
    private readonly ctx: CliContext,
    /** Parallel task output: buffer text and prefix lines. */
    private readonly prefix?: string,
    /** Do not echo assistant text (machine-output turns). */
    private readonly quiet = false,
  ) {}

  private err(line: string): void {
    if (!this.prefix && !this.atLineStart) {
      this.ctx.stdout.write('\n');
      this.atLineStart = true;
    }
    this.ctx.stderr.write(this.prefix ? line.split('\n').map((l) => `${this.prefix}${l}`).join('\n') + '\n' : `${line}\n`);
  }

  private text(t: string): void {
    if (!t || this.quiet) return;
    if (this.prefix) {
      this.buffer += t;
      return;
    }
    this.ctx.stdout.write(t);
    this.atLineStart = t.endsWith('\n');
  }

  event(e: SessionEvent): void {
    switch (e.type) {
      case 'text_delta':
        this.text(e.text);
        break;
      case 'text':
        this.text(e.text.endsWith('\n') ? e.text : `${e.text}\n`);
        break;
      case 'tool_start': {
        const c = e.call;
        const from = c.mcp ? ` from mcp server ${c.mcp.server}` : '';
        this.err(`🛠️  Using tool: ${c.displayName}${e.trusted ? ' (trusted)' : ''}${from}${c.summary ? `\n ⋮ \n ● ${c.summary}` : ''}`);
        break;
      }
      case 'tool_end': {
        const secs = e.durationMs !== undefined ? `${(e.durationMs / 1000).toFixed(2)}s` : '';
        if (e.isError) this.err(` ● Execution failed${secs ? ` after ${secs}` : ''}:\n${e.output}`);
        else this.err(` ● Completed${secs ? ` in ${secs}` : ''}`);
        break;
      }
      case 'tool_denied':
        this.err(` ❗ ${e.reason}`);
        break;
      case 'notice':
        this.err(e.message);
        break;
      case 'rate_limit':
        // the session reports a usage limit only as this event (each front end words it)
        if (e.status === 'rejected') {
          const when = e.resetsAt ? ` (resets ${new Date(e.resetsAt * (e.resetsAt < 1e12 ? 1000 : 1)).toISOString()})` : '';
          this.err(`WARNING: Claude Code usage limit reached${when}`);
        }
        break;
      default:
        break;
    }
  }

  end(): void {
    if (this.prefix) {
      const t = this.buffer.replace(/\s+$/, '');
      if (t) this.ctx.stdout.write(t.split('\n').map((l) => `${this.prefix}${l}`).join('\n') + '\n');
      this.buffer = '';
      return;
    }
    if (!this.atLineStart) {
      this.ctx.stdout.write('\n');
      this.atLineStart = true;
    }
  }
}

async function driveTurn(s: KiroSession, input: PromptInput, r: Renderer): Promise<TurnResult> {
  const gen = s.prompt(input);
  try {
    for (;;) {
      const n = await gen.next();
      if (n.done) return n.value;
      r.event(n.value);
    }
  } finally {
    r.end();
  }
}

function sessionUI(ctx: CliContext, interactive: boolean, io: () => SpecCliIO): SessionUI {
  let chain: Promise<unknown> = Promise.resolve();
  return {
    notice(_level, message) {
      ctx.stderr.write(`${message}\n`);
    },
    requestApproval(req: ApprovalRequest, signal: AbortSignal): Promise<ApprovalResponse> {
      if (!interactive) return Promise.resolve({ kind: 'deny' });
      const run = async (): Promise<ApprovalResponse> => {
        if (signal.aborted) return { kind: 'cancelled' };
        ctx.stderr.write(`🛠️  Using tool: ${req.call.displayName}\n ⋮ \n ● ${req.call.summary}\n`);
        for (;;) {
          const a = (await io().question("Allow this action? Use 't' to trust (always allow) this tool for the session. [y/n/t]: ")).trim();
          if (signal.aborted) return { kind: 'cancelled' };
          if (a === '') {
            // Ctrl+D / closed input cancels like the REPL does (06 §2.2); re-asking would spin
            // forever on answers that are already resolved (and starve every signal handler)
            if (io().isClosed?.()) {
              ctx.stdout.write('\n');
              return { kind: 'cancelled' };
            }
            continue;
          }
          const l = a.toLowerCase();
          if (l === 'y' || l === 'yes') return { kind: 'allow-once' };
          if (l === 't') return { kind: 'allow-always' };
          if (l === 'n' || l === 'no') return { kind: 'deny' };
          return { kind: 'redirect', text: a };
        }
      };
      const p = chain.then(run, run);
      chain = p.catch(() => undefined);
      return p;
    },
  };
}

async function defaultCreateSession(): Promise<CreateSessionFn> {
  // Computed specifier: session/ is another Wave-2 module (fixed entry point createSession).
  const spec = '../session/kiroSession.js';
  const mod = (await import(spec)) as { createSession?: CreateSessionFn };
  if (typeof mod.createSession !== 'function') throw new Error('session/kiroSession.js does not export createSession');
  return mod.createSession;
}

// ───────────────────────────── Ctrl+C during `spec run` ─────────────────────────────

/**
 * The NEXT Ctrl+C of `spec run` after the first one (the REPL's ReplContext.nextPressSignal): the
 * PostTaskExec hooks of a task the first press interrupted run under {@link signal} (workflow
 * executeTask), so the next press kills them with their process group (hooks/runner.ts) and the
 * run ends normally. The next press after a {@link signal} call aborts it; a call after that
 * press gets a fresh one. {@link press} reports whether a task hook was running under the signal
 * IT aborts, so a press with nothing under it can still exit at once: also one that comes while
 * a hook an earlier press killed has not settled yet (runShell's close grace, a process the
 * kernel has not reaped), which must not swallow every later press.
 */
export class NextPress {
  private ac: AbortController | undefined;
  private readonly issued = new WeakSet<AbortSignal>();
  /** Task hooks running, per signal handed out (entries removed at 0). */
  private readonly running = new Map<AbortSignal, number>();

  /** A signal the next press aborts. */
  signal(): AbortSignal {
    this.ac ??= new AbortController();
    this.issued.add(this.ac.signal);
    return this.ac.signal;
  }

  /** `runner`, with its task hooks that run under one of our signals counted as work under the next press. */
  track(runner: HookRunnerLike): HookRunnerLike {
    return new Proxy(runner, {
      get: (target, key) => {
        const v = Reflect.get(target, key, target) as unknown;
        if (typeof v !== 'function') return v;
        const fn = v as (...a: unknown[]) => unknown;
        if (key !== 'runTaskHook') return fn.bind(target);
        return async (...args: unknown[]): Promise<unknown> => {
          const sig = (args[0] as HookRunContext | undefined)?.signal;
          const ours = sig !== undefined && this.issued.has(sig) ? sig : undefined;
          if (ours) this.running.set(ours, (this.running.get(ours) ?? 0) + 1);
          try {
            return await fn.apply(target, args);
          } finally {
            if (ours) {
              const n = (this.running.get(ours) ?? 1) - 1;
              if (n > 0) this.running.set(ours, n);
              else this.running.delete(ours);
            }
          }
        };
      },
    });
  }

  /** A press: abort the signal handed out; true when a task hook was running under it. */
  press(): boolean {
    const ac = this.ac;
    this.ac = undefined;
    const busy = ac !== undefined && (this.running.get(ac.signal) ?? 0) > 0;
    ac?.abort();
    return busy;
  }
}

// ───────────────────────────── runtime ─────────────────────────────

interface CliRuntimeOptions {
  interactive: boolean;
  agentName?: string;
  model?: string;
  trustAllTools: boolean;
  trustTools?: string[];
}

/** `press`: `spec run`'s next Ctrl+C (SpecRuntime.nextPressSignal); the other commands have none. */
function cliRuntime(ctx: CliContext, o: CliRuntimeOptions, deps: SpecCliDeps, io: () => SpecCliIO, press?: NextPress): SpecRuntime {
  const ui = sessionUI(ctx, o.interactive, io);
  let createFn: CreateSessionFn | undefined = deps.createSession;
  const base = (): KiroSessionOptions => {
    const opts: KiroSessionOptions = { ws: ctx.ws, origin: 'spec', interactive: o.interactive, ui, env: ctx.ws.env };
    if (o.agentName) opts.agentName = o.agentName;
    if (o.model) opts.model = o.model;
    if (o.trustAllTools) opts.trustAllTools = true;
    if (o.trustTools) opts.trustTools = o.trustTools;
    return opts;
  };
  const create = async (extra: Partial<KiroSessionOptions>): Promise<KiroSession> => {
    createFn ??= await defaultCreateSession();
    const s = await createFn({ ...base(), ...extra });
    await s.start();
    return s;
  };
  let current: KiroSession | undefined;
  const port: SessionPort = {
    active: () => current,
    create,
    activate: (s) => {
      current = s;
    },
    run: (s, input, opts) => driveTurn(s, input, new Renderer(ctx, undefined, opts?.quiet === true)),
    // an earlier phase record the last one of the flow holds in full (T5)
    discard: (s) => {
      discardSpecRecord(ctx.ws, s.id);
    },
  };
  const driver = new SpecSessionDriver(port);
  const max = Math.max(1, Math.min(4, Math.floor(ctx.settings.getNumber('kiroClaude.spec.maxParallelTasks', 1)) || 1));
  let hooks: { runner: HookRunnerLike; sessionId: string } | null | undefined;
  const factory = deps.hookRunnerFactory ?? ((h: readonly KiroHook[]) => new HookRunner([...h]));
  const write = (stream: NodeJS.WriteStream) => (t: string) => {
    stream.write(t.endsWith('\n') ? t : `${t}\n`);
  };
  const prog = ctx.progName || 'kiro-claude';
  return {
    ws: ctx.ws,
    settings: ctx.settings,
    interactive: o.interactive,
    commandPrefix: `${prog} spec`,
    maxParallelTasks: max,
    print: write(ctx.stderr),
    result: write(ctx.stdout),
    ask: async (q) => (await io().question(`${q} `)).trim(),
    confirm: async (q, def) => {
      const a = (await io().question(`${q} [${def ? 'Y/n' : 'y/N'}]: `)).trim().toLowerCase();
      return a === '' ? def === true : a === 'y' || a === 'yes';
    },
    choose: async (q, options) => {
      ctx.stdout.write(`? ${q}\n${options.map((op, i) => `  ${i + 1}. ${op}`).join('\n')}\n`);
      for (;;) {
        const a = (await io().question(`Choose 1-${options.length} (empty to cancel): `)).trim();
        if (a === '') return undefined;
        const n = Number(a);
        if (Number.isInteger(n) && n >= 1 && n <= options.length) return n - 1;
      }
    },
    runSpecTurn: (input, phase, opts) => driver.runTurn(input, phase, opts),
    async openTaskSession(label: string): Promise<TaskSessionHandle> {
      const s = await create({});
      const prefix = max > 1 ? `[${label}] ` : undefined;
      return {
        sessionId: s.id,
        run: (input) => driveTurn(s, input, new Renderer(ctx, prefix)),
        interrupt: () => s.interrupt(),
        close: () => s.close(),
      };
    },
    taskHooks() {
      if (hooks === undefined) {
        try {
          const { agents } = loadAgents(ctx.ws, { settings: ctx.settings });
          const { agent } = selectAgent(ctx.ws, agents, ctx.settings, o.agentName, { interactive: o.interactive });
          const all = allHooksFor(ctx.ws, agent);
          if (all.some((h) => h.trigger === 'PreTaskExec' || h.trigger === 'PostTaskExec')) {
            const runner = factory(all);
            hooks = { runner: press ? press.track(runner) : runner, sessionId: randomUUID() };
          } else hooks = null;
        } catch {
          hooks = null;
        }
      }
      return hooks ?? undefined;
    },
    ...(press ? { nextPressSignal: () => press.signal() } : {}),
    readyHint: (name) => `Spec ready. Run all tasks: ${prog} spec run ${name} · Step through: ${prog} spec run ${name} --next`,
    resumeHint: (name, awaiting) => cliResumeHint(ctx, name, awaiting),
    finish: () => driver.finish('close'),
  };
}

/**
 * The spec CLI's resume hint (SpecRuntime.resumeHint, r7 #8): the CLI has no `spec <name>` form,
 * so it names commands it accepts, by where the spec stands now: `status <name>` for a spec with a
 * refused file (it says why); `approve` / `revise` for the document under review at a checkpoint
 * the user stops at (`awaiting`) when that review is the one they resume (the document the files
 * say awaits review, or tasks.md once it has tasks: a tasks.md under review derives as
 * `execution`, but its review is what resumes, r8 #10) and for a document awaiting review; `run
 * <name> --next` outside a checkpoint once the tasks are approved. At the checkpoint of a document
 * the turn did not write (or a revision emptied), `approve` / `revise` would act on another
 * document or on none ("Nothing to approve yet"), so the hint comes from where the spec stands, as
 * outside a checkpoint. A spec whose next step is drafting a document nothing awaits approval
 * before (an existing folder without its first document, also at its checkpoint) can only be
 * continued in chat (`new` refuses an existing folder): `/spec <name> in kiro-claude chat`.
 */
function cliResumeHint(ctx: CliContext, name: string, awaiting?: SpecDocKind): string {
  const prog = `${ctx.progName || 'kiro-claude'} spec`;
  const s = summarizeSpec(ctx.ws, name);
  if (!s || s.refused) return `${prog} status ${name}`;
  // the review `approve` / `revise` resume (workflow.approveSpec / reviseSpec)
  const review = s.awaitingApproval ?? (s.phase === 'execution' || s.phase === 'done' ? 'tasks' : undefined);
  if (awaiting && awaiting === review) return `${prog} approve ${name} · ${prog} revise ${name} <feedback>`;
  if (s.phase === 'execution' || s.phase === 'done') return `${prog} run ${name} --next`;
  if (s.awaitingApproval) return `${prog} approve ${name} · ${prog} revise ${name} <feedback>`;
  return `/spec ${name} in ${ctx.progName || 'kiro-claude'} chat`;
}

/** `error: <why>` for a named spec that is not found: the `.kiro/specs` refusal (r7 #7), else "not found". */
function specNotFound(ctx: CliContext, name: string): number {
  const dirWhy = specsDirRefused(ctx.ws);
  ctx.stderr.write(dirWhy ? `error: ${specRefusalText(dirWhy)}\n` : `error: spec '${name}' not found\n`);
  return 1;
}

// ───────────────────────────── commands ─────────────────────────────

function parseKind(v: string | undefined): SpecKindChoice | undefined | 'invalid' {
  if (v === undefined) return undefined;
  const x = v.toLowerCase();
  if (x === 'feature') return 'feature';
  if (x === 'bugfix' || x === 'bug') return 'bugfix';
  if (x === 'quick') return 'quick';
  return 'invalid';
}

function parseDoc(v: string | undefined): SpecDocKind | undefined {
  const x = v?.toLowerCase().replace(/\.md$/, '');
  return x === 'requirements' || x === 'bugfix' || x === 'design' || x === 'tasks' ? x : undefined;
}

/** Testable entry point (see {@link runSpecCommand}). */
export async function runSpecCommandWith(args: string[], ctx: CliContext, deps: SpecCliDeps = {}): Promise<number> {
  let p: Parsed;
  try {
    p = parseArgs(args);
  } catch (e) {
    ctx.stderr.write(`${(e as Error).message}\n\nFor more information, try '--help'.\n`);
    return 2;
  }
  const sub = p.positionals[0];
  const pos = p.positionals.slice(1);
  if (p.flags.has('--help') || sub === undefined || sub === 'help') {
    (sub === undefined && !p.flags.has('--help') ? ctx.stderr : ctx.stdout).write(SPEC_HELP_TEXT);
    return sub === undefined && !p.flags.has('--help') ? 2 : 0;
  }
  const format = str(p, '--format') ?? 'plain';
  if (format !== 'plain' && format !== 'json' && format !== 'json-pretty') {
    ctx.stderr.write(`error: invalid value '${format}' for '--format <FORMAT>'\n  [possible values: plain, json]\n`);
    return 2;
  }
  const tty = deps.isTTY ?? (ctx.stdin.isTTY === true && ctx.stdout.isTTY === true);
  // `--spec-auto-approve` is the 03 §1.11.4 name of the headless auto-approve extension.
  const yes = p.flags.has('--yes') || p.flags.has('--spec-auto-approve');
  const interactive = tty && !yes && !p.flags.has('--no-interactive');
  let ioInst: SpecCliIO | undefined;
  const io = (): SpecCliIO => (ioInst ??= deps.io ?? readlineIO(ctx));
  const rtOpts: CliRuntimeOptions = { interactive, trustAllTools: p.flags.has('--trust-all-tools') };
  const agent = str(p, '--agent');
  if (agent) rtOpts.agentName = agent;
  const model = str(p, '--model');
  if (model) rtOpts.model = model;
  const tt = str(p, '--trust-tools');
  if (tt !== undefined) rtOpts.trustTools = tt.split(',').map((s) => s.trim()).filter(Boolean);
  const needName = (): string | undefined => {
    const n = pos[0];
    if (!n) ctx.stderr.write(`error: the following required arguments were not provided:\n  <NAME>\n\nUsage: ${ctx.progName} spec ${sub} <NAME>\n`);
    return n;
  };
  const json = (v: unknown): string => (format === 'json-pretty' ? JSON.stringify(v, null, 2) : JSON.stringify(v));
  try {
    switch (sub) {
      case 'list':
      case 'ls': {
        // a .kiro/specs linked out of the workspace (docfs) is not listed: its entries are another folder's
        const dirWhy = specsDirRefused(ctx.ws);
        if (dirWhy) {
          ctx.stderr.write(`error: ${specRefusalText(dirWhy)}\n`);
          return 1;
        }
        const all = listSpecs(ctx.ws);
        if (format !== 'plain') ctx.stdout.write(`${json(all.map(specSummaryJson))}\n`);
        else if (all.length === 0) ctx.stderr.write(`No specs found in ${ctx.ws.workspaceRoot}/.kiro/specs. Create one with: ${ctx.progName} spec new <name>\n`);
        else ctx.stdout.write(`${formatSpecList(all)}\n`);
        // a spec with files kiro-claude does not read (phase `refused`, docfs): why, as a warning
        for (const l of formatSpecRefusals(all)) ctx.stderr.write(`${l}\n`);
        return 0;
      }
      case 'status': {
        if (!pos[0]) {
          const dirWhy = specsDirRefused(ctx.ws);
          if (dirWhy) {
            ctx.stderr.write(`error: ${specRefusalText(dirWhy)}\n`);
            return 1;
          }
          const all = listSpecs(ctx.ws);
          if (format !== 'plain') ctx.stdout.write(`${json(all.map(specSummaryJson))}\n`);
          else if (all.length === 0) ctx.stderr.write(`No specs found in ${ctx.ws.workspaceRoot}/.kiro/specs. Create one with: ${ctx.progName} spec new <name>\n`);
          else ctx.stdout.write(`${formatSpecList(all)}\n`);
          for (const l of formatSpecRefusals(all)) ctx.stderr.write(`${l}\n`);
          return 0;
        }
        const spec = loadSpec(ctx.ws, pos[0]);
        if (!spec) return specNotFound(ctx, pos[0]);
        if (format !== 'plain') {
          ctx.stdout.write(
            `${json({
              ...specSummaryJson(spec),
              tasks: spec.tasks?.tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, optional: t.optional, checkpoint: t.isCheckpoint, parentId: t.parentId })) ?? [],
              lint: spec.lint.map((l) => l.message),
            })}\n`,
          );
        } else ctx.stdout.write(`${formatSpecStatus(spec)}\n`);
        return 0;
      }
      case 'view':
      case 'open': {
        const name = needName();
        if (!name) return 2;
        const spec = loadSpec(ctx.ws, name);
        if (!spec) return specNotFound(ctx, name);
        let doc = parseDoc(pos[1]);
        if (pos[1] && !doc) {
          ctx.stderr.write(`error: unknown document '${pos[1]}' (requirements, bugfix, design, tasks)\n`);
          return 2;
        }
        if (doc === 'requirements' && spec.specType === 'bugfix') doc = 'bugfix';
        doc ??= spec.awaitingApproval ?? [...spec.order].reverse().find((k) => spec.docs[k].nonEmpty);
        // a document kiro-claude does not read (a symbolic link, …: docfs) is never printed
        const refused = spec.docs[doc ?? spec.order[0]!].refused;
        if (refused) {
          ctx.stderr.write(`error: ${specRefusalText(refused)}\n`);
          return 1;
        }
        if (!doc || spec.texts[doc] === undefined || !spec.docs[doc].nonEmpty) {
          ctx.stderr.write(`error: ${SPEC_DOC_FILES[doc ?? spec.order[0]!]} has not been written yet\n`);
          return 1;
        }
        ctx.stdout.write(spec.texts[doc]!.endsWith('\n') ? spec.texts[doc]! : `${spec.texts[doc]}\n`);
        return 0;
      }
      case 'new': {
        let name = needName();
        if (!name) return 2;
        if (!isValidSpecName(name)) {
          const norm = normalizeSpecName(name);
          if (!norm) {
            ctx.stderr.write(`error: invalid spec name '${name}' (use kebab-case, e.g. user-authentication)\n`);
            return 2;
          }
          if (interactive) {
            const rt0 = cliRuntime(ctx, rtOpts, deps, io);
            if (!(await rt0.confirm(`Use "${norm}" as the spec name?`, true))) return 1;
          } else ctx.stderr.write(`Using spec name '${norm}'\n`);
          name = norm;
        }
        const k = parseKind(str(p, '--type'));
        if (k === 'invalid') {
          ctx.stderr.write(`error: invalid value '${str(p, '--type')}' for '--type <TYPE>'\n  [possible values: feature, bugfix, quick]\n`);
          return 2;
        }
        const wf = str(p, '--workflow');
        if (wf !== undefined && wf !== 'requirements-first' && wf !== 'design-first') {
          ctx.stderr.write(`error: invalid value '${wf}' for '--workflow <WORKFLOW>'\n  [possible values: requirements-first, design-first]\n`);
          return 2;
        }
        const detail = str(p, '--detail');
        if (detail !== undefined && detail !== 'high' && detail !== 'low') {
          ctx.stderr.write(`error: invalid value '${detail}' for '--detail <LEVEL>'\n  [possible values: high, low]\n`);
          return 2;
        }
        const rt = cliRuntime(ctx, rtOpts, deps, io);
        let kind = k;
        if (!kind && interactive) {
          const i = await rt.choose('What kind of spec?', ['Build a Feature', 'Fix a Bug', 'Quick Spec']);
          if (i === undefined) return 1;
          kind = (['feature', 'bugfix', 'quick'] as const)[i]!;
        }
        kind ??= 'feature';
        let workflowType: WorkflowType | undefined = wf as WorkflowType | undefined;
        if (kind === 'feature' && !workflowType) {
          const def = ctx.settings.getString('kiroClaude.spec.defaultWorkflow');
          if (def === 'requirements-first' || def === 'design-first') workflowType = def;
          else if (interactive) {
            const i = await rt.choose('Which workflow?', ['Requirements-First', 'Design-First']);
            if (i === undefined) return 1;
            workflowType = i === 1 ? 'design-first' : 'requirements-first';
          }
        }
        let detailLevel: 'high' | 'low' | undefined = detail === 'high' || detail === 'low' ? detail : undefined;
        if (kind === 'feature' && workflowType === 'design-first' && !detailLevel && interactive) {
          const i = await rt.choose('Start with which level of design?', ['High Level Design', 'Low Level Design']);
          if (i === undefined) return 1;
          detailLevel = i === 1 ? 'low' : 'high';
        }
        let description = (str(p, '--description') ?? pos.slice(1).join(' ')).trim();
        if (!description && interactive) {
          description = await rt.ask(kind === 'bugfix' ? 'Describe the bug (symptom, where it happens, expected behavior):' : 'What should this spec cover?');
        }
        if (!description) {
          ctx.stderr.write('error: a description is required (--description <TEXT>)\n');
          return 2;
        }
        const req: NewSpecRequest = { name, kind, description, autoApprove: yes };
        if (workflowType) req.workflowType = workflowType;
        if (detailLevel) req.detail = detailLevel;
        const r = await createNewSpec(rt, req);
        return r.status === 'error' ? 1 : 0;
      }
      case 'approve': {
        const name = needName();
        if (!name) return 2;
        const r = await approveSpec(cliRuntime(ctx, rtOpts, deps, io), name, { autoApprove: yes });
        return r.status === 'error' ? 1 : 0;
      }
      case 'revise': {
        const name = needName();
        if (!name) return 2;
        const feedback = pos.slice(1).join(' ').trim();
        if (!feedback) {
          ctx.stderr.write(`error: feedback is required\n\nUsage: ${ctx.progName} spec revise <NAME> <FEEDBACK>...\n`);
          return 2;
        }
        const r = await reviseSpec(cliRuntime(ctx, rtOpts, deps, io), name, feedback, { autoApprove: yes });
        return r.status === 'error' ? 1 : 0;
      }
      case 'run': {
        const name = needName();
        if (!name) return 2;
        const ids = pos.slice(1).flatMap((s) => s.split(',')).filter(Boolean);
        const includeOptional = p.flags.has('--include-optional');
        let sel: TaskSelection;
        if (ids.length) sel = { kind: 'ids', ids, includeOptional };
        else if (p.flags.has('--next')) sel = { kind: 'next', includeOptional };
        else sel = { kind: 'scope', includeOptional };
        const press = new NextPress();
        const rt = cliRuntime(ctx, rtOpts, deps, io, press);
        const ac = new AbortController();
        let sigints = 0;
        const onSig = (): void => {
          sigints++;
          ctx.stderr.write(sigints === 1 ? '\nInterrupting… (press Ctrl+C again to exit)\n' : '\n');
          if (sigints > 1) {
            // a PostTaskExec hook of a task the first press interrupted runs under this press:
            // killing it lets the run end normally (summary, sessions closed); else exit now
            if (press.press()) return;
            process.off('SIGINT', onSig);
            process.kill(process.pid, 'SIGINT'); // default action: terminate
            return;
          }
          ac.abort();
        };
        process.on('SIGINT', onSig);
        try {
          const r = await runSpecTasks(rt, name, sel, { signal: ac.signal });
          return r.status === 'error' || r.status === 'stopped' ? 1 : 0;
        } finally {
          process.off('SIGINT', onSig);
          await rt.finish().catch(() => undefined);
        }
      }
      case 'analyze':
      case 'analyze_requirements':
      case 'analyze-requirements': {
        const name = needName();
        if (!name) return 2;
        const r = await analyzeRequirements(cliRuntime(ctx, rtOpts, deps, io), name, { autoApply: yes });
        return r.status === 'error' ? 1 : 0;
      }
      case 'sync': {
        const name = needName();
        if (!name) return 2;
        const r = await syncSpec(cliRuntime(ctx, rtOpts, deps, io), name);
        return r.status === 'error' ? 1 : 0;
      }
      default:
        ctx.stderr.write(`error: unrecognized subcommand '${sub}'\n\n${SPEC_HELP_TEXT}`);
        return 2;
    }
  } catch (e) {
    ctx.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  } finally {
    ioInst?.close();
  }
}

/** `kiro-claude spec …` (fixed entry point). */
export const runSpecCommand: SubcommandRunner = (args, ctx) => runSpecCommandWith(args, ctx);

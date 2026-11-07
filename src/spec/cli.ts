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
 * Sessions come from session/kiroSession.ts `createSession` (loaded lazily; injectable for tests).
 */

import { randomUUID } from 'node:crypto';
import * as readline from 'node:readline';
import type {
  ApprovalRequest,
  ApprovalResponse,
  CliContext,
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
import { formatSpecList, formatSpecStatus, isValidSpecName, listSpecs, loadSpec, normalizeSpecName, specSummaryJson } from './store.js';
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

// ───────────────────────────── runtime ─────────────────────────────

interface CliRuntimeOptions {
  interactive: boolean;
  agentName?: string;
  model?: string;
  trustAllTools: boolean;
  trustTools?: string[];
}

function cliRuntime(ctx: CliContext, o: CliRuntimeOptions, deps: SpecCliDeps, io: () => SpecCliIO): SpecRuntime {
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
          hooks = all.some((h) => h.trigger === 'PreTaskExec' || h.trigger === 'PostTaskExec') ? { runner: factory(all), sessionId: randomUUID() } : null;
        } catch {
          hooks = null;
        }
      }
      return hooks ?? undefined;
    },
    readyHint: (name) => `Spec ready. Run all tasks: ${prog} spec run ${name} · Step through: ${prog} spec run ${name} --next`,
    finish: () => driver.finish('close'),
  };
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
        const all = listSpecs(ctx.ws);
        if (format !== 'plain') ctx.stdout.write(`${json(all.map(specSummaryJson))}\n`);
        else if (all.length === 0) ctx.stderr.write(`No specs found in ${ctx.ws.workspaceRoot}/.kiro/specs. Create one with: ${ctx.progName} spec new <name>\n`);
        else ctx.stdout.write(`${formatSpecList(all)}\n`);
        return 0;
      }
      case 'status': {
        if (!pos[0]) {
          const all = listSpecs(ctx.ws);
          if (format !== 'plain') ctx.stdout.write(`${json(all.map(specSummaryJson))}\n`);
          else if (all.length === 0) ctx.stderr.write(`No specs found in ${ctx.ws.workspaceRoot}/.kiro/specs. Create one with: ${ctx.progName} spec new <name>\n`);
          else ctx.stdout.write(`${formatSpecList(all)}\n`);
          return 0;
        }
        const spec = loadSpec(ctx.ws, pos[0]);
        if (!spec) {
          ctx.stderr.write(`error: spec '${pos[0]}' not found\n`);
          return 1;
        }
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
        if (!spec) {
          ctx.stderr.write(`error: spec '${name}' not found\n`);
          return 1;
        }
        let doc = parseDoc(pos[1]);
        if (pos[1] && !doc) {
          ctx.stderr.write(`error: unknown document '${pos[1]}' (requirements, bugfix, design, tasks)\n`);
          return 2;
        }
        if (doc === 'requirements' && spec.specType === 'bugfix') doc = 'bugfix';
        doc ??= spec.awaitingApproval ?? [...spec.order].reverse().find((k) => spec.docs[k].nonEmpty);
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
        const rt = cliRuntime(ctx, rtOpts, deps, io);
        const ac = new AbortController();
        let sigints = 0;
        const onSig = (): void => {
          sigints++;
          ctx.stderr.write(sigints === 1 ? '\nInterrupting… (press Ctrl+C again to exit)\n' : '\n');
          if (sigints > 1) {
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

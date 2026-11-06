/**
 * Rendering of one chat turn: assistant text, thinking, tool calls, todos, notices
 * (06 §5.3–§5.6, 01 §4.7–§4.8).
 *
 * Classic layout (exact strings from 06 §5.4/§5.5):
 * ```
 * 🛠️  Using tool: <displayName>[ (trusted)][ from mcp server <server>]
 *  ⋮
 *  ● <tool-specific description>
 *  ⋮
 *  ↳ Purpose: <summary>
 *
 * <tool output (shell / MCP)>
 *  ⋮
 *  ● Completed in <secs>.<millis>s          ← millis NOT zero-padded (Q quirk: 5 ms ⇒ 0.5s)
 * ```
 * Failure: ` ● Execution failed after <t>s:` + newline + the error text (red).
 * Assistant text starts with a green `> ` before its first non-whitespace character and is
 * rendered by repl/markdown.ts (or raw with `chat.disableMarkdownRendering`). Thinking deltas
 * are shown dim when `chat.showThinking` (default true). A response after a tool call gets a
 * fresh `> `.
 *
 * Descriptions for Claude tools without a Q twin (Glob, WebFetch, WebSearch, Agent, Skill)
 * are DECISIONs in Q's style. Tool output is previewed (20 lines) unless
 * `chat.autoExpandToolOutput`.
 *
 * Terminal safety (DECISION, hardening over Classic which printed raw bytes): text that comes
 * from the model, tools or files never reaches the terminal as control sequences. Tool
 * descriptions (what an approval prompt shows) render control and bidi-override characters
 * visibly (`\x1b`, `\x0d`, `\u{202e}`) so a command cannot hide or rewrite part of itself;
 * assistant text, thinking, tool output, denial reasons and todo subjects have escape
 * sequences and C0/C1 controls (except tab / newline / CR) removed.
 *
 * Pure apart from the `write` callback and timers (spinner).
 */

import * as path from 'node:path';
import type { KiroToolCall, SessionEvent, TodoItem, TurnResult } from '../types.js';
import { c } from '../util/ansi.js';
import { MarkdownStream } from './markdown.js';

export interface RenderSettings {
  /** chat.disableMarkdownRendering = false */
  markdown: boolean;
  /** Wrap width (undefined = no wrapping). */
  wrapWidth?: number;
  /** Terminal width (rules, tip box). */
  columns?: number;
  /** chat.showThinking */
  showThinking: boolean;
  /** chat.autoExpandToolOutput */
  autoExpandToolOutput: boolean;
  /** ASCII glyphs (chat.allowAsciiArt=false, KIRO_ASCII_MODE=1). */
  ascii: boolean;
  /** Base for relative paths in tool descriptions. */
  cwd: string;
}

export interface Glyphs {
  cont: string;
  bullet: string;
  arrow: string;
  tool: string;
}

export const UNICODE_GLYPHS: Glyphs = { cont: ' ⋮ ', bullet: ' ● ', arrow: ' ↳ ', tool: '🛠️  ' };
export const ASCII_GLYPHS: Glyphs = { cont: ' : ', bullet: ' * ', arrow: ' > ', tool: '' };

/** Q duration format `<secs>.<millis>s` (millis not zero-padded, 06 §5.5). */
export function formatToolDuration(ms: number): string {
  const t = Math.max(0, Math.round(ms));
  return `${Math.floor(t / 1000)}.${t % 1000}s`;
}

/** Path relative to `cwd` unless that would start with `../../..` (Q tools/mod.rs). */
export function displayPath(p: string, cwd: string): string {
  if (!p) return p;
  const abs = path.resolve(cwd, p);
  const rel = path.relative(cwd, abs);
  if (rel === '') return '.';
  if (rel.startsWith(`..${path.sep}..${path.sep}..`) || path.isAbsolute(rel)) return abs;
  return rel;
}

/** ESC sequences: CSI, OSC (BEL / ST terminated, or cut at the end of the chunk), DCS/SOS/PM/APC, 2-byte. */
const ESC_SEQUENCE = /\u001b(?:\[[0-?]*[ -/]*[@-~]?|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[PX^_][^\u001b]*(?:\u001b\\)?|[ -~])?/g;
/** C0 (except tab, newline, CR), DEL and C1 controls. */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
/** Every control except tab / newline, plus bidi embedding/override/isolate characters. */
const INVISIBLE_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;

/** Remove terminal escape sequences and control characters (keeps `\t`, `\n`, `\r`). */
export function stripTerminalControls(s: string): string {
  return s.replace(ESC_SEQUENCE, '').replace(CONTROL_CHARS, '');
}

/** Show control and bidi characters as `\xNN` / `\u{NNNN}` (tool descriptions, see module doc). */
export function visibleControls(s: string): string {
  return s.replace(INVISIBLE_CHARS, (ch) => {
    const n = ch.codePointAt(0)!;
    return n <= 0xff ? `\\x${n.toString(16).padStart(2, '0')}` : `\\u{${n.toString(16)}}`;
  });
}

/** A string input field, made safe for display (see module doc). */
function str(v: unknown): string | undefined {
  return typeof v === 'string' ? visibleControls(v) : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function previewLines(text: string, max: number | undefined, mark: (l: string) => string): string {
  const lines = text.replace(/\n$/, '').split('\n');
  const shown = max === undefined ? lines : lines.slice(0, max);
  let out = shown.map(mark).join('\n') + '\n';
  if (max !== undefined && lines.length > max) out += c.gray(`... (${lines.length - max} more lines)`) + '\n';
  return out;
}

function purpose(g: Glyphs, text: string | undefined): string {
  if (!text || text.trim() === '') return '';
  return `${g.cont}\n${g.arrow}${c.blue('Purpose: ')}${text.trim()}\n`;
}

/** Tool label line (06 §5.4), without the trailing newline. */
export function toolHeaderLine(call: KiroToolCall, trusted: boolean, g: Glyphs = UNICODE_GLYPHS): string {
  const name = visibleControls(call.mcp ? call.mcp.tool : call.displayName);
  let s = c.magenta(`${g.tool}Using tool: ${name}`);
  if (trusted) s += c.green(' (trusted)');
  if (call.mcp) s += ` from mcp server ${c.magenta(visibleControls(call.mcp.server))}`;
  if (call.subagent) s += c.gray(` [subagent: ${visibleControls(call.subagent.type)}]`);
  return s;
}

/** Tool-specific description (the part after ` ● `), ending with `\n`; '' when none. */
export function describeTool(call: KiroToolCall, opts: { cwd: string; expand: boolean; glyphs?: Glyphs }): string {
  const g = opts.glyphs ?? UNICODE_GLYPHS;
  const i = call.input ?? {};
  const max = opts.expand ? undefined : 10;
  const rel = (p: string | undefined): string => displayPath(p ?? '', call.cwd || opts.cwd);
  if (call.mcp) {
    const keys = i && typeof i === 'object' ? Object.keys(i) : [];
    const tool = visibleControls(call.mcp.tool);
    if (keys.length === 0) return `Running ${c.green(tool)}\n`;
    const json = visibleControls(JSON.stringify(i, null, 2) ?? '');
    return `Running ${c.green(tool)} with the param:\n${json
      .split('\n')
      .map((l) => `${g.cont} ${l}`)
      .join('\n')}\n`;
  }
  switch (call.claudeName) {
    case 'Bash': {
      const cmd = str(i.command) ?? '';
      const sep = Buffer.byteLength(cmd, 'utf8') > 20 ? '\n' : '';
      return `I will run the following shell command: ${sep}${c.green(cmd)}\n${purpose(g, str(i.description))}`;
    }
    case 'Read': {
      const o = num(i.offset);
      const l = num(i.limit);
      let range: string;
      if (o === undefined && l === undefined) range = 'all lines';
      else if (l === undefined) range = `from line ${c.green(String(o))} to end of file`;
      else {
        const start = o ?? 1;
        range = `from line ${c.green(String(start))} to ${c.green(String(start + l - 1))}`;
      }
      return `Reading file: ${c.green(rel(str(i.file_path)))}, ${range}\n`;
    }
    case 'Glob':
      return `Searching for files matching: ${c.green(str(i.pattern) ?? '')} in ${c.green(rel(str(i.path) ?? '.'))}\n`;
    case 'Grep':
      return `Searching: ${c.green(rel(str(i.path) ?? '.'))} for pattern: ${c.green(str(i.pattern) ?? '')}\n`;
    case 'Write': {
      const content = str(i.content) ?? '';
      let s = `Path: ${c.green(rel(str(i.file_path)))}\n`;
      if (content !== '') s += `\n${previewLines(content, max, (x) => c.green(`+ ${x}`))}`;
      return s;
    }
    case 'Edit':
    case 'MultiEdit': {
      let s = `Path: ${c.green(rel(str(i.file_path)))}\n`;
      const edits: { old: string; neu: string }[] = Array.isArray(i.edits)
        ? (i.edits as Record<string, unknown>[]).map((e) => ({ old: str(e.old_string) ?? '', neu: str(e.new_string) ?? '' }))
        : [{ old: str(i.old_string) ?? '', neu: str(i.new_string) ?? '' }];
      for (const e of edits) {
        s += '\n';
        if (e.old !== '') s += previewLines(e.old, max, (x) => c.red(`- ${x}`));
        if (e.neu !== '') s += previewLines(e.neu, max, (x) => c.green(`+ ${x}`));
      }
      return s;
    }
    case 'NotebookEdit':
      return `Path: ${c.green(rel(str(i.notebook_path)))}\n`;
    case 'WebFetch':
      return `Fetching: ${c.green(str(i.url) ?? '')}\n${purpose(g, str(i.prompt))}`;
    case 'WebSearch':
      return `Searching the web for: ${c.green(str(i.query) ?? '')}\n`;
    case 'Agent':
    case 'Task': {
      const t = str(i.subagent_type) || 'general-purpose';
      return `Delegating to subagent ${c.green(t)}\n${purpose(g, str(i.description))}`;
    }
    case 'Skill':
      return `Using skill: ${c.green(visibleControls(call.subjects[0] ?? '') || str(i.skill) || '')}\n`;
    default:
      if (call.capability === 'utility' && call.v2Name === 'todo_list') return '';
      return call.summary ? `${visibleControls(call.summary)}\n` : '';
  }
}

/** Full tool block (header + description), starting at a fresh line. */
export function formatToolUse(call: KiroToolCall, trusted: boolean, opts: { cwd: string; expand: boolean; glyphs?: Glyphs }): string {
  const g = opts.glyphs ?? UNICODE_GLYPHS;
  const desc = describeTool(call, opts);
  return `${toolHeaderLine(call, trusted, g)}\n${desc ? `${g.cont}\n${g.bullet}${desc}` : ''}`;
}

/** TODO list display (06 §6.5): `TODO:` + `[x]` / `[ ]` rows. */
export function formatTodos(todos: readonly TodoItem[]): string {
  const live = todos.filter((t) => t.status !== 'deleted');
  if (live.length === 0) return `${c.yellow('TODO:')} ${c.gray('(empty)')}\n`;
  let s = `${c.yellow('TODO:')}\n`;
  for (const t of live) {
    const subject = stripTerminalControls(t.subject).replace(/[\r\n]+/g, ' ');
    if (t.status === 'completed') s += `${c.green('[x]')} ${c.gray(c.italic(subject))}\n`;
    else if (t.status === 'in_progress') s += `[ ] ${c.bold(subject)} ${c.gray('(in progress)')}\n`;
    else s += `[ ] ${subject}\n`;
  }
  return s;
}

/** Shell/MCP-like tools whose output Classic prints. */
function showsOutput(call: KiroToolCall | undefined): boolean {
  if (!call) return false;
  if (call.mcp) return true;
  return ['Bash', 'WebFetch', 'WebSearch', 'Agent', 'Task'].includes(call.claudeName);
}

// ───────────────────────────── spinner ─────────────────────────────

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** `Thinking...` spinner (cli-spinners "dots" @80 ms, 06 §5.3). No-op when disabled. */
export class Spinner {
  private timer: NodeJS.Timeout | undefined;
  private frame = 0;
  private text = '';

  constructor(
    private readonly rawWrite: (s: string) => void,
    private readonly enabled: boolean,
  ) {}

  get active(): boolean {
    return this.timer !== undefined;
  }

  start(text = 'Thinking...'): void {
    if (!this.enabled || this.timer) return;
    this.text = text;
    this.frame = 0;
    this.draw();
    this.timer = setInterval(() => this.draw(), 80);
    this.timer.unref?.();
  }

  private draw(): void {
    const f = SPINNER_FRAMES[this.frame++ % SPINNER_FRAMES.length]!;
    this.rawWrite(`\r${f} ${this.text}`);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
    this.rawWrite(`\r${' '.repeat(this.text.length + 2)}\r`);
  }
}

// ───────────────────────────── turn renderer ─────────────────────────────

/** Renders the SessionEvents of turns (see module doc). One instance per REPL. */
export class TurnRenderer {
  private md: MarkdownStream | undefined;
  private responseStarted = false;
  private thinking = false;
  private thinkingCol = 0;
  private readonly shown = new Set<string>();
  /** Tool whose block is the last thing on the screen (nothing printed after it). */
  private lastBlockToolId: string | undefined;
  private readonly startedAt = new Map<string, number>();
  private trailingNewlines = 2;
  private renderedText = false;
  private text = '';
  private readonly glyphs: Glyphs;

  constructor(
    private readonly out: (s: string) => void,
    private readonly settings: RenderSettings,
    private readonly now: () => number = Date.now,
  ) {
    this.glyphs = settings.ascii ? ASCII_GLYPHS : UNICODE_GLYPHS;
  }

  private write(s: string): void {
    if (s === '') return;
    this.out(s);
    this.track(s);
  }

  /** The cursor is at the start of a line that follows a non-empty line (after a read). */
  freshLine(): void {
    this.trailingNewlines = 1;
  }

  /** Account for text written to the same terminal by someone else (prompts, commands). */
  track(s: string): void {
    if (s === '') return;
    this.lastBlockToolId = undefined;
    const plain = s.replace(/\u001b\[[0-9;]*m/g, '');
    if (plain === '') return;
    const m = /\n*$/.exec(plain)![0].length;
    this.trailingNewlines = m === plain.length ? Math.min(2, this.trailingNewlines + m) : m;
  }

  /** Make sure the output ends with an empty line (two newlines). */
  private blankLine(): void {
    if (this.trailingNewlines === 0) this.write('\n\n');
    else if (this.trailingNewlines === 1) this.write('\n');
  }

  private newline(): void {
    if (this.trailingNewlines === 0) this.write('\n');
  }

  beginTurn(): void {
    this.responseStarted = false;
    this.thinking = false;
    this.renderedText = false;
    this.text = '';
    this.shown.clear();
    this.startedAt.clear();
  }

  /** Accumulated assistant text of the current turn. */
  get assistantText(): string {
    return this.text;
  }

  /** Whether any assistant text was rendered this turn. */
  get hasRenderedText(): boolean {
    return this.renderedText;
  }

  /** End any open text/thinking block (before tool lines, notices, prompts). */
  pause(): void {
    if (this.md) {
      this.md.end();
      this.md = undefined;
      this.trailingNewlines = Math.max(this.trailingNewlines, 1);
    }
    if (this.thinking) {
      if (this.thinkingCol > 0) this.write('\n');
      this.thinking = false;
      this.thinkingCol = 0;
    }
  }

  private endResponse(): void {
    this.pause();
    this.responseStarted = false;
  }

  /** Render assistant text (deltas or whole blocks). */
  private pushText(text: string): void {
    if (this.thinking) {
      this.pause();
      this.newline();
    }
    let t = stripTerminalControls(text);
    if (!this.responseStarted) {
      t = t.replace(/^\s+/, '');
      if (t === '') return;
      this.blankLine();
      this.write(c.green('> '));
      this.responseStarted = true;
    }
    this.renderedText = true;
    if (!this.settings.markdown) {
      this.write(t);
      return;
    }
    if (!this.md) {
      const md = new MarkdownStream((s) => this.write(s), {
        ...(this.settings.wrapWidth !== undefined ? { width: this.settings.wrapWidth } : {}),
        ...(this.settings.columns !== undefined ? { columns: this.settings.columns } : {}),
        ascii: this.settings.ascii,
      });
      md.setColumn(this.trailingNewlines === 0 ? 2 : 0);
      this.md = md;
    }
    this.md.push(t);
  }

  private pushThinking(raw: string): void {
    const text = stripTerminalControls(raw);
    if (!this.settings.showThinking || text === '') return;
    if (this.md) this.pause();
    if (!this.thinking) {
      this.blankLine();
      this.thinking = true;
      this.thinkingCol = 0;
    }
    const styled = text
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((l) => (l === '' ? '' : c.gray(c.italic(l))))
      .join('\n');
    this.write(styled);
    const lastNl = text.lastIndexOf('\n');
    this.thinkingCol = lastNl >= 0 ? text.length - lastNl - 1 : this.thinkingCol + text.length;
  }

  /**
   * Print the header + description of `call` once (tool_start or an approval prompt). With
   * `forApproval`, a block that is no longer the last thing on the screen (another tool's block
   * or text came after it, e.g. parallel calls) is printed again, so the `[y/n/t]` question
   * always sits right under the tool it is about (Q prints the description before asking).
   */
  showTool(call: KiroToolCall, trusted: boolean, forApproval = false): void {
    const id = call.toolUseId;
    if (id && this.shown.has(id) && !(forApproval && this.lastBlockToolId !== id)) return;
    if (id) {
      this.shown.add(id);
      if (!this.startedAt.has(id)) this.startedAt.set(id, this.now());
    }
    this.endResponse();
    this.blankLine();
    this.write(formatToolUse(call, trusted, { cwd: this.settings.cwd, expand: this.settings.autoExpandToolOutput, glyphs: this.glyphs }));
    this.lastBlockToolId = id;
  }

  /** Whether the tool with this id was displayed already. */
  wasShown(toolUseId: string | undefined): boolean {
    return toolUseId !== undefined && this.shown.has(toolUseId);
  }

  /** Print a notice line (colour by level). */
  notice(level: 'info' | 'warn' | 'error', message: string): void {
    this.endResponse();
    this.newline();
    const styled = level === 'error' ? c.red(message) : level === 'warn' ? c.yellow(message) : c.gray(message);
    this.write(`${styled}\n`);
  }

  handle(ev: SessionEvent): void {
    const g = this.glyphs;
    switch (ev.type) {
      case 'text_delta':
      case 'text':
        this.text += ev.text;
        this.pushText(ev.text);
        if (ev.type === 'text' && !ev.text.endsWith('\n') && this.md) this.md.push('\n');
        return;
      case 'thinking_delta':
        this.pushThinking(ev.text);
        return;
      case 'tool_start': {
        const call = ev.toolUseId && !ev.call.toolUseId ? { ...ev.call, toolUseId: ev.toolUseId } : ev.call;
        if (this.wasShown(ev.toolUseId)) return;
        this.showTool(call, ev.trusted);
        if (ev.toolUseId) this.startedAt.set(ev.toolUseId, this.now());
        return;
      }
      case 'tool_denied': {
        const call = ev.toolUseId && !ev.call.toolUseId ? { ...ev.call, toolUseId: ev.toolUseId } : ev.call;
        if (!this.wasShown(ev.toolUseId)) this.showTool(call, false);
        this.newline();
        this.write(`${g.cont}\n${c.red(c.bold(g.bullet))}${c.red(stripTerminalControls(ev.reason))}\n\n`);
        this.responseStarted = false;
        return;
      }
      case 'tool_end': {
        if (ev.call && !this.wasShown(ev.toolUseId)) this.showTool({ ...ev.call, toolUseId: ev.toolUseId }, false);
        this.endResponse();
        const started = this.startedAt.get(ev.toolUseId);
        const ms = ev.durationMs ?? (started !== undefined ? this.now() - started : 0);
        const out = stripTerminalControls(ev.output ?? '')
          .replace(/\r\n?/g, '\n')
          .replace(/\s+$/, '');
        this.newline();
        if (ev.isError) {
          this.write(`${g.cont}\n${c.red(c.bold(`${g.bullet}Execution failed after ${formatToolDuration(ms)}:`))}\n`);
          if (out) this.write(c.red(out) + '\n');
          this.write('\n');
        } else {
          if (out && showsOutput(ev.call)) {
            this.blankLine();
            this.write(previewLines(out, this.settings.autoExpandToolOutput ? undefined : 20, (l) => l));
          }
          this.write(`${g.cont}\n${c.green(c.bold(`${g.bullet}Completed in ${formatToolDuration(ms)}`))}\n\n`);
        }
        this.responseStarted = false;
        return;
      }
      case 'todo_update':
        this.endResponse();
        this.blankLine();
        this.write(formatTodos(ev.todos));
        return;
      case 'compaction':
        this.endResponse();
        this.newline();
        if (ev.state === 'started') this.write(`${c.yellow('Summarizing the conversation history...')}\n`);
        else {
          const tok =
            ev.preTokens !== undefined && ev.postTokens !== undefined ? c.gray(` (${ev.preTokens} → ${ev.postTokens} tokens)`) : '';
          this.write(`${c.green('✔ Conversation history has been compacted successfully!')}${tok}\n\n`);
        }
        return;
      case 'notice':
        this.notice(ev.level, ev.message);
        return;
      case 'subagent':
        this.endResponse();
        this.newline();
        if (ev.state === 'started') {
          const desc = ev.description ? `: ${stripTerminalControls(ev.description)}` : '';
          this.write(c.gray(`${g.arrow}Subagent ${stripTerminalControls(ev.agentType)} started${desc}`) + '\n');
        } else {
          this.write(c.gray(`${g.arrow}Subagent ${stripTerminalControls(ev.agentType)} finished`) + '\n');
        }
        return;
      case 'rate_limit':
        if (ev.status === 'rejected') {
          const when = ev.resetsAt ? ` It resets at ${formatResetTime(ev.resetsAt)}.` : '';
          this.notice('error', `You have reached your Claude usage limit.${when}`);
        } else if (ev.status === 'allowed_warning') {
          const pct = ev.utilization !== undefined ? ` (${Math.round(ev.utilization * (ev.utilization <= 1 ? 100 : 1))}% used)` : '';
          this.notice('warn', `You are approaching your Claude usage limit${pct}.`);
        }
        return;
      default:
        return;
    }
  }

  /** Finish the turn: close blocks, print the fallback text and error lines. */
  endTurn(result: TurnResult | undefined, opts: { progName: string }): void {
    if (result && !this.renderedText && !result.isError && result.text.trim() !== '' && result.stopReason !== 'local_command') {
      this.text = result.text;
      this.pushText(result.text);
    }
    this.endResponse();
    if (!result) return;
    if (result.authError) {
      this.newline();
      this.write(`${c.red(`You are not logged in, please log in with ${opts.progName} login`)}\n`);
      return;
    }
    if (result.stopReason === 'cancelled') {
      this.blankLine();
      return;
    }
    if (result.isError) {
      this.newline();
      const msg = stripTerminalControls(result.error ?? result.text ?? 'unknown error').trim() || 'unknown error';
      this.write(`${c.red(c.bold(`Kiro is having trouble responding right now: ${msg}`))}\n\n`);
      return;
    }
    if (result.stopReason === 'max_turns') this.notice('warn', 'The turn stopped after reaching the maximum number of agent turns.');
    else if (result.stopReason === 'refusal') this.notice('warn', 'The model declined to answer this request.');
    this.blankLine();
  }
}

/** Local time for rate-limit resets (`resetsAt` in seconds or ms since the epoch). */
export function formatResetTime(resetsAt: number): string {
  const ms = resetsAt < 1e12 ? resetsAt * 1000 : resetsAt;
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

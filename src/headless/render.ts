/**
 * Output of `chat --no-interactive` (00 §2.5 "Headless output", 01 §3, 06 §5.4–5.5).
 *
 * Text format ({@link TextRenderer}):
 *  - assistant text ⇒ stdout, streamed as it arrives (`text_delta`; complete `text` blocks only
 *    when no deltas were streamed for them — KiroSession already guarantees that); when a tool
 *    call starts after text, the text line is terminated so the next text starts on a new line;
 *    stdout always ends with a newline when anything was written;
 *  - tool calls, denials, warnings, hook output and notices ⇒ stderr, in Q's Classic layout
 *    (06 §5.4–5.5): `🛠️  Using tool: <display>[ (trusted)][ from mcp server <s>]`, ` ⋮ `,
 *    ` ● <summary>` [+ ` ⋮ \n ↳ Purpose: <description>`], then on completion ` ⋮ ` +
 *    ` ● Completed in <secs>.<millis>s` (millis not zero-padded, Q quirk) or
 *    ` ● Execution failed after <t>s:` + the error text; a gate denial prints
 *    ` ● Denied: <reason>` (and the matching failed `tool_end` is not printed again);
 *  - no colours (stdout/stderr may be captured; headless is for scripts).
 *
 * stream-json format ({@link JsonRenderer}): one JSON object per line on stdout (DECISION — Kiro's
 * headless event schema is unpublished, 01 §3 / 00 §2.5 P2): `{"type":"session",…}` once, every
 * {@link SessionEvent} except `raw` (tool events carry Kiro names instead of the full call),
 * `{"type":"result",…}` per turn, `{"type":"interrupted"}` when a run is interrupted and
 * `{"type":"error","message"}` for fatal errors. Nothing but JSON lines is written to stdout.
 */

import type { KiroToolCall, SessionEvent, TurnResult } from '../types.js';
import { toolDisplay } from '../policy/toolmap.js';

/** Minimal writable surface (process streams, PassThrough, test doubles). */
export interface OutStream {
  write(chunk: string): boolean;
}

/** Q `Completed in <secs>.<millis>s` duration (millis not zero-padded, 06 §5.5). */
export function formatToolDuration(ms: number): string {
  const t = Math.max(0, Math.round(ms));
  return `${Math.floor(t / 1000)}.${t % 1000}s`;
}

/** Lines printed when a tool call starts (06 §5.4, uncoloured). */
export function toolStartLines(call: KiroToolCall, trusted: boolean): string {
  let s = `\n🛠️  Using tool: ${toolDisplay(call, trusted)}\n ⋮ \n`;
  const summary = call.summary.trim();
  s += summary ? ` ● ${summary}\n` : ' ● \n';
  const purpose = typeof call.input.description === 'string' ? call.input.description.trim() : '';
  if (purpose) s += ` ⋮ \n ↳ Purpose: ${purpose}\n`;
  return s;
}

/** Common interface of the two renderers. */
export interface HeadlessRenderer {
  /** Session header (stream-json only). */
  session(info: { sessionId: string; agent: string; model: string; claudeSessionId?: string }): void;
  event(e: SessionEvent): void;
  result(r: TurnResult, info: { sessionId: string }): void;
  /** Output of a local command (no model turn). */
  local(command: string, text: string): void;
  notice(level: 'info' | 'warn' | 'error', message: string): void;
  /** Fatal error before or outside a turn. */
  error(message: string): void;
  interrupted(info: { sessionId?: string }): void;
  /** Terminate any open stdout line. */
  finish(): void;
}

interface ToolState {
  started: number;
  denied: boolean;
  call?: KiroToolCall;
}

/** Human-readable renderer (see module doc). */
export class TextRenderer implements HeadlessRenderer {
  private atLineStart = true;
  private wroteText = false;
  private readonly tools = new Map<string, ToolState>();

  constructor(
    private readonly stdout: OutStream,
    private readonly stderr: OutStream,
    private readonly now: () => number = Date.now,
  ) {}

  private text(s: string): void {
    if (s === '') return;
    this.stdout.write(s);
    this.wroteText = true;
    this.atLineStart = s.endsWith('\n');
  }

  private breakLine(): void {
    if (!this.atLineStart) {
      this.stdout.write('\n');
      this.atLineStart = true;
    }
  }

  /** True when any assistant text was written in the current turn. */
  get hasText(): boolean {
    return this.wroteText;
  }

  session(): void {
    // nothing in text mode
  }

  event(e: SessionEvent): void {
    switch (e.type) {
      case 'text_delta':
      case 'text':
        this.text(e.text);
        return;
      case 'tool_start': {
        this.breakLine();
        this.tools.set(e.toolUseId, { started: this.now(), denied: false, call: e.call });
        this.stderr.write(toolStartLines(e.call, e.trusted));
        return;
      }
      case 'tool_denied': {
        this.breakLine();
        const id = e.toolUseId ?? '';
        const st = id ? this.tools.get(id) : undefined;
        if (!st) this.stderr.write(toolStartLines(e.call, false));
        this.stderr.write(` ⋮ \n ● Denied: ${e.reason}\n\n`);
        if (id) this.tools.set(id, { started: st?.started ?? this.now(), denied: true, call: e.call });
        return;
      }
      case 'tool_end': {
        const st = this.tools.get(e.toolUseId);
        if (st?.denied) return;
        const ms = e.durationMs ?? (st ? this.now() - st.started : 0);
        if (e.isError) {
          const body = e.output.trim();
          this.stderr.write(` ⋮ \n ● Execution failed after ${formatToolDuration(ms)}:\n${body ? `${body}\n` : ''}\n`);
        } else {
          this.stderr.write(` ⋮ \n ● Completed in ${formatToolDuration(ms)}\n\n`);
        }
        return;
      }
      case 'notice':
        this.notice(e.level, e.message);
        return;
      case 'compaction':
        if (e.state === 'started') this.stderr.write('Compacting conversation...\n');
        else this.stderr.write('✔ Conversation compacted\n');
        return;
      case 'rate_limit':
        if (e.status === 'rejected') {
          const when = e.resetsAt ? ` (resets ${new Date(e.resetsAt * (e.resetsAt < 1e12 ? 1000 : 1)).toISOString()})` : '';
          this.stderr.write(`WARNING: Claude Code usage limit reached${when}\n`);
        }
        return;
      case 'subagent':
      case 'todo_update':
      case 'thinking_delta':
      case 'session_id':
      case 'raw':
        return;
      default:
        return;
    }
  }

  result(r: TurnResult): void {
    if (!this.wroteText && r.text && !r.isError) this.text(r.text);
    this.breakLine();
    // reset per-turn state
    this.wroteText = false;
    this.tools.clear();
  }

  local(_command: string, text: string): void {
    this.text(text.endsWith('\n') ? text : `${text}\n`);
  }

  notice(_level: 'info' | 'warn' | 'error', message: string): void {
    this.stderr.write(message.endsWith('\n') ? message : `${message}\n`);
  }

  error(message: string): void {
    this.breakLine();
    this.stderr.write(message.endsWith('\n') ? message : `${message}\n`);
  }

  interrupted(): void {
    this.breakLine();
  }

  finish(): void {
    this.breakLine();
  }
}

function toolFields(call: KiroToolCall | undefined): Record<string, unknown> {
  if (!call) return {};
  return {
    tool: call.mcp ? `@${call.mcp.server}/${call.mcp.tool}` : call.kiro2Name,
    claudeName: call.claudeName,
    displayName: toolDisplay(call),
    summary: call.summary,
    ...(call.mcp ? { mcpServer: call.mcp.server } : {}),
  };
}

/** Normalized JSON-lines renderer (see module doc). */
export class JsonRenderer implements HeadlessRenderer {
  constructor(private readonly stdout: OutStream) {}

  private emit(obj: Record<string, unknown>): void {
    let line: string;
    try {
      line = JSON.stringify(obj);
    } catch {
      line = JSON.stringify({ type: obj.type, error: 'unserializable event' });
    }
    this.stdout.write(`${line}\n`);
  }

  session(info: { sessionId: string; agent: string; model: string; claudeSessionId?: string }): void {
    this.emit({ type: 'session', ...info });
  }

  event(e: SessionEvent): void {
    switch (e.type) {
      case 'raw':
        return;
      case 'tool_start':
        this.emit({ type: 'tool_start', toolUseId: e.toolUseId, ...toolFields(e.call), input: e.call.input, trusted: e.trusted });
        return;
      case 'tool_denied':
        this.emit({ type: 'tool_denied', ...(e.toolUseId ? { toolUseId: e.toolUseId } : {}), ...toolFields(e.call), reason: e.reason });
        return;
      case 'tool_end':
        this.emit({
          type: 'tool_end',
          toolUseId: e.toolUseId,
          ...toolFields(e.call),
          isError: e.isError,
          output: e.output,
          ...(e.durationMs !== undefined ? { durationMs: e.durationMs } : {}),
        });
        return;
      default:
        this.emit({ ...e });
    }
  }

  result(r: TurnResult, info: { sessionId: string }): void {
    this.emit({
      type: 'result',
      stopReason: r.stopReason,
      isError: r.isError,
      text: r.text,
      ...(r.error !== undefined ? { error: r.error } : {}),
      ...(r.authError ? { authError: true } : {}),
      ...(r.usage ? { usage: r.usage } : {}),
      ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}),
      ...(r.numTurns !== undefined ? { numTurns: r.numTurns } : {}),
      ...(r.localCommand !== undefined ? { localCommand: r.localCommand } : {}),
      permissionDenials: r.permissionDenials,
      sessionId: info.sessionId,
      ...(r.claudeSessionId ? { claudeSessionId: r.claudeSessionId } : {}),
    });
  }

  local(command: string, text: string): void {
    this.emit({ type: 'text', text });
    this.emit({ type: 'result', stopReason: 'local_command', isError: false, text, localCommand: command, permissionDenials: [] });
  }

  notice(level: 'info' | 'warn' | 'error', message: string): void {
    this.emit({ type: 'notice', level, message });
  }

  error(message: string): void {
    this.emit({ type: 'error', message });
  }

  interrupted(info: { sessionId?: string }): void {
    this.emit({ type: 'interrupted', ...(info.sessionId ? { sessionId: info.sessionId } : {}) });
  }

  finish(): void {
    // lines are always complete
  }
}

/**
 * Per-turn user message composition (00 §6.2, binding) and conditional-steering activation
 * (03 §3, 00 §2.2).
 *
 * {@link composeUserTurn} renders, in order (each part only when present):
 * ```
 * --- CONTEXT ENTRY BEGIN ---            userPromptSubmit hook outputs (Q formatHookContext
 * This section (like others) …            without "for the entire conversation", 06 §3.7)
 *
 * <output>
 *
 * --- CONTEXT ENTRY END ---
 *
 * <extraContext blocks>                   e.g. spec-phase instructions, plan-mode block
 * <steering name="<stem>">…</steering>    #name / /name manual steering, fileMatch path hits
 * <@file / @dir / #spec / #git diff expansions>
 * --- USER MESSAGE BEGIN ---
 * <user text>[\n\n<agent-action hook prompt>…]--- USER MESSAGE END ---
 * ```
 * This is Q's `contentWithContext` (06 §4.5): the hook block is followed by one extra `\n`,
 * the USER MESSAGE wrapper is used only when some context precedes the text, and there is NO
 * newline before `--- USER MESSAGE END ---` (Q quirk, kept verbatim); the result is trimmed.
 * No timestamp block (00 §6.2 DECISION). Agent-action (`askAgent`) userPromptSubmit prompts
 * are appended to the user text as `<text>\n\n<prompt>` (00 §2.4). Images turn the result into
 * a content-block array: image blocks first (Claude's recommended order), then the text block
 * (omitted when empty).
 *
 * {@link SteeringActivator} owns the "inject each conditional steering file at most once per
 * session" state (03 §3):
 *  - `forPrompt(text)`: manual/auto files named by `#<name>` / `#"<name>"` or a whole-token
 *    `/<name>`, and any conditional file named by `#steering:<name|name.md|path>` (names match
 *    the steering name or the file stem, case-insensitively, the same lookup as context/refs
 *    `findSteering`; tokens inside code are ignored), plus fileMatch files whose patterns
 *    match a path token of the prompt (`@path`, `#path`, quoted or back-ticked paths, bare
 *    tokens containing `/` or a file extension);
 *  - `forToolPath(absPath)`: fileMatch files matching a path the agent read or wrote ⇒ text for
 *    the PostToolUse `additionalContext`;
 *  - `reset()` forgets what was injected (new Claude conversation: /clear, respawn without
 *    history).
 * fileMatch semantics: patterns use the steering glob dialect (`'path'`, `*` does not cross
 * `/`) with `{a,b}` brace expansion; a pattern without `/` matches the basename anywhere
 * (match-base, 03 §3); a leading `**​/` is also tried stripped (KiroCrew); subjects are paths
 * relative to the workspace root (absolute patterns match absolute paths).
 */

import * as path from 'node:path';
import type { UserContentBlock } from '../claude/protocol.js';
import type { SteeringFile, WorkspaceContext } from '../types.js';
import { expandBraces, globMatch } from '../util/glob.js';
import { toPosixPath } from '../util/paths.js';
import { codeRanges } from './refs.js';
import { formatHookContext, steeringBaseDir } from './systemPrompt.js';

export const USER_MESSAGE_BEGIN = '--- USER MESSAGE BEGIN ---';
export const USER_MESSAGE_END = '--- USER MESSAGE END ---';

export interface ComposeUserTurnInput {
  /** The user's text (after prompt expansion). */
  text: string;
  /** userPromptSubmit outputs to wrap (already filtered to successful ones by the hook runner). */
  hookOutputs: string[];
  /** Agent-action hook prompts appended to the user text. */
  agentPrompts: string[];
  /** Conditional steering activated for this turn. */
  steeringBlocks: { name: string; body: string }[];
  /** `@` / `#` expansion blocks. */
  refBlocks: string[];
  /** Extra context blocks inserted verbatim after the hook block. */
  extraContext?: string[];
  images?: { mediaType: string; dataBase64: string }[];
}

function attr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** `<steering name="<stem>">\n<body>\n</steering>` (00 §6.2). */
export function formatSteeringBlock(b: { name: string; body: string }): string {
  return `<steering name="${attr(b.name)}">\n${b.body.replace(/\s+$/, '')}\n</steering>`;
}

/** Text part of {@link composeUserTurn} (see module doc). */
export function composeUserTurnText(input: Omit<ComposeUserTurnInput, 'images'>): string {
  let c = '';
  const hook = formatHookContext(input.hookOutputs, false);
  if (hook) c += `${hook}\n`;
  const blocks = [...(input.extraContext ?? []), ...input.steeringBlocks.map(formatSteeringBlock), ...input.refBlocks]
    .map((b) => b.replace(/\s+$/, ''))
    .filter((b) => b.trim() !== '');
  for (const b of blocks) c += `${b}\n\n`;
  const prompts = input.agentPrompts.filter((p) => p.trim() !== '');
  const p = (input.text !== '' || prompts.length === 0 ? [input.text, ...prompts] : prompts).join('\n\n');
  c += c ? `${USER_MESSAGE_BEGIN}\n${p}${USER_MESSAGE_END}\n\n` : p;
  return c.trim();
}

/** Compose one user turn: a string, or content blocks when images are attached (00 §6.2). */
export function composeUserTurn(input: ComposeUserTurnInput): string | UserContentBlock[] {
  const text = composeUserTurnText(input);
  const images = input.images ?? [];
  if (images.length === 0) return text;
  const blocks: UserContentBlock[] = images.map((img) => ({
    type: 'image',
    source: { type: 'base64', media_type: img.mediaType, data: img.dataBase64 },
  }));
  if (text !== '') blocks.push({ type: 'text', text });
  return blocks;
}

// ───────────────────────────── fileMatch ─────────────────────────────

/**
 * True when any fileMatch pattern matches. `rel` is the workspace-relative POSIX path (or an
 * absolute POSIX path for files outside the workspace); `abs` the absolute POSIX path.
 */
export function fileMatchMatches(patterns: readonly string[], rel: string, abs?: string): boolean {
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  for (const raw of patterns) {
    const pat = raw.trim();
    if (pat === '') continue;
    let alts: string[];
    try {
      alts = expandBraces(pat, { escapes: false });
    } catch {
      alts = [pat];
    }
    for (let p of alts) {
      p = toPosixPath(p).replace(/^(\.\/)+/, '');
      if (p === '') continue;
      if (p.startsWith('/')) {
        if (abs !== undefined && globMatch(p, abs, 'path', { windows: false })) return true;
        continue;
      }
      if (!p.includes('/')) {
        if (globMatch(p, base, 'path', { windows: false })) return true;
        continue;
      }
      if (globMatch(p, rel, 'path', { windows: false })) return true;
      if (p.startsWith('**/') && globMatch(p.slice(3), rel, 'path', { windows: false })) return true;
    }
  }
  return false;
}

/** Path-like tokens mentioned in a prompt (for fileMatch activation). */
export function promptPathTokens(text: string): string[] {
  const out: string[] = [];
  const push = (t: string): void => {
    let s = t.trim();
    s = s.replace(/^[`'"([{<]+/, '').replace(/[`'")\]}>.,;:!?]+$/, '');
    if (s === '' || s === '/' || /^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return;
    if (!out.includes(s)) out.push(s);
  };
  for (const m of text.matchAll(/(?:^|\s)[@#]?(?:"([^"\n]+)"|'([^'\n]+)')/g)) push(m[1] ?? m[2]!);
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const t = m[1]!.trim();
    if (!/\s/.test(t) && (t.includes('/') || /\.[A-Za-z0-9]{1,10}$/.test(t))) push(t);
  }
  for (const m of text.matchAll(/(?:^|\s)([@#]?)([^\s"']+)/g)) {
    let t = m[2]!;
    const prefixed = m[1] !== '';
    t = t.replace(/^[`([{<]+/, '').replace(/[`)\]}>.,;:!?]+$/, '');
    if (t.startsWith('#')) continue;
    if (prefixed || t.includes('/') || /\.[A-Za-z0-9]{1,10}$/.test(t)) push(t);
  }
  return out;
}

// ───────────────────────────── SteeringActivator ─────────────────────────────

/** Trailing punctuation ignored after an unquoted reference (same set as context/refs). */
const REF_TRAILING_PUNCT = /[.,;:!?)\]}'"]+$/;

/** Lower-cased steering reference without trailing dots and without a `.md` suffix. */
function normalizeSteeringRef(ref: string): string {
  return ref.trim().replace(/\.+$/, '').replace(/\.md$/i, '').toLowerCase();
}

/** Lower-cased file stem of a steering file (`#<stem>` works for any name, like findSteering). */
function steeringStem(p: string): string {
  const posix = toPosixPath(p);
  return posix.slice(posix.lastIndexOf('/') + 1).replace(/\.md$/i, '').toLowerCase();
}

export interface SteeringActivatorOptions {
  /** `#[[file:…]]` expander applied to bodies when they are injected. */
  expandRefs?: (body: string, baseDir: string) => string;
}

/** Once-per-session injection of conditional steering (see module doc). */
export class SteeringActivator {
  private readonly files: SteeringFile[];
  private readonly ws: WorkspaceContext;
  private readonly expandRefs: (body: string, baseDir: string) => string;
  private readonly injected = new Set<string>();
  private readonly order: string[] = [];

  constructor(conditional: SteeringFile[], ws: WorkspaceContext, opts: SteeringActivatorOptions = {}) {
    this.files = conditional.filter((f) => f.inclusion !== 'always');
    this.ws = ws;
    this.expandRefs = opts.expandRefs ?? ((b) => b);
  }

  /** Names of the files injected so far (in injection order). */
  get activated(): string[] {
    return [...this.order];
  }

  /** Forget what was injected. */
  reset(): void {
    this.injected.clear();
    this.order.length = 0;
  }

  private body(f: SteeringFile): string {
    try {
      return this.expandRefs(f.body, steeringBaseDir(this.ws, f));
    } catch {
      return f.body;
    }
  }

  private take(files: SteeringFile[]): { name: string; body: string }[] {
    const out: { name: string; body: string }[] = [];
    for (const f of files) {
      if (this.injected.has(f.path)) continue;
      this.injected.add(f.path);
      this.order.push(f.name);
      out.push({ name: f.name, body: this.body(f) });
    }
    return out;
  }

  /** Relative (to the workspace root) and absolute POSIX forms of a path. */
  private subjects(p: string): { rel: string; abs: string } {
    const abs = path.resolve(this.ws.cwd, p);
    const rel = path.relative(this.ws.workspaceRoot, abs);
    const outside = rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
    return { rel: toPosixPath(outside ? abs : rel), abs: toPosixPath(abs) };
  }

  /** Files named explicitly (any conditional inclusion), once each. */
  forNames(names: readonly string[]): { name: string; body: string }[] {
    const want = new Set(names.map((n) => normalizeSteeringRef(n)));
    return this.take(this.files.filter((f) => want.has(f.name.toLowerCase()) || want.has(steeringStem(f.path))));
  }

  /**
   * Steering to inline for a user prompt (see module doc). Reference syntax mirrors
   * context/refs `expandHashRefs` / `findSteering`: `#steering:` is case-insensitive and takes
   * a name, `name.md`, a quoted name or a path (its file name counts); `#name` / `/name` is a
   * whole token (trailing punctuation ignored, no `/` inside, so `/api/v1` is a path) or a
   * quoted `#"name"`; names match the steering name or the file stem, case-insensitively.
   */
  forPrompt(text: string): { name: string; body: string }[] {
    const code = codeRanges(text);
    const named = new Set<string>();
    const explicit = new Set<string>();
    const re = /(^|\s)([#/])(?:(steering):(?:"([^"\n]+)"|'([^'\n]+)'|(\S+))|"([^"\n]+)"|'([^'\n]+)'|(\S+))/giu;
    for (const m of text.matchAll(re)) {
      const at = m.index! + m[1]!.length;
      if (code.some(([a, b]) => at >= a && at < b)) continue;
      if (m[3] !== undefined) {
        if (m[2] !== '#') continue; // `/steering:x` is not a reference
        const quoted = m[4] ?? m[5];
        const ref = toPosixPath(quoted ?? m[6]!.replace(REF_TRAILING_PUNCT, ''));
        const key = normalizeSteeringRef(ref.slice(ref.lastIndexOf('/') + 1));
        if (key) explicit.add(key);
        continue;
      }
      const quoted = m[7] ?? m[8];
      if (quoted !== undefined && m[2] !== '#') continue;
      const tok = quoted ?? m[9]!.replace(REF_TRAILING_PUNCT, '');
      if (quoted === undefined && /[\\/]/.test(tok)) continue; // a path, not a name
      const key = normalizeSteeringRef(tok);
      if (key) named.add(key);
    }
    const tokens = promptPathTokens(text).map((t) => this.subjects(t));
    const hits = this.files.filter((f) => {
      const keys = [f.name.toLowerCase(), steeringStem(f.path)];
      if (keys.some((k) => explicit.has(k))) return true;
      if ((f.inclusion === 'manual' || f.inclusion === 'auto') && keys.some((k) => named.has(k))) return true;
      if (f.inclusion === 'fileMatch') return tokens.some((t) => fileMatchMatches(f.fileMatchPatterns, t.rel, t.abs));
      return false;
    });
    return this.take(hits);
  }

  /**
   * fileMatch steering activated by the agent reading or writing `absPath`; returns the
   * PostToolUse `additionalContext` text, or undefined when nothing new applies.
   */
  forToolPath(absPath: string): string | undefined {
    const { rel, abs } = this.subjects(absPath);
    const hits = this.files.filter((f) => f.inclusion === 'fileMatch' && fileMatchMatches(f.fileMatchPatterns, rel, abs));
    const blocks = this.take(hits);
    if (blocks.length === 0) return undefined;
    const lead = `Kiro steering for files matching ${rel} (apply it while working on such files):`;
    return [lead, ...blocks.map(formatSteeringBlock)].join('\n\n');
  }
}

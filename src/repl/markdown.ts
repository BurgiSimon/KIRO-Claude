/**
 * Streaming "markdown-lite" renderer for assistant text (06 §5.3, Classic `parse.rs` semantics).
 *
 * Text arrives in arbitrary chunks (stream deltas); {@link MarkdownStream.push} renders as much
 * as can be decided and holds back only what is still ambiguous (a line start that may become
 * a fence / heading / rule, a `**` or backtick run cut in half, an unfinished `[text](url)`,
 * `&lt;`). The output for a given text is the same whatever the chunk boundaries are.
 *
 * Rendering (Classic, colours via util/ansi so `NO_COLOR` and non-TTY output stay plain):
 *  - `#…` headings: hashes + space magenta bold, heading text bold;
 *  - `-` / `*` / `+` bullets ⇒ `• `; `1.` / `1)` kept;
 *  - `---` / `***` / `___` ⇒ a `━` rule (`columns` wide, default 80);
 *  - inline code: green, backticks removed (a code span opens only when its closing run is on
 *    the same line); fenced code: language line bold, body green, fence lines removed;
 *  - `>` blockquote ⇒ grey `│ `;
 *  - `**bold**` ⇒ bold (single `*` / `_` are left alone: they are too often literal in code
 *    talk — DECISION, Classic also rendered `*italic*`);
 *  - `[text](url)` ⇒ `text` blue + space + url grey (just the url when both are equal);
 *  - `&lt; &gt; &amp; &quot; &apos; &#39; &nbsp;` unescaped.
 * Word wrapping at `width` columns when given (`--wrap`, 01 §3): words move to the next line,
 * continuation lines of list items / quotes are indented under their text. Lines are never
 * broken inside a word.
 *
 * Pure: output goes to the `write` callback.
 */

import { c } from '../util/ansi.js';

export interface MarkdownOptions {
  /** Wrap width; undefined = no wrapping. */
  width?: number;
  /** Terminal width used for horizontal rules (default 80). */
  columns?: number;
  /** ASCII glyphs only (chat.allowAsciiArt=false / KIRO_ASCII_MODE). */
  ascii?: boolean;
}

type Style = 'plain' | 'code' | 'bold' | 'heading' | 'link' | 'url' | 'quote';

interface Segment {
  text: string;
  style: Style;
}

const MAX_HOLD = 600;

function applyStyle(style: Style, text: string): string {
  switch (style) {
    case 'code':
      return c.green(text);
    case 'bold':
    case 'heading':
      return c.bold(text);
    case 'link':
      return c.blue(text);
    case 'url':
      return c.gray(text);
    case 'quote':
      return c.gray(text);
    default:
      return text;
  }
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", '#39': "'", nbsp: ' ' };

/** See module doc. */
export class MarkdownStream {
  private buf = '';
  private atLineStart = true;
  private fence: { ch: string; len: number } | null = null;
  private lineStyle: 'none' | 'heading' | 'quote' = 'none';
  private codeRun = 0;
  private bold = false;
  private col = 0;
  private indent = '';
  private indentStyled = '';
  private word: Segment[] = [];
  private wordLen = 0;
  private spaces = '';
  private pendingCr = false;
  private readonly glyph: { bullet: string; rule: string; quote: string };

  constructor(
    private readonly write: (s: string) => void,
    private readonly opts: MarkdownOptions = {},
  ) {
    this.glyph = opts.ascii ? { bullet: '-', rule: '-', quote: '|' } : { bullet: '•', rule: '━', quote: '│' };
  }

  /** Current output column (for callers that print a prefix first). */
  get column(): number {
    return this.col;
  }

  /** Tell the renderer that `n` visible columns were already printed on the current line. */
  setColumn(n: number): void {
    this.col = n;
  }

  /** Whether anything is buffered or the current line is unfinished. */
  get dirty(): boolean {
    return this.buf !== '' || this.wordLen > 0 || this.col > 0;
  }

  push(text: string): void {
    if (text === '') return;
    let t = (this.pendingCr ? '\r' : '') + text;
    this.pendingCr = t.endsWith('\r');
    if (this.pendingCr) t = t.slice(0, -1); // may be the first half of CRLF
    this.buf += t.replace(/\r\n?/g, '\n');
    this.process(false);
    if (this.opts.width === undefined) this.flushWord();
  }

  /** Flush everything, close open styles and end the current line. */
  end(): void {
    if (this.pendingCr) {
      this.pendingCr = false;
      this.buf += '\n';
    }
    this.process(true);
    this.flushWord();
    if (this.col > 0) this.write('\n');
    this.col = 0;
    this.atLineStart = true;
    this.fence = null;
    this.lineStyle = 'none';
    this.codeRun = 0;
    this.bold = false;
    this.indent = '';
    this.indentStyled = '';
    this.spaces = '';
  }

  // ───────────────────────────── core loop ─────────────────────────────

  private process(final: boolean): void {
    let guard = 0;
    while (this.buf.length > 0) {
      if (++guard > 1_000_000) break;
      if (this.atLineStart) {
        if (!this.lineStart(final)) return;
        continue;
      }
      if (this.fence) {
        this.fenceText();
        continue;
      }
      if (!this.inlineStep(final)) return;
    }
  }

  private consume(n: number): void {
    this.buf = this.buf.slice(n);
  }

  /** Write a line prefix immediately (nothing is pending at a line start). */
  private emitPrefix(styled: string, visible: number): void {
    this.write(styled);
    this.col += visible;
  }

  private endLine(): void {
    this.flushWord();
    this.spaces = '';
    this.write('\n');
    this.col = 0;
    this.atLineStart = true;
    this.lineStyle = 'none';
    this.indent = '';
    this.indentStyled = '';
    this.bold = false;
    this.codeRun = 0;
  }

  // ───────────────────────────── line starts ─────────────────────────────

  /** Classify the start of a line; false = need more input. */
  private lineStart(final: boolean): boolean {
    const nl = this.buf.indexOf('\n');
    const line = nl >= 0 ? this.buf.slice(0, nl) : this.buf;
    const complete = nl >= 0 || final;
    const consumeLine = (): void => this.consume(nl >= 0 ? nl + 1 : this.buf.length);

    if (this.fence) {
      const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (m && m[1]![0] === this.fence.ch && m[1]!.length >= this.fence.len) {
        if (!complete) return false;
        this.fence = null;
        consumeLine();
        return true;
      }
      if (!complete && /^ {0,3}[`~]*[ \t]*$/.test(line)) return false;
      this.atLineStart = false;
      return true;
    }

    if (nl === 0) {
      this.consume(1);
      this.write('\n');
      this.col = 0;
      this.bold = false;
      return true;
    }

    // fenced code block
    const fm = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fm && !(fm[1]![0] === '`' && fm[2]!.includes('`'))) {
      if (!complete) return false;
      const lang = fm[2]!.trim();
      if (lang) this.write(`${c.bold(lang)}\n`);
      else if (this.col > 0) this.write('\n');
      this.col = 0;
      this.fence = { ch: fm[1]![0]!, len: fm[1]!.length };
      consumeLine();
      return true;
    }
    if (!complete && /^ {0,3}(`{1,2}|~{1,2})$/.test(line)) return false;

    // horizontal rule
    if (/^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/.test(line)) {
      if (!complete) return false;
      const w = Math.max(1, this.opts.columns ?? 80);
      this.write(`${this.glyph.rule.repeat(w)}\n`);
      this.col = 0;
      consumeLine();
      return true;
    }
    if (!complete && /^ {0,3}[-*_][-*_ \t]*$/.test(line)) return false;

    // heading
    if (!complete && /^ {0,3}#{1,6}[ \t]*$/.test(line)) return false;
    const hm = /^ {0,3}(#{1,6})(?:[ \t]+|$)/.exec(line);
    if (hm) {
      this.emitPrefix(c.magenta(c.bold(`${hm[1]} `)), hm[1]!.length + 1);
      this.lineStyle = 'heading';
      this.consume(hm[0].length);
      this.atLineStart = false;
      return true;
    }

    // bullets
    if (!complete && /^[ \t]*[-*+][ \t]*$/.test(line)) return false;
    const bm = /^([ \t]*)([-*+])[ \t]+/.exec(line);
    if (bm) {
      const lead = bm[1]!.replace(/\t/g, '    ');
      const prefix = `${lead}${this.glyph.bullet} `;
      this.emitPrefix(prefix, prefix.length);
      this.indent = ' '.repeat(prefix.length);
      this.indentStyled = this.indent;
      this.consume(bm[0].length);
      this.atLineStart = false;
      return true;
    }

    // ordered list
    if (!complete && /^[ \t]*\d{1,9}(?:[.)][ \t]*)?$/.test(line)) return false;
    const om = /^([ \t]*)(\d{1,9}[.)])[ \t]+/.exec(line);
    if (om) {
      const lead = om[1]!.replace(/\t/g, '    ');
      const prefix = `${lead}${om[2]} `;
      this.emitPrefix(prefix, prefix.length);
      this.indent = ' '.repeat(prefix.length);
      this.indentStyled = this.indent;
      this.consume(om[0].length);
      this.atLineStart = false;
      return true;
    }

    // blockquote
    if (!complete && /^ {0,3}>[ \t]*$/.test(line)) return false;
    const qm = /^ {0,3}>[ \t]?/.exec(line);
    if (qm) {
      const q = `${this.glyph.quote} `;
      this.emitPrefix(c.gray(q), q.length);
      this.indent = q;
      this.indentStyled = c.gray(q);
      this.lineStyle = 'quote';
      this.consume(qm[0].length);
      this.atLineStart = false;
      return true;
    }

    if (!complete && /^[ \t]+$/.test(line)) return false;
    const lead = /^[ \t]*/.exec(line)![0];
    if (lead) {
      const sp = lead.replace(/\t/g, '    ');
      this.emitPrefix(sp, sp.length);
      this.consume(lead.length);
    }
    this.atLineStart = false;
    return true;
  }

  // ───────────────────────────── fenced code ─────────────────────────────

  private fenceText(): void {
    const nl = this.buf.indexOf('\n');
    const chunk = nl >= 0 ? this.buf.slice(0, nl) : this.buf;
    if (chunk) {
      this.write(c.green(chunk));
      this.col += chunk.length;
    }
    this.consume(chunk.length);
    if (nl >= 0) {
      this.consume(1);
      this.write('\n');
      this.col = 0;
      this.atLineStart = true;
    }
  }

  // ───────────────────────────── inline ─────────────────────────────

  private currentStyle(): Style {
    if (this.codeRun > 0) return 'code';
    if (this.lineStyle === 'heading') return 'heading';
    if (this.bold) return 'bold';
    if (this.lineStyle === 'quote') return 'plain';
    return 'plain';
  }

  private addText(text: string, style: Style = this.currentStyle()): void {
    if (text === '') return;
    const last = this.word[this.word.length - 1];
    if (last && last.style === style) last.text += text;
    else this.word.push({ text, style });
    this.wordLen += text.length;
  }

  private flushWord(): void {
    if (this.wordLen === 0) return;
    const w = this.opts.width;
    if (w !== undefined && this.col > this.indent.length && this.col + this.spaces.length + this.wordLen > w) {
      this.write(`\n${this.indentStyled}`);
      this.col = this.indent.length;
      this.spaces = '';
    }
    const styled = this.word.map((s) => applyStyle(s.style, s.text)).join('');
    this.write(this.spaces + styled);
    this.col += this.spaces.length + this.wordLen;
    this.spaces = '';
    this.word = [];
    this.wordLen = 0;
  }

  /** One inline step; false = need more input. */
  private inlineStep(final: boolean): boolean {
    const buf = this.buf;
    const ch = buf[0]!;
    if (ch === '\n') {
      this.consume(1);
      this.endLine();
      return true;
    }
    if (ch === ' ' || ch === '\t') {
      this.flushWord();
      const m = /^[ \t]+/.exec(buf)![0];
      this.spaces += m.replace(/\t/g, '    ');
      this.consume(m.length);
      return true;
    }
    if (ch === '`') {
      const run = /^`+/.exec(buf)![0].length;
      if (run === buf.length && !final) return false;
      if (this.codeRun > 0) {
        this.consume(run);
        if (run === this.codeRun) this.codeRun = 0;
        else this.addText('`'.repeat(run));
        return true;
      }
      // open only when the closing run exists on this line
      const rest = buf.slice(run);
      const nl = rest.indexOf('\n');
      const lineRest = nl >= 0 ? rest.slice(0, nl) : rest;
      const closeRe = new RegExp(`(^|[^\`])\`{${run}}(?!\`)`);
      if (closeRe.test(lineRest)) {
        this.consume(run);
        this.codeRun = run;
        return true;
      }
      if (nl < 0 && !final && buf.length < MAX_HOLD) return false;
      this.consume(run);
      this.addText('`'.repeat(run));
      return true;
    }
    if (this.codeRun > 0) {
      const m = /^[^`\n \t]+/.exec(buf)![0];
      this.addText(m);
      this.consume(m.length);
      return true;
    }
    if (ch === '*') {
      if (buf.length === 1 && !final) return false;
      if (buf.startsWith('**')) {
        this.consume(2);
        this.bold = !this.bold;
        return true;
      }
      this.addText('*');
      this.consume(1);
      return true;
    }
    if (ch === '[') {
      const m = /^\[([^\]\n]{0,300})\]\(([^)\s]{0,1000})\)/.exec(buf);
      if (m) {
        const text = m[1]!;
        const url = m[2]!;
        if (text === '' || text === url) this.addText(url || text, 'link');
        else {
          this.addText(text, 'link');
          this.flushWord();
          this.spaces += ' ';
          this.addText(url, 'url');
        }
        this.consume(m[0].length);
        return true;
      }
      if (!final && buf.length < MAX_HOLD && /^\[[^\]\n]*(?:\](?:\([^)\s]*)?)?$/.test(buf)) return false;
      this.addText('[');
      this.consume(1);
      return true;
    }
    if (ch === '&') {
      const m = /^&(lt|gt|amp|quot|apos|#39|nbsp);/.exec(buf);
      if (m) {
        this.addText(ENTITIES[m[1]!]!);
        this.consume(m[0].length);
        return true;
      }
      if (!final && /^&[a-z#0-9]{0,5}$/i.test(buf)) return false;
      this.addText('&');
      this.consume(1);
      return true;
    }
    const m = /^[^\n \t`*[&]+/.exec(buf)![0];
    this.addText(m);
    this.consume(m.length);
    return true;
  }
}

/** Render a complete markdown text to a string (tests, non-streamed blocks). */
export function renderMarkdown(text: string, opts: MarkdownOptions = {}): string {
  let out = '';
  const md = new MarkdownStream((s) => {
    out += s;
  }, opts);
  md.push(text);
  md.end();
  return out;
}

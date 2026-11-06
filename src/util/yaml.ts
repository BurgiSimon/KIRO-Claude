/**
 * Pragmatic YAML subset parser (zero dependencies) for Kiro configuration:
 * `permissions.yaml` (02 §2.8), Markdown agent front matter (02 §2.12), steering / skill /
 * prompt front matter (02 §4, §6, 03 §3).
 *
 * Supported
 *  - one document, optional leading `---` (and `%` directives before it), optional `...` end;
 *    a second `---` followed by content is an error;
 *  - comments (`#` at line start or after whitespace);
 *  - block mappings, block sequences (incl. `- key: v` mapping items, `- - x` nesting,
 *    "compact" sequences `key:\n- a` at the key's indentation), arbitrary nesting;
 *  - flow sequences `[a, 'b', "c"]` and flow mappings `{a: 1, "b": x}`, nested, spanning lines,
 *    trailing commas, `[k: v]` single-pair maps;
 *  - scalars: plain (multi-line folded), `'single'` (`''` escape), `"double"` (all YAML escapes:
 *    `\n \t \" \\ \/ \0 \a \b \e \f \r \v \N \_ \L \P \xHH \uHHHH \UHHHHHHHH`, escaped line
 *    breaks), block scalars `|` and `>` with chomping `-`/`+` and indentation indicators;
 *  - YAML 1.2 core schema resolution for plain scalars: `null`/`Null`/`NULL`/`~`/empty ⇒ null,
 *    `true`/`false` (3 casings) ⇒ boolean (NOT `yes`/`no`/`on`/`off`, which stay strings),
 *    decimal/`0x`/`0o` integers, floats incl. exponent, `.inf`/`-.inf`/`.nan`;
 *  - anchors `&a` and aliases `*a` (aliases are deep copies; an unknown alias is kept as a plain
 *    string so `*.md` style values survive), tags `!!str`/`!!int`/`!!float`/`!!bool`/`!!null`
 *    (other tags are ignored).
 *  - Duplicate keys: last one wins. Keys are strings (plain keys keep their source text).
 *
 * Leniencies (inputs real YAML rejects but users write): `@`/backtick-leading plain scalars,
 * `: ` inside a single-line plain value (`description: Note: x` ⇒ `"Note: x"`). A
 * continuation line that looks like `key: value` is still an error (likely bad indentation).
 *
 * Not supported (⇒ {@link YamlError}): complex `?` keys, flow collections as keys, tabs used
 * for indentation, multiple documents. Errors carry the 1-based source line.
 *
 * Hostile input (front matter and `permissions.yaml` can come from a cloned repository):
 * nesting deeper than {@link YAML_MAX_DEPTH} and alias expansion beyond
 * {@link YAML_MAX_ALIAS_NODES} nodes ("billion laughs") are rejected with a YamlError, and
 * {@link parseYaml} never lets a stack-overflow RangeError escape.
 */

export class YamlError extends Error {
  /** 1-based line number of the problem. */
  readonly line: number;
  /** 1-based column, when known. */
  readonly column?: number;
  /** Message without the location suffix. */
  readonly reason: string;
  constructor(reason: string, line: number, column?: number) {
    super(`${reason} at line ${line}${column !== undefined ? `, column ${column}` : ''}`);
    this.name = 'YamlError';
    this.reason = reason;
    this.line = line;
    if (column !== undefined) this.column = column;
  }
}

interface Line {
  /** 0-based index in the source. */
  idx: number;
  /** Leading spaces. */
  indent: number;
  /** Content after the indentation (for virtual lines: a suffix of `raw`). */
  text: string;
  raw: string;
}

type Obj = Record<string, unknown>;

function setProp(obj: Obj, key: string, value: unknown): void {
  if (key === '__proto__') {
    Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
  } else {
    obj[key] = value;
  }
}

/** Maximum nesting depth of block + flow collections (real configs stay far below). */
export const YAML_MAX_DEPTH = 500;
/** Maximum number of nodes produced by alias expansion ("billion laughs" guard). */
export const YAML_MAX_ALIAS_NODES = 100_000;

const INT_RE = /^[-+]?[0-9]+$/;
const HEX_RE = /^0x[0-9a-fA-F]+$/;
const OCT_RE = /^0o[0-7]+$/;
const FLOAT_RE = /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$/;

/** YAML 1.2 core-schema resolution of a plain scalar. */
export function resolvePlainScalar(s: string): unknown {
  if (s === '' || s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return null;
  if (s === 'true' || s === 'True' || s === 'TRUE') return true;
  if (s === 'false' || s === 'False' || s === 'FALSE') return false;
  if (INT_RE.test(s)) return Number(s);
  if (HEX_RE.test(s)) return parseInt(s.slice(2), 16);
  if (OCT_RE.test(s)) return parseInt(s.slice(2), 8);
  if (FLOAT_RE.test(s)) return Number(s);
  if (/^[-+]?\.(?:inf|Inf|INF)$/.test(s)) return s.startsWith('-') ? -Infinity : Infinity;
  if (/^\.(?:nan|NaN|NAN)$/.test(s)) return NaN;
  return s;
}

function applyTag(tag: string | undefined, raw: string | undefined, v: unknown): unknown {
  if (!tag) return v;
  switch (tag) {
    case '!':
    case '!!str':
      if (raw !== undefined) return raw;
      return v === null ? '' : typeof v === 'object' ? v : String(v);
    case '!!int':
    case '!!float': {
      const n = Number(raw ?? v);
      return Number.isNaN(n) ? v : n;
    }
    case '!!bool':
      return raw !== undefined ? resolvePlainScalar(raw) : v;
    case '!!null':
      return null;
    default:
      return v;
  }
}

const isSeqItem = (t: string): boolean => t === '-' || t.startsWith('- ') || t.startsWith('-\t');

/** Cut a plain scalar at a comment (`#` preceded by whitespace). */
function stripComment(s: string): string {
  for (let i = 1; i < s.length; i++) {
    if (s[i] === '#' && (s[i - 1] === ' ' || s[i - 1] === '\t')) return s.slice(0, i);
  }
  return s;
}

const isDocStart = (raw: string): boolean => raw === '---' || /^---[ \t]/.test(raw);
const isDocEnd = (raw: string): boolean => raw === '...' || /^\.\.\.[ \t]/.test(raw);

class Parser {
  private readonly src: string;
  private readonly lines: Line[] = [];
  private readonly starts: number[] = [];
  private i = 0;
  private end: number;
  private srcEnd: number;
  private fp = 0;
  private readonly anchors = new Map<string, unknown>();
  /** Current collection nesting depth (see {@link YAML_MAX_DEPTH}). */
  private depth = 0;
  /** Remaining node budget for alias expansion (see {@link YAML_MAX_ALIAS_NODES}). */
  private aliasBudget = YAML_MAX_ALIAS_NODES;

  constructor(text: string) {
    this.src = text;
    const raws = text.split('\n');
    let off = 0;
    raws.forEach((raw, idx) => {
      this.starts.push(off);
      off += raw.length + 1;
      let indent = 0;
      while (raw[indent] === ' ') indent++;
      this.lines.push({ idx, indent, text: raw.slice(indent), raw });
    });
    this.end = this.lines.length;
    this.srcEnd = text.length;
  }

  // ───────────── helpers ─────────────

  private err(reason: string, lineIdx: number, column?: number): YamlError {
    return new YamlError(reason, lineIdx + 1, column);
  }

  private errAt(reason: string, off: number): YamlError {
    const li = this.lineAt(off);
    return new YamlError(reason, li + 1, off - this.starts[li]! + 1);
  }

  private lineAt(off: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid]! <= off) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** Absolute source offset of `r`, which must be a suffix of line `li`'s raw text. */
  private absOffset(li: number, r: string): number {
    const ln = this.lines[li]!;
    return this.starts[li]! + ln.raw.length - r.length;
  }

  private static blank(ln: Line): boolean {
    const t = ln.text.trim();
    return t === '' || t.startsWith('#');
  }

  /** Next structural line (skipping blanks/comments), or undefined at document end. */
  private peekLine(): Line | undefined {
    while (this.i < this.end && Parser.blank(this.lines[this.i]!)) this.i++;
    if (this.i >= this.end) return undefined;
    const ln = this.lines[this.i]!;
    if (ln.text.startsWith('\t')) throw this.err('tab characters must not be used for indentation', ln.idx, ln.indent + 1);
    return ln;
  }

  /** Enter one nesting level; throws past {@link YAML_MAX_DEPTH}. */
  private enter(lineIdx: number): void {
    if (++this.depth > YAML_MAX_DEPTH) {
      throw this.err(`document is nested more than ${YAML_MAX_DEPTH} levels deep`, lineIdx);
    }
  }

  /** Deep copy of an anchored value for an alias, charged against the alias budget. */
  private aliasCopy(v: unknown, lineIdx: number): unknown {
    const copy = (x: unknown): unknown => {
      if (--this.aliasBudget < 0) {
        throw this.err(`aliases expand to more than ${YAML_MAX_ALIAS_NODES} nodes`, lineIdx);
      }
      if (Array.isArray(x)) return x.map(copy);
      if (x !== null && typeof x === 'object') {
        const o: Obj = {};
        for (const [k, y] of Object.entries(x as Obj)) setProp(o, k, copy(y));
        return o;
      }
      return x;
    };
    return copy(v);
  }

  // ───────────── document ─────────────

  parse(): unknown {
    // Optional directives and `---` marker before the document body.
    let k = 0;
    while (k < this.lines.length && (Parser.blank(this.lines[k]!) || this.lines[k]!.raw.startsWith('%'))) k++;
    let bodyStart = 0;
    let scanFrom = 0;
    if (k < this.lines.length && isDocStart(this.lines[k]!.raw)) {
      const ln = this.lines[k]!;
      const rest = ln.raw.slice(3).replace(/^[ \t]+/, '');
      if (rest === '' || rest.startsWith('#')) bodyStart = k + 1;
      else {
        // `--- value`: the rest of the marker line is document content.
        this.lines[k] = { idx: ln.idx, indent: ln.raw.length - rest.length, text: rest, raw: ln.raw };
        bodyStart = k;
      }
      scanFrom = k + 1;
    }
    // Document end: `...`, or a second `---` (an error when another document follows).
    for (let j = scanFrom; j < this.lines.length; j++) {
      const raw = this.lines[j]!.raw;
      const isEnd = isDocEnd(raw);
      const isStart = !isEnd && isDocStart(raw);
      if (!isEnd && !isStart) continue;
      if (isStart) {
        const restRaw = raw.slice(3).trim();
        const more = (restRaw !== '' && !restRaw.startsWith('#')) || this.lines.slice(j + 1).some((l) => !Parser.blank(l));
        if (more) throw this.err('multiple YAML documents are not supported', j);
      }
      this.end = j;
      this.srcEnd = Math.max(this.starts[j]! - 1, 0);
      break;
    }
    this.i = bodyStart;
    const first = this.peekLine();
    if (!first) return null;
    const v = this.parseNodeAt(first, -1);
    const extra = this.peekLine();
    if (extra) throw this.err('unexpected content (bad indentation?)', extra.idx, extra.indent + 1);
    return v;
  }

  // ───────────── block structure ─────────────

  /** Column of the `:` that makes `text` a `key: value` line, or -1. */
  private keyColon(text: string): number {
    const c0 = text[0];
    if (c0 === undefined) return -1;
    if (c0 === '[' || c0 === '{' || c0 === '|' || c0 === '>' || c0 === '#') return -1;
    if (c0 === '?' && (text[1] === ' ' || text[1] === '\t' || text.length === 1)) return -2;
    if (c0 === '"' || c0 === "'") {
      let j = 1;
      for (;;) {
        if (j >= text.length) return -1;
        const ch = text[j]!;
        if (c0 === '"' && ch === '\\') {
          j += 2;
          continue;
        }
        if (ch === c0) {
          if (c0 === "'" && text[j + 1] === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      j++;
      while (text[j] === ' ' || text[j] === '\t') j++;
      return text[j] === ':' ? j : -1; // JSON-like keys allow `"a":1`
    }
    for (let j = 0; j < text.length; j++) {
      const ch = text[j]!;
      if (ch === '#' && j > 0 && (text[j - 1] === ' ' || text[j - 1] === '\t')) return -1;
      if (ch === ':') {
        const nx = text[j + 1];
        if (nx === undefined || nx === ' ' || nx === '\t') return j;
      }
    }
    return -1;
  }

  private parseNodeAt(ln: Line, parentIndent: number): unknown {
    this.enter(ln.idx);
    try {
      if (isSeqItem(ln.text)) return this.parseSeq(ln.indent);
      const kc = this.keyColon(ln.text);
      if (kc === -2) throw this.err('complex mapping keys ("? ") are not supported', ln.idx, ln.indent + 1);
      if (kc >= 0) return this.parseMap(ln.indent);
      return this.parseValue(ln.text, this.i, parentIndent, undefined);
    } finally {
      this.depth--;
    }
  }

  private parseSeq(n: number): unknown[] {
    const arr: unknown[] = [];
    for (;;) {
      const ln = this.peekLine();
      if (!ln || ln.indent < n) break;
      if (ln.indent > n) throw this.err('bad indentation of a sequence entry', ln.idx, ln.indent + 1);
      if (!isSeqItem(ln.text)) break;
      let k = 1;
      while (ln.text[k] === ' ' || ln.text[k] === '\t') k++;
      const rest = ln.text.slice(k);
      if (rest === '' || rest.startsWith('#')) {
        arr.push(this.parseValue('', this.i, n, undefined));
      } else {
        const virt: Line = { idx: ln.idx, indent: n + k, text: rest, raw: ln.raw };
        this.lines[this.i] = virt;
        arr.push(this.parseNodeAt(virt, n));
      }
    }
    return arr;
  }

  private parseMap(n: number): Obj {
    const obj: Obj = {};
    for (;;) {
      const ln = this.peekLine();
      if (!ln || ln.indent < n) break;
      if (ln.indent > n) throw this.err('bad indentation of a mapping entry', ln.idx, ln.indent + 1);
      if (isSeqItem(ln.text)) throw this.err('unexpected sequence entry inside a mapping', ln.idx, ln.indent + 1);
      const kc = this.keyColon(ln.text);
      if (kc === -2) throw this.err('complex mapping keys ("? ") are not supported', ln.idx, ln.indent + 1);
      if (kc < 0) throw this.err('expected a "key: value" mapping entry', ln.idx, ln.indent + 1);
      const keyText = ln.text.slice(0, kc).replace(/[ \t]+$/, '');
      let key: string;
      if (keyText[0] === '"' || keyText[0] === "'") {
        const [k] = this.quoted(this.absOffset(this.i, ln.text));
        key = k;
      } else {
        key = keyText;
        if (key === '') throw this.err('empty mapping key', ln.idx, ln.indent + 1);
      }
      const rest = ln.text.slice(kc + 1);
      const v = this.parseValue(rest, this.i, n, n);
      setProp(obj, key, v);
    }
    return obj;
  }

  /**
   * Parse the value text `r0` found on line `li` (the remainder after `key:` / `- `, or a
   * whole scalar line). Consumes that line and any continuation lines.
   */
  private parseValue(r0: string, li: number, parentIndent: number, compactSeqIndent: number | undefined): unknown {
    let r = r0.replace(/^[ \t]+/, '');
    let anchor: string | undefined;
    let tag: string | undefined;
    for (;;) {
      if (r.startsWith('&')) {
        const m = /^&([^\s,[\]{}]+)[ \t]*/.exec(r);
        if (!m) break;
        anchor = m[1];
        r = r.slice(m[0].length);
        continue;
      }
      if (r.startsWith('!')) {
        const m = /^(!\S*)[ \t]*/.exec(r);
        if (!m) break;
        tag = m[1];
        r = r.slice(m[0].length);
        continue;
      }
      break;
    }
    let v: unknown;
    let raw: string | undefined;
    if (r === '' || r.startsWith('#')) {
      this.i = li + 1;
      const next = this.peekLine();
      if (next && next.indent > parentIndent) v = this.parseNodeAt(next, parentIndent);
      else if (next && compactSeqIndent !== undefined && next.indent === compactSeqIndent && isSeqItem(next.text)) {
        v = this.parseSeq(compactSeqIndent);
      } else v = null;
    } else if (r[0] === '*' && this.aliasName(r) !== undefined) {
      v = this.aliasCopy(this.anchors.get(this.aliasName(r)!), li);
      this.i = li + 1;
    } else if (r[0] === '|' || r[0] === '>') {
      v = this.blockScalar(r, li, parentIndent);
      raw = v as string;
    } else if (r[0] === '[' || r[0] === '{') {
      v = this.flowBlock(r, li);
    } else if (r[0] === '"' || r[0] === "'") {
      const off = this.absOffset(li, r);
      const [s, endOff] = this.quoted(off);
      let q = endOff;
      while (q < this.srcEnd && (this.src[q] === ' ' || this.src[q] === '\t')) q++;
      if (q < this.srcEnd && this.src[q] !== '\n' && this.src[q] !== '#') {
        throw this.errAt('unexpected characters after a quoted scalar', q);
      }
      this.i = this.lineAt(endOff - 1) + 1;
      v = s;
      raw = s;
    } else {
      raw = this.plainBlock(r, li, parentIndent);
      v = resolvePlainScalar(raw);
    }
    if (tag) v = applyTag(tag, raw, v);
    // The anchored node itself goes into the tree; every alias use gets its own copy.
    if (anchor !== undefined) this.anchors.set(anchor, v);
    return v;
  }

  /** Name of a known anchor referenced by `r` (`*name` alone on the line, optional comment). */
  private aliasName(r: string): string | undefined {
    const m = /^\*([^\s,[\]{}]+)[ \t]*(?:#.*)?$/.exec(r);
    return m && this.anchors.has(m[1]!) ? m[1] : undefined;
  }

  private plainBlock(r: string, li: number, parentIndent: number): string {
    let out = stripComment(r).replace(/[ \t]+$/, '');
    this.i = li + 1;
    for (;;) {
      let k = this.i;
      let blanks = 0;
      while (k < this.end && this.lines[k]!.text.trim() === '') {
        blanks++;
        k++;
      }
      if (k >= this.end) break;
      const L = this.lines[k]!;
      if (L.indent <= parentIndent) break;
      const t = L.text.trim();
      if (t.startsWith('#')) break;
      if (this.keyColon(t) >= 0) {
        // `a: 1\n  b: 2` — silently folding this into "1 b: 2" would corrupt the config.
        throw this.err('mapping values are not allowed here (check the indentation)', L.idx, L.indent + 1);
      }
      out += blanks ? '\n'.repeat(blanks) : ' ';
      out += stripComment(t).replace(/[ \t]+$/, '');
      this.i = k + 1;
    }
    return out;
  }

  private blockScalar(header: string, li: number, parentIndent: number): string {
    const style = header[0]!;
    let chomp: '' | '-' | '+' = '';
    let explicit = 0;
    let j = 1;
    for (; j < header.length && j <= 2; j++) {
      const ch = header[j]!;
      if ((ch === '-' || ch === '+') && chomp === '') chomp = ch;
      else if (ch >= '1' && ch <= '9' && explicit === 0) explicit = Number(ch);
      else break;
    }
    const tail = header.slice(j);
    if (tail !== '' && !/^[ \t]+(#.*)?$/.test(tail) && !/^[ \t]*$/.test(tail)) {
      throw this.err('invalid block scalar header', li, this.lines[li]!.raw.length - header.length + 1);
    }
    const base = Math.max(parentIndent, 0);
    let contentIndent: number;
    if (explicit) contentIndent = base + explicit;
    else {
      contentIndent = -1;
      for (let k = li + 1; k < this.end; k++) {
        const raw = this.lines[k]!.raw;
        if (raw.trim() === '') continue;
        let sp = 0;
        while (raw[sp] === ' ') sp++;
        contentIndent = sp;
        break;
      }
      if (contentIndent <= parentIndent) contentIndent = -1;
    }
    const content: string[] = [];
    let k = li + 1;
    if (contentIndent >= 0) {
      for (; k < this.end; k++) {
        const raw = this.lines[k]!.raw;
        if (raw.trim() === '') {
          content.push(raw.length > contentIndent ? raw.slice(contentIndent) : '');
          continue;
        }
        let sp = 0;
        while (raw[sp] === ' ') sp++;
        if (sp < contentIndent) break;
        content.push(raw.slice(contentIndent));
      }
    } else {
      // empty scalar: swallow following blank lines only
      while (k < this.end && this.lines[k]!.raw.trim() === '') {
        content.push('');
        k++;
      }
    }
    this.i = k;
    let last = content.length - 1;
    while (last >= 0 && content[last] === '') last--;
    const body = content.slice(0, last + 1);
    const trailing = content.length - body.length;
    let text: string;
    if (style === '|') text = body.join('\n');
    else text = foldLines(body);
    if (chomp === '-') return text;
    if (chomp === '+') return body.length ? `${text}\n${'\n'.repeat(trailing)}` : '\n'.repeat(trailing);
    return body.length ? `${text}\n` : '';
  }

  // ───────────── quoted scalars (block or flow) ─────────────

  /** Parse a quoted scalar starting at `off` (the quote). Returns [value, offset after close]. */
  private quoted(off: number): [string, number] {
    const q = this.src[off]!;
    let out = '';
    let wsMark = -1; // start of trailing literal whitespace in `out`
    let j = off + 1;
    const lit = (s: string): void => {
      if (s === ' ' || s === '\t') {
        if (wsMark < 0) wsMark = out.length;
      } else wsMark = -1;
      out += s;
    };
    const fold = (): void => {
      // at a literal line break: trim trailing literal whitespace, count empty lines
      if (wsMark >= 0) out = out.slice(0, wsMark);
      wsMark = -1;
      j++; // the '\n'
      let empties = 0;
      for (;;) {
        while (j < this.srcEnd && (this.src[j] === ' ' || this.src[j] === '\t')) j++;
        if (j < this.srcEnd && this.src[j] === '\n') {
          empties++;
          j++;
          continue;
        }
        break;
      }
      out += empties ? '\n'.repeat(empties) : ' ';
    };
    for (;;) {
      if (j >= this.srcEnd) throw this.errAt(`unterminated ${q === '"' ? 'double' : 'single'}-quoted scalar`, off);
      const ch = this.src[j]!;
      if (q === "'") {
        if (ch === "'") {
          if (this.src[j + 1] === "'" && j + 1 < this.srcEnd) {
            lit("'");
            j += 2;
            continue;
          }
          return [out, j + 1];
        }
        if (ch === '\n') {
          fold();
          continue;
        }
        lit(ch);
        j++;
        continue;
      }
      // double-quoted
      if (ch === '"') return [out, j + 1];
      if (ch === '\n') {
        fold();
        continue;
      }
      if (ch !== '\\') {
        lit(ch);
        j++;
        continue;
      }
      const e = this.src[j + 1];
      if (e === undefined || j + 1 >= this.srcEnd) throw this.errAt('unterminated escape in double-quoted scalar', j);
      wsMark = -1;
      if (e === '\n') {
        // escaped line break: join without a space, drop the next line's indentation
        j += 2;
        while (j < this.srcEnd && (this.src[j] === ' ' || this.src[j] === '\t')) j++;
        continue;
      }
      const simple: Record<string, string> = {
        '0': '\0',
        a: '\u0007',
        b: '\b',
        t: '\t',
        '\t': '\t',
        n: '\n',
        v: '\v',
        f: '\f',
        r: '\r',
        e: '\u001b',
        ' ': ' ',
        '"': '"',
        '/': '/',
        '\\': '\\',
        N: '\u0085',
        _: ' ',
        L: ' ',
        P: ' ',
      };
      if (Object.prototype.hasOwnProperty.call(simple, e)) {
        out += simple[e];
        j += 2;
        continue;
      }
      const hexLen = e === 'x' ? 2 : e === 'u' ? 4 : e === 'U' ? 8 : 0;
      if (hexLen) {
        const hex = this.src.slice(j + 2, j + 2 + hexLen);
        if (hex.length !== hexLen || !/^[0-9a-fA-F]+$/.test(hex)) throw this.errAt(`invalid \\${e} escape`, j);
        const code = parseInt(hex, 16);
        if (code > 0x10ffff) throw this.errAt(`invalid \\${e} escape`, j);
        out += String.fromCodePoint(code);
        j += 2 + hexLen;
        continue;
      }
      throw this.errAt(`unknown escape sequence \\${e}`, j);
    }
  }

  // ───────────── flow collections ─────────────

  private flowBlock(r: string, li: number): unknown {
    this.fp = this.absOffset(li, r);
    const v = this.flowNode();
    let q = this.fp;
    while (q < this.srcEnd && (this.src[q] === ' ' || this.src[q] === '\t')) q++;
    if (q < this.srcEnd && this.src[q] !== '\n' && this.src[q] !== '#') {
      throw this.errAt('unexpected characters after a flow collection', q);
    }
    this.i = this.lineAt(Math.max(this.fp - 1, 0)) + 1;
    return v;
  }

  private fws(): void {
    for (;;) {
      if (this.fp >= this.srcEnd) return;
      const ch = this.src[this.fp]!;
      if (ch === ' ' || ch === '\t' || ch === '\n') {
        this.fp++;
        continue;
      }
      if (ch === '#') {
        const prev = this.src[this.fp - 1];
        if (prev === undefined || prev === ' ' || prev === '\t' || prev === '\n') {
          while (this.fp < this.srcEnd && this.src[this.fp] !== '\n') this.fp++;
          continue;
        }
      }
      return;
    }
  }

  private flowProps(): { anchor?: string; tag?: string } {
    const props: { anchor?: string; tag?: string } = {};
    for (;;) {
      this.fws();
      const rest = this.src.slice(this.fp, Math.min(this.srcEnd, this.fp + 256));
      let m: RegExpExecArray | null;
      if (rest.startsWith('&') && (m = /^&([^\s,[\]{}]+)/.exec(rest))) {
        props.anchor = m[1]!;
        this.fp += m[0].length;
        continue;
      }
      if (rest.startsWith('!') && (m = /^(![^\s,[\]{}]*)/.exec(rest))) {
        props.tag = m[1]!;
        this.fp += m[0].length;
        continue;
      }
      return props;
    }
  }

  private flowNode(): unknown {
    this.enter(this.lineAt(this.fp));
    try {
      return this.flowNodeInner();
    } finally {
      this.depth--;
    }
  }

  private flowNodeInner(): unknown {
    const { anchor, tag } = this.flowProps();
    this.fws();
    if (this.fp >= this.srcEnd) throw this.errAt('unexpected end of input inside a flow collection', this.srcEnd);
    const ch = this.src[this.fp]!;
    let v: unknown;
    let raw: string | undefined;
    if (ch === '[') v = this.flowSeq();
    else if (ch === '{') v = this.flowMap();
    else if (ch === '"' || ch === "'") {
      const [s, e] = this.quoted(this.fp);
      this.fp = e;
      v = s;
      raw = s;
    } else if (ch === ',' || ch === ']' || ch === '}') {
      throw this.errAt(`unexpected '${ch}' in flow collection`, this.fp);
    } else {
      raw = this.flowPlain();
      const am = /^\*([^\s,[\]{}]+)$/.exec(raw);
      if (am && this.anchors.has(am[1]!)) v = this.aliasCopy(this.anchors.get(am[1]!), this.lineAt(this.fp));
      else v = resolvePlainScalar(raw);
    }
    if (tag) v = applyTag(tag, raw, v);
    if (anchor !== undefined) this.anchors.set(anchor, v);
    return v;
  }

  /** Plain scalar in flow context; returns its folded, trimmed text. */
  private flowPlain(): string {
    let out = '';
    const start = this.fp;
    for (;;) {
      if (this.fp >= this.srcEnd) break;
      const ch = this.src[this.fp]!;
      if (ch === ',' || ch === ']' || ch === '}' || ch === '[' || ch === '{') break;
      if (ch === ':') {
        const nx = this.fp + 1 < this.srcEnd ? this.src[this.fp + 1] : undefined;
        if (nx === undefined || nx === ' ' || nx === '\t' || nx === '\n' || nx === ',' || nx === ']' || nx === '}') break;
      }
      if (ch === '#' && this.fp > start && (this.src[this.fp - 1] === ' ' || this.src[this.fp - 1] === '\t')) break;
      if (ch === '\n') {
        let q = this.fp;
        let nl = 0;
        while (q < this.srcEnd && /[ \t\n]/.test(this.src[q]!)) {
          if (this.src[q] === '\n') nl++;
          q++;
        }
        const nc = this.src[q];
        if (q >= this.srcEnd || nc === ',' || nc === ']' || nc === '}' || nc === '#' || nc === ':') break;
        out = out.replace(/[ \t]+$/, '') + (nl > 1 ? '\n'.repeat(nl - 1) : ' ');
        this.fp = q;
        continue;
      }
      out += ch;
      this.fp++;
    }
    const t = out.trim();
    if (t === '' && this.fp === start) throw this.errAt('expected a value in flow collection', this.fp);
    return t;
  }

  private flowKey(): string {
    this.fws();
    const ch = this.src[this.fp];
    if (ch === '"' || ch === "'") {
      const [s, e] = this.quoted(this.fp);
      this.fp = e;
      return s;
    }
    if (ch === '[' || ch === '{') throw this.errAt('flow collections as mapping keys are not supported', this.fp);
    if (ch === '?' && /[ \t\n]/.test(this.src[this.fp + 1] ?? '')) {
      throw this.errAt('complex mapping keys ("? ") are not supported', this.fp);
    }
    return this.flowPlain();
  }

  private flowSeq(): unknown[] {
    const open = this.fp;
    this.fp++;
    const arr: unknown[] = [];
    for (;;) {
      this.fws();
      if (this.fp >= this.srcEnd) throw this.errAt('unterminated flow sequence', open);
      const ch = this.src[this.fp]!;
      if (ch === ']') {
        this.fp++;
        return arr;
      }
      if (ch === ',') throw this.errAt("unexpected ',' in flow sequence", this.fp);
      let v: unknown;
      if (ch === '[' || ch === '{' || ch === '&' || ch === '!' || ch === '*') {
        v = this.flowNode();
      } else {
        // scalar, possibly the key of a single-pair mapping (`[a: 1]`)
        const save = this.fp;
        const keyText = this.flowKey();
        this.fws();
        if (this.src[this.fp] === ':' && this.fp < this.srcEnd) {
          this.fp++;
          this.fws();
          let val: unknown = null;
          if (this.src[this.fp] !== ',' && this.src[this.fp] !== ']') val = this.flowNode();
          const o: Obj = {};
          setProp(o, keyText, val);
          v = o;
        } else {
          this.fp = save;
          v = this.flowNode();
        }
      }
      arr.push(v);
      this.fws();
      if (this.fp >= this.srcEnd) throw this.errAt('unterminated flow sequence', open);
      const sep = this.src[this.fp];
      if (sep === ',' && this.fp < this.srcEnd) {
        this.fp++;
        continue;
      }
      if (sep === ']' && this.fp < this.srcEnd) {
        this.fp++;
        return arr;
      }
      throw this.errAt("expected ',' or ']' in flow sequence", Math.min(this.fp, this.srcEnd));
    }
  }

  private flowMap(): Obj {
    const open = this.fp;
    this.fp++;
    const obj: Obj = {};
    for (;;) {
      this.fws();
      if (this.fp >= this.srcEnd) throw this.errAt('unterminated flow mapping', open);
      const ch = this.src[this.fp]!;
      if (ch === '}') {
        this.fp++;
        return obj;
      }
      if (ch === ',') throw this.errAt("unexpected ',' in flow mapping", this.fp);
      const key = this.flowKey();
      this.fws();
      let val: unknown = null;
      if (this.src[this.fp] === ':' && this.fp < this.srcEnd) {
        this.fp++;
        this.fws();
        if (this.src[this.fp] !== ',' && this.src[this.fp] !== '}') val = this.flowNode();
      }
      setProp(obj, key, val);
      this.fws();
      if (this.fp >= this.srcEnd) throw this.errAt('unterminated flow mapping', open);
      const sep = this.src[this.fp];
      if (sep === ',' && this.fp < this.srcEnd) {
        this.fp++;
        continue;
      }
      if (sep === '}' && this.fp < this.srcEnd) {
        this.fp++;
        return obj;
      }
      throw this.errAt("expected ',' or '}' in flow mapping", Math.min(this.fp, this.srcEnd));
    }
  }
}

/** YAML folded-scalar line folding (lines exclude trailing empty lines). */
function foldLines(lines: string[]): string {
  let out = '';
  let empties = 0;
  let prevMore = false;
  let first = true;
  for (const line of lines) {
    if (line === '') {
      empties++;
      continue;
    }
    const more = line[0] === ' ' || line[0] === '\t';
    if (first) out += '\n'.repeat(empties);
    else if (more || prevMore) out += '\n'.repeat(empties + 1);
    else if (empties === 0) out += ' ';
    else out += '\n'.repeat(empties);
    out += line;
    first = false;
    prevMore = more;
    empties = 0;
  }
  return out;
}

/**
 * Parse a single YAML document (subset; see module doc). Returns `null` for an empty
 * document. Throws {@link YamlError} with a 1-based line on malformed input.
 */
export function parseYaml(text: string): unknown {
  let src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  src = src.replace(/\r\n?/g, '\n');
  try {
    return new Parser(src).parse();
  } catch (e) {
    // Last-resort guard: never leak a RangeError (stack overflow) to callers.
    if (e instanceof RangeError) throw new YamlError('document is too deeply nested', 1);
    throw e;
  }
}

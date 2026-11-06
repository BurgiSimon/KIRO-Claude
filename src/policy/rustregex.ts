/**
 * Rust `regex` crate patterns compiled as JavaScript RegExps (06 §1.4.1).
 *
 * Q CLI matches `toolsSettings.execute_bash.allowedCommands` / `deniedCommands` (and Kiro 2.x
 * `web_fetch.trusted` / `blocked`) with Rust `regex`, anchored by concatenation:
 * `\A${p}\z` (NOT grouped, so `a|b` means "starts with a OR ends with b"). Faithful port:
 * {@link anchoredRustRegex} builds `^` + translate(p) + `$`.
 *
 * Rust syntax that JS lacks or reads differently is translated rather than rejected (otherwise
 * a valid Rust deny rule would become deny-all and a valid allow rule would be ignored):
 *  - inline flags `(?i)`, `(?s)`, `(?m)`, `(?x)` (anywhere; applied to the whole pattern —
 *    an approximation for flags that appear mid-pattern) and scoped `(?i:…)` (→ `(?:…)` + flag);
 *  - `(?P<name>…)` → `(?<name>…)`; `\A` / `\z` → input-boundary look-arounds;
 *  - POSIX classes `[[:alpha:]]` … → explicit ASCII ranges; nested classes `[a[bc]]` are flattened;
 *    a negated POSIX class that is the only item of its class (`[[:^digit:]]`, `[^[:^digit:]]`)
 *    becomes the complementary class; `[:name:]` with an unknown name is, as in Rust, a nested
 *    class of its characters (`[[:nope:]]` = `[:nope]`);
 *  - `\pL` / `\p{…}` / `\x{…}` / `\u{…}` / `\U…` → compiled with the `u` flag;
 *  - escaped punctuation that JS `u` mode rejects (`\-`, `\#`, `\ ` …) → the plain character;
 *  - `x` mode: unescaped whitespace and `#` comments outside classes are dropped;
 *  - `.` → `[^\n]` (`[\s\S]` with `s`): Rust's dot matches `\r`, U+2028 and U+2029, JS's does
 *    not (otherwise `deniedCommands: ["git .*"]` would miss `git status\r…`);
 *  - patterns are compiled with the JS `u` flag whenever JS accepts it, so that `.`, negated
 *    classes and case folding work on code points like Rust (not UTF-16 code units).
 *
 * Constructs Rust's regex engine does NOT support make the pattern invalid (return `null`):
 * look-around `(?=`, `(?!`, `(?<=`, `(?<!`, back-references `\1`–`\9`, `\k<…>`, `(?P=name)`,
 * unknown letter escapes, and a `{` that does not start a counted repetition. Valid Rust
 * syntax this translator cannot express without the JS `v` flag (Node ≥ 20) is ALSO reported
 * as invalid: class set operations (`&&`, `--`, `~~`), negated nested classes (`[a[^b]]`), a
 * negated POSIX class mixed with other class items, and the swap-greed flag `U`. "Invalid"
 * errs on the safe side: a deny rule then denies everything, an allow rule is ignored.
 * Rust `\d`, `\w`, `\s` are Unicode-aware while JS (without `u`) is ASCII — accepted
 * difference (06 §1.4.1, impact UNVERIFIED).
 */

const POSIX_CLASSES: Record<string, string> = {
  alnum: '0-9A-Za-z',
  alpha: 'A-Za-z',
  ascii: '\\x00-\\x7F',
  blank: '\\t ',
  cntrl: '\\x00-\\x1F\\x7F',
  digit: '0-9',
  graph: '!-~',
  lower: 'a-z',
  print: ' -~',
  punct: '!-\\/:-@\\[-`{-~',
  space: '\\t\\n\\v\\f\\r ',
  upper: 'A-Z',
  word: '0-9A-Za-z_',
  xdigit: '0-9A-Fa-f',
};

/** Characters that must stay backslash-escaped outside a class (valid identity escapes in `u` mode). */
const SYNTAX_CHARS = '^$\\.*+?()[]{}|/';
/** Same, inside a class (`-` is also allowed there). */
const CLASS_SYNTAX_CHARS = '^$\\.*+?()[]{}|/-';

export interface TranslatedRegex {
  source: string;
  flags: string;
}

interface Esc {
  text: string;
  next: number;
  unicode?: boolean;
}

/** Hex/unicode/property escapes shared by both contexts; `i` points at the backslash. */
function codeEscape(src: string, i: number): Esc | null | undefined {
  const d = src[i + 1];
  const hexBraced = (start: number): { hex: string; next: number } | null => {
    const close = src.indexOf('}', start);
    if (close < 0) return null;
    const hex = src.slice(start + 1, close);
    if (!/^[0-9A-Fa-f]{1,8}$/.test(hex) || parseInt(hex, 16) > 0x10ffff) return null;
    return { hex, next: close + 1 };
  };
  const fixedHex = (start: number, len: number): string | null => {
    const h = src.slice(start, start + len);
    return h.length === len && /^[0-9A-Fa-f]+$/.test(h) ? h : null;
  };
  switch (d) {
    case 'x':
    case 'u':
    case 'U': {
      if (src[i + 2] === '{') {
        const r = hexBraced(i + 2);
        return r ? { text: `\\u{${r.hex}}`, next: r.next, unicode: true } : null;
      }
      const len = d === 'x' ? 2 : d === 'u' ? 4 : 8;
      const h = fixedHex(i + 2, len);
      if (h === null) return null;
      if (d === 'x') return { text: `\\x${h}`, next: i + 4 };
      if (d === 'u') return { text: `\\u${h}`, next: i + 6 };
      if (parseInt(h, 16) > 0x10ffff) return null;
      return { text: `\\u{${h}}`, next: i + 10, unicode: true };
    }
    case 'p':
    case 'P': {
      if (src[i + 2] === '{') {
        const close = src.indexOf('}', i + 3);
        if (close < 0) return null;
        return { text: `\\${d}{${src.slice(i + 3, close)}}`, next: close + 1, unicode: true };
      }
      const name = src[i + 2];
      if (name === undefined || !/[A-Za-z]/.test(name)) return null;
      return { text: `\\${d}{${name}}`, next: i + 3, unicode: true };
    }
    default:
      return undefined;
  }
}

/** Escape outside a character class; `i` points at the backslash. */
function escapeOutside(src: string, i: number): Esc | null {
  const d = src[i + 1];
  if (d === undefined) return null;
  const code = codeEscape(src, i);
  if (code !== undefined) return code;
  if (/[0-9]/.test(d)) return null; // back-references / octal: unsupported by Rust regex
  if (d === 'A') return { text: '(?<![\\s\\S])', next: i + 2 };
  if (d === 'z') return { text: '(?![\\s\\S])', next: i + 2 };
  if (d === 'b' && src[i + 2] === '{') {
    const close = src.indexOf('}', i + 3);
    const kind = close < 0 ? '' : src.slice(i + 3, close);
    if (kind === 'start') return { text: '\\b(?=\\w)', next: close + 1 };
    if (kind === 'end') return { text: '\\b(?<=\\w)', next: close + 1 };
    return null;
  }
  if ('bBdDwWsSnrtfv'.includes(d)) return { text: `\\${d}`, next: i + 2 };
  if (d === 'a') return { text: '\\x07', next: i + 2 };
  if (d === '<') return { text: '\\b(?=\\w)', next: i + 2 };
  if (d === '>') return { text: '\\b(?<=\\w)', next: i + 2 };
  if (/[A-Za-z]/.test(d)) return null; // unknown letter escape (incl. \k, \Z, \e)
  return { text: SYNTAX_CHARS.includes(d) ? `\\${d}` : d, next: i + 2 };
}

interface ClassParse {
  body: string;
  negated: boolean;
  next: number;
  unicode: boolean;
}

/** Parse a bracket class starting at `src[i] === '['`. */
function parseClass(src: string, i: number): ClassParse | null {
  let j = i + 1;
  let negated = false;
  let unicode = false;
  if (src[j] === '^') {
    negated = true;
    j++;
  }
  let body = '';
  /** Negated POSIX items (`[:^digit:]`) as positive ranges. */
  const negPosix: string[] = [];
  let first = true;
  for (;;) {
    if (j >= src.length) return null;
    const c = src[j]!;
    if (c === ']') {
      if (!first) {
        j++;
        break;
      }
      body += '\\]'; // a leading `]` is literal in Rust (JS `[]` would be the empty class)
      j++;
      first = false;
      continue;
    }
    first = false;
    if (c === '[') {
      // Rust: `[:` [`^`] name `:]` with a KNOWN name is an ASCII class; anything else is parsed
      // as a nested class (regex-syntax `maybe_parse_ascii_class`).
      const posix = /^\[:(\^?)([^:\]]*):\]/.exec(src.slice(j));
      const cls = posix && Object.prototype.hasOwnProperty.call(POSIX_CLASSES, posix[2]!) ? POSIX_CLASSES[posix[2]!] : undefined;
      if (posix && cls !== undefined) {
        if (posix[1]) negPosix.push(cls);
        else body += cls;
        j += posix[0].length;
        continue;
      }
      const inner = parseClass(src, j);
      if (!inner || inner.negated) return null;
      body += inner.body;
      unicode ||= inner.unicode;
      j = inner.next;
      continue;
    }
    if (c === '\\') {
      const d = src[j + 1];
      if (d === undefined) return null;
      const code = codeEscape(src, j);
      if (code === null) return null;
      if (code !== undefined) {
        body += code.text;
        unicode ||= !!code.unicode;
        j = code.next;
        continue;
      }
      if ('dDwWsSnrtfv'.includes(d)) body += `\\${d}`;
      else if (d === 'a') body += '\\x07';
      else if (/[A-Za-z0-9]/.test(d)) return null;
      else body += CLASS_SYNTAX_CHARS.includes(d) ? `\\${d}` : d;
      j += 2;
      continue;
    }
    const pair = src.slice(j, j + 2);
    if (pair === '&&' || pair === '--' || pair === '~~') return null; // set operations
    body += c === '/' ? '\\/' : c;
    j++;
  }
  if (negPosix.length) {
    // `[[:^digit:]]` = `[^0-9]`; `[^[:^digit:]]` = `[0-9]`. Mixed with other items: unsupported.
    if (negPosix.length !== 1 || body !== '') return null;
    return { body: negPosix[0]!, negated: !negated, next: j, unicode };
  }
  return { body, negated, next: j, unicode };
}

/** Translate Rust regex syntax to a JS RegExp source + flags; `null` if Rust would reject it. */
export function translateRustRegex(src: string): TranslatedRegex | null {
  const flags = new Set<string>();
  let extended = false;
  let unicode = false;
  let out = '';
  /** Offsets in `out` where an unescaped `.` (outside classes) stands. */
  const dots: number[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (extended) {
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v') {
        i++;
        continue;
      }
      if (c === '#') {
        while (i < n && src[i] !== '\n') i++;
        continue;
      }
    }
    if (c === '\\') {
      const e = escapeOutside(src, i);
      if (!e) return null;
      out += e.text;
      unicode ||= !!e.unicode;
      i = e.next;
      continue;
    }
    if (c === '[') {
      const cls = parseClass(src, i);
      if (!cls) return null;
      out += `[${cls.negated ? '^' : ''}${cls.body}]`;
      unicode ||= cls.unicode;
      i = cls.next;
      continue;
    }
    if (c === '(') {
      if (src[i + 1] !== '?') {
        out += '(';
        i++;
        continue;
      }
      const rest = src.slice(i + 2);
      if (rest.startsWith('P<')) {
        out += '(?<';
        i += 4;
        continue;
      }
      if (rest.startsWith('P=') || rest.startsWith('=') || rest.startsWith('!') || rest.startsWith('<=') || rest.startsWith('<!')) {
        return null; // back-reference / look-around: unsupported by Rust regex
      }
      if (rest.startsWith('<')) {
        out += '(?<';
        i += 3;
        continue;
      }
      if (rest.startsWith(':')) {
        out += '(?:';
        i += 3;
        continue;
      }
      const m = /^([A-Za-z-]*)([):])/.exec(rest);
      if (!m) return null;
      let negate = false;
      for (const f of m[1]!) {
        if (f === '-') negate = true;
        else if (f === 'i' || f === 'm' || f === 's') {
          if (negate) flags.delete(f);
          else flags.add(f);
        } else if (f === 'x') extended = !negate;
        else if (f === 'u' || f === 'R') {
          /* Unicode is the JS-side approximation already; CRLF mode ignored */
        } else return null; // `U` (swap greed) and unknown flags
      }
      if (m[2] === ':') out += '(?:';
      i += 2 + m[0].length;
      continue;
    }
    if (c === '{') {
      const m = /^\{\d+(?:,\d*)?\}/.exec(src.slice(i));
      if (!m) return null; // Rust: `{` must start a counted repetition
      out += m[0];
      i += m[0].length;
      continue;
    }
    if (c === '}' || c === ']') {
      out += `\\${c}`;
      i++;
      continue;
    }
    if (c === '/') {
      out += '\\/';
      i++;
      continue;
    }
    if (c === '.') {
      // Rust `.` = any character except `\n` (with `s`: any). JS `.` also excludes `\r`,
      // U+2028 and U+2029, so `git .*` would miss `git status\r…` — a deny-rule bypass.
      dots.push(out.length);
      i++;
      continue;
    }
    out += c;
    i++;
  }
  if (dots.length) {
    const any = flags.has('s') ? '[\\s\\S]' : '[^\\n]';
    let s = '';
    let prev = 0;
    for (const at of dots) {
      s += out.slice(prev, at) + any;
      prev = at;
    }
    out = s + out.slice(prev);
  }
  const f = [...flags].sort().join('') + (unicode ? 'u' : '');
  return { source: out, flags: f };
}

/**
 * Compile with the `u` flag when JS accepts it (Rust matches Unicode scalar values, so `.`,
 * `[^x]` and case folding must see whole code points: `rm .` matches `rm 😀` in Rust), else
 * without it. Adding `u` never turns a translatable pattern invalid: it is only a preference.
 */
function tryCompile(source: string, flags: string): RegExp | null {
  if (!flags.includes('u')) {
    try {
      return new RegExp(source, `${flags}u`);
    } catch {
      /* fall back to non-unicode mode below */
    }
  }
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}

/** Compile a Rust regex (unanchored); `null` when Rust `regex` would reject it. */
export function compileRustRegex(src: string): RegExp | null {
  const t = translateRustRegex(src);
  return t ? tryCompile(t.source, t.flags) : null;
}

const anchoredCache = new Map<string, RegExp | null>();

/**
 * Q's anchored form `\A${p}\z` (concatenated, not grouped), compiled to JS; `null` when invalid.
 * With the `m` flag, `^`/`$` would mean line boundaries, so input-boundary look-arounds are used.
 */
export function anchoredRustRegex(p: string): RegExp | null {
  const hit = anchoredCache.get(p);
  if (hit !== undefined) return hit;
  const t = translateRustRegex(p);
  let re: RegExp | null = null;
  if (t) {
    const multi = t.flags.includes('m');
    const start = multi ? '(?<![\\s\\S])' : '^';
    const end = multi ? '(?![\\s\\S])' : '$';
    re = tryCompile(`${start}${t.source}${end}`, t.flags);
  }
  if (anchoredCache.size > 1024) anchoredCache.clear();
  anchoredCache.set(p, re);
  return re;
}

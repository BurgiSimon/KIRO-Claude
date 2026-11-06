/**
 * POSIX-shell word splitting, quoting and compound-command splitting.
 *
 * {@link shlexSplit} implements Rust `shlex 1.3.0` (`split`), the splitter Q CLI uses for its
 * `execute_bash` read-only check and prompt arguments (06 §1.4.1, Appendix A; vectors from the
 * crate's own test table):
 *  - word separators: space, tab, newline (`\r` is an ordinary character);
 *  - single quotes are literal; inside double quotes `\` escapes only `$`, `` ` ``, `"`, `\`
 *    and newline (a backslash-newline disappears); other `\x` keep the backslash;
 *  - outside quotes `\x` ⇒ `x` and `\<newline>` ⇒ nothing;
 *  - unterminated quote or trailing `\` ⇒ `null`.
 *  - Comments: with `{ comments: true }` a `#` at the start of a word starts a comment that
 *    runs to the end of the line — exactly Rust shlex (`ls # ; rm x` ⇒ `["ls"]`). The default
 *    is `false`, like Python's `shlex.split(posix=True)`, so prompt arguments such as
 *    `/fix #123` keep their `#` words. Q-faithful callers (permission engine) pass `true`.
 *
 * {@link shellQuote} is POSIX single-quote quoting (Python `shlex.quote`).
 *
 * {@link splitCompoundCommand} splits a shell command line into the simple commands that
 * Kiro V3 evaluates independently (02 §2.8 "Shell parsing", 00 §5.1 capEngine: "split on `;`,
 * `&&`, `||`, `|`; … unparseable ⇒ deny"). See its doc comment for the exact rules.
 */

/** Options for {@link shlexSplit}. */
export interface ShlexOptions {
  /** Treat `#` at the start of a word as a comment to end of line (Rust shlex). Default false. */
  comments?: boolean;
}

/** Split `s` into words with POSIX shell quoting rules; `null` on unbalanced quotes. */
export function shlexSplit(s: string, opts: ShlexOptions = {}): string[] | null {
  const comments = opts.comments ?? false;
  const out: string[] = [];
  let i = 0;
  const n = s.length;
  const ws = (c: string): boolean => c === ' ' || c === '\t' || c === '\n';
  for (;;) {
    // skip whitespace and comments
    let c: string;
    for (;;) {
      if (i >= n) return out;
      c = s[i++]!;
      if (ws(c)) continue;
      if (comments && c === '#') {
        while (i < n) {
          if (s[i++] === '\n') break;
        }
        continue;
      }
      break;
    }
    let w = '';
    for (;;) {
      if (c === '"') {
        for (;;) {
          if (i >= n) return null;
          const d = s[i++]!;
          if (d === '\\') {
            if (i >= n) return null;
            const e = s[i++]!;
            if (e === '$' || e === '`' || e === '"' || e === '\\') w += e;
            else if (e === '\n') {
              /* line continuation: nothing */
            } else w += `\\${e}`;
          } else if (d === '"') break;
          else w += d;
        }
      } else if (c === "'") {
        for (;;) {
          if (i >= n) return null;
          const d = s[i++]!;
          if (d === "'") break;
          w += d;
        }
      } else if (c === '\\') {
        if (i >= n) return null;
        const d = s[i++]!;
        if (d !== '\n') w += d;
      } else if (ws(c)) break;
      else w += c;
      if (i >= n) break;
      c = s[i++]!;
    }
    out.push(w);
  }
}

const SAFE_UNQUOTED = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** Quote one argument for a POSIX shell (`''` for empty; safe strings stay unquoted). */
export function shellQuote(arg: string): string {
  if (arg === '') return "''";
  if (SAFE_UNQUOTED.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'"'"'`)}'`;
}

/** Join arguments into a shell command line using {@link shellQuote}. */
export function shellJoin(args: readonly string[]): string {
  return args.map(shellQuote).join(' ');
}

const WORD_BREAK_BEFORE_HASH = new Set([' ', '\t', '\n', ';', '&', '|', '(', ')', '<', '>']);

interface PendingHeredoc {
  delim: string;
  stripTabs: boolean;
  /** Unquoted delimiter ⇒ body undergoes expansion (`$(…)`/backticks would execute). */
  expands: boolean;
}

/**
 * Reserved words that may precede the first word of a simple command (bash grammar). They are
 * syntax, not part of the command, so they are stripped from the start of a segment:
 * `if true; then rm -rf /; fi` yields `true` and `rm -rf /` (not `then rm -rf /`, which a
 * `rm *` deny rule would miss).
 */
const LEADING_RESERVED = new Set(['{', '!', 'if', 'then', 'elif', 'else', 'while', 'until', 'do', 'time']);
/** Reserved words that close a compound command; a segment consisting of only one is dropped. */
const CLOSING_RESERVED = new Set(['}', 'fi', 'done', 'esac']);

/**
 * Strip leading shell reserved words (and a `function NAME` header) from one segment.
 * Pure helper of {@link splitCompoundCommand}; `s` has no leading/trailing collapsed blanks.
 */
function stripReservedWords(s: string): string {
  for (;;) {
    const m = /^(\S+)(?: |$)/.exec(s);
    if (!m) return s;
    const w = m[1]!;
    if (LEADING_RESERVED.has(w)) {
      s = s.slice(m[0].length);
      // `time -p cmd`: the option belongs to the reserved word.
      if (w === 'time' && /^-p(?: |$)/.test(s)) s = s.slice(s.length > 2 ? 3 : 2);
      continue;
    }
    // `function name { body…` / `function name` (the `()` are separators already).
    const f = /^function [^ ]+(?: |$)/.exec(s);
    if (f) {
      s = s.slice(f[0].length);
      continue;
    }
    return s;
  }
}

/**
 * Split a shell command line into simple commands for policy evaluation.
 *
 * Separators (outside quotes): `;`, `&&`, `||`, `|`, `|&`, `&`, newline, and the grouping
 * characters `(` / `)`. Empty segments are dropped. Shell reserved words that only introduce
 * a command (`{`, `!`, `if`, `then`, `elif`, `else`, `while`, `until`, `do`, `time [-p]`,
 * `function NAME`) are removed from the start of a segment, and a segment that is exactly a
 * closing word (`}`, `fi`, `done`, `esac`) is dropped (one with trailing redirections such as
 * `done > out` is kept, so the redirection stays visible to policy). Quotes are kept verbatim
 * in segments, runs of unquoted spaces/tabs collapse to one space (escaped or quoted blanks
 * are preserved), comments (`#` at a word start) are removed, and backslash-newline
 * continuations are joined. Use {@link normalizeCommand} to also strip quoting before
 * matching. Redirections are not separators (`2>&1`, `>&2`, `&>f`, `<&3` stay in the word).
 * Here-documents (`<<WORD`, `<<-WORD`, quoted delimiters) are recognized: their bodies are
 * data, not commands, and are skipped.
 *
 * Returns `null` (unparseable for policy) when quotes are unbalanced, the input ends with a
 * lone `\`, a here-document is unterminated, or the command contains command/process
 * substitution that would execute hidden code: `` `…` ``, `$(…)` (also inside double quotes
 * and in expanding here-doc bodies), `<(…)`, `>(…)`. `$((…))` arithmetic is likewise
 * rejected. `$'…'` ANSI-C strings are supported.
 *
 * Not resolved (policy must treat them conservatively): variable expansion (`r$x`,
 * `${IFS}`), globbing in command names (`/bin/r?`), leading `NAME=value` assignments, and
 * commands that run other commands (`eval`, `sh -c`, `xargs`, `sudo`, …).
 */
export function splitCompoundCommand(cmd: string): string[] | null {
  const segments: string[] = [];
  let cur = '';
  /** An unquoted blank run was seen since the last appended text (emitted lazily). */
  let blank = false;
  let i = 0;
  const n = cmd.length;
  const pending: PendingHeredoc[] = [];

  /** Append text to the current segment, emitting one pending collapsed blank first. */
  const add = (s: string): void => {
    if (blank && cur !== '') cur += ' ';
    blank = false;
    cur += s;
  };

  const push = (): void => {
    let s = cur;
    cur = '';
    blank = false;
    s = stripReservedWords(s);
    if (s === '' || CLOSING_RESERVED.has(s)) return;
    segments.push(s);
  };

  /** Consume pending here-doc bodies starting at index `i` (just after a newline). */
  const consumeHeredocs = (): boolean => {
    while (pending.length) {
      const h = pending.shift()!;
      let found = false;
      while (i < n) {
        let end = cmd.indexOf('\n', i);
        if (end < 0) end = n;
        let line = cmd.slice(i, end);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        i = end < n ? end + 1 : n;
        const cmp = h.stripTabs ? line.replace(/^\t+/, '') : line;
        if (cmp === h.delim) {
          found = true;
          break;
        }
        if (h.expands && (line.includes('`') || line.includes('$('))) return false;
      }
      if (!found) return false;
    }
    return true;
  };

  /** Previous character of the current segment (a pending blank counts as `' '`). */
  const prevChar = (): string | undefined => (blank ? ' ' : cur.length ? cur[cur.length - 1] : undefined);

  while (i < n) {
    const ch = cmd[i]!;

    // ── quoting ──
    if (ch === "'") {
      const close = cmd.indexOf("'", i + 1);
      if (close < 0) return null;
      add(cmd.slice(i, close + 1));
      i = close + 1;
      continue;
    }
    if (ch === '$' && cmd[i + 1] === "'") {
      // ANSI-C quoting: backslash escapes inside.
      let j = i + 2;
      for (;;) {
        if (j >= n) return null;
        if (cmd[j] === '\\') {
          j += 2;
          continue;
        }
        if (cmd[j] === "'") break;
        j++;
      }
      add(cmd.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let text = '"';
      for (;;) {
        if (j >= n) return null;
        const d = cmd[j]!;
        if (d === '\\') {
          if (j + 1 >= n) return null;
          if (cmd[j + 1] === '\n') {
            j += 2; // line continuation inside double quotes
            continue;
          }
          text += d + cmd[j + 1];
          j += 2;
          continue;
        }
        if (d === '`') return null;
        if (d === '$' && cmd[j + 1] === '(') return null;
        text += d;
        j++;
        if (d === '"') break;
      }
      add(text);
      i = j;
      continue;
    }
    if (ch === '\\') {
      if (i + 1 >= n) return null;
      if (cmd[i + 1] === '\n') {
        i += 2; // line continuation
        continue;
      }
      add(cmd.slice(i, i + 2));
      i += 2;
      continue;
    }

    // ── hidden execution ──
    if (ch === '`') return null;
    if (ch === '$' && cmd[i + 1] === '(') return null;
    if ((ch === '<' || ch === '>') && cmd[i + 1] === '(') return null;

    // ── comments ──
    if (ch === '#') {
      const p = prevChar();
      if (p === undefined || WORD_BREAK_BEFORE_HASH.has(p)) {
        while (i < n && cmd[i] !== '\n') i++;
        continue; // the newline (if any) is handled as a separator next
      }
      add(ch);
      i++;
      continue;
    }

    // ── here-strings / here-documents ──
    if (ch === '<' && cmd[i + 1] === '<' && cmd[i + 2] === '<') {
      add('<<<');
      i += 3;
      continue;
    }
    if (ch === '<' && cmd[i + 1] === '<') {
      let j = i + 2;
      let stripTabs = false;
      if (cmd[j] === '-') {
        stripTabs = true;
        j++;
      }
      while (cmd[j] === ' ' || cmd[j] === '\t') j++;
      // delimiter word: may be quoted in parts; quoting disables expansion of the body
      let delim = '';
      let quoted = false;
      while (j < n) {
        const d = cmd[j]!;
        if (d === "'") {
          const close = cmd.indexOf("'", j + 1);
          if (close < 0) return null;
          delim += cmd.slice(j + 1, close);
          quoted = true;
          j = close + 1;
        } else if (d === '"') {
          const close = cmd.indexOf('"', j + 1);
          if (close < 0) return null;
          delim += cmd.slice(j + 1, close);
          quoted = true;
          j = close + 1;
        } else if (d === '\\' && j + 1 < n) {
          delim += cmd[j + 1];
          quoted = true;
          j += 2;
        } else if (/[\s;&|<>()]/.test(d)) break;
        else {
          delim += d;
          j++;
        }
      }
      if (delim === '') return null;
      pending.push({ delim, stripTabs, expands: !quoted });
      add(cmd.slice(i, j));
      i = j;
      continue;
    }

    // ── separators ──
    if (ch === '\n' || (ch === '\r' && cmd[i + 1] === '\n')) {
      push();
      i += ch === '\r' ? 2 : 1;
      if (pending.length && !consumeHeredocs()) return null;
      continue;
    }
    if (ch === ';' || ch === '(' || ch === ')') {
      push();
      i++;
      continue;
    }
    if (ch === '|') {
      if (prevChar() === '>') {
        // `>|file` (clobber redirection) is not a pipe
        add(ch);
        i++;
        continue;
      }
      push();
      i += cmd[i + 1] === '|' || cmd[i + 1] === '&' ? 2 : 1;
      continue;
    }
    if (ch === '&') {
      const p = prevChar();
      // redirections: `>&2`, `<&3`, `&>file`, `&>>file`
      if (p === '>' || p === '<' || cmd[i + 1] === '>') {
        add(ch);
        i++;
        continue;
      }
      push();
      i += cmd[i + 1] === '&' ? 2 : 1;
      continue;
    }

    if (ch === ' ' || ch === '\t') {
      // collapse unquoted whitespace runs: `rm  -rf /` must look like `rm -rf /` to policy
      // (emitted lazily so trailing blanks vanish and escaped/quoted blanks stay intact)
      blank = true;
      i++;
      continue;
    }
    add(ch);
    i++;
  }
  if (pending.length) return null; // here-doc never started (no newline after `<<EOF`)
  push();
  return segments;
}

const HEX = /^[0-9a-fA-F]$/;

/**
 * Decode the body of a bash ANSI-C string `$'…'` starting at `s[i]` (just after the opening
 * quote). Returns the decoded text and the index after the closing quote, or `null` when the
 * quote is unterminated. Escapes: `\a \b \e \E \f \n \r \t \v \\ \' \" \?`, octal `\nnn`
 * (1–3 digits), `\xHH` (1–2), `\uHHHH` (1–4), `\UHHHHHHHH` (1–8), `\cX` (control char);
 * unknown escapes keep the backslash (bash). A NUL ends the string's value, like bash.
 */
function decodeAnsiC(s: string, i: number): { text: string; end: number } | null {
  let out = '';
  let cut = false;
  const n = s.length;
  const emit = (t: string): void => {
    if (cut) return;
    const z = t.indexOf('\u0000');
    if (z >= 0) {
      out += t.slice(0, z);
      cut = true;
    } else out += t;
  };
  const digits = (start: number, max: number, re: RegExp): string => {
    let k = start;
    while (k < n && k - start < max && re.test(s[k]!)) k++;
    return s.slice(start, k);
  };
  while (i < n) {
    const ch = s[i]!;
    if (ch === "'") return { text: out, end: i + 1 };
    if (ch !== '\\') {
      emit(ch);
      i++;
      continue;
    }
    if (i + 1 >= n) return null;
    const e = s[i + 1]!;
    const simple: Record<string, string> = {
      a: '\u0007',
      b: '\b',
      e: '\u001b',
      E: '\u001b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t',
      v: '\v',
      '\\': '\\',
      "'": "'",
      '"': '"',
      '?': '?',
    };
    if (Object.prototype.hasOwnProperty.call(simple, e)) {
      emit(simple[e]!);
      i += 2;
      continue;
    }
    if (e >= '0' && e <= '7') {
      const d = digits(i + 1, 3, /^[0-7]$/);
      emit(String.fromCharCode(parseInt(d, 8) & 0xff));
      i += 1 + d.length;
      continue;
    }
    if (e === 'x' || e === 'u' || e === 'U') {
      const d = digits(i + 2, e === 'x' ? 2 : e === 'u' ? 4 : 8, HEX);
      if (d === '') {
        emit(`\\${e}`);
      } else {
        const code = parseInt(d, 16);
        emit(code <= 0x10ffff ? String.fromCodePoint(code) : '�');
      }
      i += 2 + d.length;
      continue;
    }
    if (e === 'c' && i + 2 < n && s[i + 2] !== "'") {
      const x = s[i + 2]!;
      emit(x === '?' ? '\u007f' : String.fromCharCode(x.toUpperCase().charCodeAt(0) & 0x1f));
      i += 3;
      continue;
    }
    emit(`\\${e}`);
    i += 2;
  }
  return null;
}

/**
 * Bash word splitting for policy normalization (no expansion): like {@link shlexSplit}
 * (without comments) but also decodes `$'…'` ANSI-C strings and treats `$"…"` as a plain
 * double-quoted string, both anywhere in a word (`r$'\x6d'` is `rm`). `null` on unbalanced
 * quotes or a trailing `\`.
 */
function bashWords(s: string): string[] | null {
  const out: string[] = [];
  const n = s.length;
  let i = 0;
  const ws = (c: string): boolean => c === ' ' || c === '\t' || c === '\n';
  let w = '';
  let inWord = false;
  while (i < n) {
    const c = s[i]!;
    if (ws(c)) {
      if (inWord) out.push(w);
      w = '';
      inWord = false;
      i++;
      continue;
    }
    inWord = true;
    if (c === '$' && s[i + 1] === "'") {
      const r = decodeAnsiC(s, i + 2);
      if (!r) return null;
      w += r.text;
      i = r.end;
      continue;
    }
    if (c === '$' && s[i + 1] === '"') {
      i++; // locale-translated string: same as "…"
      continue;
    }
    if (c === "'") {
      const close = s.indexOf("'", i + 1);
      if (close < 0) return null;
      w += s.slice(i + 1, close);
      i = close + 1;
      continue;
    }
    if (c === '"') {
      i++;
      for (;;) {
        if (i >= n) return null;
        const d = s[i]!;
        if (d === '"') {
          i++;
          break;
        }
        if (d === '\\') {
          if (i + 1 >= n) return null;
          const e = s[i + 1]!;
          if (e === '$' || e === '`' || e === '"' || e === '\\') w += e;
          else if (e !== '\n') w += `\\${e}`;
          i += 2;
          continue;
        }
        w += d;
        i++;
      }
      continue;
    }
    if (c === '\\') {
      if (i + 1 >= n) return null;
      const d = s[i + 1]!;
      if (d !== '\n') w += d;
      i += 2;
      continue;
    }
    w += c;
    i++;
  }
  if (inWord) out.push(w);
  return out;
}

/**
 * Canonical form of one simple command for policy matching: its shell words (quotes and
 * escapes removed; `$'…'` ANSI-C strings decoded, `$"…"` treated as `"…"`) joined by single
 * spaces. `"rm" -rf  /`, `r''m -rf /` and `$'\x72\x6d' -rf /` all become `rm -rf /`, so deny
 * rules cannot be dodged by quoting. Returns `null` when the text has unbalanced quotes.
 * (Unlike {@link shlexSplit}, which stays byte-faithful to Rust shlex for the Q engine.)
 */
export function normalizeCommand(segment: string): string | null {
  const words = bashWords(segment);
  return words === null ? null : words.join(' ');
}

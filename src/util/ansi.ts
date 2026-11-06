/**
 * Minimal ANSI styling (zero dependencies).
 *
 * Color policy (01 §9 `NO_COLOR`, plus the common `FORCE_COLOR` convention):
 *  - `FORCE_COLOR` set to anything except `''`, `'0'` or `'false'` ⇒ colors on;
 *    `FORCE_COLOR=0|false` ⇒ colors off;
 *  - otherwise `NO_COLOR` set to a non-empty value ⇒ off (https://no-color.org);
 *  - otherwise on iff the stream is a TTY and `TERM` is not `dumb`.
 *
 * The {@link c} helpers consult one module-level switch. It defaults to
 * `colorEnabled(process.stdout)` (decided lazily on first use) and can be overridden with
 * {@link setColorEnabled} (e.g. headless/ACP modes force it off; a renderer writing to stderr
 * can pass `colorEnabled(process.stderr)`).
 *
 * Nesting works like chalk: an inner style's close code re-opens the outer style.
 */

export interface ColorEnv {
  [key: string]: string | undefined;
}

/** Decide whether colors should be emitted on `stream` (default `process.stdout`). */
export function colorEnabled(
  stream: { isTTY?: boolean } | undefined = process.stdout,
  env: ColorEnv = process.env,
): boolean {
  const force = env.FORCE_COLOR;
  if (force !== undefined && force !== '') {
    return !(force === '0' || force.toLowerCase() === 'false');
  }
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (!stream || !stream.isTTY) return false;
  return env.TERM !== 'dumb';
}

let enabledOverride: boolean | undefined;
let enabledDefault: boolean | undefined;

/** Force colors on/off for every {@link c} helper. */
export function setColorEnabled(b: boolean): void {
  enabledOverride = b;
}

/** Current state of the module-level color switch. */
export function isColorEnabled(): boolean {
  if (enabledOverride !== undefined) return enabledOverride;
  if (enabledDefault === undefined) {
    try {
      enabledDefault = colorEnabled(process.stdout);
    } catch {
      enabledDefault = false;
    }
  }
  return enabledDefault;
}

type Style = (s: string) => string;

function style(open: number, close: number): Style {
  const o = `\u001b[${open}m`;
  const cl = `\u001b[${close}m`;
  return (s: string): string => {
    const text = String(s);
    if (!isColorEnabled()) return text;
    // Re-open this style after any nested close of the same kind.
    const body = text.includes(cl) ? text.split(cl).join(cl + o) : text;
    return o + body + cl;
  };
}

/** Style helpers; identity functions while colors are disabled. */
export const c = {
  bold: style(1, 22),
  dim: style(2, 22),
  italic: style(3, 23),
  underline: style(4, 24),
  red: style(31, 39),
  green: style(32, 39),
  yellow: style(33, 39),
  blue: style(34, 39),
  magenta: style(35, 39),
  cyan: style(36, 39),
  white: style(37, 39),
  gray: style(90, 39),
} as const;

export type StyleName = keyof typeof c;

// OSC (… BEL or ST), CSI (ESC[ or 8-bit CSI, params, intermediates, final), other ESC sequences.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]|\u001b[ -/]*[0-~]/g;

/** Remove ANSI escape sequences (SGR colors, cursor movement, OSC 8 hyperlinks, …). */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

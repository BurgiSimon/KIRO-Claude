/**
 * YAML front matter splitting for Markdown agents (02 §2.12), steering files (02 §4, 03 §3),
 * skills (`SKILL.md`, 02 §6.2) and prompts (02 §6.1).
 *
 * Rules (02 §4: "Front matter must be the very first bytes (no blank line before `---`).
 * Strip BOM, normalize CRLF"):
 *  - front matter exists only when the text (after an optional UTF-8 BOM) starts with a line
 *    that is exactly `---` (trailing spaces/tabs allowed, LF or CRLF) AND a later line is
 *    exactly `---` or `...`; otherwise `hasFrontMatter` is false and `body` is the input
 *    (minus BOM);
 *  - the block between the delimiters is parsed with {@link parseYaml}; an empty block or a
 *    `null` document gives `data = {}`;
 *  - if the YAML is malformed or is not a mapping, `data = {}` and `error` describes the
 *    problem; `hasFrontMatter` is still true and `body` is still the text after the block;
 *  - `body` starts right after the closing delimiter's line break; it is returned verbatim
 *    (CRLF preserved) — use `normalizeNewlines` from text.ts if needed.
 */

import { parseYaml, YamlError } from './yaml.js';

export interface FrontMatterResult {
  data: Record<string, unknown>;
  body: string;
  hasFrontMatter: boolean;
  error?: string;
}

const OPEN_RE = /^---[ \t]*(?:\r?\n|$)/;
const CLOSE_RE = /^(?:---|\.\.\.)[ \t]*$/;

/** Split `text` into front matter data and body (see module doc). */
export function parseFrontMatter(text: string): FrontMatterResult {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const open = OPEN_RE.exec(src);
  if (!open) return { data: {}, body: src, hasFrontMatter: false };

  // Walk lines after the opening delimiter looking for the closing one.
  let pos = open[0].length;
  let closeStart = -1;
  let closeEnd = -1;
  while (pos <= src.length) {
    const nl = src.indexOf('\n', pos);
    const lineEnd = nl < 0 ? src.length : nl;
    let line = src.slice(pos, lineEnd);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (CLOSE_RE.test(line)) {
      closeStart = pos;
      closeEnd = nl < 0 ? src.length : nl + 1;
      break;
    }
    if (nl < 0) break;
    pos = nl + 1;
  }
  if (closeStart < 0 || open[0].length === 0) return { data: {}, body: src, hasFrontMatter: false };

  const yamlText = src.slice(open[0].length, closeStart);
  const body = src.slice(closeEnd);
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText);
  } catch (e) {
    const msg = e instanceof YamlError ? `invalid front matter: ${e.reason} at line ${e.line + 1}` : `invalid front matter: ${String(e)}`;
    return { data: {}, body, hasFrontMatter: true, error: msg };
  }
  if (parsed === null || parsed === undefined) return { data: {}, body, hasFrontMatter: true };
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { data: {}, body, hasFrontMatter: true, error: 'invalid front matter: expected a mapping of keys to values' };
  }
  return { data: parsed as Record<string, unknown>, body, hasFrontMatter: true };
}

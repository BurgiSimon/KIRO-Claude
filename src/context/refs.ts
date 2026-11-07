/**
 * Per-turn reference expansion: Kiro CLI `@` references (01 §4.3–4.4) and the IDE-style `#`
 * context providers the port supports (03 §4, 00 §2.2).
 *
 * `@` references ({@link expandAtRefs}):
 *  1. Prompt first (01 §4.3 step 3, 06 §8): when the message *starts with* `@<name>` and
 *     `<name>` is a known prompt (case-insensitive; prompt names are `[A-Za-z0-9_-]{1,50}`, so
 *     `@./name` always means a file), nothing is expanded; the invocation is reported as
 *     `promptExpansion` (`args` shlex-split) and the caller substitutes the prompt.
 *  2. Otherwise every `@path` token (at the start of the text or after whitespace, outside
 *     code spans / fences) that names an existing file or directory, relative to `cwd` or
 *     absolute, is expanded into a block; `@"path with spaces"` / `@'…'` are quoted forms.
 *     Unquoted tokens lose trailing punctuation (`@a.ts,`) when the full token does not exist.
 *     No globs, no `~`, no line ranges (01 §4.4). Non-existent tokens stay plain text.
 *     - text file ⇒ `<file path="abs">` + fenced code block; files over 250 KB are cut at
 *       250 KB with the warning `⚠ File '<p>' was truncated (exceeds 250KB limit)`;
 *       binary files (NUL byte or invalid UTF-8) are not included (warning);
 *     - directory ⇒ `<directory path="abs">` tree, depth 3, 10 items per level then
 *       `... (N more items)`, skipping node_modules, .git, target, dist, build;
 *     - png/jpg/jpeg/gif/webp ⇒ image content blocks (≤ {@link MAX_IMAGE_BYTES} each,
 *       ≤ {@link MAX_IMAGES_PER_MESSAGE} per message).
 *  3. Drag-and-drop (01 §4.3 step 1): a message that is exactly one image path (optionally
 *     quoted or with `\ ` escapes) attaches that image.
 *  The user text itself is returned unchanged (the tokens stay visible to the model).
 *
 * `#` providers ({@link expandHashRefs}, 03 §4 grammar; skipped inside code, after
 * non-whitespace, for `# ` and for Markdown headings `^#{1,6}\s`):
 *  - `#spec:<name>` ⇒ the spec's requirements.md / bugfix.md / design.md / tasks.md, read under
 *    the rules of kiro-claude's own spec I/O (spec/docfs: a linked document, a spec folder or
 *    `.kiro/specs` linked out of the workspace or to nothing is not read; each is a notice);
 *  - `#steering:<file>` and bare `#<name>` of a manual/auto steering file ⇒ `steeringNames`
 *    (the caller injects bodies through SteeringActivator, once per session);
 *  - bare `#<name>` resolution order: steering → spec → existing file → existing directory →
 *    plain text; `#file:<p>`, `#folder:<p>`, `#docs:<p>` force file/dir handling;
 *  - `#git diff` (`#Git Diff`) ⇒ `<git_diff>` with `git status --short` + `git diff HEAD`
 *    (≤ 250 KB) through the injectable `runGit`;
 *  - hints (blocks): `#codebase`, `#url:<url>`, `#mcp:<server>`; `#code:<rest>` ⇒ code block;
 *    `#repository` ⇒ workspace tree;
 *  - `#terminal`, `#problems`, `#current` and providers missing their argument ⇒ one-line
 *    notice, nothing expanded.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PromptFile, SteeringFile, WorkspaceContext } from '../types.js';
import { specFileRefused, specFolderRefused, specRefusalText, specsRootRefused } from '../spec/docfs.js';
import { shlexSplit } from '../util/shlex.js';
import { truncateBytes, utf8SafePrefixLength } from '../util/text.js';
import { compareBytes } from './tokens.js';

/** File reference size cap (01 §4.4). */
export const MAX_FILE_REF_BYTES = 250 * 1024;
export const DIR_TREE_MAX_DEPTH = 3;
export const DIR_TREE_MAX_ITEMS = 10;
export const DIR_TREE_IGNORE: readonly string[] = ['node_modules', '.git', 'target', 'dist', 'build'];
/**
 * Claude API per-image limit (decided; Q used 10 MB for its own backend). The API checks the
 * base64 payload, so a file is attached only when its *encoded* size fits
 * ({@link base64Length}): raw images up to 3.75 MB.
 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Length of the base64 encoding of `n` bytes. */
export function base64Length(n: number): number {
  return Math.ceil(Math.max(0, n) / 3) * 4;
}
/** Q `MAX_NUMBER_OF_IMAGES_PER_REQUEST`. */
export const MAX_IMAGES_PER_MESSAGE = 10;

export const IMAGE_MEDIA_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

const LANG_BY_EXT: Readonly<Record<string, string>> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
  py: 'python', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin', rb: 'ruby', php: 'php', cs: 'csharp',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp', swift: 'swift', scala: 'scala', sh: 'bash', bash: 'bash',
  zsh: 'zsh', ps1: 'powershell', sql: 'sql', md: 'markdown', json: 'json', yaml: 'yaml', yml: 'yaml',
  toml: 'toml', xml: 'xml', html: 'html', css: 'css', scss: 'scss', vue: 'vue', svelte: 'svelte', lua: 'lua',
  dart: 'dart', ex: 'elixir', exs: 'elixir', hs: 'haskell', tf: 'hcl', dockerfile: 'dockerfile',
};

export interface AtRefImage {
  mediaType: string;
  dataBase64: string;
  path: string;
}

export interface AtRefsResult {
  /** The user text (unchanged). */
  text: string;
  /** Expanded file / directory blocks, in reference order. */
  blocks: string[];
  images: AtRefImage[];
  /** Set when the message is a prompt invocation `@<prompt> args…` (caller expands it). */
  promptExpansion?: { name: string; args: string[] };
  /** User-facing warnings (truncation, binary files, image limits). */
  warnings: string[];
}

// ───────────────────────────── code masking ─────────────────────────────

/**
 * `[start, end)` ranges of Markdown code (fenced blocks with ``` or ~~~, and inline code spans
 * delimited by equal-length backtick runs). References inside them are not expanded.
 */
export function codeRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  // fenced blocks, line based
  const lines = text.split('\n');
  let pos = 0;
  let open: { ch: string; len: number; start: number } | undefined;
  for (const line of lines) {
    const lineEnd = pos + line.length + 1;
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (open) {
      if (m && m[1]![0] === open.ch && m[1]!.length >= open.len && line.trim() === m[1]) {
        ranges.push([open.start, Math.min(lineEnd, text.length)]);
        open = undefined;
      }
    } else if (m) {
      open = { ch: m[1]![0]!, len: m[1]!.length, start: pos };
    }
    pos = lineEnd;
  }
  if (open) ranges.push([open.start, text.length]);
  const inFence = (i: number): boolean => ranges.some(([a, b]) => i >= a && i < b);
  // inline spans outside fences
  const spans: Array<[number, number]> = [];
  const re = /`+/g;
  let m: RegExpExecArray | null;
  const runs: Array<{ i: number; len: number }> = [];
  while ((m = re.exec(text))) if (!inFence(m.index)) runs.push({ i: m.index, len: m[0].length });
  for (let k = 0; k < runs.length; k++) {
    const r = runs[k]!;
    const close = runs.findIndex((x, j) => j > k && x.len === r.len);
    if (close >= 0) {
      spans.push([r.i, runs[close]!.i + runs[close]!.len]);
      k = close;
    }
  }
  return [...ranges, ...spans].sort((a, b) => a[0] - b[0]);
}

function inRanges(ranges: Array<[number, number]>, i: number): boolean {
  for (const [a, b] of ranges) if (i >= a && i < b) return true;
  return false;
}

// ───────────────────────────── helpers ─────────────────────────────

const TRAILING_PUNCT = /[.,;:!?)\]}'"]$/;

/** Message of a thrown value (Error or not) as text; never throws. */
export function errorMessage(e: unknown): string {
  if (e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string') return (e as { message: string }).message;
  try {
    return String(e);
  } catch {
    return 'unknown error';
  }
}

/** `code` of a Node error (e.g. `ENOENT`), else {@link errorMessage}; never throws. */
export function errorText(e: unknown): string {
  const code = e && typeof e === 'object' ? (e as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : errorMessage(e);
}

function statSafe(p: string): fs.Stats | undefined {
  try {
    return fs.statSync(p);
  } catch {
    return undefined;
  }
}

function lstatSafe(p: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(p);
  } catch {
    return undefined;
  }
}

/** Resolve an unquoted token, dropping trailing punctuation until something exists. */
function resolveToken(token: string, cwd: string, quoted: boolean): { abs: string; typed: string; st: fs.Stats } | undefined {
  let t = token;
  for (;;) {
    if (t === '') return undefined;
    const abs = path.resolve(cwd, t);
    const st = statSafe(abs);
    if (st && (st.isFile() || st.isDirectory())) return { abs, typed: t, st };
    if (quoted || !TRAILING_PUNCT.test(t)) return undefined;
    t = t.slice(0, -1);
  }
}

function extOf(p: string): string {
  const base = path.basename(p).toLowerCase();
  if (base === 'dockerfile') return 'dockerfile';
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i + 1) : '';
}

/** Media type for a supported image path, else undefined. */
export function imageMediaType(p: string): string | undefined {
  return IMAGE_MEDIA_TYPES[extOf(p)];
}

function fenceFor(content: string): string {
  let longest = 0;
  for (const m of content.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  return '`'.repeat(Math.max(3, longest + 1));
}

function xmlAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/**
 * Read a text file for inlining: `{ content, truncated }`, or `{ binary: true }`.
 * Reads up to `maxBytes + 1` bytes sequentially whatever size `stat` reports: files under
 * `/proc` or `/sys` report size 0, and files can grow or shrink while being read.
 */
export function readTextForRef(
  abs: string,
  maxBytes = MAX_FILE_REF_BYTES,
  noFollow = false,
): { content?: string; truncated?: boolean; binary?: boolean } {
  // noFollow: a symbolic link at `abs` is not followed (ELOOP) and anything but a regular file is
  // refused (EFTYPE) on the open descriptor; on Windows (no O_NOFOLLOW) an lstat check stands in
  let fd: number;
  if (noFollow) {
    if (process.platform === 'win32' && fs.lstatSync(abs).isSymbolicLink()) throw Object.assign(new Error(`${abs} is a symbolic link`), { code: 'ELOOP' });
    fd = fs.openSync(abs, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  } else {
    fd = fs.openSync(abs, 'r');
  }
  let buf: Buffer;
  try {
    if (noFollow && !fs.fstatSync(fd).isFile()) throw Object.assign(new Error(`${abs} is not a regular file`), { code: 'EFTYPE' });
    const want = Math.max(0, Math.floor(maxBytes)) + 1;
    buf = Buffer.alloc(want);
    let off = 0;
    while (off < want) {
      const n = fs.readSync(fd, buf, off, want - off, null);
      if (n <= 0) break;
      off += n;
    }
    buf = buf.subarray(0, off);
  } finally {
    fs.closeSync(fd);
  }
  const truncated = buf.length > maxBytes;
  const keep = truncated ? utf8SafePrefixLength(buf, maxBytes) : buf.length;
  const slice = buf.subarray(0, keep);
  if (slice.subarray(0, 8192).includes(0)) return { binary: true };
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(slice);
  } catch {
    return { binary: true };
  }
  return { content, truncated };
}

/** `<file path="…">` block with a fenced body (language from the extension). */
export function formatFileBlock(abs: string, content: string, truncated = false): string {
  const fence = fenceFor(content);
  const lang = LANG_BY_EXT[extOf(abs)] ?? '';
  const body = content.endsWith('\n') ? content : `${content}\n`;
  const note = truncated ? `[truncated: file exceeds ${MAX_FILE_REF_BYTES / 1024}KB limit]\n` : '';
  return `<file path="${xmlAttr(abs)}">\n${fence}${lang}\n${body}${fence}\n${note}</file>`;
}

/**
 * Directory tree (01 §4.4): `label/` then `├── `/`└── ` lines, depth ≤ `maxDepth`, at most
 * `maxItems` entries per level (then `... (N more items)`), names in byte order, ignored
 * directory names skipped entirely, symlinks not followed.
 */
export function renderDirTree(
  abs: string,
  label: string,
  opts: { maxDepth?: number; maxItems?: number; ignore?: readonly string[] } = {},
): string {
  const maxDepth = opts.maxDepth ?? DIR_TREE_MAX_DEPTH;
  const maxItems = opts.maxItems ?? DIR_TREE_MAX_ITEMS;
  const ignore = new Set(opts.ignore ?? DIR_TREE_IGNORE);
  const lines: string[] = [label.endsWith('/') ? label : `${label}/`];
  const walk = (dir: string, prefix: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries = entries.filter((e) => !ignore.has(e.name)).sort((a, b) => compareBytes(a.name, b.name));
    const shown = entries.slice(0, maxItems);
    const more = entries.length - shown.length;
    shown.forEach((e, idx) => {
      const last = idx === shown.length - 1 && more === 0;
      const isDir = e.isDirectory();
      lines.push(`${prefix}${last ? '└── ' : '├── '}${e.name}${isDir ? '/' : ''}`);
      if (isDir && depth < maxDepth) walk(path.join(dir, e.name), `${prefix}${last ? '    ' : '│   '}`, depth + 1);
    });
    if (more > 0) lines.push(`${prefix}└── ... (${more} more items)`);
  };
  walk(abs, '', 1);
  return lines.join('\n');
}

/** `<directory path="…">` block around {@link renderDirTree}. */
export function formatDirBlock(abs: string, label: string): string {
  return `<directory path="${xmlAttr(abs)}">\n${renderDirTree(abs, label)}\n</directory>`;
}

interface RefOutcome {
  block?: string;
  image?: AtRefImage;
  warning?: string;
}

function expandOne(abs: string, typed: string, st: fs.Stats, allowImages: boolean, imageCount: number): RefOutcome {
  if (st.isDirectory()) return { block: formatDirBlock(abs, typed.replace(/[\\/]+$/, '') || typed) };
  const media = imageMediaType(abs);
  if (media && allowImages) {
    if (base64Length(st.size) > MAX_IMAGE_BYTES) {
      return { warning: `⚠ Image '${typed}' was not attached (exceeds the ${MAX_IMAGE_BYTES / 1024 / 1024}MB image limit once encoded)` };
    }
    if (imageCount >= MAX_IMAGES_PER_MESSAGE) {
      return { warning: `⚠ Image '${typed}' was not attached (at most ${MAX_IMAGES_PER_MESSAGE} images per message)` };
    }
    try {
      const data = fs.readFileSync(abs);
      if (base64Length(data.length) > MAX_IMAGE_BYTES) {
        // grew after stat
        return { warning: `⚠ Image '${typed}' was not attached (exceeds the ${MAX_IMAGE_BYTES / 1024 / 1024}MB image limit once encoded)` };
      }
      return { image: { mediaType: media, dataBase64: data.toString('base64'), path: abs } };
    } catch (e) {
      return { warning: `⚠ Could not read '${typed}': ${errorText(e)}` };
    }
  }
  let r: ReturnType<typeof readTextForRef>;
  try {
    r = readTextForRef(abs);
  } catch (e) {
    return { warning: `⚠ Could not read '${typed}': ${errorText(e)}` };
  }
  if (r.binary || r.content === undefined) return { warning: `⚠ File '${typed}' is a binary file and was not included` };
  return {
    block: formatFileBlock(abs, r.content, r.truncated),
    ...(r.truncated ? { warning: `⚠ File '${typed}' was truncated (exceeds 250KB limit)` } : {}),
  };
}

/** Undo drag-and-drop quoting: `'p'`, `"p"`, or backslash-escaped spaces. */
function unquoteDropped(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) return t.slice(1, -1);
  return t.replace(/\\(.)/g, '$1');
}

const PROMPT_INVOCATION_RE = /^@([A-Za-z0-9_-]{1,50})(?=\s|$)/;

/** Expand `@` references (see module doc). */
export function expandAtRefs(text: string, opts: { cwd: string; prompts?: PromptFile[] }): AtRefsResult {
  const result: AtRefsResult = { text, blocks: [], images: [], warnings: [] };
  const trimmed = text.trimStart();

  // 1. prompt invocation
  const pm = PROMPT_INVOCATION_RE.exec(trimmed);
  if (pm && opts.prompts?.length) {
    const want = pm[1]!.toLowerCase();
    const prompt = opts.prompts.find((p) => p.name.toLowerCase() === want);
    if (prompt) {
      const rest = trimmed.slice(pm[0].length).trim();
      const args = rest === '' ? [] : shlexSplit(rest) ?? rest.split(/\s+/);
      result.promptExpansion = { name: prompt.name, args };
      return result;
    }
  }

  // 2. @path tokens
  const code = codeRanges(text);
  const seen = new Set<string>();
  const re = /(^|\s)@(?:"([^"\n]+)"|'([^'\n]+)'|([^\s"']\S*))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const at = m.index + m[1]!.length;
    if (inRanges(code, at)) continue;
    const quoted = m[2] ?? m[3];
    const token = quoted ?? m[4]!;
    const res = resolveToken(token, opts.cwd, quoted !== undefined);
    if (!res) continue;
    if (seen.has(res.abs)) continue;
    seen.add(res.abs);
    const out = expandOne(res.abs, res.typed, res.st, true, result.images.length);
    if (out.block) result.blocks.push(out.block);
    if (out.image) result.images.push(out.image);
    if (out.warning) result.warnings.push(out.warning);
  }

  // 3. drag-and-drop: the whole message is one image path (tried verbatim first, so names
  //    containing a literal backslash and Windows paths are not mangled by unescaping)
  if (seen.size === 0 && trimmed !== '' && !trimmed.includes('\n')) {
    const tryDropped = (p: string): boolean => {
      if (!imageMediaType(p)) return false;
      const abs = path.resolve(opts.cwd, p);
      const st = statSafe(abs);
      if (!st?.isFile()) return false;
      const out = expandOne(abs, p, st, true, 0);
      if (out.image) result.images.push(out.image);
      if (out.warning) result.warnings.push(out.warning);
      return true;
    };
    const raw = trimmed.trimEnd();
    if (!tryDropped(raw)) {
      const unq = unquoteDropped(raw);
      if (unq !== raw) tryDropped(unq);
    }
  }
  return result;
}

// ───────────────────────────── # providers ─────────────────────────────

export interface HashRefsOptions {
  ws: WorkspaceContext;
  steering: SteeringFile[];
  /** Default `<workspaceRoot>/.kiro/specs`. */
  specsDir?: string;
  /** Runs `git <args>` in the workspace and resolves stdout (rejects on failure). */
  runGit?: (args: string[]) => Promise<string>;
  /** `#[[file:…]]` expander for spec documents (identity when absent). */
  expandRefs?: (body: string, baseDir: string) => string;
}

export interface HashRefsResult {
  blocks: string[];
  /** Canonical names of conditional steering files referenced (`#name`, `#steering:name`). */
  steeringNames: string[];
  /** One-line user-facing notices (unsupported providers, missing specs, git errors). */
  notices: string[];
}

/** Hint texts (03 §4). */
export const CODEBASE_HINT = 'Search the codebase (Grep/Glob) to find the relevant files before answering.';
export const mcpHint = (server: string): string => `Use tools from MCP server ${server}.`;
export const urlHint = (url: string): string =>
  `Fetch ${url} with the web_fetch tool (WebFetch) and use its content when answering.`;

const SPEC_DOCS = ['requirements.md', 'bugfix.md', 'design.md', 'tasks.md'];
const UNSUPPORTED = new Set(['terminal', 'problems', 'current']);
const NEEDS_ARG = new Set(['spec', 'steering', 'url', 'code', 'mcp', 'file', 'folder', 'docs']);

function defaultRunGit(cwd: string): (args: string[]) => Promise<string> {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile('git', args, { cwd, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        if (err) reject(new Error(String(stderr || err.message).trim()));
        else resolve(String(stdout));
      });
    });
}

/** Find a steering file by `#name` / `#steering:<f>` reference (name, `name.md`, or path). */
export function findSteering(files: readonly SteeringFile[], ref: string, cwd?: string): SteeringFile | undefined {
  const r = ref.trim();
  const lower = r.toLowerCase();
  const stem = lower.endsWith('.md') ? lower.slice(0, -3) : lower;
  const byName = files.find((f) => f.name.toLowerCase() === stem);
  if (byName) return byName;
  const byBase = files.find((f) => path.basename(f.path).toLowerCase() === lower || path.basename(f.path, '.md').toLowerCase() === stem);
  if (byBase) return byBase;
  if (cwd && (r.includes('/') || r.includes(path.sep))) {
    const abs = path.resolve(cwd, r);
    return files.find((f) => path.resolve(f.path) === abs);
  }
  return undefined;
}

function resolveSpecDir(specsDir: string, name: string): string | undefined {
  if (name === '' || name.includes('..') || /[\\/]/.test(name)) return undefined; // stay inside specsDir
  const direct = path.join(specsDir, name);
  if (statSafe(direct)?.isDirectory()) return direct;
  try {
    const hit = fs.readdirSync(specsDir, { withFileTypes: true }).find((e) => e.isDirectory() && e.name.toLowerCase() === name.toLowerCase());
    return hit ? path.join(specsDir, hit.name) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `<spec name=… path=…>` block with each existing spec document as `[abs]\ncontent`. A document
 * kiro-claude itself must not read (spec/docfs: a symbolic link at it, not a regular file, or a
 * real path outside the workspace) is left out and its reason pushed to `refused`; it is opened
 * with O_NOFOLLOW, so a link that appears after the check is not followed either.
 */
export function formatSpecBlock(
  name: string,
  dir: string,
  expand: (body: string, baseDir: string) => string,
  baseDir: string,
  refused: string[] = [],
): string | undefined {
  const parts: string[] = [];
  for (const doc of SPEC_DOCS) {
    const p = path.join(dir, doc);
    const st = lstatSafe(p);
    if (!st) continue;
    const why = specFileRefused(p);
    if (why) {
      refused.push(why);
      continue;
    }
    if (!st.isFile()) continue;
    let r: ReturnType<typeof readTextForRef>;
    try {
      r = readTextForRef(p, MAX_FILE_REF_BYTES, true);
    } catch (e) {
      const code = typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : '';
      if (code === 'ELOOP') refused.push(`${p} is a symbolic link`);
      else if (code === 'EFTYPE') refused.push(`${p} is not a regular file`);
      continue;
    }
    if (r.content === undefined) continue;
    let body = r.content.replace(/\r\n?/g, '\n');
    try {
      body = expand(body, baseDir);
    } catch {
      // keep unexpanded
    }
    parts.push(`[${p}]\n${body.replace(/\n+$/, '')}${r.truncated ? '\n[truncated]' : ''}`);
  }
  if (parts.length === 0) return undefined;
  return `<spec name="${xmlAttr(path.basename(dir) || name)}" path="${xmlAttr(dir)}">\n${parts.join('\n\n')}\n</spec>`;
}

async function gitDiffBlock(runGit: (args: string[]) => Promise<string>): Promise<{ block?: string; notice?: string }> {
  let status: string;
  try {
    status = await runGit(['status', '--short']);
  } catch (e) {
    const msg = errorMessage(e).trim().split('\n')[0] || 'git failed';
    return { notice: `#git diff: ${msg}` };
  }
  let diff: string;
  let diffCmd = 'git diff HEAD';
  try {
    diff = await runGit(['diff', 'HEAD']);
  } catch {
    // repository without commits: fall back to the index/worktree diff
    try {
      diff = await runGit(['diff']);
      diffCmd = 'git diff';
    } catch (e) {
      const msg = errorMessage(e).trim().split('\n')[0] || 'git diff failed';
      return { notice: `#git diff: ${msg}` };
    }
  }
  const st = status.replace(/\s+$/, '');
  const df = diff.replace(/\s+$/, '');
  if (st === '' && df === '') return { block: '<git_diff>\n(no changes)\n</git_diff>' };
  let body = `$ git status --short\n${st || '(clean)'}\n\n$ ${diffCmd}\n${df || '(no diff)'}`;
  const cut = truncateBytes(body, MAX_FILE_REF_BYTES);
  if (cut.length < body.length) body = `${cut}\n[truncated: diff exceeds 250KB limit]`;
  return { block: `<git_diff>\n${body}\n</git_diff>` };
}

/** Expand `#` providers (see module doc). Never throws. */
export async function expandHashRefs(text: string, opts: HashRefsOptions): Promise<HashRefsResult> {
  const out: HashRefsResult = { blocks: [], steeringNames: [], notices: [] };
  const { ws } = opts;
  const cwd = ws.cwd;
  const specsDir = opts.specsDir ?? path.join(ws.workspaceRoot, '.kiro', 'specs');
  const expand = opts.expandRefs ?? ((b: string) => b);
  const runGit = opts.runGit ?? defaultRunGit(cwd);
  const nameable = opts.steering.filter((f) => f.inclusion === 'manual' || f.inclusion === 'auto');
  const code = codeRanges(text);
  const done = new Set<string>();
  const once = (key: string): boolean => {
    if (done.has(key)) return false;
    done.add(key);
    return true;
  };
  const addSteering = (f: SteeringFile): void => {
    if (!out.steeringNames.includes(f.name)) out.steeringNames.push(f.name);
  };
  const addSpec = (name: string, fromBare: boolean): boolean => {
    const dir = resolveSpecDir(specsDir, name);
    if (!dir) {
      if (!fromBare) out.notices.push(`Spec '${name}' not found in ${specsDir}`);
      return false;
    }
    if (!once(`spec:${dir}`)) return true;
    // the rules of kiro-claude's own spec I/O (spec/docfs, r5x X1): a spec folder linked out of
    // the workspace or to nothing, and a linked or outside document, are not read
    const folderWhy = (opts.specsDir === undefined ? specsRootRefused(ws.workspaceRoot) : undefined) ?? specFolderRefused(dir);
    if (folderWhy) {
      out.notices.push(`Spec '${name}' was not read: ${specRefusalText(folderWhy)}`);
      return true;
    }
    const refused: string[] = [];
    const block = formatSpecBlock(name, dir, expand, ws.workspaceRoot, refused);
    for (const why of refused) out.notices.push(`Spec '${name}': a document was left out: ${specRefusalText(why)}`);
    if (block) out.blocks.push(block);
    else if (refused.length === 0) out.notices.push(`Spec '${name}' has no requirements, design or tasks documents`);
    return true;
  };
  const addPath = (token: string, quoted: boolean, kind: 'any' | 'file' | 'dir', fromBare: boolean): boolean => {
    const res = resolveToken(token, cwd, quoted);
    if (!res || (kind === 'file' && !res.st.isFile()) || (kind === 'dir' && !res.st.isDirectory())) {
      if (!fromBare) out.notices.push(`#${kind === 'dir' ? 'folder' : 'file'}: '${token}' not found`);
      return false;
    }
    if (!once(`path:${res.abs}`)) return true;
    if (res.st.isFile() && imageMediaType(res.abs)) {
      out.notices.push(`#${res.typed} is an image; use @${res.typed} to attach it`);
      return true;
    }
    const r = expandOne(res.abs, res.typed, res.st, false, 0);
    if (r.block) out.blocks.push(r.block);
    if (r.warning) out.notices.push(r.warning);
    return true;
  };

  const re = /#/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const i = m.index;
    if (i > 0 && !/\s/.test(text[i - 1]!)) continue;
    if (inRanges(code, i)) continue;
    const lineStart = i === 0 || text[i - 1] === '\n';
    const rest = text.slice(i);
    if (lineStart && /^#{1,6}(?:\s|$)/.test(rest)) {
      re.lastIndex = i + (/^#+/.exec(rest)![0].length);
      continue;
    }
    if (rest.length < 2 || /\s/.test(rest[1]!)) continue;

    let k: RegExpExecArray | null;
    if ((k = /^#git[ \t]+diff\b/i.exec(rest)) || (k = /^#git-?diff\b/i.exec(rest))) {
      re.lastIndex = i + k[0].length;
      if (once('git-diff')) {
        const r = await gitDiffBlock(runGit);
        if (r.block) out.blocks.push(r.block);
        if (r.notice) out.notices.push(r.notice);
      }
      continue;
    }
    if ((k = /^#code:([^\n]*)/i.exec(rest))) {
      re.lastIndex = i + k[0].length;
      const snippet = k[1]!.trim();
      if (snippet === '') out.notices.push('#code needs a snippet, e.g. #code:<snippet>');
      else if (once(`code:${snippet}`)) {
        const fence = fenceFor(snippet);
        out.blocks.push(`${fence}\n${snippet}\n${fence}`);
      }
      continue;
    }
    if ((k = /^#(spec|steering|url|mcp|file|folder|docs):(?:"([^"\n]+)"|'([^'\n]+)'|(\S+))/i.exec(rest))) {
      re.lastIndex = i + k[0].length;
      const kind = k[1]!.toLowerCase();
      const quoted = k[2] ?? k[3];
      let arg = quoted ?? k[4]!;
      if (quoted === undefined && kind !== 'url' && kind !== 'file' && kind !== 'folder' && kind !== 'docs') {
        arg = arg.replace(/[.,;:!?)\]}'"]+$/, '');
      }
      switch (kind) {
        case 'spec':
          addSpec(arg, false);
          break;
        case 'steering': {
          const f = findSteering(opts.steering, arg, cwd);
          if (!f) out.notices.push(`Steering file '${arg}' not found`);
          else if (f.inclusion !== 'always') addSteering(f);
          break;
        }
        case 'url': {
          const url = quoted === undefined ? arg.replace(/[.,;:!?)\]}'"]+$/, '') : arg;
          if (once(`url:${url}`)) out.blocks.push(urlHint(url));
          break;
        }
        case 'mcp':
          if (once(`mcp:${arg}`)) out.blocks.push(mcpHint(arg));
          break;
        case 'folder':
          addPath(arg, quoted !== undefined, 'dir', false);
          break;
        default: // file, docs
          addPath(arg, quoted !== undefined, 'file', false);
      }
      continue;
    }
    if ((k = /^#([A-Za-z]+)(?=$|[\s.,;:!?)\]}])/.exec(rest))) {
      const word = k[1]!.toLowerCase();
      if (word === 'codebase') {
        re.lastIndex = i + k[0].length;
        if (once('codebase')) out.blocks.push(CODEBASE_HINT);
        continue;
      }
      if (word === 'repository') {
        re.lastIndex = i + k[0].length;
        if (once('repository')) out.blocks.push(`<repository path="${xmlAttr(ws.workspaceRoot)}">\n${renderDirTree(ws.workspaceRoot, path.basename(ws.workspaceRoot) || ws.workspaceRoot)}\n</repository>`);
        continue;
      }
      if (UNSUPPORTED.has(word)) {
        re.lastIndex = i + k[0].length;
        if (once(`unsupported:${word}`)) out.notices.push(`#${word} is not supported in kiro-claude and was ignored`);
        continue;
      }
      // a bare provider keyword that needs an argument — unless it names a steering file/path
      if (NEEDS_ARG.has(word) && !findSteering(nameable, word) && !resolveToken(word, cwd, false)) {
        re.lastIndex = i + k[0].length;
        if (once(`needs:${word}`)) out.notices.push(`#${word} needs an argument, e.g. #${word}:<${word === 'url' ? 'url' : word === 'code' ? 'snippet' : word === 'mcp' ? 'server' : 'name'}>`);
        continue;
      }
    }

    // bare #<path-or-name>: steering → spec → file → directory → text
    const t = /^#(?:"([^"\n]+)"|'([^'\n]+)'|(\S+))/.exec(rest);
    if (!t) continue;
    const quoted = t[1] ?? t[2];
    const token = quoted ?? t[3]!;
    const name = quoted === undefined ? token.replace(/[.,;:!?)\]}'"]+$/, '') : token;
    const st = findSteering(nameable, name);
    if (st) {
      re.lastIndex = i + t[0].length;
      addSteering(st);
      continue;
    }
    if (/^[A-Za-z0-9._-]+$/.test(name) && !name.includes('.') && addSpec(name, true)) {
      re.lastIndex = i + t[0].length;
      continue;
    }
    if (addPath(token, quoted !== undefined, 'any', true)) {
      re.lastIndex = i + t[0].length;
      continue;
    }
    // leave as text
  }
  return out;
}

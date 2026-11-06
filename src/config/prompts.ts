/**
 * File prompts (02 §6.1, 06 §8, 00 §2.2 "Prompts").
 *
 * Locations: workspace `<workspaceRoot>/.kiro/prompts/*.md` beats global
 * `<kiroHome>/prompts/*.md` for the same name (non-recursive, only `.md`). Legacy Q dirs
 * (`<ws>/.amazonq/prompts/`, `~/.aws/amazonq/prompts/`) are read only when the matching Kiro
 * location does not exist (the `.amazonq` fallback rule of 02 §1.2), with the same scopes.
 *
 * Front matter (V3, UNVERIFIED): a leading `---` block is stripped and its `description`
 * used (02 §6.1 "strip a leading `---` block defensively").
 *
 * Invocation ({@link findPrompt}): name matched case-insensitively (an exact-case match
 * wins). Expansion ({@link expandPrompt}, 00 §8 C4): `${1}`…`${10}` positional arguments,
 * `$ARGUMENTS` and `${@}` = all arguments joined by one space; a missing positional is
 * empty. A body without any placeholder is returned unchanged (Q ignores arguments for
 * file prompts).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PromptFile, WorkspaceContext } from '../types.js';
import { parseFrontMatter } from '../util/frontmatter.js';
import { isDirectory } from '../util/fsx.js';
import { normalizeNewlines, stripBom } from '../util/text.js';
import { legacyGlobalDir, workspaceAmazonqDir, workspaceKiroDir } from './workspace.js';

/** Valid prompt names for `/prompts create` (Q: 1–50 chars of `[A-Za-z0-9_-]`). */
export const PROMPT_NAME_RE = /^[A-Za-z0-9_-]{1,50}$/;

function readPromptDir(dir: string, scope: PromptFile['scope']): PromptFile[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: PromptFile[] = [];
  for (const n of names.sort()) {
    if (!n.toLowerCase().endsWith('.md') || n.startsWith('._')) continue;
    const p = path.join(dir, n);
    let text: string;
    try {
      if (!fs.statSync(p).isFile()) continue;
      text = fs.readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    const fm = parseFrontMatter(stripBom(text));
    const pf: PromptFile = { name: n.slice(0, -3), path: p, scope, body: normalizeNewlines(fm.body) };
    const d = fm.data.description;
    if (typeof d === 'string' && d.trim() !== '') pf.description = d.trim();
    out.push(pf);
  }
  return out;
}

/** Prompt directories in precedence order (see module doc). */
export function promptDirs(ws: WorkspaceContext): { dir: string; scope: PromptFile['scope'] }[] {
  const out: { dir: string; scope: PromptFile['scope'] }[] = [];
  const wk = workspaceKiroDir(ws);
  if (wk) {
    const d = path.join(wk, 'prompts');
    const aq = workspaceAmazonqDir(ws);
    if (isDirectory(d) || !aq) out.push({ dir: d, scope: 'workspace' });
    else out.push({ dir: path.join(aq, 'prompts'), scope: 'workspace' });
  }
  const g = path.join(ws.kiroHome, 'prompts');
  if (isDirectory(g)) out.push({ dir: g, scope: 'global' });
  else out.push({ dir: path.join(legacyGlobalDir(ws), 'prompts'), scope: 'global' });
  return out;
}

/** All file prompts, workspace over global, sorted by name. */
export function loadPrompts(ws: WorkspaceContext): PromptFile[] {
  const byName = new Map<string, PromptFile>();
  for (const { dir, scope } of promptDirs(ws)) {
    for (const p of readPromptDir(dir, scope)) if (!byName.has(p.name)) byName.set(p.name, p);
  }
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Find a prompt by name, case-insensitively (exact case first). */
export function findPrompt(prompts: readonly PromptFile[], name: string): PromptFile | undefined {
  const exact = prompts.find((p) => p.name === name);
  if (exact) return exact;
  const lower = name.toLowerCase();
  return prompts.find((p) => p.name.toLowerCase() === lower);
}

const PLACEHOLDER_RE = /\$\{(10|[1-9])\}|\$ARGUMENTS\b|\$\{@\}/g;

/** True when `body` contains any argument placeholder. */
export function hasPromptPlaceholders(body: string): boolean {
  PLACEHOLDER_RE.lastIndex = 0;
  return PLACEHOLDER_RE.test(body);
}

/** Substitute placeholders in `body` (shared by prompts and skills). */
export function substituteArgs(body: string, args: readonly string[], all?: string): string {
  const joined = all ?? args.join(' ');
  return body.replace(PLACEHOLDER_RE, (m, n: string | undefined) => {
    if (n !== undefined) return args[Number(n) - 1] ?? '';
    return joined;
  });
}

/** Expand a prompt with (already shlex-split) arguments (see module doc). */
export function expandPrompt(p: PromptFile, args: string[]): string {
  if (!hasPromptPlaceholders(p.body)) return p.body;
  return substituteArgs(p.body, args);
}

/**
 * The per-spawn system-prompt file passed to Claude with `--append-system-prompt-file`
 * (00 §6.1, binding). Layout, in this order (each part only when present):
 *
 * ```
 * --- CONTEXT ENTRY BEGIN ---
 * [<abs path>]
 * <content>
 * ...                                   always-steering (global, legacy, workspace), AGENTS.md,
 * --- CONTEXT ENTRY END ---               agent file:// resources, /context session entries
 *
 * <conditional steering index entry>   one per fileMatch / manual / auto steering file (03 §3)
 *
 * --- CONTEXT ENTRY BEGIN ---          agentSpawn hook outputs (Q formatHookContext, 06 §3.7)
 * This section (like others) … for the entire conversation
 *
 * <output>
 *
 * --- CONTEXT ENTRY END ---
 *
 * <adapter preamble ≤ 5 lines>
 * Follow this instruction: <agent prompt>   last = highest salience (Q context message, 06 §4.4)
 * ```
 *
 * Context files (06 §4.2–4.4):
 *  - Each entry is Q's exact `[<path>]\n<content>\n`; the path label is the absolute path.
 *  - Steering bodies (front matter already stripped by config) and AGENTS.md files (front matter
 *    stripped here) get `#[[file:…]]` references expanded through the caller's `expandRefs`
 *    (base dir: `<kiroHome>/steering` for global steering, the containing folder for
 *    AGENTS.md, the workspace root otherwise — 02 §4). Resource / session files are verbatim.
 *  - A file seen twice (by realpath) is included once; the first origin in the order above wins.
 *  - Size cap: 75 % of `contextWindowTokens` with Q's drop algorithm (tokens/tokens.ts). The
 *    *selection* is Q's (largest-first greedy fit); the *output order* is the 00 §6.1 order so
 *    workspace steering still comes after global steering. Files that cannot fit even alone are
 *    dropped from their size without being read.
 *  - Deviation (recommended by 06 §4.2): a file that is not valid UTF-8 or cannot be read is
 *    skipped with a warning instead of aborting the whole collection.
 *
 * Conditional steering (03 §3): `fileMatch`, `manual` and `auto` files are NOT inlined; each
 * gets an index entry telling the model when to Read it, and the files are returned in
 * `conditionalSteering` for {@link SteeringActivator} (context/userTurn.ts).
 *
 * Which steering files / AGENTS.md to pass (default-resource inheritance, 00 §2.2 C5) is the
 * caller's decision; this module renders what it is given. Pure apart from reading the
 * listed files.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { KiroAgent, SteeringFile, WorkspaceContext } from '../types.js';
import { parseFrontMatter } from '../util/frontmatter.js';
import { mkdirp, writeFileAtomic } from '../util/fsx.js';
import { realpathSafe, runtimeDir } from '../util/paths.js';
import { normalizeNewlines, stripBom } from '../util/text.js';
import { errorMessage, errorText } from './refs.js';
import { contextFilesLimit, estimateTokens, estimateTokensFromBytes, selectWithinLimit } from './tokens.js';

export const CONTEXT_ENTRY_BEGIN = '--- CONTEXT ENTRY BEGIN ---';
export const CONTEXT_ENTRY_END = '--- CONTEXT ENTRY END ---';

/** Q `formatHookContext` intro sentence (06 §3.7); agentSpawn appends {@link HOOK_CONTEXT_SPAWN_SUFFIX}. */
export const HOOK_CONTEXT_INTRO =
  'This section (like others) contains important information that I want you to use in your responses. ' +
  'I have gathered this context from valuable programmatic script hooks. ' +
  'You must follow any requests and consider all of the information in this section';
export const HOOK_CONTEXT_SPAWN_SUFFIX = ' for the entire conversation';

/** Q puts the agent prompt last with this prefix (06 §4.4). */
export const AGENT_PROMPT_PREFIX = 'Follow this instruction: ';

/**
 * Adapter preamble (00 §6.1: ≤ 5 lines). Tells the model where it runs and which Kiro tool
 * names to use when talking to the user (00 §4.1 column "Kiro 2.x name").
 */
export const DEFAULT_PREAMBLE = [
  'You are running inside Kiro CLI (kiro-claude); Claude Code is the agent runtime.',
  'In user-facing text, call tools by their Kiro names: read (Read), glob (Glob), grep (Grep), write (Write, Edit, NotebookEdit), ' +
    'shell (Bash), web_fetch, web_search, subagent (Agent), todo_list (the Task tools), and MCP tools as @server/tool.',
  'The context entries above (steering, AGENTS.md, resources) are this project\'s instructions: follow them; ' +
    'workspace steering takes precedence over global steering.',
  'Kiro checks every tool call against the agent\'s permissions; when a call is denied, do not repeat it unchanged — ' +
    'explain or ask the user instead.',
].join('\n');

export type ContextOrigin = 'steering' | 'agents-md' | 'resource' | 'session';

export interface SystemPromptInput {
  ws: WorkspaceContext;
  agent: KiroAgent;
  /** All loaded steering files (any inclusion); `always` ones are inlined, others indexed. */
  steering: SteeringFile[];
  /** Agent `file://` resources, already resolved to absolute paths (config/resources). */
  resourceFiles: { pattern: string; paths: string[] }[];
  /** `/context add` rules resolved to paths. */
  sessionContext: { pattern: string; paths: string[] }[];
  /** AGENTS.md file paths in context order (config/steering.findAgentsMd). */
  agentsMd: string[];
  /** Successful agentSpawn / SessionStart hook outputs in definition order. */
  agentSpawnOutputs: string[];
  /** Model context window used for the 75 % cap (00 §6.1; 200 000 when unknown). */
  contextWindowTokens: number;
  /** `#[[file:…]]` expander, e.g. `(b, d) => expandFileRefs(b, d, ws)`; identity when absent. */
  expandRefs?: (body: string, baseDir: string) => string;
  /** Override the adapter preamble; `''` omits it. Default {@link DEFAULT_PREAMBLE}. */
  preamble?: string;
}

export interface IncludedContextFile {
  path: string;
  tokens: number;
  origin: ContextOrigin;
}

export interface SystemPromptResult {
  /** Full file text ('' when there is nothing to append). */
  text: string;
  /** Context files actually inlined, in output order. */
  included: IncludedContextFile[];
  /** Paths dropped by the 75 % cap (Q evaluation order: largest first). */
  dropped: string[];
  /** fileMatch / manual / auto steering files (indexed, not inlined). */
  conditionalSteering: SteeringFile[];
  /** {@link estimateTokens} of the whole `text`. */
  totalTokens: number;
  /** Files skipped because they could not be read or are not UTF-8 text. */
  warnings: string[];
}

const SCOPE_RANK: Record<SteeringFile['scope'], number> = { global: 0, legacy: 1, workspace: 2 };

/** Steering files ordered global → legacy → workspace (stable within a scope). */
export function orderSteering(files: readonly SteeringFile[]): SteeringFile[] {
  return files
    .map((f, i) => ({ f, i }))
    .sort((a, b) => (SCOPE_RANK[a.f.scope] ?? 1) - (SCOPE_RANK[b.f.scope] ?? 1) || a.i - b.i)
    .map((x) => x.f);
}

/** Base directory for `#[[file:…]]` references in a steering / AGENTS.md file (02 §4). */
export function steeringBaseDir(ws: WorkspaceContext, file: Pick<SteeringFile, 'scope' | 'path'>): string {
  if (path.basename(file.path) === 'AGENTS.md') return path.dirname(file.path);
  if (file.scope === 'global') return path.join(ws.kiroHome, 'steering');
  return ws.workspaceRoot;
}

/** Q's context-files block (06 §4.4): `BEGIN\n` + `[path]\ncontent\n`… + `END\n\n`; '' when empty. */
export function formatContextEntries(entries: readonly { path: string; content: string }[]): string {
  if (entries.length === 0) return '';
  let s = `${CONTEXT_ENTRY_BEGIN}\n`;
  for (const e of entries) s += `[${e.path}]\n${e.content}\n`;
  return `${s}${CONTEXT_ENTRY_END}\n\n`;
}

/**
 * Q `formatHookContext` (06 §3.7): `undefined` when every output is empty; otherwise the
 * wrapper with each output followed by a blank line (empty outputs included as `\n\n`).
 * `entireConversation` adds ` for the entire conversation` (agentSpawn only).
 */
export function formatHookContext(outputs: readonly string[], entireConversation: boolean): string | undefined {
  if (outputs.every((o) => o.length === 0)) return undefined;
  let s = `${CONTEXT_ENTRY_BEGIN}\n${HOOK_CONTEXT_INTRO}${entireConversation ? HOOK_CONTEXT_SPAWN_SUFFIX : ''}\n\n`;
  for (const o of outputs) s += `${o}\n\n`;
  return `${s}${CONTEXT_ENTRY_END}\n\n`;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** `fileMatchPattern` value: a single pattern verbatim, several as a JSON array. */
function patternText(patterns: readonly string[]): string {
  if (patterns.length === 0) return '';
  if (patterns.length === 1) return patterns[0]!;
  return JSON.stringify(patterns);
}

/** Condition sentence per inclusion mode (03 §3, verbatim). */
export function steeringCondition(file: Pick<SteeringFile, 'inclusion' | 'name'>): string {
  switch (file.inclusion) {
    case 'manual':
      return `Only when the user explicitly requests #${file.name} or this guide.`;
    case 'fileMatch':
      return 'Only before working on a file matching fileMatchPattern; an empty pattern never matches.';
    case 'auto':
      return 'Only when the description is relevant to the current task; an empty description requires an explicit request.';
    default:
      return 'Always.';
  }
}

/**
 * One conditional-guide index entry (03 §3 format, from KiroCrew's non-native backend
 * driver). `Description:` is always present (empty when the file has none, which the auto
 * condition refers to); `fileMatchPattern:` only for fileMatch files.
 */
export function formatSteeringIndexEntry(file: SteeringFile): string {
  const lines = [
    `CONDITIONAL GUIDE, NOT ACTIVE INSTRUCTIONS. ${steeringCondition(file)}`,
    `Read ${file.path} with the file tool when that condition holds, then apply its full current contents.`,
  ];
  const desc = file.description ? oneLine(file.description) : '';
  lines.push(desc ? `Description: ${desc}` : 'Description:');
  if (file.inclusion === 'fileMatch') {
    const p = patternText(file.fileMatchPatterns);
    lines.push(p ? `fileMatchPattern: ${p}` : 'fileMatchPattern:');
  }
  return lines.join('\n');
}

/** Decode a buffer as strict UTF-8; `undefined` when invalid. */
function decodeUtf8(buf: Buffer): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
  } catch {
    return undefined;
  }
}

interface Candidate {
  path: string;
  origin: ContextOrigin;
  tokens: number;
  /** Content when already known; read lazily otherwise. */
  content?: string;
  /** Too big to ever fit: dropped without reading. */
  oversize?: boolean;
}

/** Build the system-prompt file text (see module doc). */
export function buildSystemPrompt(input: SystemPromptInput): SystemPromptResult {
  const { ws } = input;
  const expand = input.expandRefs ?? ((b: string) => b);
  const limit = contextFilesLimit(input.contextWindowTokens);
  const warnings: string[] = [];
  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  const firstSeen = (p: string): boolean => {
    const key = realpathSafe(p);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };

  const steering = orderSteering(input.steering);
  // one index entry per conditional file (by realpath; the first in steering order wins)
  const indexed = new Set<string>();
  const conditionalSteering = steering.filter((f) => {
    if (f.inclusion === 'always') return false;
    const key = realpathSafe(f.path);
    if (indexed.has(key)) return false;
    indexed.add(key);
    return true;
  });

  // 1. always-steering (global → legacy → workspace)
  for (const f of steering) {
    if (f.inclusion !== 'always') continue;
    if (!firstSeen(f.path)) continue;
    let content: string;
    try {
      content = expand(f.body, steeringBaseDir(ws, f));
    } catch (e) {
      warnings.push(`Steering file ${f.path}: ${errorMessage(e)}`);
      content = f.body;
    }
    candidates.push({ path: f.path, origin: 'steering', tokens: estimateTokens(content), content });
  }

  // 2. AGENTS.md (front matter stripped, refs expanded relative to its folder)
  for (const p of input.agentsMd) {
    if (!firstSeen(p)) continue;
    let buf: Buffer;
    try {
      buf = fs.readFileSync(p);
    } catch (e) {
      warnings.push(`Skipping context file ${p}: ${errorText(e)}`);
      continue;
    }
    const raw = decodeUtf8(buf);
    if (raw === undefined) {
      warnings.push(`Skipping context file ${p}: not valid UTF-8 text`);
      continue;
    }
    let body = normalizeNewlines(stripBom(raw));
    const fm = parseFrontMatter(body);
    if (fm.hasFrontMatter) body = fm.body;
    let content: string;
    try {
      content = expand(body, path.dirname(p));
    } catch (e) {
      warnings.push(`AGENTS.md ${p}: ${errorMessage(e)}`);
      content = body;
    }
    candidates.push({ path: p, origin: 'agents-md', tokens: estimateTokens(content), content });
  }

  // 3. agent resources, 4. session context (verbatim, read lazily after size check)
  const addFiles = (groups: { pattern: string; paths: string[] }[], origin: ContextOrigin): void => {
    for (const g of groups) {
      for (const p of g.paths) {
        if (!firstSeen(p)) continue;
        let size: number;
        try {
          const st = fs.statSync(p);
          if (!st.isFile()) {
            warnings.push(`Skipping context file ${p}: not a regular file`);
            continue;
          }
          size = st.size;
        } catch (e) {
          warnings.push(`Skipping context file ${p}: ${errorText(e)}`);
          continue;
        }
        const est = estimateTokensFromBytes(size);
        if (est > limit) {
          candidates.push({ path: p, origin, tokens: est, oversize: true });
          continue;
        }
        let buf: Buffer;
        try {
          buf = fs.readFileSync(p);
        } catch (e) {
          warnings.push(`Skipping context file ${p}: ${errorText(e)}`);
          continue;
        }
        const content = decodeUtf8(buf);
        if (content === undefined) {
          warnings.push(`Skipping context file ${p}: not valid UTF-8 text`);
          continue;
        }
        candidates.push({ path: p, origin, tokens: estimateTokens(content), content });
      }
    }
  };
  addFiles(input.resourceFiles, 'resource');
  addFiles(input.sessionContext, 'session');

  // Q drop algorithm decides membership; output keeps the 00 §6.1 order.
  const { kept, dropped } = selectWithinLimit(candidates, limit);
  const keptSet = new Set(kept);
  const out = candidates.filter((c) => keptSet.has(c) && !c.oversize);
  const included: IncludedContextFile[] = out.map((c) => ({ path: c.path, tokens: c.tokens, origin: c.origin }));

  const parts: string[] = [];
  parts.push(formatContextEntries(out.map((c) => ({ path: c.path, content: c.content ?? '' }))));
  for (const f of conditionalSteering) parts.push(`${formatSteeringIndexEntry(f)}\n\n`);
  parts.push(formatHookContext(input.agentSpawnOutputs, true) ?? '');
  const preamble = (input.preamble ?? DEFAULT_PREAMBLE).replace(/\s+$/, '');
  if (preamble) parts.push(`${preamble}\n\n`);
  const prompt = input.agent.prompt;
  if (prompt !== undefined && prompt.trim() !== '') parts.push(`${AGENT_PROMPT_PREFIX}${prompt}`);

  let text = parts.join('');
  text = text.trim() === '' ? '' : `${text.replace(/\n+$/, '')}\n`;

  return {
    text,
    included,
    dropped: dropped.map((d) => d.path),
    conditionalSteering,
    totalTokens: estimateTokens(text),
    warnings,
  };
}

/**
 * Where the system-prompt file lives (00 §6.1): `<runtime dir>/<sessionId>/context.md`, the
 * runtime dir being util/paths.runtimeDir (`<XDG_RUNTIME_DIR | tmpdir>/kiro-claude-<uid>`, 0700).
 */
export function systemPromptFilePath(sessionId: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId) || sessionId.includes('..')) {
    throw new Error(`Invalid session id: ${JSON.stringify(sessionId)}`);
  }
  return path.join(runtimeDir(env), sessionId, 'context.md');
}

/** Atomically write the system-prompt file (dir 0700, file 0600); returns its path. */
export function writeSystemPromptFile(sessionId: string, text: string, env: NodeJS.ProcessEnv = process.env): string {
  const p = systemPromptFilePath(sessionId, env);
  mkdirp(path.dirname(p), 0o700);
  writeFileAtomic(p, text, { mode: 0o600 });
  return p;
}

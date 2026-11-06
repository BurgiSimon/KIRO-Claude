/**
 * Kiro ⇄ Claude model ids and the model list (00 §3.13, 00 §2.5, 01 §8, 08a §2.2/§5).
 *
 * Id conversion (00 §3.13):
 *  - Claude → Kiro: `/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[1m\])?$/` ⇒
 *    `claude-$1-$2` + `.$3` when present (`claude-haiku-4-5-20251001` ⇒ `claude-haiku-4.5`,
 *    `claude-opus-4-8[1m]` ⇒ `claude-opus-4.8`); Claude `default` ⇒ Kiro `auto`. Legacy
 *    version-first ids (`claude-3-7-sonnet-20250219` ⇒ `claude-3.7-sonnet`) are converted the
 *    same way. Anything else (aliases such as `opus`) is returned unchanged.
 *  - Kiro → Claude ({@link kiroToClaudeModel}): `auto` (or empty) ⇒ no `--model`; first match
 *    against the live list's converted ids (that entry's `value`; the live `default` entry is
 *    skipped because it is Kiro `auto`, DECISION); else `claude-<f>-<maj>.<min>` ⇒
 *    `claude-<f>-<maj>-<min>`; Claude aliases (`opus`, `sonnet`, `haiku`, `fable`, `default`,
 *    `opusplan`, optional `[1m]`) and hyphenated `claude-…` ids are accepted verbatim; Q's
 *    legacy alias `claude-4-sonnet` ⇒ `claude-sonnet-4`. Non-Claude Kiro ids (`gpt-*`,
 *    `deepseek-*`, …) and other unknown names ⇒ Q's error
 *    `Model '<id>' does not exist. Available models: <ids>` (01 §3).
 *
 * Model list ({@link buildModelList}): from Claude's `initialize.models` when available (no
 * model call, VERIFIED 04 e9): `auto` first (from the `default` entry), then one entry per
 * distinct Kiro id in live order. Without a live list, {@link STATIC_MODELS} (the 2.1.318
 * capture). Context windows: Claude 4.6+ and 5.x = 1 000 000 (observed in `modelUsage`),
 * 4.5 and older = 200 000 (01 §8.1).
 *
 * `--list-models` ({@link formatModelList}): JSON is the object `{"models":[…]}` with rows
 * `{model_name, model_id, display_name, description, context_window_tokens, rate_multiplier}`
 * (`model_id == model_name` = bare dotted Kiro id). This follows KiroCrew's parser
 * (08a §2.2: any other envelope is rejected) and supersedes the bare-array decision of
 * 00 §9 #13. Plain text is an aligned table (format UNVERIFIED; DECISION 01 §8.2).
 *
 * Model cache ({@link readModelCache} / {@link writeModelCache}): the last live list is kept in
 * `${XDG_CACHE_HOME:-~/.cache}/kiro-claude/models.json` so `--list-models` can answer without
 * spawning Claude (08 KC-CLI-06).
 */

import * as path from 'node:path';
import type { ModelInfo } from '../claude/protocol.js';
import type { ModelEntry } from '../types.js';
import { readJsonIfExists, writeJsonAtomic } from '../util/fsx.js';
import { homeDir } from '../util/paths.js';

export const AUTO_MODEL_ID = 'auto';
export const DEFAULT_MODEL_WINDOW = 200_000;
const ONE_MILLION = 1_000_000;

/** Claude Code model aliases accepted verbatim (case-insensitive), optionally with `[1m]`. */
export const CLAUDE_ALIASES: readonly string[] = ['default', 'opus', 'sonnet', 'haiku', 'fable', 'opusplan', 'best'];

const CLAUDE_ID_RE = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[1m\])?$/;
const CLAUDE_LEGACY_ID_RE = /^claude-(\d+)(?:-(\d{1,2}))?-([a-z]+)(?:-\d{8})?(?:\[1m\])?$/;
const KIRO_DOTTED_RE = /^claude-([a-z]+)-(\d+)\.(\d+)$/;
const KIRO_LEGACY_DOTTED_RE = /^claude-(\d+)\.(\d+)-([a-z]+)$/;

/** Claude model id / alias ⇒ Kiro id (see module doc). */
export function claudeToKiroModelId(id: string): string {
  const s = id.trim();
  const lower = s.toLowerCase();
  if (lower === 'default') return AUTO_MODEL_ID;
  let m = CLAUDE_ID_RE.exec(lower);
  if (m) return `claude-${m[1]}-${m[2]}${m[3] !== undefined ? `.${m[3]}` : ''}`;
  m = CLAUDE_LEGACY_ID_RE.exec(lower);
  if (m) return `claude-${m[1]}${m[2] !== undefined ? `.${m[2]}` : ''}-${m[3]}`;
  return s;
}

function isClaudeAlias(lower: string): boolean {
  const base = lower.endsWith('[1m]') ? lower.slice(0, -4) : lower;
  return CLAUDE_ALIASES.includes(base);
}

/** Kiro id of a live entry (`resolvedModel` preferred, else `value`). */
export function liveKiroId(m: ModelInfo): string {
  if (m.value === 'default') return AUTO_MODEL_ID;
  return claudeToKiroModelId(m.resolvedModel || m.value);
}

/**
 * Kiro model id ⇒ value for `--model` / `set_model` (see module doc). `{}` (value undefined)
 * means "auto": omit `--model` / `set_model null`.
 */
export function kiroToClaudeModel(kiroId: string, live?: ModelInfo[]): { value?: string; error?: string } {
  const s = kiroId.trim();
  const lower = s.toLowerCase();
  if (lower === '' || lower === AUTO_MODEL_ID) return {};
  if (live?.length) {
    // `claude-haiku-4-5` (hyphenated, no date) also finds `claude-haiku-4-5-20251001`; a `[1m]`
    // suffix is only matched verbatim so the 1M-context variant is never silently dropped.
    const asKiro = lower.endsWith('[1m]') ? lower : claudeToKiroModelId(lower).toLowerCase();
    for (const m of live) {
      if (m.value === 'default') continue;
      if (m.value.toLowerCase() === lower) return { value: m.value };
    }
    for (const m of live) {
      if (m.value === 'default') continue;
      const k = liveKiroId(m).toLowerCase();
      if (k === lower || k === asKiro) return { value: m.value };
    }
  }
  if (isClaudeAlias(lower)) return { value: lower };
  if (lower === 'claude-4-sonnet') return { value: 'claude-sonnet-4' };
  let m = KIRO_DOTTED_RE.exec(lower);
  if (m) return { value: `claude-${m[1]}-${m[2]}-${m[3]}` };
  m = KIRO_LEGACY_DOTTED_RE.exec(lower);
  if (m) return { value: `claude-${m[1]}-${m[2]}-${m[3]}` };
  if (/^claude-[a-z0-9-]+(?:\[1m\])?$/.test(lower)) return { value: lower };
  const available = buildModelList(live).map((e) => e.kiroId);
  return { error: `Model '${s}' does not exist. Available models: ${available.join(', ')}` };
}

/** Known context window for a Kiro (or Claude) model id; undefined when unknown. */
export function contextWindowFor(id: string): number | undefined {
  const k = claudeToKiroModelId(id).toLowerCase();
  let m = /^claude-([a-z]+)-(\d+)(?:\.(\d+))?$/.exec(k);
  if (m) {
    const major = Number(m[2]);
    const minor = m[3] !== undefined ? Number(m[3]) : 0;
    if (major >= 5) return ONE_MILLION;
    if (major === 4) return minor >= 6 ? ONE_MILLION : DEFAULT_MODEL_WINDOW;
    return DEFAULT_MODEL_WINDOW;
  }
  m = /^claude-(\d+)(?:\.\d+)?-[a-z]+$/.exec(k);
  if (m) return DEFAULT_MODEL_WINDOW;
  return undefined;
}

/** `opus-5.5`-style display fallback: `Opus 5.5`. */
function displayFromKiroId(kiroId: string): string {
  const m = /^claude-([a-z]+)-(\d+(?:\.\d+)?)$/.exec(kiroId);
  if (m) return `${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)} ${m[2]}`;
  return kiroId;
}

const FULL_EFFORT = ['low', 'medium', 'high', 'xhigh', 'max'];
const NO_XHIGH = ['low', 'medium', 'high', 'max'];

/**
 * Static model list used before any Claude child reported `initialize.models` (values from
 * the claude 2.1.318 capture, 00 §3.13; account-dependent, so live data always wins).
 */
export const STATIC_MODELS: ModelEntry[] = [
  {
    kiroId: 'auto',
    displayName: 'Default (recommended)',
    description: 'Claude Code default model for your account',
    contextWindowTokens: ONE_MILLION,
    supportedEffortLevels: FULL_EFFORT,
    isDefault: true,
  },
  { kiroId: 'claude-opus-5.5', claudeValue: 'claude-opus-5-5', displayName: 'Opus 5.5', description: 'For complex work and everyday tasks', contextWindowTokens: ONE_MILLION, supportedEffortLevels: FULL_EFFORT },
  { kiroId: 'claude-fable-5.1', claudeValue: 'claude-fable-5-1', displayName: 'Fable 5.1', description: 'For your toughest challenges', contextWindowTokens: ONE_MILLION, supportedEffortLevels: FULL_EFFORT },
  { kiroId: 'claude-sonnet-5.5', claudeValue: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5', description: 'Most efficient for simpler tasks', contextWindowTokens: ONE_MILLION, supportedEffortLevels: FULL_EFFORT },
  { kiroId: 'claude-haiku-5.5', claudeValue: 'claude-haiku-5-5', displayName: 'Haiku 5.5', description: 'Fastest for quick answers', contextWindowTokens: ONE_MILLION, supportedEffortLevels: FULL_EFFORT },
  { kiroId: 'claude-haiku-4.5', claudeValue: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5', description: 'Fastest for quick answers', contextWindowTokens: DEFAULT_MODEL_WINDOW, supportedEffortLevels: null },
  { kiroId: 'claude-sonnet-5', claudeValue: 'claude-sonnet-5', displayName: 'Sonnet 5', description: 'Efficient for routine tasks', contextWindowTokens: ONE_MILLION, supportedEffortLevels: FULL_EFFORT },
  { kiroId: 'claude-opus-5', claudeValue: 'claude-opus-5', displayName: 'Opus 5', description: 'Best for everyday, complex tasks', contextWindowTokens: ONE_MILLION, supportedEffortLevels: FULL_EFFORT },
  { kiroId: 'claude-fable-5', claudeValue: 'claude-fable-5', displayName: 'Fable 5', description: 'Most capable for your hardest and longest-running tasks', contextWindowTokens: ONE_MILLION, supportedEffortLevels: FULL_EFFORT },
  { kiroId: 'claude-opus-4.8', claudeValue: 'claude-opus-4-8', displayName: 'Opus 4.8', description: 'Best for everyday, complex tasks', contextWindowTokens: ONE_MILLION, supportedEffortLevels: FULL_EFFORT },
  { kiroId: 'claude-opus-4.7', claudeValue: 'claude-opus-4-7', displayName: 'Opus 4.7', description: 'Best for everyday, complex tasks', contextWindowTokens: ONE_MILLION, supportedEffortLevels: FULL_EFFORT },
  { kiroId: 'claude-opus-4.6', claudeValue: 'claude-opus-4-6', displayName: 'Opus 4.6', description: 'Best for everyday, complex tasks', contextWindowTokens: ONE_MILLION, supportedEffortLevels: NO_XHIGH },
  { kiroId: 'claude-sonnet-4.6', claudeValue: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6', description: 'Efficient for routine tasks', contextWindowTokens: ONE_MILLION, supportedEffortLevels: NO_XHIGH },
];

function cloneEntry(e: ModelEntry): ModelEntry {
  return { ...e, ...(Array.isArray(e.supportedEffortLevels) ? { supportedEffortLevels: [...e.supportedEffortLevels] } : {}) };
}

function effortOf(m: ModelInfo): string[] | null {
  return Array.isArray(m.supportedEffortLevels) && m.supportedEffortLevels.length > 0 ? [...m.supportedEffortLevels] : null;
}

/**
 * Model entries for `/model`, `--list-models` and ACP (see module doc). `windows` optionally
 * overrides context windows by Kiro id (e.g. measured `modelUsage[m].contextWindow`).
 */
export function buildModelList(live?: ModelInfo[], windows?: Record<string, number>): ModelEntry[] {
  const win = (kiroId: string, fallback?: number): number | undefined => windows?.[kiroId] ?? fallback;
  if (!live || live.length === 0) {
    return STATIC_MODELS.map((e) => {
      const c = cloneEntry(e);
      const w = win(c.kiroId, c.contextWindowTokens);
      if (w !== undefined) c.contextWindowTokens = w;
      return c;
    });
  }
  const out: ModelEntry[] = [];
  const seen = new Set<string>();
  const def = live.find((m) => m.value === 'default');
  const autoWindow = win(AUTO_MODEL_ID, def ? contextWindowFor(def.resolvedModel ?? '') : undefined) ?? ONE_MILLION;
  out.push({
    kiroId: AUTO_MODEL_ID,
    displayName: def?.displayName ?? 'Default (recommended)',
    description: def?.description ?? 'Claude Code default model for your account',
    contextWindowTokens: autoWindow,
    supportedEffortLevels: def ? effortOf(def) : FULL_EFFORT.slice(),
    isDefault: true,
  });
  seen.add(AUTO_MODEL_ID);
  for (const m of live) {
    if (m.value === 'default') continue;
    const kiroId = liveKiroId(m);
    const key = kiroId.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const entry: ModelEntry = {
      kiroId,
      claudeValue: m.value,
      displayName: m.displayName || displayFromKiroId(kiroId),
      supportedEffortLevels: effortOf(m),
    };
    if (m.description) entry.description = m.description;
    const w = win(kiroId, contextWindowFor(kiroId));
    if (w !== undefined) entry.contextWindowTokens = w;
    out.push(entry);
  }
  return out;
}

/** Find an entry by Kiro id, Claude value or display name (case-insensitive). */
export function findModelEntry(entries: readonly ModelEntry[], id: string): ModelEntry | undefined {
  const l = id.trim().toLowerCase();
  return (
    entries.find((e) => e.kiroId.toLowerCase() === l) ??
    entries.find((e) => e.claudeValue?.toLowerCase() === l) ??
    entries.find((e) => e.displayName.toLowerCase() === l)
  );
}

/** One `--list-models` JSON row (08a §2.2). */
export interface ModelListRow {
  model_name: string;
  model_id: string;
  display_name: string;
  description: string;
  context_window_tokens: number;
  rate_multiplier: number;
}

export function modelListRows(entries: readonly ModelEntry[]): ModelListRow[] {
  return entries.map((e) => ({
    model_name: e.kiroId,
    model_id: e.kiroId,
    display_name: e.displayName,
    description: e.description ?? e.displayName,
    context_window_tokens: e.contextWindowTokens && e.contextWindowTokens > 0 ? e.contextWindowTokens : DEFAULT_MODEL_WINDOW,
    rate_multiplier: 1.0,
  }));
}

function formatWindow(n: number): string {
  if (n >= ONE_MILLION && n % ONE_MILLION === 0) return `${n / ONE_MILLION}M`;
  if (n >= 1000 && n % 1000 === 0) return `${n / 1000}K`;
  return String(n);
}

/** `--list-models` output (see module doc); no trailing newline. */
export function formatModelList(entries: readonly ModelEntry[], format: 'plain' | 'json' | 'json-pretty'): string {
  if (format === 'json') return JSON.stringify({ models: modelListRows(entries) });
  if (format === 'json-pretty') return JSON.stringify({ models: modelListRows(entries) }, null, 2);
  const rows = entries.map((e) => [
    e.isDefault ? '*' : ' ',
    e.kiroId,
    e.displayName,
    formatWindow(e.contextWindowTokens && e.contextWindowTokens > 0 ? e.contextWindowTokens : DEFAULT_MODEL_WINDOW),
    e.description ?? '',
  ]);
  const w = [0, 1, 2, 3].map((i) => Math.max(...rows.map((r) => r[i]!.length), 0));
  return rows
    .map((r) => `${r[0]} ${r[1]!.padEnd(w[1]!)}  ${r[2]!.padEnd(w[2]!)}  ${r[3]!.padEnd(w[3]!)}  ${r[4]}`.replace(/\s+$/, ''))
    .join('\n');
}

// ───────────────────────────── cache ─────────────────────────────

export interface ModelCacheFile {
  version: 1;
  updatedAt: string;
  models: ModelInfo[];
  /** Measured context windows by Kiro id. */
  contextWindows: Record<string, number>;
}

/** `${XDG_CACHE_HOME:-~/.cache}/kiro-claude/models.json` (08 KC-CLI-06). */
export function modelCachePath(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CACHE_HOME;
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(homeDir(env), '.cache');
  return path.join(base, 'kiro-claude', 'models.json');
}

/** Read the model cache; undefined when missing or malformed. Never throws. */
export function readModelCache(env: NodeJS.ProcessEnv = process.env): ModelCacheFile | undefined {
  try {
    const raw = readJsonIfExists<Partial<ModelCacheFile>>(modelCachePath(env));
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.models)) return undefined;
    const models = raw.models.filter((m): m is ModelInfo => !!m && typeof m === 'object' && typeof (m as ModelInfo).value === 'string');
    const contextWindows: Record<string, number> = {};
    if (raw.contextWindows && typeof raw.contextWindows === 'object') {
      for (const [k, v] of Object.entries(raw.contextWindows)) if (typeof v === 'number' && v > 0) contextWindows[k] = Math.floor(v);
    }
    return { version: 1, updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '', models, contextWindows };
  } catch {
    return undefined;
  }
}

/**
 * Store the live model list (and optionally merge measured windows). Best effort: returns
 * false instead of throwing when the cache cannot be written.
 */
export function writeModelCache(
  update: { models?: ModelInfo[]; contextWindows?: Record<string, number> },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  try {
    const prev = readModelCache(env);
    const next: ModelCacheFile = {
      version: 1,
      updatedAt: new Date().toISOString(),
      models: update.models ?? prev?.models ?? [],
      contextWindows: { ...(prev?.contextWindows ?? {}), ...(update.contextWindows ?? {}) },
    };
    writeJsonAtomic(modelCachePath(env), next, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

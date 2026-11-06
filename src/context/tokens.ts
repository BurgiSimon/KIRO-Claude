/**
 * Token estimate and context-file size limit, ported from Q CLI (06 §4.3).
 *
 *  - {@link estimateTokens}: Q `TokenCounter::count_tokens` — `bytes / 4`, then rounded to the
 *    nearest ten (`(n + 5) / 10 * 10`, integer arithmetic). UTF-8 bytes, not UTF-16 units.
 *  - {@link contextFilesLimit}: Q `calc_max_context_files_size` — 75 % of the model's context
 *    window (`window * 3 / 4`, integer), default window 200 000 ⇒ 150 000 tokens.
 *  - {@link selectWithinLimit}: Q's drop step. Files are first ordered by path (byte order),
 *    then stably sorted by token count DESC; each file is kept if it still fits
 *    (`total + n <= limit`), otherwise dropped. The largest files are therefore *kept first*
 *    when they fit (Q's comment "drops the largest files first" is inaccurate, 06 §4.3).
 *
 * Pure functions; no I/O.
 */

import { byteLength } from '../util/text.js';

/** Default context window when the model's real window is unknown (06 §4.3, 00 §6.1). */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;

/** Q's token estimate: `round10(utf8Bytes / 4)` (06 §4.3). */
export function estimateTokens(text: string): number {
  return estimateTokensFromBytes(byteLength(text));
}

/** {@link estimateTokens} for a known UTF-8 byte length (lets callers skip reading huge files). */
export function estimateTokensFromBytes(bytes: number): number {
  const b = Math.max(0, Math.floor(bytes));
  return Math.floor((Math.floor(b / 4) + 5) / 10) * 10;
}

/** 75 % of the context window (integer), Q `calc_max_context_files_size` (06 §4.3). */
export function contextFilesLimit(contextWindowTokens?: number): number {
  const w =
    contextWindowTokens !== undefined && Number.isFinite(contextWindowTokens) && contextWindowTokens > 0
      ? Math.floor(contextWindowTokens)
      : DEFAULT_CONTEXT_WINDOW_TOKENS;
  return Math.floor((w * 3) / 4);
}

/** Byte-order comparison of two strings (Rust `String` ordering). */
export function compareBytes(a: string, b: string): number {
  if (a === b) return 0;
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * Q's keep/drop selection (06 §4.3). Returns the kept and dropped items, both in the order
 * Q evaluates them (token count DESC, ties by path in byte order), plus the kept total.
 */
export function selectWithinLimit<T extends { path: string; tokens: number }>(
  items: readonly T[],
  limit: number,
): { kept: T[]; dropped: T[]; total: number } {
  const order = [...items].sort((a, b) => compareBytes(a.path, b.path)).sort((a, b) => b.tokens - a.tokens);
  const kept: T[] = [];
  const dropped: T[] = [];
  let total = 0;
  for (const it of order) {
    if (total + it.tokens > limit) dropped.push(it);
    else {
      total += it.tokens;
      kept.push(it);
    }
  }
  return { kept, dropped, total };
}

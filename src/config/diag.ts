/**
 * Small diagnostics helpers shared by the config loaders.
 *
 * JSON syntax errors: V8's `JSON.parse` messages embed a (possibly multi-line, possibly
 * `...`-truncated) copy of the input (`Unexpected token ',', ..."tools": [,]\n}" is not valid
 * JSON`). Q prints serde's one-line reason plus `at line L column C` (06 §7.2 `Json supplied at
 * <path> is invalid: <serde error>`), so {@link jsonErrorReason} keeps only the reason, on one
 * line, followed by the location computed by util/fsx.parseJsonText.
 */

import { JsonFileError } from '../util/fsx.js';

/** Drop V8's input snippet and collapse whitespace runs that contain newlines. */
export function cleanJsonReason(reason: string): string {
  return reason
    .replace(/,\s*(?:\.\.\.)?"[\s\S]*" is not valid JSON\s*$/, '')
    .replace(/\s*\(line \d+ column \d+\)\s*$/, '')
    .replace(/\s+in JSON at position \d+.*$/, '')
    .replace(/\s*[\r\n]+\s*/g, ' ')
    .trim();
}

/** One-line reason (with `at line L column C` when known) for a JSON parse failure. */
export function jsonErrorReason(e: unknown): string {
  if (e instanceof JsonFileError) {
    const reason = cleanJsonReason(e.reason) || 'invalid JSON';
    return e.line !== undefined ? `${reason} at line ${e.line} column ${e.column ?? 1}` : reason;
  }
  return cleanJsonReason(e instanceof Error ? e.message : String(e));
}

/** `<path>: invalid JSON: <reason>` (used for mcp.json, hook files, settings). */
export function jsonErrorMessage(e: unknown, filePath: string): string {
  return `${filePath}: invalid JSON: ${jsonErrorReason(e)}`;
}

/** Message of an unknown thrown value. */
export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * `map[key]` only when `key` is an own property. Plain object literals used as lookup tables
 * would otherwise return `Object.prototype` members for user-controlled keys such as
 * `constructor` or `__proto__` (a hook trigger, an inclusion mode, a preset id, …).
 */
export function ownValue<T>(map: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

/**
 * Define `obj[key] = value` as an own, enumerable data property. Unlike plain assignment this
 * never invokes the `__proto__` setter, so a configuration key or server name `__proto__`
 * read from a user file is stored (and serialized) like any other key.
 */
export function setOwn<T>(obj: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

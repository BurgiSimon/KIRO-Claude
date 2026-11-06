/**
 * Small, pure text helpers shared across kiro-claude.
 *
 * Semantics worth knowing:
 *  - {@link truncateBytes} follows Q CLI's `truncate_safe` + suffix convention used for hook
 *    output (`max_output_size`) and `USER_PROMPT` (06 §3.3): the kept prefix is the longest
 *    prefix of at most `maxBytes` UTF-8 bytes that ends on a character boundary, and the
 *    suffix is appended only when something was cut. The suffix is NOT counted against
 *    `maxBytes` (Q: `truncate(raw, n) + " ... truncated"`).
 *  - {@link sanitizeControlChars} removes Unicode `Cc` characters (C0, DEL, C1) except the
 *    ones listed in `keep` (default `\n\r\t`), which is exactly Q's `USER_PROMPT` sanitizer.
 *
 * Library code: never prints anything.
 */

/** UTF-8 byte length of a string. */
export function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/**
 * Longest prefix of `buf` that is at most `maxBytes` long and does not end in the middle of a
 * UTF-8 multi-byte sequence. Pure; used by {@link truncateBytes} and the process helpers.
 */
export function utf8SafePrefixLength(buf: Uint8Array, maxBytes: number): number {
  if (maxBytes <= 0) return 0;
  if (buf.length <= maxBytes) return buf.length;
  let end = maxBytes;
  // If buf[end] is a continuation byte (10xxxxxx), the char starting before `end` is split:
  // back off to the start of that character.
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return end;
}

/**
 * Truncate `s` to at most `maxBytes` UTF-8 bytes (never splitting a character), appending
 * `suffix` (default `''`) only when truncation happened. The suffix is not counted in the
 * budget (Q CLI convention, 06 §3.3).
 */
export function truncateBytes(s: string, maxBytes: number, suffix = ''): string {
  const max = Math.max(0, Math.floor(maxBytes));
  // Fast path: a UTF-16 string never has more UTF-8 bytes than 3x its length.
  if (s.length * 3 <= max) return s;
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= max) return s;
  const end = utf8SafePrefixLength(buf, max);
  return buf.subarray(0, end).toString('utf8') + suffix;
}

/**
 * Remove Unicode control characters (general category `Cc`: U+0000–U+001F, U+007F–U+009F)
 * except those contained in `keep` (default newline, carriage return and tab).
 */
export function sanitizeControlChars(s: string, keep = '\n\r\t'): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, (ch) => (keep.includes(ch) ? ch : ''));
}

/**
 * Prefix every non-empty line of `s` with `prefix`. Empty lines stay empty (no trailing
 * whitespace). Line endings (`\n` / `\r\n`) are preserved.
 */
export function indent(s: string, prefix: string): string {
  if (prefix === '') return s;
  return s
    .split('\n')
    .map((line) => (line === '' || line === '\r' ? line : prefix + line))
    .join('\n');
}

/** `word` or its plural form for count `n` (default plural = `word + 's'`). */
export function pluralWord(n: number, word: string, pluralForm?: string): string {
  return n === 1 ? word : pluralForm ?? `${word}s`;
}

/**
 * Count + noun: `plural(1, 'file')` → `"1 file"`, `plural(3, 'file')` → `"3 files"`,
 * `plural(2, 'entry', 'entries')` → `"2 entries"`. Use {@link pluralWord} for the noun alone.
 */
export function plural(n: number, word: string, pluralForm?: string): string {
  return `${n} ${pluralWord(n, word, pluralForm)}`;
}

/** Remove a leading UTF-8 byte-order mark (U+FEFF), if present. */
export function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** Convert CRLF and lone CR line endings to LF. */
export function normalizeNewlines(s: string): string {
  return s.replace(/\r\n?/g, '\n');
}

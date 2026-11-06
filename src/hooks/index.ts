/**
 * Kiro hook runner (V2 + V3 dialects, every trigger): runner.ts executes hooks, payload.ts builds
 * their stdin JSON, matcher.ts decides which hooks apply, format.ts holds Q's exact strings.
 * See 00 §2.4, 02 §7, 03 §2.5, 06 §3.
 */

export * from './format.js';
export * from './matcher.js';
export * from './payload.js';
export * from './runner.js';

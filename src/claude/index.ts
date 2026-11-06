/**
 * Driver for the installed Claude Code CLI (00-synthesis §3): binary discovery and capability
 * probe, child lifecycle (process groups, signals, cleanup), child environment, the
 * `ClaudeProcess` NDJSON/control-protocol client, auth helpers, transcript utilities and the
 * wire types.
 */
export * from './protocol.js';
export * from './binary.js';
export * from './lifecycle.js';
export * from './env.js';
export * from './process.js';
export * from './auth.js';
export * from './transcript.js';

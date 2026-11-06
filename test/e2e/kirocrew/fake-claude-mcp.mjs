#!/usr/bin/env node
/**
 * Stage-B helper: test/fixtures/fake-claude.mjs with MCP servers that report tools and status.
 *
 * fake-claude lists an MCP server's tools (and a non-connected status) only from `fakeTools` /
 * `fakeStatus` keys inside its `--mcp-config` entry. kiro-claude normalises every MCP entry to
 * `{type, command, args, env}` / `{type, url, headers}` (src/config/mcp.ts toClaudeMcpConfig),
 * which is correct host behaviour, so those keys can never travel through an agent spec. This
 * wrapper adds them on the Claude side instead, then runs the unmodified fake in this process:
 *
 *   KIRO_CLAUDE_BIN=<this file>
 *   KC_FAKE_MCP_INJECT='{"<server name>": {"fakeTools": ["ping"], "fakeStatus": "failed"}}'
 *
 * Every `--mcp-config <json|file>` / `--mcp-config=<json|file>` argument is rewritten to inline
 * JSON with the keys merged into the named entries (other entries are untouched). The fake logs
 * the rewritten argv, so FAKE_CLAUDE_LOG shows exactly what Claude "received".
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
let inject = {};
try {
  inject = JSON.parse(process.env.KC_FAKE_MCP_INJECT || '{}');
} catch {
  inject = {};
}

function rewrite(value) {
  let cfg;
  try {
    cfg = JSON.parse(value.trim().startsWith('{') ? value : fs.readFileSync(value, 'utf8'));
  } catch {
    return value; // let the fake report the bad config itself
  }
  for (const [name, entry] of Object.entries(cfg.mcpServers || {})) {
    if (entry && typeof entry === 'object' && inject[name]) Object.assign(entry, inject[name]);
  }
  return JSON.stringify(cfg);
}

const a = process.argv;
for (let i = 2; i < a.length; i++) {
  if (a[i] === '--mcp-config' && i + 1 < a.length) {
    a[i + 1] = rewrite(a[i + 1]);
    i++;
  } else if (a[i].startsWith('--mcp-config=')) {
    a[i] = `--mcp-config=${rewrite(a[i].slice('--mcp-config='.length))}`;
  }
}
const fake = process.env.KC_FAKE_CLAUDE || path.resolve(here, '..', '..', 'fixtures', 'fake-claude.mjs');
await import(pathToFileURL(fake).href);

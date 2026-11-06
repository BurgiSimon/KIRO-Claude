/**
 * Headless runner end to end: real session module (src/session/kiroSession.ts, loaded through
 * cli/entries like production) + fake-claude (KIRO_CLAUDE_BIN, FAKE_CLAUDE_SCRIPT_JSON). The
 * suite skips when the session module is not part of this build.
 */
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { loadCreateSession, type CreateSessionFn } from '../../src/cli/entries.js';
import { runHeadless } from '../../src/headless/run.js';
import { makeCtx, makeEnv, run, type TestEnv } from '../cli/helpers.js';

let createSession: CreateSessionFn | undefined;
let skipReason: string | undefined;
try {
  createSession = await loadCreateSession();
} catch (e) {
  skipReason = `session module unavailable: ${e instanceof Error ? e.message : String(e)}`;
}

let t: TestEnv;
beforeEach(() => {
  t = makeEnv();
});
afterEach(() => t.cleanup());

function script(s: object): Record<string, string> {
  return { FAKE_CLAUDE_SCRIPT_JSON: JSON.stringify(s) };
}

function userTurns(): Array<Record<string, unknown>> {
  return t.fakeLogLines().filter((l) => l.event === 'stdin' && (l.line as { type?: string } | undefined)?.type === 'user');
}

test('text on stdout, tool lines on stderr, exit 0', { skip: skipReason }, async () => {
  Object.assign(
    t.env,
    script({ turns: [{ steps: [{ text: 'Hello from fake.' }, { tool: { name: 'Bash', input: { command: 'echo hi', description: 'Say hi' }, result: 'hi' } }, { text: 'All done.' }] }] }),
  );
  const r = await run(t, ['chat', '--no-interactive', '--trust-all-tools', 'say hi']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Hello from fake\./);
  assert.match(r.stdout, /All done\./);
  assert.ok(!r.stdout.includes('Using tool'));
  assert.match(r.stderr, /🛠️ {2}Using tool: shell/);
  assert.match(r.stderr, /● Completed in /);
  assert.equal(userTurns().length, 1);
});

test('tools needing approval are denied in headless mode and the run continues', { skip: skipReason }, async () => {
  // FAKE_CLAUDE_SCRIPT (file form)
  t.env.FAKE_CLAUDE_SCRIPT = t.write('script.json', { turns: [{ steps: [{ tool: { name: 'Bash', input: { command: 'rm -rf /tmp/x' } } }, { text: 'Saw: {{lastToolResult}}' }] }] });
  const r = await run(t, ['chat', '--no-interactive', 'clean up']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /tool permission approval is not supported in non-interactive mode/);
});

test('/usage, /tools and /mcp send no user turn to claude', { skip: skipReason }, async () => {
  const u = await run(t, ['chat', '--no-interactive', '/usage']);
  assert.equal(u.code, 0);
  assert.equal(t.fakeLogLines().length, 0, 'claude not even spawned for /usage');
  const tools = await run(t, ['chat', '--no-interactive', '/tools']);
  assert.equal(tools.code, 0, tools.stderr);
  assert.match(tools.stdout, /Built-in:/);
  const mcp = await run(t, ['chat', '--no-interactive', '/mcp']);
  assert.equal(mcp.code, 0, mcp.stderr);
  assert.equal(userTurns().length, 0);
});

test('auth failure ⇒ not-logged-in message, exit 1', { skip: skipReason }, async () => {
  Object.assign(t.env, script({ turns: [{ steps: [{ error: 'authentication_failed' }] }] }));
  const r = await run(t, ['chat', '--no-interactive', 'hi']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /You are not logged in, please log in with kiro-claude login/);
});

test('--require-mcp-startup with a healthy server ⇒ exit 0; unavailable agent ⇒ exit 4', { skip: skipReason }, async () => {
  t.write(path.join(t.kiroHome, 'settings', 'mcp.json'), { mcpServers: { fetch: { command: process.execPath, args: ['-e', '1'] } } });
  Object.assign(t.env, script({ default: { steps: [{ text: 'ok' }] } }));
  const r = await run(t, ['chat', '--no-interactive', '--require-mcp-startup', 'hi']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /ok/);
  const missing = await run(t, ['chat', '--no-interactive', '--agent', 'ghost', 'hi']);
  assert.equal(missing.code, 4);
});

test('stream-json output is JSON lines only', { skip: skipReason }, async () => {
  Object.assign(t.env, script({ turns: [{ steps: [{ text: 'json please' }] }] }));
  const r = await run(t, ['chat', '--no-interactive', '--output-format', 'stream-json', 'hi']);
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stdout.trim().split('\n').map((l) => JSON.parse(l) as { type: string });
  assert.equal(lines[0]!.type, 'session');
  assert.equal(lines[lines.length - 1]!.type, 'result');
});

test('runHeadless with the real factory: piped stdin task', { skip: skipReason }, async () => {
  Object.assign(t.env, script({ turns: [{ match: 'from stdin', steps: [{ text: 'got it' }] }] }));
  const { ctx, stdout } = makeCtx(t, { stdin: 'task from stdin\n' });
  const code = await runHeadless({ ctx, sessionOptions: { env: t.env }, input: '', createSession: createSession! });
  assert.equal(code, 0);
  assert.match(stdout.text, /got it/);
  assert.ok(fs.existsSync(t.fakeLog));
});

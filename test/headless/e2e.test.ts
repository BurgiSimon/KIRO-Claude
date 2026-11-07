/**
 * Headless runner end to end: real session module (src/session/kiroSession.ts, loaded through
 * cli/entries like production) + fake-claude (KIRO_CLAUDE_BIN, FAKE_CLAUDE_SCRIPT_JSON). The
 * suite skips when the session module is not part of this build.
 */
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { loadCreateSession, type CreateSessionFn } from '../../src/cli/entries.js';
import { runHeadless } from '../../src/headless/run.js';
import { builtBin, makeCtx, makeEnv, run, type TestEnv } from '../cli/helpers.js';

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

// ───────────────────────── closed stderr / stdout (C10): subprocess, built binary ─────────────────────────

const EPIPE_SCRIPT = {
  turns: [
    {
      steps: [
        { text: 'first line\n' },
        { tool: { name: 'Read', input: { file_path: '/etc/hostname' } } },
        { sleepMs: 300 },
        { text: 'second line\n' },
        { tool: { name: 'Read', input: { file_path: '/etc/hosts' } } },
        { sleepMs: 300 },
        { text: 'final' },
      ],
    },
  ],
};

/**
 * Run `chat --no-interactive --trust-all-tools hi` from the built binary and destroy the read
 * side of `which` after its first chunk ('shared': stdout and stderr on one pipe, `2>&1 | head`).
 * An uncaughtExceptionMonitor preload reports crashes on fd 3; a workspace SessionEnd hook
 * touches a marker so a clean session close is observable.
 */
async function runClosingPipe(which: 'stdout' | 'stderr' | 'shared'): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  diag: string;
  locks: string[];
  turnLogs: string[];
  runtime: string[];
  sessionEnd: boolean;
}> {
  const marker = path.join(t.root, 'session-ended');
  t.write(path.join(t.cwd, '.kiro', 'hooks', 'end.json'), {
    version: 'v1',
    hooks: [{ name: 'end', trigger: 'SessionEnd', action: { type: 'command', command: `touch '${marker}'` } }],
  });
  const preload = t.write('monitor.cjs', "process.on('uncaughtExceptionMonitor', (e) => { try { require('fs').writeSync(3, 'UNCAUGHT ' + (e && e.message) + '\\n'); } catch {} });\n");
  const diagFile = path.join(t.root, 'diag.txt');
  const fd3 = fs.openSync(diagFile, 'w');
  const env = { ...t.env, ...script(EPIPE_SCRIPT) };
  const argv = ['-r', preload, builtBin(), 'chat', '--no-interactive', '--trust-all-tools', 'hi'];
  const child =
    which === 'shared'
      ? // `kiro-claude chat … 2>&1 | head -c 3`: both streams on one pipe
        spawn('/bin/sh', ['-c', 'exec "$0" "$@" 2>&1', process.execPath, ...argv], { cwd: t.cwd, env, stdio: ['ignore', 'pipe', 'ignore', fd3] })
      : spawn(process.execPath, argv, {
          cwd: t.cwd,
          env,
          stdio: ['ignore', which === 'stdout' ? 'pipe' : 'ignore', which === 'stderr' ? 'pipe' : 'ignore', fd3],
        });
  fs.closeSync(fd3);
  const stream = which === 'stderr' ? child.stderr! : child.stdout!;
  stream.once('data', () => stream.destroy());
  const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.on('exit', (c, s) => resolve({ code: c, signal: s })),
  );
  const cli = path.join(t.kiroHome, 'sessions', 'cli');
  const files = fs.existsSync(cli) ? fs.readdirSync(cli) : [];
  const rtBase = t.env.XDG_RUNTIME_DIR!;
  const runtime = fs.existsSync(rtBase) ? fs.readdirSync(rtBase).flatMap((d) => fs.readdirSync(path.join(rtBase, d))) : [];
  return {
    code,
    signal,
    diag: fs.readFileSync(diagFile, 'utf8'),
    locks: files.filter((f) => f.endsWith('.lock')),
    turnLogs: files.filter((f) => f.endsWith('.jsonl')),
    runtime,
    sessionEnd: fs.existsSync(marker),
  };
}

test('stderr closed mid-turn ⇒ no uncaught EPIPE; the turn finishes and the session closes cleanly (C10)', { skip: skipReason, timeout: 60_000 }, async () => {
  const r = await runClosingPipe('stderr');
  assert.doesNotMatch(r.diag, /UNCAUGHT/, `uncaught exception: ${r.diag}`);
  assert.equal(r.code, 0, JSON.stringify(r));
  assert.deepEqual(r.locks, [], 'session lock left behind');
  assert.deepEqual(r.runtime, [], 'runtime session dir left behind');
  assert.equal(r.sessionEnd, true, 'SessionEnd hooks did not run');
  assert.equal(r.turnLogs.length, 1, 'the turn was recorded');
});

test('stdout and stderr on one closed pipe (`2>&1 | head`) ⇒ exit 1, no crash, session closed (C10)', { skip: skipReason, timeout: 60_000 }, async () => {
  const r = await runClosingPipe('shared');
  assert.doesNotMatch(r.diag, /UNCAUGHT/, `uncaught exception: ${r.diag}`);
  assert.equal(r.signal, null);
  assert.equal(r.code, 1, JSON.stringify(r));
  assert.deepEqual(r.locks, []);
  assert.deepEqual(r.runtime, []);
  assert.equal(r.sessionEnd, true);
});

test('stdout closed mid-turn ⇒ interrupt, exit 1, session closed (control, C10)', { skip: skipReason, timeout: 60_000 }, async () => {
  const r = await runClosingPipe('stdout');
  assert.doesNotMatch(r.diag, /UNCAUGHT/, `uncaught exception: ${r.diag}`);
  assert.equal(r.code, 1, JSON.stringify(r));
  assert.deepEqual(r.locks, []);
  assert.deepEqual(r.runtime, []);
  assert.equal(r.sessionEnd, true);
});

test('--no-interactive hands Claude Code mcp.noInteractiveTimeout as MCP_TIMEOUT, never mcp.initTimeout (F4)', { skip: skipReason }, async () => {
  const childMcpTimeout = async (settings: object): Promise<string> => {
    t.write(path.join(t.kiroHome, 'settings', 'cli.json'), settings);
    Object.assign(t.env, script({ default: { steps: [{ text: 'MCP_TIMEOUT=[{{env:MCP_TIMEOUT}}]' }] } }));
    const r = await run(t, ['chat', '--no-interactive', 'hi']);
    assert.equal(r.code, 0, r.stderr);
    const m = /MCP_TIMEOUT=\[([^\]]*)\]/.exec(r.stdout);
    assert.ok(m, r.stdout);
    return m[1]!;
  };
  assert.equal(await childMcpTimeout({ 'mcp.initTimeout': 1500, 'mcp.noInteractiveTimeout': 60000 }), '60000');
  assert.equal(await childMcpTimeout({ 'mcp.initTimeout': 1500 }), '', 'no 1.5 s hard limit: Claude Code keeps its own default');
  assert.equal(await childMcpTimeout({}), '');
  t.env.MCP_TIMEOUT = '7777';
  assert.equal(await childMcpTimeout({ 'mcp.noInteractiveTimeout': 60000 }), '7777', 'the user env wins');
});

import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import { signedOutMessage } from '../../src/cli/commands/auth.js';
import { runDoctorChecks } from '../../src/cli/commands/doctor.js';
import { makeCtx, makeEnv, run, type TestEnv } from './helpers.js';

let t: TestEnv;
beforeEach(() => {
  t = makeEnv();
});
afterEach(() => t.cleanup());

test('whoami: signed in (plain / json / json-pretty)', async () => {
  const p = await run(t, ['whoami']);
  assert.equal(p.code, 0);
  assert.equal(p.stdout, 'Logged in with Claude Code (claude.ai)\n');
  const j = await run(t, ['whoami', '--format', 'json']);
  assert.equal(j.stdout, '{}\n');
  assert.ok(!j.stdout.includes('accountType'));
  const jp = await run(t, ['whoami', '-f', 'json-pretty']);
  assert.equal(jp.stdout, '{}\n');
  const bad = await run(t, ['whoami', '--format', 'yaml']);
  assert.equal(bad.code, 2);
});

test('whoami: signed out ⇒ exit 1, "not logged in" on stderr, no JSON', async () => {
  for (const fmt of [[], ['--format', 'json']]) {
    const r = await run(t, ['whoami', ...fmt], { env: { FAKE_CLAUDE_LOGGED_OUT: '1' } });
    assert.equal(r.code, 1);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, `${signedOutMessage('kiro-claude')}\n`);
    assert.ok(r.stderr.toLowerCase().includes('not logged in'));
  }
  const viaShim = await run(t, ['whoami'], { env: { FAKE_CLAUDE_LOGGED_OUT: '1' }, argv1: '/x/kiro-cli' });
  assert.equal(viaShim.stderr, 'Not logged in. Run "kiro-cli login" to sign in to Claude Code.\n');
});

test('whoami: claude missing ⇒ not found message, exit 1', async () => {
  const r = await run(t, ['whoami'], { env: { KIRO_CLAUDE_BIN: path.join(t.root, 'no-claude') } });
  assert.equal(r.code, 1);
  assert.equal(r.stderr, `Not logged in: Claude Code not found (${path.join(t.root, 'no-claude')})\n`);
});

test('login: already logged in ⇒ Q error; logged out ⇒ claude auth login passthrough', async () => {
  const already = await run(t, ['login']);
  assert.equal(already.code, 1);
  assert.equal(already.stderr, 'error: Already logged in, please logout with kiro-claude logout first\n');
  const r = await run(t, ['login', '--use-device-flow', '--region', 'us-east-1'], { env: { FAKE_CLAUDE_LOGGED_OUT: '1' } });
  assert.equal(r.code, 0);
  assert.match(r.stderr, /Note: --use-device-flow is a Kiro sign-in option and is ignored/);
  assert.match(r.stderr, /Note: --region is a Kiro sign-in option and is ignored/);
  const log = t.fakeLogLines();
  const exit = log.filter((l) => l.event === 'exit' && String(l.reason).startsWith('auth login'));
  assert.equal(exit.length, 1);
  const start = log.filter((l) => l.event === 'start').map((l) => (l.argv as string[]).join(' '));
  assert.ok(start.some((a) => a.endsWith('auth login --claudeai')), start.join('\n'));
  const failing = await run(t, ['login'], { env: { FAKE_CLAUDE_LOGGED_OUT: '1', FAKE_CLAUDE_AUTH_EXIT: '3' } });
  assert.equal(failing.code, 3);
  const pro = await run(t, ['login', '--license', 'pro'], { env: { FAKE_CLAUDE_LOGGED_OUT: '1' } });
  assert.equal(pro.code, 0);
  assert.ok(t.fakeLogLines().some((l) => l.event === 'start' && (l.argv as string[]).join(' ').endsWith('auth login --sso')));
});

test('logout: claude auth logout, then Q lines on stderr', async () => {
  const r = await run(t, ['logout']);
  assert.equal(r.code, 0);
  assert.equal(r.stderr, 'You are now logged out\nRun kiro-claude login to log back in to Claude Code\n');
  const failing = await run(t, ['logout'], { env: { FAKE_CLAUDE_AUTH_EXIT: '2' } });
  assert.equal(failing.code, 2);
  assert.equal(failing.stderr, '');
});

test('doctor: healthy setup ⇒ exit 0 with the KiroCrew hint', async () => {
  const r = await run(t, ['doctor']);
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /^✓ kiro-claude 0\.1\.0 \(kiro-cli 1\.26\.0\) on Node v/m);
  assert.match(r.stdout, /^✓ Claude Code 2\.1\.318 at .*fake-claude\.mjs$/m);
  assert.match(r.stdout, /^✓ Logged in to Claude Code \(claude\.ai\)$/m);
  assert.match(r.stdout, /^ℹ KiroCrew: run 'kiro-claude crew doctor' to check the KiroCrew integration$/m);
  assert.match(r.stdout, /\nNo problems found/);
});

test('doctor: signed out, API-key override, broken config, missing MCP command', async () => {
  t.write(path.join(t.kiroHome, 'agents', 'broken.json'), '{ nope');
  t.write(path.join(t.kiroHome, 'agents', 'dev.json'), { name: 'dev', tools: ['*'], mcpServers: { gone: { command: 'definitely-not-a-command-xyz' } } });
  t.write(path.join(t.kiroHome, 'settings', 'mcp.json'), { mcpServers: { ok: { command: process.execPath }, off: { command: 'nope-xyz', disabled: true } } });
  const r = await run(t, ['doctor'], { env: { FAKE_CLAUDE_LOGGED_OUT: '1', ANTHROPIC_API_KEY: 'sk-x', KIRO_API_KEY: 'k' } });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /^✗ Not logged in to Claude Code\. Run "kiro-claude login" \(claude auth login\)\.$/m);
  assert.match(r.stdout, /^⚠ ANTHROPIC_API_KEY is set: kiro-claude removes it from the claude environment/m);
  assert.match(r.stdout, /^⚠ KIRO_API_KEY is set but ignored/m);
  assert.match(r.stdout, /^✗ Agent 'broken' could not be loaded: Json supplied at .*broken\.json is invalid/m);
  assert.match(r.stdout, /^✗ MCP server 'gone': command 'definitely-not-a-command-xyz' not found on PATH/m);
  assert.match(r.stdout, /^✓ MCP server 'ok': .* found$/m);
  assert.ok(!r.stdout.includes("'off'"));
  assert.match(r.stdout, /\nFound \d+ problems?\.\n$/);
  assert.ok(!r.stdout.includes('sk-x'));
});

test('doctor: claude missing; --strict counts warnings', async () => {
  const r = await run(t, ['doctor'], { env: { KIRO_CLAUDE_BIN: path.join(t.root, 'nope') } });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /^✗ Claude Code: Claude Code CLI from \$KIRO_CLAUDE_BIN is not usable/m);
  const { ctx } = makeCtx(t);
  ctx.ws.env.ANTHROPIC_API_KEY = 'x';
  const rep = await runDoctorChecks(ctx);
  assert.ok(rep.warnings >= 1);
  const strict = await run(t, ['doctor', '--strict'], { env: { ANTHROPIC_API_KEY: 'x' } });
  assert.equal(strict.code, 1);
});

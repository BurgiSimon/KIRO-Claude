import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { NOT_SUPPORTED, progNameFrom, scanRoot } from '../../src/cli/main.js';
import { importOptional } from '../../src/cli/io.js';
import { CHANGELOG, UPDATE_TEXT, changelogText } from '../../src/cli/commands/version.js';
import { diagnosticEnvVars, issueUrl, sanitizeUser } from '../../src/cli/commands/misc.js';
import { versionLine } from '../../src/version.js';
import { makeEnv, run, type TestEnv } from './helpers.js';

let t: TestEnv;
beforeEach(() => {
  t = makeEnv();
});
afterEach(() => t.cleanup());

test('--version / -V / version: the KiroCrew version line', async () => {
  for (const argv of [['--version'], ['-V'], ['--version', 'chat']]) {
    const r = await run(t, argv);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, 'kiro-claude 0.1.0 (kiro-cli 1.26.0)\n');
  }
  // 01 §1.1: under -v the backing Claude Code version follows the version line.
  const verbose = await run(t, ['-v', '--version']);
  assert.equal(verbose.code, 0);
  assert.match(verbose.stdout, /^kiro-claude 0\.1\.0 \(kiro-cli 1\.26\.0\)\nClaude Code 2\.1\.318 \(.*fake-claude\.mjs\)\n$/);
  const v = await run(t, ['version']);
  assert.equal(v.stdout, `${versionLine()}\n`);
  const vv = await run(t, ['version', '-v']);
  assert.match(vv.stdout, /^kiro-claude 0\.1\.0 \(kiro-cli 1\.26\.0\)\nClaude Code 2\.1\.318 \(.*fake-claude\.mjs\)\n$/);
});

test('version --changelog (Q formats)', async () => {
  const r = await run(t, ['version', '--changelog']);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.startsWith('Changelog for version 0.1.0:\nVersion 0.1.0 (2026-11-06)\n  - Added: '));
  const all = await run(t, ['version', '--changelog=all']);
  assert.ok(all.stdout.startsWith('Changelog for all versions:\n'));
  const none = await run(t, ['version', '--changelog=9.9.9']);
  assert.equal(none.stdout, 'No changelog information available for version 9.9.9.\n');
  assert.equal(changelogText('all', []), 'No changelog information available.');
  assert.ok(CHANGELOG.length >= 1);
});

test('root --help lists subcommands and the unsupported Kiro commands', async () => {
  const r = await run(t, ['--help']);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.startsWith('Kiro CLI on your installed Claude Code'));
  assert.match(r.stdout, /Usage: kiro-claude \[OPTIONS\] \[COMMAND\]/);
  for (const c of ['chat', 'agent', 'mcp', 'settings', 'login', 'logout', 'whoami', 'doctor', 'diagnostic', 'issue', 'update', 'version', 'acp', 'spec', 'crew', 'help']) {
    assert.match(r.stdout, new RegExp(`^  ${c} +\\S`, 'm'), c);
  }
  assert.match(r.stdout, /Not supported in kiro-claude: inline, translate, integrations/);
  assert.ok(!r.stdout.includes('  profile '));
  const short = await run(t, ['-h']);
  assert.match(short.stdout, /^ {2}-V, --version +Print version$/m);
  const help = await run(t, ['help']);
  assert.equal(help.stdout, r.stdout);
});

test('help <command> and <command> --help', async () => {
  const a = await run(t, ['help', 'chat']);
  const b = await run(t, ['chat', '--help']);
  assert.equal(a.code, 0);
  assert.equal(a.stdout, b.stdout);
  const s = await run(t, ['help', 'settings']);
  assert.match(s.stdout, /Usage: kiro-claude settings \[OPTIONS\] \[KEY\] \[VALUE\] \[COMMAND\]/);
  const bad = await run(t, ['help', 'nope']);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /unrecognized subcommand 'nope'/);
});

test('unsupported Kiro commands and profile exit 1 with a clear message', async () => {
  for (const c of NOT_SUPPORTED) {
    const r = await run(t, [c, 'status']);
    assert.equal(r.code, 1, c);
    assert.equal(r.stderr, `error: '${c}' is not supported in kiro-claude (a Kiro desktop/AWS feature with no Claude Code equivalent)\n`);
  }
  const p = await run(t, ['profile']);
  assert.equal(p.code, 1);
  assert.equal(p.stderr, 'Profiles are not applicable: kiro-claude uses your Claude Code login\n');
});

test('root: chat flags before a non-chat subcommand ⇒ usage error', async () => {
  const r = await run(t, ['--agent', 'x', 'mcp', 'list']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /^error: unexpected argument '--agent' found\n\nUsage: kiro-claude \[OPTIONS\] \[COMMAND\]/);
});

test('scanRoot table', () => {
  const cases: Array<[string[], Partial<ReturnType<typeof scanRoot>>]> = [
    [[], { command: undefined, args: [] }],
    [['hello'], { command: undefined, args: ['hello'] }],
    [['-vv', 'mcp', 'list'], { verbose: 2, command: 'mcp', args: ['list'] }],
    [['--verbose', '-v', 'chat', '-a'], { verbose: 2, command: 'chat', args: ['-a'] }],
    [['--agent', 'chat', 'hi'], { command: undefined, args: ['--agent', 'chat', 'hi'] }],
    [['--agent', 'dev', 'chat', '-a'], { command: 'chat', args: ['-a'], chatFlags: ['--agent', 'dev'] }],
    [['-f', 'json', '--list-models'], { command: undefined, args: ['-f', 'json', '--list-models'] }],
    [['-af', 'json'], { command: undefined, args: ['-af', 'json'] }],
    [['--agent=mcp', 'x'], { command: undefined, args: ['--agent=mcp', 'x'] }],
    [['--', 'mcp'], { command: undefined, args: ['--', 'mcp'] }],
    [['setting', 'x'], { command: 'setting', args: ['x'] }],
    [['diagnostics'], { command: 'diagnostics', args: [] }],
    [['inline', 'enable'], { command: 'inline', args: ['enable'] }],
    [['--help', 'chat'], { help: 'long' }],
    [['-h'], { help: 'short' }],
    [['--help-all'], { helpAll: true }],
  ];
  for (const [argv, want] of cases) {
    const got = scanRoot(argv);
    for (const [k, v] of Object.entries(want)) assert.deepEqual((got as unknown as Record<string, unknown>)[k], v, `${argv.join(' ')} → ${k}`);
  }
});

test('progName: kiro-cli through a kiro-cli link, else kiro-claude', async () => {
  assert.equal(progNameFrom('/usr/local/bin/kiro-claude'), 'kiro-claude');
  assert.equal(progNameFrom('/x/dist/src/bin/kiro-claude.js'), 'kiro-claude');
  assert.equal(progNameFrom('/home/u/.local/bin/kiro-cli'), 'kiro-cli');
  assert.equal(progNameFrom('C:\\bin\\kiro-cli.cmd'.replace(/\\/g, '/')), 'kiro-cli');
  assert.equal(progNameFrom(undefined), 'kiro-claude');
  const r = await run(t, ['chat', '--bogus'], { argv1: '/home/u/.local/bin/kiro-cli' });
  assert.match(r.stderr, /Usage: kiro-cli chat \[OPTIONS\] \[INPUT\]/);
});

test('update: fast no-op, exit 0, unknown flags ignored', async () => {
  for (const argv of [['update'], ['update', '--non-interactive'], ['update', '-y'], ['update', '--check', '--relaunch-dashboard']]) {
    const r = await run(t, argv);
    assert.equal(r.code, 0, argv.join(' '));
    assert.equal(r.stdout, `${UPDATE_TEXT}\n`);
  }
  assert.equal(UPDATE_TEXT, 'kiro-claude is updated by its installer; nothing to do. Update Claude Code with: claude update');
  const h = await run(t, ['update', '--help']);
  assert.match(h.stdout, /Usage: kiro-claude update/);
});

test('issue prints a prefilled URL', async () => {
  const r = await run(t, ['issue', 'chat', 'crashes', 'on', 'start']);
  assert.equal(r.code, 0);
  const url = new URL(r.stdout.trim());
  assert.equal(url.origin + url.pathname, 'https://github.com/BurgiSimon/KIRO-Claude/issues/new');
  assert.equal(url.searchParams.get('title'), 'chat crashes on start');
  assert.match(url.searchParams.get('body') ?? '', /kiro-claude 0\.1\.0/);
  assert.equal(issueUrl('', ''), 'https://github.com/BurgiSimon/KIRO-Claude/issues/new');
});

test('diagnostic: JSON summary without secrets', async () => {
  const r = await run(t, ['diagnostic'], { env: { ANTHROPIC_API_KEY: 'sk-ant-SECRET', KIRO_API_KEY: 'ksk_SECRET', KIRO_LOG_LEVEL: 'debug', GITHUB_TOKEN: 'ghp_SECRET' } });
  assert.equal(r.code, 0);
  assert.ok(!r.stdout.includes('SECRET'));
  const d = JSON.parse(r.stdout) as Record<string, Record<string, unknown>>;
  assert.deepEqual(Object.keys(d), ['kiro-claude-details', 'system-info', 'environment', 'claude-code', 'env-vars']);
  assert.equal(d['kiro-claude-details']!.version, '0.1.0');
  assert.equal(d['claude-code']!.version, '2.1.318');
  assert.equal(d['claude-code']!['logged-in'], true);
  assert.deepEqual(d['claude-code']!['api-key-overrides'], ['ANTHROPIC_API_KEY']);
  assert.equal(d['env-vars']!.ANTHROPIC_API_KEY, '<set>');
  assert.equal(d['env-vars']!.KIRO_API_KEY, '<set>');
  assert.equal(d['env-vars']!.KIRO_LOG_LEVEL, 'debug');
  assert.equal(d['env-vars']!.GITHUB_TOKEN, undefined);
  const plain = await run(t, ['diagnostics', '--format', 'plain']);
  assert.match(plain.stdout, /^\[kiro-claude-details\]\nversion = "0\.1\.0"\n/);
  assert.match(plain.stdout, /\n\[env-vars\]\n/);
  const compact = await run(t, ['diagnostic', '-f', 'json']);
  assert.equal(compact.stdout.trim().split('\n').length, 1);
});

test('diagnostic helpers', () => {
  assert.equal(sanitizeUser('/home/alice/x:/home/alice', 'alice'), '/home/USER/x:/home/USER');
  assert.deepEqual(diagnosticEnvVars({ SHELL: '/bin/zsh', SECRET_THING: 'x', KIRO_HOME: '/k', KIRO_SESSION_TOKEN: 'abc', OTHER: 'y' }), {
    KIRO_HOME: '/k',
    KIRO_SESSION_TOKEN: '<set>',
    SHELL: '/bin/zsh',
  });
});

test('importOptional: a missing module gives a clear error', async () => {
  await assert.rejects(importOptional('./definitely-missing.js', 'x', import.meta.url), /definitely-missing\.js is not available in this build of kiro-claude/);
  await assert.rejects(importOptional('../../src/version.js', 'nope', import.meta.url), /does not export nope/);
  const v = await importOptional<() => string>('../../src/version.js', 'versionLine', import.meta.url);
  assert.equal(v(), versionLine());
});

test('acp / spec / crew are delegated to their modules (or reported unavailable)', async () => {
  for (const c of ['acp', 'spec', 'crew']) {
    const r = await run(t, [c, '--help']);
    if (r.code === 0) assert.ok(r.stdout.length > 0, c);
    else assert.match(r.stderr, /is not available in this build|error:/, c);
  }
});

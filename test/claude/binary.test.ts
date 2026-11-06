import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import {
  ClaudeNotFoundError,
  HIDDEN_FLAGS,
  capabilityCachePath,
  compareVersions,
  defaultCacheDir,
  findClaudeBinary,
  makeCapabilities,
  npmShimTarget,
  parseHelpFlags,
  parseVersion,
  probeCapabilities,
  quoteCmdArg,
  resolveSpawn,
  runCaptured,
  whichSync,
} from '../../src/claude/binary.js';
import { fakeBinary, fakeClaudePath, fakeEnv, mkTmp } from './helpers.js';

const isWin = process.platform === 'win32';

describe('parseVersion', () => {
  it('parses Claude Code version output', () => {
    assert.equal(parseVersion('2.1.318 (Claude Code)'), '2.1.318');
    assert.equal(parseVersion('2.1.318 (Claude Code)\n'), '2.1.318');
    assert.equal(parseVersion('claude v1.0.44'), '1.0.44');
    assert.equal(parseVersion('3.0.0-beta.2 (Claude Code)'), '3.0.0-beta.2');
    assert.equal(parseVersion('2.1'), '2.1');
  });
  it('returns undefined without a version', () => {
    assert.equal(parseVersion(''), undefined);
    assert.equal(parseVersion('Claude Code'), undefined);
    assert.equal(parseVersion('error: unknown option'), undefined);
  });
});

describe('compareVersions', () => {
  const cases: Array<[string, string, number]> = [
    ['2.1.318', '2.1.318', 0],
    ['2.1.318', '2.1.317', 1],
    ['2.1.9', '2.1.10', -1],
    ['2.10.0', '2.9.99', 1],
    ['10.0.0', '9.9.9', 1],
    ['2.1', '2.1.0', 0],
    ['2', '2.0.1', -1],
    ['v2.1.0', '2.1.0', 0],
    ['2.1.0-beta', '2.1.0', -1],
    ['2.1.0', '2.1.0-rc.1', 1],
    ['2.1.0-alpha', '2.1.0-beta', -1],
    ['2.1.0-rc.2', '2.1.0-rc.10', -1],
    ['2.1.0-1', '2.1.0-alpha', -1],
    ['2.1.0-rc', '2.1.0-rc.1', -1],
    ['2.1.0+build5', '2.1.0+build9', 0],
    ['garbage', '0.0.0', 0],
  ];
  for (const [a, b, want] of cases) {
    it(`${a} vs ${b} = ${want}`, () => {
      assert.equal(compareVersions(a, b), want);
      assert.equal(compareVersions(b, a), -want || 0);
    });
  }
  it('sorts', () => {
    assert.deepEqual(['2.1.10', '2.0.0', '2.1.9', '2.1.10-beta'].sort(compareVersions), ['2.0.0', '2.1.9', '2.1.10-beta', '2.1.10']);
  });
});

describe('parseHelpFlags', () => {
  const help = [
    'Usage: claude [options] [command] [prompt]',
    '',
    'Options:',
    '  --add-dir <directories...>            Additional directories to allow tool',
    '  --allowedTools, --allowed-tools <tools...>',
    '      Comma or space-separated list of tool names to allow (e.g. "Bash(git *)',
    '  --bare                                Minimal mode: ... Explicitly provide context',
    '                                        via: --system-prompt[-file],',
    '                                        --append-system-prompt[-file], --add-dir',
    '  -c, --continue                        Continue the most recent conversation',
    '  --permission-prompts <target>         Who answers: "host" (the SDK host or',
    '                                        --permission-prompt-tool) or "none"',
    '  -h, --help                            Display help for command',
    '  -v, --version                         Output the version number',
    '',
    'Commands:',
    '  respawn [options] [id]                Restart a background session, or all of',
    '                                        them with --all, so it runs',
  ].join('\n');

  it('collects option definitions only', () => {
    const flags = parseHelpFlags(help);
    for (const f of ['--add-dir', '--allowedTools', '--allowed-tools', '--bare', '--continue', '--permission-prompts', '--help', '--version']) {
      assert.ok(flags.has(f), f);
    }
    assert.equal(flags.has('--permission-prompt-tool'), false);
    assert.equal(flags.has('--all'), false);
    assert.equal(flags.has('--system-prompt'), false);
    assert.equal(flags.has('--append-system-prompt'), false);
  });

  it('handles CRLF', () => {
    const flags = parseHelpFlags(help.replace(/\n/g, '\r\n'));
    assert.ok(flags.has('--add-dir'));
  });

  it('falls back to loose tokens for unknown formats', () => {
    const flags = parseHelpFlags('Flags: --foo, --bar-baz and [--qux]');
    assert.deepEqual([...flags].sort(), ['--bar-baz', '--foo', '--qux']);
  });

  it('parses the real 2.1.318 help text served by fake-claude', async () => {
    const r = await runCaptured(fakeClaudePath(), ['--help'], { env: fakeEnv(), timeoutMs: 15000 });
    assert.equal(r.code, 0);
    const flags = parseHelpFlags(r.stdout);
    for (const f of [
      '--print', '--input-format', '--output-format', '--verbose', '--include-partial-messages', '--permission-mode',
      '--setting-sources', '--strict-mcp-config', '--mcp-config', '--tools', '--disallowedTools', '--model', '--effort',
      '--agents', '--plugin-dir', '--add-dir', '--resume', '--fork-session', '--session-id', '--system-prompt-snapshot',
      '--append-system-prompt', '--no-session-persistence', '--replay-user-messages',
    ]) {
      assert.ok(flags.has(f), f);
    }
    for (const f of ['--permission-prompt-tool', '--append-system-prompt-file', '--resume-session-at', '--all', '--hard-fail']) {
      assert.equal(flags.has(f), false, f);
    }
  });
});

describe('makeCapabilities', () => {
  it('adds hidden flags by version and normalises names', () => {
    const caps = makeCapabilities('2.1.318', ['--model', 'verbose']);
    assert.ok(caps.has('--model'));
    assert.ok(caps.has('model'));
    assert.ok(caps.has('--verbose'));
    for (const h of HIDDEN_FLAGS) assert.ok(caps.has(h.flag), h.flag);
    assert.equal(caps.has('--nope'), false);
    assert.equal(caps.version, '2.1.318');
  });
  it('only --permission-prompt-tool for 2.0.x', () => {
    const caps = makeCapabilities('2.0.5', []);
    assert.ok(caps.has('--permission-prompt-tool'));
    assert.equal(caps.has('--resume-session-at'), false);
    assert.equal(caps.has('--append-system-prompt-file'), false);
  });
  it('no hidden flags before 2.0', () => {
    assert.equal(makeCapabilities('1.0.99', []).has('--permission-prompt-tool'), false);
  });
  it('help-listed flags count regardless of version', () => {
    assert.ok(makeCapabilities('1.0.0', ['--resume-session-at']).has('--resume-session-at'));
  });
});

describe('probeCapabilities', () => {
  it('probes --help and writes a per-version cache', async () => {
    const cacheDir = mkTmp();
    const caps = await probeCapabilities(fakeBinary(), { cacheDir, env: fakeEnv() });
    assert.ok(caps.has('--print'));
    assert.ok(caps.has('--permission-prompt-tool'));
    const file = capabilityCachePath(cacheDir, '2.1.318');
    assert.equal(path.basename(file), 'claude-2.1.318.json');
    const cached = JSON.parse(fs.readFileSync(file, 'utf8')) as { version: string; flags: string[] };
    assert.equal(cached.version, '2.1.318');
    assert.ok(cached.flags.includes('--print'));
    assert.equal(cached.flags.includes('--permission-prompt-tool'), false, 'hidden flags are not cached');
  });

  it('uses the cache without running the binary', async () => {
    const cacheDir = mkTmp();
    fs.writeFileSync(capabilityCachePath(cacheDir, '9.9.9'), JSON.stringify({ version: '9.9.9', flags: ['--only-cached'] }));
    const bin = { path: path.join(cacheDir, 'does-not-exist'), version: '9.9.9', rawVersion: '9.9.9' };
    const caps = await probeCapabilities(bin, { cacheDir });
    assert.ok(caps.has('--only-cached'));
  });

  it('re-probes on a corrupt or mismatched cache, and with refresh', async () => {
    const cacheDir = mkTmp();
    const file = capabilityCachePath(cacheDir, '2.1.318');
    fs.writeFileSync(file, '{not json');
    let caps = await probeCapabilities(fakeBinary(), { cacheDir, env: fakeEnv() });
    assert.ok(caps.has('--print'));
    fs.writeFileSync(file, JSON.stringify({ version: '1.0.0', flags: ['--x'] }));
    caps = await probeCapabilities(fakeBinary(), { cacheDir, env: fakeEnv() });
    assert.equal(caps.has('--x'), false);
    fs.writeFileSync(file, JSON.stringify({ version: '2.1.318', flags: ['--stale'] }));
    caps = await probeCapabilities(fakeBinary(), { cacheDir, env: fakeEnv(), refresh: true });
    assert.equal(caps.has('--stale'), false);
    assert.ok(caps.has('--print'));
  });

  it('returns hidden flags only when --help fails, without caching', async () => {
    const cacheDir = mkTmp();
    const bin = { path: path.join(cacheDir, 'missing-claude'), version: '2.1.318', rawVersion: '' };
    const caps = await probeCapabilities(bin, { cacheDir });
    assert.ok(caps.has('--permission-prompt-tool'));
    assert.equal(caps.has('--print'), false);
    assert.equal(fs.existsSync(capabilityCachePath(cacheDir, '2.1.318')), false);
  });

  it('defaultCacheDir honours an absolute KIRO_HOME only', () => {
    assert.equal(defaultCacheDir({ KIRO_HOME: '/k', HOME: '/h' }), path.join('/k', 'kiro-claude', 'cache'));
    assert.equal(defaultCacheDir({ KIRO_HOME: 'rel/k', HOME: '/h' }), path.join('/h', '.kiro', 'kiro-claude', 'cache'));
    assert.equal(defaultCacheDir({ HOME: '/h' }), path.join('/h', '.kiro', 'kiro-claude', 'cache'));
  });

  it('sanitises the version in the cache file name', () => {
    assert.equal(path.basename(capabilityCachePath('/c', '2.1.0/../x')), 'claude-2.1.0_.._x.json');
  });
});

describe('resolveSpawn', () => {
  it('runs .mjs/.js/.cjs scripts under node', () => {
    for (const p of ['/x/fake.mjs', '/x/fake.js', '/x/fake.cjs']) {
      const s = resolveSpawn(p, ['--version'], 'linux');
      assert.equal(s.command, process.execPath);
      assert.deepEqual(s.args, [p, '--version']);
    }
  });
  it('spawns executables directly', () => {
    assert.deepEqual(resolveSpawn('/usr/bin/claude', ['-p'], 'linux'), { command: '/usr/bin/claude', args: ['-p'] });
    assert.deepEqual(resolveSpawn('C:\\x\\claude.exe', ['-p'], 'win32'), { command: 'C:\\x\\claude.exe', args: ['-p'] });
  });
  it('wraps unknown .cmd shims in cmd.exe with quoting', () => {
    const s = resolveSpawn('C:\\no\\such\\claude.cmd', ['--mcp-config', '{"a":"b c"}'], 'win32');
    assert.equal(s.windowsVerbatimArguments, true);
    assert.deepEqual(s.args.slice(0, 3), ['/d', '/s', '/c']);
    assert.match(s.args[3]!, /^".*"$/);
    assert.ok(s.args[3]!.includes('claude.cmd'));
  });
  it('unwraps npm .cmd shims to node + script', () => {
    const dir = mkTmp();
    const script = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, '');
    const shim = path.join(dir, 'claude.cmd');
    fs.writeFileSync(shim, '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n');
    if (isWin) {
      const s = resolveSpawn(shim, ['-p'], 'win32');
      assert.equal(s.command, process.execPath);
      assert.deepEqual(s.args, [script, '-p']);
    } else {
      // path.join uses '/' here; just check the shim target extraction.
      assert.equal(npmShimTarget(shim, fs.readFileSync(shim, 'utf8')), path.join(dir, 'node_modules/@anthropic-ai/claude-code/cli.js'));
    }
  });
  it('npmShimTarget returns undefined for non-shims', () => {
    assert.equal(npmShimTarget('/x/claude.cmd', '@echo hi'), undefined);
  });
  it('quoteCmdArg escapes quotes and metacharacters', () => {
    assert.equal(quoteCmdArg('a b', false), '^"a^ b^"');
    assert.equal(quoteCmdArg('say "hi"', false), '^"say^ \\^"hi\\^"^"');
    assert.equal(quoteCmdArg('x\\', false), '^"x\\\\^"');
    assert.ok(quoteCmdArg('a&b').includes('^^^&'));
  });
});

describe('whichSync', () => {
  it('finds an executable on PATH', { skip: isWin }, () => {
    const dir = mkTmp();
    const exe = path.join(dir, 'claude');
    fs.writeFileSync(exe, '#!/bin/sh\necho 1.2.3\n');
    fs.chmodSync(exe, 0o755);
    const nonExec = path.join(dir, 'claude-noexec');
    fs.writeFileSync(nonExec, '');
    assert.equal(whichSync('claude', { PATH: `/nonexistent${path.delimiter}${dir}` }), exe);
    assert.equal(whichSync('claude-noexec', { PATH: dir }), undefined);
    assert.equal(whichSync('claude', { PATH: '' }), undefined);
    assert.equal(whichSync('./claude', { PATH: dir }), undefined);
  });
  it('honours PATHEXT on win32', () => {
    const dir = mkTmp();
    fs.writeFileSync(path.join(dir, 'claude.CMD'), '');
    const found = whichSync('claude', { PATH: dir, PATHEXT: '.EXE;.CMD' }, 'win32');
    assert.ok(found && found.toLowerCase().endsWith('claude.cmd'), String(found));
    assert.equal(whichSync('claude', { PATH: dir, PATHEXT: '.EXE' }, 'win32'), undefined);
  });
});

describe('findClaudeBinary', () => {
  it('uses explicitPath and parses the version', async () => {
    const bin = await findClaudeBinary({ explicitPath: fakeClaudePath(), env: fakeEnv() });
    assert.equal(bin.path, fakeClaudePath());
    assert.equal(bin.version, '2.1.318');
    assert.equal(bin.rawVersion, '2.1.318 (Claude Code)');
  });

  it('uses $KIRO_CLAUDE_BIN', async () => {
    const bin = await findClaudeBinary({ env: fakeEnv({ KIRO_CLAUDE_BIN: fakeClaudePath(), FAKE_CLAUDE_VERSION: '2.2.0' }) });
    assert.equal(bin.version, '2.2.0');
  });

  it('explicitPath wins over $KIRO_CLAUDE_BIN', async () => {
    const bin = await findClaudeBinary({ explicitPath: fakeClaudePath(), env: fakeEnv({ KIRO_CLAUDE_BIN: '/nonexistent/claude' }) });
    assert.equal(bin.path, fakeClaudePath());
  });

  it('a broken explicit binary is an error (no silent fallback)', async () => {
    await assert.rejects(
      findClaudeBinary({ env: fakeEnv({ KIRO_CLAUDE_BIN: '/nonexistent/claude-xyz' }) }),
      (e: unknown) => e instanceof ClaudeNotFoundError && /KIRO_CLAUDE_BIN/.test(e.message) && e.tried.length === 1,
    );
  });

  it('rejects a binary whose --version has no version', async () => {
    const dir = mkTmp();
    const bad = path.join(dir, 'bad.mjs');
    fs.writeFileSync(bad, 'console.log("hello");\n');
    await assert.rejects(findClaudeBinary({ explicitPath: bad, env: fakeEnv() }), ClaudeNotFoundError);
    const failing = path.join(dir, 'failing.mjs');
    fs.writeFileSync(failing, 'console.error("boom"); process.exit(3);\n');
    await assert.rejects(findClaudeBinary({ explicitPath: failing, env: fakeEnv() }), /exit 3.*boom/);
  });

  it('finds claude on PATH', { skip: isWin }, async () => {
    const dir = mkTmp();
    const link = path.join(dir, 'claude');
    fs.symlinkSync(fakeClaudePath(), link);
    const bin = await findClaudeBinary({ env: fakeEnv({ PATH: `${dir}${path.delimiter}${process.env.PATH ?? ''}`, KIRO_CLAUDE_BIN: undefined }) });
    assert.equal(bin.path, link);
    assert.equal(bin.version, '2.1.318');
  });

  it('falls back to well-known locations under HOME', { skip: isWin }, async () => {
    const home = mkTmp();
    const local = path.join(home, '.local', 'bin');
    fs.mkdirSync(local, { recursive: true });
    fs.symlinkSync(fakeClaudePath(), path.join(local, 'claude'));
    // PATH must still provide `node` for the fake's shebang, but no `claude`.
    const nodeOnly = mkTmp();
    fs.symlinkSync(process.execPath, path.join(nodeOnly, 'node'));
    const bin = await findClaudeBinary({ env: fakeEnv({ HOME: home, PATH: nodeOnly, KIRO_CLAUDE_BIN: undefined }) });
    // ~/.claude/local/claude does not exist, so ~/.local/bin/claude is the first hit unless a
    // system-wide install exists earlier in the list (it cannot: ~/.local/bin precedes /opt).
    assert.equal(bin.path, path.join(local, 'claude'));
  });

  it('throws ClaudeNotFoundError listing what was tried', async () => {
    const home = mkTmp();
    try {
      await findClaudeBinary({ env: { HOME: home, PATH: home } });
      // A system-wide install at a well-known location may legitimately be found.
    } catch (e) {
      assert.ok(e instanceof ClaudeNotFoundError);
      assert.match(e.message, /not found/);
      assert.ok(e.tried.some((t) => t.includes('PATH')));
      assert.ok(e.tried.some((t) => t.includes(path.join(home, '.claude', 'local'))));
    }
  });
});

describe('runCaptured', () => {
  it('reports spawn errors without throwing', async () => {
    const r = await runCaptured('/nonexistent/bin-xyz', []);
    assert.ok(r.error);
    assert.equal(r.code, null);
  });
  it('kills on timeout', async () => {
    const dir = mkTmp();
    const slow = path.join(dir, 'slow.mjs');
    fs.writeFileSync(slow, 'setTimeout(() => {}, 60000);\n');
    const t0 = Date.now();
    const r = await runCaptured(slow, [], { timeoutMs: 200 });
    assert.equal(r.timedOut, true);
    assert.ok(Date.now() - t0 < 10000);
  });
});

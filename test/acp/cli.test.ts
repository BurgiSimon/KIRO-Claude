/**
 * `kiro-claude acp` launch surface: help golden (05 §2.2, 08 KC-CLI-02), clap-style flag errors
 * (08 KC-CLI-10: `--agent-engine v3` ⇒ exit 2), flag parsing (05 §2.1).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { ACP_HELP_TEXT, parseAcpFlags, runAcp, runAcpCommand } from '../../src/acp/server.js';
import { createWorkspaceContext } from '../../src/config/workspace.js';
import { openSettings } from '../../src/config/settings.js';
import type { CliContext } from '../../src/types.js';
import { kiroCrewAgentEngines, tmpEnv } from './helpers.js';

const GOLDEN_HELP = [
  'Run kiro-claude as an Agent Client Protocol (ACP) agent over stdio',
  '',
  'Usage: kiro-claude acp [OPTIONS]',
  '',
  'Options:',
  '      --agent-engine <ENGINE>',
  '          Agent harness (accepted for compatibility; kiro-claude has one engine)',
  '',
  '          [possible values: v1, v2]',
  '',
  '      --auth-method <METHOD>',
  '          Accepted for compatibility; Claude Code owns authentication',
  '',
  '          [possible values: cli, client]',
  '',
  '      --login',
  '          Sign in to Claude Code in this terminal, then exit',
  '',
  '      --agent <AGENT>',
  '          Agent to start sessions with',
  '',
  '      --model <MODEL>',
  '          Model for new sessions',
  '',
  '      --effort <LEVEL>',
  '          Initial reasoning effort',
  '',
  '          [possible values: low, medium, high, xhigh, max]',
  '',
  '  -a, --trust-all-tools',
  '          Allow every tool without confirmation',
  '',
  '      --trust-tools <TOOLS>',
  '          Comma-separated tools to allow without confirmation',
  '',
  '  -v, --verbose...',
  '          Increase logging verbosity',
  '',
  '  -h, --help',
  '          Print help',
  '',
].join('\n');

function ctxWithStreams(): { ctx: CliContext; out: () => string; err: () => string } {
  const t = tmpEnv();
  const ws = createWorkspaceContext(t.work, t.env);
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  let o = '';
  let e = '';
  stdout.on('data', (c: Buffer) => (o += c.toString()));
  stderr.on('data', (c: Buffer) => (e += c.toString()));
  stdin.end();
  return {
    ctx: {
      ws,
      settings: openSettings(ws),
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
      progName: 'kiro-claude',
      verbosity: 0,
    },
    out: () => o,
    err: () => e,
  };
}

test('acp --help is the 05 §2.2 text verbatim', async () => {
  assert.equal(ACP_HELP_TEXT, GOLDEN_HELP);
  const c = ctxWithStreams();
  assert.equal(await runAcpCommand(['--help'], c.ctx), 0);
  assert.equal(c.out(), GOLDEN_HELP);
  const c2 = ctxWithStreams();
  assert.equal(await runAcpCommand(['-h'], c2.ctx), 0);
  assert.equal(c2.out(), GOLDEN_HELP);
});

test('help passes KiroCrew probes: engines (v1, v2), no v3 anywhere, clap 6-space layout', () => {
  assert.deepEqual(kiroCrewAgentEngines(ACP_HELP_TEXT), ['v1', 'v2']);
  assert.equal(ACP_HELP_TEXT.includes('v3'), false);
  assert.equal(ACP_HELP_TEXT.includes('V3'), false);
  assert.ok(ACP_HELP_TEXT.includes('--agent-engine'));
  assert.ok(ACP_HELP_TEXT.includes('\n      --agent-engine <ENGINE>\n'));
  // the block KiroCrew cuts ends at the next "\n      --"
  const block = ACP_HELP_TEXT.slice(ACP_HELP_TEXT.indexOf('--agent-engine'));
  assert.ok(block.indexOf('\n      --auth-method') > block.indexOf('[possible values: v1, v2]'));
});

test('--agent-engine v3 exits 2 with the clap-style error (08 KC-CLI-10)', async () => {
  const c = ctxWithStreams();
  const t0 = Date.now();
  assert.equal(await runAcpCommand(['--agent-engine', 'v3', '--auth-method', 'cli'], c.ctx), 2);
  assert.ok(Date.now() - t0 < 500);
  assert.equal(c.err(), "error: invalid value 'v3' for '--agent-engine <ENGINE>'\n  [possible values: v1, v2]\n\nkiro-claude has no v3 (KAS) agent engine.\n");
  assert.equal(c.out(), '');
  const c2 = ctxWithStreams();
  assert.equal(await runAcpCommand(['--agent-engine=v3'], c2.ctx), 2);
});

test('flag errors are clap-style with exit 2', async () => {
  const cases: Array<[string[], RegExp]> = [
    [['--agent-engine', 'v9'], /^error: invalid value 'v9' for '--agent-engine <ENGINE>'\n {2}\[possible values: v1, v2\]\n\nFor more information, try '--help'\.\n$/],
    [['--effort', 'ultra'], /invalid value 'ultra' for '--effort <LEVEL>'\n {2}\[possible values: low, medium, high, xhigh, max\]/],
    [['--auth-method', 'browser'], /invalid value 'browser' for '--auth-method <METHOD>'/],
    [['--bogus'], /^error: unexpected argument '--bogus' found\n\nUsage: kiro-claude acp \[OPTIONS\]\n\nFor more information, try '--help'\.\n$/],
    [['-x'], /unexpected argument '-x' found/],
    [['extra'], /unexpected argument 'extra' found/],
    [['--agent'], /^error: a value is required for '--agent <AGENT>' but none was supplied\n\nFor more information, try '--help'\.\n$/],
    [['--model', '--agent', 'x'], /a value is required for '--model <MODEL>'/],
    [['--login=yes'], /unexpected argument '--login=yes' found/],
  ];
  for (const [args, re] of cases) {
    const c = ctxWithStreams();
    assert.equal(await runAcpCommand(args, c.ctx), 2, args.join(' '));
    assert.match(c.err(), re, args.join(' '));
    assert.equal(c.out(), '', 'nothing on stdout');
  }
});

test('flag parsing table (05 §2.1)', () => {
  const ok = (args: string[]) => {
    const r = parseAcpFlags(args);
    assert.ok(r.ok, args.join(' '));
    return r.flags;
  };
  assert.deepEqual(ok(['--agent-engine', 'v2', '--agent', 'kirocrew-skill-view-ec2d', '--model', 'claude-haiku-5.5']), {
    agent: 'kirocrew-skill-view-ec2d',
    model: 'claude-haiku-5.5',
    agentEngine: 'v2',
    trustAllTools: false,
    trustTools: [],
    login: false,
    verbose: 0,
    help: false,
  });
  assert.equal(ok(['--agent-engine=v1']).agentEngine, 'v1');
  assert.equal(ok(['--agent=probe']).agent, 'probe');
  assert.equal(ok(['-a']).trustAllTools, true);
  assert.equal(ok(['--trust-all-tools']).trustAllTools, true);
  const f = ok(['-avv']);
  assert.equal(f.trustAllTools, true);
  assert.equal(f.verbose, 2);
  assert.equal(ok(['--verbose', '-v']).verbose, 2);
  assert.deepEqual(ok(['--trust-tools', 'fs_read, execute_bash,,@srv/tool']).trustTools, ['fs_read', 'execute_bash', '@srv/tool']);
  assert.deepEqual(ok(['--trust-tools=a', '--trust-tools', 'b']).trustTools, ['a', 'b']);
  assert.equal(ok(['--auth-method', 'cli']).authMethod, 'cli');
  assert.equal(ok(['--authMethod=client']).authMethod, 'client');
  assert.equal(ok(['--effort', 'xhigh']).effort, 'xhigh');
  assert.equal(ok(['--login']).login, true);
  assert.equal(ok(['--help']).help, true);
  assert.equal(ok(['--']).help, false);
});

test('--login runs `claude auth login --claudeai` and returns its exit code', async () => {
  const c = ctxWithStreams();
  // fake-claude: auth login writes to stderr (inherited) and exits FAKE_CLAUDE_AUTH_EXIT
  c.ctx.ws.env.FAKE_CLAUDE_AUTH_EXIT = '3';
  assert.equal(await runAcp(['--login'], c.ctx), 3);
  const c2 = ctxWithStreams();
  c2.ctx.ws.env.KIRO_CLAUDE_BIN = '/nonexistent/claude';
  assert.equal(await runAcp(['--login'], c2.ctx), 1);
  assert.match(c2.err(), /^error: /);
});

test('stdin EOF with no traffic exits 0 and writes nothing to stdout', async () => {
  const c = ctxWithStreams();
  assert.equal(await runAcpCommand(['--agent-engine', 'v2', '--agent', 'x'], c.ctx), 0);
  assert.equal(c.out(), '');
});

/**
 * Adversarial review tests for the cli + headless modules (research 01 §1–3, 08 §2.2, 08a §2).
 * Each block names the behaviour it pins; several cover bugs fixed during the review:
 *  - `agent edit` validated the temporary copy, so a relative `file://` prompt (resolved next to
 *    the agent file) was reported missing and every edit of such an agent was refused;
 *  - `--delete-session` left the kiro-cli journal `<sid>.jsonl` behind;
 *  - `-v --version` ignored `-v` (01 §1.1: also print the backing Claude Code version);
 *  - `chat -v` did not reach the front ends' CliContext.verbosity;
 *  - `diagnostic` printed credentials embedded in URLs of reported variables;
 *  - `mcp list default` matched no section.
 */
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Writable } from 'node:stream';

import { UsageError, parseArgs, renderHelp, type CommandDef } from '../../src/cli/args.js';
import { scanRoot } from '../../src/cli/main.js';
import { CHAT_DEF, runChatCommand } from '../../src/cli/commands/chat.js';
import { diagnosticEnvVars, redactUrlCredentials } from '../../src/cli/commands/misc.js';
import { validateAgentFileText } from '../../src/cli/commands/agent.js';
import { openInEditor } from '../../src/cli/io.js';
import { runHeadless } from '../../src/headless/run.js';
import { SessionStore, sessionsDir } from '../../src/session/store.js';
import type { CliContext, KiroSession, SessionEvent } from '../../src/types.js';
import { MockSession, mockFactory, type MockScript } from '../headless/mockSession.js';
import { makeCtx, makeEnv, run, type TestEnv } from './helpers.js';

let t: TestEnv;
beforeEach(() => {
  t = makeEnv();
});
afterEach(() => t.cleanup());

const globalAgents = (): string => path.join(t.kiroHome, 'agents');

/** An $EDITOR command that overwrites the file with `content`. */
function editorWriting(content: string): string {
  const script = t.write(`editor-${Math.random().toString(36).slice(2)}.mjs`, `import fs from 'node:fs';\nfs.writeFileSync(process.argv[2], ${JSON.stringify(content)});\n`);
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
}

/** kiro_crew.kiro_cli.chat_agent_engines (verbatim port). */
function chatAgentEngines(help: string): string[] {
  const at = help.indexOf('--agent-engine');
  if (at < 0) return [];
  const end = help.indexOf('\n      --', at + 1);
  const block = help.slice(at, end > 0 ? end : undefined);
  const m = /\[possible values:\s*([^\]]*)\]/.exec(block);
  return m ? m[1]!.split(',').map((s) => s.trim()).filter(Boolean) : [];
}

// ───────────────────────────── parser ─────────────────────────────

const DEF: CommandDef = {
  name: 'x',
  args: [
    { id: 'agent', long: 'agent', kind: 'value', valueName: 'AGENT' },
    { id: 'format', long: 'format', short: 'f', kind: 'value', valueName: 'FORMAT', possibleValues: ['plain', 'json'] },
    { id: 'all', long: 'all', short: 'a', kind: 'bool' },
    { id: 'verbose', long: 'verbose', short: 'v', kind: 'count' },
    { id: 'args', long: 'args', kind: 'value', multiple: true, allowHyphenValues: true },
  ],
  positionals: [{ id: 'input', valueName: 'INPUT' }],
};

test('review: parser accepts clap value spellings', () => {
  const table: Array<[string[], (p: ReturnType<typeof parseArgs>) => void]> = [
    [['-f=json'], (p) => assert.equal(p.value('format'), 'json')],
    [['-fjson'], (p) => assert.equal(p.value('format'), 'json')],
    [['-af', 'json'], (p) => (assert.equal(p.value('format'), 'json'), assert.equal(p.count('all'), 1))],
    [['--agent='], (p) => assert.equal(p.value('agent'), '')],
    [['--agent', ''], (p) => assert.equal(p.value('agent'), '')],
    [['--args', '-y', '--args=--flag'], (p) => assert.deepEqual(p.valuesOf('args'), ['-y', '--flag'])],
    [['-'], (p) => assert.equal(p.pos('input'), '-')],
    [['--', '-a'], (p) => (assert.equal(p.pos('input'), '-a'), assert.equal(p.count('all'), 0))],
    [['-vvv', '-v'], (p) => assert.equal(p.count('verbose'), 4)],
  ];
  for (const [argv, check] of table) check(parseArgs(DEF, argv, 'kc'));
});

test('review: parser rejects with clap wording and exit 2', () => {
  const table: Array<[string[], RegExp]> = [
    [['--format', 'JSON'], /^error: invalid value 'JSON' for '--format <FORMAT>'\n {2}\[possible values: plain, json\]\n\nFor more information, try '--help'\.$/],
    [['--agent', '--all'], /^error: a value is required for '--agent <AGENT>' but none was supplied/],
    [['--agent'], /^error: a value is required for '--agent <AGENT>' but none was supplied/],
    [['-aZ'], /^error: unexpected argument '-Z' found/],
    [['--verbose=2'], /^error: unexpected value '2' for '--verbose' found; no more were expected/],
    [['--agent', 'a', '--agent', 'b'], /^error: the argument '--agent <AGENT>' cannot be used multiple times/],
    [['--all', '--all'], /^error: the argument '--all' cannot be used multiple times/],
    [['one', 'two'], /^error: unexpected argument 'two' found\n\nUsage: kc x \[OPTIONS\] \[INPUT\]/],
    [['--agnet', 'x'], /tip: a similar argument exists: '--agent'/],
  ];
  for (const [argv, want] of table) {
    assert.throws(
      () => parseArgs(DEF, argv, 'kc'),
      (e: unknown) => e instanceof UsageError && e.exitCode === 2 && want.test(e.message),
      argv.join(' '),
    );
  }
});

test('review: chat -h (short layout) is also KiroCrew-parsable and v3-free', () => {
  for (const mode of ['short', 'long'] as const) {
    const h = renderHelp(CHAT_DEF, 'kiro-claude', mode);
    assert.deepEqual(chatAgentEngines(h), ['v1', 'v2'], mode);
    assert.ok(!h.includes('v3'), mode);
  }
});

// ───────────────────────────── root scan ─────────────────────────────

test('review: scanRoot separates root flags, chat flags and the subcommand', () => {
  const a = scanRoot(['-vv', '--agent', 'x', 'chat', '--no-interactive', 'hi']);
  assert.equal(a.verbose, 2);
  assert.equal(a.command, 'chat');
  assert.deepEqual(a.chatFlags, ['--agent', 'x']);
  assert.deepEqual(a.args, ['--no-interactive', 'hi']);
  // a value flag consumes a token that looks like a command
  const b = scanRoot(['--agent', 'help']);
  assert.equal(b.command, undefined);
  assert.deepEqual(b.args, ['--agent', 'help']);
  const c = scanRoot(['--trust-tools', 'agent', 'go']);
  assert.equal(c.command, undefined);
  assert.deepEqual(c.args, ['--trust-tools', 'agent', 'go']);
  // after the first positional everything belongs to chat (incl. -v)
  const d = scanRoot(['hello', '-v']);
  assert.equal(d.verbose, 0);
  assert.deepEqual(d.args, ['hello', '-v']);
  // `--` ends root parsing; the rest is chat input
  const e = scanRoot(['--', 'agent']);
  assert.equal(e.command, undefined);
  assert.deepEqual(e.args, ['--', 'agent']);
  // -fjson is one token (value attached), the next token is not consumed
  const f = scanRoot(['-fjson', '--list-models']);
  assert.deepEqual(f.args, ['-fjson', '--list-models']);
});

test('review: -v --version adds the Claude Code line; plain --version stays one line (KC-CLI-01)', async () => {
  const plain = await run(t, ['--version']);
  assert.equal(plain.stdout, 'kiro-claude 0.1.0 (kiro-cli 1.26.0)\n');
  const v = await run(t, ['-v', '-V']);
  assert.equal(v.code, 0);
  const lines = v.stdout.trimEnd().split('\n');
  assert.equal(lines[0], 'kiro-claude 0.1.0 (kiro-cli 1.26.0)');
  assert.match(lines[1] ?? '', /^Claude Code 2\.1\.318 \(/);
});

test('review: version --changelog takes a space-separated value like clap num_args(0..=1)', async () => {
  const all = await run(t, ['version', '--changelog', 'all']);
  assert.equal(all.code, 0, all.stderr);
  assert.match(all.stdout, /^Changelog for all versions:\nVersion 0\.1\.0 \(/);
  const v = await run(t, ['version', '--changelog', '9.9.9']);
  assert.equal(v.stdout, 'No changelog information available for version 9.9.9.\n');
  const cur = await run(t, ['version', '--changelog', '-v']);
  assert.match(cur.stdout, /^Changelog for version 0\.1\.0:\n/);
});

test('review: openInEditor quotes the path for the platform shell', () => {
  const rec = path.join(t.root, 'argv.txt');
  const script = t.write('rec.mjs', `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(rec)}, process.argv[2]);\n`);
  const env = { ...t.env, EDITOR: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}` };
  const target = path.join(t.root, "dir with 'quote' and space", 'a.json');
  for (const platform of ['linux', 'win32'] as const) {
    fs.rmSync(rec, { force: true });
    const file = platform === 'win32' ? path.join(t.root, 'dir with space', 'a.json') : target;
    assert.equal(openInEditor(file, env, platform).code, 0, platform);
    assert.equal(fs.readFileSync(rec, 'utf8'), file, platform);
  }
});

test('review: unknown root command text is chat input; Kiro desktop commands exit 1', async () => {
  const r = await run(t, ['translate', 'x']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not supported in kiro-claude/);
  assert.equal(r.stdout, '');
});

// ───────────────────────────── chat ─────────────────────────────

test('review: --delete-session also removes the kiro-cli journal, nothing else', async () => {
  const { ctx } = makeCtx(t);
  const store = new SessionStore(sessionsDir(ctx.ws));
  const a = store.create({ origin: 'headless', cwd: t.cwd, agent: 'kiro_default', model: 'auto' });
  const b = store.create({ origin: 'headless', cwd: t.cwd, agent: 'kiro_default', model: 'auto' });
  const ja = path.join(store.dir, `${a.sessionId}.jsonl`);
  const jb = path.join(store.dir, `${b.sessionId}.jsonl`);
  fs.writeFileSync(ja, '{"version":1,"kind":"Prompt"}\n');
  fs.writeFileSync(jb, '{"version":1,"kind":"Prompt"}\n');
  const transcript = t.write(path.join('claude', 'projects', 'p', `${a.claudeSessionId}.jsonl`), '{}\n');
  const r = await run(t, ['chat', '--delete-session', a.sessionId]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!fs.existsSync(ja), 'journal of the deleted session removed');
  assert.ok(!fs.existsSync(path.join(store.dir, `${a.sessionId}.json`)));
  assert.ok(fs.existsSync(jb), 'other sessions untouched');
  assert.ok(fs.existsSync(transcript), 'Claude transcripts are never touched');
  // a traversal id never reaches the file system
  const evil = await run(t, ['chat', '--delete-session', `../${b.sessionId}`]);
  assert.equal(evil.code, 1);
  assert.ok(fs.existsSync(jb));
});

test('review: chat -v raises CliContext.verbosity for the front ends', async () => {
  const seen: number[] = [];
  const { ctx } = makeCtx(t);
  const deps = {
    runHeadless: async (o: { ctx: CliContext }) => (seen.push(o.ctx.verbosity), 0),
    runRepl: async (o: { ctx: CliContext }) => (seen.push(o.ctx.verbosity), 0),
  };
  assert.equal(await runChatCommand(['-vv', '--no-interactive', 'hi'], ctx, deps), 0);
  assert.equal(await runChatCommand(['-v', 'hi'], { ...ctx, verbosity: 1 }, deps), 0);
  assert.equal(await runChatCommand(['hi'], ctx, deps), 0);
  assert.deepEqual(seen, [2, 2, 0]);
});

test('review: /usage probe variants never resolve the agent or start a session', async () => {
  for (const argv of [
    ['chat', '--no-interactive', '--agent', 'missing-agent', '  /usage  '],
    ['--no-interactive', '--agent-engine', 'v1', '--agent', 'missing-agent', '/usage'],
    ['chat', '--non-interactive', '--agent=missing-agent', '/usage'],
  ]) {
    const r = await run(t, argv);
    assert.equal(r.code, 0, `${argv.join(' ')}: ${r.stderr}`);
    assert.equal(r.stdout, 'Claude Code subscription usage is not reported as Kiro credits. Run /usage inside kiro-claude chat.\n');
    assert.ok(!r.stdout.includes('Estimated Usage'));
  }
  assert.equal(t.fakeLogLines().length, 0, 'claude never spawned');
  // piped /usage (no INPUT): still local
  const piped = await run(t, ['chat', '--no-interactive'], { stdin: '/usage\n' });
  assert.equal(piped.code, 0, piped.stderr);
  assert.match(piped.stdout, /not reported as Kiro credits/);
  assert.equal(t.fakeLogLines().length, 0);
});

test('review: chat value validation exits 2; --profile warns and selects the agent', async () => {
  const bad = await run(t, ['chat', '--effort', 'HIGH', 'x']);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /^error: invalid value 'HIGH' for '--effort <LEVEL>'/);
  const seen: Array<string | undefined> = [];
  const { ctx, stderr } = makeCtx(t);
  const code = await runChatCommand(['--profile', 'kiro_planner', '--no-interactive', 'x'], ctx, {
    runHeadless: async (o) => (seen.push(o.sessionOptions.agentName), 0),
  });
  assert.equal(code, 0);
  assert.deepEqual(seen, ['kiro_planner']);
  assert.match(stderr.text, /WARNING: --profile is deprecated, use --agent instead/);
});

// ───────────────────────────── agent ─────────────────────────────

test('review: agent edit keeps relative file:// prompts resolvable (validated as the real file)', async () => {
  fs.mkdirSync(globalAgents(), { recursive: true });
  t.write(path.join(globalAgents(), 'prompts', 'dev.md'), 'You are dev.');
  const file = t.write(path.join(globalAgents(), 'dev.json'), { name: 'dev', tools: ['*'], prompt: 'file://./prompts/dev.md' });
  assert.equal(validateAgentFileText(file, makeCtx(t).ctx), undefined, 'the stored agent is valid');
  const edited = JSON.stringify({ name: 'dev', tools: ['read'], prompt: 'file://./prompts/dev.md', description: 'edited' });
  const r = await run(t, ['agent', 'edit', 'dev'], { env: { EDITOR: editorWriting(edited) } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal((JSON.parse(fs.readFileSync(file, 'utf8')) as { description: string }).description, 'edited');
  // a really missing prompt is still refused, naming the real path (not the temp copy)
  const broken = JSON.stringify({ name: 'dev', tools: ['read'], prompt: 'file://./prompts/none.md' });
  const b = await run(t, ['agent', 'edit', 'dev'], { env: { EDITOR: editorWriting(broken) } });
  assert.equal(b.code, 1);
  assert.match(b.stderr, /Post write validation failed for agent 'dev' at path: .*dev\.json\. Malformed config detected: Json supplied at .*dev\.json is invalid: File URI not found/);
  assert.ok(!/kiro-claude-agent-/.test(b.stderr), 'temp path never shown');
  assert.equal((JSON.parse(fs.readFileSync(file, 'utf8')) as { description: string }).description, 'edited');
});

test('review: agent edit of a Markdown agent validates as Markdown', async () => {
  const file = t.write(path.join(globalAgents(), 'md.md'), '---\nname: md\ntools: ["read"]\n---\nBody one.');
  const r = await run(t, ['agent', 'edit', 'md'], { env: { EDITOR: editorWriting('---\nname: md\ntools: ["read"]\n---\nBody two.') } });
  assert.equal(r.code, 0, r.stderr);
  assert.match(fs.readFileSync(file, 'utf8'), /Body two\./);
  const bad = await run(t, ['agent', 'edit', 'md'], { env: { EDITOR: editorWriting('---\nname: [oops\n---\nx') } });
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /Markdown agent supplied at .*md\.md is invalid/);
  assert.match(fs.readFileSync(file, 'utf8'), /Body two\./);
});

test('review: agent create refuses path-like names; KiroCrew validate probe is silent on success', async () => {
  // (`team/dev` is allowed: Kiro agent dirs are scanned recursively and named by relative stem)
  for (const name of ['../evil', 'x/../../evil', '/abs', '.', '..', '']) {
    const r = await run(t, ['agent', 'create', name, '--no-edit']);
    assert.equal(r.code, 1, name);
  }
  assert.ok(!fs.existsSync(path.join(t.kiroHome, 'evil.json')));
  assert.ok(!fs.existsSync(path.join(t.home, 'evil.json')));
  const spec = t.write('specs/kirocrew-skill-view-0123456789abcdef01234567.json', {
    name: 'kirocrew-skill-view-0123456789abcdef01234567',
    description: null,
    prompt: 'You are the crew.',
    tools: ['fs_read', '@kirocrew-core', '@kirocrew-computer'],
    allowedTools: ['fs_read', '@kirocrew-core/learn_add'],
    mcpServers: { 'kirocrew-core': { command: 'python3', args: ['-m', 'x'], env: { A: '${HOME}' } } },
    hooks: { postToolUse: [{ matcher: 'execute_bash', command: 'true' }] },
    toolsSettings: { execute_bash: { allowedCommands: ['ls'] } },
    resources: ['file://AGENTS.md'],
    includeMcpJson: false,
    model: null,
  });
  const v = await run(t, ['agent', 'validate', '--path', spec]);
  assert.equal(v.code, 0, v.stdout);
  assert.equal(v.stdout + v.stderr, '');
});

test('review: clap-style `help [COMMAND]` under agent and mcp', async () => {
  const a = await run(t, ['agent', 'help']);
  assert.equal(a.code, 0);
  assert.match(a.stdout, /^Manage agents\n\nUsage: kiro-claude agent \[OPTIONS\] \[COMMAND\]/);
  const ac = await run(t, ['agent', 'help', 'create']);
  assert.equal(ac.code, 0);
  assert.match(ac.stdout, /Usage: kiro-claude agent create \[OPTIONS\] \[NAME\]/);
  const m = await run(t, ['mcp', 'help']);
  assert.equal(m.code, 0);
  assert.match(m.stdout, /Usage: kiro-claude mcp <COMMAND>/);
  const ma = await run(t, ['mcp', 'help', 'add']);
  assert.equal(ma.code, 0);
  assert.match(ma.stdout, /Usage: kiro-claude mcp add \[OPTIONS\]/);
  const bad = await run(t, ['mcp', 'help', 'frob']);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /unrecognized subcommand 'frob'/);
});

// ───────────────────────────── mcp / settings / diagnostic ─────────────────────────────

test('review: mcp list default = global; --args keeps hyphen values', async () => {
  const add = await run(t, ['mcp', 'add', '--name', 'srv', '--command', 'npx', '--args', '-y', '--args', '@scope/server,--port\\,x']);
  assert.equal(add.code, 0, add.stderr);
  const saved = JSON.parse(fs.readFileSync(path.join(t.kiroHome, 'settings', 'mcp.json'), 'utf8')) as { mcpServers: Record<string, { args: string[] }> };
  assert.deepEqual(saved.mcpServers.srv!.args, ['-y', '@scope/server', '--port,x']);
  const list = await run(t, ['mcp', 'list', 'default']);
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, /🌍 global/);
  assert.match(list.stdout, /• srv +npx -y @scope\/server --port,x/);
  const ws = await run(t, ['mcp', 'list', 'workspace']);
  assert.ok(!ws.stdout.includes('srv'));
});

test('review: settings --workspace writes the workspace file even before .kiro exists', async () => {
  const r = await run(t, ['settings', '--workspace', 'chat.defaultModel', 'claude-haiku-5.5']);
  assert.equal(r.code, 0, r.stderr);
  const wsFile = path.join(t.cwd, '.kiro', 'settings', 'cli.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(wsFile, 'utf8')), { 'chat.defaultModel': 'claude-haiku-5.5' });
  assert.ok(!fs.existsSync(path.join(t.kiroHome, 'settings', 'cli.json')), 'global file untouched');
  const g = await run(t, ['settings', '--global', 'chat.defaultModel']);
  assert.equal(g.code, 1);
  const eff = await run(t, ['settings', 'chat.defaultModel']);
  assert.equal(eff.stdout, 'claude-haiku-5.5\n');
});

test('review: diagnostic never prints secrets (names or URL credentials)', async () => {
  assert.equal(redactUrlCredentials('https://user:p%40ss@proxy.example:8080/x'), 'https://<redacted>@proxy.example:8080/x');
  assert.equal(redactUrlCredentials('no url here'), 'no url here');
  const vars = diagnosticEnvVars({
    KIRO_PROXY_URL: 'http://bob:hunter2@proxy:3128',
    KIRO_API_KEY: 'ksk_secret',
    KIROCREW_STUB_SESSION_TOKEN: 'tok',
    ANTHROPIC_API_KEY: 'sk-ant-xyz',
    CLAUDE_CODE_OAUTH_TOKEN: 'oat',
    KIRO_HOME: '/srv/kiro',
    UNRELATED_SECRET: 'zzz',
  });
  assert.equal(vars.KIRO_PROXY_URL, 'http://<redacted>@proxy:3128');
  assert.equal(vars.KIRO_API_KEY, '<set>');
  assert.equal(vars.KIROCREW_STUB_SESSION_TOKEN, '<set>');
  assert.equal(vars.ANTHROPIC_API_KEY, '<set>');
  assert.equal(vars.CLAUDE_CODE_OAUTH_TOKEN, '<set>');
  assert.equal(vars.KIRO_HOME, '/srv/kiro');
  assert.ok(!('UNRELATED_SECRET' in vars));
  const r = await run(t, ['diagnostic', '--format', 'json'], { env: { KIRO_PROXY_URL: 'http://bob:hunter2@proxy:3128', ANTHROPIC_API_KEY: 'sk-ant-xyz' } });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!r.stdout.includes('hunter2'));
  assert.ok(!r.stdout.includes('sk-ant-xyz'));
  JSON.parse(r.stdout);
});

// ───────────────────────────── whoami ─────────────────────────────

test('review: whoami with an email (plain + leading-JSON object, no accountType)', async () => {
  const stub = t.write(
    'bin/claude-stub.mjs',
    [
      "const a = process.argv.slice(2);",
      "if (a[0] === '--version') { process.stdout.write('2.1.318 (Claude Code)\\n'); process.exit(0); }",
      "if (a[0] === 'auth' && a[1] === 'status') { process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'me@example.com', subscriptionType: 'max' }) + '\\n'); process.exit(0); }",
      'process.exit(3);',
    ].join('\n'),
  );
  const env = { KIRO_CLAUDE_BIN: stub };
  const plain = await run(t, ['whoami'], { env });
  assert.equal(plain.code, 0, plain.stderr);
  assert.equal(plain.stdout, 'Logged in with Claude Code (claude.ai)\nEmail: me@example.com\n');
  const j = await run(t, ['whoami', '-f', 'json'], { env });
  assert.equal(j.stdout, '{"email":"me@example.com"}\n');
  assert.ok(!j.stdout.includes('accountType'));
});

// ───────────────────────────── headless ─────────────────────────────

async function headless(input: string, script: MockScript, opts: { outputFormat?: 'text' | 'stream-json'; stdout?: NodeJS.WriteStream; stderr?: NodeJS.WriteStream; create?: (s: KiroSession) => KiroSession } = {}) {
  const { ctx, stdout, stderr } = makeCtx(t);
  const f = mockFactory(script);
  const c: CliContext = { ...ctx, ...(opts.stdout ? { stdout: opts.stdout } : {}), ...(opts.stderr ? { stderr: opts.stderr } : {}) };
  const code = await runHeadless({
    ctx: c,
    sessionOptions: { env: t.env },
    input,
    createSession: opts.create ? async (o) => opts.create!(await f.create(o)) : f.create,
    ...(opts.outputFormat ? { outputFormat: opts.outputFormat } : {}),
  });
  return { code, stdout: stdout.text, stderr: stderr.text, calls: f.calls };
}

test('review: headless /usage in stream-json is JSON lines only, without a session', async () => {
  const r = await headless('/usage', {}, { outputFormat: 'stream-json' });
  assert.equal(r.code, 0);
  assert.equal(r.calls.created.length, 0);
  const lines = r.stdout.trimEnd().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.deepEqual(lines.map((l) => l.type), ['text', 'result']);
  assert.equal(lines[1]!.localCommand, '/usage');
});

test('review: headless non-listing forms of informational commands fail without a session', async () => {
  for (const input of ['/model claude-haiku-5.5', '/tools trust read', '/mcp add x', '/clear']) {
    const r = await headless(input, {});
    assert.equal(r.code, 1, input);
    assert.match(r.stderr, /is only available in interactive chat/, input);
    assert.equal(r.calls.created.length, 0, input);
    assert.equal(r.stdout, '', input);
  }
});

test('review: start failure carrying exitCode 4 ⇒ stopping (exit 4), session closed', async () => {
  const e = Object.assign(new Error('Error: no agent with name ghost found'), { exitCode: 4 });
  const r = await headless('hi', { startError: e });
  assert.equal(r.code, 4);
  assert.equal(r.stderr, 'Error: no agent with name ghost found\nstopping (exit 4)\n');
  assert.equal(r.calls.closed, 1);
});

test('review: a failing local session command ⇒ exit 1, session still closed', async () => {
  const r = await headless('/context', {}, {
    create: (s) => {
      (s as MockSession).contextReport = async () => {
        throw new Error('no child');
      };
      return s;
    },
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^error: \/context: no child\n$/);
  assert.equal(r.calls.closed, 1);
  assert.equal(r.calls.prompts.length, 0);
});

test('review: stderr closed during a turn ⇒ no unhandled error; the answer still reaches stdout, exit 0, session closed (C10)', async () => {
  class Broken extends Writable {
    isTTY = false;
    override _write(_c: Buffer | string, _e: BufferEncoding, cb: (e?: Error | null) => void): void {
      cb(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    }
  }
  // no listener of its own: an embedder's stream (cli/main guards process.stderr separately)
  const broken = new Broken() as unknown as NodeJS.WriteStream;
  const tool = { type: 'tool_start', toolUseId: 't1', trusted: true, call: { displayName: 'read', summary: 'Reading x', input: {}, mcp: undefined } } as unknown as SessionEvent;
  const r = await headless(
    'hi',
    { events: [{ type: 'text_delta', text: 'a' }, tool, { type: 'notice', level: 'warn', message: 'w' } as SessionEvent, { type: 'text_delta', text: 'b' }], eventDelayMs: 5, result: { text: 'ab' } },
    { stderr: broken },
  );
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'a\nb\n');
  assert.equal(r.calls.interrupts, 0);
  assert.equal(r.calls.closed, 1);
  assert.equal(broken.listenerCount('error'), 0, 'the listener is removed again');
});

test('review: stdout closed during a turn ⇒ interrupt, exit 1, session closed', async () => {
  class Broken extends Writable {
    isTTY = false;
    override _write(_c: Buffer | string, _e: BufferEncoding, cb: (e?: Error | null) => void): void {
      cb(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    }
  }
  const broken = new Broken() as unknown as NodeJS.WriteStream;
  const r = await headless(
    'hi',
    { events: [{ type: 'text_delta', text: 'a' }, { type: 'text_delta', text: 'b' }, { type: 'text_delta', text: 'c' }], eventDelayMs: 5 },
    { stdout: broken },
  );
  assert.equal(r.code, 1);
  assert.ok(r.calls.interrupts >= 1);
  assert.equal(r.calls.closed, 1);
});

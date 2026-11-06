import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { MCP_DEFAULT_TIMEOUT_MS, parseMcpArgs, parseMcpEnv } from '../../src/cli/commands/mcp.js';
import { makeEnv, run, type TestEnv } from './helpers.js';

let t: TestEnv;
beforeEach(() => {
  t = makeEnv();
  fs.mkdirSync(path.join(t.cwd, '.kiro'), { recursive: true });
});
afterEach(() => t.cleanup());

const globalFile = (): string => path.join(t.kiroHome, 'settings', 'mcp.json');
const wsFile = (): string => path.join(t.cwd, '.kiro', 'settings', 'mcp.json');
const read = (f: string): { mcpServers: Record<string, Record<string, unknown>> } => JSON.parse(fs.readFileSync(f, 'utf8'));

test('parseMcpArgs table (Q parse_args)', () => {
  const cases: Array<[string, string[] | RegExp]> = [
    ['a', ['a']],
    ['a,b , c', ['a', 'b', 'c']],
    ['arg\\,with\\,commas,second', ['arg,with,commas', 'second']],
    ['back\\\\slash\\,x', ['back\\slash,x']],
    ['["x", "y,z"]', ['x', 'y,z']],
    ['[1,2]', /Failed to parse arguments as JSON array/],
    ['[broken', /Failed to parse arguments as JSON array/],
    ['-y', ['-y']],
  ];
  for (const [input, want] of cases) {
    const r = parseMcpArgs(input);
    if (want instanceof RegExp) assert.match(r.error ?? '', want, input);
    else assert.deepEqual(r.args, want, input);
  }
  assert.deepEqual(parseMcpEnv('A=1, B = two'), { env: { A: '1', B: 'two' } });
  assert.match(parseMcpEnv('A=1,B').error ?? '', /invalid environment variable 'B'\. Expected 'name=value'/);
});

test('mcp add: global by default (Q), Q entry shape, duplicate needs --force', async () => {
  const r = await run(t, ['mcp', 'add', '--name', 'fetch', '--command', 'uvx', '--args', 'mcp-server-fetch', '--args', '-y,--quiet', '--env', 'A=1,B=2', '--env', 'C=3']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stderr, `✓ Added MCP server 'fetch' to global config in ${globalFile()}\n\n`);
  assert.deepEqual(read(globalFile()).mcpServers.fetch, {
    command: 'uvx',
    args: ['mcp-server-fetch', '-y', '--quiet'],
    env: { A: '1', B: '2', C: '3' },
    timeout: MCP_DEFAULT_TIMEOUT_MS,
    disabled: false,
  });
  const dup = await run(t, ['mcp', 'add', '--name', 'fetch', '--command', 'x']);
  assert.equal(dup.code, 1);
  assert.match(dup.stderr, /MCP server 'fetch' already exists in global config \(path .*\)\. Use --force to overwrite\./);
  const forced = await run(t, ['mcp', 'add', '--name', 'fetch', '--command', 'x', '--timeout', '5000', '--disabled', '--force']);
  assert.equal(forced.code, 0);
  assert.deepEqual(read(globalFile()).mcpServers.fetch, { command: 'x', args: [], env: {}, timeout: 5000, disabled: true });
});

test('mcp add: workspace scope, remote --url, agent target, errors', async () => {
  const ws = await run(t, ['mcp', 'add', '--name', 'w', '--command', 'node', '--scope', 'workspace']);
  assert.equal(ws.code, 0);
  assert.ok(read(wsFile()).mcpServers.w);
  const remote = await run(t, ['mcp', 'add', '--name', 'r', '--url', 'https://example.com/mcp']);
  assert.equal(remote.code, 0);
  assert.equal(read(globalFile()).mcpServers.r!.url, 'https://example.com/mcp');

  const agentFile = t.write(path.join(t.kiroHome, 'agents', 'dev.json'), { name: 'dev', tools: ['*'], mcpServers: {} });
  const ag = await run(t, ['mcp', 'add', '--name', 'git', '--command', 'git-mcp', '--agent', 'dev']);
  assert.equal(ag.code, 0, ag.stderr);
  assert.equal(ag.stderr, "✓ Added MCP server 'git' to agent dev\n\n");
  const agentJson = JSON.parse(fs.readFileSync(agentFile, 'utf8')) as { name: string; tools: string[]; mcpServers: Record<string, unknown> };
  assert.equal(agentJson.name, 'dev');
  assert.deepEqual(agentJson.tools, ['*']);
  assert.ok(agentJson.mcpServers.git);
  const agDup = await run(t, ['mcp', 'add', '--name', 'git', '--command', 'git-mcp', '--agent', 'dev']);
  assert.equal(agDup.code, 1);
  assert.match(agDup.stderr, /already exists in agent dev/);
  const noAgent = await run(t, ['mcp', 'add', '--name', 'g', '--command', 'c', '--agent', 'ghost']);
  assert.equal(noAgent.code, 1);
  assert.match(noAgent.stderr, /No agent with name ghost found/);

  const missing = await run(t, ['mcp', 'add', '--name', 'x']);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /required arguments were not provided:\n {2}--command <COMMAND>/);
  const badScope = await run(t, ['mcp', 'add', '--name', 'x', '--command', 'c', '--scope', 'agent']);
  assert.equal(badScope.code, 2);
  const badTimeout = await run(t, ['mcp', 'add', '--name', 'x', '--command', 'c', '--timeout', 'soon']);
  assert.equal(badTimeout.code, 2);
  const badEnv = await run(t, ['mcp', 'add', '--name', 'x', '--command', 'c', '--env', 'NOEQ']);
  assert.equal(badEnv.code, 2);
});

test('mcp remove / rm', async () => {
  await run(t, ['mcp', 'add', '--name', 'a', '--command', 'c']);
  const r = await run(t, ['mcp', 'remove', '--name', 'a']);
  assert.equal(r.code, 0);
  assert.equal(r.stderr, `\n✓ Removed MCP server 'a' from global config (path ${globalFile()})\n\n`);
  assert.deepEqual(read(globalFile()).mcpServers, {});
  const again = await run(t, ['mcp', 'rm', '--name', 'a']);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /No MCP server named 'a' found in global config/);
  t.write(path.join(t.kiroHome, 'agents', 'dev.json'), { name: 'dev', tools: ['*'], mcpServers: { s: { command: 'x' } } });
  const ag = await run(t, ['mcp', 'remove', '--name', 's', '--agent', 'dev']);
  assert.equal(ag.code, 0);
  assert.equal(ag.stderr, "\n✓ Removed MCP server 's' from agent dev\n\n");
  const noName = await run(t, ['mcp', 'remove']);
  assert.equal(noName.code, 2);
});

test('mcp list: per scope, agent servers, empty', async () => {
  const empty = await run(t, ['mcp', 'list']);
  assert.equal(empty.stdout, 'No MCP server configurations found.\n\n');
  await run(t, ['mcp', 'add', '--name', 'fetch', '--command', 'uvx', '--args', 'mcp-server-fetch']);
  await run(t, ['mcp', 'add', '--name', 'off', '--command', 'node', '--disabled', '--scope', 'workspace']);
  t.write(path.join(t.kiroHome, 'agents', 'dev.json'), { name: 'dev', tools: ['*'], mcpServers: { git: { command: 'git-mcp' } } });
  const r = await run(t, ['mcp', 'list']);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes(`📄 workspace:\n\n  ${wsFile()}\n    • off          node (disabled)`));
  assert.ok(r.stdout.includes(`🌍 global:\n\n  ${globalFile()}\n    • fetch        uvx mcp-server-fetch`));
  assert.ok(r.stdout.includes('🌍 global (agent dev):'));
  assert.ok(r.stdout.includes('    • git          git-mcp'));
  const g = await run(t, ['mcp', 'list', 'global']);
  assert.ok(!g.stdout.includes('workspace'));
  const bad = await run(t, ['mcp', 'list', 'nowhere']);
  assert.equal(bad.code, 2);
});

test('mcp import (default workspace, Q)', async () => {
  const src = t.write('import.json', { mcpServers: { a: { command: 'x' }, b: { url: 'https://h/mcp' } } });
  const r = await run(t, ['mcp', 'import', '--file', src]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(Object.keys(read(wsFile()).mcpServers).sort(), ['a', 'b']);
  assert.match(r.stderr, /✓ Imported 2 MCP server\(s\) into 📄 workspace\n/);
  assert.match(r.stderr, /To learn more about MCP safety/);
  const dup = await run(t, ['mcp', 'import', '--file', src]);
  assert.equal(dup.code, 1);
  assert.match(dup.stderr, /MCP server 'a' already exists in .* \(scope workspace\)\. Use --force to overwrite\./);
  const forced = await run(t, ['mcp', 'import', '--file', src, '--force', 'global']);
  assert.equal(forced.code, 0);
  assert.deepEqual(Object.keys(read(globalFile()).mcpServers).sort(), ['a', 'b']);
  const missing = await run(t, ['mcp', 'import', '--file', path.join(t.root, 'nope.json')]);
  assert.equal(missing.code, 1);
  const noFile = await run(t, ['mcp', 'import']);
  assert.equal(noFile.code, 2);
});

test('mcp status: configuration + live check through claude (fake), no user turn', async () => {
  await run(t, ['mcp', 'add', '--name', 'fetch', '--command', process.execPath, '--args', '-e,1', '--env', 'K=V']);
  const r = await run(t, ['mcp', 'status', '--name', 'fetch']);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.ok(r.stdout.includes('─────────────\nScope   : 🌍 global\nAgent   : (mcp.json)\n'));
  assert.ok(r.stdout.includes(`Command : ${process.execPath} -e 1\n`));
  assert.ok(r.stdout.includes('Timeout : 120000 ms\nDisabled: false\nEnv Vars: K=V'));
  assert.match(r.stdout, /\nStatus {2}: connected \(0 tools\)\n$/);
  const log = t.fakeLogLines();
  const start = log.find((l) => l.event === 'start' && (l.argv as string[]).includes('-p')) as { argv: string[] } | undefined;
  assert.ok(start);
  assert.ok(start.argv.includes('--strict-mcp-config'));
  const userLines = log.filter((l) => l.event === 'stdin' && (l.line as { type?: string })?.type === 'user');
  assert.equal(userLines.length, 0);

  const cfgOnly = await run(t, ['mcp', 'status', '--name', 'fetch', '--no-check']);
  assert.equal(cfgOnly.code, 0);
  assert.ok(!cfgOnly.stdout.includes('Status  :'));
  const none = await run(t, ['mcp', 'status', '--name', 'ghost']);
  assert.equal(none.code, 1);
  assert.equal(none.stderr, "error: No MCP server named 'ghost' found in any agent\n\n");
});

test('mcp without/with unknown subcommand', async () => {
  const r = await run(t, ['mcp']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /requires a subcommand/);
  const u = await run(t, ['mcp', 'frob']);
  assert.equal(u.code, 2);
  const h = await run(t, ['mcp', '--help']);
  assert.equal(h.code, 0);
  assert.match(h.stdout, /Usage: kiro-claude mcp <COMMAND>/);
  assert.match(h.stdout, / {2}status +Get the status of a configured server/);
});

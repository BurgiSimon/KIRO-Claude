import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  addMcpServer,
  claudeMcpNameMap,
  claudeServerName,
  loadMcpFile,
  mcpConfigPaths,
  normalizeMcpServer,
  readMcpFileRaw,
  removeMcpServer,
  resolveMcpServers,
  substituteEnv,
  toClaudeMcpConfig,
} from '../../src/config/mcp.js';
import type { McpServerConfig } from '../../src/types.js';
import { codes, makeFixture, type Fixture } from './helpers.js';

const ENV = { HOME: '/home/u', TOKEN: 'tok', DB_URL: 'postgres://x', EMPTY: '' };

describe('config/mcp substituteEnv (02 §5.3)', () => {
  const table: [string, boolean, string, string[]][] = [
    ['${env:TOKEN}', false, 'tok', []],
    ['Bearer ${TOKEN}', false, 'Bearer tok', []],
    ['${env:NOPE}', false, '${env:NOPE}', ['NOPE']],
    ['${NOPE}-${NOPE}', false, '${NOPE}-${NOPE}', ['NOPE']],
    ['$TOKEN', false, '$TOKEN', []],
    ['$TOKEN/bin', true, 'tok/bin', []],
    ['${EMPTY}x', false, 'x', []],
    ['${env:DB_URL}?a=${TOKEN}', false, 'postgres://x?a=tok', []],
    ['$1 and $$', true, '$1 and $$', []],
    ['plain', true, 'plain', []],
  ];
  for (const [input, dollar, value, missing] of table) {
    it(`${input} (dollar=${dollar})`, () => assert.deepEqual(substituteEnv(input, ENV, { dollar }), { value, missing }));
  }
});

describe('config/mcp normalizeMcpServer (02 §5.2)', () => {
  it('stdio with env substitution, ~ in command, defaults', () => {
    const r = normalizeMcpServer(
      'pg',
      { command: '~/bin/pg-mcp', args: ['-y', '${TOKEN}'], env: { DATABASE_URL: '${DB_URL}', KEY: '${env:TOKEN}', N: 5 } },
      'agent',
      ENV,
      '/a.json',
    );
    assert.deepEqual(r.warnings, []);
    assert.deepEqual(r.server, {
      name: 'pg',
      type: 'stdio',
      command: path.join('/home/u', 'bin/pg-mcp'),
      args: ['-y', '${TOKEN}'],
      env: { DATABASE_URL: 'postgres://x', KEY: 'tok', N: '5' },
      headers: {},
      disabled: false,
      autoApprove: [],
      disabledTools: [],
      origin: 'agent',
      sourcePath: '/a.json',
    });
  });

  it('infers http from url; headers substituted; timeout/autoApprove/disabledTools', () => {
    const r = normalizeMcpServer(
      'remote',
      { url: 'https://h/${TOKEN}/mcp', headers: { Authorization: 'Bearer ${TOKEN}' }, timeout: 60000, autoApprove: ['*'], disabledTools: ['x'], disabled: true },
      'global',
      ENV,
    );
    assert.equal(r.server!.type, 'http');
    assert.equal(r.server!.url, 'https://h/tok/mcp');
    assert.deepEqual(r.server!.headers, { Authorization: 'Bearer tok' });
    assert.equal(r.server!.timeoutMs, 60000);
    assert.deepEqual(r.server!.autoApprove, ['*']);
    assert.deepEqual(r.server!.disabledTools, ['x']);
    assert.equal(r.server!.disabled, true);
    assert.equal(r.server!.sourcePath, undefined);
  });

  const typeTable: [Record<string, unknown>, string | undefined][] = [
    [{ type: 'stdio', command: 'x' }, 'stdio'],
    [{ type: 'http', url: 'https://a' }, 'http'],
    [{ type: 'sse', url: 'https://a/sse' }, 'sse'],
    [{ type: 'streamable-http', url: 'https://a' }, 'http'],
    [{ type: 'HTTP', url: 'https://a' }, 'http'],
    [{ command: 'x', url: 'https://a' }, 'stdio'],
    [{ url: 'https://a' }, 'http'],
    [{ command: 'x' }, 'stdio'],
    [{ type: 'stdio' }, undefined],
    [{ type: 'http' }, undefined],
    [{}, undefined],
  ];
  for (const [raw, want] of typeTable) {
    it(`type of ${JSON.stringify(raw)} ⇒ ${want ?? 'invalid'}`, () => {
      const r = normalizeMcpServer('s', raw, 'workspace', ENV);
      assert.equal(r.server?.type, want);
      if (!want) assert.ok(r.warnings.some((w) => w.code === 'mcp-invalid'));
    });
  }

  it('warns about unset env vars and bad field types', () => {
    const r = normalizeMcpServer('s', { command: '$NOPE/x', env: { A: '${MISSING}', B: { x: 1 } }, args: [1, {}], timeout: -1, disabled: 'yes' }, 'agent', ENV);
    assert.ok(r.server);
    assert.deepEqual(r.server!.args, ['1']);
    assert.deepEqual(r.server!.env, { A: '${MISSING}' });
    assert.equal(r.server!.disabled, false);
    assert.deepEqual(codes(r.warnings).sort(), ['mcp-env-unset', 'mcp-env-unset', 'mcp-invalid', 'mcp-invalid', 'mcp-invalid', 'mcp-invalid'].sort());
  });

  it('rejects non-objects', () => {
    assert.equal(normalizeMcpServer('s', 'x', 'agent', ENV).server, undefined);
    assert.equal(normalizeMcpServer('s', null, 'agent', ENV).warnings[0]!.code, 'mcp-invalid');
  });

  it('unknown type warns and falls back to inference', () => {
    const r = normalizeMcpServer('s', { type: 'ws', url: 'https://x' }, 'agent', ENV);
    assert.equal(r.server!.type, 'http');
    assert.equal(r.warnings[0]!.code, 'mcp-invalid');
  });
});

describe('config/mcp claude translation', () => {
  const s = (name: string, extra: Partial<McpServerConfig> = {}): McpServerConfig => ({
    name,
    type: 'stdio',
    command: 'cmd',
    args: ['a'],
    env: { K: 'v' },
    headers: {},
    disabled: false,
    autoApprove: [],
    disabledTools: [],
    origin: 'agent',
    ...extra,
  });

  const nameTable: [string, string][] = [
    ['git', 'git'],
    ['my-server_1', 'my-server_1'],
    ['my.server', 'my_server'],
    ['a b/c', 'a_b_c'],
    ['ünïcode', '_n_code'],
    ['', '_'],
  ];
  for (const [n, want] of nameTable) it(`claudeServerName(${JSON.stringify(n)}) = ${want}`, () => assert.equal(claudeServerName(n), want));

  it('toClaudeMcpConfig shapes, skips disabled, dedupes normalized names, name map', () => {
    const servers = [
      s('a.b'),
      s('a_b', { type: 'http', command: undefined, url: 'https://x', headers: { H: '1' } }),
      s('off', { disabled: true }),
      s('e', { type: 'sse', url: 'https://e/sse' }),
    ];
    assert.deepEqual(toClaudeMcpConfig(servers), {
      mcpServers: {
        a_b: { type: 'stdio', command: 'cmd', args: ['a'], env: { K: 'v' } },
        a_b_2: { type: 'http', url: 'https://x', headers: { H: '1' } },
        e: { type: 'sse', url: 'https://e/sse', headers: {} },
      },
    });
    assert.deepEqual(claudeMcpNameMap(servers), { a_b: 'a.b', a_b_2: 'a_b', e: 'e' });
  });
});

describe('config/mcp files and precedence (02 §5.1)', () => {
  let fx: Fixture;
  afterEach(() => fx?.cleanup());

  it('loadMcpFile: missing, invalid JSON, no mcpServers, valid', () => {
    fx = makeFixture();
    assert.deepEqual(loadMcpFile(path.join(fx.root, 'none.json'), 'global', fx.env), { servers: {}, warnings: [] });
    const bad = fx.write('bad.json', '{\n "mcpServers": {,}\n}');
    const r1 = loadMcpFile(bad, 'global', fx.env);
    assert.equal(r1.warnings[0]!.code, 'invalid-json');
    assert.match(r1.warnings[0]!.message, /line 2 column/);
    const none = fx.write('none2.json', { servers: {} });
    assert.match(loadMcpFile(none, 'global', fx.env).warnings[0]!.message, /No mcp servers found in config/);
    const ok = fx.write('ok.json', { mcpServers: { a: { command: 'x' }, b: { nope: 1 } } });
    const r2 = loadMcpFile(ok, 'workspace', fx.env);
    assert.deepEqual(Object.keys(r2.servers), ['a']);
    assert.equal(r2.servers.a!.origin, 'workspace');
    assert.equal(r2.servers.a!.sourcePath, ok);
    assert.equal(r2.warnings.length, 1);
  });

  it('mcpConfigPaths', () => {
    fx = makeFixture();
    const p = mcpConfigPaths(fx.ctx());
    assert.equal(p.global, path.join(fx.kiroHome, 'settings', 'mcp.json'));
    assert.equal(p.workspace, path.join(fx.ws, '.kiro', 'settings', 'mcp.json'));
    assert.equal(p.legacyGlobal, path.join(fx.home, '.aws', 'amazonq', 'mcp.json'));
    assert.equal(p.legacyWorkspace, path.join(fx.ws, '.amazonq', 'mcp.json'));
  });

  function setup(): void {
    fx = makeFixture();
    fx.write('home/.kiro/settings/mcp.json', {
      mcpServers: { shared: { command: 'global-shared' }, gonly: { command: 'g' }, killed: { command: 'k' } },
    });
    fx.write('proj/.kiro/settings/mcp.json', {
      mcpServers: { shared: { command: 'ws-shared' }, wonly: { url: 'https://w' }, killed: { command: 'k2', disabled: true } },
    });
    fx.write('home/.aws/amazonq/mcp.json', { mcpServers: { lg: { command: 'lg' }, agentsrv: { command: 'legacy-dup' } } });
    fx.write('proj/.amazonq/mcp.json', { mcpServers: { lw: { command: 'lw' }, lg: { command: 'lg-ws' } } });
  }

  const agentSrv = (env: NodeJS.ProcessEnv): Record<string, McpServerConfig> => ({
    shared: normalizeMcpServer('shared', { command: 'agent-shared' }, 'agent', env).server!,
    agentsrv: normalizeMcpServer('agentsrv', { command: 'agent' }, 'agent', env).server!,
  });

  it('agent > workspace > global; disabled kept; mcp.json only with includeMcpJson', () => {
    setup();
    const ws = fx.ctx();
    const none = resolveMcpServers(ws, { mcpServers: agentSrv(fx.env), includeMcpJson: false, useLegacyMcpJson: false });
    assert.deepEqual(none.servers.map((s) => s.name), ['shared', 'agentsrv']);
    const r = resolveMcpServers(ws, { mcpServers: agentSrv(fx.env), includeMcpJson: true, useLegacyMcpJson: false });
    const by = Object.fromEntries(r.servers.map((s) => [s.name, s]));
    assert.deepEqual(r.servers.map((s) => s.name), ['shared', 'agentsrv', 'wonly', 'killed', 'gonly']);
    assert.equal(by.shared!.command, 'agent-shared');
    assert.equal(by.killed!.disabled, true);
    assert.equal(by.killed!.origin, 'workspace');
    assert.equal(by.gonly!.origin, 'global');
    assert.deepEqual(Object.keys(toClaudeMcpConfig(r.servers).mcpServers), ['shared', 'agentsrv', 'wonly', 'gonly']);
    assert.deepEqual(r.warnings, []);
  });

  it('workspace-only override without agent servers', () => {
    setup();
    const r = resolveMcpServers(fx.ctx(), { mcpServers: {}, includeMcpJson: true, useLegacyMcpJson: false });
    assert.equal(r.servers.find((s) => s.name === 'shared')!.command, 'ws-shared');
  });

  it('legacy files with useLegacyMcpJson: workspace wins, agent duplicates warn with Q text', () => {
    setup();
    const r = resolveMcpServers(fx.ctx(), { mcpServers: agentSrv(fx.env), includeMcpJson: false, useLegacyMcpJson: true });
    const by = Object.fromEntries(r.servers.map((s) => [s.name, s]));
    assert.deepEqual(r.servers.map((s) => s.name), ['shared', 'agentsrv', 'lw', 'lg']);
    assert.equal(by.lg!.command, 'lg-ws');
    assert.equal(by.lg!.origin, 'legacy-workspace');
    assert.equal(by.agentsrv!.command, 'agent');
    assert.deepEqual(
      r.warnings.map((w) => w.message),
      ["WARNING: MCP server 'agentsrv' is already configured in agent config. Skipping duplicate from legacy mcp.json."],
    );
  });

  it('at home the workspace mcp.json is not read twice', () => {
    fx = makeFixture();
    fx.write('home/.kiro/settings/mcp.json', { mcpServers: { a: { command: 'x' } } });
    const r = resolveMcpServers(fx.ctx(fx.home), { mcpServers: {}, includeMcpJson: true, useLegacyMcpJson: false });
    assert.deepEqual(r.servers.map((s) => [s.name, s.origin]), [['a', 'global']]);
  });

  it('editing helpers: add/force/remove keep other keys', () => {
    fx = makeFixture();
    const p = path.join(fx.ws, '.kiro', 'settings', 'mcp.json');
    assert.deepEqual(readMcpFileRaw(p), { mcpServers: {} });
    addMcpServer(p, 'git', { command: 'uvx', args: ['mcp-server-git'] }, { force: false });
    assert.throws(() => addMcpServer(p, 'git', { command: 'x' }, { force: false }), /already exists .* Use --force to overwrite\./);
    addMcpServer(p, 'git', { command: 'npx' }, { force: true });
    addMcpServer(p, 'other', { url: 'https://o' }, { force: false });
    assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')), { mcpServers: { git: { command: 'npx' }, other: { url: 'https://o' } } });
    fs.writeFileSync(p, JSON.stringify({ $schema: 'x', mcpServers: { git: { command: 'npx' } } }));
    assert.equal(removeMcpServer(p, 'nope'), false);
    assert.equal(removeMcpServer(p, 'git'), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')), { $schema: 'x', mcpServers: {} });
    assert.equal(removeMcpServer(path.join(fx.root, 'missing.json'), 'git'), false);
    fs.writeFileSync(p, '{bad');
    assert.throws(() => readMcpFileRaw(p), /invalid JSON/);
    fs.writeFileSync(p, '{"mcpServers": []}');
    assert.throws(() => readMcpFileRaw(p), /must be an object/);
  });
});

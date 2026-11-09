/**
 * r11 #4 (session group), over ACP with the real session: since bbe76aa a mode change whose agent
 * swap took place but whose Claude Code restart failed is answered as applied (`{}` with
 * current_mode_update, r10 #4). The session's `tools` and `mcp` must then describe the agent it
 * switched to, answer at once (well under the MCP start-up wait, `mcpWaitMs`), and not report as
 * loading the servers that nothing starts before the next prompt: those are `failed` with the
 * reason, and no `server_init_failure` is sent for them, so the next child's
 * `server_initialized` still is. A running child whose servers are still connecting is waited for
 * as before. The next prompt starts the new agent's child, with its tools only.
 *
 * Claude Code is test/fixtures/fake-claude.mjs behind a wrapper that exits 1 at every start while
 * a flag file exists (a restart that fails).
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { fakeClaudePath } from '../claude/helpers.js';
import { TestClient, tmpEnv, writeAgent, type Frame, type TmpEnv } from './helpers.js';

const clients: TestClient[] = [];
after(async () => {
  await Promise.allSettled(clients.filter((c) => c.exitCode === undefined).map((c) => c.close(10_000)));
});

/** The MCP start-up wait the server uses here: long enough that a wait for it is plain. */
const MCP_WAIT_MS = 10_000;

interface Setup {
  t: TmpEnv;
  c: TestClient;
  sid: string;
  flag: string;
  log: string;
}

/**
 * fake-claude, except that every stream-mode start exits 1 while $KC_FAIL_FLAG exists; the launch
 * writes only the server fields Claude Code reads, so it also adds the fake's `fakeTools` /
 * `fakeStatus` to the servers named in $KC_FAKE_MCP.
 */
const WRAPPER = `import * as fs from 'node:fs';
const args = process.argv.slice(2);
const probe = args.includes('--version') || args.includes('-v') || args.includes('--help') || args[0] === 'auth';
if (!probe && process.env.KC_FAIL_FLAG && fs.existsSync(process.env.KC_FAIL_FLAG)) {
  process.stderr.write('fail-wrapper: forced start failure\\n');
  process.exit(1);
}
const deco = process.env.KC_FAKE_MCP ? JSON.parse(process.env.KC_FAKE_MCP) : {};
for (let i = 2; i < process.argv.length - 1; i++) {
  if (process.argv[i] !== '--mcp-config') continue;
  try {
    const spec = process.argv[i + 1];
    const cfg = JSON.parse(spec.trim().startsWith('{') ? spec : fs.readFileSync(spec, 'utf8'));
    for (const [name, sc] of Object.entries(cfg.mcpServers || {})) if (deco[name]) Object.assign(sc, deco[name]);
    process.argv[i + 1] = JSON.stringify(cfg);
  } catch {}
}
await import(${JSON.stringify(pathToFileURL(fakeClaudePath()).href)});
`;

async function setup(mcpWaitMs = MCP_WAIT_MS, launchSrv: Record<string, unknown> = { fakeTools: ['ping'] }): Promise<Setup> {
  const t = tmpEnv();
  const wrapper = path.join(t.root, 'fail-wrapper.mjs');
  fs.writeFileSync(wrapper, WRAPPER);
  const flag = path.join(t.root, 'fail.flag');
  const log = path.join(t.root, 'fake.log');
  t.env.KIRO_CLAUDE_BIN = wrapper;
  t.env.KC_FAIL_FLAG = flag;
  t.env.FAKE_CLAUDE_LOG = log;
  t.env.KC_FAKE_MCP = JSON.stringify({ oldsrv: launchSrv, newsrv: { fakeTools: ['pong'] } });
  const kiro = path.join(t.work, '.kiro');
  writeAgent(kiro, 'probe', { description: 'launch agent', tools: ['*'], includeMcpJson: false, mcpServers: { oldsrv: { command: 'node', args: ['old.js'] } } });
  writeAgent(kiro, 'reader', { description: 'read-only', tools: ['read'], includeMcpJson: false });
  writeAgent(kiro, 'withsrv', { description: 'read and newsrv', tools: ['read', '@newsrv'], includeMcpJson: false, mcpServers: { newsrv: { command: 'node', args: ['new.js'] } } });
  const c = new TestClient({ args: ['--agent', 'probe'], env: t.env, cwd: t.work, timings: { mcpWaitMs } });
  clients.push(c);
  await c.initialize();
  const { sessionId } = await c.call('session/new', { cwd: t.work, mcpServers: [] }, 30_000);
  return { t, c, sid: sessionId as string, flag, log };
}

async function cmd(s: Setup, name: string, args: Record<string, unknown> = {}): Promise<{ data: Frame; ms: number }> {
  const t0 = Date.now();
  const r = await s.c.call('_kiro.dev/commands/execute', { sessionId: s.sid, command: { command: name, args } }, 60_000);
  return { data: r.data as Frame, ms: Date.now() - t0 };
}
const servers = (d: Frame): string[] => (d.servers as Frame[]).map((x) => `${x.name}:${x.status}`);
const toolNames = (d: Frame): string[] => (d.tools as Frame[]).map((x) => x.name as string);
function starts(log: string): string[][] {
  if (!fs.existsSync(log)) return [];
  return fs
    .readFileSync(log, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Frame)
    .filter((e) => e.event === 'start')
    .map((e) => e.argv as string[]);
}
const flagValue = (argv: string[], f: string): string | undefined => (argv.indexOf(f) >= 0 ? argv[argv.indexOf(f) + 1] : undefined);

async function prompt(s: Setup, text = 'hi'): Promise<void> {
  const r = await s.c.request('session/prompt', { sessionId: s.sid, prompt: [{ type: 'text', text }] }, 60_000);
  assert.equal(r.result?.stopReason, 'end_turn', JSON.stringify(r));
}

test('set_mode answered {} after a failed restart: tools and mcp describe the agent switched to, at once', async () => {
  const s = await setup();
  assert.deepEqual(servers((await cmd(s, 'mcp')).data), ['oldsrv:running'], 'sanity: the launch agent’s server runs');

  fs.writeFileSync(s.flag, '');
  const from = s.c.frames.length;
  const sm = await s.c.request('session/set_mode', { sessionId: s.sid, modeId: 'reader' }, 60_000);
  assert.deepEqual(sm.result, {}, `set_mode answered ${JSON.stringify(sm)}`);
  assert.ok(s.c.updates('current_mode_update', s.sid).some((u) => u.currentModeId === 'reader'));
  // the answer's own MCP report does not wait for servers nothing starts: its available
  // commands follow at once
  await s.c.waitFor((f) => f.method === 'session/update' && f.params?.update?.sessionUpdate === 'available_commands_update', 1500, 'the post-answer report', from);

  const tools = await cmd(s, 'tools');
  const mcp = await cmd(s, 'mcp');
  const observed = `tools=[${toolNames(tools.data)}] (${tools.ms} ms) mcp=[${servers(mcp.data)}] (${mcp.ms} ms)`;
  assert.deepEqual(toolNames(tools.data), ['read', 'glob', 'grep'], observed);
  assert.deepEqual(servers(mcp.data), [], observed);
  assert.ok(tools.ms < 1000 && mcp.ms < 1000, observed);

  // the next prompt starts the reader agent's child, with its tools only
  fs.rmSync(s.flag, { force: true });
  const n = starts(s.log).length;
  await prompt(s);
  assert.equal(starts(s.log).length, n + 1);
  assert.equal(flagValue(starts(s.log).at(-1)!, '--tools'), 'Read,Glob,Grep');
  const tools2 = await cmd(s, 'tools');
  const mcp2 = await cmd(s, 'mcp');
  assert.deepEqual(toolNames(tools2.data), toolNames(tools.data), 'the listing agrees with the child the prompt started');
  assert.deepEqual(servers(mcp2.data), servers(mcp.data));
  assert.equal(await s.c.close(10_000), 0);
});

test('commands/execute agent to an agent with MCP servers, restart failed: its servers are failed at once with the reason, then initialized after the next prompt', async () => {
  const s = await setup();
  await cmd(s, 'mcp');
  fs.writeFileSync(s.flag, '');
  const swap = await cmd(s, 'agent', { name: 'withsrv' });
  assert.equal((swap.data.agent as Frame).name, 'withsrv', JSON.stringify(swap.data));

  const mcp = await cmd(s, 'mcp');
  const tools = await cmd(s, 'tools');
  const observed = `mcp=${JSON.stringify(mcp.data.servers)} (${mcp.ms} ms) tools=[${toolNames(tools.data)}] (${tools.ms} ms)`;
  assert.deepEqual(servers(mcp.data), ['newsrv:failed'], observed);
  assert.match(String((mcp.data.servers as Frame[])[0]!.error), /Claude Code is not running/, observed);
  assert.deepEqual(toolNames(tools.data), ['read', 'glob', 'grep'], observed);
  assert.ok(mcp.ms < 1000 && tools.ms < 1000, observed);
  const failures = (): Frame[] => s.c.notifications('_kiro.dev/mcp/server_init_failure').filter((f) => f.params?.serverName === 'newsrv');
  assert.deepEqual(failures(), [], 'a server nothing started is not reported as a failed start');

  fs.rmSync(s.flag, { force: true });
  await prompt(s);
  const mcp2 = await cmd(s, 'mcp');
  assert.deepEqual(servers(mcp2.data), ['newsrv:running']);
  assert.ok(
    s.c.notifications('_kiro.dev/mcp/server_initialized').some((f) => f.params?.serverName === 'newsrv'),
    'the next child’s server is reported initialized',
  );
  assert.deepEqual(failures(), []);
  assert.deepEqual(toolNames((await cmd(s, 'tools')).data), ['read', 'glob', 'grep', 'pong']);
  assert.equal(await s.c.close(10_000), 0);
});

test('control: a running child whose server is still connecting is waited for and reported loading', async () => {
  const wait = 1500;
  const s = await setup(wait, { fakeStatus: 'pending' });
  const mcp = await cmd(s, 'mcp');
  assert.deepEqual(servers(mcp.data), ['oldsrv:loading']);
  assert.ok(mcp.ms >= wait - 100, `mcp answered after ${mcp.ms} ms (the wait is ${wait} ms)`);
  assert.equal(await s.c.close(10_000), 0);
});

/**
 * r11 #4 verifier, over ACP with the real session: after a mode change whose Claude Code restart
 * failed (answered `{}`, r10 #4), the MCP report no longer waits for the agent's servers, which no
 * child runs (`stopped`). The prompt that follows starts the child that runs them, and its servers'
 * `_kiro.dev/mcp/server_initialized` / `server_init_failure` must still be sent (08 KC-ACP-04: one
 * per server, as soon as Claude reports it), without a later `mcp` command: KiroCrew sends a prompt
 * after `set_mode`, and its dashboard reads those frames. Before r11 #4 the answer's own report
 * kept polling (for the servers of the agent left) and so caught the next child's servers; with the
 * report ending at once nothing reported them until an `mcp` command or another mode change. A
 * prompt whose start fails again reports nothing and waits for nothing; the one after it reports.
 *
 * Claude Code is test/fixtures/fake-claude.mjs behind a wrapper that exits 1 at every start while
 * a flag file exists (a restart that fails) and gives the named servers the fake's MCP tools.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { fakeClaudePath } from '../claude/helpers.js';
import { TestClient, sleep, tmpEnv, writeAgent, type Frame } from './helpers.js';

const clients: TestClient[] = [];
after(async () => {
  await Promise.allSettled(clients.filter((c) => c.exitCode === undefined).map((c) => c.close(10_000)));
});

/** The MCP start-up wait the server uses here (a report that waits for it is plain to see). */
const MCP_WAIT_MS = 10_000;

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

interface Setup {
  c: TestClient;
  sid: string;
  flag: string;
}

async function setup(): Promise<Setup> {
  const t = tmpEnv();
  const wrapper = path.join(t.root, 'fail-wrapper.mjs');
  fs.writeFileSync(wrapper, WRAPPER);
  const flag = path.join(t.root, 'fail.flag');
  t.env.KIRO_CLAUDE_BIN = wrapper;
  t.env.KC_FAIL_FLAG = flag;
  t.env.KC_FAKE_MCP = JSON.stringify({ oldsrv: { fakeTools: ['ping'] }, newsrv: { fakeTools: ['pong'] } });
  const kiro = path.join(t.work, '.kiro');
  writeAgent(kiro, 'probe', { description: 'launch agent', tools: ['*'], includeMcpJson: false, mcpServers: { oldsrv: { command: 'node', args: ['old.js'] } } });
  writeAgent(kiro, 'withsrv', { description: 'read and newsrv', tools: ['read', '@newsrv'], includeMcpJson: false, mcpServers: { newsrv: { command: 'node', args: ['new.js'] } } });
  const c = new TestClient({ args: ['--agent', 'probe'], env: t.env, cwd: t.work, timings: { mcpWaitMs: MCP_WAIT_MS } });
  clients.push(c);
  await c.initialize();
  const { sessionId } = await c.call('session/new', { cwd: t.work, mcpServers: [] }, 30_000);
  const sid = sessionId as string;
  // the launch agent's server is reported after session/new (KC-ACP-04)
  await c.waitFor((f) => f.method === '_kiro.dev/mcp/server_initialized' && f.params?.serverName === 'oldsrv', 10_000, 'oldsrv initialized');
  return { c, sid, flag };
}

const inits = (s: Setup, name: string): Frame[] => s.c.notifications('_kiro.dev/mcp/server_initialized').filter((f) => f.params?.sessionId === s.sid && f.params?.serverName === name);
const failures = (s: Setup, name: string): Frame[] => s.c.notifications('_kiro.dev/mcp/server_init_failure').filter((f) => f.params?.sessionId === s.sid && f.params?.serverName === name);

async function cmd(s: Setup, name: string, args: Record<string, unknown> = {}): Promise<{ data: Frame; ms: number }> {
  const t0 = Date.now();
  const r = await s.c.call('_kiro.dev/commands/execute', { sessionId: s.sid, command: { command: name, args } }, 60_000);
  return { data: r.data as Frame, ms: Date.now() - t0 };
}
const servers = (d: Frame): string[] => (d.servers as Frame[]).map((x) => `${x.name}:${x.status}`);

async function prompt(s: Setup, text = 'hi'): Promise<Frame> {
  return s.c.request('session/prompt', { sessionId: s.sid, prompt: [{ type: 'text', text }] }, 60_000);
}

/** After the swap: the prompt that starts the child reports its server, no `mcp` command needed. */
async function promptReportsTheNewServer(s: Setup): Promise<void> {
  fs.rmSync(s.flag, { force: true });
  const r = await prompt(s);
  assert.equal(r.result?.stopReason, 'end_turn', JSON.stringify(r));
  await s.c.waitFor(
    (f) => f.method === '_kiro.dev/mcp/server_initialized' && f.params?.sessionId === s.sid && f.params?.serverName === 'newsrv',
    15_000,
    'server_initialized for newsrv after the prompt that started its child (no mcp command)',
  );
  assert.deepEqual(failures(s, 'newsrv'), [], 'no failure reported for newsrv');
  const mcp = await cmd(s, 'mcp');
  assert.deepEqual(servers(mcp.data), ['newsrv:running']);
  await sleep(200);
  assert.equal(inits(s, 'newsrv').length, 1, 'one server_initialized for newsrv');
}

test('set_mode whose restart failed, then a prompt: the new child’s servers are reported without an mcp command', async () => {
  const s = await setup();
  fs.writeFileSync(s.flag, '');
  const sm = await s.c.request('session/set_mode', { sessionId: s.sid, modeId: 'withsrv' }, 60_000);
  assert.deepEqual(sm.result, {}, JSON.stringify(sm));
  await promptReportsTheNewServer(s);
  assert.equal(await s.c.close(10_000), 0);
});

test('commands/execute agent whose restart failed, then a prompt: the new child’s servers are reported', async () => {
  const s = await setup();
  fs.writeFileSync(s.flag, '');
  const swap = await cmd(s, 'agent', { name: 'withsrv' });
  assert.equal((swap.data.agent as Frame).name, 'withsrv', JSON.stringify(swap.data));
  await promptReportsTheNewServer(s);
  assert.equal(await s.c.close(10_000), 0);
});

test('a prompt whose start fails again reports nothing and waits for nothing; the next one reports', async () => {
  const s = await setup();
  fs.writeFileSync(s.flag, '');
  const sm = await s.c.request('session/set_mode', { sessionId: s.sid, modeId: 'withsrv' }, 60_000);
  assert.deepEqual(sm.result, {}, JSON.stringify(sm));
  const failed = await prompt(s);
  assert.ok(failed.error, `the prompt fails while Claude Code cannot start: ${JSON.stringify(failed)}`);
  const mcp = await cmd(s, 'mcp');
  assert.deepEqual(servers(mcp.data), ['newsrv:failed'], JSON.stringify(mcp.data));
  assert.ok(mcp.ms < 1000, `mcp answered in ${mcp.ms} ms`);
  assert.deepEqual(inits(s, 'newsrv'), []);
  assert.deepEqual(failures(s, 'newsrv'), [], 'a server nothing started is not reported as a failed start');
  await promptReportsTheNewServer(s);
  assert.equal(await s.c.close(10_000), 0);
});

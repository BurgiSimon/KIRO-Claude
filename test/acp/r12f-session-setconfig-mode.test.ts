/**
 * r12 #6/#7 (session group), over ACP with the real session: `session/set_config_option`
 * `{configId:'mode'}` that switched the agent answers like `session/set_mode` (r10f-acp-setters,
 * r11f-session-swap-listing): its `configOptions` answer (wire shape unchanged), after the
 * `current_mode_update` and `_kiro.dev/agent/switched` of the swap, is followed by the MCP report
 * (`_kiro.dev/mcp/server_initialized` / `server_init_failure` of the new agent's servers) and an
 * `available_commands_update`. Before, it ran no report after its answer, so the new agent's servers
 * were reported only at a later `mcp` or `tools` command; and after a swap whose Claude Code
 * restart failed, the next prompt (README, ARCHITECTURE "Model, effort and mode changes") did not
 * report them either: only a report sets AcpSessionState.mcpUnstarted, which the turn's drain()
 * reads. A `mode` value that names the current agent answers as before, with no report.
 *
 * Claude Code is test/fixtures/fake-claude.mjs behind a wrapper that exits 1 at every start while
 * a flag file exists (a restart that fails), as in r11f-session-swap-listing.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { fakeClaudePath } from '../claude/helpers.js';
import { TestClient, tmpEnv, writeAgent, type Frame } from './helpers.js';

const clients: TestClient[] = [];
after(async () => {
  await Promise.allSettled(clients.filter((c) => c.exitCode === undefined).map((c) => c.close(10_000)));
});

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
  const c = new TestClient({ args: ['--agent', 'probe'], env: t.env, cwd: t.work, timings: { mcpWaitMs: 10_000 } });
  clients.push(c);
  await c.initialize();
  const { sessionId } = await c.call('session/new', { cwd: t.work, mcpServers: [] }, 30_000);
  const sid = sessionId as string;
  // the report after session/new is done (its server and its available commands)
  await c.waitFor((f) => f.method === '_kiro.dev/mcp/server_initialized' && f.params?.serverName === 'oldsrv', 10_000, 'oldsrv initialized');
  await c.waitFor((f) => f.method === 'session/update' && f.params?.update?.sessionUpdate === 'available_commands_update', 10_000, 'the session/new available commands');
  return { c, sid, flag };
}

const inits = (s: Setup, name: string): Frame[] =>
  s.c.notifications('_kiro.dev/mcp/server_initialized').filter((f) => f.params?.sessionId === s.sid && f.params?.serverName === name);
const allInits = (s: Setup): string[] => s.c.notifications('_kiro.dev/mcp/server_initialized').map((f) => f.params?.serverName as string);

/** Frames from `from` on, named: `upd:<kind>[=mode]`, `<method>(<server|agent>)`, `answer#<id>`. */
function names(s: Setup, from: number): string[] {
  return s.c.frames
    .slice(from)
    .map((f) => {
      if (f.method === 'session/update') return `upd:${f.params.update.sessionUpdate}${f.params.update.currentModeId ? `=${f.params.update.currentModeId}` : ''}`;
      if (f.method) return `${f.method}${f.params?.serverName ? `(${f.params.serverName})` : ''}${f.params?.agentName ? `(${f.params.agentName})` : ''}`;
      return `answer#${f.id}`;
    })
    .filter((n) => !n.startsWith('upd:agent_message_chunk') && !n.startsWith('upd:usage_update'));
}

/** The swap request's frames: current_mode_update and agent/switched, the answer, then the report. */
async function swapFrames(s: Setup, method: 'session/set_mode' | 'session/set_config_option'): Promise<{ result: Frame; order: string[] }> {
  const from = s.c.frames.length;
  const params = method === 'session/set_mode' ? { sessionId: s.sid, modeId: 'withsrv' } : { sessionId: s.sid, configId: 'mode', value: 'withsrv' };
  const r = await s.c.request(method, params, 60_000);
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  await s.c.waitFor((f) => f.method === '_kiro.dev/mcp/server_initialized' && f.params?.serverName === 'newsrv', 10_000, `newsrv initialized after ${method}`, from);
  await s.c.waitFor((f) => f.method === 'session/update' && f.params?.update?.sessionUpdate === 'available_commands_update', 10_000, `available commands after ${method}`, from);
  const order = names(s, from).map((n) => n.replace(/^answer#\d+$/, 'answer'));
  return { result: r.result as Frame, order };
}

test('set_config_option mode: its answer is followed by the new agent’s server_initialized and available commands, as for set_mode', async () => {
  const control = await setup();
  const sm = await swapFrames(control, 'session/set_mode');
  assert.deepEqual(sm.result, {});
  const s = await setup();
  const sc = await swapFrames(s, 'session/set_config_option');
  // the answer is unchanged: configOptions only (model and effortLevel)
  assert.deepEqual(Object.keys(sc.result), ['configOptions']);
  assert.deepEqual((sc.result.configOptions as Frame[]).map((o) => o.id), ['model', 'effortLevel']);
  const expected = ['upd:current_mode_update=withsrv', '_kiro.dev/agent/switched(withsrv)', 'answer', '_kiro.dev/mcp/server_initialized(newsrv)', 'upd:available_commands_update'];
  assert.deepEqual(sm.order, expected, `set_mode: ${sm.order.join(' | ')}`);
  assert.deepEqual(sc.order, expected, `set_config_option mode: ${sc.order.join(' | ')}`);
  assert.equal(inits(s, 'newsrv').length, 1);
  assert.equal(await control.c.close(10_000), 0);
  assert.equal(await s.c.close(10_000), 0);
});

test('set_config_option mode whose Claude Code restart failed: the next prompt reports the new agent’s servers (README)', async () => {
  const s = await setup();
  fs.writeFileSync(s.flag, '');
  const from = s.c.frames.length;
  const sc = await s.c.request('session/set_config_option', { sessionId: s.sid, configId: 'mode', value: 'withsrv' }, 60_000);
  assert.equal(sc.error, undefined, JSON.stringify(sc.error));
  assert.deepEqual(Object.keys(sc.result as Frame), ['configOptions']);
  // the post-answer report does not wait for servers nothing starts: its available commands follow at once
  await s.c.waitFor((f) => f.method === 'session/update' && f.params?.update?.sessionUpdate === 'available_commands_update', 5000, 'the post-answer report (well under mcpWaitMs)', from);
  assert.equal(inits(s, 'newsrv').length, 0, 'no child runs newsrv yet');
  assert.equal(s.c.notifications('_kiro.dev/mcp/server_init_failure').length, 0, 'no failure is reported for a server nothing started');
  fs.rmSync(s.flag, { force: true });
  const r = await s.c.request('session/prompt', { sessionId: s.sid, prompt: [{ type: 'text', text: 'hi' }] }, 60_000);
  assert.equal(r.result?.stopReason, 'end_turn', JSON.stringify(r));
  await s.c.waitFor((f) => f.method === '_kiro.dev/mcp/server_initialized' && f.params?.serverName === 'newsrv', 8000, `newsrv initialized after the prompt (got ${JSON.stringify(allInits(s))})`, from);
  assert.equal(inits(s, 'newsrv').length, 1);
  assert.equal(await s.c.close(10_000), 0);
});

test('control: set_config_option mode naming the current agent answers configOptions and sends no report', async () => {
  const s = await setup();
  const acu = (): number => s.c.updates('available_commands_update', s.sid).length;
  const before = acu();
  const from = s.c.frames.length;
  const sc = await s.c.request('session/set_config_option', { sessionId: s.sid, configId: 'mode', value: 'probe' }, 60_000);
  assert.equal(sc.error, undefined, JSON.stringify(sc.error));
  assert.deepEqual(Object.keys(sc.result as Frame), ['configOptions']);
  await new Promise((res) => setTimeout(res, 500));
  assert.deepEqual(
    names(s, from).map((n) => n.replace(/^answer#\d+$/, 'answer')),
    ['upd:current_mode_update=probe', 'answer'],
  );
  assert.equal(acu(), before);
  assert.deepEqual(allInits(s), ['oldsrv']);
  assert.equal(await s.c.close(10_000), 0);
});

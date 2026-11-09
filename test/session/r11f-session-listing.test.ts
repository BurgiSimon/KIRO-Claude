/**
 * r11 #4 (session group): with no Claude Code child, the session's own listings describe the
 * agent and configuration it switched to, and its MCP servers are not reported as starting.
 *
 * An agent swap (`/agent swap`, ACP set_mode) switches the agent first and then restarts Claude
 * Code; when that restart failed, closeProc had run and spawn had thrown before it recorded the new
 * launch, so `toolListing()`, `mcpStatus()` and `contextReport()` described the agent the session
 * left (its tools, its MCP servers as `pending`, its resources) until a prompt started a child, and
 * every `pending` server made the ACP `tools` / `mcp` commands wait the whole MCP start-up budget
 * for servers nothing would start. Now the launch spawn tried is the one the listings read, and
 * while no child runs or starts (a restart that failed, a child that died) the agent's servers are
 * `stopped` (with the reason) at once; the next prompt starts the child and its servers. A child
 * that is starting still reports its servers `pending`. The same holds for every restart that can
 * fail (`/context add`, `/tangent`).
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { ClaudeBinary, ClaudeCapabilities } from '../../src/claude/binary.js';
import { KiroSessionImpl, type KiroSessionInternalOptions } from '../../src/session/kiroSession.js';
import { closeAll, drain, fakeBinary, fakeCaps, fakeClaudePath, flagValue, mkSandbox, recordingUI, type Sandbox } from './helpers.js';

let caps: ClaudeCapabilities;
before(async () => {
  caps = await fakeCaps();
});

/**
 * fake-claude with MCP tools: the launch writes only the server fields Claude Code reads, so this
 * wrapper adds the fake's `fakeTools` / `fakeStatus` to the servers named in $KC_FAKE_MCP.
 */
const WRAPPER = `import * as fs from 'node:fs';
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
function wrapperBinary(sb: Sandbox): ClaudeBinary {
  const p = path.join(sb.root, 'fake-mcp-wrapper.mjs');
  fs.writeFileSync(p, WRAPPER);
  sb.env.KC_FAKE_MCP = JSON.stringify({ oldsrv: { fakeTools: ['ping'] }, newsrv: { fakeTools: ['pong'] } });
  return { ...fakeBinary(), path: p };
}

const open = (sb: Sandbox, over: Partial<KiroSessionInternalOptions> = {}): Promise<KiroSessionImpl> =>
  KiroSessionImpl.create({ ws: sb.ws, origin: 'repl', interactive: true, ui: recordingUI(), binary: wrapperBinary(sb), caps, env: sb.env, ...over });

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 20_000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

/** probe: every tool and oldsrv; reader: read only, no MCP; withsrv: read and newsrv. */
function agents(sb: Sandbox): void {
  sb.write('PROBE.md', 'probe resource\n');
  sb.write('READER.md', 'reader resource\n');
  sb.agent('probe', {
    tools: ['*'],
    resources: ['file://PROBE.md'],
    includeMcpJson: false,
    mcpServers: { oldsrv: { command: 'node', args: ['old.js'] } },
  });
  sb.agent('reader', { tools: ['read'], resources: ['file://READER.md'], includeMcpJson: false });
  sb.agent('withsrv', {
    tools: ['read', '@newsrv'],
    includeMcpJson: false,
    mcpServers: { newsrv: { command: 'node', args: ['new.js'] } },
  });
}

const names = (s: KiroSessionImpl): string[] => s.toolListing().map((t) => t.name);
async function timedStatus(s: KiroSessionImpl): Promise<{ list: string[]; ms: number; errors: string[] }> {
  const t0 = Date.now();
  const st = await s.mcpStatus();
  return { list: st.map((e) => `${e.name}:${e.status}`), ms: Date.now() - t0, errors: st.map((e) => e.error ?? '') };
}
const contextFiles = async (s: KiroSessionImpl): Promise<string[]> => {
  const r = await s.contextReport();
  return [...r.agentEntries, ...r.sessionEntries].flatMap((e) => e.files.map((f) => f.path.split('/').pop()!));
};

describe('r11f #4: listings with no Claude Code child', () => {
  it('an agent swap whose restart failed: tools, MCP servers and context are the new agent’s at once; the next prompt starts its child, no wider', async () => {
    const sb = mkSandbox();
    agents(sb);
    const s = await open(sb, { agentName: 'probe' });
    try {
      assert.deepEqual((await timedStatus(s)).list, ['oldsrv:connected'], 'sanity: the launch agent’s server runs');
      assert.ok(names(s).includes('@oldsrv/ping') && names(s).includes('shell'), names(s).join(','));

      sb.env.FAKE_CLAUDE_EXIT_ON_START = '1';
      await assert.rejects(s.swapAgent('reader'));
      assert.equal(s.agent.name, 'reader', 'the swap took place');
      assert.equal(s.process, undefined, 'no child runs');

      const tools = names(s);
      const st = await timedStatus(s);
      const ctx = await contextFiles(s);
      assert.deepEqual(tools, ['read', 'glob', 'grep'], `tools after the failed restart: ${tools.join(',')}`);
      assert.deepEqual(st.list, [], `mcp after the failed restart: ${st.list.join(',')}`);
      assert.ok(st.ms < 1000, `mcpStatus answered in ${st.ms} ms`);
      assert.deepEqual(ctx, ['READER.md'], `context after the failed restart: ${ctx.join(',')}`);

      delete sb.env.FAKE_CLAUDE_EXIT_ON_START;
      const n = sb.starts().length;
      await drain(s.prompt({ text: 'hi' }));
      assert.equal(sb.starts().length, n + 1, 'the prompt started the child');
      const argv = sb.starts().at(-1)!;
      assert.equal(flagValue(argv, '--tools'), 'Read,Glob,Grep', 'the child runs the reader agent’s tools only');
      assert.deepEqual(names(s), tools, 'the listing agrees with the child the prompt started');
      assert.deepEqual((await timedStatus(s)).list, []);
      assert.deepEqual(await contextFiles(s), ctx);
    } finally {
      delete sb.env.FAKE_CLAUDE_EXIT_ON_START;
      await closeAll(s);
    }
  });

  it('a swap to an agent with MCP servers whose restart failed: its servers are stopped (not pending) at once, then connect with the next prompt', async () => {
    const sb = mkSandbox();
    agents(sb);
    const s = await open(sb, { agentName: 'probe' });
    try {
      sb.env.FAKE_CLAUDE_EXIT_ON_START = '1';
      await assert.rejects(s.swapAgent('withsrv'));
      assert.equal(s.agent.name, 'withsrv');
      const st = await timedStatus(s);
      assert.deepEqual(st.list, ['newsrv:stopped'], st.list.join(','));
      assert.match(st.errors[0]!, /Claude Code is not running/);
      assert.ok(st.ms < 1000, `mcpStatus answered in ${st.ms} ms`);
      assert.deepEqual(names(s), ['read', 'glob', 'grep'], 'no tool of the server nothing started, none of the agent left');

      delete sb.env.FAKE_CLAUDE_EXIT_ON_START;
      await drain(s.prompt({ text: 'hi' }));
      assert.deepEqual((await timedStatus(s)).list, ['newsrv:connected']);
      assert.deepEqual(names(s), ['read', 'glob', 'grep', '@newsrv/pong']);
    } finally {
      delete sb.env.FAKE_CLAUDE_EXIT_ON_START;
      await closeAll(s);
    }
  });

  it('a child that died: its servers are stopped, not pending; the next prompt restarts them', async () => {
    const sb = mkSandbox();
    agents(sb);
    const s = await open(sb, { agentName: 'probe' });
    try {
      const proc = s.process!;
      process.kill(proc.pid!, 'SIGKILL');
      await until(() => !proc.running, 20_000, 'the child to exit');
      const st = await timedStatus(s);
      assert.deepEqual(st.list, ['oldsrv:stopped'], st.list.join(','));
      assert.ok(st.ms < 1000, `mcpStatus answered in ${st.ms} ms`);
      await drain(s.prompt({ text: 'after the crash' }));
      assert.deepEqual((await timedStatus(s)).list, ['oldsrv:connected']);
    } finally {
      await closeAll(s);
    }
  });

  it('control: while a restart’s child is starting, the servers of the agent it starts are pending', async () => {
    const sb = mkSandbox();
    agents(sb);
    const s = await open(sb, { agentName: 'probe' });
    try {
      const n = sb.starts().length;
      // the new child answers initialize late: the restart is in flight meanwhile
      sb.env.FAKE_CLAUDE_CONTROL_DELAYS = JSON.stringify({ initialize: 4000 });
      const swap = s.swapAgent('withsrv');
      swap.catch(() => undefined);
      await until(() => sb.starts().length > n && s.process === undefined, 20_000, 'the restart’s child to start');
      const st = await timedStatus(s);
      assert.deepEqual(st.list, ['newsrv:pending'], st.list.join(','));
      delete sb.env.FAKE_CLAUDE_CONTROL_DELAYS;
      await swap;
      assert.deepEqual((await timedStatus(s)).list, ['newsrv:connected']);
    } finally {
      delete sb.env.FAKE_CLAUDE_CONTROL_DELAYS;
      await closeAll(s);
    }
  });

  it('other restarts that fail (/context add, /tangent): the listings are the session’s, its servers stopped at once', async () => {
    const sb = mkSandbox();
    agents(sb);
    sb.write('EXTRA.md', 'extra context\n');
    const s = await open(sb, { agentName: 'reader' });
    try {
      await drain(s.prompt({ text: 'first' }));
      sb.env.FAKE_CLAUDE_EXIT_ON_START = '1';
      // a context rule added: the restart that carries it failed; /context shows it all the same
      await assert.rejects(s.addContext(['EXTRA.md']));
      assert.equal(s.process, undefined);
      assert.deepEqual(await contextFiles(s), ['READER.md', 'EXTRA.md']);
      delete sb.env.FAKE_CLAUDE_EXIT_ON_START;
      await drain(s.prompt({ text: 'second' }));

      // a swap to withsrv that works, then a tangent whose fork and main's restart both fail
      await s.swapAgent('withsrv');
      assert.deepEqual((await timedStatus(s)).list, ['newsrv:connected']);
      sb.env.FAKE_CLAUDE_EXIT_ON_START = '1';
      await assert.rejects(s.enterTangent('side'));
      assert.equal(s.process, undefined);
      const st = await timedStatus(s);
      assert.deepEqual(st.list, ['newsrv:stopped'], st.list.join(','));
      assert.ok(st.ms < 1000, `mcpStatus answered in ${st.ms} ms`);
      assert.deepEqual(names(s), ['read', 'glob', 'grep']);
      delete sb.env.FAKE_CLAUDE_EXIT_ON_START;
      await drain(s.prompt({ text: 'third' }));
      assert.deepEqual((await timedStatus(s)).list, ['newsrv:connected']);
    } finally {
      delete sb.env.FAKE_CLAUDE_EXIT_ON_START;
      await closeAll(s);
    }
  });
});

/**
 * Kiro hook commands do not outlive kiro-claude (review C12), as real processes: an agent
 * `hooky` whose preToolUse hook runs `touch <marker>; sleep <tag>` (60 s timeout) is running
 * when kiro-claude is told to stop. Hook commands run in their own process group, so before
 * the fix they were reparented to init and ran on (their timeout timer died with kiro-claude).
 *
 *  - `kiro-claude acp` + SIGTERM / SIGHUP (exit 143 / 129, the ACP server's own shutdown);
 *  - `kiro-claude chat --no-interactive` + SIGINT (exit 130);
 *  - `session/cancel` while the hook runs: the hook is killed and the server stays up. This
 *    needs KiroSession's hook_callback handler to pass its cancel signal to the gate
 *    (src/session/kiroSession.ts, outside this change), so it is a TODO until that lands.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { it } from 'node:test';

import { fakeClaudePath, fakeEnv, mkTmp } from '../claude/helpers.js';
import { builtModule, isLinux, spawnNode, waitForLine, type AsyncRun } from '../claude/hang-helpers.js';

const opts = isLinux ? {} : { skip: 'needs /proc (Linux)' };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
let n = 0;

/** pids of live (non-zombie) processes whose argv contains `tag`. */
function liveWith(tag: string): number[] {
  const out: number[] = [];
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      if (!fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').includes(tag)) continue;
      const stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
      const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
      if (state !== 'Z' && state !== 'X') out.push(Number(d));
    } catch {
      /* gone */
    }
  }
  return out;
}

function reap(tag: string): void {
  for (const pid of liveWith(tag)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
}

async function until(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(25);
  }
  return pred();
}

interface Fixture {
  root: string;
  work: string;
  env: NodeJS.ProcessEnv;
  tag: string;
  marker: string;
}

function fixture(): Fixture {
  const tag = `53.${process.pid}${++n}`;
  const root = fs.realpathSync(mkTmp('kc-hook-life-'));
  const home = path.join(root, 'home');
  const work = path.join(root, 'work');
  const runtime = path.join(root, 'run');
  const marker = path.join(root, 'hook-started');
  for (const d of [work, runtime, path.join(home, '.kiro', 'agents')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(
    path.join(home, '.kiro', 'agents', 'hooky.json'),
    JSON.stringify({
      name: 'hooky',
      description: 'agent with a slow preToolUse hook',
      tools: ['*'],
      allowedTools: ['*'],
      hooks: { preToolUse: [{ command: `touch '${marker}'; sleep ${tag}; echo hookdone`, timeout_ms: 60_000 }] },
    }),
  );
  const env = fakeEnv({
    HOME: home,
    KIRO_HOME: path.join(home, '.kiro'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    XDG_RUNTIME_DIR: runtime,
    KIRO_CLAUDE_BIN: fakeClaudePath(),
    FAKE_CLAUDE_LOG: path.join(root, 'fake.jsonl'),
    FAKE_CLAUDE_SCRIPT_JSON: JSON.stringify({ turns: [{ steps: [{ tool: { name: 'Bash', input: { command: 'echo hi' } } }, { text: 'done' }] }] }),
  });
  return { root, work, env, tag, marker };
}

async function acpWithRunningHook(f: Fixture): Promise<{ run: AsyncRun; send(o: unknown): void; sid: string }> {
  const run = spawnNode([builtModule('bin/kiro-claude.js'), 'acp', '--agent', 'hooky'], { env: f.env, cwd: f.work, capMs: 40_000 });
  const send = (o: unknown): void => {
    run.child.stdin!.write(`${JSON.stringify(o)}\n`);
  };
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } });
  await waitForLine(run, (o) => o.id === 1);
  send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: f.work, mcpServers: [] } });
  const created = await waitForLine(run, (o) => o.id === 2, 20_000);
  const sid = (created.result as { sessionId?: string } | undefined)?.sessionId;
  assert.ok(sid, `session/new failed: ${JSON.stringify(created)}`);
  send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: sid, prompt: [{ type: 'text', text: 'go' }] } });
  assert.ok(await until(() => fs.existsSync(f.marker) && liveWith(f.tag).length > 0, 20_000), `hook did not start; stderr=${run.stderr()}`);
  return { run, send, sid };
}

for (const [sig, code] of [['SIGTERM', 143], ['SIGHUP', 129]] as const) {
  it(`acp ${sig}: a running preToolUse hook does not outlive kiro-claude (exit ${code})`, opts, async (t) => {
    const f = fixture();
    t.after(() => {
      reap(f.tag);
      fs.rmSync(f.root, { recursive: true, force: true });
    });
    const { run } = await acpWithRunningHook(f);
    run.child.kill(sig);
    const res = await run.done;
    assert.equal(res.killedByTest, false, `stderr=${run.stderr()}`);
    assert.equal(res.code, code, `signal=${res.signal}; stderr=${run.stderr()}`);
    assert.ok(await until(() => liveWith(f.tag).length === 0, 1500), `hook still running after kiro-claude exited: ${liveWith(f.tag).join(' ')}`);
  });
}

it('chat --no-interactive SIGINT: a running preToolUse hook does not outlive kiro-claude (exit 130)', opts, async (t) => {
  const f = fixture();
  t.after(() => {
    reap(f.tag);
    fs.rmSync(f.root, { recursive: true, force: true });
  });
  const run = spawnNode([builtModule('bin/kiro-claude.js'), 'chat', '--no-interactive', '--trust-all-tools', '--agent', 'hooky', 'go'], {
    env: f.env,
    cwd: f.work,
    capMs: 40_000,
  });
  assert.ok(await until(() => fs.existsSync(f.marker) && liveWith(f.tag).length > 0, 20_000), `hook did not start; stderr=${run.stderr()}`);
  run.child.kill('SIGINT');
  const res = await run.done;
  assert.equal(res.killedByTest, false, `stderr=${run.stderr()}`);
  assert.equal(res.code, 130, `signal=${res.signal}; stderr=${run.stderr()}`);
  assert.ok(await until(() => liveWith(f.tag).length === 0, 1500), `hook still running after kiro-claude exited: ${liveWith(f.tag).join(' ')}`);
});

it(
  'acp session/cancel: the running preToolUse hook is killed and the server stays up',
  opts,
  async (t) => {
    const f = fixture();
    t.after(() => {
      reap(f.tag);
      fs.rmSync(f.root, { recursive: true, force: true });
    });
    const { run, send, sid } = await acpWithRunningHook(f);
    send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: sid } });
    const r = await waitForLine(run, (o) => o.id === 3, 20_000);
    assert.equal((r.result as { stopReason?: string } | undefined)?.stopReason, 'cancelled');
    const gone = await until(() => liveWith(f.tag).length === 0, 1000);
    assert.equal(run.child.exitCode, null, 'server still up');
    run.child.stdin!.end();
    await run.done;
    assert.ok(gone, 'hook still running 1 s after the turn was cancelled');
  },
);

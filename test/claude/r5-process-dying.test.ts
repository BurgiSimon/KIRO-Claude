/**
 * Review round 5, H2: while a fatal signal that nothing else in kiro-claude handles is forwarded
 * to the children (claude/lifecycle.ts, up to KILL_GRACE_MS for the leaders), the rest of
 * kiro-claude used to keep reacting to the dying children: a session respawned the claude child
 * and sent it the prompt, the prompt went to the dying claude, a permission request was handed
 * to the gate (and could be allowed), a hook killed by the signal was reported as failed and new
 * hook commands were started.
 *
 * lifecycle now exposes the state (`dyingSignal()`), and the spawn sites it owns check it:
 * ClaudeProcess.start() refuses to start a child, a ClaudeProcess writes nothing more to its
 * child and hands no CLI request to the handlers (it is never answered: no tool can be allowed),
 * runShell() starts no command and reports a run the signal ended as `aborted` (no failure
 * report). Should another listener swallow the re-raised signal (it owns the shutdown from then
 * on), the state is cleared again.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import * as lifecycle from '../../src/claude/lifecycle.js';
import { STREAM_ARGS, fakeClaudePath, fakeEnv, mkTmp, readJsonl } from './helpers.js';
import { builtModule, isLinux, spawnNode, waitForLine } from './hang-helpers.js';

const linux = { skip: !isLinux };

/** Every JSON line of `stdout` (the driver's events). */
function events(stdout: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const l of stdout.split('\n')) {
    if (!l.trim().startsWith('{')) continue;
    try {
      out.push(JSON.parse(l) as Record<string, unknown>);
    } catch {
      /* partial */
    }
  }
  return out;
}

describe("lifecycle: kiro-claude's 'dying' state (r5 H2)", () => {
  it('dyingSignal() is exported and undefined while no fatal signal is being forwarded', () => {
    const fn = (lifecycle as Record<string, unknown>).dyingSignal;
    assert.equal(typeof fn, 'function', 'claude/lifecycle.ts exports dyingSignal()');
    assert.equal((fn as () => unknown)(), undefined);
  });

  /**
   * A kiro-claude stand-in with no signal listener of its own. Claude Code A ignores SIGTERM and
   * stdin EOF, so a forwarded SIGTERM's grace runs its full KILL_GRACE_MS; its turn asks for a
   * tool permission 300 ms in. A hook-like `sleep` runs too. On "go" (sent during the grace) it
   * tries what a session and the hooks would do.
   */
  function writeDriver(dir: string): string {
    const driver = path.join(dir, 'dying-driver.mjs');
    const marker = path.join(dir, 'shell2-ran');
    fs.writeFileSync(
      driver,
      `const { ClaudeProcess } = await import(${JSON.stringify(builtModule('claude/process.js'))});
const lifecycle = await import(${JSON.stringify(builtModule('claude/lifecycle.js'))});
const { runShell } = await import(${JSON.stringify(builtModule('util/process.js'))});
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const opts = (log) => ({
  binary: { path: ${JSON.stringify(fakeClaudePath())}, version: '2.1.318', rawVersion: '2.1.318 (Claude Code)' },
  args: ${JSON.stringify([...STREAM_ARGS])},
  cwd: process.cwd(),
  env: { ...process.env, FAKE_CLAUDE_LOG: log },
  initialize: {},
  handlers: {
    onHookCallback: async () => ({}),
    onCanUseTool: async (r) => { say({ event: 'can_use_tool', tool: r.tool_name }); return { behavior: 'allow', updatedInput: r.input }; },
  },
});
const a = await ClaudeProcess.start(opts(${JSON.stringify(path.join(dir, 'a.log'))}));
void (async () => { try { for await (const _ of a.turn('first prompt')) {} } catch (e) { say({ event: 'turn-error', message: String(e && e.message) }); } })();
void runShell('sleep 30', { cwd: process.cwd(), timeoutMs: 60000 }).then((r) => say({ event: 'shell1', signal: r.signal, aborted: r.aborted === true }));
process.stdin.on('data', async (d) => {
  if (!String(d).includes('go')) return;
  say({ event: 'dying', signal: lifecycle.dyingSignal ? lifecycle.dyingSignal() ?? null : null });
  try {
    const b = await ClaudeProcess.start(opts(${JSON.stringify(path.join(dir, 'b.log'))}));
    say({ event: 'startB', ok: true, pid: b.pid });
  } catch (e) {
    say({ event: 'startB', ok: false, message: String(e && e.message) });
  }
  try {
    a.sendUserMessage('second prompt');
    say({ event: 'send', ok: true });
  } catch (e) {
    say({ event: 'send', ok: false, message: String(e && e.message) });
  }
  const r = await runShell(${JSON.stringify(`echo ran > '${marker}'`)}, { cwd: process.cwd() });
  say({ event: 'shell2', aborted: r.aborted === true, exitCode: r.exitCode, error: r.error ?? null, ran: (await import('node:fs')).existsSync(${JSON.stringify(marker)}) });
});
say({ event: 'ready', childPid: a.pid });
setInterval(() => {}, 1000);
`,
    );
    return driver;
  }

  it('during a forwarded SIGTERM: no Claude Code is started, nothing is written to the dying one, its permission request is not handled, hooks are not started nor reported as failed', linux, async () => {
    const dir = mkTmp();
    const script = { default: { steps: [{ sleepMs: 300 }, { tool: { name: 'Bash', input: { command: 'echo x' }, permission: 'ask' } }, { text: 'done' }] } };
    const run = spawnNode([writeDriver(dir)], {
      cwd: dir,
      env: fakeEnv({ FAKE_CLAUDE_IGNORE_SIGTERM: '1', FAKE_CLAUDE_HANG_ON_EOF: '1', FAKE_CLAUDE_SCRIPT_JSON: JSON.stringify(script) }),
      capMs: 20_000,
    });
    try {
      await waitForLine(run, (o) => o.event === 'ready');
      // the turn is running (its first step sleeps), the hook's sleep too
      const end = Date.now() + 5_000;
      while (!readJsonl(path.join(dir, 'a.log')).some((e) => e.event === 'turn') && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
      process.kill(run.child.pid!, 'SIGTERM');
      await new Promise((r) => setTimeout(r, 100));
      run.child.stdin!.write('go\n');
      const res = await run.done;
      assert.equal(res.killedByTest, false);
      assert.equal(res.signal, 'SIGTERM', `the stand-in still dies of SIGTERM (code=${res.code}, stderr=${run.stderr()})`);
      const ev = events(run.stdout());
      const get = (name: string): Record<string, unknown> | undefined => ev.find((e) => e.event === name);
      assert.equal(get('startB')?.ok, false, `a Claude Code child was started while kiro-claude was dying: ${JSON.stringify(get('startB'))}`);
      assert.equal(readJsonl(path.join(dir, 'b.log')).filter((e) => e.event === 'start').length, 0, 'no second Claude Code ran');
      assert.equal(get('send')?.ok, false, 'a user line was written to the dying Claude Code');
      const lines = readJsonl(path.join(dir, 'a.log')).filter((e) => e.event === 'stdin' && e.line).map((e) => JSON.stringify(e.line));
      assert.equal(lines.some((l) => l.includes('second prompt')), false, 'the dying Claude Code received the second prompt');
      assert.equal(get('can_use_tool'), undefined, "the dying Claude Code's permission request was handed to the gate");
      assert.equal(lines.some((l) => l.includes('"behavior":"allow"')), false, 'a tool was allowed while kiro-claude was dying');
      assert.deepEqual(get('shell1'), { event: 'shell1', signal: 'SIGTERM', aborted: true }, 'a hook the forwarded signal ended is reported as aborted, not failed');
      assert.equal(get('shell2')?.aborted, true, `a hook started while dying: ${JSON.stringify(get('shell2'))}`);
      assert.equal(get('shell2')?.ran, false, 'the hook command ran while kiro-claude was dying');
      assert.equal(get('dying')?.signal, 'SIGTERM', 'dyingSignal() names the signal while its grace runs');
    } finally {
      run.child.kill('SIGKILL');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a re-raised signal another listener swallows (it owns the shutdown now) clears the state: children can be started again', linux, async () => {
    const dir = mkTmp();
    const driver = path.join(dir, 'swallow-driver.mjs');
    fs.writeFileSync(
      driver,
      `const { ClaudeProcess } = await import(${JSON.stringify(builtModule('claude/process.js'))});
const lifecycle = await import(${JSON.stringify(builtModule('claude/lifecycle.js'))});
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const opts = {
  binary: { path: ${JSON.stringify(fakeClaudePath())}, version: '2.1.318', rawVersion: '2.1.318 (Claude Code)' },
  args: ${JSON.stringify([...STREAM_ARGS])},
  cwd: process.cwd(),
  env: process.env,
  initialize: {},
  handlers: { onHookCallback: async () => ({}), onCanUseTool: async (r) => ({ behavior: 'allow', updatedInput: r.input }) },
};
const a = await ClaudeProcess.start(opts);
a.on('exit', (info) => say({ event: 'a-exit', signal: info.signal }));
process.stdin.on('data', (d) => {
  if (!String(d).includes('go')) return;
  // A front end that starts during the grace: from now on it owns SIGTERM.
  process.on('SIGTERM', async () => {
    say({ event: 'swallowed', dying: lifecycle.dyingSignal ? lifecycle.dyingSignal() ?? null : null });
    try {
      const b = await ClaudeProcess.start(opts);
      say({ event: 'startB', ok: true });
      await b.close({ graceMs: 0 });
    } catch (e) {
      say({ event: 'startB', ok: false, message: String(e && e.message) });
    }
    process.exit(0);
  });
});
say({ event: 'ready' });
setInterval(() => {}, 1000);
`,
    );
    const run = spawnNode([driver], { cwd: dir, env: fakeEnv({ FAKE_CLAUDE_IGNORE_SIGTERM: '1', FAKE_CLAUDE_HANG_ON_EOF: '1' }), capMs: 20_000 });
    try {
      await waitForLine(run, (o) => o.event === 'ready');
      process.kill(run.child.pid!, 'SIGTERM');
      await new Promise((r) => setTimeout(r, 100));
      run.child.stdin!.write('go\n');
      const swallowed = await waitForLine(run, (o) => o.event === 'swallowed', 10_000);
      assert.equal(swallowed.dying, null, 'the dying state is cleared once another listener took the re-raised signal');
      const startB = await waitForLine(run, (o) => o.event === 'startB', 10_000);
      assert.equal(startB.ok, true, JSON.stringify(startB));
      const res = await run.done;
      assert.equal(res.code, 0);
      assert.equal(events(run.stdout()).find((e) => e.event === 'a-exit')?.signal, 'SIGKILL', 'Claude Code A was SIGKILLed after the grace');
    } finally {
      run.child.kill('SIGKILL');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

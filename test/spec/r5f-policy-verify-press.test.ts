/**
 * Round 5 fixes, group policy, verifier (known gap g1): `kiro-claude spec run`'s next Ctrl+C
 * (spec/cli.ts NextPress). A press reports "busy" (the run goes on, nothing exits) only when a
 * PostTaskExec hook runs under the signal THAT press aborts. Before the fix it counted every
 * hook under any signal it ever handed out, also one a previous press had already aborted, so
 * while such a hook had not yet settled (runShell waits up to its close grace for pipes a
 * grandchild keeps open; a process stuck in the kernel never reports its SIGKILL) every further
 * Ctrl+C was swallowed and `spec run` could not be stopped from the keyboard at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { HookRunnerLike } from '../../src/types.js';
import { NextPress } from '../../src/spec/cli.js';
import { builtBin } from '../cli/helpers.js';
import { fakeClaudePath } from '../claude/helpers.js';
import { startTicksOf } from '../claude/pid-reuse-helpers.js';
import { DESIGN_MD, REQ_MD, TASKS_MD } from './helpers.js';

/** A runner whose task hook settles only when the test says so (it ignores its signal). */
function stuckRunner(): { runner: { runTaskHook(ctx: { signal?: AbortSignal }): Promise<string> }; settle(): void } {
  const waiters: (() => void)[] = [];
  return {
    runner: {
      runTaskHook(): Promise<string> {
        return new Promise((resolve) => waiters.push(() => resolve('done')));
      },
    },
    settle: () => {
      for (const w of waiters.splice(0)) w();
    },
  };
}

test('g1 verify: a press after the one that killed a hook exits, even while that hook has not settled yet', async () => {
  const p = new NextPress();
  const { runner, settle } = stuckRunner();
  const tracked = p.track(runner as unknown as HookRunnerLike) as unknown as typeof runner;
  const s1 = p.signal();
  const run = tracked.runTaskHook({ signal: s1 });
  assert.equal(p.press(), true, 'the second press kills the hook running under its signal');
  assert.equal(s1.aborted, true);
  assert.equal(p.press(), false, 'the third press has nothing under it: it must exit');
  assert.equal(p.press(), false, 'and so does every later one');
  settle();
  assert.equal(await run, 'done');
});

test('g1 verify: a hook started under a fresh signal after a press is killed by the next press, then the following one exits', async () => {
  const p = new NextPress();
  const a = stuckRunner();
  const b = stuckRunner();
  const ta = p.track(a.runner as unknown as HookRunnerLike) as unknown as typeof a.runner;
  const tb = p.track(b.runner as unknown as HookRunnerLike) as unknown as typeof b.runner;
  const runA = ta.runTaskHook({ signal: p.signal() });
  assert.equal(p.press(), true, 'kills task A’s hook');
  const s2 = p.signal();
  const runB = tb.runTaskHook({ signal: s2 });
  assert.equal(p.press(), true, 'kills task B’s hook, started after that press');
  assert.equal(s2.aborted, true);
  assert.equal(p.press(), false, 'nothing under the next press: exit');
  a.settle();
  b.settle();
  await Promise.all([runA, runB]);
  assert.equal(p.press(), false);
});

// ───────────── end to end: the built `kiro-claude spec run` over the fake claude ─────────────

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Proc {
  pid: number;
  ticks: number | undefined;
}
const alive = (p: Proc): boolean => p.ticks !== undefined && startTicksOf(p.pid) === p.ticks;

async function pidIn(file: string, out: () => string, ms = 20_000): Promise<Proc> {
  const t0 = Date.now();
  for (;;) {
    const v = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '';
    if (/^\d+$/.test(v)) return { pid: Number(v), ticks: startTicksOf(Number(v)) };
    if (Date.now() - t0 > ms) throw new Error(`no pid in ${file}\n--- out:\n${out()}`);
    await sleep(25);
  }
}

test(
  'g1 verify e2e: a third Ctrl+C right after the second one killed a PostTaskExec hook whose grandchild keeps its pipes open exits at once',
  { timeout: 90_000, skip: process.platform === 'win32' || !fs.existsSync('/usr/bin/setsid') ? 'needs setsid' : false },
  async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kc-r5f-policy-verify-')));
    const home = path.join(root, 'home');
    const ws = path.join(root, 'proj');
    const kiroHome = path.join(home, '.kiro');
    const procs: Proc[] = [];
    let child: ChildProcess | undefined;
    try {
      for (const d of [home, path.join(ws, '.kiro'), path.join(root, 'cache'), path.join(kiroHome, 'hooks')]) fs.mkdirSync(d, { recursive: true });
      fs.mkdirSync(path.join(root, 'run'), { mode: 0o700 });
      const dir = path.join(ws, '.kiro', 'specs', 'todo-export');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'requirements.md'), REQ_MD);
      fs.writeFileSync(path.join(dir, 'design.md'), DESIGN_MD);
      fs.writeFileSync(path.join(dir, 'tasks.md'), TASKS_MD);
      const hookPid = path.join(root, 'post.pid');
      const keeperPid = path.join(root, 'keeper.pid');
      // the hook ignores TERM/INT/HUP; its grandchild leaves the group (setsid) and keeps the
      // hook's stdout/stderr open, so runShell settles only after its close grace
      const command = `trap '' TERM INT HUP; setsid sh -c 'echo $$ > "${keeperPid}"; exec sleep 30' & echo $$ > '${hookPid}'; sleep 20`;
      fs.writeFileSync(
        path.join(kiroHome, 'hooks', 'post.json'),
        JSON.stringify({ version: 'v1', hooks: [{ name: 'slow-post', trigger: 'PostTaskExec', timeout: 0, action: { type: 'command', command } }] }),
      );
      const script = {
        turns: [
          { repeat: true, match: 'Execute Task: 1\\.1', steps: [{ text: 'TASK-WORKING' }, { sleepMs: 20_000 }, { text: 'done\nTASK_RESULT: completed' }] },
          { repeat: true, match: 'Execute Task', steps: [{ text: 'done\nTASK_RESULT: completed' }] },
          { repeat: true, steps: [{ text: 'ANSWER' }] },
        ],
      };
      const env: NodeJS.ProcessEnv = {};
      for (const [k, v] of Object.entries(process.env)) if (!/^(FAKE_CLAUDE_|KIRO|CLAUDE|XDG_|ANTHROPIC_)/.test(k) && v !== undefined) env[k] = v;
      Object.assign(env, {
        HOME: home,
        KIRO_HOME: kiroHome,
        CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
        XDG_RUNTIME_DIR: path.join(root, 'run'),
        XDG_CACHE_HOME: path.join(root, 'cache'),
        XDG_CONFIG_HOME: path.join(root, 'config'),
        XDG_DATA_HOME: path.join(root, 'data'),
        KIRO_CLAUDE_BIN: fakeClaudePath(),
        FAKE_CLAUDE_SCRIPT_JSON: JSON.stringify(script),
        NO_COLOR: '1',
      });
      const c = spawn(process.execPath, [builtBin(), 'spec', 'run', 'todo-export', '1.1', '2.1'], { cwd: ws, env, stdio: ['pipe', 'pipe', 'pipe'] });
      child = c;
      let out = '';
      c.stdout.on('data', (d: Buffer) => (out += d.toString()));
      c.stderr.on('data', (d: Buffer) => (out += d.toString()));
      const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => c.on('exit', (code, signal) => res({ code, signal })));
      const waitFor = async (re: RegExp): Promise<void> => {
        const t0 = Date.now();
        while (!re.test(out)) {
          if (Date.now() - t0 > 20_000) throw new Error(`timeout waiting for ${re}\n--- out:\n${out}`);
          await sleep(25);
        }
      };
      await waitFor(/TASK-WORKING/);
      await sleep(400);
      c.kill('SIGINT');
      await waitFor(/Interrupting…/);
      const hook = await pidIn(hookPid, () => out);
      procs.push(hook);
      procs.push(await pidIn(keeperPid, () => out));
      await sleep(200);
      c.kill('SIGINT'); // kills the hook's group; the keeper holds its pipes for the close grace
      const t0 = Date.now();
      while (alive(hook) && Date.now() - t0 < 400) await sleep(10);
      assert.equal(alive(hook), false, `the second Ctrl+C did not kill the hook\n${out}`);
      c.kill('SIGINT'); // nothing runs under this press any more: exit now
      const e = await exit;
      assert.equal(e.signal, 'SIGINT', `the third Ctrl+C was swallowed: exit ${JSON.stringify(e)}\n${out}`);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      for (const p of procs) {
        if (!alive(p)) continue;
        try {
          process.kill(p.pid, 'SIGKILL');
        } catch {
          /* gone */
        }
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

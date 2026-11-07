/**
 * Round-5 "repl-signals" P1 end to end (the real runRepl and session module over
 * test/fixtures/fake-claude.mjs, test/spec/liveRepl.ts): hooks that ignore TERM/INT/HUP and would
 * run 20 s (timeout 0), reached AFTER a first Ctrl+C already aborted the command's signal:
 *  - the PostTaskExec hook of a `/spec run` task the first press interrupted (r4f #2 residual);
 *  - the agentSpawn hook of the continuation a `/spec new` flow forks after the first press
 *    interrupted its phase turn (r4f #3 residual).
 * A second press must kill the hook (with its process group) and give the prompt back; a cancelled
 * continuation leaves the chat in its own session with a notice.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { liveRepl, seedTodoExport, waitForPidFile, waitGone, writeGlobalHook, type LiveRepl } from '../spec/liveRepl.js';

const WAIT_MS = 6000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Until Claude Code got a user line matching `re` (terminal mode holds streamed text back until its line ends). */
async function untilSent(r: LiveRepl, re: RegExp, mark: number, ms = 20_000): Promise<void> {
  const t0 = Date.now();
  while (!r.userLines().some((u) => re.test(u))) {
    if (Date.now() - t0 > ms) throw new Error(`no user line matching ${re} after ${ms} ms\n--- out:\n${r.o().slice(mark)}`);
    await sleep(25);
  }
  await sleep(400); // the turn is in its sleep step
}

const slowCommand = (root: string, when = 'true'): { command: string; pidFile: string; marker: string } => {
  const pidFile = path.join(root, 'hook.pid');
  const marker = path.join(root, 'hook.done');
  return { pidFile, marker, command: `trap '' TERM INT HUP; if ${when}; then echo $$ > '${pidFile}'; sleep 20; touch '${marker}'; fi; echo HOOK-OUT` };
};

/** Fast for the first `fast` session starts, slow afterwards. */
function spawnHook(root: string, fast: number): ReturnType<typeof slowCommand> {
  const count = path.join(root, 'hook.count');
  const h = slowCommand(root, `[ "$n" -gt ${fast} ]`);
  return { ...h, command: `n=$(($(cat '${count}' 2>/dev/null || echo 0) + 1)); echo $n > '${count}'; ${h.command}` };
}

/** Second press, once the hook wrote its pid: the output after it once `expect` matches (else throws). */
async function pressDuringHook(r: LiveRepl, pidFile: string, expect: RegExp, mark: number): Promise<{ pid: number; ticks: number | undefined; after: string }> {
  const p = await waitForPidFile(pidFile).catch((e: Error) => {
    throw new Error(`${e.message}\n--- out:\n${r.o().slice(mark)}`);
  });
  await sleep(200);
  const from = r.o().length;
  r.ctrlC();
  try {
    await r.waitFor(expect, WAIT_MS, from);
  } catch {
    throw Object.assign(new Error(`no prompt ${WAIT_MS} ms after the second Ctrl+C (hook ${p.pid} still running: ${fs.existsSync(`/proc/${p.pid}`)})\n--- out:\n${r.o().slice(mark)}`), { hook: p });
  }
  return { ...p, after: r.o().slice(mark) };
}

for (const tty of [false, true]) {
  test(`r5 P1: after a Ctrl+C interrupted a /spec run task, a second Ctrl+C kills its PostTaskExec hook (timeout 0, ignores SIGTERM) and gives the prompt back (${tty ? 'terminal' : 'line'} mode)`, { timeout: 60_000 }, async () => {
    let hook: ReturnType<typeof slowCommand> | undefined;
    const r = liveRepl(
      {
        turns: [
          { repeat: true, match: 'Execute Task: 1\\.1', steps: [{ text: 'TASK-WORKING' }, { sleepMs: 20_000 }, { text: 'done\nTASK_RESULT: completed' }] },
          { repeat: true, match: 'Execute Task', steps: [{ text: 'done\nTASK_RESULT: completed' }] },
          { repeat: true, steps: [{ text: 'MAIN-ANSWER to {{userText}}' }] },
        ],
      },
      {
        tty,
        before: (t, kiroHome) => {
          hook = slowCommand(t.root);
          writeGlobalHook(kiroHome, 'post.json', { name: 'slow-post', trigger: 'PostTaskExec', timeout: 0, action: { type: 'command', command: hook.command } });
          seedTodoExport(t.wsDir);
        },
      },
    );
    let p: { pid: number; ticks: number | undefined } | undefined;
    try {
      await r.waitFor(/> $/);
      await r.send('first main', /MAIN-ANSWER to first main[\s\S]*> $/);
      const mark = r.o().length;
      r.line('/spec run todo-export 1.1 2.1');
      await untilSent(r, /Execute Task: 1\.1/, mark);
      r.ctrlC(); // interrupts the task turn: the command signal is aborted from now on
      let res;
      try {
        res = await pressDuringHook(r, hook!.pidFile, /Spec run finished[\s\S]*> $/, mark);
      } catch (e) {
        p = (e as { hook?: typeof p }).hook;
        throw e;
      }
      p = res;
      assert.ok(await waitGone(res.pid), `hook ${res.pid} still runs after the prompt came back`);
      assert.ok(!fs.existsSync(hook!.marker), 'the hook ran to completion');
      assert.match(res.after, /✗ Task 1\.1 interrupted/, res.after);
      assert.ok(!/▶ Task 2\.1/.test(res.after), `the run went on to task 2.1:\n${res.after}`);
      assert.doesNotMatch(res.after, /Failed to execute command|did not stop/, res.after);
      assert.equal(r.ended(), undefined, `the REPL quit:\n${res.after}`);
      await r.send('main again', /MAIN-ANSWER to main again[\s\S]*> $/, 15_000);
    } finally {
      await r.close(p ? [p] : []);
    }
  });
}

for (const tty of [false, true]) {
  test(`r5 P1: after a Ctrl+C interrupted a /spec new phase turn, a second Ctrl+C cancels the continuation's start (agentSpawn hook killed): notice, the chat continues in its own session (${tty ? 'terminal' : 'line'} mode)`, { timeout: 70_000 }, async () => {
    let hook: ReturnType<typeof slowCommand> | undefined;
    const r = liveRepl(
      {
        turns: [
          { repeat: true, match: 'Phase: REQUIREMENTS', steps: [{ text: 'PHASE-WORKING' }, { sleepMs: 20_000 }, { text: 'PHASE-ANSWER' }] },
          { repeat: true, steps: [{ text: 'MAIN-ANSWER history=[{{historyUserTexts}}] END' }] },
        ],
      },
      {
        tty,
        before: (t, kiroHome) => {
          // fast for the REPL's own session and the phase session, slow for the continuation
          hook = spawnHook(t.root, 2);
          writeGlobalHook(kiroHome, 'spawn.json', { name: 'spawn', trigger: 'SessionStart', timeout: 0, action: { type: 'command', command: hook.command } });
        },
      },
    );
    let p: { pid: number; ticks: number | undefined } | undefined;
    try {
      await r.waitFor(/> $/);
      await r.send('first main', /MAIN-ANSWER history=\[first main\] END[\s\S]*> $/);
      const mark = r.o().length;
      r.line('/spec new my-feature --type feature --workflow requirements-first a csv export');
      await untilSent(r, /Phase: REQUIREMENTS/, mark);
      const starts = r.starts();
      r.ctrlC(); // interrupts the phase turn: the flow ends and forks the continuation
      let res;
      try {
        res = await pressDuringHook(r, hook!.pidFile, /> $/, mark);
      } catch (e) {
        p = (e as { hook?: typeof p }).hook;
        throw e;
      }
      p = res;
      assert.ok(await waitGone(res.pid), `hook ${res.pid} still runs after the prompt came back`);
      assert.ok(!fs.existsSync(hook!.marker), 'the hook ran to completion');
      assert.equal(r.starts(), starts, 'a continuation Claude Code was spawned after the cancelled start');
      assert.match(res.after, /Ctrl\+C: the chat keeps its own conversation/, res.after);
      assert.doesNotMatch(res.after, /Failed to execute command|did not stop/, res.after);
      assert.equal(r.ended(), undefined, `the REPL quit:\n${res.after}`);
      // the chat is its own session (main): its history has no phase turn
      await r.send('main again', /MAIN-ANSWER history=\[first main \| main again\] END[\s\S]*> $/, 15_000);
    } finally {
      await r.close(p ? [p] : []);
    }
  });
}

test('r5 P1: a first Ctrl+C that cancels the /spec new continuation start prints the notice too', { timeout: 70_000 }, async () => {
  let hook: ReturnType<typeof slowCommand> | undefined;
  const r = liveRepl(
    {
      turns: [
        { repeat: true, match: 'Phase: REQUIREMENTS', steps: [{ text: 'PHASE-ANSWER' }] },
        { repeat: true, steps: [{ text: 'MAIN-ANSWER history=[{{historyUserTexts}}] END' }] },
      ],
    },
    {
      before: (t, kiroHome) => {
        hook = spawnHook(t.root, 2);
        writeGlobalHook(kiroHome, 'spawn.json', { name: 'spawn', trigger: 'SessionStart', timeout: 0, action: { type: 'command', command: hook.command } });
      },
    },
  );
  let p: { pid: number; ticks: number | undefined } | undefined;
  try {
    await r.waitFor(/> $/);
    await r.send('first main', /MAIN-ANSWER history=\[first main\] END[\s\S]*> $/);
    await r.send('/spec new my-feature --type feature --workflow requirements-first a csv export', /Stop here \(resume later with \/spec my-feature\)[\s\S]*> $/);
    const mark = r.o().length;
    r.line('Stop');
    await r.waitFor(/Stopped at the requirements\.md checkpoint/, 20_000, mark);
    let res;
    try {
      res = await pressDuringHook(r, hook!.pidFile, /keeps its own conversation[\s\S]*> $/, mark);
    } catch (e) {
      p = (e as { hook?: typeof p }).hook;
      throw e;
    }
    p = res;
    assert.ok(await waitGone(res.pid));
    await r.send('main again', /MAIN-ANSWER history=\[first main \| main again\] END[\s\S]*> $/, 15_000);
  } finally {
    await r.close(p ? [p] : []);
  }
});

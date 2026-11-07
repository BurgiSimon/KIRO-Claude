/**
 * r4-findings #2 and #3, end to end: the real runRepl over the fake claude, hooks that ignore
 * TERM/INT/HUP and would run 20 s. One Ctrl+C must kill the hook (with its process group) and
 * give the prompt back, the way `/hooks run` (G3/G4) and `/chat new` (K3) do:
 *  - #2: while a `/spec run` task's PreTaskExec / PostTaskExec command hook (timeout 0) runs;
 *  - #3: while a `/spec run` task session's agentSpawn (SessionStart) hook runs (its start is
 *    cancelled, the task is `interrupted`), and the same for the phase session and the
 *    continuation of `/spec new`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { liveRepl, seedTodoExport, waitForPidFile, waitGone, writeGlobalHook, type LiveRepl } from '../spec/liveRepl.js';

const SCRIPT = {
  turns: [
    { repeat: true, match: 'Execute Task: (1\\.1|2\\.1)', steps: [{ text: 'done\nTASK_RESULT: completed' }] },
    { repeat: true, match: 'Phase: REQUIREMENTS', steps: [{ text: 'PHASE-ANSWER' }] },
    { repeat: true, steps: [{ text: 'MAIN-ANSWER to {{userText}}' }] },
  ],
};

const WAIT_MS = 6000;

/** Press Ctrl+C once the hook wrote its pid; the output after the press once `expect` matches (else throws). */
async function pressDuringHook(r: LiveRepl, pidFile: string, expect: RegExp, mark: number): Promise<{ pid: number; ticks: number | undefined; after: string; ms: number }> {
  const p = await waitForPidFile(pidFile).catch((e: Error) => {
    throw new Error(`${e.message}\n--- out:\n${r.o().slice(mark)}`);
  });
  await new Promise((res) => setTimeout(res, 200));
  const from = r.o().length;
  const t0 = Date.now();
  r.ctrlC();
  try {
    await r.waitFor(expect, WAIT_MS, from);
  } catch {
    throw new Error(`no prompt ${WAIT_MS} ms after the Ctrl+C (hook ${p.pid} still running: ${fs.existsSync(`/proc/${p.pid}`)})\n--- out:\n${r.o().slice(mark)}`);
  }
  return { ...p, after: r.o().slice(mark), ms: Date.now() - t0 };
}

const slowCommand = (root: string, when = 'true'): { command: string; pidFile: string; marker: string } => {
  const pidFile = path.join(root, 'hook.pid');
  const marker = path.join(root, 'hook.done');
  return { pidFile, marker, command: `trap '' TERM INT HUP; if ${when}; then echo $$ > '${pidFile}'; sleep 20; touch '${marker}'; fi; echo HOOK-OUT` };
};

// ───────────── #2: PreTaskExec / PostTaskExec ─────────────

for (const trigger of ['PreTaskExec', 'PostTaskExec'] as const) {
  for (const tty of [false, true]) {
    test(`spec-r4 #2: one Ctrl+C while a /spec run task's ${trigger} hook runs (timeout 0, ignores SIGTERM) kills it and gives the prompt back (${tty ? 'terminal' : 'line'} mode)`, { timeout: 60_000 }, async () => {
      let hook: ReturnType<typeof slowCommand> | undefined;
      const r = liveRepl(SCRIPT, {
        tty,
        before: (t, kiroHome) => {
          hook = slowCommand(t.root);
          writeGlobalHook(kiroHome, 'slow.json', { name: 'slow-task-hook', trigger, timeout: 0, action: { type: 'command', command: hook.command } });
          seedTodoExport(t.wsDir);
        },
      });
      let p: { pid: number; ticks: number | undefined } | undefined;
      try {
        await r.waitFor(/> $/);
        await r.send('first main', /MAIN-ANSWER to first main[\s\S]*> $/);
        const mark = r.o().length;
        r.line('/spec run todo-export 1.1 2.1');
        const res = await pressDuringHook(r, hook!.pidFile, /Spec run finished[\s\S]*> $/, mark);
        p = res;
        assert.ok(await waitGone(res.pid), `hook ${res.pid} still runs after the prompt came back`);
        assert.ok(!fs.existsSync(hook!.marker), 'the hook ran to completion');
        assert.ok(!/▶ Task 2\.1/.test(res.after), `the run went on to task 2.1:\n${res.after}`);
        if (trigger === 'PreTaskExec') {
          assert.match(res.after, /✗ Task 1\.1 interrupted/, res.after);
          assert.ok(!r.userLines().some((u) => u.includes('Execute Task')), 'a task turn was sent after the Ctrl+C at PreTaskExec');
        } else {
          assert.match(res.after, /✓ Task 1\.1 completed/, res.after);
        }
        assert.equal(r.ended(), undefined, `the REPL quit:\n${res.after}`);
        await r.send('main again', /MAIN-ANSWER to main again[\s\S]*> $/, 15_000);
      } finally {
        await r.close(p ? [p] : []);
      }
    });
  }
}

// ───────────── #3: agentSpawn of a session the command starts ─────────────

/** A SessionStart hook that is fast for the first `fast` session starts and slow afterwards. */
function spawnHook(root: string, fast: number): ReturnType<typeof slowCommand> {
  const count = path.join(root, 'hook.count');
  const h = slowCommand(root, `[ "$n" -gt ${fast} ]`);
  return { ...h, command: `n=$(($(cat '${count}' 2>/dev/null || echo 0) + 1)); echo $n > '${count}'; ${h.command}` };
}

for (const tty of [false, true]) {
  test(`spec-r4 #3: one Ctrl+C while a /spec run task session's agentSpawn hook runs cancels its start: task interrupted, prompt back (${tty ? 'terminal' : 'line'} mode)`, { timeout: 70_000 }, async () => {
    let hook: ReturnType<typeof slowCommand> | undefined;
    const r = liveRepl(SCRIPT, {
      tty,
      before: (t, kiroHome) => {
        hook = spawnHook(t.root, 1);
        writeGlobalHook(kiroHome, 'spawn.json', { name: 'spawn', trigger: 'SessionStart', timeout: 60, action: { type: 'command', command: hook.command } });
        seedTodoExport(t.wsDir);
      },
    });
    let p: { pid: number; ticks: number | undefined } | undefined;
    try {
      await r.waitFor(/> $/);
      await r.send('first main', /MAIN-ANSWER to first main[\s\S]*> $/);
      const starts = r.starts();
      const mark = r.o().length;
      r.line('/spec run todo-export 1.1 2.1');
      const res = await pressDuringHook(r, hook!.pidFile, /Spec run finished[\s\S]*> $/, mark);
      p = res;
      assert.ok(await waitGone(res.pid), `hook ${res.pid} still runs after the prompt came back`);
      assert.ok(!fs.existsSync(hook!.marker), 'the hook ran to completion');
      assert.match(res.after, /✗ Task 1\.1 interrupted/, res.after);
      assert.doesNotMatch(res.after, /could not start a session|Failed to execute command|did not stop/, res.after);
      assert.ok(!/▶ Task 2\.1/.test(res.after), `the run went on after the Ctrl+C:\n${res.after}`);
      assert.equal(r.starts(), starts, 'a task Claude Code was spawned after the cancelled start');
      assert.ok(!r.userLines().some((u) => u.includes('Execute Task')), 'a task turn was sent');
      assert.equal(r.ended(), undefined, `the REPL quit:\n${res.after}`);
      await r.send('main again', /MAIN-ANSWER to main again[\s\S]*> $/, 15_000);
    } finally {
      await r.close(p ? [p] : []);
    }
  });
}

test("spec-r4 #3: one Ctrl+C while a /spec new phase session's agentSpawn hook runs cancels its start: the turn is interrupted, the chat stays on main", { timeout: 70_000 }, async () => {
  let hook: ReturnType<typeof slowCommand> | undefined;
  const r = liveRepl(SCRIPT, {
    before: (t, kiroHome) => {
      hook = spawnHook(t.root, 1);
      writeGlobalHook(kiroHome, 'spawn.json', { name: 'spawn', trigger: 'SessionStart', timeout: 0, action: { type: 'command', command: hook.command } });
    },
  });
  let p: { pid: number; ticks: number | undefined } | undefined;
  try {
    await r.waitFor(/> $/);
    await r.send('first main', /MAIN-ANSWER to first main[\s\S]*> $/);
    const starts = r.starts();
    const mark = r.o().length;
    r.line('/spec new my-feature --type feature --workflow requirements-first a csv export');
    const res = await pressDuringHook(r, hook!.pidFile, /Drafting requirements\.md failed: interrupted[\s\S]*> $/, mark);
    p = res;
    assert.ok(await waitGone(res.pid), `hook ${res.pid} still runs after the prompt came back`);
    assert.ok(!fs.existsSync(hook!.marker));
    assert.equal(r.starts(), starts, 'a phase Claude Code was spawned after the cancelled start');
    assert.ok(!r.userLines().some((u) => u.includes('Phase: REQUIREMENTS')), 'the phase turn was sent');
    // the chat is still main: its conversation goes on
    await r.send('main again', /MAIN-ANSWER to main again[\s\S]*> $/, 15_000);
  } finally {
    await r.close(p ? [p] : []);
  }
});

test("spec-r4 #3: one Ctrl+C while the /spec new continuation's agentSpawn hook runs cancels that start: the prompt is back, the chat continues in main", { timeout: 70_000 }, async () => {
  let hook: ReturnType<typeof slowCommand> | undefined;
  const r = liveRepl(SCRIPT, {
    before: (t, kiroHome) => {
      // fast for the REPL's own session and the phase session, slow for the continuation
      hook = spawnHook(t.root, 2);
      writeGlobalHook(kiroHome, 'spawn.json', { name: 'spawn', trigger: 'SessionStart', timeout: 0, action: { type: 'command', command: hook.command } });
    },
  });
  let p: { pid: number; ticks: number | undefined } | undefined;
  try {
    await r.waitFor(/> $/);
    await r.send('first main', /MAIN-ANSWER to first main[\s\S]*> $/);
    await r.send('/spec new my-feature --type feature --workflow requirements-first a csv export', /Stop here \(resume later with \/spec my-feature\)[\s\S]*> $/);
    const mark = r.o().length;
    r.line('Stop');
    await r.waitFor(/Stopped at the requirements\.md checkpoint/, 20_000, mark);
    // (the checkpoint line is printed before the flow ends and hands the chat its continuation)
    const res = await pressDuringHook(r, hook!.pidFile, /> $/, mark);
    p = res;
    assert.ok(await waitGone(res.pid), `hook ${res.pid} still runs after the prompt came back`);
    assert.ok(!fs.existsSync(hook!.marker));
    assert.doesNotMatch(res.after, /Failed to execute command|did not stop/, res.after);
    assert.equal(r.ended(), undefined);
    await r.send('main again', /MAIN-ANSWER to main again[\s\S]*> $/, 15_000);
  } finally {
    await r.close(p ? [p] : []);
  }
});

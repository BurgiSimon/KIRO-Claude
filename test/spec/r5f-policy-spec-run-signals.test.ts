/**
 * Round 5 fixes, group policy, known gap g1: `kiro-claude spec run` (src/spec/cli.ts) ran the
 * PostTaskExec hooks of a task the first Ctrl+C interrupted without a signal. Now they run under
 * the CLI's NEXT press, as in the REPL (ReplContext.nextPressSignal): the second Ctrl+C kills the
 * hook with its process group (also one with timeout 0 that ignores TERM/INT/HUP) and the run ends
 * normally (the run summary, the sessions closed, exit 1). A second press with nothing under it
 * still exits at once, and a fatal signal still kills the hook (claude/lifecycle.ts forwards it).
 *
 * The built `kiro-claude` over test/fixtures/fake-claude.mjs, everything in a temp root (HOME,
 * KIRO_HOME, CLAUDE_CONFIG_DIR, XDG dirs). Only processes this test started are signalled.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { builtBin } from '../cli/helpers.js';
import { fakeClaudePath } from '../claude/helpers.js';
import { startTicksOf } from '../claude/pid-reuse-helpers.js';
import { DESIGN_MD, REQ_MD, TASKS_MD } from './helpers.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Root {
  root: string;
  ws: string;
  kiroHome: string;
  env(): NodeJS.ProcessEnv;
  cleanup(): void;
}

function mkRoot(script: unknown): Root {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kc-r5f-policy-run-')));
  const home = path.join(root, 'home');
  const ws = path.join(root, 'proj');
  for (const d of [home, path.join(ws, '.kiro'), path.join(root, 'cache')]) fs.mkdirSync(d, { recursive: true });
  fs.mkdirSync(path.join(root, 'run'), { mode: 0o700 });
  const dir = path.join(ws, '.kiro', 'specs', 'todo-export');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'requirements.md'), REQ_MD);
  fs.writeFileSync(path.join(dir, 'design.md'), DESIGN_MD);
  fs.writeFileSync(path.join(dir, 'tasks.md'), TASKS_MD);
  const kiroHome = path.join(home, '.kiro');
  return {
    root,
    ws,
    kiroHome,
    env() {
      const env: NodeJS.ProcessEnv = {};
      for (const [k, v] of Object.entries(process.env)) if (!/^(FAKE_CLAUDE_|KIRO|CLAUDE|XDG_|ANTHROPIC_)/.test(k) && v !== undefined) env[k] = v;
      return {
        ...env,
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
      };
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** A global hook file (KIRO_HOME/hooks). */
function globalHook(r: Root, file: string, hook: Record<string, unknown>): void {
  fs.mkdirSync(path.join(r.kiroHome, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(r.kiroHome, 'hooks', file), JSON.stringify({ version: 'v1', hooks: [hook] }));
}

/** A command that ignores TERM/INT/HUP, writes its pid and would run 20 s. */
function slowCommand(r: Root, name: string): { command: string; pidFile: string; marker: string } {
  const pidFile = path.join(r.root, `${name}.pid`);
  const marker = path.join(r.root, `${name}.done`);
  return { pidFile, marker, command: `trap '' TERM INT HUP; echo $$ > '${pidFile}'; sleep 20; touch '${marker}'` };
}

interface Cli {
  o(): string;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  kill(sig: NodeJS.Signals): void;
  waitFor(re: RegExp, ms?: number): Promise<void>;
}

function cli(r: Root, args: string[]): Cli {
  const child = spawn(process.execPath, [builtBin(), ...args], { cwd: r.ws, env: r.env(), stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr.on('data', (d: Buffer) => (out += d.toString()));
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => child.on('exit', (code, signal) => res({ code, signal })));
  return {
    o: () => out,
    exit,
    kill: (sig) => child.kill(sig),
    async waitFor(re, ms = 20_000) {
      const t0 = Date.now();
      while (!re.test(out)) {
        if (Date.now() - t0 > ms) {
          child.kill('SIGKILL');
          throw new Error(`timeout waiting for ${re}\n--- out:\n${out}`);
        }
        await sleep(25);
      }
    },
  };
}

async function pidOf(file: string, c: Cli, ms = 20_000): Promise<{ pid: number; ticks: number | undefined }> {
  const t0 = Date.now();
  for (;;) {
    const v = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '';
    if (/^\d+$/.test(v)) return { pid: Number(v), ticks: startTicksOf(Number(v)) };
    if (Date.now() - t0 > ms) throw new Error(`no pid in ${file}\n--- out:\n${c.o()}`);
    await sleep(25);
  }
}

function alive(p: { pid: number; ticks: number | undefined }): boolean {
  return p.ticks !== undefined && startTicksOf(p.pid) === p.ticks;
}

async function gone(p: { pid: number; ticks: number | undefined }, ms: number): Promise<boolean> {
  const t0 = Date.now();
  while (alive(p) && Date.now() - t0 < ms) await sleep(25);
  return !alive(p);
}

/** SIGKILL the group of a hook this test started, if it is still that process. */
function reap(p: { pid: number; ticks: number | undefined } | undefined): void {
  if (!p || !alive(p)) return;
  try {
    process.kill(-p.pid, 'SIGKILL');
  } catch {
    /* gone */
  }
}

const SLOW_TASK = {
  turns: [
    { repeat: true, match: 'Execute Task: 1\\.1', steps: [{ text: 'TASK-WORKING' }, { sleepMs: 20_000 }, { text: 'done\nTASK_RESULT: completed' }] },
    { repeat: true, match: 'Execute Task', steps: [{ text: 'done\nTASK_RESULT: completed' }] },
    { repeat: true, steps: [{ text: 'ANSWER' }] },
  ],
};

/** `spec run todo-export 1.1 2.1`, first Ctrl+C while task 1.1 runs; resolves once the PostTaskExec hook runs. */
async function interruptedRun(r: Root): Promise<{ c: Cli; hook: { pid: number; ticks: number | undefined }; h: ReturnType<typeof slowCommand> }> {
  const h = slowCommand(r, 'post');
  globalHook(r, 'post.json', { name: 'slow-post', trigger: 'PostTaskExec', timeout: 0, action: { type: 'command', command: h.command } });
  const c = cli(r, ['spec', 'run', 'todo-export', '1.1', '2.1']);
  await c.waitFor(/TASK-WORKING/);
  await sleep(400);
  c.kill('SIGINT');
  await c.waitFor(/Interrupting… \(press Ctrl\+C again to exit\)/);
  const hook = await pidOf(h.pidFile, c);
  await sleep(200);
  return { c, hook, h };
}

test('g1: after a Ctrl+C interrupted a `spec run` task, a second Ctrl+C kills its PostTaskExec hook (timeout 0, ignores TERM/INT/HUP) and the run ends normally', { timeout: 90_000 }, async () => {
  const r = mkRoot(SLOW_TASK);
  let hook: { pid: number; ticks: number | undefined } | undefined;
  try {
    const run = await interruptedRun(r);
    hook = run.hook;
    const t0 = Date.now();
    run.c.kill('SIGINT');
    assert.ok(await gone(run.hook, 500), `the hook ${run.hook.pid} still runs 500 ms after the second Ctrl+C\n${run.c.o()}`);
    const e = await run.c.exit;
    const out = run.c.o();
    assert.deepEqual(e, { code: 1, signal: null }, `exit ${JSON.stringify(e)} after ${Date.now() - t0} ms\n${out}`);
    assert.ok(!fs.existsSync(run.h.marker), 'the hook ran to completion');
    assert.match(out, /✗ Task 1\.1 interrupted/, out);
    assert.match(out, /Spec run finished/, `no run summary:\n${out}`);
    assert.doesNotMatch(out, /▶ Task 2\.1/, out);
    assert.doesNotMatch(out, /PostTaskExec hooks for task 1\.1 failed|Failed to execute command/, out);
  } finally {
    reap(hook);
    r.cleanup();
  }
});

test('g1: SIGTERM while that PostTaskExec hook runs kills the hook and kiro-claude dies of the signal', { timeout: 90_000 }, async () => {
  const r = mkRoot(SLOW_TASK);
  let hook: { pid: number; ticks: number | undefined } | undefined;
  try {
    const run = await interruptedRun(r);
    hook = run.hook;
    run.c.kill('SIGTERM');
    const e = await run.c.exit;
    assert.equal(e.signal, 'SIGTERM', `exit ${JSON.stringify(e)}\n${run.c.o()}`);
    assert.ok(await gone(run.hook, 2000), `the hook ${run.hook.pid} outlived kiro-claude`);
    assert.ok(!fs.existsSync(run.h.marker), 'the hook ran to completion');
  } finally {
    reap(hook);
    r.cleanup();
  }
});

test('g1: a second Ctrl+C with nothing under it still exits at once (here: the task session closing in a slow SessionEnd hook)', { timeout: 90_000 }, async () => {
  const r = mkRoot(SLOW_TASK);
  let hook: { pid: number; ticks: number | undefined } | undefined;
  try {
    const h = slowCommand(r, 'end');
    globalHook(r, 'end.json', { name: 'slow-end', trigger: 'SessionEnd', timeout: 0, action: { type: 'command', command: h.command } });
    const c = cli(r, ['spec', 'run', 'todo-export', '1.1']);
    await c.waitFor(/TASK-WORKING/);
    await sleep(400);
    c.kill('SIGINT');
    await c.waitFor(/Interrupting…/);
    hook = await pidOf(h.pidFile, c);
    await sleep(200);
    c.kill('SIGINT');
    const e = await c.exit;
    assert.equal(e.signal, 'SIGINT', `exit ${JSON.stringify(e)}\n${c.o()}`);
    assert.ok(await gone(hook, 2000), `the SessionEnd hook ${hook.pid} outlived kiro-claude`);
  } finally {
    reap(hook);
    r.cleanup();
  }
});

test('g1: after the second Ctrl+C killed the PostTaskExec hook, a third one still exits at once (here: a slow SessionEnd hook of the task session)', { timeout: 90_000 }, async () => {
  const r = mkRoot(SLOW_TASK);
  const pids: { pid: number; ticks: number | undefined }[] = [];
  try {
    const end = slowCommand(r, 'end');
    globalHook(r, 'end.json', { name: 'slow-end', trigger: 'SessionEnd', timeout: 0, action: { type: 'command', command: end.command } });
    const run = await interruptedRun(r);
    pids.push(run.hook);
    run.c.kill('SIGINT');
    assert.ok(await gone(run.hook, 500), `the PostTaskExec hook ${run.hook.pid} still runs after the second Ctrl+C`);
    const endHook = await pidOf(end.pidFile, run.c);
    pids.push(endHook);
    await sleep(200);
    assert.equal(alive(endHook), true);
    run.c.kill('SIGINT');
    const e = await run.c.exit;
    assert.equal(e.signal, 'SIGINT', `exit ${JSON.stringify(e)}\n${run.c.o()}`);
    assert.ok(await gone(endHook, 2000), `the SessionEnd hook ${endHook.pid} outlived kiro-claude`);
  } finally {
    for (const p of pids) reap(p);
    r.cleanup();
  }
});

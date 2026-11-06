/**
 * runShell children (Kiro hook commands, `!`-style REPL scripts) must not outlive kiro-claude
 * (review C12). They run in their own process group (`detached`), so neither the terminal's
 * signals nor the parent's death reach them, and their timeout timer dies with the process.
 * They are registered with claude/lifecycle.ts, whose process-'exit' sweep, signal forwarding
 * and shutdownTrackedChildren() SIGKILL their whole group.
 *
 * Each case runs a small Node program that imports the built util/process.js, starts
 * `touch <marker>; sleep <tag>` with a 60 s timeout, and then exits (or is signalled) while the
 * command is still running. `<tag>` is a unique decimal (`sleep` accepts fractions) so the test
 * can find the hook's processes afterwards without touching anything else.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runShell } from '../../src/util/process.js';
import { shutdownTrackedChildren, trackedChildCount } from '../../src/claude/lifecycle.js';

const unix = process.platform === 'win32' ? { skip: 'POSIX process groups' } : {};
const PROCESS_JS = new URL('../../src/util/process.js', import.meta.url).href;
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kc-proc-life-')));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let n = 0;
const nextTag = (): string => `47.${process.pid}${++n}`;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** pids of live (non-zombie) processes whose argv contains `tag`. */
function liveWith(tag: string): number[] {
  if (fs.existsSync('/proc/self/stat')) {
    const out: number[] = [];
    for (const d of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue;
      try {
        const argv = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0');
        if (!argv.some((a) => a.includes(tag))) continue;
        const stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
        const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
        if (state !== 'Z' && state !== 'X') out.push(Number(d));
      } catch {
        /* gone */
      }
    }
    return out;
  }
  try {
    return execFileSync('ps', ['-eo', 'pid=,stat=,args='], { encoding: 'utf8' })
      .split('\n')
      .filter((l) => l.includes(tag) && !/^\s*\d+\s+Z/.test(l))
      .map((l) => Number(l.trim().split(/\s+/)[0]));
  } catch {
    return [];
  }
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

async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(25);
  }
  return pred();
}

/**
 * Start the helper program. `mode`:
 *  - `exit`: process.exit(0) as soon as the command runs (REPL /quit, run.ts stray-handle exit);
 *  - `handled`: a SIGTERM listener that exits 143 (the ACP server's shutdown);
 *  - `unhandled`: no listener of its own (default disposition: killed by the signal).
 */
function helper(mode: 'exit' | 'handled' | 'unhandled', tag: string, marker: string) {
  const script = path.join(tmp, `helper-${tag}.mjs`);
  fs.writeFileSync(
    script,
    `import * as fs from 'node:fs';
import { runShell } from ${JSON.stringify(PROCESS_JS)};
const [marker, tag, mode] = process.argv.slice(2);
if (mode === 'handled') process.on('SIGTERM', () => process.exit(143));
void runShell('touch ' + marker + '; sleep ' + tag, { cwd: ${JSON.stringify(tmp)}, timeoutMs: 60000 });
const poll = setInterval(() => {
  if (!fs.existsSync(marker)) return;
  clearInterval(poll);
  if (mode === 'exit') process.exit(0);
  process.stdout.write('ready\\n');
}, 20);
`,
  );
  const child = spawn(process.execPath, [script, marker, tag, mode], { cwd: tmp, stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => child.on('exit', (code, signal) => r({ code, signal })));
  const ready = new Promise<void>((r) => child.stdout.on('data', (b: Buffer) => b.toString().includes('ready') && r()));
  return { child, exited, ready };
}

describe('process: runShell children do not outlive kiro-claude (C12)', () => {
  it('process.exit() while a command runs SIGKILLs its process group', unix, async (t) => {
    const tag = nextTag();
    t.after(() => reap(tag));
    const h = helper('exit', tag, path.join(tmp, `m-${tag}`));
    assert.deepEqual(await h.exited, { code: 0, signal: null });
    assert.ok(await waitFor(() => liveWith(tag).length === 0, 1500), `command still running after exit: ${liveWith(tag).join(' ')}`);
  });

  it('a SIGTERM listener that exits (ACP shutdown, exit 143) leaves no command behind', unix, async (t) => {
    const tag = nextTag();
    t.after(() => reap(tag));
    const h = helper('handled', tag, path.join(tmp, `m-${tag}`));
    await h.ready;
    assert.ok(liveWith(tag).length > 0, 'command started');
    h.child.kill('SIGTERM');
    assert.deepEqual(await h.exited, { code: 143, signal: null });
    assert.ok(await waitFor(() => liveWith(tag).length === 0, 1500), `command still running after exit: ${liveWith(tag).join(' ')}`);
  });

  it('death by an unhandled SIGTERM forwards it to the command group first', unix, async (t) => {
    const tag = nextTag();
    t.after(() => reap(tag));
    const h = helper('unhandled', tag, path.join(tmp, `m-${tag}`));
    await h.ready;
    assert.ok(liveWith(tag).length > 0, 'command started');
    h.child.kill('SIGTERM');
    assert.deepEqual(await h.exited, { code: null, signal: 'SIGTERM' });
    assert.ok(await waitFor(() => liveWith(tag).length === 0, 1500), `command still running after death: ${liveWith(tag).join(' ')}`);
  });

  it('shutdownTrackedChildren() (run.ts after main resolved) kills a running command at once', unix, async (t) => {
    const tag = nextTag();
    t.after(() => reap(tag));
    const marker = path.join(tmp, `m-${tag}`);
    const before = trackedChildCount();
    const run = runShell(`touch ${marker}; sleep ${tag}`, { cwd: tmp, timeoutMs: 60_000 });
    assert.ok(await waitFor(() => fs.existsSync(marker), 5000), 'command started');
    assert.equal(trackedChildCount(), before + 1, 'the command is tracked while it runs');
    const t0 = Date.now();
    await shutdownTrackedChildren(500);
    const res = await Promise.race([run, sleep(3000).then(() => undefined)]);
    assert.ok(res, 'runShell did not settle after shutdownTrackedChildren()');
    assert.equal(res.signal, 'SIGKILL');
    assert.ok(Date.now() - t0 < 2500);
    assert.equal(trackedChildCount(), before, 'untracked once it exited');
    assert.ok(await waitFor(() => liveWith(tag).length === 0, 1000));
  });

  it('a finished command is no longer tracked', unix, async () => {
    const before = trackedChildCount();
    const res = await runShell('exit 3', { cwd: tmp });
    assert.equal(res.exitCode, 3);
    assert.equal(trackedChildCount(), before);
  });

  it('a spawn failure is not tracked and still resolves', async () => {
    const before = trackedChildCount();
    const res = await runShell('true', { cwd: path.join(tmp, 'does-not-exist') });
    assert.equal(res.exitCode, null);
    assert.ok(res.error);
    assert.equal(trackedChildCount(), before);
  });
});


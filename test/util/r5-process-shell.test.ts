/**
 * Review round 5, H2 (runShell side): while kiro-claude dies of a fatal signal nothing else
 * handles (claude/lifecycle.ts forwards it and waits up to KILL_GRACE_MS for the children), a
 * hook command the signal ended used to be reported as a failure (`signal SIGTERM`, a Kiro hook
 * warning), and a hook started meanwhile ran. Now runShell reports such a run as `aborted` (the
 * hook runner prints no warning for it) and starts no command while dying.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';

const linux = { skip: process.platform !== 'linux' };
const PROCESS_JS = new URL('../../src/util/process.js', import.meta.url).href;

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

describe('runShell while kiro-claude dies of a forwarded signal (r5 H2)', () => {
  it('a hook the signal ended is aborted (not failed); a hook started during the grace never runs', linux, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-r5-shell-'));
    const marker = path.join(dir, 'ran');
    const ignorer = path.join(dir, 'ignorer.pid');
    const driver = path.join(dir, 'driver.mjs');
    fs.writeFileSync(
      driver,
      `const { runShell } = await import(${JSON.stringify(PROCESS_JS)});
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
// keeps the forwarded signal's grace running (ignores SIGTERM; SIGKILLed after the grace)
void runShell(${JSON.stringify(`trap '' TERM; echo $$ > '${ignorer}'; sleep 30; echo after`)}, { cwd: ${JSON.stringify(dir)}, timeoutMs: 60000 });
void runShell('sleep 30', { cwd: ${JSON.stringify(dir)}, timeoutMs: 60000 }).then((r) => say({ event: 'first', signal: r.signal, aborted: r.aborted === true }));
process.stdin.on('data', async (d) => {
  if (!String(d).includes('go')) return;
  const r = await runShell(${JSON.stringify(`echo ran > '${marker}'`)}, { cwd: ${JSON.stringify(dir)} });
  say({ event: 'second', aborted: r.aborted === true, exitCode: r.exitCode, error: r.error ?? null });
});
say({ event: 'ready' });
setInterval(() => {}, 1000);
`,
    );
    const child = spawn(process.execPath, [driver], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout!.setEncoding('utf8').on('data', (d: string) => (out += d));
    const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => child.on('exit', (code, signal) => r({ code, signal })));
    const cap = setTimeout(() => child.kill('SIGKILL'), 20_000);
    try {
      const end = Date.now() + 10_000;
      while ((!out.includes('"ready"') || !fs.existsSync(ignorer)) && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
      assert.match(out, /"ready"/);
      await new Promise((r) => setTimeout(r, 100)); // both commands run
      child.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 100));
      child.stdin!.write('go\n');
      const res = await done;
      assert.equal(res.signal, 'SIGTERM', 'the driver still dies of the forwarded SIGTERM');
      const ev = events(out);
      assert.deepEqual(ev.find((e) => e.event === 'first'), { event: 'first', signal: 'SIGTERM', aborted: true });
      const second = ev.find((e) => e.event === 'second');
      assert.equal(second?.aborted, true, `a hook started while dying: ${JSON.stringify(second)}`);
      assert.match(String(second?.error), /shutting down/);
      assert.equal(fs.existsSync(marker), false, 'the command ran while kiro-claude was dying');
    } finally {
      clearTimeout(cap);
      child.kill('SIGKILL');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

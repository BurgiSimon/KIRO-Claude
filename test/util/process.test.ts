import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findExecutable, runShell, shellInvocation } from '../../src/util/process.js';

const unix = process.platform === 'win32' ? { skip: 'POSIX shell semantics' } : {};
const cwd = os.tmpdir();

/** Process exists and is not a zombie (killed but not yet reaped — common in containers). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
    return state !== 'Z' && state !== 'X';
  } catch {
    return true; // no procfs (macOS): kill(0) succeeded
  }
}

describe('process: shellInvocation / findExecutable', () => {
  it('uses bash -c on Unix when bash is on PATH', unix, () => {
    const inv = shellInvocation('echo hi');
    assert.match(path.basename(inv.file), /^(bash|sh)$/);
    assert.deepEqual(inv.args, ['-c', 'echo hi']);
  });
  it('falls back to /bin/sh when bash is not on PATH', unix, () => {
    const inv = shellInvocation('echo hi', { env: { PATH: '/nonexistent-dir' } });
    // with an explicit env lacking bash we still try the real PATH first
    assert.ok(inv.file.endsWith('bash') || inv.file === '/bin/sh');
  });
  it('honors shell overrides', () => {
    assert.deepEqual(shellInvocation('x', { shell: '/bin/sh' }).args, ['-c', 'x']);
    assert.deepEqual(shellInvocation('x', { shell: 'cmd.exe' }).args, ['/d', '/s', '/c', '"x"']);
    assert.deepEqual(shellInvocation('x', { shell: 'pwsh' }).args, ['-NoProfile', '-NonInteractive', '-Command', 'x']);
  });
  it('findExecutable', unix, () => {
    assert.ok(findExecutable('sh'));
    assert.equal(findExecutable('definitely-not-a-real-binary-xyz'), undefined);
    assert.equal(findExecutable('/bin/sh'), '/bin/sh');
    assert.equal(findExecutable('sh', { PATH: '' }), undefined);
  });
});

describe('process: runShell', () => {
  it('captures stdout, stderr and exit code', async () => {
    const r = await runShell('echo out; echo err 1>&2; exit 3', { cwd });
    assert.equal(r.exitCode, 3);
    assert.equal(r.signal, null);
    assert.equal(r.stdout, 'out\n');
    assert.equal(r.stderr, 'err\n');
    assert.equal(r.timedOut, false);
    assert.equal(r.error, undefined);
    assert.ok(r.durationMs >= 0);
  });

  it('exit 0 and exit 2 (hook block code)', async () => {
    assert.equal((await runShell('true', { cwd })).exitCode, 0);
    assert.equal((await runShell('exit 2', { cwd })).exitCode, 2);
  });

  it('runs bash syntax (Q hooks run under bash -c)', unix, async () => {
    const r = await runShell('a=(x y z); echo "${#a[@]}" $((2+3))', { cwd });
    assert.equal(r.stdout.trim(), '3 5');
  });

  it('writes stdin then closes it', async () => {
    const payload = JSON.stringify({ hook_event_name: 'preToolUse', cwd: '/x', tool_name: 'fs_read' });
    const r = await runShell('cat', { cwd, stdin: payload });
    assert.equal(r.stdout, payload);
  });

  it('closes stdin immediately when none is given (no hang)', async () => {
    const r = await runShell('cat; echo done', { cwd, timeoutMs: 5000 });
    assert.equal(r.timedOut, false);
    assert.equal(r.stdout, 'done\n');
  });

  it('ignores EPIPE when the child does not read stdin', async () => {
    const big = 'x'.repeat(4 * 1024 * 1024);
    const r = await runShell('exit 0', { cwd, stdin: big });
    assert.equal(r.exitCode, 0);
  });

  it('uses cwd and env', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kc-proc-')));
    try {
      const r = await runShell('pwd; echo "$KC_TEST_VAR"', { cwd: dir, env: { ...process.env, KC_TEST_VAR: 'hello' } });
      assert.deepEqual(r.stdout.trim().split('\n'), [dir, 'hello']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('decodes UTF-8 output', async () => {
    const r = await runShell("printf 'h\\303\\251llo \\342\\202\\254'", { cwd });
    assert.equal(r.stdout, 'héllo €');
  });

  it('truncates each stream at maxOutputBytes on a character boundary', async () => {
    const r = await runShell("head -c 5000 /dev/zero | tr '\\0' 'a'; head -c 300 /dev/zero | tr '\\0' 'b' 1>&2", {
      cwd,
      maxOutputBytes: 1000,
    });
    assert.equal(r.stdout.length, 1000);
    assert.equal(r.stderr.length, 300);
    assert.deepEqual(r.truncated, { stdout: true, stderr: false });
    const r2 = await runShell("for i in 1 2 3 4 5; do printf '\\342\\202\\254'; done", { cwd, maxOutputBytes: 7 });
    assert.equal(r2.stdout, '€€'); // 6 bytes; the third € would be split
    assert.equal(r2.truncated?.stdout, true);
  });

  it('times out and kills the whole process group, grandchildren included', unix, async () => {
    const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kc-proc-')), 'pid');
    const t0 = Date.now();
    const r = await runShell(`sleep 30 & echo $! > ${pidFile}; wait`, { cwd, timeoutMs: 300 });
    assert.equal(r.timedOut, true);
    assert.equal(r.exitCode, null);
    assert.equal(r.signal, 'SIGKILL');
    assert.ok(Date.now() - t0 < 5000);
    const grandchild = Number(fs.readFileSync(pidFile, 'utf8').trim());
    assert.ok(grandchild > 0);
    // give the kernel a moment to reap
    for (let i = 0; i < 50 && alive(grandchild); i++) await new Promise((res) => setTimeout(res, 20));
    assert.equal(alive(grandchild), false, 'grandchild sleep must be killed');
    fs.rmSync(path.dirname(pidFile), { recursive: true, force: true });
  });

  it('does not hang on background children that keep the pipes open', unix, async () => {
    const t0 = Date.now();
    const r = await runShell('sleep 3 & echo started', { cwd, closeGraceMs: 200 });
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout, 'started\n');
    assert.ok(Date.now() - t0 < 2500, `took ${Date.now() - t0} ms`);
  });

  it('AbortSignal cancels the run', unix, async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    const r = await runShell('sleep 30', { cwd, signal: ac.signal });
    assert.equal(r.aborted, true);
    assert.equal(r.exitCode, null);
    const pre = new AbortController();
    pre.abort();
    const r2 = await runShell('echo never', { cwd, signal: pre.signal });
    assert.equal(r2.aborted, true);
    assert.equal(r2.stdout, '');
  });

  it('reports spawn errors without rejecting', async () => {
    const r = await runShell('echo hi', { cwd: path.join(os.tmpdir(), 'kc-does-not-exist-xyz') });
    assert.equal(r.exitCode, null);
    assert.ok(r.error);
    const r2 = await runShell('echo hi', { cwd, shell: '/nonexistent/shell' });
    assert.equal(r2.exitCode, null);
    assert.match(r2.error ?? '', /ENOENT/);
  });

  it('runs many commands concurrently', async () => {
    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => runShell(`echo ${i}`, { cwd })));
    assert.deepEqual(
      rs.map((r) => r.stdout.trim()),
      ['0', '1', '2', '3', '4', '5', '6', '7'],
    );
  });
});

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { defaultRunner, defaultSys, formatCommand, lastLines } from '../../src/crew/runner.js';

const node = process.execPath;

describe('crew runner', () => {
  it('captures stdout/stderr and the exit code; stdin is /dev/null unless input is given', async () => {
    let r = await defaultRunner.run(node, ['-e', 'process.stdout.write("o");process.stderr.write("e");process.exit(3)']);
    assert.deepEqual([r.code, r.stdout, r.stderr, r.timedOut, r.error], [3, 'o', 'e', false, undefined]);
    r = await defaultRunner.run(node, ['-e', 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(`[${d}]`))']);
    assert.equal(r.stdout, '[]');
    r = await defaultRunner.run(node, ['-e', 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(d.toUpperCase()))'], { input: 'abc' });
    assert.equal(r.stdout, 'ABC');
  });

  it('passes cwd and env, tees output to a log file (0600, appended)', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-run-'));
    const log = path.join(d, 'setup.log');
    fs.writeFileSync(log, 'before\n', { mode: 0o600 });
    const r = await defaultRunner.run(node, ['-e', 'console.log(process.cwd(), process.env.X); console.error("err-line")'], { cwd: d, env: { X: 'y' }, logFile: log });
    assert.equal(r.stdout.trim(), `${fs.realpathSync(d)} y`);
    const text = fs.readFileSync(log, 'utf8');
    assert.ok(text.startsWith('before\n') && text.includes(' y\n') && text.includes('err-line'));
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('kills on timeout; reports spawn errors without throwing', async () => {
    let r = await defaultRunner.run(node, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 200 });
    assert.equal(r.timedOut, true);
    assert.equal(r.code, null);
    r = await defaultRunner.run('/nonexistent/tool', ['x']);
    assert.equal(r.code, null);
    assert.match(r.error!, /ENOENT/);
  });

  it('inherit mode streams to the given (non-process) streams', async () => {
    const chunks: string[] = [];
    const sink = { write: (b: Buffer | string) => (chunks.push(b.toString()), true) } as unknown as NodeJS.WritableStream;
    const r = await defaultRunner.run(node, ['-e', 'process.stdout.write("hi")'], { stdio: 'inherit', streams: { stdout: sink, stderr: sink } });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.equal(chunks.join(''), 'hi');
  });

  it('forwardSignals passes SIGHUP/SIGTERM to the child and removes its listeners afterwards', async () => {
    const before = process.listenerCount('SIGHUP');
    const p = defaultRunner.run(node, ['-e', 'process.on("SIGHUP",()=>{process.stdout.write("hup");process.exit(5)});process.stdout.write("ready");setInterval(()=>{},1000)'], { forwardSignals: true, timeoutMs: 10_000 });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(process.listenerCount('SIGHUP'), before + 1);
    process.kill(process.pid, 'SIGHUP');
    const r = await p;
    assert.equal(r.code, 5);
    assert.equal(r.stdout, 'readyhup');
    assert.equal(process.listenerCount('SIGHUP'), before);
  });

  it('spawnDetached: own session, stdin /dev/null, stdout/stderr to 0600 files', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-run-'));
    const out = path.join(d, 'o');
    const err = path.join(d, 'e');
    const { pid } = defaultRunner.spawnDetached(node, ['-e', 'const fs=require("fs");console.log(JSON.stringify({sid: fs.readFileSync("/proc/self/stat","utf8").split(") ")[1].split(" ")[3], pid: process.pid}));console.error("E");process.stdin.on("data",()=>{}).on("end",()=>console.log("eof"))'], { cwd: d, env: { PATH: '/usr/bin:/bin' }, stdoutFile: out, stderrFile: err });
    for (let i = 0; i < 50 && defaultSys.isAlive(pid); i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(defaultSys.isAlive(pid), false);
    const lines = fs.readFileSync(out, 'utf8').trim().split('\n');
    if (process.platform === 'linux') assert.equal(Number(JSON.parse(lines[0]!).sid), pid, 'session leader (setsid)');
    assert.equal(lines[1], 'eof');
    assert.equal(fs.readFileSync(err, 'utf8'), 'E\n');
    assert.equal(fs.statSync(out).mode & 0o777, 0o600);
    assert.throws(() => defaultRunner.spawnDetached(node, [], { cwd: path.join(d, 'missing'), env: {}, stdoutFile: path.join(d, 'nodir', 'o'), stderrFile: err }));
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('sys helpers', () => {
    assert.equal(defaultSys.isAlive(process.pid), true);
    assert.equal(defaultSys.isAlive(0), false);
    assert.equal(defaultSys.isAlive(2 ** 22 + 12345), false);
    assert.equal(defaultSys.kill(-1.5, 'SIGTERM'), false);
    if (process.platform === 'linux') {
      const me = defaultSys.listProcesses().find((p) => p.pid === process.pid);
      assert.ok(me && me.argv[0]!.includes('node') && me.env?.PATH !== undefined);
    }
    assert.ok((defaultSys.freeBytes(os.tmpdir()) ?? 1) > 0);
    assert.equal(formatCommand('/bin/npm', ['ci', 'a b', "it's"]), `/bin/npm ci 'a b' 'it'\\''s'`);
    assert.deepEqual(lastLines('a\nb\nc\n\n', 2), ['b', 'c']);
  });
});

/**
 * src/bin/run.ts (the executable's entry logic): once main() has resolved, stray handles (a
 * forgotten interval, a resumed stdin, a leaked claude child) cannot hold the process open,
 * and piped stdout is never truncated — the fallback exit only happens after stdout/stderr
 * have drained.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { STRAY_HANDLE_EXIT_MS } from '../../src/bin/run.js';
import { fakeClaudePath, fakeEnv, mkTmp } from './helpers.js';
import { builtModule, isWin, reap, spawnNode, waitDead, waitForLine } from './hang-helpers.js';

function writeEntry(dir: string, body: string): string {
  const f = path.join(dir, 'entry.mjs');
  fs.writeFileSync(
    f,
    `const { runEntry } = await import(${JSON.stringify(builtModule('bin/run.js'))});
runEntry(async () => {
${body}
}, process.argv.slice(2));
`,
  );
  return f;
}

describe('bin entry: stray handles after main() resolves', () => {
  it('a stray interval does not hold the process open; exit code kept', async () => {
    const dir = mkTmp();
    const run = spawnNode([writeEntry(dir, "  setInterval(() => {}, 1e6);\n  process.stdout.write('done\\n');\n  return 3;")], { capMs: 15_000 });
    const res = await run.done;
    assert.equal(res.killedByTest, false, 'process must exit');
    assert.equal(res.code, 3);
    assert.equal(run.stdout(), 'done\n');
    assert.ok(res.ms < STRAY_HANDLE_EXIT_MS + 5_000, `took ${res.ms} ms`);
  });

  it('a rejected main prints the error and exits 1 even with a stray handle', async () => {
    const dir = mkTmp();
    const run = spawnNode([writeEntry(dir, "  setInterval(() => {}, 1e6);\n  throw new Error('boom');")], { capMs: 15_000 });
    const res = await run.done;
    assert.equal(res.killedByTest, false);
    assert.equal(res.code, 1);
    assert.match(run.stderr(), /kiro-claude: boom/);
  });

  it('a clean main exits normally (no added delay)', async () => {
    const dir = mkTmp();
    const run = spawnNode([writeEntry(dir, "  process.stdout.write('ok\\n');\n  return 0;")], { capMs: 15_000 });
    const res = await run.done;
    assert.equal(res.code, 0);
    assert.equal(run.stdout(), 'ok\n');
    assert.ok(res.ms < 3_000, `took ${res.ms} ms`);
  });

  it('piped stdout is not truncated by the fallback exit (slow reader)', async () => {
    const dir = mkTmp();
    const size = 8 * 1024 * 1024;
    const run = spawnNode(
      [writeEntry(dir, `  setInterval(() => {}, 1e6);\n  process.stdout.write('x'.repeat(${size}));\n  process.stdout.write('\\nEND\\n');\n  return 0;`)],
      { capMs: 30_000 },
    );
    // Do not read for a while: the pipe fills up and stdout writes stay queued.
    run.child.stdout!.pause();
    await new Promise((r) => setTimeout(r, STRAY_HANDLE_EXIT_MS + 1_500));
    run.child.stdout!.resume();
    const res = await run.done;
    assert.equal(res.killedByTest, false);
    assert.equal(res.code, 0);
    assert.equal(run.stdout().length, size + 5);
    assert.ok(run.stdout().endsWith('\nEND\n'));
  });

  it('a leaked claude child is shut down after main() resolves and does not hold the process', { skip: isWin }, async () => {
    const dir = mkTmp();
    const entry = writeEntry(
      dir,
      `  const { ClaudeProcess } = await import(${JSON.stringify(builtModule('claude/process.js'))});
  const proc = await ClaudeProcess.start({
    binary: { path: ${JSON.stringify(fakeClaudePath())}, version: '2.1.318', rawVersion: '2.1.318 (Claude Code)' },
    args: ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-prompt-tool', 'stdio'],
    cwd: process.cwd(), env: process.env, initialize: {},
    handlers: { onHookCallback: async () => ({}), onCanUseTool: async (r) => ({ behavior: 'allow', updatedInput: r.input }) },
  });
  process.stdout.write(JSON.stringify({ childPid: proc.pid }) + '\\n');
  return 0; // never closes proc`,
    );
    // HANG_ON_EOF + IGNORE_SIGTERM: only a SIGKILL ends the child.
    const run = spawnNode([entry], { env: fakeEnv({ FAKE_CLAUDE_HANG_ON_EOF: '1', FAKE_CLAUDE_IGNORE_SIGTERM: '1' }), cwd: dir, capMs: 20_000 });
    const line = await waitForLine(run, (o) => typeof o.childPid === 'number');
    const childPid = line.childPid as number;
    try {
      const res = await run.done;
      assert.equal(res.killedByTest, false, `process must exit (stderr=${run.stderr()})`);
      assert.equal(res.code, 0);
      assert.ok(await waitDead([childPid], 3_000), 'leaked child is killed');
    } finally {
      reap([childPid]);
    }
  });
});

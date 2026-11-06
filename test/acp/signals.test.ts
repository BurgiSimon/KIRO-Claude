/**
 * `kiro-claude acp` as a real process: a hang-up (closed terminal, a parent that sends SIGHUP)
 * shuts the server down like SIGTERM does — sessions closed, their claude children gone and
 * their runtime dirs removed — and exits 129. Before, SIGHUP killed the process outright and
 * left `<runtime>/kiro-claude-<uid>/session-*` behind (KiroCrew stage-B finding).
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { it } from 'node:test';

import { fakeClaudePath, fakeEnv, mkTmp } from '../claude/helpers.js';
import { builtModule, isWin, spawnNode, waitForLine } from '../claude/hang-helpers.js';

function sessionDirs(runtimeBase: string): string[] {
  const out: string[] = [];
  for (const d of fs.existsSync(runtimeBase) ? fs.readdirSync(runtimeBase) : []) {
    if (!d.startsWith('kiro-claude-')) continue;
    const full = path.join(runtimeBase, d);
    for (const s of fs.readdirSync(full)) if (s.startsWith('session-')) out.push(path.join(full, s));
  }
  return out;
}

for (const [sig, code] of [['SIGHUP', 129], ['SIGTERM', 143]] as const) {
  it(`acp: ${sig} closes the sessions, removes their runtime dirs and exits ${code}`, { skip: isWin }, async () => {
    const root = mkTmp('kc-acp-sig-');
    const home = path.join(root, 'home');
    const work = path.join(root, 'work');
    const runtime = path.join(root, 'run');
    for (const d of [home, work, runtime]) fs.mkdirSync(d, { recursive: true });
    const env = fakeEnv({
      HOME: home,
      KIRO_HOME: path.join(home, '.kiro'),
      CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
      XDG_RUNTIME_DIR: runtime,
      KIRO_CLAUDE_BIN: fakeClaudePath(),
      FAKE_CLAUDE_LOG: path.join(root, 'fake.jsonl'),
    });
    const run = spawnNode([builtModule('bin/kiro-claude.js'), 'acp'], { env, cwd: work, capMs: 30_000 });
    const send = (o: unknown): void => {
      run.child.stdin!.write(`${JSON.stringify(o)}\n`);
    };
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } });
    await waitForLine(run, (o) => o.id === 1);
    send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: work, mcpServers: [] } });
    const created = await waitForLine(run, (o) => o.id === 2, 20_000);
    assert.ok((created.result as { sessionId?: string } | undefined)?.sessionId, `session/new failed: ${JSON.stringify(created)}`);
    assert.equal(sessionDirs(runtime).length, 1, 'one live session runtime dir');

    run.child.kill(sig);
    const res = await run.done;
    assert.equal(res.killedByTest, false, `exited on ${sig}; stderr=${run.stderr()}`);
    assert.equal(res.code, code, `exit code (signal=${res.signal}); stderr=${run.stderr()}`);
    assert.ok(res.ms < 15_000, `took ${res.ms} ms`);
    assert.deepEqual(sessionDirs(runtime), [], 'session runtime dirs removed');
    fs.rmSync(root, { recursive: true, force: true });
  });
}

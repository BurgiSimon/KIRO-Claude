/**
 * Round-5 "repl-signals" P4: `chat --no-interactive` (the built kiro-claude over
 * test/fixtures/fake-claude.mjs, temp HOME / KIRO_HOME / CLAUDE_CONFIG_DIR / XDG dirs) on
 * SIGTERM / SIGHUP during the run, and SIGINT / SIGTERM while its session starts: the session is
 * closed first (SessionEnd hooks, its record saved, its lock released; a start still running its
 * agentSpawn hooks is cancelled, leaving nothing), then kiro-claude dies of the signal, printing
 * nothing more than before.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { builtBin } from '../cli/helpers.js';
import { fakeClaudePath } from '../claude/helpers.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Root {
  root: string;
  ws: string;
  sessions: string;
  env: NodeJS.ProcessEnv;
  cleanup(): void;
}

function mkRoot(script: unknown): Root {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kc-r5hl-')));
  const home = path.join(root, 'home');
  const ws = path.join(root, 'proj');
  for (const d of [home, path.join(ws, '.kiro'), path.join(root, 'cache')]) fs.mkdirSync(d, { recursive: true });
  fs.mkdirSync(path.join(root, 'run'), { mode: 0o700 });
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(FAKE_CLAUDE_|KIRO|CLAUDE|XDG_)/.test(k) && v !== undefined) env[k] = v;
  Object.assign(env, {
    HOME: home,
    KIRO_HOME: path.join(home, '.kiro'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    XDG_RUNTIME_DIR: path.join(root, 'run'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_DATA_HOME: path.join(root, 'data'),
    KIRO_CLAUDE_BIN: fakeClaudePath(),
    FAKE_CLAUDE_PERSIST: '1',
    FAKE_CLAUDE_SCRIPT_JSON: JSON.stringify(script),
    NO_COLOR: '1',
  });
  return {
    root,
    ws,
    sessions: path.join(home, '.kiro', 'sessions', 'cli'),
    env,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function hook(r: Root, name: string, trigger: string, command: string): void {
  const dir = path.join(r.ws, '.kiro', 'hooks');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({ version: 'v1', hooks: [{ name, trigger, timeout: 0, action: { type: 'command', command } }] }));
}

function sessionFiles(r: Root): string[] {
  return fs.existsSync(r.sessions) ? fs.readdirSync(r.sessions).sort() : [];
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface Run {
  stdout(): string;
  stderr(): string;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  kill(sig: NodeJS.Signals): void;
  waitFor(re: RegExp, ms?: number): Promise<void>;
}

function headless(r: Root, args: string[]): Run {
  const child = spawn(process.execPath, [builtBin(), 'chat', '--no-interactive', ...args], { cwd: r.ws, env: r.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr.on('data', (d: Buffer) => (err += d.toString()));
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => child.on('exit', (code, signal) => res({ code, signal })));
  return {
    stdout: () => out,
    stderr: () => err,
    exit,
    kill: (sig) => child.kill(sig),
    async waitFor(re, ms = 20_000) {
      const t0 = Date.now();
      while (!re.test(out + err)) {
        if (Date.now() - t0 > ms) {
          child.kill('SIGKILL');
          throw new Error(`timeout waiting for ${re}\n--- stdout:\n${out}\n--- stderr:\n${err}`);
        }
        await sleep(25);
      }
    },
  };
}

interface Rec {
  sessionId: string;
  turns: unknown[];
}

function recordsOf(r: Root): Rec[] {
  return sessionFiles(r)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(r.sessions, f), 'utf8')) as Rec);
}

for (const sig of ['SIGTERM', 'SIGHUP'] as const) {
  for (const format of ['text', 'stream-json'] as const) {
    test(`r5 P4: ${sig} during a \`chat --no-interactive\` turn (${format}) closes the session (SessionEnd hook, lock released; a first prompt that got no reply leaves no record), prints nothing more, then dies of ${sig}`, { timeout: 60_000 }, async () => {
      const r = mkRoot({ turns: [{ steps: [{ text: 'WORKING' }, { sleepMs: 20_000 }, { text: 'NEVER' }] }] });
      try {
        const marker = path.join(r.root, 'session-ended');
        hook(r, 'end', 'SessionEnd', `touch '${marker}'`);
        const h = headless(r, [...(format === 'stream-json' ? ['--output-format', 'stream-json'] : []), 'do the thing']);
        await h.waitFor(/WORKING/);
        await sleep(300);
        const before = { out: h.stdout(), err: h.stderr() };
        const t0 = Date.now();
        h.kill(sig);
        const e = await h.exit;
        assert.equal(e.signal, sig, `exit ${JSON.stringify(e)}\n${h.stderr()}`);
        assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
        assert.ok(fs.existsSync(marker), 'the SessionEnd hook did not run');
        // Q saves a conversation only after a reply: closing drops a chat whose only prompt got none
        assert.deepEqual(sessionFiles(r), [], 'files left behind');
        assert.equal(h.stdout(), before.out, 'stdout changed after the signal');
        assert.equal(h.stderr(), before.err, 'stderr changed after the signal');
      } finally {
        r.cleanup();
      }
    });
  }

  test(`r5 P4: ${sig} during a resumed \`chat --no-interactive --resume\` turn keeps the conversation's record with its lock released`, { timeout: 60_000 }, async () => {
    const r = mkRoot({
      turns: [
        { repeat: true, match: 'first question', steps: [{ text: 'FIRST-ANSWER' }] },
        { repeat: true, steps: [{ text: 'WORKING' }, { sleepMs: 20_000 }, { text: 'NEVER' }] },
      ],
    });
    try {
      const first = headless(r, ['first question']);
      assert.deepEqual(await first.exit, { code: 0, signal: null }, first.stderr());
      const [rec] = recordsOf(r);
      assert.ok(rec, 'no record after the first run');
      const marker = path.join(r.root, 'session-ended');
      hook(r, 'end', 'SessionEnd', `touch '${marker}'`);
      const h = headless(r, ['--resume', 'second question']);
      await h.waitFor(/WORKING/);
      await sleep(300);
      const before = { out: h.stdout(), err: h.stderr() };
      h.kill(sig);
      const e = await h.exit;
      assert.equal(e.signal, sig, `exit ${JSON.stringify(e)}\n${h.stderr()}`);
      assert.ok(fs.existsSync(marker), 'the SessionEnd hook did not run');
      const files = sessionFiles(r);
      assert.deepEqual(files.filter((f) => f.endsWith('.lock')), [], `lock left behind: ${files.join(', ')}`);
      const after = recordsOf(r);
      assert.deepEqual(after.map((x) => x.sessionId), [rec.sessionId], 'the conversation record is kept');
      assert.ok(after[0]!.turns.length >= 1);
      assert.equal(h.stdout(), before.out, 'stdout changed after the signal');
      assert.equal(h.stderr(), before.err, 'stderr changed after the signal');
    } finally {
      r.cleanup();
    }
  });
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  test(`r5 P4: ${sig} while \`chat --no-interactive\` runs its agentSpawn hooks cancels the start (hook killed, nothing left), then kiro-claude dies of ${sig}`, { timeout: 60_000 }, async () => {
    const r = mkRoot({ turns: [{ steps: [{ text: 'NEVER' }] }] });
    try {
      const pidFile = path.join(r.root, 'spawn.pid');
      hook(r, 'spawn', 'SessionStart', `trap '' TERM INT HUP; echo $$ > '${pidFile}'; sleep 30`);
      const h = headless(r, ['do the thing']);
      const t0 = Date.now();
      while (!fs.existsSync(pidFile) || fs.readFileSync(pidFile, 'utf8').trim() === '') {
        if (Date.now() - t0 > 20_000) throw new Error(`the hook never ran\n${h.stderr()}`);
        await sleep(25);
      }
      const hookPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
      await sleep(200);
      const before = { out: h.stdout(), err: h.stderr() };
      const t1 = Date.now();
      h.kill(sig);
      const e = await h.exit;
      assert.equal(e.signal, sig, `exit ${JSON.stringify(e)}\n${h.stderr()}`);
      assert.ok(Date.now() - t1 < 5000, `took ${Date.now() - t1} ms`);
      await sleep(100);
      assert.equal(pidAlive(hookPid), false, 'the agentSpawn hook outlived kiro-claude');
      assert.deepEqual(sessionFiles(r), [], 'the cancelled start left files behind');
      assert.equal(h.stdout(), before.out);
      assert.equal(h.stderr(), before.err);
    } finally {
      r.cleanup();
    }
  });
}

test('r5 P4: a normal `chat --no-interactive` run keeps its exit status and output', { timeout: 60_000 }, async () => {
  const r = mkRoot({ turns: [{ steps: [{ text: 'HELLO-THERE' }] }] });
  try {
    const h = headless(r, ['hi']);
    const e = await h.exit;
    assert.deepEqual(e, { code: 0, signal: null }, h.stderr());
    assert.match(h.stdout(), /HELLO-THERE/);
    assert.deepEqual(sessionFiles(r).filter((f) => f.endsWith('.lock')), []);
  } finally {
    r.cleanup();
  }
});

/**
 * Guards for the round-4 "session-records" items on the chat side (scratchpad r4-findings.json):
 *  - #5 / #9: the exit hint names the record close() kept (printed after it), never an id
 *    closing dropped; after a /spec flow and /quit it names the continuation, which `chat
 *    --resume-id` and `chat --resume` reopen with the spec turns.
 *  - #4: SIGHUP / SIGTERM (a closed terminal, `kill`) and a Ctrl+C while `chat` starts close the
 *    session before kiro-claude dies of the signal: a chat that never had a message leaves no
 *    record (nor lock), SessionEnd hooks run, a conversation keeps its record; a record left
 *    anyway (the start outlasted the grace) is not offered by `--list-sessions` / `chat --resume`.
 *
 * The CLI cases drive the built `kiro-claude chat` over test/fixtures/fake-claude.mjs, all in a
 * temp HOME / KIRO_HOME / CLAUDE_CONFIG_DIR / XDG dirs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { builtBin } from '../cli/helpers.js';
import { fakeClaudePath } from '../claude/helpers.js';
import { runToEnd, startRepl } from './harness.js';
import { MockSession } from './mockSession.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ───────────────────────────── the exit hint (mock sessions) ─────────────────────────────

test('r4 #9: the exit hint is printed after close(), for the id resumeId() names', async () => {
  class Watched extends MockSession {
    hintBeforeClose = false;
    out: () => string = () => '';
    override async close(): Promise<void> {
      this.hintBeforeClose = this.out().includes('To resume this session');
      await super.close();
    }
  }
  const s = new Watched();
  s.resumeIdAfterClose = 'aaaaaaaa-0000-4000-8000-000000000001';
  const run = startRepl({ session: s, input: ['/quit'] });
  s.out = run.out;
  const code = await run.exit;
  const out = run.out();
  assert.equal(code, 0);
  assert.ok(s.closed);
  assert.equal(s.hintBeforeClose, false);
  assert.ok(out.endsWith('\nTo resume this session: kiro-claude chat --resume-id aaaaaaaa-0000-4000-8000-000000000001\n'), out);
  assert.ok(!out.includes(`--resume-id ${s.id}`), 'never the id closing dropped');
  run.t.cleanup();
});

test('r4 #9: no exit hint when closing left nothing to resume (a chat that never had a message)', async () => {
  const s = new MockSession();
  s.resumeIdAfterClose = undefined;
  const { code, out, run } = await runToEnd({ session: s, input: ['/quit'] });
  assert.equal(code, 0);
  assert.ok(!out.includes('To resume this session'), out);
  assert.ok(out.endsWith('\n'));
  run.t.cleanup();
});

// ───────────────────────────── the built CLI ─────────────────────────────

const ANSWER = { repeat: true, steps: [{ text: 'ANSWER history=[{{historyUserTexts}}] END' }] };

interface Root {
  root: string;
  ws: string;
  sessions: string;
  env(extra?: Record<string, string>): NodeJS.ProcessEnv;
  cleanup(): void;
}

function mkRoot(script: unknown = { turns: [ANSWER] }): Root {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kc-r4rec-')));
  const home = path.join(root, 'home');
  const ws = path.join(root, 'proj');
  for (const d of [home, path.join(ws, '.kiro'), path.join(root, 'cache')]) fs.mkdirSync(d, { recursive: true });
  fs.mkdirSync(path.join(root, 'run'), { mode: 0o700 });
  return {
    root,
    ws,
    sessions: path.join(home, '.kiro', 'sessions', 'cli'),
    env(extra = {}) {
      const env: NodeJS.ProcessEnv = {};
      for (const [k, v] of Object.entries(process.env)) if (!/^(FAKE_CLAUDE_|KIRO|CLAUDE|XDG_)/.test(k) && v !== undefined) env[k] = v;
      return {
        ...env,
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
        ...extra,
      };
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

interface Cli {
  o(): string;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  pid: number;
  line(s: string): void;
  end(): void;
  kill(sig: NodeJS.Signals): void;
  waitFor(re: RegExp, from?: number, ms?: number): Promise<void>;
}

function cli(r: Root, args: string[], extra: Record<string, string> = {}): Cli {
  const child = spawn(process.execPath, [builtBin(), ...args], { cwd: r.ws, env: r.env(extra), stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr.on('data', (d: Buffer) => (out += d.toString()));
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => child.on('exit', (code, signal) => res({ code, signal })));
  const o = (): string => out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  return {
    o,
    exit,
    pid: child.pid!,
    line: (s) => child.stdin.write(`${s}\n`),
    end: () => child.stdin.end(),
    kill: (sig) => child.kill(sig),
    async waitFor(re, from = 0, ms = 20_000) {
      const t0 = Date.now();
      while (!re.test(o().slice(from))) {
        if (Date.now() - t0 > ms) {
          child.kill('SIGKILL');
          throw new Error(`timeout waiting for ${re}\n--- out:\n${o().slice(from)}`);
        }
        await sleep(25);
      }
    },
  };
}

function sessionFiles(r: Root): string[] {
  return fs.existsSync(r.sessions) ? fs.readdirSync(r.sessions).sort() : [];
}

function records(r: Root): { sessionId: string; origin: string; turns: unknown[] }[] {
  return sessionFiles(r)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(r.sessions, f), 'utf8')) as { sessionId: string; origin: string; turns: unknown[] });
}

/** One conversation, then /quit: the record `chat --resume` must keep finding. */
async function realConversation(r: Root): Promise<string> {
  const c = cli(r, ['chat']);
  c.line('real conversation');
  c.line('/quit');
  c.end();
  const e = await c.exit;
  assert.equal(e.code, 0, c.o());
  assert.match(c.o(), /ANSWER history=\[real conversation\] END/);
  const m = /--resume-id ([0-9a-f-]{36})/.exec(c.o());
  assert.ok(m, c.o());
  return m[1]!;
}

async function resumeLatest(r: Root): Promise<string> {
  const c = cli(r, ['chat', '--resume']);
  c.line('after resume');
  c.line('/quit');
  c.end();
  const e = await c.exit;
  assert.equal(e.code, 0, c.o());
  return c.o();
}

function hook(r: Root, name: string, trigger: string, command: string): void {
  const dir = path.join(r.ws, '.kiro', 'hooks');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({ version: 'v1', hooks: [{ name, trigger, timeout: 0, action: { type: 'command', command } }] }));
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('r4 #5/#9: after a /spec flow and /quit the hint names the continuation, which keeps the spec turns', { timeout: 120_000 }, async () => {
  const r = mkRoot({ turns: [{ repeat: true, match: 'Phase: REQUIREMENTS', steps: [{ text: 'DRAFTED-REQS' }] }, ANSWER] });
  try {
    const c = cli(r, ['chat']);
    await c.waitFor(/> $/);
    c.line('remember CODEWORD-PELICAN');
    await c.waitFor(/ANSWER history=\[remember CODEWORD-PELICAN\] END[\s\S]*> $/);
    let mark = c.o().length;
    c.line('/spec new my-feature --type feature --workflow requirements-first a csv export');
    await c.waitFor(/DRAFTED-REQS[\s\S]*Stop here \(resume later with \/spec my-feature\)[\s\S]*> $/, mark);
    mark = c.o().length;
    c.line('2');
    await c.waitFor(/Stopped at the requirements\.md checkpoint[\s\S]*> $/, mark);
    c.line('/quit');
    c.end();
    assert.equal((await c.exit).code, 0, c.o().slice(-400));
    const m = /To resume this session: kiro-claude chat --resume-id ([0-9a-f-]{36})\n$/.exec(c.o());
    assert.ok(m, c.o().slice(-400));
    const hinted = records(r).find((x) => x.sessionId === m[1]);
    assert.ok(hinted, `the hint names ${m[1]}, which closing dropped; records: ${records(r).map((x) => `${x.sessionId}(${x.origin})`).join(', ')}`);
    assert.equal(hinted.origin, 'repl', 'the continuation, not the spec phase record');

    const byId = cli(r, ['chat', '--resume-id', m[1]!]);
    byId.line('which code word?');
    byId.line('/quit');
    byId.end();
    assert.equal((await byId.exit).code, 0, byId.o());
    assert.match(byId.o(), /ANSWER history=\[remember CODEWORD-PELICAN \| [^\]]*Phase: REQUIREMENTS[^\]]* \| which code word\?\] END/, byId.o().slice(-600));

    const latest = cli(r, ['chat', '--resume']);
    latest.line('and again?');
    latest.line('/quit');
    latest.end();
    assert.equal((await latest.exit).code, 0, latest.o());
    assert.match(latest.o(), /ANSWER history=\[remember CODEWORD-PELICAN \| [^\]]*Phase: REQUIREMENTS[\s\S]*\| and again\?\] END/, `\`chat --resume\` lost the spec turns: ${latest.o().slice(-600)}`);
  } finally {
    r.cleanup();
  }
});

test('r4 #9: /quit of a chat that never had a message prints no hint and leaves no record', { timeout: 60_000 }, async () => {
  const r = mkRoot();
  try {
    const c = cli(r, ['chat']);
    await c.waitFor(/> $/);
    c.line('/quit');
    c.end();
    assert.equal((await c.exit).code, 0, c.o());
    assert.doesNotMatch(c.o(), /To resume this session/, c.o());
    assert.deepEqual(sessionFiles(r), []);
  } finally {
    r.cleanup();
  }
});

test('r4 #4: Ctrl+C while `chat` runs its agentSpawn hooks: the start is cancelled, nothing stays, kiro-claude dies of SIGINT', { timeout: 90_000 }, async () => {
  const r = mkRoot();
  try {
    const realId = await realConversation(r);
    const pidFile = path.join(r.root, 'spawn.pid');
    hook(r, 'spawn', 'SessionStart', `echo $$ > '${pidFile}'; exec sleep 30`);
    const c = cli(r, ['chat']);
    const t0 = Date.now();
    while (!fs.existsSync(pidFile) || fs.readFileSync(pidFile, 'utf8').trim() === '') {
      if (Date.now() - t0 > 20_000) throw new Error(`the hook never ran\n${c.o()}`);
      await sleep(25);
    }
    const hookPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    c.kill('SIGINT'); // the terminal's Ctrl+C: the REPL does not read keys yet
    const e = await c.exit;
    assert.equal(e.signal, 'SIGINT', `exit ${JSON.stringify(e)}\n${c.o()}`);
    assert.ok(Date.now() - t0 < 20_000);
    assert.equal(pidAlive(hookPid), false, 'the agentSpawn hook outlived kiro-claude');
    assert.deepEqual(sessionFiles(r).filter((f) => !f.startsWith(realId)), [], 'the cancelled start left files behind');
    fs.rmSync(path.join(r.ws, '.kiro', 'hooks'), { recursive: true, force: true });
    assert.match(await resumeLatest(r), /ANSWER history=\[real conversation \| after resume\] END/);
  } finally {
    r.cleanup();
  }
});

test('r4 #4: Ctrl+C while Claude Code initializes for longer than the grace: the record left behind is not offered', { timeout: 90_000 }, async () => {
  const r = mkRoot();
  try {
    const realId = await realConversation(r);
    const c = cli(r, ['chat'], { FAKE_CLAUDE_CONTROL_DELAYS: JSON.stringify({ initialize: 15_000 }) });
    const t0 = Date.now();
    // the fresh record is in the index before Claude Code is up (KiroSessionImpl.build)
    while (sessionFiles(r).filter((f) => f.endsWith('.json') && !f.startsWith(realId)).length === 0) {
      if (Date.now() - t0 > 20_000) throw new Error(`no fresh record\n${c.o()}`);
      await sleep(25);
    }
    await sleep(300);
    c.kill('SIGINT');
    const e = await c.exit;
    assert.equal(e.signal, 'SIGINT', `exit ${JSON.stringify(e)}\n${c.o()}`);
    assert.ok(Date.now() - t0 < 12_000, 'kiro-claude waited for the whole initialize');
    const list = spawnSync(process.execPath, [builtBin(), 'chat', '--list-sessions'], { cwd: r.ws, env: r.env(), encoding: 'utf8' });
    assert.doesNotMatch(list.stdout, /0 messages/, `stray empty record listed:\n${list.stdout}`);
    assert.match(list.stdout, new RegExp(realId));
    assert.deepEqual(sessionFiles(r).filter((f) => !f.startsWith(realId)), [], 'the left-behind record is removed');
    assert.match(await resumeLatest(r), /ANSWER history=\[real conversation \| after resume\] END/);
  } finally {
    r.cleanup();
  }
});

for (const sig of ['SIGTERM', 'SIGHUP'] as const) {
  test(`r4 #4: ${sig} at the first prompt of a fresh chat closes it (SessionEnd hook, no record, no lock), then kiro-claude dies of ${sig}`, { timeout: 90_000 }, async () => {
    const r = mkRoot();
    try {
      const realId = await realConversation(r);
      const marker = path.join(r.root, 'session-ended');
      hook(r, 'end', 'SessionEnd', `touch '${marker}'`);
      const c = cli(r, ['chat']);
      await c.waitFor(/> $/);
      c.kill(sig);
      const e = await c.exit;
      assert.equal(e.signal, sig, `exit ${JSON.stringify(e)}\n${c.o()}`);
      assert.ok(fs.existsSync(marker), 'SessionEnd hooks did not run');
      assert.deepEqual(sessionFiles(r).filter((f) => !f.startsWith(realId)), [], 'the never-used chat left files behind');
      assert.match(await resumeLatest(r), /ANSWER history=\[real conversation \| after resume\] END/);
    } finally {
      r.cleanup();
    }
  });
}

test('r4 #4: SIGHUP at the prompt of a chat with a conversation keeps its record and releases its lock', { timeout: 90_000 }, async () => {
  const r = mkRoot();
  try {
    const c = cli(r, ['chat']);
    await c.waitFor(/> $/);
    c.line('kept conversation');
    await c.waitFor(/ANSWER history=\[kept conversation\] END[\s\S]*> $/);
    c.kill('SIGHUP');
    const e = await c.exit;
    assert.equal(e.signal, 'SIGHUP', `exit ${JSON.stringify(e)}\n${c.o()}`);
    const files = sessionFiles(r);
    assert.equal(files.filter((f) => f.endsWith('.json')).length, 1, files.join(', '));
    assert.deepEqual(files.filter((f) => f.endsWith('.lock')), [], 'the lock was not released');
    const out = await resumeLatest(r);
    assert.match(out, /ANSWER history=\[kept conversation \| after resume\] END/);
  } finally {
    r.cleanup();
  }
});

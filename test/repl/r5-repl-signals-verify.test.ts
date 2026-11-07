/**
 * Round-5 "repl-signals", verifier: the built `kiro-claude chat` over test/fixtures/fake-claude.mjs
 * (temp HOME / KIRO_HOME / CLAUDE_CONFIG_DIR / XDG dirs), states the fixer's tests do not reach:
 *  - P1 x P3: SIGTERM while the `/spec` continuation runs its agentSpawn hooks (after Stop at a
 *    checkpoint): the hook is killed, nothing half-started stays, the chat's SessionEnd comes first,
 *    `chat --resume` reaches the chat, and nothing claims a Ctrl+C the user never pressed (the
 *    cancelled-continuation notice is for a press; after a fatal signal command output stops);
 *  - P3: SIGTERM during the design phase turn of a flow whose requirements phase session (a
 *    revision turn) was already closed by the flow: no lock, `chat --resume` reaches the chat;
 *  - P2 x P3: SIGTERM while the forced-stop restart runs its agentSpawn hook;
 *  - P2 end to end on the real session module: Ctrl+C cancels the restart's agentSpawn hook (killed),
 *    the next input restarts Claude Code and continues the conversation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { builtBin } from '../cli/helpers.js';
import { fakeClaudePath } from '../claude/helpers.js';
import { REQ_MD } from '../spec/helpers.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const ANSWER = { repeat: true, steps: [{ text: 'ANSWER history=[{{historyUserTexts}}] END' }] };

interface Root {
  root: string;
  ws: string;
  sessions: string;
  env(): NodeJS.ProcessEnv;
  cleanup(): void;
}

function mkRoot(script: unknown, extraEnv: Record<string, string> = {}): Root {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kc-r5sigv-')));
  const home = path.join(root, 'home');
  const ws = path.join(root, 'proj');
  for (const d of [home, path.join(ws, '.kiro', 'hooks'), path.join(root, 'cache')]) fs.mkdirSync(d, { recursive: true });
  fs.mkdirSync(path.join(root, 'run'), { mode: 0o700 });
  return {
    root,
    ws,
    sessions: path.join(home, '.kiro', 'sessions', 'cli'),
    env() {
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
        ...extraEnv,
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
  line(s: string): void;
  ctrlC(): void;
  end(): void;
  kill(sig: NodeJS.Signals): void;
  waitFor(re: RegExp, from?: number, ms?: number): Promise<void>;
}

function cli(r: Root, args: string[]): Cli {
  const child = spawn(process.execPath, [builtBin(), ...args], { cwd: r.ws, env: r.env(), stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr.on('data', (d: Buffer) => (out += d.toString()));
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => child.on('exit', (code, signal) => res({ code, signal })));
  const o = (): string => out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  return {
    o,
    exit,
    line: (s) => child.stdin.write(`${s}\n`),
    // line mode (stdin is a pipe): a `\u0003` line is a Ctrl+C
    ctrlC: () => child.stdin.write('\u0003\n'),
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

function hook(r: Root, name: string, trigger: string, command: string): void {
  fs.writeFileSync(path.join(r.ws, '.kiro', 'hooks', `${name}.json`), JSON.stringify({ version: 'v1', hooks: [{ name, trigger, timeout: 0, action: { type: 'command', command } }] }));
}

/** A SessionEnd hook appending each session's id (its payload) to `file`. */
function sessionEndHook(r: Root, file: string): void {
  hook(r, 'end', 'SessionEnd', `cat >> '${file}'; echo >> '${file}'`);
}

/**
 * An agentSpawn hook that is fast except for the `slowAt`-th session start: that one ignores
 * TERM/INT/HUP, writes its pid to the returned file and would run 20 s (timeout 0).
 */
function spawnHook(r: Root, slowAt: number): string {
  const count = path.join(r.root, 'spawn.count');
  const pidFile = path.join(r.root, 'spawn.pid');
  hook(r, 'spawn', 'SessionStart', `n=$(($(cat '${count}' 2>/dev/null || echo 0) + 1)); echo $n > '${count}'; if [ "$n" -eq ${slowAt} ]; then trap '' TERM INT HUP; echo $$ > '${pidFile}'; sleep 20; fi`);
  return pidFile;
}

async function waitPid(file: string, what: () => string, ms = 20_000): Promise<number> {
  const t0 = Date.now();
  for (;;) {
    const v = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '';
    if (/^\d+$/.test(v)) return Number(v);
    if (Date.now() - t0 > ms) throw new Error(`no hook pid in ${file}\n${what()}`);
    await sleep(25);
  }
}

/** Alive and not a zombie (a killed hook's shell may linger unreaped for a moment). */
function alive(pid: number): boolean {
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, 'latin1');
    const st = s.slice(s.lastIndexOf(')') + 2).split(' ')[0];
    return st !== 'Z' && st !== 'X';
  } catch {
    return false;
  }
}

async function gone(pid: number, ms = 2000): Promise<boolean> {
  const t0 = Date.now();
  while (alive(pid)) {
    if (Date.now() - t0 > ms) return false;
    await sleep(25);
  }
  return true;
}

function kill(pid: number | undefined): void {
  if (pid === undefined || !alive(pid)) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // gone
  }
}

function endedIds(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => (JSON.parse(l) as { session_id?: string }).session_id ?? '?');
}

async function resumeLatest(r: Root): Promise<string> {
  fs.rmSync(path.join(r.ws, '.kiro', 'hooks'), { recursive: true, force: true });
  const c = cli(r, ['chat', '--resume']);
  c.line('which?');
  c.line('/quit');
  c.end();
  const e = await c.exit;
  assert.equal(e.code, 0, c.o());
  return c.o();
}

/** Start the chat, have one conversation, return the chat's own session id (from its record). */
async function chatWithConversation(r: Root): Promise<{ c: Cli; mainId: string }> {
  const c = cli(r, ['chat']);
  await c.waitFor(/> $/);
  c.line('remember PELICAN');
  await c.waitFor(/ANSWER history=\[remember PELICAN\] END[\s\S]*> $/);
  const recs = records(r);
  assert.equal(recs.length, 1, recs.map((x) => x.sessionId).join(','));
  return { c, mainId: recs[0]!.sessionId };
}

test('r5 verify P1/P3: SIGTERM while the /spec continuation runs its agentSpawn hook kills it, leaves nothing half-started, closes the chat first, and claims no Ctrl+C', { timeout: 120_000 }, async () => {
  const r = mkRoot({ turns: [{ repeat: true, match: 'Phase: REQUIREMENTS', steps: [{ text: 'DRAFTED-REQS' }] }, ANSWER] });
  let hookPid: number | undefined;
  try {
    const endFile = path.join(r.root, 'ended.jsonl');
    sessionEndHook(r, endFile);
    // starts: 1 the chat, 2 the requirements phase session, 3 the continuation (slow)
    const pidFile = spawnHook(r, 3);
    const { c, mainId } = await chatWithConversation(r);
    const mark = c.o().length;
    c.line('/spec new my-feature --type feature --workflow requirements-first a csv export');
    await c.waitFor(/Stop here[\s\S]*> $/, mark);
    c.line('Stop');
    hookPid = await waitPid(pidFile, () => c.o().slice(mark));
    await sleep(300);
    const atSignal = c.o().length;
    c.kill('SIGTERM');
    const e = await c.exit;
    assert.equal(e.signal, 'SIGTERM', `exit ${JSON.stringify(e)}\n${c.o().slice(-600)}`);
    assert.ok(await gone(hookPid), 'the continuation agentSpawn hook outlived kiro-claude');
    const after = c.o().slice(atSignal);
    assert.doesNotMatch(after, /Ctrl\+C/, `a SIGTERM was reported as a Ctrl+C:\n${after}`);
    const files = sessionFiles(r);
    assert.deepEqual(files.filter((f) => f.endsWith('.lock')), [], `locks left behind: ${files.join(', ')}`);
    const recs = records(r);
    // the chat and the phase session that holds the spec conversation; no continuation record
    assert.equal(recs.length, 2, files.join(', '));
    assert.deepEqual(recs.filter((x) => x.sessionId !== mainId).map((x) => x.origin), ['spec'], files.join(', '));
    const ended = endedIds(endFile);
    assert.equal(ended[0], mainId, `the user's chat must be closed first (SessionEnd order: ${ended.join(', ')})`);
    assert.equal(ended.length, 2, `SessionEnd hooks ran for ${ended.join(', ')} (the cancelled continuation never started)`);
    assert.match(await resumeLatest(r), /ANSWER history=\[remember PELICAN \| which\?\] END/);
  } finally {
    kill(hookPid);
    r.cleanup();
  }
});

test('r5 verify P3: SIGTERM during a design phase turn, after the flow closed its requirements session (a revision turn): no lock left, `chat --resume` reaches the chat', { timeout: 120_000 }, async () => {
  const r = mkRoot({
    turns: [
      { repeat: true, match: 'per this feedback', steps: [{ text: 'REVISED' }] },
      { repeat: true, match: 'Phase: DESIGN', steps: [{ text: 'DESIGN-START' }, { sleepMs: 20_000 }, { text: 'NEVER' }] },
      ANSWER,
    ],
  });
  try {
    const dir = path.join(r.ws, '.kiro', 'specs', 'my-feature');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'requirements.md'), REQ_MD);
    const endFile = path.join(r.root, 'ended.jsonl');
    sessionEndHook(r, endFile);
    const { c, mainId } = await chatWithConversation(r);
    const mark = c.o().length;
    c.line('/spec my-feature');
    await c.waitFor(/Stop here[\s\S]*> $/, mark);
    c.line('Request');
    await c.waitFor(/What should change in requirements\.md\?/, mark);
    c.line('also a tsv export');
    await c.waitFor(/REVISED[\s\S]*Stop here[\s\S]*> $/, mark);
    c.line('Approve');
    await c.waitFor(/DESIGN-START/, mark);
    await sleep(300);
    const before = endedIds(endFile);
    assert.equal(before.length, 1, `precondition: the flow closed the requirements session (${before.join(', ')})`);
    c.kill('SIGTERM');
    const e = await c.exit;
    assert.equal(e.signal, 'SIGTERM', `exit ${JSON.stringify(e)}\n${c.o().slice(-600)}`);
    const files = sessionFiles(r);
    assert.deepEqual(files.filter((f) => f.endsWith('.lock')), [], `locks left behind: ${files.join(', ')}`);
    const ended = endedIds(endFile).slice(before.length);
    assert.equal(ended[0], mainId, `the user's chat must be closed first at the signal (${ended.join(', ')})`);
    assert.equal(ended.length, 2, `SessionEnd at the signal: ${ended.join(', ')}`);
    assert.match(await resumeLatest(r), /ANSWER history=\[remember PELICAN \| which\?\] END/);
  } finally {
    r.cleanup();
  }
});

/** A chat with one conversation, then a turn Claude Code never ends (it ignores the interrupt), stopped by a second Ctrl+C. */
async function forcedStop(r: Root): Promise<{ c: Cli; mainId: string }> {
  const { c, mainId } = await chatWithConversation(r);
  const mark = c.o().length;
  c.line('run the slow thing');
  await c.waitFor(/WORKING/, mark);
  await sleep(300);
  c.ctrlC();
  await sleep(300);
  c.ctrlC();
  await c.waitFor(/did not stop after the interrupt; stopping it\.[\s\S]*> $/, mark, 15_000);
  return { c, mainId };
}

const SLOW_TURN = { repeat: true, match: 'slow thing', steps: [{ text: 'WORKING' }, { sleepMs: 100_000 }] };
const IGNORE_INTERRUPT = { FAKE_CLAUDE_CONTROL_DELAYS: JSON.stringify({ interrupt: 120_000 }) };

test('r5 verify P2: Ctrl+C while the forced-stop restart runs its agentSpawn hook kills the hook and cancels the restart; the next input restarts Claude Code and continues the conversation', { timeout: 120_000 }, async () => {
  const r = mkRoot({ turns: [SLOW_TURN, ANSWER] }, IGNORE_INTERRUPT);
  let hookPid: number | undefined;
  try {
    // starts: 1 the chat, 2 the restart (slow), 3 the next restart (fast)
    const pidFile = spawnHook(r, 2);
    const { c, mainId } = await forcedStop(r);
    let mark = c.o().length;
    c.line('next please');
    hookPid = await waitPid(pidFile, () => c.o().slice(mark));
    await sleep(300);
    c.ctrlC();
    await c.waitFor(/Restart cancelled \(Ctrl\+C\)[\s\S]*> $/, mark, 6000);
    assert.ok(await gone(hookPid), 'the restart agentSpawn hook still runs');
    assert.deepEqual(sessionFiles(r).filter((f) => f.endsWith('.lock')), [], 'the cancelled restart left a lock');
    assert.deepEqual(records(r).map((x) => x.sessionId), [mainId]);
    mark = c.o().length;
    c.line('after cancel');
    await c.waitFor(/ANSWER history=\[remember PELICAN \| run the slow thing \| after cancel\] END[\s\S]*> $/, mark, 15_000);
    c.line('/quit');
    c.end();
    assert.equal((await c.exit).code, 0, c.o().slice(-600));
    assert.deepEqual(sessionFiles(r).filter((f) => f.endsWith('.lock')), []);
  } finally {
    kill(hookPid);
    r.cleanup();
  }
});

test('r5 verify P2/P3: SIGTERM while the forced-stop restart runs its agentSpawn hook kills the hook; the record is kept with no lock and `chat --resume` continues it', { timeout: 120_000 }, async () => {
  const r = mkRoot({ turns: [SLOW_TURN, ANSWER] }, IGNORE_INTERRUPT);
  let hookPid: number | undefined;
  try {
    const endFile = path.join(r.root, 'ended.jsonl');
    sessionEndHook(r, endFile);
    const pidFile = spawnHook(r, 2);
    const { c, mainId } = await forcedStop(r);
    const mark = c.o().length;
    c.line('next please');
    hookPid = await waitPid(pidFile, () => c.o().slice(mark));
    await sleep(300);
    const atSignal = c.o().length;
    c.kill('SIGTERM');
    const e = await c.exit;
    assert.equal(e.signal, 'SIGTERM', `exit ${JSON.stringify(e)}\n${c.o().slice(-600)}`);
    assert.ok(await gone(hookPid), 'the restart agentSpawn hook outlived kiro-claude');
    assert.doesNotMatch(c.o().slice(atSignal), /Ctrl\+C|Failed/, c.o().slice(atSignal));
    assert.deepEqual(sessionFiles(r).filter((f) => f.endsWith('.lock')), []);
    assert.deepEqual(records(r).map((x) => x.sessionId), [mainId]);
    assert.deepEqual(endedIds(endFile), [mainId], 'SessionEnd: only the stopped chat had started');
    assert.match(await resumeLatest(r), /ANSWER history=\[remember PELICAN \| run the slow thing \| which\?\] END/);
  } finally {
    kill(hookPid);
    r.cleanup();
  }
});

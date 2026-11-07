/**
 * Round-5 "repl-signals" P3, the built `kiro-claude chat` over test/fixtures/fake-claude.mjs (temp
 * HOME / KIRO_HOME / CLAUDE_CONFIG_DIR / XDG dirs): SIGTERM / SIGHUP during a /spec flow, when the
 * REPL's current session is a phase or task session, closes EVERY session the REPL and its spec
 * runtime opened (the user's chat first, SessionEnd hooks for each) before kiro-claude dies of the
 * signal: no lock is left, and `chat --resume` reaches the user's conversation, not the
 * origin-'spec' phase record.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { builtBin } from '../cli/helpers.js';
import { fakeClaudePath } from '../claude/helpers.js';
import { REQ_MD, DESIGN_MD, TASKS_MD } from '../spec/helpers.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const ANSWER = { repeat: true, steps: [{ text: 'ANSWER history=[{{historyUserTexts}}] END' }] };

interface Root {
  root: string;
  ws: string;
  sessions: string;
  env(): NodeJS.ProcessEnv;
  cleanup(): void;
}

function mkRoot(script: unknown): Root {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kc-r5sig-')));
  const home = path.join(root, 'home');
  const ws = path.join(root, 'proj');
  for (const d of [home, path.join(ws, '.kiro'), path.join(root, 'cache')]) fs.mkdirSync(d, { recursive: true });
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

/** A SessionEnd hook appending each session's id (its payload) to `file`. */
function sessionEndHook(r: Root, file: string): void {
  const dir = path.join(r.ws, '.kiro', 'hooks');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'end.json'), JSON.stringify({ version: 'v1', hooks: [{ name: 'end', trigger: 'SessionEnd', timeout: 0, action: { type: 'command', command: `cat >> '${file}'; echo >> '${file}'` } }] }));
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

async function assertSettled(r: Root, c: Cli, sig: NodeJS.Signals, mainId: string, endFile: string, extra: number): Promise<void> {
  const e = await c.exit;
  assert.equal(e.signal, sig, `exit ${JSON.stringify(e)}\n${c.o().slice(-600)}`);
  const files = sessionFiles(r);
  assert.deepEqual(files.filter((f) => f.endsWith('.lock')), [], `locks left behind: ${files.join(', ')}`);
  const ended = endedIds(endFile);
  assert.equal(ended[0], mainId, `the user's chat must be closed first (SessionEnd order: ${ended.join(', ')})`);
  assert.equal(ended.length, 1 + extra, `SessionEnd hooks ran for ${ended.join(', ')}`);
  const out = await resumeLatest(r);
  assert.match(out, /ANSWER history=\[remember PELICAN \| which\?\] END/, `\`chat --resume\` did not reach the user's conversation:\n${out.slice(-800)}`);
}

for (const sig of ['SIGTERM', 'SIGHUP'] as const) {
  test(`r5 P3: ${sig} while a /spec phase session runs its turn closes the phase session and the user's chat (first): no lock left, \`chat --resume\` reaches the chat`, { timeout: 120_000 }, async () => {
    const r = mkRoot({ turns: [{ repeat: true, match: 'Phase: REQUIREMENTS', steps: [{ text: 'DRAFT-START' }, { sleepMs: 20_000 }, { text: 'DRAFTED' }] }, ANSWER] });
    try {
      const endFile = path.join(r.root, 'ended.jsonl');
      sessionEndHook(r, endFile);
      const { c, mainId } = await chatWithConversation(r);
      const mark = c.o().length;
      c.line('/spec new my-feature --type feature --workflow requirements-first a csv export');
      await c.waitFor(/DRAFT-START/, mark);
      await sleep(300);
      c.kill(sig);
      await assertSettled(r, c, sig, mainId, endFile, 1);
    } finally {
      r.cleanup();
    }
  });
}

test('r5 P3: SIGTERM at a /spec checkpoint (the phase session is current and idle) closes both sessions; `chat --resume` reaches the chat', { timeout: 120_000 }, async () => {
  const r = mkRoot({ turns: [{ repeat: true, match: 'Phase: REQUIREMENTS', steps: [{ text: 'DRAFTED-REQS' }] }, ANSWER] });
  try {
    const endFile = path.join(r.root, 'ended.jsonl');
    sessionEndHook(r, endFile);
    const { c, mainId } = await chatWithConversation(r);
    const mark = c.o().length;
    c.line('/spec new my-feature --type feature --workflow requirements-first a csv export');
    await c.waitFor(/Stop here[\s\S]*> $/, mark);
    await sleep(200);
    c.kill('SIGTERM');
    await assertSettled(r, c, 'SIGTERM', mainId, endFile, 1);
  } finally {
    r.cleanup();
  }
});

test('r5 P3: SIGTERM while a /spec run task session runs its turn closes the task session and the chat; `chat --resume` reaches the chat', { timeout: 120_000 }, async () => {
  const r = mkRoot({ turns: [{ repeat: true, match: 'Execute Task', steps: [{ text: 'TASK-START' }, { sleepMs: 20_000 }, { text: 'done\nTASK_RESULT: completed' }] }, ANSWER] });
  try {
    const dir = path.join(r.ws, '.kiro', 'specs', 'todo-export');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'requirements.md'), REQ_MD);
    fs.writeFileSync(path.join(dir, 'design.md'), DESIGN_MD);
    fs.writeFileSync(path.join(dir, 'tasks.md'), TASKS_MD);
    const endFile = path.join(r.root, 'ended.jsonl');
    sessionEndHook(r, endFile);
    const { c, mainId } = await chatWithConversation(r);
    const mark = c.o().length;
    c.line('/spec run todo-export 1.1');
    await c.waitFor(/TASK-START/, mark);
    await sleep(300);
    c.kill('SIGTERM');
    await assertSettled(r, c, 'SIGTERM', mainId, endFile, 1);
  } finally {
    r.cleanup();
  }
});

test('r5 P3: SIGTERM while a /spec phase session runs its agentSpawn hooks cancels that start (hook killed, no phase record left) and closes the chat; `chat --resume` reaches the chat', { timeout: 120_000 }, async () => {
  const r = mkRoot({ turns: [{ repeat: true, match: 'Phase: REQUIREMENTS', steps: [{ text: 'DRAFTED' }] }, ANSWER] });
  try {
    const endFile = path.join(r.root, 'ended.jsonl');
    sessionEndHook(r, endFile);
    // fast for the chat's own session, slow (ignoring TERM, timeout 0) for the phase session
    const count = path.join(r.root, 'spawn.count');
    const pidFile = path.join(r.root, 'spawn.pid');
    fs.writeFileSync(
      path.join(r.ws, '.kiro', 'hooks', 'spawn.json'),
      JSON.stringify({
        version: 'v1',
        hooks: [{ name: 'spawn', trigger: 'SessionStart', timeout: 0, action: { type: 'command', command: `n=$(($(cat '${count}' 2>/dev/null || echo 0) + 1)); echo $n > '${count}'; if [ "$n" -gt 1 ]; then trap '' TERM INT HUP; echo $$ > '${pidFile}'; sleep 20; fi` } }],
      }),
    );
    const { c, mainId } = await chatWithConversation(r);
    const mark = c.o().length;
    c.line('/spec new my-feature --type feature --workflow requirements-first a csv export');
    const t0 = Date.now();
    while (!fs.existsSync(pidFile) || fs.readFileSync(pidFile, 'utf8').trim() === '') {
      if (Date.now() - t0 > 20_000) throw new Error(`the phase session's hook never ran\n${c.o().slice(mark)}`);
      await sleep(25);
    }
    const hookPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    await sleep(200);
    c.kill('SIGTERM');
    const e = await c.exit;
    assert.equal(e.signal, 'SIGTERM', `exit ${JSON.stringify(e)}\n${c.o().slice(-600)}`);
    const alive = (): boolean => {
      try {
        process.kill(hookPid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 80 && alive(); i++) await sleep(25);
    assert.equal(alive(), false, 'the phase session agentSpawn hook outlived kiro-claude');
    const files = sessionFiles(r);
    assert.deepEqual(files.filter((f) => f.endsWith('.lock')), [], `locks left behind: ${files.join(', ')}`);
    assert.deepEqual(records(r).map((x) => x.sessionId), [mainId], `the cancelled phase start left a record: ${files.join(', ')}`);
    assert.deepEqual(endedIds(endFile), [mainId], 'SessionEnd hooks: only the chat had started');
    assert.match(await resumeLatest(r), /ANSWER history=\[remember PELICAN \| which\?\] END/);
  } finally {
    r.cleanup();
  }
});

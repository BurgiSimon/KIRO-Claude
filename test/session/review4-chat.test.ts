/**
 * K3 through the REPL (repl/commands/chat.ts `activate`): Ctrl+C while `/chat resume` or
 * `/chat load` start the next session and its agentSpawn hook runs kills the hook and cancels the
 * command. The current session stays active and is never force-stopped (F0), and nothing of the
 * session that was being started stays behind. `/chat new` is covered by test/repl/e2e-fake (R2).
 * Real runRepl + session over test/fixtures/fake-claude.mjs; no real ~/.kiro or ~/.claude.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';

import { openSettings } from '../../src/config/settings.js';
import { createWorkspaceContext } from '../../src/config/workspace.js';
import { runRepl } from '../../src/repl/repl.js';
import { SessionStore } from '../../src/session/store.js';
import type { CliContext } from '../../src/types.js';
import { stripAnsi } from '../../src/util/ansi.js';
import { fakeClaudePath, fakeEnv } from '../claude/helpers.js';
import { tempEnv } from '../repl/harness.js';

const SCRIPT = { turns: [], default: { steps: [{ text: 'ANSWER history=[{{historyUserTexts}}] END' }] } };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type Env = ReturnType<typeof tempEnv> & { kiroHome: string; sessionsDir: string; fullEnv: NodeJS.ProcessEnv };

function sandbox(): Env {
  const t = tempEnv();
  const run = path.join(t.root, 'run');
  fs.mkdirSync(run, { recursive: true, mode: 0o700 });
  const kiroHome = path.join(t.home, '.kiro');
  fs.mkdirSync(kiroHome, { recursive: true });
  const fullEnv = fakeEnv({
    ...t.env,
    KIRO_HOME: kiroHome,
    XDG_RUNTIME_DIR: run,
    XDG_CACHE_HOME: path.join(t.root, 'cache'),
    FAKE_CLAUDE_SCRIPT_JSON: JSON.stringify(SCRIPT),
    FAKE_CLAUDE_LOG: path.join(t.root, 'fake.log'),
    FAKE_CLAUDE_PERSIST: '1',
    KIRO_CLAUDE_BIN: fakeClaudePath(),
  });
  return Object.assign(t, { kiroHome, sessionsDir: t.env.KIRO_CLAUDE_SESSIONS_DIR!, fullEnv });
}

/** The real runRepl over a live stdin (line mode) and the fake claude. */
function live(e: Env) {
  const ws = createWorkspaceContext(e.wsDir, e.fullEnv);
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  stdout.on('data', (d: Buffer) => (out += d.toString()));
  const ctx: CliContext = {
    ws,
    settings: openSettings(ws),
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    progName: 'kiro-claude',
    verbosity: 0,
  };
  let ended: number | undefined;
  const exit = runRepl({ ctx, sessionOptions: { env: e.fullEnv, claudePath: fakeClaudePath() } }).then((code) => {
    ended = code;
    return code;
  });
  const o = (): string => stripAnsi(out);
  return {
    o,
    exit,
    ended: () => ended,
    line: (s: string) => stdin.write(`${s}\n`),
    ctrlC: () => stdin.write('\u0003\n'),
    end: () => stdin.end(),
    async waitFor(re: RegExp, ms = 20_000, from = 0): Promise<void> {
      const t0 = Date.now();
      while (!re.test(o().slice(from))) {
        if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${re}\n--- out:\n${o()}`);
        await sleep(25);
      }
    },
  };
}

/** A global SessionStart hook: fast the first time (the REPL's own start), then it hangs, ignoring TERM/INT/HUP. */
function slowHook(e: Env): { pid(): number | undefined; done(): boolean; kill(): void } {
  const once = path.join(e.root, 'hook.once');
  const pidFile = path.join(e.root, 'hook.pid');
  const marker = path.join(e.root, 'hook.done');
  const command = `trap '' TERM INT HUP; if [ -f '${once}' ]; then echo $$ > '${pidFile}'; sleep 30; touch '${marker}'; fi; touch '${once}'; echo SPAWN-CTX`;
  fs.mkdirSync(path.join(e.kiroHome, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(e.kiroHome, 'hooks', 'spawn.json'), JSON.stringify({ version: 'v1', hooks: [{ name: 'spawn', trigger: 'SessionStart', timeout: 60, action: { type: 'command', command } }] }));
  const pid = (): number | undefined => {
    try {
      const t = fs.readFileSync(pidFile, 'utf8').trim();
      return /^\d+$/.test(t) ? Number(t) : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    pid,
    done: () => fs.existsSync(marker),
    kill() {
      const p = pid();
      if (p === undefined) return;
      try {
        process.kill(-p, 'SIGKILL');
      } catch {
        /* gone */
      }
    },
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const records = (e: Env): string[] => (fs.existsSync(e.sessionsDir) ? fs.readdirSync(e.sessionsDir).filter((f) => f.endsWith('.json')).sort() : []);

/** Press Ctrl+C once the hook hangs; the command ends with `cancelledLine` and the prompt quickly; the hook is killed. */
async function pressWhileHookHangs(r: ReturnType<typeof live>, hook: ReturnType<typeof slowHook>, cancelledLine: RegExp): Promise<number> {
  const t0 = Date.now();
  while (hook.pid() === undefined) {
    if (Date.now() - t0 > 10_000) throw new Error(`the hook never ran again\n${r.o()}`);
    await sleep(25);
  }
  const pid = hook.pid()!;
  await sleep(200);
  const mark = r.o().length;
  const pressedAt = Date.now();
  r.ctrlC();
  await r.waitFor(new RegExp(`${cancelledLine.source}\\n\\n[\\s\\S]*> $`), 5000, mark);
  assert.ok(Date.now() - pressedAt < 4000, `the prompt came back ${Date.now() - pressedAt} ms after the press`);
  const t1 = Date.now();
  while (alive(pid) && Date.now() - t1 < 2000) await sleep(25);
  assert.ok(!alive(pid), `hook process ${pid} still runs`);
  assert.equal(hook.done(), false, 'the hook ran to completion');
  await sleep(1500); // past the forced-stop grace
  const after = r.o().slice(mark);
  assert.ok(!/did not stop/.test(after), `Claude Code was force-stopped:\n${after}`);
  assert.ok(!/Picking up where we left off|Imported conversation state|Failed to/.test(after), after);
  assert.equal(r.ended(), undefined, `the REPL quit:\n${after}`);
  return mark;
}

test('K3: Ctrl+C while /chat resume starts the picked session (its agentSpawn hook runs) cancels it; the chat stays in the current session', { timeout: 60_000 }, async () => {
  const e = sandbox();
  let hook: ReturnType<typeof slowHook> | undefined;
  try {
    // a saved session to resume
    let r = live(e);
    await r.waitFor(/> $/);
    r.line('saved SAVED_1');
    await r.waitFor(/ANSWER history=\[saved SAVED_1\] END[\s\S]*> $/);
    r.line('/quit');
    assert.equal(await r.exit, 0);
    const saved = records(e);
    assert.equal(saved.length, 1);
    hook = slowHook(e);
    r = live(e);
    try {
      await r.waitFor(/> $/);
      r.line('first main');
      await r.waitFor(/ANSWER history=\[first main\] END[\s\S]*> $/);
      const m0 = r.o().length;
      r.line('/chat resume');
      await r.waitFor(/Select a session to resume[\s\S]*> $/, 10_000, m0);
      r.line('1');
      await pressWhileHookHangs(r, hook, /Resuming the chat session was cancelled\./);
      const m2 = r.o().length;
      r.line('main again');
      await r.waitFor(/ANSWER history=\[[\s\S]*?\] END[\s\S]*> $/, 15_000, m2);
      assert.match(r.o().slice(m2), /ANSWER history=\[first main \| main again\] END/, 'still the current conversation');
      const rec = new SessionStore(e.sessionsDir).read(saved[0]!.replace(/\.json$/, ''));
      assert.equal(rec?.turns.length, 1, 'the saved session is untouched');
      r.line('/quit');
      assert.equal(await r.exit, 0);
    } finally {
      r.end();
      await r.exit.catch(() => undefined);
    }
  } finally {
    hook?.kill();
    e.cleanup();
  }
});

test('K3: Ctrl+C while /chat load starts the imported session (its agentSpawn hook runs) cancels the import; nothing of it stays', { timeout: 60_000 }, async () => {
  const e = sandbox();
  const hook = slowHook(e);
  const r = live(e);
  try {
    await r.waitFor(/> $/);
    r.line('first main');
    await r.waitFor(/ANSWER history=\[first main\] END[\s\S]*> $/);
    const file = path.join(e.root, 'exp.json');
    r.line(`/chat save ${file}`);
    await r.waitFor(/Exported conversation state[\s\S]*> $/);
    const before = records(e);
    const transcripts = (): string[] => {
      const dir = path.join(e.fullEnv.CLAUDE_CONFIG_DIR!, 'projects');
      return fs.existsSync(dir) ? fs.readdirSync(dir).flatMap((d) => fs.readdirSync(path.join(dir, d))).sort() : [];
    };
    const tBefore = transcripts();
    r.line(`/chat load ${file}`);
    await pressWhileHookHangs(r, hook, new RegExp(`Import from ${file.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} was cancelled\\.`));
    assert.deepEqual(records(e), before, 'no imported record left');
    assert.deepEqual(transcripts(), tBefore, 'no re-keyed transcript left');
    const m2 = r.o().length;
    r.line('main again');
    await r.waitFor(/ANSWER history=\[[\s\S]*?\] END[\s\S]*> $/, 15_000, m2);
    assert.match(r.o().slice(m2), /ANSWER history=\[first main \| main again\] END/);
    r.line('/quit');
    assert.equal(await r.exit, 0);
  } finally {
    hook.kill();
    r.end();
    await r.exit.catch(() => undefined);
    e.cleanup();
  }
});

// ───── K1 through the REPL: the continuation a /spec flow hands to the chat carries main's turns ─────

const SPEC_SCRIPT = {
  turns: [{ repeat: true, match: 'Phase: REQUIREMENTS', steps: [{ text: 'DRAFTED' }] }],
  default: { steps: [{ text: 'ANSWER history=[{{historyUserTexts}}] END' }] },
};

for (const cmd of ['/tangent', '/rewind 1'] as const) {
  test(`K1: ${cmd} straight after a /spec flow works in the continuation and reaches main's turns`, { timeout: 60_000 }, async () => {
    const e = sandbox();
    e.fullEnv.FAKE_CLAUDE_SCRIPT_JSON = JSON.stringify(SPEC_SCRIPT);
    const r = live(e);
    try {
      await r.waitFor(/> $/);
      r.line('remember CODEWORD_1');
      await r.waitFor(/ANSWER history=\[remember CODEWORD_1\] END[\s\S]*> $/);
      r.line('second SECOND_2');
      await r.waitFor(/ANSWER history=\[remember CODEWORD_1 \| second SECOND_2\] END[\s\S]*> $/);
      let mark = r.o().length;
      r.line('/spec new first-spec --type feature --workflow requirements-first a csv export');
      await r.waitFor(/Stop here/, 20_000, mark);
      r.line('Stop');
      await r.waitFor(/Stopped at the requirements\.md checkpoint[\s\S]*> $/, 20_000, mark);
      mark = r.o().length;
      r.line(cmd);
      await r.waitFor(cmd === '/tangent' ? /Created a conversation checkpoint[\s\S]*↯ > $/ : /Rewound the conversation to turn 1\.[\s\S]*> $/, 10_000, mark);
      assert.doesNotMatch(r.o().slice(mark), /Can't branch an empty chat|Nothing to rewind/);
      mark = r.o().length;
      r.line('which code word?');
      await r.waitFor(/ANSWER history=\[[\s\S]*?\] END[\s\S]*> $/, 15_000, mark);
      const h = /ANSWER history=\[([\s\S]*?)\] END/.exec(r.o().slice(mark))![1]!;
      assert.match(h, /^remember CODEWORD_1/, `main's history is lost: ${h.slice(0, 300)}`);
      if (cmd === '/rewind 1') assert.doesNotMatch(h, /SECOND_2/, 'turn 2 was rewound away');
      else assert.match(h, /SECOND_2/);
      r.line('/quit');
      assert.equal(await r.exit, 0);
    } finally {
      r.end();
      await r.exit.catch(() => undefined);
      e.cleanup();
    }
  });
}

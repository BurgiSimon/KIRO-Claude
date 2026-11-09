/**
 * r12h verifier (repl group): `/chat resume` around the record it picks, end to end.
 *
 *  - The picker race and permissions: while the picker is open, a chat in another terminal reopens
 *    the listed record, swaps it to a more restrictive agent, puts it in plan mode, turns trust-all
 *    on and trusts tools for that agent, saves and closes. The resumed session runs the record's
 *    agent and plan mode as read under the lock (the record wins where `chat --resume-id` lets it,
 *    and plan mode is the more restrictive of the record and the chat), and never anything wider:
 *    the saved trust-all is not honoured and the per-tool trust is the chat's (r7 #0: the chat's
 *    trust replaces the record's, mapped to the record's agent), not the holder's.
 *  - What a tangent holds: a rewind record under a tangent is open in this chat (the tangent
 *    returns there) and not offered; the conversation the rewind left (released, not held) still is,
 *    and resuming it from inside the tangent loses no turn of either record.
 *
 * The real runRepl over a live stdin (line mode) and test/fixtures/fake-claude.mjs, in this
 * process; a holder in another terminal is its saved record (written while no lock is held).
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
import type { CliContext, SessionRecord } from '../../src/types.js';
import { stripAnsi } from '../../src/util/ansi.js';
import { fakeClaudePath, fakeEnv } from '../claude/helpers.js';
import { removeOnExit } from '../tmpdirs.js';
import { tempEnv } from './harness.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const SCRIPT = { default: { steps: [{ text: 'ANSWER history=[{{historyUserTexts}}] END' }] } };

type Env = ReturnType<typeof tempEnv> & { sessionsDir: string; fullEnv: NodeJS.ProcessEnv };

function sandbox(): Env {
  const t = tempEnv();
  removeOnExit(t.root);
  const run = path.join(t.root, 'run');
  fs.mkdirSync(run, { recursive: true, mode: 0o700 });
  const kiroHome = path.join(t.home, '.kiro');
  fs.mkdirSync(path.join(kiroHome, 'agents'), { recursive: true });
  for (const a of ['bee', 'wasp']) {
    fs.writeFileSync(path.join(kiroHome, 'agents', `${a}.json`), JSON.stringify({ name: a, description: a, prompt: `you are ${a}`, tools: ['*'] }));
  }
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
  return Object.assign(t, { sessionsDir: t.env.KIRO_CLAUDE_SESSIONS_DIR!, fullEnv });
}

/** The real runRepl over a live stdin (line mode) and the fake claude. */
function live(e: Env, sessionOptions: Record<string, unknown> = {}) {
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
  const exit = runRepl({ ctx, sessionOptions: { env: e.fullEnv, claudePath: fakeClaudePath(), ...sessionOptions } });
  const o = (): string => stripAnsi(out);
  return {
    o,
    exit,
    line: (s: string) => stdin.write(`${s}\n`),
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

const store = (e: Env): SessionStore => new SessionStore(e.sessionsDir);
function read(e: Env, id: string): SessionRecord {
  const r = store(e).read(id);
  assert.ok(r, `record ${id} exists`);
  return r;
}
const previews = (r: SessionRecord): string[] => r.turns.map((t) => t.preview);

test('r12h verify: /chat resume after another chat saved a restrictive agent, plan mode, trust-all and per-tool trust while the picker was open: agent and plan mode win, nothing wider', { timeout: 120_000 }, async () => {
  const e = sandbox();
  // an older conversation of agent bee, out of plan mode
  const first = live(e, { agentName: 'bee' });
  try {
    await first.waitFor(/> $/);
    first.line('older line');
    await first.waitFor(/ANSWER history=\[older line\] END[\s\S]*> $/);
    first.line('/quit');
    assert.equal(await first.exit, 0);
  } finally {
    first.end();
    await first.exit.catch(() => undefined);
  }
  const id = store(e).list({ cwd: e.wsDir })[0]!.sessionId;
  assert.equal(read(e, id).planMode, false, 'precondition');
  // the chat: default agent, no plan mode, no trust
  const r = live(e);
  try {
    await r.waitFor(/> $/);
    r.line('hello');
    await r.waitFor(/ANSWER history=\[hello\] END[\s\S]*> $/);
    const mark = r.o().length;
    r.line('/chat resume');
    await r.waitFor(new RegExp(`Select a session to resume[\\s\\S]*${id}[\\s\\S]*> $`), 10_000, mark);
    // a chat in another terminal reopens the record: agent wasp, plan mode, trust-all, trusts tools
    assert.ok(!fs.existsSync(path.join(e.sessionsDir, `${id}.lock`)), 'precondition: the record is not held');
    const rec = read(e, id);
    rec.agent = 'wasp';
    rec.planMode = true;
    rec.trust = { trustAll: true, allowedTools: ['execute_bash', 'fs_write'], rules: [] };
    store(e).write(rec);
    r.line('1');
    await r.waitFor(/Picking up where we left off[\s\S]*> $/, 20_000, mark);
    const resumed = r.o().length;
    // the record is saved once its Claude Code is up: what the session runs
    const now = read(e, id);
    assert.equal(now.agent, 'wasp', 'the agent the other chat swapped to');
    assert.equal(now.planMode, true, 'the plan mode the other chat turned on');
    assert.equal(now.trust.trustAll, false, 'a saved trust-all was honoured');
    assert.deepEqual(now.trust.allowedTools, [], 'the other chat\'s per-tool trust replaced the chat\'s');
    r.line('again');
    // a plan-mode turn: the plan block goes with it, and the plan is offered for execution
    await r.waitFor(/ANSWER history=\[older line \| <kiro-plan-mode>[\s\S]*again[^\]]*\] END[\s\S]*Execute this plan\? \[y\/n\][\s\S]*> $/, 20_000, resumed);
    const asked = r.o().length;
    r.line('n');
    await r.waitFor(/\[plan\] > $/, 20_000, asked);
    r.line('/quit');
    assert.equal(await r.exit, 0);
  } finally {
    r.end();
    await r.exit.catch(() => undefined);
  }
  const after = read(e, id);
  assert.equal(after.agent, 'wasp');
  assert.equal(after.planMode, true);
  assert.equal(after.trust.trustAll, false);
  assert.deepEqual(after.trust.allowedTools, []);
  assert.deepEqual(previews(after), ['older line', 'again']);
});

test('r12h verify: inside a tangent of a rewind, /chat resume does not offer the rewind (held) but offers the conversation the rewind left; no turn of either is lost', { timeout: 120_000 }, async () => {
  const e = sandbox();
  const r = live(e);
  let original = '';
  let rewound = '';
  try {
    await r.waitFor(/> $/);
    r.line('one');
    await r.waitFor(/ANSWER history=\[one\] END[\s\S]*> $/);
    r.line('two');
    await r.waitFor(/ANSWER history=\[one \| two\] END[\s\S]*> $/);
    original = store(e).list({ cwd: e.wsDir })[0]!.sessionId;
    let mark = r.o().length;
    r.line('/rewind 1');
    await r.waitFor(/Rewound the conversation to turn 1\.[\s\S]*> $/, 30_000, mark);
    rewound = store(e).list({ cwd: e.wsDir }).find((s) => s.forkKind === 'rewind')!.sessionId;
    mark = r.o().length;
    r.line('rewound line');
    await r.waitFor(/ANSWER history=\[one \| rewound line\] END[\s\S]*> $/, 20_000, mark);
    mark = r.o().length;
    r.line('/tangent');
    await r.waitFor(/↯ > $/, 20_000, mark);
    mark = r.o().length;
    r.line('/chat resume');
    await r.waitFor(/Select a session to resume[\s\S]*> $/, 10_000, mark);
    const shown = r.o().slice(mark);
    assert.match(shown, new RegExp(`Not listed: ${rewound}, open in this chat under the tangent`), shown);
    assert.ok(!new RegExp(`\\d+\\. [^\\n]*${rewound}`).test(shown), `the rewind the tangent holds is offered:\n${shown}`);
    assert.match(shown, new RegExp(`1\\. [^\\n]*${original}`), `the conversation the rewind left (not held) is not offered:\n${shown}`);
    r.line('1');
    await r.waitFor(/Picking up where we left off[\s\S]*> $/, 20_000, mark);
    mark = r.o().length;
    r.line('back in the original');
    await r.waitFor(/ANSWER history=\[one \| two \| back in the original\] END[\s\S]*> $/, 20_000, mark);
    r.line('/quit');
    assert.equal(await r.exit, 0);
  } finally {
    r.end();
    await r.exit.catch(() => undefined);
  }
  assert.deepEqual(previews(read(e, original)), ['one', 'two', 'back in the original']);
  assert.deepEqual(previews(read(e, rewound)), ['one', 'rewound line']);
});

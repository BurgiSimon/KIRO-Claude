/**
 * r12h H1 (repl group): the REPL's `/chat resume` and its forced-stop restart reopen a saved
 * record with the agent, model and effort that record has once its lock is taken, as `kiro-claude
 * chat --resume-id <id>` does, not with the ones read before.
 *
 * `/chat resume` passed `agentName`, `model` and `effort` from the list it read before the user
 * picked (the picker can stay open for any time), and the restart after a forced stop passed the
 * stopped session's own (the next input can come any time later), as explicit options, which the
 * record read again under the lock (KiroSessionImpl.build, r12g S1) never overrides. A chat in
 * another terminal that swapped agent, model or effort meanwhile and closed had that undone, its
 * swap to a more restrictive agent included: the reopened session ran the old ones and saved them
 * over the holder's. Now they are only defaults (KiroSessionInternalOptions.resumeDefaults): the
 * record wins, and the chat's effort still applies to a record that has none (chat.ts module doc).
 * Trust and plan mode keep the r7 #0 rules (the chat's trust, mapped to the record's agent; plan
 * mode when the chat or the record is in it): test/repl/r7f-repl-trust*.
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
import { fakeClaudePath, fakeEnv, readJsonl } from '../claude/helpers.js';
import { removeOnExit } from '../tmpdirs.js';
import { tempEnv } from './harness.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const SCRIPT = {
  turns: [{ repeat: true, match: 'slow thing', steps: [{ text: 'working' }, { sleepMs: 100_000 }] }],
  default: { steps: [{ text: 'ANSWER model={{model}} effort={{effort}} END' }] },
};

type Env = ReturnType<typeof tempEnv> & { sessionsDir: string; logFile: string; fullEnv: NodeJS.ProcessEnv };

function sandbox(extra: Record<string, string> = {}): Env {
  const t = tempEnv();
  removeOnExit(t.root);
  const run = path.join(t.root, 'run');
  fs.mkdirSync(run, { recursive: true, mode: 0o700 });
  const kiroHome = path.join(t.home, '.kiro');
  for (const a of ['bee', 'wasp']) {
    fs.mkdirSync(path.join(kiroHome, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(kiroHome, 'agents', `${a}.json`), JSON.stringify({ name: a, description: a, prompt: `you are ${a}`, tools: ['*'] }));
  }
  const logFile = path.join(t.root, 'fake.log');
  const fullEnv = fakeEnv({
    ...t.env,
    KIRO_HOME: kiroHome,
    XDG_RUNTIME_DIR: run,
    XDG_CACHE_HOME: path.join(t.root, 'cache'),
    FAKE_CLAUDE_SCRIPT_JSON: JSON.stringify(SCRIPT),
    FAKE_CLAUDE_LOG: logFile,
    FAKE_CLAUDE_PERSIST: '1',
    KIRO_CLAUDE_BIN: fakeClaudePath(),
    ...extra,
  });
  return Object.assign(t, { sessionsDir: t.env.KIRO_CLAUDE_SESSIONS_DIR!, logFile, fullEnv });
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

const store = (e: Env): SessionStore => new SessionStore(e.sessionsDir);
function read(e: Env, id: string): SessionRecord {
  const r = store(e).read(id);
  assert.ok(r, `record ${id} exists`);
  return r;
}
/** A holder in another terminal saved `f`'s change at its close (no lock is held now). */
function holderSaved(e: Env, id: string, f: (r: SessionRecord) => void): void {
  assert.ok(!fs.existsSync(path.join(e.sessionsDir, `${id}.lock`)), `${id} is not held`);
  const r = read(e, id);
  f(r);
  store(e).write(r);
}
/** --model / --effort of the last Claude Code started. */
function lastStart(e: Env): { model: string | undefined; effort: string | undefined } {
  const argv = readJsonl(e.logFile).filter((x) => x.event === 'start' && (x.argv as string[]).includes('--input-format')).at(-1)!.argv as string[];
  const flag = (f: string): string | undefined => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
  return { model: flag('--model'), effort: flag('--effort') };
}

/** A conversation of agent bee on sonnet, no effort, one turn; its id. */
async function olderChat(e: Env): Promise<string> {
  const r = live(e, { agentName: 'bee', model: 'claude-sonnet-4.5' });
  try {
    await r.waitFor(/> $/);
    r.line('first');
    await r.waitFor(/ANSWER model=claude-sonnet\S* effort=\S+ END[\s\S]*> $/);
    r.line('/quit');
    assert.equal(await r.exit, 0);
  } finally {
    r.end();
    await r.exit.catch(() => undefined);
  }
  const recs = store(e).list({ cwd: e.wsDir });
  assert.equal(recs.length, 1, 'precondition: one saved chat');
  assert.equal(recs[0]!.agent, 'bee');
  assert.equal(recs[0]!.effort, undefined, 'precondition: the older chat has no effort');
  return recs[0]!.sessionId;
}

test('r12h H1: /chat resume runs the agent, model and effort the picked record has when its lock is taken, not the ones its list showed', { timeout: 90_000 }, async () => {
  const e = sandbox();
  const id = await olderChat(e);
  // the chat: the default agent at effort high (launch --effort high)
  const r = live(e, { effort: 'high' });
  try {
    await r.waitFor(/> $/);
    r.line('hello');
    await r.waitFor(/ANSWER model=\S+ effort=high END[\s\S]*> $/);
    const mark = r.o().length;
    r.line('/chat resume');
    await r.waitFor(new RegExp(`Select a session to resume[\\s\\S]*${id}`), 10_000, mark);
    // while the picker is open, a chat in another terminal reopens that record, swaps to a more
    // restrictive agent, another model and effort low, and closes
    await sleep(200);
    holderSaved(e, id, (rec) => {
      rec.agent = 'wasp';
      rec.model = 'claude-opus-4.7';
      rec.effort = 'low';
    });
    r.line('1');
    await r.waitFor(/Picking up where we left off[\s\S]*> $/, 20_000, mark);
    const resumed = r.o().length;
    r.line('again');
    await r.waitFor(/ANSWER [^\n]*END[\s\S]*> $/, 20_000, resumed);
    const after = r.o().slice(resumed);
    assert.match(after, /\[wasp\] >/, `the resumed chat does not run the holder's agent:\n${after}`);
    assert.match(after, /ANSWER model=claude-opus-4-7 effort=low END/, after);
    assert.match(lastStart(e).model ?? '', /opus-4-7/);
    assert.equal(lastStart(e).effort, 'low');
    r.line('/quit');
    assert.equal(await r.exit, 0);
  } finally {
    r.end();
    await r.exit.catch(() => undefined);
  }
  const rec = read(e, id);
  assert.equal(rec.agent, 'wasp', 'the reopened chat saved the agent of the list over the holder\'s');
  assert.equal(rec.model, 'claude-opus-4.7');
  assert.equal(rec.effort, 'low');
  assert.deepEqual(rec.turns.map((t) => t.preview), ['first', 'again']);
});

test('r12h H1 (control, kept rule): a picked record with no effort runs at the chat\'s effort; its own agent and model, not the launch --model', { timeout: 90_000 }, async () => {
  const e = sandbox();
  const id = await olderChat(e);
  const r = live(e, { effort: 'high', model: 'claude-opus-4.7' });
  try {
    await r.waitFor(/> $/);
    r.line('hello');
    await r.waitFor(/ANSWER model=claude-opus-4-7 effort=high END[\s\S]*> $/);
    const mark = r.o().length;
    r.line('/chat resume');
    await r.waitFor(new RegExp(id), 10_000, mark);
    r.line('1');
    await r.waitFor(/Picking up where we left off[\s\S]*> $/, 20_000, mark);
    const resumed = r.o().length;
    r.line('again');
    await r.waitFor(/ANSWER [^\n]*END[\s\S]*> $/, 20_000, resumed);
    const after = r.o().slice(resumed);
    assert.match(after, /\[bee\] >/, after);
    assert.match(after, /ANSWER model=claude-sonnet\S* effort=high END/, after);
    r.line('/quit');
    assert.equal(await r.exit, 0);
  } finally {
    r.end();
    await r.exit.catch(() => undefined);
  }
  const rec = read(e, id);
  assert.equal(rec.agent, 'bee');
  assert.equal(rec.model, 'claude-sonnet-4.5');
  assert.equal(rec.effort, 'high');
});

test('r12h H1: the restart after a forced stop runs the agent and effort the record has by then (a chat in another terminal changed them), not the stopped session\'s', { timeout: 90_000 }, async () => {
  // the interrupt is never answered: the second Ctrl+C stops Claude Code (forced stop)
  const e = sandbox({ FAKE_CLAUDE_CONTROL_DELAYS: JSON.stringify({ interrupt: 120_000 }) });
  const r = live(e, { agentName: 'bee' });
  let id = '';
  try {
    await r.waitFor(/> $/);
    r.line('hello');
    await r.waitFor(/ANSWER [^\n]*END[\s\S]*\[bee\] > $/);
    id = store(e).list({ cwd: e.wsDir })[0]!.sessionId;
    r.line('run the slow thing');
    await r.waitFor(/working/);
    await sleep(300);
    r.ctrlC();
    await sleep(300);
    r.ctrlC();
    await r.waitFor(/did not stop after the interrupt; stopping it\.[\s\S]*> $/, 30_000);
    // the stopped session's close has saved the record and released the lock
    const t0 = Date.now();
    while (fs.existsSync(path.join(e.sessionsDir, `${id}.lock`))) {
      if (Date.now() - t0 > 20_000) throw new Error('the stopped session never released its lock');
      await sleep(25);
    }
    // meanwhile `chat --resume-id <id>` in another terminal swapped to wasp at effort low and quit
    holderSaved(e, id, (rec) => {
      rec.agent = 'wasp';
      rec.effort = 'low';
    });
    const mark = r.o().length;
    r.line('next');
    await r.waitFor(/ANSWER [^\n]*END[\s\S]*> $/, 30_000, mark);
    const after = r.o().slice(mark);
    assert.match(after, /\[wasp\] >/, `the restart undid the other chat's agent swap:\n${after}`);
    assert.match(after, /effort=low END/, after);
    r.line('/quit');
    assert.equal(await r.exit, 0);
  } finally {
    r.end();
    await r.exit.catch(() => undefined);
  }
  const rec = read(e, id);
  assert.equal(rec.agent, 'wasp');
  assert.equal(rec.effort, 'low');
  assert.ok(rec.turns.some((t) => t.preview === 'next'), JSON.stringify(rec.turns.map((t) => t.preview)));
});

test('r12h H1: the restart after a forced stop keeps the stopped chat\'s plan mode though the record was taken out of it meanwhile (the more restrictive, as /chat resume)', { timeout: 90_000 }, async () => {
  const e = sandbox({ FAKE_CLAUDE_CONTROL_DELAYS: JSON.stringify({ interrupt: 120_000 }) });
  const r = live(e);
  let id = '';
  try {
    await r.waitFor(/> $/);
    r.line('hello');
    await r.waitFor(/ANSWER [^\n]*END[\s\S]*> $/);
    id = store(e).list({ cwd: e.wsDir })[0]!.sessionId;
    let mark = r.o().length;
    r.line('/plan');
    await r.waitFor(/\[plan\] > $/, 10_000, mark);
    r.line('run the slow thing');
    await r.waitFor(/working/, 20_000, mark);
    await sleep(300);
    r.ctrlC();
    await sleep(300);
    r.ctrlC();
    await r.waitFor(/did not stop after the interrupt; stopping it\.[\s\S]*> $/, 30_000, mark);
    const t0 = Date.now();
    while (fs.existsSync(path.join(e.sessionsDir, `${id}.lock`))) {
      if (Date.now() - t0 > 20_000) throw new Error('the stopped session never released its lock');
      await sleep(25);
    }
    assert.equal(read(e, id).planMode, true, 'precondition: the stopped chat saved its plan mode');
    holderSaved(e, id, (rec) => {
      rec.planMode = false;
    });
    mark = r.o().length;
    r.line('next');
    await r.waitFor(/ANSWER [^\n]*END[\s\S]*> $/, 30_000, mark);
    assert.match(r.o().slice(mark), /\[plan\] > $/, r.o().slice(mark));
    r.line('/quit');
    assert.equal(await r.exit, 0);
  } finally {
    r.end();
    await r.exit.catch(() => undefined);
  }
  assert.equal(read(e, id).planMode, true, 'the restarted chat left plan mode');
});

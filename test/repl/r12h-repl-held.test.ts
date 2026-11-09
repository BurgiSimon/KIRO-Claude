/**
 * r12h H2 (repl group): two writers of one record in one process. When this chat still holds a
 * record open, no other session of it may open that record: the new session would replace this
 * process's own lock (store.ts replaces a lock naming our pid in one step) and the older session's
 * close would later write its in-memory copy over the new session's record.
 *
 *  - Inside a tangent the chat holds its main conversation (and the outer tangents) open in the
 *    tangent stack: `/chat resume` no longer lists them, says /tangent returns there, and refuses
 *    one it is asked for. (Q has a single conversation per chat process: its tangent is an
 *    in-memory checkpoint of it and `/chat load` replaces the whole of it, persist.rs Load, so the
 *    case cannot arise there; kiro-claude keeps the main conversation as a record of its own.)
 *  - A forced stop (second Ctrl+C) waits FORCE_CLOSE_TIMEOUT_MS (10 s) at most for the session's
 *    close; a slower close (a SessionEnd hook at its 5 s cap plus a Claude Code that ignores
 *    SIGTERM, 4.5 s, on a loaded machine) went on while the next input's restart reopened the same
 *    record, and its late save overwrote what the restarted session had saved: the turn typed after
 *    the restart was lost from the record. The restart now waits for that close (saying so; Ctrl+C
 *    cancels the restart, which the next input tries again), and so does every reopen of a saved
 *    record by id (ReplContext.createSession with `resume`).
 *
 * The tangent case: the real runRepl over a live stdin (line mode) and
 * test/fixtures/fake-claude.mjs, in this process. The slow close: MockSession doubles (a real close
 * cannot be held past the 10 s bound on demand).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';

import { openSettings } from '../../src/config/settings.js';
import { createWorkspaceContext } from '../../src/config/workspace.js';
import { runRepl } from '../../src/repl/repl.js';
import { SessionStore, sessionsDir } from '../../src/session/store.js';
import type { CliContext, SessionRecord } from '../../src/types.js';
import { stripAnsi } from '../../src/util/ansi.js';
import { fakeClaudePath, fakeEnv } from '../claude/helpers.js';
import { removeOnExit } from '../tmpdirs.js';
import { startRepl, tempEnv } from './harness.js';
import { MockSession } from './mockSession.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const SCRIPT = { default: { steps: [{ text: 'ANSWER history=[{{historyUserTexts}}] END' }] } };

type Env = ReturnType<typeof tempEnv> & { sessionsDir: string; logFile: string; fullEnv: NodeJS.ProcessEnv };

function sandbox(extra: Record<string, string> = {}): Env {
  const t = tempEnv();
  removeOnExit(t.root);
  const run = path.join(t.root, 'run');
  fs.mkdirSync(run, { recursive: true, mode: 0o700 });
  const logFile = path.join(t.root, 'fake.log');
  const fullEnv = fakeEnv({
    ...t.env,
    KIRO_HOME: path.join(t.home, '.kiro'),
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
  const exit = runRepl({ ctx, sessionOptions: { env: e.fullEnv, claudePath: fakeClaudePath() } });
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
const previews = (r: SessionRecord | undefined): string[] => (r?.turns ?? []).map((t) => t.preview);

test('r12h H2: inside a tangent, /chat resume does not offer the main conversation the tangent stack holds open (/tangent returns there)', { timeout: 90_000 }, async () => {
  const e = sandbox();
  const other = store(e).create({ origin: 'repl', cwd: e.wsDir, agent: 'kiro_default', model: 'auto', title: 'another chat' });
  const r = live(e);
  try {
    await r.waitFor(/> $/);
    r.line('remember ALPHA');
    await r.waitFor(/ANSWER history=\[remember ALPHA\] END[\s\S]*> $/);
    const main = store(e).list({ cwd: e.wsDir }).find((s) => s.sessionId !== other.sessionId)!.sessionId;
    let mark = r.o().length;
    r.line('/tangent');
    await r.waitFor(/↯ > $/, 20_000, mark);
    r.line('tangent q');
    await r.waitFor(/END[\s\S]*↯ > $/, 20_000, mark);
    mark = r.o().length;
    r.line('/chat resume');
    await r.waitFor(/Select a session to resume[\s\S]*> $/, 10_000, mark);
    let shown = r.o().slice(mark);
    assert.ok(shown.includes(other.sessionId), shown);
    assert.ok(!/\d+\. [^\n]*remember ALPHA/.test(shown), `the main conversation the tangent holds is offered:\n${shown}`);
    assert.match(shown, new RegExp(`Not listed: ${main}, open in this chat under the tangent \\(/tangent returns there\\)`), shown);
    // Enter: nothing picked
    r.line('');
    await r.waitFor(/↯ > $/, 10_000, mark + shown.length);
    // nested: the main conversation still is not offered, nor any tangent
    mark = r.o().length;
    r.line('/tangent deeper');
    await r.waitFor(/↯ > $/, 20_000, mark);
    mark = r.o().length;
    r.line('/chat resume');
    await r.waitFor(/Select a session to resume[\s\S]*> $/, 10_000, mark);
    shown = r.o().slice(mark);
    assert.ok(!/\d+\. [^\n]*(remember ALPHA|tangent q)/.test(shown), shown);
    assert.match(shown, new RegExp(`Not listed: ${main}`), shown);
    r.line('');
    await r.waitFor(/↯ > $/, 10_000, mark + shown.length);
    // with nothing else to offer
    store(e).delete(other.sessionId);
    mark = r.o().length;
    r.line('/chat resume');
    await r.waitFor(/No saved chat sessions for this directory\.[\s\S]*↯ > $/, 10_000, mark);
    assert.match(r.o().slice(mark), new RegExp(`Not listed: ${main}`));
    mark = r.o().length;
    r.line('/tangent root');
    await r.waitFor(/Returned to the root conversation[\s\S]*> $/, 20_000, mark);
    mark = r.o().length;
    r.line('back in main');
    await r.waitFor(/ANSWER history=\[remember ALPHA \| back in main\] END[\s\S]*> $/, 20_000, mark);
    r.line('/quit');
    assert.equal(await r.exit, 0);
  } finally {
    r.end();
    await r.exit.catch(() => undefined);
  }
  const recs = store(e).list({ cwd: e.wsDir }).filter((s) => s.forkKind !== 'tangent');
  assert.equal(recs.length, 1);
  assert.deepEqual(previews(recs[0]), ['remember ALPHA', 'back in main']);
});

/**
 * A session whose close takes until the test opens it (as a close slower than the forced stop's
 * FORCE_CLOSE_TIMEOUT_MS: a SessionEnd hook at its cap plus a Claude Code that ignores SIGTERM, on
 * a loaded machine); at its end it saves its in-memory record, as KiroSessionImpl's close does.
 * Its turn hangs until its close begins (the close aborts it), so a second Ctrl+C stops it.
 */
class SlowClose extends MockSession {
  closeStarted = false;
  private open!: () => void;
  private readonly gate = new Promise<void>((r) => (this.open = r));
  saveTo: SessionStore | undefined;
  finishClose(): void {
    this.open();
  }
  override async close(): Promise<void> {
    this.closeStarted = true;
    await this.gate;
    this.saveTo?.write(this.record);
    await super.close();
  }
}

async function until(cond: () => boolean, ms = 30_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await sleep(10);
  }
}

/** A chat whose turn never stops at the interrupt; the record on disk holds one earlier turn. */
function stuckChat(nextTurn: (store: SessionStore) => MockSession): { run: ReturnType<typeof startRepl>; s: SlowClose; store: SessionStore } {
  let run!: ReturnType<typeof startRepl>;
  const s = new SlowClose().script({
    steps: [
      { type: 'text_delta', text: 'working...' },
      { run: () => run.send('\u0003') },
      {
        run: async ({ session }) => {
          await until(() => session.interrupted > 0);
          run.send('\u0003');
          await until(() => (session as SlowClose).closeStarted);
        },
      },
    ],
    result: { stopReason: 'cancelled' },
    noRecord: true,
  });
  let store!: SessionStore;
  run = startRepl({ session: s, input: ['long task'], keepOpen: true, nextSession: () => nextTurn(store) });
  removeOnExit(run.t.root);
  store = new SessionStore(sessionsDir(run.ws));
  s.record.turns = [{ userUuid: 'u0', assistantUuid: 'a0', preview: 'earlier', at: new Date().toISOString() }];
  s.record.messageCount = 1;
  store.write(s.record);
  s.saveTo = store;
  return { run, s, store };
}

/** The next session: answers `answer` and saves its record with that turn (as a session does). */
function answering(id: string, answer: string): (store: SessionStore) => MockSession {
  return (store) => {
    const next = new MockSession({ id });
    next.script({
      steps: [
        {
          run: () => {
            const rec = store.read(id)!;
            rec.turns.push({ userUuid: 'u1', assistantUuid: 'a1', preview: answer, at: new Date().toISOString() });
            rec.messageCount += 1;
            store.write(rec);
          },
        },
      ],
      result: { text: `${answer} answered` },
      noRecord: true,
    });
    return next;
  };
}

const WAITING = 'The stopped session is still closing; Claude Code restarts once it has closed (Ctrl+C cancels).';

test('r12h H2: the restart after a forced stop waits for a close still running past the stop\'s bound before it reopens the record; no turn is lost', { timeout: 60_000 }, async () => {
  let id = '';
  const { run, s, store } = stuckChat((st) => answering(id, 'next')(st));
  id = s.id;
  try {
    await run.waitFor(/stopping it\.\n[\s\S]*> $/, 30_000);
    run.send('next');
    // the stop's wait for the close gives up after FORCE_CLOSE_TIMEOUT_MS (10 s)
    await run.waitFor(new RegExp(`${WAITING.replace(/[.()+]/g, '\\$&')}|next answered`), 30_000);
    const reopenedEarly = run.sessions.length > 1;
    s.finishClose();
    await run.waitFor('next answered', 10_000);
    run.send('/quit');
    assert.equal(await run.exit, 0);
    await until(() => s.closed);
    const turns = (store.read(id)?.turns ?? []).map((t) => t.preview);
    assert.deepEqual(turns, ['earlier', 'next'], 'the stopped session\'s late close saved its record over the turn typed after the restart');
    assert.equal(reopenedEarly, false, 'the record was reopened while the stopped session was still closing');
    assert.ok(run.out().includes(WAITING), run.out());
    assert.deepEqual(run.created[1]?.resume, { sessionId: id });
  } finally {
    s.finishClose();
    run.end();
    await run.exit.catch(() => undefined);
    run.t.cleanup();
  }
});

test('r12h H2: Ctrl+C while the restart waits for the stopped session\'s close cancels that input; the next input restarts once it has closed', { timeout: 60_000 }, async () => {
  let id = '';
  const { run, s, store } = stuckChat((st) => answering(id, 'again')(st));
  id = s.id;
  try {
    await run.waitFor(/stopping it\.\n[\s\S]*> $/, 30_000);
    run.send('next');
    await run.waitFor(WAITING, 30_000);
    const mark = run.out().length;
    run.send('\u0003');
    await until(() => /Restart cancelled \(Ctrl\+C\)\. Claude Code restarts with your next input\.[\s\S]*> $/.test(run.out().slice(mark)), 5000);
    assert.equal(run.sessions.length, 1, 'nothing was restarted');
    s.finishClose();
    await until(() => s.closed);
    run.send('again');
    await run.waitFor('again answered', 10_000);
    assert.deepEqual(run.sessions[1]!.prompts.map((p) => p.text), ['again'], 'the cancelled input never reached Claude');
    run.send('/quit');
    assert.equal(await run.exit, 0);
    assert.deepEqual((store.read(id)?.turns ?? []).map((t) => t.preview), ['earlier', 'again']);
  } finally {
    s.finishClose();
    run.end();
    await run.exit.catch(() => undefined);
    run.t.cleanup();
  }
});

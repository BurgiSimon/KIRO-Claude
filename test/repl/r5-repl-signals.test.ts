/**
 * Round-5 "repl-signals", REPL side over MockSession (test/repl/harness.ts):
 *  - P1: ReplContext.nextPressSignal(): the NEXT Ctrl+C after the call aborts it (not a press the
 *    command signal already handled); it stays aborted; it never stops the idle session (F0).
 *  - P2: the restart after a forced stop runs under a start signal: a Ctrl+C while the restarted
 *    session runs its agentSpawn hooks cancels the restart; the REPL stays usable (the next input
 *    restarts Claude Code again) and says what happened.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { currentStartSignal, SessionStartCancelledError } from '../../src/session/startSignal.js';
import type { ReplHost, SlashCommand } from '../../src/types.js';
import { startRepl } from './harness.js';
import { MockSession } from './mockSession.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const CTRL_C = '\u0003';

function aborted(sig: AbortSignal | undefined, ms: number): Promise<boolean> {
  if (!sig) return Promise.resolve(false);
  if (sig.aborted) return Promise.resolve(true);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    sig.addEventListener('abort', () => {
      clearTimeout(t);
      resolve(true);
    });
  });
}

test('r5 P1: nextPressSignal() is aborted by the next Ctrl+C after the call, not by the one the command signal handled; the idle session is never stopped (F0)', { timeout: 20_000 }, async () => {
  const log: string[] = [];
  let next: AbortSignal | undefined;
  const cmd: SlashCommand = {
    name: 'waitpress',
    summary: 'test',
    async run(_a, _r, host: ReplHost) {
      const cmdSig = (host as { commandSignal?: AbortSignal }).commandSignal;
      host.print('FIRST-WAIT');
      log.push(`first:${await aborted(cmdSig, 5000)}`);
      const make = (host as { nextPressSignal?: () => AbortSignal }).nextPressSignal;
      if (!make) {
        host.print('NO-NEXT-PRESS-SIGNAL');
        return;
      }
      next = make.call(host);
      log.push(`fresh:${next.aborted}`);
      host.print('SECOND-WAIT');
      log.push(`second:${await aborted(next, 5000)}`);
      await sleep(1300); // longer than the forced stop's grace: an idle session must stay open
      log.push(`stays:${next.aborted}`);
      host.print('CMD-DONE');
    },
  };
  const session = new MockSession();
  const run = startRepl({ session, keepOpen: true, extraCommands: [cmd] });
  try {
    await run.waitFor('> ');
    run.send('/waitpress');
    await run.waitFor('FIRST-WAIT');
    await sleep(50);
    run.send(CTRL_C);
    await run.waitFor(/SECOND-WAIT|NO-NEXT-PRESS-SIGNAL/);
    assert.doesNotMatch(run.out(), /NO-NEXT-PRESS-SIGNAL/, 'the REPL has no nextPressSignal()');
    await sleep(100);
    assert.equal(next?.aborted, false, 'a press before the call must not count');
    run.send(CTRL_C);
    await run.waitFor('CMD-DONE', 8000);
    assert.deepEqual(log, ['first:true', 'fresh:false', 'second:true', 'stays:true']);
    assert.equal(session.closed, false, 'the idle session was stopped');
    assert.doesNotMatch(run.out(), /did not stop after the interrupt|Failed to execute command/, run.out());
    run.send('/quit');
    run.end();
    assert.equal(await run.exit, 0);
  } finally {
    run.t.cleanup();
  }
});

test('r5 P1: a nextPressSignal() taken outside any press is aborted by the next press of the command and only once per call', { timeout: 20_000 }, async () => {
  const states: boolean[] = [];
  const cmd: SlashCommand = {
    name: 'twowaiters',
    summary: 'test',
    async run(_a, _r, host: ReplHost) {
      const make = (host as { nextPressSignal?: () => AbortSignal }).nextPressSignal;
      if (!make) {
        host.print('NO-NEXT-PRESS-SIGNAL');
        return;
      }
      const a = make.call(host);
      const b = make.call(host);
      host.print('WAITING');
      states.push(await aborted(a, 5000), await aborted(b, 5000));
      const c = make.call(host);
      states.push(c.aborted);
      host.print('CMD-DONE');
    },
  };
  const run = startRepl({ keepOpen: true, extraCommands: [cmd] });
  try {
    await run.waitFor('> ');
    run.send('/twowaiters');
    await run.waitFor(/WAITING|NO-NEXT-PRESS-SIGNAL/);
    assert.doesNotMatch(run.out(), /NO-NEXT-PRESS-SIGNAL/);
    run.send(CTRL_C);
    await run.waitFor('CMD-DONE', 8000);
    assert.deepEqual(states, [true, true, false], 'both waiters abort on the press; a signal asked for after it is fresh');
    run.send('/quit');
    run.end();
    assert.equal(await run.exit, 0);
  } finally {
    run.t.cleanup();
  }
});

/** A restarted session whose start (agentSpawn hooks) runs until its start signal cancels it. */
class SlowStart extends MockSession {
  constructor(private readonly startSignal: AbortSignal | undefined) {
    super();
  }
  override async start(): Promise<void> {
    await super.start();
    const sig = this.startSignal;
    await new Promise<void>((_resolve, reject) => {
      // without a start signal the hook never ends (timeout 0)
      sig?.addEventListener('abort', () => reject(new SessionStartCancelledError()), { once: true });
      if (sig?.aborted) reject(new SessionStartCancelledError());
    });
  }
}

test('r5 P2: Ctrl+C while the session restarted after a forced stop runs its agentSpawn hooks cancels the restart; the REPL stays usable', { timeout: 30_000 }, async () => {
  const first = new MockSession();
  // a turn Claude Code never ends, even after the interrupt: the second Ctrl+C stops it
  first.script({ steps: [{ run: () => new Promise<void>(() => undefined) }] });
  let restarts = 0;
  const restarted: MockSession[] = [];
  const run = startRepl({
    session: first,
    keepOpen: true,
    nextSession: () => {
      restarts++;
      const s = restarts === 1 ? new SlowStart(currentStartSignal()) : new MockSession();
      if (restarts > 1) s.script({ result: { text: 'AFTER-RESTART' }, steps: [{ type: 'text', text: 'AFTER-RESTART' }] });
      restarted.push(s);
      return s;
    },
  });
  try {
    await run.waitFor('> ');
    run.send('stuck turn');
    await sleep(100);
    run.send(CTRL_C);
    await sleep(100);
    run.send(CTRL_C);
    await run.waitFor(/Claude Code did not stop after the interrupt[\s\S]*> $/, 8000);
    assert.equal(first.closed, true);
    const mark = run.out().length;
    run.send('second input');
    await sleep(300);
    assert.equal(restarts, 1, 'the next input restarts Claude Code');
    run.send(CTRL_C);
    try {
      await run.waitFor(/Restart cancelled[\s\S]*> $/, 5000);
    } catch (e) {
      throw new Error(`the Ctrl+C did not cancel the restart: ${(e as Error).message}`);
    }
    const after = run.out().slice(mark);
    assert.doesNotMatch(after, /Failed to restart Claude Code/, after);
    assert.equal(restarted[0]!.prompts.length, 0, 'the cancelled input was sent');
    assert.equal(run.session, first);
    // usable: the next input restarts Claude Code again and runs
    run.send('third input');
    await run.waitFor('AFTER-RESTART', 5000);
    assert.equal(restarts, 2);
    assert.equal(restarted[1]!.prompts.length, 1);
    assert.equal(restarted[1]!.prompts[0]!.text, 'third input');
    run.send('/quit');
    run.end();
    assert.equal(await run.exit, 0, run.out());
  } finally {
    run.t.cleanup();
  }
});

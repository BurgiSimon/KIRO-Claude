/**
 * K9: a read-only command waiting on Claude Code's answer to a control request of the idle main
 * session (`/usage` get_context_usage, `/mcp` and `/tools` mcp_status, `/model` set_model, the
 * usage-indicator refresh) ends at Ctrl+C: the prompt comes back at once, the idle session is
 * neither stopped nor abandoned (F0), and the answer that comes later prints nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CANCELLED, untilCancelled } from '../../src/repl/commands/cancellable.js';
import type { McpStatusEntry, UsageReport } from '../../src/types.js';
import { startRepl } from './harness.js';
import { MockSession } from './mockSession.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll `cond` (bounded, so a regression fails instead of hanging the suite). */
async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await sleep(5);
}

interface Held {
  method: string;
  answer(): void;
  fail(e: Error): void;
}

/**
 * A session whose Claude Code answers control requests only when the test says so (`held`), like
 * a wedged or very slow Claude Code: `usage()`, `mcpStatus()` and `setModel()` wait (once `hold`
 * is on, so the REPL's own start is not held). It stays idle (`busy` false) meanwhile, as
 * KiroSessionImpl does: a pending control request is not work in flight.
 */
class SlowControlSession extends MockSession {
  hold = false;
  readonly held: Held[] = [];

  private wait<T>(method: string, value: () => T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.held.push({ method, answer: () => resolve(value()), fail: reject });
    });
  }

  override async usage(): Promise<UsageReport> {
    this.calls.push({ method: 'usage', args: [] });
    if (!this.hold) return this.usageReport;
    return this.wait('usage', () => this.usageReport);
  }

  override async mcpStatus(): Promise<McpStatusEntry[]> {
    this.calls.push({ method: 'mcpStatus', args: [] });
    if (!this.hold) return this.mcp;
    return this.wait('mcpStatus', () => this.mcp);
  }

  override async setModel(id: string): Promise<void> {
    this.calls.push({ method: 'setModel', args: [id] });
    // like KiroSessionImpl: the record takes the model before Claude Code is asked
    this.model = id;
    if (!this.hold) return;
    return this.wait('setModel', () => undefined);
  }
}

/** End a run: answer whatever is still held (a regression leaves the REPL waiting), then EOF. */
async function release(s: SlowControlSession, run: ReturnType<typeof startRepl>): Promise<void> {
  for (const h of s.held) h.answer();
  run.end();
  await Promise.race([run.exit.catch(() => undefined), sleep(5000)]);
  run.t.cleanup();
}

/** What each command's late answer would print, and what its cancellation prints. */
const CASES: { cmd: string; method: string; cancelled: RegExp; late: RegExp }[] = [
  { cmd: '/usage', method: 'usage', cancelled: /\/usage was cancelled\.\n\n> $/, late: /Current context window|Pro Tips/ },
  { cmd: '/mcp', method: 'mcpStatus', cancelled: /\/mcp was cancelled\.\n\n> $/, late: /github\s+connected|No MCP servers/ },
  { cmd: '/tools', method: 'mcpStatus', cancelled: /\/tools was cancelled\.\n\n> $/, late: /Built-in:|Permission/ },
  {
    cmd: '/model claude-haiku-4.5',
    method: 'setModel',
    cancelled: /Claude Code has not confirmed the switch to Haiku 4\.5 yet\.\n\n> $/,
    late: /Using Haiku/,
  },
];

for (const tty of [false, true]) {
  for (const k of CASES) {
    test(`repl: Ctrl+C while ${k.cmd} waits on a slow Claude Code gives the prompt back at once; the late answer prints nothing (K9, ${tty ? 'terminal' : 'line'} mode)`, { timeout: 20_000 }, async () => {
      const s = new SlowControlSession().script({ result: { text: 'NEXT-ANSWER' } });
      const run = startRepl({ session: s, tty, keepOpen: true });
      const nl = tty ? '\r' : '\n';
      try {
        await run.waitFor('> ');
        s.hold = true;
        const mark = run.out().length;
        run.stdin.write(`${k.cmd}${nl}`);
        await until(() => s.held.length === 1);
        assert.equal(s.held[0]?.method, k.method, `${k.cmd} waits on ${k.method}`);
        const pressedAt = Date.now();
        run.stdin.write(tty ? '\u0003' : '\u0003\n');
        await run.waitFor(k.cancelled, 1500).catch((e: Error) => {
          throw new Error(`Ctrl+C did not end ${k.cmd} while Claude Code had not answered: ${e.message}`);
        });
        assert.ok(Date.now() - pressedAt < 1000, `the prompt came back ${Date.now() - pressedAt} ms after the press`);
        assert.equal(s.closed, false, 'the idle session stays open');
        // Claude Code answers late: nothing of it is printed, at the prompt or later
        const atPrompt = run.out().length;
        s.held[0]!.answer();
        await sleep(100);
        assert.equal(run.out().slice(atPrompt), '', `the late answer printed:\n${run.out().slice(mark)}`);
        run.stdin.write(`next${nl}`);
        await run.waitFor(/NEXT-ANSWER[\s\S]*> $/, 5000);
        await sleep(1200); // past the forced-stop grace
        const after = run.out().slice(mark);
        assert.ok(!k.late.test(after), `the late answer reached the output:\n${after}`);
        assert.ok(!/did not stop|Failed to execute command|To exit the CLI/.test(after), after);
        assert.equal(run.sessions.length, 1, 'the idle session was neither stopped nor re-created');
        assert.deepEqual(s.prompts.map((p) => p.text), ['next']);
        run.stdin.write(`/quit${nl}`);
        assert.equal(await run.exit, 0);
      } finally {
        await release(s, run);
      }
    });
  }
}

test('repl: a double Ctrl+C while /usage waits cancels it; the second press is the first exit press at the idle prompt; nothing is stopped (K9, F0)', { timeout: 20_000 }, async () => {
  const s = new SlowControlSession();
  const run = startRepl({ session: s, keepOpen: true });
  try {
    await run.waitFor('> ');
    s.hold = true;
    run.send('/usage');
    await until(() => s.held.length === 1);
    run.send('\u0003');
    await run.waitFor(/\/usage was cancelled\.\n\n> $/, 1500);
    await sleep(150);
    run.send('\u0003');
    await run.waitFor('To exit the CLI', 1500);
    await sleep(1200); // past the forced-stop grace
    const out = run.out();
    assert.ok(!out.includes('did not stop'), `the idle session was stopped:\n${out}`);
    assert.equal(s.closed, false);
    s.held[0]!.answer();
    run.send('/quit');
    assert.equal(await run.exit, 0);
    assert.ok(!/Current context window/.test(run.out()), run.out());
  } finally {
    await release(s, run);
  }
});

test('repl: a cancelled /model whose control request later fails (timeout) prints nothing and raises no unhandled rejection (K9)', { timeout: 20_000 }, async () => {
  const s = new SlowControlSession();
  const run = startRepl({ session: s, keepOpen: true });
  try {
    await run.waitFor('> ');
    s.hold = true;
    run.send('/model claude-haiku-4.5');
    await until(() => s.held.length === 1);
    run.send('\u0003');
    await run.waitFor(/has not confirmed the switch to Haiku 4\.5 yet\.\n\n> $/, 1500);
    const atPrompt = run.out().length;
    s.held[0]!.fail(new Error("Control request 'set_model' timed out after 60000 ms"));
    await sleep(200);
    assert.equal(run.out().slice(atPrompt), '', 'the late failure printed');
    run.send('/session-id');
    await run.waitFor(/\/session-id\n[\s\S]*> $/, 5000);
    assert.ok(!/timed out|Failed to execute command/.test(run.out()), run.out());
    run.send('/quit');
    assert.equal(await run.exit, 0);
  } finally {
    await release(s, run);
  }
});

test('repl: without a Ctrl+C a slow answer is still awaited and printed (K9 control)', { timeout: 20_000 }, async () => {
  const s = new SlowControlSession();
  const run = startRepl({ session: s, keepOpen: true });
  try {
    await run.waitFor('> ');
    s.hold = true;
    for (const [cmd, shows] of [['/usage', /Current context window/], ['/mcp', /github\s+connected/], ['/tools', /Built-in:/], ['/model claude-haiku-4.5', /Using Haiku 4\.5/]] as const) {
      const mark = run.out().length;
      const n = s.held.length;
      run.send(cmd);
      await until(() => s.held.length === n + 1);
      await sleep(300);
      assert.ok(!shows.test(run.out().slice(mark)), `${cmd} printed before the answer`);
      s.held[n]!.answer();
      await run.waitFor(shows, 2000);
      await run.waitFor(/> $/, 2000);
      assert.ok(!/cancelled|not confirmed/.test(run.out().slice(mark)), run.out().slice(mark));
    }
    run.send('/quit');
    assert.equal(await run.exit, 0);
  } finally {
    await release(s, run);
  }
});

test('repl: Ctrl+C during the usage-indicator refresh after /model does not wait out its timeout; the switch is reported (K9)', { timeout: 20_000 }, async () => {
  const s = new SlowControlSession();
  // setModel answers at once; only the context-usage refresh after it is slow
  s.setModel = async function (this: SlowControlSession, id: string): Promise<void> {
    this.calls.push({ method: 'setModel', args: [id] });
    this.model = id;
  };
  const run = startRepl({ session: s, keepOpen: true, settings: { 'chat.enableContextUsageIndicator': true } });
  try {
    await run.waitFor('> ');
    s.hold = true;
    run.send('/model claude-haiku-4.5');
    await until(() => s.held.length === 1);
    assert.equal(s.held[0]?.method, 'usage');
    const pressedAt = Date.now();
    run.send('\u0003');
    await run.waitFor(/Using Haiku 4\.5\n\n[\s\S]*> $/, 2500);
    assert.ok(Date.now() - pressedAt < 1000, `the refresh held the command ${Date.now() - pressedAt} ms after the press`);
    s.held[0]!.answer();
    run.send('/quit');
    assert.equal(await run.exit, 0);
  } finally {
    await release(s, run);
  }
});

test('untilCancelled: the value; CANCELLED on abort (a later rejection is handled); not started once aborted', async () => {
  assert.equal(await untilCancelled(undefined, async () => 7), 7);
  const ac = new AbortController();
  assert.equal(await untilCancelled(ac.signal, async () => 'v'), 'v');
  await assert.rejects(untilCancelled(ac.signal, async () => Promise.reject(new Error('boom'))), /boom/);
  let fail!: (e: Error) => void;
  const pending = untilCancelled(ac.signal, () => new Promise<never>((_r, rej) => (fail = rej)));
  ac.abort();
  assert.equal(await pending, CANCELLED);
  fail(new Error('late'));
  await sleep(20); // an unhandled rejection would fail the test run
  let started = false;
  assert.equal(
    await untilCancelled(ac.signal, async () => {
      started = true;
      return 1;
    }),
    CANCELLED,
  );
  assert.equal(started, false);
});

test('repl: a Ctrl+C before /model asked Claude Code to switch cancels the switch: the model stays (K9)', { timeout: 20_000 }, async () => {
  const s = new SlowControlSession();
  let releaseList!: () => void;
  let listing = false;
  const listModels = s.listModels.bind(s);
  s.listModels = async function (): Promise<import('../../src/types.js').ModelEntry[]> {
    if (s.hold) {
      listing = true;
      await new Promise<void>((r) => (releaseList = r));
    }
    return listModels();
  };
  const run = startRepl({ session: s, keepOpen: true });
  try {
    await run.waitFor('> ');
    s.hold = true;
    run.send('/model claude-haiku-4.5');
    await until(() => listing);
    run.send('\u0003');
    await sleep(50);
    releaseList();
    await run.waitFor(/\/model was cancelled\.\n\n> $/, 1500);
    assert.deepEqual(s.called('setModel'), [], 'the switch was not asked for');
    assert.equal(s.model, 'auto');
    assert.ok(!/not confirmed|Using Haiku/.test(run.out()), run.out());
    run.send('/quit');
    assert.equal(await run.exit, 0);
  } finally {
    releaseList?.();
    await release(s, run);
  }
});

// ───── repl verifier: the refresh stops at a press DURING it, not at one before it ─────

/**
 * `/tangent` back to the main conversation, whose return (a Claude Code restart) is held until the
 * test says so; the main conversation's usage is 6 %, the tangent's 40 %.
 */
function heldTangentExit(): { s: SlowControlSession; exiting: () => boolean; release: () => void } {
  const s = new SlowControlSession();
  s.tangent = { name: null, parentId: 'main' };
  s.usageReport = { ...s.usageReport, contextPercent: 40 };
  let exiting = false;
  let releaseExit: (() => void) | undefined;
  s.exitTangent = async function (this: SlowControlSession, mode: 'discard' | 'tail' | 'merge'): Promise<void> {
    this.calls.push({ method: 'exitTangent', args: [mode] });
    exiting = true;
    await new Promise<void>((r) => (releaseExit = r));
    this.tangent = undefined;
    this.usageReport = { ...this.usageReport, contextPercent: 6 };
  };
  return { s, exiting: () => exiting, release: () => releaseExit?.() };
}

test('repl: a Ctrl+C while /tangent returns (Claude Code restarting: the press changes nothing, F0) does not skip the usage-indicator refresh after it (K9)', { timeout: 20_000 }, async () => {
  const { s, exiting, release } = heldTangentExit();
  const run = startRepl({ session: s, keepOpen: true, settings: { 'chat.enableContextUsageIndicator': true } });
  try {
    await run.waitFor(/40% ↯ > $/);
    const mark = run.out().length;
    run.send('/tangent');
    await until(exiting);
    const before = s.called('usage').length;
    run.send('\u0003');
    await sleep(100);
    release();
    await run.waitFor(/Returned to main conversation\.\n\n[\s\S]*> $/, 2500);
    const after = run.out().slice(mark);
    assert.equal(s.called('usage').length, before + 1, `the refresh after the return was skipped:\n${after}`);
    assert.ok(/\n6% > $/.test(after), `the main conversation's prompt shows the tangent's usage:\n${JSON.stringify(after.slice(-40))}`);
    assert.ok(!/cancelled|did not stop|Failed to execute command/.test(after), after);
    assert.equal(s.closed, false);
    run.send('/quit');
    assert.equal(await run.exit, 0);
  } finally {
    release();
    await release0(s, run);
  }
});

test('repl: after a press before it, a press DURING the usage-indicator refresh still ends it at once (K9)', { timeout: 20_000 }, async () => {
  const { s, exiting, release } = heldTangentExit();
  const run = startRepl({ session: s, keepOpen: true, settings: { 'chat.enableContextUsageIndicator': true } });
  try {
    await run.waitFor(/40% ↯ > $/);
    s.hold = true; // the refresh after the return waits on Claude Code
    run.send('/tangent');
    await until(exiting);
    run.send('\u0003');
    await sleep(100);
    release();
    await until(() => s.held.length === 1);
    assert.equal(s.held[0]?.method, 'usage');
    const pressedAt = Date.now();
    run.send('\u0003');
    await run.waitFor(/Returned to main conversation\.\n\n[\s\S]*> $/, 2500);
    assert.ok(Date.now() - pressedAt < 1000, `the refresh held the command ${Date.now() - pressedAt} ms after the press`);
    s.held[0]!.answer();
    await sleep(50);
    run.send('/quit');
    assert.equal(await run.exit, 0);
    assert.ok(!/did not stop|Failed to execute command/.test(run.out()), run.out());
  } finally {
    release();
    await release0(s, run);
  }
});

/** {@link release}, named apart from the tangent helpers' own `release`. */
const release0 = release;

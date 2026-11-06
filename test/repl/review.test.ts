/**
 * Adversarial review tests for the REPL (resource cleanup, path safety, approval display
 * safety, slash parsing edge cases, cross-module behaviour with the real session + fake claude).
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { openSettings } from '../../src/config/settings.js';
import { createWorkspaceContext } from '../../src/config/workspace.js';
import { LineReader } from '../../src/repl/input.js';
import { APPROVAL_QUESTION } from '../../src/repl/prompt.js';
import { describeTool, formatToolUse, TurnRenderer } from '../../src/repl/render.js';
import { runRepl } from '../../src/repl/repl.js';
import type { CliContext, KiroSessionOptions, SessionEvent } from '../../src/types.js';
import { setColorEnabled, stripAnsi } from '../../src/util/ansi.js';
import { fakeClaudePath, fakeEnv } from '../claude/helpers.js';
import { runToEnd, startRepl, tempEnv } from './harness.js';
import { MockSession, call } from './mockSession.js';

setColorEnabled(false);

const temps: { cleanup(): void }[] = [];
after(() => {
  for (const t of temps) t.cleanup();
});

async function cmd(input: string[], o: Parameters<typeof runToEnd>[0] = {}): Promise<{ out: string; raw: string; s: MockSession; run: Awaited<ReturnType<typeof runToEnd>>['run'] }> {
  const s = o.session ?? new MockSession();
  const r = await runToEnd({ ...o, session: s, input });
  temps.push(r.run.t);
  return { out: r.out, raw: r.run.raw(), s, run: r.run };
}

function count(hay: string, needle: string): number {
  return hay.split(needle).length - 1;
}

// ───────────────────────────── resource cleanup ─────────────────────────────

test('review: a session whose start() fails is closed (no leaked claude child)', async () => {
  const s = new MockSession();
  s.start = async () => {
    throw new Error('claude failed to start');
  };
  const { code, out, run } = await runToEnd({ session: s, input: ['hi'] });
  temps.push(run.t);
  assert.equal(code, 1);
  assert.ok(out.includes('claude failed to start'), out);
  assert.equal(s.closed, true, 'the half-started session must be closed');
});

test('review: /chat new whose session fails to start closes it and keeps the current one', async () => {
  const first = new MockSession().script({ result: { text: 'still here' } });
  let second: MockSession | undefined;
  const { out, s } = await cmd(['/chat new', 'hello'], {
    session: first,
    nextSession: () => {
      second = new MockSession();
      second.start = async () => {
        throw new Error('spawn failed');
      };
      return second;
    },
  });
  assert.ok(out.includes('Failed to execute command: spawn failed'), out);
  assert.ok(second, 'a second session was created');
  assert.equal(second!.closed, true, 'the failed new session is closed');
  assert.equal(s.closed, true, 'the original session is closed on exit');
  assert.deepEqual(s.prompts.map((p) => p.text), ['hello'], 'the original session stays active');
  assert.ok(out.includes(`--resume-id ${first.id}`), 'exit hint names the session that stayed active');
});

test('review: /chat resume and /chat load close a session that fails to start', async () => {
  const t = tempEnv();
  temps.push(t);
  const file = t.write('proj/exp.json', '{}');
  let failing: MockSession | undefined;
  const { out } = await cmd(['/chat load exp.json'], {
    t,
    importSessionExport: async () => {
      failing = new MockSession();
      failing.start = async () => {
        throw new Error('import start failed');
      };
      return failing;
    },
  });
  assert.ok(fs.existsSync(file));
  assert.ok(out.includes('Failed to import from exp.json: import start failed'), out);
  assert.equal(failing?.closed, true);
});

// ───────────────────────────── path safety ─────────────────────────────

test('review: /prompts remove|edit refuse names that escape the prompts directory', async () => {
  const t = tempEnv();
  temps.push(t);
  const readme = t.write('proj/README.md', '# keep me\n');
  t.write('proj/.kiro/prompts/ok.md', 'fine');
  const { out } = await cmd(['/prompts remove ../../README', '/prompts edit ../../README', '/prompts rm ../prompts/ok'], { t, env: { EDITOR: 'true' } });
  assert.ok(fs.existsSync(readme), `README.md must not be deleted:\n${out}`);
  assert.ok(fs.existsSync(path.join(t.wsDir, '.kiro', 'prompts', 'ok.md')));
  assert.ok(!out.includes('✔ Removed'), out);
  assert.ok(!out.includes('✔ Updated'), out);
});

test('review: /agent create with a nested name creates the sub directory', async () => {
  const t = tempEnv();
  temps.push(t);
  const { out } = await cmd(['/agent create team/planner -d workspace'], { t, env: { EDITOR: '' } });
  const file = path.join(t.wsDir, '.kiro', 'agents', 'team', 'planner.json');
  assert.ok(fs.existsSync(file), out);
  assert.ok(out.includes(`📁 Created agent team/planner '${file}'`), out);
});

// ───────────────────────────── slash parsing ─────────────────────────────

test('review: free-text commands accept apostrophes (no "unbalanced quotes" failure)', async () => {
  const s = new MockSession().script({ result: { text: 'planning' } });
  const { out } = await cmd(["/plan I don't know where the bug is", '/title it\'s late'], { session: s });
  assert.ok(!out.includes('unbalanced quotes'), out);
  assert.deepEqual(s.prompts.map((p) => p.text), ["I don't know where the bug is"]);
  assert.ok(out.includes('Entered plan mode.'));
});

test('review: unknown slash commands, case-insensitive built-ins, lone slash', async () => {
  const { out, s } = await cmd(['/', '/HeLp', '/nope arg', '/usr/bin/env is broken']);
  assert.ok(out.includes('Unknown command: /\n'), out);
  assert.ok(out.includes('Commands:'), out);
  assert.ok(out.includes('Unknown command: /nope'), out);
  assert.ok(out.includes('Unknown command: /usr/bin/env'), out);
  assert.equal(s.prompts.length, 0, 'nothing reaches the model');
});

test('review: a /<steering> invocation never sends text starting with "/" (Claude would run it as its own slash command)', async () => {
  const s = new MockSession().script({}, {});
  const run = startRepl({ session: s, input: ['/cost', '/cost explain the numbers'] });
  run.t.write('proj/.kiro/steering/cost.md', '---\ninclusion: manual\n---\nCosts are in EUR.');
  await run.exit;
  temps.push(run.t);
  assert.equal(s.prompts.length, 2, run.out());
  for (const p of s.prompts) {
    assert.ok(!p.text.trimStart().startsWith('/'), `sent text must not start with '/': ${JSON.stringify(p.text)}`);
    assert.deepEqual(p.steeringRefs, ['cost']);
  }
  assert.ok(s.prompts[1]!.text.endsWith('explain the numbers'), s.prompts[1]!.text);
});

test('review: unicode tag characters are stripped before dispatch', async () => {
  const s = new MockSession().script({});
  await cmd(['hel\u{E0041}lo\u{E0042}'], { session: s });
  assert.deepEqual(s.prompts.map((p) => p.text), ['hello']);
});

// ───────────────────────────── approvals ─────────────────────────────

test('review: approval answers are exact (yes / Y / " y " / t)', async () => {
  const cases: [string, string][] = [
    ['yes', 'redirect'],
    ['Y', 'allow-once'],
    ['   y   ', 'allow-once'],
    ['T', 'allow-always'],
    ['N', 'deny'],
  ];
  for (const [answer, kind] of cases) {
    const s = new MockSession().script({ steps: [{ approval: call('Bash', { command: 'ls' }) }] }, {});
    await cmd(['go', answer], { session: s });
    assert.equal(s.approvals[0]?.kind, kind, JSON.stringify(answer));
  }
});

test('review: an unknown /x at the approval prompt is reported and the tool stays pending', async () => {
  const s = new MockSession().script({ steps: [{ approval: call('Bash', { command: 'ls' }) }] });
  const { out } = await cmd(['go', '/nope', 'y'], { session: s });
  assert.ok(out.includes('Unknown command: /nope'), out);
  assert.equal(count(out, APPROVAL_QUESTION), 2, out);
  assert.deepEqual(s.approvals, [{ kind: 'allow-once' }]);
});

test('review: an approval queued behind /quit is cancelled without prompting again', async () => {
  const s = new MockSession();
  const c1 = call('Bash', { command: 'one' }, 'tu1');
  const c2 = call('Bash', { command: 'two' }, 'tu2');
  s.script({
    steps: [
      {
        run: async ({ session, signal }) => {
          const ui = session.ui!;
          const [a, b] = await Promise.all([
            ui.requestApproval({ call: c1, requestId: 'r1', reasons: [], agentName: 'kiro_default' }, signal),
            ui.requestApproval({ call: c2, requestId: 'r2', reasons: [], agentName: 'kiro_default' }, signal),
          ]);
          session.approvals.push(a, b);
        },
      },
    ],
  });
  const { out } = await cmd(['go', '/quit', 'y'], { session: s });
  assert.deepEqual(s.approvals, [{ kind: 'cancelled' }, { kind: 'cancelled' }]);
  assert.equal(count(out, APPROVAL_QUESTION), 1, out);
  assert.ok(!out.includes('I will run the following shell command: two'), 'the second tool is never shown');
});

test('review: approval display shows control characters instead of interpreting them', () => {
  const evil = call('Bash', { command: 'echo safe\u001b[2K\r\u001b[1Arm -rf ~ ‮' });
  const d = describeTool(evil, { cwd: '/work', expand: false });
  assert.ok(!d.includes('\u001b'), JSON.stringify(d));
  assert.ok(!d.includes('\r'), JSON.stringify(d));
  assert.ok(!d.includes('‮'), JSON.stringify(d));
  assert.ok(d.includes('rm -rf ~'), d);
  assert.ok(d.includes('\\x1b[2K'), d);
  const w = call('Write', { file_path: '/work/a\u001b]0;pwned\u0007.txt', content: 'x\u001b[31m' });
  const block = formatToolUse(w, false, { cwd: '/work', expand: false });
  assert.ok(!block.includes('\u001b') && !block.includes('\u0007'), JSON.stringify(block));
});

test('review: tool output and assistant text cannot inject terminal escape sequences', () => {
  let out = '';
  const r = new TurnRenderer((s) => (out += s), { markdown: true, showThinking: true, autoExpandToolOutput: false, ascii: false, cwd: '/work' });
  r.beginTurn();
  const evs: SessionEvent[] = [
    { type: 'text_delta', text: 'hi \u001b]52;c;cGF5bG9hZA==\u0007there' },
    { type: 'tool_start', toolUseId: 't1', call: call('Bash', { command: 'cat f' }, 't1'), trusted: true },
    { type: 'tool_end', toolUseId: 't1', call: call('Bash', { command: 'cat f' }, 't1'), isError: false, output: 'line\u001b[2J\u001b]0;title\u0007 end', durationMs: 5 },
  ];
  for (const e of evs) r.handle(e);
  r.endTurn({ stopReason: 'end_turn', isError: false, text: '', permissionDenials: [] }, { progName: 'kiro-claude' });
  assert.ok(!out.includes('\u001b]') && !out.includes('\u001b[2J') && !out.includes('\u0007'), JSON.stringify(out));
  assert.ok(out.includes('hi there'), out);
  assert.ok(out.includes('line end'), out);
});

// ───────────────────────────── /rewind picker ─────────────────────────────

test('review: /rewind picker numbers are turn numbers', async () => {
  const s = new MockSession();
  s.record.turns.push(
    { userUuid: 'u1', preview: 'first', at: '' },
    { userUuid: 'u2', preview: 'second', at: '' },
    { userUuid: 'u3', preview: 'third', at: '' },
  );
  const { out } = await cmd(['/rewind', '1'], { session: s });
  assert.deepEqual(s.called('rewind'), [[1]], out);
  assert.ok(!/\d+\. \d+\. /.test(out), `no double numbering:\n${out}`);
});

// ───────────────────────────── input ─────────────────────────────

test('review: Ctrl+C while a child owns the terminal is left to the child (no turn interrupt)', () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const r = new LineReader({ input, output, terminal: false });
  let interrupts = 0;
  r.on('interrupt', () => interrupts++);
  r.suspend();
  r.ctrlC();
  assert.equal(interrupts, 0);
  r.resume();
  r.ctrlC();
  assert.equal(interrupts, 1);
  r.close();
});

test('review: a notice during an approval read is printed above the prompt (prompt re-shown)', async () => {
  const s = new MockSession();
  s.script({
    steps: [
      {
        run: async ({ session, signal }) => {
          const ui = session.ui!;
          const p = ui.requestApproval({ call: call('Bash', { command: 'ls' }, 'n1'), requestId: 'r', reasons: [], agentName: 'kiro_default' }, signal);
          await new Promise((res) => setTimeout(res, 20));
          ui.notice('warn', 'hook warning while asking');
          session.approvals.push(await p);
        },
      },
    ],
  });
  const run = startRepl({ session: s, input: ['go'], keepOpen: true });
  temps.push(run.t);
  await run.waitFor('hook warning while asking');
  run.send('y');
  run.end();
  await run.exit;
  const out = run.out();
  assert.deepEqual(s.approvals, [{ kind: 'allow-once' }]);
  assert.ok(/hook warning while asking\n> y\n/.test(out), out);
});

// ───────────────────────────── real session + fake claude ─────────────────────────────

async function drive(script: unknown, lines: string[], setup?: (t: ReturnType<typeof tempEnv>) => void): Promise<{ code: number; out: string; users: string[] }> {
  const t = tempEnv();
  temps.push(t);
  setup?.(t);
  const logFile = path.join(t.root, 'fake.log');
  const env = fakeEnv({ ...t.env, FAKE_CLAUDE_SCRIPT_JSON: JSON.stringify(script), FAKE_CLAUDE_LOG: logFile, KIRO_CLAUDE_BIN: fakeClaudePath() });
  const ws = createWorkspaceContext(t.wsDir, env);
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
  const sessionOptions: Omit<KiroSessionOptions, 'ui' | 'interactive' | 'origin' | 'ws'> = { env, claudePath: fakeClaudePath() };
  const exit = runRepl({ ctx, sessionOptions });
  stdin.end(lines.map((l) => `${l}\n`).join(''));
  const code = await exit;
  const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
  const users = log
    .filter((e) => e.event === 'stdin' && (e.line as { type?: string }).type === 'user')
    .map((e) => {
      const m = (e.line as { message?: { content?: unknown } }).message?.content;
      return typeof m === 'string' ? m : JSON.stringify(m);
    });
  return { code, out: stripAnsi(out), users };
}

test('review e2e: repeating a /<steering> invocation never sends raw slash text to claude', { timeout: 60_000 }, async () => {
  const script = { turns: [{ steps: [{ text: 'one' }] }, { steps: [{ text: 'two' }] }] };
  const { code, out, users } = await drive(script, ['/cost', '/cost again', '/quit'], (t) => {
    t.write('proj/.kiro/steering/cost.md', '---\ninclusion: manual\n---\nCosts are in EUR.');
  });
  assert.equal(code, 0, out);
  assert.equal(users.length, 2, JSON.stringify(users));
  for (const u of users) assert.ok(!u.trimStart().startsWith('/'), `claude received slash text: ${JSON.stringify(u)}`);
  assert.ok(users[0]!.includes('Costs are in EUR.'), users[0]);
});

test('review: the approval question always follows the block of the tool being approved', async () => {
  // parallel calls: both tool_start blocks are shown before the first approval arrives
  const a = call('Bash', { command: 'touch a' }, 'ta');
  const b = call('Bash', { command: 'rm -rf b' }, 'tb');
  const s = new MockSession().script({
    steps: [
      { type: 'tool_start', toolUseId: 'ta', call: a, trusted: false },
      { type: 'tool_start', toolUseId: 'tb', call: b, trusted: false },
      { approval: a },
    ],
  });
  const { out } = await cmd(['go', 'y'], { session: s });
  const q = out.indexOf(APPROVAL_QUESTION);
  const before = out.slice(0, q);
  assert.ok(before.lastIndexOf('touch a') > before.lastIndexOf('rm -rf b'), `question must follow the 'touch a' block:\n${out}`);
});

test('review: events arriving while an approval prompt is shown are rendered after the answer', async () => {
  const a = call('Bash', { command: 'touch a' }, 'ta');
  const s = new MockSession();
  s.script({
    steps: [
      {
        run: async ({ session, signal }) => {
          const p = session.ui!.requestApproval({ call: a, requestId: 'r', reasons: [], agentName: 'kiro_default' }, signal);
          session.approvals.push(await p);
        },
      },
    ],
  });
  // a concurrently produced event: emitted by a second consumer path while the read is active
  const orig = s.prompt.bind(s);
  s.prompt = (input, opts) => {
    const g = orig(input, opts);
    async function* wrap(): AsyncGenerator<SessionEvent, import('../../src/types.js').TurnResult> {
      const first = g.next();
      // let the approval prompt appear, then yield an event while it is still waiting
      await new Promise((r) => setTimeout(r, 30));
      yield { type: 'notice', level: 'info', message: 'concurrent event' } as SessionEvent;
      const n = await first;
      if (n.done) return n.value;
      yield n.value;
      for (;;) {
        const m = await g.next();
        if (m.done) return m.value;
        yield m.value;
      }
    }
    return wrap();
  };
  const run = startRepl({ session: s, input: ['go'], keepOpen: true });
  temps.push(run.t);
  await run.waitFor(APPROVAL_QUESTION);
  await new Promise((r) => setTimeout(r, 60));
  run.send('y');
  run.end();
  await run.exit;
  const out = run.out();
  assert.deepEqual(s.approvals, [{ kind: 'allow-once' }]);
  const answered = out.indexOf(`${APPROVAL_QUESTION}\n\n> y\n`);
  assert.ok(answered >= 0, `the prompt line is not broken by the event:\n${out}`);
  assert.ok(out.indexOf('concurrent event') > answered, `deferred until after the answer:\n${out}`);
});

test('review (tty): keys typed while a response streams never answer the [y/n/t] question', async () => {
  let run!: ReturnType<typeof startRepl>;
  const s = new MockSession().script({
    steps: [
      { run: () => void run.stdin.write('y') },
      { run: () => new Promise<void>((r) => setTimeout(r, 30)) },
      { approval: call('Bash', { command: 'rm -rf build' }) },
    ],
  });
  run = startRepl({ session: s, tty: true, keepOpen: true });
  temps.push(run.t);
  await run.waitFor('> ');
  run.stdin.write('go\r');
  await run.waitFor(APPROVAL_QUESTION);
  await new Promise((r) => setTimeout(r, 20));
  run.stdin.write('n\r');
  await new Promise((r) => setTimeout(r, 30));
  run.stdin.write('\u0004');
  await new Promise((r) => setTimeout(r, 10));
  run.stdin.write('\u0004');
  assert.equal(await run.exit, 0);
  assert.deepEqual(s.approvals, [{ kind: 'deny' }]);
});

test('review (tty): Ctrl+C at the approval prompt cancels the tool, the REPL keeps running', async () => {
  const s = new MockSession().script({ steps: [{ approval: call('Bash', { command: 'ls' }) }], result: { stopReason: 'cancelled' } }, { result: { text: 'second answer' } });
  const run = startRepl({ session: s, tty: true, keepOpen: true });
  temps.push(run.t);
  await run.waitFor('> ');
  run.stdin.write('go\r');
  await run.waitFor(APPROVAL_QUESTION);
  run.stdin.write('\u0003');
  await new Promise((r) => setTimeout(r, 30));
  run.stdin.write('again\r');
  await run.waitFor('second answer');
  run.stdin.write('/quit\r');
  assert.equal(await run.exit, 0);
  assert.deepEqual(s.approvals, [{ kind: 'cancelled' }]);
  assert.deepEqual(s.prompts.map((p) => p.text), ['go', 'again']);
  assert.ok(!run.out().includes('(To exit the CLI'), 'Ctrl+C at an approval is not the idle exit hint');
});

test('review (tty): Ctrl+C while a response streams interrupts once, a second Ctrl+C aborts', async () => {
  let run!: ReturnType<typeof startRepl>;
  let aborted = false;
  const s = new MockSession().script({
    steps: [
      { type: 'text_delta', text: 'working' },
      {
        run: async ({ signal }) => {
          run.stdin.write('\u0003');
          await new Promise((r) => setTimeout(r, 20));
          run.stdin.write('\u0003');
          await new Promise((r) => setTimeout(r, 20));
          aborted = signal.aborted;
        },
      },
    ],
    result: { stopReason: 'cancelled' },
  });
  run = startRepl({ session: s, tty: true, keepOpen: true });
  temps.push(run.t);
  await run.waitFor('> ');
  run.stdin.write('long job\r');
  await run.waitFor('working');
  await new Promise((r) => setTimeout(r, 80));
  run.stdin.write('/quit\r');
  assert.equal(await run.exit, 0);
  assert.equal(s.interrupted, 1);
  assert.equal(aborted, true, 'the second Ctrl+C aborts the prompt signal');
});

test('review: a turn-starting command at the approval prompt is refused, the tool stays pending', async () => {
  const s = new MockSession().script({ steps: [{ approval: call('Bash', { command: 'ls' }, 'tz') }] });
  const run = startRepl({ session: s, input: ['go', '/greet', '/compact', 'y'] });
  run.t.write('proj/.kiro/prompts/greet.md', 'Say hello.');
  await run.exit;
  temps.push(run.t);
  const out = run.out();
  assert.deepEqual(s.approvals, [{ kind: 'allow-once' }]);
  assert.deepEqual(s.prompts.map((p) => p.text), ['go'], 'no nested turn was started');
  assert.equal(s.called('compact').length, 0);
  assert.ok(!out.includes('Kiro is having trouble responding'), out);
  assert.equal(count(out, 'A response is still running'), 2, out);
  assert.equal(count(out, APPROVAL_QUESTION), 3, out);
});

test('review: /chat new at the approval prompt does not replace the running session', async () => {
  const s = new MockSession().script({ steps: [{ approval: call('Bash', { command: 'ls' }, 'tc') }] });
  const { out, run } = await cmd(['go', '/chat new', 'y'], { session: s });
  assert.deepEqual(s.approvals, [{ kind: 'allow-once' }]);
  assert.equal(run.sessions.length, 1, 'no second session was created');
  assert.ok(out.includes('Failed to execute command: A response is still running'), out);
  assert.ok(out.includes(`--resume-id ${s.id}`));
});

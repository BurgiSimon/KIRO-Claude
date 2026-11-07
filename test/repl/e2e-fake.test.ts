/**
 * End to end: the real runRepl (session/kiroSession createSession, spec slash commands) driving
 * test/fixtures/fake-claude.mjs. No model, no real ~/.claude.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { openSettings } from '../../src/config/settings.js';
import { createWorkspaceContext } from '../../src/config/workspace.js';
import { runRepl } from '../../src/repl/repl.js';
import type { CliContext } from '../../src/types.js';
import { stripAnsi } from '../../src/util/ansi.js';
import { fakeClaudePath, fakeEnv } from '../claude/helpers.js';
import { killIfSame, startTicksOf } from '../claude/pid-reuse-helpers.js';
import { tempEnv } from './harness.js';
import { DESIGN_MD, REQ_MD, TASKS_MD } from '../spec/helpers.js';

async function drive(script: unknown, lines: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number; out: string; log: Record<string, unknown>[]; t: ReturnType<typeof tempEnv> }> {
  const t = tempEnv();
  const logFile = path.join(t.root, 'fake.log');
  const env = fakeEnv({
    ...t.env,
    FAKE_CLAUDE_SCRIPT_JSON: JSON.stringify(script),
    FAKE_CLAUDE_LOG: logFile,
    KIRO_CLAUDE_BIN: fakeClaudePath(),
    ...extraEnv,
  });
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
  const exit = runRepl({ ctx, sessionOptions: { env, claudePath: fakeClaudePath() } });
  stdin.end(lines.map((l) => `${l}\n`).join(''));
  const code = await exit;
  const log = fs.existsSync(logFile)
    ? fs
        .readFileSync(logFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    : [];
  return { code, out: stripAnsi(out), log, t };
}

test('e2e: chat turn with a tool approval through the real session and fake claude', { timeout: 60_000 }, async () => {
  const script = {
    turns: [
      {
        steps: [
          { text: 'Creating the file.' },
          { tool: { name: 'Bash', input: { command: 'touch made-by-test.txt', description: 'Create a file' } } },
          { text: 'Tool said: {{lastToolResult}}' },
        ],
      },
    ],
  };
  const { code, out, log, t } = await drive(script, ['make a file', 'y', '/quit']);
  try {
    assert.equal(code, 0, out);
    assert.ok(out.includes('> Creating the file.'), out);
    assert.ok(out.includes('🛠️  Using tool: shell'), out);
    assert.ok(out.includes("Allow this action? Use 't' to trust (always allow) this tool for the session. [y/n/t]:"), out);
    assert.ok(out.includes('Completed in'), out);
    assert.ok(out.includes('Tool said:'), out);
    assert.match(out, /To resume this session: kiro-claude chat --resume-id [0-9a-f-]{36}\n$/);
    const sent = log.filter((e) => e.event === 'stdin').map((e) => e.line as Record<string, unknown>);
    const answers = sent.filter((l) => l.type === 'control_response');
    assert.ok(answers.some((a) => JSON.stringify(a).includes('"behavior":"allow"')), JSON.stringify(answers));
  } finally {
    t.cleanup();
  }
});

test('e2e: n denies with Kiro text; unknown /x is not forwarded', { timeout: 60_000 }, async () => {
  const script = {
    turns: [{ steps: [{ tool: { name: 'Bash', input: { command: 'rm -rf build' } } }, { text: 'model saw: {{lastToolResult}}' }] }],
  };
  const { code, out, log, t } = await drive(script, ['/definitely-unknown', 'clean', 'n', '/quit']);
  try {
    assert.equal(code, 0, out);
    assert.ok(out.includes('Unknown command: /definitely-unknown'));
    assert.ok(out.includes('I deny this tool request. Ask a follow up question clarifying the expected action'), out);
    const users = log.filter((e) => e.event === 'stdin' && (e.line as { type?: string }).type === 'user');
    assert.equal(users.length, 1, 'only the real prompt reached claude');
    assert.ok(!JSON.stringify(users).includes('definitely-unknown'));
  } finally {
    t.cleanup();
  }
});

test('e2e: a free-text answer redirects once (sent by the session, not duplicated by the REPL)', { timeout: 60_000 }, async () => {
  const script = {
    turns: [
      { match: '^clean', steps: [{ tool: { name: 'Bash', input: { command: 'rm -rf build' } } }, { text: 'never reached' }] },
      { match: 'git clean', steps: [{ text: 'OK, using git clean.' }] },
    ],
  };
  const { code, out, log, t } = await drive(script, ['clean the build', 'use git clean instead', '/quit']);
  try {
    assert.equal(code, 0, out);
    assert.ok(out.includes('OK, using git clean.'), out);
    const users = log.filter((e) => e.event === 'stdin' && (e.line as { type?: string }).type === 'user');
    assert.equal(users.filter((u) => JSON.stringify(u).includes('use git clean instead')).length, 1, JSON.stringify(users));
  } finally {
    t.cleanup();
  }
});

// ───────────────────── Ctrl+C during commands and stuck turns (C11, C16) ─────────────────────

/** The real runRepl over a live stdin (written step by step) and fake claude. */
function live(script: unknown, opts: { tty?: boolean; extraEnv?: Record<string, string>; trustTools?: string[]; isolate?: boolean } = {}) {
  const t = tempEnv();
  const logFile = path.join(t.root, 'fake.log');
  // `isolate`: KIRO_HOME and the XDG runtime / cache dirs inside the temp root as well
  const isolated: Record<string, string> = opts.isolate
    ? { KIRO_HOME: path.join(t.home, '.kiro'), XDG_RUNTIME_DIR: path.join(t.root, 'run'), XDG_CACHE_HOME: path.join(t.root, 'cache') }
    : {};
  if (isolated.XDG_RUNTIME_DIR) fs.mkdirSync(isolated.XDG_RUNTIME_DIR, { recursive: true, mode: 0o700 });
  const env = fakeEnv({
    ...t.env,
    ...isolated,
    FAKE_CLAUDE_SCRIPT_JSON: JSON.stringify(script),
    FAKE_CLAUDE_LOG: logFile,
    FAKE_CLAUDE_PERSIST: '1',
    KIRO_CLAUDE_BIN: fakeClaudePath(),
    ...(opts.extraEnv ?? {}),
  });
  const ws = createWorkspaceContext(t.wsDir, env);
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  if (opts.tty) {
    Object.assign(stdin, { isTTY: true, setRawMode: () => stdin });
    Object.assign(stdout, { isTTY: true, columns: 100 });
  }
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
  let ended: { code: number; at: number } | undefined;
  const exit = runRepl({ ctx, sessionOptions: { env, claudePath: fakeClaudePath(), ...(opts.trustTools ? { trustTools: opts.trustTools } : {}) } }).then((code) => {
    ended = { code, at: Date.now() };
    return code;
  });
  const o = (): string => stripAnsi(out);
  const NL = opts.tty ? '\r' : '\n';
  return {
    t,
    o,
    exit,
    ended: () => ended,
    line: (s: string) => stdin.write(`${s}${NL}`),
    ctrlC: () => stdin.write(opts.tty ? '\u0003' : '\u0003\n'),
    end: () => stdin.end(),
    async waitFor(re: RegExp, ms = 20_000, from = 0): Promise<void> {
      const t0 = Date.now();
      while (!re.test(o().slice(from))) {
        if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${re}\n--- out:\n${o()}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    },
    log(): Record<string, unknown>[] {
      return fs.existsSync(logFile)
        ? fs
            .readFileSync(logFile, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l) as Record<string, unknown>)
        : [];
    },
  };
}

const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const interruptRequests = (log: Record<string, unknown>[]): number =>
  log.filter((e) => e.event === 'stdin' && (e.line as { type?: string; request?: { subtype?: string } })?.type === 'control_request' && (e.line as { request: { subtype?: string } }).request.subtype === 'interrupt').length;

const MERGE_SCRIPT = {
  turns: [
    { match: '^Summarize the findings', steps: [{ sleepMs: 6000 }, { text: 'SUMMARY-TEXT' }] },
    { match: 'main question', steps: [{ text: 'main answer' }] },
    { match: 'side question', steps: [{ text: 'side answer' }] },
  ],
};

async function intoMerge(r: ReturnType<typeof live>): Promise<number> {
  await r.waitFor(/> $/);
  r.line('main question');
  await r.waitFor(/main answer[\s\S]*> $/);
  r.line('/tangent');
  await r.waitFor(/Created a conversation checkpoint[\s\S]*> $/);
  r.line('side question');
  await r.waitFor(/side answer[\s\S]*> $/);
  const mark = r.o().length;
  r.line('/tangent merge');
  await sleepMs(1500);
  return mark;
}

for (const tty of [true, false]) {
  test(`e2e: one Ctrl+C during /tangent merge interrupts its summary turn and keeps the REPL in the tangent (C11, ${tty ? 'terminal' : 'line'} mode)`, { timeout: 60_000 }, async () => {
    const r = live(MERGE_SCRIPT, { tty });
    try {
      const mark = await intoMerge(r);
      r.ctrlC();
      await r.waitFor(/Merge cancelled[\s\S]*↯ > $/, 5000, mark);
      const after = r.o().slice(mark);
      assert.equal(interruptRequests(r.log()), 1, 'the press reached claude as an interrupt');
      assert.ok(!/Merged the tangent/.test(after), after);
      assert.ok(!/To exit the CLI/.test(after), `no replayed exit press:\n${after}`);
      assert.equal(r.ended(), undefined);
      r.line('/quit');
      assert.equal(await r.exit, 0);
    } finally {
      r.end();
      await r.exit.catch(() => undefined);
      r.t.cleanup();
    }
  });
}

test('e2e: two quick Ctrl+C during /tangent merge cancel it without quitting the REPL or stopping Claude Code (C11, line mode)', { timeout: 60_000 }, async () => {
  const r = live(MERGE_SCRIPT);
  try {
    const mark = await intoMerge(r);
    r.ctrlC();
    r.ctrlC(); // a double tap: both presses land while the merge still runs
    await r.waitFor(/Merge cancelled[\s\S]*↯ > $/, 5000, mark);
    await sleepMs(1500); // past the forced-stop grace
    const after = r.o().slice(mark);
    assert.equal(r.ended(), undefined, `the REPL quit:\n${after}`);
    assert.ok(!/To exit the CLI/.test(after), after);
    assert.ok(!/did not stop/.test(after), 'claude ended the turn after the interrupt: no forced stop');
    assert.equal(r.log().filter((e) => e.event === 'start' && (e.argv as string[]).includes('--input-format')).length, 2, 'no respawn beyond the tangent fork');
    r.line('/quit');
    assert.equal(await r.exit, 0);
  } finally {
    r.end();
    await r.exit.catch(() => undefined);
    r.t.cleanup();
  }
});

test('e2e: claude ignores the interrupt ⇒ the second Ctrl+C stops it; the next prompt resumes the conversation (C16)', { timeout: 60_000 }, async () => {
  const script = {
    turns: [
      { match: '^hello', steps: [{ text: 'hi there' }] },
      { match: 'slow thing', steps: [{ text: 'working' }, { sleepMs: 100_000 }] },
      { match: '^next', steps: [{ text: 'second answer' }] },
    ],
  };
  const r = live(script, { extraEnv: { FAKE_CLAUDE_CONTROL_DELAYS: JSON.stringify({ interrupt: 120_000 }) } });
  try {
    await r.waitFor(/> $/);
    r.line('hello');
    await r.waitFor(/hi there[\s\S]*> $/);
    r.line('run the slow thing');
    await r.waitFor(/working/);
    await sleepMs(500);
    const t0 = Date.now();
    r.ctrlC();
    await sleepMs(1000);
    r.ctrlC();
    await r.waitFor(/Claude Code did not stop after the interrupt; stopping it\.[\s\S]*> $/, 15_000);
    const stoppedAfter = Date.now() - t0;
    assert.ok(stoppedAfter < 12_000, `back at the prompt after ${stoppedAfter} ms`);
    const sessionStarts = (): Record<string, unknown>[] => r.log().filter((e) => e.event === 'start' && (e.argv as string[]).includes('--input-format'));
    const starts = sessionStarts();
    const firstPid = starts[0]!.pid;
    const ends = r.log().filter((e) => e.pid === firstPid && (e.event === 'sigterm' || e.event === 'exit'));
    assert.ok(ends.length > 0, 'the first child was stopped');
    r.line('next');
    await r.waitFor(/second answer[\s\S]*> $/, 15_000);
    const second = sessionStarts()[1]!;
    assert.ok((second.argv as string[]).includes('--resume'), JSON.stringify(second.argv));
    assert.equal(interruptRequests(r.log()), 1);
    r.line('/quit');
    assert.equal(await r.exit, 0);
    assert.ok(!/To exit the CLI/.test(r.o()), r.o());
  } finally {
    r.end();
    await r.exit.catch(() => undefined);
    r.t.cleanup();
  }
});

test('e2e: Ctrl+C while the stopped Claude Code is restarted cancels that input; the presses never quit the REPL later (C16)', { timeout: 60_000 }, async () => {
  const script = {
    turns: [
      { match: 'slow thing', steps: [{ text: 'working\n\n' }, { sleepMs: 100_000 }] },
      { match: '^next', steps: [{ text: 'second answer' }] },
    ],
  };
  // initialize answered late: spawning the replacement takes a while, like the real claude
  const r = live(script, { extraEnv: { FAKE_CLAUDE_CONTROL_DELAYS: JSON.stringify({ interrupt: 120_000, initialize: 1500 }) } });
  try {
    await r.waitFor(/> $/);
    r.line('run the slow thing');
    await r.waitFor(/working/);
    r.ctrlC();
    await sleepMs(300);
    r.ctrlC();
    await r.waitFor(/stopping it\.[\s\S]*> $/, 15_000);
    const mark = r.o().length;
    const sessionStarts = (): number => r.log().filter((e) => e.event === 'start' && (e.argv as string[]).includes('--input-format')).length;
    const before = sessionStarts();
    r.line('next');
    const t0 = Date.now();
    while (sessionStarts() === before && Date.now() - t0 < 10_000) await sleepMs(20);
    r.ctrlC(); // impatient double tap while the replacement starts
    await sleepMs(100);
    r.ctrlC();
    await r.waitFor(/> $/, 15_000, mark);
    await sleepMs(500);
    let after = r.o().slice(mark);
    assert.equal(r.ended(), undefined, `the REPL quit:\n${after}`);
    assert.ok(!/To exit the CLI/.test(after), after);
    assert.ok(!/second answer/.test(after), `the input was cancelled:\n${after}`);
    r.line('next');
    await r.waitFor(/second answer[\s\S]*> $/, 15_000, mark);
    assert.equal(sessionStarts(), before + 1, 'restarted once');
    r.line('/quit');
    assert.equal(await r.exit, 0);
    after = r.o().slice(mark);
    assert.ok(!/To exit the CLI/.test(after), after);
  } finally {
    r.end();
    await r.exit.catch(() => undefined);
    r.t.cleanup();
  }
});

test('e2e: the restart after a forced stop keeps the trust as it was: a launch-trusted tool the user untrusted stays untrusted (C16)', { timeout: 60_000 }, async () => {
  const script = {
    turns: [
      { match: '^hello', steps: [{ text: 'hi there' }] },
      { match: 'slow thing', steps: [{ text: 'working\n\n' }, { sleepMs: 100_000 }] },
      { match: '^next', steps: [{ text: 'second answer' }] },
    ],
  };
  const r = live(script, { trustTools: ['shell'], extraEnv: { FAKE_CLAUDE_CONTROL_DELAYS: JSON.stringify({ interrupt: 120_000 }) } });
  const shellLabel = async (): Promise<string> => {
    const m = r.o().length;
    r.line('/tools');
    await r.waitFor(/- shell[^\n]*\n[\s\S]*> $/, 10_000, m);
    return /- shell +([^\n]*)/.exec(r.o().slice(m))![1]!.trim();
  };
  try {
    await r.waitFor(/> $/);
    r.line('hello');
    await r.waitFor(/hi there[\s\S]*> $/);
    assert.equal(await shellLabel(), 'trusted', '--trust-tools=shell');
    r.line('/tools untrust shell');
    const untrusted = await shellLabel();
    assert.notEqual(untrusted, 'trusted');
    r.line('run the slow thing');
    await r.waitFor(/working/);
    r.ctrlC();
    await sleepMs(300);
    r.ctrlC();
    await r.waitFor(/stopping it\.[\s\S]*> $/, 15_000);
    const mark = r.o().length;
    r.line('next');
    await r.waitFor(/second answer[\s\S]*> $/, 15_000, mark);
    assert.equal(await shellLabel(), untrusted, 'the launch trust must not come back over the user\'s /tools untrust');
    r.line('/quit');
    assert.equal(await r.exit, 0);
  } finally {
    r.end();
    await r.exit.catch(() => undefined);
    r.t.cleanup();
  }
});

// ───────────── Ctrl+C during a command whose work runs in another session (F0) ─────────────

const userLines = (log: Record<string, unknown>[]): string[] =>
  log
    .filter((e) => e.event === 'stdin' && (e.line as { type?: string })?.type === 'user')
    .map((e) => JSON.stringify((e.line as { message?: { content?: unknown } }).message?.content ?? ''));

function writeTodoSpec(r: ReturnType<typeof live>): void {
  const dir = path.join(r.t.wsDir, '.kiro', 'specs', 'todo-export');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'requirements.md'), REQ_MD);
  fs.writeFileSync(path.join(dir, 'design.md'), DESIGN_MD);
  fs.writeFileSync(path.join(dir, 'tasks.md'), TASKS_MD);
}

const MAIN_AND_TASKS = {
  turns: [
    { repeat: true, match: 'Execute Task: (1\\.1|2\\.1)', steps: [{ text: 'done\nTASK_RESULT: completed' }] },
    { repeat: true, match: 'main', steps: [{ text: 'MAIN-ANSWER to {{userText}}' }] },
  ],
};

test('e2e: the first Ctrl+C while /spec run starts a task session stops the run; the second never stops the idle main session (F0)', { timeout: 60_000 }, async () => {
  // initialize answered late: spawning a task session's Claude Code takes a while, like the real claude
  const r = live(MAIN_AND_TASKS, { isolate: true, extraEnv: { FAKE_CLAUDE_CONTROL_DELAYS: JSON.stringify({ initialize: 2000 }) } });
  try {
    writeTodoSpec(r);
    await r.waitFor(/> $/);
    r.line('first main');
    await r.waitFor(/MAIN-ANSWER to first main[\s\S]*> $/);
    const mark = r.o().length;
    r.line('/spec run todo-export 1.1 2.1');
    await r.waitFor(/▶ Task 1\.1/, 10_000, mark);
    await sleepMs(300); // the task session is still starting
    r.ctrlC();
    await sleepMs(50);
    r.ctrlC();
    await r.waitFor(/Spec run finished[\s\S]*> $/, 15_000, mark);
    await sleepMs(1500); // past the forced-stop grace
    const after = r.o().slice(mark);
    assert.match(after, /✗ Task 1\.1 interrupted/);
    assert.ok(!/▶ Task 2\.1/.test(after), `the run went on to the next task after the Ctrl+C:\n${after}`);
    assert.ok(!/did not stop|Failed to execute command/.test(after), `the idle main session was stopped:\n${after}`);
    assert.ok(!/To exit the CLI/.test(after), after);
    assert.ok(!userLines(r.log()).some((u) => u.includes('Execute Task')), 'no task turn was sent');
    const m2 = r.o().length;
    r.line('back to main');
    await r.waitFor(/MAIN-ANSWER to back to main[\s\S]*> $/, 15_000, m2);
    assert.ok(!/The session is closed/.test(r.o().slice(m2)), r.o().slice(m2));
    r.line('/quit');
    assert.equal(await r.exit, 0);
  } finally {
    r.end();
    await r.exit.catch(() => undefined);
    r.t.cleanup();
  }
});

test('e2e: a double Ctrl+C while /chat new starts its session reports no failure and never stops the idle session (F0)', { timeout: 60_000 }, async () => {
  const r = live(MAIN_AND_TASKS, { isolate: true, extraEnv: { FAKE_CLAUDE_CONTROL_DELAYS: JSON.stringify({ initialize: 3000 }) } });
  try {
    await r.waitFor(/> $/);
    r.line('first main');
    await r.waitFor(/MAIN-ANSWER to first main[\s\S]*> $/);
    const mark = r.o().length;
    r.line('/chat new');
    await sleepMs(300);
    r.ctrlC();
    await sleepMs(50);
    r.ctrlC();
    await r.waitFor(/Started a new chat session[\s\S]*> $/, 15_000, mark);
    const after = r.o().slice(mark);
    assert.ok(!/did not stop|Failed to execute command/.test(after), after);
    assert.ok(!/To exit the CLI/.test(after), after);
    const m2 = r.o().length;
    r.line('main again');
    await r.waitFor(/MAIN-ANSWER to main again[\s\S]*> $/, 15_000, m2);
    r.line('/quit');
    assert.equal(await r.exit, 0);
  } finally {
    r.end();
    await r.exit.catch(() => undefined);
    r.t.cleanup();
  }
});

test('e2e: Ctrl+C while /spec new --type quick starts its questions session cancels the flow; no turn is sent and the REPL goes on (F0/F3)', { timeout: 60_000 }, async () => {
  const script = {
    turns: [
      { repeat: true, match: 'Quick Spec', steps: [{ text: 'QUESTIONS [1]: a / b' }] },
      { repeat: true, match: 'Phase: REQUIREMENTS', steps: [{ text: 'DRAFTING-REQUIREMENTS' }] },
      { repeat: true, match: 'main', steps: [{ text: 'MAIN-ANSWER to {{userText}}' }] },
    ],
  };
  const r = live(script, { isolate: true, extraEnv: { FAKE_CLAUDE_CONTROL_DELAYS: JSON.stringify({ initialize: 1500 }) } });
  try {
    await r.waitFor(/> $/);
    r.line('first main');
    await r.waitFor(/MAIN-ANSWER to first main[\s\S]*> $/);
    const mark = r.o().length;
    r.line('/spec new my-feature --type quick do it');
    await r.waitFor(/Created \.kiro\/specs\/my-feature/, 10_000, mark);
    await sleepMs(300); // the questions turn's session is still starting
    r.ctrlC();
    await r.waitFor(/✗ Quick Spec clarifying questions failed: interrupted[\s\S]*> $/, 20_000, mark);
    const after = r.o().slice(mark);
    assert.ok(!/QUESTIONS|DRAFTING-REQUIREMENTS|Answer with/.test(after), after);
    assert.ok(!userLines(r.log()).some((u) => u.includes('Quick Spec') || u.includes('Phase: REQUIREMENTS')), 'a spec turn was sent after the Ctrl+C');
    assert.ok(!/To exit the CLI|did not stop/.test(after), after);
    const m2 = r.o().length;
    r.line('back to main');
    await r.waitFor(/MAIN-ANSWER to back to main[\s\S]*> $/, 15_000, m2);
    r.line('/quit');
    assert.equal(await r.exit, 0);
  } finally {
    r.end();
    await r.exit.catch(() => undefined);
    r.t.cleanup();
  }
});

test('e2e: a /spec run task turn that ignores the interrupt is stopped by the second Ctrl+C; only the task session is closed and the run stops (F0, C16)', { timeout: 60_000 }, async () => {
  const script = {
    turns: [
      { repeat: true, match: 'Execute Task: 1\\.1', steps: [{ text: 'working on 1.1' }, { sleepMs: 100000 }, { text: 'TASK_RESULT: completed' }] },
      { repeat: true, match: 'Execute Task: 2\\.1', steps: [{ text: 'TASK_RESULT: completed' }] },
      { repeat: true, match: 'main', steps: [{ text: 'MAIN-ANSWER to {{userText}}' }] },
    ],
  };
  const r = live(script, { isolate: true, extraEnv: { FAKE_CLAUDE_CONTROL_DELAYS: JSON.stringify({ interrupt: 120000 }) } });
  try {
    writeTodoSpec(r);
    await r.waitFor(/> $/);
    r.line('first main');
    await r.waitFor(/MAIN-ANSWER to first main[\s\S]*> $/);
    const mark = r.o().length;
    r.line('/spec run todo-export 1.1 2.1');
    await r.waitFor(/working on 1\.1/, 15_000, mark);
    r.ctrlC();
    await sleepMs(100);
    r.ctrlC();
    await r.waitFor(/Spec run finished[\s\S]*> $/, 20_000, mark);
    const after = r.o().slice(mark);
    assert.match(after, /stopping it\./);
    assert.match(after, /✗ Task 1\.1 interrupted/);
    assert.ok(!/▶ Task 2\.1/.test(after), after);
    assert.ok(!/Failed to execute command/.test(after), `the command was abandoned:\n${after}`);
    const m2 = r.o().length;
    r.line('back to main');
    await r.waitFor(/MAIN-ANSWER to back to main[\s\S]*> $|The session is closed/, 20_000, m2);
    assert.match(r.o().slice(m2), /MAIN-ANSWER to back to main/, r.o().slice(m2));
    r.line('/quit');
    assert.equal(await r.exit, 0);
  } finally {
    r.end();
    await r.exit.catch(() => undefined);
    r.t.cleanup();
  }
});

// ───────────────────── Ctrl+C during /hooks run (G3/G4) ─────────────────────

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const HOOK_CASES: { label: string; tty: boolean; timeout?: number; presses: number }[] = [
  { label: 'terminal mode, timeout 0, one press', tty: true, timeout: 0, presses: 1 },
  { label: 'line mode, timeout 0, one press', tty: false, timeout: 0, presses: 1 },
  { label: 'line mode, default timeout, two presses', tty: false, presses: 2 },
];

for (const hc of HOOK_CASES) {
  test(`e2e: Ctrl+C during /hooks run kills the Manual hook (SIGTERM ignored) and gives the prompt back; Claude Code is neither stopped nor restarted (G3/G4, ${hc.label})`, { timeout: 60_000 }, async () => {
    // the session reads its hooks when it is created, so the hook file exists before the REPL
    // starts: a global hook file in a KIRO_HOME of the test's own (live() makes the workspace)
    const kiroHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kc-hookhome-')));
    const pidFile = path.join(kiroHome, 'hook.pid');
    const marker = path.join(kiroHome, 'hook.done');
    // the hook ignores SIGTERM/SIGINT/SIGHUP: only SIGKILL of its process group ends it
    const command = `trap '' TERM INT HUP; echo $$ > '${pidFile}'; sleep 30; touch '${marker}'; echo SLOW-DONE`;
    fs.mkdirSync(path.join(kiroHome, 'hooks'), { recursive: true });
    fs.writeFileSync(
      path.join(kiroHome, 'hooks', 'slow.json'),
      JSON.stringify({ version: 'v1', hooks: [{ name: 'slow', trigger: 'Manual', ...(hc.timeout !== undefined ? { timeout: hc.timeout } : {}), action: { type: 'command', command } }] }),
    );
    const r = live(MAIN_AND_TASKS, { isolate: true, tty: hc.tty, extraEnv: { KIRO_HOME: kiroHome } });
    let pid: number | undefined;
    let pidTicks: number | undefined;
    try {
      await r.waitFor(/> $/);
      r.line('first main');
      await r.waitFor(/MAIN-ANSWER to first main[\s\S]*> $/);
      const mark = r.o().length;
      r.line('/hooks run slow');
      const t0 = Date.now();
      while (!(fs.existsSync(pidFile) && /^\d+$/.test(fs.readFileSync(pidFile, 'utf8').trim()))) {
        if (Date.now() - t0 > 10_000) throw new Error(`the hook never started\n${r.o()}`);
        await sleepMs(25);
      }
      pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
      pidTicks = startTicksOf(pid); // who it is, for the cleanup kill (K6)
      const pressedAt = Date.now();
      r.ctrlC();
      if (hc.presses === 2) {
        await sleepMs(150);
        r.ctrlC();
      }
      await r.waitFor(/Hook 'slow' was cancelled\.\n\n[\s\S]*> $/, 5000, mark);
      assert.ok(Date.now() - pressedAt < 4000, `the prompt came back ${Date.now() - pressedAt} ms after the press`);
      const t1 = Date.now();
      while (pidAlive(pid) && Date.now() - t1 < 2000) await sleepMs(25);
      assert.ok(!pidAlive(pid), `hook process ${pid} still runs after the prompt came back`);
      assert.ok(!fs.existsSync(marker), 'the hook ran to completion');
      await sleepMs(1500); // past the forced-stop grace
      const after = r.o().slice(mark);
      assert.ok(!/SLOW-DONE|produced no output/.test(after), after);
      assert.ok(!/did not stop|Failed to execute command/.test(after), `the idle session was stopped or the command abandoned:\n${after}`);
      assert.equal(r.ended(), undefined, `the REPL quit:\n${after}`);
      const m2 = r.o().length;
      r.line('main again');
      await r.waitFor(/MAIN-ANSWER to main again[\s\S]*> $/, 15_000, m2);
      assert.equal(r.log().filter((e) => e.event === 'start' && (e.argv as string[]).includes('--input-format')).length, 1, 'Claude Code was not restarted');
      assert.equal(interruptRequests(r.log()), 0, 'the idle Claude Code got no interrupt');
      r.line('/quit');
      assert.equal(await r.exit, 0);
    } finally {
      // the shell's group, only while its leader is still the process whose pid was read: pids
      // are reused, and kill(-pid) after it died could hit an unrelated group (K6)
      if (pid !== undefined && pidTicks !== undefined && startTicksOf(pid) === pidTicks) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          /* gone */
        }
      }
      r.end();
      await r.exit.catch(() => undefined);
      r.t.cleanup();
      fs.rmSync(kiroHome, { recursive: true, force: true });
    }
  });
}

// ───────── after a spec flow the chat carries main's conversation (G0, spec) ─────────

/** Main turns answer with the user lines of the conversation they run in. */
const HISTORY_SCRIPT = (phase: { text: string } = { text: 'DRAFTED-NOTHING' }) => ({
  turns: [
    { repeat: true, match: 'Quick Spec|Phase: REQUIREMENTS', steps: [phase] },
    { repeat: true, steps: [{ text: 'ANSWER history=[{{historyUserTexts}}] END' }] },
  ],
});

/** The user lines of the conversation the next chat line runs in. */
async function nextLineHistory(r: ReturnType<typeof live>, line: string): Promise<string> {
  const m = r.o().length;
  r.line(line);
  await r.waitFor(/ANSWER history=\[[\s\S]*?\] END[\s\S]*> $/, 20_000, m);
  return /ANSWER history=\[([\s\S]*?)\] END/.exec(r.o().slice(m))![1]!;
}

for (const kind of ['feature', 'quick'] as const) {
  test(`e2e: a Ctrl+C that cancels /spec new${kind === 'quick' ? ' --type quick' : ''} before its first turn is sent leaves the chat in main's conversation (G0)`, { timeout: 60_000 }, async () => {
    // initialize answered late: the press lands while the phase session's Claude Code starts; the
    // fake writes a fork's transcript only with its first user line, like the real claude
    const r = live(HISTORY_SCRIPT(), { isolate: true, extraEnv: { FAKE_CLAUDE_CONTROL_DELAYS: JSON.stringify({ initialize: 1500 }) } });
    try {
      await r.waitFor(/> $/);
      r.line('remember CODEWORD-PELICAN');
      await r.waitFor(/ANSWER history=\[remember CODEWORD-PELICAN\] END[\s\S]*> $/);
      const mark = r.o().length;
      r.line(`/spec new my-feature --type ${kind}${kind === 'feature' ? ' --workflow requirements-first' : ''} a csv export`);
      await r.waitFor(/Created \.kiro\/specs\/my-feature\//, 10_000, mark);
      await sleepMs(300);
      r.ctrlC();
      await r.waitFor(kind === 'quick' ? /Quick Spec clarifying questions failed: interrupted[\s\S]*> $/ : /Drafting requirements\.md failed: interrupted[\s\S]*> $/, 20_000, mark);
      assert.ok(!sentLines(r).some((u) => u.includes('Quick Spec') || u.includes('Phase: REQUIREMENTS')), 'precondition: the spec turn was cancelled before it was sent');
      const h = await nextLineHistory(r, 'which code word?');
      assert.equal(h, 'remember CODEWORD-PELICAN | which code word?', `the chat does not continue main's conversation:\n${r.o().slice(mark)}`);
      assert.ok(!/could not find the saved conversation/.test(r.o().slice(mark)), r.o().slice(mark));
      r.line('/quit');
      assert.equal(await r.exit, 0);
    } finally {
      r.end();
      await r.exit.catch(() => undefined);
      r.t.cleanup();
    }
  });
}

test('e2e: a /spec flow right after another one (its continuation has no message yet) keeps main and both flows in the chat (G0)', { timeout: 60_000 }, async () => {
  const r = live(HISTORY_SCRIPT(), { isolate: true });
  try {
    await r.waitFor(/> $/);
    r.line('remember CODEWORD-PELICAN');
    await r.waitFor(/ANSWER history=\[remember CODEWORD-PELICAN\] END[\s\S]*> $/);
    let mark = r.o().length;
    r.line('/spec new my-feature --type feature --workflow requirements-first a csv export');
    // the drafting turn runs (it writes nothing): Request changes… / Stop here
    await r.waitFor(/Stop here \(resume later with \/spec my-feature\)[\s\S]*$/, 20_000, mark);
    r.line('2');
    await r.waitFor(/Stopped at the requirements\.md checkpoint[\s\S]*> $/, 20_000, mark);
    // at once: the continuation the first flow handed over has not got a message yet
    mark = r.o().length;
    r.line('/spec my-feature');
    await r.waitFor(/What should the spec "my-feature" cover\?/, 20_000, mark);
    r.line('a tsv export too');
    await r.waitFor(/Stop here \(resume later with \/spec my-feature\)[\s\S]*$/, 20_000, mark);
    r.line('2');
    await r.waitFor(/Stopped at the requirements\.md checkpoint[\s\S]*> $/, 20_000, mark);
    const h = await nextLineHistory(r, 'which code word?');
    assert.ok(h.startsWith('remember CODEWORD-PELICAN | '), `the chat lost main's conversation:\n${h}`);
    assert.equal(h.match(/Phase: REQUIREMENTS\./g)?.length, 2, `both drafting turns are in the chat:\n${h}`);
    assert.match(h, /User description \(ground truth\): a csv export[\s\S]*User description \(ground truth\): a tsv export too/);
    assert.ok(h.endsWith(' | which code word?'), h);
    assert.ok(!/could not find the saved conversation/.test(r.o()), r.o());
    r.line('/quit');
    assert.equal(await r.exit, 0);
  } finally {
    r.end();
    await r.exit.catch(() => undefined);
    r.t.cleanup();
  }
});

test('e2e: /spec new right after /tangent (the tangent has no message yet) keeps main\'s conversation in the chat (G0)', { timeout: 60_000 }, async () => {
  const r = live(HISTORY_SCRIPT(), { isolate: true });
  try {
    await r.waitFor(/> $/);
    r.line('remember CODEWORD-PELICAN');
    await r.waitFor(/ANSWER history=\[remember CODEWORD-PELICAN\] END[\s\S]*> $/);
    let mark = r.o().length;
    r.line('/tangent');
    await r.waitFor(/> $/, 20_000, mark);
    mark = r.o().length;
    r.line('/spec new my-feature --type feature --workflow requirements-first a csv export');
    await r.waitFor(/Stop here \(resume later with \/spec my-feature\)[\s\S]*$/, 20_000, mark);
    r.line('2');
    await r.waitFor(/Stopped at the requirements\.md checkpoint[\s\S]*> $/, 20_000, mark);
    const h = await nextLineHistory(r, 'which code word?');
    assert.ok(h.startsWith('remember CODEWORD-PELICAN | '), `the chat lost main's conversation:\n${h}`);
    assert.equal(h.match(/Phase: REQUIREMENTS\./g)?.length, 1, h);
    assert.ok(h.endsWith(' | which code word?'), h);
    r.line('/quit');
    assert.equal(await r.exit, 0);
  } finally {
    r.end();
    await r.exit.catch(() => undefined);
    r.t.cleanup();
  }
});

// ───── G0 (spec, verifier): turns that reached Claude, forced stops, a Ctrl+C at a later phase ─────

/**
 * The user lines the fake logged so far. Read while fakes run (polling, a session closing in the
 * background): a line still being written is skipped instead of failing JSON.parse.
 */
function loggedEntries(r: ReturnType<typeof live>): Record<string, unknown>[] {
  const file = path.join(r.t.root, 'fake.log');
  if (!fs.existsSync(file)) return [];
  const entries: Record<string, unknown>[] = [];
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!l) continue;
    try {
      entries.push(JSON.parse(l) as Record<string, unknown>);
    } catch {
      // being written
    }
  }
  return entries;
}

function sentLines(r: ReturnType<typeof live>): string[] {
  return userLines(loggedEntries(r));
}

/** A spec "my-feature" whose requirements.md waits for review. */
function writeReviewSpec(r: ReturnType<typeof live>): void {
  const dir = path.join(r.t.wsDir, '.kiro', 'specs', 'my-feature');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'requirements.md'), REQ_MD);
}

test('e2e: a revision turn reaches Claude, then a Ctrl+C cancels the design turn while its session starts: the chat carries main and the revision (G0)', { timeout: 60_000 }, async () => {
  const script = {
    turns: [
      { repeat: true, match: 'per this feedback|Phase: DESIGN', steps: [{ text: 'REVISED' }] },
      { repeat: true, steps: [{ text: 'ANSWER history=[{{historyUserTexts}}] END' }] },
    ],
  };
  // initialize answered late: the press lands while the design session's Claude Code starts
  const r = live(script, { isolate: true, extraEnv: { FAKE_CLAUDE_CONTROL_DELAYS: JSON.stringify({ initialize: 1500 }) } });
  try {
    writeReviewSpec(r);
    await r.waitFor(/> $/);
    r.line('remember CODEWORD-PELICAN');
    await r.waitFor(/ANSWER history=\[remember CODEWORD-PELICAN\] END[\s\S]*> $/);
    const mark = r.o().length;
    r.line('/spec my-feature');
    await r.waitFor(/Stop here \(resume later with \/spec my-feature\)/, 20_000, mark);
    r.line('Request');
    await r.waitFor(/What should change in requirements\.md\?/, 20_000, mark);
    r.line('also a tsv export');
    await r.waitFor(/REVISED[\s\S]*Stop here \(resume later with \/spec my-feature\)/, 20_000, mark);
    r.line('Approve');
    await sleepMs(300); // the design session is still starting
    r.ctrlC();
    await r.waitFor(/Drafting design\.md failed: interrupted[\s\S]*> $/, 20_000, mark);
    assert.ok(sentLines(r).some((u) => u.includes('per this feedback')), 'precondition: the revision turn was sent');
    assert.ok(!sentLines(r).some((u) => u.includes('Phase: DESIGN')), 'precondition: the design turn was cancelled before it was sent');
    const h = await nextLineHistory(r, 'which code word?');
    assert.ok(h.startsWith('remember CODEWORD-PELICAN | '), `the chat lost main's conversation:\n${h}`);
    assert.match(h, /per this feedback[\s\S]*also a tsv export/, `the revision turn is not in the chat:\n${h}`);
    assert.ok(h.endsWith(' | which code word?'), h);
    assert.ok(!/could not find the saved conversation/.test(r.o().slice(mark)), r.o().slice(mark));
    r.line('/quit');
    assert.equal(await r.exit, 0);
  } finally {
    r.end();
    await r.exit.catch(() => undefined);
    r.t.cleanup();
  }
});

test('e2e: a Ctrl+C during a drafting turn Claude already got (interrupted, not cancelled before the send) keeps main and the turn in the chat (G0)', { timeout: 60_000 }, async () => {
  const script = {
    turns: [
      { repeat: true, match: 'Phase: REQUIREMENTS', steps: [{ sleepMs: 10_000 }, { text: 'DRAFTED' }] },
      { repeat: true, steps: [{ text: 'ANSWER history=[{{historyUserTexts}}] END' }] },
    ],
  };
  const r = live(script, { isolate: true });
  try {
    await r.waitFor(/> $/);
    r.line('remember CODEWORD-PELICAN');
    await r.waitFor(/ANSWER history=\[remember CODEWORD-PELICAN\] END[\s\S]*> $/);
    const mark = r.o().length;
    r.line('/spec new my-feature --type feature --workflow requirements-first a csv export');
    // the drafting turn has started (its line was sent): interrupt it
    const t0 = Date.now();
    while (!sentLines(r).some((u) => u.includes('Phase: REQUIREMENTS'))) {
      if (Date.now() - t0 > 15_000) throw new Error(`the drafting turn was never sent\n${r.o()}`);
      await sleepMs(25);
    }
    await sleepMs(100);
    r.ctrlC();
    await r.waitFor(/Drafting requirements\.md failed: interrupted[\s\S]*> $/, 20_000, mark);
    assert.equal(interruptRequests(loggedEntries(r)), 1, 'precondition: the press interrupted the running turn');
    const h = await nextLineHistory(r, 'which code word?');
    assert.ok(h.startsWith('remember CODEWORD-PELICAN | '), `the chat lost main's conversation:\n${h}`);
    assert.equal(h.match(/Phase: REQUIREMENTS\./g)?.length, 1, `the interrupted drafting turn is not in the chat:\n${h}`);
    assert.ok(h.endsWith(' | which code word?'), h);
    assert.ok(!/could not find the saved conversation/.test(r.o().slice(mark)), r.o().slice(mark));
    r.line('/quit');
    assert.equal(await r.exit, 0);
  } finally {
    r.end();
    await r.exit.catch(() => undefined);
    r.t.cleanup();
  }
});

test('e2e: a forced stop (Claude ignores the interrupt) of a drafting turn leaves the chat in main\'s conversation, open (G0)', { timeout: 60_000 }, async () => {
  const script = {
    turns: [
      { repeat: true, match: 'Phase: REQUIREMENTS', steps: [{ sleepMs: 30_000 }, { text: 'DRAFTED' }] },
      { repeat: true, steps: [{ text: 'ANSWER history=[{{historyUserTexts}}] END' }] },
    ],
  };
  // the interrupt is answered late: Claude Code does not stop, the second press stops it
  const r = live(script, { isolate: true, extraEnv: { FAKE_CLAUDE_CONTROL_DELAYS: JSON.stringify({ interrupt: 120_000 }) } });
  try {
    await r.waitFor(/> $/);
    r.line('remember CODEWORD-PELICAN');
    await r.waitFor(/ANSWER history=\[remember CODEWORD-PELICAN\] END[\s\S]*> $/);
    const mark = r.o().length;
    r.line('/spec new my-feature --type feature --workflow requirements-first a csv export');
    const t0 = Date.now();
    while (!sentLines(r).some((u) => u.includes('Phase: REQUIREMENTS'))) {
      if (Date.now() - t0 > 15_000) throw new Error(`the drafting turn was never sent\n${r.o()}`);
      await sleepMs(25);
    }
    await sleepMs(200);
    r.ctrlC();
    await sleepMs(100);
    r.ctrlC();
    await r.waitFor(/Drafting requirements\.md failed[\s\S]*> $/, 30_000, mark);
    assert.match(r.o().slice(mark), /did not stop after the interrupt; stopping it/, 'precondition: Claude Code was stopped');
    const h = await nextLineHistory(r, 'which code word?');
    assert.ok(h.startsWith('remember CODEWORD-PELICAN | '), `the chat lost main's conversation:\n${h}`);
    assert.ok(h.endsWith(' | which code word?'), h);
    assert.ok(!/could not find the saved conversation|The session is closed/.test(r.o().slice(mark)), r.o().slice(mark));
    r.line('/quit');
    assert.equal(await r.exit, 0);
  } finally {
    r.end();
    await r.exit.catch(() => undefined);
    r.t.cleanup();
  }
});

test('e2e: a /tangent merge carry still queued on main survives an analyze turn cancelled before its send and reaches the chat once, through the design turn (G0, G1)', { timeout: 90_000 }, async () => {
  const script = {
    turns: [
      { repeat: true, match: '^Summarize the findings', steps: [{ text: 'SUMMARY-FOUND_X' }] },
      { repeat: true, match: 'side finding', steps: [{ text: 'SIDE-ANSWER' }] },
      { repeat: true, match: 'Phase: DESIGN', steps: [{ text: 'DESIGNED' }] },
      { repeat: true, steps: [{ text: 'ANSWER history=[{{historyUserTexts}}] END' }] },
    ],
  };
  const r = live(script, { isolate: true, extraEnv: { FAKE_CLAUDE_CONTROL_DELAYS: JSON.stringify({ initialize: 1500 }) } });
  try {
    writeReviewSpec(r);
    await r.waitFor(/> $/);
    r.line('remember CODEWORD-PELICAN');
    await r.waitFor(/ANSWER history=\[remember CODEWORD-PELICAN\] END[\s\S]*> $/);
    let mark = r.o().length;
    r.line('/tangent research');
    await r.waitFor(/Created a conversation checkpoint[\s\S]*> $/, 20_000, mark);
    r.line('side finding FOUND_X');
    await r.waitFor(/SIDE-ANSWER[\s\S]*> $/, 20_000, mark);
    mark = r.o().length;
    r.line('/tangent merge');
    await r.waitFor(/Merged the tangent[\s\S]*> $/, 30_000, mark);
    const before = sentLines(r).length;
    mark = r.o().length;
    r.line('/spec my-feature');
    await r.waitFor(/Stop here \(resume later with \/spec my-feature\)/, 20_000, mark);
    r.line('Analyze');
    await r.waitFor(/Analyzing requirements\.md/, 20_000, mark);
    await sleepMs(300); // the analyze session is still starting
    r.ctrlC();
    await r.waitFor(/Analysis failed: interrupted[\s\S]*Stop here \(resume later with \/spec my-feature\)[\s\S]*$/, 20_000, mark);
    r.line('Approve');
    await r.waitFor(/DESIGNED[\s\S]*Stop here \(resume later with \/spec my-feature\)[\s\S]*$/, 30_000, mark);
    r.line('Stop');
    await r.waitFor(/Stopped at the design\.md checkpoint[\s\S]*> $/, 20_000, mark);
    const h = await nextLineHistory(r, 'what did the tangent find?');
    assert.ok(h.startsWith('remember CODEWORD-PELICAN | '), `the chat lost main's conversation:\n${h}`);
    const carrying = sentLines(r)
      .slice(before)
      .filter((u) => u.includes('<tangent-summary') && u.includes('SUMMARY-FOUND_X'));
    assert.equal(carrying.length, 1, `the merge carry must reach Claude exactly once after the merge:\n${sentLines(r).slice(before).map((u) => u.slice(0, 100)).join('\n')}`);
    assert.match(h, /SUMMARY-FOUND_X[\s\S]*Phase: DESIGN|Phase: DESIGN[\s\S]*SUMMARY-FOUND_X/, `the carry is not in the chat's conversation:\n${h}`);
    assert.ok(h.endsWith(' | what did the tangent find?'), h);
    r.line('/quit');
    assert.equal(await r.exit, 0);
  } finally {
    r.end();
    await r.exit.catch(() => undefined);
    r.t.cleanup();
  }
});

/**
 * The real runRepl over fake claude in an existing temp env `t` (so a second run sees the first
 * run's sessions), with extra session options (e.g. `resume`).
 */
function liveIn(t: ReturnType<typeof tempEnv>, script: unknown, sessionOptions: Record<string, unknown> = {}) {
  fs.mkdirSync(path.join(t.root, 'run'), { recursive: true, mode: 0o700 });
  const env = fakeEnv({
    ...t.env,
    KIRO_HOME: path.join(t.home, '.kiro'),
    XDG_RUNTIME_DIR: path.join(t.root, 'run'),
    XDG_CACHE_HOME: path.join(t.root, 'cache'),
    FAKE_CLAUDE_SCRIPT_JSON: JSON.stringify(script),
    FAKE_CLAUDE_PERSIST: '1',
    KIRO_CLAUDE_BIN: fakeClaudePath(),
  });
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
  const exit = runRepl({ ctx, sessionOptions: { env, claudePath: fakeClaudePath(), ...sessionOptions } });
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
        await new Promise((r) => setTimeout(r, 25));
      }
    },
  };
}

for (const viaSpec of [false, true]) {
  test(
    `e2e: a chat resumed after its Claude transcript was lost (the saved history goes with the next line) keeps main's history${viaSpec ? ' through a /spec flow that reached Claude (G0)' : ' (control)'}`,
    // the spec phase session forks from main's new Claude session, which has no transcript yet
    // (main's saved history waits for main's next line): it falls back to a new conversation and
    // restores main's history from its own record's journal, a copy of main's that create({fork})
    // makes (S1), and its record carries main's turns (K1). The continuation that finish('keep')
    // hands to the chat forks the phase session, so the chat keeps main's history.
    { timeout: 60_000 },
    async () => {
      const script = {
        turns: [
          { repeat: true, match: 'Phase: REQUIREMENTS', steps: [{ text: 'DRAFTED' }] },
          { repeat: true, steps: [{ text: 'ANSWER history=[{{historyUserTexts}}] END' }] },
        ],
      };
      const t = tempEnv();
      try {
        let r = liveIn(t, script);
        await r.waitFor(/> $/);
        r.line('remember CODEWORD-PELICAN');
        await r.waitFor(/ANSWER history=\[remember CODEWORD-PELICAN\] END[\s\S]*> $/);
        r.line('/quit');
        assert.equal(await r.exit, 0);
        const sdir = t.env.KIRO_CLAUDE_SESSIONS_DIR!;
        const rec = fs
          .readdirSync(sdir)
          .filter((f) => f.endsWith('.json'))
          .map((f) => JSON.parse(fs.readFileSync(path.join(sdir, f), 'utf8')) as { sessionId: string; turns?: unknown[] })
          .find((x) => (x.turns?.length ?? 0) > 0)!;
        // the Claude transcript is gone (e.g. a fork closed before its first message)
        const pdir = path.join(t.env.CLAUDE_CONFIG_DIR!, 'projects');
        for (const d of fs.readdirSync(pdir)) fs.rmSync(path.join(pdir, d), { recursive: true, force: true });
        r = liveIn(t, script, { resume: { sessionId: rec.sessionId } });
        try {
          await r.waitFor(/> $/);
          let mark = r.o().length;
          if (viaSpec) {
            r.line('/spec new my-feature --type feature --workflow requirements-first a csv export');
            await r.waitFor(/Stop here \(resume later with \/spec my-feature\)/, 20_000, mark);
            r.line('Stop');
            await r.waitFor(/Stopped at the requirements\.md checkpoint[\s\S]*> $/, 20_000, mark);
          }
          mark = r.o().length;
          r.line('which code word?');
          await r.waitFor(/ANSWER history=\[[\s\S]*?\] END[\s\S]*> $/, 20_000, mark);
          const h = /ANSWER history=\[([\s\S]*?)\] END/.exec(r.o().slice(mark))![1]!;
          assert.match(h, /CODEWORD-PELICAN/, `the chat lost main's history:\n${h.slice(0, 400)}`);
          r.line('/quit');
          assert.equal(await r.exit, 0);
        } finally {
          r.end();
          await r.exit.catch(() => undefined);
        }
      } finally {
        t.cleanup();
      }
    },
  );
}

test('e2e: a double Ctrl+C while the /spec new requirements session starts cancels the flow, stops nothing and leaves the chat in main\'s conversation (G0, F0)', { timeout: 60_000 }, async () => {
  const r = live(HISTORY_SCRIPT(), { isolate: true, extraEnv: { FAKE_CLAUDE_CONTROL_DELAYS: JSON.stringify({ initialize: 2000 }) } });
  try {
    await r.waitFor(/> $/);
    r.line('remember CODEWORD-PELICAN');
    await r.waitFor(/ANSWER history=\[remember CODEWORD-PELICAN\] END[\s\S]*> $/);
    const mark = r.o().length;
    r.line('/spec new my-feature --type feature --workflow requirements-first a csv export');
    await r.waitFor(/Created \.kiro\/specs\/my-feature\//, 10_000, mark);
    await sleepMs(300);
    r.ctrlC();
    await sleepMs(50);
    r.ctrlC();
    await r.waitFor(/Drafting requirements\.md failed: interrupted[\s\S]*> $/, 20_000, mark);
    await sleepMs(1500); // past the forced-stop grace
    const after = r.o().slice(mark);
    assert.ok(!/did not stop|Failed to execute command|To exit the CLI/.test(after), after);
    assert.equal(r.ended(), undefined, `the REPL quit:\n${after}`);
    assert.ok(!sentLines(r).some((u) => u.includes('Phase: REQUIREMENTS')), 'precondition: the drafting turn was cancelled before it was sent');
    const h = await nextLineHistory(r, 'which code word?');
    assert.equal(h, 'remember CODEWORD-PELICAN | which code word?', `the chat does not continue main's conversation:\n${r.o().slice(mark)}`);
    r.line('/quit');
    assert.equal(await r.exit, 0);
  } finally {
    r.end();
    await r.exit.catch(() => undefined);
    r.t.cleanup();
  }
});

// ───── P3 (spec): /spec new straight after a flow uses the conversation it carries ─────

test('e2e: /spec new straight after another flow (its continuation has no message yet) asks to use the conversation so far, which it carries (P3)', { timeout: 60_000 }, async () => {
  const r = live(HISTORY_SCRIPT({ text: 'DRAFTED history=[{{historyUserTexts}}] END' }), { isolate: true });
  try {
    await r.waitFor(/> $/);
    r.line('remember CODEWORD-PELICAN');
    await r.waitFor(/ANSWER history=\[remember CODEWORD-PELICAN\] END[\s\S]*> $/);
    let mark = r.o().length;
    r.line('/spec new first-spec --type feature --workflow requirements-first a csv export');
    await r.waitFor(/Stop here \(resume later with \/spec first-spec\)[\s\S]*$/, 20_000, mark);
    r.line('2');
    await r.waitFor(/Stopped at the requirements\.md checkpoint[\s\S]*> $/, 20_000, mark);
    // at once: the continuation the first flow handed over has not got a message yet
    mark = r.o().length;
    r.line('/spec new second-spec --type feature --workflow requirements-first a tsv export');
    await r.waitFor(/Stop here \(resume later with \/spec second-spec\)[\s\S]*$/, 20_000, mark);
    const drafts = sentLines(r).filter((u) => u.includes('Phase: REQUIREMENTS'));
    assert.equal(drafts.length, 2, JSON.stringify(drafts));
    assert.ok(drafts[0]!.includes('Use the conversation so far as input.'), `control: main had a turn:\n${drafts[0]}`);
    assert.ok(drafts[1]!.includes('Use the conversation so far as input.'), `the second flow does not use the carried conversation:\n${drafts[1]}`);
    // and the conversation is carried indeed: the second drafting turn ran in main's conversation
    assert.match(r.o().slice(mark), /DRAFTED history=\[remember CODEWORD-PELICAN \| [\s\S]*a tsv export[\s\S]*?\] END/);
    r.line('2');
    await r.waitFor(/Stopped at the requirements\.md checkpoint[\s\S]*> $/, 20_000, mark);
    r.line('/quit');
    assert.equal(await r.exit, 0);
  } finally {
    r.end();
    await r.exit.catch(() => undefined);
    r.t.cleanup();
  }
});

test('e2e: /spec new as the first line of a chat does not ask to use the conversation (P3 control)', { timeout: 60_000 }, async () => {
  const r = live(HISTORY_SCRIPT(), { isolate: true });
  try {
    await r.waitFor(/> $/);
    const mark = r.o().length;
    r.line('/spec new first-spec --type feature --workflow requirements-first a csv export');
    await r.waitFor(/Stop here \(resume later with \/spec first-spec\)[\s\S]*$/, 20_000, mark);
    const drafts = sentLines(r).filter((u) => u.includes('Phase: REQUIREMENTS'));
    assert.equal(drafts.length, 1, JSON.stringify(drafts));
    assert.ok(!drafts[0]!.includes('Use the conversation so far'), drafts[0]);
    r.line('2');
    await r.waitFor(/Stopped at the requirements\.md checkpoint[\s\S]*> $/, 20_000, mark);
    r.line('/quit');
    assert.equal(await r.exit, 0);
  } finally {
    r.end();
    await r.exit.catch(() => undefined);
    r.t.cleanup();
  }
});

// ───── Ctrl+C during /chat save-via-script and load-via-script (R1) ─────

const VIA_SCRIPT_CASES: { cmd: 'save' | 'load'; tty: boolean; presses: number }[] = [
  { cmd: 'save', tty: false, presses: 1 },
  { cmd: 'save', tty: true, presses: 2 },
  { cmd: 'load', tty: false, presses: 2 },
  { cmd: 'load', tty: true, presses: 1 },
];

for (const vc of VIA_SCRIPT_CASES) {
  const label = `${vc.tty ? 'terminal' : 'line'} mode, ${vc.presses} press${vc.presses > 1 ? 'es' : ''}`;
  test(`e2e: Ctrl+C during /chat ${vc.cmd}-via-script kills the script (SIGTERM ignored) and gives the prompt back; it reports neither success nor failure, ${vc.cmd === 'load' ? 'loads nothing of what the script printed, ' : ''}and Claude Code is neither stopped nor restarted (R1, ${label})`, { timeout: 60_000 }, async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kc-viascript-')));
    const pidFile = path.join(dir, 'script.pid');
    const marker = path.join(dir, 'script.done');
    const exportFile = path.join(dir, 'export.json');
    const r = live(MAIN_AND_TASKS, { isolate: true, tty: vc.tty });
    let pid: number | undefined;
    let pidTicks: number | undefined;
    try {
      await r.waitFor(/> $/);
      r.line('first main');
      await r.waitFor(/MAIN-ANSWER to first main[\s\S]*> $/);
      let mark = r.o().length;
      if (vc.cmd === 'load') {
        // a complete export the script prints before it hangs: a cancelled run must not load it
        r.line(`/chat save ${exportFile}`);
        await r.waitFor(/Exported conversation state to[\s\S]*> $/, 10_000, mark);
        mark = r.o().length;
      }
      // the script ignores SIGTERM/SIGINT/SIGHUP: only SIGKILL of its process group ends it
      const body = vc.cmd === 'save' ? 'cat > /dev/null; sleep 30' : `cat '${exportFile}'; sleep 30`;
      r.line(`/chat ${vc.cmd}-via-script trap '' TERM INT HUP; echo $$ > '${pidFile}'; ${body}; touch '${marker}'`);
      const t0 = Date.now();
      while (!(fs.existsSync(pidFile) && /^\d+$/.test(fs.readFileSync(pidFile, 'utf8').trim()))) {
        if (Date.now() - t0 > 10_000) throw new Error(`the script never started\n${r.o()}`);
        await sleepMs(25);
      }
      pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
      pidTicks = startTicksOf(pid); // who it is, for the cleanup kill (K6)
      await sleepMs(200); // the load script has printed its export
      const pressedAt = Date.now();
      r.ctrlC();
      if (vc.presses === 2) {
        await sleepMs(150);
        r.ctrlC();
      }
      const what = vc.cmd === 'save' ? 'Export' : 'Import';
      await r.waitFor(new RegExp(`${what} via [\\s\\S]*? was cancelled\\.\\n\\n[\\s\\S]*> $`), 5000, mark);
      assert.ok(Date.now() - pressedAt < 4000, `the prompt came back ${Date.now() - pressedAt} ms after the press`);
      const t1 = Date.now();
      while (pidAlive(pid) && Date.now() - t1 < 2000) await sleepMs(25);
      assert.ok(!pidAlive(pid), `script process ${pid} still runs after the prompt came back`);
      assert.ok(!fs.existsSync(marker), 'the script ran to completion');
      await sleepMs(1500); // past the forced-stop grace
      const after = r.o().slice(mark);
      assert.ok(!/✔ (Exported|Imported) conversation state via|Failed to (export|import) via/.test(after), after);
      assert.ok(!/did not stop|Failed to execute command/.test(after), `the idle session was stopped or the command abandoned:\n${after}`);
      assert.equal(r.ended(), undefined, `the REPL quit:\n${after}`);
      const m2 = r.o().length;
      r.line('main again');
      await r.waitFor(/MAIN-ANSWER to main again[\s\S]*> $/, 15_000, m2);
      // one Claude Code child all along: not restarted, and no imported session was started
      assert.equal(r.log().filter((e) => e.event === 'start' && (e.argv as string[]).includes('--input-format')).length, 1, 'Claude Code was restarted or the export was imported');
      assert.equal(interruptRequests(r.log()), 0, 'the idle Claude Code got an interrupt');
      r.line('/quit');
      assert.equal(await r.exit, 0);
    } finally {
      // the shell's group, only while its leader is still the process whose pid was read: pids
      // are reused, and kill(-pid) after it died could hit an unrelated group (K6)
      if (pid !== undefined && pidTicks !== undefined && startTicksOf(pid) === pidTicks) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          /* gone */
        }
      }
      r.end();
      await r.exit.catch(() => undefined);
      r.t.cleanup();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

// ───── spec verifier (P1/P3): the stock fake refuses a fork at a lost message; /clear after a flow ─────

test('e2e: /spec new right after /rewind 1 in a chat that fell back to a fresh Claude session (turn 1\'s uuid named the lost transcript) drafts over turn 1 only; the rewound turns never come back (P1, stock fake)', { timeout: 90_000 }, async () => {
  const script = {
    turns: [
      { repeat: true, match: 'Phase: REQUIREMENTS', steps: [{ text: 'DRAFTED history=[{{historyUserTexts}}] END' }] },
      { repeat: true, steps: [{ text: 'ANSWER history=[{{historyUserTexts}}] END' }] },
    ],
  };
  const t = tempEnv();
  try {
    let r = liveIn(t, script);
    await r.waitFor(/> $/);
    r.line('first ALPHA_1');
    await r.waitFor(/ANSWER history=\[first ALPHA_1\] END[\s\S]*> $/);
    let mark = r.o().length;
    r.line('second BETA_2');
    await r.waitFor(/ANSWER history=\[[^\]]*BETA_2\] END[\s\S]*> $/, 20_000, mark);
    r.line('/quit');
    assert.equal(await r.exit, 0);
    const sdir = t.env.KIRO_CLAUDE_SESSIONS_DIR!;
    const rec = fs
      .readdirSync(sdir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(sdir, f), 'utf8')) as { sessionId: string; turns?: unknown[] })
      .find((x) => (x.turns?.length ?? 0) === 2)!;
    // the Claude transcript is gone: the resume falls back to a fresh Claude session (G2)
    const pdir = path.join(t.env.CLAUDE_CONFIG_DIR!, 'projects');
    for (const d of fs.readdirSync(pdir)) fs.rmSync(path.join(pdir, d), { recursive: true, force: true });
    r = liveIn(t, script, { resume: { sessionId: rec.sessionId } });
    try {
      await r.waitFor(/> $/);
      mark = r.o().length;
      r.line('third GAMMA_3');
      await r.waitFor(/ANSWER history=\[[\s\S]*?GAMMA_3[\s\S]*?\] END[\s\S]*> $/, 20_000, mark);
      mark = r.o().length;
      r.line('/rewind 1');
      await r.waitFor(/> $/, 20_000, mark);
      mark = r.o().length;
      r.line('/spec new my-feature --type feature --workflow requirements-first a csv export');
      await r.waitFor(/Stop here \(resume later with \/spec my-feature\)/, 20_000, mark);
      // (greedy: the restored history quotes earlier answers, `… END` included)
      const drafted = /DRAFTED history=\[([\s\S]*)\] END/.exec(r.o().slice(mark))?.[1] ?? '';
      assert.match(drafted, /ALPHA_1/, `the drafting turn lost turn 1:\n${r.o().slice(mark)}`);
      assert.doesNotMatch(drafted, /BETA_2|GAMMA_3/, `the rewound turns came back in the drafting turn:\n${drafted}`);
      // (its last user text is the drafting line itself)
      assert.match(drafted, /Use the conversation so far as input\.\s*User description \(ground truth\): a csv export/, `the rewound chat has history:\n${drafted}`);
      r.line('Stop');
      await r.waitFor(/Stopped at the requirements\.md checkpoint[\s\S]*> $/, 20_000, mark);
      mark = r.o().length;
      r.line('which code word?');
      await r.waitFor(/ANSWER history=\[[\s\S]*?\] END[\s\S]*> $/, 20_000, mark);
      const h = /ANSWER history=\[([\s\S]*)\] END/.exec(r.o().slice(mark))![1]!;
      assert.match(h, /ALPHA_1/, `the chat lost turn 1:\n${h.slice(0, 600)}`);
      assert.match(h, /Phase: REQUIREMENTS/, `the chat lost the drafting turn:\n${h.slice(0, 600)}`);
      assert.doesNotMatch(h, /BETA_2|GAMMA_3/, `the rewound turns came back:\n${h.slice(0, 600)}`);
      r.line('/quit');
      assert.equal(await r.exit, 0);
    } finally {
      r.end();
      await r.exit.catch(() => undefined);
    }
  } finally {
    t.cleanup();
  }
});

test('e2e: /spec new after /clear in the continuation a flow handed over does not ask to use the (cleared) conversation (P3)', { timeout: 60_000 }, async () => {
  const r = live(HISTORY_SCRIPT({ text: 'DRAFTED history=[{{historyUserTexts}}] END' }), { isolate: true });
  try {
    await r.waitFor(/> $/);
    r.line('remember CODEWORD-PELICAN');
    await r.waitFor(/ANSWER history=\[remember CODEWORD-PELICAN\] END[\s\S]*> $/);
    let mark = r.o().length;
    r.line('/spec new first-spec --type feature --workflow requirements-first a csv export');
    await r.waitFor(/Stop here \(resume later with \/spec first-spec\)[\s\S]*$/, 20_000, mark);
    r.line('2');
    await r.waitFor(/Stopped at the requirements\.md checkpoint[\s\S]*> $/, 20_000, mark);
    mark = r.o().length;
    r.line('/clear');
    await r.waitFor(/\[y\/n\]:/, 20_000, mark);
    r.line('y');
    await r.waitFor(/> $/, 20_000, mark);
    mark = r.o().length;
    r.line('/spec new second-spec --type feature --workflow requirements-first a tsv export');
    await r.waitFor(/Stop here \(resume later with \/spec second-spec\)[\s\S]*$/, 20_000, mark);
    const drafted = /DRAFTED history=\[([\s\S]*)\] END/.exec(r.o().slice(mark))?.[1] ?? '';
    assert.match(drafted, /a tsv export/, r.o().slice(mark));
    assert.doesNotMatch(drafted, /CODEWORD-PELICAN|a csv export/, `the cleared conversation came back:\n${drafted}`);
    const drafts = sentLines(r).filter((u) => u.includes('Phase: REQUIREMENTS'));
    assert.equal(drafts.length, 2, JSON.stringify(drafts));
    assert.ok(!drafts[1]!.includes('Use the conversation so far'), `asked to use the cleared conversation:\n${drafts[1]}`);
    r.line('2');
    await r.waitFor(/Stopped at the requirements\.md checkpoint[\s\S]*> $/, 20_000, mark);
    r.line('/quit');
    assert.equal(await r.exit, 0);
  } finally {
    r.end();
    await r.exit.catch(() => undefined);
    r.t.cleanup();
  }
});

test('e2e: /spec new after /clear in a chat that had turns does not ask to use the (cleared) conversation (P3)', { timeout: 60_000 }, async () => {
  const r = live(HISTORY_SCRIPT({ text: 'DRAFTED history=[{{historyUserTexts}}] END' }), { isolate: true });
  try {
    await r.waitFor(/> $/);
    r.line('remember CODEWORD-PELICAN');
    await r.waitFor(/ANSWER history=\[remember CODEWORD-PELICAN\] END[\s\S]*> $/);
    let mark = r.o().length;
    r.line('/clear');
    await r.waitFor(/\[y\/n\]:/, 20_000, mark);
    r.line('y');
    await r.waitFor(/> $/, 20_000, mark);
    mark = r.o().length;
    r.line('/spec new my-feature --type feature --workflow requirements-first a csv export');
    await r.waitFor(/Stop here \(resume later with \/spec my-feature\)[\s\S]*$/, 20_000, mark);
    const drafted = /DRAFTED history=\[([\s\S]*)\] END/.exec(r.o().slice(mark))?.[1] ?? '';
    assert.match(drafted, /a csv export/, r.o().slice(mark));
    assert.doesNotMatch(drafted, /CODEWORD-PELICAN/, `precondition: the conversation was cleared:\n${drafted}`);
    const drafts = sentLines(r).filter((u) => u.includes('Phase: REQUIREMENTS'));
    assert.equal(drafts.length, 1, JSON.stringify(drafts));
    assert.ok(!drafts[0]!.includes('Use the conversation so far'), `asked to use the cleared conversation:\n${drafts[0]}`);
    r.line('2');
    await r.waitFor(/Stopped at the requirements\.md checkpoint[\s\S]*> $/, 20_000, mark);
    r.line('/quit');
    assert.equal(await r.exit, 0);
  } finally {
    r.end();
    await r.exit.catch(() => undefined);
    r.t.cleanup();
  }
});

// ───── repl verifier (R1/R2): a script command at an approval prompt; agentSpawn hooks of idle commands ─────

for (const tty of [false, true]) {
  test(`e2e: Ctrl+C during /chat save-via-script typed at an approval prompt kills the script and cancels the turn without asking the dead question again (R1, ${tty ? 'terminal' : 'line'} mode)`, { timeout: 60_000 }, async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kc-viaappr-')));
    const pidFile = path.join(dir, 'script.pid');
    const marker = path.join(dir, 'script.done');
    // a child in a session of its own keeps the script's stdout open after its group is killed, so
    // the command ends only after runShell's pipe grace: well after the interrupted turn ended
    const holderJs = path.join(dir, 'holder.cjs');
    const holderPidFile = path.join(dir, 'holder.pid');
    fs.writeFileSync(holderJs, "const h = require('child_process').spawn('sleep', ['30'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] }); require('fs').writeFileSync(process.argv[2], String(h.pid)); h.unref();\n");
    const script = {
      turns: [
        { match: '^make', steps: [{ tool: { name: 'Bash', input: { command: 'touch made.txt' } } }, { text: 'TOOL-SAID {{lastToolResult}}' }] },
        { repeat: true, match: 'main', steps: [{ text: 'MAIN-ANSWER to {{userText}}' }] },
      ],
    };
    const r = live(script, { isolate: true, tty });
    let pid: number | undefined;
    let pidTicks: number | undefined;
    let holder: number | undefined;
    let holderTicks: number | undefined;
    try {
      await r.waitFor(/> $/);
      r.line('make a file');
      await r.waitFor(/\[y\/n\/t\]:[\s\S]*> $/);
      const mark = r.o().length;
      r.line(`/chat save-via-script trap '' TERM INT HUP; echo $$ > '${pidFile}'; '${process.execPath}' '${holderJs}' '${holderPidFile}'; cat > /dev/null; sleep 30; touch '${marker}'`);
      const t0 = Date.now();
      const started = (f: string): boolean => fs.existsSync(f) && /^\d+$/.test(fs.readFileSync(f, 'utf8').trim());
      while (!(started(pidFile) && started(holderPidFile))) {
        if (Date.now() - t0 > 10_000) throw new Error(`the script never started\n${r.o()}`);
        await sleepMs(25);
      }
      pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
      pidTicks = startTicksOf(pid); // who it is, for the cleanup kill (K6)
      holder = Number(fs.readFileSync(holderPidFile, 'utf8').trim());
      holderTicks = startTicksOf(holder);
      const pressedAt = Date.now();
      r.ctrlC();
      await r.waitFor(/Export via [\s\S]*? was cancelled\.\n\n[\s\S]*> $/, 5000, mark);
      assert.ok(Date.now() - pressedAt < 4000, `the prompt came back ${Date.now() - pressedAt} ms after the press`);
      const t1 = Date.now();
      while (pidAlive(pid) && Date.now() - t1 < 2000) await sleepMs(25);
      assert.ok(!pidAlive(pid), `script process ${pid} still runs`);
      assert.ok(!fs.existsSync(marker), 'the script ran to completion');
      await sleepMs(300);
      const after = r.o().slice(mark);
      const cancelledAt = after.indexOf('was cancelled.');
      // the press interrupted the turn too: its approval is gone, so the question is not asked again
      assert.ok(!after.slice(cancelledAt).includes('Allow this action?'), `the dead approval question was asked again:\n${after}`);
      // and the turn ended under the command: the prompt waits for it (nothing printed after it)
      assert.ok(!/\n> /.test(after.slice(0, cancelledAt)), `the prompt came back while the command still ran:\n${after}`);
      assert.ok(!/✔ Exported conversation state via|Failed to export via/.test(after), after);
      assert.equal(r.ended(), undefined, `the REPL quit:\n${after}`);
      const m2 = r.o().length;
      r.line('main again');
      await r.waitFor(/MAIN-ANSWER to main again[\s\S]*> $/, 15_000, m2);
      assert.ok(!fs.existsSync(path.join(r.t.wsDir, 'made.txt')), 'the tool ran');
      r.line('/quit');
      assert.equal(await r.exit, 0);
    } finally {
      // the shell's group, only while its leader is still the process whose pid was read: pids
      // are reused, and kill(-pid) after it died could hit an unrelated group (K6)
      if (pid !== undefined && pidTicks !== undefined && startTicksOf(pid) === pidTicks) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          /* gone */
        }
      }
      if (holder !== undefined) killIfSame(holder, holderTicks);
      r.end();
      await r.exit.catch(() => undefined);
      r.t.cleanup();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

// /clear, /agent swap and a new session's start run the agentSpawn hooks again: commands of
// kiro-claude's own, while the session is idle. Ctrl+C kills the hook (the start signal) and
// gives the prompt back, but must not interrupt or stop the idle Claude Code (F0).
const SPAWN_HOOK_CASES: { cmd: string; answer?: string }[] = [{ cmd: '/clear', answer: 'y' }, { cmd: '/agent swap other' }, { cmd: '/chat new' }];

for (const sc of SPAWN_HOOK_CASES) {
  test(
    `e2e: Ctrl+C while ${sc.cmd} re-runs a slow agentSpawn hook kills the hook and gives the prompt back, without stopping Claude Code (R2)`,
    {
      timeout: 60_000,
    },
    async () => {
      const kiroHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kc-spawnhook-')));
      const once = path.join(kiroHome, 'hook.once');
      const pidFile = path.join(kiroHome, 'hook.pid');
      const marker = path.join(kiroHome, 'hook.done');
      // fast at the REPL's own start; the second run (the command's) hangs, ignoring TERM/INT/HUP
      const command = `trap '' TERM INT HUP; if [ -f '${once}' ]; then echo $$ > '${pidFile}'; sleep 30; touch '${marker}'; fi; touch '${once}'; echo SPAWN-CTX`;
      fs.mkdirSync(path.join(kiroHome, 'hooks'), { recursive: true });
      fs.writeFileSync(path.join(kiroHome, 'hooks', 'spawn.json'), JSON.stringify({ version: 'v1', hooks: [{ name: 'spawn', trigger: 'SessionStart', timeout: 60, action: { type: 'command', command } }] }));
      fs.mkdirSync(path.join(kiroHome, 'agents'), { recursive: true });
      fs.writeFileSync(path.join(kiroHome, 'agents', 'other.json'), JSON.stringify({ name: 'other', description: 'another agent' }));
      const r = live(MAIN_AND_TASKS, { isolate: true, extraEnv: { KIRO_HOME: kiroHome } });
      let pid: number | undefined;
      let pidTicks: number | undefined;
      try {
        await r.waitFor(/> $/);
        r.line('first main');
        await r.waitFor(/MAIN-ANSWER to first main[\s\S]*> $/);
        let mark = r.o().length;
        r.line(sc.cmd);
        if (sc.answer) {
          await r.waitFor(/\[y\/n\]:[\s\S]*> $/, 10_000, mark);
          r.line(sc.answer);
        }
        const t0 = Date.now();
        while (!(fs.existsSync(pidFile) && /^\d+$/.test(fs.readFileSync(pidFile, 'utf8').trim()))) {
          if (Date.now() - t0 > 10_000) throw new Error(`the hook never ran again\n${r.o()}`);
          await sleepMs(25);
        }
        pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
        pidTicks = startTicksOf(pid); // who it is, for the cleanup kill (K6)
        await sleepMs(200);
        mark = r.o().length;
        const pressedAt = Date.now();
        r.ctrlC();
        await r.waitFor(/> $/, 5000, mark).catch((e: Error) => {
          throw new Error(`Ctrl+C did not end ${sc.cmd} while its agentSpawn hook ran: ${e.message}`);
        });
        assert.ok(Date.now() - pressedAt < 4000, `the prompt came back ${Date.now() - pressedAt} ms after the press`);
        const t1 = Date.now();
        while (pidAlive(pid) && Date.now() - t1 < 2000) await sleepMs(25);
        assert.ok(!pidAlive(pid), `hook process ${pid} still runs after the prompt came back`);
        assert.ok(!fs.existsSync(marker), 'the hook ran to completion');
        await sleepMs(1500); // past the forced-stop grace
        const after = r.o().slice(mark);
        assert.ok(!/did not stop/.test(after), `Claude Code was force-stopped:\n${after}`);
        assert.equal(r.ended(), undefined, `the REPL quit:\n${after}`);
        const m2 = r.o().length;
        r.line('main again');
        await r.waitFor(/MAIN-ANSWER to main again[\s\S]*> $/, 15_000, m2);
        r.line('/quit');
        assert.equal(await r.exit, 0);
      } finally {
        // the shell's group, only while its leader is still the process whose pid was read: pids
        // are reused, and kill(-pid) after it died could hit an unrelated group (K6)
        if (pid !== undefined && pidTicks !== undefined && startTicksOf(pid) === pidTicks) {
          try {
            process.kill(-pid, 'SIGKILL');
          } catch {
            /* gone */
          }
        }
        r.end();
        await r.exit.catch(() => undefined);
        r.t.cleanup();
        fs.rmSync(kiroHome, { recursive: true, force: true });
      }
    },
  );
}

// ───── K9: read-only commands waiting on a control request of the idle session end at Ctrl+C ─────

/** Control requests of `subtype` the fake got so far. */
function controlRequests(r: ReturnType<typeof live>, subtype: string): number {
  return r.log().filter((e) => e.event === 'stdin' && (e.line as { type?: string })?.type === 'control_request' && (e.line as { request: { subtype?: string } }).request.subtype === subtype).length;
}

test('e2e: Ctrl+C while /usage, /mcp, /tools or /model waits on a slow Claude Code gives the prompt back at once; the late answers print nothing and nothing is stopped (K9, F0)', { timeout: 90_000 }, async () => {
  const LATE_MS = 3000;
  const r = live(MAIN_AND_TASKS, {
    isolate: true,
    extraEnv: { FAKE_CLAUDE_CONTROL_DELAYS: JSON.stringify({ get_context_usage: LATE_MS, mcp_status: LATE_MS, set_model: LATE_MS }) },
  });
  try {
    await r.waitFor(/> $/);
    r.line('first main');
    await r.waitFor(/MAIN-ANSWER to first main[\s\S]*> $/);
    const mark = r.o().length;
    const cases: [string, string, RegExp][] = [
      ['/usage', 'get_context_usage', /\/usage was cancelled\.\n\n> $/],
      ['/mcp', 'mcp_status', /\/mcp was cancelled\.\n\n> $/],
      ['/tools', 'mcp_status', /\/tools was cancelled\.\n\n> $/],
      ['/model claude-haiku-4.5', 'set_model', /Claude Code has not confirmed the switch to Haiku 4\.5 yet\.\n\n> $/],
    ];
    let lastSent = 0;
    for (const [cmd, subtype, cancelled] of cases) {
      const before = controlRequests(r, subtype);
      const m = r.o().length;
      r.line(cmd);
      const t0 = Date.now();
      while (controlRequests(r, subtype) === before) {
        if (Date.now() - t0 > 10_000) throw new Error(`${cmd} sent no ${subtype}\n${r.o()}`);
        await sleepMs(25);
      }
      lastSent = Date.now();
      await sleepMs(200);
      const pressedAt = Date.now();
      r.ctrlC();
      await r.waitFor(cancelled, 2000, m).catch((e: Error) => {
        throw new Error(`Ctrl+C did not end ${cmd} while Claude Code had not answered ${subtype}: ${e.message}`);
      });
      assert.ok(Date.now() - pressedAt < 1500, `${cmd}: the prompt came back ${Date.now() - pressedAt} ms after the press`);
    }
    // a turn after them works; then every late answer arrives (nothing of them is printed)
    const m2 = r.o().length;
    r.line('main again');
    await r.waitFor(/MAIN-ANSWER to main again[\s\S]*> $/, 15_000, m2);
    await sleepMs(Math.max(0, lastSent + LATE_MS + 800 - Date.now()));
    const after = r.o().slice(mark);
    assert.ok(!/Current context window|Pro Tips|No MCP servers configured|Built-in:|Using Haiku/.test(after), `a late answer reached the output:\n${after}`);
    assert.ok(!/did not stop|Failed to execute command|timed out|To exit the CLI/.test(after), after);
    assert.equal(r.ended(), undefined, `the REPL quit:\n${after}`);
    assert.equal(r.log().filter((e) => e.event === 'start' && (e.argv as string[]).includes('--input-format')).length, 1, 'Claude Code was not restarted');
    assert.equal(interruptRequests(r.log()), 0, 'the idle Claude Code got no interrupt');
    // the next /usage gets its own answer (the first one's late answer is not taken for it), once
    const m3 = r.o().length;
    r.line('/usage');
    await r.waitFor(/Current context window[\s\S]*Pro Tips[\s\S]*> $/, LATE_MS + 5000, m3);
    assert.equal(r.o().slice(m3).split('Current context window').length - 1, 1, r.o().slice(m3));
    r.line('/quit');
    assert.equal(await r.exit, 0);
  } finally {
    r.end();
    await r.exit.catch(() => undefined);
    r.t.cleanup();
  }
});

// ───── repl verifier (K9): /mcp typed at an approval prompt, Claude Code slow to answer ─────

for (const tty of [false, true]) {
  test(`e2e: Ctrl+C while /mcp typed at an approval prompt waits on a slow Claude Code ends it and cancels the turn without asking the dead question again; the late answer prints nothing (K9, ${tty ? 'terminal' : 'line'} mode)`, { timeout: 60_000 }, async () => {
    const LATE_MS = 2500;
    const script = {
      turns: [
        { match: '^make', steps: [{ tool: { name: 'Bash', input: { command: 'touch made.txt' } } }, { text: 'TOOL-SAID {{lastToolResult}}' }] },
        { repeat: true, match: 'main', steps: [{ text: 'MAIN-ANSWER to {{userText}}' }] },
      ],
    };
    const r = live(script, { isolate: true, tty, extraEnv: { FAKE_CLAUDE_CONTROL_DELAYS: JSON.stringify({ mcp_status: LATE_MS }) } });
    try {
      await r.waitFor(/> $/);
      r.line('make a file');
      await r.waitFor(/\[y\/n\/t\]:[\s\S]*> $/);
      const mark = r.o().length;
      const before = controlRequests(r, 'mcp_status');
      r.line('/mcp');
      const t0 = Date.now();
      while (controlRequests(r, 'mcp_status') === before) {
        if (Date.now() - t0 > 10_000) throw new Error(`/mcp sent no mcp_status\n${r.o()}`);
        await sleepMs(25);
      }
      const sentAt = Date.now();
      await sleepMs(200);
      const pressedAt = Date.now();
      r.ctrlC();
      await r.waitFor(/\/mcp was cancelled\.\n\n[\s\S]*> $/, 5000, mark).catch((e: Error) => {
        throw new Error(`Ctrl+C did not end /mcp at the approval prompt: ${e.message}`);
      });
      assert.ok(Date.now() - pressedAt < 1500, `the prompt came back ${Date.now() - pressedAt} ms after the press`);
      await sleepMs(Math.max(0, sentAt + LATE_MS + 800 - Date.now()));
      const after = r.o().slice(mark);
      const cancelledAt = after.indexOf('/mcp was cancelled.');
      // the press interrupted the turn too: its approval is gone, so the question is not asked again
      assert.ok(!after.slice(cancelledAt).includes('Allow this action?'), `the dead approval question was asked again:\n${after}`);
      assert.ok(!/No MCP servers configured|connected/.test(after), `the late answer reached the output:\n${after}`);
      assert.ok(!/did not stop|Failed to execute command|timed out|To exit the CLI/.test(after), after);
      assert.equal(r.ended(), undefined, `the REPL quit:\n${after}`);
      const m2 = r.o().length;
      r.line('main again');
      await r.waitFor(/MAIN-ANSWER to main again[\s\S]*> $/, 15_000, m2);
      assert.ok(!fs.existsSync(path.join(r.t.wsDir, 'made.txt')), 'the tool ran');
      assert.equal(r.log().filter((e) => e.event === 'start' && (e.argv as string[]).includes('--input-format')).length, 1, 'Claude Code was restarted');
      r.line('/quit');
      assert.equal(await r.exit, 0);
    } finally {
      r.end();
      await r.exit.catch(() => undefined);
      r.t.cleanup();
    }
  });
}

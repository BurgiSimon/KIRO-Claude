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
      if (pid !== undefined && pidAlive(pid)) {
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
    // the spec phase session forks from main's new Claude session (no transcript yet), falls back
    // to a new conversation and restores ITS OWN record's journal, which is empty: the session
    // group's kiroSession create(opts.fork) copies no journal from the fork's parent (enterTangent
    // does). Then finish('keep') closes main, whose saved history was never sent.
    { timeout: 60_000, ...(viaSpec ? { todo: 'session group: a create({fork}) whose source has no transcript restores no history (copy the parent journal, like enterTangent)' } : {}) },
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

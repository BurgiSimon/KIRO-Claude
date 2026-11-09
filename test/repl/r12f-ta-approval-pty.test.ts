/**
 * Round-12 fix "terminal-a", finding #0, in a real terminal: an interactive bash (job control) in
 * a python3 pty, or the chat as the pty's session leader (no shell), the built CLI over
 * test/fixtures/fake-claude.mjs, temp HOME, KIRO_HOME, CLAUDE_CONFIG_DIR and XDG_* only
 * (r11f-ta-pty-helpers.ts, r12f-ta-pty-helpers.ts).
 *
 * Keys typed while kiro-claude could not read them, BEFORE Claude Code asked for a tool, answered
 * the approval asked afterwards (r11's heartbeat park and away state hold the terminal unread
 * while Claude Code's pipe is read, so the request was read first and the approval prompt then
 * read those keys as typed at it): `y` + Enter allowed the tool, `t` trusted it, a next message
 * denied it as a redirect (and was sent to the model), Ctrl+D cancelled it. Paths: an event-loop
 * stall under bash (no stop, no SIGCONT), a stop from elsewhere with no shell (the chat leads its
 * session), and a stop from elsewhere under bash, where the keys the shell queued before `fg` were
 * kept in the approval's line. Now those keys are dropped, as type-ahead always is at an approval,
 * and the answer typed at the question is the answer. Prompt reads keep their type-ahead.
 *
 * Deterministic: Claude Code is held at the tool call by the agent's preToolUse hook (the fake is
 * stopped before the chat answers the hook_callback, r12f-ta-pty-helpers.ts holdIn), the chat is
 * frozen (a temporary cgroup-v1 freezer: a stall) or stopped while the keys are typed, and only
 * then is Claude Code continued, so its can_use_tool is in the chat's pipe before the chat can read
 * anything. Skipped without python3 and bash; the stall tests without a writable cgroup-v1
 * freezer; the sudo test without passwordless sudo whose policy says use_pty.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mkRoot, type Root } from '../headless/r5f-signals-helpers.js';
import { removeOnExit } from '../tmpdirs.js';
import { procState, quits, setup, skipPty, sleep, startAtPrompt, sudoUsePty, waitUntil, type Setup, type Term } from './r11f-ta-pty-helpers.js';
import { APPROVAL_SCRIPT, APPROVAL_WAITING, canFreeze, freeze, holdIn, leaderChat, type Held } from './r12f-ta-pty-helpers.js';

const skipStall = skipPty || (canFreeze() ? false : 'needs a writable cgroup-v1 freezer (root)');
const skipSudo = skipStall || (sudoUsePty() ? false : 'needs passwordless sudo with use_pty');
const SUDO = 'sudo -n -E ';

async function withChat(fn: (s: Setup, h: Held, pid: number) => Promise<void>, opts: { sudo?: boolean } = {}): Promise<void> {
  let h: Held | undefined;
  const s = setup({ script: APPROVAL_SCRIPT, prepare: (r) => (h = holdIn(r)) });
  try {
    const pid = await startAtPrompt(s.t, s.r, { prefix: `${h!.prefix}${opts.sudo ? SUDO : ''}`, pipe: h!.args });
    await sleep(300);
    await fn(s, h!, pid);
  } finally {
    await s.t.dispose();
  }
}

/** `go`: Claude Code reaches the tool and is held there; the chat has answered its hook. */
async function toTheTool(t: Term | { write(s: string): void }, h: Held, pid: number): Promise<number> {
  const fake = h.armHold(pid);
  t.write('go\r');
  await h.held(fake);
  return fake;
}

/** Continue Claude Code: it asks for the tool (can_use_tool, into the chat's pipe). */
async function asks(h: Held, fake: number): Promise<void> {
  process.kill(fake, 'SIGCONT');
  await waitUntil(() => h.sent('can_use_tool') === 1, 'Claude Code asks for the tool', 10_000);
}

/** The approval is asked and waits at its prompt, with nothing typed in it and nothing answered. */
async function waits(screen: () => string, h: Held, pid: number, mark: number): Promise<void> {
  await waitUntil(() => /Allow this action\?/.test(screen().slice(mark)), 'the approval question', 15_000);
  await sleep(1000);
  const at = screen().slice(mark);
  assert.deepEqual(h.behaviors(), [], `keys typed before the question answered it:\n${JSON.stringify(at.slice(-600))}`);
  assert.notEqual(procState(pid), 'gone', 'the chat ended');
  assert.doesNotMatch(at, /DONE </, at);
  assert.match(at, APPROVAL_WAITING, `the approval is not waiting at an empty prompt (keys typed before it kept in its line?):\n${JSON.stringify(at.slice(-600))}`);
}

/** Answer at the question: `y` runs the tool, `n` denies it; no redirect turn either way. */
async function answer(write: (s: string) => void, screen: () => string, h: Held, key: 'y' | 'n', turn = 'go'): Promise<void> {
  const m = screen().length;
  write(`${key}\r`);
  await waitUntil(() => /DONE <[\s\S]*> $/.test(screen().slice(m)), `the turn ends after \`${key}\``, 15_000);
  await sleep(300);
  assert.deepEqual(h.behaviors(), [key === 'y' ? 'allow' : 'deny'], JSON.stringify(screen().slice(m)));
  if (key === 'y') assert.match(screen().slice(m), /DONE <TOOL-RAN>/);
  else assert.doesNotMatch(screen().slice(m), /DONE <TOOL-RAN>/);
  assert.deepEqual(h.turns(), [turn], `a redirect (or the keys typed before the question) reached the model: ${JSON.stringify(h.turns())}`);
}

// ───────────────────────────── an event-loop stall under bash ─────────────────────────────

for (const [what, keys, key] of [
  ['y + Enter', 'y\r', 'n'],
  ['a next message + Enter', 'add tests\r', 'y'],
] as const) {
  test(`r12f #0: a stall under bash (frozen, no stop, no SIGCONT), Claude Code's request read first: ${what} typed during it never reaches the approval; \`${key}\` typed at the question answers it`, { skip: skipStall, timeout: 120_000 }, async () => {
    await withChat(async ({ t, r }, h, pid) => {
      const mark = t.screen().length;
      const fake = await toTheTool(t, h, pid);
      const f = await freeze(pid);
      try {
        t.write(keys);
        await sleep(150);
        await asks(h, fake);
        await sleep(300);
      } finally {
        f.thaw();
      }
      await waits(() => t.screen(), h, pid, mark);
      await answer((s) => t.write(s), () => t.screen(), h, key);
      await quits(t, r, pid);
    });
  });
}

test('r12f #0 (c): a stall while a turn runs: the keys typed before and during it are the next input, in order, once; a stall at the prompt: the line is submitted once', { skip: skipStall, timeout: 120_000 }, async () => {
  await withChat(async ({ t, r }, h, pid) => {
    let mark = t.screen().length;
    t.write('slow\r');
    await waitUntil(() => h.turns().length === 1, 'the turn runs', 10_000);
    await sleep(200);
    t.write('ne');
    await sleep(200);
    let f = await freeze(pid);
    try {
      t.write('xt\r');
      await sleep(400);
    } finally {
      f.thaw();
    }
    await t.waitFor(/SLOW-DONE[\s\S]*ANSWER to next[\s\S]*> $/, 'the type-ahead is the next input', mark, 20_000);
    await sleep(300);
    assert.equal(t.screen().slice(mark).match(/ANSWER to /g)?.length, 1, t.screen().slice(mark));
    assert.deepEqual(h.turns(), ['slow', 'next']);
    mark = t.screen().length;
    f = await freeze(pid);
    try {
      t.write('hello\r');
      await sleep(400);
    } finally {
      f.thaw();
    }
    await t.waitFor(/ANSWER to hello[\s\S]*> $/, 'the line typed during the stall', mark, 15_000);
    await sleep(300);
    assert.equal(t.screen().slice(mark).match(/ANSWER to /g)?.length, 1, t.screen().slice(mark));
    assert.deepEqual(h.turns(), ['slow', 'next', 'hello']);
    await quits(t, r, pid);
  });
});

test('r12f #0: a stall under `sudo` with use_pty: y + Enter typed during it never reaches the approval; `n` answers it', { skip: skipSudo, timeout: 120_000 }, async () => {
  await withChat(
    async ({ t, r }, h, pid) => {
      const mark = t.screen().length;
      const fake = await toTheTool(t, h, pid);
      const f = await freeze(pid);
      try {
        t.write('y\r');
        await sleep(150);
        await asks(h, fake);
        await sleep(300);
      } finally {
        f.thaw();
      }
      await waits(() => t.screen(), h, pid, mark);
      await answer((s) => t.write(s), () => t.screen(), h, 'n');
      await quits(t, r, pid);
    },
    { sudo: true },
  );
});

// ───────────────────────────── a stop from elsewhere under bash ─────────────────────────────

test('r12f #0: kill -STOP from elsewhere before the request, `y` + Enter typed in the shell before `fg`: not kept in the approval\'s line; `n` typed at the question denies it (no redirect)', { skip: skipPty, timeout: 120_000 }, async () => {
  await withChat(async ({ t, r }, h, pid) => {
    const mark = t.screen().length;
    const fake = await toTheTool(t, h, pid);
    process.kill(pid, 'SIGSTOP');
    await t.waitFor(/Stopped[\s\S]*BASH\$ $/, 'bash reports the job stopped', mark);
    await asks(h, fake);
    t.write('sleep 0.6; fg\r');
    await sleep(250);
    t.write('y\r'); // queued in the shell's cooked mode, typed before the question
    await waits(() => t.screen(), h, pid, mark);
    await answer((s) => t.write(s), () => t.screen(), h, 'n');
    await quits(t, r, pid);
  });
});

// ───────────────────────────── no shell: the chat leads the terminal's session ─────────────────────────────

for (const [what, keys, key] of [
  ['y + Enter', 'y\r', 'n'],
  ['t + Enter', 't\r', 'n'],
  ['a next message + Enter', 'add tests\r', 'y'],
  ['Ctrl+D', '\u0004', 'y'],
] as const) {
  test(`r12f #0: no shell (the chat leads its session): kill -STOP / kill -CONT from elsewhere, ${what} typed during the stop, before the request: the approval stays open; \`${key}\` typed at it answers it`, { skip: skipPty, timeout: 120_000 }, async () => {
    const r: Root = mkRoot(APPROVAL_SCRIPT);
    removeOnExit(r.root);
    const h = holdIn(r);
    const l = await leaderChat(h);
    try {
      await sleep(300);
      const mark = l.screen().length;
      const fake = await toTheTool(l, h, l.pid);
      process.kill(l.pid, 'SIGSTOP');
      await waitUntil(() => procState(l.pid) === 'T', 'stopped', 5000);
      l.write(keys); // raw: nobody took the terminal
      await sleep(150);
      await asks(h, fake);
      await sleep(400);
      process.kill(l.pid, 'SIGCONT');
      await waits(() => l.screen(), h, l.pid, mark);
      await answer((s) => l.write(s), () => l.screen(), h, key);
      l.write('/quit\r');
      await waitUntil(() => ['gone', 'Z'].includes(procState(l.pid)), 'the chat ends after /quit', 15_000);
    } finally {
      await l.dispose();
    }
  });
}

test('r12f #0: no shell, the race: kill -STOP before Claude Code reaches the tool, y + Enter typed during the stop, its hook_callback answered in the poll after the continue and the request read whenever it comes: the approval stays open; `n` answers it', { skip: skipPty, timeout: 120_000 }, async () => {
  const r: Root = mkRoot(APPROVAL_SCRIPT);
  removeOnExit(r.root);
  const h = holdIn(r);
  const l = await leaderChat(h);
  try {
    await sleep(300);
    const mark = l.screen().length;
    l.write('race\r');
    await waitUntil(() => h.turns().length === 1, 'the turn starts', 10_000);
    process.kill(l.pid, 'SIGSTOP');
    await waitUntil(() => procState(l.pid) === 'T', 'stopped', 5000);
    assert.equal(h.sent('hook_callback'), 0, 'Claude Code reached the tool before the stop');
    l.write('y\r');
    await waitUntil(() => h.sent('hook_callback') === 1, 'Claude Code reaches the tool during the stop', 10_000);
    await sleep(300);
    process.kill(l.pid, 'SIGCONT');
    await waits(() => l.screen(), h, l.pid, mark);
    await answer((s) => l.write(s), () => l.screen(), h, 'n', 'race');
    l.write('/quit\r');
    await waitUntil(() => ['gone', 'Z'].includes(procState(l.pid)), 'the chat ends after /quit', 15_000);
  } finally {
    await l.dispose();
  }
});

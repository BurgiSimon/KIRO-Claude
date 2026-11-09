/**
 * r12g S1 (session group), through the built CLI: a real headless kiro-claude chat in the middle of
 * a long turn holds its session; it is stopped (SIGSTOP) and then sent SIGHUP while stopped (what
 * sudo with `use_pty` leaves when the terminal of a stopped chat closes). `chat --resume-id <id>`
 * (or `chat --resume`) continues it (r12 #1), the old chat closes and saves the turn it was running,
 * and the new chat must go on from THAT record: the turns end [..., slow task, again], not
 * [..., again] (the open used to work from the copy it read before it took the lock and overwrote
 * what the old chat saved at its close). When the old chat's first turn was the one in progress,
 * the new chat keeps its title and message count and resumes its Claude session at once.
 *
 * Temp root and fake claude (test/headless/r5f-signals-helpers.ts mkRoot); every child gets TMPDIR
 * in the root and is ended by the test that started it.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { cli, mkRoot, type Cli, type Root } from '../headless/r5f-signals-helpers.js';
import { readJsonl } from '../claude/helpers.js';
import { removeOnExit } from '../tmpdirs.js';
import { LINUX, stopThenHangUp } from '../session/r12g-session-helpers.js';

const skip = LINUX ? false : 'needs Linux /proc';
const SCRIPT = {
  turns: [
    { match: 'slow', repeat: true, steps: [{ text: 'working on it' }, { sleepMs: 120_000 }, { text: 'done' }] },
    { repeat: true, steps: [{ text: 'ANSWER to {{userText}}' }] },
  ],
};

const started: Cli[] = [];

async function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<undefined>((res) => (timer = setTimeout(() => res(undefined), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/** End a chat this test started as `kill %1` does (SIGTERM, then SIGCONT); SIGKILL if it outlives its grace. */
async function end(c: Cli): Promise<void> {
  const pid = c.child.pid;
  if (pid === undefined || c.child.exitCode !== null || c.child.signalCode !== null) return;
  try {
    process.kill(pid, 'SIGTERM');
    process.kill(pid, 'SIGCONT');
  } catch {
    return;
  }
  if (await within(c.exit, 8000)) return;
  c.dispose();
}

after(async () => {
  await Promise.all(started.map(end));
});

interface Rec {
  sessionId: string;
  title: string;
  messageCount: number;
  turns: { preview: string }[];
}

function root(): { r: Root; tmpdir: string } {
  const r = mkRoot(SCRIPT);
  removeOnExit(r.root);
  const tmpdir = path.join(r.root, 'tmp');
  fs.mkdirSync(tmpdir);
  return { r, tmpdir };
}

const record = (r: Root, sid: string): Rec => JSON.parse(fs.readFileSync(path.join(r.sessions, `${sid}.json`), 'utf8')) as Rec;

async function run(r: Root, tmpdir: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; out: string }> {
  const c = cli(r, args, { stdin: 'ignore', env: { TMPDIR: tmpdir, ...env } });
  started.push(c);
  const exit = await within(c.exit, 60_000);
  if (!exit) {
    c.dispose();
    throw new Error(`timeout: ${args.join(' ')}\n${c.o()}`);
  }
  return { code: exit.code, out: c.o() };
}

/** A headless chat running `slow task` (on `sid`, or a new session), stopped and then hung up. */
async function hungUpHolder(r: Root, tmpdir: string, sid?: string): Promise<{ holder: Cli; sid: string }> {
  const holder = cli(r, ['chat', ...(sid ? ['--resume-id', sid] : []), '--no-interactive', '--trust-all-tools', 'slow task'], { stdin: 'ignore', env: { TMPDIR: tmpdir } });
  started.push(holder);
  await holder.waitFor(/working on it/, 0, 30_000);
  const id = sid ?? r.records()[0]!.sessionId;
  assert.deepEqual(r.locks(), [`${id}.lock`]);
  await stopThenHangUp(holder.child.pid!);
  return { holder, sid: id };
}

describe('r12g S1 chat: the open after a hung-up holder goes on from the record that holder saved at its close', { skip }, () => {
  for (const how of ['--resume-id', '--resume'] as const) {
    it(`chat ${how}: the turn the old chat was running is kept and the new turn follows it`, async () => {
      const { r, tmpdir } = root();
      const first = await run(r, tmpdir, ['chat', '--no-interactive', 'first']);
      assert.equal(first.code, 0, first.out);
      const sid = r.records()[0]!.sessionId;
      const { holder } = await hungUpHolder(r, tmpdir, sid);
      const o = await run(r, tmpdir, ['chat', ...(how === '--resume' ? ['--resume'] : ['--resume-id', sid]), '--no-interactive', 'again']);
      assert.equal(o.code, 0, o.out);
      assert.match(o.out, /ANSWER to again/);
      assert.deepEqual(await holder.exit, { code: null, signal: 'SIGHUP' });
      const rec = record(r, sid);
      assert.deepEqual(rec.turns.map((t) => t.preview), ['first', 'slow task', 'again']);
      assert.equal(rec.messageCount, 3);
      assert.deepEqual(r.locks(), []);
    });
  }

  it("the old chat's first turn was in progress: title and message count kept, its Claude session resumed at once", async () => {
    const { r, tmpdir } = root();
    const { holder, sid } = await hungUpHolder(r, tmpdir);
    const log = path.join(r.root, 'opener-claude.jsonl');
    const o = await run(r, tmpdir, ['chat', '--resume-id', sid, '--no-interactive', 'again'], { FAKE_CLAUDE_LOG: log });
    assert.equal(o.code, 0, o.out);
    assert.match(o.out, /ANSWER to again/);
    assert.deepEqual(await holder.exit, { code: null, signal: 'SIGHUP' });
    // the session launches (stream-json), not a capability probe
    const starts = readJsonl(log).filter((e) => e.event === 'start' && Array.isArray(e.argv) && (e.argv as string[]).includes('stream-json'));
    const argv = starts[0]!.argv as string[];
    assert.equal(argv[argv.indexOf('--resume') + 1], sid, `resumed at once: ${argv.join(' ')}`);
    assert.equal(argv.includes('--session-id'), false, `not launched as a new session: ${argv.join(' ')}`);
    const rec = record(r, sid);
    assert.deepEqual(rec.turns.map((t) => t.preview), ['slow task', 'again']);
    assert.equal(rec.title, 'slow task');
    assert.equal(rec.messageCount, 2);
  });
});

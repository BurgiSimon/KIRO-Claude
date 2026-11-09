/**
 * r12 #1 verification (session group), through the built CLI: `chat --delete-session <id>` of a
 * session held by a chat that is stopped with SIGHUP pending (sudo `use_pty` after its terminal
 * closed) continues that chat and waits for its close. A chat that never had a message drops its
 * record at that close (Q saves a conversation only after a reply), so the record is gone by the
 * time the lock is ours. Before this check `--delete-session` then printed `error: no saved chat
 * session with id '<id>'` and exited 1, although the session was listed a moment before and is
 * gone now as asked. It reports `Deleted chat session <id>` and exits 0.
 *
 * The holder is a real chat (line mode, stdin a pipe) at its first prompt; temp root and fake
 * claude (test/headless/r5f-signals-helpers.ts); every child gets TMPDIR in the root and is
 * killed by the test that started it.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { cli, mkRoot, sleep, type Cli } from '../headless/r5f-signals-helpers.js';
import { removeOnExit } from '../tmpdirs.js';

const skip = process.platform === 'linux' && fs.existsSync('/proc/self/stat') ? false : 'needs Linux /proc';
const started: Cli[] = [];
after(() => {
  for (const c of started) {
    const pid = c.child.pid;
    if (pid === undefined || c.child.exitCode !== null || c.child.signalCode !== null) continue;
    try {
      process.kill(pid, 'SIGCONT');
    } catch {
      // gone
    }
    c.dispose();
  }
});

function allStopped(pid: number): boolean {
  try {
    const tids = fs.readdirSync(`/proc/${pid}/task`);
    return (
      tids.length > 0 &&
      tids.every((t) => {
        const s = fs.readFileSync(`/proc/${pid}/task/${t}/stat`, 'utf8');
        return s.slice(s.lastIndexOf(')') + 2).split(' ')[0] === 'T';
      })
    );
  } catch {
    return false;
  }
}

function hupPending(pid: number): boolean {
  const st = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
  return [...st.matchAll(/^(?:SigPnd|ShdPnd):\s*([0-9a-f]+)$/gm)].some((m) => (Number.parseInt(m[1]!.slice(-4), 16) & 1) !== 0);
}

async function until(cond: () => boolean, what: string, ms = 30_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`);
    await sleep(10);
  }
}

describe('r12f verify: chat --delete-session of a session whose hung-up chat never had a message', { skip }, () => {
  it('continues the chat, which drops its record at its close; the session is reported deleted (exit 0)', async () => {
    const r = mkRoot({ turns: [{ repeat: true, steps: [{ text: 'ANSWER to {{userText}}' }] }] });
    removeOnExit(r.root);
    const tmpdir = path.join(r.root, 'tmp');
    fs.mkdirSync(tmpdir);
    const holder = cli(r, ['chat'], { stdin: 'pipe', env: { TMPDIR: tmpdir } });
    started.push(holder);
    await holder.waitFor(/\n> $/, 0, 30_000);
    assert.equal(r.records().length, 1);
    assert.equal(r.locks().length, 1);
    const sid = r.records()[0]!.sessionId;
    // it is listed (a live lock keeps a never-used record), so a user may well ask to delete it
    const list = cli(r, ['chat', '--list-sessions'], { stdin: 'ignore', env: { TMPDIR: tmpdir } });
    started.push(list);
    assert.equal((await list.exit).code, 0, list.o());
    assert.match(list.o(), new RegExp(sid));
    const pid = holder.child.pid!;
    process.kill(pid, 'SIGSTOP');
    await until(() => allStopped(pid), 'the chat is stopped');
    process.kill(pid, 'SIGHUP');
    await until(() => hupPending(pid), 'SIGHUP is pending');
    const del = cli(r, ['chat', '--delete-session', sid], { stdin: 'ignore', env: { TMPDIR: tmpdir } });
    started.push(del);
    const e = await del.exit;
    assert.equal(e.code, 0, del.o());
    assert.match(del.o(), new RegExp(`Deleted chat session ${sid}`));
    assert.doesNotMatch(del.o(), /no saved chat session|active in another process/);
    assert.deepEqual(await holder.exit, { code: null, signal: 'SIGHUP' });
    assert.deepEqual(r.records(), []);
    assert.deepEqual(r.locks(), []);
    assert.equal(fs.existsSync(path.join(r.sessions, `${sid}.jsonl`)), false);
  });

  it('control: an id with no record still gets the unchanged error (exit 1)', async () => {
    const r = mkRoot({ turns: [] });
    removeOnExit(r.root);
    const del = cli(r, ['chat', '--delete-session', '56565656-5656-4565-8565-565656565656'], { stdin: 'ignore' });
    started.push(del);
    assert.equal((await del.exit).code, 1);
    assert.match(del.o(), /error: no saved chat session with id '56565656-5656-4565-8565-565656565656'/);
  });
});

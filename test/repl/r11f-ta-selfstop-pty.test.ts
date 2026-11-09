/**
 * Round-11 fix "terminal-a" (findings #1 and #2) in a real terminal: a python3 pty driver running
 * an interactive bash (job control), the built CLI over test/fixtures/fake-claude.mjs, temp dirs
 * only (r11f-ta-pty-helpers.ts). sudo is in r11f-ta-sudo-pty.test.ts.
 *
 * Since r9/r10 a chat that needed its terminal and was not in the terminal's foreground (its first
 * prompt after a start in the background; Repl.handBack after a child that had the terminal; the
 * line reader away after Ctrl+Z and `bg`) only polled /proc/self/stat and never stopped:
 *  - #1: a `!bash -i` child SIGKILLed while it held the terminal left its dead process group in
 *    the foreground; the outer bash was blocked on the chat's job, Ctrl+C/Z/D reached nobody, and
 *    the chat polled forever with its lock (no prompt; only a kill from elsewhere ended it);
 *  - #2: nothing above the chat that depends on its job-control stop ever saw one (sudo's pty).
 * Now it stops like a background job that reads its terminal ('Stopped (tty input)', SIGTTIN to its
 * process group): the shell takes the terminal back, `fg` continues it and it comes up; `bg` or a
 * `kill -CONT` from elsewhere continue it in the background, where it stops again once it needs the
 * terminal; `kill %1` (SIGTERM, then SIGCONT) and a hangup still close it at once; a plain `kill`
 * waits for a continue (r10 #5). In an orphaned process group the kernel discards the stop and the
 * poll goes on as before. The stop clock credits the self-stop like any other (a hook that blocked
 * during it still blocks).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  BASH,
  SLOW_START,
  answers,
  bg,
  chatCommand,
  ctrlZ,
  jobState,
  killedCleanly,
  nothingDrawn,
  procPgrp,
  procState,
  quits,
  setup,
  skipPty,
  sleep,
  startAtPrompt,
  startChat,
  stopsForTerminal,
  waitUntil,
  type Setup,
} from './r11f-ta-pty-helpers.js';

const skip = skipPty;

// ───────────────────────── #1: a child that dies holding the terminal ─────────────────────────

/** `!bash -i` (its own process group, the terminal's foreground), then `kill -9 $$` inside it. */
async function childDiesHoldingTerminal(s: Setup): Promise<number> {
  const { r, t } = s;
  const pid = await startAtPrompt(t, r);
  let mark = t.screen().length;
  t.write(`!PS1='INNER$ ' '${BASH}' --norc --noprofile -i\r`);
  await t.waitFor(/INNER\$ $/, 'the inner bash prompt', mark);
  mark = t.screen().length;
  t.write('kill -9 $$\r');
  // the chat stops; bash, blocked on the chat's job, takes the terminal back
  await t.waitFor(/Stopped[\s\S]*BASH\$ $/, 'bash reports the chat stopped and has the terminal again', mark, 10_000);
  assert.equal(procState(pid), 'T');
  assert.equal(await jobState(t), 'Stopped (tty input)');
  // nothing of the chat's held output is written from the background
  assert.doesNotMatch(t.screen().slice(mark), /Self exited/, 'the held output was written from the background');
  return pid;
}

test('r11f #1: `!bash -i`, then `kill -9 $$` in it (its dead group keeps the terminal): the chat stops, bash gets the terminal back, `fg` brings the chat up', { skip, timeout: 120_000 }, async () => {
  const s = setup();
  try {
    const pid = await childDiesHoldingTerminal(s);
    const mark = s.t.screen().length;
    s.t.write('fg\r');
    // the child's exit status, held while it had the terminal, is written in the foreground first
    await s.t.waitFor(/Self exited with status: signal: 9 \(SIGKILL\)[\s\S]*> $/, 'the held exit status, then the prompt', mark, 15_000);
    await answers(s.t, mark, 'hi there');
    await quits(s.t, s.r, pid);
  } finally {
    await s.t.dispose();
  }
});

test('r11f #1: the same, then `kill %1`: the chat closes and dies of SIGTERM at once; the held exit status is dropped', { skip, timeout: 120_000 }, async () => {
  const s = setup();
  try {
    const pid = await childDiesHoldingTerminal(s);
    await killedCleanly(s, pid, { notPrinted: /Self exited/ });
  } finally {
    await s.t.dispose();
  }
});

test('r11f #1 control: an inner `bash -i` that exits normally gives the terminal back; the chat goes on without a stop', { skip, timeout: 120_000 }, async () => {
  const s = setup();
  try {
    const pid = await startAtPrompt(s.t, s.r);
    let mark = s.t.screen().length;
    s.t.write(`!PS1='INNER$ ' '${BASH}' --norc --noprofile -i\r`);
    await s.t.waitFor(/INNER\$ $/, 'the inner bash prompt', mark);
    mark = s.t.screen().length;
    s.t.write('exit 3\r');
    await s.t.waitFor(/Self exited with status: exit status: 3[\s\S]*> $/, 'the exit status and the prompt', mark, 10_000);
    assert.doesNotMatch(s.t.screen().slice(mark), /Stopped/);
    assert.notEqual(procState(pid), 'T');
    await answers(s.t, mark);
  } finally {
    await s.t.dispose();
  }
});

// ───────────────────────── #2: the background, at the prompt and while starting ─────────────────────────

test('r11f #2: Ctrl+Z at the prompt, `bg`: the chat stops again (\'Stopped (tty input)\'), drawing nothing; `fg` brings it back with the half-typed line', { skip, timeout: 120_000 }, async () => {
  const s = setup();
  try {
    const pid = await startAtPrompt(s.t, s.r);
    let mark = s.t.screen().length;
    s.t.write('half');
    await s.t.waitFor(/half$/, 'the half-typed line', mark);
    await ctrlZ(s.t, pid);
    mark = s.t.screen().length;
    await bg(s.t);
    await stopsForTerminal(s.t, pid);
    // typing at bash works meanwhile; nothing of the chat is drawn over the shell
    s.t.write('echo SHELL-OK\r');
    await s.t.waitFor(/SHELL-OK[\s\S]*BASH\$ $/, 'bash runs a command', mark);
    assert.doesNotMatch(s.t.screen().slice(mark), /> half/, 'the chat drew its prompt in the background');
    mark = s.t.screen().length;
    s.t.write('fg\r');
    await s.t.waitFor(/> half$/, 'the prompt and the half-typed line are back', mark, 10_000);
    s.t.write(' line\r');
    await s.t.waitFor(/ANSWER to half line[\s\S]*> $/, 'the input is read again', mark, 15_000);
    // once more into the background, then killed there
    await ctrlZ(s.t, pid);
    await bg(s.t);
    await stopsForTerminal(s.t, pid);
    await killedCleanly(s, pid);
  } finally {
    await s.t.dispose();
  }
});

test('r11f #2: Ctrl+Z, `bg`, `fg`, then a line + Enter 30 ms after fg (the cooked window): submitted once', { skip, timeout: 120_000 }, async () => {
  const s = setup();
  try {
    const pid = await startAtPrompt(s.t, s.r);
    for (const i of [0, 1]) {
      await ctrlZ(s.t, pid);
      await bg(s.t);
      await stopsForTerminal(s.t, pid);
      const mark = s.t.screen().length;
      s.t.write('fg\r');
      await sleep(30);
      s.t.write(`hello${i}\r`);
      await s.t.waitFor(new RegExp(`ANSWER to hello${i}[\\s\\S]*> $`), `the answer to hello${i}`, mark, 15_000);
      await sleep(300);
      assert.equal(s.t.screen().slice(mark).match(new RegExp(`ANSWER to hello${i}`, 'g'))?.length, 1, s.t.screen().slice(mark));
    }
  } finally {
    await s.t.dispose();
  }
});

test('r11f #2: `kill -CONT <pid>` from elsewhere while bash holds the terminal: the chat stops again; `fg` brings it up', { skip, timeout: 120_000 }, async () => {
  const s = setup();
  try {
    const pid = await startAtPrompt(s.t, s.r);
    await ctrlZ(s.t, pid);
    process.kill(pid, 'SIGCONT');
    await sleep(100);
    await stopsForTerminal(s.t, pid);
    const mark = s.t.screen().length;
    s.t.write('fg\r');
    await answers(s.t, mark);
  } finally {
    await s.t.dispose();
  }
});

test('r11f #2: a self-stopped chat (Ctrl+Z, `bg`): a plain `kill <pid>` waits for a continue (lock held); `kill -CONT` then closes it at once', { skip, timeout: 120_000 }, async () => {
  const s = setup();
  try {
    const pid = await startAtPrompt(s.t, s.r);
    await ctrlZ(s.t, pid);
    await bg(s.t);
    await stopsForTerminal(s.t, pid);
    process.kill(pid, 'SIGTERM');
    await sleep(1500);
    assert.equal(procState(pid), 'T', 'a stopped process handles no SIGTERM before it continues');
    assert.equal(s.r.locks().length, 1);
    const t0 = Date.now();
    process.kill(pid, 'SIGCONT');
    await waitUntil(() => procState(pid) === 'gone', `the chat ends after the continue (state ${procState(pid)})`, 10_000);
    assert.ok(Date.now() - t0 < 7000);
    assert.deepEqual(s.r.locks(), []);
    await waitUntil(() => fs.existsSync(s.ended) && fs.readFileSync(s.ended, 'utf8').trim() !== '', 'the SessionEnd hook ran', 5000);
  } finally {
    await s.t.dispose();
  }
});

test('r11f #2: the terminal closes while the chat is self-stopped (bash: SIGHUP + SIGCONT): it closes (lock released, SessionEnd ran)', { skip, timeout: 120_000 }, async () => {
  const s = setup();
  try {
    const pid = await startAtPrompt(s.t, s.r);
    await ctrlZ(s.t, pid);
    await bg(s.t);
    await stopsForTerminal(s.t, pid);
    await s.t.hangup();
    await waitUntil(() => procState(pid) === 'gone', `the chat ends after the hangup (state ${procState(pid)})`, 10_000);
    assert.deepEqual(s.r.locks(), []);
    await waitUntil(() => fs.existsSync(s.ended) && fs.readFileSync(s.ended, 'utf8').trim() !== '', 'the SessionEnd hook ran', 5000);
  } finally {
    await s.t.dispose();
  }
});

test('r11f #2: `kiro-claude chat &`: it stops by itself before its greeting (nothing drawn); `fg` brings the greeting and the prompt; `kill %1` of another closes it', { skip, timeout: 120_000 }, async () => {
  for (const end of ['fg', 'kill'] as const) {
    const s = setup({ env: SLOW_START });
    try {
      const mark = s.t.screen().length;
      const pid = await startChat(s.t, s.r, { amp: true });
      await sleep(2500); // started meanwhile
      await stopsForTerminal(s.t, pid);
      nothingDrawn(s.t, mark);
      if (end === 'kill') {
        await killedCleanly(s, pid);
        continue;
      }
      const m = s.t.screen().length;
      s.t.write('fg\r');
      await s.t.waitFor(/Welcome to[\s\S]*> $/, 'the greeting and the prompt', m);
      await answers(s.t, m);
      await quits(s.t, s.r, pid);
    } finally {
      await s.t.dispose();
    }
  }
});

test('r11f #2: Ctrl+Z while the chat starts, `bg`: it stops again before its greeting; `fg` brings it up', { skip, timeout: 120_000 }, async () => {
  const s = setup({ env: SLOW_START });
  try {
    const pid = await startChat(s.t, s.r);
    await sleep(300);
    await ctrlZ(s.t, pid);
    await sleep(3000); // the initialize answer arrives during the stop
    const mark = s.t.screen().length;
    await bg(s.t);
    await stopsForTerminal(s.t, pid);
    nothingDrawn(s.t, mark);
    const m = s.t.screen().length;
    s.t.write('fg\r');
    await s.t.waitFor(/Welcome to[\s\S]*> $/, 'the greeting and the prompt', m);
    await answers(s.t, m);
  } finally {
    await s.t.dispose();
  }
});

test('r11f #2: a wrapper in the chat\'s process group (`bash -c "kiro-claude chat; :" &`): the whole job stops, so `fg` continues it and it comes up', { skip, timeout: 120_000 }, async () => {
  const s = setup({ env: SLOW_START });
  try {
    await s.t.waitFor(/BASH\$ $/, 'bash prompt');
    const mark = s.t.screen().length;
    s.t.write(`'${BASH}' -c "${chatCommand().replace(/"/g, '\\"')}; :" &\r`);
    await waitUntil(() => s.r.locks().length === 1, 'the session lock', 20_000);
    const pid = s.t.chatPid();
    await sleep(2500);
    // a stop of the chat alone left the wrapper running: bash's job stayed 'Running' and `fg` sent no SIGCONT
    await stopsForTerminal(s.t, pid);
    nothingDrawn(s.t, mark);
    const m = s.t.screen().length;
    s.t.write('fg\r');
    await s.t.waitFor(/Welcome to[\s\S]*> $/, 'the greeting and the prompt', m);
    await answers(s.t, m);
  } finally {
    await s.t.dispose();
  }
});

// ───────────────────────── children that end in the background ─────────────────────────

test('r11f #2: `!sleep 1`, Ctrl+Z, `bg` (the child ends in the background): the chat stops (\'Stopped (tty input)\'); `fg` brings the prompt, a line typed right after is answered', { skip, timeout: 120_000 }, async () => {
  const s = setup();
  try {
    const pid = await startAtPrompt(s.t, s.r);
    s.t.write('!sleep 1\r');
    await sleep(400);
    await ctrlZ(s.t, pid);
    await bg(s.t);
    await sleep(1200); // the child is done
    await stopsForTerminal(s.t, pid);
    const mark = s.t.screen().length;
    s.t.write('fg\r');
    await sleep(30);
    s.t.write('hello\r');
    await s.t.waitFor(/ANSWER to hello[\s\S]*> $/, 'the line typed right after fg is answered', mark, 15_000);
    await sleep(300);
    assert.equal(s.t.screen().slice(mark).match(/ANSWER to hello/g)?.length, 1, s.t.screen().slice(mark));
  } finally {
    await s.t.dispose();
  }
});

test('r11f #2: `!sleep 1`, Ctrl+Z, `bg`, the child ends: `kill %1` of the self-stopped chat closes it', { skip, timeout: 120_000 }, async () => {
  const s = setup();
  try {
    const pid = await startAtPrompt(s.t, s.r);
    s.t.write('!sleep 1\r');
    await sleep(400);
    await ctrlZ(s.t, pid);
    await bg(s.t);
    await sleep(1200);
    await stopsForTerminal(s.t, pid);
    await killedCleanly(s, pid);
  } finally {
    await s.t.dispose();
  }
});

// ───────────────────────── a turn in the background ─────────────────────────

const SLOW_SCRIPT = {
  turns: [
    { repeat: true, match: '^slow', steps: [{ text: 'BEGIN ' }, { sleepMs: 2500 }, { text: 'END-OF-SLOW' }] },
    { repeat: true, steps: [{ text: 'ANSWER to {{userText}}' }] },
  ],
};

test('r11f #2: a turn continued in the background (kill -STOP, `bg`) runs on, its output written there, until its prompt: then the chat stops; `fg` brings the prompt', { skip, timeout: 120_000 }, async () => {
  const s = setup({ script: SLOW_SCRIPT });
  try {
    const pid = await startAtPrompt(s.t, s.r);
    let mark = s.t.screen().length;
    s.t.write('slow\r');
    await s.t.waitFor(/BEGIN/, 'the turn streams', mark);
    process.kill(pid, 'SIGSTOP'); // a stop from elsewhere during the turn
    await s.t.waitFor(/Stopped[\s\S]*BASH\$ $/, 'bash reports the job stopped', mark, 5000);
    mark = s.t.screen().length;
    await bg(s.t);
    await sleep(300);
    assert.notEqual(procState(pid), 'T', 'stopped while the turn ran (no read waited for the terminal)');
    // the turn's output is written in the background (unchanged), then its prompt stops the chat
    await s.t.waitFor(/END-OF-SLOW/, 'the turn ends in the background', mark, 15_000);
    await stopsForTerminal(s.t, pid);
    nothingDrawn(s.t, s.t.screen().indexOf('END-OF-SLOW', mark));
    const m = s.t.screen().length;
    s.t.write('fg\r');
    await answers(s.t, m);
  } finally {
    await s.t.dispose();
  }
});

// ───────────────────────── an orphaned process group ─────────────────────────

/** `bash -mc 'kiro-claude chat & sleep 0.3'`: the chat's group is orphaned once that shell exits, while the chat still starts. */
async function orphaned(s: Setup): Promise<number> {
  await s.t.waitFor(/BASH\$ $/, 'bash prompt');
  s.t.write(`'${BASH}' -mc "${chatCommand().replace(/"/g, '\\"')} & sleep 0.3"\r`);
  await waitUntil(() => s.r.locks().length === 1, 'the session lock', 20_000);
  const pid = s.t.chatPid();
  await sleep(3200); // started; the stop it makes for the terminal is discarded
  return pid;
}

test('r11f #2: an orphaned process group (`bash -mc \'… chat & …\'`): the kernel discards the stop; the chat waits off the terminal (polling), comes up when given the terminal, and closes at a kill', { skip, timeout: 120_000 }, async () => {
  for (const end of ['given', 'kill'] as const) {
    const s = setup({ env: SLOW_START });
    try {
      const mark = s.t.screen().length;
      const pid = await orphaned(s);
      const t0 = Date.now();
      while (Date.now() - t0 < 1500) {
        const st = procState(pid);
        assert.ok(st === 'S' || st === 'R', `the chat stopped in an orphaned group (state ${st})`);
        await sleep(50);
      }
      nothingDrawn(s.t, mark);
      if (end === 'kill') {
        const t1 = Date.now();
        process.kill(pid, 'SIGTERM');
        await waitUntil(() => procState(pid) === 'gone', `the chat ends after a kill (state ${procState(pid)})`, 10_000);
        assert.ok(Date.now() - t1 < 7000);
        assert.deepEqual(s.r.locks(), []);
        await waitUntil(() => fs.existsSync(s.ended) && fs.readFileSync(s.ended, 'utf8').trim() !== '', 'the SessionEnd hook ran', 5000);
        continue;
      }
      // no shell knows the job; a foreground helper of the same session hands it the terminal (what
      // a `fg` would do) and waits until the chat is gone
      const pg = procPgrp(pid);
      const m = s.t.screen().length;
      s.t.write(`python3 -I -c "import os, time; os.tcsetpgrp(0, ${pg})\nwhile os.path.exists('/proc/${pid}'): time.sleep(0.05)"\r`);
      await s.t.waitFor(/Welcome to[\s\S]*> $/, 'the greeting and the prompt once it has the terminal', m);
      await answers(s.t, m);
      const q = s.t.screen().length;
      s.t.write('/quit\r');
      await waitUntil(() => procState(pid) === 'gone', 'the chat ends after /quit', 15_000);
      await s.t.waitFor(/BASH\$ $/, 'bash has the terminal again', q, 10_000);
      assert.deepEqual(s.r.locks(), []);
    } finally {
      await s.t.dispose();
    }
  }
});

test('r11f #2: a self-stopped chat whose job then becomes orphaned (`bash -mc \'… chat & sleep 4\'` exits): the kernel\'s SIGHUP + SIGCONT closes it (lock released, SessionEnd ran)', { skip, timeout: 120_000 }, async () => {
  const s = setup();
  try {
    await s.t.waitFor(/BASH\$ $/, 'bash prompt');
    s.t.write(`'${BASH}' -mc "${chatCommand().replace(/"/g, '\\"')} & sleep 4"\r`);
    await waitUntil(() => s.r.locks().length === 1, 'the session lock', 20_000);
    const pid = s.t.chatPid();
    // the shell that started it still runs: not orphaned, the stop is real
    await waitUntil(() => procState(pid) === 'T', `the chat stops in the background (state ${procState(pid)})`, 10_000);
    await waitUntil(() => procState(pid) === 'gone', `the chat ends once its group is orphaned (state ${procState(pid)})`, 15_000);
    assert.deepEqual(s.r.locks(), []);
    await waitUntil(() => fs.existsSync(s.ended) && fs.readFileSync(s.ended, 'utf8').trim() !== '', 'the SessionEnd hook ran', 5000);
  } finally {
    await s.t.dispose();
  }
});

// ───────────────────────── the stop clock ─────────────────────────

const SECRET_READ = { name: 'Read', input: { file_path: '{{cwd}}/secret.env' }, result: 'SECRET=hunter2' };
const HOST_READ = { name: 'Read', input: { file_path: '/etc/hostname' }, result: 'HOST-CONTENT' };
const GUARD_SCRIPT = {
  turns: [
    // /etc/hostname is outside the workspace (the gate asks); secret.env inside it (trusted) is
    // guarded by the agent's preToolUse hook
    { repeat: true, match: '^read both', steps: [{ parallel: [HOST_READ, SECRET_READ] }, { text: 'DONE {{lastToolResult}}' }] },
    { repeat: true, steps: [{ text: 'ANSWER to {{userText}}' }] },
  ],
};
const HOOK_TIMEOUT_MS = 2500;

test('r11f #2 (stop clock): Ctrl+Z at an approval prompt while a parallel call\'s guard hook runs, `bg` (it stops again for the terminal), longer than the hook\'s timeout, `fg`: the guard still blocks', { skip, timeout: 120_000 }, async () => {
  let log = '';
  const s = setup({
    script: GUARD_SCRIPT,
    prepare: (r) => {
      log = path.join(r.root, 'hook.log');
      fs.writeFileSync(path.join(r.ws, 'secret.env'), 'SECRET=hunter2\n');
      const agents = path.join(r.home, '.kiro', 'agents');
      fs.mkdirSync(agents, { recursive: true });
      const cmd = `p=$(cat); case "$p" in *secret.env*) echo start >> '${log}'; sleep 1.5; echo block >> '${log}'; echo NO-SECRETS >&2; exit 2;; esac; exit 0`;
      fs.writeFileSync(
        path.join(agents, 'guard.json'),
        JSON.stringify({ name: 'guard', description: 'guards secret.env', tools: ['*'], hooks: { preToolUse: [{ matcher: '*', command: cmd, timeout_ms: HOOK_TIMEOUT_MS }] } }),
      );
    },
  });
  const hookLog = (): string => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '');
  try {
    await s.t.waitFor(/BASH\$ $/, 'bash prompt');
    const m0 = s.t.screen().length;
    s.t.write(`${chatCommand('', ' --agent guard')}\r`);
    await s.t.waitFor(/Welcome to[\s\S]*> $/, 'the chat prompt', m0, 30_000);
    const pid = s.t.chatPid();
    const turnMark = s.t.screen().length;
    s.t.write('read both\r');
    await s.t.waitFor(/\[y\/n\/t\]:[\s\S]*> $/, 'the approval prompt for the /etc/hostname read', turnMark);
    await waitUntil(() => /start/.test(hookLog()), "the parallel call's hook starts", 3000);
    assert.doesNotMatch(hookLog(), /block/, 'the hook decided before the Ctrl+Z');
    await ctrlZ(s.t, pid);
    await bg(s.t);
    // continued in the background with the approval read waiting: it stops again (a second stop)
    await stopsForTerminal(s.t, pid);
    await sleep(HOOK_TIMEOUT_MS + 1500);
    assert.match(hookLog(), /block/, 'the hook blocked while kiro-claude was stopped');
    const fg = s.t.screen().length;
    s.t.write('fg\r');
    await s.t.waitFor(/fg\r?\n[\s\S]*> $/, 'after fg: the approval prompt again', fg, 5000);
    await sleep(300);
    const mark = s.t.screen().length;
    s.t.write('n\r');
    await s.t.waitFor(/DONE [^\n]*[\s\S]*> $/, 'the turn ends', mark, 15_000);
    const out = s.t.screen().slice(turnMark);
    assert.doesNotMatch(out, /timed out after/, `the hook that blocked while kiro-claude was stopped counted as timed out:\n${out}`);
    assert.doesNotMatch(out, /hunter2/, `the guarded read ran:\n${out}`);
    assert.match(out, /NO-SECRETS/);
  } finally {
    await s.t.dispose();
  }
});

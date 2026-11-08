/**
 * Round-6 fix "repl-signals" #2: in the line-mode chat, a line typed during the SIGTERM / SIGHUP
 * close grace must not answer a question a running slash command is waiting on (ReplHost.ask /
 * confirm / choose, and readAnswer under them): the question gets no answer, so the command stops
 * without acting on it. Before the fix the muted line reader still handed the line to the pending
 * read, and `/spec new` created `.kiro/specs/<name>/` after the signal. The same holds for an
 * approval prompt still open at the signal (a `/spec` phase session's, closed after the user's
 * chat): a `y` typed during the grace allowed the tool, and a `!cmd` typed there ran.
 *
 * Built CLI in line mode (stdin is a pipe) over test/fixtures/fake-claude.mjs, temp HOME /
 * KIRO_HOME / CLAUDE_CONFIG_DIR / XDG dirs; a slow workspace SessionEnd hook makes the grace last
 * ~1.5 s, long enough to type during it.
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { cli, mkRoot, sessionEndHook, sleep, type Cli } from '../headless/r5f-signals-helpers.js';

const clis: Cli[] = [];
afterEach(() => {
  for (const c of clis.splice(0)) c.dispose();
});

interface Case {
  what: string;
  /** The command typed before the signal. */
  command: string;
  /** The question it waits on when the signal comes. */
  question: RegExp;
  /** Lines typed during the grace (old code: they answer every question and the spec is made). */
  typed: string[];
}

const CASES: Case[] = [
  {
    what: 'ask (the feature name)',
    command: '/spec new --type feature --workflow requirements-first',
    question: /Feature name/,
    typed: ['grace-feat', 'a description typed during the grace'],
  },
  {
    // an empty line is confirm's default (yes) when it is an answer
    what: 'confirm (the normalized name, default yes)',
    command: '/spec new "Grace Feat"',
    question: /Use "grace-feat" as the spec name\? \[y\/n\]/,
    typed: ['', '1', '1', 'a description typed during the grace'],
  },
  {
    what: 'choose (the kind of spec)',
    command: '/spec new grace-feat',
    question: /What kind of spec\?/,
    typed: ['1', '1', 'a description typed during the grace'],
  },
];

for (const k of CASES) {
  test(`r6f #2: a line typed during the SIGTERM grace does not answer /spec new's ${k.what}: no spec folder is made after the signal, nothing is printed`, { timeout: 60_000 }, async () => {
    const r = mkRoot({ turns: [{ repeat: true, steps: [{ text: 'ANSWER END' }] }] });
    let c: Cli | undefined;
    try {
      const endFile = path.join(r.root, 'ended.txt');
      sessionEndHook(r, `cat > /dev/null; sleep 1.5; echo end >> '${endFile}'`);
      c = cli(r, ['chat']);
      clis.push(c);
      await c.waitFor(/> $/);
      c.line('hello');
      await c.waitFor(/ANSWER END[\s\S]*> $/);
      const m = c.o().length;
      c.line(k.command);
      await c.waitFor(new RegExp(`${k.question.source}[\\s\\S]*> $`), m);
      await sleep(100);
      const specs = path.join(r.ws, '.kiro', 'specs');
      assert.equal(fs.existsSync(specs), false, 'a spec folder existed before the signal');
      const at = c.o().length;
      c.kill('SIGTERM');
      await sleep(150);
      for (const l of k.typed) c.line(l);
      const e = await c.exit;
      const made = fs.existsSync(specs) ? fs.readdirSync(specs) : [];
      const after = c.o().slice(at);
      const info = `exit ${JSON.stringify(e)}; specs ${JSON.stringify(made)}; after the signal ${JSON.stringify(after)}`;
      assert.equal(e.signal, 'SIGTERM', info);
      assert.equal(fs.readFileSync(endFile, 'utf8').trim(), 'end', info);
      assert.deepEqual(made, [], `input typed during the grace answered the command's question and the command acted on it: ${info}`);
      assert.equal(after, '', info);
      assert.deepEqual(r.locks(), [], info);
    } finally {
      c?.dispose();
      // the fake claude and the hook may still be writing into the root a moment after the exit
      await sleep(300);
      r.cleanup();
    }
  });
}

// The same for an approval prompt. The user's chat is closed first, which cancels its own pending
// request at once; a `/spec` phase session is closed after it, so its `[y/n/t]` request stayed open
// for the chat's whole close and a 'y' typed meanwhile allowed the tool (found while checking #2).
for (const typed of [['y', '!touch bang.txt'], ['!touch bang.txt', 'y']]) {
  test(`r6f #2: lines typed during the SIGTERM grace (${typed.join(', ')}) do not answer a /spec phase session's approval prompt: the tool is never allowed, no \`!cmd\` runs`, { timeout: 60_000 }, async () => {
    const r = mkRoot({
      turns: [
        { repeat: true, match: 'hello', steps: [{ text: 'ANSWER END' }] },
        { repeat: true, steps: [{ text: 'drafting ' }, { tool: { name: 'Bash', input: { command: 'touch made.txt' } } }, { text: 'after' }] },
      ],
    });
    let c: Cli | undefined;
    try {
      const endFile = path.join(r.root, 'ended.txt');
      sessionEndHook(r, `cat > /dev/null; sleep 1.5; echo end >> '${endFile}'`);
      const fakeLog = path.join(r.root, 'fake.log');
      c = cli(r, ['chat'], { env: { FAKE_CLAUDE_LOG: fakeLog } });
      clis.push(c);
      await c.waitFor(/> $/);
      c.line('hello');
      await c.waitFor(/ANSWER END[\s\S]*> $/);
      const m = c.o().length;
      c.line('/spec new grace-feat --type feature --workflow requirements-first a description of the feature');
      await c.waitFor(/\[y\/n\/t\][\s\S]*> $/, m);
      await sleep(100);
      const at = c.o().length;
      c.kill('SIGTERM');
      await sleep(150);
      for (const l of typed) c.line(l);
      const e = await c.exit;
      const after = c.o().slice(at);
      // the fake logs its own exit last: let every claude of the run finish writing its log
      await sleep(500);
      const answers = fs
        .readFileSync(fakeLog, 'utf8')
        .split('\n')
        .filter((l) => l.includes('"control_response"') && l.includes('"behavior"'))
        .map((l) => (JSON.parse(l) as { line: { response: { response: { behavior: string } } } }).line.response.response.behavior);
      const info = `exit ${JSON.stringify(e)}; approval answers ${JSON.stringify(answers)}; after the signal ${JSON.stringify(after)}`;
      assert.equal(e.signal, 'SIGTERM', info);
      assert.equal(fs.readFileSync(endFile, 'utf8').trim().split('\n').filter((l) => l === 'end').length >= 1, true, info);
      assert.ok(answers.length >= 1, `the phase turn asked no approval: ${info}`);
      assert.deepEqual(answers.filter((b) => b === 'allow'), [], `a line typed during the grace allowed the tool: ${info}`);
      assert.equal(fs.existsSync(path.join(r.ws, 'bang.txt')), false, info);
      assert.equal(after, '', info);
      assert.deepEqual(r.locks(), [], info);
    } finally {
      c?.dispose();
      await sleep(300);
      r.cleanup();
    }
  });
}

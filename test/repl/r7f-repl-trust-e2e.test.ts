/**
 * Round-7 fix "repl-trust" (#0), the built CLI in line mode over test/fixtures/fake-claude.mjs
 * (temp HOME / KIRO_HOME / CLAUDE_CONFIG_DIR / XDG dirs): `/chat new`, `/chat load` and
 * `/chat resume` keep the chat's current trust and plan mode. A tool the user revoked with
 * `/tools untrust`, or trust-all turned off with `/tools reset`, is never auto-approved again
 * because the launch `--trust-tools` / `--trust-all-tools` were applied to the next chat (Q
 * persist.rs: Load keeps the current agents, with their allowedTools and trust-all); launch trust
 * the user kept stays. Ported from the round-7 skeptic's guard
 * (skeptic-chat-switch-launch-trust.test.mjs), plus the controls and plan mode.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { builtBin } from '../cli/helpers.js';
import { mkRoot } from '../headless/r5f-signals-helpers.js';

const SCRIPT = {
  turns: [{ repeat: true, match: 'run it', steps: [{ tool: { name: 'Bash', input: { command: 'touch made.txt', description: 'touch' } } }, { text: 'TOOL-SAID {{lastToolResult}} END' }] }],
  default: { steps: [{ text: 'ok' }] },
};

/** `kiro-claude chat <flags>` with `lines` piped in (line mode); stdout + stderr, ANSI removed. */
function repl(flags: string[], lines: string[]): string {
  const r = mkRoot(SCRIPT);
  try {
    const p = spawnSync(process.execPath, [builtBin(), 'chat', ...flags], { cwd: r.ws, env: r.env(), input: `${lines.join('\n')}\n`, encoding: 'utf8', timeout: 60_000 });
    return `${p.stdout}${p.stderr}`.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
  } finally {
    r.cleanup();
  }
}

/** The output from the marker on (what happens once the chat was switched). */
function after(out: string, marker: string): string {
  const i = out.indexOf(marker);
  assert.ok(i >= 0, `marker ${JSON.stringify(marker)} not found in:\n${out}`);
  return out.slice(i);
}

const TRUSTED = /Using tool: shell \(trusted\)/;
const ASKS = /Allow this action\?/;

test('r7f #0: /chat load keeps a /tools untrust of a --trust-tools tool', { timeout: 90_000 }, () => {
  const out = repl(['--trust-tools=execute_bash'], ['hello', '/tools untrust execute_bash', 'run it', 'n', '/chat save x.json', '/chat load x.json', 'run it', 'n', '/quit']);
  assert.match(out.slice(0, out.indexOf('Imported conversation state')), ASKS, 'precondition: the untrusted tool asks before the load');
  const tail = after(out, 'Imported conversation state from x.json');
  assert.doesNotMatch(tail, TRUSTED, `after /chat load the revoked tool ran as trusted:\n${tail}`);
  assert.match(tail, ASKS, tail);
});

test('r7f #0: /chat new keeps trust-all off after /tools reset of --trust-all-tools', { timeout: 90_000 }, () => {
  const out = repl(['--trust-all-tools'], ['hello', '/tools reset', 'run it', 'n', '/chat new', 'run it', 'n', '/quit']);
  const tail = after(out, 'Started a new chat session');
  assert.doesNotMatch(tail, /^!> /m, `after /chat new the prompt shows trust-all again:\n${tail}`);
  assert.doesNotMatch(tail, TRUSTED, `after /chat new the tool ran as trusted:\n${tail}`);
  assert.match(tail, ASKS, tail);
});

test('r7f #0: /chat load keeps trust-all off after /tools reset of --trust-all-tools', { timeout: 90_000 }, () => {
  const out = repl(['--trust-all-tools'], ['hello', '/tools reset', '/chat save y.json', '/chat load y.json', 'run it', 'n', '/quit']);
  const tail = after(out, 'Imported conversation state from y.json');
  assert.doesNotMatch(tail, /^!> /m, `after /chat load the prompt shows trust-all again:\n${tail}`);
  assert.doesNotMatch(tail, TRUSTED, `after /chat load the tool ran as trusted:\n${tail}`);
  assert.match(tail, ASKS, tail);
});

test('r7f #0: /chat resume does not re-apply --trust-tools over the record whose trust revoked the tool', { timeout: 90_000 }, () => {
  const out = repl(['--trust-tools=execute_bash'], ['hello', '/tools untrust execute_bash', '/chat new', 'hi again', '/chat resume', '1', 'run it', 'n', '/tools', '/quit']);
  const tail = after(out, 'Picking up where we left off...');
  assert.doesNotMatch(tail, TRUSTED, `after /chat resume the revoked tool ran as trusted:\n${tail}`);
  assert.match(tail, ASKS, tail);
  assert.doesNotMatch(tail, /^- shell +trusted$/m, `/tools lists the revoked tool as trusted:\n${tail}`);
});

test('r7f #0 (control): launch trust the user kept stays trusted after /chat new, /chat load and /chat resume', { timeout: 120_000 }, () => {
  const some = repl(['--trust-tools=execute_bash'], ['hello', '/chat new', 'run it', '/chat save z.json', '/chat load z.json', 'run it', '/chat resume', '1', 'run it', '/quit']);
  for (const [from, to, what] of [
    ['Started a new chat session', '/chat save z.json', '/chat new'],
    ['Imported conversation state from z.json', '/chat resume', '/chat load'],
    ['Picking up where we left off...', '/quit', '/chat resume'],
  ] as const) {
    const part = after(some, from);
    const seg = part.slice(0, part.indexOf(to, from.length));
    assert.match(seg, TRUSTED, `--trust-tools=execute_bash was lost by ${what}:\n${seg}`);
    assert.doesNotMatch(seg, ASKS, `${what}: the kept tool asked:\n${seg}`);
  }
  const all = repl(['--trust-all-tools'], ['hello', '/chat new', 'run it', '/quit']);
  const tail = after(all, 'Started a new chat session');
  assert.match(tail, /^!> /m, `--trust-all-tools was lost by /chat new:\n${tail}`);
  assert.match(tail, TRUSTED, tail);
});

test('r7f #0: /chat new, /chat load and /chat resume keep the chat\'s plan mode: the next chat still denies a mutating tool', { timeout: 120_000 }, () => {
  // the resumed record and the export were saved outside plan mode; the chat is in it when it switches
  const out = repl(['--trust-all-tools'], [
    'hello', '/chat save p.json', '/chat new', 'hi', '/plan',
    '/chat resume', '1', 'run it',
    '/chat load p.json', 'run it',
    '/chat new', 'run it',
    '/quit',
  ]);
  assert.doesNotMatch(out.slice(0, out.indexOf('Entered plan mode.')), /^\[plan\]/m, 'precondition: plan mode came on with /plan only');
  for (const [from, to, what] of [
    ['Picking up where we left off...', '/chat load p.json', '/chat resume'],
    ['Imported conversation state from p.json', '/chat new', '/chat load'],
    ['Started a new chat session', '/quit', '/chat new'],
  ] as const) {
    // the last /chat new is the one from plan mode
    const part = from === 'Started a new chat session' ? out.slice(out.lastIndexOf(from)) : after(out, from);
    const seg = part.slice(0, part.indexOf(to, from.length));
    assert.match(seg, /^\[plan\] !> run it$/m, `${what} left plan mode (prompt):\n${seg}`);
    assert.match(seg, /TOOL-SAID .*Plan mode is read-only/, `${what} left plan mode: the mutating tool was not denied:\n${seg}`);
    assert.doesNotMatch(seg, /Bash completed/, seg);
  }
});

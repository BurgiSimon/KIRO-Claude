/**
 * Round-7 verification of the "repl-trust" fix (#0), the built CLI in line mode over
 * test/fixtures/fake-claude.mjs (temp HOME / KIRO_HOME / CLAUDE_CONFIG_DIR / XDG dirs). The
 * round-7 finding named the launch `--trust-tools` / `--trust-all-tools`; the same defect had a
 * second entry point without any launch flag: a tool of the AGENT's own `allowedTools` that the
 * user revoked with `/tools untrust` was auto-approved again after `/chat new`, `/chat load`
 * (also `/chat load-via-script`), because the next chat started from a fresh trust and the agent
 * config re-allowed it. Now the next chat starts from the chat's trust (ReplCore
 * baseSessionOptions -> KiroSessionOptions.initialTrust), revocations of agent tools included.
 * The control pins the documented Q semantics the other way round: trust the user gained in the
 * chat (`t`, `/tools trust-all`) is the chat's trust too and carries over.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { builtBin } from '../cli/helpers.js';
import { mkRoot } from '../headless/r5f-signals-helpers.js';

const SCRIPT = {
  turns: [{ repeat: true, match: 'run it', steps: [{ tool: { name: 'Bash', input: { command: 'touch made.txt', description: 'touch' } } }, { text: 'TOOL-SAID {{lastToolResult}} END' }] }],
  default: { steps: [{ text: 'ok' }] },
};

/** A workspace agent whose own config auto-approves the shell tool. */
const DEV_AGENT = { name: 'dev', tools: ['*'], allowedTools: ['execute_bash'] };

/** `kiro-claude chat <flags>` with `lines` piped in (line mode); stdout + stderr, ANSI removed. */
function repl(flags: string[], lines: string[], agent?: object): string {
  const r = mkRoot(SCRIPT);
  try {
    if (agent) {
      const dir = path.join(r.ws, '.kiro', 'agents');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'dev.json'), JSON.stringify(agent));
    }
    const p = spawnSync(process.execPath, [builtBin(), 'chat', ...flags], { cwd: r.ws, env: r.env(), input: `${lines.join('\n')}\n`, encoding: 'utf8', timeout: 90_000 });
    return `${p.stdout}${p.stderr}`.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
  } finally {
    r.cleanup();
  }
}

/** The output from `from` up to the next `to` after it (the whole rest when `to` is missing). */
function segment(out: string, from: string, to: string | undefined): string {
  const i = out.indexOf(from);
  assert.ok(i >= 0, `marker ${JSON.stringify(from)} not found in:\n${out}`);
  const rest = out.slice(i);
  const j = to === undefined ? -1 : rest.indexOf(to, from.length);
  return j < 0 ? rest : rest.slice(0, j);
}

const TRUSTED = /Using tool: shell \(trusted\)/;
const ASKS = /Allow this action\?/;

test('r7f-v #0: a revoked tool of the agent\'s own allowedTools (no launch flag) stays revoked through /chat new, /chat load, /chat load-via-script and /chat resume', { timeout: 120_000 }, () => {
  const out = repl(['--agent', 'dev'], [
    'hello', 'run it', '/tools untrust execute_bash',
    '/chat new', 'run it', 'n',
    '/chat save a.json', '/chat load a.json', 'run it', 'n',
    '/chat load-via-script cat a.json', 'run it', 'n',
    '/chat resume', '1', 'run it', 'n', '/tools',
    '/quit',
  ], DEV_AGENT);
  assert.match(out.slice(0, out.indexOf('/tools untrust')), TRUSTED, `precondition: the agent config trusts the tool:\n${out}`);
  for (const [from, to, what] of [
    ['Started a new chat session', '/chat save a.json', '/chat new'],
    ['Imported conversation state from a.json', '/chat load-via-script', '/chat load'],
    ['Imported conversation state via cat a.json', '/chat resume', '/chat load-via-script'],
    ['Picking up where we left off...', undefined, '/chat resume'],
  ] as const) {
    const seg = segment(out, from, to);
    assert.doesNotMatch(seg, TRUSTED, `after ${what} the revoked agent tool ran as trusted:\n${seg}`);
    assert.match(seg, ASKS, `${what}: the revoked tool did not ask:\n${seg}`);
  }
  assert.doesNotMatch(segment(out, 'Picking up where we left off...', undefined), /^- shell +trusted$/m, out);
});

test('r7f-v #0 (control, Q semantics): trust gained in the chat (a t answer, /tools trust-all) is the chat\'s trust and carries into /chat new and /chat load', { timeout: 120_000 }, () => {
  const out = repl([], [
    'hello', 'run it', 't',
    '/chat new', 'run it',
    '/tools trust-all', '/chat save b.json', '/chat load b.json', 'run it',
    '/quit',
  ]);
  assert.match(segment(out, 'hello', 'Started a new chat session'), ASKS, `precondition: the tool asked before the t answer:\n${out}`);
  const fresh = segment(out, 'Started a new chat session', '/tools trust-all');
  assert.match(fresh, TRUSTED, `/chat new lost the t answer:\n${fresh}`);
  assert.doesNotMatch(fresh, ASKS, fresh);
  const loaded = segment(out, 'Imported conversation state from b.json', undefined);
  assert.match(loaded, /^!> run it$/m, `/chat load lost /tools trust-all (prompt):\n${loaded}`);
  assert.match(loaded, TRUSTED, loaded);
});

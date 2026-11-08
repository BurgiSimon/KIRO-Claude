/**
 * Round-8 fix "signals-docs" #5, #6 and #11: what the docs say about the second signal and about
 * `/chat resume` matches the code.
 *  - #5 README.md: a second signal ends kiro-claude at once unless it comes within half a second
 *    of the first and is the same signal or the other of SIGHUP and SIGTERM (r7g: closing the
 *    terminal of a chat stopped with Ctrl+Z sends SIGHUP then SIGTERM, one event); shown with the
 *    built CLI over the fake claude: a SIGHUP 400 ms after a SIGTERM waits for the close.
 *  - #6 docs/ARCHITECTURE.md ("Fatal signals") and the exitSignals.ts module doc: ExitSignals
 *    holds SIGINT from the first SIGHUP / SIGTERM on, so a SIGINT after one is a second signal in
 *    the main phase too (r8f-signals-cli / -exits show the behaviour).
 *  - #11 src/repl/commands/chat.ts module doc: `resume` runs the picked record on its own agent,
 *    model and effort, `new` on the chat's; shown with the built CLI: after `/chat resume` the
 *    prompt is the record's agent and the answer comes from the record's model.
 *
 * Reads README.md, docs/ and src/ from the repository root (tests run from there).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { builtBin } from '../cli/helpers.js';
import { cli, mkRoot, sessionEndHook, sleep } from '../headless/r5f-signals-helpers.js';
import { removeOnExit } from '../tmpdirs.js';

function repoRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (fs.existsSync(path.join(dir, 'src', 'repl', 'exitSignals.ts')) && fs.existsSync(path.join(dir, 'docs', 'ARCHITECTURE.md'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('run the tests from the repository root');
    dir = parent;
  }
}

const ROOT = repoRoot();
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** Prose with line breaks (and a doc comment's ` * `) folded into spaces. */
const flat = (s: string): string => s.replace(/\n\s*\*(?!\/)/g, ' ').replace(/\s+/g, ' ');
/** The leading doc comment of a source file. */
const moduleDoc = (rel: string): string => {
  const src = read(rel);
  return flat(src.slice(0, src.indexOf('*/')));
};

/** The text under `heading` (matched exactly) up to the next heading of that level or higher. */
function section(md: string, heading: string): string {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => l === heading);
  assert.ok(start >= 0, `heading ${JSON.stringify(heading)} not found`);
  const level = /^#+/.exec(heading)![0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(#+) /.exec(lines[i]!);
    if (m && m[1]!.length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

test('r8f #5: README: a SIGHUP 400 ms after a SIGTERM waits for the close, and the second-signal rule says so', { skip: process.platform === 'win32', timeout: 60_000 }, async () => {
  const r = mkRoot({ turns: [{ repeat: true, steps: [{ text: 'ANSWER END' }] }] });
  removeOnExit(r.root);
  const F = path.join(r.root, 'F');
  sessionEndHook(r, `cat >/dev/null; echo start >> '${F}'; sleep 1; echo end >> '${F}'`);
  const c = cli(r, ['chat']);
  try {
    await c.waitFor(/> $/);
    c.line('hello');
    await c.waitFor(/ANSWER END[\s\S]*> $/);
    await sleep(200);
    const t0 = performance.now();
    c.kill('SIGTERM');
    await sleep(400);
    c.kill('SIGHUP');
    const e = await c.exit;
    const took = performance.now() - t0;
    const hook = fs.existsSync(F) ? fs.readFileSync(F, 'utf8').trim().split('\n') : [];
    const info = JSON.stringify({ e, took, hook });
    assert.equal(e.signal, 'SIGTERM', info);
    assert.deepEqual(hook, ['start', 'end'], `the SessionEnd hook was cut short: ${info}`);
    assert.ok(took > 900, info);
  } finally {
    c.dispose();
  }

  const readme = flat(read('README.md'));
  const at = readme.indexOf('A second signal ends it at once');
  assert.ok(at >= 0, 'README no longer has the second-signal sentence');
  const rule = readme.slice(at, readme.indexOf('After the signal', at));
  assert.match(rule, /within half a second of the first/, rule);
  assert.match(rule, /same signal/, rule);
  assert.match(rule, /SIGHUP and SIGTERM/, `the rule does not cover the SIGHUP / SIGTERM pair: "${rule}"`);
  assert.match(rule, /SIGINT/, `the rule does not say what a SIGINT after a SIGHUP / SIGTERM does: "${rule}"`);
  assert.doesNotMatch(rule, /unless it is the same signal within half a second/, rule);
});

test('r8f #6: ARCHITECTURE.md and the exitSignals.ts module doc: SIGINT is held from the first SIGHUP / SIGTERM on, so a SIGINT after one re-raises at once', () => {
  const arch = flat(section(read('docs/ARCHITECTURE.md'), '### Fatal signals: close, then die of the signal'));
  assert.match(arch, /SIGINT while the session starts[^.]*during the final close[^.]*from the first SIGHUP or SIGTERM on/, arch);
  assert.match(arch, /a SIGINT after a SIGHUP or SIGTERM/, arch);
  // what the front ends' own handlers do with that SIGINT, and the raw-mode key
  assert.match(arch, /muted read/, arch);
  assert.match(arch, /raw mode/, arch);
  assert.doesNotMatch(arch, /In between, Ctrl\+C belongs to the front end/, 'the old main-phase rule is still there');

  const doc = moduleDoc('src/repl/exitSignals.ts');
  assert.match(doc, /from the first SIGHUP \/ SIGTERM on/, doc);
  assert.doesNotMatch(doc, /in between Ctrl\+C belongs to the front end/, doc);
  assert.match(doc, /muted read/, doc);
});

test('r8f #11: /chat resume runs the picked record on its own agent and model, and the chat.ts module doc says so', { timeout: 120_000 }, () => {
  const r = mkRoot({});
  removeOnExit(r.root);
  fs.mkdirSync(path.join(r.home, '.kiro', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(r.home, '.kiro', 'agents', 'bee.json'), JSON.stringify({ name: 'bee', description: 'bee', prompt: 'you are bee', tools: ['*'] }));
  const env = r.env({ FAKE_CLAUDE_SCRIPT_JSON: JSON.stringify({ default: { steps: [{ text: 'ANSWER model={{model}}' }] } }) });
  const first = spawnSync(process.execPath, [builtBin(), 'chat', '--no-interactive', '--agent', 'bee', '--model', 'claude-haiku-4.5', 'first'], { cwd: r.ws, env, encoding: 'utf8', timeout: 60_000 });
  assert.match(first.stdout, /ANSWER model=claude-haiku/, first.stdout + first.stderr);
  const run = spawnSync(process.execPath, [builtBin(), 'chat', '--model', 'claude-sonnet-4.5'], {
    cwd: r.ws,
    env,
    encoding: 'utf8',
    timeout: 60_000,
    input: 'hello\n/chat resume\n1\nagain\n/quit\n',
  });
  const out = run.stdout.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
  const at = out.indexOf('Picking up where we left off');
  assert.ok(at > 0, out);
  // before: the chat's agent and model
  assert.match(out.slice(0, at), /ANSWER model=claude-sonnet/, out);
  // after: the record's
  const after = out.slice(at);
  assert.match(after, /\[bee\] >/, out);
  assert.match(after, /ANSWER model=claude-haiku/, out);
  assert.doesNotMatch(after, /ANSWER model=claude-sonnet/, out);

  const doc = moduleDoc('src/repl/commands/chat.ts');
  assert.doesNotMatch(doc, /`resume` create a fresh \/ resumed KiroSession with the current agent, model/, 'the module doc says /chat resume starts with the current agent and model');
  assert.match(doc, /`new` creates a fresh KiroSession with the chat's current agent, model and effort/, doc);
  assert.match(doc, /`resume` resumes the picked record on its own agent, model and effort \(the chat's effort when the record has none\)/, doc);
});

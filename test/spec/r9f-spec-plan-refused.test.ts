/**
 * Round 9, finding #7 (spec side): in a plan-mode chat, the revision turn's write of a phase
 * document that workflow.restrictionFor leaves out of the write allowance (r8 #9 verifier: a
 * document that is not a regular file, or that the user cannot read) was denied with the
 * plan-mode denial ("Plan mode is read-only. Exit plan mode … to make changes"), which blames plan
 * mode for a write that is refused either way; outside plan mode it was "only (nothing) may be
 * written now" with no reason.
 *
 * Now the restriction carries what it left out, with the reason (`refusedWritePaths`, also into
 * the forked phase session), and the gate gives the spec-phase denial with the reason in both
 * modes, as it does for a symbolic link at the document. Through the real binary
 * (`kiro-claude chat` over test/fixtures/fake-claude.mjs, whose turn writes bugfix.md and echoes
 * the tool result): a bugfix.md that is a directory, and (as uid 65534 through setpriv, when the
 * tests run as root) a bugfix.md the user cannot read. Nothing on disk changes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createReplRuntime, reviseSpec } from '../../src/spec/workflow.js';
import { fakeClaudePath } from '../claude/helpers.js';
import { BUGFIX_MD, MockHost, REQ_MD, fakeModel, makeWs, writeSpec } from './helpers.js';
import { removeOnExit } from '../tmpdirs.js';

const BIN = fileURLToPath(new URL('../../src/bin/kiro-claude.js', import.meta.url));
const IS_ROOT = process.getuid?.() === 0;
const NOBODY = 65534;
const SCRIPT = JSON.stringify({
  turns: [
    {
      repeat: true,
      steps: [{ tool: { name: 'Write', input: { file_path: '{{cwd}}/.kiro/specs/feat/bugfix.md', content: 'x' }, permission: 'ask' } }, { text: 'tool said: {{lastToolResult}}' }],
    },
  ],
});

interface Sandbox {
  base: string;
  env: NodeJS.ProcessEnv;
  ws: string;
  dir: string;
}

function sandbox(asNobody: boolean): Sandbox {
  const base = removeOnExit(fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'kc-r9f-spec-plan-'))));
  fs.chmodSync(base, 0o755);
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '', NO_COLOR: '1', FAKE_CLAUDE_SCRIPT_JSON: SCRIPT };
  for (const [k, d] of [
    ['HOME', 'home'],
    ['KIRO_HOME', 'kiro'],
    ['CLAUDE_CONFIG_DIR', 'claude'],
    ['XDG_RUNTIME_DIR', 'xdgrt'],
    ['XDG_CACHE_HOME', 'cache'],
  ] as const) {
    const p = path.join(base, d);
    fs.mkdirSync(p, { mode: 0o700 });
    if (asNobody) fs.chownSync(p, NOBODY, NOBODY);
    env[k] = p;
  }
  const fake = path.join(base, 'fake-claude.mjs');
  fs.copyFileSync(fakeClaudePath(), fake);
  fs.chmodSync(fake, 0o755);
  env.KIRO_CLAUDE_BIN = fake;
  const ws = path.join(base, 'ws');
  const dir = path.join(ws, '.kiro', 'specs', 'feat');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.config.kiro'), '{"specId": "x", "workflowType": "requirements-first", "specType": "bugfix"}');
  return { base, env, ws, dir };
}

function chownR(p: string): void {
  fs.lchownSync(p, NOBODY, NOBODY);
  if (fs.lstatSync(p).isDirectory()) for (const e of fs.readdirSync(p)) chownR(path.join(p, e));
}

/** `kiro-claude chat` with `lines` on stdin (then /quit); the line where the fake echoes its Write's result. */
function chat(s: Sandbox, lines: string[], asNobody: boolean): { said: string; all: string } {
  const argv = [process.execPath, BIN, 'chat'];
  const [cmd, ...args] = asNobody ? ['setpriv', `--reuid=${NOBODY}`, `--regid=${NOBODY}`, '--clear-groups', ...argv] : argv;
  const r = spawnSync(cmd!, args, { cwd: s.ws, env: s.env, encoding: 'utf8', input: `${[...lines, '/quit'].join('\n')}\n`, timeout: 90_000 });
  const all = `(exit ${r.status})\n${r.stdout}${r.stderr}`;
  return { said: all.split('\n').find((l) => l.includes('tool said:')) ?? '(no tool result line)', all };
}

/** `/spec revise` of the bugfix spec without and with plan mode: the same spec-phase denial, with `why`. */
function assertSpecDenial(s: Sandbox, why: string, asNobody: boolean): void {
  const want = `Spec phase bugfix: only (nothing) may be written now (${why})`;
  for (const lines of [
    ['/spec revise feat more detail', '2'],
    ['/plan', '/spec revise feat more detail', '2'],
  ]) {
    const r = chat(s, lines, asNobody);
    const shown = `${lines.join(' ⏎ ')}\n${r.said}\n${r.all}`;
    assert.ok(r.said.includes(want), shown);
    assert.doesNotMatch(r.said, /Plan mode is read-only/, shown);
    assert.doesNotMatch(r.all, /File created successfully/, shown);
  }
}

function binSkip(asNobody: boolean): string | false {
  if (process.platform !== 'linux') return 'linux only';
  if (!asNobody) return false;
  if (!IS_ROOT) return 'needs root (to run as uid 65534 through setpriv)';
  if (spawnSync('setpriv', ['--version']).status !== 0) return 'setpriv is not available';
  const r = spawnSync('setpriv', [`--reuid=${NOBODY}`, `--regid=${NOBODY}`, '--clear-groups', process.execPath, '-e', 'require("fs").accessSync(process.argv[1], 4)', BIN]);
  return r.status === 0 ? false : `the build at ${BIN} is not readable by uid ${NOBODY}`;
}

test('a bugfix.md that is a directory: its write gets the spec-phase denial with the reason, with and without plan mode', { skip: binSkip(false), timeout: 240_000 }, () => {
  const s = sandbox(false);
  const doc = path.join(s.dir, 'bugfix.md');
  fs.mkdirSync(doc);
  assertSpecDenial(s, `${doc} is not a regular file`, false);
  assert.deepEqual(fs.readdirSync(doc), []);
});

test('a bugfix.md the user cannot read (uid 65534): its write gets the spec-phase denial with the reason, with and without plan mode', { skip: binSkip(true), timeout: 240_000 }, () => {
  const s = sandbox(true);
  const doc = path.join(s.dir, 'bugfix.md');
  fs.writeFileSync(doc, BUGFIX_MD);
  chownR(s.ws);
  fs.chownSync(doc, 0, 0);
  fs.chmodSync(doc, 0o600);
  assertSpecDenial(s, `${doc} cannot be accessed (permission denied)`, true);
  assert.equal(fs.readFileSync(doc, 'utf8'), BUGFIX_MD);
});

test('control: a symbolic link at bugfix.md keeps the gate\'s own reason in plan mode', { skip: binSkip(false), timeout: 120_000 }, () => {
  const s = sandbox(false);
  fs.writeFileSync(path.join(s.ws, 'real.md'), '# x\n');
  fs.symlinkSync('../../../real.md', path.join(s.dir, 'bugfix.md'));
  const r = chat(s, ['/plan', '/spec revise feat more detail', '2'], false);
  assert.match(r.said, /Spec phase bugfix: only \S+bugfix\.md may be written now \(\S+bugfix\.md is a symbolic link\)/, r.all);
  assert.equal(fs.readFileSync(path.join(s.ws, 'real.md'), 'utf8'), '# x\n');
});

test('the phase session gets the left-out documents with their reason (refusedWritePaths); a readable document is allowed, none is left out', async () => {
  const w = makeWs('kc-r9f-spec-plan-');
  removeOnExit(w.root);
  const dir = writeSpec(w, 'feat', { requirements: REQ_MD, config: '{"specId": "x", "workflowType": "design-first", "specType": "feature"}' });
  const design = path.join(dir, 'design.md');
  fs.mkdirSync(design);
  const host = new MockHost(w.ctx, fakeModel());
  host.chooseAnswers = ['Stop here'];
  await reviseSpec(createReplRuntime(host, { openEditor: null }), 'feat', 'add a criterion');
  const phases = host.created.map((o) => o.specPhase).filter((p) => p !== undefined);
  assert.deepEqual(phases, [
    { name: 'requirements', allowedWritePaths: [path.join(dir, 'requirements.md')], refusedWritePaths: [{ path: design, why: `${design} is not a regular file` }] },
  ]);
  // control: nothing refused, nothing carried
  const w2 = makeWs('kc-r9f-spec-plan-');
  removeOnExit(w2.root);
  const d2 = writeSpec(w2, 'feat', { bugfix: BUGFIX_MD });
  const h2 = new MockHost(w2.ctx, fakeModel());
  h2.chooseAnswers = ['Stop here'];
  await reviseSpec(createReplRuntime(h2, { openEditor: null }), 'feat', 'more detail');
  assert.deepEqual(h2.created.map((o) => o.specPhase).filter((p) => p !== undefined), [{ name: 'bugfix', allowedWritePaths: [path.join(d2, 'bugfix.md')] }]);
});

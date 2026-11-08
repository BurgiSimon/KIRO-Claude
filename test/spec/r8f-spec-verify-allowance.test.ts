/**
 * Round 8, verifier of the spec fixes, finding #9 follow-up (permissions): a phase turn's write
 * allowance (workflow.restrictionFor) named every document of the phase, also one kiro-claude
 * refuses. The gate (policy/specwrite.checkSpecWrite) refuses a write through a symbolic link at
 * the document, or a path that leaves the workspace, but not a write to a document that is not a
 * regular file (a directory: its whole subtree) or that the user cannot read (mode 0200): such a
 * write was allowed without asking ("spec phase … may write this file"), also headless. So a
 * revision turn (`spec revise`, the checkpoint's "Request changes…") could write a document the
 * workflow itself never reads or writes, against the rule that the gate denies the write of a
 * refused document. The r8 #9 fix made this reachable for a bugfix spec without a usable
 * `specType` whose bugfix.md is refused (it now awaits review; before, `spec revise` refused the
 * spec before any turn); for the other documents it dates from r7 #6.
 *
 * Now the allowance leaves out every phase document that exists and is refused for a reason the
 * gate does not see itself (a link at it keeps its place: the gate refuses it with that reason,
 * r5 #3), so the write is denied ("only (nothing) may be written now"). Through the real gate:
 * the headless spec CLI over test/fixtures/fake-claude.mjs (it answers "File created
 * successfully" only for a Write the gate allowed); the unreadable cases run as uid 65534 through
 * setpriv when the tests run as root (else as the user, mode 0200).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import type { CliContext } from '../../src/types.js';
import { createWorkspaceContext } from '../../src/config/workspace.js';
import { runSpecCommandWith } from '../../src/spec/cli.js';
import { fakeClaudePath, fakeEnv } from '../claude/helpers.js';
import { BUGFIX_MD, DESIGN_MD, REQ_MD, makeWs, mockSettings, writeSpec, type Ws } from './helpers.js';
import { removeOnExit } from '../tmpdirs.js';

class Capture extends Writable {
  data = '';
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void): void {
    this.data += chunk.toString();
    cb();
  }
}

function ws(): Ws {
  const w = makeWs('kc-r8f-spec-verify-allow-');
  removeOnExit(w.root);
  return w;
}

/** A spec turn (its prompt holds the spec-mode block) that writes each file and prints the tool result as `W<i>[…]`. */
function writes(files: string[]): unknown {
  return {
    turns: [
      {
        repeat: true,
        match: 'kiro-spec-mode',
        steps: files.flatMap((f, i) => [{ tool: { name: 'Write', input: { file_path: f, content: '# Overwritten\n' } } }, { text: `W${i}[{{lastToolResult}}]` }]),
      },
      { repeat: true, steps: [{ text: 'ANSWER' }] },
    ],
  };
}

function result(out: string, i: number): string {
  return (new RegExp(`W${i}\\[([\\s\\S]*?)\\]`).exec(out)?.[1] ?? '').replace(/\s+/g, ' ');
}

/** `kiro-claude spec <args>` headless in `w`, in process, over the fake with `script` (the real gate). */
async function headless(w: Ws, args: string[], script: unknown): Promise<{ code: number; out: string; err: string }> {
  const claudeConfig = path.join(w.root, 'claude-config');
  const runtime = path.join(w.root, 'run');
  fs.mkdirSync(claudeConfig, { recursive: true });
  fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
  const env = fakeEnv({
    HOME: w.home,
    USERPROFILE: w.home,
    KIRO_HOME: path.join(w.home, '.kiro'),
    CLAUDE_CONFIG_DIR: claudeConfig,
    XDG_RUNTIME_DIR: runtime,
    XDG_CACHE_HOME: path.join(w.root, 'cache'),
    KIRO_CLAUDE_BIN: fakeClaudePath(),
    FAKE_CLAUDE_SCRIPT_JSON: JSON.stringify(script),
    ANTHROPIC_API_KEY: undefined,
    CLAUDE_CODE_EFFORT_LEVEL: undefined,
    KIRO_CLAUDE_SESSIONS_DIR: undefined,
  });
  const out = new Capture();
  const err = new Capture();
  const ctx: CliContext = {
    ws: createWorkspaceContext(w.proj, env),
    settings: mockSettings(),
    stdin: new PassThrough() as unknown as NodeJS.ReadStream,
    stdout: out as unknown as NodeJS.WriteStream,
    stderr: err as unknown as NodeJS.WriteStream,
    progName: 'kiro-claude',
    verbosity: 0,
  };
  const code = await runSpecCommandWith(args, ctx);
  return { code, out: out.data, err: err.data };
}

const NOTHING = /Spec phase (\w+): only \(nothing\) may be written now$/;

test('a bugfix.md that is a directory (no .config.kiro: a bugfix spec, r8 #9): spec revise writes neither it nor into it', { timeout: 60_000 }, async () => {
  const w = ws();
  const dir = writeSpec(w, 'fix-crash', {});
  const doc = path.join(dir, 'bugfix.md');
  fs.mkdirSync(doc);
  const r = await headless(w, ['revise', 'fix-crash', 'fix', 'it'], writes([doc, path.join(doc, 'notes.md')]));
  const all = `(exit ${r.code})\n${r.out}\n${r.err}`;
  assert.ok(r.err.includes(`${doc} is not a regular file`), all);
  assert.match(result(r.out, 0), NOTHING, all);
  assert.match(result(r.out, 1), NOTHING, all);
  assert.doesNotMatch(r.out, /File created successfully/, all);
  assert.equal(r.code, 1, all);
});

test('a design.md that is a directory (feature spec): spec revise of design.md writes neither it nor into it', { timeout: 60_000 }, async () => {
  const w = ws();
  const dir = writeSpec(w, 'feat', { requirements: REQ_MD });
  const doc = path.join(dir, 'design.md');
  fs.mkdirSync(doc);
  const r = await headless(w, ['revise', 'feat', 'make', 'it', 'shorter'], writes([doc, path.join(doc, 'inner.md')]));
  const all = `(exit ${r.code})\n${r.out}\n${r.err}`;
  assert.match(result(r.out, 0), /Spec phase design: only \(nothing\) may be written now$/, all);
  assert.match(result(r.out, 1), /Spec phase design: only \(nothing\) may be written now$/, all);
  assert.doesNotMatch(r.out, /File created successfully/, all);
});

test('design-first: the revision of requirements.md may write it, never into a design.md that is a directory', { timeout: 60_000 }, async () => {
  const w = ws();
  const dir = writeSpec(w, 'feat', { requirements: REQ_MD, config: '{"specId": "x", "workflowType": "design-first", "specType": "feature"}' });
  const design = path.join(dir, 'design.md');
  fs.mkdirSync(design);
  const req = path.join(dir, 'requirements.md');
  const r = await headless(w, ['revise', 'feat', 'add', 'a', 'criterion'], writes([req, path.join(design, 'inner.md')]));
  const all = `(exit ${r.code})\n${r.out}\n${r.err}`;
  assert.match(result(r.out, 0), /File created successfully at: .*requirements\.md/, all);
  assert.equal(result(r.out, 1).match(/Spec phase requirements: only (\S+) may be written now$/)?.[1], req, all);
});

test('control: a symbolic link at the document keeps the gate\'s own reason (r5 #3)', { timeout: 60_000 }, async () => {
  const w = ws();
  const dir = writeSpec(w, 'feat', { requirements: REQ_MD });
  const target = path.join(w.proj, 'notes.md');
  fs.writeFileSync(target, DESIGN_MD);
  const doc = path.join(dir, 'design.md');
  fs.symlinkSync(target, doc);
  const r = await headless(w, ['revise', 'feat', 'make', 'it', 'shorter'], writes([doc]));
  assert.match(result(r.out, 0), /Spec phase design: only .*design\.md may be written now \(.*design\.md is a symbolic link\)$/, r.out + r.err);
  assert.equal(fs.readFileSync(target, 'utf8'), DESIGN_MD);
});

test('control: a readable document is still written by its revision turn', { timeout: 60_000 }, async () => {
  const w = ws();
  const dir = writeSpec(w, 'fix-crash', { bugfix: BUGFIX_MD });
  const doc = path.join(dir, 'bugfix.md');
  const r = await headless(w, ['revise', 'fix-crash', 'fix', 'it'], writes([doc]));
  assert.match(result(r.out, 0), /File created successfully at: .*bugfix\.md/, r.out + r.err);
});

// ───────────── a document the user cannot read but may write (mode 0200), real permissions ─────────────

const BIN = fileURLToPath(new URL('../../src/bin/kiro-claude.js', import.meta.url));
const IS_ROOT = process.getuid?.() === 0;
const NOBODY = 65534;

function unprivileged(): string[] {
  return IS_ROOT ? ['setpriv', `--reuid=${NOBODY}`, `--regid=${NOBODY}`, '--clear-groups', process.execPath] : [process.execPath];
}

function cliSkip(): string | false {
  if (process.platform !== 'linux') return 'linux only';
  if (!IS_ROOT) return false;
  if (spawnSync('setpriv', ['--version']).status !== 0) return 'setpriv is not available';
  const [cmd, ...pre] = unprivileged();
  const r = spawnSync(cmd!, [...pre, '-e', 'require("fs").accessSync(process.argv[1], 4)', BIN]);
  return r.status === 0 ? false : `the build at ${BIN} is not readable by uid ${NOBODY}`;
}

/** Spec `fix-crash` with `doc` (mode 0200, the user's own) and `config`; `spec revise` as that user, its turn writing `doc`. */
function reviseWriteOnly(docName: string, config: string | undefined): { status: number | null; text: string; doc: string; body: string } {
  const base = removeOnExit(fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'kc-r8f-spec-verify-allow-'))));
  fs.chmodSync(base, 0o755);
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '', NO_COLOR: '1' };
  for (const [k, d] of [
    ['HOME', 'home'],
    ['KIRO_HOME', 'kiro'],
    ['CLAUDE_CONFIG_DIR', 'claude'],
    ['XDG_RUNTIME_DIR', 'xdgrt'],
    ['XDG_CACHE_HOME', 'cache'],
  ] as const) {
    const p = path.join(base, d);
    fs.mkdirSync(p, { mode: 0o700 });
    if (IS_ROOT) fs.chownSync(p, NOBODY, NOBODY);
    env[k] = p;
  }
  const fake = path.join(base, 'fake-claude.mjs');
  fs.copyFileSync(fakeClaudePath(), fake);
  fs.chmodSync(fake, 0o755);
  env.KIRO_CLAUDE_BIN = fake;
  const wsDir = path.join(base, 'ws');
  const dir = path.join(wsDir, '.kiro', 'specs', 'fix-crash');
  fs.mkdirSync(dir, { recursive: true });
  if (config !== undefined) fs.writeFileSync(path.join(dir, '.config.kiro'), config);
  const doc = path.join(dir, docName);
  const body = docName === 'bugfix.md' ? BUGFIX_MD : REQ_MD;
  fs.writeFileSync(doc, body);
  if (IS_ROOT) for (const p of [wsDir, path.join(wsDir, '.kiro'), path.join(wsDir, '.kiro', 'specs'), dir, ...fs.readdirSync(dir).map((e) => path.join(dir, e))]) fs.lchownSync(p, NOBODY, NOBODY);
  fs.chmodSync(doc, 0o200);
  env.FAKE_CLAUDE_SCRIPT_JSON = JSON.stringify(writes([doc]));
  const [cmd, ...pre] = unprivileged();
  const r = spawnSync(cmd!, [...pre, BIN, 'spec', 'revise', 'fix-crash', 'fix', 'it'], { cwd: wsDir, env, encoding: 'utf8', timeout: 90_000 });
  fs.chmodSync(doc, 0o644);
  return { status: r.status, text: `${r.stdout}${r.stderr}`, doc, body };
}

for (const [label, docName, config] of [
  ['a bugfix.md without .config.kiro (a bugfix spec, r8 #9)', 'bugfix.md', undefined],
  ['a bugfix.md with a legacy {"generationMode"} .config.kiro', 'bugfix.md', '{"generationMode": "requirements-first"}'],
  ['a requirements.md of a feature spec', 'requirements.md', '{"specId": "x", "workflowType": "requirements-first", "specType": "feature"}'],
] as const) {
  test(`${label} the user cannot read but may write: spec revise never gets to write it`, { skip: cliSkip(), timeout: 120_000 }, () => {
    const r = reviseWriteOnly(docName, config);
    const all = `(exit ${r.status})\n${r.text}`;
    assert.ok(r.text.includes(`${r.doc} cannot be accessed (permission denied)`), all);
    assert.match(result(r.text, 0), NOTHING, all);
    assert.doesNotMatch(r.text, /File created successfully/, all);
    assert.equal(r.status, 1, all);
    assert.equal(fs.readFileSync(r.doc, 'utf8'), r.body);
  });
}

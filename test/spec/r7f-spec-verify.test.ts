/**
 * Round 7 verifier of the spec group's fixes (#6, #7, #8, #10): defects found while trying to
 * break them.
 *
 *  - V1 (#6, another entry point): a spec folder the user may read but not write (its owner is
 *    another user, or it is mode 0555). `spec run` could not mark the task in progress, printed
 *    the raw EACCES and then failed the task with the false reason "task is no longer in
 *    tasks.md". The task now fails with the true write error.
 *  - V2 (#6, the race at read time): a spec document that becomes one kiro-claude does not read
 *    (EACCES, or a link: docfs) after the task's last summary and before its context is built was
 *    left out of the context silently (store.specContextBlock recorded the refusal on a copy),
 *    and the task ran without requirements.md, against workflow.ts's "its context never silently
 *    lacks a document". specContextBlock now reports what it refused; the task fails with it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { specContextBlock, summarizeSpecDir } from '../../src/spec/store.js';
import { createReplRuntime, runSpecTasks } from '../../src/spec/workflow.js';
import { fakeClaudePath } from '../claude/helpers.js';
import { DESIGN_MD, MockHost, REQ_MD, TASKS_MD, fakeModel, makeWs, writeSpec } from './helpers.js';
import type { KiroSession, KiroSessionOptions } from '../../src/types.js';

const BIN = fileURLToPath(new URL('../../src/bin/kiro-claude.js', import.meta.url));
const IS_ROOT = process.getuid?.() === 0;
const NOBODY = 65534;
const CONFIG = '{"specId": "x", "workflowType": "requirements-first", "specType": "feature"}';

/** Why the real-permission test cannot run here (no setpriv, or the build is not readable by uid 65534). */
function cliSkip(): string | false {
  if (process.platform !== 'linux') return 'linux only';
  if (!IS_ROOT) return false;
  if (spawnSync('setpriv', ['--version']).status !== 0) return 'setpriv is not available';
  const r = spawnSync('setpriv', [`--reuid=${NOBODY}`, `--regid=${NOBODY}`, '--clear-groups', process.execPath, '-e', 'require("fs").accessSync(process.argv[1], 4)', BIN]);
  return r.status === 0 ? false : `the build at ${BIN} is not readable by uid ${NOBODY}`;
}

test('V1 a spec folder the user cannot write: spec run fails the task with the write error, not "task is no longer in tasks.md"', { skip: cliSkip() }, () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'kc-r7f-spec-verify-')));
  const feat = path.join(base, 'ws', '.kiro', 'specs', 'feat');
  try {
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
    const log = path.join(base, 'fake.log');
    fs.writeFileSync(log, '');
    fs.chmodSync(log, 0o666);
    env.FAKE_CLAUDE_LOG = log;
    fs.mkdirSync(feat, { recursive: true });
    fs.writeFileSync(path.join(feat, '.config.kiro'), CONFIG);
    fs.writeFileSync(path.join(feat, 'requirements.md'), REQ_MD);
    fs.writeFileSync(path.join(feat, 'design.md'), DESIGN_MD);
    fs.writeFileSync(path.join(feat, 'tasks.md'), TASKS_MD);
    const ws = path.join(base, 'ws');
    if (IS_ROOT) {
      // the workspace is the user's; the feature folder (readable) is another user's
      for (const p of [ws, path.join(ws, '.kiro'), path.join(ws, '.kiro', 'specs')]) fs.chownSync(p, NOBODY, NOBODY);
      fs.chmodSync(feat, 0o755);
    } else fs.chmodSync(feat, 0o555);
    const pre = IS_ROOT ? ['setpriv', `--reuid=${NOBODY}`, `--regid=${NOBODY}`, '--clear-groups', process.execPath] : [process.execPath];
    const r = spawnSync(pre[0]!, [...pre.slice(1), BIN, 'spec', 'run', 'feat', '--next'], { cwd: ws, env, encoding: 'utf8', timeout: 90_000 });
    const text = `${r.stdout}${r.stderr}`;
    assert.equal(r.status, 1, text);
    assert.match(text, /1\.1: failed — .*EACCES/, text);
    assert.doesNotMatch(text, /task is no longer in tasks\.md/, text);
    assert.equal(fs.readFileSync(path.join(feat, 'tasks.md'), 'utf8'), TASKS_MD);
  } finally {
    try {
      fs.chmodSync(feat, 0o755);
    } catch {
      // gone
    }
    fs.rmSync(base, { recursive: true, force: true });
  }
});

/** requirements.md of 4096 bytes or more (docInfo does not read it to tell whether it is empty). */
const BIG_REQ_MD = `${REQ_MD}\n${'<!-- padding -->\n'.repeat(300)}`;

/**
 * Make `open(2)` of `file` fail with EACCES from now on (as a chmod by another process would; root
 * bypasses permissions, so the failure is injected). Returns the undo.
 */
function denyOpen(file: string): () => void {
  const cjsFs = createRequire(import.meta.url)('node:fs') as typeof fs;
  const orig = cjsFs.openSync;
  cjsFs.openSync = ((p: fs.PathLike, ...rest: unknown[]) => {
    if (path.resolve(String(p)) === file) throw Object.assign(new Error(`EACCES: permission denied, open '${file}'`), { code: 'EACCES', errno: -13, syscall: 'open', path: file });
    return (orig as (...a: unknown[]) => number)(p, ...rest);
  }) as typeof fs.openSync;
  syncBuiltinESMExports();
  return () => {
    cjsFs.openSync = orig;
    syncBuiltinESMExports();
  };
}

test('V2 specContextBlock reports a document refused only when it is read (EACCES, a link), instead of leaving it out silently', () => {
  const w = makeWs('kc-r7f-spec-verify-');
  let undo: (() => void) | undefined;
  try {
    const dir = writeSpec(w, 'feat', { requirements: BIG_REQ_MD, design: DESIGN_MD, tasks: TASKS_MD, config: CONFIG });
    const s = summarizeSpecDir(dir);
    assert.equal(s.refused, undefined);
    const req = path.join(dir, 'requirements.md');
    undo = denyOpen(req);
    const refused: string[] = [];
    const block = specContextBlock(w.ctx, s, refused);
    assert.deepEqual(refused, [`${req} cannot be accessed (permission denied)`]);
    assert.ok(block?.includes('design.md'));
    assert.ok(!block?.includes(req));
    undo();
    undo = undefined;
    // a link that appears at a document after the summary
    const design = path.join(dir, 'design.md');
    fs.renameSync(design, path.join(w.root, 'design-elsewhere.md'));
    fs.symlinkSync(path.join(w.root, 'design-elsewhere.md'), design);
    const refused2: string[] = [];
    specContextBlock(w.ctx, s, refused2);
    assert.deepEqual(refused2, [`${design} is a symbolic link`]);
  } finally {
    undo?.();
    w.cleanup();
  }
});

test('V2 a document that cannot be read when the task context is built (after the last check): the task fails with the reason, it never runs without it', async () => {
  const w = makeWs('kc-r7f-spec-verify-');
  let undo: (() => void) | undefined;
  try {
    const dir = writeSpec(w, 'feat', { requirements: BIG_REQ_MD, design: DESIGN_MD, tasks: TASKS_MD, config: CONFIG });
    const req = path.join(dir, 'requirements.md');
    class DenyingHost extends MockHost {
      override async createSession(opts: Partial<KiroSessionOptions>): Promise<KiroSession> {
        // e.g. a parallel task's turn makes requirements.md unreadable right after the last
        // summary (here: from the task session's start on; the summary does not open a document
        // of 4096 bytes or more)
        undo ??= denyOpen(req);
        return super.createSession(opts);
      }
    }
    const h = new DenyingHost(w.ctx, fakeModel());
    const r = await runSpecTasks(createReplRuntime(h, { openEditor: null }), 'feat', { kind: 'next' });
    undo?.();
    undo = undefined;
    const prompts = h.sessions.flatMap((s) => s.prompts);
    const ran = prompts.filter((p) => /Execute Task/.test(p.text));
    assert.equal(ran.length, 0, `the task ran with a context of ${JSON.stringify(ran.map((p) => (p.extraContext ?? []).join('\n').match(/\[[^\]]+\.md\]/g)))}`);
    assert.equal(r.outcomes[0]?.status, 'failed');
    assert.match(r.outcomes[0]?.reason ?? '', /requirements\.md cannot be accessed \(permission denied\)/);
  } finally {
    undo?.();
    w.cleanup();
  }
});

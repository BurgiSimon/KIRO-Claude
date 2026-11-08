/**
 * Round 6, finding #7 (spec-links): a spec folder link, or a linked `.kiro/specs`, whose target
 * EXISTS but lies behind a folder the user cannot enter makes `realpath` fail with EACCES, not
 * ENOENT. policy/specwrite.ts took every realpath failure at a link for "resolves to nothing
 * (dangling, or a loop)", and spec/docfs.ts added the advice "replace it with a regular file, or
 * move the spec folder into the workspace", which cannot help (the folder already is in the
 * workspace). Now only ENOENT, ENOTDIR and ELOOP mean dangling or a loop; EACCES and EPERM are
 * still refused (never resolved lexically, which could place an outside target inside the
 * workspace) with their own reason, `the target of the symbolic link <link> cannot be accessed
 * (permission denied)`, and an advice that is true for it.
 *
 * The unit tests make realpath throw (as it does for an unprivileged user); the CLI test runs
 * `kiro-claude spec` with real permissions (as uid/gid 65534 through setpriv when the tests run as
 * root, else with the folder at mode 000).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { specFileRefusal, specFolderRefusal } from '../../src/policy/specwrite.js';
import { SPEC_LINK_RULE, readSpecFile, specRefusalText, specsRootRefused } from '../../src/spec/docfs.js';
import { createSpecFolder, formatSpecRefusals, listSpecs, resolveSpecDir, summarizeSpecDir } from '../../src/spec/store.js';
import { fakeClaudePath } from '../claude/helpers.js';
import { REQ_MD, makeWs, type Ws } from './helpers.js';

const DANGLING = /resolves to nothing|dangling/;
const DENIED = /cannot be accessed \(permission denied\)/;
const MOVE_ADVICE = /replace it with a regular file|move the spec folder into the workspace/;

type RealpathNative = (p: fs.PathLike, ...rest: unknown[]) => string;
const rp = fs.realpathSync as unknown as { native: RealpathNative };

/**
 * Make realpath throw `code` for every path in `blocked` and below it (what an unprivileged user
 * gets for a link whose target is behind a folder it cannot enter); returns the restore.
 */
function failRealpath(blocked: string[], code = 'EACCES'): () => void {
  const real = rp.native;
  rp.native = (p, ...rest) => {
    const s = String(p);
    if (blocked.some((b) => s === b || s.startsWith(`${b}${path.sep}`))) throw Object.assign(new Error(`${code}: realpath '${s}'`), { code });
    return real(p, ...rest);
  };
  return () => {
    rp.native = real;
  };
}

/** `<proj>/.kiro/specs/feat -> ../../<target>` (a folder inside the workspace with a requirements.md). */
function linkedFeat(w: Ws, target = 'private/feat'): { link: string; real: string } {
  const real = path.join(w.proj, target);
  fs.mkdirSync(real, { recursive: true });
  fs.writeFileSync(path.join(real, 'requirements.md'), REQ_MD);
  const link = path.join(w.specs, 'feat');
  fs.symlinkSync(path.relative(w.specs, real), link);
  return { link, real };
}

test('specFolderRefusal / specFileRefusal: EACCES or EPERM at a folder link is refused as not accessible, never as dangling', () => {
  for (const code of ['EACCES', 'EPERM']) {
    const w = makeWs('kc-r6f-links-');
    try {
      const { link } = linkedFeat(w);
      const restore = failRealpath([link, path.join(w.proj, 'private')], code);
      let folder: string | undefined;
      let file: string | undefined;
      try {
        folder = specFolderRefusal(link, w.proj);
        file = specFileRefusal(path.join(link, 'design.md'), w.proj);
      } finally {
        restore();
      }
      assert.ok(folder, `${code}: the folder is not refused`);
      assert.doesNotMatch(folder, DANGLING, `${code}: ${folder}`);
      assert.equal(folder, `${link}: the target of the symbolic link ${link} cannot be accessed (permission denied)`);
      assert.equal(file, `${path.join(link, 'design.md')}: the target of the symbolic link ${link} cannot be accessed (permission denied)`);
    } finally {
      w.cleanup();
    }
  }
});

test('EACCES at a link to a folder OUTSIDE the workspace is still refused (no lexical fallback that would place it inside)', () => {
  const w = makeWs('kc-r6f-links-');
  try {
    const outside = path.join(w.root, 'outside', 'feat');
    fs.mkdirSync(outside, { recursive: true });
    const link = path.join(w.specs, 'feat');
    fs.symlinkSync(outside, link);
    // .kiro/specs itself linked out, behind a folder the user cannot enter
    const w2 = makeWs('kc-r6f-links-');
    try {
      const specs2 = path.join(w2.root, 'outside', 'specs');
      fs.mkdirSync(specs2, { recursive: true });
      fs.rmSync(w2.specs, { recursive: true });
      fs.symlinkSync(specs2, w2.specs);
      const restore = failRealpath([link, outside, w2.specs, specs2]);
      try {
        assert.match(specFolderRefusal(link, w.proj) ?? '', DENIED);
        assert.match(specFileRefusal(path.join(link, 'tasks.md'), w.proj) ?? '', DENIED);
        assert.match(specsRootRefused(w2.proj) ?? '', DENIED);
        assert.match(specFolderRefusal(path.join(w2.specs, 'other'), w2.proj) ?? '', DENIED);
        assert.throws(() => readSpecFile(path.join(link, 'tasks.md')), (e: unknown) => DENIED.test((e as { why?: string }).why ?? ''));
      } finally {
        restore();
      }
    } finally {
      w2.cleanup();
    }
  } finally {
    w.cleanup();
  }
});

test('controls: a dangling link, a loop and a link through a file keep the dangling reason and the replace/move advice', () => {
  const w = makeWs('kc-r6f-links-');
  try {
    const gone = path.join(w.specs, 'gone');
    fs.symlinkSync(path.join(w.root, 'nowhere'), gone);
    const a = path.join(w.specs, 'loop-a');
    const b = path.join(w.specs, 'loop-b');
    fs.symlinkSync(b, a);
    fs.symlinkSync(a, b);
    for (const l of [gone, a]) {
      const why = specFolderRefusal(l, w.proj) ?? '';
      assert.equal(why, `${l}: the symbolic link ${l} resolves to nothing (dangling, or a loop)`);
      assert.equal(specRefusalText(why), `${why}: ${SPEC_LINK_RULE}`);
    }
    // ENOTDIR at a link: its target goes through a regular file
    fs.writeFileSync(path.join(w.proj, 'notes.txt'), 'x');
    const viaFile = path.join(w.specs, 'via-file');
    fs.symlinkSync(path.join(w.proj, 'notes.txt', 'feat'), viaFile);
    assert.equal(specFolderRefusal(viaFile, w.proj), `${viaFile}: the symbolic link ${viaFile} resolves to nothing (dangling, or a loop)`);
    // the real error codes of these links
    const code = (p: string): string | undefined => {
      try {
        fs.realpathSync.native(p);
        return undefined;
      } catch (e) {
        return (e as { code?: string }).code;
      }
    };
    assert.deepEqual([code(gone), code(a), code(viaFile)], ['ENOENT', 'ELOOP', 'ENOTDIR']);
  } finally {
    w.cleanup();
  }
});

test('docfs.specRefusalText: a link whose target cannot be accessed gets no replace/move advice', () => {
  const link = '/w/.kiro/specs/feat';
  const why = `${link}: the target of the symbolic link ${link} cannot be accessed (permission denied)`;
  const text = specRefusalText(why);
  assert.ok(text.startsWith(`${why}: `), text);
  assert.doesNotMatch(text, MOVE_ADVICE);
  assert.ok(!text.includes(SPEC_LINK_RULE), text);
  assert.doesNotMatch(text, DANGLING);
  // every other reason keeps the rule
  for (const w of ['/w/.kiro/specs/feat/design.md is a symbolic link', `${link}: the symbolic link ${link} resolves to nothing (dangling, or a loop)`, `${link} resolves to /x, outside the workspace /w`]) {
    assert.equal(specRefusalText(w), `${w}: ${SPEC_LINK_RULE}`);
  }
});

test('store: a feature link behind a folder the user cannot enter is listed refused with the true reason; createSpecFolder under such a .kiro/specs names it', () => {
  const w = makeWs('kc-r6f-links-');
  try {
    const { link, real } = linkedFeat(w);
    const restore = failRealpath([link, path.dirname(real)]);
    try {
      const all = listSpecs(w.ctx);
      assert.deepEqual(all.map((s) => s.name), ['feat']);
      assert.match(all[0]!.refused ?? '', DENIED);
      assert.equal(resolveSpecDir(w.ctx, 'feat'), link);
      const lines = formatSpecRefusals(all);
      assert.equal(lines.length, 1);
      assert.doesNotMatch(lines[0]!, DANGLING);
      assert.doesNotMatch(lines[0]!, MOVE_ADVICE);
      assert.equal(summarizeSpecDir(link).docs.requirements.refused, all[0]!.refused);
    } finally {
      restore();
    }
    // .kiro/specs -> ../private/specs
    const w2 = makeWs('kc-r6f-links-');
    try {
      const specs2 = path.join(w2.proj, 'private', 'specs');
      fs.mkdirSync(specs2, { recursive: true });
      fs.rmSync(w2.specs, { recursive: true });
      fs.symlinkSync(path.join('..', 'private', 'specs'), w2.specs);
      const restore2 = failRealpath([w2.specs, path.join(w2.proj, 'private')]);
      try {
        assert.deepEqual(listSpecs(w2.ctx), []);
        assert.throws(
          () => createSpecFolder(w2.ctx, 'other', { specType: 'feature', workflowType: 'requirements-first' }),
          (e: unknown) => DENIED.test(String((e as Error).message)) && !DANGLING.test((e as Error).message) && !MOVE_ADVICE.test((e as Error).message),
        );
      } finally {
        restore2();
      }
      assert.deepEqual(fs.readdirSync(specs2), [], 'nothing was created behind the link');
    } finally {
      w2.cleanup();
    }
  } finally {
    w.cleanup();
  }
});

// ───────────────────────────── CLI, real permissions ─────────────────────────────

const BIN = fileURLToPath(new URL('../../src/bin/kiro-claude.js', import.meta.url));
const IS_ROOT = process.getuid?.() === 0;
const NOBODY = 65534;

/** argv prefix that runs node as an unprivileged user (root: setpriv to 65534; else as we are). */
function unprivileged(): string[] {
  return IS_ROOT ? ['setpriv', `--reuid=${NOBODY}`, `--regid=${NOBODY}`, '--clear-groups', process.execPath] : [process.execPath];
}

/** Why the CLI test cannot run here (no setpriv, or the build is not readable by uid 65534). */
function cliSkip(): string | false {
  if (process.platform !== 'linux') return 'linux only';
  if (!IS_ROOT) return false;
  if (spawnSync('setpriv', ['--version']).status !== 0) return 'setpriv is not available';
  const [cmd, ...pre] = unprivileged();
  const r = spawnSync(cmd!, [...pre, '-e', 'require("fs").accessSync(process.argv[1], 4)', BIN]);
  return r.status === 0 ? false : `the build at ${BIN} is not readable by uid ${NOBODY}`;
}

test('spec CLI: links into a folder the user cannot enter are refused with the true reason (list, status, approve, new)', { skip: cliSkip() }, () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'kc-r6f-links-cli-')));
  fs.chmodSync(base, 0o755);
  const owner = IS_ROOT ? NOBODY : process.getuid!();
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
    if (IS_ROOT) fs.chownSync(p, owner, owner);
    env[k] = p;
  }
  const fake = path.join(base, 'fake-claude.mjs');
  fs.copyFileSync(fakeClaudePath(), fake);
  fs.chmodSync(fake, 0o755);
  env.KIRO_CLAUDE_BIN = fake;
  // A: .kiro/specs/feat -> ../../private/feat (exists, inside the workspace, cannot be entered)
  const wsA = path.join(base, 'wsA');
  fs.mkdirSync(path.join(wsA, '.kiro', 'specs'), { recursive: true });
  fs.mkdirSync(path.join(wsA, 'private', 'feat'), { recursive: true });
  fs.writeFileSync(path.join(wsA, 'private', 'feat', 'requirements.md'), REQ_MD);
  fs.symlinkSync(path.join('..', '..', 'private', 'feat'), path.join(wsA, '.kiro', 'specs', 'feat'));
  // B: .kiro/specs -> ../private/specs (exists, inside the workspace, cannot be entered)
  const wsB = path.join(base, 'wsB');
  fs.mkdirSync(path.join(wsB, '.kiro'), { recursive: true });
  fs.mkdirSync(path.join(wsB, 'private', 'specs', 'feat'), { recursive: true });
  fs.symlinkSync(path.join('..', 'private', 'specs'), path.join(wsB, '.kiro', 'specs'));
  for (const d of [wsA, path.join(wsA, '.kiro'), path.join(wsA, '.kiro', 'specs'), wsB, path.join(wsB, '.kiro')]) fs.chmodSync(d, 0o755);
  const privates = [path.join(wsA, 'private'), path.join(wsB, 'private')];
  for (const p of privates) fs.chmodSync(p, IS_ROOT ? 0o700 : 0o000); // root-owned 0700, or 000 for a normal user

  const runs: { name: string; status: number | null; text: string }[] = [];
  try {
    const [cmd, ...pre] = unprivileged();
    for (const [ws, args] of [
      [wsA, ['spec', 'list']],
      [wsA, ['spec', 'status', 'feat']],
      [wsA, ['spec', 'approve', 'feat']],
      [wsB, ['spec', 'list']],
      [wsB, ['spec', 'new', 'other', '--description', 'x', '--yes']],
    ] as const) {
      const r = spawnSync(cmd!, [...pre, BIN, ...args], { cwd: ws, env, encoding: 'utf8', input: '', timeout: 60_000 });
      runs.push({ name: `${path.basename(ws)}: ${args.join(' ')}`, status: r.status, text: `${r.stdout}${r.stderr}` });
    }
  } finally {
    for (const p of privates) fs.chmodSync(p, 0o755);
  }
  try {
    const show = runs.map((r) => `--- ${r.name} (exit ${r.status})\n${r.text}`).join('\n');
    for (const r of runs) {
      assert.doesNotMatch(r.text, DANGLING, `${r.name} calls a permission problem a dangling link:\n${show}`);
      assert.doesNotMatch(r.text, MOVE_ADVICE, `${r.name} gives advice that cannot help:\n${show}`);
      assert.match(r.text, DENIED, `${r.name} does not say why:\n${show}`);
    }
    assert.deepEqual(
      runs.map((r) => r.status),
      [0, 0, 1, 1, 1],
      `exit codes (list A lists the spec refused; list B cannot list the folder; approve and new refuse):\n${show}`,
    );
    assert.match(runs[0]!.text, /^feat\s+feature\s+refused\s+-$/m, show);
    assert.deepEqual(fs.readdirSync(path.join(wsB, 'private', 'specs')), ['feat'], 'spec new created something behind the link');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

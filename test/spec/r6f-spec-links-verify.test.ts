/**
 * Round 6, finding #7 (spec-links), verifier: what the fixer's tests did not cover.
 *
 *  - docfs.specRefusalText chooses its advice by matching the reason's text
 *    (policy/specwrite.isLinkAccessRefusal). A path may hold a newline (legal on POSIX); the
 *    match then failed for a workspace (or a link) whose path holds one, and the "cannot be
 *    accessed (permission denied)" reason got the replace/move advice again.
 *  - With real permissions (as uid/gid 65534 through setpriv when root, else mode 000): a `.kiro`
 *    linked into a folder the user cannot enter, and a feature folder linked to a folder OUTSIDE
 *    the workspace behind such a folder, are refused with the true reason; a link into a folder
 *    the user may search but not read (0711) is not refused at all (realpath needs search only).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isLinkAccessRefusal, specFileRefusal, specFolderRefusal } from '../../src/policy/specwrite.js';
import { SPEC_LINK_ACCESS_RULE, SPEC_LINK_RULE, specRefusalText } from '../../src/spec/docfs.js';
import { formatSpecRefusals, listSpecs } from '../../src/spec/store.js';
import { createWorkspaceContext } from '../../src/config/workspace.js';
import { fakeClaudePath } from '../claude/helpers.js';
import { REQ_MD } from './helpers.js';

const DANGLING = /resolves to nothing|dangling/;
const DENIED = /cannot be accessed \(permission denied\)/;
const MOVE_ADVICE = /replace it with a regular file|move the spec folder into the workspace/;

type RealpathNative = (p: fs.PathLike, ...rest: unknown[]) => string;
const rp = fs.realpathSync as unknown as { native: RealpathNative };

/** realpath throws EACCES for `link` and below it (what an unprivileged user gets); returns the restore. */
function failRealpath(link: string): () => void {
  const real = rp.native;
  rp.native = (p, ...rest) => {
    const s = String(p);
    if (s === link || s.startsWith(`${link}${path.sep}`)) throw Object.assign(new Error(`EACCES: permission denied, realpath '${s}'`), { code: 'EACCES' });
    return real(p, ...rest);
  };
  return () => {
    rp.native = real;
  };
}

test('a workspace (or link) path with a newline: the permission-denied reason still gets its own advice, never the replace/move one', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kc-r6f-links-v-')));
  try {
    for (const [wsName, linkName] of [
      ['my\nproj', 'feat'],
      ['proj', 'fe\nat'],
    ] as const) {
      const proj = path.join(root, wsName);
      const specs = path.join(proj, '.kiro', 'specs');
      fs.mkdirSync(specs, { recursive: true });
      fs.mkdirSync(path.join(proj, 'private', linkName), { recursive: true });
      fs.writeFileSync(path.join(proj, 'private', linkName, 'requirements.md'), REQ_MD);
      const link = path.join(specs, linkName);
      fs.symlinkSync(path.join('..', '..', 'private', linkName), link);
      const ctx = createWorkspaceContext(proj, { HOME: path.join(root, 'home'), KIRO_HOME: path.join(root, 'home', '.kiro'), PATH: process.env.PATH ?? '' });
      const restore = failRealpath(link);
      let folder: string | undefined;
      let file: string | undefined;
      let lines: string[];
      try {
        folder = specFolderRefusal(link, proj);
        file = specFileRefusal(path.join(link, 'design.md'), proj);
        lines = formatSpecRefusals(listSpecs(ctx));
      } finally {
        restore();
      }
      const show = JSON.stringify({ folder, file, lines });
      assert.equal(folder, `${link}: the target of the symbolic link ${link} cannot be accessed (permission denied)`, show);
      for (const why of [folder!, file!]) {
        assert.ok(isLinkAccessRefusal(why), `not recognised as a permission problem: ${JSON.stringify(why)}`);
        assert.equal(specRefusalText(why), `${why}: ${SPEC_LINK_ACCESS_RULE}`);
      }
      assert.equal(lines.length, 1, show);
      assert.match(lines[0]!, DENIED, show);
      assert.doesNotMatch(lines[0]!, MOVE_ADVICE, show);
      assert.doesNotMatch(lines[0]!, DANGLING, show);
    }
    // a dangling link under a path with a newline keeps the dangling reason and the rule
    const proj = path.join(root, 'my\nproj');
    const gone = path.join(proj, '.kiro', 'specs', 'gone');
    fs.symlinkSync(path.join(root, 'nowhere'), gone);
    const why = specFolderRefusal(gone, proj)!;
    assert.match(why, DANGLING);
    assert.ok(!isLinkAccessRefusal(why));
    assert.equal(specRefusalText(why), `${why}: ${SPEC_LINK_RULE}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ───────────────────────────── CLI, real permissions ─────────────────────────────

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

test('spec CLI with real permissions: a .kiro linked into a folder the user cannot enter, a link out of the workspace behind one, and a search-only control', { skip: cliSkip() }, () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'kc-r6f-links-v-cli-')));
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
  // C: .kiro -> private/.kiro (exists, inside the workspace, cannot be entered)
  const wsC = path.join(base, 'wsC');
  fs.mkdirSync(path.join(wsC, 'private', '.kiro', 'specs', 'feat'), { recursive: true });
  fs.writeFileSync(path.join(wsC, 'private', '.kiro', 'specs', 'feat', 'requirements.md'), REQ_MD);
  fs.symlinkSync(path.join('private', '.kiro'), path.join(wsC, '.kiro'));
  // D: .kiro/specs/feat -> <base>/outpriv/feat (OUTSIDE the workspace, behind a folder that cannot be entered)
  const wsD = path.join(base, 'wsD');
  fs.mkdirSync(path.join(wsD, '.kiro', 'specs'), { recursive: true });
  fs.mkdirSync(path.join(base, 'outpriv', 'feat'), { recursive: true });
  fs.writeFileSync(path.join(base, 'outpriv', 'feat', 'requirements.md'), REQ_MD);
  fs.symlinkSync(path.join(base, 'outpriv', 'feat'), path.join(wsD, '.kiro', 'specs', 'feat'));
  // S: .kiro/specs/feat -> ../../searchonly/feat, searchonly mode 0711 (search, no read): no refusal
  const wsS = path.join(base, 'wsS');
  fs.mkdirSync(path.join(wsS, '.kiro', 'specs'), { recursive: true });
  fs.mkdirSync(path.join(wsS, 'searchonly', 'feat'), { recursive: true });
  fs.writeFileSync(path.join(wsS, 'searchonly', 'feat', 'requirements.md'), REQ_MD);
  fs.symlinkSync(path.join('..', '..', 'searchonly', 'feat'), path.join(wsS, '.kiro', 'specs', 'feat'));
  for (const d of [wsC, wsD, path.join(wsD, '.kiro'), path.join(wsD, '.kiro', 'specs'), wsS, path.join(wsS, '.kiro'), path.join(wsS, '.kiro', 'specs'), path.join(wsS, 'searchonly', 'feat')]) fs.chmodSync(d, 0o755);
  fs.chmodSync(path.join(wsS, 'searchonly', 'feat', 'requirements.md'), 0o644);
  const privates = [path.join(wsC, 'private'), path.join(base, 'outpriv')];
  for (const p of privates) fs.chmodSync(p, IS_ROOT ? 0o700 : 0o000);
  fs.chmodSync(path.join(wsS, 'searchonly'), IS_ROOT ? 0o711 : 0o111); // search only, for the user that runs the CLI

  const runs: { name: string; status: number | null; text: string }[] = [];
  try {
    const [cmd, ...pre] = unprivileged();
    for (const [ws, args] of [
      [wsC, ['spec', 'list']],
      [wsC, ['spec', 'new', 'other', '--description', 'x', '--yes']],
      [wsD, ['spec', 'list']],
      [wsD, ['spec', 'approve', 'feat']],
      [wsS, ['spec', 'list']],
      [wsS, ['spec', 'view', 'feat']],
    ] as const) {
      const r = spawnSync(cmd!, [...pre, BIN, ...args], { cwd: ws, env, encoding: 'utf8', input: '', timeout: 60_000 });
      runs.push({ name: `${path.basename(ws)}: ${args.join(' ')}`, status: r.status, text: `${r.stdout}${r.stderr}` });
    }
  } finally {
    for (const p of privates) fs.chmodSync(p, 0o755);
    fs.chmodSync(path.join(wsS, 'searchonly'), 0o755);
  }
  try {
    const show = runs.map((r) => `--- ${r.name} (exit ${r.status})\n${r.text}`).join('\n');
    for (const r of runs.slice(0, 4)) {
      assert.doesNotMatch(r.text, DANGLING, `${r.name}:\n${show}`);
      assert.doesNotMatch(r.text, MOVE_ADVICE, `${r.name}:\n${show}`);
      assert.match(r.text, DENIED, `${r.name}:\n${show}`);
    }
    // C names the link that cannot be followed: .kiro itself
    assert.ok(runs[0]!.text.includes(`the target of the symbolic link ${path.join(wsC, '.kiro')} cannot be accessed`), show);
    assert.deepEqual(fs.readdirSync(path.join(wsC, 'private', '.kiro', 'specs')), ['feat'], 'spec new created something behind the link');
    assert.match(runs[2]!.text, /^feat\s+feature\s+refused\s+-$/m, show);
    // the search-only control is used normally
    for (const r of runs.slice(4)) assert.doesNotMatch(r.text, /refused|cannot be accessed|dangling|⚠|✗/, `${r.name}:\n${show}`);
    assert.match(runs[4]!.text, /^feat\s+feature\s+requirements ✓/m, show);
    assert.ok(runs[5]!.text.startsWith('# Requirements Document'), show);
    assert.deepEqual(
      runs.map((r) => r.status),
      [1, 1, 0, 1, 0, 0],
      `exit codes:\n${show}`,
    );
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('gate (checkSpecWrite) with real permissions: a phase document behind a link into a folder the user cannot enter is refused as not accessible', { skip: cliSkip() }, () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'kc-r6f-links-v-gate-')));
  fs.chmodSync(base, 0o755);
  const ws = path.join(base, 'ws');
  fs.mkdirSync(path.join(ws, '.kiro', 'specs'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'private', 'feat'), { recursive: true });
  fs.mkdirSync(path.join(base, 'outpriv', 'out'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'open', 'ok'), { recursive: true });
  fs.symlinkSync(path.join('..', '..', 'private', 'feat'), path.join(ws, '.kiro', 'specs', 'feat'));
  fs.symlinkSync(path.join(base, 'outpriv', 'out'), path.join(ws, '.kiro', 'specs', 'out'));
  fs.symlinkSync(path.join('..', '..', 'open', 'ok'), path.join(ws, '.kiro', 'specs', 'ok'));
  for (const d of [ws, path.join(ws, '.kiro'), path.join(ws, '.kiro', 'specs'), path.join(ws, 'open'), path.join(ws, 'open', 'ok')]) fs.chmodSync(d, 0o755);
  const specwrite = fileURLToPath(new URL('../../src/policy/specwrite.js', import.meta.url));
  const script = path.join(base, 'gate.mjs');
  fs.writeFileSync(
    script,
    `import { checkSpecWrite } from ${JSON.stringify(pathToFileURL(specwrite).href)};
const ws = process.argv[2];
const ctx = { workspaceRoot: ws, cwd: ws, env: {}, home: '/nonexistent' };
const out = {};
for (const f of ['feat', 'out', 'ok']) {
  const doc = ws + '/.kiro/specs/' + f + '/requirements.md';
  out[f] = checkSpecWrite({ claudeName: 'Write', input: { file_path: doc }, subjects: [doc], cwd: ws }, [doc], ctx);
}
process.stdout.write(JSON.stringify(out));
`,
  );
  fs.chmodSync(script, 0o644);
  const privates = [path.join(ws, 'private'), path.join(base, 'outpriv')];
  for (const p of privates) fs.chmodSync(p, IS_ROOT ? 0o700 : 0o000);
  let r: ReturnType<typeof spawnSync>;
  try {
    const [cmd, ...pre] = unprivileged();
    r = spawnSync(cmd!, [...pre, script, ws], { cwd: base, encoding: 'utf8', timeout: 60_000 });
  } finally {
    for (const p of privates) fs.chmodSync(p, 0o755);
  }
  try {
    assert.equal(r.status, 0, String(r.stderr));
    const out = JSON.parse(String(r.stdout)) as Record<string, { ok: boolean; refused?: string }>;
    const doc = (f: string): string => path.join(ws, '.kiro', 'specs', f, 'requirements.md');
    const link = (f: string): string => path.join(ws, '.kiro', 'specs', f);
    assert.deepEqual(out.feat, { ok: false, refused: `${doc('feat')}: the target of the symbolic link ${link('feat')} cannot be accessed (permission denied)` });
    assert.deepEqual(out.out, { ok: false, refused: `${doc('out')}: the target of the symbolic link ${link('out')} cannot be accessed (permission denied)` });
    assert.deepEqual(out.ok, { ok: true }, 'an accessible folder link inside the workspace keeps working');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

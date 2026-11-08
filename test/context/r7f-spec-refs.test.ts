/**
 * Round 7, known gap closed (spec): `#spec:<name>` in chat said "Spec '<name>' not found" for a
 * dangling feature-folder link, a feature link into (or behind) a folder the user cannot enter and
 * a refused `.kiro/specs`, while the spec commands found the spec and said why. It now gives the
 * same refusal as the spec commands (spec/docfs): "Spec '<name>' was not read: <reason>: <advice>";
 * an unreadable document is left out with "a document was left out: <p> cannot be accessed
 * (permission denied)". Bare `#<name>` resolves a folder entry of `.kiro/specs` that cannot be
 * followed the same way; under a `.kiro/specs` that cannot be enumerated a bare word is left to
 * the file and text rules (nothing tells it names a spec).
 *
 * The permission cases run expandHashRefs in a child process as uid/gid 65534 through setpriv when
 * the tests run as root (root bypasses permissions), else as the current user with mode 000.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { expandHashRefs } from '../../src/context/refs.js';
import { SPEC_ACCESS_RULE, SPEC_LINK_ACCESS_RULE, SPEC_LINK_RULE } from '../../src/spec/docfs.js';
import { tmpWorkspace, write } from './helpers.js';

const posix = process.platform !== 'win32';
const IS_ROOT = process.getuid?.() === 0;
const NOBODY = 65534;
const REFS = fileURLToPath(new URL('../../src/context/refs.js', import.meta.url));

describe('#spec:<name> for a spec the spec commands refuse (r7 known gap)', { skip: !posix }, () => {
  it('a dangling feature-folder link: the refusal, not "not found" (also case-insensitive and bare)', async () => {
    const ws = tmpWorkspace();
    try {
      const specs = path.join(ws.cwd, '.kiro', 'specs');
      fs.mkdirSync(specs, { recursive: true });
      fs.symlinkSync(path.join('..', '..', 'nowhere'), path.join(specs, 'feat'));
      const why = `${path.join(specs, 'feat')}: the symbolic link ${path.join(specs, 'feat')} resolves to nothing (dangling, or a loop): ${SPEC_LINK_RULE}`;
      for (const text of ['#spec:feat', '#spec:FEAT', 'see #feat']) {
        const r = await expandHashRefs(text, { ws, steering: [] });
        assert.deepEqual(r.blocks, [], text);
        assert.deepEqual(r.notices, [`Spec '${text.includes('FEAT') ? 'FEAT' : 'feat'}' was not read: ${why}`], text);
      }
    } finally {
      fs.rmSync(ws.tmp, { recursive: true, force: true });
    }
  });

  it('a dangling .kiro/specs: #spec:<name> gives its refusal; a bare #<name> is left as text', async () => {
    const ws = tmpWorkspace();
    try {
      const specs = path.join(ws.cwd, '.kiro', 'specs');
      fs.symlinkSync(path.join('..', 'nowhere'), specs);
      const r = await expandHashRefs('#spec:feat', { ws, steering: [] });
      assert.deepEqual(r.blocks, []);
      assert.deepEqual(r.notices, [`Spec 'feat' was not read: ${specs}: the symbolic link ${specs} resolves to nothing (dangling, or a loop): ${SPEC_LINK_RULE}`]);
      const bare = await expandHashRefs('see #feat', { ws, steering: [] });
      assert.deepEqual(bare, { blocks: [], steeringNames: [], notices: [] });
      // control: a spec that is simply not there is still "not found"
      fs.unlinkSync(specs);
      fs.mkdirSync(specs);
      const none = await expandHashRefs('#spec:feat', { ws, steering: [] });
      assert.deepEqual(none.notices, [`Spec 'feat' not found in ${specs}`]);
    } finally {
      fs.rmSync(ws.tmp, { recursive: true, force: true });
    }
  });
});

/** Why the permission cases cannot run here. */
function permSkip(): string | false {
  if (process.platform !== 'linux') return 'linux only';
  if (!IS_ROOT) return false;
  if (spawnSync('setpriv', ['--version']).status !== 0) return 'setpriv is not available';
  const r = spawnSync('setpriv', [`--reuid=${NOBODY}`, `--regid=${NOBODY}`, '--clear-groups', process.execPath, '-e', 'require("fs").accessSync(process.argv[1], 4)', REFS]);
  return r.status === 0 ? false : `the build at ${REFS} is not readable by uid ${NOBODY}`;
}

describe('#spec:<name> with real permissions (r7 #6, known gap)', { skip: permSkip() }, () => {
  it('a feature link AT or behind a folder the user cannot enter, a .kiro/specs linked behind one, an unreadable document: the true reason', () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'kc-r7f-spec-refs-')));
    fs.chmodSync(base, 0o755);
    const locked: string[] = [];
    const lock = (p: string): void => {
      locked.push(p);
      const file = fs.statSync(p).isFile();
      if (IS_ROOT) {
        fs.chownSync(p, 0, 0);
        fs.chmodSync(p, file ? 0o600 : 0o700);
      } else fs.chmodSync(p, 0o000);
    };
    try {
      // A: .kiro/specs/at -> ../../privat (privat cannot be entered); .kiro/specs/behind -> ../../locked/feat
      // (locked cannot be entered); .kiro/specs/unread with an unreadable requirements.md
      const wsA = path.join(base, 'wsA');
      const specsA = path.join(wsA, '.kiro', 'specs');
      write(path.join(wsA, 'privat', 'requirements.md'), 'AT-REQ');
      write(path.join(wsA, 'locked', 'feat', 'requirements.md'), 'BEHIND-REQ');
      write(path.join(specsA, 'unread', 'requirements.md'), 'UNREAD-REQ');
      write(path.join(specsA, 'unread', 'design.md'), 'READ-DESIGN');
      fs.symlinkSync(path.join('..', '..', 'privat'), path.join(specsA, 'at'));
      fs.symlinkSync(path.join('..', '..', 'locked', 'feat'), path.join(specsA, 'behind'));
      // B: .kiro/specs -> ../private/specs (private cannot be entered)
      const wsB = path.join(base, 'wsB');
      write(path.join(wsB, 'private', 'specs', 'feat', 'requirements.md'), 'B-REQ');
      fs.mkdirSync(path.join(wsB, '.kiro'), { recursive: true });
      fs.symlinkSync(path.join('..', 'private', 'specs'), path.join(wsB, '.kiro', 'specs'));
      for (const d of [wsA, path.join(wsA, '.kiro'), specsA, path.join(specsA, 'unread'), wsB, path.join(wsB, '.kiro')]) fs.chmodSync(d, 0o755);
      fs.chmodSync(path.join(specsA, 'unread', 'design.md'), 0o644);
      lock(path.join(wsA, 'privat'));
      lock(path.join(wsA, 'locked'));
      lock(path.join(specsA, 'unread', 'requirements.md'));
      lock(path.join(wsB, 'private'));
      const script = path.join(base, 'refs.mjs');
      fs.writeFileSync(
        script,
        `import { expandHashRefs } from ${JSON.stringify(pathToFileURL(REFS).href)};
const out = {};
for (const [ws, text] of JSON.parse(process.argv[2])) {
  const ctx = { cwd: ws, workspaceRoot: ws, kiroHome: '/nonexistent/.kiro', home: '/nonexistent', env: {} };
  out[text + ' @ ' + ws] = await expandHashRefs(text, { ws: ctx, steering: [] });
}
process.stdout.write(JSON.stringify(out));
`,
      );
      fs.chmodSync(script, 0o644);
      const cases: [string, string][] = [
        [wsA, '#spec:at'],
        [wsA, '#spec:behind'],
        [wsA, '#spec:unread'],
        [wsB, '#spec:feat'],
      ];
      const argv = IS_ROOT ? ['setpriv', `--reuid=${NOBODY}`, `--regid=${NOBODY}`, '--clear-groups', process.execPath] : [process.execPath];
      const r = spawnSync(argv[0]!, [...argv.slice(1), script, JSON.stringify(cases)], { cwd: base, encoding: 'utf8', timeout: 60_000 });
      assert.equal(r.status, 0, r.stderr);
      const res = JSON.parse(r.stdout) as Record<string, { blocks: string[]; notices: string[] }>;
      const get = (ws: string, text: string): { blocks: string[]; notices: string[] } => res[`${text} @ ${ws}`]!;
      const dump = JSON.stringify(res, null, 2);
      const at = get(wsA, '#spec:at');
      assert.deepEqual(at.blocks, [], dump);
      assert.deepEqual(at.notices, [`Spec 'at' was not read: ${path.join(specsA, 'at')} cannot be accessed (permission denied): ${SPEC_ACCESS_RULE}`], dump);
      const behind = get(wsA, '#spec:behind');
      assert.deepEqual(behind.blocks, [], dump);
      assert.deepEqual(behind.notices, [`Spec 'behind' was not read: ${path.join(specsA, 'behind')}: the target of the symbolic link ${path.join(specsA, 'behind')} cannot be accessed (permission denied): ${SPEC_LINK_ACCESS_RULE}`], dump);
      const unread = get(wsA, '#spec:unread');
      assert.equal(unread.blocks.length, 1, dump);
      assert.ok(unread.blocks[0]!.includes('READ-DESIGN'), dump);
      assert.ok(!unread.blocks[0]!.includes('UNREAD-REQ'), dump);
      assert.deepEqual(unread.notices, [`Spec 'unread': a document was left out: ${path.join(specsA, 'unread', 'requirements.md')} cannot be accessed (permission denied): ${SPEC_ACCESS_RULE}`], dump);
      const b = get(wsB, '#spec:feat');
      assert.deepEqual(b.blocks, [], dump);
      const specsB = path.join(wsB, '.kiro', 'specs');
      assert.deepEqual(b.notices, [`Spec 'feat' was not read: ${specsB}: the target of the symbolic link ${specsB} cannot be accessed (permission denied): ${SPEC_LINK_ACCESS_RULE}`], dump);
      for (const v of Object.values(res)) for (const n of v.notices) assert.doesNotMatch(n, /not found|replace it with a regular file/, dump);
    } finally {
      for (const p of locked) fs.chmodSync(p, fs.statSync(p).isFile() ? 0o644 : 0o755);
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

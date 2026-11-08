/**
 * Round 7, findings #6, #7 and #10 (spec), with real permissions: `kiro-claude` runs as uid/gid
 * 65534 through setpriv when the tests run as root (root bypasses permissions), else as the
 * current user with the locked paths at mode 000.
 *
 *  - #6: a spec folder or document the user cannot enter or read, with no unresolvable link above
 *    it (a feature link pointing AT a folder the user cannot enter, a real feature folder at
 *    0700, an unreadable requirements.md of any size, a `.kiro/specs` linked to a folder the user
 *    cannot enter, a search-only `.kiro/specs`), counted as MISSING: status said "not written
 *    yet" (or "✓ empty" for a large one), the flow drafted it again, `spec run` gave a task a
 *    context without requirements.md, `list` said "No specs found". Now each is refused with
 *    `<p> cannot be accessed (permission denied)` and the access advice (docfs.SPEC_ACCESS_RULE,
 *    never the replace/move advice): never drafted over, no Approve, status/list show `refused`
 *    with the reason, run/analyze refuse, `list` gives the reason.
 *  - #7: with `.kiro/specs` linked into a folder the user cannot enter, or dangling, the named
 *    commands (CLI status/view/approve/run/sync/analyze/revise; REPL `/spec <name>`,
 *    `/spec status|view|approve <name>`) said "Spec 'feat' not found … Create it with … new feat",
 *    and that `new` then refused. Now they print the `.kiro/specs` refusal.
 *  - #10: README promised the access reason for a link "into a folder you cannot enter"; it now
 *    holds for a link behind such a folder AND a folder or document that itself cannot be read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SPEC_ACCESS_RULE } from '../../src/spec/docfs.js';
import { fakeClaudePath } from '../claude/helpers.js';
import { DESIGN_MD, REQ_MD, TASKS_MD } from './helpers.js';

const BIN = fileURLToPath(new URL('../../src/bin/kiro-claude.js', import.meta.url));
const IS_ROOT = process.getuid?.() === 0;
const NOBODY = 65534;
const DENIED = /cannot be accessed \(permission denied\)/;
const MOVE_ADVICE = /replace it with a regular file|move the spec folder into the workspace/;
const DANGLING = /resolves to nothing \(dangling, or a loop\)/;
const CONFIG = '{"specId": "x", "workflowType": "requirements-first", "specType": "feature"}';

function unprivileged(): string[] {
  return IS_ROOT ? ['setpriv', `--reuid=${NOBODY}`, `--regid=${NOBODY}`, '--clear-groups', process.execPath] : [process.execPath];
}

/** Why these tests cannot run here (no setpriv, or the build is not readable by uid 65534). */
function cliSkip(): string | false {
  if (process.platform !== 'linux') return 'linux only';
  if (!IS_ROOT) return false;
  if (spawnSync('setpriv', ['--version']).status !== 0) return 'setpriv is not available';
  const [cmd, ...pre] = unprivileged();
  const r = spawnSync(cmd!, [...pre, '-e', 'require("fs").accessSync(process.argv[1], 4)', BIN]);
  return r.status === 0 ? false : `the build at ${BIN} is not readable by uid ${NOBODY}`;
}

interface Sandbox {
  base: string;
  env: NodeJS.ProcessEnv;
  log: string;
  locked: string[];
  /** `kiro-claude <args>` as the unprivileged user, in `ws`. */
  cli(ws: string, args: string[], input?: string): { status: number | null; text: string };
  /** The user cannot read `p` (a file) or enter it (a folder). `searchOnly`: a folder it may enter but not list. */
  lock(p: string, searchOnly?: boolean): void;
  /** The user messages the fake claude was sent since the last call. */
  userTurns(): string[];
  cleanup(): void;
}

function sandbox(): Sandbox {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'kc-r7f-spec-access-')));
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
  const locked: string[] = [];
  let seen = 0;
  return {
    base,
    env,
    log,
    locked,
    cli(ws, args, input = '') {
      const [cmd, ...pre] = unprivileged();
      const r = spawnSync(cmd!, [...pre, BIN, ...args], { cwd: ws, env, encoding: 'utf8', input, timeout: 90_000 });
      return { status: r.status, text: `${r.stdout}${r.stderr}` };
    },
    lock(p, searchOnly = false) {
      const file = fs.statSync(p).isFile();
      locked.push(p);
      if (IS_ROOT) {
        fs.lchownSync(p, 0, 0);
        fs.chmodSync(p, file ? 0o600 : searchOnly ? 0o711 : 0o700);
      } else fs.chmodSync(p, searchOnly ? 0o111 : 0o000);
    },
    userTurns() {
      const lines = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
      const out: string[] = [];
      for (const l of lines.slice(seen)) {
        let e: { event?: string; line?: { type?: string; message?: { content?: unknown } } };
        try {
          e = JSON.parse(l);
        } catch {
          continue;
        }
        if (e.event !== 'stdin' || e.line?.type !== 'user') continue;
        const c = e.line.message?.content;
        out.push(typeof c === 'string' ? c : Array.isArray(c) ? c.map((b: { text?: string }) => b.text ?? '').join(' ') : '');
      }
      seen = lines.length;
      return out;
    },
    cleanup() {
      for (const p of locked) {
        try {
          fs.chmodSync(p, fs.statSync(p).isFile() ? 0o644 : 0o755);
        } catch {
          // gone
        }
      }
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

/** `p` and everything under it belong to the unprivileged user (root only). */
function chownR(p: string): void {
  if (!IS_ROOT) return;
  fs.lchownSync(p, NOBODY, NOBODY);
  if (fs.lstatSync(p).isDirectory()) for (const e of fs.readdirSync(p)) chownR(path.join(p, e));
}

function writeFullSpec(dir: string, req = REQ_MD): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'requirements.md'), req);
  fs.writeFileSync(path.join(dir, 'design.md'), DESIGN_MD);
  fs.writeFileSync(path.join(dir, 'tasks.md'), TASKS_MD);
  fs.writeFileSync(path.join(dir, '.config.kiro'), CONFIG);
}

type Run = { name: string; status: number | null; text: string };
const show = (runs: Run[]): string => runs.map((r) => `--- ${r.name} (exit ${r.status})\n${r.text.trim()}`).join('\n');

test('#6: an unreadable requirements.md is refused with the access reason, never "not written yet", never drafted over or left out of a task', { skip: cliSkip() }, () => {
  const s = sandbox();
  try {
    const ws = path.join(s.base, 'ws');
    const dir = path.join(ws, '.kiro', 'specs', 'feat');
    const req = path.join(dir, 'requirements.md');
    writeFullSpec(dir);
    chownR(ws);
    s.lock(req);
    const why = `${req} cannot be accessed (permission denied): ${SPEC_ACCESS_RULE}`;
    const runs: Run[] = [];
    for (const args of [
      ['spec', 'list'],
      ['spec', 'status', 'feat'],
      ['spec', 'view', 'feat', 'requirements'],
      ['spec', 'approve', 'feat', '--no-interactive'],
      ['spec', 'analyze', 'feat', '--yes'],
    ]) runs.push({ name: args.join(' '), ...s.cli(ws, args) });
    s.userTurns();
    const run = { name: 'spec run feat --next', ...s.cli(ws, ['spec', 'run', 'feat', '--next', '--trust-all-tools']) };
    const runTurns = s.userTurns();
    const repl = { name: 'chat: /spec feat, 2 (Stop)', ...s.cli(ws, ['chat', '--trust-all-tools'], '/spec feat\nexport todos as csv\n2\n/quit\n') };
    const replTurns = s.userTurns();
    runs.push(run, repl);
    const all = show(runs);
    const [list, status, view, approve, analyze] = runs;
    assert.match(list!.text, /^feat\s+feature\s+refused\s+/m, all);
    assert.ok(list!.text.includes(`⚠ feat: ${why}`), all);
    assert.match(status!.text, /requirements\.md\s+⚠\s+not read \(below\)/, all);
    assert.ok(status!.text.includes(`⚠ ${why}`), all);
    assert.equal(view!.status, 1, all);
    assert.ok(view!.text.includes(`error: ${why}`), all);
    assert.doesNotMatch(approve!.text, /has not been written/, all);
    assert.equal(analyze!.status, 1, all);
    assert.ok(analyze!.text.includes(`✗ Cannot analyze requirements.md: ${why}`), all);
    assert.equal(run.status, 1, all);
    assert.ok(run.text.includes(`✗ Spec 'feat' cannot run: ${why}`), all);
    assert.deepEqual(runTurns, [], `a task ran without the requirements it must verify against:\n${all}`);
    assert.doesNotMatch(repl.text, /What should the spec "feat" cover\?|requirements\.md was not written/, all);
    assert.ok(!replTurns.some((t) => t.includes('Phase: REQUIREMENTS')), `the chat drafted requirements.md again:\n${all}\n${replTurns.join('\n')}`);
    for (const r of runs) {
      assert.doesNotMatch(r.text, /not written yet|No requirements\.md yet/, `${r.name}:\n${all}`);
      assert.doesNotMatch(r.text, MOVE_ADVICE, `${r.name} gives the replace/move advice:\n${all}`);
      assert.doesNotMatch(r.text, /EACCES/, `${r.name} prints the raw error:\n${all}`);
    }
    fs.chmodSync(req, 0o644);
    assert.equal(fs.readFileSync(req, 'utf8'), REQ_MD, 'requirements.md was written over');
  } finally {
    s.cleanup();
  }
});

test('#6: an unreadable requirements.md of 4096 bytes or more is refused too (not "✓ empty")', { skip: cliSkip() }, () => {
  const s = sandbox();
  try {
    const ws = path.join(s.base, 'ws');
    const dir = path.join(ws, '.kiro', 'specs', 'feat');
    writeFullSpec(dir, `${REQ_MD}\n${'<!-- padding -->\n'.repeat(300)}`);
    assert.ok(fs.statSync(path.join(dir, 'requirements.md')).size >= 4096);
    chownR(ws);
    s.lock(path.join(dir, 'requirements.md'));
    const status = s.cli(ws, ['spec', 'status', 'feat']);
    assert.doesNotMatch(status.text, /requirements\.md\s+✓/, status.text);
    assert.match(status.text, /requirements\.md\s+⚠\s+not read \(below\)/, status.text);
    assert.match(status.text, DENIED, status.text);
  } finally {
    s.cleanup();
  }
});

test('#6/#10: a feature link pointing AT a folder the user cannot enter, and a real feature folder at 0700, are refused with the access reason', { skip: cliSkip() }, () => {
  const s = sandbox();
  try {
    const ws = path.join(s.base, 'ws');
    const specs = path.join(ws, '.kiro', 'specs');
    writeFullSpec(path.join(ws, 'privfeat'));
    fs.mkdirSync(specs, { recursive: true });
    fs.symlinkSync(path.join('..', '..', 'privfeat'), path.join(specs, 'feat'));
    writeFullSpec(path.join(specs, 'real'));
    chownR(ws);
    s.lock(path.join(ws, 'privfeat'));
    s.lock(path.join(specs, 'real'));
    const runs: Run[] = [];
    for (const args of [
      ['spec', 'list'],
      ['spec', 'status', 'feat'],
      ['spec', 'status', 'real'],
      ['spec', 'view', 'feat', 'requirements'],
      ['spec', 'approve', 'feat', '--no-interactive'],
    ]) runs.push({ name: args.join(' '), ...s.cli(ws, args) });
    const repl = { name: 'chat: /spec feat', ...s.cli(ws, ['chat'], '/spec feat\nexport todos\n/quit\n') };
    runs.push(repl);
    const all = show(runs);
    const [list, statusFeat, statusReal, view, approve] = runs;
    assert.equal(list!.status, 0, all);
    assert.match(list!.text, /^feat\s+feature\s+refused\s+-$/m, all);
    assert.match(list!.text, /^real\s+feature\s+refused\s+-$/m, all);
    assert.ok(list!.text.includes(`⚠ feat: ${path.join(specs, 'feat')} cannot be accessed (permission denied): ${SPEC_ACCESS_RULE}`), all);
    assert.ok(list!.text.includes(`⚠ real: ${path.join(specs, 'real')} cannot be accessed (permission denied): ${SPEC_ACCESS_RULE}`), all);
    for (const st of [statusFeat!, statusReal!]) {
      assert.match(st.text, /requirements\.md\s+⚠\s+not read \(below\)/, all);
      assert.match(st.text, /^Phase: unknown \(not read\)$/m, all);
    }
    assert.equal(view!.status, 1, all);
    assert.match(view!.text, DENIED, all);
    assert.equal(approve!.status, 1, all);
    assert.match(approve!.text, /✗ Spec 'feat' cannot continue: .*cannot be accessed \(permission denied\)/, all);
    assert.match(repl.text, /✗ Cannot draft requirements\.md: .*cannot be accessed \(permission denied\)/, all);
    assert.doesNotMatch(repl.text, /What should the spec "feat" cover\?/, all);
    for (const r of runs) {
      assert.doesNotMatch(r.text, /not written yet|^feat\s+feature\s+new\b/m, `${r.name}:\n${all}`);
      assert.doesNotMatch(r.text, MOVE_ADVICE, `${r.name}:\n${all}`);
      assert.doesNotMatch(r.text, DANGLING, `${r.name}:\n${all}`);
    }
  } finally {
    s.cleanup();
  }
});

test('#6/#10: a .kiro/specs linked AT a folder the user cannot enter, and a search-only .kiro/specs: list gives the reason, not "No specs found"', { skip: cliSkip() }, () => {
  const s = sandbox();
  try {
    // L: .kiro/specs -> ../privspecs (the folder itself cannot be entered)
    const wsL = path.join(s.base, 'wsL');
    writeFullSpec(path.join(wsL, 'privspecs', 'feat'));
    fs.mkdirSync(path.join(wsL, '.kiro'), { recursive: true });
    fs.symlinkSync(path.join('..', 'privspecs'), path.join(wsL, '.kiro', 'specs'));
    // S: a real .kiro/specs the user may enter but not list (0711)
    const wsS = path.join(s.base, 'wsS');
    writeFullSpec(path.join(wsS, '.kiro', 'specs', 'feat'));
    chownR(wsL);
    chownR(wsS);
    s.lock(path.join(wsL, 'privspecs'));
    s.lock(path.join(wsS, '.kiro', 'specs'), true);
    const runs: Run[] = [];
    for (const [ws, args] of [
      [wsL, ['spec', 'list']],
      [wsL, ['spec', 'status']],
      [wsL, ['spec', 'status', 'feat']],
      [wsL, ['spec', 'new', 'other', '--description', 'x', '--yes']],
      [wsS, ['spec', 'list']],
      [wsS, ['spec', 'status', 'feat']],
      [wsS, ['spec', 'view', 'feat', 'requirements']],
    ] as const) runs.push({ name: `${path.basename(ws)}: ${args.join(' ')}`, ...s.cli(ws, [...args]) });
    const all = show(runs);
    const specsL = path.join(wsL, '.kiro', 'specs');
    const specsS = path.join(wsS, '.kiro', 'specs');
    assert.deepEqual(runs.map((r) => r.status), [1, 1, 1, 1, 1, 0, 0], `exit codes:\n${all}`);
    for (const r of runs.slice(0, 3)) assert.ok(r.text.includes(`error: ${specsL} cannot be accessed (permission denied): ${SPEC_ACCESS_RULE}`), `${r.name}:\n${all}`);
    assert.match(runs[3]!.text, new RegExp(`✗ ${path.join(specsL, 'other').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: ${specsL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} cannot be accessed \\(permission denied\\)`), all);
    assert.doesNotMatch(runs[3]!.text, /EACCES|mkdir/, all);
    assert.ok(runs[4]!.text.includes(`error: ${specsS} cannot be accessed (permission denied): ${SPEC_ACCESS_RULE}`), all);
    // the named spec of a search-only .kiro/specs is used normally
    assert.match(runs[5]!.text, /requirements\.md\s+✓/, all);
    assert.match(runs[5]!.text, /^Phase: execution$/m, all);
    assert.ok(runs[6]!.text.startsWith('# Requirements Document'), all);
    for (const r of runs) assert.doesNotMatch(r.text, /No specs found|not found|Create it with/, `${r.name}:\n${all}`);
    for (const r of runs) assert.doesNotMatch(r.text, MOVE_ADVICE, `${r.name}:\n${all}`);
  } finally {
    s.cleanup();
  }
});

for (const kind of ['denied', 'dangling'] as const) {
  test(`#7: .kiro/specs ${kind}: the named spec commands print the .kiro/specs refusal, not "not found … Create it with … new"`, { skip: cliSkip() }, () => {
    const s = sandbox();
    try {
      const ws = path.join(s.base, `ws-${kind}`);
      fs.mkdirSync(path.join(ws, '.kiro'), { recursive: true });
      const priv = path.join(ws, 'private');
      if (kind === 'denied') {
        writeFullSpec(path.join(priv, 'specs', 'feat'));
        fs.symlinkSync(path.join('..', 'private', 'specs'), path.join(ws, '.kiro', 'specs'));
      } else fs.symlinkSync(path.join('..', 'nowhere'), path.join(ws, '.kiro', 'specs'));
      chownR(ws);
      if (kind === 'denied') s.lock(priv);
      const reason = kind === 'denied' ? DENIED : DANGLING;
      const runs: Run[] = [];
      for (const args of [
        ['spec', 'status', 'feat'],
        ['spec', 'view', 'feat'],
        ['spec', 'approve', 'feat', '--yes'],
        ['spec', 'run', 'feat', '--all'],
        ['spec', 'sync', 'feat'],
        ['spec', 'analyze', 'feat', '--yes'],
        ['spec', 'revise', 'feat', 'more', 'detail'],
      ]) runs.push({ name: args.join(' '), ...s.cli(ws, args) });
      for (const line of ['/spec feat', '/spec status feat', '/spec view feat', '/spec approve feat']) {
        const r = s.cli(ws, ['chat'], `${line}\n/quit\n`);
        runs.push({ name: `chat: ${line}`, status: r.status, text: r.text.split('\n').filter((l) => /feat|kiro\/specs/.test(l) && !l.startsWith('/spec ')).join('\n') });
      }
      const all = show(runs);
      for (const r of runs) {
        assert.doesNotMatch(r.text, /not found|Create it with/, `${r.name} says the spec is not found and suggests \`new\`:\n${all}`);
        assert.match(r.text, reason, `${r.name} does not give the .kiro/specs refusal:\n${all}`);
        if (kind === 'denied') assert.doesNotMatch(r.text, MOVE_ADVICE, `${r.name} gives the replace/move advice:\n${all}`);
      }
      for (const r of runs.slice(0, 7)) assert.equal(r.status, 1, `${r.name}:\n${all}`);
      if (kind === 'denied') {
        fs.chmodSync(priv, 0o755);
        assert.deepEqual(fs.readdirSync(path.join(priv, 'specs', 'feat')).sort(), ['.config.kiro', 'design.md', 'requirements.md', 'tasks.md'], 'something was written behind the link');
      }
    } finally {
      s.cleanup();
    }
  });
}

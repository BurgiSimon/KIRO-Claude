/**
 * Round 8, finding #9 (spec), with real permissions: `kiro-claude` runs as uid/gid 65534 through
 * setpriv when the tests run as root (root bypasses permissions), else as the current user with
 * bugfix.md at mode 000 (as test/spec/r7f-spec-access.test.ts does).
 *
 * A bugfix spec without a usable `specType` (no `.config.kiro`, a legacy `{"generationMode": …}`
 * one, or one without `specType`) whose bugfix.md exists but cannot be read was shown as a
 * requirements-first feature spec: `status` said "Phase: drafting requirements.md" with
 * requirements.md "not written yet", `--format json` gave specType "feature" and phase
 * "requirements", `list` "feature  refused", `analyze` "No requirements.md yet", and `/spec
 * <name>` in chat "✗ Cannot draft requirements.md". For a bugfix.md of 4096 bytes or more this was
 * a regression of r7 #6 (before it, such a file counted as non-empty from its size alone).
 *
 * Now the existing unreadable bugfix.md counts as present for the type (store.summarizeSpecDir,
 * readSpecConfig): the spec is a bugfix spec with bugfix.md awaiting approval, marked `⚠ not read`
 * with the access reason, and nothing names a requirements.md.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SPEC_ACCESS_RULE } from '../../src/spec/docfs.js';
import { fakeClaudePath } from '../claude/helpers.js';
import { BUGFIX_MD } from './helpers.js';
import { removeOnExit } from '../tmpdirs.js';

const BIN = fileURLToPath(new URL('../../src/bin/kiro-claude.js', import.meta.url));
const IS_ROOT = process.getuid?.() === 0;
const NOBODY = 65534;

function unprivileged(): string[] {
  return IS_ROOT ? ['setpriv', `--reuid=${NOBODY}`, `--regid=${NOBODY}`, '--clear-groups', process.execPath] : [process.execPath];
}

/** Why these tests cannot run here (not Linux, no setpriv, or the build is not readable by uid 65534). */
function cliSkip(): string | false {
  if (process.platform !== 'linux') return 'linux only';
  if (!IS_ROOT) return false;
  if (spawnSync('setpriv', ['--version']).status !== 0) return 'setpriv is not available';
  const [cmd, ...pre] = unprivileged();
  const r = spawnSync(cmd!, [...pre, '-e', 'require("fs").accessSync(process.argv[1], 4)', BIN]);
  return r.status === 0 ? false : `the build at ${BIN} is not readable by uid ${NOBODY}`;
}

interface Sandbox {
  ws: string;
  doc: string;
  cli(args: string[], input?: string): { name: string; status: number | null; text: string };
  lock(): void;
  unlock(): void;
}

function sandbox(config: string | undefined, body: string): Sandbox {
  const base = removeOnExit(fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'kc-r8f-spec-type-'))));
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
  const ws = path.join(base, 'ws');
  const dir = path.join(ws, '.kiro', 'specs', 'fix-crash');
  fs.mkdirSync(dir, { recursive: true });
  if (config !== undefined) fs.writeFileSync(path.join(dir, '.config.kiro'), config);
  const doc = path.join(dir, 'bugfix.md');
  fs.writeFileSync(doc, body);
  if (IS_ROOT) for (const p of [ws, path.join(ws, '.kiro'), path.join(ws, '.kiro', 'specs'), dir, ...fs.readdirSync(dir).map((e) => path.join(dir, e))]) fs.lchownSync(p, NOBODY, NOBODY);
  return {
    ws,
    doc,
    cli(args, input = '') {
      const [cmd, ...pre] = unprivileged();
      const r = spawnSync(cmd!, [...pre, BIN, ...args], { cwd: ws, env, encoding: 'utf8', input, timeout: 90_000 });
      return { name: args.join(' '), status: r.status, text: `${r.stdout}${r.stderr}` };
    },
    lock() {
      if (IS_ROOT) {
        fs.lchownSync(doc, 0, 0);
        fs.chmodSync(doc, 0o600);
      } else fs.chmodSync(doc, 0o000);
    },
    unlock() {
      fs.chmodSync(doc, 0o644);
    },
  };
}

const CONFIGS: [string, string | undefined][] = [
  ['no .config.kiro', undefined],
  ['legacy {"generationMode"} .config.kiro', '{"generationMode": "requirements-first"}'],
  ['.config.kiro without specType', '{"specId": "x", "workflowType": "requirements-first"}'],
];
const LARGE = `${BUGFIX_MD}\n${'<!-- padding -->\n'.repeat(300)}`;

for (const [label, config] of CONFIGS) {
  for (const [size, body] of [
    ['small', BUGFIX_MD],
    ['4096 bytes or more', LARGE],
  ] as const) {
    test(`an unreadable bugfix.md (${size}, ${label}) keeps the spec a bugfix spec: status, json, list, view, analyze, approve, /spec`, { skip: cliSkip() }, () => {
      const s = sandbox(config, body);
      if (size !== 'small') assert.ok(fs.statSync(s.doc).size >= 4096);
      // control: readable
      const ok = s.cli(['spec', 'status', 'fix-crash']);
      assert.match(ok.text, /^Spec: fix-crash \(bugfix, requirements-first\)$/m, ok.text);
      assert.match(ok.text, /^Phase: bugfix\.md awaiting approval \(next: design\.md\)$/m, ok.text);
      s.lock();
      const why = `${s.doc} cannot be accessed (permission denied): ${SPEC_ACCESS_RULE}`;
      const runs = [
        s.cli(['spec', 'status', 'fix-crash']),
        s.cli(['spec', 'status', 'fix-crash', '--format', 'json']),
        s.cli(['spec', 'list']),
        s.cli(['spec', 'view', 'fix-crash']),
        s.cli(['spec', 'analyze', 'fix-crash', '--yes']),
        s.cli(['spec', 'approve', 'fix-crash', '--no-interactive']),
      ];
      const repl = size === 'small' ? s.cli(['chat', '--trust-all-tools'], '/spec fix-crash\n2\n/quit\n') : undefined;
      if (repl) runs.push({ ...repl, name: 'chat: /spec fix-crash, 2 (Stop)' });
      const all = runs.map((r) => `--- ${r.name} (exit ${r.status})\n${r.text.trim()}`).join('\n');
      const [status, json, list, view, analyze, approve] = runs;
      assert.match(status!.text, /^Spec: fix-crash \(bugfix, requirements-first\)$/m, `status gives the spec type as feature:\n${all}`);
      assert.match(status!.text, /^ {2}bugfix\.md\s+⚠\s+not read \(below\)$/m, all);
      assert.match(status!.text, /^Phase: bugfix\.md awaiting approval \(next: design\.md\)$/m, all);
      assert.ok(status!.text.includes(`⚠ ${why}`), all);
      const j = JSON.parse(json!.text.split('\n').find((l) => l.startsWith('{')) ?? '{}') as Record<string, unknown>;
      assert.equal(j.specType, 'bugfix', all);
      assert.equal(j.phase, 'design', all);
      assert.equal(j.awaitingApproval, 'bugfix', all);
      assert.deepEqual(Object.keys(j.documents as object), ['bugfix', 'design', 'tasks'], all);
      assert.match(list!.text, /^fix-crash\s+bugfix\s+refused\s+-$/m, all);
      assert.equal(view!.status, 1, all);
      assert.ok(view!.text.includes(`error: ${why}`), all);
      assert.equal(analyze!.status, 1, all);
      assert.ok(analyze!.text.includes(`✗ Cannot analyze bugfix.md: ${why}`), all);
      assert.equal(approve!.status, 1, all);
      assert.ok(approve!.text.includes(`✗ Cannot approve bugfix.md: ${why}`), all);
      if (repl) {
        assert.match(repl.text, /Does the bug analysis look good\?/, all);
        assert.match(repl.text, /Stopped at the bugfix\.md checkpoint/, all);
        assert.ok(repl.text.includes(`⚠ ${why}`), all);
      }
      for (const r of runs) {
        assert.doesNotMatch(r.text, /requirements\.md|No requirements|drafting/, `${r.name} names a requirements.md a bugfix spec never has:\n${all}`);
        assert.doesNotMatch(r.text, /EACCES/, `${r.name} prints the raw error:\n${all}`);
      }
      s.unlock();
      assert.equal(fs.readFileSync(s.doc, 'utf8'), body, 'bugfix.md was written over');
      assert.deepEqual(fs.readdirSync(path.dirname(s.doc)).filter((e) => e !== '.config.kiro').sort(), ['bugfix.md'], 'a document was drafted');
    });
  }
}

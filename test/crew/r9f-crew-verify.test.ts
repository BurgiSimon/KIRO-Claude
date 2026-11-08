/**
 * Round 9, crew finding #5, verifier: after the bridge's own area became `$CS/node/node_modules`
 * and `$CS/node` itself (a directory beside node_modules, such as `$CS/node/KiroCrew`, is fine),
 * the docs must not still say that setup skips the bridge install while `node/` holds a checkout,
 * and must say when a kept `node/` is labelled: only when it is or holds a Kiro Crew checkout,
 * not for any other entry that keeps it (the purge's label-only branch, `isOwnMembersPrefix`
 * false).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CLAUDE_AGENT_ACP } from '../../src/crew/pin.js';
import { defaultSys } from '../../src/crew/runner.js';
import { removeOnExit } from '../tmpdirs.js';
import { crew, makeFakeEnv, realPython, type FakeEnv } from './helpers.js';

const PY = realPython();
const deps = { sys: { ...defaultSys, freeBytes: () => 64 * 1024 ** 3 } };
const flat = (s: string): string => s.replace(/\s+/g, ' ');

function repoRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (fs.existsSync(path.join(dir, 'docs', 'ARCHITECTURE.md')) && fs.existsSync(path.join(dir, 'README.md'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('run the tests from the repository root');
    dir = parent;
  }
}

function fakeEnv(): FakeEnv {
  const fe = makeFakeEnv();
  removeOnExit(fe.root);
  return fe;
}

/** The lines of `stdout` that report the purge. */
function purgeLines(stdout: string): string[] {
  return stdout.split('\n').filter((l) => /^(Purged |Nothing to purge)/.test(l));
}

/** An installed bridge in `$CS/node` (npm's three entries) plus `extra` entries beside it. */
function bridgeWith(fe: FakeEnv, extra: (prefix: string) => void): string {
  const prefix = path.join(fe.cs, 'node');
  const pkg = path.join(prefix, 'node_modules', ...CLAUDE_AGENT_ACP.name.split('/'));
  fs.mkdirSync(path.join(pkg, path.dirname(CLAUDE_AGENT_ACP.entry)), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: CLAUDE_AGENT_ACP.name, version: CLAUDE_AGENT_ACP.version }));
  fs.writeFileSync(path.join(pkg, ...CLAUDE_AGENT_ACP.entry.split('/')), '');
  fs.writeFileSync(path.join(prefix, 'package.json'), JSON.stringify({ dependencies: { [CLAUDE_AGENT_ACP.name]: `^${CLAUDE_AGENT_ACP.version}` } }));
  fs.writeFileSync(path.join(prefix, 'package-lock.json'), '{}');
  extra(prefix);
  return prefix;
}

describe('r9f crew verify: the docs say what keeps setup from installing the bridge, and when a kept node/ is labelled', () => {
  it('README: the bridge install waits while node/node_modules holds a checkout or node/ is one, not while node/ holds one beside node_modules', () => {
    const readme = flat(fs.readFileSync(path.join(repoRoot(), 'README.md'), 'utf8'));
    assert.doesNotMatch(readme, /nor does it build or install the bridge while one of them holds a Kiro Crew checkout/, 'node/ is one of them, and a checkout beside node_modules does not stop the install');
    assert.match(readme, /nor does it build while a cache holds a Kiro Crew checkout, or install the bridge while `node\/node_modules` holds one or `node\/` is one \(it names it: move it out of there first\)\./);
  });

  it('ARCHITECTURE.md: a node/ kept for holding something else is labelled only when it is or holds a checkout', () => {
    const arch = fs.readFileSync(path.join(repoRoot(), 'docs', 'ARCHITECTURE.md'), 'utf8');
    const un = flat(arch.split(/\n\n/).find((p) => p.startsWith('**Uninstalling.**')) ?? '');
    assert.doesNotMatch(un, /a `node\/` kept for holding something else is labelled the same way\)/);
    assert.match(un, /a `node\/` kept for holding something else is labelled the same way when it is or holds one\)/);
  });
});

describe('r9f crew verify: the purge labels a node/ kept for another entry only when it is or holds a checkout', { skip: PY ? false : 'no python3 with sqlite3' }, () => {
  it('node/ with an unknown file beside the bridge: kept, unlabelled; a checkout in its node_modules too: labelled "holds a"', async () => {
    const fe = fakeEnv();
    const prefix = bridgeWith(fe, (p) => fs.writeFileSync(path.join(p, 'notes.txt'), 'mine'));
    const plain = await crew(fe, ['uninstall', '--purge'], { deps });
    assert.equal(plain.code, 0, `${plain.stdout}\n${plain.stderr}`);
    assert.deepEqual(purgeLines(plain.stdout), [`Nothing to purge in ${fe.cs}; kept node`], plain.stdout);
    assert.equal(fs.existsSync(path.join(prefix, 'notes.txt')), true);

    const stray = path.join(prefix, 'node_modules', 'KiroCrew');
    fs.mkdirSync(path.join(stray, '.git'), { recursive: true });
    fs.writeFileSync(path.join(stray, 'WORK'), 'uncommitted work');
    const held = await crew(fe, ['uninstall', '--purge'], { deps });
    assert.equal(held.code, 0, `${held.stdout}\n${held.stderr}`);
    assert.deepEqual(purgeLines(held.stdout), [`Nothing to purge in ${fe.cs}; kept node (holds a Kiro Crew checkout)`], held.stdout);
    assert.equal(fs.readFileSync(path.join(stray, 'WORK'), 'utf8'), 'uncommitted work');
    assert.equal(fs.existsSync(path.join(prefix, 'notes.txt')), true);
  });

  it('node/ holding only the bridge and a checkout beside it is kept whole, labelled; once the checkout moves out, the purge removes the bridge', async () => {
    const fe = fakeEnv();
    const prefix = bridgeWith(fe, (p) => {
      fe.makeCheckout(path.join(p, 'KiroCrew'), { built: true });
      fs.writeFileSync(path.join(p, 'KiroCrew', 'WORK'), 'uncommitted work');
    });
    const kept = await crew(fe, ['uninstall', '--purge'], { deps });
    assert.equal(kept.code, 0, `${kept.stdout}\n${kept.stderr}`);
    assert.deepEqual(purgeLines(kept.stdout), [`Nothing to purge in ${fe.cs}; kept node (holds a Kiro Crew checkout)`], kept.stdout);
    assert.deepEqual(fs.readdirSync(prefix).sort(), ['KiroCrew', 'node_modules', 'package-lock.json', 'package.json']);
    const moved = path.join(fe.root, 'KC');
    fs.renameSync(path.join(prefix, 'KiroCrew'), moved);
    assert.equal(fs.readFileSync(path.join(moved, 'WORK'), 'utf8'), 'uncommitted work');
    const gone = await crew(fe, ['uninstall', '--purge'], { deps });
    assert.equal(gone.code, 0, `${gone.stdout}\n${gone.stderr}`);
    assert.deepEqual(purgeLines(gone.stdout), [`Purged ${fe.cs}`], gone.stdout);
  });
});

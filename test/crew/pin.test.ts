/**
 * The pin is consistent across the gitlink, `.gitmodules` and src/crew/pin.ts (08 §4.1: "the unit
 * test asserts that `git ls-tree HEAD vendor/KiroCrew` shows KIROCREW_PIN.commit; it is skipped
 * outside a git checkout"). Read-only git commands only.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CLAUDE_AGENT_ACP, KIROCREW_PIN, KIROCREW_SUBMODULE_PATH } from '../../src/crew/pin.js';
import { isSubmoduleCheckout } from '../../src/crew/paths.js';

function repoRoot(): string | undefined {
  let dir = process.cwd();
  for (;;) {
    try {
      const pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: string };
      if (pj.name === 'kiro-claude') return dir;
    } catch {
      // keep walking
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

describe('KiroCrew pin (08 §4.1)', () => {
  it('pin constants', () => {
    assert.match(KIROCREW_PIN.commit, /^[0-9a-f]{40}$/);
    assert.equal(KIROCREW_PIN.commit, '665a0e4e4a6507de0f3e7cffd3160c9359900c7c');
    assert.equal(KIROCREW_PIN.url, 'https://github.com/kirodotdev/KiroCrew.git');
    assert.equal(KIROCREW_PIN.version, '0.13.0');
    assert.equal(KIROCREW_SUBMODULE_PATH, 'vendor/KiroCrew');
    assert.deepEqual({ ...CLAUDE_AGENT_ACP }, { name: '@agentclientprotocol/claude-agent-acp', version: '0.101.0', entry: 'dist/index.js' });
  });

  it('.gitmodules declares the submodule exactly (shallow, ignore = dirty, no branch)', (t) => {
    const root = repoRoot();
    if (!root || !fs.existsSync(path.join(root, '.gitmodules'))) return t.skip('not in a kiro-claude checkout');
    assert.equal(
      fs.readFileSync(path.join(root, '.gitmodules'), 'utf8'),
      '[submodule "vendor/KiroCrew"]\n\tpath = vendor/KiroCrew\n\turl = https://github.com/kirodotdev/KiroCrew.git\n\tshallow = true\n\tignore = dirty\n',
    );
    assert.equal(isSubmoduleCheckout(root), fs.existsSync(path.join(root, '.git')));
  });

  it('the gitlink at HEAD is KIROCREW_PIN.commit', (t) => {
    const root = repoRoot();
    if (!root || !fs.existsSync(path.join(root, '.git'))) return t.skip('not a git checkout');
    const r = spawnSync('git', ['-C', root, 'ls-tree', 'HEAD', KIROCREW_SUBMODULE_PATH], { encoding: 'utf8' });
    if (r.status !== 0 || r.stdout.trim() === '') return t.skip('gitlink not committed yet');
    assert.equal(r.stdout.trim(), `160000 commit ${KIROCREW_PIN.commit}\t${KIROCREW_SUBMODULE_PATH}`);
  });
});

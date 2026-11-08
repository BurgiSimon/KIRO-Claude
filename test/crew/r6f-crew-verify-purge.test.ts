/**
 * Round 6, verifier of the crew group's fix for finding #8 (`crew uninstall --purge` without
 * crew.json). The purge of leftovers runs only when crew.json is ABSENT: one that exists but cannot
 * be read (a symbolic link loop, a state dir that is a file) fails with its error and exit 1 and
 * removes nothing, like a corrupt one. What the purge reports must match what it removed: files
 * of crew's inside a kept folder (cache/npm next to an unknown cache entry, run/setup.log next to
 * an unknown run file) are named as purged, never "Nothing to purge".
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { crew, makeFakeEnv, type FakeEnv } from './helpers.js';

/** Our private bridge (package.json depending on claude-agent-acp only) and an empty bin/. */
function bridge(fe: FakeEnv): string {
  fs.mkdirSync(path.join(fe.cs, 'bin'), { recursive: true });
  const prefix = path.join(fe.cs, 'node');
  fs.mkdirSync(path.join(prefix, 'node_modules', '@agentclientprotocol', 'claude-agent-acp'), { recursive: true });
  fs.writeFileSync(path.join(prefix, 'package.json'), JSON.stringify({ dependencies: { '@agentclientprotocol/claude-agent-acp': '^0.101.0' } }));
  fs.mkdirSync(path.join(fe.cs, 'cache', 'npm'), { recursive: true });
  fs.writeFileSync(path.join(fe.cs, 'cache', 'npm', 'blob'), 'x');
  return prefix;
}

describe('r6f crew verify: uninstall --purge without crew.json', () => {
  it('a crew.json that exists but cannot be read (symbolic link loop) fails with its error and purges nothing', async () => {
    const fe = makeFakeEnv();
    try {
      const prefix = bridge(fe);
      fs.symlinkSync('crew.json', path.join(fe.cs, 'crew.json'));
      const r = await crew(fe, ['uninstall', '--purge']);
      assert.equal(r.code, 1, r.stdout);
      assert.match(r.stderr, /cannot read .*crew\.json/);
      assert.doesNotMatch(r.stdout, /Purged|purging/);
      assert.equal(fs.existsSync(path.join(prefix, 'package.json')), true, 'the bridge is kept');
      assert.equal(fs.existsSync(path.join(fe.cs, 'cache', 'npm', 'blob')), true, 'the caches are kept');
      assert.equal(fs.existsSync(path.join(fe.cs, 'bin')), true);
      // the plain uninstall says the same
      const plain = await crew(fe, ['uninstall']);
      assert.equal(plain.code, 1);
      assert.match(plain.stderr, /cannot read .*crew\.json/);
    } finally {
      fe.cleanup();
    }
  });

  it('a crew state dir that is a file fails with the error (exit 1), not "does not exist" with exit 0', async () => {
    const fe = makeFakeEnv();
    try {
      fs.mkdirSync(path.dirname(fe.cs), { recursive: true });
      fs.writeFileSync(fe.cs, 'not a directory');
      const r = await crew(fe, ['uninstall', '--purge']);
      assert.equal(r.code, 1, r.stdout);
      assert.match(r.stderr, /cannot read .*crew\.json/);
      assert.doesNotMatch(r.stdout, /does not exist|Nothing to purge/);
      assert.equal(fs.readFileSync(fe.cs, 'utf8'), 'not a directory');
    } finally {
      fe.cleanup();
    }
  });

  it('names what it removed inside a folder it keeps (cache/npm, run/setup.log), never "Nothing to purge"', async () => {
    const fe = makeFakeEnv();
    try {
      fs.mkdirSync(path.join(fe.cs, 'cache', 'npm'), { recursive: true });
      fs.writeFileSync(path.join(fe.cs, 'cache', 'npm', 'blob'), 'x');
      fs.writeFileSync(path.join(fe.cs, 'cache', 'mine'), 'user file');
      fs.mkdirSync(path.join(fe.cs, 'run'), { recursive: true });
      fs.writeFileSync(path.join(fe.cs, 'run', 'setup.log'), 'log');
      fs.writeFileSync(path.join(fe.cs, 'run', 'notes'), 'user file');
      const r = await crew(fe, ['uninstall', '--purge']);
      assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
      assert.equal(fs.existsSync(path.join(fe.cs, 'cache', 'npm')), false);
      assert.equal(fs.existsSync(path.join(fe.cs, 'run', 'setup.log')), false);
      assert.equal(fs.readFileSync(path.join(fe.cs, 'cache', 'mine'), 'utf8'), 'user file');
      assert.equal(fs.readFileSync(path.join(fe.cs, 'run', 'notes'), 'utf8'), 'user file');
      assert.doesNotMatch(r.stdout, /Nothing to purge/);
      const line = r.stdout.split('\n').find((l) => l.startsWith('Purged ')) ?? '';
      assert.match(line, new RegExp(`Purged .*${path.join('cache', 'npm')}`), r.stdout);
      assert.match(line, new RegExp(`Purged .*${path.join('run', 'setup.log')}`), r.stdout);
      assert.match(line, /; kept cache, run$/, r.stdout);
    } finally {
      fe.cleanup();
    }
  });

  it('a removed folder is named once, not with each file it held', async () => {
    const fe = makeFakeEnv();
    try {
      bridge(fe);
      fs.mkdirSync(path.join(fe.cs, 'run'), { recursive: true });
      fs.writeFileSync(path.join(fe.cs, 'run', 'setup.log'), 'log');
      fs.writeFileSync(path.join(fe.cs, 'keep.txt'), 'user file');
      const r = await crew(fe, ['uninstall', '--purge']);
      assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
      const line = r.stdout.split('\n').find((l) => l.startsWith('Purged ')) ?? '';
      assert.equal(line, `Purged bin, cache, node, run from ${fe.cs}; kept keep.txt`, r.stdout);
    } finally {
      fe.cleanup();
    }
  });
});

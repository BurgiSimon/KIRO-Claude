/**
 * Round 6, group crew, finding #8: `crew uninstall --purge` run after a plain `crew uninstall`
 * (crew.json gone) must still remove what is left under `$CS` (the private claude-agent-acp bridge,
 * the build caches, empty bin/ and run/, crew.json temp files, then `$CS` when empty) instead of
 * answering "Kiro Crew is not set up yet". The ownership rules stay those of a full purge: the
 * bridge prefix only while it holds nothing but claude-agent-acp, unknown entries and a checkout
 * inside `$CS` are kept. It refuses while run/ready.json names a gateway that may still run, and a
 * corrupt crew.json still fails. A plain uninstall without crew.json is unchanged.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { defaultSys, type CrewSys } from '../../src/crew/runner.js';
import { crew, freePort, makeFakeEnv, procStart, realPython, type FakeEnv } from './helpers.js';

const PY = realPython();

/** What a plain uninstall leaves behind: an empty bin/, the bridge, the caches. */
function leftovers(fe: FakeEnv, o: { ownBridge?: boolean } = {}): void {
  fs.mkdirSync(path.join(fe.cs, 'bin'), { recursive: true });
  const bridge = path.join(fe.cs, 'node');
  fs.mkdirSync(path.join(bridge, 'node_modules', '@agentclientprotocol', 'claude-agent-acp'), { recursive: true });
  const deps: Record<string, string> = { '@agentclientprotocol/claude-agent-acp': '^0.101.0' };
  if (o.ownBridge === false) deps['left-pad'] = '^1.0.0';
  fs.writeFileSync(path.join(bridge, 'package.json'), JSON.stringify({ dependencies: deps }));
  fs.writeFileSync(path.join(bridge, 'package-lock.json'), '{}');
  for (const d of ['npm', 'pip']) {
    fs.mkdirSync(path.join(fe.cs, 'cache', d), { recursive: true });
    fs.writeFileSync(path.join(fe.cs, 'cache', d, 'blob'), 'x');
  }
  fs.writeFileSync(path.join(fe.cs, '.crew.json.123.tmp'), '{');
}

function bootId(): string | undefined {
  try {
    return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

/** A ready.json naming `pid` (with this boot and `startTime` when given, as `crew start` writes it). */
function writeReady(fe: FakeEnv, pid: number, startTime: number | undefined): void {
  const run = path.join(fe.cs, 'run');
  fs.mkdirSync(run, { recursive: true });
  const boot = bootId();
  const identity = startTime !== undefined ? { pid, startTime, ...(boot ? { bootId: boot } : {}) } : undefined;
  fs.writeFileSync(path.join(run, 'ready.json'), JSON.stringify({ port: 1, pid, ...(identity ? { kiroClaude: identity } : {}) }));
  fs.writeFileSync(path.join(run, 'token'), 'secret');
}

describe('r6f crew: uninstall --purge after a plain uninstall', () => {
  it('guard: setup, start, uninstall, then uninstall --purge removes the bridge and $CS', { skip: PY ? false : 'no python3 with sqlite3' }, async () => {
    const fe = makeFakeEnv();
    try {
      fs.writeFileSync(path.join(fe.home, '.fake-claude-login'), '');
      assert.equal((await crew(fe, ['setup', '--dir', path.join(fe.root, 'KiroCrew'), '--allow-tmp'])).code, 0);
      assert.equal((await crew(fe, ['start', '--port', String(await freePort())])).code, 0);
      const bridge = path.join(fe.cs, 'node');
      assert.ok(fs.existsSync(path.join(bridge, 'package.json')), 'setup installed the private bridge');
      const plain = await crew(fe, ['uninstall']);
      assert.equal(plain.code, 0, plain.stderr);
      assert.ok(fs.existsSync(bridge), 'a plain uninstall keeps the bridge (documented)');
      const purge = await crew(fe, ['uninstall', '--purge']);
      assert.equal(purge.code, 0, `${purge.stdout}\n${purge.stderr}`);
      assert.doesNotMatch(purge.stderr, /not set up yet/);
      assert.equal(fs.existsSync(bridge), false, `the bridge is still at ${bridge}`);
      assert.equal(fs.existsSync(fe.cs), false, '$CS purged');
      assert.match(purge.stdout, new RegExp(`Purged ${fe.cs.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      assert.equal(fs.existsSync(path.join(fe.root, 'KiroCrew', 'bin', 'kirocrew')), true, 'the checkout is kept');
      // Idempotent: a second purge has nothing left to do.
      const again = await crew(fe, ['uninstall', '--purge']);
      assert.equal(again.code, 0, again.stderr);
      assert.match(again.stdout, /[Nn]othing to purge/);
    } finally {
      fe.cleanup();
    }
  });

  it('removes only crew-owned leftovers: unknown entries, a checkout inside $CS and a foreign bridge are kept and named', async () => {
    const fe = makeFakeEnv();
    try {
      leftovers(fe, { ownBridge: false });
      fs.writeFileSync(path.join(fe.cs, 'notes.txt'), 'user data');
      fs.mkdirSync(path.join(fe.cs, 'KiroCrew', 'bin'), { recursive: true });
      fs.writeFileSync(path.join(fe.cs, 'KiroCrew', 'bin', 'kirocrew'), '#!/bin/sh\n');
      fs.mkdirSync(path.join(fe.cs, 'run'), { recursive: true });
      fs.writeFileSync(path.join(fe.cs, 'run', 'setup.log'), 'log');
      const r = await crew(fe, ['uninstall', '--purge']);
      assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
      for (const gone of ['bin', 'run', 'cache', '.crew.json.123.tmp']) assert.equal(fs.existsSync(path.join(fe.cs, gone)), false, gone);
      assert.equal(fs.readFileSync(path.join(fe.cs, 'notes.txt'), 'utf8'), 'user data');
      assert.equal(fs.existsSync(path.join(fe.cs, 'KiroCrew', 'bin', 'kirocrew')), true, 'a checkout inside $CS is kept');
      assert.equal(fs.existsSync(path.join(fe.cs, 'node', 'package.json')), true, 'a bridge prefix holding more than claude-agent-acp is kept');
      assert.match(r.stdout, /kept/);
      for (const kept of ['KiroCrew', 'node', 'notes.txt']) assert.match(r.stdout, new RegExp(kept.replace('.', '\\.')), kept);
    } finally {
      fe.cleanup();
    }
  });

  it('removes our bridge and $CS when only crew leftovers remain (no Python needed)', async () => {
    const fe = makeFakeEnv();
    try {
      leftovers(fe);
      const r = await crew(fe, ['uninstall', '--purge']);
      assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
      assert.equal(fs.existsSync(fe.cs), false, `left: ${fs.existsSync(fe.cs) ? fs.readdirSync(fe.cs).join(', ') : ''}`);
    } finally {
      fe.cleanup();
    }
  });

  it('refuses while run/ready.json names a gateway that may still run, and removes nothing', async () => {
    const fe = makeFakeEnv();
    try {
      leftovers(fe);
      // This test process stands in for the gateway: alive, same start time, this boot.
      writeReady(fe, process.pid, procStart(process.pid));
      const r = await crew(fe, ['uninstall', '--purge']);
      assert.equal(r.code, 1, r.stdout);
      assert.match(r.stderr, /may still be running/);
      assert.match(r.stderr, new RegExp(`pid ${process.pid}`));
      assert.doesNotMatch(r.stderr, /not set up yet/);
      assert.equal(fs.existsSync(path.join(fe.cs, 'node', 'package.json')), true, 'the bridge a running gateway uses is kept');
      assert.equal(fs.existsSync(path.join(fe.cs, 'run', 'ready.json')), true);
      assert.equal(fs.existsSync(path.join(fe.cs, 'run', 'token')), true);
    } finally {
      fe.cleanup();
    }
  });

  it('refuses when ready.json has no identity but its pid is alive (it cannot be told apart from the gateway)', async () => {
    const fe = makeFakeEnv();
    try {
      leftovers(fe);
      writeReady(fe, process.pid, undefined);
      const r = await crew(fe, ['uninstall', '--purge']);
      assert.equal(r.code, 1, r.stdout);
      assert.match(r.stderr, /may still be running/);
      assert.equal(fs.existsSync(path.join(fe.cs, 'node')), true);
    } finally {
      fe.cleanup();
    }
  });

  it('refuses when ready.json cannot be read (it may name a running gateway)', async () => {
    const fe = makeFakeEnv();
    try {
      leftovers(fe);
      fs.mkdirSync(path.join(fe.cs, 'run'), { recursive: true });
      fs.writeFileSync(path.join(fe.cs, 'run', 'ready.json'), '{');
      const r = await crew(fe, ['uninstall', '--purge']);
      assert.equal(r.code, 1, r.stdout);
      assert.match(r.stderr, /may still be running \(.*ready\.json cannot be read\)/);
      assert.equal(fs.existsSync(path.join(fe.cs, 'node')), true);
    } finally {
      fe.cleanup();
    }
  });

  it('purges past a ready.json whose pid is gone', async () => {
    const fe = makeFakeEnv();
    try {
      leftovers(fe);
      // The recorded pid names no process (the sys double says so; a real dead pid could be reused).
      const dead = 999_999;
      writeReady(fe, dead, undefined);
      const sys: CrewSys = { ...defaultSys, isAlive: (pid: number) => pid !== dead && defaultSys.isAlive(pid) };
      const r = await crew(fe, ['uninstall', '--purge'], { deps: { sys } });
      assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
      assert.equal(fs.existsSync(fe.cs), false);
    } finally {
      fe.cleanup();
    }
  });

  it('purges past a stale ready.json (its pid now names another process)', { skip: process.platform !== 'linux' ? 'needs /proc' : false }, async () => {
    const fe = makeFakeEnv();
    try {
      leftovers(fe);
      const st = procStart(process.pid);
      assert.ok(st !== undefined);
      writeReady(fe, process.pid, st - 1);
      const r = await crew(fe, ['uninstall', '--purge']);
      assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
      assert.equal(fs.existsSync(fe.cs), false, 'the stale ready.json and token went with the run dir');
    } finally {
      fe.cleanup();
    }
  });

  it('a corrupt crew.json still fails with its error and purges nothing', async () => {
    const fe = makeFakeEnv();
    try {
      leftovers(fe);
      fs.writeFileSync(path.join(fe.cs, 'crew.json'), '{ not json');
      const r = await crew(fe, ['uninstall', '--purge']);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /crew\.json is not valid JSON/);
      assert.equal(fs.existsSync(path.join(fe.cs, 'node', 'package.json')), true);
      assert.equal(fs.existsSync(path.join(fe.cs, 'cache', 'npm', 'blob')), true);
    } finally {
      fe.cleanup();
    }
  });

  it('a plain uninstall without crew.json keeps its message and exit code, and removes nothing', async () => {
    const fe = makeFakeEnv();
    try {
      leftovers(fe);
      const r = await crew(fe, ['uninstall']);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /Kiro Crew is not set up yet\. Run: kiro-claude crew setup/);
      assert.equal(fs.existsSync(path.join(fe.cs, 'node', 'package.json')), true);
      assert.equal(fs.existsSync(path.join(fe.cs, 'bin')), true);
    } finally {
      fe.cleanup();
    }
  });

  it('with no crew state directory at all there is nothing to purge (exit 0)', async () => {
    const fe = makeFakeEnv();
    try {
      assert.equal(fs.existsSync(fe.cs), false);
      const r = await crew(fe, ['uninstall', '--purge']);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /[Nn]othing to purge/);
    } finally {
      fe.cleanup();
    }
  });

  it('the uninstall help says --purge also cleans up after an earlier plain uninstall', async () => {
    const fe = makeFakeEnv();
    try {
      const r = await crew(fe, ['uninstall', '--help']);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout.replace(/\s+/g, ' '), /after an earlier plain .*uninstall/i);
    } finally {
      fe.cleanup();
    }
  });
});

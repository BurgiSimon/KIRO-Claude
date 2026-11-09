/**
 * r12 #1 (session group): the decision behind the hung-up holder recovery
 * (session/store.ts hungUpLockHolder), over a fake /proc root (the LockProcView seam): only a
 * process that is verifiably the lock's writer (this host and boot, its start time the lock's
 * `start_ticks`, our uid and euid, /proc of our own pid namespace), in a job-control stop (`T`,
 * never a ptrace stop `t`) with SIGHUP or SIGTERM pending (SigPnd or ShdPnd), is one to continue.
 * Also: the lock a store writes on Linux records this process's boot id and start time.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SessionStore, hungUpLockHolder } from '../../src/session/store.js';
import { removeOnExit } from '../tmpdirs.js';

const skip = process.platform === 'linux' ? false : 'Linux only (the decision is false elsewhere)';
const PID = 424242;
const START = 987654;
const BOOT = '5b0f6f43-8f4b-4c55-9d43-0d5f1b2f3a11';
const UID = 1000;

interface Fake {
  state?: string;
  start?: number;
  uid?: [number, number];
  sigPnd?: string;
  shdPnd?: string;
  boot?: string;
  selfPid?: number;
  comm?: string;
}

/** A fake /proc with our own `self/stat`, the boot id and the holder PID's stat and status. */
function fakeProc(f: Fake = {}): string {
  const root = removeOnExit(fs.mkdtempSync(path.join(os.tmpdir(), 'kc-r12f-proc-')));
  const stat = (pid: number, state: string, start: number, comm = 'node'): string => {
    // fields 3 … 52; field 22 (index 19 after the comm) is the start time
    const rest = Array.from({ length: 50 }, (_, i) => (i === 0 ? state : i === 19 ? String(start) : '0'));
    return `${pid} (${comm}) ${rest.join(' ')}\n`;
  };
  fs.mkdirSync(path.join(root, 'self'));
  fs.writeFileSync(path.join(root, 'self', 'stat'), stat(f.selfPid ?? process.pid, 'R', 1));
  fs.mkdirSync(path.join(root, 'sys', 'kernel', 'random'), { recursive: true });
  fs.writeFileSync(path.join(root, 'sys', 'kernel', 'random', 'boot_id'), `${f.boot ?? BOOT}\n`);
  fs.mkdirSync(path.join(root, String(PID)));
  fs.writeFileSync(path.join(root, String(PID), 'stat'), stat(PID, f.state ?? 'T', f.start ?? START, f.comm));
  const [ruid, euid] = f.uid ?? [UID, UID];
  fs.writeFileSync(
    path.join(root, String(PID), 'status'),
    [
      'Name:\tnode',
      `State:\t${f.state ?? 'T'} (stopped)`,
      `Pid:\t${PID}`,
      `Uid:\t${ruid}\t${euid}\t${ruid}\t${euid}`,
      `Gid:\t${UID}\t${UID}\t${UID}\t${UID}`,
      `SigPnd:\t${f.sigPnd ?? '0000000000000000'}`,
      `ShdPnd:\t${f.shdPnd ?? '0000000000000001'}`,
      'SigBlk:\t0000000000000000',
      'SigIgn:\t0000000001001000',
      'SigCgt:\t0000000188004602',
      '',
    ].join('\n'),
  );
  return root;
}

const lock = (extra: Record<string, unknown> = {}): string =>
  `${JSON.stringify({ pid: PID, started_at: '2026-11-09T10:00:00.000Z', host: os.hostname(), boot_id: BOOT, start_ticks: START, ...extra })}\n`;
const view = (procRoot: string, uid = UID, euid = UID) => ({ procRoot, uid, euid });

describe('r12f hungUpLockHolder: the decision', { skip }, () => {
  it('stopped (T) with SIGHUP pending process-wide (ShdPnd bit 0), the lock’s writer, our uid: true', () => {
    assert.equal(hungUpLockHolder(lock(), view(fakeProc())), true);
  });

  it('SIGTERM pending (bit 14), in SigPnd or ShdPnd, also with other signals pending: true', () => {
    assert.equal(hungUpLockHolder(lock(), view(fakeProc({ shdPnd: '0000000000004000' }))), true);
    assert.equal(hungUpLockHolder(lock(), view(fakeProc({ shdPnd: '0000000000000000', sigPnd: '0000000000004000' }))), true);
    assert.equal(hungUpLockHolder(lock(), view(fakeProc({ shdPnd: '0000000000020001' }))), true);
    assert.equal(hungUpLockHolder(lock(), view(fakeProc({ shdPnd: '0000000000000000', sigPnd: '0000000000000001' }))), true);
  });

  it('a comm with spaces and parentheses is parsed from its last ")"', () => {
    assert.equal(hungUpLockHolder(lock(), view(fakeProc({ comm: 'kiro (claude) x' }))), true);
  });

  it('nothing, or only other signals, pending (an ordinary Ctrl+Z in a terminal still open): false', () => {
    assert.equal(hungUpLockHolder(lock(), view(fakeProc({ shdPnd: '0000000000000000' }))), false);
    // SIGINT (bit 1), SIGCONT (bit 17), SIGWINCH (bit 27)
    assert.equal(hungUpLockHolder(lock(), view(fakeProc({ shdPnd: '0000000004020002' }))), false);
  });

  it('a ptrace stop (t), a running, sleeping or zombie process: false', () => {
    for (const state of ['t', 'R', 'S', 'D', 'Z']) assert.equal(hungUpLockHolder(lock(), view(fakeProc({ state }))), false, state);
  });

  it('a start time other than the lock’s (pid reuse), a lock without one, another boot: false', () => {
    assert.equal(hungUpLockHolder(lock(), view(fakeProc({ start: START + 1 }))), false);
    assert.equal(hungUpLockHolder(lock({ start_ticks: undefined }), view(fakeProc())), false);
    assert.equal(hungUpLockHolder(lock({ boot_id: undefined }), view(fakeProc())), false);
    assert.equal(hungUpLockHolder(lock(), view(fakeProc({ boot: '00000000-0000-4000-8000-000000000000' }))), false);
    // KiroCrew's / kiro-cli's shape
    assert.equal(hungUpLockHolder(`${JSON.stringify({ pid: PID, started_at: 'x' })}\n`, view(fakeProc())), false);
  });

  it('another host, a lock without host, our own pid: false', () => {
    assert.equal(hungUpLockHolder(lock({ host: `not-${os.hostname()}` }), view(fakeProc())), false);
    assert.equal(hungUpLockHolder(lock({ host: undefined }), view(fakeProc())), false);
    assert.equal(hungUpLockHolder(lock({ pid: process.pid }), view(fakeProc())), false);
  });

  it('another user (real or effective uid): false', () => {
    assert.equal(hungUpLockHolder(lock(), view(fakeProc({ uid: [0, 0] }))), false);
    assert.equal(hungUpLockHolder(lock(), view(fakeProc({ uid: [UID, 0] }))), false);
    assert.equal(hungUpLockHolder(lock(), view(fakeProc({ uid: [0, UID] }))), false);
    assert.equal(hungUpLockHolder(lock(), view(fakeProc(), 0, 0)), false);
  });

  it('a /proc of another pid namespace (self is not us), unreadable entries, a corrupt lock: false', () => {
    assert.equal(hungUpLockHolder(lock(), view(fakeProc({ selfPid: process.pid + 1 }))), false);
    const gone = fakeProc();
    fs.rmSync(path.join(gone, String(PID)), { recursive: true });
    assert.equal(hungUpLockHolder(lock(), view(gone)), false);
    const noStatus = fakeProc();
    fs.rmSync(path.join(noStatus, String(PID), 'status'));
    assert.equal(hungUpLockHolder(lock(), view(noStatus)), false);
    const noBoot = fakeProc();
    fs.rmSync(path.join(noBoot, 'sys'), { recursive: true });
    assert.equal(hungUpLockHolder(lock(), view(noBoot)), false);
    for (const junk of ['', '{', 'null', '{"pid":"1"}', '{"pid":-1}']) assert.equal(hungUpLockHolder(junk, view(fakeProc())), false, junk);
  });
});

describe('r12f session lock: what the lock records', { skip }, () => {
  it('acquireLock writes this boot’s id and this process’s start time next to {pid, started_at, host}', () => {
    const dir = removeOnExit(fs.mkdtempSync(path.join(os.tmpdir(), 'kc-r12f-lockfile-')));
    const s = new SessionStore(dir);
    const l = s.acquireLock('abc');
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, 'abc.lock'), 'utf8')) as Record<string, unknown>;
      const self = fs.readFileSync('/proc/self/stat', 'utf8');
      const start = Number(self.slice(self.lastIndexOf(')') + 2).split(' ')[19]);
      assert.deepEqual(Object.keys(data), ['pid', 'started_at', 'host', 'boot_id', 'start_ticks']);
      assert.equal(data.pid, process.pid);
      assert.equal(data.boot_id, fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim());
      assert.equal(data.start_ticks, start);
      // lockInfo keeps its shape
      assert.deepEqual(Object.keys(s.lockInfo('abc')!), ['pid', 'startedAt', 'host', 'live']);
    } finally {
      l.release();
    }
    assert.equal(fs.existsSync(path.join(dir, 'abc.lock')), false);
  });
});

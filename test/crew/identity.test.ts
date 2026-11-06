import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createIdentityStub,
  inspectIdentityStore,
  removeIdentityStub,
  STUB_AUTH_KEY,
  STUB_AUTH_VALUE,
  STUB_SENTINEL_KEY,
} from '../../src/crew/identity.js';
import { defaultRunner } from '../../src/crew/runner.js';
import { realPython } from './helpers.js';

const PY = realPython();
const runner = defaultRunner;

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kc-id-'));
}

function sql(python: string, db: string, code: string): string {
  const r = spawnSync(python, ['-I', '-c', `import sqlite3,json,sys\ndb=sqlite3.connect(sys.argv[1])\n${code}\ndb.commit()`, db], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

describe('identity stub (08 §3.5, 09 item 1)', { skip: PY ? false : 'no python3 with sqlite3' }, () => {
  it('stub claims are exactly §3.5 and contain no token fields', () => {
    assert.equal(STUB_AUTH_KEY, 'kirocli:social:token');
    assert.equal(STUB_AUTH_VALUE, '{"start_url":"https://claude.ai/kiro-claude","region":"us-east-1","oauth_flow":"kiro-claude","client_id":"kiro-claude","scopes":["claude-code"]}');
    assert.doesNotMatch(STUB_AUTH_VALUE, /access_token|refresh_token|"token"|expires/);
    assert.equal(STUB_SENTINEL_KEY, 'kiro-claude.identity-stub');
  });

  it('creates the stub (dir 0700, file 0600) with one auth_kv row and one sentinel row', async () => {
    const d = tmp();
    const store = path.join(d, '.local', 'share', 'kiro-cli', 'data.sqlite3');
    const r = await createIdentityStub(store, { runner, python: PY!, now: new Date('2026-11-06T12:00:00Z') });
    assert.deepEqual(r, { result: 'created', createdDir: true });
    assert.equal(fs.statSync(store).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(store)).mode & 0o777, 0o700);
    const dump = JSON.parse(
      sql(PY!, store, `print(json.dumps({"auth": db.execute("select key,value from auth_kv").fetchall(), "state": db.execute("select key,value from state").fetchall(), "tables": sorted(t for (t,) in db.execute("select name from sqlite_master where type='table'"))}))`),
    );
    assert.deepEqual(dump.tables, ['auth_kv', 'state']);
    assert.deepEqual(dump.auth, [[STUB_AUTH_KEY, STUB_AUTH_VALUE]]);
    assert.deepEqual(dump.state, [[STUB_SENTINEL_KEY, '{"createdBy":"kiro-claude crew setup","version":1,"createdAt":"2026-11-06T12:00:00.000Z"}']]);
    assert.ok(!dump.state.some(([k]: [string]) => k.startsWith('auth.') || k.startsWith('api.codewhisperer.')), 'sentinel cannot affect the fingerprint');
    assert.deepEqual(fs.readdirSync(path.dirname(store)), ['data.sqlite3'], 'no temp files left');
    const ins = await inspectIdentityStore(store, { runner, python: PY });
    assert.equal(ins.ours, true);
    assert.equal(ins.via, 'python');
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('NEVER touches an existing store — not even one without an identity row (09 item 1)', async () => {
    const d = tmp();
    const store = path.join(d, 'kiro-cli', 'data.sqlite3');
    fs.mkdirSync(path.dirname(store), { recursive: true });
    for (const content of ['', 'not a database at all']) {
      fs.writeFileSync(store, content);
      fs.utimesSync(store, new Date(1_000_000_000_000), new Date(1_000_000_000_000));
      const before = fs.statSync(store);
      const r = await createIdentityStub(store, { runner, python: PY! });
      assert.equal(r.result, 'exists');
      const after = fs.statSync(store);
      assert.equal(fs.readFileSync(store, 'utf8'), content);
      assert.equal(after.mtimeMs, before.mtimeMs);
      assert.equal(after.ino, before.ino);
    }
    // A real store with tokens: untouched and reported as not ours.
    fs.rmSync(store);
    sql(PY!, store, `db.execute("create table auth_kv (key text primary key, value text)")\ndb.execute("insert into auth_kv values ('kirocli:social:token', '{\\"access_token\\":\\"secret\\"}')")`);
    const bytes = fs.readFileSync(store);
    assert.equal((await createIdentityStub(store, { runner, python: PY! })).result, 'exists');
    assert.ok(fs.readFileSync(store).equals(bytes));
    const ins = await inspectIdentityStore(store, { runner, python: PY });
    assert.equal(ins.exists, true);
    assert.equal(ins.ours, false);
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('a symlink at the store path counts as an existing store', async () => {
    const d = tmp();
    const store = path.join(d, 'kiro-cli', 'data.sqlite3');
    fs.mkdirSync(path.dirname(store), { recursive: true });
    fs.symlinkSync(path.join(d, 'nowhere'), store);
    assert.equal((await createIdentityStub(store, { runner, python: PY! })).result, 'exists');
    assert.equal(fs.existsSync(path.join(d, 'nowhere')), false);
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('race: the python side refuses when the file appears after the fast check', async () => {
    const d = tmp();
    const store = path.join(d, 'kiro-cli', 'data.sqlite3');
    // Simulate the race by wrapping the runner: create the file just before python runs.
    const racing = {
      ...runner,
      run: (file: string, args: readonly string[], opts?: Parameters<typeof runner.run>[2]) => {
        fs.mkdirSync(path.dirname(store), { recursive: true });
        fs.writeFileSync(store, 'real');
        return runner.run(file, args, opts);
      },
    };
    const r = await createIdentityStub(store, { runner: racing, python: PY! });
    assert.equal(r.result, 'exists');
    assert.equal(fs.readFileSync(store, 'utf8'), 'real');
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('removal deletes only our unmodified stub (and its dir when we created it)', async () => {
    const d = tmp();
    const store = path.join(d, 'kiro-cli', 'data.sqlite3');
    await createIdentityStub(store, { runner, python: PY! });
    let r = await removeIdentityStub(store, { runner, python: PY!, removeDir: true });
    assert.equal(r.result, 'removed');
    assert.equal(r.removedDir, true);
    assert.equal(fs.existsSync(path.dirname(store)), false);
    r = await removeIdentityStub(store, { runner, python: PY! });
    assert.equal(r.result, 'absent');

    // Modified by kiro-cli (a real login replaced the row) → not ours, kept.
    await createIdentityStub(store, { runner, python: PY! });
    sql(PY!, store, `db.execute("update auth_kv set value='{\\"access_token\\":\\"x\\"}'")`);
    r = await removeIdentityStub(store, { runner, python: PY! });
    assert.equal(r.result, 'not-ours');
    assert.equal(fs.existsSync(store), true);
    fs.rmSync(store);

    // Extra tables / rows → not ours.
    await createIdentityStub(store, { runner, python: PY! });
    sql(PY!, store, 'db.execute("create table conversations (id text)")');
    assert.equal((await removeIdentityStub(store, { runner, python: PY! })).result, 'not-ours');
    fs.rmSync(store);
    await createIdentityStub(store, { runner, python: PY! });
    sql(PY!, store, `db.execute("insert into state values ('auth.idc.region', 'x')")`);
    assert.equal((await removeIdentityStub(store, { runner, python: PY! })).result, 'not-ours');
    fs.rmSync(store);

    // A store without the sentinel (made like 08b's make_identity_store.py) → not ours.
    sql(PY!, store, `db.execute("create table auth_kv (key text primary key, value text)")\ndb.execute("insert into auth_kv values (?, ?)", ("${STUB_AUTH_KEY}", ${JSON.stringify(STUB_AUTH_VALUE)}))`);
    assert.equal((await removeIdentityStub(store, { runner, python: PY! })).result, 'not-ours');
    assert.equal(fs.existsSync(store), true);
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('without python, inspection falls back to existence + a byte scan for the sentinel', async () => {
    const d = tmp();
    const store = path.join(d, 'kiro-cli', 'data.sqlite3');
    assert.equal((await inspectIdentityStore(store, { runner })).exists, false);
    await createIdentityStub(store, { runner, python: PY! });
    const ins = await inspectIdentityStore(store, { runner });
    assert.deepEqual([ins.exists, ins.ours, ins.via], [true, true, 'scan']);
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('reports a python failure clearly', async () => {
    const d = tmp();
    await assert.rejects(createIdentityStub(path.join(d, 'x', 'data.sqlite3'), { runner, python: path.join(d, 'no-python') }), /cannot run/);
    fs.rmSync(d, { recursive: true, force: true });
  });
});

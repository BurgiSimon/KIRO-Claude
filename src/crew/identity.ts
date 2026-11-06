/**
 * The token-less kiro-cli identity stub (08-kirocrew-integration §0 item 4, §3.5; user decision
 * 09 item 1 — binding).
 *
 * Why: KiroCrew fingerprints kiro-cli's identity store (`auth_kv` rows of
 * `~/.local/share/kiro-cli/data.sqlite3`); with no store the fingerprint is "absent", which is
 * never reconciled, so every dashboard turn and cron fire retires all idle kiro runtimes
 * (V6, 08b run 1). One `auth_kv` row of stable claims (NO tokens) fixes it (08b run 2).
 *
 * Rules (09 item 1):
 * - written ONLY when no store file exists (a present file — even one without an identity row —
 *   counts as a real store and is never opened for writing, modified or replaced);
 * - clearly marked: a `state` row `kiro-claude.identity-stub` (KiroCrew only reads `state` keys
 *   starting `auth.` / `api.codewhisperer.`, so the sentinel cannot affect the fingerprint) and
 *   claims naming kiro-claude (`oauth_flow`, `client_id`, `start_url`);
 * - never `auth.idc.*` rows (they would turn on MCP-registry governance);
 * - removed only when it is provably ours: sentinel present, `auth_kv` holds exactly the stub
 *   row, `state` holds exactly the sentinel, no other table exists, and no non-empty `-wal` /
 *   `-journal` holds later writes;
 * - inspected with an immutable read-only open, which never creates files next to the store.
 *
 * kiro-claude has zero runtime dependencies and supports Node 18, so the SQLite work runs in
 * Python's stdlib `sqlite3` (`<python> -I -c <script>`, 08 §3.10); KiroCrew needs Python ≥ 3.12
 * anyway. Creation is atomic and never overwrites: the database is built in a temp file in the
 * same directory and published with `os.link` (fails if the target exists), falling back to an
 * `O_EXCL` create + copy where hard links are unsupported. Directory mode 0700, file mode 0600.
 */
import * as fs from 'node:fs';

import type { CrewRunner } from './runner.js';

export const STUB_AUTH_KEY = 'kirocli:social:token';
/** Stable claims only, no token fields (§3.5, exact). */
export const STUB_AUTH_VALUE = JSON.stringify({
  start_url: 'https://claude.ai/kiro-claude',
  region: 'us-east-1',
  oauth_flow: 'kiro-claude',
  client_id: 'kiro-claude',
  scopes: ['claude-code'],
});
export const STUB_SENTINEL_KEY = 'kiro-claude.identity-stub';

export function sentinelValue(createdAt: string): string {
  return JSON.stringify({ createdBy: 'kiro-claude crew setup', version: 1, createdAt });
}

/**
 * Shared Python helper: inspect a store without changing anything and decide whether it is
 * exactly our stub. `immutable=1` (with `mode=ro`) is required: a plain read-only open of a
 * WAL-mode database CREATES `-wal`/`-shm` files next to it (verified with SQLite 3.x), i.e. it
 * would touch a real kiro-cli store's directory (09 item 1). An immutable open ignores WAL
 * content, so a non-empty `-wal` (or hot `-journal`) means "written since" and is never ours.
 */
const PY_INSPECT_FN = String.raw`
import json, os, pathlib, sqlite3, sys
def inspect(path, auth_key, auth_value, sentinel_key):
    r = {"exists": os.path.lexists(path), "ours": False, "sentinel": False, "tables": [], "authRows": 0, "stateRows": 0, "pendingWrites": False}
    if not r["exists"]:
        return r
    if os.path.islink(path) or not os.path.isfile(path):
        r["error"] = "not a regular file"
        return r
    for suffix in ("-wal", "-journal"):
        try:
            if os.path.getsize(path + suffix) > 0:
                r["pendingWrites"] = True
        except OSError:
            pass
    try:
        uri = pathlib.Path(os.path.abspath(path)).as_uri() + "?mode=ro&immutable=1"
        db = sqlite3.connect(uri, uri=True)
        try:
            tables = sorted(t for (t,) in db.execute("SELECT name FROM sqlite_master WHERE type='table'"))
            r["tables"] = tables
            auth = db.execute("SELECT key, value FROM auth_kv").fetchall() if "auth_kv" in tables else []
            state = db.execute("SELECT key, value FROM state").fetchall() if "state" in tables else []
        finally:
            db.close()
    except Exception as e:
        r["error"] = str(e)
        return r
    r["authRows"] = len(auth)
    r["stateRows"] = len(state)
    r["sentinel"] = any(k == sentinel_key for (k, _v) in state)
    r["ours"] = (r["sentinel"] and not r["pendingWrites"] and set(tables) <= {"auth_kv", "state"}
                 and auth == [(auth_key, auth_value)]
                 and len(state) == 1)
    return r
`;

/** argv: path auth_key auth_value sentinel_key sentinel_value → prints JSON {"result": "created"|"exists", "createdDir": bool}. */
export const PY_CREATE = String.raw`
import json, os, sqlite3, sys, tempfile
path, auth_key, auth_value, sentinel_key, sentinel_value = sys.argv[1:6]
d = os.path.dirname(path)
created_dir = not os.path.isdir(d)
os.makedirs(d, mode=0o700, exist_ok=True)
if created_dir:
    os.chmod(d, 0o700)
def done(result):
    print(json.dumps({"result": result, "createdDir": created_dir}))
    sys.exit(0)
if os.path.lexists(path):
    done("exists")
fd, tmp = tempfile.mkstemp(prefix=".kiro-claude-identity-", suffix=".tmp", dir=d)
os.close(fd)
try:
    os.chmod(tmp, 0o600)
    db = sqlite3.connect(tmp)
    db.execute("CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)")
    db.execute("CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT)")
    db.execute("INSERT INTO auth_kv (key, value) VALUES (?, ?)", (auth_key, auth_value))
    db.execute("INSERT INTO state (key, value) VALUES (?, ?)", (sentinel_key, sentinel_value))
    db.commit()
    db.close()
    try:
        os.link(tmp, path)
    except FileExistsError:
        done("exists")
    except OSError:
        try:
            out = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            done("exists")
        with open(tmp, "rb") as src, os.fdopen(out, "wb") as dst:
            dst.write(src.read())
    os.chmod(path, 0o600)
finally:
    try:
        os.unlink(tmp)
    except OSError:
        pass
done("created")
`;

/** argv: path auth_key auth_value sentinel_key → prints the inspection JSON. */
export const PY_INSPECT = `${PY_INSPECT_FN}
print(json.dumps(inspect(*sys.argv[1:5])))
`;

/** argv: path auth_key auth_value sentinel_key remove_dir(0|1) → prints {"result":"removed"|"absent"|"not-ours", …}. */
export const PY_REMOVE = `${PY_INSPECT_FN}
path, auth_key, auth_value, sentinel_key, remove_dir = sys.argv[1:6]
r = inspect(path, auth_key, auth_value, sentinel_key)
if not r["exists"]:
    r["result"] = "absent"
elif not r["ours"]:
    r["result"] = "not-ours"
else:
    for suffix in ("", "-wal", "-shm", "-journal"):
        try:
            os.unlink(path + suffix)
        except FileNotFoundError:
            pass
    r["result"] = "removed"
    if remove_dir == "1":
        try:
            os.rmdir(os.path.dirname(path))
            r["removedDir"] = True
        except OSError:
            r["removedDir"] = False
print(json.dumps(r))
`;

export interface StoreInspection {
  exists: boolean;
  ours: boolean;
  sentinel: boolean;
  tables: string[];
  authRows: number;
  stateRows: number;
  /** A non-empty `-wal`/`-journal` sits next to the store (someone wrote to it since). */
  pendingWrites?: boolean;
  error?: string;
  /** How the answer was obtained: `python` (authoritative) or `scan` (no Python: byte scan). */
  via: 'python' | 'scan' | 'fs';
}

export class IdentityStubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityStubError';
  }
}

function parseLastJson(stdout: string): Record<string, unknown> | undefined {
  const lines = stdout.trim().split(/\r?\n/).reverse();
  for (const l of lines) {
    const t = l.trim();
    if (!t.startsWith('{')) continue;
    try {
      const v = JSON.parse(t) as unknown;
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

async function runPython(runner: CrewRunner, python: string, script: string, args: string[], env?: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  const r = await runner.run(python, ['-I', '-c', script, ...args], { timeoutMs: 30_000, env });
  if (r.error) throw new IdentityStubError(`cannot run ${python}: ${r.error}`);
  const json = parseLastJson(r.stdout);
  if (r.code !== 0 || !json) {
    const detail = (r.stderr || r.stdout).trim().split(/\r?\n/).slice(-3).join(' | ');
    throw new IdentityStubError(`${python} failed (exit ${r.code ?? r.signal})${detail ? `: ${detail}` : ''}`);
  }
  return json;
}

function toInspection(j: Record<string, unknown>, via: StoreInspection['via']): StoreInspection {
  return {
    exists: j.exists === true,
    ours: j.ours === true,
    sentinel: j.sentinel === true,
    tables: Array.isArray(j.tables) ? (j.tables.filter((t) => typeof t === 'string') as string[]) : [],
    authRows: typeof j.authRows === 'number' ? j.authRows : 0,
    stateRows: typeof j.stateRows === 'number' ? j.stateRows : 0,
    pendingWrites: j.pendingWrites === true ? true : undefined,
    error: typeof j.error === 'string' ? j.error : undefined,
    via,
  };
}

/**
 * Inspects the store. With a Python the answer is authoritative; without one, only existence and
 * a byte scan for the sentinel key (never used to delete).
 */
export async function inspectIdentityStore(storePath: string, opts: { runner: CrewRunner; python?: string; env?: NodeJS.ProcessEnv }): Promise<StoreInspection> {
  let exists = false;
  try {
    fs.lstatSync(storePath);
    exists = true;
  } catch {
    exists = false;
  }
  if (!exists) return { exists: false, ours: false, sentinel: false, tables: [], authRows: 0, stateRows: 0, via: 'fs' };
  if (opts.python) {
    const j = await runPython(opts.runner, opts.python, PY_INSPECT, [storePath, STUB_AUTH_KEY, STUB_AUTH_VALUE, STUB_SENTINEL_KEY], opts.env);
    return toInspection(j, 'python');
  }
  let sentinel = false;
  try {
    sentinel = fs.readFileSync(storePath).includes(Buffer.from(STUB_SENTINEL_KEY));
  } catch {
    sentinel = false;
  }
  return { exists: true, ours: sentinel, sentinel, tables: [], authRows: 0, stateRows: 0, via: 'scan' };
}

export interface CreateStubResult {
  result: 'created' | 'exists';
  createdDir: boolean;
}

/** Creates the stub unless a store file exists (never overwrites; see module doc). */
export async function createIdentityStub(storePath: string, opts: { runner: CrewRunner; python: string; now?: Date; env?: NodeJS.ProcessEnv }): Promise<CreateStubResult> {
  // Fast path: never even start Python for an existing store.
  try {
    fs.lstatSync(storePath);
    return { result: 'exists', createdDir: false };
  } catch {
    // absent
  }
  const createdAt = (opts.now ?? new Date()).toISOString();
  const j = await runPython(opts.runner, opts.python, PY_CREATE, [storePath, STUB_AUTH_KEY, STUB_AUTH_VALUE, STUB_SENTINEL_KEY, sentinelValue(createdAt)], opts.env);
  const result = j.result === 'created' ? 'created' : 'exists';
  return { result, createdDir: j.createdDir === true };
}

export interface RemoveStubResult {
  result: 'removed' | 'absent' | 'not-ours';
  removedDir?: boolean;
  inspection: StoreInspection;
}

/** Removes the store only if it is exactly our stub. `removeDir` also removes the (then empty) directory. */
export async function removeIdentityStub(storePath: string, opts: { runner: CrewRunner; python: string; removeDir?: boolean; env?: NodeJS.ProcessEnv }): Promise<RemoveStubResult> {
  const j = await runPython(opts.runner, opts.python, PY_REMOVE, [storePath, STUB_AUTH_KEY, STUB_AUTH_VALUE, STUB_SENTINEL_KEY, opts.removeDir ? '1' : '0'], opts.env);
  const result = j.result === 'removed' ? 'removed' : j.result === 'absent' ? 'absent' : 'not-ours';
  return { result, removedDir: typeof j.removedDir === 'boolean' ? j.removedDir : undefined, inspection: toInspection(j, 'python') };
}

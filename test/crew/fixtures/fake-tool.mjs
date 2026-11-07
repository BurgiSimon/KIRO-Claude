// Fake external tools for the `kiro-claude crew` tests: git, python, pip, npm, make, kirocrew,
// node, xdg-open. Invoked through small `#!/bin/sh` wrappers written by test/crew/helpers.ts:
//   exec '<node>' '<this file>' <tool> "$@"
// Zero dependencies. Every call is appended to $FAKE_LOG (JSONL: tool, args, cwd, env subset).
//
// Knobs (environment):
//   FAKE_LOG                 JSONL call log
//   FAKE_PIN                 the pinned KiroCrew commit (default HEAD for a submodule update)
//   FAKE_KC_TEMPLATE         directory copied into a checkout by `checkout FETCH_HEAD` / `submodule update`
//   FAKE_FAIL                "<tool>:<substring>[;…]" → that call prints "fake failure" and exits 1
//   FAKE_GIT_VERSION, FAKE_PYTHON_VERSION, FAKE_NODE_VERSION, FAKE_KC_VERSION
//   FAKE_GIT_FETCH_SHA       sha a fetch lands on (default: the requested one)
//   FAKE_GIT_DIRTY           stdout of `status --porcelain`
//   FAKE_REAL_PYTHON         real python used for `-I -c` scripts (identity stub)
//   FAKE_GATEWAY_MODE        ok (default) | fail | hang | ignore-term
//   FAKE_GW_AUTH             "0" → /api/kiro-prerequisite reports authenticated:false
//   FAKE_STOP_IGNORE         "1" → `kirocrew stop` does nothing
//   FAKE_KC_DOCTOR_OUTPUT    replaces `kirocrew doctor` output
//   FAKE_KC_EXIT             exit code of other kirocrew verbs (exec tests)
//   FAKE_OPEN_EXIT           exit code of xdg-open/open
//   FAKE_GATEWAY_CHILD       linger | stubborn → the gateway starts a child in its process group that
//                            outlives it (like KiroCrew's history-index worker after os._exit);
//                            linger exits on SIGTERM, stubborn ignores it. late → the gateway starts a
//                            SIGTERM-ignoring child only when it is told to stop, just before it exits
//                            (not in crew stop's snapshot of the tree). Pid (and start time) in
//                            fake-gateway-child.json
//   FAKE_LOCK_INHERIT        "1" → that child inherits the gateway's lock fd (KiroCrew's flock lives on in a
//                            forked child): once the gateway is gone (a crash) while the child runs, the lock
//                            stays held with no live holder to name. `gateway-pid` then answers what KiroCrew
//                            answers on Linux, where /proc/locks names the dead acquirer: {"holder":
//                            "indeterminate"} (exit 2), or {"holder":"held"} with $KIROCREW_HOME/fake-held;
//                            `stop` refuses ("Not signalling anything", exit 1)
//   $KIROCREW_HOME/fake-held  exists → `gateway-pid` answers {"holder":"held"} while the gateway runs, or
//                            a child keeps its lock (a held lock whose holder KiroCrew cannot name); `stop` is unchanged (KiroCrew
//                            tries its authenticated API shutdown first). A file, so a test can flip it
//                            while one `crew stop` polls.
// The gateway's pid is recorded with its start time (fake-gateway.json), and `gateway-pid`, `stop` and
// `token` act on it only while that pid still has that start time: the file outlives a crashed gateway,
// and its pid may be another process's by then (K8).
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const tool = process.argv[2];
const args = process.argv.slice(3);
const env = process.env;

const LOGGED_ENV = [
  'HOME', 'PATH', 'KIROCREW_HOME', 'KIRO_HOME', 'XDG_DATA_HOME', 'KIROCREW_KIRO_BIN', 'KIROCREW_SKIP_MODEL_DOWNLOAD',
  'KIROCREW_SKIP_APP_STORE_FETCH', 'PYTHONUNBUFFERED', 'CLAUDE_AGENT_ACP_BIN', 'CLAUDE_CODE_EXECUTABLE', 'KIROCREW_SKIP_FRONTEND',
  'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_REMOTE_SESSION_ID', 'CCR_TEST', 'KIRO_CLAUDE_FORCE_MODEL', 'FAKE_EXTRA',
];

function log(extra = {}) {
  if (!env.FAKE_LOG) return;
  const e = {};
  for (const k of LOGGED_ENV) if (env[k] !== undefined) e[k] = env[k];
  let umask;
  try {
    umask = process.umask();
  } catch {
    umask = undefined;
  }
  fs.appendFileSync(env.FAKE_LOG, JSON.stringify({ tool, args, cwd: process.cwd(), env: e, umask, pid: process.pid, ...extra }) + '\n');
}

function out(s) {
  process.stdout.write(s.endsWith('\n') ? s : s + '\n');
}
function err(s) {
  process.stderr.write(s.endsWith('\n') ? s : s + '\n');
}

function maybeFail() {
  const spec = env.FAKE_FAIL;
  if (!spec) return;
  const joined = args.join(' ');
  for (const part of spec.split(';')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    if (part.slice(0, i) === tool && joined.includes(part.slice(i + 1))) {
      err(`fake failure: ${tool} ${joined}`);
      process.exit(1);
    }
  }
}

function wrapper(file, t) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
  fs.writeFileSync(file, `#!/bin/sh\nFAKE_SELF="$0"; export FAKE_SELF\nexec ${q(process.execPath)} ${q(SELF)} ${t} "$@"\n`, { mode: 0o755 });
}

function copyTree(src, dst) {
  if (!src || !fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    if (name === '.git') continue;
    const s = path.join(src, name);
    const d = path.join(dst, name);
    const st = fs.lstatSync(s);
    if (st.isDirectory()) copyTree(s, d);
    else fs.copyFileSync(s, d), fs.chmodSync(d, st.mode & 0o777);
  }
}

function makeVenv(dir) {
  wrapper(path.join(dir, 'bin', 'python'), 'python');
  wrapper(path.join(dir, 'bin', 'pip'), 'pip');
  wrapper(path.join(dir, 'bin', 'kirocrew'), 'kirocrew');
}

// ───────────────────────────── git ─────────────────────────────
function git() {
  let dir = process.cwd();
  let a = args.slice();
  if (a[0] === '-C') {
    dir = path.resolve(a[1]);
    a = a.slice(2);
  }
  const gitDir = path.join(dir, '.git');
  const headFile = path.join(gitDir, 'FAKE_HEAD');
  const cmd = a[0];
  if (cmd === '--version') return out(`git version ${env.FAKE_GIT_VERSION ?? '2.43.0'}`);
  if (cmd === 'rev-parse' && a[1] === 'HEAD') {
    if (!fs.existsSync(headFile)) {
      err('fatal: not a git repository (or any of the parent directories): .git');
      process.exit(128);
    }
    return out(fs.readFileSync(headFile, 'utf8').trim());
  }
  if (cmd === 'init') {
    fs.mkdirSync(gitDir, { recursive: true });
    return;
  }
  if (cmd === 'remote' && a[1] === 'get-url') {
    const f = path.join(gitDir, 'FAKE_REMOTE');
    if (!fs.existsSync(f)) {
      err(`error: No such remote '${a[2]}'`);
      process.exit(2);
    }
    return out(fs.readFileSync(f, 'utf8'));
  }
  if (cmd === 'remote' && a[1] === 'add') {
    fs.writeFileSync(path.join(gitDir, 'FAKE_REMOTE'), a[3] ?? '');
    return;
  }
  if (cmd === 'sparse-checkout') return;
  if (cmd === 'fetch') {
    const sha = a[a.length - 1];
    fs.writeFileSync(path.join(gitDir, 'FAKE_FETCH_HEAD'), env.FAKE_GIT_FETCH_SHA ?? sha);
    return;
  }
  if (cmd === 'checkout') {
    const target = a[a.length - 1];
    const sha = target === 'FETCH_HEAD' ? fs.readFileSync(path.join(gitDir, 'FAKE_FETCH_HEAD'), 'utf8').trim() : target;
    fs.writeFileSync(headFile, sha + '\n');
    if (target === 'FETCH_HEAD') copyTree(env.FAKE_KC_TEMPLATE, dir);
    return;
  }
  if (cmd === 'status') return out(env.FAKE_GIT_DIRTY ?? '');
  if (cmd === 'submodule') {
    const sub = a[1];
    const p = a[a.length - 1];
    if (sub === 'update') {
      const target = path.join(dir, p);
      fs.mkdirSync(path.join(target, '.git'), { recursive: true });
      fs.writeFileSync(path.join(target, '.git', 'FAKE_HEAD'), (env.FAKE_GIT_FETCH_SHA ?? env.FAKE_PIN ?? '0'.repeat(40)) + '\n');
      copyTree(env.FAKE_KC_TEMPLATE, target);
    }
    return;
  }
  err(`fake git: unsupported ${a.join(' ')}`);
  process.exit(1);
}

// ───────────────────────────── python / pip / npm / make ─────────────────────────────
function python() {
  if (args[0] === '--version') return out(`Python ${env.FAKE_PYTHON_VERSION ?? '3.13.1'}`);
  // KiroCrew's own locked config writer (crew uninstall): emulated, since the real python run
  // here has no kiro_crew package. Only answers from a venv python (as the real one would).
  if (args[0] === '-I' && args[1] === '-c' && (args[2] ?? '').includes('update_config_locked')) {
    if (!/[/\\]\.venv[/\\]bin[/\\]python$/.test(env.FAKE_SELF ?? '')) {
      // not a venv python: fall through to the generic path (a real python has no kiro_crew)
    } else {
      const keys = JSON.parse(args[3] ?? '[]');
      const cfg = readJson(CONFIG, undefined);
      const removed = [];
      if (cfg) {
        for (const key of keys) {
          const parts = key.split('.');
          let d = cfg;
          for (const p of parts.slice(0, -1)) d = d && typeof d === 'object' ? d[p] : undefined;
          if (d && typeof d === 'object' && parts[parts.length - 1] in d) {
            delete d[parts[parts.length - 1]];
            removed.push(key);
          }
        }
        if (removed.length) fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n');
      }
      fs.appendFileSync(path.join(KC_HOME, 'fake-locked-writes.jsonl'), JSON.stringify({ keys, removed }) + '\n');
      return out(JSON.stringify({ removed }));
    }
  }
  if (args[0] === '-I' && args[1] === '-c') {
    const real = env.FAKE_REAL_PYTHON;
    if (!real) {
      err('fake python: FAKE_REAL_PYTHON is not set');
      process.exit(1);
    }
    const r = spawnSync(real, args, { stdio: 'inherit' });
    process.exit(r.status ?? 1);
  }
  if (args[0] === '-m' && args[1] === 'venv') return makeVenv(path.resolve(args[2]));
  if (args[0] === '-m' && args[1] === 'kiro_crew.frontend' && args[2] === 'stage') {
    fs.mkdirSync(path.join(path.resolve(args[3]), 'src', 'kiro_crew', 'static', 'dist'), { recursive: true });
    return;
  }
  err(`fake python: unsupported ${args.join(' ')}`);
  process.exit(1);
}

function npm() {
  if (args[0] === '--version') return out('10.9.0');
  if (args[0] === 'ci') return;
  if (args[0] === 'run' && args[1] === 'build') {
    fs.mkdirSync(path.join(process.cwd(), 'dist'), { recursive: true });
    return;
  }
  if (args[0] === 'i' || args[0] === 'install') {
    const prefix = args[args.indexOf('--prefix') + 1];
    const spec = args.find((x) => x.startsWith('@agentclientprotocol/'));
    const at = spec.lastIndexOf('@');
    const name = spec.slice(0, at);
    const version = spec.slice(at + 1);
    const pkg = path.join(prefix, 'node_modules', ...name.split('/'));
    fs.mkdirSync(path.join(pkg, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name, version }));
    fs.writeFileSync(path.join(pkg, 'dist', 'index.js'), '// fake claude-agent-acp\n');
    // Like real npm: the prefix gets a package.json naming the dependency, and a lockfile.
    fs.writeFileSync(path.join(prefix, 'package.json'), JSON.stringify({ dependencies: { [name]: `^${version}` } }, null, 2) + '\n');
    fs.writeFileSync(path.join(prefix, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3 }) + '\n');
    return;
  }
  err(`fake npm: unsupported ${args.join(' ')}`);
  process.exit(1);
}

function make() {
  const dir = path.resolve(args[args.indexOf('-C') + 1]);
  makeVenv(path.join(dir, '.venv'));
  fs.mkdirSync(path.join(dir, 'src', 'kiro_crew', 'static', 'dist'), { recursive: true });
}

// ───────────────────────────── kirocrew ─────────────────────────────
const KC_HOME = env.KIROCREW_HOME || path.join(env.HOME || '/nonexistent', '.kiro', 'crew');
const CONFIG = path.join(KC_HOME, 'config.json');
const GW_FILE = path.join(KC_HOME, 'fake-gateway.json');
const TOKENS = path.join(KC_HOME, 'fake-tokens.json');
const DEFAULTS = merge(
  { agent: { acp_backend: 'kas', kas_bundle: true, member_acp_backend: 'kas', role_models: {} }, auto_update: true, heartbeat: { default_deliver: 'auto' } },
  env.FAKE_KC_DEFAULTS ? JSON.parse(env.FAKE_KC_DEFAULTS) : {},
);
const KNOWN = new Set(['agent.acp_backend', 'agent.kas_bundle', 'agent.member_acp_backend', 'auto_update', 'heartbeat.default_deliver', 'agent.role_models']);

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}
function merge(a, b) {
  const o = { ...a };
  for (const [k, v] of Object.entries(b)) o[k] = v && typeof v === 'object' && !Array.isArray(v) && o[k] && typeof o[k] === 'object' ? merge(o[k], v) : v;
  return o;
}
function dget(o, key) {
  let cur = o;
  for (const p of key.split('.')) {
    if (!cur || typeof cur !== 'object' || !(p in cur)) return undefined;
    cur = cur[p];
  }
  return cur;
}
function dset(o, key, v) {
  const parts = key.split('.');
  let cur = o;
  for (const p of parts.slice(0, -1)) cur = cur[p] = cur[p] && typeof cur[p] === 'object' ? cur[p] : {};
  cur[parts[parts.length - 1]] = v;
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}
/** `/proc/<pid>/stat` of a running pid: its state and start time (field 22); undefined when gone or without /proc. */
function procStat(pid) {
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const f = s.slice(s.lastIndexOf(')') + 1).trim().split(/\s+/);
    const start = Number(f[19]);
    return { state: f[0], start: Number.isInteger(start) ? start : undefined };
  } catch {
    return undefined;
  }
}
function startOf(pid) {
  return procStat(pid)?.start;
}
/** `rec` ({pid, start?}) still names the process it was written for: alive, not a zombie, same start time. */
function stillThat(rec) {
  if (!rec || !Number.isInteger(rec.pid) || rec.pid <= 0 || !alive(rec.pid)) return false;
  const st = procStat(rec.pid);
  if (st && (st.state === 'Z' || st.state === 'X')) return false;
  return st?.start === rec.start;
}
function gwRecord() {
  const r = readJson(GW_FILE, undefined);
  return stillThat(r) ? r : undefined;
}
/** The gateway's child that keeps its lock (FAKE_LOCK_INHERIT), while it runs. */
function lockInheritor() {
  const ch = readJson(path.join(KC_HOME, 'fake-gateway-child.json'), undefined);
  return ch && ch.lock && stillThat(ch) ? ch : undefined;
}
/** KiroCrew's LockProbeError text (gateway_lock.py) for `cause`. */
function lockProbeReason(cause) {
  return `could not determine whether a gateway holds the lock at ${path.join(KC_HOME, 'gateway.lock')}: ${cause}`;
}
/** Its reason for a held lock whose acquirer is gone (gateway_lock.lock_holder: an inherited fd). */
function inheritedLockReason() {
  const acquirer = readJson(GW_FILE, undefined)?.pid;
  return lockProbeReason(`the lock is held but its recorded acquirer (pid ${acquirer ?? 'unknown'}) is gone`);
}
function pyRepr(v) {
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (v === null) return 'None';
  return String(v);
}

function ensureConfig() {
  if (!fs.existsSync(CONFIG)) {
    fs.mkdirSync(KC_HOME, { recursive: true });
    fs.writeFileSync(CONFIG, JSON.stringify({ meta: { lastTouchedVersion: '0.13.0' } }, null, 2) + '\n');
  }
}

function gateway() {
  const mode = env.FAKE_GATEWAY_MODE ?? 'ok';
  const portArg = args[args.indexOf('--port') + 1];
  fs.mkdirSync(KC_HOME, { recursive: true });
  fs.writeFileSync(path.join(KC_HOME, 'fake-gateway-args.json'), JSON.stringify({ args, cwd: process.cwd() }));
  if (mode === 'fail') {
    err('Traceback (most recent call last):\n  File "gateway.py"\nRuntimeError: fake gateway failure');
    process.exit(1);
  }
  const startChild = (kind) => {
    const onTerm = kind === 'linger' ? '() => process.exit(0)' : '() => undefined';
    const code = `process.on('SIGTERM', ${onTerm}); setInterval(() => undefined, 1000); setTimeout(() => process.exit(0), 60000);`;
    const ch = spawn(process.execPath, ['-e', code], { stdio: 'ignore' });
    fs.writeFileSync(path.join(KC_HOME, 'fake-gateway-child.json'), JSON.stringify({ pid: ch.pid, start: startOf(ch.pid), lock: env.FAKE_LOCK_INHERIT === '1' }));
  };
  if (mode === 'ignore-term') process.on('SIGTERM', () => undefined);
  else process.on('SIGTERM', () => {
    if (env.FAKE_GATEWAY_CHILD === 'late') startChild('stubborn');
    try {
      fs.rmSync(GW_FILE, { force: true });
    } catch {}
    process.exit(0);
  });
  fs.appendFileSync(path.join(KC_HOME, 'gateway.log'), `fake gateway boot pid ${process.pid}\n`);
  if (env.FAKE_GATEWAY_CHILD === 'linger' || env.FAKE_GATEWAY_CHILD === 'stubborn') startChild(env.FAKE_GATEWAY_CHILD);
  err('booting fake gateway');
  if (mode === 'hang') {
    fs.writeFileSync(GW_FILE, JSON.stringify({ pid: process.pid, start: startOf(process.pid), port: 0 }));
    setInterval(() => undefined, 1000);
    return;
  }
  const readyToken = `tok-${process.pid}`;
  const valid = () => new Set([readyToken, ...readJson(TOKENS, [])]);
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const port = server.address().port;
    const cookie = `mc_token_${port}=sess-${process.pid}`;
    const hasCookie = (req.headers.cookie ?? '').split(';').map((s) => s.trim()).includes(cookie);
    const json = (code, body, headers = {}) => {
      res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    fs.appendFileSync(path.join(KC_HOME, 'fake-http.jsonl'), JSON.stringify({ method: req.method, path: u.pathname, cookie: hasCookie, token: u.searchParams.has('token') }) + '\n');
    if (u.pathname === '/api/status' && u.searchParams.has('token')) {
      if (!valid().has(u.searchParams.get('token'))) return json(401, { error: 'invalid token' });
      return json(200, { version: '0.13.0', ok: true }, { 'Set-Cookie': [`${cookie}; Path=/; HttpOnly`, `mc_refresh_${port}=r; Path=/`] });
    }
    if (!hasCookie) return json(401, { error: 'unauthorized' });
    if (u.pathname === '/api/status') return json(200, { version: '0.13.0', ok: true });
    if (u.pathname === '/api/kiro-prerequisite') {
      const authed = env.FAKE_GW_AUTH !== '0';
      return json(200, { installed: true, authenticated: authed, ready: authed, missing_agent_specs: [], rejected_agent_specs: [] });
    }
    if (u.pathname === '/api/acp-backends') return json(200, { backends: [{ id: 'kiro', installed: 'installed' }, { id: 'claude', installed: 'installed' }, { id: 'kas', installed: 'missing' }] });
    json(404, { error: 'not found' });
  });
  server.listen(portArg === 'auto' ? 0 : Number(portArg), '127.0.0.1', () => {
    const port = server.address().port;
    fs.writeFileSync(GW_FILE, JSON.stringify({ pid: process.pid, start: startOf(process.pid), port }));
    out('Kiro Crew gateway starting');
    out(`KIROCREW_READY:${JSON.stringify({ port, token: readyToken, pid: process.pid, home: KC_HOME })}`);
  });
}

function kirocrew() {
  const verb = args[0];
  if (verb === '--version') return out(`kirocrew ${env.FAKE_KC_VERSION ?? '0.13.0'} (source checkout, not a release build)`);
  if (verb === 'config') {
    ensureConfig();
    const stored = readJson(CONFIG, {});
    if (args[1] === 'get') {
      const eff = merge(DEFAULTS, stored);
      if (!args[2]) return out(JSON.stringify(eff, null, 2));
      const v = dget(eff, args[2]);
      if (v === undefined) {
        err(`❌ Unknown key: ${args[2]}`);
        process.exit(1);
      }
      return out(typeof v === 'object' ? JSON.stringify(v, null, 2) : pyRepr(v));
    }
    if (args[1] === 'set') {
      if (args.includes('--file')) {
        err('fake kirocrew: config set --file must never be used');
        process.exit(99);
      }
      const key = args[2];
      const raw = args[3];
      if (!KNOWN.has(key)) {
        err(`❌ Unknown key: ${key}`);
        process.exit(1);
      }
      let v;
      try {
        v = JSON.parse(raw);
      } catch {
        v = raw;
      }
      dset(stored, key, v);
      fs.writeFileSync(CONFIG, JSON.stringify(stored, null, 2) + '\n');
      return out(`✅ ${key} = ${JSON.stringify(v)}`);
    }
  }
  if (verb === 'gateway-pid') {
    const r = gwRecord();
    const held = fs.existsSync(path.join(KC_HOME, 'fake-held'));
    // KiroCrew's `held`: the lock is positively held but nothing names its holder (cli_server_stop.py).
    if ((r || lockInheritor()) && held) return out(JSON.stringify({ holder: 'held', reason: lockProbeReason('the lock is held but no live holder pid can be established') }));
    if (!r && lockInheritor()) {
      out(JSON.stringify({ holder: 'indeterminate', reason: inheritedLockReason() }));
      process.exit(2);
    }
    return out(JSON.stringify(r ? { holder: 'process', pid: r.pid, alive: true, source: 'lock' } : { holder: 'nobody' }));
  }
  if (verb === 'gateway') return gateway();
  if (verb === 'stop') {
    if (env.FAKE_STOP_IGNORE === '1' && gwRecord()) return out('(fake) ignoring stop');
    const r = gwRecord(); // the recorded pid, checked again right before the signal
    if (!r) {
      if (lockInheritor()) {
        out(`❌ ${inheritedLockReason()}. Not signalling anything; check the file and retry.`);
        process.exit(1);
      }
      return out('No Kiro Crew gateway currently running on port 5476.');
    }
    process.kill(r.pid, 'SIGTERM');
    return out(`✅ Sent SIGTERM to gateway (pid ${r.pid}).`);
  }
  if (verb === 'token') {
    const r = gwRecord();
    if (!r) {
      err('❌ Gateway not running — start it with: kirocrew gateway');
      process.exit(1);
    }
    const port = args[args.indexOf('--port') + 1];
    const tok = `minted-${Date.now()}-${process.pid}`;
    const list = readJson(TOKENS, []);
    list.push(tok);
    fs.writeFileSync(TOKENS, JSON.stringify(list));
    return out(`http://localhost:${port}?token=${tok}`);
  }
  if (verb === 'doctor') {
    // Shape of the real output (verified against KiroCrew 0.13.0): `kiro-cli:` appears twice.
    out(env.FAKE_KC_DOCTOR_OUTPUT ?? 'Kiro Crew doctor\n  kiro-cli:    ✅ /x/bin/kiro-claude\n  claude-acp:  ✅ resolved off PATH 0.101.0 (Claude Code installed)\n  kiro auth:   ✅ kiro-cli\'s own sign-in\n  session bus: ❌ no user session bus\n  kiro-cli:    ✅ kiro-claude 0.1.0 (kiro-cli 1.26.0)\n❌ Fix these issues: kiro-cli is too old for its v3 (KAS) engine');
    process.exit(1);
  }
  out(`fake kirocrew ${args.join(' ')}`);
  out(`KIROCREW_KIRO_BIN=${env.KIROCREW_KIRO_BIN ?? ''}`);
  out(`cwd=${process.cwd()}`);
  process.exit(Number(env.FAKE_KC_EXIT ?? 0));
}

log();
maybeFail();
switch (tool) {
  case 'git':
    git();
    break;
  case 'python':
    python();
    break;
  case 'pip':
    break;
  case 'npm':
    npm();
    break;
  case 'make':
    make();
    break;
  case 'kirocrew':
    kirocrew();
    break;
  case 'node':
    if (args[0] === '--version') out(env.FAKE_NODE_VERSION ?? 'v22.23.4');
    break;
  case 'open':
    process.exit(Number(env.FAKE_OPEN_EXIT ?? 0));
    break;
  default:
    err(`fake-tool: unknown tool ${tool}`);
    process.exit(1);
}

/**
 * `kiro-claude crew setup` against fake git/python/npm/make/kirocrew executables on a temp PATH
 * with a temp HOME (08 §3.3). Asserts the command sequence, the keyed config writes, the
 * identity-stub rules (09 item 1), idempotency, and the failure/usage paths.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { renderShim } from '../../src/crew/shim.js';
import { KIROCREW_PIN } from '../../src/crew/pin.js';
import { readState } from '../../src/crew/state.js';
import { STUB_SENTINEL_KEY } from '../../src/crew/identity.js';
import { crew, FAKE_CLAUDE, FAKE_ENTRY, makeFakeEnv, realPython, type Call, type FakeEnv } from './helpers.js';

const PY = realPython();
const PIN = KIROCREW_PIN.commit;

function rel(fe: FakeEnv, c: Call): string {
  const bin = path.basename(c.tool === 'python' || c.tool === 'pip' || c.tool === 'kirocrew' ? c.tool : c.tool);
  return [bin, ...c.args].join(' ').split(fe.root).join('$T');
}

function signIn(fe: FakeEnv): void {
  fs.writeFileSync(path.join(fe.home, '.fake-claude-login'), '');
}

function storePath(fe: FakeEnv): string {
  return path.join(fe.home, '.local', 'share', 'kiro-cli', 'data.sqlite3');
}

async function freshSetup(fe: FakeEnv, extra: string[] = []): Promise<{ code: number; stdout: string; stderr: string; dir: string }> {
  signIn(fe);
  const dir = path.join(fe.root, 'KiroCrew');
  const r = await crew(fe, ['setup', '--dir', dir, '--allow-tmp', ...extra]);
  return { ...r, dir };
}

describe('crew setup (08 §3.3)', { skip: PY ? false : 'no python3 with sqlite3' }, () => {
  it('fresh setup: fetch by SHA, light build, shim, members, keyed config, identity stub, crew.json, doctor', async () => {
    const fe = makeFakeEnv();
    try {
      const r = await freshSetup(fe);
      assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
      const dir = r.dir;
      const cs = fe.cs;

      // Fetch (no superproject: init/remote/fetch/checkout by SHA, then verify).
      const git = fe.callsOf('git').map((c) => rel(fe, c));
      const fetchSeq = git.filter((g) => !g.includes('status') && !g.endsWith('--version'));
      assert.deepEqual(fetchSeq.slice(0, 5), [
        'git -C $T/KiroCrew init -q',
        `git -C $T/KiroCrew remote add origin ${KIROCREW_PIN.url}`,
        `git -C $T/KiroCrew fetch --depth 1 origin ${PIN}`,
        'git -C $T/KiroCrew checkout -q --detach FETCH_HEAD',
        'git -C $T/KiroCrew rev-parse HEAD',
      ]);
      assert.ok(!git.some((g) => g.includes('--filter')), 'no blob filter without --slim');

      // Build (light) — order, cwd, caches, umask 022, KIROCREW_SKIP_FRONTEND on the -e install.
      const buildCalls = fe.calls().filter((c) => ['npm', 'python', 'pip', 'make'].includes(c.tool) && !c.args.includes('--version') && !(c.args[0] === '-I'));
      const seq = buildCalls.map((c) => `${c.tool} ${c.args.join(' ')}`.split(fe.root).join('$T'));
      assert.deepEqual(seq, [
        'npm ci --no-audit --no-fund --cache $T/h/.local/share/kiro-claude/crew/cache/npm',
        'npm run build',
        'python -m venv $T/KiroCrew/.venv',
        'pip install --cache-dir $T/h/.local/share/kiro-claude/crew/cache/pip --upgrade pip setuptools wheel',
        'pip install --cache-dir $T/h/.local/share/kiro-claude/crew/cache/pip --prefer-binary -e $T/KiroCrew',
        'python -m kiro_crew.frontend stage $T/KiroCrew',
        'npm i --prefix $T/h/.local/share/kiro-claude/crew/node @agentclientprotocol/claude-agent-acp@0.101.0 --omit=optional --no-audit --no-fund',
      ]);
      assert.equal(buildCalls[0]!.cwd, path.join(dir, 'website'));
      assert.equal(buildCalls[1]!.cwd, path.join(dir, 'website'));
      for (const c of buildCalls.slice(0, 6)) assert.equal(c.umask, 0o022, `umask for ${c.args.join(' ')}`);
      assert.equal(buildCalls[4]!.env.KIROCREW_SKIP_FRONTEND, '1');
      assert.equal(buildCalls[3]!.env.KIROCREW_SKIP_FRONTEND, undefined);
      assert.equal(fs.existsSync(path.join(cs, 'cache')), false, 'build caches deleted after a successful build');
      assert.ok(!fe.calls().some((c) => c.args.some((a) => /ensure-(node|python)\.sh|minimal_install/.test(a))), 'never runs ensure-*.sh / minimal_install.sh');

      // Config: keyed `config set` only (decided against config.json itself, so no `config get`
      // first), all with the gateway env.
      const kc = fe.callsOf('kirocrew').filter((c) => c.args[0] === 'config');
      const cfgSeq = kc.map((c) => c.args.join(' '));
      const firstSet = cfgSeq.findIndex((s) => s.startsWith('config set'));
      assert.equal(firstSet, 0, 'the first config call is a set');
      assert.deepEqual(cfgSeq.slice(firstSet, firstSet + 4), [
        'config set agent.acp_backend kiro',
        'config set agent.kas_bundle false',
        'config set agent.member_acp_backend claude',
        'config set auto_update false',
      ]);
      assert.ok(!cfgSeq.some((s) => s.includes('--file')), 'never config set --file');
      for (const c of kc) {
        assert.equal(c.env.KIROCREW_KIRO_BIN, path.join(cs, 'bin', 'kiro-claude'));
        assert.equal(c.env.CLAUDE_CODE_EXECUTABLE, FAKE_CLAUDE());
        assert.equal(c.env.CLAUDE_AGENT_ACP_BIN, path.join(cs, 'node', 'node_modules', '@agentclientprotocol', 'claude-agent-acp', 'dist', 'index.js'));
        assert.equal(c.env.PYTHONUNBUFFERED, '1');
        assert.equal(c.env.KIROCREW_SKIP_MODEL_DOWNLOAD, '1');
        assert.equal(c.env.KIROCREW_SKIP_APP_STORE_FETCH, '1');
        assert.equal(c.cwd, dir);
      }
      const config = JSON.parse(fs.readFileSync(path.join(fe.home, '.kiro', 'crew', 'config.json'), 'utf8'));
      assert.deepEqual({ a: config.agent.acp_backend, k: config.agent.kas_bundle, m: config.agent.member_acp_backend, u: config.auto_update }, { a: 'kiro', k: false, m: 'claude', u: false });

      // Shim: byte-exact, 0755, not named kiro-cli.
      const shim = path.join(cs, 'bin', 'kiro-claude');
      assert.equal(fs.readFileSync(shim, 'utf8'), renderShim({ node: process.execPath, entry: FAKE_ENTRY(), claude: FAKE_CLAUDE() }));
      assert.equal(fs.statSync(shim).mode & 0o777, 0o755);

      // Identity stub.
      assert.equal(fs.existsSync(storePath(fe)), true);
      assert.ok(fs.readFileSync(storePath(fe)).includes(Buffer.from(STUB_SENTINEL_KEY)));
      assert.match(r.stdout, /wrote a token-less kiro-cli identity stub \(no credentials\)/);

      // crew.json.
      const st = readState(path.join(cs, 'crew.json'))!;
      assert.equal(fs.statSync(path.join(cs, 'crew.json')).mode & 0o777, 0o600);
      assert.deepEqual(
        { dir: st.kirocrew.dir, commit: st.kirocrew.commit, build: st.kirocrew.build, url: st.kirocrew.url, shim: st.shim, node: st.node, entry: st.entry, claude: st.claude, members: st.members.backend, port: st.port, stub: st.identityStub.created },
        { dir, commit: PIN, build: 'light', url: KIROCREW_PIN.url, shim, node: process.execPath, entry: FAKE_ENTRY(), claude: FAKE_CLAUDE(), members: 'claude', port: 5476, stub: true },
      );
      assert.deepEqual(st.previousConfig, { 'agent.acp_backend': null, 'agent.kas_bundle': null, 'agent.member_acp_backend': null, auto_update: null });
      assert.deepEqual(st.env, { KIROCREW_SKIP_MODEL_DOWNLOAD: '1', KIROCREW_SKIP_APP_STORE_FETCH: '1' });
      assert.ok(!fs.readFileSync(path.join(cs, 'crew.json'), 'utf8').includes('tok-'), 'no secrets in crew.json');

      // Doctor ran (no gateway) and passed; next step printed.
      assert.match(r.stdout, /✅ kiro-cli probe contract: --version, acp --help, chat --help, whoami --format json, chat --list-models, update, acp --agent-engine v3/);
      assert.match(r.stdout, /⏭ gateway: skipped \(--no-gateway\)/);
      assert.match(r.stdout, /Kiro Crew is ready\. Next: kiro-claude crew start/);
    } finally {
      fe.cleanup();
    }
  });

  it('is idempotent: a re-run fetches, builds, installs, sets and writes nothing', async () => {
    const fe = makeFakeEnv();
    try {
      const first = await freshSetup(fe);
      assert.equal(first.code, 0, first.stderr);
      const shim = path.join(fe.cs, 'bin', 'kiro-claude');
      const shimSt = fs.statSync(shim);
      const storeSt = fs.statSync(storePath(fe));
      const storeBytes = fs.readFileSync(storePath(fe));
      const n = fe.calls().length;
      const second = await crew(fe, ['setup', '--dir', first.dir, '--allow-tmp']);
      assert.equal(second.code, 0, second.stderr);
      const later = fe.calls().slice(n);
      const mutating = later.filter(
        (c) =>
          (c.tool === 'git' && ['init', 'fetch', 'checkout', 'remote', 'submodule'].some((v) => c.args.includes(v))) ||
          (c.tool === 'npm' && !c.args.includes('--version')) ||
          c.tool === 'pip' ||
          c.tool === 'make' ||
          (c.tool === 'python' && c.args[0] === '-m') ||
          (c.tool === 'kirocrew' && c.args[0] === 'config' && c.args[1] === 'set'),
      );
      assert.deepEqual(mutating.map((c) => `${c.tool} ${c.args.join(' ')}`), []);
      assert.match(second.stdout, /fetch: .* is already at 665a0e4/);
      assert.match(second.stdout, /build: already built \(kirocrew 0\.13\.0/);
      assert.match(second.stdout, /shim: .*\(unchanged\)/);
      assert.match(second.stdout, /members: claude-agent-acp already installed/);
      assert.match(second.stdout, /config: already set/);
      assert.match(second.stdout, /identity: kiro-claude identity stub already present/);
      assert.equal(fs.statSync(shim).mtimeMs, shimSt.mtimeMs);
      assert.equal(fs.statSync(shim).ino, shimSt.ino);
      assert.equal(fs.statSync(storePath(fe)).mtimeMs, storeSt.mtimeMs);
      assert.ok(fs.readFileSync(storePath(fe)).equals(storeBytes));
      // A third run without --dir keeps the directory chosen first.
      const third = await crew(fe, ['setup', '--allow-tmp']);
      assert.equal(third.code, 0, third.stderr);
      assert.equal(readState(path.join(fe.cs, 'crew.json'))!.kirocrew.dir, first.dir);
    } finally {
      fe.cleanup();
    }
  });

  it('never touches an existing kiro-cli identity store (09 item 1)', async () => {
    const fe = makeFakeEnv();
    try {
      fs.mkdirSync(path.dirname(storePath(fe)), { recursive: true });
      fs.writeFileSync(storePath(fe), 'REAL KIRO-CLI STORE');
      const before = fs.statSync(storePath(fe));
      const r = await freshSetup(fe);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(fs.readFileSync(storePath(fe), 'utf8'), 'REAL KIRO-CLI STORE');
      assert.equal(fs.statSync(storePath(fe)).mtimeMs, before.mtimeMs);
      assert.match(r.stdout, /a kiro-cli identity store already exists at .*; left untouched/);
      assert.equal(readState(path.join(fe.cs, 'crew.json'))!.identityStub.created, false);
      assert.match(r.stdout, /✅ kiro-cli identity: kiro-cli identity store at .* \(not ours; left untouched\)/);
      // unstub refuses to delete it.
      const u = await crew(fe, ['unstub']);
      assert.equal(u.code, 1);
      assert.match(u.stderr, /is not kiro-claude's identity stub/);
      assert.equal(fs.readFileSync(storePath(fe), 'utf8'), 'REAL KIRO-CLI STORE');
    } finally {
      fe.cleanup();
    }
  });

  it('--no-identity-stub writes no store; doctor warns instead of failing; unstub removes only ours', async () => {
    const fe = makeFakeEnv();
    try {
      const r = await freshSetup(fe, ['--no-identity-stub']);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(fs.existsSync(storePath(fe)), false);
      assert.match(r.stdout, /identity: skipped \(--no-identity-stub\)/);
      assert.match(r.stdout, /⚠ kiro-cli identity: no kiro-cli identity store .*\(setup ran with --no-identity-stub\)/);
      assert.equal(readState(path.join(fe.cs, 'crew.json'))!.identityStub.optOut, true);

      // Now with the stub, then remove it through both spellings.
      const again = await crew(fe, ['setup', '--allow-tmp']);
      assert.equal(again.code, 0, again.stderr);
      assert.equal(fs.existsSync(storePath(fe)), true);
      let u = await crew(fe, ['unstub']);
      assert.equal(u.code, 0, u.stderr);
      assert.match(u.stdout, /Removed the kiro-claude identity stub/);
      assert.equal(fs.existsSync(storePath(fe)), false);
      assert.equal(fs.existsSync(path.dirname(storePath(fe))), false, 'we created the kiro-cli dir, so it goes too');
      assert.equal(readState(path.join(fe.cs, 'crew.json'))!.identityStub.created, false);
      u = await crew(fe, ['unstub']);
      assert.equal(u.code, 0);
      assert.match(u.stdout, /nothing to remove/);
      await crew(fe, ['setup', '--allow-tmp']);
      u = await crew(fe, ['setup', '--remove-identity-stub']);
      assert.equal(u.code, 0, u.stderr);
      assert.equal(fs.existsSync(storePath(fe)), false);
    } finally {
      fe.cleanup();
    }
  });

  it('--members none / --no-claude-acp: no adapter, no member key; doctor warns about Bots', async () => {
    for (const flag of [['--members', 'none'], ['--no-claude-acp']]) {
      const fe = makeFakeEnv();
      try {
        const r = await freshSetup(fe, flag);
        assert.equal(r.code, 0, r.stderr);
        assert.ok(!fe.callsOf('npm').some((c) => c.args[0] === 'i'), 'no npm i');
        assert.ok(!fe.callsOf('kirocrew').some((c) => c.args.includes('agent.member_acp_backend')));
        assert.ok(!fe.callsOf('kirocrew').some((c) => c.env.CLAUDE_AGENT_ACP_BIN));
        assert.match(r.stdout, /members: skipped \(--members none\)/);
        assert.match(r.stdout, /⚠ members \(Bots\): Bots are unavailable/);
        assert.equal(readState(path.join(fe.cs, 'crew.json'))!.members.backend, 'none');
      } finally {
        fe.cleanup();
      }
    }
  });

  it('in a kiro-claude git checkout: git submodule update --init --depth 1 vendor/KiroCrew', async () => {
    const fe = makeFakeEnv();
    try {
      signIn(fe);
      const root = path.join(fe.root, 'kiro-claude');
      fs.mkdirSync(path.join(root, '.git'), { recursive: true });
      fs.writeFileSync(path.join(root, '.gitmodules'), '[submodule "vendor/KiroCrew"]\n\tpath = vendor/KiroCrew\n\turl = https://github.com/kirodotdev/KiroCrew.git\n\tshallow = true\n\tignore = dirty\n');
      const r = await crew(fe, ['setup', '--allow-tmp'], { deps: { packageRoot: root } });
      assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
      const git = fe.callsOf('git').map((c) => rel(fe, c)).filter((g) => /submodule|init|fetch|checkout/.test(g));
      assert.deepEqual(git, ['git -C $T/kiro-claude submodule update --init --depth 1 vendor/KiroCrew']);
      const st = readState(path.join(fe.cs, 'crew.json'))!;
      assert.equal(st.kirocrew.dir, path.join(root, 'vendor', 'KiroCrew'));
      assert.equal(st.kirocrew.source, 'submodule');
    } finally {
      fe.cleanup();
    }
  });

  it('--slim in a checkout: submodule init, sparse checkout, blob-filtered SHA fetch, absorbgitdirs (V2)', async () => {
    const fe = makeFakeEnv();
    try {
      signIn(fe);
      const root = path.join(fe.root, 'kiro-claude');
      fs.mkdirSync(path.join(root, '.git'), { recursive: true });
      fs.writeFileSync(path.join(root, '.gitmodules'), '[submodule "vendor/KiroCrew"]\n\tpath = vendor/KiroCrew\n');
      const r = await crew(fe, ['setup', '--slim', '--allow-tmp', '--no-build', '--members', 'none'], { deps: { packageRoot: root } });
      assert.equal(r.code, 1, 'not built → doctor reports problems');
      const git = fe.callsOf('git').map((c) => rel(fe, c)).filter((g) => /submodule|init|remote|sparse|fetch|checkout/.test(g));
      assert.deepEqual(git, [
        'git -C $T/kiro-claude submodule init vendor/KiroCrew',
        'git -C $T/kiro-claude/vendor/KiroCrew init -q',
        `git -C $T/kiro-claude/vendor/KiroCrew remote add origin ${KIROCREW_PIN.url}`,
        "git -C $T/kiro-claude/vendor/KiroCrew sparse-checkout set --no-cone /* !/temp-screenshots/",
        `git -C $T/kiro-claude/vendor/KiroCrew fetch --depth 1 --filter=blob:none origin ${PIN}`,
        'git -C $T/kiro-claude/vendor/KiroCrew checkout -q --detach FETCH_HEAD',
        'git -C $T/kiro-claude submodule absorbgitdirs vendor/KiroCrew',
      ]);
      assert.match(r.stdout, /build: skipped \(--no-build\); the checkout does not look built/);
      assert.match(r.stdout, /❌ build: not built/);
    } finally {
      fe.cleanup();
    }
  });

  it('--full runs make -C <dir> build PY=<python>', async () => {
    const fe = makeFakeEnv();
    try {
      const r = await freshSetup(fe, ['--full']);
      assert.equal(r.code, 0, r.stderr);
      const make = fe.callsOf('make');
      assert.equal(make.length, 1);
      assert.deepEqual(make[0]!.args, ['-C', r.dir, 'build', `PY=${path.join(fe.bin, 'python3')}`]);
      assert.equal(make[0]!.umask, 0o022);
      assert.ok(!fe.callsOf('npm').some((c) => c.args[0] === 'ci'));
      assert.equal(readState(path.join(fe.cs, 'crew.json'))!.kirocrew.build, 'full');
      // Later light re-run keeps "full".
      const again = await crew(fe, ['setup', '--allow-tmp']);
      assert.equal(again.code, 0, again.stderr);
      assert.equal(readState(path.join(fe.cs, 'crew.json'))!.kirocrew.build, 'full');
    } finally {
      fe.cleanup();
    }
  });

  it('--no-fetch --no-build uses a prepared checkout as it is', async () => {
    const fe = makeFakeEnv();
    try {
      signIn(fe);
      const dir = fe.makeCheckout(path.join(fe.root, 'kc'), { built: true });
      const r = await crew(fe, ['setup', '--dir', dir, '--no-fetch', '--no-build', '--allow-tmp', '--port', '6001']);
      assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
      assert.ok(!fe.callsOf('git').some((c) => ['init', 'fetch', 'submodule'].some((v) => c.args.includes(v))));
      assert.match(r.stdout, /fetch: skipped \(--no-fetch\)/);
      assert.match(r.stdout, /build: skipped \(--no-build\)\n/);
      assert.equal(readState(path.join(fe.cs, 'crew.json'))!.port, 6001);
    } finally {
      fe.cleanup();
    }
  });

  it('records previousConfig from config.json once (first setup only)', async () => {
    const fe = makeFakeEnv();
    try {
      const cfg = path.join(fe.home, '.kiro', 'crew', 'config.json');
      fs.mkdirSync(path.dirname(cfg), { recursive: true });
      fs.writeFileSync(cfg, JSON.stringify({ agent: { acp_backend: 'claude', other: 1 }, auto_update: true }));
      const r = await freshSetup(fe);
      assert.equal(r.code, 0, r.stderr);
      const st = readState(path.join(fe.cs, 'crew.json'))!;
      assert.deepEqual(st.previousConfig, { 'agent.acp_backend': 'claude', 'agent.kas_bundle': null, 'agent.member_acp_backend': null, auto_update: true });
      const after = JSON.parse(fs.readFileSync(cfg, 'utf8'));
      assert.equal(after.agent.other, 1, 'other keys kept (no --file replace)');
      await crew(fe, ['setup', '--allow-tmp']);
      assert.deepEqual(readState(path.join(fe.cs, 'crew.json'))!.previousConfig, st.previousConfig);
    } finally {
      fe.cleanup();
    }
  });

  it('fails clearly when the fetch lands on another commit', async () => {
    const fe = makeFakeEnv({ extraEnv: { FAKE_GIT_FETCH_SHA: 'abcdef0123456789abcdef0123456789abcdef01' } });
    try {
      const r = await freshSetup(fe);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /❌ fetch: KiroCrew checkout is at abcdef0, expected 665a0e4/);
    } finally {
      fe.cleanup();
    }
  });

  it('never moves a user checkout that is at another commit', async () => {
    const fe = makeFakeEnv();
    try {
      signIn(fe);
      const dir = fe.makeCheckout(path.join(fe.root, 'kc'), { head: '1ece9833'.padEnd(40, '0') });
      const r = await crew(fe, ['setup', '--dir', dir, '--allow-tmp']);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /KiroCrew checkout is at 1ece983, expected 665a0e4 .*--no-fetch/);
      assert.ok(!fe.callsOf('git').some((c) => c.args.includes('fetch') || c.args.includes('checkout')));
    } finally {
      fe.cleanup();
    }
  });

  it('a failing build step names the step and the command, and shows its output', async () => {
    const fe = makeFakeEnv({ extraEnv: { FAKE_FAIL: 'npm:run build' } });
    try {
      const r = await freshSetup(fe);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /❌ build: command failed \(exit 1\)/);
      assert.match(r.stderr, /command: \S*npm run build/);
      assert.match(r.stderr, /fake failure: npm run build/);
      assert.match(r.stderr, /full log: .*run\/setup\.log/);
      assert.ok(fs.readFileSync(path.join(fe.cs, 'run', 'setup.log'), 'utf8').includes('fake failure'));
    } finally {
      fe.cleanup();
    }
  });

  it('a failing config set fails the config step; previousConfig is already saved', async () => {
    const fe = makeFakeEnv({ extraEnv: { FAKE_FAIL: 'kirocrew:config set agent.kas_bundle' } });
    try {
      const cfg = path.join(fe.home, '.kiro', 'crew', 'config.json');
      fs.mkdirSync(path.dirname(cfg), { recursive: true });
      fs.writeFileSync(cfg, JSON.stringify({ auto_update: true }));
      const r = await freshSetup(fe);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /❌ config: kirocrew config set agent.kas_bundle failed \(exit 1\)/);
      assert.equal(readState(path.join(fe.cs, 'crew.json'))!.previousConfig.auto_update, true);
      const again = await crew(fe, ['setup', '--allow-tmp'], { env: { FAKE_FAIL: '' } });
      assert.equal(again.code, 0, again.stderr);
      assert.equal(readState(path.join(fe.cs, 'crew.json'))!.previousConfig['agent.acp_backend'], null, 'not overwritten by our own value');
    } finally {
      fe.cleanup();
    }
  });

  it('preflight failures stop setup before anything is fetched', async () => {
    const cases: Array<{ name: string; env?: NodeJS.ProcessEnv; deps?: object; args?: string[]; re: RegExp }> = [
      { name: 'old python', env: { FAKE_PYTHON_VERSION: '3.11.9' }, re: /Python 3\.12 or newer is required.*3\.11\.9/ },
      { name: 'old git', env: { FAKE_GIT_VERSION: '2.30.1' }, re: /git 2\.36\.0 or newer is required \(found 2\.30\.1/ },
      { name: 'old node', env: { FAKE_NODE_VERSION: 'v20.11.0' }, deps: { nodePath: '__FAKE_NODE__' }, re: /Node\.js 22\.12\.0 or newer is required to build Kiro Crew \(found v20\.11\.0/ },
      { name: 'disk', deps: { sys: '__LOW_DISK__' }, re: /not enough free disk at .*: 1\.0 GB free, about 3\.0 GB needed/ },
      { name: 'claude', deps: { findClaude: async () => { throw new Error('Claude Code CLI (claude) was not found'); } }, re: /Claude Code was not found/ },
      { name: 'explicit python', env: { KIRO_CLAUDE_CREW_PYTHON: '/nope/python' }, re: /KIRO_CLAUDE_CREW_PYTHON \(\/nope\/python\) is not an executable/ },
    ];
    for (const tc of cases) {
      const fe = makeFakeEnv({ extraEnv: tc.env });
      try {
        signIn(fe);
        const deps: Record<string, unknown> = { ...(tc.deps ?? {}) };
        if (deps.nodePath === '__FAKE_NODE__') deps.nodePath = path.join(fe.bin, 'node');
        if (deps.sys === '__LOW_DISK__') {
          const { defaultSys } = await import('../../src/crew/runner.js');
          deps.sys = { ...defaultSys, freeBytes: () => 1024 ** 3 };
        }
        const r = await crew(fe, ['setup', '--dir', path.join(fe.root, 'KiroCrew'), '--allow-tmp', ...(tc.args ?? [])], { deps });
        assert.equal(r.code, 1, tc.name);
        assert.match(r.stderr, tc.re, tc.name);
        assert.ok(!fe.callsOf('git').some((c) => c.args.includes('fetch')), `${tc.name}: nothing fetched`);
      } finally {
        fe.cleanup();
      }
    }
  });

  it('path guards: temp dir without --allow-tmp, linked worktree, $CS inside a probe-hidden dir', async () => {
    const fe = makeFakeEnv();
    try {
      signIn(fe);
      let r = await crew(fe, ['setup', '--dir', path.join(fe.root, 'KiroCrew')]);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /is under the system temp directory .*--allow-tmp/);
      const wt = path.join(fe.root, 'wt');
      fs.mkdirSync(wt);
      fs.writeFileSync(path.join(wt, '.git'), 'gitdir: /repo/.git/worktrees/wt\n');
      r = await crew(fe, ['setup', '--dir', path.join(wt, 'vendor', 'KiroCrew'), '--allow-tmp']);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /inside a linked git worktree/);
      r = await crew(fe, ['setup', '--dir', path.join(fe.root, 'KiroCrew'), '--allow-tmp'], { env: { KIRO_CLAUDE_CREW_HOME: path.join(fe.home, '.kiro', 'crew', 'kc') } });
      assert.equal(r.code, 1);
      assert.match(r.stderr, /which Kiro Crew hides from its kiro-cli probes/);
      assert.equal(fe.calls().filter((c) => c.tool === 'git' && c.args.includes('fetch')).length, 0);
    } finally {
      fe.cleanup();
    }
  });

  it('a signed-out Claude Code is a warning, not a failure', async () => {
    const fe = makeFakeEnv();
    try {
      signIn(fe);
      const r = await crew(fe, ['setup', '--dir', path.join(fe.root, 'KiroCrew'), '--allow-tmp'], { deps: { claudeAuth: async () => ({ loggedIn: false }) } });
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /⚠ preflight: Claude Code is not signed in/);
    } finally {
      fe.cleanup();
    }
  });

  it('--claude-bin is baked into the shim; the default discovery (KIRO_CLAUDE_BIN) works too', async () => {
    const fe = makeFakeEnv();
    try {
      signIn(fe);
      const alt = path.join(fe.root, 'my claude.mjs');
      fs.copyFileSync(FAKE_CLAUDE(), alt);
      fs.chmodSync(alt, 0o755);
      const { defaultDeps } = await import('../../src/crew/context.js');
      const real = defaultDeps();
      const r = await crew(fe, ['setup', '--dir', path.join(fe.root, 'KiroCrew'), '--allow-tmp', '--claude-bin', alt], {
        deps: { findClaude: real.findClaude, claudeAuth: real.claudeAuth },
      });
      assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
      assert.ok(fs.readFileSync(path.join(fe.cs, 'bin', 'kiro-claude'), 'utf8').includes(`KIRO_CLAUDE_BIN="\${KIRO_CLAUDE_BIN:-${alt}}"`));
      assert.match(r.stdout, /Claude Code 2\.1\.318/);
      // Discovery through $KIRO_CLAUDE_BIN when there is no flag and no earlier choice.
      fs.rmSync(path.join(fe.cs, 'crew.json'));
      const r2 = await crew(fe, ['setup', '--allow-tmp', '--dir', path.join(fe.root, 'KiroCrew')], {
        deps: { findClaude: real.findClaude, claudeAuth: real.claudeAuth },
        env: { KIRO_CLAUDE_BIN: FAKE_CLAUDE() },
      });
      assert.equal(r2.code, 0, r2.stderr);
      assert.equal(readState(path.join(fe.cs, 'crew.json'))!.claude, FAKE_CLAUDE());
    } finally {
      fe.cleanup();
    }
  });

  it('asks before downloading/building on a terminal unless --yes; warns about a relocated XDG_DATA_HOME', async () => {
    const { Readable, PassThrough } = await import('node:stream');
    const { makeCtx, testDeps } = await import('./helpers.js');
    const { createCrewCommand } = await import('../../src/crew/cli.js');
    const fe = makeFakeEnv();
    try {
      signIn(fe);
      const run = async (answer: string, extra: string[] = [], env: NodeJS.ProcessEnv = {}) => {
        const cap = makeCtx({ ...fe.env, ...env }, fe.home);
        const stdin = Object.assign(Readable.from([answer]), { isTTY: true }) as unknown as NodeJS.ReadStream;
        const out = new PassThrough();
        let text = '';
        out.on('data', (b: Buffer) => (text += b.toString()));
        Object.assign(out, { isTTY: true });
        const ctx = { ...cap.ctx, stdin, stdout: out as unknown as NodeJS.WriteStream };
        const code = await createCrewCommand(testDeps(fe))(['setup', '--dir', path.join(fe.root, 'KiroCrew'), '--allow-tmp', ...extra], ctx);
        return { code, stdout: text, stderr: cap.stderr() };
      };
      let r = await run('n\n');
      assert.equal(r.code, 1);
      assert.match(r.stdout, /This will download and build Kiro Crew in .* \(about 2\.9 GB on disk\)\. Continue\? \[y\/N\] /);
      assert.match(r.stderr, /Setup cancelled\./);
      assert.equal(fe.callsOf('git').filter((c) => c.args.includes('fetch')).length, 0);
      r = await run('', ['--yes'], { XDG_DATA_HOME: path.join(fe.root, 'xdg') });
      assert.equal(r.code, 0, r.stderr);
      assert.doesNotMatch(r.stdout, /Continue\?/);
      assert.match(r.stdout, /⚠ env: XDG_DATA_HOME .* is removed from the Kiro Crew gateway environment/);
    } finally {
      fe.cleanup();
    }
  });

  it('usage errors exit 2', async () => {
    const fe = makeFakeEnv();
    try {
      for (const args of [
        ['setup', '--full', '--no-build'],
        ['setup', '--bogus'],
        ['setup', '--members', 'kas'],
        ['setup', '--port', 'abc'],
        ['setup', '--port'],
        ['setup', 'extra'],
        ['setup', '--no-claude-acp', '--members', 'claude'],
        ['nope'],
        [],
      ]) {
        const r = await crew(fe, args);
        assert.equal(r.code, 2, args.join(' '));
      }
      const r = await crew(fe, ['setup', '--bogus']);
      assert.match(r.stderr, /error: unexpected argument '--bogus' found\n\nFor more information, try 'kiro-claude crew setup --help'\./);
      const h = await crew(fe, ['setup', '--help']);
      assert.equal(h.code, 0);
      assert.match(h.stdout, /--no-identity-stub/);
      const top = await crew(fe, ['--help']);
      assert.equal(top.code, 0);
      assert.match(top.stdout, /Usage: kiro-claude crew <COMMAND>/);
    } finally {
      fe.cleanup();
    }
  });
});

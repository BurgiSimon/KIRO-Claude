/**
 * `kiro-claude crew doctor` (08 §3.9): ✅/⚠/❌ rows, --json, --fix, exit codes, and the probe
 * contract run through the real shim against a fake kiro-claude entry under KiroCrew's probe env.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runProbeContract } from '../../src/crew/doctor.js';
import { defaultRunner } from '../../src/crew/runner.js';
import { writeShim } from '../../src/crew/shim.js';
import { KIROCREW_PIN } from '../../src/crew/pin.js';
import { cloneFakeEnv, crew, FAKE_ENTRY, makeFakeEnv, realPython, type FakeEnv } from './helpers.js';

const PY = realPython();

let base: FakeEnv | undefined;

/** A set-up fake environment (setup runs once; each test gets its own copy). */
async function setUp(fe: FakeEnv): Promise<string> {
  if (!base) {
    base = makeFakeEnv();
    fs.writeFileSync(path.join(base.home, '.fake-claude-login'), '');
    const r = await crew(base, ['setup', '--dir', path.join(base.root, 'KiroCrew'), '--allow-tmp']);
    assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  }
  const copy = cloneFakeEnv(base);
  // Move the copy into the caller's environment object.
  fs.rmSync(fe.root, { recursive: true, force: true });
  fs.renameSync(copy.root, fe.root);
  const stateFile = path.join(fe.cs, 'crew.json');
  fs.writeFileSync(stateFile, fs.readFileSync(stateFile, 'utf8').split(copy.root).join(fe.root), { mode: 0o600 });
  return path.join(fe.root, 'KiroCrew');
}

function entryConf(fe: FakeEnv, conf: object): void {
  fs.writeFileSync(path.join(fe.home, '.fake-entry.json'), JSON.stringify(conf));
}

interface Row {
  id: string;
  title: string;
  status: string;
  detail: string;
  fix?: string;
  fixed?: string;
}

async function doctorJson(fe: FakeEnv, args: string[] = [], o: Parameters<typeof crew>[2] = {}): Promise<{ code: number; rows: Map<string, Row>; ok: boolean }> {
  const r = await crew(fe, ['doctor', '--json', ...args], o);
  const j = JSON.parse(r.stdout) as { ok: boolean; rows: Row[] };
  return { code: r.code, ok: j.ok, rows: new Map(j.rows.map((x) => [x.id, x])) };
}

describe('crew doctor (08 §3.9)', { skip: PY ? false : 'no python3 with sqlite3' }, () => {
  after(() => base?.cleanup());
  it('a fresh setup passes every check; human output uses ✅/⚠/❌ rows', async () => {
    const fe = makeFakeEnv();
    try {
      await setUp(fe);
      const r = await crew(fe, ['doctor']);
      assert.equal(r.code, 0, r.stdout);
      const lines = r.stdout.trim().split('\n');
      assert.match(lines[0]!, /^✅ tools: node 22\.23\.4, python 3\.13\.1, git 2\.43\.0$/);
      assert.match(r.stdout, /✅ checkout: .*KiroCrew at 665a0e4 \(kirocrew 0\.13\.0\)/);
      assert.match(r.stdout, /✅ build: kirocrew 0\.13\.0 \(source checkout, not a release build\)/);
      assert.match(r.stdout, /✅ Kiro Crew config: agent\.acp_backend=kiro, agent\.kas_bundle=false, agent\.member_acp_backend=claude, auto_update=false/);
      assert.match(r.stdout, /✅ members \(Bots\): @agentclientprotocol\/claude-agent-acp@0\.101\.0 → /);
      assert.match(r.stdout, /✅ shim: .*\/bin\/kiro-claude/);
      assert.match(r.stdout, /✅ Claude Code: .* 2\.1\.318; Logged in with Claude Code \(claude\.ai\)/);
      assert.match(r.stdout, /✅ kiro-cli identity: kiro-claude identity stub \(no credentials\)/);
      assert.match(r.stdout, /⏭ gateway: not running/);
      assert.match(r.stdout, /✅ Kiro Crew's doctor: kiro-cli ✅, claude-acp ✅, kiro auth ✅\n/);
      assert.equal(lines[lines.length - 1], 'No problems found.');
      // D12 ignores KiroCrew's own exit code (the fake exits 1 and flags "session bus").
      const j = await doctorJson(fe);
      assert.equal(j.code, 0);
      assert.deepEqual([...j.rows.keys()], ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'D10', 'D11', 'D12']);
      // The probes ran under the minimal probe env with the baked KIRO_CLAUDE_BIN.
      const probes = fs.readFileSync(path.join(fe.home, '.fake-entry.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { args: string[]; KIRO_CLAUDE_BIN: string; envKeys: string[] });
      const v = probes.find((p) => p.args[0] === '--version')!;
      assert.ok(v.KIRO_CLAUDE_BIN.endsWith('fake-claude.mjs'));
      assert.ok(!v.envKeys.includes('FAKE_LOG'), 'probe env is an allowlist');
      for (const args of [['acp', '--help'], ['chat', '--help'], ['whoami', '--format', 'json'], ['chat', '--list-models', '--format', 'json', '--no-interactive'], ['update'], ['acp', '--agent-engine', 'v3', '--auth-method', 'cli'], ['whoami']]) {
        assert.ok(probes.some((p) => JSON.stringify(p.args) === JSON.stringify(args)), args.join(' '));
      }
    } finally {
      fe.cleanup();
    }
  });

  it('no crew.json: setup row fails, exit 1', async () => {
    const fe = makeFakeEnv();
    try {
      const j = await doctorJson(fe);
      assert.equal(j.code, 1);
      assert.equal(j.rows.get('D0')!.status, 'fail');
      assert.equal(j.rows.get('D0')!.fix, 'kiro-claude crew setup');
    } finally {
      fe.cleanup();
    }
  });

  it('D2: wrong commit → ❌; --fix checks out the pin only when clean', async () => {
    const fe = makeFakeEnv();
    try {
      const dir = await setUp(fe);
      fs.writeFileSync(path.join(dir, '.git', 'FAKE_HEAD'), `${'1'.repeat(40)}\n`);
      const before = fe.callsOf('git').length;
      let j = await doctorJson(fe, [], { env: { FAKE_GIT_DIRTY: ' M setup.py' } });
      assert.equal(j.rows.get('D2')!.status, 'fail');
      assert.match(j.rows.get('D2')!.detail, /KiroCrew checkout is at 1111111, expected 665a0e4/);
      j = await doctorJson(fe, ['--fix'], { env: { FAKE_GIT_DIRTY: ' M setup.py' } });
      assert.equal(j.rows.get('D2')!.fixed, 'not attempted: the checkout has local changes');
      assert.ok(!fe.callsOf('git').slice(before).some((c) => c.args.includes('checkout')));
      j = await doctorJson(fe, ['--fix']);
      assert.equal(j.rows.get('D2')!.status, 'ok');
      assert.equal(j.rows.get('D2')!.fixed, 'checked out 665a0e4');
      assert.ok(fe.callsOf('git').some((c) => c.args.join(' ') === `-C ${dir} checkout --detach ${KIROCREW_PIN.commit}`));
      assert.equal(j.code, 0);
    } finally {
      fe.cleanup();
    }
  });

  it('D3: unbuilt → ❌ (and later rows that need KiroCrew are skipped)', async () => {
    const fe = makeFakeEnv();
    try {
      const dir = await setUp(fe);
      fs.rmSync(path.join(dir, 'src', 'kiro_crew', 'static', 'dist'), { recursive: true });
      const j = await doctorJson(fe);
      assert.equal(j.code, 1);
      assert.equal(j.rows.get('D3')!.status, 'fail');
      assert.match(j.rows.get('D3')!.detail, /missing src\/kiro_crew\/static\/dist/);
      assert.equal(j.rows.get('D4')!.status, 'skip');
      assert.equal(j.rows.get('D12')!.status, 'skip');
      const f = await doctorJson(fe, ['--fix']);
      assert.equal(f.rows.get('D3')!.fixed, 'rebuilt');
      assert.equal(f.rows.get('D3')!.status, 'ok');
    } finally {
      fe.cleanup();
    }
  });

  it('D4: config drift → ❌ with keyed fixes; --fix sets only the wrong keys', async () => {
    const fe = makeFakeEnv();
    try {
      const dir = await setUp(fe);
      const cfg = path.join(fe.home, '.kiro', 'crew', 'config.json');
      const data = JSON.parse(fs.readFileSync(cfg, 'utf8'));
      data.agent.acp_backend = 'kas';
      delete data.auto_update;
      fs.writeFileSync(cfg, JSON.stringify(data));
      let j = await doctorJson(fe);
      const d4 = j.rows.get('D4')!;
      assert.equal(d4.status, 'fail');
      assert.match(d4.detail, /agent\.acp_backend is "kas" \(want "kiro"\); auto_update is true \(want false\)/);
      assert.equal(d4.fix, 'kiro-claude crew exec -- config set agent.acp_backend kiro && kiro-claude crew exec -- config set auto_update false');
      const before = fe.callsOf('kirocrew').length;
      j = await doctorJson(fe, ['--fix']);
      assert.equal(j.rows.get('D4')!.status, 'ok');
      const sets = fe.callsOf('kirocrew').slice(before).filter((c) => c.args[1] === 'set').map((c) => c.args.join(' '));
      assert.deepEqual(sets, ['config set agent.acp_backend kiro', 'config set auto_update false']);
      void dir;
    } finally {
      fe.cleanup();
    }
  });

  it('D5: missing adapter → ❌; --fix reinstalls', async () => {
    const fe = makeFakeEnv();
    try {
      await setUp(fe);
      fs.rmSync(path.join(fe.cs, 'node'), { recursive: true });
      let j = await doctorJson(fe);
      assert.equal(j.rows.get('D5')!.status, 'fail');
      j = await doctorJson(fe, ['--fix']);
      assert.equal(j.rows.get('D5')!.status, 'ok');
      assert.equal(j.rows.get('D5')!.fixed, 'reinstalled claude-agent-acp');
    } finally {
      fe.cleanup();
    }
  });

  it('D6: stale or missing shim → ❌; --fix rewrites it byte-exact', async () => {
    const fe = makeFakeEnv();
    try {
      await setUp(fe);
      const shim = path.join(fe.cs, 'bin', 'kiro-claude');
      const good = fs.readFileSync(shim, 'utf8');
      fs.writeFileSync(shim, good.replace('exec', 'exec  '));
      let j = await doctorJson(fe);
      assert.equal(j.rows.get('D6')!.status, 'fail');
      assert.match(j.rows.get('D6')!.detail, /content differs/);
      j = await doctorJson(fe, ['--fix']);
      assert.equal(j.rows.get('D6')!.status, 'ok');
      assert.equal(fs.readFileSync(shim, 'utf8'), good);
      fs.rmSync(shim);
      j = await doctorJson(fe);
      assert.equal(j.rows.get('D6')!.status, 'fail');
      assert.equal(j.rows.get('D7')!.status, 'skip');
    } finally {
      fe.cleanup();
    }
  });

  it('D7: probe contract violations are named', async () => {
    const fe = makeFakeEnv();
    try {
      await setUp(fe);
      for (const [conf, re] of [
        [{ acpHelpV3: true }, /acp --help: no "\[possible values: v1, v2\]", mentions v3; chat --help: --agent-engine block lacks .*mentions v3/],
        [{ version: 'kiro-claude 0.1.0' }, /--version: exit 0, printed "kiro-claude 0\.1\.0" \(needs a kiro-cli version in \[1\.26\.0, 2\.21\.0\)/],
        [{ version: 'kiro-claude 0.1.0 (kiro-cli 2.21.0)' }, /--version: /],
        [{ v3Exit: 0 }, /acp --agent-engine v3: expected exit 2, got 0/],
        [{ listModels: '[{"model_id":"x"}]' }, /chat --list-models: expected a JSON object \{"models":\[…\]\}/],
        [{ listModels: '{"models":[{"model_id":"x","context_window_tokens":0}]}' }, /row without a string model_id\/model_name and an integer context_window_tokens > 0/],
      ] as Array<[object, RegExp]>) {
        entryConf(fe, conf);
        const j = await doctorJson(fe, ['--no-gateway']);
        assert.equal(j.code, 1, JSON.stringify(conf));
        assert.equal(j.rows.get('D7')!.status, 'fail');
        assert.match(j.rows.get('D7')!.detail, re);
      }
    } finally {
      fe.cleanup();
    }
  });

  it('D7 also validates ~/.kiro/agents/kirocrew.json when present (KC-CLI-09)', async () => {
    const fe = makeFakeEnv();
    try {
      await setUp(fe);
      fs.mkdirSync(path.join(fe.home, '.kiro', 'agents'), { recursive: true });
      fs.writeFileSync(path.join(fe.home, '.kiro', 'agents', 'kirocrew.json'), '{}');
      const j = await doctorJson(fe);
      assert.match(j.rows.get('D7')!.detail, /agent validate/);
    } finally {
      fe.cleanup();
    }
  });

  it('D8: env-only sign-in is detected; signed out names kiro-claude login', async () => {
    const fe = makeFakeEnv();
    try {
      await setUp(fe);
      fs.rmSync(path.join(fe.home, '.fake-claude-login'));
      let j = await doctorJson(fe, [], { env: { CLAUDE_CODE_OAUTH_TOKEN: 'x' } });
      assert.equal(j.rows.get('D8')!.status, 'fail');
      assert.equal(j.rows.get('D8')!.detail, `Claude Code sign-in is only in the environment; Kiro Crew's sign-in check cannot see it. Run "claude /login" (or "kiro-claude login").`);
      j = await doctorJson(fe);
      assert.equal(j.rows.get('D8')!.status, 'fail');
      assert.match(j.rows.get('D8')!.detail, /Not logged in\. Run "kiro-claude login"/);
      assert.equal(j.rows.get('D8')!.fix, 'kiro-claude login');
      j = await doctorJson(fe, [], { deps: { findClaude: async () => { throw new Error('Claude Code CLI (claude) was not found.'); } } });
      assert.equal(j.rows.get('D8')!.status, 'fail');
      assert.match(j.rows.get('D8')!.detail, /was not found/);
    } finally {
      fe.cleanup();
    }
  });

  it('D9: missing store → ❌; --fix writes the stub; an opt-out only warns; relocated XDG_DATA_HOME warns', async () => {
    const fe = makeFakeEnv();
    try {
      await setUp(fe);
      const store = path.join(fe.home, '.local', 'share', 'kiro-cli', 'data.sqlite3');
      fs.rmSync(store);
      let j = await doctorJson(fe);
      assert.equal(j.rows.get('D9')!.status, 'fail');
      assert.equal(j.rows.get('D9')!.fix, 'kiro-claude crew doctor --fix');
      j = await doctorJson(fe, ['--fix']);
      assert.equal(j.rows.get('D9')!.status, 'ok');
      assert.equal(j.rows.get('D9')!.fixed, 'wrote the identity stub');
      assert.equal(fs.existsSync(store), true);
      j = await doctorJson(fe, [], { env: { XDG_DATA_HOME: path.join(fe.root, 'xdg') } });
      assert.equal(j.rows.get('D9')!.status, 'warn');
      assert.match(j.rows.get('D9')!.detail, /XDG_DATA_HOME=.* is relocated/);
    } finally {
      fe.cleanup();
    }
  });

  it('D10: a long KIROCREW_HOME and low disk warn (exit stays 0)', async () => {
    const fe = makeFakeEnv();
    try {
      await setUp(fe);
      const { defaultSys } = await import('../../src/crew/runner.js');
      const long = path.join(fe.root, 'a-very-long-directory-name-for-the-kiro-crew-data-home', 'crew');
      const j = await doctorJson(fe, [], { env: { KIROCREW_HOME: long }, deps: { sys: { ...defaultSys, freeBytes: () => 100 * 1024 ** 2 } } });
      assert.equal(j.rows.get('D10')!.status, 'warn');
      assert.match(j.rows.get('D10')!.detail, /characters long \(> 60\).*only 0\.1 GB free/);
    } finally {
      fe.cleanup();
    }
  });

  it("D12: KiroCrew's doctor kiro-cli-chat ❌ fails the check", async () => {
    const fe = makeFakeEnv();
    try {
      await setUp(fe);
      const j = await doctorJson(fe, [], { env: { FAKE_KC_DOCTOR_OUTPUT: '  kiro-cli:    ✅ x\n  kiro-cli-chat: ❌ Kiro CLI is broken: no kiro-cli-chat in ~/.local/bin or on PATH' } });
      assert.equal(j.rows.get('D12')!.status, 'fail');
      assert.match(j.rows.get('D12')!.detail, /kiro-cli-chat ❌ \(Kiro CLI is broken/);
      assert.equal(j.code, 1);
    } finally {
      fe.cleanup();
    }
  });

  it('a foreign --kiro-bin skips D7 and the D8 sign-in probe (08 §5.1 A2)', async () => {
    const fe = makeFakeEnv();
    try {
      await setUp(fe);
      const j = await doctorJson(fe, ['--kiro-bin', '/x/fake-kiro-cli/kiro-claude']);
      assert.equal(j.rows.get('D7')!.status, 'skip');
      assert.match(j.rows.get('D8')!.detail, /sign-in probe skipped/);
    } finally {
      fe.cleanup();
    }
  });
});

describe('probe contract runner', () => {
  it('passes against the fake entry through a real shim under the probe env', async () => {
    const fe = makeFakeEnv({ tools: [] });
    try {
      fs.writeFileSync(path.join(fe.home, '.fake-claude-login'), '');
      const shim = path.join(fe.cs, 'bin', 'kiro-claude');
      writeShim(shim, { node: process.execPath, entry: FAKE_ENTRY(), claude: '/baked/claude' });
      const res = await runProbeContract(defaultRunner, shim, { home: fe.home });
      assert.deepEqual(res.map((r) => [r.id, r.ok]), [
        ['KC-CLI-01', true],
        ['KC-CLI-02', true],
        ['KC-CLI-03', true],
        ['KC-CLI-05', true],
        ['KC-CLI-06', true],
        ['KC-CLI-08', true],
        ['KC-CLI-10', true],
      ]);
      fs.rmSync(path.join(fe.home, '.fake-claude-login'));
      const out = await runProbeContract(defaultRunner, shim, { home: fe.home });
      assert.deepEqual(out.find((r) => r.id === 'KC-CLI-05'), { id: 'KC-CLI-05', label: 'whoami --format json', ok: true, detail: 'signed out (see the Claude row)', durationMs: undefined });
    } finally {
      fe.cleanup();
    }
  });
});

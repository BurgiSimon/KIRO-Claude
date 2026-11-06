/**
 * KiroCrew end-to-end stages (08-kirocrew-integration §5): KiroCrew 0.13.0's gateway, CLI and
 * ACP client run on kiro-claude (`kiro-claude crew …`), each stage in a fresh isolated run dir
 * (`/tmp/kce.XXXX`, HOME=<run>/h; the real ~/.kiro, ~/.claude and ~/.local are never touched).
 *
 * - Stage B (`KIRO_CLAUDE_E2E_KIROCREW=1`): real kiro-claude, fake Claude
 *   (test/fixtures/fake-claude.mjs + test/e2e/kirocrew/fake-script.json); deterministic, no model
 *   cost. setup → contract (KC-CLI-*) → ACP scenarios S1–S13 → crew start → pipeline C1–C14 →
 *   frame-shape parity against KiroCrew's kiro-cli corpus → teardown + leftover check (C18).
 * - Stage C (`KIRO_CLAUDE_E2E_KIROCREW=1` and `KIRO_CLAUDE_E2E=1`): the same against the real
 *   `claude` (haiku via KIRO_CLAUDE_FORCE_MODEL; costs about 30 model turns on your account).
 *
 * Needs a BUILT KiroCrew checkout: `$KIRO_CLAUDE_E2E_KCDIR`, else `<repo>/vendor/KiroCrew` once
 * `kiro-claude crew setup` has built it (`.venv` present). Every harness script prints
 * `PASS|FAIL|SKIP <id> <evidence>` lines; each line becomes a subtest here.
 * Debug: `KIRO_CLAUDE_E2E_KEEP=1` keeps the run dir (it is kept on failure anyway).
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

const STAGE_B = process.env.KIRO_CLAUDE_E2E_KIROCREW === '1';
const STAGE_C = STAGE_B && process.env.KIRO_CLAUDE_E2E === '1';
const KEEP = process.env.KIRO_CLAUDE_E2E_KEEP === '1';

/** `<outDir>` of this compiled file (`<outDir>/test/e2e/kirocrew.test.js`). */
const OUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The kiro-claude checkout holding test/e2e/kirocrew/*.sh (the scripts are not compiled). */
function findRepo(): string | undefined {
  const starts = [process.env.KIRO_CLAUDE_REPO, process.cwd(), OUT_DIR].filter((s): s is string => !!s);
  for (const s of starts) {
    let d = path.resolve(s);
    for (;;) {
      if (fs.existsSync(path.join(d, 'test', 'e2e', 'kirocrew', 'env.sh'))) return d;
      const up = path.dirname(d);
      if (up === d) break;
      d = up;
    }
  }
  return undefined;
}

const REPO = findRepo();
const TOOLS = REPO ? path.join(REPO, 'test', 'e2e', 'kirocrew') : '';

function findKcdir(): string | undefined {
  const cands = [process.env.KIRO_CLAUDE_E2E_KCDIR, REPO ? path.join(REPO, 'vendor', 'KiroCrew') : undefined];
  for (const c of cands) {
    if (c && fs.existsSync(path.join(c, '.venv', 'bin', 'python')) && fs.existsSync(path.join(c, 'bin', 'kirocrew'))) return path.resolve(c);
  }
  return undefined;
}

function skipReason(stage: 'B' | 'C'): string | undefined {
  if (stage === 'B' && !STAGE_B) return 'set KIRO_CLAUDE_E2E_KIROCREW=1 to run the KiroCrew stage B e2e (fake Claude, no model cost)';
  if (stage === 'C' && !STAGE_C) return 'set KIRO_CLAUDE_E2E_KIROCREW=1 and KIRO_CLAUDE_E2E=1 to run KiroCrew stage C (real Claude Code model calls on your account)';
  if (process.platform !== 'linux') return 'the KiroCrew e2e stages are Linux-only (08 §7 U11)';
  if (!REPO) return 'test/e2e/kirocrew/env.sh not found (run from the kiro-claude checkout, or set KIRO_CLAUDE_REPO)';
  if (!fs.existsSync(path.join(OUT_DIR, 'src', 'bin', 'kiro-claude.js'))) return `no built kiro-claude next to this test (${OUT_DIR}/src/bin/kiro-claude.js)`;
  if (!findKcdir()) return 'no built KiroCrew: set KIRO_CLAUDE_E2E_KCDIR=<built checkout> or run `kiro-claude crew setup` (vendor/KiroCrew)';
  return undefined;
}

interface Row {
  status: 'PASS' | 'FAIL' | 'SKIP';
  id: string;
  evidence: string;
}

function parseRows(text: string): Row[] {
  const rows: Row[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^(PASS|FAIL|SKIP) (\S+) ?(.*)$/.exec(line);
    if (m) rows.push({ status: m[1] as Row['status'], id: m[2]!, evidence: m[3] ?? '' });
  }
  return rows;
}

interface Stage {
  e2e: string;
  env: NodeJS.ProcessEnv;
  log: string;
}

function newStage(): Stage {
  const e2e = fs.mkdtempSync('/tmp/kce.');
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  Object.assign(env, { E2E: e2e, KC_DIST: OUT_DIR, KC_REPO: REPO!, KCDIR: findKcdir()! });
  return { e2e, env, log: path.join(e2e, 'stage.log') };
}

/** Runs `bash -c '. env.sh && <cmd>'` in the repo root; resolves with exit code and output. */
function sh(st: Stage, cmd: string, timeoutMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', `. "${TOOLS}/env.sh" >/dev/null && ${cmd}`], {
      cwd: REPO,
      env: st.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    let out = '';
    const onData = (b: Buffer): void => {
      out += b.toString('utf8');
      fs.appendFileSync(st.log, b);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => {
      out += `\nFAIL harness-timeout ${cmd.slice(0, 80)} exceeded ${timeoutMs} ms\n`;
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        // gone
      }
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

/** One harness script as a subtest whose PASS/FAIL/SKIP rows become nested subtests. */
async function step(t: TestContext, st: Stage, name: string, cmd: string, timeoutMs: number): Promise<boolean> {
  let ok = true;
  await t.test(name, { timeout: timeoutMs + 30_000 }, async (tt) => {
    const r = await sh(st, cmd, timeoutMs);
    const rows = parseRows(r.out);
    for (const row of rows) {
      await tt.test(`${row.id}`, (rt) => {
        if (row.status === 'SKIP') rt.skip(row.evidence);
        else if (row.status === 'FAIL') assert.fail(`${row.id}: ${row.evidence}`);
      });
    }
    ok = r.code === 0 && !rows.some((x) => x.status === 'FAIL');
    if (r.code !== 0 && rows.length === 0) assert.fail(`${name} exited ${r.code}:\n${r.out.slice(-2000)}`);
    if (r.code !== 0 && !rows.some((x) => x.status === 'FAIL')) assert.fail(`${name} exited ${r.code} without a FAIL row:\n${r.out.slice(-2000)}`);
  });
  return ok;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      const port = typeof a === 'object' && a ? a.port : 0;
      s.close(() => resolve(port));
    });
  });
}

async function runStage(t: TestContext, stage: 'B' | 'C'): Promise<void> {
  const st = newStage();
  t.diagnostic(`run dir ${st.e2e} (log ${st.log})`);
  const port = await freePort();
  const startEnv =
    stage === 'B'
      ? `FAKE_CLAUDE_SCRIPT=${TOOLS}/fake-script.json FAKE_CLAUDE_LOG=${st.e2e}/fake-claude.jsonl PYTHONDONTWRITEBYTECODE=1`
      : 'KIRO_CLAUDE_FORCE_MODEL=haiku PYTHONDONTWRITEBYTECODE=1';
  st.env.KC_START_ENV = startEnv;
  const envFlags = startEnv
    .split(' ')
    .map((kv) => `--env '${kv}'`)
    .join(' ');
  let allOk = true;
  try {
    const setup = await sh(st, `bash "$KC_TOOLS/setup.sh" --stage ${stage}`, 600_000);
    if (setup.code !== 0) assert.fail(`setup.sh failed (${setup.code}):\n${setup.out.slice(-3000)}`);
    allOk = (await step(t, st, 'contract', `bash "$KC_TOOLS/contract.sh" --stage ${stage}`, 300_000)) && allOk;
    if (stage === 'B') allOk = (await step(t, st, 'acp scenarios S1-S13', `python3 -I "$KC_TOOLS/acp_scenarios.py" --stage B --bin "$SHIM"`, 900_000)) && allOk;
    const start = await sh(st, `"$KC_NODE" "$KC_ENTRY" crew start --port ${port} ${envFlags}`, 240_000);
    if (start.code !== 0) assert.fail(`crew start failed (${start.code}):\n${start.out.slice(-3000)}`);
    allOk = (await step(t, st, 'pipeline C1-C14', `bash "$KC_TOOLS/pipeline.sh" --stage ${stage}`, stage === 'B' ? 1_500_000 : 3_000_000)) && allOk;
    if (stage === 'C') {
      allOk = (await step(t, st, 'C15 acp scenarios (real)', `python3 -I "$KC_TOOLS/acp_scenarios.py" --stage C --bin "$SHIM" S3 S4 S5 S6 S7 S9 S12`, 1_800_000)) && allOk;
    } else {
      allOk = (await step(t, st, 'frame-shape parity', `bash "$KC_TOOLS/parity.sh"`, 300_000)) && allOk;
    }
  } finally {
    allOk = (await step(t, st, 'teardown C18', `bash "$KC_TOOLS/teardown.sh" --kill`, 300_000)) && allOk;
    if (allOk && !KEEP) fs.rmSync(st.e2e, { recursive: true, force: true });
    else t.diagnostic(`kept ${st.e2e}`);
  }
}

test('KiroCrew stage B: real kiro-claude, fake Claude', { timeout: 3_600_000 }, async (t) => {
  const why = skipReason('B');
  if (why) {
    t.skip(why);
    return;
  }
  await runStage(t, 'B');
});

test('KiroCrew stage C: real kiro-claude, real Claude (haiku)', { timeout: 7_200_000 }, async (t) => {
  const why = skipReason('C');
  if (why) {
    t.skip(why);
    return;
  }
  await runStage(t, 'C');
});

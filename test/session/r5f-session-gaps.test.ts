/**
 * Round-5 known gaps in the session files (session group):
 *  - g1: a quit inside a fresh tangent of a main that never had a message drops main (r5 S4) AND
 *    the empty tangent records (nested ones too); a tangent with a message of its own is kept.
 *  - g2: `/rewind N` to a turn a `/compact` followed falls back on the journal (Claude no longer
 *    serves that turn's answer); its warning says the conversation was compacted after turn N, not
 *    that the saved conversation could not be found.
 *  - g3: while kiro-claude dies of a forwarded fatal signal (claude/lifecycle `dyingSignal()`, r5
 *    H2) a session prints no "restarting it" notice and starts nothing; restart() returns quietly.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ClaudeCapabilities } from '../../src/claude/binary.js';
import { KiroSessionImpl, type KiroSessionInternalOptions } from '../../src/session/kiroSession.js';
import { SessionStore } from '../../src/session/store.js';
import { STREAM_ARGS } from '../claude/helpers.js';
import { builtModule, isLinux, spawnNode, waitForLine } from '../claude/hang-helpers.js';
import { closeAll, drain, fakeBinary, fakeCaps, fakeClaudePath, mkSandbox, readJsonl, recordingUI, type RecordingUI, type Sandbox } from './helpers.js';

let caps: ClaudeCapabilities;
before(async () => {
  caps = await fakeCaps();
});

const SCRIPT = { default: { steps: [{ text: 'hist={{historyUserTexts}}' }] } };

function baseOptions(sb: Sandbox, ui: RecordingUI = recordingUI()): KiroSessionInternalOptions {
  return { ws: sb.ws, origin: 'repl', interactive: true, ui, binary: fakeBinary(), caps, env: sb.env };
}
const open = (sb: Sandbox, over: Partial<KiroSessionInternalOptions> = {}, ui?: RecordingUI): Promise<KiroSessionImpl> =>
  KiroSessionImpl.create({ ...baseOptions(sb, ui), ...over });
const listed = (sb: Sandbox): string[] => new SessionStore(sb.sessionsDir).list({ cwd: sb.cwd }).map((r) => `${r.forkKind}:${r.tangentName ?? ''}`);

/** A main whose only actions were local commands (Claude wrote a transcript), inside a tangent. */
async function emptyMainInTangent(sb: Sandbox): Promise<KiroSessionImpl> {
  const s = await open(sb);
  await drain(s.compact()); // nothing to compact, but the command line is written to Claude's transcript
  await s.addContext(['*.md']); // a respawn: `already in use` resumes that transcript
  await s.enterTangent('side');
  assert.equal(s.record.forkKind, 'tangent', 'precondition: inside the tangent');
  return s;
}

describe('r5 g1: a quit inside a fresh tangent of a main that never had a message', () => {
  it('drops main and the empty tangent: nothing is listed', async () => {
    const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const s = await emptyMainInTangent(sb);
    const tangentId = s.id;
    await s.close();
    assert.deepEqual(listed(sb), [], 'an empty tangent of a dropped main stays listed');
    assert.ok(!fs.existsSync(path.join(sb.sessionsDir, `${tangentId}.json`)));
    assert.ok(!fs.existsSync(path.join(sb.sessionsDir, `${tangentId}.jsonl`)));
    assert.ok(!fs.existsSync(path.join(sb.sessionsDir, `${tangentId}.lock`)));
    assert.equal(s.resumeId(), undefined, 'nothing to resume');
  });

  it('nested empty tangents are dropped too', async () => {
    const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const s = await emptyMainInTangent(sb);
    await s.enterTangent('inner');
    await s.close();
    assert.deepEqual(listed(sb), []);
  });

  it('a tangent with a message of its own is kept (main, which never had one, is not)', async () => {
    const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const s = await emptyMainInTangent(sb);
    const tangentId = s.id;
    await drain(s.prompt({ text: 'in the tangent' }));
    await s.close();
    assert.deepEqual(listed(sb), ['tangent:side']);
    assert.equal(s.resumeId(), tangentId);
  });

  it('a tangent entered from that used tangent carries its turn: both are kept', async () => {
    const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const s = await emptyMainInTangent(sb);
    await drain(s.prompt({ text: 'in the tangent' }));
    await s.enterTangent('inner');
    const innerId = s.id;
    await s.close();
    assert.deepEqual(listed(sb).sort(), ['tangent:inner', 'tangent:side']);
    assert.ok(new SessionStore(sb.sessionsDir).read(innerId));
  });
});

describe('r5 g2: /rewind to a turn a /compact followed', () => {
  it('falls back on the journal cut at that turn with a warning that names the compaction', async () => {
    const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const ui = recordingUI();
    const s = await open(sb, {}, ui);
    try {
      await drain(s.prompt({ text: 'alpha ALPHA_1' }));
      await drain(s.prompt({ text: 'beta BETA_2' }));
      const { result } = await drain(s.compact());
      assert.equal(result.isError, false, 'precondition: compacted');
      await s.rewind(1);
      const warns = ui.notices.filter((n) => n.level === 'warn').map((n) => n.message);
      assert.ok(warns.some((m) => /compacted after turn 1/.test(m)), `the fallback warning does not name the compaction: ${JSON.stringify(warns)}`);
      assert.ok(!warns.some((m) => /could not find the saved conversation/.test(m)), JSON.stringify(warns));
      const { result: next } = await drain(s.prompt({ text: 'after rewind' }));
      assert.match(next.text, /ALPHA_1/);
      assert.doesNotMatch(next.text, /BETA_2/, 'the turn rewound away came back');
    } finally {
      await closeAll(s);
    }
  });

  it('a rewind to the turn the compaction kept forks without a fallback (no warning)', async () => {
    const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const ui = recordingUI();
    const s = await open(sb, {}, ui);
    try {
      await drain(s.prompt({ text: 'alpha ALPHA_1' }));
      await drain(s.prompt({ text: 'beta BETA_2' }));
      await drain(s.compact());
      await s.rewind(2);
      assert.deepEqual(ui.notices.filter((n) => n.level === 'warn'), []);
    } finally {
      await closeAll(s);
    }
  });
});

describe('r5 g3: a session while kiro-claude dies of a forwarded SIGTERM', () => {
  /**
   * A kiro-claude stand-in with no signal listener of its own: a session (its child dies of the
   * forwarded SIGTERM) and a Claude Code child that ignores SIGTERM (so the grace runs its full
   * KILL_GRACE_MS). On "go", during the grace, it sends a prompt (ensureProcess) and runs a
   * command that restarts the child (/context add).
   */
  function writeDriver(sb: Sandbox): string {
    const driver = path.join(sb.root, 'dying-session-driver.mjs');
    fs.writeFileSync(
      driver,
      `const { KiroSessionImpl } = await import(${JSON.stringify(builtModule('session/kiroSession.js'))});
const { probeCapabilities } = await import(${JSON.stringify(builtModule('claude/binary.js'))});
const { ClaudeProcess } = await import(${JSON.stringify(builtModule('claude/process.js'))});
const { createWorkspaceContext } = await import(${JSON.stringify(builtModule('config/workspace.js'))});
const lifecycle = await import(${JSON.stringify(builtModule('claude/lifecycle.js'))});
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const env = { ...process.env };
const binary = { path: ${JSON.stringify(fakeClaudePath())}, version: '2.1.318', rawVersion: '2.1.318 (Claude Code)' };
const caps = await probeCapabilities(binary, { cacheDir: ${JSON.stringify(path.join(sb.root, 'caps'))}, env });
const ui = { notice: (level, message) => say({ event: 'notice', level, message }), requestApproval: async () => ({ kind: 'allow-once' }) };
const s = await KiroSessionImpl.create({ ws: createWorkspaceContext(process.cwd(), env), origin: 'repl', interactive: true, ui, binary, caps, env });
const drain = async (g) => { for (;;) { const r = await g.next(); if (r.done) return r.value; } };
await drain(s.prompt({ text: 'first' }));
const keeper = await ClaudeProcess.start({
  binary, args: ${JSON.stringify([...STREAM_ARGS])}, cwd: process.cwd(),
  env: { ...env, FAKE_CLAUDE_IGNORE_SIGTERM: '1', FAKE_CLAUDE_HANG_ON_EOF: '1', FAKE_CLAUDE_LOG: ${JSON.stringify(path.join(sb.root, 'keeper.log'))} },
  initialize: {}, handlers: { onHookCallback: async () => ({}), onCanUseTool: async () => ({ behavior: 'deny', message: 'no' }) },
});
process.stdin.on('data', async (d) => {
  if (!String(d).includes('go')) return;
  say({ event: 'dying', signal: lifecycle.dyingSignal() ?? null });
  const t0 = Date.now();
  while (s.process && s.process.running && Date.now() - t0 < 600) await new Promise((r) => setTimeout(r, 10));
  say({ event: 'child', running: !!(s.process && s.process.running) });
  try { await drain(s.prompt({ text: 'second' })); say({ event: 'prompt', ok: true }); }
  catch (e) { say({ event: 'prompt', ok: false, message: String(e && e.message) }); }
  try { await s.addContext(['*.md']); say({ event: 'restart', ok: true }); }
  catch (e) { say({ event: 'restart', ok: false, message: String(e && e.message) }); }
  say({ event: 'done' });
});
say({ event: 'ready', keeper: keeper.pid });
setInterval(() => {}, 1000);
`,
    );
    return driver;
  }

  it('no "restarting it" notice, no launch warning, no child started; the restart returns quietly', { skip: !isLinux, timeout: 30_000 }, async () => {
    const sb = mkSandbox({ script: SCRIPT });
    const run = spawnNode([writeDriver(sb)], { cwd: sb.cwd, env: sb.env, capMs: 20_000 });
    try {
      await waitForLine(run, (o) => o.event === 'ready', 15_000);
      const startsBefore = readJsonl(sb.logFile).filter((e) => e.event === 'start').length;
      process.kill(run.child.pid!, 'SIGTERM');
      await new Promise((r) => setTimeout(r, 100));
      run.child.stdin!.write('go\n');
      const done = await waitForLine(run, (o) => o.event === 'done', 10_000).catch(() => undefined);
      const res = await run.done;
      const ev = run
        .stdout()
        .split('\n')
        .filter((l) => l.trim().startsWith('{'))
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      assert.ok(done, `the driver did not finish during the grace: ${run.stdout()}\n${run.stderr()}`);
      assert.equal(ev.find((e) => e.event === 'dying')?.signal, 'SIGTERM', 'precondition: dying');
      assert.equal(ev.find((e) => e.event === 'child')?.running, false, "precondition: the session's child died of the signal");
      const notices = ev.filter((e) => e.event === 'notice').map((e) => String(e.message));
      assert.deepEqual(notices, [], `notices printed while kiro-claude was dying: ${JSON.stringify(notices)}`);
      assert.equal(ev.find((e) => e.event === 'restart')?.ok, true, `restart() was not quiet: ${JSON.stringify(ev.find((e) => e.event === 'restart'))}`);
      assert.equal(readJsonl(sb.logFile).filter((e) => e.event === 'start').length, startsBefore, 'a Claude Code child was started while dying');
      assert.equal(res.signal, 'SIGTERM', `the stand-in still dies of SIGTERM (code=${res.code})`);
    } finally {
      run.child.kill('SIGKILL');
    }
  });
});

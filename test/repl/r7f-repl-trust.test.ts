/**
 * Round-7 fix "repl-trust" (#0), unit half over MockSession doubles: `/chat new`, `/chat load`
 * and `/chat resume` start the next chat from the current chat's trust
 * (KiroSessionOptions.initialTrust, as the forced-stop restart does), never from the launch
 * `--trust-tools` / `--trust-all-tools` again, which would re-trust a tool the user untrusted or
 * turn trust-all back on after `/tools reset` (Q persist.rs: Load swaps the CURRENT agents, with
 * their allowedTools and trust-all, into the loaded state; trust is per process). A caller's own
 * initialTrust (a spec session's) still wins. Plan mode is session state too: the next chat keeps
 * the current one's, and a conversation saved in plan mode still comes back in it.
 * The built CLI over the fake claude: r7f-repl-trust-e2e.test.ts.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import { SessionStore } from '../../src/session/store.js';
import type { KiroSession, KiroSessionOptions, SessionTrust, SlashCommand } from '../../src/types.js';
import { setColorEnabled } from '../../src/util/ansi.js';
import { runToEnd, tempEnv, type StartOptions } from './harness.js';
import { MockSession, agentOf } from './mockSession.js';

setColorEnabled(false);

const temps: { cleanup(): void }[] = [];
after(() => {
  for (const t of temps) t.cleanup();
});

async function run(o: StartOptions): Promise<Awaited<ReturnType<typeof runToEnd>>> {
  const r = await runToEnd(o);
  temps.push(r.run.t);
  return r;
}

/** The launch flags of every test: `--trust-tools=shell,read --trust-all-tools`. */
const LAUNCH = { trustTools: ['shell', 'read'], trustAllTools: true };

/** What the user left of the launch trust: trust-all off (/tools reset), shell untrusted. */
function revoked(s: MockSession): SessionTrust {
  Object.assign(s.trust, { trustAll: false, allowedTools: ['read'], rules: [], revokedTools: ['shell'] });
  return s.trust;
}

function assertFromChat(o: Partial<KiroSessionOptions> | undefined, trust: SessionTrust, agent: string, what: string): void {
  assert.ok(o, `${what}: no session was created`);
  assert.deepEqual(o.initialTrust, { trust, agent }, `${what} did not start from the chat's trust`);
  assert.equal(o.trustTools, undefined, `${what} carried the launch --trust-tools again`);
  assert.equal(o.trustAllTools, trust.trustAll, `${what}: trust-all is not the chat's`);
}

test('r7f #0: /chat new starts from the chat\'s trust, not from the launch --trust-tools / --trust-all-tools', async () => {
  const first = new MockSession({ agent: agentOf('dev') });
  const trust = revoked(first);
  const r = await run({ session: first, input: ['/chat new'], sessionOptions: { ...LAUNCH } });
  assert.ok(r.out.includes('✔ Started a new chat session'), r.out);
  assertFromChat(r.run.created[1], trust, 'dev', '/chat new');
});

test('r7f #0: /chat resume starts from the chat\'s trust (mapped from the chat\'s agent), not the record\'s plus the launch flags', async () => {
  const t = tempEnv();
  temps.push(t);
  const store = new SessionStore(t.env.KIRO_CLAUDE_SESSIONS_DIR!);
  const rec = store.create({ origin: 'repl', cwd: t.wsDir, agent: 'other', model: 'auto', title: 'older chat' });
  const first = new MockSession({ agent: agentOf('dev') });
  const trust = revoked(first);
  const r = await run({ t, session: first, input: ['/chat resume', '1'], sessionOptions: { ...LAUNCH } });
  assert.ok(r.out.includes('Picking up where we left off...'), r.out);
  const o = r.run.created[1]!;
  assert.deepEqual(o.resume, { sessionId: rec.sessionId });
  assert.equal(o.agentName, 'other', 'the record\'s agent');
  // `agent` names the agent the snapshot's per-tool fields belong to: the session maps them to its own
  assertFromChat(o, trust, 'dev', '/chat resume');
});

test('r7f #0: /chat load starts from the chat\'s trust, not from the launch flags', async () => {
  const t = tempEnv();
  temps.push(t);
  t.write('proj/saved.json', '{}');
  const first = new MockSession({ agent: agentOf('dev') });
  const trust = revoked(first);
  const seen: Omit<KiroSessionOptions, 'resume' | 'fork'>[] = [];
  const r = await run({
    t,
    session: first,
    input: ['/chat load saved.json'],
    sessionOptions: { ...LAUNCH },
    importSessionExport: async (_p, opts) => {
      seen.push(opts);
      return new MockSession() as unknown as KiroSession;
    },
  });
  assert.ok(r.out.includes('✔ Imported conversation state from saved.json'), r.out);
  assertFromChat(seen[0], trust, 'dev', '/chat load');
});

test('r7f #0 (control): launch trust the user did not revoke is kept by /chat new, /chat load and /chat resume', async () => {
  const t = tempEnv();
  temps.push(t);
  t.write('proj/saved.json', '{}');
  new SessionStore(t.env.KIRO_CLAUDE_SESSIONS_DIR!).create({ origin: 'repl', cwd: t.wsDir, agent: 'dev', model: 'auto', title: 'older chat' });
  const first = new MockSession({ agent: agentOf('dev') });
  // what the session made of the launch flags (KiroSessionImpl applies them at creation)
  Object.assign(first.trust, { trustAll: true, allowedTools: ['shell', 'read'] });
  const seen: Partial<KiroSessionOptions>[] = [];
  const r = await run({
    t,
    session: first,
    // each next session gets the same trust (a MockSession's does not follow initialTrust)
    nextSession: () => {
      const s = new MockSession({ agent: agentOf('dev') });
      Object.assign(s.trust, { trustAll: true, allowedTools: ['shell', 'read'] });
      return s;
    },
    input: ['/chat new', '/chat load saved.json', '/chat resume', '1'],
    sessionOptions: { ...LAUNCH },
    importSessionExport: async (_p, opts) => {
      seen.push(opts);
      const s = new MockSession({ agent: agentOf('dev') });
      Object.assign(s.trust, { trustAll: true, allowedTools: ['shell', 'read'] });
      return s as unknown as KiroSession;
    },
  });
  assert.ok(r.out.includes('Picking up where we left off...'), r.out);
  const kept = { trustAll: true, allowedTools: ['shell', 'read'], rules: [] };
  for (const [o, what] of [[r.run.created[1], '/chat new'], [seen[0], '/chat load'], [r.run.created[2], '/chat resume']] as const) {
    assert.deepEqual(o?.initialTrust, { trust: kept, agent: 'dev' }, `${what} lost the launch trust`);
    assert.equal(o?.trustAllTools, true, `${what} lost --trust-all-tools`);
  }
});

test('r7f #0: a caller\'s own initialTrust (a spec session\'s) still wins over the chat\'s', async () => {
  const first = new MockSession({ agent: agentOf('dev') });
  revoked(first);
  const own: SessionTrust = { trustAll: false, allowedTools: ['grep'], rules: [] };
  const probe: SlashCommand = {
    name: 'probe',
    summary: 'create a session with its own trust',
    async run(_args, _raw, host) {
      const s = await host.createSession({ origin: 'spec', initialTrust: { trust: own, agent: 'kiro_default' } });
      await s.close();
    },
  };
  const r = await run({ session: first, input: ['/probe'], sessionOptions: { ...LAUNCH }, extraCommands: [probe] });
  const o = r.run.created[1]!;
  assert.deepEqual(o.initialTrust, { trust: own, agent: 'kiro_default' });
  assert.equal(o.trustTools, undefined, 'the launch --trust-tools came back');
});

// ───────────────────────────── plan mode ─────────────────────────────

/** A MockSession whose plan mode records whether it was set before start(). */
function planProbe(initial = false): MockSession & { setWhileStarted: boolean[] } {
  const s = new MockSession({ agent: agentOf('dev') }) as MockSession & { setWhileStarted: boolean[] };
  s.setWhileStarted = [];
  let on = initial;
  Object.defineProperty(s, 'planMode', {
    get: () => on,
    set: (v: boolean) => {
      s.setWhileStarted.push(s.started);
      on = v;
    },
    configurable: true,
  });
  return s;
}

test('r7f #0: /chat new, /chat load and /chat resume keep the chat\'s plan mode (set before the next session starts)', async () => {
  for (const sub of ['new', 'load', 'resume'] as const) {
    const t = tempEnv();
    temps.push(t);
    t.write('proj/saved.json', '{}');
    new SessionStore(t.env.KIRO_CLAUDE_SESSIONS_DIR!).create({ origin: 'repl', cwd: t.wsDir, agent: 'dev', model: 'auto', title: 'older chat' });
    const first = new MockSession({ agent: agentOf('dev') });
    first.planMode = true;
    const next = planProbe();
    const input = sub === 'new' ? ['/chat new'] : sub === 'load' ? ['/chat load saved.json'] : ['/chat resume', '1'];
    const r = await run({
      t,
      session: first,
      nextSession: () => next,
      input,
      importSessionExport: async () => next as unknown as KiroSession,
    });
    assert.equal(next.started, true, `/chat ${sub}: ${r.out}`);
    assert.equal(next.planMode, true, `/chat ${sub} left plan mode: the next prompt would run with edits allowed`);
    assert.deepEqual(next.setWhileStarted, [false], `/chat ${sub}: plan mode was not set before the session started`);
  }
});

test('r7f #0: a conversation saved in plan mode comes back in it although the chat is not; a chat outside plan mode starts outside it', async () => {
  const t = tempEnv();
  temps.push(t);
  t.write('proj/saved.json', '{}');
  const loaded = planProbe(true);
  const fresh = planProbe();
  const r = await run({
    t,
    nextSession: () => fresh,
    input: ['/chat load saved.json', '/plan', '/chat new'],
    importSessionExport: async () => loaded as unknown as KiroSession,
  });
  assert.ok(r.out.includes('Exited plan mode.'), `the loaded conversation was not in plan mode: ${r.out}`);
  assert.equal(loaded.planMode, false);
  assert.deepEqual(loaded.setWhileStarted, [true], 'the import never turns plan mode off: only the /plan toggle did');
  assert.equal(fresh.planMode, false, '/chat new turned plan mode on');
  assert.deepEqual(fresh.setWhileStarted, []);
});

test('r7g: /chat new, /chat load and /chat resume from plan mode pass planMode to the next session (on its record from the first write)', async () => {
  for (const [inPlan, want] of [[true, true], [false, undefined]] as const) {
    const t = tempEnv();
    temps.push(t);
    t.write('proj/saved.json', '{}');
    new SessionStore(t.env.KIRO_CLAUDE_SESSIONS_DIR!).create({ origin: 'repl', cwd: t.wsDir, agent: 'dev', model: 'auto', title: 'older chat' });
    const first = new MockSession({ agent: agentOf('dev') });
    first.planMode = inPlan;
    const seen: Omit<KiroSessionOptions, 'resume' | 'fork'>[] = [];
    const r = await run({
      t,
      session: first,
      nextSession: () => {
        const s = new MockSession({ agent: agentOf('dev') });
        s.planMode = inPlan;
        return s;
      },
      input: ['/chat new', '/chat load saved.json', '/chat resume', '1'],
      importSessionExport: async (_p, opts) => {
        seen.push(opts);
        const s = new MockSession({ agent: agentOf('dev') });
        s.planMode = inPlan;
        return s as unknown as KiroSession;
      },
    });
    assert.ok(r.out.includes('Picking up where we left off...'), r.out);
    for (const [o, what] of [[r.run.created[1], '/chat new'], [seen[0], '/chat load'], [r.run.created[2], '/chat resume']] as const) {
      assert.equal(o?.planMode, want, `${what} from a chat ${inPlan ? 'in' : 'outside'} plan mode`);
    }
  }
});

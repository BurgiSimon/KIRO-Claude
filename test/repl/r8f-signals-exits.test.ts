/**
 * Round-8 fix "signals-docs" #6, unit level (ExitSignals in a child node process, which imports
 * the built module; the parent reads its log and its death signal):
 *  - From the first SIGHUP / SIGTERM on ExitSignals holds SIGINT too, also in the main phase
 *    (after ready(), where a front end holds SIGINT): a SIGINT is then a second signal by the
 *    usual rules, so one inside the duplicate window (or later) re-raises the first signal at
 *    once. It used to reach only the front end there, and the close ran to the end of the grace.
 *  - A SIGINT before any SIGHUP / SIGTERM in the main phase is still the front end's alone (it is
 *    no first signal: a later SIGTERM's close is not cut short).
 *  - SIGINT is held by one listener only: closing() after that adds none, nor does a later signal.
 *  - Unchanged: a SIGINT that is the first signal of the final close (closing()) closes, a repeat
 *    inside the window is the same event (an npm / npx wrapper forwarding the terminal's), and a
 *    SIGTERM inside it re-raises the SIGINT at once.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { DUPLICATE_SIGNAL_WINDOW_MS, SIGNAL_CLOSE_GRACE_MS } from '../../src/repl/exitSignals.js';
import { removeOnExit } from '../tmpdirs.js';

const EXITS_URL = new URL('../../src/repl/exitSignals.js', import.meta.url).href;

/**
 * Child: an ExitSignals whose close takes `closeMs`, set up as `setup` says; with `frontEnd` a
 * SIGINT listener of its own after that (a front end's Ctrl+C handling, installed after ready()).
 * Then the steps of `plan` (`[delayMs, step]`, delays from the start, run in order: a signal is
 * dispatched before the next step): a signal sent to itself, an ExitSignals method, or `count`
 * (log the SIGINT listeners).
 */
const CHILD = `
const { ExitSignals } = await import(process.argv[2]);
const cfg = JSON.parse(process.argv[3]);
const t0 = Date.now();
const log = (s) => process.stdout.write(\`\${Date.now() - t0} \${s}\\n\`);
const ex = new ExitSignals(async () => {
  log('close-start');
  await new Promise((r) => setTimeout(r, cfg.closeMs));
  log('close-done');
}, []);
for (const step of cfg.setup) ex[step]();
if (cfg.frontEnd) process.on('SIGINT', () => log('front-end SIGINT'));
setInterval(() => undefined, 1000);
// one step after the other, each at its time from the start or later: a signal sent is
// dispatched to its listeners (the poll phase) before the next step runs, also when a loaded
// machine stalls this process past the next step's time (two timers due in one timers phase
// would otherwise run before the signal's dispatch)
void (async () => {
  for (const [ms, step] of cfg.plan) {
    const wait = ms - (Date.now() - t0);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (step.startsWith('SIG')) {
      log('send ' + step);
      process.kill(process.pid, step);
      await new Promise((r) => setImmediate(r));
    } else if (step === 'count') log('count ' + process.listenerCount('SIGINT'));
    else ex[step]();
  }
})();
log('ready');
`;

const DIR = removeOnExit(fs.mkdtempSync(path.join(os.tmpdir(), 'kc-r8f-exits-')));
const CHILD_FILE = path.join(DIR, 'child.mjs');
fs.writeFileSync(CHILD_FILE, CHILD);

interface ChildRun {
  signal: NodeJS.Signals | null;
  code: number | null;
  /** ms after the first signal was sent until the child died. */
  diedAfter: number;
  lines: string[];
}

async function runChild(cfg: { closeMs: number; setup: string[]; frontEnd?: boolean; plan: [number, string][] }): Promise<ChildRun> {
  const child = spawn(process.execPath, [CHILD_FILE, EXITS_URL, JSON.stringify(cfg)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  let firstSent: number | undefined;
  child.stdout.on('data', (d: Buffer) => {
    out += d.toString();
    if (firstSent === undefined && /send /.test(out)) firstSent = Date.now();
  });
  child.stderr.on('data', (d: Buffer) => (err += d.toString()));
  const killer = setTimeout(() => child.kill('SIGKILL'), 15_000);
  const e = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => child.on('exit', (code, signal) => res({ code, signal })));
  clearTimeout(killer);
  assert.equal(err, '', `child stderr: ${err}`);
  return { ...e, diedAfter: Date.now() - (firstSent ?? Date.now()), lines: out.trim().split('\n') };
}

const has = (r: ChildRun, re: RegExp): boolean => r.lines.some((l) => re.test(l));

for (const first of ['SIGHUP', 'SIGTERM'] as const) {
  test(`r8f #6: after ready(), a SIGINT ${DUPLICATE_SIGNAL_WINDOW_MS > 200 ? '200 ms' : 'right'} after a ${first} (inside the window) re-raises the ${first} at once, with or without a front end holding SIGINT`, { skip: process.platform === 'win32', timeout: 30_000 }, async () => {
    assert.ok(200 < DUPLICATE_SIGNAL_WINDOW_MS);
    for (const frontEnd of [true, false]) {
      const r = await runChild({ closeMs: 10_000, setup: ['ready'], frontEnd, plan: [[50, first], [250, 'SIGINT']] });
      const info = `front end ${frontEnd}: ${JSON.stringify(r)}`;
      assert.equal(r.signal, first, info);
      assert.ok(has(r, /close-start/) && !has(r, /close-done/), info);
      assert.ok(r.diedAfter < 800, `died ${r.diedAfter} ms after the ${first}, not at the SIGINT 200 ms after it\n${info}`);
    }
  });
}

test('r8f #6: after ready(), a SIGINT after the window of a SIGTERM also re-raises at once', { skip: process.platform === 'win32', timeout: 30_000 }, async () => {
  const later = 50 + DUPLICATE_SIGNAL_WINDOW_MS + 250;
  const r = await runChild({ closeMs: 10_000, setup: ['ready'], frontEnd: true, plan: [[50, 'SIGTERM'], [later, 'SIGINT']] });
  assert.equal(r.signal, 'SIGTERM', JSON.stringify(r));
  assert.ok(!has(r, /close-done/), r.lines.join('\n'));
  assert.ok(r.diedAfter < SIGNAL_CLOSE_GRACE_MS - 300, `died ${r.diedAfter} ms after the SIGTERM (SIGINT at +${later - 50})`);
});

test('r8f #6: after ready(), a SIGINT before any SIGHUP / SIGTERM stays the front end\'s: it is no first signal, and a later SIGTERM\'s close runs to its end', { skip: process.platform === 'win32', timeout: 30_000 }, async () => {
  const r = await runChild({ closeMs: 600, setup: ['ready'], frontEnd: true, plan: [[50, 'SIGINT'], [100, 'SIGTERM']] });
  assert.equal(r.signal, 'SIGTERM', JSON.stringify(r));
  assert.ok(has(r, /front-end SIGINT/), r.lines.join('\n'));
  assert.ok(has(r, /close-done/), `the SIGTERM's close was cut short:\n${r.lines.join('\n')}`);
  const sigint = r.lines.findIndex((l) => /front-end SIGINT/.test(l));
  const start = r.lines.findIndex((l) => /close-start/.test(l));
  const term = r.lines.findIndex((l) => /send SIGTERM/.test(l));
  assert.ok(sigint < term && term < start, `the SIGINT started the close:\n${r.lines.join('\n')}`);
});

test('r8f #6: a SIGHUP / SIGTERM arms one SIGINT listener of ExitSignals; closing() and a duplicate signal add none', { skip: process.platform === 'win32', timeout: 30_000 }, async () => {
  const r = await runChild({
    closeMs: 400,
    setup: ['ready'],
    frontEnd: true,
    plan: [[30, 'count'], [50, 'SIGHUP'], [80, 'count'], [90, 'SIGTERM'], [110, 'closing'], [130, 'count']],
  });
  const counts = r.lines.filter((l) => /count /.test(l)).map((l) => Number(l.split(' ').pop()));
  // the front end's alone; then the front end's and ExitSignals' (one, whatever comes after)
  assert.deepEqual(counts, [1, 2, 2], r.lines.join('\n'));
  assert.equal(r.signal, 'SIGHUP', JSON.stringify(r));
  assert.ok(has(r, /close-done/), `the SIGTERM right after the SIGHUP (one event) cut the close short:\n${r.lines.join('\n')}`);
});

test('r8f #6 unchanged: SIGINT as the first signal of the final close: a repeat inside the window is the same event; a SIGTERM inside it re-raises the SIGINT at once', { skip: process.platform === 'win32', timeout: 30_000 }, async () => {
  const dup = await runChild({ closeMs: 600, setup: ['ready', 'closing'], plan: [[50, 'SIGINT'], [60, 'SIGINT']] });
  assert.equal(dup.signal, 'SIGINT', JSON.stringify(dup));
  assert.ok(has(dup, /close-done/), `a forwarded duplicate SIGINT cut the close short:\n${dup.lines.join('\n')}`);
  const term = await runChild({ closeMs: 10_000, setup: ['ready', 'closing'], plan: [[50, 'SIGINT'], [150, 'SIGTERM']] });
  assert.equal(term.signal, 'SIGINT', JSON.stringify(term));
  assert.ok(!has(term, /close-done/), term.lines.join('\n'));
  assert.ok(term.diedAfter < 800, `died ${term.diedAfter} ms after the SIGINT`);
});

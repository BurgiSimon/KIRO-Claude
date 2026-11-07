/**
 * Round 5 fixes, group policy, item #3 end to end: the real runRepl and `/spec` flow over
 * test/fixtures/fake-claude.mjs (the fake answers "File created successfully" only for a Write the
 * gate allowed). `/spec feat` → "Request changes…" → the revision turn writes design.md:
 *  - design.md committed as a symlink to ~/.bashrc: neither the write through design.md nor the
 *    write to ~/.bashrc by its own path runs, and nothing is asked; plan mode off and on;
 *  - a symlinked spec folder that stays inside the workspace keeps working (written, not asked);
 *  - a symlinked spec folder that leaves the workspace is refused with a clear denial.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { TempEnv } from './harness.js';
import { liveRepl } from '../spec/liveRepl.js';
import { DESIGN_MD, REQ_MD } from '../spec/helpers.js';

interface Revision {
  /** Text the revision turn printed for each Write, in order. */
  results: string[];
  asked: boolean;
  out: string;
}

/**
 * `/spec feat` (requirements.md and design.md present: the design checkpoint) → Request changes →
 * a revision turn that writes each of `targets(t)` in order. `setup` lays out the spec folder.
 */
async function revise(plan: boolean, setup: (t: TempEnv) => void, targets: (t: TempEnv) => string[]): Promise<Revision> {
  let n = 0;
  const r = liveRepl(
    (t: TempEnv) => {
      const files = targets(t);
      n = files.length;
      const steps = files.flatMap((f, i) => [
        { tool: { name: 'Write', input: { file_path: f, content: '# Design\n' } } },
        { text: `W${i}[{{lastToolResult}}]${i === files.length - 1 ? ' END' : ''}` },
      ]);
      return { turns: [{ repeat: true, match: 'kiro-spec-mode', steps }, { repeat: true, steps: [{ text: 'ANSWER' }] }] };
    },
    { before: (t) => setup(t) },
  );
  try {
    await r.waitFor(/> $/);
    if (plan) await r.send('/plan', /\[plan\] > $/);
    const cp = await r.send('/spec feat', /Request changes[\s\S]*> $/);
    const k = /(\d+)\. Request changes/.exec(cp)![1]!;
    await r.send(k, /What should change in design\.md\?[\s\S]*> $/);
    const out = await r.send('make it shorter', /\] END[\s\S]*> $/);
    const results: string[] = [];
    for (let i = 0; i < n; i++) results.push((new RegExp(`W${i}\\[([\\s\\S]*?)\\]${i === n - 1 ? ' END' : ''}`).exec(out)?.[1] ?? '').replace(/\s+/g, ' '));
    return { results, asked: /\[y\/n\/t\]/.test(out), out };
  } finally {
    await r.close();
  }
}

const specDir = (t: TempEnv): string => path.join(t.wsDir, '.kiro', 'specs', 'feat');

for (const plan of [false, true]) {
  test(`plan=${plan}: design.md committed as a symlink to ~/.bashrc: no write through it, none to ~/.bashrc, nothing asked`, { timeout: 120_000 }, async () => {
    const rv = await revise(
      plan,
      (t) => {
        fs.mkdirSync(specDir(t), { recursive: true });
        fs.writeFileSync(path.join(specDir(t), 'requirements.md'), REQ_MD);
        const bashrc = path.join(t.home, '.bashrc');
        fs.writeFileSync(bashrc, DESIGN_MD);
        fs.symlinkSync(bashrc, path.join(specDir(t), 'design.md'));
      },
      (t) => [path.join(specDir(t), 'design.md'), path.join(t.home, '.bashrc')],
    );
    const [viaDoc, direct] = rv.results;
    assert.match(viaDoc!, /Spec phase design: only .*design\.md may be written now \(.*design\.md is a symbolic link\)/, rv.out);
    assert.doesNotMatch(direct!, /File created successfully/, rv.out);
    assert.match(direct!, plan ? /Plan mode is read-only/ : /Spec phase design: only .*design\.md may be written now/);
    assert.equal(rv.asked, false, 'no approval prompt');
  });

  test(`plan=${plan}: a spec folder symlinked inside the workspace still writes its document without asking`, { timeout: 120_000 }, async () => {
    const rv = await revise(
      plan,
      (t) => {
        const real = path.join(t.wsDir, 'docs', 'specs', 'feat');
        fs.mkdirSync(real, { recursive: true });
        fs.writeFileSync(path.join(real, 'requirements.md'), REQ_MD);
        fs.writeFileSync(path.join(real, 'design.md'), DESIGN_MD);
        fs.mkdirSync(path.dirname(specDir(t)), { recursive: true });
        fs.symlinkSync(path.join('..', '..', 'docs', 'specs', 'feat'), specDir(t));
      },
      (t) => [path.join(specDir(t), 'design.md')],
    );
    assert.match(rv.results[0]!, /File created successfully at: .*\.kiro\/specs\/feat\/design\.md/, rv.out);
    assert.equal(rv.asked, false);
  });

  test(`plan=${plan}: a spec folder symlinked out of the workspace is refused with a clear denial`, { timeout: 120_000 }, async () => {
    const rv = await revise(
      plan,
      (t) => {
        const real = path.join(t.home, 'elsewhere', 'feat');
        fs.mkdirSync(real, { recursive: true });
        fs.writeFileSync(path.join(real, 'requirements.md'), REQ_MD);
        fs.writeFileSync(path.join(real, 'design.md'), DESIGN_MD);
        fs.mkdirSync(path.dirname(specDir(t)), { recursive: true });
        fs.symlinkSync(real, specDir(t));
      },
      (t) => [path.join(specDir(t), 'design.md')],
    );
    assert.match(rv.results[0]!, /Spec phase design: only .*design\.md may be written now \(.*resolves to .*elsewhere\/feat\/design\.md, outside the workspace .*\)/, rv.out);
    assert.equal(rv.asked, false);
  });
}

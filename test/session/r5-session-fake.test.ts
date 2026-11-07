/**
 * r5 S1: the fake's transcripts after a compaction behave like the real claude 2.1.319's.
 *
 * VERIFIED with the real claude 2.1.319 (haiku; probes in the r5 session scratchpad,
 * probe-compact-pin*.mjs; every temp project dir removed): `/compact` writes a `system`
 * `compact_boundary` entry (`parentUuid` null, `logicalParentUuid` the last entry before it,
 * `compactMetadata`), the summary (`isCompactSummary`, its uuid the stream summary frame's and the
 * metadata's `anchorUuid`), then the command's caveat / `<command-name>` (the line's uuid) /
 * `<local-command-stdout>Compacted </local-command-stdout>` (the stream replay frame's uuid)
 * entries. A resume loads the transcript from its last compact boundary: the boundary, the summary,
 * the messages the compaction preserved verbatim (`preservedSegment` head..tail, relinked after the
 * summary; with two user turns or more it was the last assistant message, with one turn nothing),
 * then what followed. So `--resume S --resume-session-at <uuid>` (with or without
 * `--fork-session`) of a pre-compaction uuid that was not preserved fails: exit 1, stderr
 * `No message found with message.uuid of: <uuid>`, one `error_during_execution` result frame. A
 * fork at the summary keeps the summary (the model still knew ALPHA, BETA); one at the boundary
 * does not (NONE); one at the preserved message holds boundary, summary and that message.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { fakeClaudePath, fakeEnv } from '../claude/helpers.js';

const ARGS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];

interface Run {
  code: number | null;
  stderr: string;
  frames: Record<string, unknown>[];
  sent: string[];
}

interface Box {
  cwd: string;
  config: string;
  projDir: string;
  run(args: string[], lines: string[], env?: Record<string, string>): Promise<Run>;
  transcript(sid: string): Record<string, unknown>[];
}

function box(): Box {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kc-r5s-fake-')));
  const cwd = path.join(root, 'proj');
  const config = path.join(root, 'claude-config');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(config, { recursive: true });
  const projDir = path.join(config, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
  const env = fakeEnv({
    HOME: path.join(root, 'home'),
    CLAUDE_CONFIG_DIR: config,
    FAKE_CLAUDE_PERSIST: '1',
    FAKE_CLAUDE_SCRIPT_JSON: JSON.stringify({ default: { steps: [{ text: 'hist={{historyUserTexts}}' }] } }),
  });
  return {
    cwd,
    config,
    projDir,
    run: (args, lines, extra = {}) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [fakeClaudePath(), ...ARGS, ...args], { cwd, env: { ...env, ...extra }, stdio: ['pipe', 'pipe', 'pipe'] });
        let buf = '';
        let stderr = '';
        let i = 0;
        const frames: Record<string, unknown>[] = [];
        const sent: string[] = [];
        const next = (): void => {
          if (i < lines.length) {
            const u = randomUUID();
            sent.push(u);
            child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: lines[i++] }, parent_tool_use_id: null, session_id: '', uuid: u }) + '\n');
          } else child.stdin.end();
        };
        child.stdout.on('data', (d: Buffer) => {
          buf += d.toString('utf8');
          let k: number;
          while ((k = buf.indexOf('\n')) >= 0) {
            const l = buf.slice(0, k);
            buf = buf.slice(k + 1);
            try {
              const f = JSON.parse(l) as Record<string, unknown>;
              frames.push(f);
              if (f.type === 'result') next();
            } catch {
              /* not a frame */
            }
          }
        });
        child.stdin.on('error', () => undefined);
        child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
        child.on('exit', (code) => resolve({ code, stderr, frames, sent }));
        next();
      }),
    transcript: (sid) => {
      const f = path.join(projDir, `${sid}.jsonl`);
      if (!fs.existsSync(f)) return [];
      return fs
        .readFileSync(f, 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    },
  };
}

const assistants = (r: Run): string[] => r.frames.filter((f) => f.type === 'assistant').map((f) => f.uuid as string);
const resultOf = (r: Run): Record<string, unknown> | undefined => r.frames.filter((f) => f.type === 'result').at(-1);
const boundaryFrame = (r: Run): Record<string, unknown> | undefined => r.frames.find((f) => f.type === 'system' && f.subtype === 'compact_boundary');
const summaryFrame = (r: Run): Record<string, unknown> | undefined => r.frames.find((f) => f.type === 'user' && f.isSynthetic === true);
const stdoutFrame = (r: Run): Record<string, unknown> | undefined =>
  r.frames.find((f) => f.type === 'user' && f.isReplay === true && JSON.stringify(f.message).includes('Compacted'));
const answer = (r: Run): string => String(resultOf(r)?.result ?? '');

/** Two turns, /compact, a third turn: the r5 probe's main session. */
async function compacted(b: Box): Promise<{ S: string; main: Run; A1: string; A2: string; A4: string; U2: string }> {
  const S = randomUUID();
  const main = await b.run(['--session-id', S], ['alpha ALPHA_1', 'beta BETA_2', '/compact', 'gamma GAMMA_3']);
  assert.equal(main.code, 0, main.stderr);
  const [A1, A2, A4] = assistants(main);
  return { S, main, A1: A1!, A2: A2!, A4: A4!, U2: main.sent[1]! };
}

describe('r5 S1: the fake loads a compacted transcript like claude 2.1.319', () => {
  it('writes the compaction the way claude does: boundary, summary, then the command entries', async () => {
    const b = box();
    const { S, main, A2 } = await compacted(b);
    const cb = boundaryFrame(main)!;
    const sum = summaryFrame(main)!;
    const out = stdoutFrame(main)!;
    const md = cb.compact_metadata as Record<string, unknown>;
    assert.deepEqual(md.preserved_segment, { head_uuid: A2, anchor_uuid: sum.uuid, tail_uuid: A2 }, 'two turns: the last assistant message is kept verbatim');
    assert.deepEqual(md.preserved_messages, { anchor_uuid: sum.uuid, uuids: [A2], all_uuids: [A2] });
    assert.equal(cb.logical_parent_uuid, A2);
    const lines = b.transcript(S);
    const bi = lines.findIndex((l) => l.type === 'system' && l.subtype === 'compact_boundary');
    assert.ok(bi > 0, 'a compact_boundary entry');
    const boundary = lines[bi]!;
    assert.equal(boundary.uuid, cb.uuid, 'the stream frame\'s uuid');
    assert.equal(boundary.parentUuid, null);
    assert.equal(boundary.logicalParentUuid, A2);
    const cmd = boundary.compactMetadata as Record<string, unknown>;
    assert.deepEqual(cmd.preservedSegment, { headUuid: A2, anchorUuid: sum.uuid, tailUuid: A2 });
    const after = lines.slice(bi + 1, bi + 5);
    assert.equal(after[0]!.uuid, sum.uuid, 'the summary follows the boundary');
    assert.equal(after[0]!.isCompactSummary, true);
    assert.equal(after[0]!.parentUuid, cb.uuid);
    assert.equal(after[1]!.isMeta, true, 'the command caveat');
    assert.equal(after[2]!.uuid, main.sent[2], 'the /compact line\'s own uuid');
    assert.match(String((after[2]!.message as { content: string }).content), /<command-name>\/compact<\/command-name>/);
    assert.equal(after[3]!.uuid, out.uuid, 'the replay frame\'s uuid');
    assert.equal(after[3]!.type, 'user');
    assert.equal((after[3]!.message as { content: string }).content, '<local-command-stdout>Compacted </local-command-stdout>');
    // the model still knows the summarized lines
    assert.equal(answer(main), 'hist=alpha ALPHA_1 | beta BETA_2 | gamma GAMMA_3');
  });

  for (const fork of [true, false]) {
    it(`refuses a pre-compaction uuid that was not kept, ${fork ? 'with' : 'without'} --fork-session (No message found, exit 1)`, async () => {
      const b = box();
      const { S, A1, U2 } = await compacted(b);
      for (const at of [A1, U2]) {
        const r = await b.run(['--resume', S, '--resume-session-at', at, ...(fork ? ['--fork-session'] : [])], ['/cost']);
        assert.equal(r.code, 1);
        assert.equal(r.stderr.trim(), `No message found with message.uuid of: ${at}`);
        assert.equal(r.frames.length, 1);
        const res = resultOf(r)!;
        assert.equal(res.subtype, 'error_during_execution');
        assert.deepEqual(res.errors, [`No message found with message.uuid of: ${at}`]);
      }
    });
  }

  it('serves a fork at the kept message, at the summary and after the compaction; a fork at the boundary loses the summary', async () => {
    const b = box();
    const { S, main, A2, A4 } = await compacted(b);
    const sum = summaryFrame(main)!.uuid as string;
    const cb = boundaryFrame(main)!.uuid as string;
    const out = stdoutFrame(main)!.uuid as string;
    const at = async (u: string): Promise<{ r: Run; fid: string }> => {
      const fid = randomUUID();
      const r = await b.run(['--resume', S, '--resume-session-at', u, '--fork-session', '--session-id', fid], ['RECALL']);
      assert.equal(r.code, 0, `${u}: ${r.stderr}`);
      return { r, fid };
    };
    const kept = await at(A2);
    assert.equal(answer(kept.r), 'hist=alpha ALPHA_1 | beta BETA_2 | RECALL');
    const fl = b.transcript(kept.fid);
    assert.deepEqual(
      fl.slice(0, 4).map((l) => l.uuid),
      [cb, sum, A2, kept.r.sent[0]],
      'the fork holds the boundary, the summary, the kept message, then its own line',
    );
    assert.equal(fl[2]!.parentUuid, sum, 'the kept message is relinked after the summary');
    assert.equal(answer((await at(sum)).r), 'hist=alpha ALPHA_1 | beta BETA_2 | RECALL');
    assert.equal(answer((await at(out)).r), 'hist=alpha ALPHA_1 | beta BETA_2 | RECALL');
    assert.equal(answer((await at(A4)).r), 'hist=alpha ALPHA_1 | beta BETA_2 | gamma GAMMA_3 | RECALL');
    assert.equal(answer((await at(cb)).r), 'hist=RECALL', 'a fork at the boundary has no summary');
    // the source is untouched
    assert.equal(b.transcript(S).filter((l) => l.type === 'system' && l.subtype === 'compact_boundary').length, 1);
  });

  it('after a single turn nothing is kept: the turn\'s answer is not found', async () => {
    const b = box();
    const S = randomUUID();
    const main = await b.run(['--session-id', S], ['alpha ALPHA_1', '/compact']);
    const [A1] = assistants(main);
    const md = boundaryFrame(main)!.compact_metadata as Record<string, unknown>;
    assert.equal(md.preserved_segment, undefined);
    assert.equal(md.preserved_messages, undefined);
    const r = await b.run(['--resume', S, '--resume-session-at', A1!, '--fork-session'], ['/cost']);
    assert.equal(r.code, 1);
    assert.equal(r.stderr.trim(), `No message found with message.uuid of: ${A1}`);
    // the summary still is
    const sum = summaryFrame(main)!.uuid as string;
    const ok = await b.run(['--resume', S, '--resume-session-at', sum, '--fork-session'], ['RECALL']);
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(answer(ok), 'hist=alpha ALPHA_1 | RECALL');
  });

  it('a plain resume of a compacted session knows the summarized lines and the later ones', async () => {
    const b = box();
    const { S } = await compacted(b);
    const r = await b.run(['--resume', S], ['RECALL']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(answer(r), 'hist=alpha ALPHA_1 | beta BETA_2 | gamma GAMMA_3 | RECALL');
  });

  it('FAKE_CLAUDE_COMPACT_PRESERVE=none keeps nothing verbatim', async () => {
    const b = box();
    const S = randomUUID();
    const main = await b.run(['--session-id', S], ['alpha ALPHA_1', 'beta BETA_2', '/compact'], { FAKE_CLAUDE_COMPACT_PRESERVE: 'none' });
    const [, A2] = assistants(main);
    assert.equal((boundaryFrame(main)!.compact_metadata as Record<string, unknown>).preserved_segment, undefined);
    const r = await b.run(['--resume', S, '--resume-session-at', A2!, '--fork-session'], ['/cost']);
    assert.equal(r.code, 1);
  });
});

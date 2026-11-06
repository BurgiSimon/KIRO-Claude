import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import {
  claudeConfigDir,
  claudeProjectsDir,
  findTranscript,
  parseJsonl,
  readTranscript,
  rewriteTranscriptSessionId,
  sanitizeProjectDir,
  transcriptPath,
} from '../../src/claude/transcript.js';
import { mkTmp } from './helpers.js';

describe('claudeConfigDir', () => {
  it('prefers CLAUDE_CONFIG_DIR', () => {
    assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: '/cfg', HOME: '/h' }), path.resolve('/cfg'));
  });
  it('ignores an empty CLAUDE_CONFIG_DIR', () => {
    assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: '  ', HOME: '/h' }), path.join('/h', '.claude'));
  });
  it('defaults to ~/.claude', () => {
    assert.equal(claudeConfigDir({ HOME: '/h' }), path.join('/h', '.claude'));
    assert.equal(claudeProjectsDir({ HOME: '/h' }), path.join('/h', '.claude', 'projects'));
  });
});

describe('sanitizeProjectDir', () => {
  it('replaces every non-alphanumeric char with -', () => {
    assert.equal(sanitizeProjectDir('/home/user/KIRO-Claude'), '-home-user-KIRO-Claude');
    assert.equal(
      sanitizeProjectDir('/tmp/claude-0/-home-user-KIRO-Claude/f64c/scratchpad/work/claude-protocol/proj'),
      '-tmp-claude-0--home-user-KIRO-Claude-f64c-scratchpad-work-claude-protocol-proj',
    );
    assert.equal(sanitizeProjectDir('C:\\Users\\me\\my proj.v2'), 'C--Users-me-my-proj-v2');
    assert.equal(sanitizeProjectDir('/a/ü_b'), '-a---b');
  });
});

function setupProjects(): { env: NodeJS.ProcessEnv; cfg: string } {
  const cfg = mkTmp('kc-cfg-');
  return { env: { CLAUDE_CONFIG_DIR: cfg }, cfg };
}

describe('findTranscript', () => {
  const sid = '0f8fad5b-d9cb-469f-a165-70867728950e';

  it('finds the transcript in the cwd project dir', () => {
    const { env } = setupProjects();
    const cwd = mkTmp('kc-cwd-');
    const file = transcriptPath(sid, cwd, env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{}\n');
    assert.equal(findTranscript(sid, { cwd, env }), file);
  });

  it('finds via the realpath of a symlinked cwd', { skip: process.platform === 'win32' }, () => {
    const { env } = setupProjects();
    const real = fs.realpathSync(mkTmp('kc-real-'));
    const link = path.join(mkTmp('kc-link-'), 'ln');
    fs.symlinkSync(real, link);
    const file = transcriptPath(sid, real, env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{}\n');
    assert.equal(findTranscript(sid, { cwd: link, env }), file);
  });

  it('scans other project dirs when cwd does not match', () => {
    const { env, cfg } = setupProjects();
    const file = path.join(cfg, 'projects', '-some-other-dir', `${sid}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{}\n');
    assert.equal(findTranscript(sid, { cwd: '/not/it', env }), file);
    assert.equal(findTranscript(sid, { env }), file);
  });

  it('returns undefined when missing or no projects dir', () => {
    const { env } = setupProjects();
    assert.equal(findTranscript(sid, { cwd: '/x', env }), undefined);
    assert.equal(findTranscript(sid, { env: { CLAUDE_CONFIG_DIR: path.join(mkTmp(), 'nope') } }), undefined);
  });

  it('refuses path-traversal ids', () => {
    const { env, cfg } = setupProjects();
    fs.mkdirSync(path.join(cfg, 'projects', 'p'), { recursive: true });
    fs.writeFileSync(path.join(cfg, 'secret.jsonl'), '{}');
    assert.equal(findTranscript('../../secret', { env }), undefined);
    assert.equal(findTranscript('..', { env }), undefined);
    assert.equal(findTranscript('', { env }), undefined);
  });

  it('ignores directories named like the transcript', () => {
    const { env, cfg } = setupProjects();
    fs.mkdirSync(path.join(cfg, 'projects', 'p', `${sid}.jsonl`), { recursive: true });
    assert.equal(findTranscript(sid, { env }), undefined);
  });
});

describe('readTranscript / parseJsonl', () => {
  it('parses lines and skips blank/bad ones', () => {
    const file = path.join(mkTmp(), 't.jsonl');
    fs.writeFileSync(file, '{"a":1}\n\nnot json\r\n{"b":2}\r\n   \n{"c":');
    assert.deepEqual(readTranscript(file), [{ a: 1 }, { b: 2 }]);
  });
  it('keeps non-object JSON values', () => {
    assert.deepEqual(parseJsonl('1\n"x"\nnull\n'), [1, 'x', null]);
  });
  it('throws for a missing file', () => {
    assert.throws(() => readTranscript(path.join(mkTmp(), 'missing.jsonl')), /ENOENT/);
  });
});

describe('rewriteTranscriptSessionId', () => {
  const NEW = '11111111-1111-4111-8111-111111111111';

  it('rewrites sessionId and session_id at any depth', () => {
    const text = [
      JSON.stringify({ type: 'user', sessionId: 'old', uuid: 'u1', message: { role: 'user', content: 'hi sessionId old' } }),
      JSON.stringify({ type: 'attachment', attachment: { hookInput: { session_id: 'old', x: [{ sessionId: 'old' }] } }, sessionId: 'old' }),
    ].join('\n') + '\n';
    const out = rewriteTranscriptSessionId(text, NEW);
    const lines = out.split('\n');
    assert.equal(lines.length, 3);
    assert.equal(lines[2], '');
    const a = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.equal(a.sessionId, NEW);
    assert.equal(a.uuid, 'u1');
    assert.deepEqual(a.message, { role: 'user', content: 'hi sessionId old' }, 'text content untouched');
    const b = JSON.parse(lines[1]!) as { sessionId: string; attachment: { hookInput: { session_id: string; x: Array<{ sessionId: string }> } } };
    assert.equal(b.sessionId, NEW);
    assert.equal(b.attachment.hookInput.session_id, NEW);
    assert.equal(b.attachment.hookInput.x[0]!.sessionId, NEW);
  });

  it('does not touch non-string session fields', () => {
    const out = rewriteTranscriptSessionId(JSON.stringify({ sessionId: null, session_id: 5 }), NEW);
    assert.deepEqual(JSON.parse(out), { sessionId: null, session_id: 5 });
  });

  it('preserves bad lines, blank lines, CRLF and missing trailing newline', () => {
    const text = '{"sessionId":"a"}\r\n\r\nnot json\r\n{"sessionId":"b"}';
    const out = rewriteTranscriptSessionId(text, NEW);
    assert.equal(out, `{"sessionId":"${NEW}"}\r\n\r\nnot json\r\n{"sessionId":"${NEW}"}`);
  });

  it('handles empty input', () => {
    assert.equal(rewriteTranscriptSessionId('', NEW), '');
    assert.equal(rewriteTranscriptSessionId('\n', NEW), '\n');
  });
});

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createLogger, defaultLogFile, formatLogLine, levelFromVerbosity, log, parseLogLevel } from '../../src/util/log.js';

describe('log', () => {
  let dir: string;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-log-'));
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('defaultLogFile: KIRO_CHAT_LOG_FILE, then XDG_RUNTIME_DIR, then TMPDIR, then /tmp (01 §9)', () => {
    assert.equal(defaultLogFile({ KIRO_CHAT_LOG_FILE: path.join(dir, 'x.log') }), path.join(dir, 'x.log'));
    assert.equal(defaultLogFile({ XDG_RUNTIME_DIR: '/run/user/1' }), path.join('/run/user/1', 'kiro-log', 'kiro-claude.log'));
    assert.equal(defaultLogFile({ TMPDIR: '/var/tmp' }), path.join('/var/tmp', 'kiro-log', 'kiro-claude.log'));
    if (process.platform !== 'win32') assert.equal(defaultLogFile({}), '/tmp/kiro-log/kiro-claude.log');
  });

  it('parseLogLevel / levelFromVerbosity', () => {
    assert.equal(parseLogLevel('DEBUG'), 'debug');
    assert.equal(parseLogLevel(' trace '), 'trace');
    assert.equal(parseLogLevel('verbose'), undefined);
    assert.equal(parseLogLevel(undefined), undefined);
    assert.equal(levelFromVerbosity(0), 'warn');
    assert.equal(levelFromVerbosity(1), 'info');
    assert.equal(levelFromVerbosity(2), 'debug');
    assert.equal(levelFromVerbosity(5), 'trace');
    assert.equal(levelFromVerbosity(1, 'debug'), 'debug');
  });

  it('formatLogLine', () => {
    const line = formatLogLine('warn', ['hello', { a: 1 }, 42, new Error('boom')], new Date('2026-01-02T03:04:05.000Z'));
    // stack continuation lines: V8's 4-space indent + our 2-space continuation indent
    assert.match(line, /^2026-01-02T03:04:05\.000Z WARN hello \{ a: 1 \} 42 Error: boom\n {6}at /);
    assert.ok(line.endsWith('\n'));
    assert.equal(formatLogLine('info', ['a\nb'], new Date(0)), '1970-01-01T00:00:00.000Z INFO a\n  b\n');
  });

  it('default level comes from KIRO_LOG_LEVEL (default warn) and filters messages', () => {
    const file = path.join(dir, 'filter.log');
    const l = createLogger({ env: {}, file, now: () => new Date(0) });
    assert.equal(l.level, 'warn');
    l.debug('hidden');
    l.info('hidden');
    l.warn('shown-warn');
    l.error('shown-error');
    l.close();
    assert.equal(
      fs.readFileSync(file, 'utf8'),
      '1970-01-01T00:00:00.000Z WARN shown-warn\n1970-01-01T00:00:00.000Z ERROR shown-error\n',
    );
    const l2 = createLogger({ env: { KIRO_LOG_LEVEL: 'trace' }, file: path.join(dir, 'x.log') });
    assert.equal(l2.level, 'trace');
    assert.equal(l2.enabled('trace'), true);
    const l3 = createLogger({ env: { KIRO_LOG_LEVEL: 'bogus' }, file: path.join(dir, 'y.log') });
    assert.equal(l3.level, 'warn');
  });

  it('setLevel / level setter / file setter', () => {
    const l = createLogger({ env: {}, file: path.join(dir, 'a.log') });
    l.setLevel('debug');
    assert.equal(l.level, 'debug');
    l.level = 'error';
    assert.equal(l.level, 'error');
    l.level = 'nonsense' as never;
    assert.equal(l.level, 'error');
    l.error('to-a');
    l.file = path.join(dir, 'b.log');
    l.error('to-b');
    l.close();
    assert.match(fs.readFileSync(path.join(dir, 'a.log'), 'utf8'), /to-a/);
    assert.match(fs.readFileSync(path.join(dir, 'b.log'), 'utf8'), /to-b/);
    assert.doesNotMatch(fs.readFileSync(path.join(dir, 'a.log'), 'utf8'), /to-b/);
  });

  it('creates the directory lazily, only when something is logged', () => {
    const sub = path.join(dir, 'lazy', 'deeper');
    const l = createLogger({ env: { KIRO_CHAT_LOG_FILE: path.join(sub, 'k.log') } });
    l.debug('below threshold');
    assert.equal(fs.existsSync(sub), false);
    l.error('now');
    l.close();
    assert.equal(fs.existsSync(path.join(sub, 'k.log')), true);
  });

  it('never throws, even when the file cannot be opened', () => {
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'x');
    const l = createLogger({ env: {}, file: path.join(blocker, 'sub', 'k.log') });
    assert.doesNotThrow(() => {
      l.error('cannot write');
      l.warn({ circular: (() => { const o: Record<string, unknown> = {}; o.self = o; return o; })() });
    });
  });

  it('never writes to stdout or stderr', () => {
    const origOut = process.stdout.write;
    const origErr = process.stderr.write;
    let wrote = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = () => {
      wrote = true;
      return true;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = () => {
      wrote = true;
      return true;
    };
    try {
      const l = createLogger({ env: {}, file: path.join(dir, 'quiet.log'), level: 'trace' });
      l.trace('t');
      l.error(new Error('e'));
      const bad = createLogger({ env: {}, file: '/proc/definitely/not/writable/x.log', level: 'trace' });
      bad.error('nowhere');
      l.close();
    } finally {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    }
    assert.equal(wrote, false);
  });

  it('rotates files larger than 10 MiB at open time', () => {
    const file = path.join(dir, 'big.log');
    fs.writeFileSync(file, Buffer.alloc(10 * 1024 * 1024 + 1, 'a'));
    const l = createLogger({ env: {}, file });
    l.error('fresh');
    l.close();
    assert.ok(fs.existsSync(`${file}.old`));
    assert.match(fs.readFileSync(file, 'utf8'), /^\S+ ERROR fresh\n$/);
  });

  it('the shared logger exposes the documented surface', () => {
    for (const k of ['error', 'warn', 'info', 'debug', 'trace', 'setLevel'] as const) assert.equal(typeof log[k], 'function');
    assert.equal(typeof log.level, 'string');
    assert.equal(typeof log.file, 'string');
  });
});

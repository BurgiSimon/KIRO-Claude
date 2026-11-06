import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { c, colorEnabled, isColorEnabled, setColorEnabled, stripAnsi } from '../../src/util/ansi.js';

describe('ansi: colorEnabled', () => {
  const tty = { isTTY: true };
  const pipe = { isTTY: false };
  it('TTY without overrides ⇒ on; pipe ⇒ off', () => {
    assert.equal(colorEnabled(tty, {}), true);
    assert.equal(colorEnabled(pipe, {}), false);
    assert.equal(colorEnabled(undefined, {}), false);
  });
  it('NO_COLOR (non-empty) disables', () => {
    assert.equal(colorEnabled(tty, { NO_COLOR: '1' }), false);
    assert.equal(colorEnabled(tty, { NO_COLOR: '' }), true);
  });
  it('FORCE_COLOR forces on (even over NO_COLOR and pipes); 0/false forces off', () => {
    assert.equal(colorEnabled(pipe, { FORCE_COLOR: '1' }), true);
    assert.equal(colorEnabled(pipe, { FORCE_COLOR: '1', NO_COLOR: '1' }), true);
    assert.equal(colorEnabled(tty, { FORCE_COLOR: '0' }), false);
    assert.equal(colorEnabled(tty, { FORCE_COLOR: 'false' }), false);
  });
  it('TERM=dumb disables', () => {
    assert.equal(colorEnabled(tty, { TERM: 'dumb' }), false);
  });
});

describe('ansi: styles', () => {
  afterEach(() => setColorEnabled(false));

  it('are identity functions when disabled', () => {
    setColorEnabled(false);
    assert.equal(isColorEnabled(), false);
    for (const f of Object.values(c)) assert.equal(f('x'), 'x');
  });
  it('wrap with SGR codes when enabled', () => {
    setColorEnabled(true);
    assert.equal(c.red('x'), '\u001b[31mx\u001b[39m');
    assert.equal(c.bold('x'), '\u001b[1mx\u001b[22m');
    assert.equal(c.gray('x'), '\u001b[90mx\u001b[39m');
    assert.equal(c.green('x'), '\u001b[32mx\u001b[39m');
    assert.equal(c.underline('x'), '\u001b[4mx\u001b[24m');
  });
  it('nesting re-opens the outer style', () => {
    setColorEnabled(true);
    const s = c.red(`a${c.green('b')}c`);
    assert.equal(s, '\u001b[31ma\u001b[32mb\u001b[39m\u001b[31mc\u001b[39m');
    assert.equal(stripAnsi(s), 'abc');
  });
});

describe('ansi: stripAnsi', () => {
  it('removes SGR, cursor, OSC 8 hyperlinks and 8-bit CSI', () => {
    assert.equal(stripAnsi('\u001b[1;31mred\u001b[0m plain'), 'red plain');
    assert.equal(stripAnsi('\u001b[2K\u001b[1Gline'), 'line');
    assert.equal(stripAnsi('\u001b]8;;https://x.y\u0007link\u001b]8;;\u0007'), 'link');
    assert.equal(stripAnsi('\u001b]8;;https://x.y\u001b\\link\u001b]8;;\u001b\\'), 'link');
    assert.equal(stripAnsi('\u009b31mx\u009b0m'), 'x');
    assert.equal(stripAnsi('\u001b7saved\u001b8'), 'saved');
    assert.equal(stripAnsi('no escapes, ünïcode 😀'), 'no escapes, ünïcode 😀');
  });
});

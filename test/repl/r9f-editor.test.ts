/**
 * Round-9 fix "editor" (#2), repl/external.ts: how a child's stdio is set up. Given the terminal
 * (`inherit`), the child's stdin is the process's own (fd 0); its output goes to the process's
 * own stdout / stderr unless `inheritStdout` / `inheritStderr` say false (a REPL whose output
 * stream is not the process's), when it is copied to `out` / `err`. Without `inherit` (piped
 * input, tests) stdin is /dev/null and the output is copied. The real terminal cases (a piped
 * stdout included) are in r9f-editor-pty.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { openEditor, runShellCommand, type ChildIo } from '../../src/repl/external.js';
import { removeOnExit } from '../tmpdirs.js';

const ownStdin = ((): string | undefined => {
  try {
    return fs.readlinkSync('/proc/self/fd/0');
  } catch {
    return undefined;
  }
})();
// (node --test gives a test process a socket as stdin: told apart from the /dev/null of a child without it)
const skip = process.platform !== 'linux' ? 'Linux (/proc)' : ownStdin === undefined || ownStdin === '/dev/null' ? 'this process has no stdin of its own' : false;

function io(over: Partial<ChildIo>): { io: ChildIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { inherit: false, out: (s) => out.push(s), err: (s) => err.push(s), cwd: os.tmpdir(), env: { ...process.env }, ...over },
    out,
    err,
  };
}

const SAY_STDIN = 'readlink /proc/self/fd/0; echo to-err >&2';

test('r9f #2: given the terminal, a `!cmd` reads the process\'s own stdin; output streams that are not the process\'s get its output copied', { skip }, async () => {
  const c = io({ inherit: true, inheritStdout: false, inheritStderr: false });
  const r = await runShellCommand(SAY_STDIN, c.io);
  assert.deepEqual(r, { code: 0, signal: null });
  assert.equal(c.out.join('').trim(), ownStdin);
  assert.equal(c.err.join(''), 'to-err\n');
});

test('r9f #2: without the terminal (piped input), a `!cmd` gets /dev/null as stdin and its output is copied', { skip }, async () => {
  const c = io({ inherit: false, inheritStdout: true, inheritStderr: true });
  const r = await runShellCommand(SAY_STDIN, c.io);
  assert.deepEqual(r, { code: 0, signal: null });
  assert.equal(c.out.join('').trim(), '/dev/null');
  assert.equal(c.err.join(''), 'to-err\n');
});

test('r9f #2: given the terminal, the editor reads the process\'s own stdin too (stdout copied here)', { skip }, async () => {
  const dir = removeOnExit(fs.mkdtempSync(path.join(os.tmpdir(), 'kc-r9f-ed-')));
  const ed = path.join(dir, 'ed.sh');
  fs.writeFileSync(ed, '#!/bin/sh\necho EDITING\nreadlink /proc/self/fd/0 > "$1"\n', { mode: 0o755 });
  const c = io({ inherit: true, inheritStdout: false, inheritStderr: false });
  const r = await openEditor('', c.io, { command: [ed] });
  assert.deepEqual(r, { ok: true, text: `${ownStdin}\n` });
  assert.equal(c.out.join(''), 'EDITING\n');
});

/**
 * Round-8 residual (repl-input gap of #2): the spec flow's "Open in $EDITOR" ran the editor with
 * spawnSync and inherited stdio while the REPL's reader still held the terminal, so an editor that
 * turns bracketed paste off at exit (vim, vi) left it off for the rest of the chat (a multi-line
 * paste was then submitted line by line), and a Ctrl+Z in that editor was not handled either. In
 * the REPL it now goes through ReplContext.openEditor (the reader is suspended and resumed, like
 * /editor), with the spec's own editor choice ($VISUAL before $EDITOR) as the command.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { openEditor } from '../../src/repl/external.js';
import { createReplRuntime } from '../../src/spec/workflow.js';
import { MockHost, fakeModel, makeWs } from './helpers.js';

type EditorCall = { initial: string; opts: { file?: string; command?: readonly string[] } };

function hostWithEditor(env: Record<string, string>, result: { ok: true; text: string } | { ok: false; error: string } = { ok: true, text: '' }) {
  const w = makeWs('kc-r8g-ed-');
  Object.assign(w.ctx.env, env);
  const host = new MockHost(w.ctx, fakeModel());
  const calls: EditorCall[] = [];
  (host as unknown as { openEditor: (i: string, o: EditorCall['opts']) => Promise<typeof result> }).openEditor = async (initial, opts) => {
    calls.push({ initial, opts });
    return result;
  };
  return { w, host, calls };
}

test('r8g: in the REPL the spec editor goes through the host (reader handed over), with $EDITOR as the command', async () => {
  const { w, host, calls } = hostWithEditor({ EDITOR: 'my-ed --wait' });
  try {
    const rt = createReplRuntime(host);
    assert.ok(rt.openEditor, '"Open in $EDITOR" is offered when an editor is configured');
    const file = path.join(w.specs, 'feat', 'requirements.md');
    await rt.openEditor(file);
    assert.deepEqual(calls, [{ initial: '', opts: { file, command: ['my-ed', '--wait'] } }]);
    assert.deepEqual(host.printed, []);
  } finally {
    w.cleanup();
  }
});

test('r8g: $VISUAL wins over $EDITOR, as before', async () => {
  const { w, host, calls } = hostWithEditor({ VISUAL: 'vis-ed', EDITOR: 'my-ed' });
  try {
    await createReplRuntime(host).openEditor!('/x/design.md');
    assert.deepEqual(calls.map((c) => c.opts.command), [['vis-ed']]);
  } finally {
    w.cleanup();
  }
});

test("r8g: an editor that fails is reported, and the flow goes on", async () => {
  const { w, host } = hostWithEditor({ EDITOR: 'my-ed' }, { ok: false, error: 'my-ed exited with status 1' });
  try {
    await createReplRuntime(host).openEditor!('/x/tasks.md');
    assert.deepEqual(host.printed, ['✗ my-ed exited with status 1']);
  } finally {
    w.cleanup();
  }
});

test('r8g: no editor configured: the option stays hidden although the host can open one', () => {
  const { w, host, calls } = hostWithEditor({});
  try {
    assert.equal(createReplRuntime(host).openEditor, undefined);
    assert.deepEqual(calls, []);
  } finally {
    w.cleanup();
  }
});

test('r8g: openEditor runs opts.command (not $EDITOR) on the file, edited in place', async () => {
  const w = makeWs('kc-r8g-ed-');
  try {
    const file = path.join(w.proj, 'doc.md');
    fs.writeFileSync(file, 'old\n');
    const script = path.join(w.root, 'ed.mjs');
    fs.writeFileSync(script, "import * as fs from 'node:fs';\nfs.appendFileSync(process.argv.at(-1), 'edited ' + process.argv[2] + '\\n');\n");
    const r = await openEditor(
      '',
      { inherit: false, out: () => undefined, err: () => undefined, cwd: w.proj, env: { ...w.ctx.env, EDITOR: 'false' } },
      { file, command: [process.execPath, script, '--flag'] },
    );
    assert.deepEqual(r, { ok: true, text: 'old\nedited --flag\n' });
  } finally {
    w.cleanup();
  }
});

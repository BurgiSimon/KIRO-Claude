/**
 * Child programs the REPL hands the terminal to: `$EDITOR` for /editor, /reply, /agent create
 * (01 §5.7, §9: `EDITOR`, fallback `vi`) and `!cmd` shell escapes (01 §4.3 step 4: `bash -c`
 * via util/process `shellInvocation`, inherited stdio, not sent to the model).
 *
 * When the REPL reads the keyboard (`inherit`: terminal mode on the process's own stdin), the
 * child gets that terminal on stdin and the caller suspends the line reader around it, whatever
 * the REPL's stdout is (`kiro-claude chat | tee log` reads raw keys too, r9 #2). Its output goes
 * where Q sends it (Q runs both with `Command::status()`, every stream inherited): straight to
 * the process's own stdout and stderr, a pipe included, so it reaches the screen in order with
 * what the REPL writes before and after it (the reader's bracketed-paste switches go to stdout
 * too; the caller first waits until what Node still queues for a pipe is handed to the OS, and
 * takes the terminal back only in the foreground: repl/core.ts flushedForChild, handBack).
 * DECISION: not to the controlling terminal (`/dev/tty`), which would keep an editor's
 * screen out of a piped log but could overtake output still in the pipe, may not exist, and is
 * not what Q does; an editor may then say its output is not a terminal (vim: a 2 s pause), as
 * under Q. An output stream that is not the process's own (an embedder's) gets the child's
 * output copied instead (`inheritStdout` / `inheritStderr`). Nothing is watched while the child
 * runs: one given the terminal gets Ctrl+C from the terminal itself (cooked mode, kiro-claude's
 * foreground process group; it is spawned in that group, not `detached`, so the terminal's Ctrl+C
 * and Ctrl+Z reach it, as in Q). Because the group is shared, a terminal mode change the child
 * makes from the background sends SIGTTOU to kiro-claude too: the caller catches it meanwhile
 * (repl/core.ts guardChild, r10 #0). Otherwise (piped input, tests) the child's stdin is closed (it
 * never takes the REPL's next input line) and its output is copied to the REPL's output streams.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { shellInvocation } from '../util/process.js';
import { shlexSplit } from '../util/shlex.js';
import type { EditorResult } from './types.js';

export interface ChildIo {
  /** Give the child the terminal the REPL reads (stdin inherited; see module doc). */
  inherit: boolean;
  /** With `inherit`: the child writes to the process's stdout itself (default), else through `out`. */
  inheritStdout?: boolean;
  /** With `inherit`: the child writes to the process's stderr itself (default), else through `err`. */
  inheritStderr?: boolean;
  out: (s: string) => void;
  err: (s: string) => void;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
}

function runChild(file: string, args: string[], io: ChildIo, windowsVerbatimArguments = false): Promise<ChildExit> {
  return new Promise<ChildExit>((resolve) => {
    let child;
    try {
      child = spawn(file, args, {
        cwd: io.cwd,
        env: io.env,
        stdio: io.inherit
          ? ['inherit', io.inheritStdout === false ? 'pipe' : 'inherit', io.inheritStderr === false ? 'pipe' : 'inherit']
          : ['ignore', 'pipe', 'pipe'],
        windowsVerbatimArguments,
      });
    } catch (e) {
      resolve({ code: null, signal: null, error: e instanceof Error ? e.message : String(e) });
      return;
    }
    let settled = false;
    const done = (r: ChildExit): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    child.on('error', (e: Error) => done({ code: null, signal: null, error: e.message }));
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => io.out(d));
    child.stderr?.on('data', (d: string) => io.err(d));
    child.on('close', (code, signal) => done({ code, signal }));
  });
}

/** Run `command` through the platform shell (01 §4.3 step 4). */
export function runShellCommand(command: string, io: ChildIo): Promise<ChildExit> {
  const inv = shellInvocation(command, { env: io.env });
  return runChild(inv.file, inv.args, io, inv.windowsVerbatimArguments);
}

/** `$EDITOR` split into program + arguments (fallback `vi`). */
export function editorCommand(env: NodeJS.ProcessEnv): string[] {
  const raw = (env.EDITOR ?? '').trim();
  if (raw === '') return ['vi'];
  const words = shlexSplit(raw);
  return words && words.length > 0 ? words : [raw];
}

/**
 * Open `$EDITOR` (or `opts.command`, the editor's program and arguments) on `opts.file` (edited in
 * place) or on a temp file prefilled with `initial`; resolves with the file's content afterwards.
 */
export async function openEditor(initial: string, io: ChildIo, opts: { suffix?: string; file?: string; command?: readonly string[] } = {}): Promise<EditorResult> {
  let file = opts.file;
  let tmpDir: string | undefined;
  try {
    if (!file) {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-claude-editor-'));
      file = path.join(tmpDir, `prompt${opts.suffix ?? '.md'}`);
      fs.writeFileSync(file, initial, { mode: 0o600 });
    }
    const [prog, ...args] = opts.command && opts.command.length > 0 ? opts.command : editorCommand(io.env);
    const r = await runChild(prog!, [...args, file], io);
    if (r.error) return { ok: false, error: r.error };
    if (r.code !== 0) return { ok: false, error: `${prog} exited with ${r.signal ? `signal ${r.signal}` : `status ${r.code}`}` };
    return { ok: true, text: fs.readFileSync(file, 'utf8') };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

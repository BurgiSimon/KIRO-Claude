/**
 * Child programs the REPL hands the terminal to: `$EDITOR` for /editor, /reply, /agent create
 * (01 §5.7, §9: `EDITOR`, fallback `vi`) and `!cmd` shell escapes (01 §4.3 step 4: `bash -c`
 * via util/process `shellInvocation`, inherited stdio, not sent to the model).
 *
 * When the REPL runs on a real terminal (`inherit`), the child gets the TTY (stdio inherited)
 * and the caller suspends the line reader around it. Otherwise (pipes, tests) the child's
 * output is copied to the REPL's output streams and its stdin is closed.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { shellInvocation } from '../util/process.js';
import { shlexSplit } from '../util/shlex.js';
import type { EditorResult } from './types.js';

export interface ChildIo {
  /** Give the child the real terminal. */
  inherit: boolean;
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
        stdio: io.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
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

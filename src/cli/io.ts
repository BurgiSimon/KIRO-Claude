/**
 * Small I/O helpers shared by the CLI commands: line output on the CliContext streams,
 * usage-error printing, `$EDITOR` launching (01 §9 `EDITOR`, fallback `vi`), reading stdin,
 * and optional imports of sibling Wave-2 modules.
 *
 * Library rule (task RULES): commands write only to `ctx.stdout` / `ctx.stderr`, never to
 * `process.stdout` directly, so tests can capture output.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { CliContext } from '../types.js';
import { shellQuote } from '../util/shlex.js';
import { UsageError, parseArgs, renderHelp, type CommandDef, type ParsedArgs } from './args.js';

/** Write `text` + newline to stdout. */
export function out(ctx: Pick<CliContext, 'stdout'>, text = ''): void {
  ctx.stdout.write(`${text}\n`);
}

/** Write `text` + newline to stderr. */
export function err(ctx: Pick<CliContext, 'stderr'>, text = ''): void {
  ctx.stderr.write(`${text}\n`);
}

/**
 * Parse `args` for a command; prints help (stdout, exit 0) or a usage error (stderr, exit 2).
 * Returns the parse result, or the exit code when the command must stop.
 */
export function parseOrExit(def: CommandDef, args: readonly string[], ctx: CliContext): ParsedArgs | number {
  try {
    const p = parseArgs(def, args, ctx.progName);
    if (p.help) {
      ctx.stdout.write(renderHelp(def, ctx.progName, p.help));
      return 0;
    }
    return p;
  } catch (e) {
    if (e instanceof UsageError) {
      ctx.stderr.write(`${e.message}\n`);
      return e.exitCode;
    }
    throw e;
  }
}

/** Print a {@link UsageError} (or rethrow anything else) and return its exit code. */
export function reportUsage(ctx: CliContext, e: unknown): number {
  if (e instanceof UsageError) {
    ctx.stderr.write(`${e.message}\n`);
    return e.exitCode;
  }
  throw e;
}

/** Error text of an unknown value. */
export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The editor command: Kiro uses `$EDITOR` (fallback `vi`, 01 §9). */
export function editorCommand(env: NodeJS.ProcessEnv): string {
  const e = env.EDITOR;
  return e && e.trim() !== '' ? e.trim() : 'vi';
}

/**
 * Open `file` in the user's editor with inherited stdio and wait. `$EDITOR` may contain
 * arguments (`code -w`), so it runs through the shell with the file path quoted. Returns the
 * editor's exit code (or an error message when it could not be started).
 */
export function openInEditor(file: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): { code: number; error?: string } {
  // cmd.exe has no single quotes; Windows paths cannot contain `"`, so double quotes suffice.
  const quoted = platform === 'win32' ? `"${file}"` : shellQuote(file);
  const cmd = `${editorCommand(env)} ${quoted}`;
  const r = spawnSync(cmd, { shell: true, stdio: 'inherit', env });
  if (r.error) return { code: 1, error: r.error.message };
  return { code: r.status ?? 1 };
}

/** Read all of a readable stream as UTF-8 text. */
export function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer | string) => chunks.push(typeof c === 'string' ? Buffer.from(c) : c));
    stream.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.once('error', reject);
  });
}

/**
 * Read one line from `stdin` (for simple prompts such as the resume picker). Resolves with the
 * line without its newline, or `undefined` on EOF.
 */
export function readLine(stdin: NodeJS.ReadableStream): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve) => {
    const st = stdin as NodeJS.ReadableStream & { readableEnded?: boolean; destroyed?: boolean };
    if (st.readableEnded || st.destroyed) {
      resolve(undefined);
      return;
    }
    let buf = '';
    const onData = (c: Buffer | string): void => {
      buf += typeof c === 'string' ? c : c.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        cleanup();
        const line = buf.slice(0, nl).replace(/\r$/, '');
        const rest = buf.slice(nl + 1);
        if (rest !== '' && typeof (stdin as NodeJS.ReadableStream & { unshift?: (c: Buffer) => void }).unshift === 'function') {
          (stdin as NodeJS.ReadableStream & { unshift: (c: Buffer) => void }).unshift(Buffer.from(rest));
        }
        resolve(line);
      }
    };
    const onEnd = (): void => {
      cleanup();
      resolve(buf === '' ? undefined : buf.replace(/\r$/, ''));
    };
    const cleanup = (): void => {
      stdin.removeListener('data', onData);
      stdin.removeListener('end', onEnd);
      stdin.removeListener('error', onEnd);
      stdin.pause();
    };
    stdin.on('data', onData);
    stdin.once('end', onEnd);
    stdin.once('error', onEnd);
    stdin.resume();
  });
}

/**
 * Import a sibling module that may not exist in every build (other Wave-2 modules), by a
 * computed specifier so the TypeScript build does not depend on it, and return one export.
 * Throws a clear error when the module or the export is missing.
 */
export async function importOptional<T>(specifier: string, exportName: string, base: string = import.meta.url): Promise<T> {
  const url = new URL(specifier, base);
  let mod: Record<string, unknown>;
  try {
    mod = (await import(url.href)) as Record<string, unknown>;
  } catch (e) {
    const code = (e as { code?: string }).code;
    // Only the module itself being absent is "not available"; a missing dependency of an
    // existing module is a real error and is rethrown as is.
    if (code === 'ERR_MODULE_NOT_FOUND' && String((e as Error).message).includes(`'${fileURLToPath(url)}'`)) {
      throw new Error(`${specifier} is not available in this build of kiro-claude`);
    }
    throw e;
  }
  const v = mod[exportName];
  if (v === undefined) throw new Error(`${specifier} does not export ${exportName}`);
  return v as T;
}

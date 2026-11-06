/**
 * Logic of the `kiro-claude` executable around `main()` (src/bin/kiro-claude.ts only wires it
 * to cli/main.ts; this module has no side effects so it can be tested).
 *
 * Once `main()` has settled, the command is complete and nothing may keep the process alive:
 *  1. `claude` children still running were abandoned (e.g. a `claude auth status` probe left
 *     behind when `whoami` hit its 20 s cap, 08 KC-CLI-04): they are shut down gracefully
 *     (SIGTERM to their process group, SIGKILL after a short grace — claude/lifecycle.ts), so
 *     they neither hold the event loop open nor survive us;
 *  2. stdout and stderr are drained (every queued write handed to the OS), so piped output is
 *     never truncated;
 *  3. only then, if some other stray handle (a forgotten timer, a resumed stdin, a socket)
 *     still keeps the loop alive after {@link STRAY_HANDLE_EXIT_MS}, the process exits with
 *     main's code. The timer is unref'd: a clean loop exits on its own first, at once.
 */
import { shutdownTrackedChildren } from '../claude/lifecycle.js';

/** Grace for stray handles once main() resolved and stdout/stderr drained. */
export const STRAY_HANDLE_EXIT_MS = 1_000;

/** Resolves once everything written to `stream` so far has been flushed (or it cannot be). */
function drained(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    if (stream.destroyed || !stream.writable) {
      resolve();
      return;
    }
    try {
      // Writes complete in order: this callback runs after every earlier write was flushed
      // (or with an error, e.g. EPIPE from a closed reader).
      stream.write('', () => resolve());
    } catch {
      resolve();
    }
  });
}

async function finish(code: number): Promise<void> {
  process.exitCode = code;
  try {
    await shutdownTrackedChildren();
  } catch {
    /* best effort */
  }
  await drained(process.stdout);
  await drained(process.stderr);
  setTimeout(() => process.exit(code), STRAY_HANDLE_EXIT_MS).unref();
}

/** Runs `mainFn(argv)` as the process entry point (see module doc). */
export function runEntry(mainFn: (argv: string[]) => Promise<number>, argv: string[]): void {
  mainFn(argv).then(
    (code) => finish(code),
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`kiro-claude: ${msg}\n`);
      return finish(1);
    },
  );
}

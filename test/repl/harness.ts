/**
 * Drive the REPL (repl/core.ts runReplWith) with scripted stdin and a MockSession.
 * Temp HOME / workspace per run; never touches the real ~/.kiro or ~/.claude.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { openSettings } from '../../src/config/settings.js';
import { createWorkspaceContext } from '../../src/config/workspace.js';
import { runReplWith } from '../../src/repl/core.js';
import type { ReplDeps, RunReplOptions } from '../../src/repl/types.js';
import type { CliContext, KiroSession, KiroSessionOptions, SlashCommand, WorkspaceContext } from '../../src/types.js';
import { stripAnsi } from '../../src/util/ansi.js';
import { MockSession } from './mockSession.js';

export interface TempEnv {
  root: string;
  home: string;
  kiroHome: string;
  wsDir: string;
  env: NodeJS.ProcessEnv;
  write(rel: string, content: string): string;
  cleanup(): void;
}

export function tempEnv(extraEnv: NodeJS.ProcessEnv = {}): TempEnv {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kc-repl-')));
  const home = path.join(root, 'home');
  const wsDir = path.join(root, 'proj');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(wsDir, '.kiro'), { recursive: true });
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    KIRO_CLAUDE_SESSIONS_DIR: path.join(home, '.kiro', 'sessions', 'cli'),
    ...extraEnv,
  };
  return {
    root,
    home,
    kiroHome: path.join(home, '.kiro'),
    wsDir,
    env,
    write(rel: string, content: string): string {
      const p = path.isAbsolute(rel) ? rel : path.join(root, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
      return p;
    },
    cleanup(): void {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

export interface ReplRun {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  /** Output so far, ANSI stripped. */
  out(): string;
  raw(): string;
  err(): string;
  exit: Promise<number>;
  session: MockSession;
  sessions: MockSession[];
  created: KiroSessionOptions[];
  ws: WorkspaceContext;
  t: TempEnv;
  /** Wait until the stripped output contains `s` (or matches). */
  waitFor(s: string | RegExp, ms?: number): Promise<void>;
  send(line: string): void;
  end(): void;
}

export interface StartOptions {
  /** Lines (joined with \n, trailing \n) written to stdin at once. */
  input?: string[];
  /** Keep stdin open (default: end after `input`). */
  keepOpen?: boolean;
  session?: MockSession;
  /** Factory for sessions created after the first (/chat new, resume, load). */
  nextSession?: (opts: KiroSessionOptions) => MockSession;
  settings?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
  sessionOptions?: RunReplOptions['sessionOptions'];
  initialInput?: string;
  wrap?: RunReplOptions['wrap'];
  extraCommands?: SlashCommand[];
  importSessionExport?: ReplDeps['importSessionExport'];
  /** Make stdin/stdout look like a TTY (terminal mode). */
  tty?: boolean;
  columns?: number;
  t?: TempEnv;
  createFails?: Error;
}

export function startRepl(o: StartOptions = {}): ReplRun {
  const t = o.t ?? tempEnv(o.env);
  if (o.settings) {
    fs.mkdirSync(path.join(t.kiroHome, 'settings'), { recursive: true });
    fs.writeFileSync(path.join(t.kiroHome, 'settings', 'cli.json'), JSON.stringify(o.settings));
  }
  const ws = createWorkspaceContext(t.wsDir, t.env);
  const settings = openSettings(ws);
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  if (o.tty) {
    Object.assign(stdin, { isTTY: true, setRawMode: () => stdin });
    Object.assign(stdout, { isTTY: true, columns: o.columns ?? 100 });
  } else if (o.columns) Object.assign(stdout, { columns: o.columns });
  let rawOut = '';
  let rawErr = '';
  stdout.on('data', (d: Buffer) => {
    rawOut += d.toString('utf8');
  });
  stderr.on('data', (d: Buffer) => {
    rawErr += d.toString('utf8');
  });
  const ctx: CliContext = {
    ws,
    settings,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    progName: 'kiro-claude',
    verbosity: 0,
  };
  const first = o.session ?? new MockSession();
  const sessions: MockSession[] = [];
  const created: KiroSessionOptions[] = [];
  const deps: ReplDeps = {
    async createSession(opts: KiroSessionOptions): Promise<KiroSession> {
      created.push(opts);
      if (o.createFails) throw o.createFails;
      const s = sessions.length === 0 ? first : o.nextSession ? o.nextSession(opts) : new MockSession();
      s.ui = opts.ui;
      s.opts = opts;
      sessions.push(s);
      return s;
    },
    random: () => 0,
    ...(o.extraCommands ? { extraCommands: o.extraCommands } : {}),
    ...(o.importSessionExport ? { importSessionExport: o.importSessionExport } : {}),
  };
  const opts: RunReplOptions = {
    ctx,
    sessionOptions: o.sessionOptions ?? {},
    ...(o.initialInput !== undefined ? { initialInput: o.initialInput } : {}),
    ...(o.wrap ? { wrap: o.wrap } : {}),
  };
  const exit = runReplWith(opts, deps);
  if (o.input) stdin.write(o.input.map((l) => `${l}\n`).join(''));
  if (!o.keepOpen) stdin.end();
  const run: ReplRun = {
    stdin,
    stdout,
    stderr,
    out: () => stripAnsi(rawOut),
    raw: () => rawOut,
    err: () => stripAnsi(rawErr),
    exit,
    session: first,
    sessions,
    created,
    ws,
    t,
    async waitFor(s: string | RegExp, ms = 3000): Promise<void> {
      const start = Date.now();
      for (;;) {
        const txt = stripAnsi(rawOut);
        if (typeof s === 'string' ? txt.includes(s) : s.test(txt)) return;
        if (Date.now() - start > ms) throw new Error(`timed out waiting for ${String(s)}; output:\n${txt}`);
        await new Promise((r) => setTimeout(r, 5));
      }
    },
    send(line: string): void {
      stdin.write(`${line}\n`);
    },
    end(): void {
      stdin.end();
    },
  };
  return run;
}

/** Run to completion and return the stripped output. */
export async function runToEnd(o: StartOptions): Promise<{ code: number; out: string; run: ReplRun }> {
  const run = startRepl(o);
  const code = await run.exit;
  return { code, out: run.out(), run };
}

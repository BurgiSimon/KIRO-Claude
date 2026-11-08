/**
 * /chat new [prompt…] | resume | save <path> [-f] | load <path> | save-via-script <script> |
 * load-via-script <script>, the Classic aliases /save and /load, and /sessions (01 §5.6,
 * 06 §6.3 exact strings, 00 §2.5 export format owned by session/).
 *
 *  - `save`: an existing file without `-f/--force` ⇒ `File at <path> already exists. To
 *    overwrite, use -f or --force`; success `✔ Exported conversation state to <path>`;
 *    failure `Failed to export to <path>: <err>`. `~` is not expanded (Kiro).
 *  - `load`: tries `<path>` then `<path>.json` (Classic); the imported session replaces the
 *    current one; `✔ Imported conversation state from <path>` / `Failed to import from …`.
 *  - `*-via-script`: the script gets the export JSON on stdin / prints it on stdout and must
 *    exit 0 (util/process.runShell). It runs in a process group of its own (C12), which the
 *    terminal's SIGINT never reaches, while the session is idle (so the forced stop never ends
 *    the command, F0): Ctrl+C reaches it only through the command signal, which kills it. A
 *    cancelled run prints `Export via <script> was cancelled.` / `Import via <script> was
 *    cancelled.`, neither success nor failure, and loads nothing of what it printed (R1).
 *  - `new` / `resume` create a fresh / resumed KiroSession with the current agent, model and
 *    effort and close the old one.
 *  - `new`, `resume` and `load` keep the chat's current trust (`/tools untrust`, `/tools reset`,
 *    `t` answers; never the launch `--trust-tools` / `--trust-all-tools` again: Q keeps trust per
 *    process, its Load swaps the current agents into the loaded state) and plan mode; a record or
 *    export saved in plan mode comes back in it too (ReplContext.baseSessionOptions, activate).
 *  - Ctrl+C while `new` / `resume` / `load` run the next session's agentSpawn hooks (they can
 *    take long: V2 30 s, V3 60 s, 0 = never) cancels the command (K3): the command signal is the
 *    session's start signal (session/startSignal.ts), so its hooks are killed, nothing of it stays
 *    and the current session stays active (`Starting a new chat session was cancelled.`,
 *    `Resuming the chat session was cancelled.`, `Import from <path> was cancelled.`). A press
 *    while Claude Code then starts changes nothing. The current session is idle meanwhile, so no
 *    press force-stops it (F0).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isSessionStartCancelled, withStartSignal } from '../../session/startSignal.js';
import { SessionStore, formatListTime, formatSessionList, sessionsDir } from '../../session/store.js';
import { c } from '../../util/ansi.js';
import type { KiroSession } from '../../types.js';
import { runShell } from '../../util/process.js';
import { BUSY_MESSAGE, notSupported } from '../prompt.js';
import type { BuiltinCommand, ReplContext } from '../types.js';

const USAGE = [
  '/chat new [prompt…]              Start a new conversation (the current one is kept)',
  '/chat resume                     Resume another conversation of this directory',
  '/chat save <path> [-f|--force]   Export this conversation to a file',
  '/chat load <path>                Import a conversation exported with /chat save',
  '/chat save-via-script <script>   Pipe the export to a script (stdin)',
  '/chat load-via-script <script>   Import what a script prints (stdout)',
].join('\n');

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function saveTo(r: ReplContext, args: string[]): Promise<void> {
  const force = args.includes('-f') || args.includes('--force');
  const p = args.find((a) => a !== '-f' && a !== '--force');
  if (!p) {
    r.write(`\n${c.red('Usage: /chat save <path> [-f|--force]')}\n\n`);
    return;
  }
  const abs = path.resolve(r.ws.cwd, p);
  if (fs.existsSync(abs) && !force) {
    r.write(`\n${c.red(`File at ${p} already exists. To overwrite, use -f or --force`)}\n\n`);
    return;
  }
  try {
    await r.session.exportTo(abs, force);
    r.write(`\n${c.green(`✔ Exported conversation state to ${p}`)}\n\n`);
  } catch (e) {
    r.write(`\n${c.red(`Failed to export to ${p}: ${errText(e)}`)}\n\n`);
  }
}

/**
 * Create (and start) the next session with `create` and make it the active one; `'cancelled'`
 * when Ctrl+C (the command signal) cancelled its start: its creation runs under that signal
 * (withStartSignal), which kills its agentSpawn hooks and leaves nothing of it behind (K3), and
 * the current session stays active. A press once the hooks are done (Claude Code is starting) is
 * no failure: the session still becomes active (F0). A session whose start fails is closed (it
 * may already own a claude child and the session lock) and the current one stays active.
 */
async function activate(r: ReplContext, create: () => Promise<KiroSession>): Promise<KiroSession | 'cancelled'> {
  const planMode = r.session.planMode;
  let next: KiroSession;
  try {
    next = await withStartSignal(r.commandSignal, create);
  } catch (e) {
    if (isSessionStartCancelled(e)) return 'cancelled';
    throw e;
  }
  try {
    // plan mode is session state, like the trust the next session starts from
    // (ReplContext.baseSessionOptions): the next chat keeps the chat's (Kiro's plan mode is the
    // planner agent, which /chat new|load keep), set before the session becomes the chat's and
    // before any prompt reaches it (a KiroSessionImpl's create() has started Claude Code already:
    // the gate reads plan mode per tool call); a conversation saved in plan mode comes back in it
    // all the same (the more restrictive of the two)
    if (planMode && !next.planMode) next.planMode = true;
    await next.start();
    await r.swapSession(next);
  } catch (e) {
    await next.close().catch(() => undefined);
    throw e;
  }
  return next;
}

function cancelled(r: ReplContext, what: string): void {
  r.write(`\n${c.gray(`${what} was cancelled.`)}\n\n`);
}

/**
 * The chat's plan mode for the session that replaces it (KiroSessionOptions.planMode): on the
 * record from its first write, so a crash while the next session starts (its agentSpawn hooks)
 * never leaves it on disk outside plan mode; activate() sets it again for sessions that do not
 * take the option.
 */
function keepPlanMode(r: ReplContext): { planMode?: true } {
  return r.session.planMode ? { planMode: true } : {};
}

/** /chat new|resume|load replace the session: not while a turn runs (approval prompt). */
function assertIdle(r: ReplContext): void {
  if (r.busy) throw new Error(BUSY_MESSAGE);
}

/** Import `file` as the active session; false when Ctrl+C cancelled it (nothing was loaded). */
async function importFile(r: ReplContext, file: string): Promise<boolean> {
  assertIdle(r);
  return (await activate(r, () => r.importSession(file, keepPlanMode(r)))) !== 'cancelled';
}

export async function loadFrom(r: ReplContext, args: string[]): Promise<void> {
  const p = args[0];
  if (!p) {
    r.write(`\n${c.red('Usage: /chat load <path>')}\n\n`);
    return;
  }
  const abs = path.resolve(r.ws.cwd, p);
  const candidates = [abs, ...(abs.toLowerCase().endsWith('.json') ? [] : [`${abs}.json`])];
  const file = candidates.find((f) => {
    try {
      return fs.statSync(f).isFile();
    } catch {
      return false;
    }
  });
  if (!file) {
    r.write(`\n${c.red(`Failed to import from ${p}: No such file or directory`)}\n\n`);
    return;
  }
  try {
    if (!(await importFile(r, file))) return cancelled(r, `Import from ${p}`);
    r.write(`\n${c.green(`✔ Imported conversation state from ${p}`)}\n\n`);
  } catch (e) {
    r.write(`\n${c.red(`Failed to import from ${p}: ${errText(e)}`)}\n\n`);
  }
}

/** The command's Ctrl+C signal for runShell: it kills the script's process group (R1). */
function signalOf(r: ReplContext): { signal?: AbortSignal } {
  return r.commandSignal ? { signal: r.commandSignal } : {};
}

async function saveViaScript(r: ReplContext, script: string | undefined): Promise<void> {
  if (!script) {
    r.write(`\n${c.red('Usage: /chat save-via-script <script>')}\n\n`);
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-claude-export-'));
  try {
    const file = path.join(dir, 'session.json');
    await r.session.exportTo(file, true);
    const json = fs.readFileSync(file, 'utf8');
    const res = await runShell(script, { cwd: r.ws.cwd, env: r.ws.env, stdin: json, ...signalOf(r) });
    if (res.aborted) {
      r.write(`\n${c.gray(`Export via ${script} was cancelled.`)}\n\n`);
      return;
    }
    if (res.exitCode !== 0) {
      const why = res.error ?? (res.stderr.trim() || `exit status ${res.exitCode ?? res.signal}`);
      r.write(`\n${c.red(`Failed to export via ${script}: ${why}`)}\n\n`);
      return;
    }
    r.write(`\n${c.green(`✔ Exported conversation state via ${script}`)}\n\n`);
  } catch (e) {
    r.write(`\n${c.red(`Failed to export via ${script}: ${errText(e)}`)}\n\n`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function loadViaScript(r: ReplContext, script: string | undefined): Promise<void> {
  if (!script) {
    r.write(`\n${c.red('Usage: /chat load-via-script <script>')}\n\n`);
    return;
  }
  const res = await runShell(script, { cwd: r.ws.cwd, env: r.ws.env, maxOutputBytes: 256 * 1024 * 1024, ...signalOf(r) });
  if (res.aborted) {
    // whatever it printed before the Ctrl+C is not an export to load
    r.write(`\n${c.gray(`Import via ${script} was cancelled.`)}\n\n`);
    return;
  }
  if (res.exitCode !== 0) {
    const why = res.error ?? (res.stderr.trim() || `exit status ${res.exitCode ?? res.signal}`);
    r.write(`\n${c.red(`Failed to import via ${script}: ${why}`)}\n\n`);
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-claude-import-'));
  try {
    const file = path.join(dir, 'session.json');
    fs.writeFileSync(file, res.stdout, { mode: 0o600 });
    if (!(await importFile(r, file))) return cancelled(r, `Import via ${script}`);
    r.write(`\n${c.green(`✔ Imported conversation state via ${script}`)}\n\n`);
  } catch (e) {
    r.write(`\n${c.red(`Failed to import via ${script}: ${errText(e)}`)}\n\n`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function newChat(r: ReplContext, prompt: string): Promise<void | 'quit'> {
  assertIdle(r);
  const next = await activate(r, () => r.createSession({ ...r.baseSessionOptions(), ...keepPlanMode(r) }));
  if (next === 'cancelled') return cancelled(r, 'Starting a new chat session');
  r.write(`\n${c.green('✔ Started a new chat session')} ${c.gray(`(${next.id})`)}\n\n`);
  if (prompt.trim()) return r.submit(prompt);
}

async function resume(r: ReplContext): Promise<void> {
  assertIdle(r);
  const store = new SessionStore(sessionsDir(r.ws));
  const list = store.list({ cwd: r.ws.cwd }).filter((s) => s.sessionId !== r.session.id && s.forkKind !== 'tangent');
  if (list.length === 0) {
    r.write('\nNo saved chat sessions for this directory.\n\n');
    return;
  }
  const idx = await r.choose(
    'Select a session to resume',
    list.map((s) => `${formatListTime(s.updatedAt)}  ${s.title || s.lastPreview || '(untitled)'}  ${c.gray(`(${s.messageCount} messages, ${s.sessionId})`)}`),
  );
  if (idx === undefined) return;
  const rec = list[idx]!;
  const next = await activate(r, () =>
    r.createSession({ ...r.baseSessionOptions(), ...keepPlanMode(r), agentName: rec.agent, model: rec.model, ...(rec.effort ? { effort: rec.effort } : {}), resume: { sessionId: rec.sessionId } }),
  );
  if (next === 'cancelled') return cancelled(r, 'Resuming the chat session');
  r.write(`\n${c.magenta('Picking up where we left off...')}\n\n`);
}

export const chatCommand: BuiltinCommand = {
  name: 'chat',
  summary: 'Manage chat sessions (new, resume, save, load)',
  usage: USAGE,
  async run(args, raw, r) {
    const sub = args[0];
    const rest = args.slice(1);
    switch (sub) {
      case 'new':
        return newChat(r, raw.replace(/^\s*new\b/, ''));
      case 'resume':
        await resume(r);
        return;
      case 'save':
        await saveTo(r, rest);
        return;
      case 'load':
        await loadFrom(r, rest);
        return;
      case 'save-via-script':
        await saveViaScript(r, raw.replace(/^\s*save-via-script\s*/, '').trim() || undefined);
        return;
      case 'load-via-script':
        await loadViaScript(r, raw.replace(/^\s*load-via-script\s*/, '').trim() || undefined);
        return;
      case undefined:
      case 'help':
        r.write(`\n${USAGE}\n\n`);
        return;
      default:
        r.write(`${c.red(`Unknown subcommand: /chat ${sub}`)}\n\n${USAGE}\n\n`);
    }
  },
};

export const saveCommand: BuiltinCommand = {
  name: 'save',
  summary: 'Save the conversation to a file (= /chat save)',
  usage: '/save <path> [-f|--force]',
  async run(args, _raw, r) {
    await saveTo(r, args);
  },
};

export const loadCommand: BuiltinCommand = {
  name: 'load',
  summary: 'Load a conversation from a file (= /chat load)',
  usage: '/load <path>',
  async run(args, _raw, r) {
    await loadFrom(r, args);
  },
};

export const sessionsCommand: BuiltinCommand = {
  name: 'sessions',
  summary: 'List the saved sessions of this directory',
  async run(args, _raw, r) {
    if (args[0]) {
      r.write(`${c.yellow(notSupported(`sessions ${args[0]}`))}\n`);
      return;
    }
    const store = new SessionStore(sessionsDir(r.ws));
    r.write(`\n${formatSessionList(store.list({ cwd: r.ws.cwd }), 'plain')}\n\n`);
  },
};

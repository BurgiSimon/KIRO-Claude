/**
 * `kiro-claude chat [OPTIONS] [INPUT]` (01 §3, 00 §2.2 "Agent selection", §2.5 rows "Model list",
 * "--model", "--resume…"; 08 §2.2 KC-CLI-03/06/07).
 *
 * Order of work:
 *  1. parse (clap-style errors exit 2); `--agent-engine v3` gets 08 KC-CLI-10's wording, exit 2;
 *  2. not supported: `--cloud` / `--sandbox` ⇒ message, exit 1;
 *  3. fast paths that never spawn Claude: `--list-models` (cache or static list, 08 KC-CLI-06:
 *     JSON is the object `{"models":[…]}`), `--list-sessions`, `--delete-session <id>` (the
 *     index file, its lock and the kiro-cli journal `<id>.jsonl`; never Claude transcripts), and the
 *     headless local commands that need no session (`/usage`, `/help`, `/agent list`, `/prompts`,
 *     `/quit`; headless/local.ts), handed straight to the headless runner before agent resolution —
 *     whether they come as INPUT or, without INPUT, from piped stdin (read here for that reason);
 *  4. agent: `--agent` > `chat.defaultAgent` > `kiro_default` (config/agents selectAgent).
 *     `--no-interactive` with an unavailable `--agent` (or, on a fresh run, an unavailable
 *     `chat.defaultAgent`) ⇒ `stopping (exit 4)`; interactive ⇒ Q's fallback warnings;
 *  5. model: an explicit `--model` that is not a Claude model ⇒ Q's
 *     `Model '<id>' does not exist. Available models: …`, exit 1 (agent/default models are the
 *     session's business: warning + fallback);
 *  6. sessions: `--resume` (newest for this directory; none ⇒ `No saved chat sessions for this
 *     directory. Starting a new session.`), `--resume-id <id>` (exact id or unique prefix;
 *     unknown ⇒ exit 1), `--resume-picker` / `--sessions` (numbered prompt on stderr/stdin).
 *     A resumed session keeps its stored agent/model/effort unless given explicitly;
 *  7. trust: `-a/--trust-all-tools`; `--trust-tools=a,b` (`--trust-tools=` = none) with Q's
 *     warning for custom tools without `@server/` (06 §1.1 / 01 §3);
 *  8. interactive ⇒ repl `runRepl`, `--no-interactive` ⇒ headless `runHeadless`
 *     (`--output-format` needs `--no-interactive`; `--require-mcp-startup` only applies there).
 *
 * Accepted and ignored: `--v2`, `--v3`, `--tui`, `--classic`, `--legacy-ui`, `--agent-engine
 * v1|v2`, `--trust-workspace`, `--repo`. `--profile` is a deprecated alias of `--agent`
 * (`WARNING: --profile is deprecated, use --agent instead`).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CliContext, SessionRecord } from '../../types.js';
import { loadAgents, selectAgent } from '../../config/agents.js';
import { buildModelList, formatModelList, kiroToClaudeModel, readModelCache } from '../../models/models.js';
import { SessionStore, formatListTime, formatSessionList, sessionsDir } from '../../session/store.js';
import { levelFromVerbosity, log } from '../../util/log.js';
import type { ParsedArgs } from '../args.js';
import { loadRunRepl, type FrontEndSessionOptions, type RunReplFn } from '../entries.js';
import { classifyHeadlessInput } from '../../headless/local.js';
import { err, out, parseOrExit, readAll, readLine } from '../io.js';
import { CHAT_DEF } from './chatArgs.js';

export { CHAT_DEF } from './chatArgs.js';

/** src/headless/run.ts `runHeadless` (RULES signature). */
export type RunHeadlessFn = (opts: {
  ctx: CliContext;
  sessionOptions: FrontEndSessionOptions;
  input: string;
  outputFormat?: 'text' | 'stream-json';
  requireMcpStartup?: boolean;
}) => Promise<number>;

/** Injectable front ends (tests, embedding). */
export interface ChatDeps {
  runRepl?: RunReplFn;
  runHeadless?: RunHeadlessFn;
}

/** 08 KC-CLI-10 wording (also used for `chat`). */
export const AGENT_ENGINE_V3_ERROR =
  "error: invalid value 'v3' for '--agent-engine <ENGINE>'\n  [possible values: v1, v2]\n\nkiro-claude has no v3 (KAS) agent engine.";

/** Kiro tool names (V2, Kiro 2.x aliases, V3 ids) that are not custom MCP tools (06 §1.1). */
const NATIVE_TOOL_NAMES = new Set([
  '*', 'read', 'fs_read', 'fsRead', 'read_file', 'list_directory', 'file_search', 'glob', 'grep_search', 'grep',
  'write', 'fs_write', 'fsWrite', 'str_replace', 'fs_append', 'delete_file', 'shell', 'execute_bash', 'execute_cmd',
  'executeCmd', 'execute_pwsh', 'web', 'web_fetch', 'remote_web_search', 'web_search', 'subagent', 'invoke_sub_agent',
  'use_subagent', 'agent_crew', 'todo_list', 'todo', 'task', 'skill', 'disclose_context', 'context', 'knowledge',
  'introspect', 'code', 'use_aws', 'aws', 'thinking', 'delegate', 'report', 'report_issue', 'gh_issue', 'session',
  'goal', 'tool_search', 'use_mcp_tool',
]);

/** Split `--trust-tools` (comma list; empty = none) and collect Q's custom-tool warnings. */
export function parseTrustTools(raw: string): { tools: string[]; warnings: string[] } {
  const tools = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  const warnings: string[] = [];
  for (const t of tools) {
    if (t.startsWith('@') || t.startsWith('subagent/') || NATIVE_TOOL_NAMES.has(t)) continue;
    warnings.push(`WARNING: --trust-tools arg for custom tool ${t} needs to be prepended with @{MCPSERVERNAME}/`);
  }
  return { tools, warnings };
}

/** `--list-models` output (08 KC-CLI-06): cached live list, else the static list; no Claude spawn. */
export function listModelsText(env: NodeJS.ProcessEnv, format: 'plain' | 'json' | 'json-pretty'): string {
  const cache = readModelCache(env);
  const entries = buildModelList(cache?.models.length ? cache.models : undefined, cache?.contextWindows);
  return formatModelList(entries, format);
}

/** Resolve `--resume-id` (exact id, else a unique id prefix across all saved sessions). */
export function resolveSessionId(store: SessionStore, id: string): { record?: SessionRecord; error?: string } {
  const exact = store.read(id);
  if (exact) return { record: exact };
  const matches = id.length >= 4 ? store.list().filter((r) => r.sessionId.startsWith(id)) : [];
  if (matches.length === 1) return { record: matches[0]! };
  if (matches.length > 1) return { error: `error: session id '${id}' is ambiguous (${matches.length} sessions match)` };
  return { error: `error: no saved chat session with id '${id}'` };
}

async function pickSession(ctx: CliContext, records: SessionRecord[]): Promise<SessionRecord | undefined> {
  err(ctx, 'Saved chat sessions for this directory:');
  records.forEach((r, i) => {
    const title = r.title || r.lastPreview || '(untitled)';
    const n = `${r.messageCount} ${r.messageCount === 1 ? 'message' : 'messages'}`;
    err(ctx, `  ${String(i + 1).padStart(2)}) ${title}  (${formatListTime(r.updatedAt)}, ${n})  ${r.sessionId}`);
  });
  for (;;) {
    ctx.stderr.write(`Select a session to resume [1-${records.length}] (Enter to start a new session): `);
    const line = await readLine(ctx.stdin);
    if (line === undefined || line.trim() === '') return undefined;
    const k = Number.parseInt(line.trim(), 10);
    if (Number.isInteger(k) && k >= 1 && k <= records.length && String(k) === line.trim()) return records[k - 1];
    err(ctx, `Please enter a number between 1 and ${records.length}.`);
  }
}

/** Piped stdin as text (`undefined` for a TTY; '' when it is closed or unreadable). */
async function readPipedStdin(stdin: NodeJS.ReadableStream & { isTTY?: boolean; readableEnded?: boolean; destroyed?: boolean }): Promise<string | undefined> {
  if (stdin.isTTY) return undefined;
  if (stdin.readableEnded || stdin.destroyed) return '';
  try {
    return await readAll(stdin);
  } catch {
    return '';
  }
}

function formatOf(p: ParsedArgs): 'plain' | 'json' | 'json-pretty' {
  const f = p.value('format');
  return f === 'json' || f === 'json-pretty' ? f : 'plain';
}

/** `chat` subcommand runner (see module doc). */
export async function runChatCommand(args: string[], ctxIn: CliContext, deps: ChatDeps = {}): Promise<number> {
  let ctx = ctxIn;
  // 08 KC-CLI-10 wording for the rejected engine.
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') break;
    if (a === '--agent-engine=v3' || (a === '--agent-engine' && args[i + 1] === 'v3')) {
      err(ctx, AGENT_ENGINE_V3_ERROR);
      return 2;
    }
  }
  const parsed = parseOrExit(CHAT_DEF, args, ctx);
  if (typeof parsed === 'number') return parsed;
  const p = parsed;
  const env = ctx.ws.env;

  const verbosity = ctx.verbosity + p.count('verbose');
  if (p.count('verbose') > 0) {
    log.setLevel(levelFromVerbosity(verbosity, log.level));
    // `chat -v` counts like a root `-v` for the front ends (CliContext.verbosity).
    ctx = { ...ctx, verbosity };
  }

  if (p.has('cloud')) {
    err(ctx, 'error: cloud sessions are not supported in kiro-claude (it runs your local Claude Code)');
    return 1;
  }
  if (p.has('sandbox')) {
    err(ctx, 'error: --sandbox is not supported in kiro-claude (no local command sandbox is available)');
    return 1;
  }
  if (args.some((a) => a === '--profile' || a.startsWith('--profile='))) err(ctx, 'WARNING: --profile is deprecated, use --agent instead');

  // ── fast paths ──
  if (p.has('list-models')) {
    out(ctx, listModelsText(env, formatOf(p)));
    return 0;
  }
  if (p.has('list-sessions') || p.has('delete-session')) {
    const store = new SessionStore(sessionsDir(ctx.ws));
    if (p.has('delete-session')) {
      const id = p.value('delete-session')!;
      const lock = store.read(id) ? store.lockInfo(id) : undefined;
      // A live holder refuses, except a chat stopped for good with a hangup or kill pending (sudo
      // use_pty after its terminal closed): acquireLock continues it so that it closes, as for
      // `chat --resume` (session/store.ts, "Hung-up holder"); the lock is held while deleting, so
      // that chat's last write (its record made the newest) cannot bring the record back. A chat
      // that never had a message drops its record at that close: gone as asked, so it is deleted.
      let held: { release(): void } | undefined;
      if (lock?.live && lock.pid !== process.pid) {
        try {
          held = store.acquireLock(id);
        } catch {
          err(ctx, `error: Session is active in another process (PID ${store.lockInfo(id)?.pid ?? lock.pid})`);
          return 1;
        }
      }
      const deleted = store.delete(id) || (held !== undefined && !store.read(id));
      held?.release();
      if (!deleted) {
        err(ctx, `error: no saved chat session with id '${id}'`);
        return 1;
      }
      // The kiro-cli journal next to the index file (08 KC-FS-03; session/kiroFiles.ts
      // `journalPath`, restated here because Wave-2 modules only share fixed entry points)
      // belongs to the deleted session too. Claude transcripts are never touched (00 §2.5).
      try {
        fs.rmSync(path.join(store.dir, `${id}.jsonl`), { force: true });
      } catch {
        // best effort: the index entry is gone, which is what lists and resumes read
      }
      out(ctx, `Deleted chat session ${id}`);
      return 0;
    }
    const records = store.list({ cwd: ctx.ws.cwd });
    const fmt = formatOf(p);
    if (fmt === 'plain') out(ctx, formatSessionList(records, 'plain'));
    else {
      const text = formatSessionList(records, 'json');
      out(ctx, fmt === 'json' ? text : JSON.stringify(JSON.parse(text), null, 2));
    }
    return 0;
  }

  const interactive = !p.has('no-interactive');
  const input = p.pos('input');
  const outputFormat = p.value('output-format') as 'text' | 'stream-json' | undefined;
  if (interactive && outputFormat === 'stream-json') {
    err(ctx, "error: '--output-format stream-json' requires '--no-interactive'\n\nFor more information, try '--help'.");
    return 2;
  }
  const runHeadless: RunHeadlessFn =
    deps.runHeadless ?? (async (o) => (await import('../../headless/run.js')).runHeadless(o));

  // Headless local commands without a session (/usage, …): answered before anything else
  // (08 KC-CLI-07). The task comes from INPUT or, without it, from piped stdin (01 §3), which is
  // read here so both paths behave the same; runHeadless gets the text and does not read again.
  let headlessInput = input;
  if (!interactive) {
    if (headlessInput === undefined || headlessInput.trim() === '') {
      const piped = await readPipedStdin(ctx.stdin);
      if (piped !== undefined) headlessInput = piped;
    }
    const text = (headlessInput ?? '').trim();
    if (text.startsWith('/')) {
      const kind = classifyHeadlessInput(text, ctx.ws, ctx.settings).kind;
      if (kind === 'output' || kind === 'quit') {
        return runHeadless({ ctx, sessionOptions: { env }, input: headlessInput!, ...(outputFormat ? { outputFormat } : {}) });
      }
    }
  }

  if (env.KIRO_API_KEY) err(ctx, 'WARNING: KIRO_API_KEY is ignored: kiro-claude uses your Claude Code login');

  // ── sessions ──
  const resumeFlags = p.has('resume') || p.has('resume-id') || p.has('resume-picker') || p.has('sessions');
  let resume: SessionRecord | undefined;
  if (resumeFlags) {
    const store = new SessionStore(sessionsDir(ctx.ws));
    if (p.has('resume-id')) {
      const r = resolveSessionId(store, p.value('resume-id')!);
      if (!r.record) {
        err(ctx, r.error!);
        return 1;
      }
      resume = r.record;
    } else {
      const records = store.list({ cwd: ctx.ws.cwd }).filter((r) => r.forkKind !== 'tangent');
      // `--resume` continues the user's latest chat; KiroCrew/ACP sessions in the same directory
      // are skipped (store.latestResumable). The picker still lists every session.
      const latest = p.has('resume') ? store.latestResumable(ctx.ws.cwd) : undefined;
      if (p.has('resume') ? latest === undefined : records.length === 0) {
        err(ctx, 'No saved chat sessions for this directory. Starting a new session.');
      } else if (p.has('resume')) {
        resume = latest;
      } else {
        if (!interactive) {
          err(ctx, 'error: --resume-picker needs interactive mode; use --resume-id <ID> with --no-interactive');
          return 1;
        }
        resume = await pickSession(ctx, records);
        if (!resume) err(ctx, 'No session selected. Starting a new session.');
      }
    }
  }

  // ── agent ──
  const requested = p.value('agent');
  let agentName: string | undefined;
  if (!resume || requested !== undefined) {
    const loaded = loadAgents(ctx.ws, { settings: ctx.settings });
    const sel = selectAgent(ctx.ws, loaded.agents, ctx.settings, requested, { interactive });
    if (!interactive && (sel.missingRequested !== undefined || (sel.missingDefault !== undefined && !resume))) {
      const name = (sel.missingRequested ?? sel.missingDefault)!;
      const failure = loaded.failed.get(name);
      if (failure) err(ctx, `Error: agent ${name} could not be loaded: ${failure.message}`);
      else err(ctx, `Error: no agent with name ${name} found`);
      err(ctx, 'stopping (exit 4)');
      return 4;
    }
    for (const w of sel.warnings) err(ctx, w.message);
    agentName = sel.agent.name;
  }

  // ── model ──
  const model = p.value('model');
  if (model !== undefined) {
    const r = kiroToClaudeModel(model, readModelCache(env)?.models);
    if (r.error) {
      err(ctx, `error: ${r.error}`);
      return 1;
    }
  }

  // ── trust ──
  let trustTools: string[] | undefined;
  if (p.has('trust-tools')) {
    const t = parseTrustTools(p.value('trust-tools') ?? '');
    for (const w of t.warnings) err(ctx, w);
    trustTools = t.tools;
  }

  const claudePath = ctx.settings.getString('kiroClaude.claudePath');
  const allowApiKey = p.has('use-api-key') || ctx.settings.getBoolean('kiroClaude.allowApiKey', false);
  const effort = p.value('effort');
  const sessionOptions: FrontEndSessionOptions = {
    ...(agentName !== undefined ? { agentName } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(p.has('trust-all-tools') ? { trustAllTools: true } : {}),
    ...(trustTools !== undefined ? { trustTools } : {}),
    ...(resume ? { resume: { sessionId: resume.sessionId } } : {}),
    env,
    ...(claudePath ? { claudePath } : {}),
    ...(allowApiKey ? { allowApiKey: true } : {}),
  };

  if (!interactive) {
    return runHeadless({
      ctx,
      sessionOptions,
      input: headlessInput ?? '',
      ...(outputFormat ? { outputFormat } : {}),
      ...(p.has('require-mcp-startup') ? { requireMcpStartup: true } : {}),
    });
  }
  const runRepl = deps.runRepl ?? (await loadRunRepl());
  const wrap = p.value('wrap') as 'always' | 'never' | 'auto' | undefined;
  return runRepl({ ctx, sessionOptions, ...(input !== undefined ? { initialInput: input } : {}), ...(wrap ? { wrap } : {}) });
}

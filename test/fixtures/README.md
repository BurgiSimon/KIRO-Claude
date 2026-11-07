# Test fixtures

## `fake-claude.mjs` — scriptable stand-in for the Claude Code CLI

A zero-dependency Node script that behaves like `claude` **2.1.318** in headless stream-json
mode, as verified in the research notes (00-synthesis §3, 04-claude-protocol, 07-verified-gate).
Every suite that needs a Claude child (claude/, session/, REPL, headless, ACP, spec) should use it
instead of the real binary. Real-binary tests live in `test/e2e/` and only run with
`KIRO_CLAUDE_E2E=1`.

### Using it

```ts
import { fakeBinary, startFake, collectTurn, STREAM_ARGS } from '../claude/helpers.js';

// A ClaudeBinary pointing at the script. `.mjs` paths are spawned as `node <script>` by
// src/claude/binary.ts resolveSpawn(), so this works on every OS.
const bin = fakeBinary(); // { path: '<repo>/test/fixtures/fake-claude.mjs', version: '2.1.318', ... }

// Or let the helper start a ClaudeProcess with a script and a private log file:
const h = await startFake({
  script: { turns: [{ steps: [{ text: 'hello' }] }] },
  args: ['--session-id', '0f8fad5b-d9cb-469f-a165-70867728950e'],
  initialize: { hooks: { PreToolUse: [{ hookCallbackIds: ['kiro_pre'] }] } },
  handlers: { onHookCallback: async () => ({}) },
});
const { frames, result } = await collectTurn(h.proc.turn('hi'));
h.stdinLines(); // every line the fake received (parsed)
h.log();        // the whole FAKE_CLAUDE_LOG
await h.proc.close();
```

Other ways to point code at the fake: `KIRO_CLAUDE_BIN=<abs path to fake-claude.mjs>` (picked up by
`findClaudeBinary`), or a symlink named `claude` on `PATH` (POSIX; the shebang needs `node` on
`PATH`). `test/claude/helpers.ts` → `fakeClaudePath()` locates the script from the source tree, from
`dist/`, or from any out dir (walks up from `process.cwd()`); `KIRO_CLAUDE_FAKE` overrides.

### Command line

| Invocation | Behaviour |
|---|---|
| `--version` / `-v` | prints `2.1.318 (Claude Code)` (`FAKE_CLAUDE_VERSION` overrides the number) |
| `--help` / `-h` | prints the real 2.1.318 help text verbatim (hidden flags such as `--permission-prompt-tool`, `--append-system-prompt-file`, `--resume-session-at` are absent, as in the real CLI) |
| `auth status [--json]` | `{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}`, exit 0; with `FAKE_CLAUDE_LOGGED_OUT=1`: `{"loggedIn":false,"authMethod":"none",…}`, exit 1. `--text` prints a human-readable variant |
| `auth login …` / `auth logout` | writes `fake-claude: auth …` to stderr, exits `FAKE_CLAUDE_AUTH_EXIT` (default 0) |
| anything else | headless stream mode (below) |

Stream mode requires `-p`, `--input-format stream-json`, `--output-format stream-json` and
`--verbose` (missing `--verbose` fails with the real error text). Options are parsed like the real
commander CLI: **unknown options are fatal** (`error: unknown option '--x'`, exit 1), value/variadic
options are honoured (`--tools ""`, `--setting-sources ""`, repeated `--add-dir`, …). Also validated
like the real CLI: `--permission-mode`, `--effort`, `--setting-sources`, `--session-id` (UUID),
`--resume-session-at` (requires `--resume`), `--session-id` + `--resume` (requires `--fork-session`).

Flags with an effect: `--session-id`, `--resume`, `--fork-session`, `--resume-session-at`,
`--continue`, `--model` (aliases `default|opus|sonnet|haiku|fable|best` resolve to the 2.1.318 ids),
`--effort`, `--permission-mode`, `--permission-prompt-tool stdio` (without it an `ask` is denied),
`--include-partial-messages` (stream_event deltas), `--replay-user-messages`, `--tools` (exact
`init.tools` semantics: `Agent`→`Task`, unknown names dropped, `TaskStop` added implicitly, `""` = none),
`--disallowedTools`, `--mcp-config` (JSON or file; servers appear in `init.mcp_servers` /
`mcp_status`), `--max-turns`, `--no-session-persistence`.

### Wire behaviour

* Answers `initialize` with `commands`, `agents`, `models` (the real 2.1.318 list), `account`,
  `pid`, `claude_code_version`, `current_permission_mode`, `hooks_applied`; stores the `hooks`
  registration (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`; `matcher` honoured as a
  `^(?:matcher)$` regex, omitted/`*` = all tools).
* Every turn starts with `system/init` (session id, tools, model, permissionMode, `apiKeySource`
  = `"ANTHROPIC_API_KEY"` if that env var is set, else `"none"`) and `system/status requesting`, and
  ends with exactly one `result` (`num_turns`, `usage`, cumulative `total_cost_usd`/`modelUsage`,
  `permission_denials`, `user_message_uuid(s)`, `session_id`, `result_index`).
* User lines with a `uuid` get `command_lifecycle` `queued` → `started` → `completed` (after the
  result; `cancelled` instead for a line whose turn was interrupted). `priority:"now"` interrupts
  the running turn; anything else without `priority:"next"` is queued as its own turn.
* `priority:"next"` while a turn runs models claude 2.1.319's queue (VERIFIED with haiku): the line
  waits in the running turn's queue, and the queue is snapshotted **right after a tool boundary's
  `tool_result` frames, in the same tick** — so a line the host writes after *seeing* those frames
  waits for the following boundary. At a boundary the waiting lines are folded in (`started` right
  after the tool_result, uuid added to the turn's result, `completed` just before that result,
  their text in `{{steerText}}`). Lines that find no further boundary run next, each as its own turn
  right after the result (own `completed` → steer `started` → `system/init` …). A boundary inside a
  subagent (`parent_tool_use_id`) or of an interrupted turn folds nothing.
* Host control requests: `initialize`, `interrupt` (aborts the running turn; the plain interrupt
  keeps queued lines and answers `{"still_queued":[<uuids>]}` — they run after the interrupted
  result; `cancel_queued:true` drops them: `command_lifecycle cancelled` for each, then
  `{"still_queued":[],"cancelled":[<uuids>]}`, both VERIFIED 2.1.319), `cancel_async_message`
  (`{message_uuid}`: a line still queued — a `next` line not folded in yet, or one waiting for its
  own turn — is dropped, `command_lifecycle cancelled`, then `{"cancelled":true}`; otherwise
  `{"cancelled":false}`; VERIFIED 2.1.319),
  `set_model` (`{"model":<resolved>}`, `null`/`"default"` resets), `set_permission_mode`,
  `set_max_thinking_tokens`, `get_context_usage`, `mcp_status`, `get_settings`
  (`applied.model/effort`), `get_session_cost`; anything else →
  `{"subtype":"error","error":"Unsupported control request subtype: <x>"}`.
* Local slash commands (no script consumed): `/clear` (`conversation_reset` with the **old**
  session id, then everything carries a new id; `result.local_command:"clear"`), `/compact [instr]`
  (`system/status compacting` → `compact_boundary` → synthetic summary user frame → result
  `local_command:"compact"`, same id), `/effort <level>`, `/model [name]`, `/cost`, `/usage`,
  `/context`, `/help`. Any other `/x` is "forwarded to the model", i.e. handled by the script.
* A non-JSON stdin line is fatal (`Error parsing streaming input line …`, exit 1), like the real CLI.
* stdin EOF: finishes queued turns and exits 0 (1 if the last result was an error). If a CLI→host
  request is pending at EOF the running turn is aborted (nobody can answer any more).
* SIGTERM → exit code 143.

### Tool calls and the gate

For each tool step the fake emits the `assistant` `tool_use` frame, then:

1. **PreToolUse**: one `hook_callback` per registered matching callback id
   (`input`: `session_id, transcript_path, cwd, prompt_id, permission_mode, effort,
   hook_event_name, tool_name, tool_input, tool_use_id` [+ `agent_id/agent_type`, `mcp_server`]).
   Most restrictive answer wins (`deny` > `ask` > `allow`); `additionalContext` and `updatedInput`
   are applied. An `error` answer with `onFailure:"block"` denies with the verified 2.1.318 text
   (`[callback]: failed; blocking because onFailure is "block"\nHook callback <id> failed: …`).
2. `deny` ⇒ tool_result `is_error:true`, content `PreToolUse:<Tool> hook error: <reason>`, listed in
   `permission_denials`.
3. `ask` ⇒ `can_use_tool` (`decision_reason`, `decision_reason_type:"hook"`, `blocked_path` for
   `file_path` inputs). No hook decision ⇒ Claude's own flow: read-only tools (`Read`, `Glob`, `Grep`,
   `Task*`, `Skill`, `Agent`) run, others `ask` (override per step with `"permission"`;
   `bypassPermissions` mode allows, `dontAsk` denies, `acceptEdits` allows file edits).
   Answer `allow` (+`updatedInput`) runs the tool; `deny` shows `message` verbatim; `deny` +
   `interrupt:true` ends the turn `error_during_execution` / `aborted_tools`.
4. After running: `PostToolUse` (`tool_response`, `duration_ms`) or, for `is_error` results,
   `PostToolUseFailure` (`error`, `is_interrupt`), if registered.
5. The `user` `tool_result` frame (+ structured `tool_use_result`).

On `interrupt` (or a step's `cancelAfterMs`) every pending CLI→host request is withdrawn with
`control_cancel_request` (VERIFIED behaviour of the real CLI for `can_use_tool`), interrupted tools
get the real "The user doesn't want to proceed…" text, a `[Request interrupted by user for tool use]`
user frame follows, and the result is `error_during_execution` (`aborted_tools`, or
`aborted_streaming` when no tool was involved).

### Script format (`$FAKE_CLAUDE_SCRIPT` = JSON file, or `$FAKE_CLAUDE_SCRIPT_JSON` = inline JSON)

```json
{
  "turns": [
    { "match": "^deploy", "flags": "i", "steps": [ … ] },
    { "repeat": true, "match": "status", "steps": [ … ] },
    { "steps": [ … ] }
  ],
  "default": { "steps": [{ "text": "ok" }] }
}
```

For each (non-local) user message the fake picks the **first unused** turn whose `match` regex
(with optional `flags`) matches the user text (string content, or text blocks joined; images render
as `[image]`). Turns without `match` match anything. A used turn is skipped afterwards unless
`"repeat": true`. Nothing left ⇒ `default` ⇒ `{"steps":[{"text":"ok"}]}`.
`$FAKE_CLAUDE_STATE_FILE` persists the set of used turns across processes (for respawn tests).

Steps (executed in order; consecutive text/thinking steps share one assistant message, a tool step
closes it; `num_turns` counts messages):

| Step | Effect |
|---|---|
| `{"text": "…", "chunks"?: ["…"], "chunkDelayMs"?: n, "parent_tool_use_id"?: "toolu_…"}` | assistant `text` block (+ `text_delta` stream events with `--include-partial-messages`, split by words unless `chunks` given). Top-level text of the last message becomes `result.result`. |
| `{"thinking": "…"}` | assistant `thinking` block (+ `thinking_delta`) |
| `{"tool": {"name": "Bash", "input": {…}, "result"?: "…" \| {…}, "is_error"?: bool, "tool_use_result"?: any, "id"?: "toolu_x", "durationMs"?: n, "permission"?: "allow"\|"ask"\|"deny", "cancelAfterMs"?: n, "agent_id"?: "…", "agent_type"?: "…", "parent_tool_use_id"?: "…"}}` | one tool call through the gate (above). `result` defaults per tool (`(Bash completed with no output)`, `1\tcontents of <file_path>`, …). `durationMs` = interruptible run time. `cancelAfterMs` = if `can_use_tool` is not answered in time, send `control_cancel_request` and abort the turn. `agent_*` = call made inside a subagent. |
| `{"parallel": [toolSpec, toolSpec, …]}` | several tool_use blocks in one message; gates run concurrently; results emitted in order |
| `{"sleepMs": n}` | wait (interruptible) |
| `{"error": "authentication_failed" \| "rate_limit" \| "billing_error" \| "overloaded" \| …, "text"?: "…"}` | synthetic assistant frame with top-level `error` (`Not logged in · Please run /login` for auth), then result `is_error:true`, `terminal_reason:"api_error"`; remaining steps skipped |
| `{"result": {…}}` | fields merged into this turn's result frame (e.g. `{"stop_reason":"refusal"}`) |
| `{"control": {"subtype": "elicitation", …}}` | send a CLI→host control_request and wait; the raw answer is available as `{{lastControlResponse}}` |
| `{"frame": {…}}` | emit an arbitrary frame (`session_id`/`uuid` filled in), e.g. `rate_limit_event`, `system/task_started`, unknown types |
| `{"raw": "…", "noNewline"?: true}` | write a raw stdout line (malformed-line tests) |
| `{"stderr": "…"}` | write a line to stderr |
| `{"exit": code, "stderr"?: "…"}` | crash immediately with that exit code (mid-turn crash tests) |

Template variables, substituted in every string of `text`, `thinking`, tool specs, `frame`,
`control` and `result`: `{{userText}}`, `{{sessionId}}`, `{{model}}`, `{{effort}}`, `{{cwd}}`,
`{{lastToolResult}}` (content of the last tool_result, e.g. a denial text the "model saw"),
`{{steerText}}` (texts of the `priority:"next"` lines folded into this turn so far, ` | `),
`{{lastHookContext}}` (last `additionalContext` from a hook callback), `{{lastControlResponse}}`,
`{{turnIndex}}` (user messages processed by this process, local commands included),
`{{historyCount}}` / `{{historyUserTexts}}` (user messages in the session history — includes resumed
history when persistence is on, not the entries of local commands; joined with ` | `), `{{env:NAME}}`.

### Persistence (opt-in): `FAKE_CLAUDE_PERSIST=1` + `CLAUDE_CONFIG_DIR=<temp dir>`

Transcripts are written to `$CLAUDE_CONFIG_DIR/projects/<cwd with [^A-Za-z0-9]→'-'>/<sid>.jsonl`
(user/assistant/tool_result lines with `uuid`, `parentUuid`, `sessionId`, `cwd`, `version`; the user
line uuid is the uuid the host sent). With persistence on, the fake mimics the real session rules:
`--session-id` of an existing transcript → `Error: Session ID <id> is already in use.` (exit 1);
`--resume <unknown>` → `No conversation found with session ID: <id>` + an `error_during_execution`
result, exit 1; `--resume` keeps id + history; `--fork-session` copies history to a new id (original
untouched) and, like the real claude 2.1.319, writes the fork's transcript only when the fork gets its
first user line: a fork that exits without one leaves no transcript, so `--resume <fork id>` (or a
fork of it) reports `No conversation found`; a fork onto a `--session-id` whose transcript exists
(`--resume X --fork-session --session-id T`, T already written, e.g. a re-fork of a fork that got its
first line; also `--continue --fork-session --session-id T`) is refused like a new start onto it, as
by the real claude 2.1.319: stderr `Error: Session ID T is already in use.`, exit 1, nothing on
stdout, nothing written (T is not overwritten), and that check comes before any session is loaded
(the same answer when X has no transcript; kiro-claude then resumes T, see
`test/spec/fake-refork.test.ts`). As in the real CLI, only the cwd's project dir counts, and a fork
onto the id it resumes (`--resume T --fork-session --session-id T`) is exempt (exit 0; the fake
then continues T, what the real claude writes into T then is not verified). A fork onto an id
without a transcript (a fork that never got a line) forks again; `--session-id` with `--resume` or
`--continue` but no `--fork-session` is rejected (`Error: --session-id can only be used with
--continue or --resume if --fork-session is also specified.`); `--resume-session-at <uuid>` keeps history up to and
including that line, and, like the real claude 2.1.319, a uuid the resumed transcript does not hold
(with or without `--fork-session`) fails: stderr `No message found with message.uuid of: <uuid>`, an
`error_during_execution` result on stdout (`errors: [that text]`), exit 1, nothing written (a
missing transcript still reports `No conversation found` first); `--continue` picks the newest
transcript of the cwd (with `--fork-session` too: the fake does not fork a continued session); `/clear` starts a new transcript.
A local command line (`/effort`, `/compact`, `/model`, `/cost`, `/usage`, `/context`) is part of the
transcript, as in the real claude 2.1.319 (VERIFIED for `/effort`, `/compact`, `/model`, `/cost` and
`/context` as the only line of a new session, of a resumed one and of a fork that had no line yet):
it appends a meta `<local-command-caveat>` user entry, a `<command-name>/x</command-name>…` user
entry carrying the uuid of the line the host sent, and a `system`/`local_command`
`<local-command-stdout>` entry (shapes abridged; the fake marks them `localCommand: true` so
`{{historyUserTexts}}` skips them), so a new session or a pending fork then HAS a transcript:
`--resume <id>` and a fork of it find a conversation. `/clear` and `/help` write nothing (the real
2.1.319 writes a file for `/clear`'s new session; not modeled). Without persistence any `--resume` id is
accepted with empty history (and `--resume-session-at` cuts nothing). Never point
`CLAUDE_CONFIG_DIR` at a real config dir.

### Environment variables

| Variable | Effect |
|---|---|
| `FAKE_CLAUDE_SCRIPT` / `FAKE_CLAUDE_SCRIPT_JSON` | script file / inline script |
| `FAKE_CLAUDE_STATE_FILE` | persist consumed turns across processes |
| `FAKE_CLAUDE_LOG` | JSONL log: `{"event":"start","argv","cwd","env":<CLAUDE*/ANTHROPIC*/KIRO*/FAKE_CLAUDE*/CCR_*/NODE_OPTIONS/DEBUG/AI_AGENT, secrets masked as "<set>">}`, `{"event":"stdin","line":<parsed>}` (or `"raw"`), `turn`, `cancel_sent`, `unmatched_control_response` (a duplicate/unknown answer from the host), `stdin_end`, `sigterm`, `exit` |
| `FAKE_CLAUDE_LOG_STDOUT=1` | also log every emitted frame (`event:"stdout"`) |
| `FAKE_CLAUDE_VERSION` | version reported by `--version` / init |
| `FAKE_CLAUDE_LOGGED_OUT=1` | `auth status` reports logged out (exit 1) |
| `FAKE_CLAUDE_AUTH_EXIT` | exit code of `auth login/logout` |
| `FAKE_CLAUDE_EXIT_ON_START=<code>` | exit immediately (before reading stdin) with that code; stderr = `FAKE_CLAUDE_STDERR` or a default message |
| `FAKE_CLAUDE_STDERR` | text written to stderr at startup |
| `FAKE_CLAUDE_NO_INIT_RESPONSE=1` | never answer `initialize` (timeout tests) |
| `FAKE_CLAUDE_INIT_ERROR=<msg>` | answer `initialize` with an error |
| `FAKE_CLAUDE_CONTROL_DELAYS` | JSON `{"<subtype>": ms}` delaying host control answers (out-of-order tests) |
| `FAKE_CLAUDE_HANG_ON_EOF=1` | ignore stdin EOF (keeps running until killed) |
| `FAKE_CLAUDE_IGNORE_SIGTERM=1` | ignore SIGTERM (SIGKILL escalation tests) |
| `FAKE_CLAUDE_PERSIST=1` | transcript persistence (needs `CLAUDE_CONFIG_DIR`) |
| `FAKE_CLAUDE_DEFAULT_MODEL` / `FAKE_CLAUDE_DEFAULT_EFFORT` | defaults (`claude-opus-5-5` / `medium`) |
| `FAKE_CLAUDE_SUBSCRIPTION` | `initialize.account.subscriptionType` (default `max`) |
| `FAKE_CLAUDE_COMPACT_MS` | duration of `/compact` (default 5 ms) |

`test/claude/helpers.ts` → `fakeEnv()` strips any inherited `FAKE_CLAUDE_*` variables so tests do
not leak settings into each other.

### Known differences from the real CLI

* No real model, tools, MCP connections, subagents, background tasks or auto-compaction.
* Hook callback `timeout` is not enforced; `onFailure:"continue"` + error = no decision.
* `--agents`, `--plugin-dir`, `--append-system-prompt-file`, `--system-prompt-snapshot`, `--add-dir`,
  `--setting-sources` are accepted and logged (inspect `argv` in the log) but have no effect.
* Results always carry `user_message_uuid(s)` when the host sent a uuid (the real CLI does too for
  model and local-command turns; CLI-initiated background turns are not simulated).
* A user line WITHOUT `priority` sent while a turn runs is queued as a separate turn; claude 2.1.319
  was seen folding such a line in at the next tool boundary like `next` (kiro-claude never sends
  one mid-turn).
* `queued_turn_count` is the length of the fake's own queue (the real CLI reported 0 with a `next`
  line still waiting).

## `test/e2e/` — opt-in suite against the REAL Claude Code CLI

Real-binary tests make model calls on the user's Claude Code login (billed to their
subscription), so every real-claude case **skips** (`t.skip(<reason>)`) unless `KIRO_CLAUDE_E2E=1`.
The default `npm test` glob (`dist/test/**/*.test.js`) therefore only reports them as skipped (only
the model-free `helpers.test.ts` self-tests and, on Linux, the harness-timeout cases of
`kirocrew.test.ts` run there).

```sh
npm run build && KIRO_CLAUDE_E2E=1 node --test dist/test/e2e/cli-real.test.js   # or: npm run test:e2e
```

| Variable | Effect |
|---|---|
| `KIRO_CLAUDE_E2E=1` | run the suite at all |
| `KIRO_CLAUDE_E2E_MODEL` | model passed as `--model` (default `haiku`) |
| `KIRO_CLAUDE_E2E_KEEP=1` | keep the temp dirs and the Claude project dirs of the temp cwds (paths printed as test diagnostics) |

* `helpers.test.ts` — self-tests of `helpers.ts` (the fake claude, temp `HOME` / `CLAUDE_CONFIG_DIR`,
  no model calls), so they **always run**: the Claude-project-dir removal only ever removes the
  dirs of `kc-e2e-*` temp cwds (both spellings of a symlinked temp dir), `e2eEnv()`'s isolation,
  and `cleanup()` stopping the project's CLI children before removing it.
* `kirocrew.test.ts` — the KiroCrew stages B/C (`KIRO_CLAUDE_E2E_KIROCREW=1`, see its header). Its
  harness runs each script as `bash -c` in a process group of its own; the timeout's SIGKILL of that
  group goes through `src/claude/lifecycle` `signalChild`, so once the leader exited the group is
  signalled only while a member that started before the exit is left (pids are reused: an emptied
  group's number may belong to an unrelated group by then). Three model-free cases check that
  (empty group: no kill; live leader; a member still holding the pipes) and always run on Linux.
* `claude-real.test.ts` drives `ClaudeProcess` directly (initialize, one turn, a PreToolUse deny).
* `cli-real.test.ts` runs the **built** CLI (`<outDir>/src/bin/kiro-claude.js`, resolved relative
  to the compiled test file) as a child process: (a) headless `chat --no-interactive`; (b) steering
  resource + `agentSpawn` hook output + agent prompt in the `--append-system-prompt-file` (captured by
  a generated `sh` wrapper used as `KIRO_CLAUDE_BIN` that copies the file and `exec`s the real
  `claude`; POSIX only); (c) the V2 gate (`allowedPaths`, the non-interactive denial text,
  `deniedCommands`, `allowedCommands`); (d) REPL line mode with a `y` answer at `[y/n/t]:` and
  `/quit`; (e) ACP `initialize` → `session/new` → `session/prompt` → `session/request_permission`
  (`allow_once`) → stdin EOF exit 0, then a new process `session/load` (replay + resumed memory);
  (f) `<KIRO_HOME>/sessions/cli/<sid>.json` + `.jsonl` written by (e) (shared, memoized scenario: (f)
  runs it itself when (e) did not); (g) `spec new … --type quick --yes` (600 s budget).

### `test/e2e/helpers.ts`

* `e2eTest(name, timeoutMs, fn)` — a `node:test` case that `t.skip`s without `KIRO_CLAUDE_E2E=1`.
* `makeProject(t?)` — `<tmp>/kc-e2e-XXXXXX/{project,kiro-home}`: `project` is `git init`ed and used as
  cwd, `kiro-home` is `KIRO_HOME` (with an empty `agents/` so legacy `~/.aws/amazonq` agents are not
  read). `.env` is the caller's environment **minus** `KIRO_*` / `FAKE_CLAUDE_*` / `FORCE_COLOR`
  (so a stray `KIRO_CLAUDE_BIN` cannot select the fake) plus `KIRO_HOME`, `KIRO_CHAT_LOG_FILE`,
  `NO_COLOR=1`. **HOME and CLAUDE_CONFIG_DIR are not overridden** — that would hide the login.
  `.write(rel, text)`, `.agent(name, spec)` (workspace V2 agent), `.token` (unique marker);
  `await .cleanup()` is registered on `t.after` (call it yourself without `t`): it first stops
  (SIGTERM, SIGKILL after 5 s, ≤ 15 s) every tracked CLI child still running in the project — a
  failed or timed-out case would otherwise leave `claude` writing its transcript back into the
  user's Claude config after the removal — then removes the temp root and the Claude project dir.
* `trackChild(child, cwd)` — register a child so `cleanup()` of the project containing `cwd` stops
  it; `runCli`, `CliProc` and `AcpClient` do this for their children.
* `removeClaudeProjectDir(cwd, uniqueRoot?, env?)` — the real `claude` creates
  `<CLAUDE_CONFIG_DIR|~/.claude>/projects/<sanitized cwd>/` for every temp cwd (named after its
  getcwd(), i.e. the realpath, so both spellings are tried); this removes exactly that directory,
  and only when `uniqueRoot` is a `kc-e2e-*` temp dir that contains `cwd` and whose name the
  directory carries. `env` (default `e2eEnv()`) supplies `CLAUDE_CONFIG_DIR`. Nothing else in the
  user's Claude config is touched.
* `runCli(args, {cwd, env, timeoutMs})` — run `kiro-claude <args>` with stdin closed; ANSI-stripped
  `stdout`/`stderr`, exit code, `timedOut` (SIGTERM, then SIGKILL after 5 s).
* `CliProc` — a long-running CLI child with piped stdio (REPL line mode): `write(line)`, `end()`,
  `waitUntil(cond, what, timeoutMs)` (re-checked on every output chunk, on exit and every 250 ms for
  file-system conditions; fails early with the output tail if the process exits), `exited`.
* `AcpClient` — a JSON-RPC 2.0 client over `kiro-claude acp …` stdio: `call(method, params, ms)` →
  `{result, from, to}` (the frame-index range of the exchange), `chunkText(sid, kind, from, to)`,
  `updates(...)`, `endAndWait(ms)`; `session/request_permission` is answered by `onPermission`
  (default: the `allow_once` option), other agent → client requests get "method not found";
  non-JSON stdout lines are collected in `nonJson`.
* `describeRun(r)` — output tail for assertion messages (never the environment).

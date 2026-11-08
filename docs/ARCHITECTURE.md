# kiro-claude architecture

kiro-claude is a port of the **Kiro CLI** front end (commands, interactive chat, slash
commands, custom agents, steering, MCP config, hooks, prompts, skills, specs, ACP mode)
whose agent runtime is the **Claude Code CLI installed on your machine**. Every model call
is made by the `claude` binary itself, so it is billed to whatever Claude Code is logged in
with (normally your Claude Pro/Max subscription). kiro-claude never reads, stores or forwards
credentials.

```
 ┌──────────────────────────── kiro-claude ─────────────────────────────┐
 │ cli/        argv parsing, subcommands (chat, agent, mcp, settings,   │
 │             spec, acp, login/whoami/logout, doctor, ...)             │
 │ repl/       interactive chat: line editor, slash commands, renderer, │
 │             y/n/t approvals, Ctrl+C, fatal signals (exitSignals.ts)  │
 │ headless/   `chat --no-interactive` runner                           │
 │ spec/       Kiro spec workflow (requirements → design → tasks → run) │
 │ acp/        Agent Client Protocol server (`kiro-cli acp` drop-in)    │
 │ crew/       `kiro-claude crew`: build and set up KiroCrew, kiro-cli  │
 │             shim, identity stub, gateway start/stop, run/crashed.json│
 │ session/    KiroSession orchestrator + launch builder + session index│
 │ context/    system-prompt file (steering, resources, AGENTS.md, hook │
 │             output, agent prompt) and per-turn user text (@, #)      │
 │ models/     Kiro ⇄ Claude model id mapping                           │
 │ policy/     tool map + the gate: Q engine (V2 agents), capability    │
 │             engine (V3 agents), invariants, session trust, the       │
 │             spec-phase write allowance                               │
 │ hooks/      Kiro hook runner (V2 + V3 dialects, all triggers)        │
 │ config/     ~/.kiro + .kiro loaders (agents, steering, mcp, prompts, │
 │             skills, hooks, permissions.yaml, settings)               │
 │ claude/     ClaudeProcess: spawn installed `claude`, stream-json I/O,│
 │             control protocol, capability probe, env scrub, auth      │
 │ util/       globs, shlex, yaml/front matter, fs, shell exec, logging │
 │ types.ts    every cross-module contract                              │
 └──────────────────────────────────────┬───────────────────────────────┘
                                        │ stdin/stdout NDJSON (stream-json)
                                        ▼
                     claude -p --input-format stream-json
                            --output-format stream-json --verbose
                            --permission-prompt-tool stdio ...
                     (your installed Claude Code, your login)
```

## Why this shape

* Kiro CLI is closed source; its open-source predecessor (Amazon Q Developer CLI, Rust,
  Apache-2.0/MIT) is ~53k lines tied to AWS's CodeWhisperer backend and its own tool loop.
  Claude Code already *is* a complete agent loop (tools, MCP, subagents, compaction,
  session storage). So the port keeps Kiro's **surface and semantics** and delegates the
  loop to Claude Code, instead of transplanting Q CLI's loop.
* Driving the official `claude` binary in headless stream-json mode is the supported way to
  automate Claude Code. Authentication stays inside Claude Code.

## Permission gate (verified against claude 2.1.318 and 2.1.319)

The first stdin line is a control-protocol `initialize` request registering in-process hook
callbacks. `PreToolUse` (no matcher → every tool, including tools Claude would auto-allow)
calls back into kiro-claude, which:

1. runs the agent's Kiro `preToolUse` hooks (exit 2 → deny, stderr goes to the model);
2. evaluates Kiro policy: `allowedTools`, `toolsSettings` allow/deny lists, read-only
   auto-allow, session trust (`/tools trust`, `--trust-all-tools`, `--trust-tools`);
3. answers `allow`, `deny` (with Kiro's denial text), or `ask`.

`ask` makes Claude Code send a `can_use_tool` control request, which kiro-claude answers by
prompting the user (`y/n/t`) in chat, by `session/request_permission` in ACP mode, or by
denying in `--no-interactive` mode. `PostToolUse` callbacks run Kiro `postToolUse` hooks.
`agentSpawn`, `userPromptSubmit` and `stop` hooks run inside kiro-claude itself (before
spawn, before each prompt, after each turn) and their output is injected the way Kiro does.

## Configuration changes mid-session

Claude Code fixes the system prompt per process. Changing agent, context files, MCP servers
or tools mid-session restarts the `claude` child with `--resume <session-id>` and
`--system-prompt-snapshot off` (when supported), so history is kept and the new appended
system prompt takes effect. Model changes use the `set_model` control request when possible.

## Specs

kiro-claude owns Kiro's spec workflow (`spec/workflow.ts`, used by `/spec` in chat and by
`kiro-claude spec`): requirements (or a bugfix analysis) → design → tasks, each phase drafted in
one turn and followed by a checkpoint where the user approves it or asks for a revision (a quick
spec drafts all three after a few clarifying questions and has one checkpoint at the end, on the
tasks). Approval is a menu choice; the model never moves on by itself.

* **Phase sessions and the continuation.** A phase turn may write only that phase's documents
  (`.kiro/specs/<feature>/requirements.md`, …): the gate allows those writes without asking (the
  hard rules and a policy deny still apply) and denies every other write with
  `Spec phase <name>: only <paths> may be written now`. Claude Code
  fixes a session's tools and prompt per process, so each phase runs in a phase session of its
  own that forks the current Claude conversation, and the context carries over. When the flow
  ends, the chat continues in an unrestricted continuation forked from the last phase session a
  turn reached; `kiro-claude spec` closes everything instead. When no spec turn reached Claude
  (for example a Ctrl+C while the phase session was starting), the chat keeps its own session.
  The hints that say how to go on after a stop (a checkpoint's Stop label and stop hint, `new` of
  an existing spec, `run` or `analyze` without its document) come from `SpecRuntime.resumeHint`:
  `/spec <name>` in chat; `kiro-claude spec`, which has no such form, names its own commands by
  where the spec stands (r7 #8): `kiro-claude spec approve <name> · kiro-claude spec revise <name>
  <feedback>` for a document awaiting review, `kiro-claude spec run <name> --next` once the tasks
  are approved, `kiro-claude spec status <name>` for a spec with a refused file, and `/spec <name>
  in kiro-claude chat` when only the chat can draft the next document (an existing folder without
  its first document: `new` refuses an existing folder).
* **Trust and plan mode, carried in and back.** Every phase session and the continuation start
  from the trust and plan mode of the session they continue, as the chat has them at that moment
  (a `/tools untrust`, a revoked tool, a `t` answer, Shift+Tab), never from the launch flags
  (`--trust-tools`, the agent's `allowedTools`) again; a `/spec run` task session starts from the
  chat's trust. When the chat gets a session of its own back (a task ended, a flow handed over no
  continuation), the restrictions the user added meanwhile carry back: trust-all turned off, a
  tool untrusted, plan mode turned on. Trust gained there with `t` does not, which is stricter
  than Kiro, whose tasks run in the chat itself.
* **Plan mode.** Kiro's plan mode is the read-only planner. The phase sessions of a plan-mode chat
  run in plan mode too (the prompt shows `[plan]`): the gate denies every mutating tool except
  writes of the phase's own documents, and the phase turn tells the model which documents it may
  write. Running tasks is refused in plan mode: `/spec run`, and running tasks from `/spec <name>`,
  print `Plan mode is read-only: running spec tasks implements code (it edits files and runs
  commands). Exit plan mode (/plan or Shift+Tab), then run /spec run <name> again.` When plan mode
  comes on during a run (Shift+Tab while a task session is the chat's: that task's session is in
  plan mode from then on, and the mode carries back to the chat), no further task starts.
* **Symbolic links.** The phase-document allowance is anchored to the spec folder
  (`policy/specwrite.ts`). A phase never writes through a symbolic link at the document: not a
  document that is itself a link (a dangling one included), nor a path with a link above it that
  resolves to nothing or whose target cannot be accessed, nor a path with `..` right after a link;
  and the document's real path must stay inside the workspace. A link whose target is behind a
  folder the user cannot enter (realpath fails with EACCES or EPERM) cannot be checked, so it is
  refused too, with its own reason (`the target of the symbolic link <link> cannot be accessed
  (permission denied)`), never as a dangling link and without the advice to replace the link or
  move the folder (a dangling link or a loop is ENOENT, ENOTDIR or ELOOP). A `.kiro`,
  `.kiro/specs` or feature folder that is a symbolic link resolving inside the workspace keeps
  working. A refused write gets the spec-phase denial with the reason in parentheses, in plan
  mode too. kiro-claude's own reads and writes of spec files follow the same rules
  (`spec/docfs.ts`): the listing and status, `view`, the task context, a
  `#spec:<name>` reference in chat (each refused document or folder is a notice instead), the
  `tasks.md` repair after a turn, the box updates of a run and `.config.kiro` never go through a
  link at a document, through a link above it that resolves to nothing or whose target cannot be
  accessed, or outside the workspace (reads use `O_NOFOLLOW`; writes rename over the path itself,
  never a link's target). They also refuse what the user cannot access, which the gate leaves to
  the tool's own I/O error: a document the user cannot read (whatever its size: every document is
  checked) and a feature folder or `.kiro/specs` the user cannot enter (also one a link points at,
  or one under such a folder) get the reason `<p> cannot be accessed (permission denied)` and the
  advice `kiro-claude uses spec files and folders only when it can read them, and never takes one
  it cannot read for a missing one (check their permissions)`, never the advice to replace the
  link or move the folder; a `.kiro/specs` the user may enter but not read is not enumerated (that
  reason too), and its specs still work by their exact name. DECISION (r7 #6, the research is
  silent): such a file is refused rather than taken for a missing one, so it is never drafted
  over and no task runs with a context that silently lacks it (the files of a folder that cannot
  be entered are not known to exist: `status` gives the phase as `unknown (not read)`). Such a
  document is marked `refused` with the reason: `list` and `status`
  show the phase `refused` and say why, `view` prints the reason instead of the text, and it is
  never drafted over as if it were missing. Its checkpoint offers no Approve and `approve` refuses
  it (a headless flow ends with an error there); a revision turn still runs and the gate denies
  its write. The same holds
  for every phase of a spec with any refused file, also an input document (`requirements.md`
  under review of the design) or `.config.kiro` (the spec's type and workflow are then unknown):
  each checkpoint names every reason and offers no Approve, and no phase is drafted from it.
  `run` and `sync` (whose turn also builds on requirements and design) of a spec with a refused
  file, `analyze` with a refused requirements document, and `new` under a `.kiro/specs` that is
  linked out of the workspace (or dangling, or to a target that cannot be accessed), or that the
  user cannot enter, are refused with the reason. Such a `.kiro/specs` is not enumerated either:
  `list` and `status` print why instead (`kiro-claude spec list` exits 1); a feature folder linked
  like that is listed as `refused`. A spec named under such a `.kiro/specs` that is not found
  (it may well be there) gets that refusal instead of "not found … Create it with … new" (r7 #7:
  `kiro-claude spec status|view <name>`, `/spec <name>`, `/spec status|view <name>` and every flow;
  `new` would refuse anyway), and `#spec:<name>` gives the same reasons (also for a feature folder
  link that cannot be followed), never "not found". A task whose spec file becomes a link (or
  unreadable) during the run (before it starts, while its session starts, or when its context is
  read) fails with the reason, and the link's target is left alone; one whose box cannot be
  marked in progress for another reason (a spec folder the user cannot write) fails with that
  error, not as a task that is no longer in `tasks.md`. A link swapped
  into a folder between the check and the I/O is not ruled out (the same window as the gate's).
* **Tangents.** A spec command that runs spec turns (`/spec new`, `approve`, `revise`, `analyze`,
  `sync`, and resuming a spec that still has a document to draft or review) is refused inside a
  tangent: the continuation it hands over would replace the tangent, and `/tangent` could no
  longer return to the main conversation (`⚠️ Spec drafting is disabled while in tangent mode: its
  spec conversation would replace this tangent. …`). The one exception is a tangent of the main
  conversation that has no message of its own yet, which holds nothing to lose: it is left first
  (`Left the tangent (↯): it had no messages of its own, so the spec continues the main
  conversation.`). An empty tangent nested in another tangent is refused, since leaving it would
  return to that tangent, not to the main conversation. `list`, `status`, `view` and task runs
  work in a tangent. Leaving a tangent this way, like any other, keeps the plan mode the user
  last set (see [Sessions](#sessions-tangents-rewind-compaction)).
* **Phase records.** When a flow ends, the saved records of its phase sessions that a later
  session holds in full are removed: with a continuation all of them, otherwise (`kiro-claude
  spec`, or a continuation that could not be made) all but the last, which keeps the spec
  conversation. So `chat --list-sessions` shows the chat, not one record per phase; the phases'
  Claude transcripts stay. A `/rewind` in a continuation that has no message of its own yet keeps
  that continuation, since it is then the only record of the spec turns. A flow cut short by a
  fatal signal keeps its phase records (known gap).
* **Running tasks.** Tasks run in waves planned from `tasks.md` (checkpoint tasks are barriers).
  Per task: its PreTaskExec hooks, a fresh task session with the spec documents as context, the
  box ticked only for a turn that ends in `TASK_RESULT: completed`, then its PostTaskExec hooks.
  A task a PreTaskExec hook blocks (exit 2) is skipped with its box unchanged and the run goes on;
  any other task that does not complete (failed, blocked, interrupted) stops the run.
  `/spec run` in chat runs one task at a time: each task session becomes the chat's session for
  its turn, and the chat has one active session and one approval prompt. `kiro-claude spec run`
  runs up to `kiroClaude.spec.maxParallelTasks` (1–4) tasks of a wave at once.
* **Ctrl+C.** The first press stops scheduling tasks, interrupts the running task sessions, kills
  running task hook commands with their process groups, and cancels a session start whose
  agentSpawn hooks still run (the phase turn is not sent, the continuation is not made, the task
  is `interrupted`). That press's signal stays aborted, so what starts after it runs under the
  next press (`ReplContext.nextPressSignal`, `SpecRuntime.nextPressSignal`): the PostTaskExec
  hooks of a task the press interrupted (they still run, with the status `interrupted`), and a
  phase session or the continuation that starts afterwards. The next Ctrl+C kills or cancels
  them; a cancelled continuation leaves the chat in its own session (`Ctrl+C: the chat keeps its
  own conversation; the spec conversation was not carried over (the spec documents are saved).`).
  `kiro-claude spec run` handles Ctrl+C itself: the first press prints `Interrupting… (press
  Ctrl+C again to exit)`; the second kills such a PostTaskExec hook (with its process group) and
  lets the run end normally (summary, sessions closed, exit 1), or exits at once when no such
  hook runs; the press after that exits. SIGTERM and SIGHUP reach its task hooks through the
  lifecycle forwarder ([Signals and child processes](#signals-and-child-processes)).

## Sessions: tangents, rewind, compaction

Sessions are kiro-cli session files in `~/.kiro/sessions/cli` (`<id>.json` and the `<id>.jsonl`
journal); Claude Code keeps its own transcript, which kiro-claude resumes and forks.

* **Switching chats.** `/chat new` (a fresh conversation) and `/chat load` (an export, imported as
  a new record) keep the agent, model and effort of the chat (`/chat load` the export's effort
  when the chat has none); `/chat resume` (another record of this directory) takes the record's
  (the chat's effort when the record has none). All three keep the chat's trust and plan mode as they are
  at that moment. Trust is per process, as in Q (its Load swaps the current agents, with their
  allowed tools and trust-all, into the loaded state): the next chat starts from the chat's trust
  (trust-all, per-tool trust, session rules, `/tools untrust` revocations, other agents' trust),
  never from the launch `--trust-tools` / `--trust-all-tools` again, so a tool the user
  untrusted, or trust-all turned off with `/tools reset`, stays so, and launch trust the user kept
  stays too, as do a revoked tool of the agent's own `allowedTools` and trust gained with `t` or
  `/tools trust-all`. For `/chat resume` this replaces the record's own saved trust (the chat's
  per-tool trust of the record's agent when the record runs another one), and the record is saved
  with it once its Claude Code is up: a revocation an earlier run saved in it is gone, also for a
  later `chat --resume` of it (which starts from the record's own trust and the launch flags).
  Plan mode is session state too
  (Kiro's plan mode is the planner agent, which `/chat new` and `/chat load` keep): the next chat
  is in plan mode when the chat is, and a record or export saved in plan mode comes back in it
  even when the chat is not.
* **Tangents.** `/tangent` forks the conversation into a tangent and `/tangent` again returns to
  the main one; `/tangent tail` brings the tangent's last question and answer back with it,
  `/tangent merge` a summary. Tangents nest. Plan mode is session state, not part of the tangent's
  checkpoint (Q CLI's checkpoint holds the conversation, not settings such as the agent): whichever
  way the chat leaves a tangent (`/tangent`, `tail`, `merge`, `/tangent root`, or the spec
  command's automatic exit), it keeps the plan mode the user last set, and a change made inside a
  tangent is written to the records under it at once, so a quit or a crash inside the tangent
  cannot lose it. The agent (`/agent swap`) and tool trust (`/tools trust`, `untrust`, `reset`,
  `trust-all`) are session state too, written to those records at once the same way: after a
  crash inside a tangent, `chat --resume` (which opens the main conversation; after a `/rewind`
  inside the tangent it can open the rewound one, a record of its own that holds them too, from
  the moment it is written, also while its Claude Code is still starting) never
  runs a tool revoked inside the tangent as trusted, nor resumes on the agent the user left
  (trust-all is per invocation anyway: a resume without `--trust-all-tools` clears it). So are the
  model and the effort (Q CLI keeps the model per process): the model the agent pins when
  `/agent swap` switches to it inside a tangent (when it is a valid one), and a `/model` or
  `/effort` made inside a tangent, are written to the records under it at once and kept when the
  chat leaves the tangent, so the main conversation runs the new agent on its model, not on the
  model it had before. A `tail` carries the
  tangent's own last exchange: also after a return from a tangent nested in it (the exchange it
  had before), and after a `/rewind N` inside it turn N's (also when Claude Code compacted
  automatically during that turn), never a turn rewound away. What a nested tangent's `merge`
  or `tail` left for its parent reaches the main conversation when that parent is merged (it goes
  into the merge summary);
  after a plain `/tangent` or a `tail` out of the parent it stays on the parent's record.
  In a chat that has no message yet `/tangent` is refused (`Can't branch an empty chat.`); a
  session that entered a tangent without one all the same (through the session API, after local
  commands only) keeps no record of the chat or of its empty tangents when it quits.
* **Rewind.** `/rewind N` continues from turn N in a new record and names the record that keeps
  the original conversation. The new record (like a tangent's) is written with the chat's trust,
  agent, model, effort and plan mode and the fork still to be made, so a crash while its Claude
  Code starts leaves `chat --resume`, which opens it, neither a revoked tool trusted nor the
  conversation lost (the resume makes the fork again). An untouched copy (a `/spec` continuation with no message of its
  own) is dropped only when its parent record still holds every one of its turns. After a
  `/compact` Claude Code keeps the conversation from its summary on: a rewind to the turn the
  compaction followed forks the compacted conversation at that turn's answer when Claude Code kept
  the answer verbatim (the last answer of a chat with two turns or more). Otherwise (a single turn
  before the compaction), and for an earlier turn, it starts a new conversation with the saved
  history up to turn N as context (turn N's own prompts and answers, not a summary written after
  them) and says so (`The conversation was compacted after turn N, …`).
* **Compaction.** `/compact` runs Claude Code's own compaction. With nothing to compact (a session
  with no messages, or one holding only local commands such as `/effort`), Claude Code refuses
  under a result that says success; kiro-claude reports the refusal as an error with Claude
  Code's reason (`No messages to compact`, `Not enough messages to compact.`) and prints no
  success line. Over ACP, `commands/execute compact` answers `{success:false}` with that reason
  and the compaction status is `failed`. A `/compact` interrupted while Claude Code compacts
  (Ctrl+C, an ACP cancel) is cancelled, not an error, although Claude Code reports the abort as
  `API Error: Request was aborted.` under a result that says success: the chat prints `Compaction
  cancelled.` and over ACP the `failed` status says `Compaction cancelled`.
* **A compaction that does not compact.** Claude Code reports one it started and did not finish
  (refused, failed, interrupted) as a failed status with a reason and no boundary, also for an
  automatic compaction inside a prompt turn, after which the turn goes on. The session publishes
  the end of every compaction it reported started: `finished`, or `compaction_failed` with
  Claude's reason, as a sentence for Claude Code's internal codes (`too_few_groups`: `Not enough
  messages to compact.`; `exhausted`: `The conversation could not be reduced below the context
  limit.`; `media_unstrippable`: `Attached media exceeds size limits.`) and without Claude's own
  `Compaction failed ·` before it. One Claude never ends is ended at Claude's next output (Claude streams nothing
  while it compacts), so its end comes before the answer, or when the turn ends. The chat closes
  `Summarizing the conversation history...` with one plain line, `Compaction failed: <reason>`
  (`Compaction cancelled.` after Ctrl+C), and the answer follows; a refused `/compact` prints
  Claude's reason once as a plain line, not `Kiro is having trouble responding right now`. Over
  ACP the automatic compaction's `_kiro.dev/compaction/status` `started` gets a `failed` end with
  the reason in `summary` and `reason`, sent just before the turn's next frame or before the
  prompt response when nothing follows, and the prompt answers what Claude answered. KiroCrew
  then neither waits for an end nor ends a turn that is still running: it reads a `failed` inside
  a turn as the start of a 60 s post-failure budget and gives up on the turn only after 60 s
  with no frame, so the frame goes out with the one that ends Claude's silence after the
  failure (a steer's queued or cleared answer does not end it). Its dashboard drops the text
  streamed before a compaction terminal, which is why the end never follows the answer.

## Ctrl+C and signals

### Ctrl+C in the chat

* During a turn the first Ctrl+C interrupts it (control request `interrupt`; at a `[y/n/t]`
  prompt the tool call is cancelled too), and so does a press during a slash command that works
  through the session without a turn of the REPL's own (`/tangent merge`'s summary turn,
  `/agent swap` restarting Claude Code). The press is never kept as type-ahead for the next
  prompt.
* Every press while a slash command runs also aborts the command's signal
  (`ReplContext.commandSignal`): `/spec run` starts no further task; `/hooks run` and `/chat
  save-via-script|load-via-script` kill the hook command or the script (it runs in a process
  group of its own, which the terminal's SIGINT never reaches); `/usage`, `/mcp`, `/tools` and
  `/model` stop waiting for Claude Code's answer to their control request; `/chat
  new|resume|load` cancel the next session's start while it runs its agentSpawn hooks (they are
  killed, nothing of that session stays, the current one stays active).
* The command signal stays aborted after its first press, so work a command starts after that
  press runs under the next one (`ReplContext.nextPressSignal`): the PostTaskExec hooks of a
  `/spec run` task the press interrupted, and the start of a later phase session or of the
  `/spec` continuation. Only a new press cancels them.
* A second Ctrl+C: when the turn or command still runs 1 s later (Claude Code did not end it
  after the interrupt), kiro-claude stops Claude Code (`Claude Code did not stop after the
  interrupt; stopping it.`): the session is closed (stdin EOF, SIGTERM after 2 s, then SIGKILL)
  and the REPL returns to its prompt. The next input restarts it with `--resume`, with the agent,
  model, trust and plan mode it had; a conversation without a finished turn, which closing
  drops, starts afresh. A Ctrl+C while the restarted session runs its agentSpawn hooks cancels the
  restart (`Restart cancelled (Ctrl+C). Claude Code restarts with your next input.`): the hooks
  are killed and the next input tries again.
* The forced stop only ends a session that has work of its own in flight (`KiroSession.busy`;
  F0 in the code: an idle session is never stopped). A command waiting on another session (a
  `/spec run` task session, `/chat new` starting) or on Claude Code (re)starting is neither
  stopped nor abandoned; one waiting on the idle session's control request or on a process of
  kiro-claude's own ends through its command signal, and Claude Code keeps running. `$EDITOR` and
  `!cmd` get the terminal, and its SIGINT, themselves.
* At the idle prompt the first Ctrl+C or Ctrl+D prints `(To exit the CLI, press Ctrl+C or Ctrl+D
  again or type /quit)`; the second exits.
* Ctrl+Z (POSIX) at a prompt (the idle prompt, an approval or a question) suspends kiro-claude
  like any terminal program, as rustyline does at Q's prompt: the terminal reader
  (`repl/input.ts`) turns raw mode and bracketed paste off and sends SIGTSTP to kiro-claude's
  process group, so a wrapper such as `npx` stops with it. Claude Code runs in a process group
  of its own and keeps running; what it writes waits in the pipe, and a permission request waits
  for its answer, until `fg`. Pressed while a turn runs, Ctrl+Z is kept as type-ahead and the
  stop happens at the prompt that follows (an approval prompt drops it with the rest of the
  type-ahead). DECISION: Q stops at once there (its terminal is in cooked mode while it answers),
  but kiro-claude's hook commands also run in groups of their own and go on while it is stopped,
  and its timers do not wait: a stop that outlasted a running preToolUse hook's timeout counted
  that hook as timed out, which never blocks, even when it had blocked the tool, and a trusted
  tool then ran.
  After `fg` raw mode and bracketed paste are back and the prompt being read is drawn again with
  its half-typed line; an approval prompt still takes its answer. As the terminal's session
  leader (`ssh -t host kiro-claude chat`, `docker run -it`, `tmux new 'kiro-claude chat'`) there
  is no shell to return to: the kernel discards the stop and the chat goes on as before.
  readline's own suspend is not used: it left the input paused after `fg`, and in cooked mode
  when the stop was discarded (Enter no longer submitted, and Ctrl+D was an end of input taken
  for a hangup). A stop from elsewhere (`kill -TSTP` or `kill -STOP` of kiro-claude, then `fg`)
  leaves the terminal in the shell's cooked mode; the reader takes it back at SIGCONT the same
  way, the prompt being read drawn on the shell's fresh line. While `$EDITOR` or `!cmd` owns the
  terminal, Ctrl+Z is the terminal's own: it stops that program and kiro-claude together, as one
  job.

`chat --no-interactive`: the first Ctrl+C interrupts the turn (exit status 130 once it ends); a
second one closes the session.

### Fatal signals: close, then die of the signal

Both front ends use `ExitSignals` (`repl/exitSignals.ts`) on POSIX:

* It handles SIGHUP and SIGTERM for the whole run (a closed terminal tab, `kill`), and SIGINT
  while the session starts (Claude Code initializing, agentSpawn hooks) and during the final
  close (after `/quit`, after the headless answer). In between, Ctrl+C belongs to the front end
  (above). In an interactive terminal the chat's input is still in raw mode during its final
  close, so a Ctrl+C key is ignored there; `kill -INT` and piped input get the close described
  here.
* From the signal on no session is created and no turn is sent. A running command's signal and
  every next-press signal are aborted (`/spec run` stops, hook commands are killed), and a start
  still running its agentSpawn hooks is cancelled (they are killed; nothing of that session
  stays).
* Every open session is then closed, the user's chat first, then the others together (`/spec`
  phase and task sessions, a session the forced stop is still closing): each runs its SessionEnd
  hooks, saves its record and releases its lock. The chat's record is then made the newest, under
  its lock, so `chat --resume` continues the user's conversation and not a phase record closed
  after it.
* The close may take up to 2 s from the signal (`SIGNAL_CLOSE_GRACE_MS`). Then the signal is
  re-raised with these listeners removed, so kiro-claude dies of it: a shell shows the exit
  status 128 + the signal number (129 for SIGHUP, 130 for SIGINT, 143 for SIGTERM), and the
  lifecycle forwarder ends any child still running. Should anything swallow the re-raised signal,
  kiro-claude exits with that status 5 s later.
* A second signal re-raises at once: one more than 500 ms after the first
  (`DUPLICATE_SIGNAL_WINDOW_MS`), or a SIGINT after a SIGHUP or SIGTERM inside that window. A
  repeat inside the window is the same event delivered twice, not an impatient user: a terminal
  tab closing under an interactive shell sends SIGHUP twice within a millisecond, an `npm` or
  `npx` wrapper forwards the terminal's SIGINT, and a supervisor may signal both the process and
  its group. So is a SIGTERM right after a SIGHUP, or the other way round: closing the terminal
  of an interactive bash while the chat is stopped (Ctrl+Z) sends SIGHUP and then SIGTERM (each
  with a SIGCONT) within microseconds.
* After the signal kiro-claude prints nothing more. The REPL shows no prompt, no turn error, no
  notice and nothing a command prints, drops the output of a `!cmd` still running, clears a
  spinner, and neither sends nor runs input typed during the grace. Nor does such input answer a
  question that was already waiting: a command's question (`/spec new`'s name, a `[y/n]`, a menu)
  gets no answer, so the command stops without acting, and an approval prompt still open (a
  `/spec` phase session's, closed after the chat) is cancelled. A process SIGINT (`kill -INT`) or
  a terminal resize during the grace draws nothing either (no fresh line, no redrawn prompt; the
  terminal reader lets readline redraw its prompt line at a resize only while a read is active and
  no child owns the terminal, so a resize while an answer streams never draws a stale prompt over
  it). The one exception is the
  resume hint of a `/quit` whose close the signal came into. Headless prints nothing more (notices
  included) and returns no status. The same silence holds while kiro-claude dies of a signal the
  lifecycle forwarder owns (an embedder that turned these handlers off).
* A hung-up terminal also fails reads and writes with EIO: the line reader takes the input error
  for the end of input, EIO on stdout and stderr is ignored (headless interrupts its turn, since
  the answer cannot be delivered, and exits 1 unless the signal ends it first), and a half-typed
  line in the terminal is dropped, not sent (piped input keeps a last line without a newline).
  In the interactive terminal that end of input is not a quit: it reaches the REPL a moment
  before Node dispatches the hangup's SIGHUP, so the REPL waits for the signal (up to 500 ms,
  `ExitSignals.awaitSignal`) and then closes and dies of it like any SIGHUP, with no resume hint.
  Without the wait a chat whose session had already closed (after a forced stop) exited 0 before
  the signal. Ctrl+D (a key in raw mode) and the end of piped input quit at once.
* Headless: at a signal during the turn the children still running (`claude`, hook commands) get
  SIGTERM and, 1 s later, SIGKILL with their surviving group members, as under the lifecycle
  forwarder; the session is marked closed first, so nothing respawns Claude Code or sends the
  prompt. During the final close nothing is signalled, so a SessionEnd hook that is running
  finishes within the grace.
* A chat that never had a message and is left behind anyway (the grace ran out, SIGKILL, a crash)
  is removed by the session index instead of listed; a stale lock is taken over when its record
  is opened again.
* Not on Windows (no POSIX re-raise), and not for an embedder that passes
  `installSignalHandlers: false`; there the signal is the lifecycle forwarder's (below).

## Signals and child processes

kiro-claude starts `claude` (the session child and its version and login probes) and the Kiro hook
commands itself, and `claude/lifecycle.ts` tracks every one of them:

* **Process groups.** On POSIX every child is spawned `detached`, so it leads a new process group
  (and session). A terminal's Ctrl+C reaches only kiro-claude, which interrupts the turn itself;
  kill signals go to the whole group (`kill(-pid)`), so shell wrappers and tool commands that
  inherited the pipes go too. On Windows children are spawned normally and killed with
  `child.kill()`.
* **No child outlives kiro-claude.** `claude` exits on stdin EOF, and kiro-claude's end of its
  stdin closes when kiro-claude dies; at process exit every live tracked group is SIGKILLed; and
  a SIGTERM, SIGHUP or SIGINT that nothing else in kiro-claude handles is forwarded to every
  tracked group, survivors are SIGKILLed after 1 s, and the signal is re-raised, so kiro-claude
  still dies of it. When another listener exists (the REPL, headless, the ACP server, the crew
  runner), that listener owns the shutdown.
* **The group sweep after `claude` exits.** Once the `claude` child has exited (on stdin EOF from
  a close: `/quit`, the fatal-signal close, the ACP shutdown, the end of a headless run; or a
  crash), the members left in its process group (its MCP servers and their wrappers, anything
  else it ran in its group) get 100 ms to leave, then SIGTERM, then SIGKILL at 500 ms; `close()`
  waits for that. Hook commands are not swept: background commands of a hook shell that exited by
  itself may be meant to outlive it.
* **Only what is provably ours.** Once Node has reaped a leader, its pid can be handed out again,
  so a group whose leader is gone is signalled only while `/proc` (or `ps`) proves it is still
  ours: no process has that pid, and a member of that group and session started no later than
  the leader's exit. The proof is read again right before the kill; a reuse in the microseconds
  between that read and kill(2) cannot be excluded (Node has no pidfd).
* **The dying state.** From a forwarded signal until its re-raise, `dyingSignal()` names it and
  nothing new starts: no `claude` session child is spawned or respawned, nothing more is written
  to the running one, no hook command starts (one the signal ended counts as aborted, not
  failed), and the front ends print nothing (no restart notice, no turn error).
* **Left to Claude Code by design.** What Claude Code starts in a session of its own (setsid) is
  not swept, since it may be meant to outlive `claude`: with Claude Code 2.1.319 that is every
  Bash tool command, which `claude` kills itself on its exit or on SIGTERM. One that ignores
  `claude`'s SIGTERM outlives it, as it would under `claude` alone. Hook commands that leave their
  process group are not killed either.

## Steering a running turn (ACP `_session/steer`)

A steer is held by the ACP server and written to Claude Code at the next tool boundary as a
user line with `priority: "next"`. Claude Code folds such a line into the running turn at its
next tool boundary, or answers it in a turn of its own right after the result; its
`command_lifecycle` frames (`queued`, `started`, `completed`, `cancelled`) say which.
kiro-claude reports `AgentExecutionSteeringInjected` when Claude Code *starts* the line (not
when it is written), keeps such a turn's reply inside the same prompt request, and starts the
reply on a new paragraph. A steer still held when the turn ends is sent as a continuation
prompt inside the same request.

`_session/steer/clear` drops the held steers and withdraws written ones Claude Code has not
started yet (`cancel_async_message`), reporting all of them in one
`AgentExecutionUserMessageCleared`. `session/cancel` sends `interrupt` with `cancel_queued`
(when the installed Claude Code supports it), so a written steer never runs in a turn the client
cannot see.

## Cancelling commands and session starts (ACP)

ACP's `session/cancel` ignores a session with no turn running, but a Kiro command that waits for
Claude Code is not left running (`acp/server.ts`):

* A `_kiro.dev/commands/execute`, or the same command sent as prompt text, that waits for Claude
  Code (`usage`: get_context_usage; `mcp` and `tools`: mcp_status and the wait for MCP servers to
  start; the model listing) is cancelled by `session/cancel`, by its own `$/cancel_request`, and
  by the session's close (`_kiro.dev/session/terminate`, the server's shutdown, the connection
  closing). It answers at once, `{success:false,message:"Command cancelled"}`, or
  `stopReason:"cancelled"` as prompt text, and whatever its wait yields later is dropped.
* For `/clear` and an agent swap the cancel also interrupts the session, which kills the
  agentSpawn hooks they run first: nothing changes, and as prompt text the answer is its message
  followed by `stopReason:"cancelled"`, never `end_turn`. `/model x` and `/effort x` are not
  interrupted; they finish and answer what they did.
* A command withdrawn by `$/cancel_request` while it is still queued never runs; it is answered
  when it reaches the head of the queue. `session/cancel` cancels queued prompts, not queued
  commands.
* `commands/execute compact` is cancelled by the same three: its compaction turn is interrupted
  (compaction status `failed`) and it answers `Command cancelled` once its status and metadata
  frames are out, so nothing of it follows the answer. A compaction Claude Code finished before
  the cancel reached it (its `compact_boundary` seen) is reported `completed` and answers
  success. One that fails for another reason answers that reason (for example `No messages to
  compact`). `/compact` sent as prompt text answers `end_turn` first and then sends its status
  frames, as kiro-cli does.
* A mode change (`session/set_mode`, or `session/set_config_option` with `mode`) is cancelled
  only by its own `$/cancel_request`; `session/cancel` leaves it alone. Withdrawn while queued it
  never runs; withdrawn while the target agent's agentSpawn hooks run, they are killed. Either
  way it answers the JSON-RPC error `-32800` (`Request cancelled`) and the agent is unchanged.
  Past the hooks it finishes and answers what it did.
* Every session start (`session/new`, `session/load`, the restart after a stuck cancel) runs
  under a start signal (`session/startSignal.ts`) that the server's shutdown (stdin EOF, a
  signal) and the request's own `$/cancel_request` abort. A start still running its agentSpawn
  hooks is cancelled: the hooks are killed, no record or lock of it stays, and the request
  answers `-32800` (`Request cancelled`), or the internal error `Server is shutting down` during
  a shutdown.

## KiroCrew (persistent pipeline) on Claude Code

[KiroCrew](https://github.com/kirodotdev/KiroCrew) (Apache-2.0) is Kiro's persistent,
self-hosted agent workspace: persistent sessions, memory and lessons, self-evolving
skills, checkpointed long-running tasks, schedules and heartbeats, delegation, a web
dashboard, CLI and messaging channels. Its default agent backend is `kiro-cli` spoken to
over ACP.

kiro-claude includes all of it by:

1. vendoring KiroCrew unmodified as a git submodule at `vendor/KiroCrew` (pinned commit);
2. implementing the `kiro-cli` contract KiroCrew relies on (`--version`, `acp --help`,
   `chat --help` probes, `acp --agent-engine v2 --agent <name>`, the kiro ACP dialect,
   `~/.kiro/agents` + `~/.kiro/sessions/cli` files) in `kiro-claude acp`;
3. `kiro-claude crew …` commands that build KiroCrew from source, point it at a `kiro-cli`
   shim that execs kiro-claude, and manage the gateway lifecycle.

KiroCrew treats `kiro-cli` as signed out without a kiro-cli identity store, which makes it tear
down backend processes every turn. `crew setup` therefore writes a token-less identity stub,
**only when no real kiro-cli store exists**, and never modifies an existing one.

KiroCrew itself is untouched; every model call it makes goes through kiro-claude to your
installed Claude Code.

**Stopping the gateway.** `kiro-claude crew stop` (`crew/gateway.ts`):

1. runs `kirocrew stop` and waits up to `--timeout` (default 30 s) for the gateway to exit; if it
   still runs and its pid is known, it gets SIGTERM and, 10 s later, SIGKILL. The gateway and its
   children are known by pid and start time from a snapshot taken while it still ran, so a
   process that later reuses one of their pids is never signalled;
2. reaps orphaned `kiro-claude acp` processes whose environment has `KIROCREW_SPAWNED=1` and the
   same HOME;
3. ends what is left of the gateway's own process tree (KiroCrew's history-index worker);
4. removes `run/token`, `run/ready.json` (which holds the token too) and the token in the READY
   line of `run/gateway.out`.

It prints `Stopped (pid <n>); <k> orphan agent process(es) reaped`.

**Gateways that crashed (Linux only).** A gateway that crashed while one of its children kept the
lock it inherited is gone, yet KiroCrew reports the lock as held (`kirocrew gateway-pid`: `held`,
or `indeterminate` on Linux). When `run/ready.json` proves the gateway is gone (this boot, its
start time, it led its own process group, no process has its pid), `crew stop` retires the
members it left in its process group that carry this crew's HOME and `KIROCREW_KIRO_BIN` and
started after it (SIGTERM, then SIGKILL), and says so: `Stopped (pid <n>, which had already
exited; <m> leftover process(es) of its process group retired); <k> orphan agent process(es)
reaped`. That evidence (pid, start time, boot id, HOME, `KIROCREW_KIRO_BIN`;
no token) is kept in `run/crashed.json` whenever `crew start` (after a crash) or `crew stop`
removes `ready.json`, for at most 16 gateways; entries are dropped after a reboot or once nothing
provable of the gateway is left. Every later `crew stop` retires what those gateways left, by the
same proof (`; <m> leftover process(es) of the process group of an earlier gateway (pid <n>,
which had already exited) retired`), and `crew start` warns while such leftovers run. The proof
needs every member's environment, which only `/proc` gives: off Linux nothing a crashed gateway
left is signalled, and a stop that cannot free the lock says so. Every signal is checked against
the process's start time right before it is sent.

`crew stop` exits 1 when the gateway did not exit or its lock is still held afterwards (its
holder may be outside the group), listing everything it signalled, and, when no gateway was
running, when a leftover of a crashed one survives SIGKILL. (A leftover of an earlier gateway that
survives SIGKILL while a running gateway is stopped is reported, with exit 0: known gap.)

**Uninstalling.** `crew uninstall` stops the gateway first (and changes nothing when that fails),
restores the KiroCrew settings setup changed (unless they were changed since), and removes the
launcher, the identity stub (only if kiro-claude created it), `crew.json`, and the run files and
logs under `run/` (`gateway.out`, `gateway.err`, `setup.log`, `ready.json`, `token`,
`crashed.json`). `--purge` also removes the private claude-agent-acp bridge (only while it holds
nothing else), the npm and pip build caches, and then the crew state directory itself when it is
empty. KiroCrew's data home and its checkout are kept. Both purge paths print what they removed
(also crew's files inside a folder that is kept, such as `cache/npm`) and what they kept:
`Purged <dir>` only when the state directory is really gone (lstat fails with `ENOENT`);
otherwise `Purged <entries> from <dir>` or `Nothing to purge in <dir>`, then `; kept <entries>`
(with `crew.json`, the checkout it names is labelled as such when it is inside), or, when nothing
is left, why the directory itself stays:
it is a symbolic link (purged through the link, crew's entries of its target only; the link is
never removed) or rmdir failed (its error code, e.g. `EBUSY` for a mount point). Without
`crew.json` (after an earlier plain uninstall) a plain uninstall exits 1 ("not set up yet"), but
`--purge` runs just the purge,
by the same ownership rules: the bridge only while it holds nothing else, the caches, the run
files above, an empty `bin/` and `run/`, `crew.json` temp files, then the state directory when
empty. Unknown entries and a checkout inside are kept, with the same report (exit 0). A state
directory that does not exist, or is a dangling symbolic link (named as such; the link is kept),
leaves nothing to purge (exit 0). It
refuses, removing nothing (exit 1), while `run/ready.json` names a gateway that may still run (its pid is alive and
neither its boot nor its start time proves it another process, or the file cannot be read or
names no pid), since
`crew stop` cannot stop that gateway without `crew.json`. A `crew.json` that is there but corrupt
or cannot be read (a symbolic link loop, a state directory that is a file) exits 1 either way with
its error, removing nothing.

## Compatibility probe

`claude --version` and `claude --help` are parsed once per version and cached, so
kiro-claude passes only flags the installed Claude Code supports.

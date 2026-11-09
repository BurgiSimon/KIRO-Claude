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

A restart that fails (or a child that dies) leaves the session without a child. It keeps what
changed (an agent swap stays done, a context rule stays added), and the next prompt starts Claude
Code with it. Until then `/tools`, `/mcp` and `/context` describe that configuration, the one
the failed start tried, not the one before it (`session/kiroSession.ts` `spawn`). After a failed
restart `/tools` lists the new agent's built-in tools and no MCP tools, because no server runs.
After a crash it lists the tools the dead child reported. The MCP servers are `stopped`
("Claude Code is not running; the next prompt starts it"), not `pending`, so nothing waits for
servers that no child will start. A child that is still starting reports them `pending`. A
listing never starts Claude Code itself: retrying a start that just failed could take the whole
initialize timeout, and a client polling `/mcp` would retry it on every poll.

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
  <feedback>` for a document awaiting review, `kiro-claude spec run <name> --next` once tasks.md
  has tasks, `kiro-claude spec status <name>` for a spec with a refused file, and `/spec <name>
  in kiro-claude chat` when only the chat can draft the next document (an existing folder without
  its first document: `new` refuses an existing folder). A checkpoint's Stop label and stop hint
  pass the document under review (`resumeHint(name, awaiting)`), so at every checkpoint, the
  tasks.md one included, the CLI names `approve` / `revise`, as the headless stop there does: the
  approval of tasks.md is not saved anywhere, so a tasks.md under review derives as `execution`,
  and `run <name> --next` would run a task and skip the review (r8 #10). That holds when the
  document under review was written: at the checkpoint of one the turn did not write (or a
  revision emptied), `approve` / `revise` act on the document the files say awaits review, or on
  none, so the hint is the one outside a checkpoint (for the first document `/spec <name> in
  kiro-claude chat`, where both would answer "Nothing to approve yet"). The review is derived
  from the files alone (research 03 §1.11.2), so a checkpoint's document need not be the one
  plain `approve` / `revise` act on: when an earlier document is drafted (again) next to a
  tasks.md that has tasks (a requirements-first or bugfix `design.md` removed and drafted again,
  a design-first `requirements.md`), every document is present and the files say tasks.md. Such a
  checkpoint names the document explicitly, `approve <name> --doc <doc> · revise <name> --doc
  <doc> <feedback>` (`workflow.reviewDocOption`; the CLI and `/spec` in chat, the Stop label, the
  stop hint and the headless "… is waiting for review" line), never `run <name> --next` (r9 #6;
  so does the tasks.md checkpoint of a tasks.md without parseable tasks, where the files say
  design.md). `approve --doc <doc>` approves that document as the checkpoint's Approve does
  (drafts the next one, or answers "Spec ready" for tasks.md), `revise --doc <doc>` revises it
  (`workflow.explicitReview`); the document and every one before it must be present
  (`requirements` names a bugfix spec's `bugfix.md`). In chat, `/spec revise` takes `--doc` only
  before the feedback, which is free text: a `--doc` in it stays feedback, never retargets the
  revision (r9 #6 verification). DECISION (Kiro is silent; `.config.kiro`
  may not be extended): an explicit option rather than a recorded checkpoint stop or file times.
  Outside a checkpoint (`new` of an existing spec, `run` or `analyze` without its document) a spec
  with tasks still gets `run <name> --next`, also one stopped unapproved at its tasks.md review
  (r9 #9: that approval is recorded nowhere).
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
  never drafted over as if it were missing. It also counts as present when the type of a spec
  without a usable `specType` (no `.config.kiro`, a legacy `{"generationMode": …}` one) is
  inferred: an existing `bugfix.md` that is refused keeps the spec a bugfix spec with `bugfix.md`
  awaiting approval, never a feature spec at "drafting requirements.md" (r8 #9). Such a
  document's checkpoint offers no Approve and `approve` refuses
  it (a headless flow ends with an error there); a revision turn still runs and its write of the
  document is denied: the gate refuses a link there (with the reason), and a document that is not
  a regular file or that the user cannot read, whose write the gate would allow without asking,
  is left out of the turn's write allowance and named in the restriction with its reason
  (`workflow.restrictionFor`, `specPhase.refusedWritePaths`): the gate's spec-phase denial says
  why ("only (nothing) may be written now (<doc> is not a regular file)"), in plan mode too, never
  the plan-mode denial, which leaving plan mode would not lift (r9 #7). The same holds
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
  model it had before. Claude Code runs the model at the session's effort: a Claude Code started
  on a model without that level (some models have no effort levels; after a resume on one, an
  `/agent swap` to an agent that pins one) runs without one, and a later `/model` to a model
  that has the level sends it (a silent `/effort <level>`, queued for the next prompt while a
  turn runs or a restored history waits for its line). A Claude Code that already has the level gets no extra command,
  also after a `/model` through a model without the level: Claude Code keeps the level across
  model switches and applies it again on a model that has it (verified). Each change reaches
  Claude Code as one command: an `/effort` typed while a turn runs (at an approval prompt) or
  while Claude Code is down, and the level a `/model` typed while a turn runs leaves for the next
  prompt, wait for that prompt, and are not sent a second time when a `/model` since sent the
  level (a Claude Code restarted meanwhile, which starts with the level, still gets it once).
  A `tail` carries the
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
  conversation lost (the resume makes the fork again). The other records that start as a fork
  are written with the fork still to be made from the start too: a `/spec` phase session, the
  continuation a `/spec` flow hands to the chat, and a `/chat load` of an export without a
  transcript whose Claude session (or the source of its pending fork) still has one. A crash
  while their Claude Code starts makes `chat --resume` fork the source again; it does not fall
  back on the saved history (`Claude Code could not find the saved conversation…`). A `/chat
  load` of an export without a transcript whose Claude sessions are gone too is no fork: it
  starts a new conversation with the export's saved history, which goes with its first message.
  A crash while its Claude Code starts (or a quit before that message) makes `chat --resume` try
  that new conversation, which Claude Code does not have yet, and fall back on the saved history
  with the warning above; the history still goes once, with the first message. A transcript
  Claude Code has of it by then (the first message reached it before a crash, or a local command
  such as a refused `/compact`) is resumed, never replaced. An untouched copy (a `/spec` continuation with no message of its
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
  type-ahead); presses typed ahead stop the chat once, as in a cooked-mode program, where the
  first press stops the job and the next ones go to the shell (one is kept, and a replayed one
  drops any other). DECISION: Q stops at once there (its terminal is in cooked mode while it
  answers); kiro-claude stops between turns, when nothing of the turn goes on without it (hook
  commands too run in process groups of their own and keep running while it is stopped).
  DECISION (r8): however kiro-claude is stopped (its own Ctrl+Z, also at an approval prompt
  in the middle of a turn while other concurrent calls' preToolUse hooks run; `kill -TSTP` or
  `kill -STOP` from elsewhere), the stop does not count against a hook command's timeout nor
  against a control request's (initialize included): `runningTimeout` (`util/process.ts`) decides
  an expiry one event-loop turn after its timer fired, so a hook's exit or Claude Code's answer
  that arrived meanwhile is handled first (libuv runs expired timers before the poll phase that
  delivers them), and a stop's duration (an unref'd 100 ms heartbeat while such timers are armed,
  confirmed by the SIGCONT that ends it; never more than the stop, unless the event loop was
  blocked right before it) is given back, so a hook still running after the stop gets the rest
  of its time. A hook that exited during the stop is judged by its exit status, a block included;
  a hung one still times out after its timeout of running time; a blocked event loop extends
  nothing, neither without a SIGCONT nor when the loop ran on before one came (r8
  verification: a block, then a short or stray stop, gave the block back too). Before, a stop
  that outlasted a running preToolUse hook's timeout counted that hook as timed out, which never
  blocks, even when it had blocked the tool, and a trusted tool then ran. Every stop counts, also
  several back to back (r9 #0): the clock's SIGCONT listener runs first (prepended) and credits
  both the gap the last heartbeat saw and the span since it, and the expiry moves one more turn on
  when the turn after its timer took longer than a heartbeat (at most 10 turns in a row), so a
  hook's exit or an answer queued during a stop that began after the timer fired is seen first.
  Before, kiro-claude stopped again inside the SIGCONT dispatch (the terminal reader set raw mode
  from the background: SIGTTOU) was credited only the longer of the two stops, and a hook that
  exited 2 during the second one was killed as timed out.
  After `fg` raw mode and bracketed paste are back and the prompt being read is drawn again with
  its half-typed line; an approval prompt still takes its answer. As the terminal's session
  leader (`ssh -t host kiro-claude chat`, `docker run -it`, `tmux new 'kiro-claude chat'`) there
  is no shell to return to: the kernel discards the stop and the chat goes on as before.
  readline's own suspend is not used: it left the input paused after `fg`, and in cooked mode
  when the stop was discarded (Enter no longer submitted, and Ctrl+D was an end of input taken
  for a hangup). A stop from elsewhere (`kill -TSTP` or `kill -STOP` of kiro-claude, then `fg`)
  leaves the terminal in the shell's cooked mode; the reader takes it back at SIGCONT the same
  way, the prompt being read drawn on the shell's fresh line. Nothing sees such a stop begin
  (SIGSTOP cannot be caught; kiro-claude does not catch SIGTSTP), and libuv dispatches the SIGCONT
  only after the other I/O of the poll it comes in: before r11 the keys typed in the shell before
  `fg` (`sleep 1; fg`) were read first, in its canonical mode, so a Ctrl+D (canonical mode's end
  of file, a 0-byte read) ended the input as at a hangup (an open approval was denied unanswered,
  the chat quit, the keys after it ran in the shell), a Return was a newline (Ctrl+J, a soft
  newline), and after a `kill -CONT` from elsewhere while the shell ran a command, keys typed
  ahead made the chat read the terminal from the background, where the kernel's SIGTTIN stopped
  it inside that read, restarted after every continue, so `kill %1` left it 'Stopped' until `fg`
  (r11 #0). So while the reader's input flows in terminal mode (the prompt, an approval, a turn's
  type-ahead; none while away, while a child owns the terminal, in line mode) it keeps an unref'd
  heartbeat (`INPUT_BEAT_MS`, 100 ms: 10 wakeups a second, a clock read each): the poll that the
  stop interrupted then has a finite timeout and returns to the timers phase before the next poll
  (with no timer it waited again and read the keys and the signal together), and a beat more than
  250 ms after the one before (`INPUT_GAP_MS`) parks the input, paused and its reading stopped
  (a paused tty stream still reads one more chunk; `process.stdin` stops a tick after a pause
  through a listener of Node's own, which the reader does at once), until the check phase after
  the next poll. A prompt drawn in that poll leaves it paused (`LineReader.promptLine`: readline's
  `prompt()` resumes a paused input, and Claude Code's output queued during the stop, read in that
  poll before the SIGCONT is dispatched, can draw one: a notice printed above the prompt, a
  question or an approval asked, the prompt after a turn; the shell's queued keys were then read
  before the SIGCONT after all, r11 verification). A SIGCONT in that poll makes the gap a stop:
  the keys stay in the terminal until the retake reads them as typed in the shell's cooked mode
  (below). None makes it a blocked event
  loop (a long synchronous step, a GC pause, a slow machine): the input is resumed as it was,
  nothing drawn, no mode changed, the keys read raw and in order (a stop that began after that
  poll is seen by the next beat). Ctrl+Z (its stop pauses the input first) and the reader's own
  stop in the background (below) are made while away, without the heartbeat, so their continue
  is never taken for a stop from elsewhere (one retake, one redraw). Not seen in time: a stop
  shorter than 250 ms (no one types and runs `fg` in that time) and one that lands in a timers
  phase after the beat. An end of input read with no beat since such a stop (the second case)
  while the input is still the controlling terminal is canonical mode's end of file, a Ctrl+D
  typed in the shell (a hangup takes the controlling terminal away before its read returns), so it
  is not taken for a hangup: the chat quits as at the end of piped input, without waiting for a
  SIGHUP that does not come (DECISION: the input stream is over either way; reopening the terminal
  is not worth it for that window); after a shorter stop a beat has run first, and the chat quits
  after the 500 ms wait for a SIGHUP.
  As the terminal's session leader (no shell can take the terminal) the terminal stays raw
  during such a stop, and the keys typed meanwhile are read as the raw keys they are (a Ctrl+J
  stays a soft newline). The stop clock (`util/process.ts`, above) keeps its own heartbeat,
  unchanged. From the stop on the reader's input
  is paused and nothing of it is drawn; it takes the terminal back two event-loop turns after the
  continue, never inside the stop's own callback or the SIGCONT dispatch, and only when
  kiro-claude is the terminal's foreground process group (r9 #0/#1: a terminal mode change from
  the background stops it again at once with SIGTTOU, before the stop clock and the signals that
  came with the continue had run). So `kill %1` of a chat stopped with Ctrl+Z (bash sends SIGTERM,
  then SIGCONT, and keeps the terminal) closes it and dies of SIGTERM at once (before, it stayed
  'Stopped (tty output)' with its lock until `fg`, and then drew its prompt); a muted reader
  touches nothing of the terminal. Continued in the background (`bg`, `kill -CONT` while the
  shell holds the terminal) the chat stays off the terminal (no prompt, no mode change, nothing
  read) until `fg`. While no read waits for the terminal (a turn runs: a stop from elsewhere
  during it, then `bg`) it runs on, the turn's output still written there (unchanged; with `stty
  tostop` such a write stops it at the default SIGTTOU, as any background job's); once a read
  waits (the prompt at the turn's end, an approval, a question) it stops again like a background
  job that reads its terminal, as Q's rustyline (whose raw-mode tcsetattr gets SIGTTOU there) and
  any terminal program do (r11 #2, `stopForTerminal`): SIGTTIN at its default action to
  kiro-claude's process group, so bash reports the job 'Stopped' (`jobs -l`: 'Stopped (tty
  input)') and takes the terminal, and `fg` continues it with a SIGCONT. The reader looks at the
  foreground every 20 ms while away in the background (`FOREGROUND_POLL_MS`: a `/proc/self/stat`
  read; never at the prompt), and stops only at such a look, never inside the SIGCONT dispatch:
  after a continue the signals that came with it are dispatched first (two event-loop turns), and
  a further stop needs another poll interval and another look at the fatal-signal state, so
  `kill %1` of the self-stopped chat (SIGTERM, then SIGCONT) and a hangup (SIGHUP, SIGCONT) close
  it at once, and a plain `kill <pid>` waits for a continue as for any stop (r10 #5). `bg` or a
  `kill -CONT` of the self-stopped chat continue it in the background, where it stops again at the
  next look. Between r9 and r11 it only polled there and ran on (bash's `fg` of a job it knows to
  be running sends no SIGCONT: the poll noticed it); but something above the chat may depend on
  the job-control stop: under `sudo` with `use_pty` (sudo's default on current Debian and Ubuntu)
  sudo keeps its inner pty's foreground on its monitor while it is in the background and hands it
  to the command only once sudo itself is continued, which follows the command's job-control stop,
  so after Ctrl+Z, `bg`, `fg` the chat never came up. Before r9 the retake's tcsetattr stopped it
  with SIGTTOU inside the ioctl, restarted after every continue, so `kill %1` never closed it.
  The stop is the whole process group's, as the kernel's own SIGTTIN for a background read: bash
  counts a job stopped only once none of its processes runs, so a wrapper (`npx`, a script) or
  the rest of a pipeline (`kiro-claude chat | tee log`) left running kept the job 'Running' and
  `fg` sent no SIGCONT (r11, bash 5.2). Claude Code and hook commands run in process groups of
  their own and go on. SIGTTIN rather than SIGTTOU (caught while a child owns the terminal,
  below) or SIGTSTP (sudo answers a command's SIGTSTP by suspending itself even when it is in the
  foreground already; at a SIGTTIN or SIGTTOU there it resumes the command in the foreground).
  But a stop that comes back sooner than 20 ms (`STOP_ANSWERED_MS`, no person's `fg`/`bg`/`kill`)
  with the chat still in the background makes the next one a SIGTSTP (`TerminalStops`; one
  that lasted makes it a SIGTTIN again, a SIGTSTP that never stopped it, back within 2 ms
  (`STOP_DISCARDED_MS`: discarded in an orphaned group, or blocked), is not sent again in that
  stretch, and each wait or away stretch starts with SIGTTIN): sudo's
  foreground resume gives the inner pty to the group that had it at the stop, which after a
  `!cmd` that died holding it is the dead one (below), so with SIGTTIN alone the chat was stopped
  and continued every poll and the shell, blocked on sudo's job, never got its terminal back; a
  SIGTTIN that is blocked or discarded (an orphaned group) comes back at once too. No
  stop where it cannot help: off Linux, for an input that is not the controlling terminal, while
  a fatal signal is in, while a listener for the signal is installed, and as the terminal's session
  leader (`ssh -t host kiro-claude chat`: its group is orphaned, as is that of a chat whose
  starting shell has gone, `bash -mc 'kiro-claude chat & …'`; Linux discards a default-action
  SIGTSTP, SIGTTIN or SIGTTOU there, so the poll goes on alone, as before r11). A chat stopped this
  way whose job then becomes orphaned (that `bash -mc` shell exits while it is stopped) gets the
  kernel's SIGHUP and SIGCONT for an orphaned stopped group and closes as at a hangup. Until the
  retake the terminal is in the shell's cooked mode: keys typed then are echoed by the terminal and
  queued with Return made a newline (ICRNL), which raw mode reads as Ctrl+J, a soft newline, and
  a Ctrl+D as canonical mode's NUL end-of-file placeholder, which readline drops (r10 #2: polled
  every 250 ms, a line typed right after `fg` was not submitted). So when the reader takes the
  terminal back from the shell's cooked mode (the retake after a stop, which after a stop from
  elsewhere also finds the keys typed in the shell before `fg`, above; `resume(true)` after a
  child that ended while kiro-claude was in the background, and the first prompt of a chat whose
  start finished while it was in the background, so that it waited there for `fg`:
  `LineReaderOptions.cooked`, decided once, after the start), what it reads at the
  next poll phase, i.e. what the terminal had already queued (`cookedKeys`; up to the second
  check phase from the switch), is read as typed in cooked mode: a newline is Return and a NUL at
  a line start is Ctrl+D. A key typed after that is raw, a Ctrl+J a soft newline, and so is
  everything from a bracketed-paste start on (the terminal brackets pastes only once the retake
  turned bracketed paste on again, after raw mode). The terminal's echo of such a line stays above
  the redrawn prompt (the prompt starts at column 0 and erases a half-typed echo). Not otherwise:
  a newline queued while the chat started in the foreground (also after a `fg` that came while it
  was still starting, after Ctrl+Z or `bg` or as `kiro-claude chat &`: the start then finishes in
  the foreground, and nothing is drawn before the greeting either way; README says so), or during
  a `!cmd` that ended in the
  foreground without reading it, stays Ctrl+J, a soft newline, as in Q (rustyline reads it as
  Ctrl+J, which Q binds to insert a new line), so a multi-line paste there (unbracketed: the
  terminal is cooked) stays one input and none of its lines (`!cmd`, `/command`) runs before an
  Enter (r10 verification: read as typed, each pasted line was submitted on its own). And an
  approval prompt (a read that discards type-ahead) never reads such keys as typed: a `y` +
  Return typed blind during an approval-time `!cmd`, or into the shell before `fg`, answers it
  only with an Enter typed at its question (r10 verification). The foreground test
  is Linux's `/proc/self/stat` (the process group against the controlling terminal's foreground
  group, when the input is that terminal: its own device or `/dev/tty`, as in `kiro-claude chat
  < /dev/tty`, which the r9 verification found taken for another terminal, so in the background
  the chat stopped again and `kill %1` never closed it). DECISION: elsewhere (no portable tcgetpgrp without a
  native module) the reader takes itself for the foreground: the retake is still deferred past the
  signals that came with the continue, and after `bg` the chat stops again (SIGTTOU) until `fg`, as
  before. The first prompt takes the terminal only in the foreground too (`Repl.run`, r10 #1).
  Stopped while it starts (Ctrl+Z: the terminal is still cooked, so the terminal's SIGTSTP stops
  the job; `kill -STOP`) and continued in the background (`kill %1`, `bg`), or started as
  `kiro-claude chat &`, the chat created its line reader from the background: readline's raw-mode
  switch stopped it with SIGTTOU inside that ioctl, restarted after every continue, so `kill %1`
  never closed it and it kept its lock until `fg`, then drew its greeting and died (Claude Code's
  answer to `initialize`, queued during the stop, is read before the signal that came with the
  continue). Now it waits off the terminal, asking every 20 ms, before its greeting, and stops
  meanwhile like a background job that reads its terminal (`Repl.awaitForeground`, the same
  self-stop as the reader's above, r11 #2: with polling alone, `sudo kiro-claude chat &` and
  `fg`, or Ctrl+Z while it started, `bg`, `fg`, never came up under `sudo` with `use_pty`, a
  regression of the r10 #1 wait); `fg` continues it and the greeting comes up, and a fatal
  signal meanwhile (`kill %1`, a hangup) closes it at once, nothing drawn. DECISION: a first INPUT
  waits for `fg` too
  (nothing of the chat runs unseen before its greeting). What the chat writes to a terminal it is
  in the background of while it starts (a session notice, a Node warning) waits for the
  foreground as well (`holdTerminalOutput`, the stand-in a child's guard uses, below): with `stty
  tostop` such a write stopped it the same way (SIGTTOU at its default action, its SIGTERM
  caught, so `kill %1` never closed it); it is written in order once in the foreground, before the
  greeting, and dropped after a fatal signal. Before the REPL (the CLI's own warnings, the
  `--resume-picker` prompt and its read) nothing is held or deferred: a stop there (SIGTTOU with
  `stty tostop`, SIGTTIN at the picker's read) is any program's, and `kill %1` ends it at once
  (no handler of kiro-claude's is installed and no session or lock exists yet). While `$EDITOR` or `!cmd` owns the terminal, Ctrl+Z is the terminal's own: it stops
  that program and kiro-claude together, as one job (the child runs in kiro-claude's process
  group, as in Q). Such a child may change the terminal mode from the background: vim when `bg`
  continues it, vim's deadly-signal path or a trap running `stty` at the SIGTERM of `kill %1`. The
  kernel answers with SIGTTOU to the whole group, which at its default action stopped kiro-claude
  too, before its SIGTERM close ran (r10 #0: 'Stopped (tty output)' with its lock until `fg`, and
  the 2 s grace run out by then). So from after the reader hands the terminal over until it takes
  it back, kiro-claude catches SIGTTOU (`ExitSignals.childOwnsTerminal`, `Repl.guardChild`): once
  a fatal signal is in it is dropped and the close runs; otherwise kiro-claude stops itself two
  event-loop turns later, as before (with SIGTSTP, so bash says 'Stopped' rather than 'Stopped
  (tty output)', and the listener is still there for the next continue), and `bg`, `fg` and the
  child's own exit work as they did. A caught SIGTTOU has a hazard of its own (r10 #0
  verification): a terminal mode change or a `stty tostop` write that kiro-claude itself makes
  from the background then restarts forever (SA_RESTART; 100% CPU, no JS runs, only SIGKILL ends
  it). So the listener exists only while the reader is suspended (it is installed after
  suspend()'s mode change and removed before resume()'s), what kiro-claude writes to a terminal
  stdout or stderr meanwhile (a notice, a Node warning) is held and written once the child is
  done (in the foreground; dropped after a fatal signal, as everything after one), and it is
  removed at the re-raise and at any exit or uncaught exception, before Node's own exit restores
  the terminal mode (libuv's reset of its terminal descriptor runs with SIGTTOU unblocked; only
  its fds 0-2 restore blocks it). It is not installed at all while the debug log
  (`$KIRO_CHAT_LOG_FILE`) is that terminal or `/dev/tty`: the log's writes are synchronous and
  cannot be held, and with `stty tostop` one from the background spun that way (r10
  verification); such a chat stops in the background as before r10. A child that ignores SIGTERM is not killed: it outlives the chat
  as a member of any job `kill %1` ends would, as under Q (such children are not tracked: [Signals
  and child processes](#signals-and-child-processes), its last bullet). The child gets the terminal with raw mode
  and bracketed paste off, as from Q's rustyline and from bash, so a paste into a cooked-mode
  child (`!cat > notes.txt`) arrives without the ESC[200~ … ESC[201~ markers (r9 #8). When the
  child is done the reader turns raw mode and bracketed paste on again: bash turns bracketed
  paste off before `fg` continues the job, and vim does at exit (r8). The spec
  workflow's "Open in $EDITOR" goes the same way in the chat (`ReplContext.openEditor`, with
  `$VISUAL` or `$EDITOR` as the command).
* `$EDITOR` (`/editor`, `/reply`, the spec checkpoint's "Open in $EDITOR") and `!cmd` get the
  terminal whenever the chat reads the keyboard: terminal mode on kiro-claude's own stdin,
  whatever its stdout is (`Repl.childIo`, `repl/external.ts`). `kiro-claude chat | tee
  session.log` reads raw keys too, so there as well the child gets the terminal on stdin and the
  reader is suspended meanwhile (r9 #2: before, such a child got /dev/null, vim hung, the reader
  took the keys typed for it as type-ahead, and the spec flow lost its edit). As in Q, which runs
  both with every stream inherited, their output goes to kiro-claude's own stdout and stderr,
  the pipe included, in order with what the chat writes before and after them: writes to a pipe
  are asynchronous, so what Node still queues for a consumer that lags (the end of an answer, the
  prompt, the bracketed-paste switch) is handed to the OS before the child starts, waiting as a
  blocking write in Q would (`Repl.flushedForChild`; r9 #2 verification: a `!cmd` typed ahead
  printed in the middle of a long answer behind a slow `| tee`). DECISION: not to
  the controlling terminal (`/dev/tty`), which would keep an editor's screen out of the log but
  could overtake output still in the pipe; vim then says its output is not a terminal and waits
  2 s, as under Q. A Ctrl+C in a cooked-mode child (`!sleep 30`) is the terminal's SIGINT for
  the whole pipeline: the `tee` or `cat` ends too, and the chat goes on without a screen, as Q or
  any program in a pipeline would (`tee -i` ignores it). With piped input a child's stdin
  is closed, so it never takes the chat's next input line, and its output goes through the chat.
  The reader takes the terminal back after the child only in the foreground (`Repl.handBack`): a
  child that ends after Ctrl+Z and `bg` leaves the chat off the terminal, in the background, until
  `fg` (asked every 20 ms, like the reader after a stop; what the terminal queued
  meanwhile, keys typed after `fg` before that and those the child left unread, is read as typed
  in the cooked terminal, r10 #2; after a child that ended in the foreground a newline typed
  during it stays a soft newline, as in Q), stopped meanwhile like a background job that reads
  its terminal (the reader's self-stop above, r11 #1/#2: 'Stopped', `jobs -l` 'Stopped (tty
  input)'; under `sudo` with `use_pty` the polling alone never came up after `fg`), and a fatal
  signal meanwhile closes it at once, the reader not resumed (the terminal stays as the child left
  it). The same stop covers a job-control child that dies holding the terminal (r11 #1): `!bash
  -i` puts itself in a process group of its own and makes it the terminal's foreground, and gives
  the terminal back only when it exits normally; SIGKILLed (`kill -9 $$` in it, a crash, the OOM
  killer) it left its dead group in the foreground, the shell blocked in waitpid on the chat's
  job, Ctrl+C, Ctrl+Z and Ctrl+D reaching nobody, and the chat polling for good with its lock.
  Now the chat stops within a poll, bash takes the terminal back ('Stopped'), and after `fg` the
  child's exit status that the guard held (`Self exited with status: signal: 9 (SIGKILL)`) is
  written in the foreground, then the prompt; `kill %1` closes it there, the held status dropped.
  The guard is released only after that wait, and the stop is SIGTTIN, which the guard does not
  catch. As the terminal's session leader (no shell) the stop is discarded and such a dead group
  still leaves the chat polling until a signal or the hangup (no tcsetpgrp in Node). Under `sudo`
  with `use_pty` the dead group is on sudo's inner pty, and sudo, in the foreground, answered each
  SIGTTIN by resuming the chat at once (its monitor gives the pty back to the group that had it at
  the stop: the dead one, which fails); the SIGTSTP that follows a stop answered at once (above)
  makes sudo suspend itself, so bash gets the terminal back ('Stopped') and `kill %1` closes the
  chat; it cannot come back there (after `fg` sudo restores the dead group again and the chat
  stops again).
  Before r9, the reader's raw-mode switch from the background stopped
  the chat again (SIGTTOU) and `kill %1` never closed it, as r9 #1 at the prompt (r9 #2
  verification; plain terminal and piped stdout alike). What the chat itself writes to the
  terminal while the child runs (a session notice) waits until the child is done (r10 #0, above);
  with a piped stdout it still goes into the pipe at once.

`chat --no-interactive`: the first Ctrl+C interrupts the turn (exit status 130 once it ends); a
second one closes the session.

### Fatal signals: close, then die of the signal

Both front ends use `ExitSignals` (`repl/exitSignals.ts`) on POSIX:

* It handles SIGHUP and SIGTERM for the whole run (a closed terminal tab, `kill`), and SIGINT
  while the session starts (Claude Code initializing, agentSpawn hooks), during the final close
  (after `/quit`, after the headless answer) and from the first SIGHUP or SIGTERM on (a SIGINT
  after one is a second signal, below). Otherwise Ctrl+C belongs to the front end (above). After
  a SIGHUP or SIGTERM the front end's own SIGINT handler still runs for such a SIGINT, and does
  nothing visible: the REPL's ends its muted read or interrupts the turn being closed,
  headless's interrupts a session that is already closing. In an interactive terminal the chat's
  input is in raw mode from its first prompt on, also during its final close and during a
  SIGHUP's or SIGTERM's close (unless the signal ended a stop: the shell holds the terminal, below),
  so a Ctrl+C key there is a key, which the muted reader drops, not
  a SIGINT: the close goes on. `kill -INT`, and a Ctrl+C where the terminal is in cooked mode,
  get the handling described here: headless, a chat whose input is piped, a chat still starting
  (its line reader is not up yet) and one whose terminal a `!cmd` or `$EDITOR` holds (they run
  in kiro-claude's process group, so the terminal's SIGINT reaches kiro-claude too, unless the
  program reads Ctrl+C as a key itself).
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
  kiro-claude exits with that status 5 s later. A chat that was stopped (Ctrl+Z, `kill -STOP`)
  closes the same way when the signal comes with its continue (`kill %1` in bash: SIGTERM, then
  SIGCONT; `kill -TERM` and `kill -CONT` from elsewhere; its terminal closed): the terminal reader
  takes nothing of the terminal back and reads nothing once the signal is in (r9 #1), so no
  SIGTTOU or SIGTTIN stops it again in the background, and nothing is drawn; after a stop from
  elsewhere it reads nothing before it has seen the continue either, also with keys typed ahead in
  the shell (r11 #0: the heartbeat parks the input before the poll that would read them). That holds also when
  it was stopped while it was still starting, and for `kiro-claude chat &` waiting for `fg`: the
  first prompt takes the terminal only in the foreground and nothing is written there from the
  background before it (r10 #1, above), when it stopped itself in the background because it
  needed the terminal (r11 #1/#2, above: its own SIGTTIN, or SIGTSTP, at the default action, outside any system
  call that restarts; after the continue the signals that came with it are dispatched before it
  could stop again), when
  it was stopped inside `$EDITOR` or a `!cmd` whose terminal mode change at the signal sends the
  group SIGTTOU (caught while a child owns the terminal, above; r10 #0), and when it was stopped
  during the final close after `/quit`: a signal that comes in during that close ends the process
  once the close is done, without closing the line reader, whose readline close() turned raw mode
  off from the background (a tcsetattr: SIGTTOU stopped the chat again until `fg`, r10 #3). The
  close needs the continue: a stopped process runs no handler, so a plain `kill <pid>` (SIGTERM
  alone) of a stopped chat waits, chat and lock included, until it is continued (`fg`, `kill
  -CONT <pid>`), and then the close runs at once (r10 #5). A chat that ends without a signal in
  the background (after a stop and a continue there, the final close of a `/quit` finishing
  there, or a fatal REPL error) leaves the terminal as the shell has it as well: the reader's
  close() turns no mode off and writes nothing there (r10 #3); Node's own exit then restores the
  mode kiro-claude started with, through libuv's terminal descriptor with SIGTTOU unblocked, so
  that exit waits stopped ('Stopped (tty output)') until `fg` and then ends with the chat's status
  (as any program that changes the terminal mode, rustyline's Q included).
* A second signal re-raises at once: one more than 500 ms after the first
  (`DUPLICATE_SIGNAL_WINDOW_MS`), or a different one inside that window: a SIGINT after a SIGHUP
  or SIGTERM (also in the main phase of the chat and of the headless run, above), or a SIGHUP or
  SIGTERM after a SIGINT. A repeat inside the window is the same event delivered twice, not an
  impatient user: a terminal tab closing under an interactive shell sends SIGHUP twice within a
  millisecond, an `npm` or `npx` wrapper forwards the terminal's SIGINT, and a supervisor may
  signal both the process and its group. So is a SIGTERM right after a SIGHUP, or the other way
  round: closing the terminal of an interactive bash while the chat is stopped (Ctrl+Z) sends
  SIGHUP and then SIGTERM (each with a SIGCONT) within microseconds.
* After the signal kiro-claude prints nothing more. The REPL shows no prompt, no turn error, no
  notice and nothing a command prints, drops the output of a `!cmd` still running (with piped
  input; one that has the terminal writes to stdout itself), clears a
  spinner, and neither sends nor runs input typed during the grace. Nor does such input answer a
  question that was already waiting: a command's question (`/spec new`'s name, a `[y/n]`, a menu)
  gets no answer, so the command stops without acting, and an approval prompt still open (a
  `/spec` phase session's, closed after the chat) is cancelled. A process SIGINT (`kill -INT`,
  which after a SIGHUP or SIGTERM also ends kiro-claude at once) or a terminal resize during the
  grace draws nothing either (no fresh line, no redrawn prompt; the terminal reader lets readline
  redraw its prompt line at a resize only while a read is active and no child owns the terminal,
  so a resize while an answer streams never draws a stale prompt over it). The one exception is
  the resume hint of a `/quit` whose close the signal came into, and only in the foreground (from
  the background it would be written over the shell, and with `stty tostop` the write would stop
  the chat before it could die; r10 #3). Headless prints nothing more
  (notices included) and returns no status. The same silence holds while kiro-claude dies of a
  signal the lifecycle forwarder owns (an embedder that turned these handlers off).
* A hung-up terminal also fails reads and writes with EIO: the line reader takes the input error
  for the end of input, EIO on stdout and stderr is ignored (headless interrupts its turn, since
  the answer cannot be delivered, and exits 1 unless the signal ends it first), and a half-typed
  line in the terminal is dropped, not sent (piped input keeps a last line without a newline).
  In the interactive terminal that end of input is not a quit: it reaches the REPL a moment
  before Node dispatches the hangup's SIGHUP, so the REPL waits for the signal (up to 500 ms,
  `ExitSignals.awaitSignal`) and then closes and dies of it like any SIGHUP, with no resume hint.
  Without the wait a chat whose session had already closed (after a forced stop) exited 0 before
  the signal. Ctrl+D (a key in raw mode) and the end of piped input quit at once, and so does an
  end of input read right after a stop from elsewhere that the reader did not see in time while
  the input is still the controlling terminal: canonical mode's end of file, a Ctrl+D typed in the
  shell, no hangup (`LineReader.hungUp`, r11 #0, above).
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
commands itself, and `claude/lifecycle.ts` tracks every one of them. The children it hands the
terminal to are not tracked (last bullet):

* **Process groups.** On POSIX every tracked child is spawned `detached`, so it leads a new process group
  (and session). A terminal's Ctrl+C reaches only kiro-claude, which interrupts the turn itself;
  kill signals go to the whole group (`kill(-pid)`), so shell wrappers and tool commands that
  inherited the pipes go too. On Windows children are spawned normally and killed with
  `child.kill()`. The job-control stops the chat makes of its own process group (Ctrl+Z's
  SIGTSTP, and the SIGTTIN with which it stops in the background when it needs the terminal,
  r11) therefore never reach them: they reach a wrapper above kiro-claude, the rest of its
  pipeline (`| tee log`) and a `!cmd` or `$EDITOR` (spawned in kiro-claude's group, as in Q), as
  the terminal's own Ctrl+Z or a background read would.
* **No tracked child outlives kiro-claude.** `claude` exits on stdin EOF, and kiro-claude's end of its
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
* **Not tracked: the children that get the terminal.** `!cmd`, `/editor`, `/reply` and the spec's
  "Open in $EDITOR" (`repl/external.ts`), and the interactive `claude auth login|logout`
  (`claude/auth.ts`, stdio inherited), are spawned in kiro-claude's own process group, neither
  `detached` nor tracked, as in Q, so that the terminal's Ctrl+C and Ctrl+Z reach them (see the
  Ctrl+Z and `$EDITOR`/`!cmd` bullets of [Ctrl+C in the chat](#ctrlc-in-the-chat)). They get what
  the terminal or the shell sends the whole job (Ctrl+C, Ctrl+Z, `kill %1`, a hangup), and nothing
  else: kiro-claude neither forwards a signal to them nor kills them at its exit. A SIGTERM to
  kiro-claude alone (`kill <pid>`), or one that such a child ignores, leaves it running after
  kiro-claude died, in the dead chat's process group (README: the signals paragraph of the chat).

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

## Model, effort and mode changes (ACP)

`session/set_model`, `session/set_config_option` (`model`, `effortLevel`/`effort`, `mode`),
`session/set_mode` and the `model`, `effort` and `agent` commands answer what the session reports
afterwards (`acp/server.ts` `applyModel`, `applyEffort`, `swapTo`), so the answer and the
configOptions (or the current mode) never disagree:

* A change the session took is answered as applied: `{}` for `set_model` and `set_mode`, the new
  `configOptions` for `set_config_option`, `success:true` for a command, with the
  `config_option_update` (model, effort) or `current_mode_update` and `_kiro.dev/agent/switched`
  (mode) of any change, before the answer. That includes a change Claude Code did not confirm:
  a `set_model` control request it never answered (the 60 s control-request timeout, counted in
  running time; a child that died or was restarted during it), also one for the model the session
  already has (KiroCrew sends its model pin at a session's start and at a pool claim whatever
  the session reports; an error there reads as a refused pin), an `/effort` line that failed
  after the session saved the level, an agent swap whose Claude Code restart failed. The session
  keeps and saves such a choice, and its next child starts with it (`--model`, `--effort`, the
  agent's configuration). A warning goes to the log. After such a swap, until a prompt starts
  that child, the `tools` and `mcp` commands answer at once and describe the agent switched to
  (see [Configuration changes mid-session](#configuration-changes-mid-session)). A server
  nothing has started is `failed` in `mcp`, with that reason as its `error`. The MCP report
  sends no `server_init_failure` for it and does not wait for it. The turn that starts the next
  child (the next prompt) reports that child's servers in the background, each
  `server_initialized` (or failure) as soon as Claude reports it, as after `session/new`. A
  prompt whose start fails again reports nothing, and the one after it tries again.
* A change the session did not take is an error and changes nothing: `Invalid model ID: <id>`
  (`-32602`) for an id we do not advertise and for a switch Claude Code refused (an error answer
  to `set_model`; no `config_option_update`), `-32602` for an invalid effort level, and the
  internal error (`-32603`) with the reason otherwise (a level the model does not offer, an
  unknown mode, a session that failed to start); a mode change its own `$/cancel_request`
  cancelled answers `-32800` (above). A command answers `success:false` with the same reason.

KiroCrew's session handle waits 3 s for the `set_model` answer, records the switch when there is
none and treats an error as a refusal (the old model stays), which matches both cases.

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

**Where the checkout may live.** `crew setup` refuses (preflight, exit 1; only `run/setup.log` is
written before, nothing is fetched or built and `crew.json` is untouched) a checkout, whether named
by `--dir`, `KIRO_CLAUDE_CREW_DIR` or an earlier setup, that is
in a linked git worktree, under the system temp directory without `--allow-tmp`, or that is or is
inside one of crew's own directories under the state directory, compared as given and by real
path: the npm and pip build caches (`cache/npm`, `cache/pip`; every build empties them) and the
claude-agent-acp bridge's `node/node_modules` (npm keeps only packages there), or that is the
bridge prefix `node/` itself or one of the two files npm writes in it (`package.json`,
`package-lock.json`). `npm i --prefix node/ …` leaves the rest of `node/` alone (verified with
npm 10.9 for a first install, a version change and a reinstall), so a directory beside
`node_modules`, such as `node/KiroCrew`, is allowed. `crew uninstall --purge` removes the caches,
and `node/` while it holds nothing but the bridge (unless they hold a checkout, below). The build
(also run by `crew doctor --fix`) does not start in such a checkout either (`crew/build.ts`
`crewDirHolding`). Nor does a build start while a cache holds a directory that looks like a Kiro
Crew checkout (`bin/kirocrew` or a `.git`), nor the bridge install (setup's, or `crew doctor
--fix`'s reinstall) while `node/node_modules` holds one or `node/` itself is one
(`crewDirCheckout`): an earlier kiro-claude could set a checkout up there, and while setting up
another one the build would delete it from a cache, npm from `node_modules`, and npm would write
the bridge into a `node/` that is one. Setup says
so at preflight (`<dir> looks like a Kiro Crew checkout … Move it out of there first.`), doctor in
the row's `fixed:` line.

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
`crashed.json`). `--purge` also removes the private claude-agent-acp bridge (only while `node/`
holds nothing else, such as a checkout beside `node_modules`), the npm and pip build caches, and
then the crew state directory itself when it is
empty. KiroCrew's data home and its checkout are kept: a cache or the bridge that is or holds the
checkout `crew.json` names (compared as given and by real path), or a directory that looks like a
Kiro Crew checkout (it has `bin/kirocrew` or a `.git`; symbolic links are not followed), is not
removed. The closing line says the checkout was kept only while it exists (`the checkout <dir>
does not exist` otherwise). Both purge paths print what they removed
(also crew's files inside a folder that is kept, such as `cache/npm`) and what they kept:
`Purged <dir>` only when the state directory is really gone (lstat fails with `ENOENT`);
otherwise `Purged <entries> from <dir>` or `Nothing to purge in <dir>`, then `; kept <entries>`
(with `crew.json`, the checkout it names is labelled as such when it is inside, e.g.
`cache (holds the Kiro Crew checkout)`; on both paths an entry kept for holding another checkout
reads `cache (holds a Kiro Crew checkout)`, and `node (a Kiro Crew checkout)` for a `node/` that is
one; a `node/` kept for holding something else is labelled the same way when it is or holds
one), or, when nothing is left, why the directory itself stays:
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

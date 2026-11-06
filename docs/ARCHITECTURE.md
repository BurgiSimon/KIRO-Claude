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
 │             y/n/t approvals                                          │
 │ headless/   `chat --no-interactive` runner                           │
 │ spec/       Kiro spec workflow (requirements → design → tasks → run) │
 │ acp/        Agent Client Protocol server (`kiro-cli acp` drop-in)    │
 │ session/    KiroSession orchestrator + launch builder + session index│
 │ context/    system-prompt file (steering, resources, AGENTS.md, hook │
 │             output, agent prompt) and per-turn user text (@, #)      │
 │ models/     Kiro ⇄ Claude model id mapping                           │
 │ policy/     tool map + the gate: Q engine (V2 agents), capability    │
 │             engine (V3 agents), invariants, session trust            │
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

## Permission gate (verified against claude 2.1.318)

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

## Compatibility probe

`claude --version` and `claude --help` are parsed once per version and cached, so
kiro-claude passes only flags the installed Claude Code supports.

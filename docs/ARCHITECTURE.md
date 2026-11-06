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
 │             spec, acp, login/whoami/logout, doctor, translate, ...)  │
 │ chat/       interactive REPL, slash commands, renderer, approvals    │
 │ spec/       Kiro spec workflow (requirements → design → tasks → run) │
 │ acp/        Agent Client Protocol server (kiro-cli acp drop-in)      │
 │ session/    KiroSession: one live conversation = agent + engine      │
 │ adapter/    Kiro → Claude Code translation (launch spec, tool/model  │
 │             mapping, system prompt composition, MCP, subagents)      │
 │ permissions/ Kiro permission semantics (allowedTools, toolsSettings) │
 │ hooks/      Kiro hook runner (agentSpawn, userPromptSubmit,          │
 │             preToolUse, postToolUse, stop)                           │
 │ config/     ~/.kiro + .kiro loaders (agents, steering, mcp, prompts, │
 │             skills, settings), kiro-claude settings & data dirs      │
 │ engine/     ClaudeProcess: spawn installed `claude`, stream-json I/O,│
 │             control protocol, capability probe, session index        │
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

## Compatibility probe

`claude --version` and `claude --help` are parsed once per version and cached, so
kiro-claude passes only flags the installed Claude Code supports.

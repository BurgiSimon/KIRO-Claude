# kiro-claude

**The Kiro CLI, running on the Claude Code you already have installed.**

kiro-claude is a port of the [Kiro CLI](https://github.com/kirodotdev/Kiro) front end — the
`kiro-cli` commands, the interactive chat with its slash commands, custom agents, steering,
MCP configuration, hooks, prompts, skills, specs and ACP mode — whose agent runtime is the
**Claude Code CLI (`claude`) installed on your machine**. Every model call is made by the
`claude` binary itself, so it runs on whatever Claude Code is logged in with, normally your
**Claude Pro / Max subscription**. kiro-claude never reads, stores or forwards credentials.

It also runs **[KiroCrew](https://github.com/kirodotdev/KiroCrew)**, Kiro's persistent agent
workspace (sessions, memory and lessons, self-evolving skills, checkpointed long-running
tasks, schedules and heartbeats, delegation, dashboard, CLI and messaging), on Claude Code:
`kiro-claude crew setup` builds the unmodified KiroCrew from source and makes kiro-claude its
`kiro-cli` backend.

```
you ──▶ kiro-claude (Kiro agents, steering, hooks, MCP config, permissions, specs, ACP)
            │  stream-json + control protocol over stdio
            ▼
        claude -p … (your installed Claude Code, your login, your subscription)
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how it works.

> kiro-claude is an independent project. It is not affiliated with or endorsed by Amazon Web
> Services or Anthropic, and it contains neither the Kiro CLI nor Claude Code. See [NOTICE](NOTICE).

## Requirements

* **Node.js ≥ 18.17** (developed and tested on Node 22).
* **Claude Code** installed and logged in: `claude --version` works and `claude auth status`
  says you are logged in. Install it from <https://claude.com/claude-code>.
* For `kiro-claude crew`: git, Node ≥ 22.12 and Python ≥ 3.12 (`make` too, but only for
  `crew setup --full`). The KiroCrew build needs about 3 GB of disk space (4 GB with `--full`).

## Install

```sh
git clone https://github.com/BurgiSimon/KIRO-Claude.git
cd KIRO-Claude
npm install          # installs the TypeScript toolchain and builds dist/
npm link             # puts `kiro-claude` on your PATH
```

kiro-claude has no runtime dependencies. If you want to type `kiro-cli` out of habit, add a
shell alias (`alias kiro-cli=kiro-claude`). Avoid this if the real Kiro CLI is installed.

## Quick start

```sh
kiro-claude login        # = claude auth login (skip this if Claude Code is already logged in)
kiro-claude doctor       # checks Claude Code, its login, and your Kiro configuration
kiro-claude              # interactive chat (same as `kiro-claude chat`)
```

```sh
kiro-claude chat --agent my-agent                       # chat with a custom agent
kiro-claude chat --model claude-sonnet-5.5              # pick a model (see --list-models)
kiro-claude chat --resume                               # resume the latest chat in this directory
kiro-claude chat --no-interactive "summarize README.md" # one-shot, prints the answer
kiro-claude chat --no-interactive --trust-all-tools "fix the failing test"
```

In chat, type `/help` for the slash commands. Tool calls the agent's permissions do not
allow ask `Allow this action? Use 't' to trust (always allow) this tool for the session. [y/n/t]:`,
as in Kiro.

## Your subscription and your login

* kiro-claude starts your `claude` binary in headless mode and talks to it over stdio. Claude
  Code does the authentication; kiro-claude only runs `claude auth status` to tell you
  whether you are logged in (`kiro-claude whoami`).
* `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and the Bedrock / Vertex switches are **removed**
  from the environment of the `claude` child by default, so a stray API key in your shell
  cannot silently move your usage off the subscription. Set
  `kiro-claude settings kiroClaude.allowApiKey true` (global settings only) if you do want
  API-key billing. `kiro-claude doctor` warns when such variables are present.
* `/usage` shows the context window and the subscription rate-limit window Claude Code
  reports. The cost figure it shows is an estimate at API list prices, not what your
  subscription pays.

## What is supported

| Kiro feature | kiro-claude |
| --- | --- |
| `chat`: interactive and `--no-interactive`, `--agent`, `--model`, `--resume`, `--resume-id`, `--list-sessions`, `--list-models`, `--trust-all-tools`, `--trust-tools`, `--require-mcp-startup`, `--effort`, `--wrap` | yes |
| Slash commands: `/help /quit /clear /context /model /effort /agent /chat /save /load /tools /hooks /mcp /prompts /compact /usage /tangent /rewind /todos /plan /editor /reply /spec …` | yes (a few P2 commands are stubs that say so) |
| Custom agents in `~/.kiro/agents` and `.kiro/agents` (JSON V2 with `allowedTools` / `toolsSettings`, V3 `permissions`, Markdown agents) | yes; `agent list/create/edit/validate/set-default/schema/migrate` |
| Permission gate: allowed tools, `allowedPaths`/`deniedPaths`, `allowedCommands`/`deniedCommands`, read-only auto-allow, `/tools trust`, `permissions.yaml` | yes; enforced on every tool call, including tools Claude Code would allow by itself and calls made by subagents |
| Steering (`.kiro/steering`, global steering, `always` / `fileMatch` / `manual` / `auto` inclusion), `AGENTS.md`, agent `resources`, `@file` and `#` references | yes |
| MCP: `mcp.json` (workspace and global), agent `mcpServers`, `includeMcpJson`, `mcp add/remove/list/import/status` | yes; Claude Code runs the servers |
| Hooks: `agentSpawn`, `userPromptSubmit`, `preToolUse`, `postToolUse`, `stop`, and the V3 hook dialect | yes |
| Prompts (`@prompt`, `/prompt`) and skills | yes |
| Specs: requirements → design → tasks → run (`kiro-claude spec …`, `/spec …`) | yes |
| Sessions in `~/.kiro/sessions/cli` (kiro-cli file format), tangents, rewind, compaction | yes |
| ACP (`kiro-claude acp`) for editors and KiroCrew, including `_kiro.dev/*` extensions | yes |
| `settings`, `whoami`, `login`, `logout`, `doctor`, `version`, `update`, `issue`, `diagnostic` | yes (`login`/`logout` run `claude auth`) |
| `inline`, `translate`, `integrations`, `autocomplete`, `theme`, `dashboard`, voice, knowledge bases | not supported (prints a clear message) |

Model ids are Kiro-style (`claude-sonnet-5.5`, `claude-haiku-4.5`, …) and map to Claude Code
model ids; `auto` lets Claude Code pick its default. Run `kiro-claude chat --list-models`.

## Ctrl+C and signals

In chat:

* **Ctrl+C** while Kiro is answering interrupts the turn. While a slash command runs, it also
  cancels the command: `/spec run` starts no further task, `/hooks run` and
  `/chat save-via-script|load-via-script` stop their command, `/usage`, `/mcp`, `/tools` and
  `/model` stop waiting for Claude Code, and `/chat new|resume|load` cancel a session start that
  is still running its agentSpawn hooks.
* What a command starts after that press, such as the PostTaskExec hooks of a task the press
  interrupted or the start of the chat that continues a `/spec`, is cancelled by the **next
  Ctrl+C**.
* A **second Ctrl+C** stops Claude Code when the turn is still running 1 s later. Your next input
  restarts it with the conversation (`--resume`); a Ctrl+C while the restarted session runs its
  agentSpawn hooks cancels the restart. An idle Claude Code is never stopped this way.
* At the prompt, Ctrl+C or Ctrl+D twice exits (or type `/quit`).

`chat --no-interactive`: the first Ctrl+C interrupts the answer (exit status 130), a second one
closes the session.

Closing the terminal (SIGHUP), `kill` (SIGTERM) and Ctrl+C while the chat is still starting make
kiro-claude close every open session first, your chat first (a session still starting is
cancelled): SessionEnd hooks run, the conversation's record is saved and its lock released, so
`kiro-claude chat --resume` continues that conversation. The close gets at most 2 s; then
kiro-claude exits with the signal (a shell shows 128 + the signal number, e.g. 143 for SIGTERM)
and ends any child process still running. A second signal ends it at once, unless it is the same
signal within half a second of the first (closing a terminal tab can send SIGHUP twice). After
the signal nothing more is printed and nothing you type is run. Details:
[Ctrl+C and signals](docs/ARCHITECTURE.md#ctrlc-and-signals) and
[Signals and child processes](docs/ARCHITECTURE.md#signals-and-child-processes).

## Specs

`/spec` in chat and `kiro-claude spec` run Kiro's spec workflow: requirements (or a bugfix
analysis) → design → tasks, with a review after each phase (a quick spec drafts all three and has
one review at the end), then `run` to implement the tasks. Each phase may write only its own
documents in `.kiro/specs/<feature>/`.

* In **plan mode** the phases still run and write their documents, and nothing else; `/spec run`
  (and running tasks from `/spec <name>`) is refused, and turning plan mode on during a run stops
  it before the next task.
* In a **tangent**, the commands that draft a spec (`/spec new`, `approve`, `revise`, `analyze`,
  `sync`) are refused, because the spec conversation would replace the tangent: go back with
  `/tangent` (or `/tangent merge`) first. A tangent of the main conversation that has no message
  of its own yet is left for you; an empty tangent nested in another one is refused too. Leaving
  a tangent keeps the plan mode you last set.
* The phases and the chat that continues the spec start from your current trust settings and plan
  mode; a tool you untrusted during a task stays untrusted afterwards.
* `/spec run` in chat runs one task at a time;
  `kiro-claude spec run` runs up to `kiroClaude.spec.maxParallelTasks` tasks of a wave at once.
* A spec document that is a symbolic link is never written by a phase (the write is denied, with
  the reason), nor read or written by kiro-claude itself: `list` and `status` show it as
  `refused` and say why, `view` prints the reason instead of the text, `run`, `sync` and
  `analyze` refuse to use it, `#spec:<name>` in chat leaves it out with a notice, and no phase of
  that spec is approved or drafted (its checkpoints say why). A `.kiro`, `.kiro/specs` or feature folder that is a symbolic link works when it
  resolves inside the workspace; one that points outside it is refused the same way.
* Ctrl+C stops a run before its next task and interrupts the running one; the next Ctrl+C kills
  the PostTaskExec hooks of a task it interrupted. In `kiro-claude spec run` that second Ctrl+C
  lets the run print its summary; without such a hook it exits at once.

Details: [Specs](docs/ARCHITECTURE.md#specs).

## Configuration

kiro-claude reads the same files as Kiro CLI:

| What | Global | Workspace |
| --- | --- | --- |
| Agents | `~/.kiro/agents/*.json`, `*.md` | `.kiro/agents/` |
| Steering | `~/.kiro/steering/*.md` | `.kiro/steering/` |
| MCP servers | `~/.kiro/settings/mcp.json` | `.kiro/settings/mcp.json` |
| Hooks | agent `hooks`, `~/.kiro/hooks` | `.kiro/hooks/` |
| Prompts / skills | `~/.kiro/prompts`, `~/.kiro/skills` | `.kiro/prompts`, `.kiro/skills` |
| Settings | `~/.kiro/settings/cli.json` | `.kiro/settings/cli.json` |
| Sessions | `~/.kiro/sessions/cli/` | — |

`KIRO_HOME` moves `~/.kiro`. `kiro-claude settings list --all` shows every setting; those
described as not supported or ignored are stored (so a `cli.json` shared with Kiro CLI keeps
working) but have no effect. These Kiro settings are passed on to Claude Code when you set them:
`chat.disableAutoCompaction` (as `DISABLE_AUTO_COMPACT`), `api.timeout` (as `API_TIMEOUT_MS`)
and the MCP start-up limit `MCP_TIMEOUT`, which Claude Code applies as a hard per-server cut-off:
`mcp.noInteractiveTimeout` for `--no-interactive` runs, `mcp.initTimeout` for interactive and ACP
sessions, only when above Claude Code's own 30 s default (in Kiro it is a wait before the prompt,
not a failure). A variable already set in your environment wins.

kiro-claude's own settings live in `kiro-claude.json` next to `cli.json`:

| Setting | Default | Meaning |
| --- | --- | --- |
| `kiroClaude.claudePath` | `$KIRO_CLAUDE_BIN`, then `PATH` | The `claude` binary to run |
| `kiroClaude.allowApiKey` | `false` | Let API-key and cloud-provider variables reach `claude` |
| `kiroClaude.claudeSettingSources` | `''` | Value for `claude --setting-sources` (`''` = only Kiro semantics; e.g. `user,project` also loads your Claude Code settings, hooks and permissions) |
| `kiroClaude.extraClaudeArgs` | `[]` | Extra arguments for every `claude` invocation |
| `kiroClaude.spec.defaultWorkflow` | ask | `requirements-first` or `design-first` |
| `kiroClaude.spec.maxParallelTasks` | `1` | Tasks of one wave that `kiro-claude spec run` runs at once (1–4); `/spec run` in chat runs one task at a time |

Settings that change how `claude` is launched or authenticated are only read from the global
settings, so a cloned repository cannot change them.

Environment variables: `KIRO_HOME`, `KIRO_CLAUDE_BIN` (path of `claude`),
`KIRO_CLAUDE_FORCE_MODEL` (force one model for the session and its subagents),
`KIRO_LOG_LEVEL` (`error|warn|info|debug|trace`).

## Editors (ACP)

`kiro-claude acp` speaks the [Agent Client Protocol](https://agentclientprotocol.com) on stdio,
in Kiro CLI's dialect. Use it wherever an editor accepts a custom ACP agent command, for
example in Zed's `settings.json`:

```json
{
  "agent_servers": {
    "Kiro (Claude Code)": { "command": "kiro-claude", "args": ["acp"] }
  }
}
```

Tool permission requests appear in the editor. Sessions are stored in `~/.kiro/sessions/cli`
and can be loaded again.

`session/cancel` also stops a Kiro command that is waiting for Claude Code: a
`_kiro.dev/commands/execute` such as `usage` or `compact` answers `Command cancelled`, and `/usage`
sent as prompt text ends with `stopReason: "cancelled"`. A `$/cancel_request` for a `session/new`
or `session/load` cancels a start that is still running agentSpawn hooks, and nothing of that
session stays. See
[Cancelling commands and session starts](docs/ARCHITECTURE.md#cancelling-commands-and-session-starts-acp).

## KiroCrew on Claude Code

```sh
kiro-claude crew setup     # fetch the pinned KiroCrew, build it, point it at kiro-claude
kiro-claude crew start     # start the gateway in the background
kiro-claude crew open      # open the dashboard
kiro-claude crew status    # running / ready?
kiro-claude crew logs -f
kiro-claude crew exec -- chat -m "hello"   # any kirocrew command, with the gateway's environment
kiro-claude crew stop
kiro-claude crew doctor    # checks every piece of the integration
```

What `crew setup` does:

1. Fetches KiroCrew at the commit pinned by this repository's `vendor/KiroCrew` submodule
   (or uses `--dir <checkout>`) and builds it from source: the dashboard (`npm ci` and
   `npm run build`), a `.venv` with KiroCrew installed by `pip install -e`, and the staged
   frontend. `--full` runs KiroCrew's own `make build` instead, which its pytest suites need;
   `--no-build` skips the build. KiroCrew's code is not modified.
2. Writes a small `kiro-claude` launcher under `~/.local/share/kiro-claude/crew/bin/` with
   absolute paths to Node, kiro-claude and `claude`. It then configures KiroCrew to use it as
   its `kiro-cli` (`KIROCREW_KIRO_BIN`, `agent.acp_backend kiro`, `auto_update false`).
3. Bot/member sessions run on a private copy of Anthropic's `claude-agent-acp` bridge pointed
   at your `claude` binary (`--members none` turns this off).
4. KiroCrew treats a kiro-cli without an identity store as signed out and restarts its
   backends on every turn. When **no kiro-cli identity store exists**, `crew setup` writes a
   token-less stub, which contains no credentials. It never modifies an existing store.
   `kiro-claude crew unstub` removes the stub again, and only if kiro-claude created it.

KiroCrew's main agent, schedules, heartbeats, delegation and memory all run through
`kiro-claude acp`, and therefore on your Claude Code subscription.

`kiro-claude crew stop` runs `kirocrew stop` (then SIGTERM and SIGKILL if the gateway does not
exit), reaps orphaned agent processes and ends what is left of the gateway's process tree. On
Linux it also retires the leftover processes that a gateway which crashed left in its process
group; the evidence for that is kept in `run/crashed.json` of the crew state directory
(`~/.local/share/kiro-claude/crew/`; no token, at most 16 gateways, dropped after a reboot), and
`crew start` warns while such leftovers run. It exits 1 when the gateway or its lock could not
be freed. See [KiroCrew](docs/ARCHITECTURE.md#kirocrew-persistent-pipeline-on-claude-code).

`kiro-claude crew uninstall` stops the gateway, restores KiroCrew's previous configuration and
removes what setup added: the launcher, the identity stub (only if kiro-claude created it),
`crew.json`, and the run files and logs under `run/` (`crashed.json` included). `--purge` also
removes the private claude-agent-acp bridge and the build caches, then the crew state directory
itself when it is empty. Your KiroCrew data and the checkout are kept.

## Differences from Kiro CLI

* The agent loop is Claude Code's: its built-in tools (shown under their Kiro names: `read`,
  `write`, `shell`, `grep`, `glob`, `web_fetch`, …), its compaction and its subagents. Kiro's
  tool *policy* is applied on top through the permission gate.
* Claude Code owns MCP connections, so MCP prompts and `/mcp auth` are not available in chat.
* Kiro's `code`, `introspect`, `session` and `report` tools have no Claude Code equivalent; an
  agent that selects them simply does not get them. `tool_search` maps to Claude Code's
  `ToolSearch`.
* Some REPL conveniences are not implemented: Ctrl+R history search, the Ctrl+S picker, vi
  mode, image paste, and the granular shell-trust menu.
* Knowledge bases, inline completions, translate and the desktop integrations are not ported.
* There is one agent engine. `--agent-engine v1|v2` is accepted; `v3` (Kiro's KAS engine) is
  rejected the way kiro-cli rejects an unknown engine, so KiroCrew uses its v2 backend.

## Development

```sh
npm install
npm run build
npm test                                 # unit + integration tests against a scriptable fake claude
KIRO_CLAUDE_E2E=1 npm run test:e2e       # end-to-end against your real claude (uses haiku; bills your subscription)
```

`test/fixtures/fake-claude.mjs` simulates Claude Code's stream-json and control protocol, so
the whole suite runs without network access or a login. Run the tests from the repository
root.

The KiroCrew integration has its own end-to-end harness, which needs a built KiroCrew checkout
(`kiro-claude crew setup`, or `npm run crew:fetch` and KiroCrew's build):

```sh
KCDIR=<built KiroCrew> KC_DIST=<kiro-claude build dir> test/e2e/kirocrew/stage.sh B   # fake claude
KCDIR=<built KiroCrew> KC_DIST=<kiro-claude build dir> test/e2e/kirocrew/stage.sh C   # real claude (haiku)
```

Each run uses a fresh temporary HOME, never your own `~/.kiro` or kiro-cli store, and prints a
PASS/FAIL line per contract check. `docs/VERIFICATION.md` records the last full run.

## License

MIT, see [LICENSE](LICENSE). Kiro, Kiro CLI and KiroCrew are trademarks of Amazon.com, Inc. or its
affiliates; Claude and Claude Code are trademarks of Anthropic, PBC. See [NOTICE](NOTICE).

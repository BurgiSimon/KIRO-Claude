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
* For `kiro-claude crew`: git, Node ≥ 22.12, Python ≥ 3.12 and `make`. The KiroCrew build
  needs about 3 GB of disk space.

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

`KIRO_HOME` moves `~/.kiro`. `kiro-claude settings list --all` shows every setting.

kiro-claude's own settings live in `kiro-claude.json` next to `cli.json`:

| Setting | Default | Meaning |
| --- | --- | --- |
| `kiroClaude.claudePath` | `$KIRO_CLAUDE_BIN`, then `PATH` | The `claude` binary to run |
| `kiroClaude.allowApiKey` | `false` | Let API-key and cloud-provider variables reach `claude` |
| `kiroClaude.claudeSettingSources` | `''` | Value for `claude --setting-sources` (`''` = only Kiro semantics; e.g. `user,project` also loads your Claude Code settings, hooks and permissions) |
| `kiroClaude.extraClaudeArgs` | `[]` | Extra arguments for every `claude` invocation |
| `kiroClaude.spec.defaultWorkflow` | ask | `requirements-first` or `design-first` |
| `kiroClaude.spec.maxParallelTasks` | `1` | Spec tasks run concurrently (1–4) |

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
   (or uses `--dir <checkout>`) and builds it from source with its own `make build`.
   KiroCrew's code is not modified.
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
`kiro-claude acp`, and therefore on your Claude Code subscription. `kiro-claude crew uninstall`
undoes the setup and restores KiroCrew's previous configuration. `--purge` also removes the
files kiro-claude created for it (launcher, bridge, logs). Your KiroCrew data and the checkout
are kept.

## Differences from Kiro CLI

* The agent loop is Claude Code's: its built-in tools (shown under their Kiro names: `read`,
  `write`, `shell`, `grep`, `glob`, `web_fetch`, …), its compaction and its subagents. Kiro's
  tool *policy* is applied on top through the permission gate.
* Claude Code owns MCP connections, so MCP prompts and `/mcp auth` are not available in chat.
* Some REPL conveniences are not implemented: Ctrl+R history search, the Ctrl+S picker, vi
  mode, image paste, and the granular shell-trust menu.
* Knowledge bases, inline completions, translate and the desktop integrations are not ported.

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

## License

MIT, see [LICENSE](LICENSE). Kiro, Kiro CLI and KiroCrew are trademarks of Amazon.com, Inc. or its
affiliates; Claude and Claude Code are trademarks of Anthropic, PBC. See [NOTICE](NOTICE).

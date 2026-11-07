#!/usr/bin/env node
/**
 * fake-claude — a scriptable stand-in for the Claude Code CLI (2.1.318) in headless
 * stream-json mode, used by every kiro-claude test suite. Plain ESM, zero dependencies.
 *
 * It mimics the verified wire behaviour of `claude -p --input-format stream-json
 * --output-format stream-json --verbose --permission-prompt-tool stdio` (research 00 §3,
 * 04 §5–§12, 07): initialize, system/init per turn, assistant/user/stream_event/result frames,
 * hook_callback + can_use_tool control requests, interrupt, set_model, get_context_usage,
 * mcp_status, get_settings, local slash commands (/clear, /compact, /effort, /model, /cost,
 * /context), command_lifecycle, the priority:"next" queue (folded in at the next tool boundary,
 * else run as its own turn after the result; plain interrupt keeps it, `cancel_queued` drops
 * it), and (opt-in) transcript persistence for --resume / --fork-session (a fork's transcript is
 * written with its first user line, like the real claude) / --resume-session-at (a uuid the
 * transcript does not hold fails with `No message found with message.uuid of: <uuid>`, exit 1),
 * a compacted transcript loaded from its last compact boundary like the real claude 2.1.319 (the
 * summary and the messages the compaction kept verbatim; older uuids are not found).
 *
 * Turns are scripted with $FAKE_CLAUDE_SCRIPT (JSON file) or $FAKE_CLAUDE_SCRIPT_JSON (inline).
 * See test/fixtures/README.md for the script format and every FAKE_CLAUDE_* variable.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const env = process.env;
const VERSION = env.FAKE_CLAUDE_VERSION || '2.1.318';
const argv = process.argv.slice(2);
const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

/* ---------------------------------------------------------------------------------------- */
/* Logging ($FAKE_CLAUDE_LOG, JSONL, synchronous so entries from several processes interleave */
/* cleanly and survive crashes)                                                              */
/* ---------------------------------------------------------------------------------------- */

const SECRET_VARS = /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN)$/;
function envSubset() {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (/^(CLAUDE|ANTHROPIC|KIRO|FAKE_CLAUDE|CCR_|AI_AGENT$|NODE_OPTIONS$|DEBUG$)/.test(k)) {
      out[k] = SECRET_VARS.test(k) ? '<set>' : v;
    }
  }
  return out;
}
function log(entry) {
  if (!env.FAKE_CLAUDE_LOG) return;
  try {
    fs.appendFileSync(env.FAKE_CLAUDE_LOG, JSON.stringify({ ts: Date.now(), pid: process.pid, ...entry }) + '\n');
  } catch {
    /* ignore */
  }
}

/* ---------------------------------------------------------------------------------------- */
/* Output helpers                                                                            */
/* ---------------------------------------------------------------------------------------- */

let stdoutBroken = false;
process.stdout.on('error', () => {
  stdoutBroken = true;
  process.exit(0);
});
function writeOut(line) {
  if (stdoutBroken) return;
  process.stdout.write(line);
}
function emit(frame) {
  if (env.FAKE_CLAUDE_LOG_STDOUT === '1') log({ event: 'stdout', frame });
  writeOut(JSON.stringify(frame) + '\n');
}
function exitAfterFlush(code) {
  process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
}
function fail(message, code = 1) {
  process.stderr.write(message + '\n');
  log({ event: 'exit', code, reason: message });
  exitAfterFlush(code);
}

log({ event: 'start', argv, cwd: process.cwd(), env: envSubset() });

/* ---------------------------------------------------------------------------------------- */
/* Help / version / auth                                                                     */
/* ---------------------------------------------------------------------------------------- */

const HELP_TEXT = [
  "Usage: claude [options] [command] [prompt]",
  "",
  "Claude Code - starts an interactive session by default, use -p/--print for",
  "non-interactive output",
  "",
  "Arguments:",
  "  prompt                                Your prompt",
  "",
  "Options:",
  "  --add-dir <directories...>            Additional directories to allow tool",
  "                                        access to",
  "  --agent <agent>                       Agent for the current session. Overrides",
  "                                        the 'agent' setting.",
  "  --agents <json-or-file>               JSON object defining custom agents, or",
  "                                        with --print the path to a file that",
  "                                        holds one (e.g. '{\"reviewer\":",
  "                                        {\"description\": \"Reviews code\",",
  "                                        \"prompt\": \"You are a code reviewer\"}}')",
  "  --allow-dangerously-skip-permissions  Enable bypassing all permission checks",
  "                                        as an option, without it being enabled",
  "                                        by default. Recommended only for",
  "                                        sandboxes with no internet access.",
  "  --allowedTools, --allowed-tools <tools...>",
  "      Comma or space-separated list of tool names to allow (e.g. \"Bash(git *)",
  "      Edit\")",
  "  --append-system-prompt <prompt>       Append a system prompt to the default",
  "                                        system prompt",
  "  --autocompact <auto|tokens>           Auto-compact window size (auto, or",
  "                                        100k–1M tokens)",
  "  --ax-screen-reader                    Render screen-reader friendly output",
  "                                        (flat text, no decorative borders or",
  "                                        animations).",
  "  --bg, --background                    Start the session in the background and",
  "                                        return immediately. Prints the id that",
  "                                        `claude attach`, `logs`, `stop` and `rm`",
  "                                        take; `claude agents` lists them. With",
  "                                        --resume <session-id>, continues that",
  "                                        session in the background under the same",
  "                                        ID, or starts a copy and says so when",
  "                                        the session is already running",
  "  --bare                                Minimal mode: skip hooks (those defined",
  "                                        in settings and by installed plugins;",
  "                                        features built into Claude Code are",
  "                                        unaffected), LSP, plugin sync,",
  "                                        attribution, auto-memory, background",
  "                                        prefetches, keychain reads, and",
  "                                        CLAUDE.md auto-discovery. Sets",
  "                                        CLAUDE_CODE_SIMPLE=1. Anthropic auth is",
  "                                        strictly ANTHROPIC_API_KEY or",
  "                                        apiKeyHelper via --settings (OAuth and",
  "                                        keychain are never read). 3P providers",
  "                                        (Bedrock/Vertex/Foundry) use their own",
  "                                        credentials. Skills still resolve via",
  "                                        /skill-name. Explicitly provide context",
  "                                        via: --system-prompt[-file],",
  "                                        --append-system-prompt[-file], --add-dir",
  "                                        (CLAUDE.md dirs), --mcp-config,",
  "                                        --settings, --agents, --plugin-dir.",
  "  --betas <betas...>                    Beta headers to include in API requests",
  "                                        (API key users only)",
  "  --brief                               Enable SendUserMessage tool for",
  "                                        agent-to-user communication",
  "  --chrome                              Enable Claude in Chrome integration",
  "  --cloud [description|session_id|url]  Create a cloud session with the given",
  "                                        description, or attach to an existing",
  "                                        one by session ID or claude.ai/code URL",
  "  -c, --continue                        Continue the most recent conversation in",
  "                                        the current directory",
  "  --dangerously-skip-permissions        Bypass all permission checks.",
  "                                        Recommended only for sandboxes with no",
  "                                        internet access.",
  "  -d, --debug [filter]                  Enable debug mode with optional category",
  "                                        filtering (e.g., --debug=hooks,mcp or",
  "                                        --debug='!hooks,!mcp')",
  "  --debug-file <path>                   Write debug logs to a specific file path",
  "                                        (implicitly enables debug mode)",
  "  --desktop                             Open in the Claude Desktop app instead",
  "                                        of the terminal (with --continue or",
  "                                        --resume <id> to pick the session)",
  "  --disable-slash-commands              Disable all skills and commands",
  "  --disallowedTools, --disallowed-tools <tools...>",
  "      Comma or space-separated list of tool names to deny (e.g. \"Bash(git *)",
  "      Edit\")",
  "  --effort <level>                      Effort level for the current session",
  "                                        (low, medium, high, xhigh, max)",
  "  --environment <environment_id>        Create a new cloud session that runs on",
  "                                        the given self-hosted environment",
  "                                        (ccpool_...).",
  "  --exclude-dynamic-system-prompt-sections",
  "      Move per-machine sections (cwd, env info, memory paths, git status) from",
  "      the system prompt into the first user message. Improves cross-user",
  "      prompt-cache reuse. Only applies with the default system prompt (ignored",
  "      with --system-prompt). (default: false)",
  "  --fallback-model <model>              Enable automatic fallback to specified",
  "                                        model(s) when the default model is",
  "                                        overloaded or not available. Accepts a",
  "                                        comma-separated list to try each in",
  "                                        order. Re-tries the primary at the start",
  "                                        of each user turn.",
  "  --file <specs...>                     File resources to download at startup.",
  "                                        Format: file_id:relative_path (e.g.,",
  "                                        --file file_abc:doc.txt",
  "                                        file_def:img.png)",
  "  --fork-session                        When resuming, create a new session ID",
  "                                        instead of reusing the original (use",
  "                                        with --resume or --continue)",
  "  --forward-subagent-text               Forward subagent text and thinking",
  "                                        blocks as assistant/user messages with",
  "                                        parent_tool_use_id set (only works with",
  "                                        --print and --output-format=stream-json)",
  "  --from-pr [value]                     Resume a session linked to a PR by PR",
  "                                        number/URL, or open interactive picker",
  "                                        with optional search term",
  "  -h, --help                            Display help for command",
  "  --ide                                 Automatically connect to IDE on startup",
  "                                        if exactly one valid IDE is available",
  "  --include-hook-events                 Include all hook lifecycle events in the",
  "                                        output stream (only works with",
  "                                        --output-format=stream-json)",
  "  --include-partial-messages            Include partial message chunks as they",
  "                                        arrive (only works with --print and",
  "                                        --output-format=stream-json)",
  "  --input-format <format>               Input format (only works with --print):",
  "                                        \"text\" (default), or \"stream-json\"",
  "                                        (realtime streaming input) (choices:",
  "                                        \"text\", \"stream-json\")",
  "  --json-schema <schema>                JSON Schema for structured output",
  "                                        validation (only works with --print).",
  "                                        Example:",
  "                                        {\"type\":\"object\",\"properties\":{\"name\":{\"type\":\"string\"}},\"required\":[\"name\"]}",
  "  --max-budget-usd <amount>             Maximum dollar amount to spend on API",
  "                                        calls (only works with --print)",
  "  --mcp-config <configs...>             Load MCP servers from JSON files or",
  "                                        strings (space-separated)",
  "  --model <model>                       Model for the current session. Provide",
  "                                        an alias for the latest model (e.g.",
  "                                        'fable', 'opus', or 'sonnet') or a",
  "                                        model's full name.",
  "  -n, --name <name>                     Set a display name for this session",
  "                                        (shown in the prompt box, /resume",
  "                                        picker, and terminal title)",
  "  --no-chrome                           Disable Claude in Chrome integration",
  "  --no-session-persistence              Disable session persistence - sessions",
  "                                        will not be saved to disk and cannot be",
  "                                        resumed (only works with --print)",
  "  --output-format <format>              Output format (only works with --print):",
  "                                        \"text\" (default), \"json\" (single",
  "                                        result), or \"stream-json\" (realtime",
  "                                        streaming) (choices: \"text\", \"json\",",
  "                                        \"stream-json\")",
  "  --permission-mode <mode>              Permission mode to use for the session",
  "                                        (choices: \"acceptEdits\", \"auto\",",
  "                                        \"bypassPermissions\", \"manual\",",
  "                                        \"dontAsk\", \"plan\")",
  "  --permission-prompts <target>         Who answers permission prompts with",
  "                                        --print: \"host\" (the SDK host or",
  "                                        --permission-prompt-tool) or \"none\"",
  "                                        (nobody: anything that would prompt is",
  "                                        denied automatically; the permission",
  "                                        mode still decides everything else)",
  "                                        (choices: \"host\", \"none\", default:",
  "                                        \"host\")",
  "  --plugin-dir <path>                   Load a plugin from a directory or .zip",
  "                                        for this session only; a folder of",
  "                                        plugins loads each child (repeatable:",
  "                                        --plugin-dir A --plugin-dir B.zip)",
  "                                        (default: [])",
  "  --plugin-url <url>                    Fetch a plugin .zip from a URL for this",
  "                                        session only (repeatable: --plugin-url A",
  "                                        --plugin-url B) (default: [])",
  "  -p, --print                           Print response and exit (useful for",
  "                                        pipes). Note: The workspace trust dialog",
  "                                        is skipped when Claude is run in",
  "                                        non-interactive mode (via -p, or when",
  "                                        stdout is not a TTY, e.g. piped or",
  "                                        redirected output). Only use this in",
  "                                        directories you trust. Settings files",
  "                                        that fail validation are silently",
  "                                        ignored in this mode (no error dialog is",
  "                                        shown).",
  "  --prompt-suggestions [value]          Enable prompt suggestions. In print/SDK",
  "                                        mode, emits a prompt_suggestion message",
  "                                        after each turn with a predicted next",
  "                                        user prompt (choices: \"true\", \"false\",",
  "                                        \"1\", \"0\", \"yes\", \"no\", \"on\", \"off\",",
  "                                        preset: \"true\")",
  "  --remote-control [name]               Start an interactive session with Remote",
  "                                        Control enabled (optionally named)",
  "  --remote-control-session-name-prefix <prefix>",
  "      Prefix for auto-generated Remote Control session names (default: hostname)",
  "  --replay-user-messages                Re-emit user messages from stdin back on",
  "                                        stdout for acknowledgment (only works",
  "                                        with --input-format=stream-json and",
  "                                        --output-format=stream-json)",
  "  --restricted                          Restricted mode: removes the built-in",
  "                                        tools that run commands or code (Bash,",
  "                                        PowerShell and the other code-running",
  "                                        tools) and WebFetch unless --tools names",
  "                                        them, and ignores user, project and",
  "                                        local settings files (managed settings",
  "                                        and --settings still apply; add",
  "                                        --strict-mcp-config to skip MCP servers",
  "                                        too). Also confines the file tools to",
  "                                        the working directories (--add-dir",
  "                                        included), refuses bypassPermissions,",
  "                                        and lets only a person or the configured",
  "                                        permission handler approve writes to",
  "                                        settings, git and tool-configuration",
  "                                        files.",
  "  -r, --resume [value]                  Resume a conversation by session ID or",
  "                                        name, or open interactive picker with",
  "                                        optional search term",
  "  --safe-mode                           Start with all customizations",
  "                                        (CLAUDE.md, skills, installed plugins,",
  "                                        hooks, MCP servers, custom commands and",
  "                                        agents, output styles, workflows, custom",
  "                                        themes, keybindings, and more) disabled",
  "                                        — useful for troubleshooting a broken",
  "                                        configuration. Admin-managed (policy)",
  "                                        settings still apply. Auth, model",
  "                                        selection, built-in tools and plugins,",
  "                                        and permissions work normally. Sets",
  "                                        CLAUDE_CODE_SAFE_MODE=1.",
  "  --session-id <uuid>                   Use a specific session ID for the",
  "                                        conversation (must be a valid UUID)",
  "  --setting-sources <sources>           Comma-separated list of setting sources",
  "                                        to load (user, project, local).",
  "  --settings <file-or-json>             Path to a settings JSON file or a JSON",
  "                                        string to load additional settings from",
  "  --strict-mcp-config                   Only use MCP servers from --mcp-config,",
  "                                        ignoring all other MCP configurations",
  "  --system-prompt <prompt>              System prompt to use for the session",
  "  --system-prompt-snapshot <on|off>     Record the system prompt once per",
  "                                        conversation and reuse it verbatim on",
  "                                        every request and resume. on (the",
  "                                        default, except under --bare outside",
  "                                        cloud and background sessions): the",
  "                                        prompt is rendered on the conversation's",
  "                                        first request — a --system-prompt or",
  "                                        --append-system-prompt included — sent,",
  "                                        and recorded; every later request and",
  "                                        resume sends the record as-is, even when",
  "                                        a later launch passes different text,",
  "                                        until the conversation is compacted.",
  "                                        off: never record; the prompt is",
  "                                        rendered fresh every request (for",
  "                                        iterating on prompt text). (choices:",
  "                                        \"on\", \"off\")",
  "  --teleport [session]                  Resume a teleport session, optionally",
  "                                        specify session ID",
  "  --tmux                                Create a tmux session for the worktree",
  "                                        (requires --worktree). Uses iTerm2",
  "                                        native panes when available; use",
  "                                        --tmux=classic for traditional tmux.",
  "  --tools <tools...>                    Specify the list of available tools from",
  "                                        the built-in set. Use \"\" to disable all",
  "                                        tools, \"default\" to use the default set,",
  "                                        or specify tool names (e.g.",
  "                                        \"Bash,Edit,Read\").",
  "  --verbose                             Override verbose mode setting from",
  "                                        config",
  "  -v, --version                         Output the version number",
  "  -w, --worktree [name]                 Create a new git worktree for this",
  "                                        session (optionally specify a name)",
  "",
  "Commands:",
  "  agents [options]                      Manage background agents",
  "  attach <id|name>                      Open a background session in this",
  "                                        terminal. <id> is the short id that",
  "                                        `claude --bg` prints and `claude agents`",
  "                                        lists. Part of the session name works",
  "                                        too",
  "  auth                                  Manage authentication",
  "  auto-mode                             Inspect or reset auto mode configuration",
  "  doctor                                Check the health of your Claude Code",
  "                                        installation. Reads settings files in",
  "                                        the current directory without a trust",
  "                                        prompt. For a full checkup that can also",
  "                                        fix issues, run /doctor in a session.",
  "  gateway [options]                     Run the enterprise auth/telemetry",
  "                                        gateway",
  "  import [options] [source]             Import config from another AI coding",
  "                                        agent into Claude Code",
  "  install [options] [target]            Install Claude Code native build. Use",
  "                                        [target] to specify version (stable,",
  "                                        latest, or specific version)",
  "  logs <id|name>                        Print a background session's recent",
  "                                        terminal output",
  "  mcp                                   Configure and manage MCP servers",
  "  plugin|plugins                        Manage Claude Code plugins",
  "  purge [options] [path]                Delete a project's Claude Code data",
  "                                        (transcripts, tasks, file history, and",
  "                                        its entry in ~/.claude.json) from this",
  "                                        computer only",
  "  respawn [options] [id]                Restart a background session, or all of",
  "                                        them with --all, so it runs the current",
  "                                        Claude Code version",
  "  rm <id>                               Delete a background session, and its",
  "                                        worktree when that is safe. Works on",
  "                                        sessions that have already exited",
  "  setup-token                           Set up a long-lived authentication token",
  "                                        (requires Claude subscription)",
  "  stop|kill <id>                        Stop a background session. Its",
  "                                        conversation is kept: `claude attach",
  "                                        <id>` opens it again, `claude --resume`",
  "                                        works once it is stopped",
  "  ultrareview [options] [target]        Run a cloud-hosted multi-agent code",
  "                                        review of the current branch (or a PR",
  "                                        number / base branch) and print the",
  "                                        findings",
  "  update|upgrade                        Check for updates and install if",
  "                                        available; package-manager installs",
  "                                        update through the package manager",
  ""
].join("\n");

function runAuth(args) {
  const sub = args[0];
  if (sub === 'status') {
    const loggedOut = env.FAKE_CLAUDE_LOGGED_OUT === '1';
    const text = args.includes('--text');
    if (text) {
      writeOut(loggedOut ? 'Not logged in. Run claude auth login to sign in.\n' : 'Login method: Claude Max account\nEmail: fake@example.com\n');
    } else {
      const status = loggedOut
        ? { loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' }
        : { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' };
      writeOut(JSON.stringify(status, null, 2) + '\n');
    }
    log({ event: 'exit', code: loggedOut ? 1 : 0, reason: 'auth status' });
    return exitAfterFlush(loggedOut ? 1 : 0);
  }
  if (sub === 'login' || sub === 'logout') {
    process.stderr.write(`fake-claude: auth ${args.join(' ')}\n`);
    const code = Number.parseInt(env.FAKE_CLAUDE_AUTH_EXIT || '0', 10) || 0;
    log({ event: 'exit', code, reason: `auth ${sub}` });
    return exitAfterFlush(code);
  }
  return fail(`error: unknown command 'auth ${sub ?? ''}'`);
}

/* ---------------------------------------------------------------------------------------- */
/* Argument parsing (commander-like; unknown options are fatal like the real CLI)            */
/* ---------------------------------------------------------------------------------------- */

function parseArgs(args) {
  const BOOL = new Set([
    '--allow-dangerously-skip-permissions', '--ax-screen-reader', '--bg', '--background', '--bare', '--brief',
    '--chrome', '--continue', '-c', '--dangerously-skip-permissions', '--disable-slash-commands',
    '--exclude-dynamic-system-prompt-sections', '--fork-session', '--forward-subagent-text', '--ide',
    '--include-hook-events', '--include-partial-messages', '--no-chrome', '--no-session-persistence', '--print',
    '-p', '--replay-user-messages', '--restricted', '--safe-mode', '--strict-mcp-config', '--verbose',
    '--debug-to-stderr', '--await-initialize', '--session-mirror',
  ]);
  const VALUE = new Set([
    '--agent', '--agents', '--append-system-prompt', '--autocompact', '--debug-file', '--effort', '--environment',
    '--fallback-model', '--input-format', '--json-schema', '--max-budget-usd', '--model', '--name', '-n',
    '--output-format', '--permission-mode', '--permission-prompts', '--plugin-dir', '--plugin-url',
    '--remote-control-session-name-prefix', '--session-id', '--setting-sources', '--settings', '--system-prompt',
    '--system-prompt-snapshot',
    // hidden (accepted by 2.1.318, 04 §3)
    '--permission-prompt-tool', '--append-system-prompt-file', '--system-prompt-file', '--resume-session-at',
    '--max-turns', '--thinking', '--max-thinking-tokens', '--thinking-display', '--plugin-dir-no-mcp',
    '--project-config-root', '--resume-drops-turn', '--task-budget', '--channels', '--managed-settings',
  ]);
  const VARIADIC = new Set([
    '--add-dir', '--allowedTools', '--allowed-tools', '--betas', '--disallowedTools', '--disallowed-tools', '--file',
    '--mcp-config', '--tools',
  ]);
  const OPTIONAL = new Set([
    '--debug', '-d', '--from-pr', '--cloud', '--remote-control', '--resume', '-r', '--teleport', '--worktree', '-w',
    '--prompt-suggestions', '--tmux',
  ]);
  const ALIAS = {
    '-p': '--print', '-c': '--continue', '-n': '--name', '-r': '--resume', '-d': '--debug', '-w': '--worktree',
    '--allowed-tools': '--allowedTools', '--disallowed-tools': '--disallowedTools', '--background': '--bg',
  };
  const opts = {};
  const positional = [];
  const add = (name, value) => {
    const key = ALIAS[name] || name;
    (opts[key] ||= []).push(value);
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('-') || a === '-') {
      positional.push(a);
      continue;
    }
    let name = a;
    let inline;
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq > 0) {
      name = a.slice(0, eq);
      inline = a.slice(eq + 1);
    }
    if (BOOL.has(name)) add(name, true);
    else if (VALUE.has(name)) {
      if (inline !== undefined) add(name, inline);
      else if (i + 1 < args.length) add(name, args[++i]);
      else return { error: `error: option '${name} <value>' argument missing` };
    } else if (VARIADIC.has(name)) {
      const vals = inline !== undefined ? [inline] : [];
      while (inline === undefined && i + 1 < args.length && !args[i + 1].startsWith('-')) vals.push(args[++i]);
      if (vals.length === 0) return { error: `error: option '${name} <values...>' argument missing` };
      for (const v of vals) add(name, v);
    } else if (OPTIONAL.has(name)) {
      if (inline !== undefined) add(name, inline);
      else if (i + 1 < args.length && !args[i + 1].startsWith('-')) add(name, args[++i]);
      else add(name, true);
    } else {
      return { error: `error: unknown option '${name}'` };
    }
  }
  return { opts, positional };
}

const one = (opts, name) => (opts[name] ? opts[name][opts[name].length - 1] : undefined);
const all = (opts, name) => opts[name] || [];

/* ---------------------------------------------------------------------------------------- */
/* Models                                                                                    */
/* ---------------------------------------------------------------------------------------- */

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODELS = [
  { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', description: 'Opus 5.5 · Best for everyday, complex tasks', supportsEffort: true, supportedEffortLevels: EFFORTS, supportsAdaptiveThinking: true, supportsFastMode: true, supportsAutoMode: true, supportsThinkingOff: false },
  { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', description: 'For complex work and everyday tasks', supportsEffort: true, supportedEffortLevels: EFFORTS, supportsAdaptiveThinking: true, supportsFastMode: true, supportsAutoMode: true, supportsThinkingOff: false },
  { value: 'fable', resolvedModel: 'claude-fable-5-1', displayName: 'Fable 5.1', description: 'For your toughest challenges', supportsEffort: true, supportedEffortLevels: EFFORTS, supportsAdaptiveThinking: true, supportsAutoMode: true, supportsThinkingOff: false },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5', description: 'Most efficient for simpler tasks', supportsEffort: true, supportedEffortLevels: EFFORTS, supportsAdaptiveThinking: true, supportsAutoMode: true, supportsThinkingOff: false },
  { value: 'haiku', resolvedModel: 'claude-haiku-5-5', displayName: 'Haiku 5.5', description: 'Fastest for quick answers', supportsEffort: true, supportedEffortLevels: EFFORTS, supportsAdaptiveThinking: true, supportsAutoMode: true, supportsThinkingOff: false },
  { value: 'claude-haiku-4-5-20251001', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5', description: 'Fastest for quick answers', supportsThinkingOff: true },
  { value: 'claude-sonnet-5', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet 5', description: 'Efficient for routine tasks', supportsEffort: true, supportedEffortLevels: EFFORTS, supportsAdaptiveThinking: true, supportsAutoMode: true, supportsThinkingOff: true },
  { value: 'claude-opus-5', resolvedModel: 'claude-opus-5', displayName: 'Opus 5', description: 'Best for everyday, complex tasks', supportsEffort: true, supportedEffortLevels: EFFORTS, supportsAdaptiveThinking: true, supportsFastMode: true, supportsAutoMode: true, supportsThinkingOff: true },
  { value: 'claude-fable-5', resolvedModel: 'claude-fable-5', displayName: 'Fable 5', description: 'Most capable for your hardest and longest-running tasks', supportsEffort: true, supportedEffortLevels: EFFORTS, supportsAdaptiveThinking: true, supportsAutoMode: true, supportsThinkingOff: false },
  { value: 'claude-opus-4-8', resolvedModel: 'claude-opus-4-8', displayName: 'Opus 4.8', description: 'Best for everyday, complex tasks', supportsEffort: true, supportedEffortLevels: EFFORTS, supportsAdaptiveThinking: true, supportsFastMode: true, supportsAutoMode: true, supportsThinkingOff: true },
  { value: 'claude-opus-4-7', resolvedModel: 'claude-opus-4-7', displayName: 'Opus 4.7', description: 'Best for everyday, complex tasks', supportsEffort: true, supportedEffortLevels: EFFORTS, supportsAdaptiveThinking: true, supportsAutoMode: true, supportsThinkingOff: true },
  { value: 'claude-opus-4-6', resolvedModel: 'claude-opus-4-6', displayName: 'Opus 4.6', description: 'Best for everyday, complex tasks', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'max'], supportsAdaptiveThinking: true, supportsAutoMode: true, supportsThinkingOff: true },
  { value: 'claude-sonnet-4-6', resolvedModel: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6', description: 'Efficient for routine tasks', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'max'], supportsAdaptiveThinking: true, supportsAutoMode: true, supportsThinkingOff: true },
];
const ALIASES = { default: 'claude-opus-5-5', opus: 'claude-opus-5-5', best: 'claude-opus-5-5', fable: 'claude-fable-5-1', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5', opusplan: 'claude-opus-5-5' };

function resolveModel(m) {
  if (m === null || m === undefined || m === '' || m === 'default') return env.FAKE_CLAUDE_DEFAULT_MODEL || ALIASES.default;
  const base = String(m).replace(/\[1m\]$/i, '');
  return ALIASES[base.toLowerCase()] || String(m);
}
function displayName(model) {
  const hit = MODELS.find((x) => x.resolvedModel === model && x.value.startsWith('claude-')) || MODELS.find((x) => x.resolvedModel === model);
  if (hit && !hit.displayName.startsWith('Default')) return hit.displayName;
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?/.exec(model);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? '.' + m[3] : ''}` : model;
}
function contextWindow(model) {
  return /-5(-|$)/.test(model) || /-5-\d/.test(model) ? 1_000_000 : 200_000;
}

/**
 * The conversation claude 2.1.319 loads from transcript lines (`--resume`, `--continue`, a fork):
 * from the LAST `compact_boundary` entry on (VERIFIED: a `--resume-session-at` uuid before it fails
 * with `No message found with message.uuid of: <uuid>`, with or without --fork-session): the
 * boundary, the summary (`isCompactSummary`, the metadata's `anchorUuid`), the messages the
 * compaction kept verbatim (`compactMetadata.preservedMessages.uuids`, looked up before the
 * boundary and relinked after the summary, VERIFIED: a fork at such a message holds boundary,
 * summary, message), then the entries that followed the summary. Lines without a boundary load
 * whole.
 */
function loadedConversation(lines) {
  let b = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i] && lines[i].type === 'system' && lines[i].subtype === 'compact_boundary') {
      b = i;
      break;
    }
  }
  if (b < 0) return lines;
  const boundary = lines[b];
  const rest = lines.slice(b + 1);
  const md = boundary.compactMetadata && typeof boundary.compactMetadata === 'object' ? boundary.compactMetadata : {};
  const pm = md.preservedMessages && typeof md.preservedMessages === 'object' ? md.preservedMessages : {};
  const anchor = pm.anchorUuid ?? (md.preservedSegment && md.preservedSegment.anchorUuid);
  const before = lines.slice(0, b);
  const kept = (Array.isArray(pm.uuids) ? pm.uuids : []).map((u) => before.find((l) => l.uuid === u)).filter(Boolean);
  const ai = rest.findIndex((l) => l.uuid === anchor);
  if (ai < 0 || kept.length === 0) return [boundary, ...rest];
  let parent = anchor;
  const relinked = kept.map((l) => {
    const o = { ...l, parentUuid: parent };
    parent = l.uuid;
    return o;
  });
  const after = rest.slice(ai + 1).map((l, i) => (i === 0 ? { ...l, parentUuid: parent } : l));
  return [boundary, ...rest.slice(0, ai + 1), ...relinked, ...after];
}

/* ---------------------------------------------------------------------------------------- */
/* Main (stream-json mode)                                                                   */
/* ---------------------------------------------------------------------------------------- */

function main() {
  const parsed = parseArgs(argv);
  if (parsed.error) return fail(parsed.error);
  const { opts } = parsed;

  if (!opts['--print']) return fail('fake-claude only supports headless mode (-p/--print)');
  if (one(opts, '--input-format') !== 'stream-json') return fail('fake-claude requires --input-format stream-json');
  if (one(opts, '--output-format') !== 'stream-json') return fail('fake-claude requires --output-format stream-json');
  if (!opts['--verbose']) return fail('Error: When using --print, --output-format=stream-json requires --verbose');
  const permissionModeArg = one(opts, '--permission-mode');
  const MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan', 'default'];
  if (permissionModeArg !== undefined && !MODES.includes(permissionModeArg)) {
    return fail(`error: option '--permission-mode <mode>' argument '${permissionModeArg}' is invalid. Allowed choices are acceptEdits, auto, bypassPermissions, manual, dontAsk, plan.`);
  }
  const effortArg = one(opts, '--effort');
  if (effortArg !== undefined && !EFFORTS.includes(effortArg)) {
    return fail(`error: option '--effort <level>' argument '${effortArg}' is invalid. Allowed choices are ${EFFORTS.join(', ')}.`);
  }
  const settingSources = one(opts, '--setting-sources');
  if (settingSources !== undefined && settingSources !== '' && !settingSources.split(',').every((s) => ['user', 'project', 'local'].includes(s.trim()))) {
    return fail(`Error: Invalid setting source in --setting-sources: ${settingSources}`);
  }
  const sessionIdArg = one(opts, '--session-id');
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (sessionIdArg !== undefined && !UUID_RE.test(sessionIdArg)) return fail('Error: Invalid session ID. Must be a valid UUID.');
  const resumeArg = one(opts, '--resume');
  const resumeAt = one(opts, '--resume-session-at');
  if (resumeAt !== undefined && (resumeArg === undefined || resumeArg === true)) return fail('Error: --resume-session-at requires --resume');
  if (sessionIdArg && (resumeArg || opts['--continue']) && !opts['--fork-session']) {
    return fail('Error: --session-id can only be used with --continue or --resume if --fork-session is also specified.');
  }

  if (env.FAKE_CLAUDE_EXIT_ON_START) {
    return fail(env.FAKE_CLAUDE_STDERR || 'fake-claude: exiting on start (FAKE_CLAUDE_EXIT_ON_START)', Number.parseInt(env.FAKE_CLAUDE_EXIT_ON_START, 10) || 1);
  }
  if (env.FAKE_CLAUDE_STDERR) process.stderr.write(env.FAKE_CLAUDE_STDERR + '\n');

  const cwd = process.cwd();
  const sanitize = (p) => p.replace(/[^A-Za-z0-9]/g, '-');
  const persist = env.FAKE_CLAUDE_PERSIST === '1' && !opts['--no-session-persistence'] && !!env.CLAUDE_CONFIG_DIR;
  if (env.FAKE_CLAUDE_PERSIST === '1' && !env.CLAUDE_CONFIG_DIR) process.stderr.write('fake-claude: FAKE_CLAUDE_PERSIST needs CLAUDE_CONFIG_DIR; persistence disabled\n');
  const projectDir = persist ? path.join(env.CLAUDE_CONFIG_DIR, 'projects', sanitize(cwd)) : '';
  const transcriptFile = (sid) => path.join(projectDir, `${sid}.jsonl`);
  const findTranscriptFile = (sid) => {
    if (!persist) return undefined;
    const direct = transcriptFile(sid);
    if (fs.existsSync(direct)) return direct;
    try {
      for (const d of fs.readdirSync(path.join(env.CLAUDE_CONFIG_DIR, 'projects'))) {
        const p = path.join(env.CLAUDE_CONFIG_DIR, 'projects', d, `${sid}.jsonl`);
        if (fs.existsSync(p)) return p;
      }
    } catch {
      /* none */
    }
    return undefined;
  };

  /* --- session id + history ------------------------------------------------------------- */
  let sessionId;
  let historyLines = []; // transcript lines (objects) of the current session
  // a --fork-session child whose copied history is not on disk yet: real claude 2.1.319 writes a
  // fork's transcript only with its first user line, so until then `--resume <fork id>` finds no
  // conversation (VERIFIED: a fork that exits without a message leaves no transcript)
  let forkPending = false;
  // a --session-id whose transcript exists in the cwd's project dir: real claude 2.1.319 refuses it
  // (VERIFIED: `Error: Session ID <id> is already in use.`, exit 1, nothing on stdout) for a new
  // start and for a fork (`--resume X` or `--continue` with --fork-session) alike, BEFORE any
  // session is loaded (the same answer when X has no transcript), so a re-fork of a fork that
  // Claude already wrote never overwrites it. Exempt: a fork onto the very id it resumes
  // (`--resume T --fork-session --session-id T`, VERIFIED exit 0, T untouched); transcripts of
  // other project dirs do not count (VERIFIED)
  if (persist && sessionIdArg && !(opts['--fork-session'] && resumeArg === sessionIdArg) && fs.existsSync(transcriptFile(sessionIdArg))) {
    return fail(`Error: Session ID ${sessionIdArg} is already in use.`);
  }
  if (resumeArg !== undefined && resumeArg !== true) {
    let loaded = [];
    if (persist) {
      const file = findTranscriptFile(resumeArg);
      if (!file) {
        process.stderr.write(`No conversation found with session ID: ${resumeArg}\n`);
        emit({ type: 'result', subtype: 'error_during_execution', is_error: true, duration_ms: 0, duration_api_ms: 0, num_turns: 0, stop_reason: null, session_id: resumeArg, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 }, modelUsage: {}, permission_denials: [], errors: [`No conversation found with session ID: ${resumeArg}`], uuid: uuid() });
        log({ event: 'exit', code: 1, reason: 'resume not found' });
        return exitAfterFlush(1);
      }
      loaded = loadedConversation(fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean));
    }
    if (resumeAt !== undefined) {
      const idx = loaded.findIndex((l) => l.uuid === resumeAt);
      if (idx >= 0) loaded = loaded.slice(0, idx + 1);
      else if (persist) {
        // a message the transcript does not hold: real claude 2.1.319 refuses the resume, with or
        // without --fork-session, before anything is written (VERIFIED; the same error path as
        // `No conversation found`)
        const msg = `No message found with message.uuid of: ${resumeAt}`;
        process.stderr.write(msg + '\n');
        emit({ type: 'result', subtype: 'error_during_execution', is_error: true, duration_ms: 0, duration_api_ms: 0, num_turns: 0, stop_reason: null, session_id: resumeArg, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 }, modelUsage: {}, permission_denials: [], errors: [msg], uuid: uuid() });
        log({ event: 'exit', code: 1, reason: 'resume-session-at message not found' });
        return exitAfterFlush(1);
      } else process.stderr.write(`fake-claude: --resume-session-at ${resumeAt} without persistence (no transcript to cut)\n`);
    }
    sessionId = opts['--fork-session'] ? sessionIdArg || uuid() : resumeArg;
    historyLines = loaded.map((l) => ({ ...l, sessionId }));
    if (persist && opts['--fork-session']) forkPending = true;
    else if (persist && resumeAt !== undefined) {
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(transcriptFile(sessionId), historyLines.map((l) => JSON.stringify(l)).join('\n') + (historyLines.length ? '\n' : ''));
    }
  } else if (opts['--continue'] && persist) {
    let newest;
    try {
      for (const f of fs.readdirSync(projectDir)) {
        if (!f.endsWith('.jsonl')) continue;
        const st = fs.statSync(path.join(projectDir, f));
        if (!newest || st.mtimeMs > newest.m) newest = { f, m: st.mtimeMs };
      }
    } catch {
      /* none */
    }
    sessionId = newest ? newest.f.replace(/\.jsonl$/, '') : uuid();
    if (newest) historyLines = loadedConversation(fs.readFileSync(path.join(projectDir, newest.f), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)));
  } else {
    sessionId = sessionIdArg || uuid(); // an existing --session-id was refused above
  }

  /* --- static config --------------------------------------------------------------------- */
  const partial = !!opts['--include-partial-messages'];
  const replay = !!opts['--replay-user-messages'];
  const promptTool = one(opts, '--permission-prompt-tool');
  const maxTurns = one(opts, '--max-turns') !== undefined ? Number.parseInt(one(opts, '--max-turns'), 10) : undefined;
  let permissionMode = !permissionModeArg || permissionModeArg === 'manual' ? 'default' : permissionModeArg;
  let model = resolveModel(one(opts, '--model'));
  let effort = effortArg || env.FAKE_CLAUDE_DEFAULT_EFFORT || 'medium';

  const KNOWN_TOOLS = ['Task', 'AskUserQuestion', 'Bash', 'Edit', 'EnterPlanMode', 'ExitPlanMode', 'Glob', 'Grep', 'NotebookEdit', 'Read', 'Skill', 'ToolSearch', 'WebFetch', 'WebSearch', 'Write', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'TaskStop'];
  const DEFAULT_TOOLS = ['Task', 'AskUserQuestion', 'Bash', 'Edit', 'EnterPlanMode', 'ExitPlanMode', 'NotebookEdit', 'Read', 'Skill', 'ToolSearch', 'WebFetch', 'WebSearch', 'Write'];
  const toolsArg = opts['--tools'];
  let tools;
  if (!toolsArg || (toolsArg.length === 1 && toolsArg[0] === 'default')) tools = [...DEFAULT_TOOLS];
  else {
    const names = new Set();
    for (const raw of toolsArg.join(',').split(/[,\s]+/).filter(Boolean)) {
      const n = raw === 'Agent' ? 'Task' : raw;
      if (KNOWN_TOOLS.includes(n)) names.add(n);
    }
    if ([...names].some((n) => n.startsWith('Task') && n !== 'Task')) names.add('TaskStop');
    tools = [...(names.has('Task') ? ['Task'] : []), ...[...names].filter((n) => n !== 'Task').sort()];
  }

  const mcpServers = [];
  for (const spec of all(opts, '--mcp-config')) {
    let cfg;
    try {
      cfg = JSON.parse(spec.trim().startsWith('{') ? spec : fs.readFileSync(spec, 'utf8'));
    } catch (e) {
      return fail(`Error: Invalid MCP configuration: ${e.message}`);
    }
    for (const [name, sc] of Object.entries(cfg.mcpServers || {})) {
      const norm = name.replace(/[^a-zA-Z0-9_-]/g, '_');
      const st = (sc && sc.fakeStatus) || 'connected';
      mcpServers.push({ name: norm, configName: name, status: st, config: sc, tools: (sc && sc.fakeTools) || [] });
    }
  }
  const disallowed = new Set(all(opts, '--disallowedTools').join(',').split(/[,\s]+/).filter(Boolean));
  for (const s of mcpServers) if (s.status === 'connected') for (const t of s.tools) tools.push(`mcp__${s.name}__${t}`);
  tools = tools.filter((t) => !disallowed.has(t));

  /* --- script ---------------------------------------------------------------------------- */
  let script = { turns: [] };
  try {
    if (env.FAKE_CLAUDE_SCRIPT_JSON) script = JSON.parse(env.FAKE_CLAUDE_SCRIPT_JSON);
    else if (env.FAKE_CLAUDE_SCRIPT) script = JSON.parse(fs.readFileSync(env.FAKE_CLAUDE_SCRIPT, 'utf8'));
  } catch (e) {
    return fail(`fake-claude: cannot load script: ${e.message}`);
  }
  if (!Array.isArray(script.turns)) script.turns = [];
  const usedTurns = new Set();
  const stateFile = env.FAKE_CLAUDE_STATE_FILE;
  if (stateFile) {
    try {
      for (const i of JSON.parse(fs.readFileSync(stateFile, 'utf8')).usedTurns || []) usedTurns.add(i);
    } catch {
      /* fresh */
    }
  }
  function pickTurn(text) {
    for (let i = 0; i < script.turns.length; i++) {
      const t = script.turns[i];
      if (!t || (usedTurns.has(i) && !t.repeat)) continue;
      if (t.match !== undefined) {
        let re;
        try {
          re = new RegExp(t.match, t.flags || '');
        } catch {
          re = null;
        }
        if (re ? !re.test(text) : !text.includes(t.match)) continue;
      }
      if (!t.repeat) {
        usedTurns.add(i);
        if (stateFile) {
          try {
            fs.writeFileSync(stateFile, JSON.stringify({ usedTurns: [...usedTurns] }));
          } catch {
            /* ignore */
          }
        }
      }
      return { index: i, steps: Array.isArray(t.steps) ? t.steps : [] };
    }
    const d = script.default && Array.isArray(script.default.steps) ? script.default.steps : [{ text: 'ok' }];
    return { index: -1, steps: d };
  }

  /* --- mutable session state ------------------------------------------------------------- */
  let hooks = {};
  let totalCost = 0;
  let modelUsage = {};
  let contextTokens = 0;
  let resultIndex = 0;
  let turnCounter = 0;
  let lastResultIsError = false;
  let lastParentUuid = historyLines.length ? historyLines[historyLines.length - 1].uuid : null;
  const controlDelays = (() => {
    try {
      return JSON.parse(env.FAKE_CLAUDE_CONTROL_DELAYS || '{}');
    } catch {
      return {};
    }
  })();
  // host control requests answered with an error instead ({"<subtype>": "<message>"}), after
  // their FAKE_CLAUDE_CONTROL_DELAYS delay (a set_model the CLI rejects)
  const controlErrors = (() => {
    try {
      return JSON.parse(env.FAKE_CLAUDE_CONTROL_ERRORS || '{}');
    } catch {
      return {};
    }
  })();
  const transcriptPathFor = () => path.join(env.CLAUDE_CONFIG_DIR || path.join(env.HOME || '/', '.claude'), 'projects', sanitize(cwd), `${sessionId}.jsonl`);

  /** Write a pending fork's copied history (its first user line arrived, see forkPending). */
  function materializeFork() {
    if (!forkPending) return;
    forkPending = false;
    try {
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(transcriptFile(sessionId), historyLines.map((l) => JSON.stringify(l)).join('\n') + (historyLines.length ? '\n' : ''));
    } catch (e) {
      process.stderr.write(`fake-claude: transcript write failed: ${e.message}\n`);
    }
  }

  function appendTranscript(entry) {
    materializeFork();
    const line = { parentUuid: lastParentUuid, isSidechain: false, userType: 'external', cwd, sessionId, version: VERSION, timestamp: now(), ...entry };
    lastParentUuid = line.uuid;
    historyLines.push(line);
    if (!persist) return;
    try {
      fs.mkdirSync(projectDir, { recursive: true });
      fs.appendFileSync(transcriptFile(sessionId), JSON.stringify(line) + '\n');
    } catch (e) {
      process.stderr.write(`fake-claude: transcript write failed: ${e.message}\n`);
    }
  }
  const userTextOf = (content) => {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.map((b) => (b && b.type === 'text' ? b.text : b && b.type === 'image' ? '[image]' : b && b.type === 'document' ? '[document]' : '')).join('');
  };
  // the conversation's user messages: tool results and the entries of a local command (see
  // recordLocalCommand) are not listed; a compaction summary stands for the lines it summarized
  // (the model still knows them, VERIFIED: it answered ALPHA, BETA after /compact)
  const historyUserTexts = () =>
    historyLines
      .filter((l) => l.type === 'user' && l.message && !l.localCommand && !(Array.isArray(l.message.content) && l.message.content.some((b) => b && b.type === 'tool_result')))
      .flatMap((l) => (l.isCompactSummary ? (Array.isArray(l.fakeSummarizedTexts) ? l.fakeSummarizedTexts : []) : [userTextOf(l.message.content)]));
  // the session holds a message of the conversation (a compaction summary counts; the entries of
  // local commands do not): /compact of a session without one fails (VERIFIED 2.1.319)
  const hasConversation = () =>
    historyLines.some((l) => (l.type === 'user' || l.type === 'assistant') && l.message && !l.localCommand && !l.isMeta);
  // the message /compact keeps verbatim: real claude 2.1.319 kept the last assistant message of a
  // conversation with two user turns or more and nothing after a single turn (VERIFIED);
  // $FAKE_CLAUDE_COMPACT_PRESERVE=none keeps nothing, =last always the last assistant message
  const compactKept = () => {
    const mode = env.FAKE_CLAUDE_COMPACT_PRESERVE || 'auto';
    if (mode === 'none') return undefined;
    const prompts = historyLines.filter((l) => l.type === 'user' && l.message && !l.localCommand && !l.isCompactSummary && !(Array.isArray(l.message.content) && l.message.content.some((b) => b && b.type === 'tool_result'))).length;
    if (mode !== 'last' && prompts < 2) return undefined;
    for (let i = historyLines.length - 1; i >= 0; i--) {
      const l = historyLines[i];
      if (l.type === 'system' && l.subtype === 'compact_boundary') return undefined;
      if (l.type === 'assistant' && typeof l.uuid === 'string') return l.uuid;
    }
    return undefined;
  };
  // Local commands whose line becomes part of the session transcript, like the real claude 2.1.319
  // (VERIFIED for /effort, /compact, /model, /cost and /context as the only line of a new session,
  // of a resumed one and of a fork that had no line yet: the transcript, a fork's copied history
  // included, is written, and `--resume <id>` / a fork of it then find a conversation). /clear
  // (a new session) and /help are not recorded.
  const LOCAL_RECORDED = new Set(['effort', 'compact', 'model', 'cost', 'usage', 'context']);
  /** The transcript entries of a local command line (VERIFIED 2.1.319 shapes, abridged). */
  function recordLocalCommand(msg, cmd, args) {
    appendTranscript({ type: 'user', uuid: uuid(), isMeta: true, localCommand: true, message: { role: 'user', content: '<local-command-caveat>The command below was run directly in Claude Code, not sent to you as a request, and its output goes straight to the user. It\'s recorded here as context for later messages.</local-command-caveat>' } });
    // the command entry carries the uuid of the line the host sent (VERIFIED)
    appendTranscript({ type: 'user', uuid: msg.uuid || uuid(), localCommand: true, message: { role: 'user', content: `<command-name>/${cmd}</command-name>\n            <command-message>${cmd}</command-message>\n            <command-args>${args}</command-args>` } });
  }

  /* --- frames ---------------------------------------------------------------------------- */
  const SLASH = ['clear', 'compact', 'context', 'cost', 'effort', 'model', 'usage', 'init', 'review', 'security-review'];
  function initFrame(uuids) {
    return {
      type: 'system', subtype: 'init', cwd, session_id: sessionId, tools: [...tools],
      mcp_servers: mcpServers.map((s) => ({ name: s.name, status: s.status, source: 'dynamic' })),
      model, permissionMode, slash_commands: [...SLASH], terminal_slash_commands: ['doctor'],
      apiKeySource: env.ANTHROPIC_API_KEY ? 'ANTHROPIC_API_KEY' : 'none', claude_code_version: VERSION,
      output_style: 'default', agents: ['general-purpose', 'Explore', 'Plan'], skills: [], plugins: [],
      uuid: uuid(), ...(uuids.length ? { user_message_uuids: [...uuids] } : {}),
    };
  }
  const zeroUsage = () => ({ input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 });
  function lifecycle(commandUuid, state) {
    if (commandUuid) emit({ type: 'command_lifecycle', command_uuid: commandUuid, state, uuid: uuid(), session_id: sessionId });
  }
  function emitResult(t, fields) {
    const usage = { input_tokens: t.inTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: t.outTokens };
    if (t.inTokens || t.outTokens) {
      const cost = (t.inTokens * 3 + t.outTokens * 15) / 1e6;
      totalCost += cost;
      const mu = (modelUsage[model] ||= { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0, contextWindow: contextWindow(model), maxOutputTokens: 128000 });
      mu.inputTokens += t.inTokens;
      mu.outputTokens += t.outTokens;
      mu.costUSD += cost;
      contextTokens += t.inTokens + t.outTokens;
    }
    const result = {
      type: 'result', subtype: 'success', is_error: false, duration_ms: Date.now() - t.started, duration_api_ms: Date.now() - t.started,
      num_turns: t.numTurns, result: t.resultText, stop_reason: 'end_turn', terminal_reason: 'completed', session_id: sessionId,
      total_cost_usd: totalCost, usage, modelUsage: JSON.parse(JSON.stringify(modelUsage)), permission_denials: t.denials,
      uuid: uuid(), ...(t.uuids.length ? { user_message_uuid: t.uuids[0], user_message_uuids: [...t.uuids] } : {}),
      queued_turn_count: queue.length, result_index: resultIndex++, ...fields, ...(t.resultOverrides || {}),
    };
    lastResultIsError = result.is_error === true;
    // lines folded in at a tool boundary report `completed` just before the result (VERIFIED)
    for (const u of t.folded || []) lifecycle(u, 'completed');
    emit(result);
    return result;
  }

  /* --- host-bound control requests ------------------------------------------------------- */
  const pendingHost = new Map();
  function sendHostRequest(request, signal) {
    const id = uuid();
    return new Promise((resolve) => {
      if (signal && signal.aborted) return resolve({ cancelled: true });
      const onAbort = () => {
        if (!pendingHost.has(id)) return;
        pendingHost.delete(id);
        emit({ type: 'control_cancel_request', request_id: id });
        log({ event: 'cancel_sent', request_id: id, subtype: request.subtype });
        resolve({ cancelled: true });
      };
      pendingHost.set(id, {
        subtype: request.subtype,
        resolve: (resp) => {
          if (signal) signal.removeEventListener('abort', onAbort);
          resolve(resp);
        },
      });
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      emit({ type: 'control_request', request_id: id, request });
    });
  }
  function anySignal(signals) {
    const ac = new AbortController();
    for (const s of signals) {
      if (!s) continue;
      if (s.aborted) ac.abort();
      else s.addEventListener('abort', () => ac.abort(), { once: true });
    }
    return ac.signal;
  }
  const sleep = (ms, signal) =>
    new Promise((resolve) => {
      if (signal && signal.aborted) return resolve(false);
      const timer = setTimeout(() => resolve(true), ms);
      if (signal) signal.addEventListener('abort', () => { clearTimeout(timer); resolve(false); }, { once: true });
    });

  /* --- templating ------------------------------------------------------------------------ */
  function tpl(value, t) {
    if (typeof value === 'string') {
      return value.replace(/\{\{(\w+)(?::([^}]*))?\}\}/g, (m, key, arg) => {
        switch (key) {
          case 'userText': return t.userText;
          case 'sessionId': return sessionId;
          case 'model': return model;
          case 'effort': return effort;
          case 'cwd': return cwd;
          case 'lastToolResult': return t.lastToolResult;
          case 'lastHookContext': return t.lastHookContext;
          case 'lastControlResponse': return t.lastControlResponse;
          case 'steerText': return (t.steerTexts || []).join(' | ');
          case 'turnIndex': return String(turnCounter);
          case 'historyCount': return String(historyUserTexts().length);
          case 'historyUserTexts': return historyUserTexts().join(' | ');
          case 'env': return env[arg] ?? '';
          default: return m;
        }
      });
    }
    if (Array.isArray(value)) return value.map((v) => tpl(v, t));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, tpl(v, t)]));
    return value;
  }

  /* --- assistant message bookkeeping ----------------------------------------------------- */
  function streamEvent(event, parent) {
    emit({ type: 'stream_event', event, session_id: sessionId, parent_tool_use_id: parent ?? null, uuid: uuid() });
  }
  function openMessage(t, parent) {
    if (t.msg) return true;
    if (maxTurns !== undefined && t.numTurns >= maxTurns) {
      t.maxTurnsHit = true;
      return false;
    }
    t.numTurns++;
    t.inTokens += 100 + contextTokens;
    t.msg = { id: `msg_fake_${crypto.randomBytes(8).toString('hex')}`, index: 0, parent };
    if (partial) streamEvent({ type: 'message_start', message: { model, id: t.msg.id, type: 'message', role: 'assistant', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } }, parent);
    return true;
  }
  function closeMessage(t, stopReason) {
    if (!t.msg) return;
    if (partial) {
      streamEvent({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: t.outTokens } }, t.msg.parent);
      streamEvent({ type: 'message_stop' }, t.msg.parent);
    }
    t.msg = null;
  }
  function assistantFrame(t, block, parent) {
    const frame = {
      type: 'assistant',
      message: { model, id: t.msg.id, type: 'message', role: 'assistant', content: [block], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: Math.ceil(JSON.stringify(block).length / 4) } },
      parent_tool_use_id: parent ?? null, session_id: sessionId, uuid: uuid(), timestamp: now(),
      ...(t.uuids.length ? { user_message_uuid: t.uuids[0], user_message_uuids: [...t.uuids] } : {}),
    };
    emit(frame);
    appendTranscript({ type: 'assistant', uuid: frame.uuid, message: frame.message });
    t.lastAssistantUuid = frame.uuid;
  }
  async function textLike(t, kind, raw, step) {
    const parent = step.parent_tool_use_id ?? null;
    if (t.msg && t.msg.parent !== parent) closeMessage(t, 'end_turn');
    if (!openMessage(t, parent)) return;
    const text = tpl(String(raw), t);
    const index = t.msg.index++;
    if (partial) {
      streamEvent({ type: 'content_block_start', index, content_block: kind === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '', signature: '' } }, parent);
      const chunks = Array.isArray(step.chunks) ? step.chunks.map((c) => tpl(String(c), t)) : text.match(/\S+\s*|\s+/g) || [''];
      for (const c of chunks) {
        streamEvent({ type: 'content_block_delta', index, delta: kind === 'text' ? { type: 'text_delta', text: c } : { type: 'thinking_delta', thinking: c } }, parent);
        if (step.chunkDelayMs) {
          if (!(await sleep(step.chunkDelayMs, t.signal))) break;
        }
      }
    }
    t.outTokens += Math.ceil(text.length / 4) + 1;
    assistantFrame(t, kind === 'text' ? { type: 'text', text } : { type: 'thinking', thinking: text, signature: 'fake-signature' }, parent);
    if (partial) streamEvent({ type: 'content_block_stop', index }, parent);
    if (kind === 'text' && !parent) {
      if (t.resultMsgId === t.msg.id) t.resultText += text;
      else {
        t.resultText = text;
        t.resultMsgId = t.msg.id;
      }
    }
  }

  /* --- tools ----------------------------------------------------------------------------- */
  const READ_ONLY = new Set(['Read', 'Glob', 'Grep', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TaskStop', 'Skill', 'Agent', 'Task', 'ToolSearch']);
  const INTERRUPTED_TEXT = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";
  function matches(matcher, toolName) {
    if (matcher === undefined || matcher === null || matcher === '' || matcher === '*') return true;
    try {
      return new RegExp(`^(?:${matcher})$`).test(toolName);
    } catch {
      return matcher === toolName;
    }
  }
  function hookInput(t, call, event, extra) {
    return {
      session_id: sessionId, transcript_path: transcriptPathFor(), cwd, prompt_id: t.promptId, permission_mode: permissionMode,
      ...(call.spec.agent_id ? { agent_id: call.spec.agent_id, agent_type: call.spec.agent_type || 'general-purpose' } : {}),
      effort: { level: effort }, hook_event_name: event, tool_name: call.name, tool_input: call.input, tool_use_id: call.id,
      ...(call.name.startsWith('mcp__') ? { mcp_server: { name: call.name.split('__')[1], source: 'dynamic' } } : {}),
      ...extra,
    };
  }
  async function runHooks(t, call, event, extra, signal) {
    const regs = (hooks[event] || []).filter((r) => r && matches(r.matcher, call.name));
    const outputs = [];
    for (const reg of regs) {
      for (const cbId of reg.hookCallbackIds || []) {
        const resp = await sendHostRequest({ subtype: 'hook_callback', callback_id: cbId, input: hookInput(t, call, event, extra), tool_use_id: call.id }, signal);
        if (resp.cancelled) return { cancelled: true, outputs };
        if (resp.subtype === 'error') {
          // VERIFIED on 2.1.318: the host's error text is not shown; with onFailure "block" the
          // tool is denied with this fixed reason.
          outputs.push(
            reg.onFailure === 'block'
              ? { decision: 'deny', reason: `[callback]: failed; blocking because onFailure is "block"\nHook callback ${cbId} failed: the SDK host replied with an error or an invalid answer.` }
              : {},
          );
          continue;
        }
        const r = resp.response || {};
        const hso = r.hookSpecificOutput || {};
        let decision = hso.permissionDecision;
        if (!decision && r.decision === 'block') decision = 'deny';
        if (!decision && r.decision === 'approve') decision = 'allow';
        outputs.push({ decision, reason: hso.permissionDecisionReason ?? r.reason, additionalContext: hso.additionalContext, updatedInput: hso.updatedInput });
      }
    }
    return { cancelled: false, outputs };
  }
  function defaultResult(name, input) {
    switch (name) {
      case 'Bash': return '(Bash completed with no output)';
      case 'Read': return `1\tcontents of ${input.file_path ?? 'file'}`;
      case 'Write': return `File created successfully at: ${input.file_path ?? 'file'}`;
      case 'Edit': return `The file ${input.file_path ?? 'file'} has been updated successfully.`;
      default: return `${name} completed`;
    }
  }
  function defaultToolUseResult(name, content, input, isError) {
    if (isError) return `Error: ${content}`;
    switch (name) {
      case 'Bash': return { stdout: content === '(Bash completed with no output)' ? '' : content, stderr: '', interrupted: false, isImage: false, noOutputExpected: false };
      case 'Read': return { type: 'text', file: { filePath: input.file_path, content, numLines: content.split('\n').length, startLine: 1, totalLines: content.split('\n').length } };
      case 'Write': return { type: 'create', filePath: input.file_path, content: input.content, structuredPatch: [], originalFile: null };
      default: return content;
    }
  }
  async function gateAndRun(t, call) {
    const signal = t.signal;
    const out = { call, content: '', is_error: false, interrupted: false, tool_use_result: undefined };
    const deny = (content) => {
      out.content = content;
      out.is_error = true;
      out.tool_use_result = `Error: ${content}`;
      t.denials.push({ tool_name: call.name, tool_use_id: call.id, tool_input: call.input });
      return out;
    };
    const interrupted = (content = INTERRUPTED_TEXT) => {
      out.content = content;
      out.is_error = true;
      out.interrupted = true;
      out.tool_use_result = `Error: ${content}`;
      return out;
    };

    // 1. PreToolUse hook callbacks (00 §3.5)
    const pre = await runHooks(t, call, 'PreToolUse', {}, signal);
    if (pre.cancelled) return interrupted();
    let decision;
    let reason;
    for (const o of pre.outputs) {
      if (o.additionalContext) t.lastHookContext = o.additionalContext;
      if (o.updatedInput && typeof o.updatedInput === 'object') call.input = o.updatedInput;
      if (o.decision === 'deny') {
        if (decision !== 'deny') reason = o.reason;
        decision = 'deny';
      } else if (o.decision === 'ask' && decision !== 'deny') {
        if (decision !== 'ask') reason = o.reason;
        decision = 'ask';
      } else if (o.decision === 'allow' && !decision) {
        decision = 'allow';
        reason = o.reason;
      }
    }
    let fromHook = decision !== undefined;
    if (decision === 'deny') return deny(`PreToolUse:${call.name} hook error: ${reason ?? ''}`);

    // 2. Claude's own permission flow when no hook decided (00 §3.5 "no decision")
    if (!decision) {
      fromHook = false;
      if (permissionMode === 'bypassPermissions') decision = 'allow';
      else decision = call.spec.permission || (READ_ONLY.has(call.name) || (permissionMode === 'acceptEdits' && ['Write', 'Edit', 'NotebookEdit'].includes(call.name)) ? 'allow' : 'ask');
      if (decision === 'ask' && permissionMode === 'dontAsk') decision = 'deny';
      if (decision === 'deny') return deny(`Permission to use ${call.name} has been denied.`);
    }

    // 3. can_use_tool (00 §3.6)
    if (decision === 'ask') {
      if (promptTool !== 'stdio') return deny(`Claude requested permissions to use ${call.name}, but you haven't granted it yet.`);
      const cancelAc = new AbortController();
      let cancelTimer;
      if (call.spec.cancelAfterMs !== undefined) cancelTimer = setTimeout(() => cancelAc.abort(), call.spec.cancelAfterMs);
      const req = {
        subtype: 'can_use_tool', tool_name: call.name, display_name: call.name, input: call.input,
        description: call.input.description || (call.input.file_path ? path.basename(String(call.input.file_path)) : call.name),
        ...(fromHook ? { decision_reason: reason ?? '', decision_reason_type: 'hook' } : {}),
        permission_suggestions: [], tool_use_id: call.id,
        ...(call.input.file_path ? { blocked_path: String(call.input.file_path) } : {}),
        ...(call.spec.agent_id ? { agent_id: call.spec.agent_id } : {}),
      };
      const resp = await sendHostRequest(req, anySignal([signal, cancelAc.signal]));
      if (cancelTimer) clearTimeout(cancelTimer);
      if (resp.cancelled) {
        if (cancelAc.signal.aborted && !signal.aborted) t.abort('cancelled');
        return interrupted();
      }
      if (resp.subtype === 'error') return deny(`Permission request failed: ${resp.error}`);
      const pr = resp.response || {};
      if (pr.behavior === 'allow') {
        if (pr.updatedInput && typeof pr.updatedInput === 'object') call.input = pr.updatedInput;
      } else if (pr.behavior === 'deny') {
        if (pr.interrupt) {
          deny(INTERRUPTED_TEXT);
          out.interrupted = true;
          t.abort('deny-interrupt');
          return out;
        }
        return deny(String(pr.message ?? ''));
      } else {
        return deny('Invalid permission response');
      }
    }

    // 4. "run" the tool
    const started = Date.now();
    if (call.spec.durationMs) {
      if (!(await sleep(call.spec.durationMs, signal))) {
        return interrupted(`${INTERRUPTED_TEXT} Correction to the text above: this call was stopped while running, not refused before it ran.`);
      }
    }
    if (signal.aborted) return interrupted();
    out.is_error = !!call.spec.is_error;
    out.content = tpl(call.spec.result !== undefined ? (typeof call.spec.result === 'string' ? call.spec.result : JSON.stringify(call.spec.result)) : defaultResult(call.name, call.input), t);
    out.tool_use_result = call.spec.tool_use_result !== undefined ? tpl(call.spec.tool_use_result, t) : defaultToolUseResult(call.name, out.content, call.input, out.is_error);

    // 5. PostToolUse / PostToolUseFailure
    const post = out.is_error
      ? await runHooks(t, call, 'PostToolUseFailure', { error: out.content, is_interrupt: false }, signal)
      : await runHooks(t, call, 'PostToolUse', { tool_response: out.tool_use_result, duration_ms: Date.now() - started }, signal);
    for (const o of post.outputs) if (o.additionalContext) t.lastHookContext = o.additionalContext;
    return out;
  }
  async function runTools(t, specs) {
    const parent = specs[0].parent_tool_use_id ?? null;
    if (t.msg && t.msg.parent !== parent) closeMessage(t, 'end_turn');
    if (!openMessage(t, parent)) return;
    const calls = specs.map((s) => {
      const spec = tpl(s, t);
      return { spec, id: spec.id || `toolu_fake_${crypto.randomBytes(8).toString('hex')}`, name: spec.name || 'Bash', input: spec.input || {} };
    });
    for (const call of calls) {
      const index = t.msg.index++;
      const block = { type: 'tool_use', id: call.id, name: call.name, input: call.input, caller: { type: 'direct' } };
      if (partial) {
        streamEvent({ type: 'content_block_start', index, content_block: { ...block, input: {} } }, parent);
        streamEvent({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) } }, parent);
      }
      t.outTokens += 20;
      assistantFrame(t, block, parent);
      if (partial) streamEvent({ type: 'content_block_stop', index }, parent);
    }
    closeMessage(t, 'tool_use');
    const outcomes = await Promise.all(calls.map((c) => gateAndRun(t, c)));
    for (const o of outcomes) {
      const frame = {
        type: 'user',
        message: { role: 'user', content: [{ tool_use_id: o.call.id, type: 'tool_result', content: o.content, is_error: o.is_error }] },
        parent_tool_use_id: parent, session_id: sessionId, uuid: uuid(), timestamp: now(), tool_use_result: o.tool_use_result,
      };
      emit(frame);
      appendTranscript({ type: 'user', uuid: frame.uuid, message: frame.message, toolUseResult: o.tool_use_result });
      t.lastToolResult = o.content;
      t.inTokens += Math.ceil(o.content.length / 4);
    }
    if (outcomes.some((o) => o.interrupted)) t.abort(t.abortReason || 'interrupt');
    // The queue snapshot is taken right after the boundary's tool results, in the same tick: a
    // `next` line the host writes after SEEING these frames waits for the following boundary.
    else if (parent === null && !t.signal.aborted) foldNext(t);
  }

  /** Fold every `priority:"next"` line received so far into the running turn (tool boundary). */
  function foldNext(t) {
    for (const m of t.pendingNext.splice(0)) {
      if (m.uuid) {
        t.uuids.push(m.uuid);
        t.folded.push(m.uuid);
        lifecycle(m.uuid, 'started');
      }
      t.steerTexts.push(userTextOf(m.message && m.message.content));
      appendTranscript({ type: 'user', uuid: m.uuid || uuid(), message: m.message });
    }
  }

  /* --- turns ----------------------------------------------------------------------------- */
  const queue = [];
  let running = null;
  let pumping = false;
  let stdinEnded = false;

  function newTurnState(msg, text) {
    const ac = new AbortController();
    const t = {
      uuids: msg.uuid ? [msg.uuid] : [], userText: text, promptId: uuid(), started: Date.now(), line: msg, localRecorded: false,
      numTurns: 0, inTokens: 0, outTokens: 0, denials: [], resultText: '', resultMsgId: null, msg: null,
      lastToolResult: '', lastHookContext: '', lastControlResponse: '', resultOverrides: null, abortReason: null,
      signal: ac.signal, inTools: false,
      // `priority:"next"` lines received while this turn runs and not yet folded in; uuids folded
      // in (at a tool boundary) and their texts ({{steerText}})
      pendingNext: [], folded: [], steerTexts: [],
      abort(reason) {
        if (!t.abortReason) t.abortReason = reason;
        ac.abort();
      },
    };
    return t;
  }

  function syntheticAssistant(text, command, args) {
    const frame = {
      type: 'assistant',
      message: { id: uuid(), container: null, model: '<synthetic>', role: 'assistant', stop_reason: 'end_turn', stop_sequence: null, type: 'message', usage: zeroUsage(), content: [{ type: 'text', text }], context_management: null },
      parent_tool_use_id: null, local_command_source: `<local-command-stdout>${text}</local-command-stdout>`, session_id: sessionId,
      uuid: uuid(), timestamp: now(), ...(command ? { local_command_run: { command, args } } : {}),
    };
    emit(frame);
  }
  function contextUsage() {
    const maxTokens = contextWindow(model);
    const used = 18000 + contextTokens;
    return {
      categories: [
        { id: 'system_prompt', name: 'System prompt', tokens: 3000, kind: 'used' },
        { id: 'system_tools', name: 'System tools', tokens: 15000, kind: 'used' },
        { id: 'messages', name: 'Messages', tokens: contextTokens, kind: 'used' },
        { id: 'free_space', name: 'Free space', tokens: maxTokens - used, kind: 'free' },
      ],
      totalTokens: used, maxTokens, rawMaxTokens: maxTokens, percentage: Math.round((used / maxTokens) * 100), model,
      autoCompactThreshold: Math.round(maxTokens * 0.967), isAutoCompactEnabled: true,
    };
  }
  const costText = () => `Total cost:            $${totalCost.toFixed(4)}\nTotal duration (API):  0s\nTotal duration (wall): 0s\nTotal code changes:    0 lines added, 0 lines removed`;
  const EFFORT_TEXT = { low: 'Quick, straightforward implementation with minimal overhead', medium: 'Balanced approach with standard implementation and testing', high: 'Comprehensive implementation with extensive testing and documentation', xhigh: 'Extended reasoning for complex problems', max: 'Maximum capability with deepest reasoning' };

  async function runLocal(t, cmd, args) {
    switch (cmd) {
      case 'clear': {
        const old = sessionId;
        const fresh = uuid();
        emit({ type: 'conversation_reset', new_conversation_id: fresh, uuid: fresh, trigger: 'clear', ...(t.uuids.length ? { user_message_uuid: t.uuids[0] } : {}), timestamp: now(), session_id: old });
        sessionId = fresh;
        historyLines = [];
        lastParentUuid = null;
        contextTokens = 0;
        totalCost = 0;
        modelUsage = {};
        emit(initFrame(t.uuids));
        return emitResult(t, { result: '', local_command: 'clear', stop_reason: null });
      }
      case 'compact': {
        if (!hasConversation() && historyLines.length > 0) {
          // a session holding only local-command entries (a /effort, a /compact refused before):
          // real claude 2.1.319 starts the compaction and refuses it (VERIFIED, no model call): a
          // failed compaction status with the reason, a synthetic assistant frame with it as
          // stdout and no local_command_outcome, then a result with the text that says success;
          // no boundary or summary; the transcript gets the command entries and a
          // system/local_command entry with the stdout
          const text = 'Not enough messages to compact.';
          emit({ type: 'system', subtype: 'status', status: 'compacting', session_id: sessionId, uuid: uuid() });
          emit({ type: 'system', subtype: 'status', status: null, compact_result: 'failed', compact_error: text, session_id: sessionId, uuid: uuid() });
          emit(initFrame(t.uuids));
          emit({
            type: 'assistant',
            message: { id: uuid(), container: null, model: '<synthetic>', role: 'assistant', stop_reason: 'end_turn', stop_sequence: null, type: 'message', usage: zeroUsage(), content: [{ type: 'text', text }], context_management: null },
            parent_tool_use_id: null, local_command_source: `<local-command-stdout>${text}</local-command-stdout>`, session_id: sessionId,
            uuid: uuid(), timestamp: now(), local_command_run: { command: 'compact', args },
          });
          recordLocalCommand(t.line, 'compact', args);
          appendTranscript({ type: 'system', subtype: 'local_command', uuid: uuid(), content: `<local-command-stdout>${text}</local-command-stdout>`, level: 'info' });
          t.localRecorded = true;
          return emitResult(t, { result: text, local_command: 'compact', stop_reason: null, num_turns: 0 });
        }
        if (!hasConversation()) {
          // a session with no messages (a new one, or one after /clear or a fallback): real claude
          // 2.1.319 refuses it (VERIFIED, no model call): no status, boundary or summary; one
          // synthetic assistant frame with the error and local_command_outcome failed, then a
          // result that still says success; the transcript gets the command entries and a
          // system/local_command entry with the stderr
          emit(initFrame(t.uuids));
          const text = 'Error: No messages to compact';
          emit({
            type: 'assistant',
            message: { id: uuid(), container: null, model: '<synthetic>', role: 'assistant', stop_reason: 'end_turn', stop_sequence: null, type: 'message', usage: zeroUsage(), content: [{ type: 'text', text }], context_management: null },
            parent_tool_use_id: null, local_command_source: `<local-command-stderr>${text}</local-command-stderr>`, session_id: sessionId,
            uuid: uuid(), timestamp: now(), local_command_run: { command: 'compact', args }, local_command_outcome: { kind: 'failed' },
          });
          recordLocalCommand(t.line, 'compact', args);
          appendTranscript({ type: 'system', subtype: 'local_command', uuid: uuid(), content: `<local-command-stderr>${text}</local-command-stderr>`, level: 'info' });
          t.localRecorded = true;
          return emitResult(t, { result: '', local_command: 'compact', stop_reason: null, num_turns: 0 });
        }
        emit({ type: 'system', subtype: 'status', status: 'compacting', session_id: sessionId, uuid: uuid() });
        if (!(await sleep(Number(env.FAKE_CLAUDE_COMPACT_MS || 5), t.signal))) {
          emit({ type: 'system', subtype: 'status', status: null, compact_result: 'failed', session_id: sessionId, uuid: uuid() });
          return emitResult(t, { subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming', result: '' });
        }
        const pre = 18000 + contextTokens;
        contextTokens = Math.round(contextTokens / 4);
        emit({ type: 'system', subtype: 'status', status: null, compact_result: 'success', session_id: sessionId, uuid: uuid() });
        emit(initFrame(t.uuids));
        const boundaryUuid = uuid();
        const summaryUuid = uuid();
        const stdoutUuid = uuid();
        const kept = compactKept();
        const logicalParent = lastParentUuid;
        const summarized = historyUserTexts();
        const summary = `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n${summarized.join('\n')}${args ? `\n\nCompaction instructions: ${args}` : ''}`;
        emit({
          type: 'system', subtype: 'compact_boundary', session_id: sessionId, uuid: boundaryUuid,
          compact_metadata: { trigger: 'manual', pre_tokens: pre, post_tokens: 18000 + contextTokens, ...(kept ? { preserved_segment: { head_uuid: kept, anchor_uuid: summaryUuid, tail_uuid: kept }, preserved_messages: { anchor_uuid: summaryUuid, uuids: [kept], all_uuids: [kept] } } : {}) },
          logical_parent_uuid: logicalParent,
        });
        emit({ type: 'user', message: { role: 'user', content: summary }, isSynthetic: true, parent_tool_use_id: null, session_id: sessionId, uuid: summaryUuid, timestamp: now() });
        // the transcript (VERIFIED 2.1.319 order): boundary, summary, then the command's entries;
        // from here on the conversation is what a resume of it loads (loadedConversation)
        appendTranscript({
          type: 'system', subtype: 'compact_boundary', uuid: boundaryUuid, parentUuid: null, logicalParentUuid: logicalParent, content: 'Conversation compacted', isMeta: false, level: 'info',
          compactMetadata: { trigger: 'manual', preTokens: pre, postTokens: 18000 + contextTokens, ...(kept ? { preservedSegment: { headUuid: kept, anchorUuid: summaryUuid, tailUuid: kept }, preservedMessages: { anchorUuid: summaryUuid, uuids: [kept], allUuids: [kept] } } : {}) },
        });
        appendTranscript({ type: 'user', uuid: summaryUuid, isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: 'user', content: summary }, fakeSummarizedTexts: summarized });
        historyLines = loadedConversation(historyLines);
        recordLocalCommand(t.line, 'compact', args);
        t.localRecorded = true;
        emit({ type: 'user', message: { role: 'user', content: '<local-command-stdout>Compacted </local-command-stdout>' }, session_id: sessionId, parent_tool_use_id: null, uuid: stdoutUuid, timestamp: now(), isReplay: true });
        appendTranscript({ type: 'user', uuid: stdoutUuid, localCommand: true, message: { role: 'user', content: '<local-command-stdout>Compacted </local-command-stdout>' } });
        t.inTokens += 500;
        t.outTokens += 200;
        return emitResult(t, { result: '', local_command: 'compact', stop_reason: null });
      }
      case 'effort': {
        emit(initFrame(t.uuids));
        let text;
        if (!args) text = `Current effort level: ${effort}`;
        else if (EFFORTS.includes(args)) {
          effort = args;
          text = `Set effort level to ${args} (this session only): ${EFFORT_TEXT[args]}`;
        } else text = `Invalid effort level: ${args}. Valid options are: ${EFFORTS.join(', ')}`;
        syntheticAssistant(text, 'effort', args);
        return emitResult(t, { result: text, local_command: 'effort', stop_reason: null });
      }
      case 'model': {
        emit(initFrame(t.uuids));
        let text;
        if (!args) text = `Current model: \`${displayName(model)}\`\nUsage: /model <name>. Available: sonnet, opus, haiku, fable, default, or a full model ID.`;
        else {
          model = resolveModel(args);
          text = `Set model to \`${displayName(model)}\` for this session only`;
        }
        syntheticAssistant(text, 'model', args);
        return emitResult(t, { result: text, local_command: 'model', stop_reason: null });
      }
      case 'cost':
      case 'usage': {
        emit(initFrame(t.uuids));
        const text = costText();
        syntheticAssistant(text, 'cost', args);
        return emitResult(t, { result: text, local_command: 'cost', stop_reason: null });
      }
      case 'context': {
        emit(initFrame(t.uuids));
        const u = contextUsage();
        const text = `## Context Usage\n\n**Model:** ${model}\n**Tokens:** ${u.totalTokens} / ${u.maxTokens} (${u.percentage}%)`;
        syntheticAssistant(text, 'context', args);
        return emitResult(t, { result: text, local_command: 'context', stop_reason: null });
      }
      case 'help': {
        emit(initFrame(t.uuids));
        const text = "/help isn't available in this environment.";
        syntheticAssistant(text, null, args);
        return emitResult(t, { result: text, stop_reason: null });
      }
      default:
        return undefined;
    }
  }

  const API_ERROR_TEXT = {
    authentication_failed: 'Not logged in · Please run /login',
    rate_limit: "You've hit your session limit · resets 3:45pm",
    billing_error: 'Credit balance is too low',
    overloaded: 'API Error: Repeated 529 Overloaded errors',
  };

  async function runScripted(t) {
    const picked = pickTurn(t.userText);
    log({ event: 'turn', index: picked.index, userText: t.userText });
    emit(initFrame(t.uuids));
    emit({ type: 'system', subtype: 'status', status: 'requesting', session_id: sessionId, uuid: uuid() });
    let apiError = null;
    for (const step of picked.steps) {
      if (t.signal.aborted || t.maxTurnsHit || apiError) break;
      if (!step || typeof step !== 'object') continue;
      if (step.text !== undefined) await textLike(t, 'text', step.text, step);
      else if (step.thinking !== undefined) await textLike(t, 'thinking', step.thinking, step);
      else if (step.tool) {
        t.inTools = true;
        await runTools(t, [step.tool]);
        t.inTools = false;
      } else if (Array.isArray(step.parallel) && step.parallel.length) {
        t.inTools = true;
        await runTools(t, step.parallel);
        t.inTools = false;
      } else if (step.sleepMs !== undefined) {
        await sleep(Number(step.sleepMs), t.signal);
      } else if (step.error !== undefined) {
        closeMessage(t, 'end_turn');
        const text = tpl(step.text ?? step.message ?? API_ERROR_TEXT[step.error] ?? `API Error: ${step.error}`, t);
        emit({
          type: 'assistant',
          message: { id: uuid(), container: null, model: '<synthetic>', role: 'assistant', stop_reason: 'stop_sequence', stop_sequence: '', type: 'message', usage: zeroUsage(), content: [{ type: 'text', text }], context_management: null },
          parent_tool_use_id: null, session_id: sessionId, uuid: uuid(), timestamp: now(), error: step.error, is_api_error_message: true,
        });
        if (t.numTurns === 0) t.numTurns = 1;
        apiError = text;
      } else if (step.result && typeof step.result === 'object') {
        t.resultOverrides = { ...(t.resultOverrides || {}), ...tpl(step.result, t) };
      } else if (step.exit !== undefined) {
        if (step.stderr) process.stderr.write(String(step.stderr) + '\n');
        log({ event: 'exit', code: Number(step.exit), reason: 'script exit step' });
        exitAfterFlush(Number(step.exit));
        await new Promise(() => {}); // never resolves: the process is exiting
      } else if (step.raw !== undefined) {
        writeOut(String(step.raw) + (step.noNewline ? '' : '\n'));
      } else if (step.frame && typeof step.frame === 'object') {
        emit({ session_id: sessionId, uuid: uuid(), ...tpl(step.frame, t) });
      } else if (step.stderr !== undefined) {
        process.stderr.write(String(step.stderr) + '\n');
      } else if (step.control && typeof step.control === 'object') {
        const resp = await sendHostRequest(tpl(step.control, t), t.signal);
        t.lastControlResponse = JSON.stringify(resp);
      }
    }
    if (apiError) {
      return emitResult(t, { is_error: true, result: apiError, terminal_reason: 'api_error', stop_reason: 'stop_sequence' });
    }
    if (t.maxTurnsHit) {
      closeMessage(t, 'tool_use');
      return emitResult(t, { subtype: 'error_max_turns', is_error: true, terminal_reason: 'max_turns', stop_reason: 'tool_use', errors: [`Reached maximum number of turns (${maxTurns})`] });
    }
    if (t.signal.aborted) {
      const tools = t.abortReason !== 'streaming' && (t.inTools || t.abortReason === 'deny-interrupt' || t.abortReason === 'cancelled' || t.lastToolResult !== '');
      closeMessage(t, tools ? 'tool_use' : null);
      emit({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: tools ? '[Request interrupted by user for tool use]' : '[Request interrupted by user]' }] }, parent_tool_use_id: null, session_id: sessionId, uuid: uuid(), timestamp: now() });
      return emitResult(t, { subtype: 'error_during_execution', is_error: true, terminal_reason: tools ? 'aborted_tools' : 'aborted_streaming', stop_reason: tools ? 'tool_use' : null, errors: ['[ede_diagnostic] interrupted'] });
    }
    closeMessage(t, 'end_turn');
    return emitResult(t, {});
  }

  async function runTurn(msg) {
    const content = msg.message && msg.message.content;
    const text = userTextOf(content);
    turnCounter++;
    const t = newTurnState(msg, text);
    running = t;
    if (msg.uuid) lifecycle(msg.uuid, 'started');
    try {
      const slash = /^\/([A-Za-z][\w:-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
      let done = false;
      if (slash) {
        const args = (slash[2] || '').trim();
        const recorded = LOCAL_RECORDED.has(slash[1]);
        // a /compact that succeeds writes its own entries after the compaction's (runLocal)
        if (recorded && slash[1] !== 'compact') recordLocalCommand(msg, slash[1], args);
        const r = await runLocal(t, slash[1], args);
        done = r !== undefined;
        if (recorded && r && !t.localRecorded) {
          if (slash[1] === 'compact') recordLocalCommand(msg, slash[1], args);
          appendTranscript({ type: 'system', subtype: 'local_command', uuid: uuid(), content: `<local-command-stdout>${typeof r.result === 'string' ? r.result : ''}</local-command-stdout>` });
        }
      }
      if (!done) {
        appendTranscript({ type: 'user', uuid: msg.uuid || uuid(), message: { role: 'user', content } });
        await runScripted(t);
      }
    } catch (e) {
      process.stderr.write(`fake-claude internal error: ${e && e.stack ? e.stack : e}\n`);
      emitResult(t, { subtype: 'error_during_execution', is_error: true, errors: [String(e)] });
    } finally {
      running = null;
      // `next` lines that found no tool boundary run next, each as its own turn (VERIFIED
      // 2.1.319: own result → own `completed` → steer `started` → system/init)
      if (t.pendingNext.length) queue.unshift(...t.pendingNext.splice(0));
      // an interrupted line reports `cancelled` after its result (VERIFIED), others `completed`
      const interrupted = t.abortReason === 'interrupt' || t.abortReason === 'streaming';
      if (msg.uuid) lifecycle(msg.uuid, interrupted ? 'cancelled' : 'completed');
    }
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length) await runTurn(queue.shift());
    } finally {
      pumping = false;
    }
    if (stdinEnded && env.FAKE_CLAUDE_HANG_ON_EOF !== '1') {
      log({ event: 'exit', code: lastResultIsError ? 1 : 0, reason: 'stdin closed' });
      exitAfterFlush(lastResultIsError ? 1 : 0);
    }
  }

  function onUser(msg) {
    if (replay) emit({ ...msg, session_id: sessionId, isReplay: true, timestamp: now(), uuid: msg.uuid || uuid() });
    if (msg.uuid) lifecycle(msg.uuid, 'queued');
    if (running && msg.priority === 'next') {
      // queued for the running turn: folded in at its next tool boundary, else run after it
      running.pendingNext.push(msg);
      return;
    }
    if (running && msg.priority === 'now') {
      queue.unshift(msg);
      running.abort('now');
      return;
    }
    queue.push(msg);
    void pump();
  }

  /* --- host control requests ------------------------------------------------------------- */
  function respond(requestId, payload) {
    emit({ type: 'control_response', response: { subtype: 'success', request_id: requestId, ...(payload !== undefined ? { response: payload } : {}) } });
  }
  function respondError(requestId, error) {
    emit({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error } });
  }
  function handleHostRequest(msg) {
    const id = msg.request_id;
    const req = msg.request || {};
    const answer = () => {
      if (req.subtype !== 'initialize' && typeof controlErrors[req.subtype] === 'string') return respondError(id, controlErrors[req.subtype]);
      switch (req.subtype) {
        case 'initialize': {
          if (env.FAKE_CLAUDE_NO_INIT_RESPONSE === '1') return;
          if (env.FAKE_CLAUDE_INIT_ERROR) return respondError(id, env.FAKE_CLAUDE_INIT_ERROR);
          hooks = req.hooks && typeof req.hooks === 'object' ? req.hooks : {};
          return respond(id, {
            commands: [
              { name: 'clear', description: 'Clear conversation history and free up context', argumentHint: '' },
              { name: 'compact', description: 'Clear conversation history but keep a summary in context', argumentHint: '<optional custom summarization instructions>' },
              { name: 'context', description: 'Visualize current context usage', argumentHint: '' },
              { name: 'cost', description: 'Show the total cost and duration of the current session', argumentHint: '' },
              { name: 'effort', description: 'Set effort level for model usage', argumentHint: '[low|medium|high|xhigh|max]' },
              { name: 'model', description: 'Set the AI model for Claude Code', argumentHint: '[model]' },
              { name: 'review', description: 'Review a pull request', argumentHint: '', builtin: true },
            ],
            agents: [
              { name: 'general-purpose', description: 'General-purpose agent for researching complex questions.' },
              { name: 'Explore', description: 'Fast read-only search agent for locating code.', model: 'inherit' },
              { name: 'Plan', description: 'Software architect agent for designing implementation plans.', model: 'inherit' },
            ],
            output_style: 'default',
            available_output_styles: ['default', 'Explanatory', 'Learning'],
            models: MODELS,
            account: { subscriptionType: env.FAKE_CLAUDE_SUBSCRIPTION || 'max', apiProvider: 'firstParty', email: 'fake@example.com' },
            pid: process.pid,
            claude_code_version: VERSION,
            current_permission_mode: permissionMode,
            hook_on_failure_supported: true,
            ...(req.hooks ? { hooks_applied: true } : {}),
            session_state: running ? 'running' : 'idle',
          });
        }
        case 'interrupt': {
          // The plain interrupt keeps queued sends (they run after the interrupted result);
          // `cancel_queued:true` drops them: `command_lifecycle cancelled` for each, then the
          // answer lists them (VERIFIED 2.1.319, capability interrupt_cancel_queued_v1).
          const queued = [...(running ? running.pendingNext : []), ...queue];
          const ids = queued.map((m) => m.uuid).filter((u) => typeof u === 'string' && u);
          if (req.cancel_queued === true) {
            if (running) running.pendingNext.length = 0;
            queue.length = 0;
            for (const u of ids) lifecycle(u, 'cancelled');
            respond(id, { still_queued: [], cancelled: ids });
          } else {
            respond(id, { still_queued: ids });
          }
          if (running) running.abort(running.inTools ? 'interrupt' : 'streaming');
          return;
        }
        case 'cancel_async_message': {
          // Withdraws a line still queued (a `next` line not folded in yet, or one waiting for its
          // own turn): `command_lifecycle cancelled`, then {cancelled:true}; a line no longer
          // queued (started / unknown) answers {cancelled:false} (VERIFIED 2.1.319).
          if (typeof req.message_uuid !== 'string') return respondError(id, 'cancel_async_message: message_uuid must be a string');
          for (const list of [running ? running.pendingNext : [], queue]) {
            const i = list.findIndex((m) => m.uuid === req.message_uuid);
            if (i < 0) continue;
            list.splice(i, 1);
            lifecycle(req.message_uuid, 'cancelled');
            return respond(id, { cancelled: true });
          }
          return respond(id, { cancelled: false });
        }
        case 'set_model':
          model = resolveModel(req.model);
          return respond(id, { model });
        case 'set_permission_mode':
          permissionMode = req.mode === 'manual' ? 'default' : String(req.mode);
          respond(id, { mode: permissionMode });
          emit({ type: 'system', subtype: 'status', status: null, permissionMode, session_id: sessionId, uuid: uuid() });
          return;
        case 'set_max_thinking_tokens':
          return respond(id, undefined);
        case 'get_context_usage':
          return respond(id, contextUsage());
        case 'mcp_status':
          return respond(id, {
            mcpServers: mcpServers.map((s) => ({
              name: s.name, status: s.status, serverInfo: { name: s.name, version: '0.0.1' }, config: s.config,
              scope: 'dynamic', source: 'dynamic', tools: s.tools.map((n) => ({ name: n, annotations: {} })),
              ...(s.status === 'failed' ? { error: 'Connection failed' } : {}),
            })),
          });
        case 'get_settings':
          return respond(id, { effective: {}, sources: [], applied: { model, effort } });
        case 'get_session_cost':
          return respond(id, { text: costText() });
        default:
          return respondError(id, `Unsupported control request subtype: ${req.subtype}`);
      }
    };
    const delay = Number(controlDelays[req.subtype] || 0);
    if (delay > 0) setTimeout(answer, delay);
    else answer();
  }

  /* --- stdin ----------------------------------------------------------------------------- */
  let buf = '';
  let fatal = false;
  function onLine(line) {
    if (fatal) return;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.trim() === '') return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      log({ event: 'stdin', raw: line });
      fatal = true;
      return fail(`Error parsing streaming input line (type=unknown, ${line.length} chars): SyntaxError: ${e.message}`);
    }
    log({ event: 'stdin', line: msg });
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'control_request':
        return handleHostRequest(msg);
      case 'control_response': {
        const r = msg.response || {};
        const p = pendingHost.get(r.request_id);
        if (!p) {
          log({ event: 'unmatched_control_response', request_id: r.request_id });
          return;
        }
        pendingHost.delete(r.request_id);
        return p.resolve(r);
      }
      case 'control_cancel_request':
        return;
      case 'user':
        materializeFork();
        return onUser(msg);
      default:
        return;
    }
  }
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      onLine(line);
    }
  });
  process.stdin.on('end', () => {
    if (buf.trim()) onLine(buf);
    buf = '';
    stdinEnded = true;
    log({ event: 'stdin_end' });
    if (env.FAKE_CLAUDE_HANG_ON_EOF === '1') {
      setInterval(() => undefined, 1 << 30); // keep the event loop alive until killed
      return;
    }
    // Nobody can answer pending control requests any more: abort the running turn.
    if (running && pendingHost.size > 0) running.abort('eof');
    if (!running && !pumping) void pump();
  });
  process.on('SIGTERM', () => {
    log({ event: 'sigterm' });
    if (env.FAKE_CLAUDE_IGNORE_SIGTERM === '1') return;
    exitAfterFlush(143);
  });
}

/* ---------------------------------------------------------------------------------------- */
/* Entry point (last, so every top-level const above is initialised)                         */
/* ---------------------------------------------------------------------------------------- */

if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-v')) {
  writeOut(`${VERSION} (Claude Code)\n`);
  log({ event: 'exit', code: 0, reason: 'version' });
  exitAfterFlush(0);
} else if (argv[0] === 'auth') {
  runAuth(argv.slice(1));
} else if (argv.includes('--help') || argv.includes('-h')) {
  writeOut(HELP_TEXT);
  log({ event: 'exit', code: 0, reason: 'help' });
  exitAfterFlush(0);
} else {
  main();
}

// Fake kiro-claude JS entry for the crew tests: the shim execs `<node> <this file> "$@"`.
// It answers KiroCrew's probes (08 §2.2) the way the real kiro-claude must, so the shim and
// `crew doctor` D7/D8 can be tested without cli/main.ts.
//
// The probe env only carries HOME/PATH/LANG/NO_COLOR/TERM, so configuration and the call log
// live under $HOME:
//   $HOME/.fake-entry.jsonl     call log (argv, KIRO_CLAUDE_BIN, env keys)
//   $HOME/.fake-entry.json      overrides: {"version": "...", "acpHelpV3": true, "v3Exit": 0, "listModels": "..."}
//   $HOME/.fake-claude-login    exists ⇒ `whoami` is signed in (else only CLAUDE_CODE_OAUTH_TOKEN in env)
import * as fs from 'node:fs';
import * as path from 'node:path';

const home = process.env.HOME ?? '/nonexistent';
const args = process.argv.slice(2);
let conf = {};
try {
  conf = JSON.parse(fs.readFileSync(path.join(home, '.fake-entry.json'), 'utf8'));
} catch {
  conf = {};
}
try {
  fs.appendFileSync(
    path.join(home, '.fake-entry.jsonl'),
    JSON.stringify({ args, KIRO_CLAUDE_BIN: process.env.KIRO_CLAUDE_BIN ?? null, envKeys: Object.keys(process.env).sort() }) + '\n',
  );
} catch {
  // ignore
}

const out = (s) => process.stdout.write(s);
const err = (s) => process.stderr.write(s);
const has = (...xs) => xs.every((x) => args.includes(x));

const ENGINE_BLOCK = conf.acpHelpV3
  ? '      --agent-engine <ENGINE>\n          Agent engine\n\n          [possible values: v1, v2, v3]\n'
  : '      --agent-engine <ENGINE>\n          Agent engine\n\n          [possible values: v1, v2]\n';

if (args[0] === '--version') {
  out(`${conf.version ?? 'kiro-claude 0.1.0 (kiro-cli 1.26.0)'}\n`);
  process.exit(0);
}
if (args[0] === 'acp' && args.includes('--agent-engine') && args[args.indexOf('--agent-engine') + 1] === 'v3') {
  err("error: invalid value 'v3' for '--agent-engine <ENGINE>'\n  [possible values: v1, v2]\n\nkiro-claude has no v3 (KAS) agent engine.\n");
  process.exit(conf.v3Exit ?? 2);
}
if (args[0] === 'acp' && args.includes('--help')) {
  out(`Start the Agent Client Protocol server\n\nUsage: kiro-claude acp [OPTIONS]\n\nOptions:\n      --agent <AGENT>\n          Agent to use\n\n${ENGINE_BLOCK}\n  -h, --help\n          Print help\n`);
  process.exit(0);
}
if (args[0] === 'chat' && args.includes('--help')) {
  out(`Start a chat session\n\nUsage: kiro-claude chat [OPTIONS] [INPUT]\n\nOptions:\n      --agent <AGENT>\n          Agent\n\n${ENGINE_BLOCK}\n      --no-interactive\n          Print the first response and exit\n`);
  process.exit(0);
}
if (args[0] === 'whoami') {
  const bin = process.env.KIRO_CLAUDE_BIN;
  if (!bin) {
    err('Not logged in: Claude Code not found ()\n');
    process.exit(1);
  }
  const loggedIn = fs.existsSync(path.join(home, '.fake-claude-login')) || !!process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!loggedIn) {
    err('Not logged in. Run "kiro-claude login" to sign in to Claude Code.\n');
    process.exit(1);
  }
  if (has('--format', 'json')) out('{"email":"user@example.com"}\n');
  else out('Logged in with Claude Code (claude.ai)\nEmail: user@example.com\n');
  process.exit(0);
}
if (args[0] === 'chat' && has('--list-models')) {
  out(
    conf.listModels ??
      JSON.stringify({
        models: [
          { model_name: 'auto', model_id: 'auto', description: 'Claude Code default', context_window_tokens: 200000, rate_multiplier: 1.0 },
          { model_name: 'Claude Haiku 5.5', model_id: 'claude-haiku-5.5', description: 'fast', context_window_tokens: 200000, rate_multiplier: 1.0 },
        ],
      }) + '\n',
  );
  process.exit(0);
}
if (args[0] === 'update') {
  out('kiro-claude is updated by its installer; nothing to do. Update Claude Code with: claude update\n');
  process.exit(0);
}
if (args[0] === 'agent' && args[1] === 'validate') {
  process.exit(0);
}
err(`fake-entry: unsupported ${args.join(' ')}\n`);
process.exit(1);

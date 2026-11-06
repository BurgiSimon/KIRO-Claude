/**
 * The vendored KiroCrew pin and the tool floors of `kiro-claude crew`.
 *
 * Sources (research, binding): 08-kirocrew-integration §0 items 6–8 (pin, members adapter,
 * build floors), §3.3 step 0 (preflight floors), §3.10 (`pin.ts`), §4.1 (bumping the pin is one
 * commit that changes the gitlink, this file, `vendor/README.md` and NOTICE; `test/crew/pin.test.ts`
 * checks the gitlink against {@link KIROCREW_PIN}).
 */

/** KiroCrew as vendored at `vendor/KiroCrew` (git submodule, gitlink = `commit`). */
export const KIROCREW_PIN = Object.freeze({
  url: 'https://github.com/kirodotdev/KiroCrew.git',
  commit: '665a0e4e4a6507de0f3e7cffd3160c9359900c7c',
  version: '0.13.0',
});

/** Path of the submodule inside the kiro-claude checkout. */
export const KIROCREW_SUBMODULE_PATH = 'vendor/KiroCrew';

/** KiroCrew's own Claude Code ACP adapter, installed privately for Crewmate/Bot sessions (08 §0 item 6). */
export const CLAUDE_AGENT_ACP = Object.freeze({
  name: '@agentclientprotocol/claude-agent-acp',
  version: '0.101.0',
  /** Entry inside `<prefix>/node_modules/<name>/`. */
  entry: 'dist/index.js',
});

/** Tool floors (08 §3.3 step 0). */
export const FLOORS = Object.freeze({
  /** KiroCrew's dashboard build and `ensure-node.sh` floor. */
  node: '22.12.0',
  /** `requires-python >=3.12` (08b §1.1). */
  python: '3.12.0',
  /** `--filter` for submodules. */
  git: '2.36.0',
  /** Claude Code (kiro-claude's own floor, claude/binary MIN_CLAUDE_VERSION). */
  claude: '2.1.0',
});

/** Free disk needed at the checkout's filesystem (08 §3.3 step 0), in bytes. */
export const DISK_NEEDS = Object.freeze({
  light: 3 * 1024 ** 3,
  slim: 2.5 * 1024 ** 3,
  full: 4 * 1024 ** 3,
  /** Doctor D10 warning floor at the KiroCrew data home. */
  doctorMin: 1024 ** 3,
});

/** Default dashboard port (08b §2.2). */
export const DEFAULT_PORT = 5476;

/** `bin/kirocrew --version` of the pinned source checkout (08 §3.3 step 2 "Check"). */
export const KIROCREW_VERSION_RE = /^kirocrew\s+0\.13\.0\b/m;

/** Short form used in messages: `665a0e4`. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

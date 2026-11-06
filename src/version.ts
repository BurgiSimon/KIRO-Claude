/**
 * Version strings.
 *
 * KIRO_CLAUDE_VERSION is this project's own version.
 * KIRO_CLI_COMPAT_VERSION is the kiro-cli version we claim compatibility with when a client
 * (e.g. KiroCrew) parses `--version` or ACP `agentInfo.version`: KiroCrew warns below 1.26 and
 * gates newer behaviors at >= 2.21, so a value in [1.26.0, 2.21.0) keeps every conservative
 * code path and silences the "outdated" warning (research 08b §0 item 7).
 */
export const KIRO_CLAUDE_VERSION = '0.1.0';
export const KIRO_CLI_COMPAT_VERSION = '1.26.0';

/**
 * `kiro-claude --version` output: `kiro-claude 0.1.0 (kiro-cli 1.26.0)` (research 08 §0 item 3,
 * verified against KiroCrew's parser). ACP `initialize.agentInfo.version` uses KIRO_CLI_COMPAT_VERSION.
 */
export function versionLine(): string {
  return `kiro-claude ${KIRO_CLAUDE_VERSION} (kiro-cli ${KIRO_CLI_COMPAT_VERSION})`;
}

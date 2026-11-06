# Verification record

The last full verification run of kiro-claude, on Linux with Node v22.23.4, Claude Code
2.1.319 and KiroCrew 0.13.0 at commit `665a0e4e4` (the `vendor/KiroCrew` pin).

| Suite | How it runs | Result |
| --- | --- | --- |
| Unit and integration tests | `npm test` (scriptable fake `claude`) | 3279 pass, 1 skipped (needs a non-root user) |
| Real Claude Code end-to-end | `KIRO_CLAUDE_E2E=1 npm run test:e2e` (haiku) | 15 pass; headless, context, permission gate, REPL approvals, ACP, session files, spec |
| KiroCrew stage B | `test/e2e/kirocrew/stage.sh B` (real kiro-claude, fake `claude`) | 91 pass, 0 fail, 2 skipped |
| KiroCrew stage C | `test/e2e/kirocrew/stage.sh C` (real kiro-claude, real Claude Code, haiku) | 54 pass, 2 skipped; the one teardown failure (KiroCrew's history-index worker still running right after `crew stop`) is fixed and passed on the re-check |
| KiroCrew Bot (C16) | `test/e2e/kirocrew/bots.py --start` | pass: a Crewmate answered through `claude-agent-acp` on Claude Code |

Stage B covers the kiro-cli contract KiroCrew probes (`--version`, `acp --help`, `chat --help`,
session files, the identity-stub rule), ACP scenarios S1–S18, the persistent pipeline (memory,
lessons, cron, heartbeat, delegation, compaction, checkpointed tasks, skills, restart and
resume) and frame parity with captured kiro-cli frames. Stage C repeats the pipeline and the
ACP scenarios against the real Claude Code.

Skipped checks: a real Claude Code sign-in (manual), on-disk effects of tool calls in stage B
(the fake `claude` simulates tools; stage C checks them), and gateway-session runtime
directories that KiroCrew's own teardown SIGKILLs.

Not applicable: KiroCrew's `test_real_kiro_smoke.py`. Its harness starts
`kiro-cli acp --agent-engine v3` (Kiro's KAS engine), which kiro-claude does not provide; the
crew integration configures KiroCrew's v2 backend instead.

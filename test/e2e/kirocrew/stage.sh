#!/usr/bin/env bash
# One whole KiroCrew e2e stage in a fresh isolated run dir (08-kirocrew-integration §5.0, §5.2, §5.3).
#
#   KCDIR=<built KiroCrew> KC_DIST=<kiro-claude build dir> test/e2e/kirocrew/stage.sh B|C
#
# B: real kiro-claude + fake Claude (deterministic, no model cost):
#    setup → identity stub rule → contract → ACP scenarios S1–S17 → crew start → pipeline C1–C14 →
#    parity → teardown.
# C: real kiro-claude + real Claude (haiku; costs model turns): setup → identity → contract → crew start →
#    pipeline (nonces) → ACP scenarios S3 S4 S5 S6 S7 S9 S12 (C15) → teardown.
# Prints every PASS/FAIL/SKIP line, then a summary; exits 1 on any FAIL. The run dir is printed
# and kept (it holds logs and frame corpora; it never holds credentials beyond the gateway token,
# which crew stop removes).
set -u
STAGE=${1:-B}
case "$STAGE" in B|C) ;; *) echo "usage: $0 B|C" >&2; exit 2 ;; esac
here=$(cd "$(dirname "$0")" && pwd)
unset E2E
# shellcheck source=/dev/null
. "$here/env.sh"
echo "E2E=$E2E"
LOG=$E2E/stage-$STAGE.log
port=$(python3 -I -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')
if [ "$STAGE" = B ]; then
  START_ENV="FAKE_CLAUDE_SCRIPT=$KC_TOOLS/fake-script.json FAKE_CLAUDE_LOG=$E2E/fake-claude.jsonl PYTHONDONTWRITEBYTECODE=1"
else
  START_ENV="KIRO_CLAUDE_FORCE_MODEL=haiku PYTHONDONTWRITEBYTECODE=1"
fi
export KC_START_ENV="$START_ENV"
run() { echo "== $*"; "$@" 2>&1 | tee -a "$LOG"; return "${PIPESTATUS[0]}"; }
rc=0
run bash "$KC_TOOLS/setup.sh" --stage "$STAGE" >/dev/null || { echo "FAIL setup see $LOG"; rc=1; }
if [ $rc = 0 ]; then
  run bash "$KC_TOOLS/identity.sh" || rc=1
  run bash "$KC_TOOLS/contract.sh" --stage "$STAGE" || rc=1
  [ "$STAGE" = B ] && { run python3 -I "$KC_TOOLS/acp_scenarios.py" --stage B --bin "$SHIM" || rc=1; }
  env_args=(); for kv in $START_ENV; do env_args+=(--env "$kv"); done
  if run "$KC_NODE" "$KC_ENTRY" crew start --port "$port" "${env_args[@]}"; then
    run bash "$KC_TOOLS/pipeline.sh" --stage "$STAGE" || rc=1
  else
    echo "FAIL crew-start see $CS/run/gateway.err"; rc=1
  fi
  [ "$STAGE" = C ] && { run python3 -I "$KC_TOOLS/acp_scenarios.py" --stage C --bin "$SHIM" S3 S4 S5 S6 S7 S9 S12 || rc=1; }
  [ "$STAGE" = B ] && { run bash "$KC_TOOLS/parity.sh" || rc=1; }
fi
run bash "$KC_TOOLS/teardown.sh" --kill || rc=1
echo "== summary ($E2E)"
grep -cE '^PASS ' "$LOG" | sed 's/^/PASS: /'; grep -cE '^SKIP ' "$LOG" | sed 's/^/SKIP: /'; grep -E '^FAIL ' "$LOG" | sed 's/^/  /' || true
exit $rc

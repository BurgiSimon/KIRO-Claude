#!/usr/bin/env bash
# KiroCrew gateway pipeline (08-kirocrew-integration §5.3 C1–C14; stage B = §5.2 item 3 with fixed
# words instead of nonces). Prints `PASS|FAIL|SKIP <id> <reason>` lines and exits non-zero on any
# FAIL. The steps live in kc_pipeline.py (stdlib Python: HTTP, SSE, JSON); this wrapper checks the
# preconditions and passes the gateway's start env so C12 restarts it identically.
#
#   pipeline.sh [--stage B|C | --real] [--port N] [C1 C4 …]
#
# Needs: env.sh sourced, setup.sh run, and the gateway started with
#   stage B: kiro-claude crew start --env FAKE_CLAUDE_SCRIPT=$KC_TOOLS/fake-script.json \
#            --env FAKE_CLAUDE_LOG=$E2E/fake-claude.jsonl --env PYTHONDONTWRITEBYTECODE=1
#   stage C: kiro-claude crew start --env KIRO_CLAUDE_FORCE_MODEL=haiku --env PYTHONDONTWRITEBYTECODE=1
# (override with KC_START_ENV="K=V K=V"; the same pairs are reused for crew exec and the C12 restart).
set -u
: "${E2E:?source env.sh first}" "${KC_ENTRY:?source env.sh first}"
STAGE=B
pass_args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --stage) STAGE=$2; shift 2 ;;
    --real) STAGE=C; shift ;;
    *) pass_args+=("$1"); shift ;;
  esac
done
if [ -z "${KC_START_ENV:-}" ]; then
  if [ "$STAGE" = B ]; then
    KC_START_ENV="FAKE_CLAUDE_SCRIPT=$KC_TOOLS/fake-script.json FAKE_CLAUDE_LOG=$E2E/fake-claude.jsonl PYTHONDONTWRITEBYTECODE=1"
  else
    KC_START_ENV="KIRO_CLAUDE_FORCE_MODEL=haiku PYTHONDONTWRITEBYTECODE=1"
  fi
fi
env_args=()
for kv in $KC_START_ENV; do env_args+=(--start-env "$kv"); done
exec python3 -I "$KC_TOOLS/kc_pipeline.py" --stage "$STAGE" "${env_args[@]}" "${pass_args[@]}"

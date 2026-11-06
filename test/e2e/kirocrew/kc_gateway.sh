#!/usr/bin/env bash
# Start/stop a headless KiroCrew gateway from the built tree, against the isolated home of
# env.sh, WITHOUT kiro-claude's crew commands (stage A bring-up / debugging only; the stages use
# `kiro-claude crew start|stop|status`, 08 §5.0).
#   kc_gateway.sh start [port]   -> detached gateway, waits for KIROCREW_READY, writes token file
#   kc_gateway.sh stop           -> kirocrew stop (SIGTERM via the home's gateway.lock holder)
#   kc_gateway.sh status
# Env: env.sh sourced (KCDIR, E2E, HOME); KIRO_BIN = kiro-cli replacement (absolute path).
set -euo pipefail
: "${KCDIR:?source env.sh first}" "${E2E:?source env.sh first}" "${KIRO_BIN:?set KIRO_BIN (absolute kiro-cli replacement)}"
KC="$KCDIR/bin/kirocrew"
LOG="$E2E/logs"; mkdir -p "$LOG"
cmd=${1:-status}; port=${2:-5476}
case "$cmd" in
  start)
    : > "$LOG/gw.out"
    cd "$KCDIR"
    # every fd of the detached child points at a file, so callers piping this script never hang
    KIROCREW_KIRO_BIN="$KIRO_BIN" KIROCREW_SKIP_MODEL_DOWNLOAD=1 \
      KIROCREW_SKIP_APP_STORE_FETCH=1 PYTHONUNBUFFERED=1 \
      setsid nohup "$KC" gateway --no-open --no-tunnel --json-ready --port "$port" \
      >"$LOG/gw.out" 2>"$LOG/gw.err" </dev/null &
    disown || true
    for _ in $(seq 1 90); do
      if grep -q '^KIROCREW_READY:' "$LOG/gw.out" 2>/dev/null; then break; fi
      sleep 1
    done
    line=$(grep -m1 '^KIROCREW_READY:' "$LOG/gw.out") || { echo "gateway did not become ready; see $LOG/gw.err" >&2; exit 1; }
    umask 077
    printf '%s' "${line#KIROCREW_READY:}" | python3 -I -c 'import json,sys;print(json.load(sys.stdin)["token"])' > "$LOG/token.txt"
    echo "ready on port $port; token in $LOG/token.txt; logs $LOG/gw.out $LOG/gw.err"
    ;;
  stop) "$KC" stop ;;
  status) "$KC" gateway-pid ;;
  *) echo "usage: $0 start [port] | stop | status" >&2; exit 2 ;;
esac

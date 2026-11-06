#!/usr/bin/env bash
# Stage setup (08-kirocrew-integration §5.0, §5.2, §5.3): `crew setup` against the built KiroCrew
# ($KCDIR, never fetched or built here) plus the test-only Kiro Crew config of §3.6.
#
#   setup.sh [--stage B|C] [--members claude|none]
#
# Stage B bakes test/fixtures/fake-claude.mjs into the shim (--claude-bin); stage C uses the real
# `claude` and adds agent.role_models (haiku). The gateway must be stopped (the hooks edit below
# is a locked JSON edit of config.json, which KiroCrew only allows while nothing else writes it).
# Needs env.sh sourced.
set -euo pipefail
STAGE=B
MEMBERS=claude
while [ $# -gt 0 ]; do
  case "$1" in
    --stage) STAGE=$2; shift 2 ;;
    --real) STAGE=C; shift ;;
    --members) MEMBERS=$2; shift 2 ;;
    *) echo "usage: $0 [--stage B|C] [--members claude|none]" >&2; exit 2 ;;
  esac
done
: "${E2E:?source env.sh first}" "${KCDIR:?set KCDIR (built KiroCrew)}" "${KC_ENTRY:?source env.sh first}"
kc_crew() { "$KC_NODE" "$KC_ENTRY" crew "$@"; }
args=(--dir "$KCDIR" --no-fetch --no-build --members "$MEMBERS" --yes)
case "$KCDIR" in /tmp/*|"${TMPDIR:-/tmp}"/*) args+=(--allow-tmp) ;; esac
[ "$STAGE" = B ] && args+=(--claude-bin "$FAKE_CLAUDE")
echo "+ kiro-claude crew setup ${args[*]}"
kc_crew setup "${args[@]}" </dev/null

# §3.6 test-only keys.
kc_crew exec -- config set heartbeat.default_deliver dashboard
if [ "$STAGE" = C ]; then
  kc_crew exec -- config set agent.role_models '{"background":"claude-haiku-5.5","subagent":"claude-haiku-5.5"}'
fi
# hooks.auto_approve_subagent_spawn=true: not settable with `config set` ("Unknown key"), so a
# locked JSON edit of config.json while the gateway is stopped (08 §3.6).
st=$(kc_crew status --json 2>/dev/null || true)
case "$st" in *'"running":true'*) echo "gateway is running; stop it before setup.sh" >&2; exit 1 ;; esac
"$KCPY" -I -B - "$HOME/.kiro/crew/config.json" <<'PY'
import fcntl, json, os, sys, tempfile
path = sys.argv[1]
with open(path + ".lock", "a+") as lk:
    fcntl.flock(lk, fcntl.LOCK_EX)
    with open(path) as f:
        cfg = json.load(f)
    hooks = cfg.get("hooks") if isinstance(cfg.get("hooks"), dict) else {}
    hooks["auto_approve_subagent_spawn"] = True
    cfg["hooks"] = hooks
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".config.", suffix=".tmp")
    with os.fdopen(fd, "w") as f:
        json.dump(cfg, f, indent=2)
        f.write("\n")
    os.chmod(tmp, os.stat(path).st_mode & 0o777)
    os.replace(tmp, path)
print("hooks.auto_approve_subagent_spawn = true")
PY

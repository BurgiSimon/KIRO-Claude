# shellcheck shell=bash
# Source me: the isolated environment of the KiroCrew end-to-end stages (08-kirocrew-integration §5.0).
#
#   . test/e2e/kirocrew/env.sh            # fresh E2E=$(mktemp -d /tmp/kce.XXXX)
#   E2E=/tmp/kce.ab12 . test/e2e/kirocrew/env.sh   # reuse an existing run dir
#
# Inputs (all optional):
#   KC_REPO     kiro-claude checkout (default: two levels above this file's dir)
#   KC_DIST     kiro-claude build output dir holding src/bin/kiro-claude.js (default: $KC_REPO/dist)
#   KCDIR       built KiroCrew checkout (default: $KC_REPO/vendor/KiroCrew if built, else
#               $KIRO_CLAUDE_E2E_KCDIR)
#   E2E         run dir (default: a new mktemp -d /tmp/kce.XXXX; short, so AF_UNIX paths fit)
#
# Exports: KC_REPO KC_DIST KC_ENTRY KC_NODE KCDIR KCPY E2E HOME CS SHIM FAKE_CLAUDE KC_TOOLS KC_CREW
# (the crew command as one string: "$KC_NODE $KC_ENTRY crew").
#
# Isolation rules (§5.0): HOME=$E2E/h; KIROCREW_HOME, KIRO_HOME and every XDG_* base dir are unset
# so KiroCrew and kiro-claude use their defaults under the fake HOME. The real ~/.kiro, ~/.claude
# and ~/.local are never touched. Python never writes bytecode (KiroCrew's tree stays unmodified).
# Inherited kiro-claude / fake-claude knobs are dropped so a stage never leaks into the next.

_kc_here=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)
export KC_TOOLS="$_kc_here"
export KC_REPO="${KC_REPO:-$(cd "$_kc_here/../../.." && pwd)}"
export KC_DIST="${KC_DIST:-$KC_REPO/dist}"
export KC_ENTRY="$KC_DIST/src/bin/kiro-claude.js"
export KC_NODE="${KC_NODE:-$(command -v node)}"
if [ -z "${KCDIR:-}" ]; then
  if [ -x "$KC_REPO/vendor/KiroCrew/.venv/bin/python" ]; then KCDIR="$KC_REPO/vendor/KiroCrew"
  else KCDIR="${KIRO_CLAUDE_E2E_KCDIR:-}"; fi
fi
export KCDIR
export KCPY="$KCDIR/.venv/bin/python"
export FAKE_CLAUDE="$KC_REPO/test/fixtures/fake-claude.mjs"

if [ -z "${E2E:-}" ]; then E2E=$(mktemp -d /tmp/kce.XXXX); fi
export E2E
export HOME="$E2E/h"
mkdir -p "$HOME" "$E2E/logs"
chmod 700 "$E2E"

unset KIROCREW_HOME KIRO_HOME XDG_DATA_HOME XDG_CONFIG_HOME XDG_CACHE_HOME XDG_STATE_HOME XDG_RUNTIME_DIR
unset KIROCREW_KIRO_BIN KIROCREW_PORT KIRO_CLAUDE_CREW_HOME KIRO_CLAUDE_CREW_DIR
# kiro-claude / fake-claude knobs from the caller's shell.
for _v in $(env | sed -n 's/^\(KIRO_CLAUDE_[A-Za-z0-9_]*\|FAKE_CLAUDE_[A-Za-z0-9_]*\|KIRO_[A-Z0-9_]*\)=.*/\1/p'); do
  case "$_v" in KIRO_CLAUDE_E2E|KIRO_CLAUDE_E2E_KIROCREW|KIRO_CLAUDE_E2E_KCDIR) ;; *) unset "$_v" ;; esac
done
unset _v
# Canary for KC-ENV-01: kiro-claude must scrub it before spawning Claude (00 §3.2).
export CLAUDECODE="${CLAUDECODE:-1}"
export PYTHONDONTWRITEBYTECODE=1
export NO_COLOR=1

export CS="$HOME/.local/share/kiro-claude/crew"
export SHIM="$CS/bin/kiro-claude"
export KC_CREW="$KC_NODE $KC_ENTRY crew"
# KiroCrew's credential-minimal probe environment (08 §2.0 $PROBE, V5).
kc_probe() { env -i HOME="$HOME" PATH=/usr/bin:/bin LANG=C.UTF-8 NO_COLOR=1 TERM=dumb "$@"; }
# `kiro-claude crew …` with this environment.
kc_crew() { "$KC_NODE" "$KC_ENTRY" crew "$@"; }
unset _kc_here

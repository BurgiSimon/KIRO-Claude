#!/usr/bin/env bash
# Frame-shape parity (08-kirocrew-integration §5.2 item 4). Copies KiroCrew's kiro-cli corpus
# ($KCDIR/test/fixtures/acp_frames/kiro/) and its replay harness OUT of the KiroCrew tree into
# $E2E/parity/ (nothing is ever written inside $KCDIR), adds our acp_scenarios.py recordings
# (provenance header {"_meta":{"backend":"","recorded":"live","agent_name":"kiro-claude","agent_version":"1.26.0"}}),
# and runs compare.py with KiroCrew's venv python (-I -B: isolated, no bytecode).
#
#   parity.sh [<frames dir>]     (default: $E2E/acp/frames)
set -euo pipefail
: "${E2E:?source env.sh first}" "${KCDIR:?source env.sh first}" "${KCPY:?source env.sh first}"
FR=${1:-$E2E/acp/frames}
P=$E2E/parity
rm -rf "$P"; mkdir -p "$P/ours"
cp -r "$KCDIR/test/fixtures/acp_frames/kiro" "$P/kiro"
cp "$KCDIR/test/acp_frame_replay_harness.py" "$P/"
cp "$FR"/*.jsonl "$P/ours/"
cd "$P"
exec "$KCPY" -I -B "$KC_TOOLS/compare.py" --parity "$P"

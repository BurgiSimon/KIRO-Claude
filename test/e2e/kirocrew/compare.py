#!/usr/bin/env python3
"""Frame-shape parity (08-kirocrew-integration §5.2 item 4): replay KiroCrew's recorded kiro-cli
corpus and our kiro-claude recordings through KiroCrew's OWN replay harness
(`acp_frame_replay_harness.replay_frames()`, which runs the dispatch layer's classifiers and
parsers) and compare what KiroCrew makes of them: event types, tool identity, permission options,
stop reasons, compaction and steering events. Ids and text are ignored.

  $KCPY -I compare.py --parity <dir> [--ours <frames dir>]

<dir> must hold copies made OUTSIDE the KiroCrew tree (never written to):
  <dir>/kiro/*.jsonl                    ← $KCDIR/test/fixtures/acp_frames/kiro/
  <dir>/acp_frame_replay_harness.py     ← $KCDIR/test/acp_frame_replay_harness.py
  <dir>/ours/*.jsonl                    ← acp_scenarios.py frames (provenance header first)
Prints `PASS|FAIL|SKIP <id> <evidence>`; exits 1 on any FAIL.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

sys.dont_write_bytecode = True
RESULTS: list[str] = []


def report(pid: str, status: str, evidence: str) -> None:
    RESULTS.append(status)
    print(f"{status} {pid} {' '.join(str(evidence).split())[:900]}", flush=True)


def load(harness, d: Path) -> dict[str, list[dict]]:
    out = {}
    for p in sorted(d.glob("*.jsonl")):
        meta, frames = harness.read_fixture(p)
        if meta.get("recorded") not in harness.RECORDED_KINDS:
            raise SystemExit(f"{p.name}: bad provenance {meta}")
        out[p.stem] = harness.replay_frames(frames, gate_envelope_nonce=meta.get("gate_envelope_nonce"))
    return out


def classes(corpus: dict[str, list[dict]]) -> dict[tuple, set[str]]:
    seen: dict[tuple, set[str]] = {}
    for name, entries in corpus.items():
        for e in entries:
            key = (e.get("frame") or "<response>", e.get("action", ""), e.get("session_update", ""))
            seen.setdefault(key, set()).add(name)
    return seen


def events(corpus, kind: str):
    for name, entries in corpus.items():
        for e in entries:
            for ev in e.get("events") or []:
                if ev.get("kind") == kind:
                    yield name, e, ev


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--parity", required=True)
    ap.add_argument("--ours", default=None)
    a = ap.parse_args()
    root = Path(a.parity).resolve()
    sys.path.insert(0, str(root))
    import acp_frame_replay_harness as harness  # the copy in <dir>

    theirs = load(harness, root / "kiro")
    ours = load(harness, Path(a.ours).resolve() if a.ours else root / "ours")
    with open(root / "replayed-ours.json", "w") as f:
        json.dump(ours, f, indent=1, sort_keys=True)
    ct, co = classes(theirs), classes(ours)

    # 1. Event types: every class we emit must be one KiroCrew handles (never unknown/skip where kiro-cli's is handled)
    unknown = sorted(k for k in co if k[1] in ("server_request_unknown",))
    skip_but_handled = sorted(k for k in co if k[1] == "skip" and any(t[0] == k[0] and t[1] != "skip" for t in ct))
    shared = sorted(set(ct) & set(co))
    only_theirs = sorted(set(ct) - set(co))
    only_ours = sorted(set(co) - set(ct))
    report("P-classes", "FAIL" if unknown or skip_but_handled else "PASS",
           f"shared {len(shared)} classes; unknown-to-KiroCrew {unknown}; skipped-but-kiro-handles {skip_but_handled}; "
           f"only ours {[k[0] + '/' + k[2] for k in only_ours]}; only kiro-cli (not exercised) {[k[0] + '/' + k[2] for k in only_theirs]}")

    # 2. Tool identity: shell / read calls classify the same way
    def ident(ev):
        return {k: ev.get(k) for k in ("tool_name", "is_shell", "tool_kind", "tool_identity_trusted")}
    tid_t = {ev.get("tool_name"): ident(ev) for _, _, ev in events(theirs, "tool_call")}
    tid_o = {}
    for _, _, ev in events(ours, "tool_call"):
        tid_o.setdefault(ev.get("tool_name"), ident(ev))
    bad = {n: (tid_o[n], tid_t[n]) for n in tid_o if n in tid_t and tid_o[n] != tid_t[n]}
    common = sorted(set(tid_o) & set(tid_t))
    report("P-tool-identity", "FAIL" if bad or "shell" not in common else "PASS",
           f"compared {common}: mismatches {bad}; ours {json.dumps(tid_o)[:300]}")
    # tool_call fields present in kiro-cli's shell call must be present in ours
    kt = next((ev for _, _, ev in events(theirs, "tool_call") if ev.get("tool_name") == "shell"), {})
    ko = next((ev for _, _, ev in events(ours, "tool_call") if ev.get("tool_name") == "shell"), {})
    missing = sorted(set(kt) - set(ko) - {"tool_call_id"})
    report("P-tool-fields", "FAIL" if missing or not ko else "PASS",
           f"kiro-cli shell tool_call fields {sorted(kt)}; missing in ours {missing}")

    # 3. Permission options
    opts_t = [e.get("recorded_options") for es in theirs.values() for e in es if e.get("action") == "permission"]
    opts_o = [e.get("recorded_options") for es in ours.values() for e in es if e.get("action") == "permission"]
    want = opts_t[0] if opts_t else None
    pe_t = next((ev for _, _, ev in events(theirs, "permission_request")), {})
    pe_o = next((ev for _, _, ev in events(ours, "permission_request")), {})
    miss_p = sorted(set(pe_t) - set(pe_o) - {"tool_call_id", "request_id"})
    report("P-permission-options", "FAIL" if not opts_o or any(o != want for o in opts_o) or miss_p else "PASS",
           f"kiro-cli {want}; ours {len(opts_o)} requests, distinct {[json.dumps(x) for x in {json.dumps(o, sort_keys=True) for o in opts_o}]}; "
           f"permission_request fields missing in ours {miss_p}")

    # 4. Stop reasons
    sr_t = sorted({e.get("stop_reason") for es in theirs.values() for e in es if e.get("stop_reason")})
    sr_o = sorted({e.get("stop_reason") for es in ours.values() for e in es if e.get("stop_reason")})
    acp = {"end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"}
    report("P-stop-reasons", "FAIL" if not set(sr_o) <= acp or "end_turn" not in sr_o or "cancelled" not in sr_o else "PASS",
           f"kiro-cli {sr_t}; ours {sr_o}")

    # 5. Compaction
    def comp(corpus):
        seq = []
        for name, es in corpus.items():
            for e in es:
                if e.get("action") == "compaction":
                    p = e.get("params") or {}
                    seq.append(((p.get("status") or {}).get("type"), tuple(sorted(p)), type(p.get("summary")).__name__))
        return seq
    cpt, cpo = comp(theirs), comp(ours)
    types_t = [x[0] for x in cpt]
    types_o = [x[0] for x in cpo]
    keys_ok = all(x[1] == cpt[0][1] for x in cpo) if cpt else False
    summ_ok = any(x[0] == "completed" and x[2] == "str" for x in cpo)
    report("P-compaction", "FAIL" if types_o[:2] != ["started", "completed"] or not keys_ok or not summ_ok else "PASS",
           f"kiro-cli {cpt}; ours {cpo}")

    # 6. Steering
    def steer(corpus, name_filter=None):
        out = {}
        for name, es in corpus.items():
            if name_filter and not name_filter(name):
                continue
            for e in es:
                if e.get("action") == "steer":
                    out.setdefault(name, []).append(e.get("session_update"))
        return out
    st_t, st_o = steer(theirs), steer(ours)
    seq_o = [s for v in st_o.values() for s in v]
    need = ["AgentExecutionUserMessageQueued", "AgentExecutionSteeringInjected", "AgentExecutionUserMessageCleared"]
    have = all(n in seq_o for n in need)
    kiro_kinds = {s for v in st_t.values() for s in v}
    report("P-steering", "FAIL" if not have or not set(seq_o) <= kiro_kinds else "PASS",
           f"kiro-cli {json.dumps(st_t)[:300]}; ours {json.dumps(st_o)[:300]}")

    # 7. Metadata parses to a context percentage, except kiro-cli's refusal frame
    #    ({sessionId, stopReason:"CONTENT_FILTERED", refusal, modelId}: no contextUsagePercentage on the
    #    wire in kiro-cli 2.32.0 either, KiroCrew corpus refusal-fallback-live.jsonl).
    def raw_metadata(d: Path):
        out = []
        for p in sorted(d.glob("*.jsonl")):
            _, frames = harness.read_fixture(p)
            out += [f.get("params") or {} for f in frames if f.get("method") == "_kiro.dev/metadata"]
        return out
    raw_o = raw_metadata(Path(a.ours).resolve() if a.ours else root / "ours")
    raw_t = raw_metadata(root / "kiro")
    md = [e["metadata"] for es in ours.values() for e in es if e.get("action") == "metadata"]
    refusal_o = [m for m in raw_o if m.get("stopReason") == "CONTENT_FILTERED"]
    plain = [m for m in md if not isinstance(m.get("context_pct"), (int, float))]
    report("P-metadata", "FAIL" if not md or len(plain) != len(refusal_o) else "PASS",
           f"{len(md)} _kiro.dev/metadata frames; context_pct parsed {sorted({type(m.get('context_pct')).__name__ for m in md})}; "
           f"{len(plain)} without context_pct = {len(refusal_o)} CONTENT_FILTERED refusal frames; credits {sorted({str(m.get('credits')) for m in md})[:3]}")
    refusal_t = [m for m in raw_t if m.get("stopReason") == "CONTENT_FILTERED"]
    if not refusal_o:
        report("P-refusal", "SKIP", "no refusal recorded (S14 not run)")
    else:
        kt = (sorted(refusal_t[0]), sorted(refusal_t[0].get("refusal") or {})) if refusal_t else None
        ko = (sorted(refusal_o[0]), sorted(refusal_o[0].get("refusal") or {}))
        report("P-refusal", "FAIL" if kt != ko else "PASS", f"kiro-cli CONTENT_FILTERED metadata keys {kt}; ours {ko}")

    # 8. initialize / session/new responses
    init_o = [e for es in ours.values() for e in es if e.get("frame") == "response" and e.get("agent_version")]
    modes_o = [e["modes"] for es in ours.values() for e in es if e.get("frame") == "response" and e.get("modes")]
    report("P-init-modes", "FAIL" if not init_o or any(e["agent_version"] != "1.26.0" for e in init_o) or not modes_o
           or not all(m.get("advertised") and m.get("current") for m in modes_o) else "PASS",
           f"agent_version {sorted({e['agent_version'] for e in init_o})}; caps {json.dumps(init_o[0].get('agent_capabilities') if init_o else None)}; "
           f"modes current set in {sum(1 for m in modes_o if m.get('current'))}/{len(modes_o)}")
    return 1 if "FAIL" in RESULTS else 0


if __name__ == "__main__":
    sys.exit(main())

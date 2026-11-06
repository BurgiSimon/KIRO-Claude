#!/usr/bin/env python3
"""C16 of 08-kirocrew-integration §5.3 (§7 U6): a KiroCrew Bot (Crewmate, member session) runs on
the user's real Claude Code through the claude-agent-acp bridge that `kiro-claude crew setup`
installs privately under the crew state dir ($CS/node).

  . test/e2e/kirocrew/env.sh                       # E2E=/tmp/kce.XXXX to reuse a set-up run dir
  python3 -I test/e2e/kirocrew/bots.py --start     # starts the gateway (FORCE_MODEL haiku), stops it
  python3 -I test/e2e/kirocrew/bots.py [--port N]  # against a gateway started with `crew start`

Preconditions: env.sh sourced; `crew setup` done with `--members claude` against the real claude
(setup.sh --stage C). Costs one short model turn (the Bot is pinned to a haiku model).

Steps (all through the dashboard HTTP API that the Crewmates page uses, SRC
dashboard/routes/agents.py):
  1. `crew status --json`: running, ready, backends.members = claude, membersInstalled;
     GET /api/acp-backends lists claude installed; KiroCrew config.json has
     agent.member_acp_backend = claude and agent.kas_bundle = false; no KAS engine installed.
  2. POST /api/agents {name, kiro_agent: "kirocrew", model: <haiku>}   (NewCrewmateDialog body)
     GET  /api/members → the Bot's slug;  POST /api/members/{slug}/thread → its DM slot key
     GET  /api/agents/resolved-model?agent=<bot> → harness = claude (the member route)
  3. POST /api/chat {message, slot} (SSE). The message is a challenge whose answer is NOT in it
     (BOT-<nonce>-<a+b>), so an echo of the prompt cannot pass. A watcher polls /proc every 30 ms
     from before `crew start` to after `crew stop` and records every process image of this HOME.
  4. Evidence, tied together by Claude's session id <sid>:
     (a) the reply came from a member session on claude-agent-acp, not from `kiro-claude acp`:
         session_map dashboard:<slot> → sid on the claude_code namespace; the gateway log (lines
         written during the turn) has `claude-acp via <crew.json members.adapter> … sessionId=<sid>`;
         the claude process carrying `--session-id=<sid>` is a child of `node <adapter>`, which
         descends from the gateway pid; exactly ONE transcript under the fake HOME holds the answer
         and it is <sid>.jsonl, written after the turn started, on a haiku model, its text equal
         to the SSE reply; no kiro-claude session file (~/.kiro/sessions/cli) names <sid> or the
         nonce; no `kiro-claude acp` process ran in the Bot's workspace. (kiro-claude also sets
         CLAUDE_CODE_ENTRYPOINT=sdk-ts, so the transcript entrypoint proves nothing and is INFO.)
     (b) the bridge ran crew.json's claude: the bridge has CLAUDE_CODE_EXECUTABLE = crew.json
         `claude` and CLAUDE_AGENT_ACP_BIN = crew.json `members.adapter` (checked by
         name/equality in /proc/<pid>/environ, never printed); every claude child of the bridge
         execs realpath(crew.json claude); that binary reports `(Claude Code)` and the
         transcript's version equals its `--version`; no scrubbed session variable (00 §3.2).
     (c) no KAS/v3 path: no process image with `--agent-engine v3` or under engines/kas during
         the whole run; the gateway log lines of the turn mention no KAS/v3 route.
  5. DELETE /api/agents/<bot> (unless --keep-bot); with --start: `crew stop`, then no process of
     this HOME may remain.
Prints `PASS|FAIL C16 <evidence>` (plus `INFO C16 …` detail lines); exits 1 on FAIL.
stdlib only; never prints tokens or environment values.
"""
from __future__ import annotations

import argparse
import datetime
import glob
import http.cookiejar
import json
import os
import pwd
import re
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

HOME = os.environ["HOME"]
CS = os.environ.get("CS", os.path.join(HOME, ".local/share/kiro-claude/crew"))
KC_HOME = os.path.join(HOME, ".kiro", "crew")
KC_SESS = os.path.join(HOME, ".kiro", "sessions", "cli")   # kiro-claude's own session store
GW_LOG = os.path.join(KC_HOME, "gateway.log")
CREW = [os.environ.get("KC_NODE", "node"), os.environ["KC_ENTRY"], "crew"]
DEFAULT_START_ENV = ["KIRO_CLAUDE_FORCE_MODEL=haiku", "PYTHONDONTWRITEBYTECODE=1"]

# kiro-claude's scrub list (src/claude/env.ts SESSION_VARS / SESSION_VAR_PREFIXES): the gateway env
# drops them (src/crew/env.ts), so neither the bridge nor its claude child may carry one.
SCRUBBED = {
    "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_PID", "CLAUDE_ENV_FILE", "CLAUDE_PROJECT_DIR", "CLAUDE_EFFORT",
    "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_EXECPATH", "CLAUDE_CODE_SSE_PORT",
    "CLAUDE_AFTER_LAST_COMPACT", "CLAUDE_CODE_TEE_SDK_STDOUT", "CLAUDE_CODE_DIAGNOSTICS_FILE", "AI_AGENT",
    "NODE_OPTIONS", "DEBUG",
}
SCRUBBED_PREFIXES = ("CLAUDE_CODE_REMOTE", "CLAUDE_CODE_CCR", "CCR_", "CLAUDE_SESSION_INGRESS")
# The Agent SDK sets this one on the claude it spawns (the bridge's child), to this value.
SDK_CHILD_SETS = {"CLAUDE_CODE_ENTRYPOINT": "sdk-ts"}
REDACT_AFTER = {"--mcp-config", "--settings", "--append-system-prompt", "--system-prompt", "--agents"}
# A KAS route in the gateway log (relay `acp --agent-engine v3`, the bundled engine, the fallback).
KAS_LOG = re.compile(r"agent-engine[ =]v3|\bKAS\b|kas_route|kas_bundle|engine_fallback|engines/kas")


def say(status: str, evidence: str) -> None:
    print(f"{status} C16 {' '.join(str(evidence).split())[:2500]}", flush=True)


def info(msg: str) -> None:
    print(f"INFO C16 {msg}", flush=True)


class Check:
    def __init__(self):
        self.bad: list[str] = []
        self.good: list[str] = []

    def ok(self, cond, what: str, detail: str = "") -> bool:
        if cond:
            self.good.append(what)
        else:
            self.bad.append(f"{what}{(': ' + detail) if detail else ''}")
        return bool(cond)

    def done(self) -> int:
        if self.bad:
            say("FAIL", "; ".join(self.bad) + (f" | ok: {', '.join(self.good)}" if self.good else ""))
            return 1
        say("PASS", ", ".join(self.good))
        return 0


# ── processes ────────────────────────────────────────────────────────────────

def sanitize_argv(argv) -> str:
    out, skip = [], False
    for a in argv:
        if skip:
            out.append("<redacted>")
            skip = False
            continue
        if a in REDACT_AFTER:
            skip = True
        if "=" in a and a.split("=", 1)[0] in REDACT_AFTER:
            a = a.split("=", 1)[0] + "=<redacted>"
        if len(a) > 160 or re.search(r"token|secret|key=", a, re.I):
            a = a[:40] + f"…<{len(a)} chars>"
        out.append(a)
    return " ".join(out)


def redact_line(s: str) -> str:
    return re.sub(r"(token|secret|key)([=:]\s*)\S+", r"\1\2<redacted>", s, flags=re.I)[:200]


def ancestors(pid: int) -> set[int]:
    seen = set()
    while pid > 1 and pid not in seen:
        seen.add(pid)
        try:
            pid = int(open(f"/proc/{pid}/stat").read().rsplit(")", 1)[1].split()[1])
        except (OSError, ValueError, IndexError):
            break
    return seen


def read_argv(pid: int) -> tuple[str, ...]:
    with open(f"/proc/{pid}/cmdline", "rb") as f:
        return tuple(a.decode("utf-8", "replace") for a in f.read().split(b"\0") if a)


def proc_facts(pid: int, argv: tuple[str, ...], state: dict) -> dict | None:
    """Facts about one process of this run's HOME (None for any other process). Env facts are
    booleans or names only; values never leave this function."""
    d = f"/proc/{pid}"
    try:
        with open(f"{d}/environ", "rb") as f:
            raw = f.read().split(b"\0")
    except OSError:
        return None
    if f"HOME={HOME}".encode() not in raw:
        return None
    claude, adapter = state.get("claude") or "", (state.get("members") or {}).get("adapter") or ""
    try:
        with open(f"{d}/stat") as f:
            stat = f.read().rsplit(")", 1)[1].split()
        ppid, sess = int(stat[1]), int(stat[3])
    except (OSError, ValueError, IndexError):
        return None
    env = {}
    for e in raw:
        if b"=" in e:
            k, v = e.split(b"=", 1)
            env[k.decode("utf-8", "replace")] = v
    try:
        exe = os.readlink(f"{d}/exe")
    except OSError:
        exe = ""
    try:
        cwd = os.readlink(f"{d}/cwd")
    except OSError:
        cwd = ""
    leaks = sorted(k for k in env if (k in SCRUBBED or k.startswith(SCRUBBED_PREFIXES))
                   and not (k in SDK_CHILD_SETS and env[k] == SDK_CHILD_SETS[k].encode()))
    return {
        "pid": pid, "ppid": ppid, "sid": sess, "argv": list(argv), "exe": exe, "cwd": cwd, "t": time.time(),
        "cce": "CLAUDE_CODE_EXECUTABLE" in env,
        "cce_is_state_claude": bool(claude) and env.get("CLAUDE_CODE_EXECUTABLE") == claude.encode(),
        "acp_bin_is_state_adapter": bool(adapter) and env.get("CLAUDE_AGENT_ACP_BIN") == adapter.encode(),
        "entrypoint": env.get("CLAUDE_CODE_ENTRYPOINT", b"").decode("utf-8", "replace"),
        "spawned": env.get("KIROCREW_SPAWNED") == b"1",
        "leaks": leaks,
    }


def home_procs(state: dict) -> list[dict]:
    """Every live process whose HOME is this run's HOME."""
    out = []
    for name in os.listdir("/proc"):
        if not name.isdigit():
            continue
        try:
            argv = read_argv(int(name))
        except OSError:
            continue
        p = proc_facts(int(name), argv, state)
        if p:
            out.append(p)
    return out


class Sampler(threading.Thread):
    """Polls /proc every 30 ms. Every distinct (pid, argv) image of this HOME is recorded, so a
    fork is seen again after its exec and a short-lived spawn (a rejected `--agent-engine v3`
    exits in < 0.5 s) is still caught. `latest` holds each pid's last image."""

    def __init__(self, state: dict, interval: float = 0.03):
        super().__init__(daemon=True)
        self.state, self.interval = state, interval
        self.images: dict[tuple, dict] = {}
        self.latest: dict[int, dict] = {}
        self.foreign: dict[int, tuple] = {}
        self.passes = 0
        self.stop_ev = threading.Event()
        self.lock = threading.Lock()

    def run(self) -> None:
        while not self.stop_ev.is_set():
            self.snap()
            self.stop_ev.wait(self.interval)

    def snap(self) -> None:
        with self.lock:
            self.passes += 1
            for name in os.listdir("/proc"):
                if not name.isdigit():
                    continue
                pid = int(name)
                try:
                    argv = read_argv(pid)
                except OSError:
                    continue
                if not argv or self.foreign.get(pid) == argv or (pid, argv) in self.images:
                    continue
                p = proc_facts(pid, argv, self.state)
                if p is None:
                    self.foreign[pid] = argv
                    continue
                self.images[(pid, argv)] = p
                self.latest[pid] = p


def is_kiro_claude_acp(p: dict) -> bool:
    a = p["argv"]
    return ("acp" in a and "--help" not in a and "-h" not in a
            and any(x.endswith("kiro-claude.js") or x.endswith("/kiro-claude") for x in a[:2]))


def is_kas(p: dict) -> bool:
    a = p["argv"]
    v3 = any(x == "--agent-engine=v3" or (x == "--agent-engine" and i + 1 < len(a) and a[i + 1] == "v3")
             for i, x in enumerate(a))
    return v3 or any("/engines/kas" in x for x in a + [p["exe"]])


# ── HTTP ─────────────────────────────────────────────────────────────────────

def crew(*args: str, timeout: float = 300) -> subprocess.CompletedProcess:
    return subprocess.run([*CREW, *args], capture_output=True, text=True, timeout=timeout,
                          stdin=subprocess.DEVNULL, env=dict(os.environ))


def crew_status() -> dict:
    r = crew("status", "--json", timeout=120)
    try:
        d = json.loads(r.stdout)
    except ValueError:
        return {"_rc": r.returncode, "_err": r.stderr[-300:]}
    d.pop("token", None)
    return d


class Gateway:
    def __init__(self, port: int):
        self.base = f"http://127.0.0.1:{port}"
        last = None
        for attempt in range(6):
            try:
                token = open(os.path.join(CS, "run", "token")).read().strip()
            except OSError:
                token = ""
            if attempt >= 3 or not token:
                r = crew("open", "--print", "--ttl", "2h", timeout=120)
                m = re.search(r"[?&]token=([^\s&]+)", r.stdout)
                token = m.group(1) if m else token
            self.op = urllib.request.build_opener(urllib.request.ProxyHandler({}),
                                                  urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
            try:
                self.op.open(f"{self.base}/api/status?token={token}", timeout=20).read()
                return
            except (urllib.error.URLError, OSError) as e:
                last = type(e).__name__
                time.sleep(2)
        raise RuntimeError(f"dashboard login failed ({last})")

    def call(self, method: str, path: str, body=None, timeout: float = 60):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method, headers={"Content-Type": "application/json"})
        try:
            with self.op.open(req, timeout=timeout) as r:
                raw, code = r.read().decode("utf-8", "replace"), r.status
        except urllib.error.HTTPError as e:
            raw, code = e.read().decode("utf-8", "replace"), e.code
        try:
            return code, json.loads(raw)
        except ValueError:
            return code, raw

    def chat(self, message: str, slot: str, timeout: float = 300) -> dict:
        """One turn over SSE; approves a pending tool approval if the gateway raises one."""
        out = {"reply": None, "events": [], "approved": 0, "error": None}
        stop = threading.Event()

        def approver():
            while not stop.wait(0.5):
                try:
                    _, d = self.call("GET", f"/api/chat/slots/{slot}", timeout=10)
                except OSError:
                    continue
                pa = d.get("pending_approval") if isinstance(d, dict) else None
                if pa:
                    rid = (pa.get("request_id") or pa.get("id") or "") if isinstance(pa, dict) else ""
                    self.call("POST", f"/api/chat/slots/{slot}/approve", {"action": "approved", "request_id": rid})
                    out["approved"] += 1

        th = threading.Thread(target=approver, daemon=True)
        th.start()
        req = urllib.request.Request(self.base + "/api/chat", data=json.dumps({"message": message, "slot": slot}).encode(),
                                     method="POST", headers={"Content-Type": "application/json"})
        t0 = time.time()
        try:
            with self.op.open(req, timeout=timeout) as resp:
                for raw in resp:
                    line = raw.decode("utf-8", "replace").rstrip("\n")
                    if not line.startswith("data: "):
                        continue
                    data = line[6:]
                    if data == "[DONE]":
                        break
                    try:
                        ev = json.loads(data)
                    except ValueError:
                        continue
                    out["events"].append(ev.get("type"))
                    if ev.get("type") == "assistant":
                        out["reply"] = ev.get("content")
                    elif ev.get("type") == "error":
                        out["error"] = str(ev.get("content"))[:500]
        except (OSError, urllib.error.URLError) as e:
            out["error"] = f"{type(e).__name__}: {e}"
        finally:
            stop.set()
        out["secs"] = round(time.time() - t0, 1)
        return out


# ── the check ────────────────────────────────────────────────────────────────

def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def parse_ts(s: str) -> float | None:
    try:
        return datetime.datetime.fromisoformat(str(s).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def read_transcript(path: str) -> dict:
    info_ = {"entrypoints": set(), "versions": set(), "cwds": set(), "models": set(), "texts": []}
    for line in open(path, encoding="utf-8", errors="replace"):
        try:
            r = json.loads(line)
        except ValueError:
            continue
        for k, dst in (("entrypoint", "entrypoints"), ("version", "versions"), ("cwd", "cwds")):
            if r.get(k):
                info_[dst].add(r[k])
        if r.get("type") == "assistant":
            m = r.get("message") or {}
            if m.get("model"):
                info_["models"].add(m["model"])
            for c in m.get("content") or []:
                if isinstance(c, dict) and c.get("type") == "text":
                    info_["texts"].append((c.get("text", ""), parse_ts(r.get("timestamp"))))
    return info_


def transcripts_holding(needle: str) -> list[str]:
    """Every Claude transcript under the fake HOME whose ASSISTANT text holds `needle`."""
    hits = []
    for path in glob.glob(os.path.join(HOME, ".claude", "projects", "*", "*.jsonl")):
        try:
            with open(path, encoding="utf-8", errors="replace") as f:
                if needle not in f.read():
                    continue
        except OSError:
            continue
        if any(needle in t for t, _ in read_transcript(path)["texts"]):
            hits.append(path)
    return hits


def kiro_claude_sessions_naming(sid: str, needles: list[str], since: float) -> list[str]:
    """kiro-claude session files (~/.kiro/sessions/cli) that name `sid` or were written since the
    turn started and hold one of `needles`: a Bot turn served by `kiro-claude acp` leaves one."""
    hits = []
    for path in glob.glob(os.path.join(KC_SESS, "*")):
        try:
            if os.path.basename(path).startswith(sid):
                hits.append(path)
                continue
            if os.path.getmtime(path) < since - 2:
                continue
            with open(path, encoding="utf-8", errors="replace") as f:
                body = f.read()
        except OSError:
            continue
        if sid in body or any(n in body for n in needles):
            hits.append(path)
    return hits


def claude_version(claude: str) -> str:
    try:
        r = subprocess.run([claude, "--version"], capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL)
        return (r.stdout or "").strip().splitlines()[0] if r.returncode == 0 and r.stdout.strip() else ""
    except (OSError, subprocess.SubprocessError):
        return ""


def read_from(path: str, pos: int) -> str:
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            if os.path.getsize(path) >= pos:
                f.seek(pos)
            return f.read()
    except OSError:
        return ""


def chain_to(pid: int, target: int, by_pid: dict[int, dict]) -> list[int]:
    """The recorded ppid chain from `pid` up to `target` (empty if `target` is not an ancestor)."""
    chain, seen = [pid], set()
    while pid in by_pid and pid not in seen:
        seen.add(pid)
        pid = by_pid[pid]["ppid"]
        chain.append(pid)
        if pid == target:
            return chain
    return []


def run_check(a, gw: Gateway, state: dict, sampler: Sampler, c: Check) -> None:
    nonce = os.urandom(5).hex()
    bot = f"c16bot{nonce}"
    claude = state.get("claude") or ""
    adapter = (state.get("members") or {}).get("adapter") or ""
    real_claude = os.path.realpath(claude) if claude else ""
    # The answer must not appear in the prompt, so an echo of the prompt cannot pass: the code in
    # upper case plus a two-digit sum (haiku got a four-digit mental sum wrong in one run).
    while True:
        code_ = os.urandom(5).hex()
        x, y = (11 + b % 34 for b in os.urandom(2))
        prompt = (f"Do not use any tools. The code is {code_}. Reply with exactly BOT-, then the code in "
                  f"UPPERCASE, then -, then the sum {x} + {y} in digits, and nothing else.")
        want = f"BOT-{code_.upper()}-{x + y}"
        if sum(ch.isalpha() for ch in code_) >= 3 and want not in prompt and code_.upper() not in prompt \
                and str(x + y) not in prompt:
            break

    # 1. status, backends, KiroCrew config, the binaries crew setup recorded
    st = crew_status()
    be = st.get("backends") or {}
    gw_pid = st.get("pid")
    c.ok(st.get("running") is True and st.get("ready") is True and isinstance(gw_pid, int), "crew status running+ready (gateway pid known)",
         json.dumps({k: st.get(k) for k in ("running", "ready", "holder", "pid", "reason")}))
    c.ok(be.get("members") == "claude" and be.get("membersInstalled") is True, "crew status members = claude (installed)", json.dumps(be))
    c.ok(adapter.startswith(os.path.join(CS, "node") + os.sep) and os.path.isfile(adapter),
         "crew.json members.adapter is the private install under $CS/node", adapter)
    code, ab = gw.call("GET", "/api/acp-backends")
    rows = {r.get("id"): r for r in (ab.get("backends") or []) if isinstance(r, dict)} if isinstance(ab, dict) else {}
    c.ok(str((rows.get("claude") or {}).get("installed")).lower() in ("installed", "true"), "/api/acp-backends: claude installed",
         json.dumps((rows.get("claude") or {}).get("installed")))
    try:
        agent_cfg = (json.load(open(os.path.join(KC_HOME, "config.json"))).get("agent") or {})
    except (OSError, ValueError):
        agent_cfg = {}
    c.ok(agent_cfg.get("member_acp_backend") == "claude" and agent_cfg.get("kas_bundle") is False,
         "KiroCrew config: agent.member_acp_backend = claude, agent.kas_bundle = false",
         json.dumps({k: agent_cfg.get(k) for k in ("acp_backend", "member_acp_backend", "kas_bundle")}))
    kas_root = os.path.join(KC_HOME, "engines", "kas")
    c.ok(not (os.path.isdir(kas_root) and os.listdir(kas_root)), "no KAS engine installed (~/.kiro/crew/engines/kas absent or empty)")
    version = claude_version(claude) if claude else ""
    fake = os.environ.get("FAKE_CLAUDE") or "fake-claude"
    c.ok(bool(real_claude) and os.access(real_claude, os.X_OK) and "(Claude Code)" in version
         and "fake-claude" not in real_claude and real_claude != os.path.realpath(fake),
         "crew.json claude is the real Claude Code", f"{claude} -> {real_claude}: {version!r}")
    info(f"claude={claude} -> {real_claude} version={version!r} adapter={adapter}")

    # 2. create the Bot, open its DM thread (gateway.log is read from here on)
    try:
        log_pos = os.path.getsize(GW_LOG)
    except OSError:
        log_pos = 0
    t_create = time.time()
    code, made = gw.call("POST", "/api/agents", {
        "name": bot, "kiro_agent": "kirocrew", "workspace": "", "memory_store": "default",
        "description": "C16 bridge check", "triggers": "", "session_color": "", "model": a.model,
    })
    if not c.ok(code == 200 and isinstance(made, dict) and made.get("ok"), f"POST /api/agents created Bot {bot} (model {a.model})", f"{code} {json.dumps(made)[:300]}"):
        return
    try:
        _, roster = gw.call("GET", "/api/members")
        row = next((m for m in (roster.get("members") or []) if m.get("name") == bot), None) if isinstance(roster, dict) else None
        c.ok(row is not None and row.get("model") == a.model, "GET /api/members lists the Bot with its model pin", json.dumps(row)[:300] if row else "absent")
        slug = (row or {}).get("slug") or bot
        code, th = gw.call("POST", f"/api/members/{slug}/thread")
        slot = th.get("slot_key") if isinstance(th, dict) else None
        if not c.ok(code == 200 and slot and slot.startswith("member-"), "POST /api/members/{slug}/thread → member slot", f"{code} {json.dumps(th)[:300]}"):
            return
        code, rm = gw.call("GET", f"/api/agents/resolved-model?agent={bot}")
        rm = rm if isinstance(rm, dict) else {}
        c.ok(code == 200 and rm.get("harness") == "claude", "KiroCrew backend role for the Bot: harness = claude",
             json.dumps({k: rm.get(k) for k in ("harness", "inherited_harness", "harness_model", "pin_served_as", "models_backend")}))
        info(f"bot={bot} slug={slug} slot={slot} resolved: " + json.dumps(
            {k: rm.get(k) for k in ("harness", "inherited_harness", "models_backend", "harness_model", "pin_served_as")}))

        # 3. one DM turn
        t0 = time.time()
        r = gw.chat(prompt, slot, timeout=a.timeout)
        time.sleep(1.0)
        sampler.snap()
        reply = r["reply"] if isinstance(r["reply"], str) else ""
        c.ok(want in reply, f"Bot reply holds {want} (neither the upper-case code nor the sum is in the prompt: not an echo)",
             json.dumps({k: r.get(k) for k in ("reply", "error", "events", "secs")})[:400])
        info(f"reply={reply!r} secs={r['secs']} events={r['events'][:12]} approvals={r['approved']}")
        new_log = read_from(GW_LOG, log_pos)

        # session id: session_map → claude argv → gateway log → transcript
        sid, ent = None, {}
        try:
            ent = json.load(open(os.path.join(KC_HOME, "session_map.json"))).get(f"dashboard:{slot}") or {}
            sid = ent.get("sid")
        except (OSError, ValueError) as e:
            c.ok(False, "session_map.json readable", type(e).__name__)
        ws = os.path.join(KC_HOME, f"workspace-member-{slug}")
        c.ok(bool(sid) and ent.get("provider") == "claude_code" and ent.get("cwd") == ws,
             "session_map dashboard:<slot>: claude_code namespace, cwd = the Bot workspace, sid set",
             json.dumps({k: ent.get(k) for k in ("provider", "cwd", "sid")}))
        sid = sid or "<none>"

        # 4. processes
        with sampler.lock:
            images = list(sampler.images.values())
            by_pid = dict(sampler.latest)
        bridges = [p for p in by_pid.values() if adapter and p["argv"][1:2] == [adapter]
                   and os.path.basename(p["exe"]).startswith("node")]
        bridge_pids = {p["pid"] for p in bridges}
        kids = [p for p in by_pid.values() if p["ppid"] in bridge_pids]
        claude_kids = [p for p in kids if "stream-json" in p["argv"]]
        sid_kids = [p for p in claude_kids if f"--session-id={sid}" in p["argv"]
                    or any(p["argv"][i:i + 2] == [f, sid] for f in ("--session-id", "--resume") for i in range(len(p["argv"])))]
        c.ok(bool(bridges), "ps: `node <crew.json members.adapter>` (claude-agent-acp 0.101.0 bridge) ran",
             f"{len(by_pid)} HOME pids, {len(images)} images, {sampler.passes} polls")
        c.ok(bridges and all(p["cce_is_state_claude"] for p in bridges),
             "bridge env: CLAUDE_CODE_EXECUTABLE = crew.json claude", json.dumps([[p["pid"], p["cce"], p["cce_is_state_claude"]] for p in bridges]))
        c.ok(bridges and all(p["acp_bin_is_state_adapter"] for p in bridges), "bridge env: CLAUDE_AGENT_ACP_BIN = crew.json members.adapter")
        c.ok(len(sid_kids) == 1, "ps: exactly one claude process carries --session-id=<sid> and its parent is the bridge",
             json.dumps([[p["pid"], p["ppid"], sanitize_argv(p["argv"][:2])] for p in kids])[:400])
        exec_kids = [p for p in kids if not os.path.basename(p["exe"]).startswith("node")]
        c.ok(claude_kids and all(os.path.realpath(p["exe"]) == real_claude for p in exec_kids),
             "every non-node child of the bridge execs realpath(crew.json claude)",
             json.dumps([[p["pid"], p["exe"]] for p in exec_kids]))
        sid_bridges = [by_pid[k["ppid"]] for k in sid_kids]
        c.ok(sid_kids and all(p["cwd"] == ws for p in sid_kids + sid_bridges),
             "the <sid> bridge and its claude run in the Bot workspace", json.dumps(sorted({p["cwd"] for p in sid_kids + sid_bridges})))
        chains = [chain_to(p["pid"], gw_pid, by_pid) for p in sid_kids] if isinstance(gw_pid, int) else []
        c.ok(chains and all(chains), "claude <sid> → bridge → … → gateway pid (process ancestry)", json.dumps(chains))
        leaky = [[p["pid"], p["leaks"]] for p in bridges + claude_kids if p["leaks"]]
        c.ok(not leaky, "no scrubbed session variable reached the bridge or its claude (KC-ENV-01)", json.dumps(leaky))
        kc_in_bot = [p["pid"] for p in by_pid.values() if is_kiro_claude_acp(p) and p["cwd"] == ws]
        c.ok(not kc_in_bot, "no `kiro-claude acp` process ran in the Bot workspace", json.dumps(kc_in_bot))
        kc_turn = [p["pid"] for p in by_pid.values() if is_kiro_claude_acp(p) and p["t"] >= t0]
        info(f"kiro-claude acp processes first seen during the turn (any cwd): {kc_turn}")
        info(f"bridge pids={sorted(bridge_pids)} children=" + json.dumps(
            [[k["pid"], k["exe"], sanitize_argv(k["argv"][:3])[:120]] for k in kids]))
        for p in [by_pid[b["ppid"]] for b in sid_bridges if b["ppid"] in by_pid] + sid_bridges + sid_kids:
            info(f"ps pid={p['pid']} ppid={p['ppid']} exe={p['exe']} cwd={p['cwd']} "
                 f"CLAUDE_CODE_EXECUTABLE={'set' if p['cce'] else 'unset'} entrypoint={p['entrypoint'] or '-'} argv={sanitize_argv(p['argv'])[:400]}")

        # gateway log lines written during the turn
        bridge_lines = [ln for ln in new_log.splitlines() if f"claude-acp via {adapter}" in ln and f"sessionId={sid}" in ln]
        c.ok(bool(bridge_lines), "gateway.log (Bot create → reply): `claude-acp via <adapter>` session lines for <sid>", f"{len(new_log)} new bytes")
        kas_lines = [redact_line(ln) for ln in new_log.splitlines() if KAS_LOG.search(ln)]
        c.ok(not kas_lines, "gateway.log (Bot create → reply): no KAS / --agent-engine v3 route", json.dumps(kas_lines[:3]))
        info(f"gateway.log (Bot create → reply): {len(new_log.splitlines())} lines, {len(bridge_lines)} bridge lines for sid")

        # Claude's own transcript
        hits = transcripts_holding(want)
        tpath = os.path.join(os.path.dirname(hits[0]), f"{sid}.jsonl") if hits else ""
        c.ok(len(hits) == 1 and os.path.basename(hits[0]) == f"{sid}.jsonl" and hits[0].startswith(os.path.join(HOME, ".claude") + os.sep),
             "exactly one Claude transcript under the fake HOME holds the answer: <sid>.jsonl", json.dumps(hits))
        if hits:
            t = read_transcript(hits[0])
            ans = [(txt, ts) for txt, ts in t["texts"] if want in txt]
            real_models = sorted(m for m in t["models"] if not m.startswith("<"))
            c.ok(ans and all(ts is not None and ts >= t0 - 5 for _, ts in ans), "the answer record was written during this turn",
                 json.dumps([ts for _, ts in ans]))
            c.ok(any(txt.strip() == reply.strip() for txt, _ in ans), "transcript answer text = SSE reply")
            c.ok(real_models and all("haiku" in m for m in real_models), "transcript models are all haiku", json.dumps(real_models))
            c.ok(t["cwds"] == {ws}, "transcript cwd = the Bot workspace", json.dumps(sorted(t["cwds"])))
            vnum = (re.match(r"\s*(\S+)", version) or [None, ""])[1]
            c.ok(bool(vnum) and t["versions"] == {vnum}, "transcript version = crew.json claude --version", json.dumps(sorted(t["versions"])))
            info(f"transcript={hits[0]} versions={sorted(t['versions'])} models={real_models} entrypoints={sorted(t['entrypoints'])} "
                 f"(kiro-claude sets sdk-ts too)")
        kc_files = kiro_claude_sessions_naming(sid, [want, code_, nonce], t_create)
        c.ok(not kc_files, "no kiro-claude session file (~/.kiro/sessions/cli) names <sid> or the nonce", json.dumps(kc_files))
        real_home = pwd.getpwuid(os.getuid()).pw_dir
        real_home_hit = glob.glob(os.path.join(real_home, ".claude", "projects", "*", f"{sid}.jsonl")) if real_home != HOME else []
        c.ok(not real_home_hit, "nothing written to the real ~/.claude for this session")
        _, hist = gw.call("GET", f"/api/chat/slots/{slot}")
        msgs = hist.get("messages", []) if isinstance(hist, dict) else []
        last = next((m for m in reversed(msgs) if m.get("role") == "assistant"), {})
        ts_ = ((last.get("meta") or {}).get("turn_stats") or {})
        c.ok(want in str(last.get("content")), "DM history (GET /api/chat/slots/{slot}) holds the reply", json.dumps(last)[:300])
        info(f"turn_stats model={ts_.get('model')!r} elapsed_ms={ts_.get('elapsed_ms')} sid={sid}")
    finally:
        if not a.keep_bot:
            code, d = gw.call("DELETE", f"/api/agents/{bot}")
            c.ok(code == 200, f"DELETE /api/agents/{bot}", f"{code} {json.dumps(d)[:200]}")


def leftover_procs(state: dict) -> list[dict]:
    """Processes of this HOME, except this script's ancestors and plain helpers of its own
    terminal session (the shell, a `| tee`). The gateway is started detached (setsid), so all it
    spawned is in another session; an agent process is never excused, whatever its session."""
    mine, my_sid = ancestors(os.getpid()), os.getsid(0)
    agentish = re.compile(r"kiro-claude|claude-agent-acp|kirocrew|stream-json|kiro_crew")
    return [p for p in home_procs(state) if p["pid"] not in mine
            and (p["sid"] != my_sid or agentish.search(" ".join(p["argv"])))]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--port", type=int, help="gateway port (default: crew status)")
    ap.add_argument("--start", action="store_true", help="start the gateway on a free port and stop it afterwards")
    ap.add_argument("--start-env", action="append", default=[], help="extra --env K=V for crew start")
    ap.add_argument("--model", default="haiku", help="the Bot's model pin (default: the bridge's haiku alias)")
    ap.add_argument("--timeout", type=float, default=300)
    ap.add_argument("--keep-bot", action="store_true", help="do not delete the Bot afterwards")
    a = ap.parse_args()
    if "haiku" not in a.model:
        say("FAIL", f"--model {a.model!r} is not a haiku model; C16 pins the Bot to haiku")
        return 1
    try:
        state = json.load(open(os.path.join(CS, "crew.json")))
    except (OSError, ValueError) as e:
        say("FAIL", f"{CS}/crew.json unreadable ({type(e).__name__}); run crew setup (setup.sh --stage C)")
        return 1
    if (state.get("members") or {}).get("backend") != "claude":
        say("FAIL", f"crew.json members.backend = {(state.get('members') or {}).get('backend')!r}, not claude (setup --members claude)")
        return 1

    started = False
    c = Check()
    sampler = Sampler(state)
    sampler.start()  # before `crew start`: the KAS/v3 watch covers the gateway's boot too
    try:
        if a.start:
            st = crew_status()
            if st.get("running"):
                info(f"a gateway already runs on port {st.get('port')}; using it (not stopping it)")
                a.port = a.port or st.get("port")
            else:
                a.port = a.port or free_port()
                envs = []
                for kv in DEFAULT_START_ENV + a.start_env:
                    envs += ["--env", kv]
                r = crew("start", "--port", str(a.port), *envs, timeout=240)
                started = r.returncode == 0
                if not c.ok(started, "crew start", f"exited {r.returncode}: {(r.stderr or r.stdout)[-400:]}"):
                    return c.done()
                info(f"gateway started on port {a.port} with {' '.join(DEFAULT_START_ENV + a.start_env)}")
        port = a.port or crew_status().get("port")
        if not c.ok(bool(port), "a gateway runs", "pass --start, or run kiro-claude crew start"):
            return c.done()
        run_check(a, Gateway(int(port)), state, sampler, c)
    except Exception as e:  # noqa: BLE001 - one FAIL line, not a traceback
        c.ok(False, "check ran to the end", f"{type(e).__name__}: {str(e)[:300]}")
    finally:
        if started:
            r = crew("stop", timeout=180)
            left = []
            for _ in range(60):
                left = leftover_procs(state)
                if not left:
                    break
                time.sleep(0.5)
            c.ok(r.returncode == 0 and not left, "cleanup: crew stop, no process of this HOME left",
                 f"crew stop exited {r.returncode}; left: " + json.dumps([[p["pid"], sanitize_argv(p["argv"])[:120]] for p in left])[:600])
            info(f"cleanup: {r.stdout.strip()[:200]}")
        sampler.stop_ev.set()
        sampler.join(timeout=5)
        with sampler.lock:
            images = list(sampler.images.values())
        kas = [[p["pid"], sanitize_argv(p["argv"])[:160]] for p in images if is_kas(p)]
        window = "crew start … crew stop" if started else "the check"
        info(f"process watch: {len(images)} images of HOME over {sampler.passes} polls (30 ms) during {window}")
        c.ok(sampler.passes > 0 and not kas, f"no KAS / --agent-engine v3 process image during {window}", json.dumps(kas)[:600])
    return c.done()

if __name__ == "__main__":
    sys.exit(main())

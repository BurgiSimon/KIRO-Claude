#!/usr/bin/env python3
"""KiroCrew gateway pipeline steps C1-C14 of 08-kirocrew-integration §5.3 (stage C) and their
fixed-word variant for stage B (§5.2 item 3). Run it through pipeline.sh.

  kc_pipeline.py [--stage B|C | --real] [--port N] [--start-env K=V]... [C1 C4 ...]

Preconditions: env.sh sourced; `crew setup` done (setup.sh); the gateway started with
`kiro-claude crew start` (stage B: with --env FAKE_CLAUDE_SCRIPT=… --env FAKE_CLAUDE_LOG=$E2E/fake-claude.jsonl;
pass the same pairs with --start-env so C12 can restart it identically).

Stage B sends fixed words that fake-script.json answers (PING → PONG, RUN-ECHO → a Bash call,
LEARN → mcp__kirocrew-core__learn_add, anything else → OK); memory, cron, spawn and the task only
check that the turn succeeded. Stage C sends nonce instructions to the real model (haiku) and
checks the nonces. Prints `PASS|FAIL|SKIP <id> <evidence>`; exits 1 on any FAIL.
stdlib only; KiroCrew is reached over HTTP and through `kiro-claude crew exec`.
"""
from __future__ import annotations

import argparse
import fcntl
import glob
import http.cookiejar
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

HOME = os.environ["HOME"]
E2E = os.environ["E2E"]
CS = os.environ.get("CS", os.path.join(HOME, ".local/share/kiro-claude/crew"))
KC_HOME = os.path.join(HOME, ".kiro", "crew")
SESS_DIR = os.path.join(HOME, ".kiro", "sessions", "cli")
CREW = [os.environ.get("KC_NODE", "node"), os.environ["KC_ENTRY"], "crew"]
SKILL_VIEW = re.compile(r"^kirocrew-skill-view-[0-9a-f]{24}$")

RESULTS: list[tuple[str, str]] = []


def report(sid: str, status: str, evidence: str) -> None:
    evidence = " ".join(str(evidence).split())
    RESULTS.append((sid, status))
    print(f"{status} {sid} {evidence[:900]}", flush=True)


class Check:
    def __init__(self, sid: str):
        self.sid, self.bad, self.good, self.skips = sid, [], [], []

    def ok(self, cond, what: str, detail: str = "") -> bool:
        (self.good if cond else self.bad).append(what if cond else f"{what}{(': ' + detail) if detail else ''}")
        return bool(cond)

    def done(self, extra: str = "") -> None:
        if self.bad:
            report(self.sid, "FAIL", "; ".join(self.bad) + (f" | ok: {', '.join(self.good)}" if self.good else ""))
        else:
            report(self.sid, "PASS", ", ".join(self.good) + (f"; {extra}" if extra else ""))


# ── processes ────────────────────────────────────────────────────────────────

def acp_procs() -> list[dict]:
    """Live `kiro-claude … acp` processes of this HOME: pid, argv, cwd."""
    out = []
    for d in glob.glob("/proc/[0-9]*"):
        try:
            with open(f"{d}/cmdline", "rb") as f:
                argv = [a.decode("utf-8", "replace") for a in f.read().split(b"\0") if a]
            if len(argv) < 3 or "acp" not in argv or not any(a.endswith("kiro-claude.js") or a.endswith("/kiro-claude") for a in argv[:2]):
                continue
            if "--help" in argv or "-h" in argv:
                continue  # KiroCrew's `acp --help` probe before each spawn, not a session process
            with open(f"{d}/environ", "rb") as f:
                env = f.read().split(b"\0")
            if f"HOME={HOME}".encode() not in env:
                continue
            out.append({"pid": int(d.rsplit("/", 1)[1]), "argv": argv, "cwd": os.readlink(f"{d}/cwd"),
                        "agent": argv[argv.index("--agent") + 1] if "--agent" in argv[:-1] else None})
        except (OSError, ValueError):
            continue
    return out


class Sampler(threading.Thread):
    """Samples acp processes every 0.2 s so short-lived spawns (cron, subagent, helpers) are seen."""

    def __init__(self):
        super().__init__(daemon=True)
        self.seen: dict[int, dict] = {}
        self.stop_ev = threading.Event()

    def run(self) -> None:
        while not self.stop_ev.is_set():
            for p in acp_procs():
                self.seen.setdefault(p["pid"], p)
            self.stop_ev.wait(0.2)


# ── HTTP ─────────────────────────────────────────────────────────────────────

class Gateway:
    def __init__(self, port: int):
        self.port = port
        self.base = f"http://127.0.0.1:{port}"
        self.login()

    def login(self) -> None:
        """Exchange the stored READY token (crew start's run/token) for the dashboard cookie.
        Retries, then falls back to a fresh link token from `crew open --print`."""
        last = None
        for attempt in range(6):
            token = open(os.path.join(CS, "run", "token")).read().strip()
            if attempt >= 3:
                r = crew("open", "--print", "--ttl", "2h", timeout=120)
                m = re.search(r"[?&]token=([^\s&]+)", r.stdout)
                if m:
                    token = m.group(1)
            self.op = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
            try:
                self.op.open(f"{self.base}/api/status?token={token}", timeout=20).read()
                return
            except (urllib.error.URLError, OSError) as e:
                last = e
                time.sleep(2)
        raise RuntimeError(f"dashboard login failed: {last}")

    def call(self, method: str, path: str, body=None, timeout: float = 60):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method, headers={"Content-Type": "application/json"})
        try:
            with self.op.open(req, timeout=timeout) as r:
                raw = r.read().decode("utf-8", "replace")
                code = r.status
        except urllib.error.HTTPError as e:
            raw, code = e.read().decode("utf-8", "replace"), e.code
        try:
            return code, json.loads(raw)
        except ValueError:
            return code, raw

    def chat(self, message: str, slot: str | None = None, timeout: float = 300) -> dict:
        """One dashboard turn over SSE; approves a pending tool approval if the gateway raises one."""
        if not slot:
            code, created = self.call("POST", "/api/chat/slots", {})
            slot = created["key"]
        out = {"slot": slot, "reply": None, "events": [], "approved": 0, "error": None}
        stop = threading.Event()

        def approver():
            while not stop.wait(0.5):
                try:
                    c, d = self.call("GET", f"/api/chat/slots/{slot}", timeout=10)
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
                        out["error"] = ev.get("content")
        except (OSError, urllib.error.URLError) as e:
            out["error"] = f"{type(e).__name__}: {e}"
        finally:
            stop.set()
        out["secs"] = round(time.time() - t0, 2)
        return out

    def history(self, slot: str) -> list[dict]:
        c, d = self.call("GET", f"/api/chat/slots/{slot}")
        return d.get("messages", []) if isinstance(d, dict) else []


# ── helpers ──────────────────────────────────────────────────────────────────

def crew(*args: str, timeout: float = 300, env_extra: dict | None = None) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    if env_extra:
        env.update(env_extra)
    return subprocess.run([*CREW, *args], capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL, env=env)


def fake_log(path: str) -> list[dict]:
    out = []
    if path and os.path.exists(path):
        for line in open(path, encoding="utf-8", errors="replace"):
            try:
                out.append(json.loads(line))
            except ValueError:
                pass
    return out


def user_text(rec: dict) -> str:
    line = rec.get("line") or {}
    if line.get("type") != "user":
        return ""
    c = (line.get("message") or {}).get("content")
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return "".join(b.get("text", "") for b in c if isinstance(b, dict))
    return ""


def fake_pids_for(log: list[dict], needle: str) -> list[int]:
    return [r["pid"] for r in log if r.get("event") == "stdin" and needle in user_text(r)]


def file_lines(p: str) -> int:
    try:
        with open(p, "rb") as f:
            return sum(1 for _ in f)
    except OSError:
        return 0


def new_session_files(since: float) -> list[str]:
    out = []
    for p in glob.glob(os.path.join(SESS_DIR, "*.json")):
        if os.path.getmtime(p) >= since:
            out.append(p)
    return out


def jsonl_kinds(p: str) -> list[str]:
    kinds = []
    try:
        for line in open(p, encoding="utf-8"):
            try:
                kinds.append(json.loads(line).get("kind"))
            except ValueError:
                kinds.append("<bad>")
    except OSError:
        pass
    return kinds


# ── pipeline ─────────────────────────────────────────────────────────────────

class Pipeline:
    def __init__(self, a):
        self.a = a
        self.real = a.real
        self.n = os.urandom(6).hex() if self.real else "B"
        self.code_word = f"KC-{self.n}" if self.real else "KC-WORD"
        self.fake_log_path = a.fake_log
        self.sampler = Sampler()
        self.sampler.start()
        self.slot = None
        self.main_pids: set[int] = set()
        self.port = a.port or self.status().get("port")
        self.gw = Gateway(self.port)

    def status(self) -> dict:
        r = crew("status", "--json", timeout=120)
        try:
            return json.loads(r.stdout)
        except ValueError:
            return {"_rc": r.returncode, "_out": r.stdout[-300:], "_err": r.stderr[-300:]}

    def msg(self, stage_b: str, stage_c: str) -> str:
        return stage_c if self.real else stage_b

    def flog(self) -> list[dict]:
        return fake_log(self.fake_log_path) if not self.real else []

    # C1
    def c1(self):
        c = Check("C1")
        st = self.status()
        pre = st.get("prerequisite") or {}
        c.ok(st.get("running") is True and st.get("ready") is True, "crew status running+ready", json.dumps(st)[:300])
        code, d = self.gw.call("GET", "/api/kiro-prerequisite")
        d = d if isinstance(d, dict) else {}
        c.ok(code == 200 and d.get("installed") and d.get("authenticated") and d.get("ready"), "/api/kiro-prerequisite installed+authenticated+ready",
             json.dumps({k: d.get(k) for k in ("installed", "authenticated", "ready", "repair_required")}))
        c.ok(not d.get("missing_agent_specs") and not d.get("rejected_agent_specs"), "no missing/rejected agent specs",
             json.dumps({k: d.get(k) for k in ("missing_agent_specs", "rejected_agent_specs")})[:300])
        err = ""
        try:
            err = open(os.path.join(CS, "run", "gateway.err"), encoding="utf-8", errors="replace").read()
        except OSError:
            pass
        c.ok("outdated" not in err, "gateway.err has no 'outdated'")
        code, ab = self.gw.call("GET", "/api/acp-backends")
        blob = json.dumps(ab)
        c.ok(code == 200 and isinstance(ab, (dict, list)), "GET /api/acp-backends 200", f"{code} {blob[:200]}")
        rows = {r.get("id"): r for r in ((ab or {}).get("backends") or []) if isinstance(r, dict)} if isinstance(ab, dict) else {}
        inst = lambda r: (r or {}).get("installed") is True or str((r or {}).get("installed")).lower() == "installed"
        c.ok(inst(rows.get("kiro")) and inst(rows.get("claude")), "/api/acp-backends: kiro (main) and claude (members) installed",
             json.dumps({k: (rows.get(k) or {}).get("installed") for k in ("kiro", "claude", "kas")}))
        dj = crew("doctor", "--json", timeout=300)
        try:
            drows = {r.get("id"): r for r in json.loads(dj.stdout).get("rows", [])}
        except ValueError:
            drows = {}
        c.ok((drows.get("D11") or {}).get("status") == "ok", "crew doctor D11 (gateway: prerequisite ready, main = kiro, members = claude)",
             json.dumps(drows.get("D11"))[:300])
        c.ok((drows.get("D12") or {}).get("status") == "ok", "crew doctor D12 (Kiro Crew's own doctor rows)", json.dumps(drows.get("D12"))[:300])
        _ = pre
        c.done()

    # C2
    def c2(self):
        c = Check("C2")
        code, d = self.gw.call("GET", "/api/models")
        ids = [m.get("model_id") for m in d] if isinstance(d, list) else [m.get("model_id") for m in (d.get("models") or [])] if isinstance(d, dict) else []
        c.ok(code == 200, "GET /api/models 200", str(code))
        c.ok("claude-haiku-5.5" in ids, "contains claude-haiku-5.5", json.dumps(ids)[:200])
        c.done(f"{len(ids)} models")

    # C3
    def c3(self):
        c = Check("C3")
        m = self.msg("PING", f"Reply with exactly: PONG-{self.n}")
        envs = []
        for kv in self.a.start_env:
            envs += ["--env", kv]
        t0 = time.time()
        r = crew("exec", *envs, "--", "chat", "-m", m, timeout=180)
        dt = time.time() - t0
        want = "PONG" if not self.real else f"PONG-{self.n}"
        c.ok(r.returncode == 0, "exit 0", f"rc={r.returncode} err={r.stderr[-300:]}")
        c.ok(want in r.stdout, f"stdout contains {want}", repr(r.stdout[-200:]))
        c.ok(dt < 90, f"{dt:.1f}s < 90s")
        c.done()

    # C4
    def c4(self):
        c = Check("C4")
        t0 = time.time()
        r = self.gw.chat(self.msg(f"Remember the code word {self.code_word}. Reply with exactly: OK",
                                  f"Remember the code word {self.code_word}. Reply with exactly: OK"))
        self.slot = r["slot"]
        c.ok(r["reply"] is not None and "OK" in r["reply"], "reply contains OK", json.dumps(r)[:300])
        time.sleep(0.5)
        files = new_session_files(t0)
        good = []
        for f in files:
            try:
                env = json.load(open(f))
            except (OSError, ValueError):
                continue
            stem = os.path.basename(f)[:-5]
            jl = f[:-5] + ".jsonl"
            if env.get("session_id") == stem and re.match(r"^[0-9a-f-]{36}$", stem) and os.path.exists(jl) and os.path.getsize(jl) >= 10 and "Prompt" in jsonl_kinds(jl):
                if self.code_word in open(jl, encoding="utf-8", errors="replace").read():
                    good.append(stem)
        c.ok(bool(good), "KC-FS-02/03 <uuid>.json + .jsonl (≥10 B, Prompt) for the slot", f"{len(files)} new session files")
        procs = acp_procs()
        main = [p for p in procs if p["cwd"] == os.path.join(KC_HOME, "workspace")]
        self.main_pids = {p["pid"] for p in main}
        c.ok(main and all(p["argv"][-4:-2] == ["--agent-engine", "v2"] and SKILL_VIEW.match(p["agent"] or "") for p in main),
             "C1-spawn: ps shows acp --agent-engine v2 --agent kirocrew-skill-view-<24hex>", json.dumps([p["argv"][-5:] for p in main])[:300])
        c.done(f"slot={self.slot} session={good[:1]}")

    # C5
    def c5(self):
        c = Check("C5")
        if not self.slot:
            return report("C5", "SKIP", "no slot from C4")
        before = {p["pid"] for p in acp_procs() if p["cwd"] == os.path.join(KC_HOME, "workspace")}
        r = self.gw.chat(self.msg("What is the code word? PING", "What is the code word? Reply with only the word."), self.slot)
        if self.real:
            c.ok(r["reply"] and self.code_word.lower() in r["reply"].lower(), f"reply contains {self.code_word}", repr(r["reply"]))
        else:
            c.ok(r["reply"] == "PONG", "reply PONG", repr(r["reply"]))
            log = self.flog()
            p1, p2 = fake_pids_for(log, self.code_word), fake_pids_for(log, "What is the code word? PING")
            c.ok(p1 and p2 and p1[-1] == p2[-1], "turn 2 went to the same Claude child as turn 1 (persistent session)", f"{p1[-1:]} vs {p2[-1:]}")
        after = {p["pid"] for p in acp_procs() if p["cwd"] == os.path.join(KC_HOME, "workspace")}
        c.ok(before and before <= after and self.main_pids <= after, "same kiro-claude pid(s)", f"{sorted(self.main_pids)} → {sorted(after)}")
        gl = open(os.path.join(KC_HOME, "gateway.log"), encoding="utf-8", errors="replace").read()
        c.ok("deliberate logout teardown" not in gl, "no 'deliberate logout teardown' in gateway.log (KC-AUTH-03)")
        c.done()

    # C6
    def c6(self):
        c = Check("C6")
        audit = os.path.join(KC_HOME, "audit.log")
        n0 = file_lines(audit)
        word = "kc-e2e" if not self.real else f"SH-{self.n}"
        r = self.gw.chat(self.msg("Please RUN-ECHO", f"Use your shell tool to run: echo SH-{self.n} . Then reply DONE."), self.slot)
        c.ok(r["reply"] and "DONE" in r["reply"], "reply DONE", json.dumps(r)[:200])
        tools = [m for m in self.gw.history(self.slot) if m.get("role") == "tool"]
        outs = [((m.get("meta") or {}).get("output") or "") for m in tools]
        c.ok(any(word in o for o in outs), f"slot history has a tool message with output {word}", json.dumps(outs[-2:])[:200])
        c.ok(any((m.get("meta") or {}).get("tool_name") == "shell" for m in tools), "tool_name shell")
        time.sleep(0.5)
        lines = open(audit, encoding="utf-8", errors="replace").read().splitlines()[n0:] if os.path.exists(audit) else []
        c.ok(any(" BASH: " in l and word in l for l in lines), "KC-SPEC-05 audit.log gained a BASH line (postToolUse hook)", f"{len(lines)} new lines")
        c.done(f"approvals answered via API: {r['approved']}")

    # C7
    def c7(self):
        c = Check("C7")
        r = self.gw.chat(self.msg("Save a lesson: LEARN", f"Call the learn_add tool to save this lesson: kc-e2e lesson {self.n}. Then reply SAVED."), self.slot)
        c.ok(r["reply"] and "SAVED" in r["reply"], "turn succeeded (reply SAVED)", json.dumps(r)[:200])
        tools = [m for m in self.gw.history(self.slot) if m.get("role") == "tool"]
        last = tools[-1] if tools else {}
        meta = last.get("meta") or {}
        c.ok("learn_add" in json.dumps(meta), "tool message for learn_add", json.dumps(meta)[:200])
        if self.real:
            lr = crew("exec", "--", "learn", "list", timeout=120)
            c.ok(self.n in lr.stdout, "learn list contains the nonce (KC-ENV-02, SPEC-04)", lr.stdout[-200:])
        else:
            c.ok(meta.get("done") is True and "error" not in json.dumps(meta).lower(), "learn_add ran without error (fake result)", json.dumps(meta)[:200])
            self.c7_lesson()
        c.done()

    def c7_lesson(self):
        """Stage B KC-ENV-02 / KC-SPEC-04 for real: fake-claude only simulates MCP calls, so do what
        Claude would do with the main session's --mcp-config: start the kirocrew-core server with the
        live Claude child's own environment plus the entry's env (which must carry the gateway's
        per-session KIROCREW_STUB_SESSION_TOKEN), call learn_add over MCP stdio, then read it back
        with `kirocrew learn list`."""
        c = Check("C7-lesson")
        ws_dir = os.path.join(KC_HOME, "workspace")
        starts = [r for r in self.flog() if r.get("event") == "start" and "-p" in (r.get("argv") or []) and r.get("cwd") == ws_dir]
        live = [r for r in starts if os.path.exists(f"/proc/{r['pid']}")]
        if not live:
            return report("C7-lesson", "FAIL", f"no live main-session Claude child ({len(starts)} main starts in the fake log)")
        st = live[-1]
        argv = st["argv"]
        cfg = {}
        for i, a_ in enumerate(argv[:-1]):
            if a_ == "--mcp-config":
                v = argv[i + 1]
                try:
                    cfg.update((json.loads(v if v.strip().startswith("{") else open(v).read()).get("mcpServers")) or {})
                except (OSError, ValueError) as e:
                    c.ok(False, "main session --mcp-config readable", str(e))
        core = cfg.get("kirocrew-core") or {}
        tok = (core.get("env") or {}).get("KIROCREW_STUB_SESSION_TOKEN")
        c.ok(bool(core.get("command")) and bool(tok), "KC-ENV-02 main session --mcp-config has kirocrew-core with a KIROCREW_STUB_SESSION_TOKEN",
             json.dumps({"command": core.get("command"), "args": core.get("args"), "env_keys": sorted((core.get("env") or {}).keys())})[:300])
        if not core.get("command"):
            return c.done()
        try:
            raw = open(f"/proc/{st['pid']}/environ", "rb").read().split(b"\0")
            env = dict(x.decode("utf-8", "replace").split("=", 1) for x in raw if b"=" in x)
        except OSError as e:
            return report("C7-lesson", "FAIL", f"cannot read the Claude child's environment: {e}")
        env.update(core.get("env") or {})
        lesson = f"kc-e2e lesson {os.urandom(4).hex()}"
        p = subprocess.Popen([core["command"], *(core.get("args") or [])], cwd=st.get("cwd") or ws_dir, env=env,
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=open(os.path.join(E2E, "logs", "c7-mcp-core.stderr"), "wb"), text=True)
        def rpc(i, method, params, timeout=60.0):
            p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": i, "method": method, "params": params}) + "\n")
            p.stdin.flush()
            t_end = time.time() + timeout
            while time.time() < t_end:
                line = p.stdout.readline()
                if not line:
                    return None
                try:
                    m = json.loads(line)
                except ValueError:
                    continue
                if m.get("id") == i:
                    return m
            return None
        try:
            init = rpc(1, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "claude-code", "version": "2.1.318"}})
            c.ok(init is not None and "result" in init, "kirocrew-core MCP initialize", json.dumps(init)[:200])
            p.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
            p.stdin.flush()
            tl = rpc(2, "tools/list", {}) or {}
            tools = {t.get("name"): t for t in ((tl.get("result") or {}).get("tools") or [])}
            c.ok("learn_add" in tools, "kirocrew-core lists learn_add", json.dumps(sorted(tools))[:300])
            props = ((tools.get("learn_add") or {}).get("inputSchema") or {}).get("properties") or {}
            key = next((k for k in ("rule", "lesson", "text") if k in props), None)
            args = {key: lesson} if key else {}
            if "category" in props:
                args["category"] = "knowledge"
            res = rpc(3, "tools/call", {"name": "learn_add", "arguments": args}, timeout=90) or {}
            r = res.get("result") or {}
            text = " ".join(str(b.get("text", "")) for b in r.get("content") or [] if isinstance(b, dict))
            c.ok("result" in res and not r.get("isError") and not text.lstrip().lower().startswith("error"),
                 f"tools/call learn_add {json.dumps(sorted(args))} succeeded (stub token accepted)", json.dumps(res)[:300])
        finally:
            try:
                p.stdin.close()
                p.wait(10)
            except (OSError, subprocess.TimeoutExpired):
                p.kill()
        lr = crew("exec", "--", "learn", "list", timeout=120)
        c.ok(lesson in lr.stdout, "kirocrew learn list contains the lesson", (lr.stdout + lr.stderr)[-200:])
        c.done()

    # C8
    def c8(self):
        c = Check("C8")
        m = self.msg("Reply with exactly PING", f"Reply with exactly CRON-{self.n}")
        code, d = self.gw.call("POST", "/api/crons", {"name": f"kc-{self.n}-{int(time.time())}", "every": 3600, "message": m})
        cid = (d or {}).get("id") if isinstance(d, dict) else None
        c.ok(code in (200, 201) and cid, "POST /api/crons", f"{code} {json.dumps(d)[:200]}")
        if cid:
            code, d = self.gw.call("POST", f"/api/crons/{cid}/run", {})
            c.ok(code in (200, 202), "POST /api/crons/<id>/run", f"{code} {json.dumps(d)[:200]}")
            hist = None
            t0 = time.time()
            while time.time() - t0 < 120:
                code, h = self.gw.call("GET", f"/api/crons/{cid}/history")
                rows = h if isinstance(h, list) else (h.get("history") or h.get("runs") or []) if isinstance(h, dict) else []
                done = [x for x in rows if isinstance(x, dict) and x.get("status") not in (None, "running", "pending", "queued")]
                if done:
                    hist = done[-1]
                    break
                time.sleep(2)
            want = "PONG" if not self.real else f"CRON-{self.n}"
            c.ok(hist and hist.get("status") == "success", "history status success (≤120 s)", json.dumps(hist)[:300])
            c.ok(hist and want in json.dumps(hist), f"summary contains {want}", json.dumps(hist)[:300])
            self.gw.call("DELETE", f"/api/crons/{cid}")
            cron_cwds = [p["cwd"] for p in self.sampler.seen.values() if "/cron_" in p["cwd"]]
            if not self.real:
                cron_cwds += [r.get("cwd") for r in self.flog() if r.get("event") == "start" and "/cron_" in str(r.get("cwd"))]
            c.ok(bool(cron_cwds), "a session in cwd …/cron_<id>", json.dumps(sorted(set(cron_cwds)))[:200])
        c.done()

    # C9
    def c9(self):
        c = Check("C9")
        hb = os.path.join(KC_HOME, "workspace", "HEARTBEAT.md")
        line = self.msg(f"- Reply with exactly PING", f"- Reply with exactly HB-{self.n}")
        code, n0 = self.gw.call("GET", "/api/notifications")
        lock = os.path.join(os.path.dirname(hb), ".HEARTBEAT.md.lock")
        with open(hb, "a", encoding="utf-8") as f:
            try:
                fcntl.flock(f, fcntl.LOCK_EX)
            except OSError:
                pass
            f.write(line + "\n")
        _ = lock
        t0 = time.time()
        gone = False
        while time.time() - t0 < 180:
            if line not in open(hb, encoding="utf-8").read():
                gone = True
                break
            time.sleep(3)
        c.ok(gone, f"line consumed from HEARTBEAT.md in {time.time() - t0:.0f}s (≤180 s)")
        want = "PONG" if not self.real else f"HB-{self.n}"
        delivered = ""
        t1 = time.time()
        while gone and time.time() - t1 < 60 and not delivered:
            code, nn = self.gw.call("GET", "/api/notifications")
            if want in json.dumps(nn):
                delivered = "notifications"
                break
            code, slots = self.gw.call("GET", "/api/chat/slots")
            for s in (slots if isinstance(slots, list) else (slots.get("slots") or []) if isinstance(slots, dict) else []):
                key = s.get("key") if isinstance(s, dict) else None
                if key and want in json.dumps(self.gw.history(key)):
                    delivered = f"slot {key}"
                    break
            time.sleep(3)
        if not delivered and not self.real:
            if any("PING" in user_text(r) and "HEARTBEAT" not in user_text(r)[:0] for r in self.flog() if r.get("event") == "stdin" and "Reply with exactly PING" in user_text(r)):
                delivered = ""
        c.ok(bool(delivered), "result delivered to the dashboard", delivered or "not found in /api/notifications or slots")
        c.done(delivered)

    # C10
    def c10(self):
        c = Check("C10")
        m = self.msg("PING", f"Reply with exactly SUB-{self.n}")
        envs = []
        for kv in self.a.start_env:
            envs += ["--env", kv]
        t0 = time.time()
        r = crew("exec", *envs, "--", "spawn", "--port", str(self.port), "run", m, timeout=300)
        want = "PONG" if not self.real else f"SUB-{self.n}"
        c.ok(r.returncode == 0, "spawn run exit 0", f"rc={r.returncode} {r.stderr[-300:]}")
        c.ok(want in r.stdout, f"stdout contains {want}", repr(r.stdout[-300:]))
        cwds = [p["cwd"] for p in self.sampler.seen.values() if "/subagent_" in p["cwd"]]
        if not self.real:
            cwds += [str(x.get("cwd")) for x in self.flog() if x.get("event") == "start" and "/subagent_" in str(x.get("cwd"))]
        c.ok(bool(cwds), "a session in cwd …/subagent_<id>", json.dumps(sorted(set(cwds)))[:200])
        c.done(f"{time.time() - t0:.1f}s")

    # C11
    def c11(self):
        c = Check("C11")
        start_log = len(self.flog())
        r = self.gw.chat("/compact", self.slot)
        c.ok(r["error"] is None, "/compact turn ok", json.dumps(r)[:200])
        time.sleep(1.0)
        if not self.real:
            log = self.flog()[start_log:]
            got = [x for x in log if x.get("event") == "stdin" and user_text(x).strip() == "/compact"]
            c.ok(bool(got), "Claude received /compact (kiro-claude's local compaction path)", str(len(got)))
        jls = [f[:-1] for f in glob.glob(os.path.join(SESS_DIR, "*.jsonl")) if self.code_word in open(f, encoding="utf-8", errors="replace").read()]
        kinds = [k for f in glob.glob(os.path.join(SESS_DIR, "*.jsonl")) if self.code_word in open(f, encoding="utf-8", errors="replace").read() for k in jsonl_kinds(f)]
        c.ok("Compaction" in kinds, "Compaction record in the slot's <sid>.jsonl (compaction/status completed)", repr(kinds[-6:]))
        r2 = self.gw.chat(self.msg("What is the code word? PING", "What is the code word? Reply with only the word."), self.slot)
        if self.real:
            c.ok(r2["reply"] and self.code_word.lower() in r2["reply"].lower(), f"reply still contains {self.code_word}", repr(r2["reply"]))
        else:
            c.ok(r2["reply"] == "PONG", "turn after /compact succeeds", repr(r2["reply"]))
        _ = jls
        c.done()

    # C12
    def c12(self):
        c = Check("C12")
        r = crew("stop", timeout=120)
        c.ok(r.returncode == 0, "crew stop", (r.stdout + r.stderr)[-200:])
        args = ["start", "--port", str(self.port)]
        for kv in self.a.start_env:
            args += ["--env", kv]
        r = crew(*args, timeout=200)
        c.ok(r.returncode == 0, "crew start", (r.stdout + r.stderr)[-300:])
        self.gw = Gateway(self.port)
        start_log = len(self.flog())
        r2 = self.gw.chat(self.msg("After the restart: what is the code word? PING", "What is the code word? Reply with only the word."), self.slot)
        if self.real:
            c.ok(r2["reply"] and self.code_word.lower() in r2["reply"].lower(), f"reply contains {self.code_word}", repr(r2["reply"]))
        else:
            c.ok(r2["reply"] == "PONG", "reply PONG after restart", json.dumps(r2)[:200])
            log = self.flog()[start_log:]
            hist = [x for x in log if x.get("event") == "stdin" and "After the restart" in user_text(x)]
            resumed = [x for x in log if x.get("event") == "start" and "--resume" in (x.get("argv") or [])]
            replay = hist and self.code_word in user_text(hist[-1])
            c.ok(replay or resumed, "history reached the new Claude child (text replay or --resume)",
                 f"replay={bool(replay)} resume={len(resumed)}")
        c.done()

    # C13
    def c13(self):
        c = Check("C13")
        tdir = os.path.join(E2E, "task")
        os.makedirs(tdir, exist_ok=True)
        if not os.path.exists(os.path.join(tdir, ".git")):
            subprocess.run(["git", "init", "-q", tdir], check=False)
        spec = os.path.join(tdir, "TASK.md")
        with open(spec, "w") as f:
            f.write("# Two files\n\n1. Create the file a.txt containing exactly the single letter A.\n"
                    "2. Create the file b.txt containing exactly the single letter B.\n")
        code, d = self.gw.call("POST", "/api/taskrunner", {"spec": spec, "workspace_dir": tdir, "name": f"kc-{self.n}-{int(time.time())}",
                                                            "source": "dashboard", "auto_approve": True})
        tid = None
        if isinstance(d, dict):
            tid = d.get("task_id") or d.get("id") or (d.get("task") or {}).get("task_id")
        c.ok(code in (200, 201, 202) and tid, "POST /api/taskrunner", f"{code} {json.dumps(d)[:300]}")
        st = {}
        if tid:
            t0 = time.time()
            # KiroCrew 0.13.0 has no GET /api/taskrunner/<id> (only DELETE); the run is in GET /api/taskrunner .runs[]
            while time.time() - t0 < 300:
                code, lst = self.gw.call("GET", "/api/taskrunner")
                runs = (lst or {}).get("runs") or [] if isinstance(lst, dict) else []
                st = next((r for r in runs if r.get("task_id") == tid), {})
                if st.get("status") in ("completed", "failed", "cancelled", "paused"):
                    break
                time.sleep(3)
            s = st.get("status")
            details = st.get("task_details") or []
            c.ok(s == "completed", "status completed", f"status={s} error={st.get('error')!r}")
            c.ok(st.get("tasks", 0) >= 2 and st.get("completed", 0) == st.get("tasks") and st.get("failed", 1) == 0, "both steps recorded as done",
                 json.dumps({k: st.get(k) for k in ("tasks", "completed", "failed", "skipped")}) + " " +
                 json.dumps([(t.get("title"), t.get("status")) for t in details if isinstance(t, dict)])[:300])
            a_ok = open(os.path.join(tdir, "a.txt")).read().strip() == "A" if os.path.exists(os.path.join(tdir, "a.txt")) else False
            b_ok = open(os.path.join(tdir, "b.txt")).read().strip() == "B" if os.path.exists(os.path.join(tdir, "b.txt")) else False
            if self.real:
                c.ok(a_ok and b_ok, "a.txt=A and b.txt=B")
            else:
                # stage-B substitute: both step-execution prompts went through kiro-claude to Claude
                execs = [user_text(r) for r in self.flog() if r.get("event") == "stdin" and "Execute this task" in user_text(r)]
                c.ok(any("single letter A." in t for t in execs) and any("single letter B." in t for t in execs),
                     "both step prompts (a.txt, b.txt) reached Claude through kiro-claude", f"{len(execs)} step-execution prompts")
                report("C13-files", "SKIP", "fake-claude limitation: tool calls are simulated (Write/Bash never touch disk), so a.txt/b.txt cannot appear in stage B; stage C checks them")
        c.done()

    # C14
    def c14(self):
        c = Check("C14")
        code, d = self.gw.call("GET", "/api/skills")
        n = len(d) if isinstance(d, list) else len(d.get("skills") or []) if isinstance(d, dict) else 0
        c.ok(code == 200 and n > 0, f"GET /api/skills non-empty ({n})", str(code))
        seen = list(self.sampler.seen.values())
        main = [p for p in seen if p["cwd"] == os.path.join(KC_HOME, "workspace") or "/cron_" in p["cwd"] or "/subagent_" in p["cwd"]]
        bad = sorted({p["agent"] or "?" for p in main if not SKILL_VIEW.match(p["agent"] or "")})
        c.ok(main and not bad, "every main/cron/subagent spawn used a kirocrew-skill-view-* agent (KC-FS-01)",
             f"{len(main)} spawns; others: {bad}")
        c.done(f"{len(seen)} acp processes sampled; agents: {sorted({str(p['agent']) for p in seen})[:6]}")

    def spec_warnings(self):
        """KC-SPEC-02 side check: kiro-claude's ACP log (KIRO_CHAT_LOG_FILE) must not warn that the
        KiroCrew spec's tool_search is unavailable (it maps to Claude ToolSearch), and code/introspect/
        session/report are ignored at debug level only."""
        logs = glob.glob(os.path.join(KC_HOME, "scratch", "runtime-*", "kiro-log", "kiro-chat.log"))
        text = ""
        for p in logs:
            try:
                text += open(p, encoding="utf-8", errors="replace").read()
            except OSError:
                pass
        warn = sorted(set(re.findall(r"WARN acp\[[^\]]*\]: Tool '([a-z_@/-]+)' in tools is not available", text)))
        if not logs:
            return report("KC-SPEC-02-log", "SKIP", "no kiro-chat.log under scratch/runtime-*")
        if warn:
            report("KC-SPEC-02-log", "FAIL", f"ACP log WARNs that spec tools {warn} were ignored ({len(logs)} logs); "
                   "tool_search must map to ToolSearch and code/introspect/session/report be debug-only")
        else:
            report("KC-SPEC-02-log", "PASS", f"no 'not available' warnings in {len(logs)} ACP logs")


STEPS = ["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9", "C10", "C11", "C12", "C13", "C14"]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", default="B", choices=["B", "C"])
    ap.add_argument("--real", action="store_true")
    ap.add_argument("--port", type=int, default=None)
    ap.add_argument("--start-env", action="append", default=[])
    ap.add_argument("--fake-log", default=os.path.join(E2E, "fake-claude.jsonl"))
    ap.add_argument("only", nargs="*")
    a = ap.parse_args()
    a.real = a.real or a.stage == "C"
    try:
        p = Pipeline(a)
    except Exception as e:  # noqa: BLE001
        report("C0", "FAIL", f"gateway not reachable: {type(e).__name__}: {e}")
        return 1
    steps = a.only or STEPS
    for s in steps:
        fn = getattr(p, s.lower(), None)
        if fn is None:
            report(s, "FAIL", "unknown step")
            continue
        try:
            fn()
        except Exception as e:  # noqa: BLE001
            report(s, "FAIL", f"harness exception {type(e).__name__}: {e}")
    if not a.only:
        p.spec_warnings()
    p.sampler.stop_ev.set()
    return 1 if any(st == "FAIL" for _, st in RESULTS) else 0


if __name__ == "__main__":
    sys.exit(main())

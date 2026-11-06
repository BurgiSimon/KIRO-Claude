#!/usr/bin/env python3
"""ACP scenarios S1-S13 of 08-kirocrew-integration §5.2 against `kiro-claude acp` (stdlib only), plus
the §2 KC-* rows marked (B) that §5.2 does not name: S1-invalid (Guard A2 for an invalid spec),
S2-mcpjson-control / S2-switch (KC-SPEC-01 control, KC-ACP-03), S4c (permission `cancelled`),
S5-clear (KC-ACP-05 clear), S6-auto (KC-ACP-14 auto-compaction), S11-frame (KC-ACP-16 10 MiB cap),
S14 (KC-AUTH-04 auth error, KC-ACP-19 refusal), S15 (KC-SPEC-02 KiroCrew tool mapping), S16
(KC-ACP-20 todo), S17 (KC-ACP-21 subagent frames), S18 (KC-FS-06 log append + rotation).
S2 runs Claude as fake-claude-mcp.mjs so MCP servers report tools/status (see that file).

Each scenario is a plain ACP client that speaks to `<bin> acp --agent-engine v2 --agent <name>`
exactly like KiroCrew does (initialize params of 08b §4.4, spawn env of 08b §4.3), in its own
workspace `$E2E/ws-<n>` with the agent spec written to `<ws>/.kiro/agents/<name>.json`.

  acp_scenarios.py --bin <shim> [--stage B|C | --real] [--out DIR] [S1 S4r ...]

Stage B (default): KIRO_CLAUDE_BIN is the shim's baked fake-claude; FAKE_CLAUDE_SCRIPT is
fake-script.json next to this file, and each scenario's FAKE_CLAUDE_LOG is `<ws>/fake-claude.jsonl`.
Stage C (`--real`): the real `claude` (KIRO_CLAUDE_FORCE_MODEL=haiku unless set); prompts carry
a nonce and text is matched loosely; checks that need fake-claude's log are skipped.

Prints `PASS|FAIL|SKIP <id> <evidence>`; exits 1 if any FAILs. Every agent→client frame is
recorded per scenario to `<out>/frames/<S>.jsonl` (first line: a KiroCrew replay-corpus provenance
header), so the frame-shape parity check (08 §5.2 item 4) can replay them; every line in both
directions goes to `<out>/wire/<S>.jsonl`. A non-JSON stdout line from the agent is a failure
(KC-FS-06).
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
INIT_PARAMS = {
    "clientInfo": {"name": "kirocrew", "version": "0.13.0"},
    "protocolVersion": "2025-08-22",
    "clientCapabilities": {"fs": {"readTextFile": False, "writeTextFile": False}, "terminal": False,
                           "elicitation": {"form": {}, "url": {}}},
}
PROVENANCE = {"_meta": {"backend": "", "recorded": "live", "agent_name": "kiro-claude", "agent_version": "1.26.0"}}
UUID4 = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
KIRO_OPTIONS = {"allow_once", "allow_always", "reject_once"}

RESULTS: list[tuple[str, str, str]] = []


def report(sid: str, status: str, evidence: str) -> None:
    evidence = " ".join(str(evidence).split())
    RESULTS.append((sid, status, evidence))
    print(f"{status} {sid} {evidence[:900]}", flush=True)


class Check:
    """Collects the failed assertions of one scenario row."""

    def __init__(self, sid: str):
        self.sid, self.bad, self.good = sid, [], []

    def ok(self, cond, what: str, detail: str = "") -> bool:
        if cond:
            self.good.append(what)
        else:
            self.bad.append(f"{what}{(': ' + detail) if detail else ''}")
        return bool(cond)

    def done(self, extra: str = "") -> None:
        if self.bad:
            report(self.sid, "FAIL", "; ".join(self.bad) + (f" | ok: {', '.join(self.good)}" if self.good else ""))
        else:
            report(self.sid, "PASS", ", ".join(self.good) + (f"; {extra}" if extra else ""))


class Agent:
    """One `kiro-claude acp` process."""

    def __init__(self, ctx: "Ctx", name: str, ws: str, agent: str, extra_env: dict | None = None, label: str | None = None):
        self.ctx, self.ws, self.agent = ctx, ws, agent
        self.label = label or name
        self.frames: list[tuple[float, dict]] = []  # agent→client, parsed
        self.bad_lines: list[str] = []
        self.cv = threading.Condition()
        self.next_id = 1
        self.eof = False
        self.permission_policy = "allow_once"  # or "reject_once" | "hold" | "cancelled"
        self.pending_permissions: list[dict] = []
        os.makedirs(os.path.join(ctx.out, "frames"), exist_ok=True)
        os.makedirs(os.path.join(ctx.out, "wire"), exist_ok=True)
        self.frames_path = os.path.join(ctx.out, "frames", f"{self.label}.jsonl")
        self.wire = open(os.path.join(ctx.out, "wire", f"{self.label}.jsonl"), "a", encoding="utf-8")
        with open(self.frames_path, "w", encoding="utf-8") as f:
            f.write(json.dumps(PROVENANCE) + "\n")
        env = ctx.agent_env(ws)
        if extra_env:
            env.update(extra_env)
        self.env = env
        self.argv = [ctx.bin, "acp", "--agent-engine", "v2", "--agent", agent]
        self.t0 = time.time()
        self.stderr = open(os.path.join(ws, f"acp-{self.label}.stderr"), "ab")
        self.p = subprocess.Popen(self.argv, cwd=ws, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=self.stderr, start_new_session=True)
        ctx.procs.append(self.p)
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()

    # ── wire ──
    def _log(self, direction: str, obj) -> None:
        try:
            self.wire.write(json.dumps({"t": round(time.time() - self.t0, 3), "dir": direction, "msg": obj}) + "\n")
            self.wire.flush()
        except ValueError:
            pass

    def _read(self) -> None:
        assert self.p.stdout is not None
        for raw in self.p.stdout:
            line = raw.decode("utf-8", "replace").rstrip("\n")
            if not line.strip():
                continue
            try:
                msg = json.loads(line)
                if not isinstance(msg, dict):
                    raise ValueError("not an object")
            except ValueError:
                self.bad_lines.append(line[:200])
                self._log("bad", line[:2000])
                continue
            self._log("in", msg)
            with open(self.frames_path, "a", encoding="utf-8") as f:
                f.write(json.dumps(msg) + "\n")
            with self.cv:
                self.frames.append((time.time(), msg))
                self.cv.notify_all()
            if "method" in msg and "id" in msg:
                threading.Thread(target=self._on_request, args=(msg,), daemon=True).start()
        with self.cv:
            self.eof = True
            self.cv.notify_all()

    def send(self, obj: dict) -> None:
        self._log("out", obj)
        assert self.p.stdin is not None
        self.p.stdin.write((json.dumps(obj) + "\n").encode())
        self.p.stdin.flush()

    def _on_request(self, msg: dict) -> None:
        if msg["method"] == "session/request_permission":
            pol = self.permission_policy
            if pol == "hold":
                with self.cv:
                    self.pending_permissions.append(msg)
                    self.cv.notify_all()
                return
            self.answer_permission(msg, pol)
            return
        self.send({"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32601, "message": f"Method not found: {msg['method']}"}})

    def answer_permission(self, msg: dict, option: str) -> None:
        if option == "cancelled":
            outcome = {"outcome": "cancelled"}
        else:
            outcome = {"outcome": "selected", "optionId": option}
        self.send({"jsonrpc": "2.0", "id": msg["id"], "result": {"outcome": outcome}})

    def request_async(self, method: str, params: dict) -> int:
        rid = self.next_id
        self.next_id += 1
        self.send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
        return rid

    def wait_response(self, rid: int, timeout: float = 30.0):
        """(result, error, index) of the response to request `rid`; raises on timeout/EOF."""
        hit = self.wait_for(lambda m: m.get("id") == rid and "method" not in m and ("result" in m or "error" in m), timeout)
        if hit is None:
            raise TimeoutError(f"no response to id {rid} within {timeout}s (eof={self.eof})")
        idx, m = hit
        return m.get("result"), m.get("error"), idx

    def request(self, method: str, params: dict, timeout: float = 30.0):
        return self.wait_response(self.request_async(method, params), timeout)

    def notify(self, method: str, params: dict) -> None:
        self.send({"jsonrpc": "2.0", "method": method, "params": params})

    def wait_for(self, pred, timeout: float = 30.0, start: int = 0):
        deadline = time.time() + timeout
        with self.cv:
            i = start
            while True:
                while i < len(self.frames):
                    if pred(self.frames[i][1]):
                        return i, self.frames[i][1]
                    i += 1
                left = deadline - time.time()
                if left <= 0 or self.eof:
                    return None
                self.cv.wait(min(left, 0.5))

    def wait_permission(self, timeout: float = 30.0):
        deadline = time.time() + timeout
        with self.cv:
            while not self.pending_permissions:
                left = deadline - time.time()
                if left <= 0 or self.eof:
                    return None
                self.cv.wait(min(left, 0.5))
            return self.pending_permissions.pop(0)

    def msgs(self, start: int = 0, end: int | None = None) -> list[dict]:
        with self.cv:
            return [m for _, m in self.frames[start:end]]

    def updates(self, start: int = 0, end: int | None = None, kind: str | None = None, method: str = "session/update") -> list[dict]:
        out = []
        for m in self.msgs(start, end):
            if m.get("method") != method:
                continue
            u = (m.get("params") or {}).get("update") or {}
            if kind is None or u.get("sessionUpdate") == kind:
                out.append(u)
        return out

    def text(self, start: int = 0, end: int | None = None, kind: str = "agent_message_chunk") -> str:
        return "".join(((u.get("content") or {}).get("text") or "") for u in self.updates(start, end, kind))

    def close(self, timeout: float = 10.0) -> int | None:
        try:
            if self.p.stdin and not self.p.stdin.closed:
                self.p.stdin.close()
        except OSError:
            pass
        try:
            return self.p.wait(timeout)
        except subprocess.TimeoutExpired:
            self.kill()
            return None
        finally:
            self.reader.join(2)
            self.wire.close()

    def kill(self) -> None:
        try:
            os.killpg(self.p.pid, signal.SIGKILL)
        except OSError:
            pass

    # ── ACP helpers ──
    def initialize(self):
        return self.request("initialize", INIT_PARAMS, timeout=15)

    def new_session(self, mcp_servers: list | None = None, cwd: str | None = None):
        return self.request("session/new", {"cwd": cwd or self.ws, "mcpServers": mcp_servers or []}, timeout=60)

    def prompt(self, sid: str, text: str, timeout: float = 120.0):
        rid = self.request_async("session/prompt", {"sessionId": sid, "prompt": [{"type": "text", "text": text}]})
        start = len(self.frames)
        res, err, idx = self.wait_response(rid, timeout)
        return res, err, idx, start


class Ctx:
    def __init__(self, a):
        self.bin = a.bin
        self.real = a.real
        self.e2e = os.environ.get("E2E") or os.path.dirname(os.path.abspath(a.out))
        self.out = os.path.abspath(a.out)
        self.home = os.environ["HOME"]
        self.script = a.script
        self.procs: list[subprocess.Popen] = []
        self.nonce = os.urandom(4).hex()
        self.kiro_home = os.path.join(self.home, ".kiro")

    def agent_env(self, ws: str) -> dict:
        env = dict(os.environ)
        env.update({
            "KIRO_CLI_CLIENT_APPLICATION": "kirocrew",
            "KIRO_CHAT_LOG_FILE": os.path.join(ws, "kiro-chat.log"),
            "KIROCREW_SPAWNED": "1",
            "KIROCREW_RUNTIME_AGENT": "kirocrew",
            "NO_COLOR": "1",
        })
        if self.real:
            for k in [k for k in env if k.startswith("FAKE_CLAUDE_")]:
                env.pop(k)
            env.setdefault("KIRO_CLAUDE_FORCE_MODEL", "haiku")
        else:
            env["FAKE_CLAUDE_SCRIPT"] = self.script
            env["FAKE_CLAUDE_LOG"] = os.path.join(ws, "fake-claude.jsonl")
        return env

    def workspace(self, n: str, spec_name: str, spec: dict, files: dict | None = None) -> str:
        ws = os.path.join(self.e2e, f"ws-{n.lower()}")
        os.makedirs(os.path.join(ws, ".kiro", "agents"), exist_ok=True)
        # a re-run in the same run dir must not see the previous run's logs (checks count starts)
        for old_log in ("fake-claude.jsonl", "kiro-chat.log"):
            try:
                os.unlink(os.path.join(ws, old_log))
            except OSError:
                pass
        with open(os.path.join(ws, ".kiro", "agents", f"{spec_name}.json"), "w") as f:
            json.dump(spec, f, indent=2)
        for rel, content in (files or {}).items():
            p = os.path.join(ws, rel)
            os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, "w") as f:
                f.write(content)
        return ws

    def sessions_dir(self) -> str:
        return os.path.join(self.kiro_home, "sessions", "cli")


def fake_log(ws: str) -> list[dict]:
    p = os.path.join(ws, "fake-claude.jsonl")
    out = []
    if os.path.exists(p):
        for line in open(p, encoding="utf-8"):
            try:
                out.append(json.loads(line))
            except ValueError:
                pass
    return out


def user_text(rec: dict) -> str:
    line = rec.get("line") or {}
    c = (line.get("message") or {}).get("content")
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return "".join(b.get("text", "") for b in c if isinstance(b, dict))
    return ""


def stream_starts(log: list[dict]) -> list[dict]:
    return [r for r in log if r.get("event") == "start" and "-p" in (r.get("argv") or [])]


def argv_value(argv: list[str], flag: str) -> list[str]:
    return [argv[i + 1] for i, a in enumerate(argv[:-1]) if a == flag]


def pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    try:
        with open(f"/proc/{pid}/stat") as f:
            return f.read().split(") ", 1)[1].split()[0] != "Z"
    except OSError:
        return True


def spec(name: str, **kw) -> dict:
    s = {"name": name, "description": f"kiro-claude e2e agent {name}", "prompt": "You are a test agent.",
         "tools": ["execute_bash", "fs_read", "fs_write", "grep", "glob"], "allowedTools": ["fs_read", "grep", "glob"],
         "resources": ["file://AGENTS.md", "file://.kiro/steering/**/*.md"], "includeMcpJson": False, "mcpServers": {}}
    s.update(kw)
    return s


def opener(ctx: Ctx, n: str, spec_name: str, sp: dict, files: dict | None = None, extra_env: dict | None = None, mcp: list | None = None):
    """Workspace + process + initialize + session/new (asserted only for transport errors)."""
    ws = ctx.workspace(n, spec_name, sp, files)
    ag = Agent(ctx, n, ws, spec_name, extra_env)
    ag.initialize()
    res, err, idx = ag.new_session(mcp)
    if err or not res:
        raise RuntimeError(f"session/new failed: {err}")
    return ws, ag, res["sessionId"], idx


def words(ctx: Ctx, w: str) -> str:
    """Prompt text for a fixed fake-script word (stage B) or a nonce instruction (stage C)."""
    if not ctx.real:
        return w
    n = ctx.nonce
    return {
        "PING": f"Reply with exactly: PONG-{n}",
        "RUN-ECHO": f"Use your shell tool (execute_bash / Bash) to run exactly: echo kc-e2e-{n} . Then reply DONE.",
        "ECHO-STEER": f"Use your shell tool to run exactly: echo kc-e2e-{n} . Then reply STEER-DONE.",
        "SLOW": "Count from 1 to 400, one number per line, with no other text.",
        "READ-DENIED": "Use your file read tool to read the file secret/token.txt and print its contents.",
    }.get(w, w)


def expect_text(ctx: Ctx, got: str, w: str) -> bool:
    if not ctx.real:
        return w in got
    return (f"{w}-{ctx.nonce}".lower() in got.lower()) if w in ("PONG",) else (w.lower() in got.lower())


# ─────────────────────────── scenarios ───────────────────────────

def s1(ctx: Ctx) -> None:
    c = Check("S1")
    ws = ctx.workspace("S1", "kc-probe", spec("kc-probe"))
    ag = Agent(ctx, "S1", ws, "kc-probe")
    try:
        t0 = time.time()
        res, err, _ = ag.initialize()
        dt = time.time() - t0
        c.ok(err is None and isinstance(res, dict), "initialize ok", str(err))
        res = res or {}
        caps = res.get("agentCapabilities") or {}
        c.ok(res.get("protocolVersion") == 1, "protocolVersion 1", repr(res.get("protocolVersion")))
        c.ok(caps.get("loadSession") is True, "loadSession")
        c.ok(caps.get("promptCapabilities") == {"image": True, "audio": False, "embeddedContext": True}, "promptCapabilities", json.dumps(caps.get("promptCapabilities")))
        c.ok(caps.get("mcpCapabilities") == {"http": True, "sse": True}, "mcpCapabilities", json.dumps(caps.get("mcpCapabilities")))
        c.ok(res.get("authMethods") == [], "authMethods []")
        info = res.get("agentInfo") or {}
        c.ok(info == {"name": "kiro-claude", "title": "kiro-claude 0.1.0 (Claude Code)", "version": "1.26.0"},
             "agentInfo exactly {kiro-claude, 'kiro-claude 0.1.0 (Claude Code)', 1.26.0}", json.dumps(info))
        c.ok(not (((res.get("_meta") or {}).get("kiro") or {}).get("extensionMethods")), "no _meta.kiro.extensionMethods")
        c.ok(set(res) <= {"protocolVersion", "agentCapabilities", "authMethods", "agentInfo", "_meta"}, "no unexpected top-level keys", json.dumps(sorted(res)))
        extra_caps = sorted(set(caps) - {"loadSession", "promptCapabilities", "mcpCapabilities"})
        c.ok(dt < 1.0, f"initialize {dt*1000:.0f}ms < 1s")
        res, err, _ = ag.new_session()
        c.ok(err is None and isinstance(res, dict), "session/new ok", str(err))
        res = res or {}
        sid = res.get("sessionId", "")
        c.ok(bool(UUID4.match(sid)), "sessionId uuid v4", sid)
        modes = res.get("modes") or {}
        c.ok(modes.get("currentModeId") == "kc-probe", "currentModeId==kc-probe", json.dumps(modes)[:200])
        c.ok("kc-probe" in [m.get("id") for m in modes.get("availableModes") or []], "availableModes has kc-probe")
        # KC-FS-01: KiroCrew's mates agents are never offered as modes.
        c.ok(not any("mates" in json.dumps(m) for m in modes.get("availableModes") or []), "no ~/.kiro/mates/agents in availableModes")
        models = res.get("models") or {}
        am = models.get("availableModels") or []
        c.ok(bool(models.get("currentModelId")) and am and all({"modelId", "name", "description"} <= set(m) for m in am), "models shape {modelId,name,description}",
             json.dumps(models)[:200])
        c.ok("claude-haiku-5.5" in [m.get("modelId") for m in am], "claude-haiku-5.5 advertised")
        # KC-CLI-06: chat --list-models ids are the session/new ids (same source, the model cache).
        lm = subprocess.run([ctx.bin, "chat", "--list-models", "--format", "json", "--no-interactive"], cwd=ag.ws, env=ag.env,
                            capture_output=True, text=True, timeout=20, stdin=subprocess.DEVNULL)
        try:
            lm_ids = sorted(r["model_id"] for r in json.loads(lm.stdout)["models"])
        except (ValueError, KeyError, TypeError):
            lm_ids = []
        c.ok(lm_ids and lm_ids == sorted(m.get("modelId") for m in am), "KC-CLI-06 list-models ids == session/new availableModels",
             f"list={lm_ids} acp={sorted(m.get('modelId') for m in am)}")
        cache = os.path.join(ctx.home, ".cache", "kiro-claude", "models.json")
        c.ok(os.path.exists(cache), "KC-CLI-06 model cache ~/.cache/kiro-claude/models.json written after Claude's initialize")
        # Guard A2: a missing spec is a JSON-RPC error naming it, never a silent fallback.
        ws2 = ctx.workspace("S1-missing", "kc-other", spec("kc-other"))
        ag2 = Agent(ctx, "S1-missing", ws2, "kc-no-such-agent", label="S1-missing")
        try:
            ag2.initialize()
            r2, e2, _ = ag2.new_session()
            c.ok(e2 is not None and "kc-no-such-agent" in json.dumps(e2), "missing --agent spec ⇒ error naming it", json.dumps(r2 or e2)[:200])
        finally:
            ag2.close()
        # Guard A2 (KC-ACP-02): an INVALID spec is a JSON-RPC error naming the file. Own row.
        ci = Check("S1-invalid")
        ws3 = ctx.workspace("S1-invalid", "kc-bad", {"name": "kc-bad", "tools": 5})
        ag3 = Agent(ctx, "S1-invalid", ws3, "kc-bad", label="S1-invalid")
        try:
            ag3.initialize()
            r3, e3, _ = ag3.new_session()
            bad_path = os.path.join(ws3, ".kiro", "agents", "kc-bad.json")
            v = subprocess.run([ctx.bin, "agent", "validate", "--path", bad_path], capture_output=True, text=True, timeout=20, stdin=subprocess.DEVNULL, env=ag3.env)
            ci.ok(v.returncode == 1 and "is invalid" in v.stdout, "control: agent validate rejects it", f"rc={v.returncode}")
            ci.ok(e3 is not None and (bad_path in json.dumps(e3) or "kc-bad.json" in json.dumps(e3)),
                  "session/new with an invalid spec (tools:5) ⇒ JSON-RPC error naming the file",
                  "got a session instead: " + json.dumps({"currentModeId": ((r3 or {}).get("modes") or {}).get("currentModeId"),
                                                          "error": e3})[:200])
            if not ctx.real:
                time.sleep(0.3)
                st3 = stream_starts(fake_log(ws3))
                if st3:
                    ci.ok(False, "no Claude child for an invalid spec", f"spawned with --tools {argv_value(st3[0]['argv'], '--tools')!r}")
        finally:
            ag3.close()
        ci.done()
        # KC-ACP-01: protocolVersion 1 is accepted as well as "2025-08-22".
        ag4 = Agent(ctx, "S1-v1", ws, "kc-probe", label="S1-v1")
        try:
            r4, e4, _ = ag4.request("initialize", dict(INIT_PARAMS, protocolVersion=1), timeout=15)
            c.ok(e4 is None and (r4 or {}).get("protocolVersion") == 1, "initialize protocolVersion 1 accepted", json.dumps(r4 or e4)[:200])
        finally:
            ag4.close()
        c.ok(not ag.bad_lines, "stdout only JSON-RPC (KC-FS-06)", repr(ag.bad_lines[:2]))
    finally:
        ag.close()
    c.done(f"agentCapabilities extra keys beyond the 08 answer: {extra_caps}" if extra_caps else "")


FAKE_MCP = os.path.join(HERE, "fake-claude-mcp.mjs")


def _mcp_configs(argv: list[str]) -> dict:
    merged: dict = {}
    for v in argv_value(argv, "--mcp-config"):
        try:
            merged.update((json.loads(v if v.strip().startswith("{") else open(v).read()).get("mcpServers")) or {})
        except (OSError, ValueError):
            merged["_unreadable"] = v
    return merged


def s2(ctx: Ctx) -> None:
    c = Check("S2")
    sp = spec("kc-mcp", mcpServers={
        "kc-alpha": {"command": "/bin/true", "args": [], "disabledTools": ["pong"]},
        "kc-beta": {"command": "/bin/true", "args": ["--x"],
                    "env": {"KC_SPEC_ONLY": "${HOME}", "KC_ENV_PREFIX": "${env:HOME}", "KC_UNSET": "${KC_NO_SUCH_VAR_E2E}"}},
        "kirocrew-core": {"command": "/bin/false", "args": ["spec-version"]},
        "kc-broken": {"command": "/bin/true", "args": []},
        "kc-remote": {"url": "http://127.0.0.1:9/mcp", "headers": {"X-Kc-Home": "${HOME}"}},
        "kc-off": {"command": "/bin/true", "args": [], "disabled": True},
    }, tools=["execute_bash", "fs_read", "@kc-alpha", "@kc-beta", "@kirocrew-core", "@kc-broken", "@kc-remote", "@kc-off", "@kirocrew-computer"])
    stub = [{"name": "kirocrew-core", "command": "/bin/true", "args": ["mcp-core"], "type": "stdio",
             "env": [{"name": "KIROCREW_STUB_SESSION_TOKEN", "value": "tok-e2e-stub"}, {"name": "KIROCREW_HOME", "value": "/x"}]}]
    files = {".kiro/steering/kc-marker.md": "KC-STEERING-MARKER-7f3a\n",
             ".kiro/settings/cli.json": json.dumps({"chat.modelDefaults.auto.output_config.effort": "high"}),
             # KC-SPEC-01: a server only in the workspace mcp.json; the spec has includeMcpJson:false
             ".kiro/settings/mcp.json": json.dumps({"mcpServers": {"kc-mcpjson-only": {"command": "/bin/true", "args": []}}})}
    canaries = {
        # KC-ENV-01 / 00 §3.2: scrubbed before Claude is spawned
        "KIRO_API_KEY": "kc-canary", "CLAUDE_CODE_ENTRYPOINT": "kc-canary-entry", "CLAUDE_CODE_SESSION_ID": str(uuid.uuid4()),
        "CLAUDE_CODE_REMOTE_KC": "1", "CCR_KC_CANARY": "1", "CLAUDE_SESSION_INGRESS_KC": "1", "AI_AGENT": "kc-canary",
        "DEBUG": "kc-canary", "NODE_OPTIONS": "--no-deprecation",
        # kept
        "KIRO_HOME": ctx.kiro_home, "KIROCREW_KC_CANARY": "keep-me",
    }
    inject = {"kc-alpha": {"fakeTools": ["ping", "pong"]}, "kirocrew-core": {"fakeTools": ["learn_add"]},
              "kc-broken": {"fakeStatus": "failed"}}
    extra = {"ASBX_KIRO_MANDATORY_MCPS": "kc-alpha,kirocrew-core", "KIRO_CLAUDE_BIN": FAKE_MCP, "KC_FAKE_MCP_INJECT": json.dumps(inject)}
    if ctx.real:
        extra = {"ASBX_KIRO_MANDATORY_MCPS": "kc-alpha,kirocrew-core"}
    extra.update(canaries)
    ws, ag, sid, idx_new = opener(ctx, "S2", "kc-mcp", sp, files, extra_env=extra, mcp=stub)
    try:
        res, err, idx = ag.request("session/set_mode", {"sessionId": sid, "modeId": "kc-mcp"})
        c.ok(err is None and res == {}, "set_mode same id ⇒ {}", json.dumps(res or err))
        cmu = ag.wait_for(lambda m: m.get("method") == "session/update" and (m["params"].get("update") or {}).get("sessionUpdate") == "current_mode_update", 5, idx_new)
        c.ok(cmu is not None and cmu[1]["params"]["update"].get("currentModeId") == "kc-mcp", "current_mode_update")
        ok_want = {"kc-alpha", "kc-beta", "kirocrew-core", "kc-remote"}
        fail_want = {"kc-broken"} if not ctx.real else set()
        t0 = time.time()
        while time.time() - t0 < 10:
            got = {m["params"].get("serverName") for m in ag.msgs(idx_new)
                   if m.get("method") in ("_kiro.dev/mcp/server_initialized", "_kiro.dev/mcp/server_init_failure")}
            if got >= ok_want | fail_want:
                break
            time.sleep(0.1)
        time.sleep(1.0)  # late duplicates would show up here
        counts, fails = {}, {}
        for m in ag.msgs(idx_new):
            pr = m.get("params") or {}
            if m.get("method") == "_kiro.dev/mcp/server_initialized":
                counts[pr.get("serverName")] = counts.get(pr.get("serverName"), 0) + 1
                c.ok(pr.get("sessionId") == sid, f"server_initialized {pr.get('serverName')} carries sessionId")
            elif m.get("method") == "_kiro.dev/mcp/server_init_failure":
                fails[pr.get("serverName")] = pr
        if ctx.real:
            c.ok(set(counts) | set(fails) >= {"kc-alpha", "kc-beta"}, "one server_initialized/init_failure per server", json.dumps(counts))
        else:
            c.ok(set(counts) == ok_want and all(v == 1 for v in counts.values()), "exactly one server_initialized per connected server within 10s",
                 json.dumps(counts))
            f = fails.get("kc-broken") or {}
            c.ok(set(fails) == {"kc-broken"} and f.get("sessionId") == sid and isinstance(f.get("error"), str) and f.get("error"),
                 "KC-ACP-04 server_init_failure {sessionId, serverName, error} for the failed server", json.dumps(fails)[:300])
            c.ok("kc-off" not in counts and "kc-off" not in fails, "disabled server never initialized")
        res, err, _ = ag.request("_kiro.dev/commands/execute", {"sessionId": sid, "command": {"command": "mcp", "args": {}}}, timeout=40)
        servers = ((res or {}).get("data") or {}).get("servers") or []
        by = {s.get("name"): s for s in servers}
        c.ok((res or {}).get("success") is True and str((res or {}).get("message", "")).startswith(f"{len(servers)} MCP server"),
             "/mcp {success:true, message:'N MCP servers'}", json.dumps({k: (res or {}).get(k) for k in ("success", "message")})[:200])
        c.ok(all(by.get(n, {}).get("status") == "running" for n in ok_want), "/mcp connected servers status running",
             json.dumps({n: by.get(n, {}).get("status") for n in sorted(by)}))
        if not ctx.real:
            c.ok(by.get("kc-broken", {}).get("status") == "failed", "/mcp failed server status failed", json.dumps(by.get("kc-broken")))
            c.ok("kc-off" not in by or by["kc-off"].get("status") == "disabled", "/mcp disabled server absent or 'disabled'", json.dumps(by.get("kc-off")))
            # toolCount is Claude's mcp_status tool count (08 does not say whether disabledTools are
            # subtracted; kiro-claude counts them, see the evidence).
            c.ok(by.get("kirocrew-core", {}).get("toolCount") == 1 and (by.get("kc-alpha", {}).get("toolCount") or 0) >= 1,
                 f"toolCount from Claude's tools (kirocrew-core 1, kc-alpha {by.get('kc-alpha', {}).get('toolCount')} incl. 1 disabledTools entry)",
                 json.dumps({n: by.get(n, {}).get("toolCount") for n in sorted(by)}))
        c.ok(all(isinstance(s.get("toolCount"), int) for s in servers if s.get("status") != "disabled"), "toolCount ints (non-disabled servers)",
             json.dumps({s.get("name"): s.get("toolCount") for s in servers}))
        c.ok("kc-mcpjson-only" not in by, "KC-SPEC-01 includeMcpJson:false ⇒ mcp.json server not loaded")
        res, err, _ = ag.request("_kiro.dev/commands/execute", {"sessionId": sid, "command": {"command": "tools", "args": {}}}, timeout=40)
        tools = ((res or {}).get("data") or {}).get("tools") or []
        srcs = sorted({str(t.get("source")) for t in tools})
        c.ok((res or {}).get("success") is True and str((res or {}).get("message", "")).startswith(f"{len(tools)} tool"),
             "/tools {success:true, message:'N tools'}", json.dumps({k: (res or {}).get(k) for k in ("success",)}))
        c.ok(any(t.get("source") == "builtin" for t in tools), "/tools has builtin sources")
        mcp_tools = [(t.get("name"), t.get("source")) for t in tools if str(t.get("source")).startswith("mcp:")]
        if ctx.real:
            c.ok(True, f"/tools sources {srcs}")
        else:
            c.ok(any(src == "mcp:kc-alpha" and "ping" in str(n) for n, src in mcp_tools) and any(src == "mcp:kirocrew-core" for _, src in mcp_tools),
                 "/tools data.tools[].source has the mcp:<server> prefix", json.dumps(mcp_tools)[:300])
            c.ok(not any("pong" in str(n) for n, _ in mcp_tools), "disabledTools pong not offered", json.dumps(mcp_tools)[:200])
        # KC-ACP-22 available_commands_update after session/new
        c.ok(bool(ag.updates(idx_new, kind="available_commands_update")), "available_commands_update")
        if not ctx.real:
            time.sleep(0.3)
            starts = stream_starts(fake_log(ws))
            c.ok(len(starts) == 1, "eager claude child at session/new (1 fake start)", str(len(starts)))
            if starts:
                st = starts[0]
                env = st.get("env") or {}
                scrub = ["CLAUDECODE", "KIRO_API_KEY", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_REMOTE_KC", "CCR_KC_CANARY",
                         "CLAUDE_SESSION_INGRESS_KC", "AI_AGENT", "DEBUG", "NODE_OPTIONS"]
                leaked = [k for k in scrub if k in env]
                c.ok(not leaked and env.get("CLAUDE_CODE_ENTRYPOINT") == "sdk-ts", "KC-ENV-01 scrub list removed (00 §3.2), CLAUDE_CODE_ENTRYPOINT=sdk-ts",
                     f"leaked={leaked} entrypoint={env.get('CLAUDE_CODE_ENTRYPOINT')!r}")
                kept = {k: env.get(k) for k in ("KIROCREW_SPAWNED", "KIROCREW_RUNTIME_AGENT", "KIROCREW_KC_CANARY", "KIRO_HOME")}
                c.ok(kept == {"KIROCREW_SPAWNED": "1", "KIROCREW_RUNTIME_AGENT": "kirocrew", "KIROCREW_KC_CANARY": "keep-me", "KIRO_HOME": ctx.kiro_home},
                     "KC-ENV-01 KIROCREW_* and KIRO_HOME kept", json.dumps({k: (v is not None) for k, v in kept.items()}))
                merged = _mcp_configs(st["argv"])
                core = merged.get("kirocrew-core") or {}
                c.ok((core.get("env") or {}).get("KIROCREW_STUB_SESSION_TOKEN") == "tok-e2e-stub" and core.get("command") == "/bin/true",
                     "KC-ENV-02 session stub overrides spec server, env kept", json.dumps({k: core.get(k) for k in ("command", "args")})[:300])
                c.ok(merged.get("kc-alpha", {}).get("alwaysLoad") is True and merged.get("kirocrew-core", {}).get("alwaysLoad") is True
                     and not merged.get("kc-beta", {}).get("alwaysLoad"), "KC-ENV-03 alwaysLoad on ASBX_KIRO_MANDATORY_MCPS",
                     json.dumps({k: v.get("alwaysLoad") for k, v in merged.items() if isinstance(v, dict)}))
                benv = merged.get("kc-beta", {}).get("env") or {}
                c.ok(benv.get("KC_SPEC_ONLY") == ctx.home and benv.get("KC_ENV_PREFIX") == ctx.home and benv.get("KC_UNSET") == "${KC_NO_SUCH_VAR_E2E}",
                     "KC-SPEC-04 ${VAR} and ${env:VAR} expanded, unresolved var stays literal",
                     json.dumps({k: (v == ctx.home) if k != "KC_UNSET" else v for k, v in benv.items()}))
                rem = merged.get("kc-remote") or {}
                c.ok(rem.get("type") in ("http", "sse") and rem.get("url") == "http://127.0.0.1:9/mcp" and (rem.get("headers") or {}).get("X-Kc-Home") == ctx.home,
                     "KC-SPEC-04 remote {url,headers} ⇒ http entry with expanded headers", json.dumps({k: rem.get(k) for k in ("type", "url")}))
                c.ok("kc-off" not in merged and "kc-mcpjson-only" not in merged, "KC-SPEC-04 disabled server and (KC-SPEC-01) mcp.json server absent from --mcp-config",
                     json.dumps(sorted(merged)))
                dis = ",".join(argv_value(st["argv"], "--disallowedTools"))
                c.ok("mcp__kc-alpha__pong" in dis, "KC-SPEC-04 disabledTools ⇒ --disallowedTools mcp__kc-alpha__pong", dis[:200])
                eff = argv_value(st["argv"], "--effort")
                c.ok(eff == ["high"], "KC-FS-05 cli.json effort ⇒ --effort high", repr(eff))
                prompt_files = argv_value(st["argv"], "--append-system-prompt-file") + argv_value(st["argv"], "--system-prompt-file")
                inline = argv_value(st["argv"], "--append-system-prompt") + argv_value(st["argv"], "--system-prompt")
                blob = "".join(inline)
                for pf in prompt_files:
                    try:
                        blob += open(pf, encoding="utf-8").read()
                    except OSError:
                        pass
                c.ok("KC-STEERING-MARKER-7f3a" in blob, "KC-FS-07 steering marker in Claude system prompt",
                     f"files={prompt_files} inline={len(blob)}B")
        c.ok(not ag.bad_lines, "stdout only JSON-RPC", repr(ag.bad_lines[:2]))
    finally:
        ag.close()
    c.done()
    if not ctx.real:
        s2_mcpjson_control(ctx)
        s2_switch(ctx)


def s2_mcpjson_control(ctx: Ctx) -> None:
    """KC-SPEC-01 positive control: the same workspace mcp.json IS merged when includeMcpJson is true,
    so S2's absence check is meaningful."""
    c = Check("S2-mcpjson-control")
    files = {".kiro/settings/mcp.json": json.dumps({"mcpServers": {"kc-mcpjson-only": {"command": "/bin/true", "args": []}}})}
    ws, ag, sid, _ = opener(ctx, "S2j", "kc-json", spec("kc-json", includeMcpJson=True, tools=["fs_read", "@kc-mcpjson-only"]), files)
    try:
        time.sleep(0.5)
        starts = stream_starts(fake_log(ws))
        merged = _mcp_configs(starts[0]["argv"]) if starts else {}
        c.ok("kc-mcpjson-only" in merged, "includeMcpJson:true ⇒ workspace mcp.json server in --mcp-config", json.dumps(sorted(merged)))
    finally:
        ag.close()
    c.done()


def s2_switch(ctx: Ctx) -> None:
    """KC-ACP-03 (P1): set_mode with a DIFFERENT id swaps the agent: {} + current_mode_update +
    _kiro.dev/agent/switched, and the Claude child is respawned with --resume."""
    c = Check("S2-switch")
    ws = ctx.workspace("S2s", "kc-one", spec("kc-one"))
    with open(os.path.join(ws, ".kiro", "agents", "kc-two.json"), "w") as f:
        json.dump(spec("kc-two", prompt="You are the second agent."), f)
    ag = Agent(ctx, "S2s", ws, "kc-one")
    try:
        ag.initialize()
        r, e, _ = ag.new_session()
        sid = (r or {})["sessionId"]
        ag.prompt(sid, words(ctx, "PING"))
        start = len(ag.frames)
        res, err, _ = ag.request("session/set_mode", {"sessionId": sid, "modeId": "kc-two"})
        c.ok(err is None and res == {}, "set_mode kc-two ⇒ {}", json.dumps(res or err)[:200])
        cmu = ag.wait_for(lambda m: m.get("method") == "session/update" and (m["params"].get("update") or {}).get("sessionUpdate") == "current_mode_update"
                          and m["params"]["update"].get("currentModeId") == "kc-two", 10, start)
        c.ok(cmu is not None, "current_mode_update kc-two")
        sw = ag.wait_for(lambda m: m.get("method") == "_kiro.dev/agent/switched", 10, start)
        c.ok(sw is not None and (sw[1].get("params") or {}).get("sessionId") == sid, "_kiro.dev/agent/switched", json.dumps(sw[1] if sw else None)[:200])
        r2, e2, i2, s2_ = ag.prompt(sid, words(ctx, "PING"))
        c.ok((r2 or {}).get("stopReason") == "end_turn", "prompt after the switch")
        starts = stream_starts(fake_log(ws))
        c.ok(len(starts) >= 2 and argv_value(starts[-1]["argv"], "--resume"), "respawned with --resume", str([argv_value(s["argv"], "--resume") for s in starts]))
    finally:
        ag.close()
    c.done()


def s3(ctx: Ctx) -> None:
    c = Check("S3")
    ws, ag, sid, _ = opener(ctx, "S3", "kc-chat", spec("kc-chat"))
    try:
        filler = "".join(f"Rule {i}: be concise, cite files, and keep the workspace tidy at all times.\n" for i in range(700))
        text = "[AGENT SYSTEM PROMPT]\n" + filler + "[END AGENT SYSTEM PROMPT]\n[CURRENT USER REQUEST -- respond to this]\n" + words(ctx, "PING")
        c.ok(len(text) >= 45000, f"prompt {len(text)} chars")
        res, err, idx, start = ag.prompt(sid, text, timeout=180)
        got = ag.text(start, idx)
        c.ok(err is None and (res or {}).get("stopReason") == "end_turn", "end_turn", json.dumps(res or err)[:200])
        c.ok(expect_text(ctx, got, "PONG"), "chunks contain PONG", repr(got[:120]))
        meta = ag.wait_for(lambda m: m.get("method") == "_kiro.dev/metadata" and "contextUsagePercentage" in (m.get("params") or {}), 5, start)
        c.ok(meta is not None and meta[1]["params"].get("sessionId") == sid and isinstance(meta[1]["params"].get("contextUsagePercentage"), (int, float)),
             "KC-ACP-13 _kiro.dev/metadata {sessionId, contextUsagePercentage:number}", json.dumps(meta[1]["params"] if meta else None)[:200])
        mds = [m["params"] for m in ag.msgs() if m.get("method") == "_kiro.dev/metadata"]
        c.ok(not any("meteringUsage" in json.dumps(x) for x in mds), "KC-ACP-13 no credit meteringUsage")
        if not ctx.real:
            sent = [user_text(r) for r in fake_log(ws) if r.get("event") == "stdin" and (r.get("line") or {}).get("type") == "user"]
            c.ok(text in sent, "KC-ACP-06 the 53 KB prompt reached Claude verbatim", f"{len(sent)} user lines, lengths {[len(x) for x in sent][:3]} vs {len(text)}")
        usage = ag.updates(start, kind="usage_update")
        c.ok(bool(usage) and all({"used", "size"} <= set(u) for u in usage), "KC-ACP-18 usage_update {used,size}", json.dumps(usage[:1]))
        c.ok(isinstance((res or {}).get("usage"), dict), "KC-ACP-18 PromptResponse.usage", json.dumps((res or {}).get("usage"))[:200])
        time.sleep(0.3)
        jf = os.path.join(ctx.sessions_dir(), f"{sid}.json")
        jl = os.path.join(ctx.sessions_dir(), f"{sid}.jsonl")
        kinds = []
        if os.path.exists(jl):
            for line in open(jl, encoding="utf-8"):
                try:
                    kinds.append(json.loads(line).get("kind"))
                except ValueError:
                    kinds.append("<bad>")
        c.ok("Prompt" in kinds and "AssistantMessage" in kinds and os.path.getsize(jl) >= 10, "KC-FS-03 <sid>.jsonl Prompt+AssistantMessage", repr(kinds))
        recs = []
        if os.path.exists(jl):
            for line in open(jl, encoding="utf-8"):
                try:
                    recs.append(json.loads(line))
                except ValueError:
                    pass
        pr = next((r for r in recs if r.get("kind") == "Prompt"), {})
        am = next((r for r in recs if r.get("kind") == "AssistantMessage"), {})
        def shape_ok(r, want_text=None):
            d = r.get("data") or {}
            cont = d.get("content") or []
            return (r.get("version") == 1 and isinstance(r.get("timestamp"), str) and isinstance(d.get("message_id"), str)
                    and cont and cont[0].get("kind") == "text" and isinstance(cont[0].get("data"), str)
                    and (want_text is None or cont[0]["data"] == want_text))
        c.ok(shape_ok(pr, text) and shape_ok(am), "KC-FS-03 08a §4.2 record shapes (version 1, timestamp, data.message_id, content[{kind:text,data}]; Prompt = the prompt text)",
             json.dumps({"Prompt": {k: pr.get(k) for k in ("version", "kind")}, "AssistantMessage": (am.get("data") or {}).get("content")})[:300])
        env = json.load(open(jf)) if os.path.exists(jf) else {}
        ss = env.get("session_state") or {}
        fsp = (ss.get("permissions") or {}).get("filesystem") or {}
        c.ok(env.get("session_id") == sid and ss.get("agent_name") == "kc-chat" and env.get("cwd") == ws
             and isinstance(env.get("created_at"), str) and isinstance(env.get("updated_at"), str) and "title" in env
             and isinstance(ss.get("conversation_metadata"), dict)
             and isinstance(fsp.get("allowed_read_paths"), list) and isinstance(fsp.get("allowed_write_paths"), list)
             and env.get("kind") == "kiro-claude-session" and isinstance(env.get("kiro_claude"), dict),
             "KC-FS-02 <sid>.json kiro-cli envelope (session_id, cwd, created_at, updated_at, title, session_state{agent_name, permissions.filesystem{allowed_read_paths, allowed_write_paths}, conversation_metadata}, kind, kiro_claude)",
             json.dumps({k: env.get(k) for k in ("session_id", "cwd", "kind")})[:200])
        c.ok(os.path.exists(jf) and (os.stat(jf).st_mode & 0o777) == 0o600, "KC-FS-02 mode 0600",
             oct(os.stat(jf).st_mode & 0o777) if os.path.exists(jf) else "missing")
    finally:
        ag.close()
    c.done()


def _tool_frames(ag: Agent, start: int):
    """(tool_call updates, tool_call_update updates, index of first permission request or None, index of first tool_call or None)."""
    calls, upd, perm_i, call_i = [], [], None, None
    for i, m in enumerate(ag.msgs(start)):
        if m.get("method") == "session/request_permission" and perm_i is None:
            perm_i = i
        if m.get("method") == "session/update":
            u = m["params"].get("update") or {}
            if u.get("sessionUpdate") == "tool_call":
                calls.append(u)
                if call_i is None:
                    call_i = i
            elif u.get("sessionUpdate") == "tool_call_update":
                upd.append(u)
    return calls, upd, perm_i, call_i


def _deny_in_fake_log(ws: str) -> bool:
    for r in fake_log(ws):
        if r.get("event") != "stdin":
            continue
        s = json.dumps(r.get("line"))
        if '"behavior": "deny"' in s or '"permissionDecision": "deny"' in s or '"decision": "block"' in s:
            return True
    return False


def s4(ctx: Ctx, variant: str) -> None:
    sid_name = {"allow": "S4", "reject": "S4r", "allowed": "S4b", "cancel": "S4c"}[variant]
    c = Check(sid_name)
    allowed = ["fs_read", "execute_bash"] if variant == "allowed" else ["fs_read"]
    ws, ag, sid, _ = opener(ctx, sid_name, "kc-tools", spec("kc-tools", allowedTools=allowed))
    ag.permission_policy = {"reject": "reject_once", "cancel": "cancelled"}.get(variant, "allow_once")
    try:
        res, err, idx, start = ag.prompt(sid, words(ctx, "RUN-ECHO"), timeout=180)
        calls, upd, perm_i, call_i = _tool_frames(ag, start)
        perms = [m for m in ag.msgs(start) if m.get("method") == "session/request_permission"]
        if variant == "cancel":
            c.ok(err is None and (res or {}).get("stopReason") in ("end_turn", "cancelled"), "turn ends (end_turn or cancelled)", json.dumps(res or err)[:200])
        else:
            c.ok(err is None and (res or {}).get("stopReason") == "end_turn", "end_turn", json.dumps(res or err)[:200])
        shell = [u for u in calls if ((u.get("_meta") or {}).get("kiro") or {}).get("toolName") == "shell"]
        c.ok(bool(shell), "tool_call _meta.kiro.toolName=shell", json.dumps([(u.get("_meta") or {}) for u in calls])[:300])
        c.ok(all(((u.get("_meta") or {}).get("kiro") or {}).get("toolName") for u in calls), "_meta.kiro.toolName on every tool_call")
        c.ok(all(u.get("status") == "pending" for u in calls), "tool_call status pending", json.dumps([u.get("status") for u in calls]))
        purpose = [((u.get("rawInput") or {}).get("__tool_use_purpose")) for u in shell]
        c.ok(any(purpose), "rawInput.__tool_use_purpose", json.dumps([u.get("rawInput") for u in shell])[:200])
        tcid = shell[0].get("toolCallId") if shell else None
        mine = [u for u in upd if u.get("toolCallId") == tcid]
        final = [u for u in mine if u.get("status") in ("completed", "failed")]
        if variant == "allowed":
            c.ok(not perms, "S4b allowedTools ⇒ no permission request", str(len(perms)))
        else:
            c.ok(len(perms) == 1, "one session/request_permission", str(len(perms)))
            if perms:
                p = perms[0]["params"]
                opts = {o.get("optionId") for o in p.get("options") or []}
                c.ok(opts == KIRO_OPTIONS, "3 kiro options", json.dumps(p.get("options"))[:300])
                c.ok(call_i is not None and perm_i is not None and call_i < perm_i, "tool_call precedes request_permission")
                c.ok((p.get("toolCall") or {}).get("toolCallId") == tcid, "permission names the tool_call")
        if variant in ("reject", "cancel"):
            fm = (final[-1].get("_meta") or {}).get("kiro") if final else {}
            c.ok(bool(final) and final[-1].get("status") == "failed", f"on {variant}: failed", json.dumps(final)[:300])
            if variant == "reject":
                c.ok((fm or {}).get("toolCallFailureReason") == "permission_denied", "toolCallFailureReason permission_denied", json.dumps(fm)[:200])
            if not ctx.real:
                c.ok(_deny_in_fake_log(ws), "fake log shows a deny answer")
                ran = any(r.get("event") == "stdin" and "kc-e2e" in json.dumps(r.get("line")) and '"tool_result"' in json.dumps(r.get("line")) for r in fake_log(ws))
                c.ok(not ran, "no side effect (tool not run)")
        else:
            ro = final[-1].get("rawOutput") if final else None
            stdout = None
            try:
                stdout = ro["items"][0]["Json"]["stdout"]
            except (TypeError, KeyError, IndexError):
                pass
            c.ok(bool(final) and final[-1].get("status") == "completed", "completed", json.dumps(final)[-300:])
            c.ok(stdout is not None and "kc-e2e" in stdout, "rawOutput.items[0].Json.stdout has kc-e2e", json.dumps(ro)[:300])
            c.ok(expect_text(ctx, ag.text(start, idx), "DONE"), "reply DONE", repr(ag.text(start, idx)[:100]))
            time.sleep(0.3)
            jl = os.path.join(ctx.sessions_dir(), f"{sid}.jsonl")
            trs = []
            if os.path.exists(jl):
                for line in open(jl, encoding="utf-8"):
                    try:
                        r = json.loads(line)
                    except ValueError:
                        continue
                    if r.get("kind") == "ToolResults":
                        trs += (r.get("data") or {}).get("content") or []
            tr = next((x for x in trs if x.get("kind") == "toolResult"), {})
            td = tr.get("data") or {}
            c.ok(str(td.get("toolUseId", "")).startswith("toolu_") and td.get("status") == "success"
                 and any(b.get("kind") == "text" and "kc-e2e" in str(b.get("data")) for b in td.get("content") or []),
                 "KC-FS-03 ToolResults record {kind:toolResult, data{toolUseId, content[{kind:text}], status:success}}", json.dumps(trs)[:300])
    finally:
        ag.close()
    c.done()


def s5(ctx: Ctx) -> None:
    c = Check("S5")
    ws, ag, sid, _ = opener(ctx, "S5", "kc-chat", spec("kc-chat"))
    try:
        res, err, _ = ag.request("session/set_model", {"sessionId": sid, "modelId": "claude-haiku-5.5"})
        c.ok(err is None and res == {}, "set_model claude-haiku-5.5 ⇒ {}", json.dumps(res or err))
        res, err, _ = ag.request("session/set_model", {"sessionId": sid, "modelId": "bogus"})
        c.ok(err is not None and "Invalid model ID: bogus" in json.dumps(err), "bogus ⇒ error 'Invalid model ID: bogus'", json.dumps(res or err)[:200])
        # KiroCrew sends BOTH spellings: providers/acp_model_effort.py send_command("/effort", args={"level": l})
        # and the dashboard slash path parse_slash_command("/effort high") ⇒ args {"value": "high"}.
        for argk, lvl in (("level", "high"), ("value", "low")):
            res, err, _ = ag.request("_kiro.dev/commands/execute", {"sessionId": sid, "command": {"command": "effort", "args": {argk: lvl}}})
            c.ok(err is None and (res or {}).get("success") is True and (res or {}).get("message") == f"Effort set to {lvl}",
                 f"effort args {{{argk}: {lvl}}} ⇒ 'Effort set to {lvl}'", json.dumps(res or err)[:200])
        res, err, _ = ag.request("_kiro.dev/commands/execute", {"sessionId": sid, "command": {"command": "foo", "args": {}}})
        c.ok(err is None and (res or {}).get("success") is False and (res or {}).get("message") == "Unknown command: /foo", "foo ⇒ {success:false, Unknown command: /foo}", json.dumps(res or err)[:200])
        if not ctx.real:
            # the change reaches Claude: next turn's fake log shows set_model/effort
            r2, e2, idx, start = ag.prompt(sid, words(ctx, "PING"))
            sm = [((r.get("line") or {}).get("request") or {}).get("model") for r in fake_log(ws)
                  if r.get("event") == "stdin" and ((r.get("line") or {}).get("request") or {}).get("subtype") == "set_model"]
            c.ok(any(m in ("haiku", "claude-haiku-5-5") for m in sm), "set_model reached Claude (control set_model)", json.dumps(sm))
            starts = stream_starts(fake_log(ws))
            efforts = [argv_value(x["argv"], "--effort") for x in starts]
            stdin_eff = [user_text(r) for r in fake_log(ws) if r.get("event") == "stdin" and user_text(r).startswith("/effort")]
            c.ok(any(e == ["low"] for e in efforts) or any("low" in t for t in stdin_eff), "last effort (low) reached Claude",
                 f"--effort per spawn {efforts}; /effort lines {stdin_eff}")
    finally:
        ag.close()
    c.done()
    # KC-ACP-05 `clear` ⇒ {success:true} + _kiro.dev/clear/status (P0 per 08 §2.5 KC-ACP-05).
    cc = Check("S5-clear")
    ws, ag, sid, _ = opener(ctx, "S5c", "kc-chat", spec("kc-chat"))
    try:
        ag.prompt(sid, words(ctx, "PING"))
        start = len(ag.frames)
        res, err, _ = ag.request("_kiro.dev/commands/execute", {"sessionId": sid, "command": {"command": "clear", "args": {}}}, timeout=60)
        cc.ok(err is None and (res or {}).get("success") is True, "clear ⇒ {success:true}", json.dumps(res or err)[:200])
        cs = ag.wait_for(lambda m: m.get("method") == "_kiro.dev/clear/status", 10, start)
        cc.ok(cs is not None and (cs[1].get("params") or {}).get("sessionId") == sid, "_kiro.dev/clear/status", json.dumps(cs[1] if cs else None)[:200])
        r2, e2, i2, s2_ = ag.prompt(sid, words(ctx, "PING"))
        cc.ok((r2 or {}).get("stopReason") == "end_turn" and expect_text(ctx, ag.text(s2_, i2), "PONG"), "session usable after clear")
    finally:
        ag.close()
    cc.done()


def s6(ctx: Ctx) -> None:
    c = Check("S6")
    ws, ag, sid, _ = opener(ctx, "S6", "kc-chat", spec("kc-chat"))
    try:
        ag.prompt(sid, words(ctx, "PING"))
        res, err, idx, start = ag.prompt(sid, "/compact", timeout=180)
        c.ok(err is None and (res or {}).get("stopReason") == "end_turn", "end_turn", json.dumps(res or err)[:200])
        c.ok(ag.text(start, idx).startswith("Compacting conversation...\n"), "chunk 'Compacting conversation...\\n'", repr(ag.text(start, idx)[:80]))
        done = ag.wait_for(lambda m: m.get("method") == "_kiro.dev/compaction/status" and ((m["params"].get("status") or {}).get("type") in ("completed", "failed")), 60, start)
        cps = [m["params"] for m in ag.msgs(start) if m.get("method") == "_kiro.dev/compaction/status"]
        sts = [(p.get("status") or {}) for p in cps]
        types = [s.get("type") for s in sts]
        c.ok(types[:1] == ["started"] and done is not None and types[-1] == "completed", "compaction/status started → completed", json.dumps(types))
        pos_resp = idx - start
        pos_first = next((i for i, m in enumerate(ag.msgs(start)) if m.get("method") == "_kiro.dev/compaction/status"), None)
        c.ok(pos_first is not None and pos_first > pos_resp, "status frames after the end_turn response")
        # kiro-cli's wire (KiroCrew corpus compaction-live.jsonl): params {sessionId, status:{type}, summary}
        c.ok(bool(cps) and isinstance(cps[-1].get("summary"), str) and cps[-1]["summary"].strip() != "", "completed + summary", json.dumps(cps[-1:])[:200])
        time.sleep(0.3)
        jl = os.path.join(ctx.sessions_dir(), f"{sid}.jsonl")
        recs = [json.loads(l) for l in open(jl)] if os.path.exists(jl) else []
        comp = [r for r in recs if r.get("kind") == "Compaction"]
        snap = ((comp[-1].get("data") or {}).get("messages_snapshot") or [{}]) if comp else [{}]
        c.ok(bool(comp) and (snap[0].get("content") or [{}])[0].get("kind") == "text",
             "Compaction jsonl record {data.messages_snapshot[{content[{kind:text}]}]}", json.dumps(comp[-1:])[:200])
    finally:
        ag.close()
    c.done()
    if ctx.real:
        return
    # KC-ACP-14: also emitted for Claude AUTO-compaction (status compacting → compact_boundary → summary).
    ca = Check("S6-auto")
    ws, ag, sid, _ = opener(ctx, "S6a", "kc-chat", spec("kc-chat"))
    try:
        res, err, idx, start = ag.prompt(sid, "AUTO-COMPACT", timeout=60)
        ca.ok((res or {}).get("stopReason") == "end_turn" and "AUTO-DONE" in ag.text(start, idx), "turn ends end_turn with the reply", json.dumps(res or err)[:150])
        ag.wait_for(lambda m: m.get("method") == "_kiro.dev/compaction/status" and ((m["params"].get("status") or {}).get("type") == "completed"), 10, start)
        cps = [m["params"] for m in ag.msgs(start) if m.get("method") == "_kiro.dev/compaction/status"]
        types = [(x.get("status") or {}).get("type") for x in cps]
        ca.ok(types == ["started", "completed"], "compaction/status started → completed for auto-compaction", json.dumps(types))
        ca.ok(bool(cps) and "KC-AUTO-SUMMARY-91c2" in str(cps[-1].get("summary")), "completed carries the summary", json.dumps(cps[-1:])[:200])
    finally:
        ag.close()
    ca.done()


def s7(ctx: Ctx) -> None:
    c = Check("S7")
    ws, ag, sid, _ = opener(ctx, "S7", "kc-chat", spec("kc-chat"))
    try:
        rid = ag.request_async("session/prompt", {"sessionId": sid, "prompt": [{"type": "text", "text": words(ctx, "SLOW")}]})
        start = len(ag.frames)
        ag.wait_for(lambda m: m.get("method") == "session/update" and (m["params"].get("update") or {}).get("sessionUpdate") == "agent_message_chunk", 60, start)
        time.sleep(0.2)
        t0 = time.time()
        ag.notify("session/cancel", {"sessionId": sid})
        res, err, idx = ag.wait_response(rid, 10)
        dt = time.time() - t0
        c.ok((res or {}).get("stopReason") == "cancelled", "stopReason cancelled", json.dumps(res or err)[:200])
        c.ok(dt <= 2.0, f"within {dt:.2f}s ≤ 2s")
        if not ctx.real:
            c.ok("TOO-LATE" not in ag.text(start), "turn did not finish")
            ints = [r for r in fake_log(ws) if r.get("event") == "stdin" and ((r.get("line") or {}).get("request") or {}).get("subtype") == "interrupt"]
            c.ok(bool(ints), "Claude got an interrupt control request")
        r2, e2, i2, s2_ = ag.prompt(sid, words(ctx, "PING"))
        c.ok((r2 or {}).get("stopReason") == "end_turn" and expect_text(ctx, ag.text(s2_, i2), "PONG"), "session usable after cancel")
    finally:
        ag.close()
    c.done()


def s8(ctx: Ctx) -> None:
    c = Check("S8")
    ws, ag, sid, _ = opener(ctx, "S8", "kc-chat", spec("kc-chat"))
    try:
        ag.prompt(sid, words(ctx, "PING"))
        res, err, _ = ag.request("_kiro.dev/session/terminate", {"sessionId": sid})
        c.ok(err is None and res == {}, "terminate ⇒ {}", json.dumps(res or err))
        res2, err2, _ = ag.request("_kiro.dev/session/terminate", {"sessionId": sid})
        c.ok(err2 is None and res2 == {}, "terminate idempotent", json.dumps(res2 or err2))
        res, err, _ = ag.request("session/set_mode", {"sessionId": sid, "modeId": "kc-chat"})
        c.ok(err is not None and err.get("code") == -32603 and err.get("message") == "Internal error" and err.get("data") == "Session not found",
             "then set_mode ⇒ -32603 Internal error / Session not found", json.dumps(res or err))
        d = ctx.sessions_dir()
        c.ok(os.path.exists(os.path.join(d, f"{sid}.json")) and os.path.exists(os.path.join(d, f"{sid}.jsonl")), "files kept")
        if not ctx.real:
            time.sleep(0.5)
            pids = {r["pid"] for r in stream_starts(fake_log(ws))}
            c.ok(pids and not any(pid_alive(p) for p in pids), "Claude child closed", str(pids))
    finally:
        ag.close()
    c.done()


def s9(ctx: Ctx) -> None:
    c = Check("S9")
    ws, ag, sid, _ = opener(ctx, "S9", "kc-chat", spec("kc-chat"))
    try:
        ag.prompt(sid, words(ctx, "PING"))
        ag.prompt(sid, words(ctx, "RUN-ECHO"), timeout=180)
    finally:
        ag.close()
    claude_sid = None
    try:
        rec = json.load(open(os.path.join(ctx.sessions_dir(), f"{sid}.json")))
        claude_sid = (rec.get("kiro_claude") or {}).get("claudeSessionId")
    except (OSError, ValueError):
        pass
    ag2 = Agent(ctx, "S9", ws, "kc-chat", label="S9-load")
    try:
        ag2.initialize()
        start = len(ag2.frames)
        res, err, idx = ag2.request("session/load", {"sessionId": sid, "cwd": ws, "mcpServers": [],
                                                     "_meta": {"_kiro.dev/session_file": os.path.join(ctx.sessions_dir(), f"{sid}.json")}}, timeout=60)
        c.ok(err is None and isinstance(res, dict), "session/load ok (fresh process)", json.dumps(err)[:200])
        res = res or {}
        c.ok((res.get("modes") or {}).get("currentModeId") == "kc-chat", "result has modes", json.dumps(res.get("modes"))[:150])
        c.ok(isinstance(res.get("models"), dict), "result has models")
        um = ag2.text(start, idx, "user_message_chunk")
        am = ag2.text(start, idx, "agent_message_chunk")
        c.ok(bool(um) and bool(am), "replayed user_message_chunk + agent_message_chunk", f"user={um[:60]!r} agent={am[:60]!r}")
        c.ok(bool(ag2.updates(start, idx, "tool_call")), "replayed tool_call")
        if not ctx.real:
            starts = stream_starts(fake_log(ws))
            last = starts[-1]["argv"] if starts else []
            c.ok(claude_sid is not None and argv_value(last, "--resume") == [claude_sid], "fake log --resume <claude sid>",
                 f"claude_sid={claude_sid} argv_resume={argv_value(last, '--resume')}")
        r2, e2, i2, s2_ = ag2.prompt(sid, words(ctx, "PING"))
        c.ok((r2 or {}).get("stopReason") == "end_turn" and expect_text(ctx, ag2.text(s2_, i2), "PONG"), "prompt after load")
    finally:
        ag2.close()
    c.done()


def s10(ctx: Ctx) -> None:
    c = Check("S10")
    ws, ag, main, _ = opener(ctx, "S10", "kc-chat", spec("kc-chat"))
    try:
        sids = [main]
        for _ in range(2):
            r, e, _ = ag.new_session()
            sids.append(r["sessionId"])
        # 3 concurrent prompts; in stage B each turn sleeps 1.5 s, so they only finish in < 3 s if they really overlap
        first = len(ag.frames)
        t0 = time.time()
        rids = [ag.request_async("session/prompt", {"sessionId": s, "prompt": [{"type": "text", "text": words(ctx, "DELAY-PING" if not ctx.real else "PING")}]}) for s in sids]
        outs = [ag.wait_response(r, 120) for r in rids]
        dt = time.time() - t0
        c.ok(all((o[0] or {}).get("stopReason") == "end_turn" for o in outs), "3 concurrent sessions end_turn", json.dumps([o[0] or o[1] for o in outs])[:200])
        if not ctx.real:
            c.ok(dt < 3.0, f"the 3 turns overlapped ({dt:.2f}s for 3 × 1.5 s turns)")
        per = {}
        for m in ag.msgs(first):
            if m.get("method") == "session/update" and (m["params"].get("update") or {}).get("sessionUpdate") == "agent_message_chunk":
                per[m["params"].get("sessionId")] = per.get(m["params"].get("sessionId"), "") + ((m["params"]["update"].get("content") or {}).get("text") or "")
        c.ok(all(expect_text(ctx, per.get(x, ""), "PONG") for x in sids), "each session's reply arrives under its own sessionId", json.dumps({k[:8]: v[:20] for k, v in per.items()}))
        # 2 helper sessions while the main ones idle: open → prompt → terminate (lite spec, no tools)
        helpers_ok = []
        for _ in range(2):
            r, e, _ = ag.new_session()
            h = r["sessionId"]
            ag.request("session/set_mode", {"sessionId": h, "modeId": "kc-chat"})
            ag.request("session/set_model", {"sessionId": h, "modelId": "auto"})
            pr = ag.prompt(h, "You are a session naming agent. Name ONLY the conversation delimited below.\n---\nhello\n---")
            t = ag.request("_kiro.dev/session/terminate", {"sessionId": h})
            helpers_ok.append((pr[0] or {}).get("stopReason") == "end_turn" and t[0] == {})
        c.ok(all(helpers_ok), "2 helper sessions open → prompt → terminate", json.dumps(helpers_ok))
        r2 = ag.prompt(main, words(ctx, "PING"))
        c.ok((r2[0] or {}).get("stopReason") == "end_turn", "main session still serves after helpers")
        c.ok(ag.p.poll() is None, f"one kiro-claude process (pid {ag.p.pid}) served all")
        if not ctx.real:
            starts = stream_starts(fake_log(ws))
            c.ok(len({r['pid'] for r in starts}) == 5, "one fake-claude child per session (5)", str(len(starts)))
    finally:
        ag.close()
    c.done()


def _children(pid: int) -> list[int]:
    out = []
    for d in glob.glob("/proc/[0-9]*"):
        try:
            with open(f"{d}/stat") as f:
                st = f.read()
            if int(st.rsplit(") ", 1)[1].split()[1]) == pid:
                out.append(int(d.rsplit("/", 1)[1]))
        except (OSError, ValueError, IndexError):
            pass
    return out


def s11(ctx: Ctx) -> None:
    for how in ("eof", "sigterm"):
        c = Check(f"S11{'' if how == 'eof' else 't'}")
        ws, ag, sid, _ = opener(ctx, f"S11-{how}", "kc-chat", spec("kc-chat"))
        try:
            ag.new_session()
            ag.prompt(sid, words(ctx, "PING"))
            rid = ag.request_async("session/prompt", {"sessionId": sid, "prompt": [{"type": "text", "text": words(ctx, "SLOW")}]})
            ag.wait_for(lambda m: m.get("method") == "session/update" and (m["params"].get("update") or {}).get("sessionUpdate") == "agent_message_chunk"
                        and "Working" in json.dumps(m) if not ctx.real else True, 30)
            kids = _children(ag.p.pid)
            fake_pids = {r["pid"] for r in stream_starts(fake_log(ws))} if not ctx.real else set(kids)
            t0 = time.time()
            if how == "eof":
                ag.p.stdin.close()
            else:
                ag.p.send_signal(signal.SIGTERM)
            try:
                rc = ag.p.wait(10)
            except subprocess.TimeoutExpired:
                rc = None
            dt = time.time() - t0
            c.ok(rc is not None and dt <= 5.0, f"{how}: exit rc={rc} in {dt:.2f}s ≤ 5s")
            time.sleep(0.5)
            left = [p for p in fake_pids | set(kids) if pid_alive(p)]
            c.ok(fake_pids and not left, f"no Claude child left ({len(fake_pids)} started)", str(left))
            ag.reader.join(2)
            c.ok(not ag.bad_lines, "only frames on stdout", repr(ag.bad_lines[:2]))
            _ = rid
        finally:
            ag.kill()
            try:
                ag.wire.close()
            except ValueError:
                pass
        c.done()


def s12(ctx: Ctx) -> None:
    c = Check("S12")
    ws, ag, sid, _ = opener(ctx, "S12", "kc-tools", spec("kc-tools"))
    ag.permission_policy = "hold"
    try:
        # (a) steer while the tool waits for permission ⇒ queued, injected after the tool result
        rid = ag.request_async("session/prompt", {"sessionId": sid, "prompt": [{"type": "text", "text": words(ctx, "ECHO-STEER")}]})
        start = len(ag.frames)
        perm = ag.wait_permission(60)
        c.ok(perm is not None, "permission pending")
        steer_text = "KC-STEER-ALPHA also say hi"
        res, err, _ = ag.request("_session/steer", {"sessionId": sid, "message": steer_text})
        c.ok(err is None and (res or {}).get("queued") is True, "steer ⇒ {queued:true}", json.dumps(res or err))
        q = ag.wait_for(lambda m: m.get("method") == "_kiro.dev/session/update" and (m["params"].get("update") or {}).get("sessionUpdate") == "AgentExecutionUserMessageQueued", 5, start)
        c.ok(q is not None, "AgentExecutionUserMessageQueued")
        if perm:
            ag.answer_permission(perm, "allow_once")
        r, e, idx = ag.wait_response(rid, 120)
        c.ok((r or {}).get("stopReason") == "end_turn", "turn ends end_turn", json.dumps(r or e)[:150])
        upd_kinds = [((m.get("params") or {}).get("update") or {}).get("sessionUpdate") for m in ag.msgs(start, idx + 1)
                     if m.get("method") in ("session/update", "_kiro.dev/session/update")]
        inj = "AgentExecutionSteeringInjected" in upd_kinds
        c.ok(inj, "AgentExecutionSteeringInjected", json.dumps(upd_kinds)[:400])
        if inj:
            last_tool = max(i for i, k in enumerate(upd_kinds) if k == "tool_call_update")
            c.ok(upd_kinds.index("AgentExecutionSteeringInjected") > upd_kinds.index("AgentExecutionUserMessageQueued")
                 and upd_kinds.index("AgentExecutionSteeringInjected") > last_tool - 0, "Queued → tool result → Injected order")
        if not ctx.real:
            got = [r for r in fake_log(ws) if r.get("event") == "stdin" and "KC-STEER-ALPHA" in json.dumps(r.get("line"))]
            c.ok(bool(got) and (got[0].get("line") or {}).get("priority") == "next", "steer reached Claude with priority next",
                 json.dumps([(g.get("line") or {}).get("priority") for g in got]))
        # (b) steer then clear while the permission is pending ⇒ {cleared:true} + UserMessageCleared; never injected
        rid = ag.request_async("session/prompt", {"sessionId": sid, "prompt": [{"type": "text", "text": words(ctx, "ECHO-STEER")}]})
        start = len(ag.frames)
        perm = ag.wait_permission(60)
        res, err, _ = ag.request("_session/steer", {"sessionId": sid, "message": "KC-STEER-BRAVO drop me"})
        c.ok((res or {}).get("queued") is True, "second steer queued")
        res, err, _ = ag.request("_session/steer/clear", {"sessionId": sid})
        c.ok(err is None and (res or {}).get("cleared") is True, "steer/clear ⇒ {cleared:true}", json.dumps(res or err))
        cl = ag.wait_for(lambda m: m.get("method") == "_kiro.dev/session/update" and (m["params"].get("update") or {}).get("sessionUpdate") == "AgentExecutionUserMessageCleared", 5, start)
        c.ok(cl is not None, "AgentExecutionUserMessageCleared")
        if perm:
            ag.answer_permission(perm, "allow_once")
        r, e, idx = ag.wait_response(rid, 120)
        kinds_b = [((m.get("params") or {}).get("update") or {}).get("sessionUpdate") for m in ag.msgs(start, idx + 1)]
        c.ok((r or {}).get("stopReason") == "end_turn" and "AgentExecutionSteeringInjected" not in kinds_b, "cleared steer never injected; end_turn")
        if not ctx.real:
            c.ok(not any("KC-STEER-BRAVO" in json.dumps(r.get("line")) for r in fake_log(ws) if r.get("event") == "stdin"), "cleared steer never reached Claude")
    finally:
        ag.close()
    c.done()


def s13(ctx: Ctx) -> None:
    c = Check("S13")
    ws, ag, sid, _ = opener(ctx, "S13", "kc-zero", spec("kc-zero", tools=[], allowedTools=[], mcpServers={}))
    try:
        res, err, idx, start = ag.prompt(sid, words(ctx, "PING"))
        calls, upd, perm_i, _ = _tool_frames(ag, start)
        c.ok((res or {}).get("stopReason") == "end_turn" and not calls and not upd and perm_i is None, "zero-tools: no tool frames, no permission request")
        if not ctx.real:
            st = stream_starts(fake_log(ws))
            tv = argv_value(st[0]["argv"], "--tools") if st else None
            c.ok(tv == [""], "zero-tools: claude --tools \"\"", repr(tv))
            c.ok(st and "--strict-mcp-config" in st[0]["argv"] and not argv_value(st[0]["argv"], "--mcp-config"),
                 "zero-tools: no MCP config, --strict-mcp-config")
    finally:
        ag.close()
    c.done()
    c2 = Check("S13r")
    files = {"secret/token.txt": "TOP-SECRET-VALUE\n", "notes.txt": "public\n"}
    # fs_read is deliberately NOT in allowedTools. fs_read trusts the working directory, so the
    # in-cwd denied read (secret/) shows deniedPaths beating that trust; a read OUTSIDE the cwd
    # normally asks (control), so the outside denied read shows "refused before any permission".
    out = os.path.join(ctx.e2e, "s13r-outside")
    os.makedirs(out, exist_ok=True)
    for n_, t_ in (("secret.txt", "OUTSIDE-SECRET-VALUE\n"), ("public.txt", "outside public\n")):
        with open(os.path.join(out, n_), "w") as f:
            f.write(t_)
    sp = spec("kc-ro--readonly", tools=["fs_read", "grep", "glob"], allowedTools=["grep", "glob"],
              toolsSettings={"fs_read": {"deniedPaths": ["secret/**", os.path.join(ctx.e2e, "ws-s13r", "secret"), os.path.join(out, "secret.txt")]}})
    ws, ag, sid, _ = opener(ctx, "S13r", "kc-ro--readonly", sp, files, extra_env={"KC_S13R_OUT": out})
    try:
        res, err, idx, start = ag.prompt(sid, words(ctx, "READ-DENIED"), timeout=180)
        calls, upd, perm_i, _ = _tool_frames(ag, start)
        final = [u for u in upd if u.get("status") in ("completed", "failed")]
        c2.ok((res or {}).get("stopReason") == "end_turn", "end_turn", json.dumps(res or err)[:150])
        c2.ok(perm_i is None, "no permission request for the denied read (fs_read not pre-approved)")
        c2.ok(bool(final) and final[-1].get("status") == "failed", "read of a denied path ⇒ failed", json.dumps(final)[:300])
        c2.ok("TOP-SECRET-VALUE" not in json.dumps(ag.msgs(start)), "secret never on the wire")
        if not ctx.real:
            c2.ok(_deny_in_fake_log(ws), "Claude got a deny before the tool ran")
            # control 1: a non-denied read in the cwd completes without asking (cwd trust)
            res, err, idx, start = ag.prompt(sid, "READ-PUBLIC", timeout=60)
            _, upd2, perm2, _ = _tool_frames(ag, start)
            fin2 = [u for u in upd2 if u.get("status") in ("completed", "failed")]
            c2.ok(perm2 is None and fin2 and fin2[-1].get("status") == "completed", "control: a non-denied read in the cwd completes (cwd trust)",
                  f"perm={perm2 is not None} final={[u.get('status') for u in fin2]}")
            # control 2: a non-denied read OUTSIDE the cwd asks (answered allow_once) and completes
            res, err, idx, start = ag.prompt(sid, "READ-OUT-PUBLIC", timeout=60)
            _, upd3, perm3, _ = _tool_frames(ag, start)
            fin3 = [u for u in upd3 if u.get("status") in ("completed", "failed")]
            c2.ok(perm3 is not None and fin3 and fin3[-1].get("status") == "completed", "control: a non-denied read outside the cwd asks, then completes",
                  f"perm={perm3 is not None} final={[u.get('status') for u in fin3]}")
            # the denied file outside the cwd: refused BEFORE any permission request
            res, err, idx, start = ag.prompt(sid, "READ-OUT-DENIED", timeout=60)
            _, upd4, perm4, _ = _tool_frames(ag, start)
            fin4 = [u for u in upd4 if u.get("status") in ("completed", "failed")]
            c2.ok(perm4 is None and fin4 and fin4[-1].get("status") == "failed" and "OUTSIDE-SECRET-VALUE" not in json.dumps(ag.msgs(start)),
                  "denied read outside the cwd ⇒ failed with no permission request", f"perm={perm4 is not None} final={[u.get('status') for u in fin4]}")
    finally:
        ag.close()
    c2.done()


def s11f(ctx: Ctx) -> None:
    """KC-ACP-16: every frame stays under 10 MiB (tool output is truncated)."""
    c = Check("S11-frame")
    if ctx.real:
        return report("S11-frame", "SKIP", "needs a scripted 12 MiB tool result (stage B only)")
    ws = ctx.workspace("S11f", "kc-tools", spec("kc-tools", allowedTools=["fs_read", "execute_bash"]))
    big = os.path.join(ws, "big-script.json")
    with open(big, "w") as f:
        json.dump({"turns": [{"repeat": True, "match": "BIG", "steps": [
            {"tool": {"name": "Bash", "input": {"command": "yes kc | head -c 12582912", "description": "big"}, "result": "kc-big-" + ("x" * (12 * 1024 * 1024))}},
            {"text": "BIG-DONE"}]}]}, f)
    ag = Agent(ctx, "S11f", ws, "kc-tools", extra_env={"FAKE_CLAUDE_SCRIPT": big})
    longest = [0]
    orig = ag._log
    def sized(direction, obj, _o=orig):
        if direction == "in":
            longest[0] = max(longest[0], len(json.dumps(obj)))
        _o(direction, obj)
    ag._log = sized
    try:
        ag.initialize()
        r, e, _ = ag.new_session()
        sid = (r or {})["sessionId"]
        res, err, idx, start = ag.prompt(sid, "BIG", timeout=120)
        c.ok((res or {}).get("stopReason") == "end_turn" and "BIG-DONE" in ag.text(start, idx), "turn with a 12 MiB tool result ends end_turn", json.dumps(res or err)[:150])
        c.ok(0 < longest[0] < 10 * 1024 * 1024, f"largest frame {longest[0]} B < 10 MiB")
        c.ok(not ag.bad_lines, "only frames on stdout")
    finally:
        ag.close()
    c.done()


def s15(ctx: Ctx) -> None:
    """KC-SPEC-02 tool mapping with KiroCrew's real tool list (kirocrew.json / kirocrew-worker.json):
    execute_bash, fs_read, fs_write, grep, glob, web_fetch, web_search and tool_search map to Claude
    tools; code, introspect, session and report are ignored with a debug log only (no WARN)."""
    c = Check("S15")
    tools = ["execute_bash", "fs_read", "fs_write", "code", "grep", "glob", "web_fetch", "web_search", "introspect", "session", "report", "tool_search"]
    sp = spec("kc-map", tools=tools, allowedTools=["web_fetch", "web_search", "introspect", "session", "report", "tool_search"])
    ws, ag, sid, _ = opener(ctx, "S15", "kc-map", sp)
    try:
        res, err, _ = ag.request("_kiro.dev/commands/execute", {"sessionId": sid, "command": {"command": "tools", "args": {}}}, timeout=40)
        names = sorted({t.get("name") for t in ((res or {}).get("data") or {}).get("tools") or []})
        c.ok({"shell", "read", "write", "grep", "glob", "web_fetch", "web_search"} <= set(names), "/tools lists shell, read, write, grep, glob, web_fetch, web_search", json.dumps(names))
        c.ok("tool_search" in names, "/tools lists tool_search (KiroCrew's tool_search selection is honoured)", json.dumps(names))
        if not ctx.real:
            time.sleep(0.3)
            st = stream_starts(fake_log(ws))
            tv = ",".join(argv_value(st[0]["argv"], "--tools")) if st else ""
            want = {"Bash", "Read", "Glob", "Grep", "Write", "Edit", "WebFetch", "WebSearch"}
            c.ok(want <= set(tv.split(",")), "--tools has Bash, Read, Glob, Grep, Write, Edit, WebFetch, WebSearch", tv)
            c.ok("ToolSearch" in tv.split(","), "tool_search ⇒ --tools has ToolSearch", tv)
        log = ""
        try:
            log = open(os.path.join(ws, "kiro-chat.log"), encoding="utf-8", errors="replace").read()
        except OSError:
            pass
        warned = sorted(set(re.findall(r"WARN[^\n]*Tool '([a-z_]+)' in [a-zA-Z]+ is not available", log)))
        c.ok(not warned, "no WARN for KiroCrew's tool names (code/introspect/session/report are debug-only, tool_search maps)", f"WARN for {warned}")
    finally:
        ag.close()
    c.done()


def s16(ctx: Ctx) -> None:
    """KC-ACP-20 (P1, B): Claude's todo tools ⇒ kiro `todo_list` tool frames with the snapshot
    envelope, plus ACP `plan` updates."""
    c = Check("S16")
    if ctx.real:
        return report("S16", "SKIP", "scripted todo tools (stage B only)")
    ws, ag, sid, _ = opener(ctx, "S16", "kc-todo", spec("kc-todo", tools=["fs_read", "todo_list"], allowedTools=["fs_read", "todo_list"]))
    try:
        res, err, idx, start = ag.prompt(sid, "TODO-PLAN", timeout=60)
        c.ok((res or {}).get("stopReason") == "end_turn" and "TODO-DONE" in ag.text(start, idx), "end_turn + reply", json.dumps(res or err)[:150])
        calls, upd, perm_i, _ = _tool_frames(ag, start)
        names = [((u.get("_meta") or {}).get("kiro") or {}).get("toolName") for u in calls]
        c.ok(names and all(n == "todo_list" for n in names), "tool_call _meta.kiro.toolName todo_list", json.dumps(names))
        c.ok(perm_i is None, "no permission request (allowed)")
        fin = [u for u in upd if u.get("status") == "completed"]
        snap = json.dumps(fin[-1].get("rawOutput")) if fin else ""
        c.ok(fin and "kc todo one" in snap and "kc todo two" in snap, "completed todo_list rawOutput carries the todo snapshot", snap[:300])
        plans = ag.updates(start, idx, "plan")
        last = plans[-1].get("entries") if plans else []
        c.ok(bool(plans) and len(last or []) == 2 and any(e.get("status") == "completed" for e in last or []), "plan updates: 2 entries, one completed",
             json.dumps(last)[:300])
    finally:
        ag.close()
    c.done()


def s17(ctx: Ctx) -> None:
    """KC-ACP-21 (P1, B): a Claude subagent's inner tool calls are reported under the PARENT
    sessionId with _meta.claudeCode.parentToolUseId."""
    c = Check("S17")
    if ctx.real:
        return report("S17", "SKIP", "scripted subagent frames (stage B only)")
    ws, ag, sid, _ = opener(ctx, "S17", "kc-sub", spec("kc-sub", tools=["execute_bash", "fs_read", "subagent"], allowedTools=["execute_bash", "fs_read", "subagent"]))
    try:
        res, err, idx, start = ag.prompt(sid, "SUBAGENT-RUN", timeout=60)
        c.ok((res or {}).get("stopReason") == "end_turn" and "SUB-DONE" in ag.text(start, idx), "end_turn + reply", json.dumps(res or err)[:150])
        inner = []
        for m in ag.msgs(start, idx):
            if m.get("method") != "session/update":
                continue
            u = m["params"].get("update") or {}
            if u.get("sessionUpdate") == "tool_call" and ((u.get("_meta") or {}).get("claudeCode") or {}).get("parentToolUseId"):
                inner.append((m["params"].get("sessionId"), u))
        c.ok(bool(inner), "inner tool_call carries _meta.claudeCode.parentToolUseId",
             json.dumps([((u.get("_meta") or {})) for _, u in inner])[:300] or json.dumps([u.get("_meta") for u in ag.updates(start, idx, "tool_call")])[:300])
        c.ok(inner and all(s_ == sid for s_, _ in inner), "inner tool_call is under the parent sessionId")
        c.ok(inner and ((inner[0][1].get("_meta") or {}).get("claudeCode") or {}).get("parentToolUseId") == "toolu_kcparent01", "parentToolUseId names the Agent call")
    finally:
        ag.close()
    c.done()


def s18(ctx: Ctx) -> None:
    """KC-FS-06: the ACP log goes to $KIRO_CHAT_LOG_FILE in APPEND mode (an existing file is kept)
    and survives KiroCrew rotating it in place (truncate): later lines start at offset 0, with no
    NUL-filled hole (which a non-O_APPEND writer leaves after a truncation)."""
    c = Check("S18")
    ws = ctx.workspace("S18", "kc-log", spec("kc-log", tools=["fs_read", "@kc-dangling-a"]))
    with open(os.path.join(ws, ".kiro", "agents", "kc-log2.json"), "w") as f:
        json.dump(spec("kc-log2", tools=["fs_read", "@kc-dangling-b"]), f)
    logp = os.path.join(ws, "kiro-chat.log")
    with open(logp, "w") as f:
        f.write("KC-PRE-EXISTING-LINE\n")
    ag = Agent(ctx, "S18", ws, "kc-log")
    try:
        ag.initialize()
        r, e, _ = ag.new_session()
        sid = (r or {})["sessionId"]
        time.sleep(0.5)
        first = open(logp, "rb").read()
        c.ok(first.startswith(b"KC-PRE-EXISTING-LINE\n") and b"kc-dangling-a" in first, "appends to an existing log (kept the old line, then wrote the WARN)",
             f"{len(first)} B, starts {first[:40]!r}")
        with open(logp, "r+b") as f:  # KiroCrew-style in-place rotation
            f.truncate(0)
        ag.request("session/set_mode", {"sessionId": sid, "modeId": "kc-log2"}, timeout=30)
        time.sleep(0.8)
        after = open(logp, "rb").read()
        c.ok(after and not after.startswith(b"\0") and b"\0" not in after[:4096], "after an in-place truncation the next lines start at offset 0 (O_APPEND; no NUL hole)",
             f"{len(after)} B, starts {after[:24]!r}")
        c.ok(b"kc-dangling-b" in after, "logging continues after the rotation", f"{len(after)} B")
        c.ok(not ag.bad_lines, "nothing but frames on stdout")
    finally:
        ag.close()
    c.done()


def s14(ctx: Ctx) -> None:
    """Turn errors (08 KC-AUTH-04) and refusal (KC-ACP-19), stage B only (scripted by fake-claude)."""
    c = Check("S14")
    if ctx.real:
        return report("S14", "SKIP", "needs scripted Claude errors (stage B only)")
    ws, ag, sid, _ = opener(ctx, "S14", "kc-chat", spec("kc-chat"))
    try:
        res, err, idx, start = ag.prompt(sid, "AUTH-FAIL")
        c.ok(err is not None and err.get("code") == -32000 and "HTTP 401" in json.dumps(err), "KC-AUTH-04 auth failure ⇒ -32000 with HTTP 401",
             json.dumps(res or err)[:200])
        res, err, idx, start = ag.prompt(sid, "REFUSE")
        c.ok(err is None and (res or {}).get("stopReason") == "refusal", "KC-ACP-19 stopReason refusal", json.dumps(res or err)[:200])
        md = [m for m in ag.msgs(start, idx) if m.get("method") == "_kiro.dev/metadata" and (m.get("params") or {}).get("stopReason") == "CONTENT_FILTERED"]
        c.ok(bool(md) and isinstance(md[0]["params"].get("refusal"), dict), "_kiro.dev/metadata {stopReason:CONTENT_FILTERED, refusal{}} before the response",
             json.dumps(md[:1])[:200])
        r2, e2, i2, s2_ = ag.prompt(sid, "PING")
        c.ok((r2 or {}).get("stopReason") == "end_turn" and "PONG" in ag.text(s2_, i2), "session usable after errors")
    finally:
        ag.close()
    c.done()


SCENARIOS = {
    "S1": s1, "S2": s2, "S3": s3,
    "S4": lambda c: s4(c, "allow"), "S4r": lambda c: s4(c, "reject"), "S4b": lambda c: s4(c, "allowed"), "S4c": lambda c: s4(c, "cancel"),
    "S5": s5, "S6": s6, "S7": s7, "S8": s8, "S9": s9, "S10": s10, "S11": s11, "S11f": s11f, "S12": s12, "S13": s13, "S14": s14,
    "S15": s15, "S16": s16, "S17": s17, "S18": s18,
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bin", default=os.environ.get("SHIM"))
    ap.add_argument("--stage", default="B", choices=["B", "C"])
    ap.add_argument("--real", action="store_true")
    ap.add_argument("--out", default=None)
    ap.add_argument("--script", default=os.path.join(HERE, "fake-script.json"))
    ap.add_argument("only", nargs="*")
    a = ap.parse_args()
    a.real = a.real or a.stage == "C"
    if not a.bin:
        ap.error("--bin is required (or source env.sh for $SHIM)")
    if not a.out:
        a.out = os.path.join(os.environ.get("E2E", "."), "acp")
    os.makedirs(a.out, exist_ok=True)
    ctx = Ctx(a)
    names = a.only or list(SCENARIOS)
    for n in names:
        if n not in SCENARIOS:
            report(n, "FAIL", "unknown scenario")
            continue
        try:
            SCENARIOS[n](ctx)
        except Exception as e:  # noqa: BLE001 - one broken scenario must not hide the others
            report(n, "FAIL", f"harness exception {type(e).__name__}: {e}")
        finally:
            for p in ctx.procs:
                if p.poll() is None:
                    try:
                        os.killpg(p.pid, signal.SIGKILL)
                    except OSError:
                        pass
            ctx.procs.clear()
    return 1 if any(s == "FAIL" for _, s, _ in RESULTS) else 0


if __name__ == "__main__":
    sys.exit(main())

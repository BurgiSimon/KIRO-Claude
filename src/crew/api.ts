/**
 * Minimal authenticated client for a running KiroCrew gateway (08b §2.3; port of the verified
 * helpers `work/kc-build/tools/kc_api.py` and `kc_chat.py`, 08 §5.0).
 *
 * Auth: `GET /api/status?token=<JWT>` sets the cookies `mc_token_<port>` / `mc_refresh_<port>`;
 * every later call presents the cookies (some routes reject a re-presented link token). The
 * READY-line token (or `kirocrew token --port N`) is the credential; it is a secret and is never
 * logged here.
 *
 * Used by `crew status` (`/api/status`, `/api/kiro-prerequisite`, `/api/acp-backends`), `crew doctor`
 * D11, and by the KiroCrew e2e plan (§5: `chat()` = kc_chat.py, `request()` = kc_api.py).
 */
import * as http from 'node:http';

export interface HttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export type HttpFn = (req: HttpRequest) => Promise<HttpResponse>;

/** node:http implementation (loopback only; no proxies). */
export const defaultHttp: HttpFn = (req) =>
  new Promise((resolve, reject) => {
    const u = new URL(req.url);
    const r = http.request(
      {
        method: req.method,
        hostname: u.hostname,
        port: u.port,
        path: `${u.pathname}${u.search}`,
        headers: req.headers,
        timeout: req.timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    r.on('timeout', () => r.destroy(new Error(`request to ${u.pathname} timed out after ${req.timeoutMs} ms`)));
    r.on('error', reject);
    if (req.body !== undefined) r.write(req.body);
    r.end();
  });

export class GatewayAuthError extends Error {
  constructor(readonly status: number) {
    super(`the dashboard refused the token (HTTP ${status})`);
    this.name = 'GatewayAuthError';
  }
}

export interface ApiResult {
  status: number;
  json?: unknown;
  text: string;
}

export class GatewayClient {
  private cookies = new Map<string, string>();
  private readonly base: string;
  private readonly http: HttpFn;
  constructor(private readonly opts: { port: number; token: string; host?: string; http?: HttpFn; timeoutMs?: number }) {
    this.base = `http://${opts.host ?? '127.0.0.1'}:${opts.port}`;
    this.http = opts.http ?? defaultHttp;
  }

  private store(headers: HttpResponse['headers']): void {
    const raw = headers['set-cookie'];
    const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
    for (const c of list) {
      const first = c.split(';')[0] ?? '';
      const eq = first.indexOf('=');
      if (eq > 0) this.cookies.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
    }
  }

  private cookieHeader(): Record<string, string> {
    if (this.cookies.size === 0) return {};
    return { Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') };
  }

  private async send(method: string, pathAndQuery: string, body?: unknown, timeoutMs?: number): Promise<ApiResult> {
    const headers: Record<string, string> = { Accept: 'application/json', ...this.cookieHeader() };
    let data: string | undefined;
    if (body !== undefined) {
      data = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
    }
    const res = await this.http({ method, url: this.base + pathAndQuery, headers, body: data, timeoutMs: timeoutMs ?? this.opts.timeoutMs ?? 15_000 });
    this.store(res.headers);
    let json: unknown;
    try {
      json = res.body ? JSON.parse(res.body) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, json, text: res.body };
  }

  /** `GET /api/status?token=…` (mints the session cookies). Throws {@link GatewayAuthError} on 401/403. */
  async login(): Promise<ApiResult> {
    const r = await this.send('GET', `/api/status?token=${encodeURIComponent(this.opts.token)}`);
    if (r.status === 401 || r.status === 403) throw new GatewayAuthError(r.status);
    return r;
  }

  /** Any authenticated call (logs in first when no cookie is held yet). */
  async request(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<ApiResult> {
    if (this.cookies.size === 0) await this.login();
    return this.send(method, path, body, timeoutMs);
  }

  get(path: string): Promise<ApiResult> {
    return this.request('GET', path);
  }

  /**
   * One dashboard chat turn (kc_chat.py): creates a slot unless `slot` is given, POSTs
   * `/api/chat` and reads the SSE stream (`data: {...}` … `data: [DONE]`). Returns the last
   * `assistant` event's content.
   */
  async chat(message: string, opts: { slot?: string; agent?: string; timeoutMs?: number } = {}): Promise<{ slot: string; reply?: string; events: unknown[] }> {
    let slot = opts.slot;
    let agent = opts.agent;
    if (!slot) {
      const created = await this.request('POST', '/api/chat/slots', {});
      const j = created.json as { key?: unknown; agent?: unknown } | undefined;
      if (!j || typeof j.key !== 'string') throw new Error(`cannot create a chat slot (HTTP ${created.status})`);
      slot = j.key;
      if (!agent && typeof j.agent === 'string') agent = j.agent;
    }
    const body: Record<string, unknown> = { message, slot };
    if (agent) body.agent = agent;
    const r = await this.request('POST', '/api/chat', body, opts.timeoutMs ?? 600_000);
    const events = parseSse(r.text);
    let reply: string | undefined;
    for (const ev of events) {
      if (ev && typeof ev === 'object' && (ev as { type?: unknown }).type === 'assistant') {
        const c = (ev as { content?: unknown }).content;
        if (typeof c === 'string') reply = c;
      }
    }
    return { slot, reply, events };
  }
}

/** JSON payloads of `data: …` SSE lines up to `data: [DONE]`. */
export function parseSse(text: string): unknown[] {
  const out: unknown[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.startsWith('data: ')) continue;
    const data = raw.slice(6);
    if (data === '[DONE]') break;
    try {
      out.push(JSON.parse(data));
    } catch {
      // ignore non-JSON data lines
    }
  }
  return out;
}

/** `/api/kiro-prerequisite` fields crew looks at (08 KC-AUTH-01). */
export interface PrerequisiteSummary {
  installed: boolean;
  authenticated: boolean;
  ready: boolean;
  missingAgentSpecs: string[];
  rejectedAgentSpecs: string[];
}

export function summarizePrerequisite(j: unknown): PrerequisiteSummary | undefined {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return undefined;
  const o = j as Record<string, unknown>;
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  return {
    installed: o.installed === true,
    authenticated: o.authenticated === true,
    ready: o.ready === true,
    missingAgentSpecs: list(o.missing_agent_specs),
    rejectedAgentSpecs: list(o.rejected_agent_specs),
  };
}

/** Reasons a prerequisite summary is not ready (empty = ready). */
export function prerequisiteProblems(p: PrerequisiteSummary): string[] {
  const out: string[] = [];
  if (!p.installed) out.push('Kiro CLI (kiro-claude) not detected as installed');
  if (!p.authenticated) out.push('not signed in (whoami failed)');
  if (p.missingAgentSpecs.length) out.push(`missing agent specs: ${p.missingAgentSpecs.join(', ')}`);
  if (p.rejectedAgentSpecs.length) out.push(`rejected agent specs: ${p.rejectedAgentSpecs.join(', ')}`);
  if (!p.ready && out.length === 0) out.push('not ready');
  return out;
}

/** `/api/acp-backends` row for a backend id (`kiro`, `claude`, …). */
export function backendRow(j: unknown, id: string): Record<string, unknown> | undefined {
  const rows = j && typeof j === 'object' ? (j as { backends?: unknown }).backends : undefined;
  if (!Array.isArray(rows)) return undefined;
  return rows.find((r) => r && typeof r === 'object' && (r as { id?: unknown }).id === id) as Record<string, unknown> | undefined;
}

/** True when an acp-backends row reports the backend installed. */
export function backendInstalled(row: Record<string, unknown> | undefined): boolean {
  if (!row) return false;
  const v = row.installed;
  return v === true || (typeof v === 'string' && v.toLowerCase() === 'installed');
}

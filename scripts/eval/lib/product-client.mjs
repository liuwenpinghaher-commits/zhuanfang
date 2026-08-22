/**
 * Cookie-only Product API client. Never sends Authorization Bearer.
 * Journal records every HTTP call so tests can prove no write before probe pass.
 */
import { SESSION_COOKIE_NAME } from "./auth-client.mjs";

export function createProductClient({ apiBase, journal }) {
  const log = journal ?? { calls: [] };
  let cookie = "";

  function headers(extra = {}) {
    const h = { accept: "application/json", ...extra };
    if (cookie) h.cookie = `${SESSION_COOKIE_NAME}=${cookie}`;
    return h;
  }

  function record(method, path, status, kind) {
    log.calls.push({ method, path, status, kind, at: Date.now() });
  }

  async function request(method, path, body, { write, timeoutMs } = {}) {
    const url = `${apiBase}${path}`;
    const init = { method, headers: headers(body !== undefined ? { "content-type": "application/json" } : {}), signal: AbortSignal.timeout(timeoutMs ?? 300000) };
    if (body !== undefined) init.body = JSON.stringify(body);
    let res;
    try {
      res = await fetch(url, init);
    } catch (err) {
      record(method, path, 0, write ? "write" : "read");
      throw err;
    }
    record(method, path, res.status, write ? "write" : "read");
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }
    if (!res.ok) {
      const err = new Error(`${method} ${path} ${res.status}: ${text.slice(0, 240)}`);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    const setCookie = res.headers.get("set-cookie") ?? "";
    const m = setCookie.match(/zf_session=([^;]+)/);
    if (m) cookie = decodeURIComponent(m[1]);
    return json;
  }

  return {
    apiBase,
    journal: log,
    get cookie() {
      return cookie;
    },
    setCookie(value) {
      cookie = value;
    },
    writes() {
      return log.calls.filter((c) => c.kind === "write");
    },
    async login(username, password) {
      const json = await request("POST", "/api/auth/login", { username, password }, { write: false });
      if (!cookie) {
        throw new Error("login did not set zf_session");
      }
      return json;
    },
    async me() {
      const json = await request("GET", "/api/auth/me", undefined, { write: false });
      return json?.username ?? json?.user?.username ?? json?.name;
    },
    async getState() {
      return await request("GET", "/api/state", undefined, { write: false });
    },
    async health() {
      return await request("GET", "/api/health", undefined, { write: false });
    },
    async capabilities() {
      return await request("GET", "/api/system/capabilities", undefined, { write: false });
    },
    async putState(body) {
      return await request("PUT", "/api/state", body, { write: true });
    },
    async putOverlay(overlay) {
      const { applyOverlay } = await import("./fixtures.mjs");
      const stored = await this.getState();
      const body = applyOverlay(stored, overlay);
      return await this.putState(body);
    },
    async purgeAll() {
      return await request(
        "POST",
        "/api/state/purge",
        { confirm: "PURGE_PERSONAL_DATA", scope: "all" },
        { write: true }
      );
    },
    async createSession(payload) {
      return await request("POST", "/api/interview-sessions", payload, { write: true });
    },
    async postTurn(sessionId, content) {
      let lastErr;
      for (let attempt = 1; attempt <= 4; attempt++) {
        try {
          return await request("POST", `/api/interview-sessions/${sessionId}/turns`, { content }, { write: true });
        } catch (err) {
          lastErr = err;
          const empty = /empty content|追问生成失败/i.test(String(err?.message ?? ""));
          if (err?.status !== 502 || !empty || attempt === 4) throw err;
          await new Promise((r) => setTimeout(r, 1500 * attempt));
        }
      }
      throw lastErr;
    },
    async postControl(sessionId, action) {
      return await request("POST", `/api/interview-sessions/${sessionId}/control`, { action }, { write: true });
    },
    async endSession(sessionId, extra = {}) {
      let lastErr;
      for (let attempt = 1; attempt <= 4; attempt++) {
        try {
          return await request("POST", `/api/interview-sessions/${sessionId}/end`, extra, { write: true, timeoutMs: 520000 });
        } catch (err) {
          lastErr = err;
          const empty = /empty content|专访归档失败/i.test(String(err?.message ?? ""));
          if (err?.status !== 502 || !empty || attempt === 4) throw err;
          await new Promise((r) => setTimeout(r, 2000 * attempt));
        }
      }
      throw lastErr;
    },
    async interrupt(sessionId) {
      return await request("POST", `/api/interview-sessions/${sessionId}/interrupt`, {}, { write: true });
    },
    async rawMaterial(sessionId) {
      return await request("GET", `/api/sessions/${sessionId}/raw-material`, undefined, { write: false });
    },
    async approveMemory(id, payload = { mode: "add" }) {
      return await request("POST", `/api/memory-candidates/${id}/approve`, payload, { write: true });
    },
    async consolidateQueue() {
      return await request("POST", "/api/memory/consolidate", { mode: "queue" }, { write: true });
    },
    async resolveConflict(candidateId, payload) {
      return await request("POST", `/api/memory-candidates/${candidateId}/resolve-conflict`, payload, { write: true });
    }
  };
}

import { FormEvent, useState } from "react";
import { getProductApiBaseUrl } from "../../api/productApi";

export interface LoginPageProps {
  onSuccess: (username: string) => void;
}

/**
 * L1 human login: username + password → POST /api/auth/login (HttpOnly zf_session).
 * Does not paste PRODUCT_API_TOKEN.
 */
export function LoginPage({ onSuccess }: LoginPageProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const base = getProductApiBaseUrl().replace(/\/$/, "");
      const res = await fetch(`${base}/api/auth/login`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password })
      });
      if (!res.ok) {
        let msg = "用户名或密码错误";
        try {
          const body = (await res.json()) as { error?: string };
          if (body?.error) msg = body.error;
        } catch {
          /* */
        }
        setError(msg);
        return;
      }
      const body = (await res.json()) as { username?: string };
      onSuccess(body.username ?? username.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : "网络错误");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        background: "var(--bg, #0f1117)",
        color: "var(--fg, #e8eaed)",
        padding: 24
      }}
    >
      <form
        onSubmit={submit}
        style={{
          width: "100%",
          maxWidth: 360,
          display: "flex",
          flexDirection: "column",
          gap: 12,
          padding: 24,
          borderRadius: 12,
          background: "rgba(255,255,255,0.04)",
          border: "1px solid rgba(255,255,255,0.08)"
        }}
      >
        <h1 style={{ margin: 0, fontSize: 22 }}>专访登录</h1>
        <p style={{ margin: 0, opacity: 0.7, fontSize: 13, lineHeight: 1.5 }}>
          使用账号密码进入。会话由服务器 Cookie 维护，不会在浏览器保存共享 API 密钥。
        </p>
        <input
          name="username"
          autoComplete="username"
          placeholder="用户名"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          disabled={busy}
          style={{ padding: "10px 12px", borderRadius: 8, border: "1px solid #333", background: "#111", color: "inherit" }}
          autoFocus
        />
        <input
          type="password"
          name="password"
          autoComplete="current-password"
          placeholder="密码"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
          style={{ padding: "10px 12px", borderRadius: 8, border: "1px solid #333", background: "#111", color: "inherit" }}
        />
        {error ? (
          <div role="alert" style={{ color: "#f87171", fontSize: 13 }}>
            {error}
          </div>
        ) : null}
        <button
          type="submit"
          disabled={busy || !username.trim() || !password}
          style={{
            padding: "10px 12px",
            borderRadius: 8,
            border: "none",
            background: "#3b82f6",
            color: "#fff",
            fontWeight: 600,
            cursor: "pointer"
          }}
        >
          {busy ? "登录中…" : "登录"}
        </button>
      </form>
    </div>
  );
}

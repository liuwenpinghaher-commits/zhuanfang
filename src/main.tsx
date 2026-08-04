import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import { getProductApiBaseUrl } from "./api/productApi";
import { LoginPage } from "./features/auth/LoginPage";

type Gate = "checking" | "need_login" | "ok";

/**
 * Session-first gate: runtime-bootstrap reports authRequired/authenticated.
 * Does not set long-lived PRODUCT_API_TOKEN cookies as the primary browser path.
 */
async function resolveAuthGate(): Promise<Gate> {
  try {
    const base = getProductApiBaseUrl().replace(/\/$/, "");
    const res = await fetch(`${base}/api/runtime-bootstrap`, { credentials: "include" });
    if (!res.ok) return "ok"; // offline / old server — let App surface errors
    const body = (await res.json()) as {
      authRequired?: boolean;
      authenticated?: boolean;
    };
    if (body.authRequired && !body.authenticated) return "need_login";
    // If session mode claims authenticated, still verify /api/auth/me when present
    if (body.authRequired && body.authenticated) return "ok";
    if (body.authRequired) {
      // machine_token legacy: optional cookie already handled server-side; probe state
      const st = await fetch(`${base}/api/state`, { credentials: "include" });
      if (st.status === 401) return "need_login";
    }
    return "ok";
  } catch {
    return "ok";
  }
}

function Root() {
  const [gate, setGate] = React.useState<Gate>("checking");

  React.useEffect(() => {
    let cancelled = false;
    void resolveAuthGate().then((g) => {
      if (!cancelled) setGate(g);
    });
    const onAuthRequired = () => setGate("need_login");
    window.addEventListener("zf-auth-required", onAuthRequired);
    return () => {
      cancelled = true;
      window.removeEventListener("zf-auth-required", onAuthRequired);
    };
  }, []);

  if (gate === "checking") {
    return (
      <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", color: "#aaa" }}>
        加载中…
      </div>
    );
  }
  if (gate === "need_login") {
    return <LoginPage onSuccess={() => setGate("ok")} />;
  }
  return <App />;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);

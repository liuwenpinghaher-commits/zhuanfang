import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import { getProductApiBaseUrl } from "./api/productApi";
import { LoginPage } from "./features/auth/LoginPage";

type Gate = "checking" | "need_login" | "ok";
type BootstrapMode = "session" | "machine_token" | "open" | "unknown";

type GateResult = { gate: Gate; mode: BootstrapMode };

/**
 * Session-first gate: runtime-bootstrap reports authRequired/authenticated.
 * S17: bootstrap never mints long-lived PRODUCT_API_TOKEN cookies.
 * - mode=session → LoginPage when unauthenticated
 * - mode=machine_token / need_machine_token → matrix B (VITE_PRODUCT_API_TOKEN);
 *   do NOT force LoginPage (would deadlock without PRODUCT_AUTH_ENABLED users)
 */
async function resolveAuthGate(): Promise<GateResult> {
  try {
    const base = getProductApiBaseUrl().replace(/\/$/, "");
    const res = await fetch(`${base}/api/runtime-bootstrap`, { credentials: "include" });
    if (!res.ok) return { gate: "ok", mode: "unknown" }; // offline / old server — let App surface errors
    const body = (await res.json()) as {
      authRequired?: boolean;
      authenticated?: boolean;
      mode?: string;
      need_machine_token?: boolean;
      cookieSet?: boolean;
    };

    if (!body.authRequired) return { gate: "ok", mode: "open" };

    // Human session path: require username/password login.
    if (body.mode === "session") {
      return { gate: body.authenticated ? "ok" : "need_login", mode: "session" };
    }

    // Machine-token deploy (no session auth): never send user to LoginPage.
    // Matrix B — productApi attaches VITE_PRODUCT_API_TOKEN as Bearer; legacy cookie
    // still accepted server-side if present; bootstrap no longer mints cookies (S17).
    if (body.mode === "machine_token" || body.need_machine_token) {
      return { gate: "ok", mode: "machine_token" };
    }

    // Back-compat: older servers without mode field.
    if (body.authenticated) return { gate: "ok", mode: "unknown" };
    if (body.authRequired && body.authenticated === false) {
      return { gate: "need_login", mode: "session" };
    }
    return { gate: "ok", mode: "unknown" };
  } catch {
    return { gate: "ok", mode: "unknown" };
  }
}

function Root() {
  const [gate, setGate] = React.useState<Gate>("checking");
  const modeRef = React.useRef<BootstrapMode>("unknown");

  React.useEffect(() => {
    let cancelled = false;
    void resolveAuthGate().then((result) => {
      if (cancelled) return;
      modeRef.current = result.mode;
      setGate(result.gate);
    });
    const onAuthRequired = () => {
      // Machine-only deploys have no LoginPage path — avoid deadlock on 401.
      if (modeRef.current === "machine_token") return;
      setGate("need_login");
    };
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

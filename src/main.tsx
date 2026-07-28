import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import { getProductApiBaseUrl } from "./api/productApi";

/**
 * Establish HttpOnly session cookie for production auth without reading the
 * long-lived secret into browser JS (bootstrap body never contains the token).
 */
async function bootstrapAuthCookie(): Promise<void> {
  try {
    const base = getProductApiBaseUrl().replace(/\/$/, "");
    await fetch(`${base}/api/runtime-bootstrap`, { credentials: "include" });
  } catch {
    /* offline / local without server — fine */
  }
}

void bootstrapAuthCookie().finally(() => {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
});

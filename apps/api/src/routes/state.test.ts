import { describe, it, expect } from "vitest";
import { buildApiServer } from "../server";

describe("state routes", () => {
  it("rejects a stale whole-state PUT with 409 and returns the current state", async () => {
    const server = buildApiServer();
    const cur = (await server.inject({ method: "GET", url: "/api/state" })).json();
    // advance the server revision once (server bumps to cur.revision+1)
    await server.inject({ method: "PUT", url: "/api/state", payload: { ...cur, revision: cur.revision } });
    // now PUT again with the ORIGINAL (now-stale) revision -> rejected
    const stale = await server.inject({ method: "PUT", url: "/api/state", payload: { ...cur, revision: cur.revision } });
    expect(stale.statusCode).toBe(409);
    const body = stale.json();
    expect(body.current).toBeDefined();
    expect(body.current.revision).toBeGreaterThan(cur.revision);
    await server.close();
  });

  it("rejects a forged-future revision (N+5) with 409 — must-equal check (P1-18)", async () => {
    const server = buildApiServer();
    const cur = (await server.inject({ method: "GET", url: "/api/state" })).json();
    // client lies about revision being far ahead; old '<' logic would allow this
    const forged = await server.inject({
      method: "PUT",
      url: "/api/state",
      payload: { ...cur, revision: cur.revision + 5 },
    });
    expect(forged.statusCode).toBe(409);
    const body = forged.json();
    expect(body.current).toBeDefined();
    expect(body.current.revision).toBe(cur.revision);
    await server.close();
  });

  it("accepts a PUT with exactly the stored revision and increments to revision+1 (P1-18)", async () => {
    const server = buildApiServer();
    const cur = (await server.inject({ method: "GET", url: "/api/state" })).json();
    const res = await server.inject({
      method: "PUT",
      url: "/api/state",
      payload: { ...cur, revision: cur.revision },
    });
    expect(res.statusCode).toBe(200);
    const updated = res.json();
    expect(updated.revision).toBe(cur.revision + 1);
    await server.close();
  });
});

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
});

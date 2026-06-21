import { describe, it, expect } from "vitest";
import { buildApiServer } from "../server";
import { buildPrivacyReport } from "../../../../src/domain/privacy";
import { buildBackupRestoreRehearsalReport } from "../../../../src/domain/backup";
import { createInMemoryRawMaterialRepository } from "../raw-material-repository";
import { createInMemoryAudioRepository } from "../audio-repository";
import type { InterviewRawMaterial } from "../../../../src/domain/types";

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

  it("rejects a PUT with omitted revision field with 409 — absent revision cannot bypass lock (P1-18)", async () => {
    const server = buildApiServer();
    const cur = (await server.inject({ method: "GET", url: "/api/state" })).json();
    // Omit revision entirely; old code skipped the check and let it through
    const { revision: _omit, ...stateWithoutRevision } = cur as Record<string, unknown>;
    const res = await server.inject({
      method: "PUT",
      url: "/api/state",
      payload: stateWithoutRevision,
    });
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error).toContain("stale");
    expect(body.current).toBeDefined();
    expect(body.current.revision).toBe(cur.revision);
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

  describe("data governance endpoints (P0-1, P0-2, P0-3)", () => {
    it("GET /api/state/privacy-report returns 200 with inventory array (P0-1)", async () => {
      const server = buildApiServer();
      const res = await server.inject({ method: "GET", url: "/api/state/privacy-report" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // Must match buildPrivacyReport structure
      expect(body.inventory).toBeDefined();
      expect(Array.isArray(body.inventory)).toBe(true);
      expect(body.inventory.length).toBeGreaterThan(0);
      expect(body.generatedAt).toBeDefined();
      expect(typeof body.totalRecords).toBe("number");
      expect(typeof body.hasPersonalData).toBe("boolean");
      expect(body.operations).toBeDefined();
      await server.close();
    });

    it("GET /api/state/export returns 200 with backup rehearsal structure (P0-2)", async () => {
      const server = buildApiServer();
      const res = await server.inject({ method: "GET", url: "/api/state/export" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // Must match buildBackupRestoreRehearsalReport structure
      expect(body.schemaVersion).toBe(1);
      expect(body.strategy).toBe("json-export-import-rehearsal");
      expect(body.generatedAt).toBeDefined();
      expect(body.package).toBeDefined();
      expect(body.privacyReport).toBeDefined();
      expect(Array.isArray(body.checks)).toBe(true);
      await server.close();
    });

    it("POST /api/state/purge returns 200 and subsequent GET /api/state reflects purged state (P0-3)", async () => {
      const server = buildApiServer();
      // Seed some data first so purge has something to clear
      const cur = (await server.inject({ method: "GET", url: "/api/state" })).json();
      const purgeRes = await server.inject({
        method: "POST",
        url: "/api/state/purge",
        payload: { confirm: "PURGE_PERSONAL_DATA" }
      });
      expect(purgeRes.statusCode).toBe(200);
      const purgeBody = purgeRes.json();
      // createPurgedProductState clears all arrays and resets profile
      expect(purgeBody.sessions).toBeDefined();
      expect(Array.isArray(purgeBody.sessions)).toBe(true);
      expect(purgeBody.sessions.length).toBe(0);
      expect(purgeBody.notes.length).toBe(0);
      expect(purgeBody.points.length).toBe(0);
      // auditEvents has exactly one purge event
      expect(purgeBody.auditEvents.length).toBe(1);
      expect(purgeBody.auditEvents[0].type).toBe("privacy_data_purged");
      // Subsequent GET reflects persisted purge
      const afterGet = (await server.inject({ method: "GET", url: "/api/state" })).json();
      expect(afterGet.sessions.length).toBe(0);
      expect(afterGet.auditEvents.length).toBe(1);
      expect(afterGet.auditEvents[0].type).toBe("privacy_data_purged");
      await server.close();
    });
  });

  describe("destructive-endpoint confirm guards (P0-B)", () => {
    it("POST /api/state/purge without confirm returns 422 and does NOT mutate state", async () => {
      const server = buildApiServer();
      const before = (await server.inject({ method: "GET", url: "/api/state" })).json();
      const res = await server.inject({ method: "POST", url: "/api/state/purge" });
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toContain("PURGE_PERSONAL_DATA");
      // state untouched — sessions still present, no purge audit event written
      const after = (await server.inject({ method: "GET", url: "/api/state" })).json();
      expect(after.sessions.length).toBe(before.sessions.length);
      expect((after.auditEvents ?? []).some((e: { type: string }) => e.type === "privacy_data_purged")).toBe(false);
      await server.close();
    });

    it("POST /api/state/purge with wrong confirm token returns 422", async () => {
      const server = buildApiServer();
      const res = await server.inject({
        method: "POST",
        url: "/api/state/purge",
        payload: { confirm: "yes" }
      });
      expect(res.statusCode).toBe(422);
      await server.close();
    });

    it("POST /api/state/import without confirm returns 422 and does NOT overwrite state", async () => {
      const server = buildApiServer();
      const before = (await server.inject({ method: "GET", url: "/api/state" })).json();
      const res = await server.inject({
        method: "POST",
        url: "/api/state/import",
        payload: { state: { ...before, profile: { ...before.profile, name: "Overwritten" } } }
      });
      expect(res.statusCode).toBe(422);
      const after = (await server.inject({ method: "GET", url: "/api/state" })).json();
      expect(after.profile.name).toBe(before.profile.name);
      await server.close();
    });

    it("POST /api/state/purge with scope=profile clears only the profile and reports deletedScope+deletedCount", async () => {
      const server = buildApiServer();
      const before = (await server.inject({ method: "GET", url: "/api/state" })).json();
      // seed guarantees a populated profile + assets to delete-around
      expect(before.profile.name).not.toBe("");
      const pointsBefore = before.points.length;
      const res = await server.inject({
        method: "POST",
        url: "/api/state/purge",
        payload: { confirm: "PURGE_PERSONAL_DATA", scope: "profile" }
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.deletedScope).toBe("profile");
      expect(typeof body.deletedCount).toBe("number");
      const after = (await server.inject({ method: "GET", url: "/api/state" })).json();
      expect(after.profile.name).toBe(""); // profile wiped
      expect(after.points.length).toBe(pointsBefore); // assets preserved (scoped, not全量)
      await server.close();
    });

    it("POST /api/state/purge with an unknown scope returns 422 and does NOT mutate state", async () => {
      const server = buildApiServer();
      const before = (await server.inject({ method: "GET", url: "/api/state" })).json();
      const res = await server.inject({
        method: "POST",
        url: "/api/state/purge",
        payload: { confirm: "PURGE_PERSONAL_DATA", scope: "everything" }
      });
      expect(res.statusCode).toBe(422);
      const after = (await server.inject({ method: "GET", url: "/api/state" })).json();
      expect(after.profile.name).toBe(before.profile.name);
      await server.close();
    });

    it("POST /api/state/purge with scope omitted defaults to a full wipe (deletedScope=all)", async () => {
      const server = buildApiServer();
      const res = await server.inject({
        method: "POST",
        url: "/api/state/purge",
        payload: { confirm: "PURGE_PERSONAL_DATA" }
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.deletedScope).toBe("all");
      expect(body.sessions.length).toBe(0);
      expect(body.points.length).toBe(0);
      await server.close();
    });

    it("POST /api/state/import with confirm=REPLACE_ALL_STATE overwrites state (200)", async () => {
      const server = buildApiServer();
      const before = (await server.inject({ method: "GET", url: "/api/state" })).json();
      const res = await server.inject({
        method: "POST",
        url: "/api/state/import",
        payload: {
          confirm: "REPLACE_ALL_STATE",
          state: { ...before, profile: { ...before.profile, name: "Imported" } }
        }
      });
      expect(res.statusCode).toBe(200);
      const after = (await server.inject({ method: "GET", url: "/api/state" })).json();
      expect(after.profile.name).toBe("Imported");
      // import is recorded as an audit event (state_imported)
      expect((after.auditEvents ?? []).some((e: { type: string }) => e.type === "state_imported")).toBe(true);
      await server.close();
    });
  });

  describe("cold-layer raw material in export/import/purge (Task 13)", () => {
    const sampleMaterial = (sessionId: string): InterviewRawMaterial => ({
      sessionId,
      turns: [
        {
          id: `${sessionId}-t1`,
          role: "assistant",
          content: "你最近在想什么？",
          intent: "open",
          timestamp: "2026-06-20T00:00:00.000Z"
        },
        {
          id: `${sessionId}-t2`,
          role: "user",
          content: "在想冷层材料的隐私闭环。",
          intent: "answer",
          timestamp: "2026-06-20T00:00:05.000Z"
        }
      ],
      strategyTrace: [],
      createdAt: "2026-06-20T00:00:10.000Z"
    });

    it("purge(all) 清空冷层 raw material", async () => {
      const rawRepo = createInMemoryRawMaterialRepository();
      rawRepo.put(sampleMaterial("cold-session-1"));
      expect(rawRepo.get("cold-session-1")).toBeDefined();

      const server = buildApiServer({ rawMaterialRepository: rawRepo });
      const purgeRes = await server.inject({
        method: "POST",
        url: "/api/state/purge",
        payload: { confirm: "PURGE_PERSONAL_DATA" }
      });
      expect(purgeRes.statusCode).toBe(200);
      // Cold layer wiped
      expect(rawRepo.get("cold-session-1")).toBeUndefined();
      await server.close();
    });

    it("export 打包冷层原始材料，可经 import 恢复", async () => {
      const rawRepo = createInMemoryRawMaterialRepository();
      rawRepo.put(sampleMaterial("cold-session-A"));

      const server = buildApiServer({ rawMaterialRepository: rawRepo });
      const exportRes = await server.inject({ method: "GET", url: "/api/state/export" });
      expect(exportRes.statusCode).toBe(200);
      const body = exportRes.json();
      // Export package carries the cold-layer raw materials
      expect(Array.isArray(body.rawMaterials)).toBe(true);
      const exported = body.rawMaterials.find(
        (m: InterviewRawMaterial) => m.sessionId === "cold-session-A"
      );
      expect(exported).toBeDefined();
      expect(exported.turns.length).toBe(2);

      // Import into a fresh server's cold layer restores the raw material
      const freshRepo = createInMemoryRawMaterialRepository();
      const freshServer = buildApiServer({ rawMaterialRepository: freshRepo });
      const importRes = await freshServer.inject({
        method: "POST",
        url: "/api/state/import",
        payload: { confirm: "REPLACE_ALL_STATE", ...body }
      });
      expect(importRes.statusCode).toBe(200);
      expect(freshRepo.get("cold-session-A")).toBeDefined();
      expect(freshRepo.get("cold-session-A")?.turns.length).toBe(2);
      await freshServer.close();
      await server.close();
    });
  });

  describe("audio in export/purge (Task 4 — 隐私闭环)", () => {
    it("purge(all) 清空音频", async () => {
      const audioRepo = createInMemoryAudioRepository();
      audioRepo.put({
        sessionId: "a1",
        audio: new Uint8Array([1]),
        mime: "audio/webm",
        byteSize: 1,
        createdAt: "2026-06-20T00:00:00.000Z"
      });
      expect(audioRepo.has("a1")).toBe(true);

      const server = buildApiServer({ audioRepository: audioRepo });
      const purgeRes = await server.inject({
        method: "POST",
        url: "/api/state/purge",
        payload: { confirm: "PURGE_PERSONAL_DATA" }
      });
      expect(purgeRes.statusCode).toBe(200);
      // Audio wiped along with the full purge
      expect(audioRepo.has("a1")).toBe(false);
      await server.close();
    });

    it("export 记录有音频会话", async () => {
      const audioRepo = createInMemoryAudioRepository();
      audioRepo.put({
        sessionId: "a1",
        audio: new Uint8Array([1]),
        mime: "audio/webm",
        byteSize: 1,
        createdAt: "2026-06-20T00:00:00.000Z"
      });

      const server = buildApiServer({ audioRepository: audioRepo });
      const exportRes = await server.inject({ method: "GET", url: "/api/state/export" });
      expect(exportRes.statusCode).toBe(200);
      const body = exportRes.json();
      expect(Array.isArray(body.audioSessions)).toBe(true);
      expect(body.audioSessions).toContain("a1");
      await server.close();
    });
  });
});

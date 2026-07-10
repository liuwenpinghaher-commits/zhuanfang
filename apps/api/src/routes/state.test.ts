import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { buildApiServer } from "../server";
import { registerStateRoutes } from "./state";
import { createInMemoryProductStateRepository } from "../product-state-repository";
import { buildPrivacyReport } from "../../../../src/domain/privacy";
import { buildBackupRestoreRehearsalReport } from "../../../../src/domain/backup";
import { createInMemoryRawMaterialRepository } from "../raw-material-repository";
import { createInMemoryAudioRepository } from "../audio-repository";
import { createInMemoryKnowledgeIndexRepository } from "../knowledge-index-repository";
import type { InterviewAudio, InterviewRawMaterial, ProductState } from "../../../../src/domain/types";

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
      // F-06:真实 StateExportBundle 必须在 API 层自证完整性与最终响应字节数。
      expect(body.bundleDigest).toMatch(/^fnv1a-[a-f0-9]{8}$/);
      expect(body.completeness).toMatchObject({
        status: "complete",
        complete: true,
        directlyImportable: true,
        omittedAudioSessions: 0
      });
      expect(body.importCompatibility.bytes).toBe(Buffer.byteLength(res.body));
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

    it("POST /api/state/reset without confirm returns 422 and does NOT mutate state", async () => {
      const server = buildApiServer();
      const before = (await server.inject({ method: "GET", url: "/api/state" })).json();
      const res = await server.inject({ method: "POST", url: "/api/state/reset" });
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toContain("RESET_ALL_DATA");
      const after = (await server.inject({ method: "GET", url: "/api/state" })).json();
      expect(after.profile.name).toBe(before.profile.name);
      expect(after.points.length).toBe(before.points.length);
      expect(after.notes.length).toBe(before.notes.length);
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
          // 审计修复 F-04:裸 state(legacy 包)现在必须显式声明冷层去向,否则 422。
          coldLayerMode: "preserve-cold",
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

    it("R4-1:import 含非法 rawMaterial(缺 turns)→ 422 且旧冷层不丢(build-then-swap 先校验后交换)", async () => {
      const rawRepo = createInMemoryRawMaterialRepository();
      rawRepo.put(sampleMaterial("existing-cold"));
      const server = buildApiServer({ rawMaterialRepository: rawRepo });
      const cur = (await server.inject({ method: "GET", url: "/api/state" })).json();
      // 非法包:一条 rawMaterial 缺 turns(node:sqlite put 会抛)。若"先 deleteAll 再逐条 put",中途抛错则
      // 旧冷层已清空未恢复=数据丢失(比不清更糟)。build-then-swap 必须在 deleteAll 前 422 挡住坏数据。
      const res = await server.inject({
        method: "POST",
        url: "/api/state/import",
        payload: {
          confirm: "REPLACE_ALL_STATE",
          state: { ...cur, profile: { ...cur.profile, name: "SHOULD_NOT_APPLY_AFTER_422" } },
          rawMaterials: [{ sessionId: "bad", createdAt: "2026-06-27T00:00:00.000Z" }],
          // F-04:完整包要求 rawMaterials+audios 同时在场(半截包会走另一条 422),
          // 补空 audios 让本测试仍精确命中"非法 rawMaterial 条目"的校验路径。
          audios: []
        }
      });
      expect(res.statusCode).toBe(422);
      expect(rawRepo.get("existing-cold")?.turns.length).toBe(2);   // 旧冷层数据完好,未被清空
      const after = (await server.inject({ method: "GET", url: "/api/state" })).json();
      expect(after.profile.name).toBe(cur.profile.name);
      await server.close();
    });

    it("R4-2:reset 清冷层 raw material(重置即三库同清,索引/冷层不残留可召回私密)", async () => {
      const rawRepo = createInMemoryRawMaterialRepository();
      rawRepo.put(sampleMaterial("reset-cold"));
      expect(rawRepo.get("reset-cold")).toBeDefined();
      const server = buildApiServer({ rawMaterialRepository: rawRepo });
      const res = await server.inject({
        method: "POST",
        url: "/api/state/reset",
        payload: { confirm: "RESET_ALL_DATA" }
      });
      expect(res.statusCode).toBe(200);
      expect(rawRepo.get("reset-cold")).toBeUndefined();   // 冷层被清
      await server.close();
    });

    // 审计修复 F-04:本测试原契约是"冷层失败 → 500 且热态不动"。但故障注入实测第二个库
    // 失败时第一个库已删,前序删除无法恢复——"热态未变"的响应语义与实际不符,重试也拿不回
    // 已删的库。新契约:purge 是隐私删除,删除最大化——热态无论冷层成败都提交,失败以
    // 500 + purgeReceipt 如实回执(细粒度矩阵见下方 "F-04: purge 冷层尽力而为" describe)。
    it("purge(all) 冷层清理失败 → 500 + purgeReceipt,但热态仍已清(隐私删除最大化)", async () => {
      const rawRepo = {
        ...createInMemoryRawMaterialRepository(),
        deleteAll: () => {
          throw new Error("simulated raw delete failure");
        }
      };
      const server = buildApiServer({ rawMaterialRepository: rawRepo });
      const res = await server.inject({
        method: "POST",
        url: "/api/state/purge",
        payload: { confirm: "PURGE_PERSONAL_DATA" }
      });
      expect(res.statusCode).toBe(500);
      const body = res.json();
      expect(body.purgeReceipt.partialFailure).toBe(true);
      expect(body.purgeReceipt.stores["raw-material"]).toMatch(/^failed: /);
      // 热态已清空并随 body 带回(前端可采纳),GET 复核落库。
      expect(body.state.profile.name).toBe("");
      const after = (await server.inject({ method: "GET", url: "/api/state" })).json();
      expect(after.profile.name).toBe("");
      expect(after.sessions.length).toBe(0);
      await server.close();
    });
  });

  describe("F-03: reset 冷层清理失败不再假 200(部分失败 → 500 + resetReceipt)", () => {
    // 故障注入:包一层让 deleteAll 抛错,模拟 sqlite IO 故障。
    const failing = <T extends { deleteAll: () => void }>(repo: T): T => ({
      ...repo,
      deleteAll: () => {
        throw new Error("simulated cold-layer delete failure");
      }
    });

    // fail=true 时包上故障注入。条件包装让"哪个库坏"由参数决定,三库类型各自保持精确,
    // 无需对联合键索引做任何类型断言(as never / as 联合都不诚实)。
    const maybeFailing = <T extends { deleteAll: () => void }>(repo: T, fail: boolean): T =>
      fail ? failing(repo) : repo;

    const buildRepos = (failStore?: "raw-material" | "audio" | "knowledge-index") => ({
      rawMaterialRepository: maybeFailing(createInMemoryRawMaterialRepository(), failStore === "raw-material"),
      audioRepository: maybeFailing(createInMemoryAudioRepository(), failStore === "audio"),
      knowledgeIndexRepository: maybeFailing(createInMemoryKnowledgeIndexRepository(), failStore === "knowledge-index")
    });

    it.each(["raw-material", "audio", "knowledge-index"] as const)(
      "%s deleteAll 抛错 → 500 + resetReceipt 标记该库 failed,其余库仍被清,热态已重置",
      async (storeName) => {
        const server = buildApiServer(buildRepos(storeName));
        // 先污染热态,证明 reset 后热态确实被清(空基底 profile.name 为空)。
        const cur = (await server.inject({ method: "GET", url: "/api/state" })).json();
        await server.inject({
          method: "PUT",
          url: "/api/state",
          payload: { ...cur, revision: cur.revision, profile: { ...cur.profile, name: "WillBeReset" } }
        });
        const res = await server.inject({
          method: "POST",
          url: "/api/state/reset",
          payload: { confirm: "RESET_ALL_DATA" }
        });
        // 冷层删除失败绝不再无条件 200——用户必须知道私密数据仍残留。
        expect(res.statusCode).toBe(500);
        const body = res.json();
        expect(body.error).toContain("reset partial failure");
        expect(body.error).toContain(storeName);
        expect(body.resetReceipt.partialFailure).toBe(true);
        expect(body.resetReceipt.stores[storeName]).toMatch(/^failed: /);
        // 其余两库仍被尽力清空(一库失败不挡其余库)。
        for (const other of ["raw-material", "audio", "knowledge-index"].filter(n => n !== storeName)) {
          expect(body.resetReceipt.stores[other]).toBe("cleared");
        }
        // 热态已重置并随响应带回(前端可采纳),GET 也确认已清。
        expect(body.state).toBeDefined();
        expect(body.state.profile.name).not.toBe("WillBeReset");
        const after = (await server.inject({ method: "GET", url: "/api/state" })).json();
        expect(after.profile.name).not.toBe("WillBeReset");
        expect(after.sessions.length).toBe(0);
        await server.close();
      }
    );

    it("三库全部清理成功 → 200 + resetReceipt 全 cleared 且 partialFailure=false", async () => {
      const server = buildApiServer(buildRepos());
      const res = await server.inject({
        method: "POST",
        url: "/api/state/reset",
        payload: { confirm: "RESET_ALL_DATA" }
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.resetReceipt.partialFailure).toBe(false);
      expect(body.resetReceipt.stores).toEqual({
        "raw-material": "cleared",
        audio: "cleared",
        "knowledge-index": "cleared"
      });
      await server.close();
    });

    it("三库未注入(嵌入式/测试场景)→ 200,not-configured 不算失败", async () => {
      // buildApiServer 会默认注入三库,not-configured 只在直接注册路由且不传 repo 时出现。
      const server = Fastify();
      await registerStateRoutes(server, createInMemoryProductStateRepository());
      const res = await server.inject({
        method: "POST",
        url: "/api/state/reset",
        payload: { confirm: "RESET_ALL_DATA" }
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.resetReceipt.partialFailure).toBe(false);
      expect(body.resetReceipt.stores).toEqual({
        "raw-material": "not-configured",
        audio: "not-configured",
        "knowledge-index": "not-configured"
      });
      await server.close();
    });
  });

  describe("audio in export/purge (Task 4 — 隐私闭环)", () => {
    it("purge(all) 清空音频", async () => {
      const audioRepo = createInMemoryAudioRepository();
      audioRepo.put({
        sessionId: "a1",
        role: "interviewee",
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
        role: "interviewee",
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

  describe("知识索引 in purge (Task 12 — 隐私闭环)", () => {
    it("purge(all) 清空知识索引", async () => {
      const knowledgeIndexRepository = createInMemoryKnowledgeIndexRepository();
      knowledgeIndexRepository.put({
        id: "k1",
        sourceType: "transcript",
        sourceId: "s1",
        title: "片段标题",
        text: "片段正文",
        keywords: ["关键词"],
        createdAt: "2026-06-21T00:00:00.000Z"
      });
      expect(knowledgeIndexRepository.listAll().length).toBe(1);

      const server = buildApiServer({ knowledgeIndexRepository });
      const purgeRes = await server.inject({
        method: "POST",
        url: "/api/state/purge",
        payload: { confirm: "PURGE_PERSONAL_DATA" }
      });
      expect(purgeRes.statusCode).toBe(200);
      // 知识索引随全量 purge 一并清空（它是派生、可重建的)
      expect(knowledgeIndexRepository.listAll().length).toBe(0);
      await server.close();
    });
  });

  describe("audio bytes in export/import (导出含音频可恢复)", () => {
    it("export 打包音频且可经 import 恢复", async () => {
      const audioRepo = createInMemoryAudioRepository();
      audioRepo.put({
        sessionId: "a1",
        role: "interviewee",
        audio: new Uint8Array([1, 2, 3]),
        mime: "audio/webm",
        byteSize: 3,
        durationMs: 500,
        recordingStartedAt: "2026-06-21T10:00:00.000Z",
        createdAt: "2026-06-21T10:00:01.000Z"
      });

      const server = buildApiServer({ audioRepository: audioRepo });
      const exportRes = await server.inject({ method: "GET", url: "/api/state/export" });
      expect(exportRes.statusCode).toBe(200);
      const body = exportRes.json();

      expect(Array.isArray(body.audios)).toBe(true);
      const packed = body.audios.find((a: { sessionId: string }) => a.sessionId === "a1");
      expect(packed).toBeDefined();
      expect(packed.mime).toBe("audio/webm");
      expect(packed.durationMs).toBe(500);
      expect(packed.recordingStartedAt).toBe("2026-06-21T10:00:00.000Z");
      // base64 round-trip is byte-exact
      expect(Array.from(Buffer.from(packed.audioBase64, "base64"))).toEqual([1, 2, 3]);
      // The full list of audio-bearing sessions is preserved alongside the packed subset
      expect(body.audioSessions).toContain("a1");

      // Import the whole export package into a fresh server's audio repo
      const freshAudioRepo = createInMemoryAudioRepository();
      const freshServer = buildApiServer({ audioRepository: freshAudioRepo });
      const importRes = await freshServer.inject({
        method: "POST",
        url: "/api/state/import",
        payload: { confirm: "REPLACE_ALL_STATE", ...body }
      });
      expect(importRes.statusCode).toBe(200);

      const restored = freshAudioRepo.get("a1");
      expect(restored).toBeDefined();
      expect(Array.from(restored!.audio)).toEqual([1, 2, 3]);
      expect(restored!.mime).toBe("audio/webm");
      expect(restored!.byteSize).toBe(3);
      expect(restored!.durationMs).toBe(500);
      expect(restored!.recordingStartedAt).toBe("2026-06-21T10:00:00.000Z");
      await freshServer.close();
      await server.close();
    });

    it("两路 role 都被导出且经 import 恢复", async () => {
      const audioRepo = createInMemoryAudioRepository();
      audioRepo.put({
        sessionId: "s1",
        role: "interviewee",
        audio: new Uint8Array([1, 1]),
        mime: "audio/webm",
        byteSize: 2,
        createdAt: "2026-06-21T10:00:00.000Z"
      });
      audioRepo.put({
        sessionId: "s1",
        role: "interviewer",
        audio: new Uint8Array([2, 2, 2]),
        mime: "audio/webm",
        byteSize: 3,
        createdAt: "2026-06-21T10:00:01.000Z"
      });

      const server = buildApiServer({ audioRepository: audioRepo });
      const body = (await server.inject({ method: "GET", url: "/api/state/export" })).json();
      const roles = body.audios
        .filter((a: { sessionId: string }) => a.sessionId === "s1")
        .map((a: { role: string }) => a.role)
        .sort();
      expect(roles).toEqual(["interviewee", "interviewer"]);
      // 同一 session 两路, audioSessions 去重为一条
      expect(body.audioSessions.filter((s: string) => s === "s1").length).toBe(1);

      const freshAudioRepo = createInMemoryAudioRepository();
      const freshServer = buildApiServer({ audioRepository: freshAudioRepo });
      await freshServer.inject({
        method: "POST",
        url: "/api/state/import",
        payload: { confirm: "REPLACE_ALL_STATE", ...body }
      });
      expect(Array.from(freshAudioRepo.get("s1", "interviewee")!.audio)).toEqual([1, 1]);
      expect(Array.from(freshAudioRepo.get("s1", "interviewer")!.audio)).toEqual([2, 2, 2]);
      await freshServer.close();
      await server.close();
    });

    it("base64 往返字节精确(含 0/255 边界)", async () => {
      const audioRepo = createInMemoryAudioRepository();
      const bytes = new Uint8Array([0, 1, 127, 128, 254, 255]);
      audioRepo.put({
        sessionId: "edge",
        role: "interviewee",
        audio: bytes,
        mime: "audio/webm",
        byteSize: bytes.byteLength,
        createdAt: "2026-06-21T10:00:00.000Z"
      });

      const server = buildApiServer({ audioRepository: audioRepo });
      const body = (await server.inject({ method: "GET", url: "/api/state/export" })).json();
      const freshAudioRepo = createInMemoryAudioRepository();
      const freshServer = buildApiServer({ audioRepository: freshAudioRepo });
      await freshServer.inject({
        method: "POST",
        url: "/api/state/import",
        payload: { confirm: "REPLACE_ALL_STATE", ...body }
      });
      expect(Array.from(freshAudioRepo.get("edge")!.audio)).toEqual([0, 1, 127, 128, 254, 255]);
      await freshServer.close();
      await server.close();
    });

    it("超额音频被省略并记入 audioOmittedSessions", async () => {
      const audioRepo = createInMemoryAudioRepository();
      // Two ~10MB blobs. base64 inflates by 4/3, so the first (~13.3MB) fits under the
      // 18MB budget but the second pushes the running total over it and is omitted.
      const tenMB = 10 * 1024 * 1024;
      audioRepo.put({
        sessionId: "big-1",
        role: "interviewee",
        audio: new Uint8Array(tenMB),
        mime: "audio/webm",
        byteSize: tenMB,
        createdAt: "2026-06-21T10:00:00.000Z"
      });
      audioRepo.put({
        sessionId: "big-2",
        role: "interviewee",
        audio: new Uint8Array(tenMB),
        mime: "audio/webm",
        byteSize: tenMB,
        createdAt: "2026-06-21T10:00:01.000Z"
      });

      const server = buildApiServer({ audioRepository: audioRepo });
      const body = (await server.inject({ method: "GET", url: "/api/state/export" })).json();
      const packedIds = body.audios.map((a: { sessionId: string }) => a.sessionId);
      expect(packedIds).toContain("big-1");
      expect(packedIds).not.toContain("big-2");
      expect(body.audioOmittedSessions).toContain("big-2");
      // audioSessions still lists every audio-bearing session
      expect(body.audioSessions).toEqual(expect.arrayContaining(["big-1", "big-2"]));
      // F-06:遗漏不能只藏在 JSON 的技术字段里，正式 completeness 直接标 partial。
      expect(body.completeness).toMatchObject({
        status: "partial",
        complete: false,
        directlyImportable: true,
        omittedAudioSessions: 1
      });
      expect(body.completeness.reasons.join(" ")).toContain("1 段录音");
      await server.close();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // 审计修复 F-04(P1):import 执行协议(journal+补偿)、legacy 显式冷层模式、音频非法
  // 条目整体 422。此前 build-then-swap 只覆盖"校验失败",不覆盖"存储执行失败":
  // 先 replaceState 再清冷层 → raw delete 抛错时 500 但 profile 已是导入值、旧冷层仍在
  // (热态与冷层来自两个世代);legacy 裸 state 静默保留旧冷层却仍以"替换全部"语义 200;
  // 音频非法条目静默 continue,用户以为全量恢复实际缺条目。
  // ═══════════════════════════════════════════════════════════════════════════════
  describe("F-04: import 执行协议(journal+补偿)与 legacy 显式冷层模式", () => {
    const sampleMaterial = (sessionId: string): InterviewRawMaterial => ({
      sessionId,
      turns: [
        { id: `${sessionId}-t1`, role: "assistant", content: "问题", intent: "open", timestamp: "2026-06-20T00:00:00.000Z" },
        { id: `${sessionId}-t2`, role: "user", content: "回答", intent: "answer", timestamp: "2026-06-20T00:00:05.000Z" }
      ],
      strategyTrace: [],
      createdAt: "2026-06-20T00:00:10.000Z"
    });
    const seededAudio = (sessionId: string): InterviewAudio => ({
      sessionId,
      role: "interviewee",
      audio: new Uint8Array([1, 2, 3]),
      mime: "audio/webm",
      byteSize: 3,
      createdAt: "2026-06-20T00:00:00.000Z"
    });
    const audioImportEntry = (sessionId: string) => ({
      sessionId,
      role: "interviewee",
      mime: "audio/webm",
      audioBase64: Buffer.from([9, 9, 9]).toString("base64")
    });

    it("完整包中段失败(audio put 抛)→ 500 + journal 回滚:raw/audio 快照恢复,热态未变", async () => {
      const rawRepo = createInMemoryRawMaterialRepository();
      rawRepo.put(sampleMaterial("old-raw"));
      const audioBase = createInMemoryAudioRepository();
      audioBase.put(seededAudio("old-audio"));
      // 故障注入:仅对导入的新条目抛错——补偿路径 put 回旧快照必须仍然可用。
      const audioRepo = {
        ...audioBase,
        put: (a: InterviewAudio) => {
          if (a.sessionId === "new-audio") throw new Error("simulated audio put failure");
          audioBase.put(a);
        }
      };
      const server = buildApiServer({ rawMaterialRepository: rawRepo, audioRepository: audioRepo });
      const cur = (await server.inject({ method: "GET", url: "/api/state" })).json();
      const res = await server.inject({
        method: "POST",
        url: "/api/state/import",
        payload: {
          confirm: "REPLACE_ALL_STATE",
          state: { ...cur, profile: { ...cur.profile, name: "SHOULD_NOT_COMMIT" } },
          rawMaterials: [sampleMaterial("new-raw")],
          audios: [audioImportEntry("new-audio")]
        }
      });
      expect(res.statusCode).toBe(500);
      const body = res.json();
      expect(body.failedStep).toBe("audio");
      expect(body.rolledBack).toBe(true);
      expect(body.steps).toEqual([
        { store: "raw-material", status: "compensated" },
        { store: "audio", status: "failed" },
        { store: "hot-state", status: "pending" }
      ]);
      // 快照已恢复:旧世代数据在,新世代数据不在。
      expect(rawRepo.get("old-raw")).toBeDefined();
      expect(rawRepo.get("new-raw")).toBeUndefined();
      expect(audioBase.has("old-audio")).toBe(true);
      expect(audioBase.has("new-audio")).toBe(false);
      // 热态排在最后一步,失败时尚未写入——GET 复核未变。
      const after = (await server.inject({ method: "GET", url: "/api/state" })).json();
      expect(after.profile.name).toBe(cur.profile.name);
      await server.close();
    });

    it("B2#5:完整包第一步失败(raw-material put 抛)→ 500 + journal:raw 快照恢复,audio 未动,热态未变", async () => {
      // 与既有的 middle(audio)/last(hot-state)/补偿失败用例对称,补齐首步故障注入:
      // raw-material 是 journal 第一步,deleteAll 成功后 put 新条目抛错——失败步骤自身可能已
      // 部分执行,补偿必须把 raw 快照放回;后续步骤(audio/hot-state)必须保持 pending 未执行。
      const rawBase = createInMemoryRawMaterialRepository();
      rawBase.put(sampleMaterial("old-raw"));
      // 故障注入:仅对导入的新条目抛错——补偿路径 put 回旧快照必须仍然可用。
      const rawRepo = {
        ...rawBase,
        put: (m: InterviewRawMaterial) => {
          if (m.sessionId === "new-raw") throw new Error("simulated raw put failure");
          rawBase.put(m);
        }
      };
      const audioRepo = createInMemoryAudioRepository();
      audioRepo.put(seededAudio("old-audio"));
      const server = buildApiServer({ rawMaterialRepository: rawRepo, audioRepository: audioRepo });
      const cur = (await server.inject({ method: "GET", url: "/api/state" })).json();
      const res = await server.inject({
        method: "POST",
        url: "/api/state/import",
        payload: {
          confirm: "REPLACE_ALL_STATE",
          state: { ...cur, profile: { ...cur.profile, name: "SHOULD_NOT_COMMIT" } },
          rawMaterials: [sampleMaterial("new-raw")],
          audios: [audioImportEntry("new-audio")]
        }
      });
      expect(res.statusCode).toBe(500);
      const body = res.json();
      expect(body.failedStep).toBe("raw-material");
      expect(body.rolledBack).toBe(true);
      expect(body.steps).toEqual([
        { store: "raw-material", status: "failed" },
        { store: "audio", status: "pending" },
        { store: "hot-state", status: "pending" }
      ]);
      // raw 快照已恢复:旧世代在,新世代不在;audio 库根本没被执行,旧数据原样。
      expect(rawBase.get("old-raw")).toBeDefined();
      expect(rawBase.get("new-raw")).toBeUndefined();
      expect(audioRepo.has("old-audio")).toBe(true);
      expect(audioRepo.has("new-audio")).toBe(false);
      // 热态排在最后一步,首步失败时尚未写入——GET 复核未变。
      const after = (await server.inject({ method: "GET", url: "/api/state" })).json();
      expect(after.profile.name).toBe(cur.profile.name);
      await server.close();
    });

    it("最后一步热态 replaceState 失败 → 冷层已全部补偿恢复,journal 标 hot-state failed", async () => {
      const rawRepo = createInMemoryRawMaterialRepository();
      rawRepo.put(sampleMaterial("old-raw"));
      const audioRepo = createInMemoryAudioRepository();
      audioRepo.put(seededAudio("old-audio"));
      const baseRepo = createInMemoryProductStateRepository();
      let failReplace = false;
      const stateRepo = {
        ...baseRepo,
        replaceState: ((state: ProductState, opts?: Parameters<typeof baseRepo.replaceState>[1]) => {
          if (failReplace) throw new Error("simulated hot-state replace failure");
          return baseRepo.replaceState(state, opts);
        }) as typeof baseRepo.replaceState
      };
      const server = buildApiServer({ productStateRepository: stateRepo, rawMaterialRepository: rawRepo, audioRepository: audioRepo });
      const cur = (await server.inject({ method: "GET", url: "/api/state" })).json();
      failReplace = true;
      const res = await server.inject({
        method: "POST",
        url: "/api/state/import",
        payload: {
          confirm: "REPLACE_ALL_STATE",
          state: { ...cur, profile: { ...cur.profile, name: "SHOULD_NOT_COMMIT" } },
          rawMaterials: [sampleMaterial("new-raw")],
          audios: [audioImportEntry("new-audio")]
        }
      });
      failReplace = false;
      expect(res.statusCode).toBe(500);
      const body = res.json();
      expect(body.failedStep).toBe("hot-state");
      expect(body.rolledBack).toBe(true);
      expect(body.steps).toEqual([
        { store: "raw-material", status: "compensated" },
        { store: "audio", status: "compensated" },
        { store: "hot-state", status: "failed" }
      ]);
      // 冷层两库已回到导入前的世代。
      expect(rawRepo.get("old-raw")).toBeDefined();
      expect(rawRepo.get("new-raw")).toBeUndefined();
      expect(audioRepo.has("old-audio")).toBe(true);
      expect(audioRepo.has("new-audio")).toBe(false);
      const after = (await server.inject({ method: "GET", url: "/api/state" })).json();
      expect(after.profile.name).toBe(cur.profile.name);
      await server.close();
    });

    it("补偿自身失败 → rolledBack=false + compensationFailures 写明不一致细节", async () => {
      const rawBase = createInMemoryRawMaterialRepository();
      rawBase.put(sampleMaterial("old-raw"));
      // 第一次 deleteAll(执行步骤)成功,第二次(补偿)抛错——模拟回滚窗口里的 IO 故障。
      let rawDeleteCalls = 0;
      const rawRepo = {
        ...rawBase,
        deleteAll: () => {
          rawDeleteCalls += 1;
          if (rawDeleteCalls >= 2) throw new Error("simulated raw compensation failure");
          rawBase.deleteAll();
        }
      };
      const audioBase = createInMemoryAudioRepository();
      audioBase.put(seededAudio("old-audio"));
      const audioRepo = {
        ...audioBase,
        put: (a: InterviewAudio) => {
          if (a.sessionId === "new-audio") throw new Error("simulated audio put failure");
          audioBase.put(a);
        }
      };
      const server = buildApiServer({ rawMaterialRepository: rawRepo, audioRepository: audioRepo });
      const cur = (await server.inject({ method: "GET", url: "/api/state" })).json();
      const res = await server.inject({
        method: "POST",
        url: "/api/state/import",
        payload: {
          confirm: "REPLACE_ALL_STATE",
          state: { ...cur, profile: { ...cur.profile, name: "SHOULD_NOT_COMMIT" } },
          rawMaterials: [sampleMaterial("new-raw")],
          audios: [audioImportEntry("new-audio")]
        }
      });
      expect(res.statusCode).toBe(500);
      const body = res.json();
      expect(body.failedStep).toBe("audio");
      // raw 的补偿失败:绝不谎报"已回滚"。
      expect(body.rolledBack).toBe(false);
      expect(body.compensationFailures).toEqual([
        { store: "raw-material", error: expect.stringContaining("simulated raw compensation failure") }
      ]);
      // raw 步骤已执行且未能回滚(completed 非 compensated),body 如实反映不一致。
      expect(body.steps).toEqual([
        { store: "raw-material", status: "completed" },
        { store: "audio", status: "failed" },
        { store: "hot-state", status: "pending" }
      ]);
      // 不一致的真实现场:raw 库停在导入世代,热态未变。
      expect(rawBase.get("new-raw")).toBeDefined();
      const after = (await server.inject({ method: "GET", url: "/api/state" })).json();
      expect(after.profile.name).toBe(cur.profile.name);
      await server.close();
    });

    it("音频非法条目不再静默跳过 → 422 + 错误清单含条目下标,任何存储未动", async () => {
      const rawRepo = createInMemoryRawMaterialRepository();
      rawRepo.put(sampleMaterial("old-raw"));
      const audioRepo = createInMemoryAudioRepository();
      audioRepo.put(seededAudio("old-audio"));
      const server = buildApiServer({ rawMaterialRepository: rawRepo, audioRepository: audioRepo });
      const cur = (await server.inject({ method: "GET", url: "/api/state" })).json();
      const res = await server.inject({
        method: "POST",
        url: "/api/state/import",
        payload: {
          confirm: "REPLACE_ALL_STATE",
          state: { ...cur, profile: { ...cur.profile, name: "SHOULD_NOT_COMMIT" } },
          rawMaterials: [sampleMaterial("new-raw")],
          // index 0 合法,index 1 缺 audioBase64/mime——旧行为静默 continue,现在整体 422。
          audios: [audioImportEntry("ok-audio"), { sessionId: "bad-audio" }]
        }
      });
      expect(res.statusCode).toBe(422);
      const body = res.json();
      expect(body.invalidAudios).toHaveLength(1);
      expect(body.invalidAudios[0].index).toBe(1);
      expect(body.invalidAudios[0].error).toContain("audioBase64");
      expect(body.invalidAudios[0].error).toContain("mime");
      // 一起拒绝,绝不部分恢复:冷层与热态全部原样。
      expect(rawRepo.get("old-raw")).toBeDefined();
      expect(rawRepo.get("new-raw")).toBeUndefined();
      expect(audioRepo.has("old-audio")).toBe(true);
      expect(audioRepo.has("ok-audio")).toBe(false);
      const after = (await server.inject({ method: "GET", url: "/api/state" })).json();
      expect(after.profile.name).toBe(cur.profile.name);
      await server.close();
    });

    it("legacy 裸 state 缺 coldLayerMode → 422,错误信息解释两种模式,状态未变", async () => {
      const rawRepo = createInMemoryRawMaterialRepository();
      rawRepo.put(sampleMaterial("old-raw"));
      const server = buildApiServer({ rawMaterialRepository: rawRepo });
      const cur = (await server.inject({ method: "GET", url: "/api/state" })).json();
      const res = await server.inject({
        method: "POST",
        url: "/api/state/import",
        payload: {
          confirm: "REPLACE_ALL_STATE",
          state: { ...cur, profile: { ...cur.profile, name: "SHOULD_NOT_COMMIT" } }
        }
      });
      expect(res.statusCode).toBe(422);
      const message = res.json().error as string;
      expect(message).toContain("coldLayerMode");
      expect(message).toContain("preserve-cold");
      expect(message).toContain("replace-all");
      expect(rawRepo.get("old-raw")).toBeDefined();
      const after = (await server.inject({ method: "GET", url: "/api/state" })).json();
      expect(after.profile.name).toBe(cur.profile.name);
      await server.close();
    });

    it("半截包(只带 rawMaterials 无 audios)→ 422,拒绝静默混合另一半冷层", async () => {
      const server = buildApiServer();
      const cur = (await server.inject({ method: "GET", url: "/api/state" })).json();
      const res = await server.inject({
        method: "POST",
        url: "/api/state/import",
        payload: {
          confirm: "REPLACE_ALL_STATE",
          state: cur,
          rawMaterials: [sampleMaterial("half-package")]
        }
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toContain("audios");
      await server.close();
    });

    it("legacy + coldLayerMode=preserve-cold → 200,冷层保留,importReceipt 如实", async () => {
      const rawRepo = createInMemoryRawMaterialRepository();
      rawRepo.put(sampleMaterial("kept-raw"));
      const audioRepo = createInMemoryAudioRepository();
      audioRepo.put(seededAudio("kept-audio"));
      const server = buildApiServer({ rawMaterialRepository: rawRepo, audioRepository: audioRepo });
      const cur = (await server.inject({ method: "GET", url: "/api/state" })).json();
      const res = await server.inject({
        method: "POST",
        url: "/api/state/import",
        payload: {
          confirm: "REPLACE_ALL_STATE",
          coldLayerMode: "preserve-cold",
          state: { ...cur, profile: { ...cur.profile, name: "Imported-Legacy" } }
        }
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.profile.name).toBe("Imported-Legacy");
      expect(body.importReceipt.coldLayerMode).toBe("preserve-cold");
      expect(body.importReceipt.restored).toEqual({ rawMaterials: 0, audios: 0 });
      // 冷层原样保留(显式选择,不再是静默默认)。
      expect(rawRepo.get("kept-raw")).toBeDefined();
      expect(audioRepo.has("kept-audio")).toBe(true);
      await server.close();
    });

    it("legacy + coldLayerMode=replace-all → 200,冷层清空", async () => {
      const rawRepo = createInMemoryRawMaterialRepository();
      rawRepo.put(sampleMaterial("stale-raw"));
      const audioRepo = createInMemoryAudioRepository();
      audioRepo.put(seededAudio("stale-audio"));
      const server = buildApiServer({ rawMaterialRepository: rawRepo, audioRepository: audioRepo });
      const cur = (await server.inject({ method: "GET", url: "/api/state" })).json();
      const res = await server.inject({
        method: "POST",
        url: "/api/state/import",
        payload: {
          confirm: "REPLACE_ALL_STATE",
          coldLayerMode: "replace-all",
          state: { ...cur, profile: { ...cur.profile, name: "Imported-Clean" } }
        }
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.profile.name).toBe("Imported-Clean");
      expect(body.importReceipt.coldLayerMode).toBe("replace-all");
      // 冷层与热态同世代:旧冷层全部清空。
      expect(rawRepo.list()).toHaveLength(0);
      expect(audioRepo.listAll()).toHaveLength(0);
      await server.close();
    });

    it("完整包成功 → importReceipt.restored 数量正确 + knowledgeIndex=rebuilt", async () => {
      const rawRepo = createInMemoryRawMaterialRepository();
      rawRepo.put(sampleMaterial("previous-gen"));
      const audioRepo = createInMemoryAudioRepository();
      const server = buildApiServer({ rawMaterialRepository: rawRepo, audioRepository: audioRepo });
      const cur = (await server.inject({ method: "GET", url: "/api/state" })).json();
      const res = await server.inject({
        method: "POST",
        url: "/api/state/import",
        payload: {
          confirm: "REPLACE_ALL_STATE",
          state: { ...cur, profile: { ...cur.profile, name: "Imported-Full" } },
          rawMaterials: [sampleMaterial("new-raw-1"), sampleMaterial("new-raw-2")],
          audios: [audioImportEntry("new-audio")]
        }
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.profile.name).toBe("Imported-Full");
      expect(body.importReceipt.restored).toEqual({ rawMaterials: 2, audios: 1 });
      expect(body.importReceipt.knowledgeIndex).toBe("rebuilt");
      // 完整包不需要 coldLayerMode(数组本身就是冷层的完整声明)。
      expect(body.importReceipt.coldLayerMode).toBeUndefined();
      // 冷层被整体替换为导入世代。
      expect(rawRepo.get("previous-gen")).toBeUndefined();
      expect(rawRepo.list().map((m) => m.sessionId).sort()).toEqual(["new-raw-1", "new-raw-2"]);
      expect(audioRepo.has("new-audio")).toBe(true);
      await server.close();
    });

    it("导入含 audioOmittedSessions 的部分备份 → 200 但 importReceipt 明确 missing/partial", async () => {
      const server = buildApiServer();
      const cur = (await server.inject({ method: "GET", url: "/api/state" })).json();
      const res = await server.inject({
        method: "POST",
        url: "/api/state/import",
        payload: {
          confirm: "REPLACE_ALL_STATE",
          state: cur,
          rawMaterials: [],
          audios: [audioImportEntry("included-audio")],
          audioSessions: ["included-audio", "omitted-audio"],
          audioOmittedSessions: ["omitted-audio"]
        }
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().importReceipt).toMatchObject({
        partial: true,
        restored: { rawMaterials: 0, audios: 1 },
        skipped: { rawMaterials: [], audios: [] },
        missing: { audioSessions: ["omitted-audio"] }
      });
      await server.close();
    });
  });

  // 审计修复 F-04(P1):purge 冷层从"假原子"改为尽力而为 + purgeReceipt 三态回执。
  // 此前 purge(all) 先删冷层最后提交热态,注入第二库失败:500、热态未变,但第一库已删
  // ——响应语义与实际不符;purge(interviews) 冷层失败 500 但热态已变且无任何回执。
  describe("F-04: purge 冷层尽力而为 + purgeReceipt(热态无论冷层成败都提交)", () => {
    const failing = <T extends { deleteAll: () => void }>(repo: T): T => ({
      ...repo,
      deleteAll: () => {
        throw new Error("simulated cold-layer delete failure");
      }
    });
    const maybeFailing = <T extends { deleteAll: () => void }>(repo: T, fail: boolean): T =>
      fail ? failing(repo) : repo;
    const buildRepos = (failStore?: "raw-material" | "audio" | "knowledge-index") => ({
      rawMaterialRepository: maybeFailing(createInMemoryRawMaterialRepository(), failStore === "raw-material"),
      audioRepository: maybeFailing(createInMemoryAudioRepository(), failStore === "audio"),
      knowledgeIndexRepository: maybeFailing(createInMemoryKnowledgeIndexRepository(), failStore === "knowledge-index")
    });

    it.each(["raw-material", "audio", "knowledge-index"] as const)(
      "purge(all) %s 失败 → 500 + purgeReceipt 该库 failed,其余库仍被清,热态已清",
      async (storeName) => {
        const server = buildApiServer(buildRepos(storeName));
        const res = await server.inject({
          method: "POST",
          url: "/api/state/purge",
          payload: { confirm: "PURGE_PERSONAL_DATA" }
        });
        expect(res.statusCode).toBe(500);
        const body = res.json();
        expect(body.error).toContain("purge partial failure");
        expect(body.error).toContain(storeName);
        expect(body.purgeReceipt.partialFailure).toBe(true);
        expect(body.purgeReceipt.hotStateCommitted).toBe(true);
        expect(body.purgeReceipt.stores[storeName]).toMatch(/^failed: /);
        // 一库失败不挡其余库(隐私删除最大化)。
        for (const other of ["raw-material", "audio", "knowledge-index"].filter((n) => n !== storeName)) {
          expect(body.purgeReceipt.stores[other]).toBe("cleared");
        }
        // 热态无论冷层成败都提交:body 带回已清热态,GET 复核确已落库。
        expect(body.state.profile.name).toBe("");
        expect(body.state.sessions.length).toBe(0);
        const after = (await server.inject({ method: "GET", url: "/api/state" })).json();
        expect(after.profile.name).toBe("");
        expect(after.sessions.length).toBe(0);
        await server.close();
      }
    );

    it("purge(all) 全成功 → 200 + purgeReceipt 全 cleared", async () => {
      const server = buildApiServer(buildRepos());
      const res = await server.inject({
        method: "POST",
        url: "/api/state/purge",
        payload: { confirm: "PURGE_PERSONAL_DATA" }
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.deletedScope).toBe("all");
      expect(body.purgeReceipt.partialFailure).toBe(false);
      expect(body.purgeReceipt.stores).toEqual({
        "raw-material": "cleared",
        audio: "cleared",
        "knowledge-index": "cleared"
      });
      await server.close();
    });

    it("purge(interviews) 冷层失败 → 500 + purgeReceipt 注明热态已提交,scoped 审计事件已落库", async () => {
      const server = buildApiServer(buildRepos("raw-material"));
      const before = (await server.inject({ method: "GET", url: "/api/state" })).json();
      const res = await server.inject({
        method: "POST",
        url: "/api/state/purge",
        payload: { confirm: "PURGE_PERSONAL_DATA", scope: "interviews" }
      });
      expect(res.statusCode).toBe(500);
      const body = res.json();
      expect(body.purgeReceipt.partialFailure).toBe(true);
      // interviews 档热态先提交是既有顺序;receipt 必须注明,让前端明白 500≠什么都没发生。
      expect(body.purgeReceipt.hotStateCommitted).toBe(true);
      expect(body.purgeReceipt.stores["raw-material"]).toMatch(/^failed: /);
      expect(body.purgeReceipt.stores.audio).toBe("cleared");
      expect(body.purgeReceipt.stores["knowledge-index"]).toBe("cleared");
      // 热态已提交:会话清空、profile 保留(interviews 是分档清除);scoped purge 的
      // privacy_data_purged 审计事件落库是"热态确已提交"的确凿证据(空基底会话本就为 0)。
      expect(body.state.sessions.length).toBe(0);
      expect(
        (body.state.auditEvents ?? []).some(
          (e: { type: string; entityId: string }) => e.type === "privacy_data_purged" && e.entityId === "local-product-state:interviews"
        )
      ).toBe(true);
      const after = (await server.inject({ method: "GET", url: "/api/state" })).json();
      expect(after.sessions.length).toBe(0);
      expect(after.profile.name).toBe(before.profile.name);
      expect(
        (after.auditEvents ?? []).some(
          (e: { type: string; entityId: string }) => e.type === "privacy_data_purged" && e.entityId === "local-product-state:interviews"
        )
      ).toBe(true);
      await server.close();
    });

    it("purge(interviews) 全成功 → 200 + purgeReceipt 全 cleared", async () => {
      const server = buildApiServer(buildRepos());
      const res = await server.inject({
        method: "POST",
        url: "/api/state/purge",
        payload: { confirm: "PURGE_PERSONAL_DATA", scope: "interviews" }
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.deletedScope).toBe("interviews");
      expect(body.purgeReceipt.partialFailure).toBe(false);
      expect(body.purgeReceipt.stores).toEqual({
        "raw-material": "cleared",
        audio: "cleared",
        "knowledge-index": "cleared"
      });
      await server.close();
    });
  });
});

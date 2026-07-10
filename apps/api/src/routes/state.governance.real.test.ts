import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerStateRoutes } from "./state";
import { withKnowledgeReindex } from "../server";
import { createLlmBudget } from "../llm-budget";
import { createSurrealStores, type SurrealStores } from "../../../../packages/db/src/surreal/surreal-cold-repositories";
import type { InterviewAudio, InterviewRawMaterial, KnowledgeChunk } from "../../../../src/domain/types";

/** R2b · 治理路由 × 真 SurrealDB(mem://)端到端。验证 HTTP reset/purge/import 走真事务后**真实冷层**
 *  被清空/恢复(mock 路由测试无法验证冷层实际动作),并经完整路由栈做 DB 级基线推进(重加同 id 落库)。
 *  跨包直接 import createSurrealStores(vite/esbuild transform 可行);故本文件从 apps/api tsconfig
 *  exclude(同 surreal-data-layer-journey.real.test.ts 打法),仍由 vitest include 跑到。 */

const openStores = new Set<SurrealStores>();
const openServers = new Set<FastifyInstance>();
afterEach(async () => {
  for (const srv of openServers) await srv.close();
  for (const s of openStores) await s.close();
  openServers.clear();
  openStores.clear();
});

async function makeRig() {
  const stores = await createSurrealStores({ url: "mem://" });
  openStores.add(stores);
  await stores.productState.flush();
  const server = Fastify();
  openServers.add(server);
  // 生产路径:热态经 withKnowledgeReindex 包装(...inner spread 透传 runGovernanceTransaction)。
  const wrapped = withKnowledgeReindex(stores.productState, stores.knowledgeIndex, () => undefined, createLlmBudget());
  await registerStateRoutes(server, wrapped, {
    rawMaterialRepository: stores.rawMaterial,
    audioRepository: stores.audio,
    knowledgeIndexRepository: stores.knowledgeIndex,
  });
  return { stores, server };
}

const raw = (id: string): InterviewRawMaterial => ({ sessionId: id, turns: [], strategyTrace: [], createdAt: "2026-06-21T00:00:00.000Z" });
const aud = (id: string): InterviewAudio => ({ sessionId: id, role: "interviewee", audio: new Uint8Array([1, 2, 3]), mime: "audio/webm", byteSize: 3, createdAt: "2026-06-21T00:00:00.000Z" });
const chunk = (id: string): KnowledgeChunk => ({ id, sourceType: "note", sourceId: "s1", title: "t", text: "x", keywords: [], createdAt: "2026-06-22T00:00:00.000Z" });
async function seedCold(stores: SurrealStores) {
  await stores.rawMaterial.put(raw("s1"));
  await stores.audio.put(aud("s1"));
  await stores.knowledgeIndex.put(chunk("c1"));
}
async function coldCounts(stores: SurrealStores) {
  return {
    raw: (await stores.rawMaterial.list()).length,
    audio: (await stores.audio.listAll()).length,
    knowledge: (await stores.knowledgeIndex.listAll()).length,
  };
}

describe("R2b 治理路由 × 真 SurrealDB(mem://)", () => {
  it("reset:HTTP → 200 + resetReceipt 全 cleared,真实三冷层被清空", async () => {
    const { stores, server } = await makeRig();
    await seedCold(stores);
    expect(await coldCounts(stores)).toEqual({ raw: 1, audio: 1, knowledge: 1 });

    const res = await server.inject({ method: "POST", url: "/api/state/reset", payload: { confirm: "RESET_ALL_DATA" } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.resetReceipt).toEqual({ partialFailure: false, stores: { "raw-material": "cleared", audio: "cleared", "knowledge-index": "cleared" } });
    expect(body.notes).toEqual([]);
    expect(await coldCounts(stores)).toEqual({ raw: 0, audio: 0, knowledge: 0 }); // 真实冷层清空
  });

  it("purge(all):HTTP → 200 + purgeReceipt hotStateCommitted,真实三冷层被清空", async () => {
    const { stores, server } = await makeRig();
    await seedCold(stores);
    const res = await server.inject({ method: "POST", url: "/api/state/purge", payload: { confirm: "PURGE_PERSONAL_DATA" } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.deletedScope).toBe("all");
    expect(body.purgeReceipt).toEqual({ partialFailure: false, hotStateCommitted: true, stores: { "raw-material": "cleared", audio: "cleared", "knowledge-index": "cleared" } });
    expect(await coldCounts(stores)).toEqual({ raw: 0, audio: 0, knowledge: 0 });
  });

  it("purge(interviews):HTTP → 200,真实三冷层被清空", async () => {
    const { stores, server } = await makeRig();
    await seedCold(stores);
    const res = await server.inject({ method: "POST", url: "/api/state/purge", payload: { confirm: "PURGE_PERSONAL_DATA", scope: "interviews" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().purgeReceipt.hotStateCommitted).toBe(true);
    expect(await coldCounts(stores)).toEqual({ raw: 0, audio: 0, knowledge: 0 });
  });

  it("import 完整包:HTTP → 200,真实冷层 raw/audio 被替换恢复", async () => {
    const { stores, server } = await makeRig();
    await seedCold(stores); // 旧冷层:s1
    const payload = {
      confirm: "REPLACE_ALL_STATE",
      state: { profile: { name: "恢复者" }, notes: [] },
      rawMaterials: [{ sessionId: "imp1", turns: [], createdAt: "2026-06-21T00:00:00.000Z" }, { sessionId: "imp2", turns: [], createdAt: "2026-06-21T00:00:01.000Z" }],
      audios: [{ sessionId: "imp1", mime: "audio/webm", audioBase64: Buffer.from([9, 9, 9]).toString("base64") }],
      audioSessions: ["imp1"],
    };
    const res = await server.inject({ method: "POST", url: "/api/state/import", payload });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.importReceipt.restored).toEqual({ rawMaterials: 2, audios: 1 });
    // 真实冷层:旧 s1 被替换成 imp1/imp2(raw),imp1(audio)。
    expect((await stores.rawMaterial.list()).map((m) => m.sessionId).sort()).toEqual(["imp1", "imp2"]);
    expect(await stores.audio.has("imp1")).toBe(true);
    expect(await stores.audio.has("s1")).toBe(false);
  });

  it("★DB 级基线推进:HTTP purge 后经完整路由栈重加同 id note,DB 真落库(基线未推进则丢失)", async () => {
    const { stores, server } = await makeRig();
    const before = (await server.inject({ method: "GET", url: "/api/state" })).json();
    const demoNote = before.notes[0]; // note-seed-1
    expect(demoNote).toBeDefined();

    // purge(all):热态 + 冷层原子清空,基线推进到 purged。
    await server.inject({ method: "POST", url: "/api/state/purge", payload: { confirm: "PURGE_PERSONAL_DATA" } });

    // 经 HTTP PUT 重新写入与 demo 同 id 的 note(整状态替换,走 wrapper.replaceState → persist)。
    const purged = (await server.inject({ method: "GET", url: "/api/state" })).json();
    const putRes = await server.inject({ method: "PUT", url: "/api/state", payload: { ...purged, notes: [demoNote], revision: purged.revision } });
    expect(putRes.statusCode).toBe(200);
    await stores.productState.flush();

    // 直查 DB:note-seed-1 必须真在 note 表(基线若未从 pre 推进到 purged,diff 会判'无变化'不写)。
    const [ids] = await stores.productState.query<[unknown[]]>("SELECT VALUE id FROM note;");
    expect((ids ?? []).map(String).some((id) => id.includes("note-seed-1"))).toBe(true);
    expect(stores.productState.getPersistHealth().consecutiveFailures).toBe(0);
  });
});

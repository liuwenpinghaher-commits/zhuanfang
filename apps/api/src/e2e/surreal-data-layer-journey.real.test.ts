// @vitest-environment node
// ↑ @surrealdb/node + onnxruntime-node(本地 embedding)都需原生 node 环境,不能在 jsdom 下跑。
/**
 * SurrealDB 真实数据层端到端 e2e —— 补最大缺口。
 *
 * 背景:dual-surreal 已是生产权威库(zhuanfang-surreal-cutover),但所有现有 e2e 都走 in-memory
 * repo,SurrealStore 的资产往返 / 原生 RELATE 边投影 / 图遍历召回 / 溯源 在真实端到端从未被验证。
 *
 * 本测试用真实 SurrealStore(mem://,同进程)+ 真实本地 embedding(node onnxruntime)+ 离线确定性
 * finalize(env 无 key),端到端跑完整采访闭环,直查 surreal 表/边断言数据层真实工作。
 * gate:bge 模型缓存存在(创建 session 的召回 embedding 需要)。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildApiServer } from "../server";
// 跨包动态 import surreal repo:vite transform 下直接 import 可行(server.ts 的 Function-import 绕 tsconfig
// 技巧在 vite 报 "dynamic import callback not specified")。apps/api tsconfig 不检查 .real.test(见 tsconfig)。
import { createSurrealProductStateRepository } from "../../../../packages/db/src/surreal/surreal-product-state-repository";

const hasModel = existsSync(join(process.cwd(), "node_modules/@huggingface/transformers/.cache/Xenova/bge-large-zh-v1.5"));

async function makeSurrealRepo(): Promise<any> {
  return createSurrealProductStateRepository({ url: "mem://" });
}

describe.skipIf(!hasModel)("SurrealDB 真实数据层 e2e(采访闭环 → 落库/边/溯源)", () => {
  let repo: any;
  let server: ReturnType<typeof buildApiServer>;
  let sessionId: string;

  beforeAll(async () => {
    repo = await makeSurrealRepo();
    server = buildApiServer({ env: { EMBEDDING_PROVIDER: "local" }, productStateRepository: repo });

    await server.inject({ method: "POST", url: "/api/state/reset" });
    const createRes = await server.inject({
      method: "POST", url: "/api/interview-sessions",
      payload: { mode: "daily", strength: "standard" }
    });
    expect(createRes.statusCode).toBe(200);
    sessionId = createRes.json().session.id;

    for (const content of [
      "我一直认为管理者必须事必躬亲才能保证质量。",
      "但最近我开始觉得,过度控制反而扼杀了团队的主动性。",
      "也许真正的成熟是学会在关键节点把控、日常充分放权。"
    ]) {
      const r = await server.inject({ method: "POST", url: `/api/interview-sessions/${sessionId}/turns`, payload: { content } });
      expect(r.statusCode).toBe(200);
    }
    const endRes = await server.inject({ method: "POST", url: `/api/interview-sessions/${sessionId}/end` });
    expect(endRes.statusCode).toBe(200);
    await repo.flush?.();
  }, 120000);

  afterAll(async () => { await repo?.close?.(); });

  it("采访闭环后 SurrealStore 真实落库了 note(直查 note 表,非只内存)", async () => {
    const stateRes = await server.inject({ method: "GET", url: "/api/state" });
    expect(stateRes.json().notes.length).toBeGreaterThan(0);
    const [notes] = await repo.query("SELECT * FROM note;");
    expect((notes ?? []).length).toBeGreaterThan(0);
  });

  it("SurrealStore 投影了 part_of 边(turn→session,原生 RELATE)", async () => {
    const [partOf] = await repo.query("SELECT * FROM part_of;");
    expect((partOf ?? []).length).toBeGreaterThan(0);
  });

  it("溯源图遍历可调用且不炸(recallProvenanceTurns 经真实 surreal RELATE)", async () => {
    const [notes] = await repo.query("SELECT id FROM note;");
    const rawId = (notes?.[0] as any)?.id;
    expect(rawId).toBeTruthy();
    const noteId = String(rawId).includes(":") ? String(rawId).split(":")[1].replace(/[⟨⟩]/g, "") : String(rawId);
    const turns = await repo.recallProvenanceTurns("note", noteId);
    expect(Array.isArray(turns)).toBe(true); // 离线 note 可能无锚点 → 空数组;关键是真实图遍历不抛
  });

  it("getState 往返:surreal 读回的 state 日期字段是 string(P0 B coerce 真实生效)", async () => {
    const state = (await server.inject({ method: "GET", url: "/api/state" })).json();
    const note = state.notes[0];
    expect(typeof note.createdAt).toBe("string"); // 非 DateTime$1 对象
  });

  it("③ 真实向量召回:HNSW + 真实 bge embedding 命中语义相关记忆 + A4 门控敏感记忆", async () => {
    const { createLocalEmbeddingClient } = await import("../providers/local-embedding");
    const [vManage, vLunch, vQuery] = await createLocalEmbeddingClient().embed([
      "管理者应该学会放权给团队、信任下属的判断",
      "今天中午食堂吃什么比较好",
      "怎样把决策权授权给团队负责人"
    ]);
    const ts = "2026-06-28T00:00:00.000Z";
    const mem = (id: string, text: string, embedding: number[], sensitivity: "normal" | "sensitive" = "normal") =>
      ({ id, text, status: "confirmed" as const, sourceType: "profile" as const, sourceId: "p", evidenceQuote: "", sensitivity, embedding, createdAt: ts, updatedAt: ts, relatedThemeIds: [] });
    repo.replaceState({ ...repo.getState(), memoryRecords: [
      mem("me_manage", "管理者应该学会放权给团队、信任下属的判断", vManage),
      mem("me_lunch", "今天中午食堂吃什么比较好", vLunch),
      mem("me_secret", "放权相关的敏感记忆", vManage, "sensitive")
    ]});
    await repo.flush();
    // 真实 query 向量 → HNSW top1 命中语义最近(放权≈授权,远离午饭),证明真模型语义召回、非噪声
    const top1 = await repo.recallMemoriesByVector(vQuery, 1);
    expect(top1[0]?.id).toBe("me_manage");
    // A4 门控:k 放大也绝不召回 sensitive(默认 includeSensitive=false)
    const all = await repo.recallMemoriesByVector(vQuery, 5);
    const ids = all.map((h: any) => h.id);
    expect(ids).toContain("me_manage");
    expect(ids).not.toContain("me_secret");
  }, 60000);

  it("④ P4·原生 rag 混合召回经【生产接线】可达:BM25 拉回无嵌入块(域层 cosine 路径物理排除它)", async () => {
    // 判别器设计:X 有 embedding 但内容与问题无关;Y 无 embedding、文本含问题关键词。
    // 域层 buildSemanticRagContext 的 cosine 路径只在【有 embedding 的候选】里排序 → Y 恒不可达;
    // 原生 recallRagChunks 的 BM25 路命中 Y → citations 含 Y 当且仅当原生路径真被走到。
    // 这同时是 withKnowledgeReindex 能力透传修复的 E2E 级回归锁(此前包装吞掉能力,
    // asNativeRecall 恒 undefined,原生召回在生产接线上从未生效)。
    const { createLocalEmbeddingClient } = await import("../providers/local-embedding");
    const [vLunch] = await createLocalEmbeddingClient().embed(["今天中午食堂吃什么比较好"]);
    const ts = "2026-06-28T00:00:00.000Z";
    repo.replaceState({
      ...repo.getState(),
      importSources: [{
        id: "is_e2e", title: "E2E 资料", sourceType: "text", content: "正文", status: "chunked",
        sensitivity: "normal", chunkIds: ["rc_x", "rc_y"], createdAt: ts, updatedAt: ts
      }],
      ragChunks: [
        { id: "rc_x", sourceId: "is_e2e", title: "无关但有向量", text: "今天中午食堂吃什么比较好", keywords: [], tokenEstimate: 10, usage: "interview-context", embedding: vLunch, createdAt: ts },
        { id: "rc_y", sourceId: "is_e2e", title: "关键词命中无向量", text: "团队正在评估区块链技术选型方案", keywords: [], tokenEstimate: 10, usage: "interview-context", createdAt: ts }
      ]
    });
    await repo.flush();
    const res = await server.inject({ method: "POST", url: "/api/rag/query", payload: { question: "区块链" } });
    expect(res.statusCode).toBe(200);
    const citations = (res.json().citations ?? []).map((c: any) => c.id);
    expect(citations, "BM25 应拉回无嵌入块 rc_y(域层 cosine 排除它 → 只有原生混合召回能命中)").toContain("rc_y");
  }, 60000);

  it("⑤ P4·图↔软链一致性审计不变量:真实业务闭环后 /api/ops/graph-consistency 必须 ok", async () => {
    // 方案二的 E2E 级消费:采访闭环(finalize 产资产/边)+ ③④ 的 replaceState 之后,
    // collectEdges(lastPersisted) 与 surreal 5 张边表实际必须逐条一致——persist/diff/edge-mapper
    // 全链的端到端不变量;任何投影漏写/漏删在此暴露。
    const res = await server.inject({ method: "GET", url: "/api/ops/graph-consistency" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // 失败时把差异样本打进断言消息,直接可定位
    expect(body.ok, `图审计应一致: ${JSON.stringify(body.report)}`).toBe(true);
    expect(body.report.missingCount).toBe(0);
    expect(body.report.unexpectedCount).toBe(0);
    console.log(`[surreal-e2e] 图审计: expected=${body.report.expectedCount} actual=${body.report.actualCount}`);
  }, 30000);
});

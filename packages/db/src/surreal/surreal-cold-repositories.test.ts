import { describe, it, expect, afterEach } from "vitest";
import { createSurrealStores, type SurrealStores } from "./surreal-cold-repositories";
import type { InterviewAudio, InterviewRawMaterial, KnowledgeChunk } from "../../../../src/domain/types";

/** R2a · 三冷层(raw_material / audio / knowledge_chunk)SurrealDB 实现的行为测试。
 *  覆盖与 sqlite/in-memory 相同的行为(roundtrip / 复合键 / deleteAll / epoch / replaceSource 事务
 *  原子性);audio 用几百 KB 的 Uint8Array 断言字节逐位一致(入库 bytes,R0-S2 背书)。
 *  mem:// 内库、进程内(HNSW 在 mem 下可用,同 surreal-recall.test 打法),afterEach 统一 close 共享连接。
 *  ⚠️ 当前只测 Surreal 实现,并非"三实现共跑同一套契约表"(sqlite/in-memory 各自另有测试文件)。
 *  后续项(记档):把这三套断言抽成 describe.each 的共享契约,对 in-memory/sqlite/surreal 三实现统跑,
 *  从"对齐用例"升级为"同一契约的单一真值",彻底杜绝同名方法语义漂移。 */

const open = new Set<SurrealStores>();
async function makeStores(): Promise<SurrealStores> {
  const stores = await createSurrealStores({ url: "mem://" });
  open.add(stores);
  return stores;
}
afterEach(async () => {
  for (const s of open) await s.close();
  open.clear();
});

const rawMaterial = (id: string): InterviewRawMaterial => ({
  sessionId: id,
  turns: [
    { id: "t1", role: "user", content: "原话一", intent: "", timestamp: "2026-06-21T00:00:00.000Z" },
    { id: "t2", role: "assistant", content: "追问", intent: "deepen", timestamp: "2026-06-21T00:00:05.000Z" },
  ],
  strategyTrace: [{ turnId: "t2", reason: "深挖" } as never],
  createdAt: "2026-06-21T00:00:10.000Z",
});

const audioOf = (sessionId: string, role: InterviewAudio["role"], bytes: Uint8Array, at: string): InterviewAudio => ({
  sessionId, role, audio: bytes, mime: "audio/webm", byteSize: bytes.byteLength, createdAt: at,
});

// HNSW 索引固定 DIMENSION 1024(== EMBEDDING_DIMENSION);生产嵌入恒为 1024 维,测试同口径。
const vec1024 = (seed: number): number[] => Array.from({ length: 1024 }, (_, i) => Math.sin(seed * 0.13 + i * 0.017));
const chunk = (id: string, sourceId: string, emb?: number[]): KnowledgeChunk => ({
  id, sourceType: "note", sourceId, title: "标题", text: "片段正文", keywords: ["关键词", "kw2"],
  ...(emb ? { embedding: emb } : {}), createdAt: "2026-06-22T00:00:00.000Z",
});

describe("Surreal RawMaterialRepository (R2a 冷层)", () => {
  it("put→get 往返(含嵌套 turns/strategyTrace),不存在返回 undefined", async () => {
    const { rawMaterial: repo } = await makeStores();
    expect(await repo.get("s1")).toBeUndefined();
    await repo.put(rawMaterial("s1"));
    const got = await repo.get("s1");
    expect(got?.sessionId).toBe("s1");
    expect(got?.turns).toHaveLength(2);
    expect(got?.turns[0].content).toBe("原话一");
    expect(got?.turns[1].intent).toBe("deepen");
    expect(got?.strategyTrace).toHaveLength(1);
    expect(got?.createdAt).toBe("2026-06-21T00:00:10.000Z");
  });

  it("list 按 createdAt 升序;delete 删单条;deleteAll 清空", async () => {
    const { rawMaterial: repo } = await makeStores();
    await repo.put({ ...rawMaterial("a"), createdAt: "2026-06-21T00:00:00.000Z" });
    await repo.put({ ...rawMaterial("b"), createdAt: "2026-06-21T01:00:00.000Z" });
    expect((await repo.list()).map((m) => m.sessionId)).toEqual(["a", "b"]);
    await repo.delete("a");
    expect(await repo.get("a")).toBeUndefined();
    expect(await repo.get("b")).toBeDefined();
    await repo.deleteAll();
    expect(await repo.list()).toHaveLength(0);
  });

  it("空 turns/strategyTrace 往返为空数组", async () => {
    const { rawMaterial: repo } = await makeStores();
    await repo.put({ sessionId: "empty", turns: [], strategyTrace: [], createdAt: "2026-06-21T00:00:00.000Z" });
    const got = await repo.get("empty");
    expect(got?.turns).toEqual([]);
    expect(got?.strategyTrace).toEqual([]);
  });
});

describe("Surreal AudioRepository (R2a 冷层)", () => {
  it("几百 KB Uint8Array 入库 bytes:往返逐位一致", async () => {
    const { audio: repo } = await makeStores();
    const bytes = new Uint8Array(300 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 0xff;
    await repo.put(audioOf("s1", "interviewee", bytes, "2026-06-21T00:00:00.000Z"));
    const got = await repo.get("s1");
    expect(got).toBeDefined();
    expect(got!.byteSize).toBe(bytes.byteLength);
    expect(got!.audio.byteLength).toBe(bytes.byteLength);
    // 逐位一致(不用 toEqual 整数组比较大对象,循环断言更省内存)。
    let same = got!.audio.length === bytes.length;
    if (same) for (let i = 0; i < bytes.length; i++) if (got!.audio[i] !== bytes[i]) { same = false; break; }
    expect(same).toBe(true);
  });

  it("复合键(sessionId, role):两路互不覆盖,各自取回;has;缺省 role=interviewee", async () => {
    const { audio: repo } = await makeStores();
    await repo.put(audioOf("s1", "interviewee", new Uint8Array([1, 1]), "2026-06-21T00:00:00.000Z"));
    await repo.put(audioOf("s1", "interviewer", new Uint8Array([2, 2, 2]), "2026-06-21T00:00:01.000Z"));
    expect(Array.from((await repo.get("s1", "interviewee"))!.audio)).toEqual([1, 1]);
    expect(Array.from((await repo.get("s1", "interviewer"))!.audio)).toEqual([2, 2, 2]);
    expect((await repo.get("s1"))!.role).toBe("interviewee"); // 缺省
    expect(await repo.has("s1", "interviewer")).toBe(true);
    expect(await repo.has("nope")).toBe(false);
  });

  it("durationMs / recordingStartedAt 可选字段往返;不带则缺席", async () => {
    const { audio: repo } = await makeStores();
    await repo.put({ ...audioOf("s1", "interviewee", new Uint8Array([9]), "2026-06-21T00:00:00.000Z"), durationMs: 1234, recordingStartedAt: "2026-06-21T09:00:00.000Z" });
    const got = await repo.get("s1");
    expect(got!.durationMs).toBe(1234);
    expect(got!.recordingStartedAt).toBe("2026-06-21T09:00:00.000Z");
    await repo.put(audioOf("s2", "interviewee", new Uint8Array([9]), "2026-06-21T00:00:00.000Z"));
    const got2 = await repo.get("s2");
    expect("durationMs" in got2!).toBe(false);
    expect("recordingStartedAt" in got2!).toBe(false);
  });

  it("delete(sessionId) 无 role → 删两路;delete(sessionId, role) 仅删该路", async () => {
    const { audio: repo } = await makeStores();
    await repo.put(audioOf("s1", "interviewee", new Uint8Array([1]), "2026-06-21T00:00:00.000Z"));
    await repo.put(audioOf("s1", "interviewer", new Uint8Array([2]), "2026-06-21T00:00:01.000Z"));
    await repo.delete("s1", "interviewer");
    expect(await repo.has("s1", "interviewee")).toBe(true);
    expect(await repo.has("s1", "interviewer")).toBe(false);
    await repo.put(audioOf("s1", "interviewer", new Uint8Array([2]), "2026-06-21T00:00:01.000Z"));
    await repo.delete("s1");
    expect(await repo.has("s1", "interviewee")).toBe(false);
    expect(await repo.has("s1", "interviewer")).toBe(false);
  });

  it("listSessionIds 去重排序;listAll 每路一条;deleteAll 清空", async () => {
    const { audio: repo } = await makeStores();
    await repo.put(audioOf("s2", "interviewee", new Uint8Array([1]), "2026-06-21T00:00:00.000Z"));
    await repo.put(audioOf("s1", "interviewee", new Uint8Array([1]), "2026-06-21T00:00:01.000Z"));
    await repo.put(audioOf("s1", "interviewer", new Uint8Array([2]), "2026-06-21T00:00:02.000Z"));
    expect(await repo.listSessionIds()).toEqual(["s1", "s2"]);
    expect((await repo.listAll()).length).toBe(3);
    await repo.deleteAll();
    expect(await repo.listAll()).toHaveLength(0);
    expect(await repo.listSessionIds()).toHaveLength(0);
  });
});

describe("Surreal KnowledgeIndexRepository (R2a 冷层)", () => {
  it("put→listAll 往返(含 embedding/keywords);无 emb 时不挂字段", async () => {
    const { knowledgeIndex: repo } = await makeStores();
    const emb = vec1024(1);
    await repo.put(chunk("c1", "s1", emb));
    await repo.put(chunk("c2", "s1"));
    const all = await repo.listAll();
    expect(all).toHaveLength(2);
    const c1 = all.find((c) => c.id === "c1");
    expect(c1?.embedding).toHaveLength(1024);
    expect(c1?.embedding?.slice(0, 3)).toEqual(emb.slice(0, 3));
    expect(c1?.keywords).toEqual(["关键词", "kw2"]);
    expect(all.find((c) => c.id === "c2")?.embedding).toBeUndefined();
  });

  it("replaceSource 原子替换某来源的块;deleteBySource 删该来源全部", async () => {
    const { knowledgeIndex: repo } = await makeStores();
    await repo.put(chunk("c1", "s1"));
    await repo.put(chunk("c9", "other"));
    await repo.replaceSource("note", "s1", [chunk("c2", "s1"), chunk("c3", "s1")]);
    expect((await repo.listAll()).filter((c) => c.sourceId === "s1").map((c) => c.id).sort()).toEqual(["c2", "c3"]);
    // 另一来源不受影响
    expect((await repo.listAll()).some((c) => c.id === "c9")).toBe(true);
    await repo.deleteBySource("note", "s1");
    expect((await repo.listAll()).filter((c) => c.sourceId === "s1")).toHaveLength(0);
  });

  it("replaceSource 事务原子性:UPSERT 中途抛(非法维度嵌入)→ 整批回滚,旧块完整存在", async () => {
    const { knowledgeIndex: repo } = await makeStores();
    await repo.put(chunk("keep1", "s1", vec1024(1)));
    await repo.put(chunk("keep2", "s1"));
    // 注入一条非法块:embedding 维度 3 ≠ HNSW 的 1024 → UPSERT 在事务内抛。
    const bad: KnowledgeChunk = { ...chunk("newbad", "s1"), embedding: [1, 2, 3] };
    await expect(repo.replaceSource("note", "s1", [chunk("newgood", "s1", vec1024(2)), bad])).rejects.toThrow();
    // 原子回滚:旧块(keep1/keep2)必须完好,新块(newgood/newbad)都不该落库——绝无"被清空的中间态"。
    const ids = (await repo.listAll()).filter((c) => c.sourceId === "s1").map((c) => c.id).sort();
    expect(ids).toEqual(["keep1", "keep2"]);
  });

  it("replaceSource 复用同 chunkId(重嵌场景):不因 3.x 同事务删建同 id 而失败", async () => {
    const { knowledgeIndex: repo } = await makeStores();
    await repo.put(chunk("dup", "s1", vec1024(1)));
    const reEmb = vec1024(2);
    await repo.replaceSource("note", "s1", [chunk("dup", "s1", reEmb)]);
    const got = (await repo.listAll()).find((c) => c.id === "dup");
    expect(got?.embedding?.slice(0, 3)).toEqual(reEmb.slice(0, 3));
  });

  it("epoch 语义照搬:deleteAll 单调递增(reset/purge 后据此丢弃陈旧后台嵌入)", async () => {
    const { knowledgeIndex: repo } = await makeStores();
    const e0 = await repo.epoch();
    await repo.deleteAll();
    expect(await repo.epoch()).toBe(e0 + 1);
    await repo.deleteAll();
    expect(await repo.epoch()).toBe(e0 + 2);
    expect(await repo.listAll()).toHaveLength(0);
  });
});

describe("Surreal KnowledgeIndexRepository.searchHybrid (R2c 原生混合召回)", () => {
  // 带自定义正文/嵌入的块(chunk() 的 text 固定,这里需要区分性 fixture)。
  const kchunk = (id: string, text: string, emb?: number[]): KnowledgeChunk => ({
    id, sourceType: "note", sourceId: `src-${id}`, title: `标题-${id}`, text,
    keywords: [], ...(emb ? { embedding: emb } : {}), createdAt: "2026-06-22T00:00:00.000Z",
  });
  // SurrealStores 暴露的静态类型是 KnowledgeIndexRepository(searchHybrid 可选)——运行时对象必有,
  // 收窄为必选取用(与消费点 typeof 探测同一事实)。
  const hybridOf = (repo: SurrealStores["knowledgeIndex"]) => {
    expect(typeof repo.searchHybrid).toBe("function");
    return repo.searchHybrid!.bind(repo);
  };

  it("混合召回:query 向量的语义近邻排第一,返回完整 KnowledgeChunk 形状", async () => {
    const { knowledgeIndex: repo } = await makeStores();
    await repo.put(kchunk("near", "谈到放权与信任的边界", vec1024(1)));
    await repo.put(kchunk("far1", "今天聊了天气与跑步", vec1024(60)));
    await repo.put(kchunk("far2", "程序员的编辑器偏好", vec1024(120)));
    const hits = await hybridOf(repo)({ text: "放权信任", embedding: vec1024(1), limit: 3 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].id).toBe("near");
    // 消费契约:候选是完整块(chat 的 citation 需要 sourceType/sourceId/title/text;精排需要 embedding)。
    expect(hits[0].sourceType).toBe("note");
    expect(hits[0].sourceId).toBe("src-near");
    expect(hits[0].title).toBe("标题-near");
    expect(hits[0].text).toContain("放权");
    expect(hits[0].embedding).toHaveLength(1024);
    expect(hits[0].createdAt).toBe("2026-06-22T00:00:00.000Z");
  });

  it("BM25-only:query 无 embedding 时纯关键词命中;不含词的块不返回", async () => {
    const { knowledgeIndex: repo } = await makeStores();
    await repo.put(kchunk("bm", "区块链共识机制的取舍", vec1024(1)));
    await repo.put(kchunk("other", "晚饭吃了什么", vec1024(60)));
    const hits = await hybridOf(repo)({ text: "区块链", limit: 5 });
    expect(hits.map((h) => h.id)).toEqual(["bm"]);
  });

  it("无 embedding 的关键词降级块可达:BM25-only 与混合两条路都能召回它", async () => {
    const { knowledgeIndex: repo } = await makeStores();
    await repo.put(kchunk("noemb", "量子计算的产业前景")); // 无 embedding → HNSW 索引不含它
    await repo.put(kchunk("vec", "完全另一个话题", vec1024(1)));
    // BM25-only(查询也无向量):噪声嵌入失败/离线场景。
    const bmOnly = await hybridOf(repo)({ text: "量子计算", limit: 5 });
    expect(bmOnly.map((h) => h.id)).toContain("noemb");
    // 混合(查询有向量):BM25 路把无嵌入块带进融合,HNSW 路带回向量近邻——两者都在候选集。
    const mixed = await hybridOf(repo)({ text: "量子计算", embedding: vec1024(1), limit: 5 });
    expect(mixed.map((h) => h.id)).toContain("noemb");
    expect(mixed.map((h) => h.id)).toContain("vec");
  });

  it("rrf 融合排序:双路命中(向量近邻+关键词命中)排在单路命中之前;结果无重复", async () => {
    const { knowledgeIndex: repo } = await makeStores();
    await repo.put(kchunk("both", "星际旅行计划的想法", vec1024(1)));      // 向量同向 + 文本含词
    await repo.put(kchunk("vecOnly", "毫不相干的日常琐事", vec1024(1.05))); // 向量近 + 文本不含词
    await repo.put(kchunk("bmOnly", "读了星际旅行手册"));                   // 无嵌入 + 文本含词
    const hits = await hybridOf(repo)({ text: "星际旅行", embedding: vec1024(1), limit: 5 });
    expect(hits[0].id).toBe("both");
    const ids = hits.map((h) => h.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("vecOnly");
    expect(ids).toContain("bmOnly");
  });

  it("降级链:空 text + 有向量 → 纯 HNSW;空 text + 无向量 → [];纯符号 query 不炸且向量近邻仍第一", async () => {
    const { knowledgeIndex: repo } = await makeStores();
    await repo.put(kchunk("v1", "任意正文", vec1024(1)));
    await repo.put(kchunk("v2", "另一段正文", vec1024(80)));
    const hnsw = await hybridOf(repo)({ text: "   ", embedding: vec1024(1), limit: 2 });
    expect(hnsw[0]?.id).toBe("v1");
    expect(await hybridOf(repo)({ text: "   ", limit: 2 })).toEqual([]);
    // 纯符号:zh(class+ngram) 切不出词或 BM25 无命中——两条内部路径殊途同归,都落到向量路结果。
    const sym = await hybridOf(repo)({ text: "!!!???", embedding: vec1024(1), limit: 2 });
    expect(sym[0]?.id).toBe("v1");
  });

  it("k/ef 字面量插值防御:limit 为小数/0/NaN 都钳制不炸;超长 query 的 BM25 token 钳制不炸", async () => {
    const { knowledgeIndex: repo } = await makeStores();
    await repo.put(kchunk("a", "关于放权的看法", vec1024(1)));
    await repo.put(kchunk("b", "关于跑步的看法", vec1024(50)));
    expect((await hybridOf(repo)({ text: "放权", embedding: vec1024(1), limit: 2.7 })).length).toBeLessThanOrEqual(2);
    expect((await hybridOf(repo)({ text: "放权", embedding: vec1024(1), limit: 0 })).length).toBeGreaterThan(0);
    expect((await hybridOf(repo)({ text: "放权", embedding: vec1024(1), limit: Number.NaN })).length).toBeGreaterThan(0);
    // 超长自由输入(chat message 可达数万字):去重后 token 种类 >32(钳制分支真被走到),
    // "放权"在文本前缀 → 落在保留的前 32 个 token 里,BM25 信号不丢;语句有界,正常返回。
    const long = `放权与信任,${"甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥东南西北春夏秋冬金木水火土山川河流日月星辰风雨雷电".repeat(40)}`;
    const hits = await hybridOf(repo)({ text: long, embedding: vec1024(1), limit: 3 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].id).toBe("a");
  });

  it("deleteAll 后召回为空(库空即空,无陈旧代际可召——epoch 是进程态,表无代际列)", async () => {
    const { knowledgeIndex: repo } = await makeStores();
    await repo.put(kchunk("x", "放权话题", vec1024(1)));
    await repo.deleteAll();
    expect(await hybridOf(repo)({ text: "放权", embedding: vec1024(1), limit: 3 })).toEqual([]);
    expect(await hybridOf(repo)({ text: "放权", limit: 3 })).toEqual([]);
  });
});

describe("createSurrealStores 共享连接", () => {
  it("热态产品仓库与三冷层挂同一连接:各自 roundtrip 且 close 一次不双关", async () => {
    const stores = await makeStores();
    // 热态:一次 replaceState 往返(证明产品仓库在共享连接上正常工作)。
    const base = stores.productState.getState();
    const next = stores.productState.replaceState(base);
    expect(next.revision).toBe((base.revision ?? 0) + 1);
    await stores.productState.flush();
    // 冷层:三库各写一条。
    await stores.rawMaterial.put(rawMaterial("s1"));
    await stores.audio.put(audioOf("s1", "interviewee", new Uint8Array([1, 2, 3]), "2026-06-21T00:00:00.000Z"));
    await stores.knowledgeIndex.put(chunk("c1", "s1"));
    expect(await stores.rawMaterial.get("s1")).toBeDefined();
    expect(await stores.audio.has("s1")).toBe(true);
    expect(await stores.knowledgeIndex.listAll()).toHaveLength(1);
    // afterEach 的 close() 会关闭共享连接一次(productState.close 因 ownsConnection=false 不重复关)。
  });
});

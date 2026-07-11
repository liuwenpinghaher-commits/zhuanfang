import { describe, it, expect, afterEach } from "vitest";
import { createSurrealStores, type SurrealStores } from "./surreal-cold-repositories";
import type { ProductState } from "../../../../src/domain/types";

// N-01 真库 wedge 回归(mem:// createSurrealStores):数值/布尔 typed core 列的坏值经**完整 persist
// 路径**(replaceState → normalizeProductState → clampPersistableEnums → persist UPSERT)后落库成功
// (consecutiveFailures=0)且 DB 值为钳后合法值;并断言"坏实体 + 无辜实体同批写"不再连坐失败。
// 修复前(未加 intCount/optInt/=== true):这些坏值直落权威库 → SurrealDB SCHEMAFULL coerce 失败 →
// persist 确定性 wedge、基线冻结、连坐同事务全体(本文件顶注即 spike 实证的错误家族)。

const TS = "2026-06-27T00:00:00.000Z";
const open = new Set<SurrealStores>();
async function makeStores(): Promise<SurrealStores> {
  const stores = await createSurrealStores({ url: "mem://" });
  open.add(stores);
  return stores;
}
afterEach(async () => { for (const s of open) await s.close(); open.clear(); });

/** 从种子态出发,只覆盖被测数组(其余留种子);deliberately-illegal 值用 as never 注入。 */
function withArrays(base: ProductState, over: Partial<Record<keyof ProductState, unknown[]>>): ProductState {
  return { ...base, ...(over as Partial<ProductState>) };
}

describe("N-01 真库 wedge 回归(mem:// createSurrealStores)", () => {
  it("四类坏形态(int '3' / int null / option<int> null / bool 'yes')经完整 persist 路径落库成功且值钳合法", async () => {
    const stores = await makeStores();
    const repo = stores.productState;
    const base = repo.getState();
    repo.replaceState(withArrays(base, {
      questions: [
        { id: "qu_str", question: "q", whyImportant: "", status: "开放", appearances: "3", relatedThemeIds: [], nextPrompt: "", important: false, updatedAt: TS },   // 字符串数字
        { id: "qu_flo", question: "q", whyImportant: "", status: "开放", appearances: 4.8, relatedThemeIds: [], nextPrompt: "", important: false, updatedAt: TS },     // 小数
      ] as never,
      themes: [
        { id: "th_null", name: "t", summary: "", maturity: "萌芽", representativeQuote: "", appearances: null, nextQuestion: "", updatedAt: TS },                       // int null
      ] as never,
      memoryRecords: [
        { id: "m_null", text: "x", status: "confirmed", sourceType: "profile", sourceId: "s", evidenceQuote: "", sensitivity: "normal", importance: null, createdAt: TS, updatedAt: TS },  // option<int> null
        { id: "m_flo",  text: "y", status: "confirmed", sourceType: "profile", sourceId: "s", evidenceQuote: "", sensitivity: "normal", importance: 9.6,  createdAt: TS, updatedAt: TS },   // option<int> 小数
      ] as never,
      points: [
        { id: "pt_yes", title: "t", content: "c", status: "临时想法", confidence: "待验证", evidence: [], relatedThemeIds: [], important: "yes", updatedAt: TS },      // bool 字符串
      ] as never,
    }));
    await repo.flush();

    // ① 无 wedge:整批落库成功,健康度清零。
    expect(repo.getPersistHealth().consecutiveFailures, "坏值经 clamp 后 persist 不再 wedge").toBe(0);

    // ② DB 真值为钳后合法值(直查 mem:// 权威库,非内存副本)。
    const one = async (q: string) => (await repo.query<[unknown[]]>(q))[0]?.[0];
    expect(await one("SELECT VALUE appearances FROM question:qu_str;")).toBe(0);   // "3" → 0(fail-closed,不救活)
    expect(await one("SELECT VALUE appearances FROM question:qu_flo;")).toBe(4);   // 4.8 → 4(floor)
    expect(await one("SELECT VALUE appearances FROM theme:th_null;")).toBe(0);     // null → 0
    expect(await one("SELECT VALUE importance IS NONE FROM memory:m_null;")).toBe(true); // null → NONE
    expect(await one("SELECT VALUE importance FROM memory:m_flo;")).toBe(9);       // 9.6 → 9(floor)
    expect(await one("SELECT VALUE important FROM point:pt_yes;")).toBe(false);    // "yes" → false
  });

  it("坏实体 + 无辜实体同批写:不再连坐失败,无辜实体照常落库", async () => {
    const stores = await makeStores();
    const repo = stores.productState;
    const base = repo.getState();
    // 同一 replaceState 里:坏 question(修复前会 wedge 整个事务)+ 无辜 memoryCorrection。
    repo.replaceState(withArrays(base, {
      questions: [
        { id: "qu_bad", question: "q", whyImportant: "", status: "开放", appearances: "not-a-number", relatedThemeIds: [], nextPrompt: "", important: false, updatedAt: TS },
      ] as never,
      memoryCorrections: [
        { id: "mc_innocent", text: "无辜修正应照常落库", createdAt: TS },
      ] as never,
    }));
    await repo.flush();

    expect(repo.getPersistHealth().consecutiveFailures).toBe(0);
    // 坏 question 被钳合法后落库;无辜 memoryCorrection 不再被连坐 wedge(修复前整事务失败 → 它 +1/-0 永不落)。
    const one = async (q: string) => (await repo.query<[unknown[]]>(q))[0]?.[0];
    expect(await one("SELECT VALUE appearances FROM question:qu_bad;")).toBe(0);
    expect(await one("SELECT VALUE text FROM memory_correction:mc_innocent;")).toBe("无辜修正应照常落库");
  });

  it("UPSERT 覆盖已存在记录时缺 appearances 字段(found NONE 变体):钳制补 0,不 wedge", async () => {
    const stores = await makeStores();
    const repo = stores.productState;
    // ① 先落一个带合法 appearances 的 theme。
    repo.replaceState(withArrays(repo.getState(), {
      themes: [{ id: "th_ovr", name: "n1", summary: "", maturity: "萌芽", representativeQuote: "", appearances: 5, nextQuestion: "", updatedAt: TS }] as never,
    }));
    await repo.flush();
    expect(repo.getPersistHealth().consecutiveFailures).toBe(0);

    // ② 覆盖同 id、改 name 触发 UPSERT,但**删掉 appearances 字段**。修复前:CONTENT 不重跑 DEFAULT →
    //    该列变 NONE → coerce 失败 wedge。修复后:clamp 的 intCount(undefined)=0 恒补齐 → 落库成功。
    repo.replaceState(withArrays(repo.getState(), {
      themes: [{ id: "th_ovr", name: "n2-changed", summary: "", maturity: "萌芽", representativeQuote: "", nextQuestion: "", updatedAt: TS }] as never,
    }));
    await repo.flush();

    expect(repo.getPersistHealth().consecutiveFailures, "覆盖时缺字段被 intCount 补 0,不再 found NONE wedge").toBe(0);
    const one = async (q: string) => (await repo.query<[unknown[]]>(q))[0]?.[0];
    expect(await one("SELECT VALUE appearances FROM theme:th_ovr;")).toBe(0);
    expect(await one("SELECT VALUE name FROM theme:th_ovr;")).toBe("n2-changed");
  });
});

// N-01-embedding 真库 wedge 回归(mem:// createSurrealStores):array<float> 向量列(memory.embedding /
// rag_chunk.embedding,均 option<array<float>> + HNSW 1024)的坏值经完整 persist 路径后落库成功、
// 坏 embedding 钳成 NONE、无辜实体不连坐;合法 1024 维 embedding 原样落库且 HNSW 原生召回可达。
// 修复前:null → `Expected none|array<float> but found NULL`、非 1024 维 → `Incorrect vector dimension`
// → persist 确定性 wedge、基线冻结、连坐同事务全体(mem:// spike 实证的错误家族)。
describe("N-01-embedding 真库 wedge 回归(mem:// createSurrealStores)", () => {
  it("坏 embedding(null/非数组/含非数值/非 1024 维)经完整 persist → 不 wedge、DB 为 NONE、无辜实体不连坐", async () => {
    const stores = await makeStores();
    const repo = stores.productState;
    const base = repo.getState();
    repo.replaceState(withArrays(base, {
      memoryRecords: [
        { id: "m_null", text: "a", status: "confirmed", sourceType: "profile", sourceId: "s", evidenceQuote: "", sensitivity: "normal", embedding: null,          createdAt: TS, updatedAt: TS },  // null
        { id: "m_dim",  text: "b", status: "confirmed", sourceType: "profile", sourceId: "s", evidenceQuote: "", sensitivity: "normal", embedding: [1, 2, 3],       createdAt: TS, updatedAt: TS },  // 3 维 ≠ 1024
        { id: "m_str",  text: "c", status: "confirmed", sourceType: "profile", sourceId: "s", evidenceQuote: "", sensitivity: "normal", embedding: ["x", "y"],      createdAt: TS, updatedAt: TS },  // 含非数值元素
        { id: "m_arr",  text: "d", status: "confirmed", sourceType: "profile", sourceId: "s", evidenceQuote: "", sensitivity: "normal", embedding: "notarray",      createdAt: TS, updatedAt: TS },  // 非数组
      ] as never,
      importSources: [
        { id: "src1", title: "t", content: "c", sourceType: "text", status: "chunked", sensitivity: "normal", createdAt: TS },  // 供 rag_chunk.sourceId 挂靠,避免被悬空修剪
      ] as never,
      ragChunks: [
        { id: "rc_bad", sourceId: "src1", title: "", text: "t", keywords: [], usage: "interview-context", tokenEstimate: 1, embedding: [0.1, 0.2], createdAt: TS },  // 2 维
      ] as never,
      memoryCorrections: [
        { id: "mc_innocent", text: "无辜修正应照常落库", createdAt: TS },
      ] as never,
    }));
    await repo.flush();

    // ① 无 wedge:整批落库成功,健康度清零。
    expect(repo.getPersistHealth().consecutiveFailures, "坏 embedding 经 clamp 后 persist 不再 wedge").toBe(0);

    // ② 坏 embedding 全钳成 NONE(直查 mem:// 权威库)。
    const one = async (q: string) => (await repo.query<[unknown[]]>(q))[0]?.[0];
    expect(await one("SELECT VALUE embedding IS NONE FROM memory:m_null;")).toBe(true);
    expect(await one("SELECT VALUE embedding IS NONE FROM memory:m_dim;")).toBe(true);
    expect(await one("SELECT VALUE embedding IS NONE FROM memory:m_str;")).toBe(true);
    expect(await one("SELECT VALUE embedding IS NONE FROM memory:m_arr;")).toBe(true);
    expect(await one("SELECT VALUE embedding IS NONE FROM rag_chunk:rc_bad;")).toBe(true);

    // ③ 记录本身照常落库(只是没 embedding);无辜 memoryCorrection 不再被连坐 wedge。
    expect(await one("SELECT VALUE text FROM memory:m_dim;")).toBe("b");
    expect(await one("SELECT VALUE text FROM memory_correction:mc_innocent;")).toBe("无辜修正应照常落库");
  });

  it("合法 1024 维 embedding 经完整 persist → 原样落库且 HNSW 原生召回可达", async () => {
    const stores = await makeStores();
    const repo = stores.productState;
    // 单位向量(第 0 维为 1),cosine 稳定、与 query 向量完全同向 → 必是最近邻。
    const vec = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0));
    repo.replaceState(withArrays(repo.getState(), {
      memoryRecords: [
        { id: "m_ok", text: "语义可召回的合法向量", status: "confirmed", sourceType: "profile", sourceId: "s", evidenceQuote: "", sensitivity: "normal", embedding: vec, createdAt: TS, updatedAt: TS },
      ] as never,
    }));
    await repo.flush();

    expect(repo.getPersistHealth().consecutiveFailures).toBe(0);
    // 合法向量原样落库(未被 clamp 裁掉),长度 1024。
    const [len] = await repo.query<[number[]]>("SELECT VALUE array::len(embedding) FROM memory:m_ok;");
    expect(len?.[0]).toBe(1024);
    // 原生召回(生产路径 recallMemoriesByVector,走 HNSW):合法向量被真正建进向量索引 → 可召回。
    const hits = await repo.recallMemoriesByVector(vec, 5);
    expect(hits.some((h) => h.text === "语义可召回的合法向量"), "合法 1024 维 embedding 应被 HNSW 召回").toBe(true);
  });
});

// N-01-datetime 真库 wedge 回归(mem:// createSurrealStores):datetime typed 列(session.startedAt /
// *.createdAt / *.updatedAt / turn.timestamp / 流水 tsField)的坏日期串经完整 persist 路径后落库成功、
// 坏日期钳成固定哨兵 1970、option<datetime>(session.completedAt)坏值→NONE、合法日期原样保留、无辜实体不连坐。
// 修复前(未加 isoDate/optIsoDate):坏日期串经持久层 fillUpsertDefaults 的 `new Date(bad)` = Invalid Date
// → SDK `InvalidDateError: The provided date is invalid` → persist 确定性 wedge、基线冻结、连坐同事务全体
// (mem:// spike 实证:"not-a-date" / "" / NaN 各 consecutiveFailures=1;null/缺字段落 new Date() 不 wedge;
// option<datetime> 坏值留 rest 不 wedge——本回归覆盖会 wedge 的必填 datetime 主路径)。
describe("N-01-datetime 真库 wedge 回归(mem:// createSurrealStores)", () => {
  // SurrealDB 读回 datetime 是 SDK 包装,直接字符串比较有格式歧义;用 time::year() 读年份(哨兵→1970、
  // 合法→原年份),既证"未 wedge 且是合法 datetime",又区分"哨兵 vs 真实时刻",避开字面量/格式坑。
  const yearOf = async (repo: SurrealStores["productState"], q: string) =>
    (await repo.query<[number[]]>(q))[0]?.[0];

  it("坏日期(node datetime / turn.timestamp / 流水 tsField / option<datetime>)经完整 persist → 不 wedge、坏→哨兵1970、option→NONE、合法保留、无辜不连坐", async () => {
    const stores = await makeStores();
    const repo = stores.productState;
    const base = repo.getState();
    // 一个合法 card/guide 最小壳(rest FLEXIBLE,persist 不校验其形状);session 走 typed 列 startedAt/completedAt。
    const shell = { card: {}, guide: {}, turns: [] };
    repo.replaceState(withArrays(base, {
      memoryRecords: [
        // createdAt 坏串、updatedAt 空串(两种 wedge 形态);合法字段其余照旧。
        { id: "m_bad", text: "坏日期记忆", status: "confirmed", sourceType: "profile", sourceId: "s", evidenceQuote: "", sensitivity: "normal", createdAt: "not-a-date", updatedAt: "" },
        // 合法日期:必须原样保留(不被误伤成哨兵)。
        { id: "m_ok",  text: "合法日期记忆", status: "confirmed", sourceType: "profile", sourceId: "s", evidenceQuote: "", sensitivity: "normal", createdAt: "2026-06-27T00:00:00.000Z", updatedAt: "2026-06-27T00:00:00.000Z" },
      ] as never,
      questions: [
        { id: "qu_bad", question: "q", whyImportant: "", status: "开放", appearances: 1, relatedThemeIds: [], nextPrompt: "", important: false, updatedAt: "2026-13-99T99:99:99Z" }, // 越界坏 ISO
      ] as never,
      sessions: [
        // startedAt 坏串(node datetime,会 wedge)+ completedAt 坏串(option<datetime>,不 wedge→NONE);
        // 内嵌 turn.timestamp 坏串(经 fillUpsertDefaults 提升,会 wedge)。
        { id: "se_bad", title: "坏日期会话", mode: "daily", strength: "standard", status: "completed", ...shell,
          startedAt: "garbage", completedAt: "also-garbage",
          turns: [{ id: "tn_bad", sessionId: "se_bad", role: "user", content: "hi", timestamp: "nope-not-a-date" }] },
      ] as never,
      auditEvents: [
        { id: "ae_bad", type: "x", label: "l", detail: "d", severity: "info", entityType: "e", entityId: "id", createdAt: "not-a-date" }, // 流水 tsField 坏串
      ] as never,
      memoryCorrections: [
        { id: "mc_innocent", text: "无辜修正应照常落库", createdAt: "2026-06-27T00:00:00.000Z" },
      ] as never,
    }));
    await repo.flush();

    // ① 无 wedge:整批落库成功,健康度清零。
    expect(repo.getPersistHealth().consecutiveFailures, "坏日期经 clamp 后 persist 不再 wedge").toBe(0);

    // ② 坏日期钳成固定哨兵 1970(直查 mem:// 权威库的 typed datetime 列)。
    expect(await yearOf(repo, "SELECT VALUE time::year(createdAt) FROM memory:m_bad;"), "坏串→哨兵").toBe(1970);
    expect(await yearOf(repo, "SELECT VALUE time::year(updatedAt) FROM memory:m_bad;"), "空串→哨兵").toBe(1970);
    expect(await yearOf(repo, "SELECT VALUE time::year(updatedAt) FROM question:qu_bad;"), "越界坏 ISO→哨兵").toBe(1970);
    expect(await yearOf(repo, "SELECT VALUE time::year(startedAt) FROM session:se_bad;"), "node datetime 坏串→哨兵").toBe(1970);
    expect(await yearOf(repo, "SELECT VALUE time::year(timestamp) FROM turn:tn_bad;"), "turn.timestamp 坏串→哨兵").toBe(1970);
    expect(await yearOf(repo, "SELECT VALUE time::year(createdAt) FROM audit_event;"), "流水 tsField 坏串→哨兵").toBe(1970);

    // ③ option<datetime>(completedAt)坏值→undefined→NONE(不 wedge、不落哨兵)。
    const one = async (q: string) => (await repo.query<[unknown[]]>(q))[0]?.[0];
    expect(await one("SELECT VALUE completedAt IS NONE FROM session:se_bad;"), "option<datetime> 坏值→NONE").toBe(true);

    // ④ 合法日期原样保留(未被误伤成哨兵)。
    expect(await yearOf(repo, "SELECT VALUE time::year(createdAt) FROM memory:m_ok;"), "合法日期不误伤").toBe(2026);
    expect(await yearOf(repo, "SELECT VALUE time::year(updatedAt) FROM memory:m_ok;"), "合法日期不误伤").toBe(2026);

    // ⑤ 无辜实体照常落库(不被坏日期同批连坐 wedge)。
    expect(await one("SELECT VALUE text FROM memory_correction:mc_innocent;")).toBe("无辜修正应照常落库");
    expect(await yearOf(repo, "SELECT VALUE time::year(createdAt) FROM memory_correction:mc_innocent;"), "无辜合法日期保留").toBe(2026);
  });

  it("UPSERT 覆盖已存在记录时缺 createdAt 字段(缺字段变体):钳制补哨兵1970(确定性),不 wedge", async () => {
    const stores = await makeStores();
    const repo = stores.productState;
    // ① 先落一个带合法 createdAt 的 memory。
    repo.replaceState(withArrays(repo.getState(), {
      memoryRecords: [{ id: "m_ovr", text: "v1", status: "confirmed", sourceType: "profile", sourceId: "s", evidenceQuote: "", sensitivity: "normal", createdAt: "2026-06-27T00:00:00.000Z", updatedAt: "2026-06-27T00:00:00.000Z" }] as never,
    }));
    await repo.flush();
    expect(repo.getPersistHealth().consecutiveFailures).toBe(0);

    // ② 覆盖同 id、改 text 触发 UPSERT,但**删掉 createdAt 字段**。normalize 的 isoDate(undefined)=哨兵
    //    → 确定性补 1970(不落 fillUpsertDefaults 的非确定性 now),不 wedge。updatedAt 仍合法则保留。
    repo.replaceState(withArrays(repo.getState(), {
      memoryRecords: [{ id: "m_ovr", text: "v2-changed", status: "confirmed", sourceType: "profile", sourceId: "s", evidenceQuote: "", sensitivity: "normal", updatedAt: "2026-06-27T00:00:00.000Z" }] as never,
    }));
    await repo.flush();

    expect(repo.getPersistHealth().consecutiveFailures, "覆盖时缺 createdAt 被 isoDate 补哨兵,不 wedge").toBe(0);
    expect(await yearOf(repo, "SELECT VALUE time::year(createdAt) FROM memory:m_ovr;"), "缺字段→哨兵1970(确定性)").toBe(1970);
    expect(await yearOf(repo, "SELECT VALUE time::year(updatedAt) FROM memory:m_ovr;"), "在场合法 updatedAt 保留").toBe(2026);
    const one = async (q: string) => (await repo.query<[unknown[]]>(q))[0]?.[0];
    expect(await one("SELECT VALUE text FROM memory:m_ovr;")).toBe("v2-changed");
  });
});

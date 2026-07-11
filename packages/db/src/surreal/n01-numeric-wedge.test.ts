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

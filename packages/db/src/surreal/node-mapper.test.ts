import { describe, it, expect } from "vitest";
import { NODE_MAPPINGS, STREAM_MAPPINGS, toRecord, fromRecord, mappingFor } from "./node-mapper";
import { META_KEYS, SINGLETON_TABLES, DATETIME_DEFAULT_COLS } from "./surreal-product-state-repository";
import { createInitialProductState } from "../../../../src/domain/engine";
import { NUMERIC_BOOL_CLAMPED_COLS } from "../../../../src/domain/storage";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

describe("node-mapper", () => {
  it("point 往返:核心字段 + rest 无损", () => {
    const m = mappingFor("points")!;
    const entity = {
      id: "pt_1", title: "标题", content: "内容", status: "稳定观点",
      confidence: "用户确认", evidence: ["e1"], relatedThemeIds: ["th_1"],
      important: true, updatedAt: "2026-06-27T00:00:00.000Z", sourceSessionId: "se_1"
    };
    const rec = toRecord(entity, m);
    expect(rec.status).toBe("稳定观点");            // 核心列(受 ASSERT)
    expect((rec.rest as Record<string, unknown>).evidence).toEqual(["e1"]); // 非核心进 rest
    expect((rec.rest as Record<string, unknown>).updatedAt).toBe("2026-06-27T00:00:00.000Z"); // 日期进 rest
    expect("id" in rec).toBe(false);               // id → 记录 id,不作字段
    const back = fromRecord("pt_1", rec);
    expect(back).toEqual(entity);                   // 完整无损
  });

  it("B fromRecord:datetime 列(SDK DateTime 包装 / 原生 Date)coerce 回 ISO string", () => {
    // surreal 读回时 typed datetime 列是 SDK 的 DateTime 包装(非 string、非原生 Date);模拟之 + 原生 Date。
    const sdkDatetime = { toISOString: () => "2026-06-28T00:00:00.000Z" }; // 模拟 DateTime$1
    const back = fromRecord("pt_1", {
      title: "t", content: "c", status: "稳定观点", confidence: "用户确认", important: true,
      updatedAt: sdkDatetime, rest: { evidence: ["e1"] }
    });
    expect(typeof back.updatedAt).toBe("string");
    expect(back.updatedAt).toBe("2026-06-28T00:00:00.000Z");
    // 原生 Date 也 coerce 回 ISO string。
    expect(typeof fromRecord("m_1", { status: "x", createdAt: new Date("2026-06-28T00:00:00.000Z"), rest: {} }).createdAt).toBe("string");
    // 非日期核心值(string/number/array embedding)原样不受影响。
    const b3 = fromRecord("m_2", { text: "hi", importance: 0.5, embedding: [0.1, 0.2], rest: {} });
    expect(b3.text).toBe("hi");
    expect(b3.importance).toBe(0.5);
    expect(b3.embedding).toEqual([0.1, 0.2]);
  });

  it("覆盖全部 21 本体映射(12 认知本体 + R1a 9 类 blob 实体)", () => {
    expect(NODE_MAPPINGS.map((x) => x.stateKey).sort()).toEqual(
      ["debts","decisions","importSources","memoryCandidates","memoryRecords","notes","points","questions","ragChunks","searchBriefs","sessions","themes",
       // R1a
       "profileSuggestions","interviewAnnotations","chatSessions","memoryCorrections",
       "podcastEpisodes","corpusImports","corpusInsights","playbookPatches","configVersions"].sort()
    );
  });

  // 分区完整性守卫:ProductState 每个键必须落在 节点表(NODE_MAPPINGS) 或 流水表(STREAM_MAPPINGS,R1b)
  // 或 单例表(SINGLETON_TABLES) 或 运维尾巴(META_KEYS) 或 revision。
  // 否则将来新增数组会在 SurrealStore 落库时被静默丢弃(真数据丢失)。
  it("ProductState 全键被持久化分区覆盖(防新增数组静默丢弃)", () => {
    const covered = new Set<string>([
      ...NODE_MAPPINGS.map((m) => m.stateKey as string),
      ...STREAM_MAPPINGS.map((m) => m.stateKey as string),
      ...SINGLETON_TABLES.map((s) => s.stateKey as string),
      ...META_KEYS,
      "revision"
    ]);
    const stateKeys = Object.keys(createInitialProductState());
    const uncovered = stateKeys.filter((k) => !covered.has(k));
    expect(uncovered, `未被 NODE_MAPPINGS/META_KEYS 覆盖的键会在落库时丢失: ${uncovered.join(", ")}`).toEqual([]);
  });

  // 防漂移守卫:每个 migration 里 `TYPE datetime ... DEFAULT` 的列都必须在 DATETIME_DEFAULT_COLS 里。
  // 否则 persist 的 UPSERT CONTENT 覆盖该表已存在记录时,该列变 NONE → SCHEMAFULL coerce 静默失败。
  // 把"新增 DEFAULT datetime 列忘了同步映射"从静默数据分歧变成响亮的测试失败。
  it("DATETIME_DEFAULT_COLS 覆盖所有 migration 里的 DEFAULT datetime 列(防 UPSERT 覆盖静默失败)", () => {
    const migDir = join(dirname(fileURLToPath(import.meta.url)), "migrations");
    const re = /DEFINE FIELD (?:IF NOT EXISTS\s+)?(\w+)\s+ON\s+(\w+)\s+TYPE datetime\b[^\n;]*DEFAULT/g;
    const missing: string[] = [];
    for (const f of readdirSync(migDir).filter((x) => x.endsWith(".surql"))) {
      const sql = readFileSync(join(migDir, f), "utf8");
      for (const m of sql.matchAll(re)) {
        const [, col, tbl] = m;
        if (!(DATETIME_DEFAULT_COLS[tbl] ?? []).includes(col)) missing.push(`${tbl}.${col} (${f})`);
      }
    }
    expect(missing, `这些 DEFAULT datetime 列未登记进 DATETIME_DEFAULT_COLS,UPSERT 覆盖会静默失败: ${missing.join(", ")}`).toEqual([]);
  });

  // N-01 防漂移守卫:每个 migration 里的**标量**数值/bool typed **core** 列(TYPE int/float/number/
  // decimal/bool 及其 option 变体,进 NODE_MAPPINGS.core → 落 typed 列)都必须在 NUMERIC_BOOL_CLAMPED_COLS
  // 里有坏值兜底。否则 API PUT/坏 import 的非法值(字符串数字/null/小数/缺字段)会经 UPSERT coerce 失败
  // → persist 确定性 wedge 权威库(mem:// spike 实证)。把"新增数值/bool typed core 列忘了钳制"从静默
  // 数据缺陷变成响亮的测试失败(镜像上面的 DATETIME_DEFAULT_COLS 守卫)。双向:漏钳→missing 红;
  // 登记表有 schema 不存在的陈旧项→stale 红。刻意排除 array<float>(embedding,数组形态非标量,见登记表注释)。
  it("NUMERIC_BOOL_CLAMPED_COLS 覆盖所有 migration 里的标量数值/bool typed core 列(防坏值 wedge)", () => {
    const migDir = join(dirname(fileURLToPath(import.meta.url)), "migrations");
    const fieldRe = /DEFINE FIELD (?:IF NOT EXISTS\s+)?(\w+)\s+ON\s+(\w+)\s+TYPE\s+([^\s;]+)/g;
    // 标量数值/bool(含 option 包装);option<array<float>> / option<datetime> / array<string> 不匹配。
    const scalarNumericBool = /^(?:option<)?(?:int|float|number|decimal|bool)>?$/;
    const coreByTable = new Map(NODE_MAPPINGS.map((m) => [m.table, new Set(m.core)] as const));

    const scanned = new Set<string>();
    for (const f of readdirSync(migDir).filter((x) => x.endsWith(".surql"))) {
      const sql = readFileSync(join(migDir, f), "utf8");
      for (const [, col, tbl, type] of sql.matchAll(fieldRe)) {
        if (!scalarNumericBool.test(type)) continue;      // 只标量数值/bool
        if (!coreByTable.has(tbl)) continue;              // 非节点表(edge/state_meta/冷层)不走 persist typed core
        if (!coreByTable.get(tbl)!.has(col)) continue;    // 进 rest blob(非 core)不 wedge
        scanned.add(`${tbl}.${col}`);
      }
    }
    const registered = new Set(
      Object.entries(NUMERIC_BOOL_CLAMPED_COLS).flatMap(([tbl, cols]) => cols.map((c) => `${tbl}.${c}`))
    );

    // schema→登记:任何标量数值/bool typed core 列都必须被钳制,否则坏值确定性 wedge。
    const missing = [...scanned].filter((k) => !registered.has(k)).sort();
    expect(missing, `这些标量数值/bool typed core 列未在 NUMERIC_BOOL_CLAMPED_COLS 登记兜底,坏值会 wedge 权威库: ${missing.join(", ")}`).toEqual([]);
    // 登记→schema:登记表不得有 migration 已不存在的陈旧项(防笔误/删列后遗留)。
    const stale = [...registered].filter((k) => !scanned.has(k)).sort();
    expect(stale, `NUMERIC_BOOL_CLAMPED_COLS 有 migration 中不存在的标量数值/bool typed core 列(陈旧登记): ${stale.join(", ")}`).toEqual([]);
  });
});

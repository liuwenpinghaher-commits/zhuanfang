import { describe, it, expect } from "vitest";
import { NODE_MAPPINGS, STREAM_MAPPINGS, toRecord, fromRecord, mappingFor } from "./node-mapper";
import { META_KEYS, SINGLETON_TABLES, DATETIME_DEFAULT_COLS, OPTIONAL_DATETIME_COLS } from "./surreal-product-state-repository";
import { createInitialProductState } from "../../../../src/domain/engine";
import { NUMERIC_BOOL_CLAMPED_COLS, ARRAY_FLOAT_CLAMPED_COLS, DATETIME_CLAMPED_COLS, EMBEDDING_DIMENSION } from "../../../../src/domain/storage";
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

  // P3-12 防漂移守卫:node-mapped 表上每个 `option<datetime>`(无 DEFAULT)列都必须被"投影"——
  // 要么在 core(直接落列)、要么在 DATETIME_DEFAULT_COLS/OPTIONAL_DATETIME_COLS(从 rest 补值)。
  // 否则就是 session.completedAt 那样的死列(定义了却恒 NONE),真值只在 rest、typed 列不可查。
  // 把"新增 option<datetime> 列忘了投影"从静默死列变成响亮失败(镜像 DATETIME_DEFAULT_COLS 守卫)。
  it("OPTIONAL_DATETIME_COLS/core 覆盖所有 node-mapped 表的 option<datetime> 列(防死列)", () => {
    const migDir = join(dirname(fileURLToPath(import.meta.url)), "migrations");
    const re = /DEFINE FIELD (?:IF NOT EXISTS\s+)?(\w+)\s+ON\s+(\w+)\s+TYPE option<datetime>/g;
    const coreByTable = new Map(NODE_MAPPINGS.map((m) => [m.table, new Set(m.core)] as const));
    const dead: string[] = [];
    for (const f of readdirSync(migDir).filter((x) => x.endsWith(".surql"))) {
      const sql = readFileSync(join(migDir, f), "utf8");
      for (const m of sql.matchAll(re)) {
        const [, col, tbl] = m;
        const core = coreByTable.get(tbl);
        if (!core) continue; // 只管 node-mapped 表(单例/冷层/流水各有独立持久路径)
        const projected = core.has(col)
          || (DATETIME_DEFAULT_COLS[tbl] ?? []).includes(col)
          || (OPTIONAL_DATETIME_COLS[tbl] ?? []).includes(col);
        if (!projected) dead.push(`${tbl}.${col} (${f})`);
      }
    }
    expect(dead, `这些 option<datetime> 列从未被投影(死列,恒 NONE),须进 core 或 OPTIONAL_DATETIME_COLS: ${dead.join(", ")}`).toEqual([]);
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

  // N-01-embedding 防漂移守卫:每个 migration 里的 **array<float>**(及 option<array<float>>)typed **core** 列
  // (进 NODE_MAPPINGS.core → 落 typed 列,且各带 HNSW 向量索引)都必须在 ARRAY_FLOAT_CLAMPED_COLS 里有兜底。
  // 否则 API PUT/坏 import/第三方备份的坏 embedding(null / 非数组 / 含非数值元素 / 非 1024 维)会经 UPSERT
  // coerce 失败或 HNSW "Incorrect vector dimension" → persist 确定性 wedge 权威库(mem:// spike 实证)。
  // 与标量守卫同构、双向;类型正则只认 array<float>(与标量正则干净分区,option<array<float>> 归本守卫)。
  it("ARRAY_FLOAT_CLAMPED_COLS 覆盖所有 migration 里的 array<float> typed core 列(防坏 embedding wedge)", () => {
    const migDir = join(dirname(fileURLToPath(import.meta.url)), "migrations");
    const fieldRe = /DEFINE FIELD (?:IF NOT EXISTS\s+)?(\w+)\s+ON\s+(\w+)\s+TYPE\s+([^\s;]+)/g;
    // array<float>(含 option 包装);int/float/bool 标量 / array<string> / option<datetime> 不匹配。
    const arrayFloat = /^(?:option<)?array<float>>?$/;
    const coreByTable = new Map(NODE_MAPPINGS.map((m) => [m.table, new Set(m.core)] as const));

    const scanned = new Set<string>();
    for (const f of readdirSync(migDir).filter((x) => x.endsWith(".surql"))) {
      const sql = readFileSync(join(migDir, f), "utf8");
      for (const [, col, tbl, type] of sql.matchAll(fieldRe)) {
        if (!arrayFloat.test(type)) continue;             // 只 array<float>
        if (!coreByTable.has(tbl)) continue;              // 非节点表(冷层 knowledge_chunk/edge)不走 persist typed core
        if (!coreByTable.get(tbl)!.has(col)) continue;    // 进 rest blob(非 core)不 wedge
        scanned.add(`${tbl}.${col}`);
      }
    }
    const registered = new Set(
      Object.entries(ARRAY_FLOAT_CLAMPED_COLS).flatMap(([tbl, cols]) => cols.map((c) => `${tbl}.${c}`))
    );

    // schema→登记:任何 array<float> typed core 列都必须被钳制,否则坏 embedding 确定性 wedge。
    const missing = [...scanned].filter((k) => !registered.has(k)).sort();
    expect(missing, `这些 array<float> typed core 列未在 ARRAY_FLOAT_CLAMPED_COLS 登记兜底,坏 embedding 会 wedge 权威库: ${missing.join(", ")}`).toEqual([]);
    // 登记→schema:登记表不得有 migration 已不存在的陈旧项。
    const stale = [...registered].filter((k) => !scanned.has(k)).sort();
    expect(stale, `ARRAY_FLOAT_CLAMPED_COLS 有 migration 中不存在的 array<float> typed core 列(陈旧登记): ${stale.join(", ")}`).toEqual([]);
    // 兜底完整性:当前应恰好覆盖 memory.embedding 与 rag_chunk.embedding 两列(knowledge_chunk 是冷层不入 NODE_MAPPINGS)。
    expect([...scanned].sort()).toEqual(["memory.embedding", "rag_chunk.embedding"]);
  });

  // N-01-embedding:optFloatArray 的维度常量 EMBEDDING_DIMENSION 必须与 migration 里所有 HNSW 向量索引的
  // DIMENSION 一致。否则 clamp 放行的"合法维度"与 DB 实际约束维度不符 → 要么误伤合法向量、要么放坏值进去
  // wedge。把"改了 schema 维度忘了同步域层常量"从静默 bug 变成响亮失败。
  it("EMBEDDING_DIMENSION 与 migration 所有 HNSW DIMENSION 对齐(防维度钳制漂移)", () => {
    const migDir = join(dirname(fileURLToPath(import.meta.url)), "migrations");
    const dimRe = /HNSW\s+DIMENSION\s+(\d+)/g;
    const dims = new Set<number>();
    for (const f of readdirSync(migDir).filter((x) => x.endsWith(".surql"))) {
      for (const [, d] of readFileSync(join(migDir, f), "utf8").matchAll(dimRe)) dims.add(Number(d));
    }
    expect(dims.size, "migration 里未找到任何 HNSW DIMENSION(索引定义漂移?)").toBeGreaterThan(0);
    expect([...dims], `HNSW DIMENSION 与 EMBEDDING_DIMENSION(${EMBEDDING_DIMENSION})不一致`).toEqual([EMBEDDING_DIMENSION]);
  });

  // N-01-datetime 防漂移守卫:每个 migration 里 clampable 表(NODE_MAPPINGS ∪ STREAM_MAPPINGS ∪ {turn})
  // 上的 datetime(含 option<datetime>)typed 列都必须在 DATETIME_CLAMPED_COLS 有坏值兜底。datetime 列
  // 与前两族的关键差异:它**不在** NODE_MAPPINGS.core(日期随 rest 落库),而是 persist 的 fillUpsertDefaults
  // 把 rest 里同名 ISO **提升为 typed 列**(new Date(rest[col]))→ 存在且非法的日期串 coerce 成 Invalid Date
  // → SDK InvalidDateError → 确定性 wedge 权威库(mem:// spike 实证:"not-a-date"/""/NaN 各 +1 失败)。
  // 故此守卫的表过滤用 clampable 表集(**非** core.has),排除冷层(raw_material/audio/knowledge_chunk 由
  // 冷层仓库直写、不走本管线)。与标量/embedding 守卫同构、双向:漏钳→missing 红;陈旧登记→stale 红。
  // 类型正则只认 datetime / option<datetime>(与标量 numeric/bool、array<float>、array<string> 干净分区)。
  function scanClampableDatetimeCols(): Set<string> {
    const migDir = join(dirname(fileURLToPath(import.meta.url)), "migrations");
    const fieldRe = /DEFINE FIELD (?:IF NOT EXISTS\s+)?(\w+)\s+ON\s+(\w+)\s+TYPE\s+([^\s;]+)/g;
    const datetimeType = /^(?:option<)?datetime>?$/;
    // clampable 表 = 走 clampPersistableEnums + fillUpsertDefaults 提升的表(节点/流水/turn)。
    const clampable = new Set<string>([
      ...NODE_MAPPINGS.map((m) => m.table),
      ...STREAM_MAPPINGS.map((m) => m.table),
      "turn", // turn 不在 NODE_MAPPINGS(persist 单列处理),但 timestamp 经 fillUpsertDefaults 提升 + clampPersistableEnums 处理
    ]);
    const scanned = new Set<string>();
    for (const f of readdirSync(migDir).filter((x) => x.endsWith(".surql"))) {
      const sql = readFileSync(join(migDir, f), "utf8");
      for (const [, col, tbl, type] of sql.matchAll(fieldRe)) {
        if (!datetimeType.test(type)) continue;   // 只 datetime / option<datetime>
        if (!clampable.has(tbl)) continue;         // 冷层/edge/state_meta 不走本管线
        scanned.add(`${tbl}.${col}`);
      }
    }
    return scanned;
  }
  const registeredDatetime = () => new Set(
    Object.entries(DATETIME_CLAMPED_COLS).flatMap(([tbl, cols]) => cols.map((c) => `${tbl}.${c}`))
  );

  it("DATETIME_CLAMPED_COLS 覆盖所有 migration 里 clampable 表的 datetime typed 列(防坏日期 wedge)", () => {
    const scanned = scanClampableDatetimeCols();
    const registered = registeredDatetime();
    // schema→登记:任何 clampable 表的 datetime typed 列都必须被钳制,否则坏日期串确定性 wedge。
    const missing = [...scanned].filter((k) => !registered.has(k)).sort();
    expect(missing, `这些 datetime typed 列未在 DATETIME_CLAMPED_COLS 登记兜底,坏日期串会 wedge 权威库: ${missing.join(", ")}`).toEqual([]);
    // 登记→schema:登记表不得有 migration 已不存在的陈旧项(防笔误/删列后遗留)。
    const stale = [...registered].filter((k) => !scanned.has(k)).sort();
    expect(stale, `DATETIME_CLAMPED_COLS 有 migration 中不存在的 datetime typed 列(陈旧登记): ${stale.join(", ")}`).toEqual([]);
    // 兜底完整性 sanity:session.completedAt(option<datetime>)与流水 tsField 都在扫描集内(证明正则/表过滤真覆盖)。
    expect(scanned.has("session.completedAt"), "option<datetime> 应被扫描到").toBe(true);
    expect(scanned.has("workflow_run.startedAt"), "流水 tsField 应被扫描到").toBe(true);
    expect(scanned.has("turn.timestamp"), "turn.timestamp 应被扫描到").toBe(true);
    // 冷层 datetime 列不应进扫描集(它们不走本管线,由冷层仓库直写)。
    expect(scanned.has("audio.createdAt"), "冷层表不该被本守卫要求").toBe(false);
    expect(scanned.has("knowledge_chunk.createdAt"), "冷层表不该被本守卫要求").toBe(false);
  });

  // N-01-datetime 负控:证明上面的守卫**真能抓漏**——从真实登记表删掉一列(memory.createdAt),跑同一
  // missing 检测算法,必须报出该缺口(否则守卫是空转、给不出保护)。这是"守卫真抓漏"的实证。
  it("负控:DATETIME_CLAMPED_COLS 漏登记一列时守卫必红(证明守卫真抓漏)", () => {
    const scanned = scanClampableDatetimeCols();
    const registered = registeredDatetime();
    registered.delete("memory.createdAt"); // 人为制造漏钳
    const missing = [...scanned].filter((k) => !registered.has(k));
    expect(missing, "守卫应报出被删的 memory.createdAt").toContain("memory.createdAt");
  });
});

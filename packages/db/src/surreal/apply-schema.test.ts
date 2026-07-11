import { describe, it, expect, afterEach } from "vitest";
import type { Surreal } from "surrealdb";
import { createSurrealConnection } from "./connect.js";
import { applySchema } from "./apply-schema.js";
import { EMBEDDING_DIMENSION } from "./constants.js";

let db: Surreal | undefined;
afterEach(async () => { await db?.close(); db = undefined; });

async function freshDb(): Promise<Surreal> {
  db = await createSurrealConnection({ url: "mem://" });
  return db;
}

describe("applySchema", () => {
  it("在空库上应用全部 migrations(返回已应用文件名)", async () => {
    const d = await freshDb();
    const applied = await applySchema(d);
    expect(applied).toEqual(["001_nodes.surql", "002_relations.surql", "003_index.surql", "004_p1a_rest_meta.surql", "005_p3_cascade.surql", "006_p4_cascade_note_scope.surql", "007_r1a_entities.surql", "008_r1b_event_streams.surql", "009_r2a_cold.surql", "010_r4a_ngram.surql"]);
  });

  it("L1:关系表 ENFORCED——RELATE 指向不存在端点节点应被引擎拒绝(DB 层引用完整性兜底)", async () => {
    const d = await freshDb();
    await applySchema(d);
    // point:ghost / theme:ghost 节点不存在;ENFORCED 应拒绝建悬挂边(应用层 collectEdges 之外的双保险)。
    await expect(d.query("RELATE point:ghost->belongs_to_theme->theme:ghost;")).rejects.toThrow();
  });

  it("二次 apply 幂等:不报错、不重复、INFO 不变", async () => {
    const d = await freshDb();
    await applySchema(d);
    const second = await applySchema(d);
    expect(second).toEqual([]); // 全部已应用
    const [ledger] = await d.query<[{ name: string }[]]>("SELECT name FROM _migration;");
    const names = (ledger ?? []).map((r) => r.name).sort();
    expect(names).toEqual(["001_nodes.surql", "002_relations.surql", "003_index.surql", "004_p1a_rest_meta.surql", "005_p3_cascade.surql", "006_p4_cascade_note_scope.surql", "007_r1a_entities.surql", "008_r1b_event_streams.surql", "009_r2a_cold.surql", "010_r4a_ngram.surql"]);
  });

  it("R4a:010 迁移后 zh analyzer 升为 ngram(1,3),三个 BM25 索引重建后单字可切词", async () => {
    const d = await freshDb();
    await applySchema(d);
    // analyzer filter 已是 ngram(1,3)(010 OVERWRITE 生效)。
    const [info] = await d.query<[{ analyzers: Record<string, string> }]>("INFO FOR DB;");
    // 3.0.2 回读的 analyzer 定义为大写规范化(如 "...FILTERS NGRAM(1,3), LOWERCASE"),用小写比对。
    expect(String(info?.analyzers?.zh ?? "").toLowerCase()).toContain("ngram(1,3)");
    // 三个 zh BM25 索引齐全(memory_ft / rag_ft / kc_ft)——010 REBUILD 的全集。
    const [mem] = await d.query<[{ indexes: Record<string, string> }]>("INFO FOR TABLE memory;");
    const [rag] = await d.query<[{ indexes: Record<string, string> }]>("INFO FOR TABLE rag_chunk;");
    const [kc] = await d.query<[{ indexes: Record<string, string> }]>("INFO FOR TABLE knowledge_chunk;");
    expect(Object.keys(mem?.indexes ?? {})).toContain("memory_ft");
    expect(Object.keys(rag?.indexes ?? {})).toContain("rag_ft");
    expect(Object.keys(kc?.indexes ?? {})).toContain("kc_ft");
    // 端到端:单字全文查询命中(ngram(2,2) 下 `search::analyze` 对单字切 0 token、`@@` 恒不命中)。
    await d.query("CREATE memory:mk SET text='他喜欢赌一把大的', status='confirmed', sourceType='profile', sourceId='p', sensitivity='normal';");
    const [hit] = await d.query<[unknown[]]>("SELECT VALUE id FROM memory WHERE text @@ '赌';");
    expect((hit ?? []).length, "ngram(1,3) 下单字「赌」应命中").toBe(1);
  });

  it("INFO FOR DB:13 节点表 + entity_kind + 8 边表 + R1a 11 实体表 + R1b 4 流水表齐全", async () => {
    const d = await freshDb();
    await applySchema(d);
    const [info] = await d.query<[{ tables: Record<string, unknown> }]>("INFO FOR DB;");
    const tables = Object.keys(info?.tables ?? {});
    for (const t of [
      "entity_kind","session","turn","note","point","decision","debt","question",
      "theme","memory","memory_candidate","material","rag_chunk","search_brief",
      "derived_from","belongs_to_theme","about_theme","promoted_from","part_of",
      "corrects","contradicts","evolves_into",
      // R1a:007_r1a_entities.surql(2 单例 + 9 数组实体)
      "profile","system_config","profile_suggestion","interview_annotation","chat_session",
      "memory_correction","podcast_episode","corpus_import","corpus_insight","playbook_patch","config_version",
      // R1b:008_r1b_event_streams.surql(4 流水表)
      "audit_event","ai_run_event","workflow_run","operational_check",
      // R2a:009_r2a_cold.surql(三冷层)
      "raw_material","audio","knowledge_chunk",
    ]) {
      expect(tables, `缺表 ${t}`).toContain(t);
    }
  });

  it("INFO FOR TABLE:关键字段与索引存在", async () => {
    const d = await freshDb();
    await applySchema(d);
    const [pointInfo] = await d.query<[{ fields: Record<string, string> }]>("INFO FOR TABLE point;");
    expect(Object.keys(pointInfo?.fields ?? {})).toContain("status");
    const [memInfo] = await d.query<[{ indexes: Record<string, string> }]>("INFO FOR TABLE memory;");
    const idxNames = Object.keys(memInfo?.indexes ?? {});
    expect(idxNames).toContain("memory_emb");
    expect(idxNames).toContain("memory_ft");
  });

  it("HNSW 维度 == EMBEDDING_DIMENSION(防 DDL 与常量漂移)", async () => {
    const d = await freshDb();
    await applySchema(d);
    const [memInfo] = await d.query<[{ indexes: Record<string, string> }]>("INFO FOR TABLE memory;");
    const def = String(memInfo?.indexes?.memory_emb ?? "");
    expect(def).toContain(`DIMENSION ${EMBEDDING_DIMENSION}`);
    // R2a:009 的 knowledge_chunk HNSW 索引同样必须 == EMBEDDING_DIMENSION(009 注释"守卫防漂移"落实)。
    const [kcInfo] = await d.query<[{ indexes: Record<string, string> }]>("INFO FOR TABLE knowledge_chunk;");
    const kcDef = String(kcInfo?.indexes?.kc_emb ?? "");
    expect(kcDef).toContain(`DIMENSION ${EMBEDDING_DIMENSION}`);
  });

  it("ASSERT 拒非法 status,放行合法值", async () => {
    const d = await freshDb();
    await applySchema(d);
    // 非法 point.status 被拒
    await expect(
      d.query("CREATE point:bad SET title='x', content='y', status='不存在的状态', confidence='待验证';")
    ).rejects.toThrow();
    // 合法值放行
    const [rows] = await d.query<[{ id: unknown }[]]>(
      "CREATE point:good SET title='x', content='y', status='稳定观点', confidence='用户确认';"
    );
    expect((rows ?? []).length).toBe(1);
  });

  it("derived_from.provenance.origin ASSERT 生效", async () => {
    const d = await freshDb();
    await applySchema(d);
    await d.query("CREATE point:p1 SET title='t', content='c', status='临时想法', confidence='待验证';");
    await d.query("CREATE turn:t1 SET sessionId='s1', role='user', content='原话';");
    // 非法 origin 被拒
    await expect(
      d.query("RELATE point:p1->derived_from->turn:t1 SET provenance = { origin: 'bogus' };")
    ).rejects.toThrow();
    // 合法 origin:边建成且可读回 provenance
    await d.query("RELATE point:p1->derived_from->turn:t1 SET provenance = { origin: 'llm_extracted', turnId: 't1', confidence: 0.9 };");
    const [prov] = await d.query<[{ provenance: { origin: string } }[]]>(
      "SELECT provenance FROM derived_from;"
    );
    expect(prov?.[0]?.provenance?.origin).toBe("llm_extracted");
  });

  it("A5 cascade EVENT 定义齐全(cascade_session_delete / cascade_material_delete)", async () => {
    const d = await freshDb();
    await applySchema(d);
    const [sInfo] = await d.query<[{ events: Record<string, string> }]>("INFO FOR TABLE session;");
    expect(Object.keys(sInfo?.events ?? {})).toContain("cascade_session_delete");
    const [mInfo] = await d.query<[{ events: Record<string, string> }]>("INFO FOR TABLE material;");
    expect(Object.keys(mInfo?.events ?? {})).toContain("cascade_material_delete");
  });

  it("A5 cascade(mem://):删 session → 其 turn/note 被级联清,RELATE 边随端点节点自动消失", async () => {
    const d = await freshDb();
    await applySchema(d);
    // 造一条会话 + 它的 turn/note,并建图边(part_of: turn→session;derived_from: point→turn)。
    await d.query("CREATE session:s1 SET title='会话', mode='daily', strength='standard', status='completed';");
    await d.query("CREATE turn:t1 SET sessionId='s1', role='user', content='原话';");
    await d.query("CREATE note:n1 SET sessionId='s1', title='笔记', summary='s';");
    await d.query("CREATE point:p1 SET title='观点', content='c', status='稳定观点', confidence='用户确认';");
    await d.query("RELATE turn:t1->part_of->session:s1;");
    await d.query("RELATE point:p1->derived_from->turn:t1 SET provenance = { origin: 'llm_extracted' };");

    await d.query("DELETE session:s1;");

    const [turns] = await d.query<[unknown[]]>("SELECT id FROM turn;");
    const [notes] = await d.query<[unknown[]]>("SELECT id FROM note;");
    const [partOf] = await d.query<[unknown[]]>("SELECT id FROM part_of;");
    const [derived] = await d.query<[unknown[]]>("SELECT id FROM derived_from;");
    expect((turns ?? []).length, "turn 应被级联清(string-FK 子记录)").toBe(0);
    expect((notes ?? []).length, "006 级联收缩:note 生命周期归域层,session 删除不再级联清 note").toBe(1);
    expect((partOf ?? []).length, "part_of 边随 turn 节点删除自动消失").toBe(0);
    expect((derived ?? []).length, "derived_from 边随 turn 节点删除自动消失(无孤儿边)").toBe(0);
    // point 自身不属于 session,不应被删。
    const [points] = await d.query<[unknown[]]>("SELECT id FROM point;");
    expect((points ?? []).length, "point 不归属 session,保留").toBe(1);
  });

  it("A5 cascade(mem://):删 material → 其 rag_chunk 被级联清(派生块不成孤儿)", async () => {
    const d = await freshDb();
    await applySchema(d);
    await d.query("CREATE material:m1 SET title='素材', sourceType='text', content='正文', status='chunked';");
    await d.query("CREATE rag_chunk:c1 SET sourceId='m1', text='块', usage='interview-context';");
    await d.query("CREATE rag_chunk:c2 SET sourceId='m1', text='块2', usage='interview-context';");
    await d.query("DELETE material:m1;");
    const [chunks] = await d.query<[unknown[]]>("SELECT id FROM rag_chunk;");
    expect((chunks ?? []).length, "rag_chunk 应被级联清").toBe(0);
  });

  it("belongs_to_theme 双向图遍历(根治召回漏类的图模型基础)", async () => {
    const d = await freshDb();
    await applySchema(d);
    // SurrealDB 3.x 不允许 Chinese 字符作 bare record id;使用反引号转义
    await d.query("CREATE theme:`放权` SET name='放权', maturity='聚焦';");
    await d.query("CREATE point:p2 SET title='t', content='c', status='稳定观点', confidence='用户确认';");
    await d.query("CREATE decision:d1 SET title='t', decisionKind='用户决策', confirmationStatus='用户确认', choice='c', status='待复盘';");
    await d.query("RELATE point:p2->belongs_to_theme->theme:`放权`;");
    await d.query("RELATE decision:d1->belongs_to_theme->theme:`放权`;");
    // 出边:point → theme
    const [out] = await d.query<[{ themes: unknown[] }[]]>(
      "SELECT ->belongs_to_theme->theme AS themes FROM point:p2;"
    );
    expect((out?.[0]?.themes ?? []).length).toBe(1);
    // 入边:theme ← (point + decision) 一次拿全
    // SELECT VALUE 每个 FROM 记录返回一项,项本身是数组 → 结果是 unknown[][]
    const [pts] = await d.query<[unknown[][]]>("SELECT VALUE <-belongs_to_theme<-point FROM theme:`放权`;");
    const [decs] = await d.query<[unknown[][]]>("SELECT VALUE <-belongs_to_theme<-decision FROM theme:`放权`;");
    expect((pts?.[0] ?? []).length).toBe(1);
    expect((decs?.[0] ?? []).length).toBe(1);
  });
});

import type { ProductState, EvidenceAnchor } from "../../../../src/domain/types";

export interface EdgeSpec {
  edge: "belongs_to_theme" | "derived_from" | "about_theme" | "part_of";
  fromTable: string;
  fromId: string;
  toTable: string;
  toId: string;
  /** 仅 derived_from 携带,形如 {provenance:{...}};persist 用 `SET provenance=$d.provenance` 落库。
   *  收窄到具体形状(而非 Record<string,unknown>),防将来往 data 加字段被该 SET 静默丢弃。 */
  data?: { provenance: { origin: string; sessionId: string; turnId: string } };
}

/** turn 记录(写 turn 表用):从各 session.turns 摊平,带 sessionId 外键。
 *  3.x 校正:turn.timestamp DEFINE 为 datetime,有值才转 Date 写入;缺失则不写该字段,
 *  交给 schema 的 `DEFAULT time::now()`(persist 的 fillUpsertDefaults 在覆盖写时同样补 now),
 *  不伪造 `new Date()` 这种非确定性值。 */
export function turnRecordsOf(state: ProductState): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const s of state.sessions) {
    for (const t of s.turns ?? []) {
      const rec: Record<string, unknown> = { id: t.id, sessionId: s.id, role: t.role, content: t.content };
      // 审查加固(L5):intent 有值才写(对齐 timestamp),防将来 null 致 surreal option<string> coerce 失败、双写发散。
      if (t.intent != null) rec.intent = t.intent;
      if (t.timestamp) rec.timestamp = new Date(t.timestamp);
      out.push(rec);
    }
  }
  return out;
}

/** 把四套旧编码 + turns 投影成统一 EdgeSpec[]。theme/memory 端按 known-id 集过滤悬挂边;
 *  derived_from 的 turn 端不过滤(H1:turn 是 append-only 冷层,降冷后内存 turns 空但节点仍在,
 *  见 ② 注释)。 */
export function collectEdges(state: ProductState): EdgeSpec[] {
  const edges: EdgeSpec[] = [];
  const themeIds = new Set(state.themes.map((t) => t.id));
  const memoryIds = new Set(state.memoryRecords.map((m) => m.id));

  // ① relatedThemeIds[] → belongs_to_theme
  const theme = (fromTable: string, fromId: string, ids?: string[]) => {
    for (const tid of ids ?? []) if (themeIds.has(tid)) edges.push({ edge: "belongs_to_theme", fromTable, fromId, toTable: "theme", toId: tid });
  };
  for (const x of state.points)        theme("point", x.id, x.relatedThemeIds);
  for (const x of state.questions)     theme("question", x.id, x.relatedThemeIds);
  for (const x of state.decisions)     theme("decision", x.id, x.relatedThemeIds);
  for (const x of state.debts)         theme("debt", x.id, x.relatedThemeIds);
  for (const x of state.notes)         theme("note", x.id, x.relatedThemeIds);
  for (const x of state.sessions)      theme("session", x.id, x.relatedThemeIds);
  for (const x of state.importSources) theme("material", x.id, x.relatedThemeIds);

  // ② EvidenceAnchor → derived_from(带 provenance,指向 turn)
  // H1:turn 是 append-only 冷层 occurrent。**不**按内存 turnIds 过滤——降冷
  // (offloadCompletedSession 剥 session.turns)后内存 turns 为空,但 turn 节点在
  // surreal 里 append-only 保留。若在此过滤,持有 evidenceAnchor 的资产(point/decision)
  // 会丢掉 derived_from 投影 → diff 判为 removed → 溯源边被删 → recallProvenanceTurns 失效。
  // 改为从资产 anchor 无条件投影:资产在则边在(资产删则其 anchor 没了 → 边自然进 removed,正确)。
  // 协同 L1 ENFORCED(002 关系表 TYPE RELATION ENFORCED):anchor 来自 resolveEvidenceAnchors
  // 的真实 turn,且 turn append-only 保证写过的 turn 仍在,故 RELATE 不会因端点缺失被拒。
  const derived = (fromTable: string, fromId: string, anchors?: EvidenceAnchor[]) => {
    for (const a of anchors ?? []) edges.push({
      edge: "derived_from", fromTable, fromId, toTable: "turn", toId: a.turnId,
      data: { provenance: { origin: "llm_extracted", sessionId: a.sessionId, turnId: a.turnId } }
    });
  };
  for (const x of state.points)           derived("point", x.id, x.evidenceAnchors);
  for (const x of state.decisions)        derived("decision", x.id, x.evidenceAnchors);
  for (const x of state.debts)            derived("debt", x.id, x.evidenceAnchors);
  for (const x of state.memoryRecords)    derived("memory", x.id, x.evidenceAnchors);
  for (const x of state.memoryCandidates) derived("memory_candidate", x.id, x.evidenceAnchors);
  for (const x of state.notes)            derived("note", x.id, x.keyQuoteAnchor ? [x.keyQuoteAnchor] : undefined);
  for (const x of state.themes)           derived("theme", x.id, x.representativeQuoteAnchor ? [x.representativeQuoteAnchor] : undefined);

  // ③ MemoryEdge → about_theme(审查修复:同时过滤 from 端 memory 是否存在,与 belongs_to_theme 的 theme-end known-id 过滤对齐,杜绝悬挂边)
  for (const e of state.memoryEdges) if (themeIds.has(e.themeId) && memoryIds.has(e.fromMemoryRecordId)) edges.push({ edge: "about_theme", fromTable: "memory", fromId: e.fromMemoryRecordId, toTable: "theme", toId: e.themeId });

  // ④ session.turns → part_of(turn→session)
  for (const s of state.sessions) for (const t of s.turns ?? []) edges.push({ edge: "part_of", fromTable: "turn", fromId: t.id, toTable: "session", toId: s.id });

  return edges;
}

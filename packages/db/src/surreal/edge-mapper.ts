import type { ProductState, EvidenceAnchor } from "../../../../src/domain/types";

export interface EdgeSpec {
  edge: "belongs_to_theme" | "derived_from" | "about_theme" | "part_of" | "contradicts" | "evolves_into";
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
  // ⑤ provenance.origin 按资产确认状态【真区分】(不再写死 llm_extracted),让公理 A3
  //    (origin='llm_extracted' 未经 user_confirmed 不得当事实)在 derived_from 边上有判别力。
  //    用户确认过的资产(point.confidence/decision.confirmationStatus='用户确认'、memory.status='confirmed')
  //    → user_confirmed;其余(AI 抽/待确认/候选/笔记/主题代表句)→ llm_extracted。
  const derived = (
    fromTable: string,
    fromId: string,
    anchors?: EvidenceAnchor[],
    origin: "llm_extracted" | "user_confirmed" = "llm_extracted"
  ) => {
    for (const a of anchors ?? []) edges.push({
      edge: "derived_from", fromTable, fromId, toTable: "turn", toId: a.turnId,
      data: { provenance: { origin, sessionId: a.sessionId, turnId: a.turnId } }
    });
  };
  for (const x of state.points)           derived("point", x.id, x.evidenceAnchors, x.confidence === "用户确认" ? "user_confirmed" : "llm_extracted");
  for (const x of state.decisions)        derived("decision", x.id, x.evidenceAnchors, x.confirmationStatus === "用户确认" ? "user_confirmed" : "llm_extracted");
  for (const x of state.debts)            derived("debt", x.id, x.evidenceAnchors);
  for (const x of state.memoryRecords)    derived("memory", x.id, x.evidenceAnchors, x.status === "confirmed" ? "user_confirmed" : "llm_extracted");
  for (const x of state.memoryCandidates) derived("memory_candidate", x.id, x.evidenceAnchors);
  for (const x of state.notes)            derived("note", x.id, x.keyQuoteAnchor ? [x.keyQuoteAnchor] : undefined);
  for (const x of state.themes)           derived("theme", x.id, x.representativeQuoteAnchor ? [x.representativeQuoteAnchor] : undefined);

  // ③ memoryRecords[].relatedThemeIds → about_theme(M1:记忆主题归属统一为内嵌软链,退役 MemoryEdge 双轨)。
  //    沿用 ① theme() 的 theme-end known-id 过滤风格杜绝悬挂边;from 端遍历的是真实存在的 record(隐式过滤)。
  for (const m of state.memoryRecords)
    for (const tid of m.relatedThemeIds ?? [])
      if (themeIds.has(tid)) edges.push({ edge: "about_theme", fromTable: "memory", fromId: m.id, toTable: "theme", toId: tid });

  // ④ session.turns → part_of(turn→session)
  for (const s of state.sessions) for (const t of s.turns ?? []) edges.push({ edge: "part_of", fromTable: "turn", fromId: t.id, toTable: "session", toId: s.id });

  // ⑤ 轻量推理(欠账②):point.contradictsPointIds[] → contradicts(point↔point,symmetric)。
  //    symmetric 去重:对立是无向的,A↔B 只投影【一条】边,方向归一为 id 字典序(from<to),
  //    避免双向软链(两端各记一次)产生重复边、以及召回时把一对算成两条。
  //    point 两端均按 known-id 过滤(沿用 ① theme/③ memory 端的悬挂边杜绝风格);自指(A→A)忽略。
  const pointIds = new Set(state.points.map((p) => p.id));
  const seenContradicts = new Set<string>();
  for (const p of state.points) {
    for (const otherId of p.contradictsPointIds ?? []) {
      if (p.id === otherId || !pointIds.has(otherId)) continue;
      const [lo, hi] = p.id < otherId ? [p.id, otherId] : [otherId, p.id];
      const key = `${lo}|${hi}`;
      if (seenContradicts.has(key)) continue;
      seenContradicts.add(key);
      edges.push({ edge: "contradicts", fromTable: "point", fromId: lo, toTable: "point", toId: hi });
    }
  }

  // ⑥ 取代关系(欠账②):point.supersededByPointId → evolves_into(旧→新,有向)。
  //    复活 002 的 evolves_into 死表 + 让"观点取代"在图层可达(此前只有内嵌软链 supersededByPointId,
  //    图遍历不到)。两端按 known-id 过滤(沿用悬挂边杜绝风格);自指(A→A)忽略。
  for (const p of state.points) {
    const newId = p.supersededByPointId;
    if (!newId || newId === p.id || !pointIds.has(newId)) continue;
    edges.push({ edge: "evolves_into", fromTable: "point", fromId: p.id, toTable: "point", toId: newId });
  }

  return edges;
}

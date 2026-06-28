import type { ProductState } from "./types";
import { clampMaturityByAppearances } from "./finalize";

/**
 * 公理引擎(P3 · spec 03)。把本体论 A1–A5(ontology/01 §5.4)从"散落手写"提升为
 * **一处统一的确定性校验器**。SHACL 式、封闭世界(CWA):只检查 state 里已有的事实、
 * 报违例,**不推新事实、不拦写**(对齐 D5/D6:不引入 OWL reasoner)。
 *
 * 与现有散落规则的关系(本期不收敛 T6):finalize 的 clampMaturityByAppearances、
 * context-pack 的 status==='confirmed' 过滤、context-pack/knowledge 的 isModelSafeMemoryRecord
 * 过滤**继续各自工作**;checkAxioms 是新增的**统一兜底/审计层**——同一规则在此再核一遍,
 * 任一链路漏了都能在审计里看到违例,避免大改回归。
 *
 * A5(删除级联根除孤儿)由 **DB 强制**(005 migration 的 DEFINE EVENT + SurrealDB 原生
 * RELATE 边自维护),不在此纯函数里——这里只覆盖 A1–A4 这类语义/跨实体推导。
 */
export interface AxiomViolation {
  axiom: "A1" | "A2" | "A3" | "A4";
  entityType: "point" | "decision" | "debt" | "theme" | "memory_record";
  entityId: string;
  detail: string;
}

export function checkAxioms(state: ProductState): AxiomViolation[] {
  return [
    ...checkA1_provenance(state),
    ...checkA2_maturity(state),
    ...checkA3_hitl(state),
    ...checkA4_sensitive(state),
  ];
}

/**
 * A1 · 每个 Distillation(point/decision/debt)应有 ≥1 条溯源(evidenceAnchors)。
 * 无溯源 = 幻觉(无 derived_from)。域层用 evidenceAnchors 承载溯源,collectEdges 投影成
 * derived_from 边——所以"无 evidenceAnchors"等价于"无 derived_from 出边"。
 *
 * 欠账④ 评估:这三段循环看似可用 collectDistillations 收敛,但各类的 entityType 字面量、
 * 文案前缀、取名字段(point/decision 用 title、debt 用 concept)都不同,且 DualTrackNote
 * 虽同属 Distillation 却走 keyQuoteAnchor 而非 evidenceAnchors——收敛需引入带类型转换的
 * 描述符表,复杂度 > 收益(红线:不为收敛硬塞 cast)。故**保持三段显式循环**,只在父类
 * 类型层(types.ts)体现"它们是 Distillation 兄弟",逻辑不强行收敛。
 */
export function checkA1_provenance(state: ProductState): AxiomViolation[] {
  const out: AxiomViolation[] = [];
  const lacks = (anchors: unknown[] | undefined) => !anchors || anchors.length === 0;
  for (const p of state.points) {
    if (lacks(p.evidenceAnchors)) {
      out.push({ axiom: "A1", entityType: "point", entityId: p.id, detail: `观点《${p.title}》缺少证据溯源(evidenceAnchors),无法回指来源 turn。` });
    }
  }
  for (const d of state.decisions) {
    if (lacks(d.evidenceAnchors)) {
      out.push({ axiom: "A1", entityType: "decision", entityId: d.id, detail: `决策《${d.title}》缺少证据溯源(evidenceAnchors),无法回指来源 turn。` });
    }
  }
  for (const d of state.debts) {
    if (lacks(d.evidenceAnchors)) {
      out.push({ axiom: "A1", entityType: "debt", entityId: d.id, detail: `知识债《${d.concept}》缺少证据溯源(evidenceAnchors),无法回指来源 turn。` });
    }
  }
  return out;
}

/**
 * A2 · Theme.maturity ≤ f(appearances)(涌现属性,01 §4.7)。成熟度不能超过出现次数允许的
 * 天花板。复用 finalize 的 clampMaturityByAppearances 作为单一真值:存储值若高于 clamp 结果即违例。
 */
export function checkA2_maturity(state: ProductState): AxiomViolation[] {
  const out: AxiomViolation[] = [];
  for (const t of state.themes) {
    const ceiling = clampMaturityByAppearances(t.maturity, t.appearances);
    if (ceiling !== t.maturity) {
      out.push({
        axiom: "A2",
        entityType: "theme",
        entityId: t.id,
        detail: `主题《${t.name}》成熟度「${t.maturity}」超出出现 ${t.appearances} 次允许的上限「${ceiling}」。`,
      });
    }
  }
  return out;
}

/**
 * A3 · provenance.origin='llm_extracted' 未经 user_confirmed 不得呈现为"事实"(HITL 门控)。
 * 域层 MemoryRecord 以 status 编码确认态:仅 status==='confirmed' 是已确认事实。
 *
 * 事后审计语义(spec §3「checkAxioms 只做事后核对」+ 与 A4 平行):只有 confirmed 记忆才应
 * 派生进入召回的 rag_chunk。这里检查"非 confirmed 记忆却派生了可召回索引块"——即未确认/已弃用
 * 内容仍被当事实召回(要么未经 HITL 就索引,要么弃用后漏清)。
 * 关键:**不把"存在非 confirmed 记忆"本身当违例**——pending/deprecated/deleted 是 HITL 流程与
 * 记忆生命周期的正常态,只有它越权进入召回索引才算违例,否则每次 finalize 都会刷审计噪音。
 */
export function checkA3_hitl(state: ProductState): AxiomViolation[] {
  const unconfirmed = new Map(
    state.memoryRecords
      .filter((r) => r.status !== "confirmed")
      .map((r) => [r.id, r] as const),
  );
  if (unconfirmed.size === 0) {
    return [];
  }
  const out: AxiomViolation[] = [];
  const reported = new Set<string>();
  for (const chunk of state.ragChunks) {
    const record = unconfirmed.get(chunk.sourceId);
    if (record && !reported.has(record.id)) {
      reported.add(record.id);
      out.push({
        axiom: "A3",
        entityType: "memory_record",
        entityId: record.id,
        detail: `未确认/已弃用长期记忆(status「${record.status}」)派生了可召回索引块(rag_chunk:${chunk.id}),未经 HITL 确认不应作为事实进入召回。`,
      });
    }
  }
  return out;
}

/**
 * A4 · sensitivity='sensitive' 的 Memory 不应产生进入公开召回/索引的派生块(除非 policy 开)。
 * 对齐 context-pack 的 isModelSafeMemoryRecord + knowledge 的 buildKnowledgeChunks 过滤:
 * 默认敏感记忆不进 chat 可召回索引。这里检查"已落库的派生 ragChunk 指回了某条敏感记忆"——
 * 即敏感内容已泄入索引(孤儿/越权派生)。policy includeSensitiveMemoriesInContext 开启时放行。
 */
export function checkA4_sensitive(state: ProductState): AxiomViolation[] {
  if (state.systemConfig.memory.includeSensitiveMemoriesInContext) {
    return [];
  }
  const sensitiveMemoryIds = new Map(
    state.memoryRecords
      .filter((r) => (r.sensitivity ?? "normal") === "sensitive")
      .map((r) => [r.id, r] as const),
  );
  if (sensitiveMemoryIds.size === 0) {
    return [];
  }
  const out: AxiomViolation[] = [];
  const reported = new Set<string>();
  for (const chunk of state.ragChunks) {
    const record = sensitiveMemoryIds.get(chunk.sourceId);
    if (record && !reported.has(record.id)) {
      reported.add(record.id);
      out.push({
        axiom: "A4",
        entityType: "memory_record",
        entityId: record.id,
        detail: `敏感长期记忆派生了可召回索引块(rag_chunk:${chunk.id}),违反敏感隔离;应在派生期排除或开启 policy。`,
      });
    }
  }
  return out;
}

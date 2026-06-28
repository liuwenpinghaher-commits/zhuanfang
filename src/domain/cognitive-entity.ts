// 本体论分类法的运行时单一真值(欠账④ · 原子 D · ontology/01 §5.2)。
//
// types.ts 用结构性 extends 把"认知实体"家族树钉成类型层级(CognitiveEntity →
// Distillation/Inquiry/Axis/Memory)。本文件给出**收集器**:把 ProductState 里平行的
// 各资产数组聚成父类数组。
//
// 单一真值意义:今天"哪些数组属于蒸馏类/认知实体"散落在 privacy/axioms 等处各自手工枚举,
// 加一种新资产类型就得到处补;改用这两个 helper 后,**新增资产类型只需改这里一处**,
// 下游遍历父类即可,从根上少一类"漏一类"的 bug(召回漏 decisions、清空漏计数……同根因)。
//
// 务实边界(诚实优先):父类目前只承载真共性 `id`(字段不一致是历史现状,本期不强行统一,
// 见 types.ts CognitiveEntity 注释)。因此这些 helper 适合"按父类做计数/遍历/治理"的场景;
// 凡需要各资产**专有字段**(evidenceAnchors vs keyQuoteAnchor、status 文案……)的逻辑,
// 仍应直接访问具体数组——不为收敛而把专有字段塞进父类或退化成 any。

import type {
  CognitiveEntity,
  DecisionAsset,
  Distillation,
  DualTrackNote,
  KnowledgeDebt,
  LongTermTheme,
  MemoryRecord,
  PointAsset,
  ProductState,
  QuestionAsset,
} from "./types";

/**
 * 蒸馏类资产(Note / Point / Decision / Debt)汇成一个 Distillation[]。
 *
 * 保留各数组的具体元素类型(联合),不丢失信息——返回值声明为父类 Distillation[],
 * 调用方只应依赖父类共性(id);需要专有字段时请直接用具体数组。
 */
export function collectDistillations(
  state: Pick<ProductState, "notes" | "points" | "decisions" | "debts">,
): Distillation[] {
  return [...state.notes, ...state.points, ...state.decisions, ...state.debts];
}

/**
 * 全部认知实体(蒸馏 + 追问 Question + 主轴 Theme + 记忆 MemoryRecord)汇成 CognitiveEntity[]。
 *
 * = collectDistillations(state) ∪ questions ∪ themes ∪ memoryRecords。
 * 用于"对所有可溯源/可归类/可治理实体统一处理"的场景(如统一计数、统一遍历)。
 * 复用 collectDistillations 以保持"蒸馏成员清单"的单一真值。
 */
export function collectCognitiveEntities(
  state: Pick<
    ProductState,
    "notes" | "points" | "decisions" | "debts" | "questions" | "themes" | "memoryRecords"
  >,
): CognitiveEntity[] {
  return [
    ...collectDistillations(state),
    ...state.questions,
    ...state.themes,
    ...state.memoryRecords,
  ];
}

// 便于下游(测试/消费点)拿到"成员资产数组"的具体类型联合,而不必散落重复声明。
export type DistillationAsset = DualTrackNote | PointAsset | DecisionAsset | KnowledgeDebt;
export type CognitiveEntityAsset =
  | DistillationAsset
  | QuestionAsset
  | LongTermTheme
  | MemoryRecord;

/**
 * "认知资产"隐私/迁移类目的计数:point + question + decision + debt + theme。
 *
 * 诚实标注边界:这是 privacy/migration 面向用户的**数据类目**口径,**不是**家族树节点——
 * 它跨切了分类法(notes 归到"专访"类目、memoryRecords 归到"长期记忆"类目,故都不计入),
 * 因此既 ≠ collectDistillations(含 notes、缺 question/theme)也 ≠ collectCognitiveEntities
 * (含 notes + memoryRecords)。
 *
 * 抽出它纯粹是消除一处**逐字重复**:privacy.buildPrivacyReport 与 migration 的 "assets"
 * 类目原本各写一遍同一道求和,口径必须一致(隐私 report 与 scoped-purge 同源校验)。
 * 单一真值:这五个数组的口径只此一处。
 */
export function countRetrievableAssetCategory(
  state: Pick<ProductState, "points" | "questions" | "decisions" | "debts" | "themes">,
): number {
  return (
    state.points.length +
    state.questions.length +
    state.decisions.length +
    state.debts.length +
    state.themes.length
  );
}

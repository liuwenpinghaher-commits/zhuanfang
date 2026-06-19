# R4 · 记忆简化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。迁移 TDD + 往返;改动前 grep 消费点。

**Goal:** 砍掉记忆层的过度设计——memoryEdges 从 6×5 的图结构简化为最小 record→主题软链;memoryCorrections 修复"全量直传";已审候选加保留窗口裁剪。保留真实消费(HITL 闸门、hasGraphReference 信号、喂专访)。

**Architecture:** 简化类型 + 迁移 + 有界化,零新依赖。每项先 grep 消费点确认,保留被真实消费的信号。

**Tech Stack:** TS/React, Vitest。验证:`npm run typecheck` / `npx vitest run --exclude "**/*.real.test.ts"`。

设计:`docs/superpowers/specs/2026-06-19-cognitive-assets-consolidation-design.md` 第 3 节 R4。

---

## 通用约束
- 顶层 `src/`(忽略 zhuanfang)。提交只 `git add` 本 Task 文件,禁 `git add -A/.`。
- 每 Task:`npm run typecheck` + `npx vitest run --exclude "**/*.real.test.ts"` 全绿 + git status 核无关文件未暂存。

## 已核实(消费点)
- `memoryEdges`→`buildContextPackMemoryEdges`(context-pack:86)→`graphReferences`(:317)→ guide(:507)→ `strategy.ts:554 hasGraphReference`(**仅布尔信号被消费**;rich 字段 relation/weight/evidenceQuote/targetType **不进 LLM 提示/语音**)。`buildMemoryEdgesForRecord`(关键词重叠建边)、`buildMemoryEdgeLabel`、`buildMemoryGraphReferences` 在 context-pack/engine。
- `memoryCorrections`→ context-pack:335 **全量直传** `corrections`;ProfileView:70 显示;App:940 `markMemoryCorrection` 创建。
- 候选:approved/rejected 永久堆积(无裁剪)。

---

## Task 1: 简化 memoryEdges 为最小 record→主题软链

**Files:** Modify `src/domain/types.ts`、`src/domain/context-pack.ts`、`src/domain/storage.ts`(迁移)、相关测试。

- [ ] **Step 1:** 读 `src/domain/types.ts` 的 `MemoryEdge`(及 targetType/relation 枚举)、`src/domain/context-pack.ts` 的 `buildMemoryEdgesForRecord`/`buildContextPackMemoryEdges`/`buildMemoryGraphReferences`/`buildMemoryEdgeLabel`、`strategy.ts:554` 的 `hasGraphReference` 用法(它 gate 什么)。
- [ ] **Step 2:** 简化:`MemoryEdge` 砍为最小 `{ id?, fromMemoryRecordId, themeId, createdAt? }`(删 targetType/relation/weight/label/evidenceQuote;只保留"记录关联哪个主题")。`buildMemoryEdgesForRecord`:仍用关键词重叠把 record 连到 **themes**(只连主题,不再连其它 6 类 target),产出简化 edge。`buildMemoryGraphReferences`:据简化 edge 产出 graphReferences(保证 `graphReferences.length`/`hasGraphReference` 仍工作,strategy 行为不变)。删 `buildMemoryEdgeLabel`(relation label 不再需要)及 relation/targetType 枚举(若全仓无其它引用)。
- [ ] **Step 3:** 迁移:`storage.ts normalizeProductState` 的 memoryEdges 归一——把历史 rich edge 迁移为简化形(取 fromMemoryRecordId + 若 targetType==="long_term_theme" 则 targetId→themeId,否则丢弃该 edge);TDD 往返:历史 rich edge → 简化 edge(只剩 theme 链),非 theme target 的 edge 被丢弃。
- [ ] **Step 4:** `npm run typecheck` exit 0(枚举/字段删净)+ `npx vitest run --exclude "**/*.real.test.ts"` 全绿(MemoryEdge 相关测试同步简化;**确认 strategy 的 hasGraphReference 测试/行为不变**)。**若 hasGraphReference 删 relation 后行为变化波及 ≥3 处或改变可观察输出,DONE_WITH_CONCERNS 报告。**
- [ ] **Step 5:** 提交:只 add 改动文件,`git commit -m "refactor(memory): simplify MemoryEdge to record→theme soft link (drop dead graph fields) (R4)"`。

---

## Task 2: memoryCorrections 有界化 + 已审候选裁剪

**Files:** Modify `src/domain/context-pack.ts`(corrections 限流)、`src/domain/storage.ts`(normalize 裁剪)、相关测试。

- [ ] **Step 1:** 读 `context-pack.ts:335` 的 `corrections: state.memoryCorrections`(全量直传)、`storage.ts normalizeProductState` 的 memoryCorrections/memoryCandidates 归一。
- [ ] **Step 2(corrections 有界):** context-pack 的 corrections 改为只取最近 N 条(常量 `MAX_CONTEXT_CORRECTIONS = 20`,按 createdAt 倒序 slice),修复无界直传。加注释。TDD:>20 条 corrections → contextPack.corrections ≤ 20 且是最近的。
- [ ] **Step 3(候选裁剪):** `normalizeProductState`:对 memoryCandidates 裁剪——保留全部 pending + 最近 N 条 approved/rejected(常量 `MAX_REVIEWED_CANDIDATES = 200`),避免已审候选无限堆积。加注释 `// ponytail: 保留 pending 全量 + 最近 200 已审,防 state 膨胀`。TDD:构造 >200 条 approved 候选 → normalize 后 approved 数 ≤ 200,pending 全保留。
- [ ] **Step 4:** `npm run typecheck` exit 0 + `npx vitest run --exclude "**/*.real.test.ts"` 全绿。
- [ ] **Step 5:** 提交:只 add 改动文件 + 测试,`git commit -m "fix(memory): bound context corrections + prune reviewed candidates (R4)"`。

---

## Self-Review
**1. Spec 覆盖:** memoryEdges 简化(T1)、corrections 有界(T2)、候选裁剪(T2)。memoryCorrections 未"并入 record"——改为有界化(更低风险,修复真问题"全量直传";并入 record 因 correction 不绑定具体 record 而 awkward,DONE_WITH_CONCERNS 式偏离已说明)。
**2. 占位扫描:** 无 TBD;改动前 grep 消费点,保留 hasGraphReference 信号。
**3. 一致性:** MemoryEdge 简化形跨 type/context-pack/migration 一致;常量命名一致。
**4. 风险:** 简化 edge 可能动 strategy 的 hasGraphReference——T1 显式要求保持该信号 + 行为不变,超阈值 DONE_WITH_CONCERNS。迁移往返测试兜底。

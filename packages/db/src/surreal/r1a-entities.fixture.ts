import type { ProductState } from "../../../../src/domain/types";

/** R1a 测试 fixture:覆盖全部 11 类真表化实体(9 数组每类 2 条含枚举边界值 + 2 单例改动)。
 *  12 既有本体数组刻意清空——既有表往返已有专测,这里让 digest 等价断言只聚焦 R1a 面。
 *  ⚠️ 数组按**生产 prepend 序**构造(newest-first:*_b createdAt 更新、排在前)——域层这 9 类
 *  写入点全是 prepend;而 SELECT 无 ORDER BY 按 record id 升序返回(*_a 在前),两序相反。
 *  digest 是顺序敏感的:roundtrip 等价必须依赖 loadState 的 createdAt DESC 重排
 *  (R1A_PREPEND_TABLES)才能通过,即本 fixture 在真实数据形状下钉死重载序不反转。 */
export function buildR1aFixtureState(base: ProductState): ProductState {
  return {
    ...base,
    sessions: [], notes: [], points: [], questions: [], decisions: [], debts: [], themes: [],
    memoryRecords: [], memoryCandidates: [], searchBriefs: [], importSources: [], ragChunks: [],
    profile: { ...base.profile, name: "R1a测试者", currentFocus: "真表化验证" },
    systemConfig: { ...base.systemConfig, search: { ...base.systemConfig.search, recencyDays: 42 } },
    profileSuggestions: [
      { id: "ps_b", field: "longTermGoal", currentValue: "旧目标", suggestedValue: "新目标", reason: "阶段变化", evidenceQuote: "原话2", sourceSessionId: "se_y", status: "rejected", createdAt: "2026-07-10T00:01:00.000Z", reviewedAt: "2026-07-10T01:00:00.000Z" },
      { id: "ps_a", field: "currentFocus", currentValue: "旧焦点", suggestedValue: "新焦点", reason: "访谈中反复出现", evidenceQuote: "原话", sourceSessionId: "se_x", status: "pending", createdAt: "2026-07-10T00:00:00.000Z" }
    ],
    interviewAnnotations: [
      { id: "an_b", sessionId: "se_y", turnId: "tu_2", text: "旁注二", createdAt: "2026-07-10T00:01:00.000Z" },
      { id: "an_a", sessionId: "se_x", turnId: "tu_1", text: "旁注一", createdAt: "2026-07-10T00:00:00.000Z" }
    ],
    chatSessions: [
      { id: "ch_b", title: "问答二", messages: [], createdAt: "2026-07-10T00:01:00.000Z", updatedAt: "2026-07-10T00:01:00.000Z" },
      { id: "ch_a", title: "问答一", messages: [{ id: "msg_1", role: "user", content: "你好", createdAt: "2026-07-10T00:00:00.000Z" }], createdAt: "2026-07-10T00:00:00.000Z", updatedAt: "2026-07-10T00:05:00.000Z" }
    ],
    memoryCorrections: [
      { id: "mc_b", text: "纠偏二", createdAt: "2026-07-10T00:01:00.000Z" },
      { id: "mc_a", text: "纠偏一", createdAt: "2026-07-10T00:00:00.000Z" }
    ],
    podcastEpisodes: [
      { id: "pe_b", noteId: "no_2", title: "第二期", format: "host-guest", voice: "longanyang", status: "draft", scriptReviewStatus: "待确认", durationSec: 0, script: "", chapters: [], audioUrl: "", shownotes: [], createdAt: "2026-07-10T00:01:00.000Z" },
      { id: "pe_a", noteId: "no_1", title: "第一期", format: "solo", voice: "longanhuan", status: "ready", scriptReviewStatus: "用户确认", durationSec: 120, script: "播客台词", chapters: [{ title: "开场", startsAtSec: 0, summary: "s" }], audioUrl: "blob:x", shownotes: ["要点"], createdAt: "2026-07-10T00:00:00.000Z", sourceType: "note", sourceId: "no_1" }
    ],
    corpusImports: [
      { id: "ci_b", title: "语料二", mediaType: "audio", content: "转写文本", sourceUrl: "https://example.com/a.mp3", status: "analyzed", turns: [], createdAt: "2026-07-10T00:01:00.000Z" },
      { id: "ci_a", title: "语料一", mediaType: "text", content: "正文", status: "analyzed", turns: [{ speaker: "主持", content: "问题", move: "opening" }], createdAt: "2026-07-10T00:00:00.000Z" }
    ],
    corpusInsights: [
      { id: "cn_b", importId: "ci_b", title: "洞察二", dimensions: [], improvementPlan: [], recommendedPatches: [], createdAt: "2026-07-10T00:01:00.000Z" },
      { id: "cn_a", importId: "ci_a", title: "洞察一", dimensions: [{ name: "追问深度", score: 4, finding: "f", example: "e", recommendedAction: "a" }], improvementPlan: [], recommendedPatches: [], createdAt: "2026-07-10T00:00:00.000Z" }
    ],
    playbookPatches: [
      { id: "pp_b", title: "补丁二", description: "d2", sourceInsightId: "cn_b", status: "reverted", rules: [], impact: "low", createdAt: "2026-07-10T00:01:00.000Z", revertedAt: "2026-07-10T02:00:00.000Z" },
      { id: "pp_a", title: "补丁一", description: "d", sourceInsightId: "cn_a", sourceImportId: "ci_a", status: "applied", rules: ["规则1"], impact: "high", createdAt: "2026-07-10T00:00:00.000Z", appliedAt: "2026-07-10T01:00:00.000Z" }
    ],
    configVersions: [
      { id: "cv_b", version: "v2", createdAt: "2026-07-10T00:01:00.000Z", changedBy: "system", reason: "升级", diff: ["b"], active: true, affectedSessions: ["se_x"], snapshot: base.systemConfig, rollbackTarget: "cv_a" },
      { id: "cv_a", version: "v1", createdAt: "2026-07-10T00:00:00.000Z", changedBy: "user", reason: "初始", diff: ["a"], active: false, affectedSessions: [], snapshot: base.systemConfig }
    ]
  };
}

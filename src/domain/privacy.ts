import { createInitialProductState } from "./engine";
import type { AuditEvent, ProductState } from "./types";

export type PrivacyInventoryCategoryId =
  | "profile"
  | "interviews"
  | "assets"
  | "memory"
  | "external_knowledge"
  | "corpus_learning"
  | "generated_media"
  | "operations";

export interface PrivacyInventoryItem {
  id: PrivacyInventoryCategoryId;
  label: string;
  count: number;
  detail: string;
  exported: boolean;
  purged: boolean;
}

export interface PrivacyOperationsReport {
  exportAvailable: boolean;
  importAvailable: boolean;
  purgeAvailable: boolean;
  resetToDemoAvailable: boolean;
  providerSecretsExcluded: boolean;
  runtimeEnvPreservedOnPurge: boolean;
}

export interface PrivacyReport {
  generatedAt: string;
  totalRecords: number;
  hasPersonalData: boolean;
  inventory: PrivacyInventoryItem[];
  operations: PrivacyOperationsReport;
  retentionNotes: string[];
}

export function buildPrivacyReport(state: ProductState, generatedAt = new Date().toISOString()): PrivacyReport {
  const inventory: PrivacyInventoryItem[] = [
    {
      id: "profile",
      label: "显性档案与边界",
      count: countProfileRecords(state),
      detail: "姓名、角色、行业、当前关注、长期目标、显式边界和 AI 推断线索。",
      exported: true,
      purged: true
    },
    {
      id: "interviews",
      label: "专访与双轨笔记",
      count: state.sessions.length + state.notes.length,
      detail: "会话、轮次、控制动作、实时信号、会后双轨笔记和关键引用。",
      exported: true,
      purged: true
    },
    {
      id: "assets",
      label: "观点、问题、决策、知识债和主题",
      count: state.points.length + state.questions.length + state.decisions.length + state.debts.length + state.themes.length,
      detail: "专访沉淀出的可检索资产、状态流转和长期追踪主题。",
      exported: true,
      purged: true
    },
    {
      id: "memory",
      label: "长期记忆治理",
      count: state.memoryCorrections.length + state.memoryRecords.length + state.memoryCandidates.length + state.memoryEdges.length,
      detail: "用户修正、候选记忆、确认记忆、敏感隔离和记忆图谱边。",
      exported: true,
      purged: true
    },
    {
      id: "external_knowledge",
      label: "联网资料与 RAG",
      count: state.searchBriefs.length + state.importSources.length + state.ragChunks.length,
      detail: "SearchBrief、导入资料、来源引用、RAG chunks 和外部素材转资产记录。",
      exported: true,
      purged: true
    },
    {
      id: "corpus_learning",
      label: "导入专访学习",
      count: state.corpusImports.length + state.corpusInsights.length + state.playbookPatches.length,
      detail: "导入文本/音频专访、分析维度、改进建议和确认后的 PlaybookPatch。",
      exported: true,
      purged: true
    },
    {
      id: "generated_media",
      label: "播客与生成物",
      count: state.podcastEpisodes.length,
      detail: "播客脚本、shownotes、音频地址、渲染状态和声音配置。",
      exported: true,
      purged: true
    },
    {
      id: "operations",
      label: "审计与运行记录",
      // workflowRuns / operationalChecks are not yet produced by any code path, so they
      // are excluded here rather than implying coverage the system doesn't have.
      count:
        state.auditEvents.length +
        state.aiRunEvents.length +
        state.configVersions.length,
      detail: "审计事件、AI run event 和配置版本历史。",
      exported: true,
      purged: true
    }
  ];
  const totalRecords = inventory.reduce((total, item) => total + item.count, 0);
  const personalRecords = inventory
    .filter((item) => item.id !== "operations")
    .reduce((total, item) => total + item.count, 0);

  return {
    generatedAt,
    totalRecords,
    hasPersonalData: personalRecords > 0,
    inventory,
    operations: {
      exportAvailable: true,
      importAvailable: true,
      purgeAvailable: true,
      resetToDemoAvailable: true,
      providerSecretsExcluded: true,
      runtimeEnvPreservedOnPurge: true
    },
    retentionNotes: [
      "JSON 导出包含产品状态，不包含 .env.local、DASHSCOPE_API_KEY、BAILIAN_API_KEY 或第三方搜索 key。",
      "通过 Product API 执行彻底清空时，会删除个人档案、专访、资产、记忆、导入资料、播客、运行历史和已引用的 local-object 本地音频原件，只保留当前 provider/模型配置和一条清空审计事件。",
      "重置演示数据会恢复初始样例，不等同于隐私清空；生产删除应使用彻底清空。"
    ]
  };
}

export function createPurgedProductState(currentState: ProductState, createdAt = new Date().toISOString()): ProductState {
  const baseState = createInitialProductState();
  const purgeEvent: AuditEvent = {
    id: `audit-privacy-purge-${createdAt.replace(/[^0-9]/g, "")}`,
    type: "privacy_data_purged",
    label: "个人数据已彻底清空",
    detail: "用户执行隐私清空：个人档案、专访、资产、记忆、导入资料、播客、运行事件和配置版本历史已移除；provider 运行配置保留。",
    severity: "critical",
    entityType: "privacy_operation",
    entityId: "local-product-state",
    createdAt
  };

  return {
    ...baseState,
    profile: {
      name: "",
      role: "未设置",
      industry: "未设置",
      currentFocus: "",
      longTermGoal: "",
      preferredStrength: "standard",
      explicitBoundaries: [],
      confirmedMemories: [],
      inferredMemories: []
    },
    sessions: [],
    notes: [],
    points: [],
    questions: [],
    decisions: [],
    debts: [],
    themes: [],
    memoryCorrections: [],
    memoryRecords: [],
    memoryCandidates: [],
    memoryEdges: [],
    searchBriefs: [],
    importSources: [],
    ragChunks: [],
    podcastEpisodes: [],
    corpusImports: [],
    corpusInsights: [],
    playbookPatches: [],
    configVersions: [],
    auditEvents: [purgeEvent],
    aiRunEvents: [],
    workflowRuns: [],
    operationalChecks: [],
    systemConfig: currentState.systemConfig ?? baseState.systemConfig
  };
}

function countProfileRecords(state: ProductState) {
  const profile = state.profile;
  const identityFields = [profile.name, profile.role, profile.industry, profile.currentFocus, profile.longTermGoal]
    .map((value) => value.trim())
    .filter((value) => value && value !== "未设置");
  const hasProfileFields = Boolean(
    identityFields.length > 0 ||
      profile.preferredStrength !== "standard"
  );
  return (hasProfileFields ? 1 : 0) + profile.explicitBoundaries.length + profile.confirmedMemories.length + profile.inferredMemories.length;
}

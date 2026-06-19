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
  | "intel"
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

export type PrivacyOperationControlStatus = "pass" | "watch" | "block";

export interface PrivacyArtifactSummary {
  localObjectReferenceCount: number;
  uniqueLocalObjectFileCount: number;
  uploadDirConfigured: boolean;
}

export interface PrivacyOperationControl {
  id: string;
  label: string;
  status: PrivacyOperationControlStatus;
  detail: string;
  evidence: string;
  recommendation: string;
}

export interface PrivacySubjectRight {
  id: string;
  label: string;
  available: boolean;
  surface: string;
  detail: string;
}

export interface PrivacyRetentionPolicyItem {
  id: string;
  label: string;
  retention: string;
  deletion: string;
}

export interface PrivacyOperationsPackage {
  generatedAt: string;
  packageId: string;
  privacyReport: PrivacyReport;
  artifactSummary: PrivacyArtifactSummary;
  summary: Record<PrivacyOperationControlStatus, number> & {
    totalRecords: number;
    hasPersonalData: boolean;
  };
  controls: PrivacyOperationControl[];
  subjectRights: PrivacySubjectRight[];
  retentionPolicy: PrivacyRetentionPolicyItem[];
  redaction: {
    providerSecretsIncluded: false;
    envValuesIncluded: false;
    localFileContentsIncluded: false;
    runtimeConfigPreservedOnPurge: boolean;
  };
  runbook: string[];
  nextActions: string[];
}

export interface PrivacyNoticeDataCategory {
  id: PrivacyInventoryCategoryId;
  label: string;
  count: number;
  purpose: string;
  legalBasis: string;
  exported: boolean;
  purged: boolean;
  retention: string;
  deletion: string;
}

export type PrivacyNoticeProcessorRole = "processor" | "optional-subprocessor";
export type PrivacyNoticeProcessorTransfer = "local-or-self-hosted" | "external-provider";

export interface PrivacyNoticeProcessor {
  id: string;
  label: string;
  role: PrivacyNoticeProcessorRole;
  purpose: string;
  dataCategories: PrivacyInventoryCategoryId[];
  configuration: string;
  transfer: PrivacyNoticeProcessorTransfer;
}

export interface PrivacyNoticePackage {
  generatedAt: string;
  noticeId: string;
  version: "privacy-notice-v1";
  operationsPackageId: string;
  summary: {
    totalRecords: number;
    hasPersonalData: boolean;
    dataCategoryCount: number;
    processorCount: number;
    subjectRightCount: number;
  };
  dataCategories: PrivacyNoticeDataCategory[];
  subjectRights: PrivacySubjectRight[];
  processors: PrivacyNoticeProcessor[];
  retentionPolicy: PrivacyRetentionPolicyItem[];
  redaction: {
    providerSecretsIncluded: false;
    envValuesIncluded: false;
    localFileContentsIncluded: false;
  };
  evidence: {
    privacyOperationsPackagePath: "/api/state/privacy-operations-package";
    privacyReportPath: "/api/state/privacy-report";
    exportPath: "/api/state/export";
    purgePath: "/api/state/purge";
  };
  userFacingText: string;
}

interface PrivacyOperationsPackageOptions {
  generatedAt?: string;
  artifactSummary?: PrivacyArtifactSummary;
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
      id: "intel",
      label: "情报监控与素材",
      count: state.intelTasks.length + state.intelItems.length,
      detail: "情报监控任务、自动化采集的情报条目和关键声明。",
      exported: true,
      purged: true
    },
    {
      id: "operations",
      label: "审计与运行记录",
      count:
        state.auditEvents.length +
        state.aiRunEvents.length +
        state.workflowRuns.length +
        state.operationalChecks.length +
        state.configVersions.length,
      detail: "审计事件、AI run event、workflow trace、运营检查证据和配置版本历史。",
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

export function buildPrivacyOperationsPackage(
  state: ProductState,
  options: PrivacyOperationsPackageOptions = {}
): PrivacyOperationsPackage {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const privacyReport = buildPrivacyReport(state, generatedAt);
  const artifactSummary = options.artifactSummary ?? {
    localObjectReferenceCount: 0,
    uniqueLocalObjectFileCount: 0,
    uploadDirConfigured: false
  };
  const controls = buildPrivacyOperationControls(privacyReport, artifactSummary);
  const controlSummary = summarizePrivacyOperationControls(controls);

  return {
    generatedAt,
    packageId: buildPrivacyOperationsPackageId(generatedAt, privacyReport),
    privacyReport,
    artifactSummary,
    summary: {
      ...controlSummary,
      totalRecords: privacyReport.totalRecords,
      hasPersonalData: privacyReport.hasPersonalData
    },
    controls,
    subjectRights: buildPrivacySubjectRights(privacyReport),
    retentionPolicy: buildPrivacyRetentionPolicy(artifactSummary),
    redaction: {
      providerSecretsIncluded: false,
      envValuesIncluded: false,
      localFileContentsIncluded: false,
      runtimeConfigPreservedOnPurge: privacyReport.operations.runtimeEnvPreservedOnPurge
    },
    runbook: buildPrivacyOperationsRunbook(privacyReport, artifactSummary),
    nextActions: controls.filter((control) => control.status !== "pass").map((control) => `${control.label}：${control.recommendation}`)
  };
}

export function buildPrivacyNoticePackage(state: ProductState, options: PrivacyOperationsPackageOptions = {}): PrivacyNoticePackage {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const operationsPackage = buildPrivacyOperationsPackage(state, {
    ...options,
    generatedAt
  });
  const dataCategories = buildPrivacyNoticeDataCategories(operationsPackage.privacyReport, operationsPackage.retentionPolicy);
  const subjectRights = operationsPackage.subjectRights;
  const processors = buildPrivacyNoticeProcessors(dataCategories);

  return {
    generatedAt,
    noticeId: buildPrivacyNoticeId(generatedAt, operationsPackage.packageId),
    version: "privacy-notice-v1",
    operationsPackageId: operationsPackage.packageId,
    summary: {
      totalRecords: operationsPackage.privacyReport.totalRecords,
      hasPersonalData: operationsPackage.privacyReport.hasPersonalData,
      dataCategoryCount: dataCategories.length,
      processorCount: processors.length,
      subjectRightCount: subjectRights.length
    },
    dataCategories,
    subjectRights,
    processors,
    retentionPolicy: operationsPackage.retentionPolicy,
    redaction: {
      providerSecretsIncluded: false,
      envValuesIncluded: false,
      localFileContentsIncluded: false
    },
    evidence: {
      privacyOperationsPackagePath: "/api/state/privacy-operations-package",
      privacyReportPath: "/api/state/privacy-report",
      exportPath: "/api/state/export",
      purgePath: "/api/state/purge"
    },
    userFacingText: buildPrivacyNoticeUserFacingText(operationsPackage)
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

function buildPrivacyOperationsPackageId(generatedAt: string, report: PrivacyReport) {
  const compactTimestamp = generatedAt.replace(/\D/g, "").slice(0, 14);
  return `privacy-ops-${compactTimestamp}-${report.totalRecords}`;
}

function buildPrivacyNoticeId(generatedAt: string, operationsPackageId: string) {
  const compactTimestamp = generatedAt.replace(/\D/g, "").slice(0, 14);
  return `privacy-notice-${compactTimestamp}-${operationsPackageId}`;
}

function buildPrivacyNoticeDataCategories(
  report: PrivacyReport,
  retentionPolicy: PrivacyRetentionPolicyItem[]
): PrivacyNoticeDataCategory[] {
  return report.inventory.map((item) => ({
    id: item.id,
    label: item.label,
    count: item.count,
    purpose: buildPrivacyNoticePurpose(item.id),
    legalBasis: buildPrivacyNoticeLegalBasis(item.id),
    exported: item.exported,
    purged: item.purged,
    retention: resolvePrivacyNoticeRetention(item.id, retentionPolicy),
    deletion: resolvePrivacyNoticeDeletion(item.id, retentionPolicy)
  }));
}

function buildPrivacyNoticePurpose(category: PrivacyInventoryCategoryId) {
  const purposes: Record<PrivacyInventoryCategoryId, string> = {
    profile: "支持个性化专访、边界控制、长期回访和偏好记忆。",
    interviews: "记录专访过程、生成双轨笔记、保留关键引用并支持后续追问。",
    assets: "把专访沉淀为观点、问题、决策、知识债、阅读和长期主题。",
    memory: "保存用户确认或修正后的长期记忆，并隔离敏感记忆上下文。",
    external_knowledge: "保存联网搜索、导入资料和 RAG 片段，用于准备主题与可追溯引用。",
    corpus_learning: "学习用户导入的优秀专访样本，形成可审核的访谈策略改进建议。",
    generated_media: "保存播客脚本、shownotes、音频生成状态和用户选择的声音配置。",
    intel: "保存情报监控任务配置、自动化采集的情报条目和关键声明，用于主题追踪和专访准备。",
    operations: "记录审计事件、AI 运行事件、workflow trace、运营检查和配置版本。"
  };
  return purposes[category];
}

function buildPrivacyNoticeLegalBasis(category: PrivacyInventoryCategoryId) {
  if (category === "operations") {
    return "安全、审计、故障恢复和产品运营必要性";
  }
  if (category === "external_knowledge") {
    return "用户请求导入或联网收集材料以完成专访准备";
  }
  return "用户主动记录与产品核心功能需要";
}

function resolvePrivacyNoticeRetention(category: PrivacyInventoryCategoryId, retentionPolicy: PrivacyRetentionPolicyItem[]) {
  if (category === "generated_media") {
    return "保留到用户删除播客生成物、导入覆盖、重置演示数据或彻底清空为止。";
  }
  if (category === "operations") {
    return "保留到用户导出、导入覆盖、重置演示数据或彻底清空为止；清空后只保留一条清空审计事件。";
  }
  return retentionPolicy.find((item) => item.id === "product-state")?.retention ?? "保留到用户执行导出、导入、重置或彻底清空为止。";
}

function resolvePrivacyNoticeDeletion(category: PrivacyInventoryCategoryId, retentionPolicy: PrivacyRetentionPolicyItem[]) {
  if (category === "operations") {
    return "彻底清空会删除历史运行记录，并保留一条清空审计事件用于证明删除动作发生。";
  }
  if (category === "corpus_learning") {
    return `${retentionPolicy.find((item) => item.id === "product-state")?.deletion ?? "彻底清空会删除该类数据。"} 本地对象音频会按 local-object 引用尝试删除。`;
  }
  return retentionPolicy.find((item) => item.id === "product-state")?.deletion ?? "彻底清空会删除该类数据。";
}

function buildPrivacyNoticeProcessors(categories: PrivacyNoticeDataCategory[]): PrivacyNoticeProcessor[] {
  const allCategoryIds = categories.map((category) => category.id);
  return [
    {
      id: "local-product-state",
      label: "Product API 本地状态库",
      role: "processor",
      purpose: "保存用户拥有的产品状态、隐私库存、审计事件和运行证据。",
      dataCategories: allCategoryIds,
      configuration: "PRODUCT_STATE_DB_PATH",
      transfer: "local-or-self-hosted"
    },
    {
      id: "local-object-storage",
      label: "本地对象音频目录",
      role: "processor",
      purpose: "保存用户上传或导入的专访音频原件，供转写和语料学习使用。",
      dataCategories: ["corpus_learning"],
      configuration: "CORPUS_UPLOAD_DIR / CORPUS_AUDIO_PUBLIC_BASE_URL",
      transfer: "local-or-self-hosted"
    },
    {
      id: "bailian",
      label: "百炼 / DashScope",
      role: "optional-subprocessor",
      purpose: "在用户配置服务端密钥后，用于联网搜索、角色专访、TTS、ASR 和 Realtime 语音。",
      dataCategories: ["interviews", "external_knowledge", "corpus_learning", "generated_media"],
      configuration: "DASHSCOPE_API_KEY / BAILIAN_API_KEY / BAILIAN_REALTIME_WEBRTC_ENDPOINT",
      transfer: "external-provider"
    },
    {
      id: "external-search",
      label: "AnySearch / Tavily / Exa / Brave Search",
      role: "optional-subprocessor",
      purpose: "在用户配置搜索 provider 后，用于主动收集热点和相关材料来源。",
      dataCategories: ["external_knowledge"],
      configuration: "ANYSEARCH_API_KEY / TAVILY_API_KEY / EXA_API_KEY / BRAVE_SEARCH_API_KEY",
      transfer: "external-provider"
    },
    {
      id: "local-workflow-runtime",
      label: "Local Workflow Runtime",
      role: "processor",
      purpose: "本地工作流引擎，用于执行专访准备、记忆投影、素材导入等工作流编排，无数据出境。",
      dataCategories: ["memory", "operations", "external_knowledge"],
      configuration: "（内置，无需额外配置）",
      transfer: "local-or-self-hosted"
    }
  ];
}

function buildPrivacyNoticeUserFacingText(operationsPackage: PrivacyOperationsPackage) {
  const personalDataText = operationsPackage.summary.hasPersonalData
    ? `当前状态包含 ${operationsPackage.summary.totalRecords} 条可导出的产品记录。`
    : "当前状态没有检测到个人数据记录。";
  return [
    "本产品把专访、笔记、长期记忆、联网资料、导入语料、播客生成物和运行审计视为用户拥有的数据。",
    personalDataText,
    "你可以导出、导入、更正或彻底清空个人数据；彻底清空会删除个人状态和已引用的本地对象音频，并保留 provider 运行配置。",
    "第三方 provider 仅在你配置服务端密钥并主动使用相关能力时调用；导出包、隐私说明包和运营包不会包含 provider secret、env value 或本地文件内容。"
  ].join("\n");
}

function buildPrivacyOperationControls(
  report: PrivacyReport,
  artifactSummary: PrivacyArtifactSummary
): PrivacyOperationControl[] {
  const exportableInventory = report.inventory.every((item) => item.exported);
  const purgeableInventory = report.inventory.every((item) => item.purged);
  return [
    {
      id: "inventory-export",
      label: "数据库存与导出",
      status: report.operations.exportAvailable && exportableInventory ? "pass" : "block",
      detail: `隐私库存覆盖 ${report.inventory.length} 类数据，共 ${report.totalRecords} 条状态记录。`,
      evidence: `exportAvailable=${report.operations.exportAvailable}; allInventoryExported=${exportableInventory}`,
      recommendation: "保持导出包包含隐私库存；上线前抽样导入一次最近导出包。"
    },
    {
      id: "purge-right",
      label: "删除权与清空",
      status: report.operations.purgeAvailable && purgeableInventory ? "pass" : "block",
      detail: "彻底清空会移除个人档案、专访、资产、记忆、外部资料、播客和运行历史。",
      evidence: `purgeAvailable=${report.operations.purgeAvailable}; allInventoryPurged=${purgeableInventory}`,
      recommendation: "生产前在副本环境执行一次清空演练，并核对清空后只保留一条审计事件。"
    },
    {
      id: "secret-boundary",
      label: "密钥与运行配置边界",
      status: report.operations.providerSecretsExcluded && report.operations.runtimeEnvPreservedOnPurge ? "pass" : "block",
      detail: "导出包不包含 provider key；隐私清空保留运行配置，避免把账号密钥混入个人数据生命周期。",
      evidence: `providerSecretsExcluded=${report.operations.providerSecretsExcluded}; runtimeEnvPreservedOnPurge=${report.operations.runtimeEnvPreservedOnPurge}`,
      recommendation: "继续把第三方 key 放在服务端 env 或运行配置中，不写入 ProductState 导出包。"
    },
    {
      id: "local-object-artifacts",
      label: "本地对象文件删除",
      status: artifactSummary.localObjectReferenceCount > 0 ? "watch" : "pass",
      detail:
        artifactSummary.localObjectReferenceCount > 0
          ? `当前状态引用 ${artifactSummary.localObjectReferenceCount} 个 local-object 音频对象，涉及 ${artifactSummary.uniqueLocalObjectFileCount} 个本地文件。`
          : "当前状态没有引用 local-object 本地音频文件。",
      evidence: `localObjectReferences=${artifactSummary.localObjectReferenceCount}; uniqueLocalObjectFiles=${artifactSummary.uniqueLocalObjectFileCount}; uploadDirConfigured=${artifactSummary.uploadDirConfigured}`,
      recommendation:
        artifactSummary.localObjectReferenceCount > 0
          ? "执行隐私清空时核对 artifactPurge 删除/缺失/跳过数量；生产对象存储需要等价删除演练。"
          : "保持清空流程的对象文件删除检查；接入 OSS/S3 后补充对象删除凭证。"
    },
    {
      id: "personal-data-state",
      label: "当前个人数据状态",
      status: report.hasPersonalData ? "watch" : "pass",
      detail: report.hasPersonalData ? "当前产品状态仍包含个人数据。" : "当前产品状态没有检测到个人数据。",
      evidence: `hasPersonalData=${report.hasPersonalData}; totalRecords=${report.totalRecords}`,
      recommendation: report.hasPersonalData
        ? "上线演练或交付他人前先导出备份；如不应保留个人数据，执行彻底清空而不是重置演示数据。"
        : "继续保留空状态审计事件，用于证明清空发生过。"
    }
  ];
}

function summarizePrivacyOperationControls(controls: PrivacyOperationControl[]) {
  return controls.reduce(
    (summary, control) => ({
      ...summary,
      [control.status]: summary[control.status] + 1
    }),
    { pass: 0, watch: 0, block: 0 } as Record<PrivacyOperationControlStatus, number>
  );
}

function buildPrivacySubjectRights(report: PrivacyReport): PrivacySubjectRight[] {
  return [
    {
      id: "access-export",
      label: "访问与导出",
      available: report.operations.exportAvailable,
      surface: "个人档案 / Product API /api/state/export",
      detail: "用户可以导出完整 ProductState 和隐私库存；导出包不含运行密钥。"
    },
    {
      id: "rectification",
      label: "更正与修正",
      available: true,
      surface: "个人档案 / 记忆修正 / 候选记忆审核",
      detail: "用户可以修正 AI 理解、编辑确认记忆、拒绝候选记忆或把敏感记忆排除出模型上下文。"
    },
    {
      id: "deletion",
      label: "删除与清空",
      available: report.operations.purgeAvailable,
      surface: "个人档案 / 彻底清空个人数据 / Product API /api/state/purge",
      detail: "彻底清空会移除个人数据和运行历史，并保留 provider 运行配置。"
    },
    {
      id: "portability-import",
      label: "迁移与导入",
      available: report.operations.importAvailable,
      surface: "个人档案 / 导入个人数据 / Product API /api/state/import",
      detail: "用户可以把导出包恢复到当前状态库；导入会经过 ProductState 归一化。"
    },
    {
      id: "transparency",
      label: "解释与透明",
      available: true,
      surface: "系统配置 / 质量 / 透明报告",
      detail: "系统展示审计事件、AI run event、workflow run、来源引用、运营检查和访谈透明报告。"
    }
  ];
}

function buildPrivacyRetentionPolicy(artifactSummary: PrivacyArtifactSummary): PrivacyRetentionPolicyItem[] {
  return [
    {
      id: "product-state",
      label: "ProductState 业务数据",
      retention: "保留到用户导出、导入覆盖、重置演示数据或彻底清空为止。",
      deletion: "彻底清空会删除个人档案、专访、资产、记忆、外部资料、播客、workflow 和 AI 运行记录。"
    },
    {
      id: "provider-secrets",
      label: "第三方 Provider 密钥",
      retention: "密钥保留在服务端 env 或运行配置文件中，不进入 ProductState。",
      deletion: "隐私清空不会删除 provider 配置；如需撤销访问，应在配置页清空密钥或到第三方后台轮换。"
    },
    {
      id: "local-object-audio",
      label: "本地对象音频",
      retention:
        artifactSummary.localObjectReferenceCount > 0
          ? `当前状态引用 ${artifactSummary.uniqueLocalObjectFileCount} 个本地对象文件。`
          : "当前状态没有引用本地对象文件。",
      deletion: "隐私清空会尝试删除已引用的 local-object://corpus-audio/... 文件；生产 OSS/S3 需要等价删除策略。"
    },
    {
      id: "demo-reset",
      label: "演示数据重置",
      retention: "重置演示数据会恢复初始样例，用于演示和测试。",
      deletion: "重置不等于隐私删除；真实删除必须使用彻底清空个人数据。"
    }
  ];
}

function buildPrivacyOperationsRunbook(report: PrivacyReport, artifactSummary: PrivacyArtifactSummary) {
  return [
    "导出当前个人数据，保存导出包和隐私库存摘要。",
    "在副本环境导入导出包，确认配置版本、专访、记忆、资产和生成物可恢复。",
    artifactSummary.localObjectReferenceCount > 0
      ? "执行彻底清空个人数据，核对 artifactPurge 的删除、缺失和跳过数量。"
      : "执行彻底清空个人数据，确认没有残留个人状态记录。",
    "清空后重新打开首页、个人档案和系统配置，确认空状态仍可启动专访并保留 provider 运行配置。",
    report.hasPersonalData
      ? "交付、演示或发布前确认是否允许保留当前个人数据。"
      : "保留清空审计事件，作为删除操作发生过的证据。"
  ];
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

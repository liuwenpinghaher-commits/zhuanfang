import type { InterviewControlAction } from "./domain/types";
import type { CapabilityTaskStatus } from "./capabilities/task";

export type View =
  | "home"
  | "interview"
  | "search"
  | "corpus"
  | "podcast"
  | "notes"
  | "material"
  | "asset-chat"
  | "my-assets"
  | "themes"
  | "memory"
  | "config"
  | "profile"
  | "track";

export type NoticeKind = "success" | "info" | "warning" | "danger";

export interface UiNotice {
  id: string;
  kind: NoticeKind;
  message: string;
  detail?: string;
}

export interface NavigationItem {
  id: View;
  label: string;
}

export interface NavigationGroup {
  label: string;
  items: NavigationItem[];
}

export type AssetFilter = "all" | "points" | "questions" | "decisions" | "debts";

export interface AssetFilterOption {
  id: AssetFilter;
  label: string;
  description: string;
}

export type ConfigSection = "status" | "settings";

export interface ConfigSectionOption {
  id: ConfigSection;
  label: string;
  description: string;
}

export type RealtimePhase = "listening" | "holding" | "thinking" | "speaking";

export interface InterviewControlOption {
  id: InterviewControlAction;
  label: string;
  description: string;
}

export interface InterviewControlGroup {
  label: string;
  description: string;
  actions: InterviewControlOption[];
}

export interface PodcastProductionSection {
  id: "setup" | "review" | "chapters" | "shownotes" | "script";
  label: string;
  description: string;
}

export const groupedNavigation: NavigationGroup[] = [
  {
    label: "访谈工作台",
    items: [
      { id: "home", label: "今日访谈台" },
      { id: "interview", label: "实时专访" },
      { id: "themes", label: "主题线" }
    ]
  },
  {
    label: "认知资产",
    items: [
      { id: "notes", label: "本场记录" },
      { id: "memory", label: "记忆" },
      { id: "asset-chat", label: "资料" },
      { id: "search", label: "外部调研" }
    ]
  },
  {
    label: "系统",
    items: [
      { id: "config", label: "系统配置" },
      { id: "profile", label: "个人档案" }
    ]
  }
];

/** 侧栏「本场记录」同时覆盖笔记与我的资产。 */
export function isSessionRecordView(view: View): boolean {
  return view === "notes" || view === "my-assets";
}

/** 侧栏「资料」同时覆盖资产对话与导入索引。 */
export function isLibraryView(view: View): boolean {
  return view === "asset-chat" || view === "material";
}

export function navItemIsActive(itemId: View, view: View): boolean {
  if (itemId === view) return true;
  if (itemId === "notes" && isSessionRecordView(view) && view !== "notes") return true;
  if (itemId === "asset-chat" && isLibraryView(view) && view !== "asset-chat") return true;
  return false;
}

export const assetFilterOptions: AssetFilterOption[] = [
  { id: "all", label: "全部", description: "查看所有认知资产" },
  { id: "points", label: "观点", description: "可验证、可修正的判断" },
  { id: "questions", label: "问题", description: "下次访谈需要回访的开放问题" },
  { id: "decisions", label: "决策", description: "需要复盘的选择和假设" },
  { id: "debts", label: "知识债", description: "需要补齐或应用的概念" }
];

export const configSectionOptions: ConfigSectionOption[] = [
  { id: "status", label: "状态", description: "实时能力健康、引擎版本和生成物计数" },
  { id: "settings", label: "参数", description: "服务端配置(env)和产品策略" }
];

export const interviewControlGroups: InterviewControlGroup[] = [
  {
    label: "节奏",
    description: "调整留白、收束和推进速度。",
    actions: [
      { id: "softer", label: "放慢一点", description: "降低追问压力，多给一点解释和停顿。" },
      { id: "summary", label: "阶段总结", description: "先把刚才的表达收束成一个阶段性摘要。" }
    ]
  },
  {
    label: "方向",
    description: "切换追问角度或提高问题锋利度。",
    actions: [
      { id: "different-angle", label: "换个角度", description: "从新的视角继续问同一个主题。" },
      { id: "sharper", label: "更直接", description: "把回避点说清楚，减少铺垫。" }
    ]
  },
  {
    label: "边界",
    description: "处理跳过、隐私和保存边界。",
    actions: [
      { id: "skip", label: "跳过这个问题", description: "不继续当前问题，换到下一个追问。" },
      { id: "do-not-save", label: "本次不保存", description: "继续访谈，但结束后不写入长期资产。" }
    ]
  }
];

export const podcastProductionSections: PodcastProductionSection[] = [
  { id: "setup", label: "制作设置", description: "选择来源笔记、节目形态和主持人/来宾声音。" },
  { id: "review", label: "收听复核", description: "确认生成状态、音频位置和节目时长。" },
  { id: "chapters", label: "章节导航", description: "检查章节切点和每段摘要。" },
  { id: "shownotes", label: "Shownotes", description: "生成可发布的节目说明和追问入口。" },
  { id: "script", label: "脚本复核", description: "保留完整口播稿，便于二次编辑。" }
];

export function formatRealtimePhase(phase: RealtimePhase): string {
  const labels: Record<RealtimePhase, string> = {
    listening: "正在听",
    holding: "保持留白",
    thinking: "整理追问",
    speaking: "准备开场"
  };
  return labels[phase];
}

export function formatPodcastTimestamp(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

export function formatCapabilityTaskStatus(status: CapabilityTaskStatus): string {
  const labels: Record<CapabilityTaskStatus, string> = {
    idle: "待开始",
    running: "运行中",
    succeeded: "已完成",
    failed: "失败",
    cancelled: "已取消",
    degraded: "降级完成"
  };
  return labels[status];
}

export function buildNotice(kind: NoticeKind, message: string, detail?: string): UiNotice {
  return {
    id: `notice-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    kind,
    message,
    detail
  };
}

// 分析方法说明常量 — 镜像自 apps/api/src/intelligence/corpus-llm.ts SYSTEM_PROMPT
// 与后端 SYSTEM_PROMPT 保持内容同步；如修改 corpus-llm.ts 的 prompt 逻辑，同步更新此处。

/**
 * 评分维度说明（源自 SYSTEM_PROMPT 产出规范 + corpus.ts 确定性维度名）
 * LLM 模式：维度由模型从样本中提炼，典型维度如下所示；确定性兜底模式：固定三个维度。
 */
export const ANALYSIS_DIMENSIONS = [
  {
    name: "追问动作",
    description: "主持人索要具体事实/时刻的方式——能否把被访者从抽象评价带回可复盘的具体场景。"
  },
  {
    name: "节奏控制",
    description: "主持人在收到回答后的停顿/留白/再追问节奏，是否给被访者足够的展开空间。"
  },
  {
    name: "反方推动",
    description: "主持人把被访者叙述翻转成机制假设或反例的能力——以挑战和反问推动观点深化。"
  },
  {
    name: "视角切换",
    description: "主持人引导被访者从个人经历切换到系统机制、旁观者或反例视角的技法。"
  },
  {
    name: "留白控制",
    description: "主持人主动保留沉默/短停顿，而非立即补充问题或建议，给被访者二次思考空间。"
  }
] as const;

/**
 * 分析产出结构说明（源自 corpus-llm.ts user 消息 JSON schema）
 */
export const ANALYSIS_OUTPUTS = [
  {
    key: "dimensions",
    label: "维度评分（1-5）",
    detail: "每个维度含评分、发现、样本原话（evidence）和对引擎的建议动作。"
  },
  {
    key: "improvementPlan",
    label: "引擎改进计划",
    detail: "每条改进含标题、样本为什么这么做（rationale）、引擎具体怎么改（action）和预期行为变化。"
  },
  {
    key: "patch",
    label: "PlaybookPatch（可应用规则）",
    detail:
      "确认后会写入 enginePolicy：最多 3 条规则软注入提示词，并按 ruleType 做有限硬路由（如 depth/challenge）。不是任意规则都能改写全部策略树——以「软注入 + 分类路由」为准。"
  }
] as const;

/**
 * 分析铁律（源自 SYSTEM_PROMPT 最后一句）
 */
export const ANALYSIS_PRINCIPLES = [
  "只基于样本里真实出现的技法进行评分，不基于通用理论推断。",
  "每条发现必须给出样本原话作为 evidence，不编造引用。",
  "只输出一个结构化 JSON 对象，不添加额外解释。"
] as const;

/**
 * 分析路径说明：有 DASHSCOPE key 走 LLM；否则/失败时 fail-loud（无确定性冒充）。
 */
export const ANALYSIS_PATHS = {
  llm: {
    label: "LLM 深度分析",
    condition: "配置了 DASHSCOPE API Key",
    description: "调用通义千问大模型，从样本全文中提炼维度、改进计划和 PlaybookPatch；维度数量和名称由模型根据样本内容决定。"
  },
  unavailable: {
    label: "不可用时如实失败",
    condition: "未配置 API Key 或 LLM 调用失败",
    description:
      "语料分析是 LLM 能力：未配置或调用失败时返回 503/429/502，不会用确定性模板评分冒充分析成功。请配置密钥后重试。"
  }
} as const;

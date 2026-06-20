import type {
  PodcastEpisode,
  ProductState,
} from "./types";

import { cloneState, makeId, nowIso, withAuditEvent, withAiRunEvent } from "./utils";
import { withGeneratedArtifactWorkflowRun } from "./engine";



type PodcastFormat = PodcastEpisode["format"];
function buildPodcastRelatedAssets(state: ProductState) {
  return [
    state.points[0]?.title,
    state.questions[0]?.question,
    state.debts[0]?.concept,
    state.decisions[0]?.title
  ].filter((item): item is string => Boolean(item));
}
function buildPodcastScript(
  format: PodcastFormat,
  soloLines: string[],
  dialogueLines: string[]
) {
  return [podcastAiDisclosure, ...(format === "host-guest" ? dialogueLines : soloLines)].filter(Boolean).join("\n");
}
function buildPodcastShownotes(format: PodcastFormat, items: string[]) {
  return [podcastAiDisclosure, `播客形态：${formatPodcastFormatLabel(format)}`, ...items];
}
function formatPodcastFormatLabel(format: PodcastFormat) {
  return format === "host-guest" ? "主持对谈" : "单人旁白";
}
export function generatePodcastEpisode(
  state: ProductState,
  noteId: string,
  options: { format: PodcastEpisode["format"]; voice: string }
): { episode: PodcastEpisode; nextState: ProductState } {
  const note = state.notes.find((item) => item.id === noteId) ?? state.notes[0];
  const createdAt = nowIso();
  const title = `播客：${note.title}`;
  const script = buildPodcastScript(options.format, [
    `开场：今天我们回到《${note.title}》。`,
    `关键原话：“${note.keyQuote}”`,
    `第一部分，我说了什么：${note.saidTrack.slice(0, 2).join("；")}`,
    `第二部分，我学到了什么：${note.learnedTrack.slice(0, 2).join("；")}`,
    `收束问题：${note.nextQuestions[0] ?? "下一次从这个问题继续。"}`
  ], [
    `主持人：欢迎回来，今天我们用《${note.title}》做一段复盘对谈。`,
    `来宾：这期最值得停下来的原话是：“${note.keyQuote}”`,
    "主持人：先还原一下，当时真正说出口的是什么？",
    `来宾：${note.saidTrack.slice(0, 2).join("；")}`,
    "主持人：如果把它往下挖一层，这段经历让你学到了什么？",
    `来宾：${note.learnedTrack.slice(0, 2).join("；")}`,
    "主持人：那下一次专访最该继续追问哪一个问题？",
    `来宾：${note.nextQuestions[0] ?? "下一次从这个问题继续。"}`
  ]);
  const episode: PodcastEpisode = {
    id: makeId("podcast"),
    noteId: note.id,
    sourceType: "note",
    sourceId: note.id,
    sourceLabel: note.title,
    title,
    format: options.format,
    voice: options.voice,
    status: "draft",
    scriptReviewStatus: "待确认",
    durationSec: Math.max(180, Math.round(script.length * 0.8)),
    script,
    aiDisclosure: podcastAiDisclosure,
    chapters: [
      {
        title: "开场与背景",
        startsAtSec: 0,
        summary: note.summary
      },
      {
        title: "关键原话",
        startsAtSec: 45,
        summary: note.keyQuote
      },
      {
        title: "复盘与下一问",
        startsAtSec: 120,
        summary: note.nextQuestions[0] ?? "保留一个下次追问。"
      }
    ],
    audioUrl: `local-audio://${title.replace(/\s+/g, "-")}.mp3`,
    audioRenderStatus: "pending",
    audioRenderMessage: "脚本待确认，确认后才会渲染音频。",
    shownotes: buildPodcastShownotes(options.format, [
      `来源笔记：${note.title}`,
      `关键原话：${note.keyQuote}`,
      ...note.nextQuestions.slice(0, 2).map((question) => `下次追问：${question}`)
    ]),
    createdAt
  };
  const generatedState = {
    ...cloneState(state),
    podcastEpisodes: [episode, ...state.podcastEpisodes]
  };
  const stateWithCreationEvents = withAiRunEvent(
    withAuditEvent(generatedState, {
      type: "podcast_episode_created",
      label: "播客脚本已生成",
      detail: `从笔记《${note.title}》生成待确认脚本《${episode.title}》。`,
      severity: "info",
      entityType: "podcast_episode",
      entityId: episode.id,
      createdAt
    }),
    {
      workflow: "podcast_generation",
      providerId: state.systemConfig.models.synthesisModel,
      status: "succeeded",
      entityType: "podcast_episode",
      entityId: episode.id,
      inputSummary: `来源笔记：${note.title}`,
      outputSummary: `生成待确认播客脚本，预计 ${episode.durationSec} 秒。`,
      estimatedTokens: script.length,
      createdAt
    }
  );
  const nextState = withGeneratedArtifactWorkflowRun(stateWithCreationEvents, {
    workflow: "podcast_generation",
    entityType: "podcast_episode",
    entityId: episode.id,
    inputSummary: `来源笔记：${note.title}`
  });

  return {
    episode,
    nextState
  };
}
export function generatePodcastEpisodeFromKnowledgeDebt(
  state: ProductState,
  debtId: string,
  options: { format: PodcastEpisode["format"]; voice: string }
): { episode: PodcastEpisode; nextState: ProductState } {
  const debt = state.debts.find((item) => item.id === debtId) ?? state.debts[0];
  if (!debt) {
    return generatePodcastEpisode(state, state.notes[0]?.id ?? "", options);
  }

  const createdAt = nowIso();
  const title = `学习播客：${debt.concept}`;
  const relatedAssets = buildPodcastRelatedAssets(state);
  const script = buildPodcastScript(options.format, [
    `开场：今天把知识债《${debt.concept}》做成一段学习播客。`,
    `背景：${debt.context}`,
    `为什么重要：${debt.whyImportant}`,
    `当前状态：${debt.status}`,
    relatedAssets.length > 0 ? `相关资产：${relatedAssets.join("；")}` : "",
    `收束问题：${debt.nextQuestion}`
  ], [
    `主持人：今天我们把知识债《${debt.concept}》拆成一段学习对谈。`,
    `来宾：背景是：${debt.context}`,
    "主持人：它为什么值得现在学习，而不是以后再说？",
    `来宾：${debt.whyImportant}`,
    "主持人：当前推进状态和可用线索是什么？",
    `来宾：状态是 ${debt.status}。${relatedAssets.length > 0 ? `相关资产包括：${relatedAssets.join("；")}` : "还需要继续积累证据。"}`,
    "主持人：最后留给下一次验证的问题是什么？",
    `来宾：${debt.nextQuestion}`
  ]);
  const episode: PodcastEpisode = {
    id: makeId("podcast"),
    // 非 note 来源不写入 noteId（避免异类 id 污染外键语义）；来源由 sourceType/sourceId 表达。
    noteId: "",
    sourceType: "knowledge-debt",
    sourceId: debt.id,
    sourceLabel: debt.concept,
    title,
    format: options.format,
    voice: options.voice,
    status: "draft",
    scriptReviewStatus: "待确认",
    durationSec: Math.max(180, Math.round(script.length * 0.8)),
    script,
    aiDisclosure: podcastAiDisclosure,
    chapters: [
      {
        title: "知识债背景",
        startsAtSec: 0,
        summary: debt.context
      },
      {
        title: "为什么重要",
        startsAtSec: 55,
        summary: debt.whyImportant
      },
      {
        title: "下一次验证",
        startsAtSec: 130,
        summary: debt.nextQuestion
      }
    ],
    audioUrl: `local-audio://${title.replace(/\s+/g, "-")}.mp3`,
    audioRenderStatus: "pending",
    audioRenderMessage: "脚本待确认，确认后才会渲染音频。",
    shownotes: buildPodcastShownotes(options.format, [
      `知识债：${debt.concept}`,
      `背景：${debt.context}`,
      `为什么重要：${debt.whyImportant}`,
      `下一问：${debt.nextQuestion}`,
      ...relatedAssets.map((asset) => `相关资产：${asset}`)
    ]),
    createdAt
  };
  const generatedState = {
    ...cloneState(state),
    podcastEpisodes: [episode, ...state.podcastEpisodes]
  };
  const stateWithCreationEvents = withAiRunEvent(
    withAuditEvent(generatedState, {
      type: "podcast_episode_created",
      label: "知识债播客脚本已生成",
      detail: `从知识债《${debt.concept}》生成待确认脚本《${episode.title}》。`,
      severity: "info",
      entityType: "podcast_episode",
      entityId: episode.id,
      createdAt
    }),
    {
      workflow: "podcast_generation",
      providerId: state.systemConfig.models.synthesisModel,
      status: "succeeded",
      entityType: "podcast_episode",
      entityId: episode.id,
      inputSummary: `知识债：${debt.concept}`,
      outputSummary: `生成待确认学习播客脚本，预计 ${episode.durationSec} 秒。`,
      estimatedTokens: script.length,
      createdAt
    }
  );
  const nextState = withGeneratedArtifactWorkflowRun(stateWithCreationEvents, {
    workflow: "podcast_generation",
    entityType: "podcast_episode",
    entityId: episode.id,
    inputSummary: `知识债：${debt.concept}`
  });

  return {
    episode,
    nextState
  };
}
export function generatePodcastEpisodeFromSearchBrief(
  state: ProductState,
  briefId: string,
  options: { format: PodcastEpisode["format"]; voice: string }
): { episode: PodcastEpisode; nextState: ProductState } {
  const brief = state.searchBriefs.find((item) => item.id === briefId) ?? state.searchBriefs[0];
  if (!brief) {
    return generatePodcastEpisode(state, state.notes[0]?.id ?? "", options);
  }

  const createdAt = nowIso();
  const title = `热点播客：${brief.topic}`;
  const sourceNotes = brief.sources
    .slice(0, 3)
    .map((source) => `来源链接：${source.publisher}｜${source.title}｜${source.url}`);
  const relatedAssets = buildPodcastRelatedAssets(state);
  const script = buildPodcastScript(options.format, [
    `开场：今天我们用一份联网素材聊《${brief.topic}》。`,
    `素材摘要：${brief.summary}`,
    `关键事实：${brief.facts.slice(0, 3).join("；")}`,
    `争议：${brief.controversies.slice(0, 2).join("；")}`,
    `反方观点：${brief.opposingViews.slice(0, 2).join("；")}`,
    `可追问角度：${brief.interviewAngles.slice(0, 2).join("；")}`,
    relatedAssets.length > 0 ? `相关资产：${relatedAssets.join("；")}` : "",
    `收束问题：${brief.discussionTopics[0] ?? "这份素材和你当前最真实的判断有什么关系？"}`
  ], [
    `主持人：今天我们把联网素材《${brief.topic}》转成一段可讨论的对谈。`,
    `来宾：先给出素材摘要：${brief.summary}`,
    "主持人：这份材料里最硬的事实是什么？",
    `来宾：${brief.facts.slice(0, 3).join("；")}`,
    "主持人：如果从反方和争议看，它提醒我们不要忽略什么？",
    `来宾：争议包括：${brief.controversies.slice(0, 2).join("；")}。反方观点包括：${brief.opposingViews.slice(0, 2).join("；")}`,
    `主持人：它能怎样转成下一次专访的真实问题？`,
    `来宾：${brief.interviewAngles.slice(0, 2).join("；")}。${relatedAssets.length > 0 ? `也要关联已有资产：${relatedAssets.join("；")}` : "先把热点转回自己的判断。"}`,
    `主持人：最后留一个收束问题。`,
    `来宾：${brief.discussionTopics[0] ?? "这份素材和你当前最真实的判断有什么关系？"}`
  ]);
  const episode: PodcastEpisode = {
    id: makeId("podcast"),
    // 非 note 来源不写入 noteId（避免异类 id 污染外键语义）；来源由 sourceType/sourceId 表达。
    noteId: "",
    sourceType: "search-brief",
    sourceId: brief.id,
    sourceLabel: brief.topic,
    title,
    format: options.format,
    voice: options.voice,
    status: "draft",
    scriptReviewStatus: "待确认",
    durationSec: Math.max(180, Math.round(script.length * 0.8)),
    script,
    aiDisclosure: podcastAiDisclosure,
    chapters: [
      {
        title: "热点背景",
        startsAtSec: 0,
        summary: brief.summary
      },
      {
        title: "争议与反方",
        startsAtSec: 60,
        summary: brief.controversies[0] ?? brief.opposingViews[0] ?? "保留反方观点。"
      },
      {
        title: "回到个人判断",
        startsAtSec: 140,
        summary: brief.discussionTopics[0] ?? "把热点转回用户自己的下一步判断。"
      }
    ],
    audioUrl: `local-audio://${title.replace(/\s+/g, "-")}.mp3`,
    audioRenderStatus: "pending",
    audioRenderMessage: "脚本待确认，确认后才会渲染音频。",
    shownotes: buildPodcastShownotes(options.format, [
      `来源素材：${brief.topic}`,
      `素材摘要：${brief.summary}`,
      ...sourceNotes,
      ...relatedAssets.map((asset) => `相关资产：${asset}`),
      ...brief.discussionTopics.slice(0, 2).map((topic) => `可讨论主题：${topic}`)
    ]),
    createdAt
  };
  const generatedState = {
    ...cloneState(state),
    podcastEpisodes: [episode, ...state.podcastEpisodes]
  };
  const stateWithCreationEvents = withAiRunEvent(
    withAuditEvent(generatedState, {
      type: "podcast_episode_created",
      label: "热点播客脚本已生成",
      detail: `从联网素材《${brief.topic}》生成待确认脚本《${episode.title}》。`,
      severity: "info",
      entityType: "podcast_episode",
      entityId: episode.id,
      createdAt
    }),
    {
      workflow: "podcast_generation",
      providerId: state.systemConfig.models.synthesisModel,
      status: "succeeded",
      entityType: "podcast_episode",
      entityId: episode.id,
      inputSummary: `来源素材：${brief.topic}`,
      outputSummary: `生成待确认热点专题播客脚本，预计 ${episode.durationSec} 秒。`,
      estimatedTokens: script.length,
      createdAt
    }
  );
  const nextState = withGeneratedArtifactWorkflowRun(stateWithCreationEvents, {
    workflow: "podcast_generation",
    entityType: "podcast_episode",
    entityId: episode.id,
    inputSummary: `来源素材：${brief.topic}`
  });

  return {
    episode,
    nextState
  };
}
export function generatePodcastEpisodeFromTheme(
  state: ProductState,
  themeId: string,
  options: { format: PodcastEpisode["format"]; voice: string }
): { episode: PodcastEpisode; nextState: ProductState } {
  const theme = state.themes.find((item) => item.id === themeId) ?? state.themes[0];
  if (!theme) {
    return generatePodcastEpisode(state, state.notes[0]?.id ?? "", options);
  }

  const createdAt = nowIso();
  const title = `主题播客：${theme.name}`;
  const relatedAssets = buildPodcastRelatedAssets(state);
  const script = buildPodcastScript(options.format, [
    `开场：今天我们围绕长期主题《${theme.name}》做一次专题回放。`,
    `主题摘要：${theme.summary}`,
    `代表原话：“${theme.representativeQuote}”`,
    `成熟度：${theme.maturity}，历史出现 ${theme.appearances} 次。`,
    relatedAssets.length > 0 ? `相关资产：${relatedAssets.join("；")}` : "",
    `收束问题：${theme.nextQuestion}`
  ], [
    `主持人：今天我们围绕长期主题《${theme.name}》做一段专题对谈。`,
    `来宾：这个主题的核心摘要是：${theme.summary}`,
    "主持人：有没有一句话最能代表它？",
    `来宾：“${theme.representativeQuote}”`,
    "主持人：从长期轨迹看，它现在成熟到什么程度？",
    `来宾：成熟度是 ${theme.maturity}，历史出现 ${theme.appearances} 次。${relatedAssets.length > 0 ? `相关资产包括：${relatedAssets.join("；")}` : ""}`,
    "主持人：下一次继续追问什么？",
    `来宾：${theme.nextQuestion}`
  ]);
  const episode: PodcastEpisode = {
    id: makeId("podcast"),
    // 非 note 来源不写入 noteId（避免异类 id 污染外键语义）；来源由 sourceType/sourceId 表达。
    noteId: "",
    sourceType: "theme",
    sourceId: theme.id,
    sourceLabel: theme.name,
    title,
    format: options.format,
    voice: options.voice,
    status: "draft",
    scriptReviewStatus: "待确认",
    durationSec: Math.max(180, Math.round(script.length * 0.8)),
    script,
    aiDisclosure: podcastAiDisclosure,
    chapters: [
      {
        title: "主题背景",
        startsAtSec: 0,
        summary: theme.summary
      },
      {
        title: "代表原话",
        startsAtSec: 55,
        summary: theme.representativeQuote
      },
      {
        title: "下一次追问",
        startsAtSec: 130,
        summary: theme.nextQuestion
      }
    ],
    audioUrl: `local-audio://${title.replace(/\s+/g, "-")}.mp3`,
    audioRenderStatus: "pending",
    audioRenderMessage: "脚本待确认，确认后才会渲染音频。",
    shownotes: buildPodcastShownotes(options.format, [
      `长期主题：${theme.name}`,
      `主题摘要：${theme.summary}`,
      `代表原话：${theme.representativeQuote}`,
      `下一问：${theme.nextQuestion}`,
      ...relatedAssets.map((asset) => `相关资产：${asset}`)
    ]),
    createdAt
  };
  const generatedState = {
    ...cloneState(state),
    podcastEpisodes: [episode, ...state.podcastEpisodes]
  };
  const stateWithCreationEvents = withAiRunEvent(
    withAuditEvent(generatedState, {
      type: "podcast_episode_created",
      label: "主题播客脚本已生成",
      detail: `从长期主题《${theme.name}》生成待确认脚本《${episode.title}》。`,
      severity: "info",
      entityType: "podcast_episode",
      entityId: episode.id,
      createdAt
    }),
    {
      workflow: "podcast_generation",
      providerId: state.systemConfig.models.synthesisModel,
      status: "succeeded",
      entityType: "podcast_episode",
      entityId: episode.id,
      inputSummary: `长期主题：${theme.name}`,
      outputSummary: `生成待确认主题专题播客脚本，预计 ${episode.durationSec} 秒。`,
      estimatedTokens: script.length,
      createdAt
    }
  );
  const nextState = withGeneratedArtifactWorkflowRun(stateWithCreationEvents, {
    workflow: "podcast_generation",
    entityType: "podcast_episode",
    entityId: episode.id,
    inputSummary: `长期主题：${theme.name}`
  });

  return {
    episode,
    nextState
  };
}
const podcastAiDisclosure = "AI 合成语音：本节目由系统根据用户确认内容生成，请以原始笔记和来源为准。";


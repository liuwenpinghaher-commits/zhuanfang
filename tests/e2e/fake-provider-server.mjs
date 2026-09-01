// E2E 假 provider 服务（真实性重构配套的测试方案基建）。
//
// 生产代码已剔除全部离线兜底——LLM/搜索/TTS/ASR 能力不可用即 503/429/502。默认族 E2E
// 因此不再依赖生产降级路径充当"无 key 可跑"的替身，而是把造假推到【外部网络边界】：
// 本服务在 127.0.0.1:13230 冒充 DashScope(compatible-mode + audio) 与 AnySearch 的 HTTP
// 契约，playwright 用 BAILIAN_BASE_URL / BAILIAN_AUDIO_BASE_URL / ANYSEARCH_BASE_URL
// 指过来。生产代码 100% 走真实代码路径（真 fetch、真解析、真校验、真落库）。
//
// canned 产物与 apps/api/src/test-helpers/fake-llm-clients.ts 保持同语义（该文件是
// vitest 层的进程内替身，本文件是 E2E 层的网络替身）——改动任一侧请同步。
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.FAKE_PROVIDER_PORT ?? 13230);

// ── canned LLM 产物（按 prompt 特征路由，见 detectCapability）──────────────────
const FINALIZE_JSON = JSON.stringify({
  summary: "这次对话把「测试主题」推进到了可验证阶段。",
  keyQuote: "我在测试里说过这句话。",
  saidTrack: ["用户复述了测试要点一。", "用户复述了测试要点二。", "用户复述了测试要点三。"],
  learnedTrack: ["被挑战的假设：测试即真实。", "新视角：先暴露再修复。"],
  nextQuestions: ["下次继续追问测试边界？"],
  points: [
    { title: "测试观点", content: "系统失败时应当如实暴露。", evidence: ["我在测试里说过这句话。"], themeRefs: [] }
  ],
  questions: [
    { question: "测试问题：边界在哪里？", whyImportant: "决定系统的诚实度。", nextPrompt: "边界之外发生什么？", themeRefs: [] }
  ],
  decisions: [
    {
      title: "测试决策", choice: "选择暴露失败", tradeOff: "牺牲表面可用性",
      riskHypothesis: "用户可能不适应", reviewAt: "", evidence: ["我在测试里说过这句话。"], themeRefs: []
    }
  ],
  debts: [
    {
      concept: "测试知识债", context: "对话里提到但没讲清。", whyImportant: "补全后判断更准。",
      nextQuestion: "能举个具体例子吗？", evidence: ["我在测试里说过这句话。"], themeRefs: []
    }
  ],
  themes: [
    {
      name: "测试主题线", summary: "追踪测试与真实的张力。", representativeQuote: "我在测试里说过这句话。",
      nextQuestion: "下次追问测试盲区。", maturity: "萌芽"
    }
  ],
  profileSuggestions: []
});

const PRE_SIGNALS_BLOCK = [
  "<pre_signals>",
  "depth_direction:",
  "  concept: 测试深挖方向",
  "  reason: 对话反复出现该主题",
  "  guidance: 能展开讲讲那次经历吗？",
  "backchannel: 嗯,对,是的",
  "interrupt: 不对,等一下",
  "sensitivity: medium",
  "</pre_signals>"
].join("\n");

const CANNED = {
  finalize: FINALIZE_JSON,
  preSignals: PRE_SIGNALS_BLOCK,
  turnComplete: JSON.stringify({ done: true, reason: "表达完整（fake）" }),
  memoryExtraction: JSON.stringify({
    candidates: [
      { text: "当系统失败时会如实暴露而不是伪装成功。", evidenceQuote: "我在测试里说过这句话。", sensitivity: "normal" }
    ]
  }),
  cognitiveRelations: JSON.stringify({ relations: [] }),
  reviews: JSON.stringify({
    monthly: {
      topTheme: "测试主题线",
      changedView: "从掩盖失败转向暴露失败。",
      avoidedQuestion: "被掩盖的失败有多少？",
      recommendedNextInterview: "下次聊聊暴露之后的修复。"
    },
    yearly: {
      coreQuestions: ["系统的诚实边界在哪里？"],
      changedViews: ["能用就能用，不能用就暴露。"],
      unresolvedPatterns: ["降级惯性"],
      importantDecisions: ["测试决策"],
      missingPerspectives: ["系统论"],
      nextYearFocus: "持续追踪真实性。"
    }
  }),
  corpus: JSON.stringify({
    dimensions: [
      {
        name: "追问动作", score: 4, finding: "样本擅长索要具体时刻。",
        example: "样本原话：那天下午你在哪里？", recommendedAction: "引擎应优先索要具体时刻。"
      }
    ],
    improvementPlan: [
      {
        title: "强化具体时刻索要", rationale: "样本用它打开细节。", action: "在追问模板中前置具体时刻问题。",
        expectedEngineChange: "追问更快落到事实。", evidence: "样本原话：那天下午你在哪里？"
      }
    ],
    patch: {
      title: "具体时刻优先", description: "先要时刻再要观点。",
      rules: ["先问『什么时候/在哪里』再问『怎么看』"], ruleTypes: ["concrete-moment"], impact: "medium"
    }
  }),
  searchInsights: JSON.stringify({
    summary: "这些资料只是追问线索，不是用户结论。",
    facts: ["来源[1]给出一个可核实的事实。", "来源[2]给出另一个事实。"],
    controversies: ["来源间存在方法论分歧。"],
    opposingViews: ["有观点认为相反成立。"],
    interviewAngles: ["把话题落到你上次的真实决策上。"],
    discussionTopics: ["这个变化影响了你哪个判断？"],
    sourceAngles: ["可引用来源[1]作为追问线索。"]
  }),
  podcastScript: "这是为测试生成的播客脚本正文。它基于真实笔记内容展开，长度足够被当作有效脚本。",
  consolidate: "当系统失败时会如实暴露而不是伪装成功（整合后的记忆表述）。",
  chat: "根据资料[1]，答案是：如实暴露失败。"
};

// 角色扮演专访追问（buildCharacterMessages 的 system prompt 走真实主持人 persona）：
// 回真实文本 + <pre_signals> 块（extractPreSignals 会剥离并结构化）。
function characterTurnReply(messages) {
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const utterance = (lastUser.match(/<user_utterance[^>]*>\n?([\s\S]*?)\n?<\/user_utterance>/)?.[1] ?? lastUser).trim();
  return (
    `你刚才提到「${utterance.slice(0, 12)}」，能给一个具体发生过的时刻吗？\n${PRE_SIGNALS_BLOCK}`
  );
}

function detectCapability(text) {
  if (text.includes("双轨笔记") && text.includes("keyQuote")) return "finalize";
  // characterTurn 必须先于 preSignals 判定：角色扮演专访 prompt 里也含 <pre_signals>
  // 使用说明（"在你的追问末尾，用 <pre_signals>…"），若先按 <pre_signals> 命中会只回
  // 信号块、无追问正文——服务端剥离后 content 为空，助手轮渲染成空气泡。
  if (text.includes("user_utterance") || text.includes("专访主持人")) return "characterTurn";
  if (text.includes("交互预判器") || text.includes("<pre_signals>")) return "preSignals";
  if (text.includes("轮转判定器") || text.includes("是否已经说完")) return "turnComplete";
  if (text.includes("长期记住") && text.includes("candidates")) return "memoryExtraction";
  if (text.includes("认知关系审校员")) return "cognitiveRelations";
  if (text.includes("认知分析师") && text.includes("monthly")) return "reviews";
  if (text.includes("访谈方法论分析师")) return "corpus";
  if (text.includes("资料分析助手") && text.includes("interviewAngles")) return "searchInsights";
  if (text.includes("播客")) return "podcastScript";
  if (text.includes("整理一个人的长期记忆")) return "consolidate";
  return "chat";
}

// 确定性 1024 维假 embedding（与 fake-llm-clients 同算法：文本哈希播种）。
function fakeEmbedding(text) {
  let seed = 7;
  for (let i = 0; i < text.length; i++) seed = (seed * 31 + text.charCodeAt(i)) % 100003;
  const vec = new Array(1024);
  for (let i = 0; i < 1024; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    vec[i] = (seed / 2147483648) * 2 - 1;
  }
  return vec;
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function json(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const path = url.pathname;

  if (path === "/health") return json(res, 200, { ok: true, service: "fake-provider" });

  // ── OpenAI compatible-mode: chat completions（全部 LLM 消费点）──
  if (path.endsWith("/chat/completions") && req.method === "POST") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const text = messages.map((m) => String(m.content ?? "")).join("\n");
    const capability = detectCapability(text);
    const content = capability === "characterTurn" ? characterTurnReply(messages) : CANNED[capability];
    return json(res, 200, {
      choices: [{ message: { role: "assistant", content } }],
      usage: { prompt_tokens: 10, completion_tokens: 50, total_tokens: 60 }
    });
  }

  // ── embeddings（云端 embedding client）──
  if (path.endsWith("/embeddings") && req.method === "POST") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    return json(res, 200, { data: inputs.map((t) => ({ embedding: fakeEmbedding(String(t ?? "")) })) });
  }

  // ── Responses API（bailian 联网搜索）──
  if (path.endsWith("/responses") && req.method === "POST") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const topic = String(body.input ?? "").match(/话题[:：]\s*(.+)/)?.[1]?.trim() ?? "测试话题";
    return json(res, 200, {
      output_text: JSON.stringify({
        summary: `关于「${topic}」的联网搜索综述（fake provider 产出，仅供 E2E）。`,
        facts: [`${topic} 的可核实事实一。`, `${topic} 的可核实事实二。`],
        controversies: [`${topic} 存在方法论分歧。`],
        opposingViews: ["有观点认为相反成立。"],
        interviewAngles: [`${topic} 和你上次的真实决策有什么关系？`],
        discussionTopics: [`${topic} 改变了你哪个判断？`],
        sourceAngles: ["可引用来源[1]作为追问线索。"],
        sources: [
          {
            title: `${topic}：来源一`, url: "http://127.0.0.1:13230/source/1",
            publisher: "Fake Provider", publishedAt: new Date().toISOString(),
            snippet: `${topic} 的来源一摘要。`, relevanceScore: 0.9
          },
          {
            title: `${topic}：来源二`, url: "http://127.0.0.1:13230/source/2",
            publisher: "Fake Provider", publishedAt: new Date().toISOString(),
            snippet: `${topic} 的来源二摘要。`, relevanceScore: 0.7
          }
        ]
      })
    });
  }

  // ── AnySearch ──
  if (path === "/v1/search" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const topic = String(body.query ?? "测试话题");
    return json(res, 200, {
      code: 0,
      data: {
        metadata: { request_id: "fake-req-1" },
        results: [
          {
            title: `${topic}：AnySearch 来源一`, url: "http://127.0.0.1:13230/source/a1",
            snippet: `${topic} 的 AnySearch 摘要一。`, publisher: "Fake AnySearch",
            published_at: new Date().toISOString()
          },
          {
            title: `${topic}：AnySearch 来源二`, url: "http://127.0.0.1:13230/source/a2",
            snippet: `${topic} 的 AnySearch 摘要二。`, publisher: "Fake AnySearch",
            published_at: new Date().toISOString()
          }
        ]
      }
    });
  }

  // ── Qwen-Audio ASR（默认模型 qwen-audio-3.0-asr-flash）──
  if (path === "/api/v1/services/aigc/multimodal-generation/generation" && req.method === "POST") {
    return json(res, 200, {
      request_id: "fake-asr-1",
      output: {
        text: "主持人：那天下午你在哪里？\n受访者：我在复盘一次失败的发布，那次我学会了先暴露问题再修复。"
      },
      usage: { duration: 12 }
    });
  }

  // ── CosyVoice TTS ──
  if (path === "/api/v1/services/audio/tts/SpeechSynthesizer" && req.method === "POST") {
    return json(res, 200, {
      output: {
        audio: {
          url: `http://127.0.0.1:${PORT}/fake-audio.mp3`,
          expires_at: Math.floor(Date.now() / 1000) + 86400,
          duration: 180
        }
      }
    });
  }

  // ── Voice enrollment（qwen-voice-enrollment）:音色列表/创建/删除 ──
  // GET /api/realtime-voice/voices 在配置了 enrollment client 时会真实外呼这里;
  // 上游失败即 502(不再用预置列表冒充),所以假 provider 必须提供 list 契约。
  if (path === "/api/v1/services/audio/tts/customization" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const action = body?.input?.action;
    if (action === "list" || action === "list_voice") {
      return json(res, 200, {
        output: {
          voice_list: [
            { voice: "longanyang", gmt_create: "2026-01-01 00:00:00" },
            { voice: "longanhuan", gmt_create: "2026-01-01 00:00:00" }
          ]
        }
      });
    }
    if (action === "create" || action === "create_voice") {
      return json(res, 200, {
        output: {
          voice_id: "qwen-audio-3.0-tts-plus-fakeclone-1",
          voice: "qwen-audio-3.0-tts-plus-fakeclone-1",
          target_model: "qwen-audio-3.0-tts-plus"
        }
      });
    }
    // delete / 其它 action：契约上返回空 output 即成功。
    return json(res, 200, { output: {} });
  }

  // ── SenseVoice ASR：提交任务 → 轮询 → 转写结果 ──
  if (path === "/api/v1/services/audio/asr/transcription" && req.method === "POST") {
    return json(res, 200, { output: { task_id: "fake-task-1" } });
  }
  if (path.startsWith("/api/v1/tasks/") && req.method === "POST") {
    return json(res, 200, {
      output: {
        task_status: "SUCCEEDED",
        // 真实 DashScope 契约:results 里每个子任务带 subtask_status,消费端
        // (pickSuccessfulTranscriptionResult)只认 SUCCEEDED 的子任务——缺了它会被判
        // "无转写 URL"而 502。
        results: [
          {
            subtask_status: "SUCCEEDED",
            transcription_url: `http://127.0.0.1:${PORT}/fake-transcription.json`
          }
        ],
        usage: { duration: 12 }
      }
    });
  }
  if (path === "/fake-transcription.json") {
    return json(res, 200, {
      transcripts: [
        {
          text: "主持人：那天下午你在哪里？\n受访者：我在复盘一次失败的发布，那次我学会了先暴露问题再修复。"
        }
      ]
    });
  }
  if (path === "/fake-audio.mp3") {
    res.writeHead(200, { "content-type": "audio/mpeg" });
    return res.end(Buffer.from("fake-mp3-bytes"));
  }

  json(res, 404, { error: `fake-provider: no handler for ${req.method} ${path}` });
});

const ttsWss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const path = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`).pathname;
  if (path !== "/api-ws/v1/inference") {
    socket.destroy();
    return;
  }
  ttsWss.handleUpgrade(req, socket, head, (ws) => {
    ttsWss.emit("connection", ws, req);
  });
});

ttsWss.on("connection", (ws) => {
  let taskId = "fake-tts-task";
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    const action = msg?.header?.action;
    if (typeof msg?.header?.task_id === "string" && msg.header.task_id) {
      taskId = msg.header.task_id;
    }
    if (action === "run-task") {
      ws.send(JSON.stringify({ header: { event: "task-started", task_id: taskId } }));
      return;
    }
    if (action === "finish-task") {
      ws.send(Buffer.alloc(128));
      ws.send(JSON.stringify({ header: { event: "task-finished", task_id: taskId } }));
    }
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(JSON.stringify({ event: "fake_provider_listening", port: PORT }));
});

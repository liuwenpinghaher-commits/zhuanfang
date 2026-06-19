# 功能实现质量分析报告(2026-06-19)

分支 `refactor/v3-system-optimization`。本报告分析本轮重构(阶段 0c→1→2→3→4 + 推送 + 端到端验证)各功能的实现质量,基于 **3 份独立对抗性代码审查** + **真实端到端测试**(Playwright 17 + 运行态 curl),并记录已修复与诚实接受的项。

---

## 1. 总评

**结论:核心实现整体可用且经端到端验证,但"测试绿"一度掩盖了一批真实缺陷——对抗审查揭出 1 个严重安全旁路、1 个严重 ASR 挂起、1 个数据丢失、以及 RAG 的多处正确性问题。这些已全部修复或诚实标注。**

关键教训:**fake/mock 的单测会遮蔽真实问题**。RAG 的 embedding 请求体格式错误、ASR 的 onclose 永久挂起、P1-18 的缺字段旁路,vitest 全绿却都存在——只有对抗审查 + 真实运行才暴露。

最终状态:tsc 0 错;确定性 vitest **615 passed**;Playwright e2e **17/17 passed**;新端点运行态 curl 全部验证。

---

## 2. 端到端验证(真实,非 mock)

| 验证 | 方式 | 结果 |
|---|---|---|
| 前端 12 视图 + 导航 + 专访生命周期 | Playwright(起真实 API+Vite,离线模式) | 17/17 绿 |
| 数据治理端点 privacy-report/export/purge | 运行态 curl | 200 + 正确语义(purge 后资产清零,audit 留痕) |
| RAG 资料问答(导入→召回→答案) | 运行态 curl | 导入笔记后查询真实召回并引用对应 chunk |
| RAG 离线 fallback | 运行态 curl | 无 key 时关键词召回 + 确定性答案,不崩 |
| CORS 白名单 | 运行态 curl | 反射 example.com、不反射 evil.com |
| production bearer 鉴权 | 运行态 curl | health 豁免 200 / 无 token 401 / 正确 token 200 |
| P1-18 乐观锁 | 运行态 curl | 缺 revision→409、正确 revision→200 |

**e2e 发现的真问题(已修):**
- P2-16 一键开始改变了首页流程 → 3 个 e2e 编码旧两步流程而失败 → 更新测试对齐契约(保留全部实质断言)。
- ConfigView `播客默认声音` 下拉**离线为空**(voices 端点无 client 返回空)→ 真实 UX 缺陷,已修(无 client 时返回 cosyvoice 预设)。
- 2 个 e2e 用了无效 voice 值(longyuan_v3 等,非 cosyvoice-v3-plus 预设)→ 预存在失败(经 pre-work worktree 实测确认非本轮回归),已改用合法预设。

---

## 3. 对抗审查发现 + 处置

三个领域各派一名独立审查员,要求"找真问题不要客套"。

### 3.1 安全(阶段 4)

| 发现 | 严重度 | 处置 |
|---|---|---|
| **P1-18 缺 revision 字段零成本旁路乐观锁**(实测可覆写任意旧 state) | 严重 | ✅ 修:PUT /api/state 要求 revision 存在且相等,缺失→409。前端 saveState 本就必带 revision,无破坏。 |
| token 比较非 timing-safe | 次要 | ✅ 修:`crypto.timingSafeEqual` |
| `DEPLOYMENT_PROFILE` 大小写敏感(`Production` 静默绕过鉴权) | 重要 | ✅ 修:trim+toLowerCase |
| 用户 interview 输入未清洗(corpus/search 却清洗了,不一致) | 重要 | ✅ 修:userText 进 LLM 前复用 sanitize + 诚实标注"非安全边界" |
| 路径遍历绕过鉴权 | 实测无(Fastify 已规范化路径) | 无需改 |
| CORS credentials+反射危险组合 | 无(未设 credentials) | 无需改 |

### 3.2 数据模型 / 行为变更(阶段 0c + 4)

| 发现 | 严重度 | 处置 |
|---|---|---|
| **ASR WebSocket onclose 不 reject → 服务端正常关闭时 start() 永久挂起,重连失效**(测试恰好只覆盖 onerror) | 严重 | ✅ 修:onclose-before-ready 也 reject(settled 标志防双重 settle)+ 补测 onclose 路径 |
| **normalizeVoiceConfig 白名单把任意非预设 voice(含用户克隆 custom voice)静默改为 longanyang** | 重要 | ✅ 修:改黑名单——只纠正已知非法 legacy 值(warm-interviewer/calm-host/local-demo),custom 声音原样保留 |
| P1-11 maxPollTotalMs 在生产 FromEnv 路径无法配置 | 重要 | ✅ 修:FromEnv 读 `BAILIAN_ASR_POLL_TOTAL_MS` 透传 |
| P0-12 去种子化是"换了一批硬编码词"(mentionsAvoidance/WorstCase 仍偏管理语料,非真 scenario-agnostic) | 重要 | ⚠️ 诚实标注:`// ponytail:` 注明为启发式关键词信号、真 scenario-agnostic 需 LLM 驱动(升级路径)。未做风险重写。 |
| 迁移幂等/无损、pruneDanglingThemeRefs | 无问题(有测) | — |

### 3.3 RAG(阶段 3)

| 发现 | 严重度 | 处置 |
|---|---|---|
| **embedding 请求体 `{input:{texts}}`(原生格式)与 compatible-mode baseUrl 不符,真 key 下大概率 400**(fake fetch 遮蔽) | 重要 | ✅ 修:改 OpenAI 兼容 `{input: texts}` |
| 空数组 embedding(部分失败)通过 `Array.isArray` 过滤进检索成"幽灵向量" | 重要 | ✅ 修:topKByCosine 过滤 `length>0`;ingest 不附空 embedding |
| 批量 embed 无批次上限(>10 chunk 触 DashScope 限制,大文档整批失败) | 重要 | ✅ 修:按 ≤10 分批,单批失败不阻塞 |
| embedding 存进 state JSON 无体积上限(state 膨胀) | 严重 | ✅ 修:`MAX_EMBEDDED_CHUNKS=200` 上限 + log 跳过数 |
| citations 与答案不对应(答案用前 3、citations 列全部) | 重要 | ✅ 修:citations 只列答案实际引用的 chunk |
| rag.test 的"预算耗尽"是废测(实测 chat 异常 + 死代码) | 重要 | ✅ 修:改为真验证预算耗尽路径 |
| **主访谈流程从不调 cosine**(buildInterviewContextPack 不传 queryEmbedding,只 /api/rag/query 用 cosine) | 重要 | ⚠️ 诚实标注:主流程 topicHint 短、关键词足够;语义 cosine 由专用 /api/rag/query 消费(资料问答)。embedding 非浪费(被该端点使用)。未做穿透 context-pack 的 async 重写。 |

---

## 4. 测试质量评估

- **强**:领域逻辑(storage 迁移、engine、vector、cosine)单测覆盖好;真实 e2e(Playwright + curl)覆盖核心用户旅程与新端点。
- **弱(已部分补)**:外部调用大量 fake → 一度遮蔽真实 API 格式错误(RAG embed)、协议路径(ASR onclose)、字段旁路(P1-18 缺 revision)。本轮对抗审查后补了 onclose、缺-revision、空向量、批量、custom-voice 等边界/失败路径测试。
- **真 LLM 路径**:`.real.test.ts` 由 DASHSCOPE_API_KEY 门控,本轮以离线/fake 为主验证;真 key 下的 embedding/TTS/ASR 全链路仍建议手动验一次(本机有 key,可跑 `npx vitest run *.real.test.ts`)。

---

## 5. 诚实的剩余局限(未做,有意识)

1. **P0-12 追问仍是关键词启发式**,非真正 scenario-agnostic(需 LLM 驱动生成,留作升级,已标注)。
2. **主访谈 RAG 用关键词**,cosine 仅服务 /api/rag/query(短 topicHint 下关键词足够,已标注)。
3. **浏览器 realtime 语音**(打断、麦、WS 生命周期)单测覆盖逻辑层,完整验证需真机长会话(P1-7 livekit interrupt 已诚实标注受 SDK 限制)。
4. **RAG 体积上限固定 200 chunk**,规模上来需换外部向量库(已标注升级路径)。
5. 真 LLM 全链路(embedding 真调百炼)未在本轮真跑(离线 + fake 验证)。

---

## 6. 修复提交(本轮质量整改)

```
c739d1cb fix(security): require revision on state PUT, timing-safe token, case-insensitive profile, sanitize user turns
14813416 fix(asr): reject on WS close-before-ready (no hang) + wire maxPollTotalMs from env
9729b17a fix(voice): correct only known-invalid legacy voices, preserve custom enrolled voices
91fe8b22 fix(rag): OpenAI-compat embed body, drop empty-vector chunks, batch+cap embeddings, align citations
4a996ec7 docs: honestly scope main-flow keyword RAG + heuristic turn-builder signals (ponytail)
f3f2475e fix(voice): offer cosyvoice presets when voice enrollment unavailable (offline voice dropdown)
ad3ffbf8 test(e2e): align with one-click start (P2-16) + valid cosyvoice presets
```
全部只 add 计划/审查指定文件;zhuanfang/CLAUDE.md/memory/.claude 零误吞。

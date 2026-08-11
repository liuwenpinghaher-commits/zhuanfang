# 成本信封（D3.a · 定稿）

> **日期：** 2026-07-30  
> **范围：** 单机单用户 MVP 的 **调用次数 / 流量上界** 与运维旋钮  
> **不是：** 美元账单、token 精确计量、供应商价目表（百炼单价会变，本文件不锁价）  
> **代码真源：** `apps/api/src/llm-budget.ts` · 各路由 `tryConsume(...)`  
> **配套：** [`MAINTENANCE-ROADMAP.md`](./MAINTENANCE-ROADMAP.md) · Wave D 分析 D3 · [`runbooks/README.md`](./runbooks/README.md) §3/§5

本文件回答：**一场典型使用会烧掉多少「计费相关调用」？进程级硬闸在哪？如何调而不破坏 fail-loud？**

---

## 1. 先读这三条

1. **进程内 LLM 预算是「调用次数」计数器**，不是 token、不是 USD。  
   - 默认：`LLM_MAX_CALLS_PER_SESSION=200`（未设或非法值时回落 200；**显式 `0` = 全关 kill-switch**）。  
   - 系统类桶滑窗：`LLM_SYSTEM_WINDOW_MS` 默认 **3600000（1h）**；到 cap 后返回 **429** + 日志 `llm_budget_exceeded`。  
2. **HTTP 限流是另一道闸**（`RATE_LIMIT_*`），与 LLM 预算正交；严格桶覆盖 export / chat / rag / voice 等。  
3. **供应商账单**仍以 DashScope/百炼控制台为准；本信封只给「次数上界 + 场景模型」，避免把调用预算误读成金额。

---

## 2. 预算桶模型（与代码一致）

实现：`createLlmBudget()`。

| 桶类型 | Key 形态 | 到 cap 后行为 | 恢复方式 |
| --- | --- | --- | --- |
| **会话桶** | 真实 `session.id` | 该专访会话内后续 LLM 调用 429 | `POST .../end` 等路径 `budget.reset(sessionId)`；或新会话新 id |
| **系统滑窗桶** | 固定名，见下表 | 该 key 在窗口内 429 | 等滑窗滚动（默认 1h）或调大 cap/窗 |

### 2.1 系统滑窗 key（`SYSTEM_BUDGET_KEYS`）

| Key | 典型 capability（日志/语义） | 路由/模块 |
| --- | --- | --- |
| `system` | `import_documents` · `search_briefs` · `search_refresh` · `search_auto_briefs` · `podcast_script` · `corpus_insights` 等 | import / search / podcast / corpus |
| `chat` | 全局助手 chat | `routes/chat.ts` |
| `rag_query` | 导入资料 QA | `routes/rag.ts` |
| `knowledge_index` | 嵌入 / 重嵌 | `routes/knowledge.ts` 等 |
| `memory_consolidate` | 记忆整理摘要 | `routes/memory-candidates.ts` |
| `research_auto_run` | 后台研究调度 | `research-scheduler.ts` · search auto |
| `reviews` | 月/年复盘叙事 LLM | `routes/reviews.ts`（`GET /api/reviews`） |

每个 key **各自**享有「每窗最多 `LLM_MAX_CALLS_PER_SESSION` 次」——**不是**全局 200 均分所有 key，而是 **每 key 每窗最多 200**（默认）。

### 2.2 会话桶（专访主路径）

| Key | 计入内容（同一 session 共享一个计数器） |
| --- | --- |
| `session.id` | 文本/语音追问 turn · pre_signals · turn_complete · memory_extraction · cognitive_relations 等 |

一场专访的 **全部会话侧 LLM** 共享该 session 的 200 次上限（默认），结束时 reset。

### 2.3 已知边角

| 项 | 说明 |
| --- | --- |
| `reviews` | 独立 key `reviews`，已在 `SYSTEM_BUDGET_KEYS` 滑窗集合；默认每小时最多 `LLM_MAX_CALLS_PER_SESSION` 次，到 cap 后 429，窗滚动后恢复（不再是「孤立单调桶」）。 |
| 语音 cascade TTS/ASR | 浏览器/代理路径上的 **流式 TTS、SenseVoice ASR、Realtime** 多数 **不走** `llm-budget` 次数闸（仍受供应商配额与 `RATE_LIMIT` 影响）。专访 **LLM 追问**仍走 session 桶。 |
| Embedding | `knowledge_index` 等走预算；本地 `EMBEDDING_PROVIDER=local` 仍计 **调用次数**（不产生云 embedding 费，但仍占进程闸）。 |
| 未配置 key | 能力 **5xx / 诚实失败**，不会静默烧预算装成功。 |

---

## 3. 场景调用上界（工程模型）

下列为 **上界量级**，用于容量与「会不会先撞 429」；**不是** SLA。  
「LLM 次」= 进入 `tryConsume` 且成功占用的次数。  
「供应商侧」= 仍可能产生账单、但不一定计入 LLM 预算的调用。

### 3.1 短文本专访（约 8–12 轮追问 + 结束沉淀）

| 步骤 | 桶 | 次数模型（约） |
| --- | --- | --- |
| 每轮追问 LLM | session | 1 / 轮 → **8–12** |
| turn_complete / pre_signals（若开启） | session | 0–2 / 轮量级 → **0–20** |
| 结束 finalize / 记忆抽取 / 认知关系（若触发） | session | **1–5** |
| **会话合计** | session | **约 10–40**（远低于默认 200） |
| 结束页后 HITL 人工审批 | — | 0 LLM（纯状态） |

### 3.2 短 cascade 语音专访（约 10 分钟 · 1 路）

| 步骤 | 是否计 LLM 预算 | 备注 |
| --- | --- | --- |
| ASR 分片 / 流式识别 | 通常否 | 供应商 ASR 时长/次数 |
| 每轮应答 LLM | **是 · session** | 与文本类似，轮次驱动 |
| 流式 TTS 子句 | 通常否 | 字符/请求计供应商 TTS |
| barge-in / interrupt | 否（控制面） | 不另计 LLM |
| **会话 LLM** | session | **约 15–50**（含 turn 辅助） |
| **推荐并发** | — | **1 路** cascade（见部署清单） |

### 3.3 Chat / RAG 问答（单用户连问）

| 能力 | 桶 | 上界含义 |
| --- | --- | --- |
| `POST /api/chat` | `chat` 滑窗 | 默认每小时最多 **200** 次 chat LLM |
| `POST /api/rag/query` | `rag_query` 滑窗 | 默认每小时最多 **200** 次 |
| 召回 embedding（若每次问都 embed） | 常挂在路由逻辑 / `knowledge_index` 相关路径 | 大量重问 + 重嵌时先观察 `knowledge_index` 429 |

### 3.4 导入资料 + 建索引

| 步骤 | 桶 | 模型 |
| --- | --- | --- |
| 导入解析 / 可选 LLM  enrichment | `system` | 按批次数，单次导入通常 **个位数–十几** |
| 分块 embedding | `knowledge_index` | **约 1 次 / 需嵌入的批或块路径**（实现按路由批处理；大库重建最吃此桶） |
| 全量 rebuild | `knowledge_index` | 可能逼近窗 cap → 拉长窗口或分批，或临时提高 cap |

知识规模建议：hybrid 观察 **&lt; ~10k chunks**（容量信封，非硬限制）。

### 3.5 播客（脚本 + 可选 TTS）

| 步骤 | 桶 | 模型 |
| --- | --- | --- |
| 笔记路径脚本 LLM | `system`（capability `podcast_script`） | 通常 **1** 次成功脚本；失败 502 不落假稿 |
| TTS `synthesize` | 一般不走 LLM 预算 | **按字符/请求**计 CosyVoice；默认创建不自动渲染（`PODCAST_AUTO_RENDER_ON_CREATE` 默认关） |
| 长文一次合成 | — | 无服务端自动分片时，超时风险在供应商侧（D1.b 增强项） |

### 3.6 联网搜索 / 后台 research

| 步骤 | 桶 | 模型 |
| --- | --- | --- |
| 搜索简报 LLM 整理 | `system` | 每次 brief/refresh 路径 **1+** |
| 外接 Search API | 否（LLM 预算） | AnySearch/Tavily/Exa/Brave **各自计费与限流** |
| `research_auto_run` 调度 | `research_auto_run` 滑窗 | 与交互 `system` 隔离，避免后台抽干前台 |

### 3.7 记忆巩固

| 步骤 | 桶 | 模型 |
| --- | --- | --- |
| `POST /api/memory/consolidate` | `memory_consolidate` | 按集群摘要次数；`mode=queue` 可只预览 |

---

## 4. 与 HTTP 限流的叠加（别只看 LLM 预算）

| 变量 | 默认意图 | 作用 |
| --- | --- | --- |
| `RATE_LIMIT_MAX` | ~60 / 窗 | 一般 API |
| `RATE_LIMIT_STRICT_MAX` | ~20 / 窗 | export / chat / rag / voice 等更严 |
| `RATE_LIMIT_WINDOW_MS` | 60000 | 窗口 |
| `RATE_LIMIT_DISABLED` | 生产 **禁止 true** | 测试专用 |

同一用户连点 chat：可能先撞 **strict 429**，再撞 **`chat` 预算 429**。日志区分：`rate_limit_exceeded` vs `llm_budget_exceeded`。

---

## 5. 粗算「会不会贵」（定性，非报价）

个人 MVP 常见成本驱动（降序）：

1. **语音**：Realtime 全双工或长 cascade（ASR 时长 + TTS 字符 + 多轮 LLM）。  
2. **播客 TTS**：长脚本 × 重合成。  
3. **批量搜索 / 自动 research**：外搜 API + 简报 LLM。  
4. **全库重嵌**：chunk 数 × embedding。  
5. **纯文本短专访 + 偶发 chat**：通常远低于语音/TTS。

**省钱默认（已在产品里）：**

- 专访主路径优先 **cascade**（相对 omni Realtime 更可控）。  
- 播客 **默认不**创建即 TTS。  
- 无 key → 失败暴露，不烧「假成功」重试环。  
- 可 `EMBEDDING_PROVIDER=local` 降云 embedding（首次下模型；维度须保持 1024）。

---

## 6. 调参速查

| 目标 | 建议 |
| --- | --- |
| 临时禁止一切 LLM | `LLM_MAX_CALLS_PER_SESSION=0`（kill-switch） |
| 长专访 / 多辅助信号顶满 session | 提高 cap，或减少 per-turn 辅助 LLM |
| chat/rag 一小时 429 | 提高 cap 或 `LLM_SYSTEM_WINDOW_MS`；同时检查 strict 限流 |
| 索引重建中途 429 | 分批、提高 cap、或拉长窗；观察 `knowledge_index` |
| `reviews` 一小时 429 | 与其它系统桶相同：等滑窗或提高 cap / `LLM_SYSTEM_WINDOW_MS` |
| 账单惊吓 | 先关 `PODCAST_AUTO_RENDER`、降 research 调度、限语音时长；控制台核对 TTS/ASR |

---

## 7. 验收（D3.a 完成定义）

- [x] 单场 / 分能力 **调用上界表** 落盘（本文）  
- [x] 明确 **次数 ≠ USD/token**  
- [x] 指向代码桶与 env 旋钮  
- [x] README / CURRENT / 维护路线图可发现本文  
- [ ] D3.b `llm_calls_by_capability` 汇总 API（未做；有指标需求再开）  
- [ ] D3.c provider usage 透传 estimatedTokens（未做）

---

## 8. 相关链接

| 文档 | 用途 |
| --- | --- |
| `apps/api/src/llm-budget.ts` | 预算实现 |
| `docs/runbooks/README.md` | 429 / provider 5xx 处理 |
| `docs/DEPLOYMENT-CHECKLIST.md` | 生产 env 勾选 |
| `docs/superpowers/2026-07-30-wave-d-analysis.md` | D3 切片全景 |
| `docs/MAINTENANCE-ROADMAP.md` | 下一队列项 |

**D3.a 状态：closed（文档信封）**  
**关联：D6.a 告警协议见 [`docs/runbooks/ALERTS.md`](./runbooks/ALERTS.md)。**

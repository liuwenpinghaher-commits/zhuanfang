# Wave D 剩余维度完整分析（2026-07-30）

> 范围：CURRENT 仍标 **open** 的 D1–D6  
> 基线：`main` @ `96a82cad`+ · Wave 0–C 已闭 · 健康检查绿 · Conditional GO  
> 方法：对照代码与既有测试；**本篇为分析 + 维护路线，默认不强制一次改完 D**

---

## 0. 总览

| ID | 维度 | 工程成熟度 | 产品/运营成熟度 | 建议优先级 | 与 MVP 上线关系 |
| --- | --- | --- | --- | --- | --- |
| D1 | 播客 E2E | 中高 | 中 | P2 | 不阻塞 Conditional GO |
| D2 | 搜索/素材策略 | 中 | 中 | P2 | 无 key 时已诚实失败 |
| D3 | 成本经济学 | 低 | 低 | P2 | 个人用可暂缓 |
| D4 | UX / a11y / 移动 | 中 | 中低 | P2–P3 | 桌面主路径可用 |
| D5 | Provider 可移植 | 低 | 低 | P3（无第二厂商需求时） | 接受百炼绑定 |
| D6 | 可观测运营化 | 中 | 低 | P2 | runbook+health 已够单机 |

**共同结论：** Wave D 是**增强与可运营化**，不是正确性主路径空洞。维护策略应是「按需切片 + 回归门禁不回退」，而非再开一轮全系统重写。

---

## D1 — 播客工作台 E2E

### 现状（代码）

| 能力 | 锚点 | 行为 |
| --- | --- | --- |
| 多源创建 | `apps/api/src/routes/podcast.ts` | note（LLM 脚本）/ search-brief / theme / knowledge-debt |
| 脚本 | `intelligence/podcast-script-llm.ts` + domain `generatePodcastEpisode*` | 笔记路径强制 LLM；失败 502，不落假脚本 |
| 落库顺序 | podcast 路由 | **先 persist 脚本**，再可选 TTS |
| TTS | `renderEpisodeAudio` · CosyVoice client | 成功 `rendered`+`audioExpiresAt`；失败 `failed`+真错误 |
| 默认策略 | `PODCAST_AUTO_RENDER_ON_CREATE` | 默认关 → 确认后 `POST .../synthesize` |
| UI | `PodcastStudioView.tsx` | 工作台编辑/合成；基础 aria |
| 格式 | `solo` \| `host-guest` | 域常量存在 |

### 缺口（分析）

1. **长脚本：** 无服务端按句/按时长切分重试；超长一次 synthesize 易超时或截断不明。  
2. **host-guest：** 双人角色音色/轮次一致性未产品化约束。  
3. **过期音频：** 有 `audioExpiresAt`，UI/自动 refresh 路径未系统分析。  
4. **成本：** 脚本字数 × TTS 单价未进 metrics。  
5. **质量：** 无 shownotes/脚本 rubric；与专访笔记一致性无抽检。  
6. **brief/theme/debt 路径：** 部分可能偏模板/域生成，与 note-LLM 路径质量不齐（需按源再审计 diff）。

### 爆炸半径

中。改 TTS 分段影响 `podcast.ts` + provider client + UI 播放器；不碰专访主路径。

### 建议切片（维护）

| 切片 | 验收 |
| --- | --- |
| D1.a 过期刷新 | synthesize 可重拉；UI 展示过期 |
| D1.b 长文分段 | 超 N 字分片合成并拼接或明确 422 |
| D1.c 成本计数 | metrics：`podcast_tts_chars` |
| D1.d 源路径审计 | 四源脚本来源表 + 单测 |

---

## D2 — 搜索与「来源→资产」

### 现状

| 能力 | 锚点 | 行为 |
| --- | --- | --- |
| Provider | bailian / anysearch / tavily / exa / brave | env 自动启用 |
| 失败语义 | `search.ts` | 联网失败 **502**，不用 local-demo 假简报落库 |
| local-demo | 显式 provider | 422 on refresh 等边界 |
| Brief → 访谈 | agendaTrace / guide | 外部材料须回用户事件 |
| 外材清洗 | sanitize | prompt 注入缓解 |
| 调度 | `research-scheduler.ts` | 可选后台；budget 滑窗 |

### 缺口

1. **多 provider 融合：** 无统一 URL 规范化去重与可信排序专题。  
2. **needs-review：** 降级/争议源是否贯穿转资产全部 UI 入口 — 未做旅程级核对。  
3. **批量主题搜集：** 噪声、限流（已有全局限流）、成本尖峰。  
4. **时效/版权：** 无过期源策略。  
5. **与 chat knowledge_chunk：** 搜索资产入索引的延迟与 reindex 观感。

### 爆炸半径

中。动融合算法影响 SearchBrief 内容与下游访谈/播客线索。

### 建议切片

| 切片 | 验收 |
| --- | --- |
| D2.a URL 去重 | 同 canonical URL 不双记 |
| D2.b 转资产 HITL 清单 | UI 必经 needs-review |
| D2.c 批量搜集 | 走 strict rate limit + 任务状态诚实 |

---

## D3 — 成本经济学

### 现状

- `llm-budget.ts`：**调用次数** / session 与系统滑窗，**不是** token 或 USD。  
- 无按 capability 的字符/分钟账单。  
- voice-slo / runtime-metrics 有延迟与 grounding，无 cost。

### 缺口

1. 单场专访：ASR + 多轮 LLM + TTS + embed 上界模型。  
2. 播客 / 批量搜索 / reindex 尖峰。  
3. 本地 embed vs 云 embed TCO。  
4. 运营可读的「本月估算」——即便是粗算。

### 爆炸半径

低～中。只加 metrics/文档则低；改 provider 请求封装以读 usage 则中。

### 建议切片

| 切片 | 验收 |
| --- | --- |
| D3.a 文档成本信封 | README/清单：单场 call 上界表 |
| D3.b metrics counters | `llm_calls_by_capability`（已有部分 event）汇总 API |
| D3.c （可选）usage 透传 | 若百炼返回 usage，记 estimatedTokens |

**维护原则：** 个人 MVP 可长期停在 D3.a+b；商业化前再做 D3.c。

---

## D4 — UX / a11y / 移动端

### 现状

- 多视图大量 `aria-*`（Interview、Memory、Search 等）。  
- `styles.css` ~3900 行；多断点 + `prefers-reduced-motion`。  
- 专访/语音主路径桌面可用；配置/健康 TTFA 可见。

### 缺口

1. **系统 a11y 审计**未做（焦点陷阱、读屏、对比度、键盘全路径）。  
2. **移动 Safari 语音**（权限、后台、中断）未当一等 e2e。  
3. **大状态性能**（长 sessions、大 ragChunks）渲染未 profile。  
4. **多 Tab**：CAS/revision 有，冲突文案有 demo 指纹；完整多端策略未产品化（CRDT 非目标）。

### 爆炸半径

中（CSS/焦点易回归）。应用组件级改动 + 视觉回归抽检。

### 建议切片

| 切片 | 验收 |
| --- | --- |
| D4.a 专访键盘路径 | Tab/Esc/主按钮无陷阱 |
| D4.b 对比度抽检 | 关键页 WCAG AA 抽样 |
| D4.c 移动语音诚实 UI | 权限拒绝/失败不白屏 |
| D4.d （可选）列表虚拟化 | 长列表帧率 |

---

## D5 — Provider 可移植性

### 现状

| 层 | 绑定 |
| --- | --- |
| Chat / Character / Realtime / TTS / ASR | DashScope/Bailian 客户端 |
| Embedding | 云端默认；`EMBEDDING_PROVIDER=local` → bge-large-zh 1024d |
| 向量索引 | Surreal HNSW **DIMENSION=1024** 与模型耦合 |
| LiveKit | 可选旁路 `agent/` Python |
| 接口形状 | 已有 client 接口类型，便于测假 client |

### 缺口

1. 无第二「一等」LLM/TTS 厂商验收。  
2. 换 embedding 维度 = **全量重嵌 + schema 迁移**，无 runbook 演练。  
3. LiveKit agent 与主仓发布不同步风险未专题。  
4. 区域/合规断供剧本仅有 fail-loud，无多活。

### 爆炸半径

高（若真换模）。维护上应 **文档化边界 + 禁止静默换维**。

### 建议切片

| 切片 | 验收 |
| --- | --- |
| D5.a 适配层文档 | README：Client 边界与测假注入点 |
| D5.b 换维 runbook | 步骤：停写 → 迁 DIMENSION → rebuild embed |
| D5.c LiveKit 版本钉 | agent/requirements 与主仓兼容表 |
| D5.d 第二厂商 | **仅当有明确需求时**开项目，不预研过度 |

---

## D6 — 可观测运营化

### 现状

| 能力 | 锚点 |
| --- | --- |
| Health | `routes/health.ts`：persist、voice 分段、recall |
| 环形 metrics | `observability/runtime-metrics.ts` · `/api/system/runtime-metrics` |
| stderr JSON | hybrid/rag/chat/tts/rate_limit/ssrf… |
| OTEL | `telemetry.ts`：OTLP、query token 脱敏、shutdown 在 flush 后 |
| Runbook | `docs/runbooks/README.md` |
| CI | typecheck + unit |

### 缺口

1. 无告警规则（p95 TTFA、persist.degraded、429 率）。  
2. Trace 与 `session.id` 关联未规范。  
3. 日志留存/隐私策略未产品化。  
4. Compose 无可选 OTEL collector profile。  
5. 看板：配置页有部分 metrics，非运营级。

### 爆炸半径

低～中。加 span 属性低；加依赖 collector 中。

### 建议切片

| 切片 | 验收 |
| --- | --- |
| D6.a 告警草案 | runbook 附录：阈值与阈值 |
| D6.b session 属性 | 关键 span 白名单 `session.id` |
| D6.c compose otel profile | 可选 profile 文档 |
| D6.d （可选）metrics 导出 | Prometheus 文本或 OTLP metrics |

---

## 维度依赖（维护时避免散打）

```text
Full GO 验证 ──┬─ 不阻塞 D 增强
               │
D3 成本文档 ───┼─ 支撑 D1 播客 / D2 搜索 的「该不该默认开」
D6 可观测 ─────┼─ 支撑所有 D 上线后的发现问题
D5 可移植 ─────┴─ 仅在供应商风险升高时升级
D4 a11y ─────── 与功能切片并行，改 UI 时顺带
```

---

## 明确不在 Wave D 再分析的范围

- 多租户、CRDT 多设备、完整 AWS SDK  
- 重做 Surreal 正确性 / 混合召回主路径（已闭）  
- 再扫一轮「全系统 16 维」除非产品形态变化  

---

## 分析结论（给维护路线的输入）

1. **D 全是增强面**；单机 MVP 可带着 Conditional GO 运行。  
2. **最高杠杆维护项**其实是清单 **Full GO 验证**（非 D），然后才是 D1/D2/D6 薄切片。  
3. **D3/D5** 以文档与 runbook 为主即可，避免过早造计费与多厂商。  
4. 任何 D 切片必须：单测 + 全量 `REAL_PROVIDER_SMOKE=off` 不回退 + CURRENT 勾状态。  

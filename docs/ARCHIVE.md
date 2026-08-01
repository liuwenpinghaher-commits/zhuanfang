# 项目文档归档与最终健康检查

> **最近归档：** 2026-08-01 · tip `main` @ `14cc5f5e`（双轨笔记阅读室 + 生产冒烟已关闭，见 §0.8）  
> **基线归档：** 2026-07-30 · tip `14304554`  
> **远程：** `origin/main` 同步 · 工作区干净（归档时）  
> **运行时：** Node ≥22.5 · macOS · Docker Compose `:3210`

本文档是文档体系的**归档入口**：标明何为现行真源、何为历史过程材料，并固化健康检查结果。

---

## 0. 2026-08-01 任务归档（本轮关闭）

### 0.1 交付范围

| 主题 | Commit | 说明 |
| --- | --- | --- |
| 播客多源 LLM | `31294d37` | note/search-brief/theme/knowledge-debt 全走 LLM 脚本；fail-loud |
| 部署验证文档 | `c0a14c8c` | `2026-08-01-podcast-multisource-llm-deploy-verification.md` |
| 播客 TTS / 资产 P1 | `4a6d1b7a` | CosyVoice 音色归一+动态超时；过期音频 UX；仅重要/排序/URL/带入专访 |
| 今日访谈台闭环 | `6b295e0f` | 继续优先、空场 discard、launch 参数不丢、将带入芯片 |

### 0.2 最终回归（2026-08-01 部署前）

| 门禁 | 结果 |
| --- | --- |
| typecheck | **PASS** |
| Vitest | **PASS** · **1624 pass / 6 skip** |
| Playwright 默认 e2e | **PASS** · **38/38**（隔离 13210/13220/13230） |
| Compose 生产 | **healthy** · `productStore=surreal` · 新 bundle 含「另开一场/移除空场」 |
| discard 路由 | 在线（未知 id → 404） |

### 0.3 本地清理（归档动作）

- 删除 `test-results/`、`playwright-report/`（若存在）
- 删除本轮 `/tmp/zf-*`、`/tmp/zhuanfang*` 冒烟临时文件
- **保留** 生产容器 `:3210`（未 `compose down`，避免误停在用实例）
- **未**执行 `git clean -fdx` / 删除 `node_modules` / 删 `.data`

### 0.4 现行补充真源

| 路径 | 角色 |
| --- | --- |
| `docs/superpowers/2026-08-01-podcast-multisource-llm-deploy-verification.md` | 播客多源 LLM 生产验证 |
| `docs/superpowers/CURRENT-开放清单.md` | 含 2026-08-01 追加闭合项 |
| `README.md` §验证状态 | 最近发布验证表 |

### 0.5 明确未纳入本轮（非阻塞）

- Wave D 其余增强（D2 融合深化、D3 账单、D4 全站 a11y、D5 第二厂商、D6 OTEL 看板）— 按需
- 多租户 / CRDT / 完整 AWS SDK — Won't
- 长脚本 TTS 分片拼接 — 已用动态超时缓解；完整分片属后续 D1.b

### 0.6 访谈台/实时专访剩余项收口（同日续）

| 项 | 状态 |
| --- | --- |
| 实时专访对话优先 UX | **closed** · `080308b0` |
| 上场摘要回 Home、结束确认、Esc、移动端 | **closed**（本批） |
| 最终报告 | `2026-08-01-interview-ux-optimization-report.md` |

**本轮任务状态：关闭 · 可归档**

### 0.7 主题线 / Track 端到端（同日续）

| 项 | 状态 |
| --- | --- |
| 非 Home resume 空场 discard | **closed** |
| 复盘 SWR + 重试 + 三分态 | **closed** |
| 继续绑定 topicHint + relatedThemeIds | **closed** |
| Track 返回 themes + 三列钻取 | **closed** |
| 雷达真实零值 | **closed** |
| 报告 | `2026-08-01-themes-track-optimization-report.md` |

### 0.8 双轨笔记阅读室（同日续）

| 项 | 状态 |
| --- | --- |
| 用此问题开场 + Hero 智能 CTA | **closed** |
| 保存问题去重并留页 | **closed** |
| 轻量 pill / 展开 / 搜索筛选 | **closed** |
| 主题 chip · 播客 · 原文 · 档案高亮 | **closed** |
| 报告 | `2026-08-01-notes-reading-room-optimization-report.md` |
| 生产工作流冒烟 | **PASS** · `2026-08-01-notes-workflow-smoke.md` |
| 可复现脚本 | `scripts/notes-workflow-smoke.mjs` |
| 任务状态 | **关闭 · 可归档**（`14cc5f5e`） |

**§0.8 任务状态：关闭 · 已归档**

---
## 1. 最终系统健康检查（2026-07-30）

| # | 门禁 | 命令 / 检查 | 结果 |
| ---: | --- | --- | --- |
| 1 | Git | `main` == `origin/main`，无脏文件 | **PASS** |
| 2 | Typecheck | `npm run typecheck` | **PASS** |
| 3 | 全量测试 | `REAL_PROVIDER_SMOKE=off npm test -- --run` | **PASS** · **1600 pass / 0 fail / 6 skip** · 158 files · ~26s |
| 4 | 生产构建 | `npm run build` | **PASS** · Vite `dist/` 生成 |
| 5 | 容量 smoke | `node scripts/capacity-smoke.mjs 1000` | **PASS** · hitCount=8 · rankMs≈0.8ms |
| 6 | 语音 SLO | `npx tsx scripts/voice-slo-smoke.ts` | **PASS** · p50=510 / p95=890 · bargeIn=1.0 · okP95/okBarge |
| 7 | 备份 smoke | `node scripts/backup-export-smoke.mjs` | **PASS (dry)** |
| 8 | Compose | `PRODUCT_API_TOKEN=… docker compose config -q` | **PASS** |
| 9 | CI 工件 | `.github/workflows/ci.yml` | **存在** |
| 10 | 部署清单 | `docs/DEPLOYMENT-CHECKLIST.md` | **存在（定稿）** |
| 11 | Playwright 默认 e2e | `npm run test:e2e` | **PASS 35/35**（V1 · 隔离端口） |
| 12 | V2 真 key compose | checklist §7 | **PASS** · build+冒烟+卷持久 |
| 13 | V3 live export | checklist §8 | **PASS** · completeness=complete |
| — | Track V | V1–V3 | **验证轨 Full GO** |

### 1.1 测试边界（诚实）

| 未跑 / dry | 说明 |
| --- | --- |
| Playwright `npm run test:e2e` | 需 dev 双进程 + 浏览器；上线 Full GO 建议补跑 |
| `test:e2e:real` / 真实 LLM 长跑 | 6 skip 为 provider smoke；需 key |
| Live export smoke | 需运行中 API + `PRODUCT_API_BASE_URL` |
| Docker `up --build` 全链路 | 需生产 env；compose **schema** 已校验 |

### 1.2 健康结论

**系统健康：绿；验证轨 Full GO（V1–V3，2026-07-30）**

- 类型、全量单元/API 集成、生产 build、compose 配置、语音 SLO、容量代理 smoke 均通过。  
- 部署验证轨 **Full GO**（§6 默认 e2e、§7 compose、§8 live export completeness）。可选加深：import 回灌、E2E_REAL 语音、产品签字 §10–§11。

---

## 2. 现行真源文档（操作入口）

按优先级阅读；**上线只认下列现行文档**，勿以历史审查报告覆盖。

| 优先级 | 路径 | 角色 |
| ---: | --- | --- |
| 1 | [`README.md`](../README.md) | 运行、部署摘要、Hybrid RAG、配置说明 |
| 2 | [`docs/DEPLOYMENT-CHECKLIST.md`](./DEPLOYMENT-CHECKLIST.md) | **上线勾选清单（定稿真源）** |
| 2b | [`docs/MAINTENANCE-ROADMAP.md`](./MAINTENANCE-ROADMAP.md) | **长期维护路线（定稿）** |
| 2c | [`docs/superpowers/2026-07-30-wave-d-analysis.md`](./superpowers/2026-07-30-wave-d-analysis.md) | Wave D1–D6 完整分析 |
| 2d | [`docs/COST-ENVELOPE.md`](./COST-ENVELOPE.md) | **D3.a 成本/调用信封（定稿）** |
| 2e | [`docs/runbooks/ALERTS.md`](./runbooks/ALERTS.md) | **D6.a 告警协议（定稿）** |
| 3 | [`docs/superpowers/CURRENT-开放清单.md`](./superpowers/CURRENT-开放清单.md) | 开放/已闭项与 Wave 进度 |
| 3b | [`docs/superpowers/2026-08-01-podcast-multisource-llm-deploy-verification.md`](./superpowers/2026-08-01-podcast-multisource-llm-deploy-verification.md) | 2026-08-01 播客多源 LLM 生产验证 |
| 3c | [`docs/superpowers/2026-08-01-interview-ux-optimization-report.md`](./superpowers/2026-08-01-interview-ux-optimization-report.md) | 2026-08-01 实时专访 UX 最终报告 |
| 3d | [`docs/superpowers/2026-08-01-themes-track-optimization-report.md`](./superpowers/2026-08-01-themes-track-optimization-report.md) | 2026-08-01 主题线/Track 端到端优化 |
| 3e | [`docs/superpowers/2026-08-01-notes-reading-room-optimization-report.md`](./superpowers/2026-08-01-notes-reading-room-optimization-report.md) | 2026-08-01 双轨笔记阅读室 |
| 3f | [`docs/superpowers/2026-08-01-notes-workflow-smoke.md`](./superpowers/2026-08-01-notes-workflow-smoke.md) | 2026-08-01 双轨笔记生产工作流冒烟（PASS） |
| 4 | [`docs/superpowers/2026-07-30-integration-and-deployment-state.md`](./superpowers/2026-07-30-integration-and-deployment-state.md) | 集成矩阵、架构、容量信封 |
| 5 | [`docs/runbooks/README.md`](./runbooks/README.md) | 故障手册（双开锁 / export / 5xx / persist / 429） |
| 6 | [`docs/superpowers/eval/interview-rubric.md`](./superpowers/eval/interview-rubric.md) | 追问质量抽检 rubric |
| 7 | [`.env.example`](../.env.example) / [`.env.production.example`](../.env.production.example) | 环境变量模板（勿提交真实密钥） |
| 8 | [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) | CI 门禁定义 |

### 2.1 代码锚点（非 md，但属“系统说明书”）

| 区域 | 路径 |
| --- | --- |
| API 入口 | `apps/api/src/server.ts` |
| 混合召回 | `packages/db/src/surreal/surreal-product-state-repository.ts` |
| 策略引擎 | `src/domain/strategy.ts` |
| 召回/拒召 | `src/domain/retrieval.ts` · `src/domain/knowledge.ts` |
| SSRF / 限流 | `apps/api/src/safe-url.ts` · `apps/api/src/rate-limit.ts` |

---

## 3. 文档树归档分类

### 3.1 `docs/` 根

| 文件 / 目录 | 分类 | 说明 |
| --- | --- | --- |
| `DEPLOYMENT-CHECKLIST.md` | **现行** | 部署清单 |
| `ARCHIVE.md` | **现行** | 本文：归档索引 + 健康检查 |
| `runbooks/` | **现行** | 运维 |
| `superpowers/CURRENT-*` · `2026-07-30-integration-*` · `eval/` | **现行** | 状态与评测 |
| `ontology/` | **参考** | 本体论设计；部分结论已过时（见 CURRENT 注） |
| `active-guidance-*.md` · `bidirectional-*.md` · `interaction-timing-*.md` · `realtime-improvement-plan.md` | **历史** | 早期交互/引导研究，过程材料 |
| `superpowers/plans/`（~52） | **历史** | 阶段实施计划归档 |
| `superpowers/specs/`（~34） | **历史/规格** | 设计规格；实现以代码为准 |
| `superpowers/2026-06-*` · `2026-07-0*` · `2026-07-1*` · `2026-07-2*` 审查/修复报告 | **历史** | 审查与修复快照，**不作为上线真源** |
| `superpowers/zhuanfang-ARCHIVED.md` | **历史** | 既有归档标记 |

### 3.2 阅读规则

1. **要跑起来 / 要上线** → README + `DEPLOYMENT-CHECKLIST.md` + runbooks。  
2. **要知道还开着什么** → `CURRENT-开放清单.md`。  
3. **要查某次审查为什么改** → `superpowers/` 带日期的报告（历史）。  
4. **要理解本体意图** → `docs/ontology/`，并对照 CURRENT 中的“过时”声明与代码。  
5. 历史文档**保留不删**，便于审计；新结论只写入现行真源。

### 3.3 仓库外过程材料

根目录可能仍有设计草案 `.md`（若存在）→ 一律视为**历史**，以 `docs/` 现行真源为准。

---

## 4. 里程碑提交（归档时间线）

| Commit | 主题 |
| --- | --- |
| `96a4e198` … `4de24fad` | 语音后置、旅程诚实、无白名单 WebRTC、OSS |
| `fe75af6b` … `c9e81b79` | 导入 warning、TTFA、BM25 hybrid 稳定 |
| `dafbba1f` | Wave 0–C：安全、CI、第二大脑策略、rubric |
| `92d09059` | 集成验证与部署系统态 |
| `14304554` | 部署清单定稿 |
| PR [#2](https://github.com/liuwenpinghaher-commits/zhuanfang/pull/2) | 审阅切片已 MERGED；临时 baseline 分支已删 |
| `31294d37` … `6b295e0f` | 2026-08-01：播客多源 LLM、资产 P1、今日访谈台闭环 |

---

## 5. Wave / 能力归档摘要

| 簇 | 状态 |
| --- | --- |
| Stage-1/2/3 | closed（见 CURRENT） |
| 旅程后置（语音/WebRTC/OSS/BM25/TTFA） | closed |
| Wave 0–C | closed |
| Wave D（播客/成本/a11y/可移植/OTEL 增强） | **已分析 · 按需**；**D3.a + D6.a closed**；播客多源 LLM / 资产 P1 / 访谈台闭环见 2026-08-01 |
| 维护路线图 | **定稿**（`docs/MAINTENANCE-ROADMAP.md`） |
| 非目标 | 多租户 · CRDT · 完整 AWS SDK |

---

## 6. 归档声明

- 本归档**不移动、不删除**历史 md，避免破坏既有链接与 git 历史。  
- 分类标签（现行 / 参考 / 历史）即归档完成态。  
- 后续变更应：更新现行真源 → 在 CURRENT 记一笔 → 重大节点可新增 `docs/superpowers/YYYY-MM-DD-*.md` 快照。  

**健康检查执行人：** Oz agent  
**归档状态：** 完成（含 2026-08-01 追加）  
**系统健康：** 绿 · 验证轨 Full GO + 2026-08-01 生产回归绿  

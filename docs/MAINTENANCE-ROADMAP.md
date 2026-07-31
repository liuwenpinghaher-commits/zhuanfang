# 最终维护路线图（定稿）

> **日期：** 2026-07-30  
> **代码基线：** `main` @ `96a82cad`+  
> **系统健康：** 绿 · **部署：** Conditional GO  
> **配套分析：** [`docs/superpowers/2026-07-30-wave-d-analysis.md`](./superpowers/2026-07-30-wave-d-analysis.md)  
> **上线清单：** [`docs/DEPLOYMENT-CHECKLIST.md`](./DEPLOYMENT-CHECKLIST.md)  
> **归档入口：** [`docs/ARCHIVE.md`](./ARCHIVE.md)

本路线图回答：**主路径已收口后，如何长期维护、按需增强、不回退。**

---

## 1. 维护原则

1. **正确性优先于增强** — Wave 0–C / 语音 / 混合召回 / fail-loud 回归红线不可破。  
2. **薄切片** — 一次只开一个 D 切片或一个验证项；禁止「再扫全系统」。  
3. **门禁不降** — 每次改动：`typecheck` + `REAL_PROVIDER_SMOKE=off npm test -- --run`；涉及 UI 再考虑 Playwright。  
4. **文档双写** — 行为变更 → 改现行真源（README / CURRENT / CHECKLIST）→ 必要时 ARCHIVE 记一笔。  
5. **非目标冻结** — 多租户、CRDT、完整 AWS SDK：默认拒绝，除非产品书面改目标。  
6. **Conditional → Full GO** 优先于 D 功能堆叠。

---

## 2. 维护节奏

| 节奏 | 动作 |
| --- | --- |
| **每次 PR** | typecheck + unit；CURRENT 若闭环某 ID 则勾选 |
| **每周（有活跃开发时）** | 全量 unit；扫 `persist.degraded` / 429 / hybrid_empty 日志样本 |
| **每次准备部署** | 走完 `DEPLOYMENT-CHECKLIST.md` §1–§5 |
| **每次宣称 Full GO** | 再加清单 §6–§8 |
| **季度（或供应商大变）** | 重读 D5 换维/断供；依赖大版本与安全通告 |
| **按需** | 只开下表「队列」中的下一切片 |

---

## 3. 回归红线（禁止无测回退）

| 红线 | 最小守护 |
| --- | --- |
| Fail-loud（无假 AI 追问/假转写） | 既有 API 测 + 禁止恢复静默模板兜底 |
| Production 无 token 拒启 | `assertProductionAuthConfigured` 测 |
| SSRF 默认禁私网 | `safe-url.test.ts` |
| Chat/RAG 拒召与 minRecallScore | retrieval / chat 相关测 |
| BM25 无向量块可达 | surreal-recall + P4 e2e |
| 决策/债策略可测 | `strategy.test.ts` |
| CI 绿 | `.github/workflows/ci.yml` |

---

## 4. 工作队列（有序）

### Track V — 验证（最高优先级 · 非功能）

| 序号 | 项 | 完成定义 | 估计 |
| --- | --- | --- | --- |
| V1 | Playwright 默认 e2e | **closed 2026-07-30** · 35/35 绿；e2e 端口 13210/13220/13230 | done |
| V2 | 真 key compose 演练 | **closed 2026-07-30** · checklist §7；报告 `2026-07-30-v2-compose-exercise.md` | done |
| V3 | Live export smoke | **closed 2026-07-30** · export complete；`2026-07-30-v3-live-export-smoke.md` | done |
| V4 | （可选）E2E_REAL 语音抽样 | 有 key 环境 | 1d |

**V1–V3 已完成（2026-07-30）：验证轨 Full GO。** 产品/运维书面签字仍走 `DEPLOYMENT-CHECKLIST.md` §10–§11。

### Track M — 维护杂项（持续）

| 序号 | 项 | 完成定义 |
| --- | --- | --- |
| M1 | 依赖与 Node 引擎 | 安全补丁；保持 `engines.node` |
| M2 | Surreal/迁移 | 只增 surql；双开锁 runbook |
| M3 | 密钥轮换演练 | token + provider key 轮换步骤每年一次 |
| M4 | 备份抽样 | 月度 export completeness 抽检 |
| M5 | 文档漂移 | README/CURRENT/ARCHIVE 与代码季度对齐 |

### Track D — Wave D 增强（按需 · 见波次分析）

推荐默认顺序（可因产品改序）：

```text
V1–V3（Full GO）· closed
  → D3.a 成本信封文档 · closed → docs/COST-ENVELOPE.md
  → D6.a 告警草案 · closed → docs/runbooks/ALERTS.md
  → UX-UI 亮色主题与壳层交互 · closed → docs/superpowers/2026-07-30-ui-light-theme.md
  → UX-UI 全站视觉重做 · closed → docs/superpowers/2026-07-30-ui-visual-redesign.md
  → D4.a 专访键盘路径深化 / D1.a 或 D2.a（选产品痛点）· **next**
  → D5.a/b 适配层与换维 runbook（无第二厂商则停）
  → 其余 D*.b/c 仅在用户痛点或指标恶化时开启
```

| 切片 | 触发条件 | 不做的信号 |
| --- | --- | --- |
| D1.* 播客 | 用户真用播客且抱怨过期/长文 | 无人用播客 |
| D2.* 搜索 | 多 key 并行或重复源投诉 | 单 provider 够用 |
| D3.* 成本 | 账单惊吓或要共享给多人 | 个人低频 |
| D4.* a11y | 无障碍需求或移动用户 | 纯桌面个人 |
| D5.* 可移植 | 百炼限流/合规/涨价 | 供应商稳定 |
| D6.* 观测 | 需要 on-call 或多实例 | 仍单机自用 |

---

## 5. 季度健康检查模板

复制执行：

```bash
git status -sb
npm ci
npm run typecheck
env -u DASHSCOPE_API_KEY -u BAILIAN_API_KEY REAL_PROVIDER_SMOKE=off npm test -- --run
npm run build
node scripts/capacity-smoke.mjs
npx tsx scripts/voice-slo-smoke.ts
PRODUCT_API_TOKEN=check docker compose config -q
```

记录到新文件：`docs/superpowers/YYYY-MM-DD-quarterly-health.md`（可选）或更新 `ARCHIVE.md` 一小节。

---

## 6. 事件驱动维护

| 事件 | 动作 |
| --- | --- |
| 生产 5xx 飙升 | runbook provider 节；查预算/限流/配额 |
| `surreal_connect_failed` | runbook 双开锁 |
| `persist.degraded` | 磁盘/权限；export 抢救 |
| BM25/召回投诉 | 先复现 P4 路径；勿先改 RRF 常量 |
| 换 embedding 模型 | **必须** D5.b；禁止只改 env |
| 安全通告（依赖） | 打补丁 + 全量测 |
| 产品要「多用户」 | **新立项**（非本路线图范围） |

---

## 7. 明确 Won't（维护期默认拒绝）

- 多租户 / 复杂 RBAC  
- Surreal 原生 CRDT 多设备同步  
- 完整 AWS SDK 重写预签名  
- 无验收的「大重构」或再开全系统 16 维扫尾式改造  
- 用降级模板重新掩盖 LLM/ASR 失败  

---

## 8. 成功维护画像

- 主路径回归长期绿；CI 必跑。  
- 部署清单可重复执行；Full GO 可达到并保持。  
- Wave D 仅在有触发条件时前进，CURRENT 状态真实。  
- 文档真源不散落；历史报告只读。  
- 单机 MVP 预期不被「SaaS 化」承诺掏空。  

---

## 9. 相关文档索引

| 文档 | 用途 |
| --- | --- |
| `docs/superpowers/2026-07-30-wave-d-analysis.md` | D1–D6 现状/缺口/切片 |
| `docs/COST-ENVELOPE.md` | **D3.a 成本/调用信封（定稿）** |
| `docs/runbooks/ALERTS.md` | **D6.a 告警协议（定稿）** |
| `docs/DEPLOYMENT-CHECKLIST.md` | 上线勾选 |
| `docs/ARCHIVE.md` | 健康检查 + 文档分类 |
| `docs/runbooks/README.md` | 故障 |
| `docs/superpowers/CURRENT-开放清单.md` | 开放 ID 状态 |
| `README.md` | 用户向运行与架构 |

**维护路线图状态：定稿**  
**下一步默认动作：** D4.a 键盘路径深化，或有痛点时 D1.a/D2.a；否则 Track M。D3.a/D6.a/UX-UI 亮色主题已闭。

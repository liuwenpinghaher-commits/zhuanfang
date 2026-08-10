# ADR · 语音默认路径：Cascade 保持默认；bailian / Audio3 / LiveKit 仅 opt-in

> **日期：** 2026-08-10  
> **状态：** Accepted  
> **范围：** 默认 `realtimeMode` 与实验路径策略；**不**交付生产半级联或 Audio3 翻盘  
> **设计锚点：** CFC+（Craft-First Cascade Plus · Rev C）— Key Decisions **KD1**、**KD16**  
> **相关 PR：** PR-10（本文）；PR-6s（half-cascade spike）；PR-8s（Audio3 spike）；PR-8（**blocked**）

---

## 1. 背景

专访产品是**纵向私人采访 OS**，不是通用语音聊天助手。工艺铁律（开场纪律、记忆召回、质量护栏、硬边界、craft golden）集中落在 **文本 turn 生成** 与 **统一 instruction 构建** 上——这是产品核心 IP（L3）。

默认语音路径已是 **cascade**（`realtimeMode: "cascade"`，见 `src/domain/seed.ts` 等）：

```text
浏览器 ASR → 产品 HTTP/SSE LLM（/turns · /turns/stream）→ 流式 Cosy TTS
```

辅路径：

| 模式 | 配置值 | 结构 | 本轮角色 |
|------|--------|------|----------|
| **Cascade** | `"cascade"` | 浏览器编排 ASR→LLM→TTS | **默认质量承诺 + 主回归** |
| **Bailian E2E（Omni）** | `"bailian"` | Omni Realtime 全双工 | **实验 / 降级**；须显式选择 |
| **LiveKit** | `"livekit"` | SFU + Python agent | **实验 / best-effort**；不进默认 SLA |
| **Audio 3.0** | profile/flag（未生产接线） | 辅路径 Realtime 族 | **未冻结**；生产 PR-8 **blocked** |

CFC+ 阶段曾评估「默认翻到 E2E Omni / Audio 3.0」与「半级联（brain 文本 → omni 口播）」等路径。本 ADR **书面冻结**本轮结论，防止后续静默改默认或把 spike 绿误读成生产 GO。

---

## 2. 决策（Decision）

### D1 — Cascade 保持默认（CFC+ · KD1）

1. **`realtimeMode` 默认值保持 `"cascade"`**。  
2. 未设置 / 非法 / 回退路径的代码与配置默认值 **必须** 解析为 cascade（与 `seed` / `?? "cascade"` 现状一致）。  
3. **禁止**在无书面门禁与显式发布说明的情况下，将默认改为 `"bailian"` 或 `"livekit"`。  
4. 默认路径的质量承诺、主回归、voice-slo / e2e 主族、成本信封推荐并发，均以 **cascade** 为准。

### D2 — bailian / Audio3 / LiveKit 仅 opt-in 实验

| 路径 | Opt-in 方式 | 本轮生产状态 |
|------|-------------|--------------|
| Bailian Omni E2E | 用户/运维显式设 `realtimeMode: "bailian"`（或等价 UI/配置） | 可连可实验；**非**默认；**不**宣称「已实现高质量语音默认」 |
| LiveKit | 显式 `"livekit"` + agent 栈 | best-effort；**不**进默认 SLA / P1 主路径 |
| Audio 3.0 | 未来 `VOICE_BAILIAN_AUDIO3` / profile `audio3-flash` 等 **flag 默认关** | **OQ1 暂不冻结** → **PR-8 不合并**；profile 占位可保留（PR-7） |
| 半级联（omni 口播 brain 文本） | 未来 `VOICE_OMNI_BRAIN_TEXT` 等 **flag 默认 false** | **本轮不排生产**（见 D4） |

实验桶形态（OQ5）：**显式单用户 / 显式配置 opt-in**，非静默百分比分流。

### D3 — 禁止静默 E2E 翻盘

下列行为 **一律否决**（本轮及后续未重新开 ADR 前）：

1. 静默修改默认 `realtimeMode`（含 seed、env 默认、部署 compose 默认、前端 fallback）。  
2. 因 spike 脚本绿、厂商 blog、或「听感更好」的主观印象，**直接**把生产默认改为 bailian/Audio3。  
3. 把 Omni/Audio3 实验路径的改进，写成「系统级 / 默认用户五星听感」对外话术（默认用户收益叙事仍为 L2–L4 + 可选 cascade L1）。  
4. 在 OQ1 未冻结前合并 **PR-8**（Audio3 生产 profile/flag 接线）。  
5. 将 LiveKit 标为与 cascade **同等**生产质量承诺。

**允许的变更形态：** 显式 flag / 显式配置 / 显式 UI 选择 + 发布说明 +（若改默认）新的 ADR 与对照实验证据。

### D4 — 本轮不落半级联生产（PR-6s = SKIPPED）

| 项 | 状态 |
|----|------|
| PR-6s spike（`spike-half-cascade`） | 本工作区 / CI 无 live key 时结论为 **`SKIPPED`**（exit 0，无协议证据） |
| 含义 | **无 go / partial-go 证据** → 不得进入 PR-6i 实现 |
| PR-6i（半级联生产接线） | **本轮不排期** |
| 降级（KD11） | 辅路径 L3 继续以 **instruction 同源** 为主；**不**占 Phase 5「omni L3 与 cascade 持平」假设 |
| 若日后 live 跑出 GO/PARTIAL | 另开设计与实现 PR；仍 **flag 默认 false**；仍不自动改 cascade 默认 |

> **纪律：** `SKIPPED` ≠ `GO`。无 key 的脚手架合并 **不**构成半级联生产授权。

### D5 — OQ1 阻塞 PR-8（Audio3 生产）

| 项 | 状态 |
|----|------|
| OQ1（Audio3 正式 model id / smart_turn / 音色白名单） | **已决：暂不冻结**（用户决议 2026-08-10） |
| PR-8s | spike 可后续；绿也不自动解禁 PR-8 |
| PR-8 | **blocked** until OQ1 freeze；exec plan 标 skipped 的生产实现本轮不合并 |
| PR-7 profile 层 | 允许保留 `audio3-flash` 占位（未实现则回落 `omni-default`） |

---

## 3. 与 Key Decisions 的映射

| ID | 摘要 | 本 ADR 落实 |
|----|------|-------------|
| **KD1** | CFC+：默认 cascade，拒绝无门禁 E2E 翻盘 | D1 + D3 |
| **KD6** | Audio 3.0 仅辅路径 + profile/flag/白名单 | D2 Audio3 行 |
| **KD11** | 半级联未验证前不排实现、不占 L3 持平 | D4 |
| **KD16** | OQ1 暂不冻结 → 不合并 PR-8；OQ2 做 PR-6s，失败/无证据则不排 PR-6i；不改为默认 E2E、不优先 Audio3 生产 | D2–D5 全文 |
| Must-set ADR §5 | 默认质量承诺栈 = Cascade；Omni/LiveKit = 实验或降级 | 对齐，本文件为**默认模式专项冻结** |

---

## 4. 非目标（Explicit non-goals · 本轮）

- 不交付半级联生产路径（PR-6i）。  
- 不交付 Audio3 生产 flag 接线（PR-8）。  
- 不将 bailian/livekit 升为默认 SLA。  
- 不做百分比静默实验分流。  
- 不宣称「Omni/Audio3 已达默认 cascade 工艺持平」。  
- 不伪造 D4 真人价值或 Full product GO。

---

## 5. 何时才可重议「改默认」（Phase 5 门禁 · 摘要）

仅当 **全部** 满足时，才可起草**新** ADR 讨论改默认（仍建议先小流量 **显式 opt-in**，而非一步全量）：

1. 统一 InterviewerBrain / 工艺门禁已落地且默认路径不回退；  
2. 半级联 **live GO**，或证明 instruction-only 辅路径 L3 已持平（有 rubric 样本，非 SKIPPED）；  
3. 辅路径 L1（含 Audio3，若启用）对照显著优于 cascade L1，且 **OQ1 已冻结**；  
4. 对照实验协议完成（同人同卡、样本量、rubric 记入 `docs/superpowers/eval/samples/`）；  
5. 产品书面批准 + 发布说明 + 可一键回退 cascade。

否则：**保持 cascade 默认**。

---

## 6. 工程落点（验收与防回退）

| 检查项 | 期望 |
|--------|------|
| `src/domain/seed.ts` `realtimeMode` | `"cascade"` |
| 前端/配置 fallback | `?? "cascade"` 或等价 |
| Feature flags（若引入） | `VOICE_OMNI_BRAIN_TEXT` / `VOICE_BAILIAN_AUDIO3` 等 **默认 false/关** |
| `BAILIAN_REALTIME_PROFILE=audio3-flash` | 未冻结前回落 omni-default（PR-7 行为） |
| 部署默认 | demo/生产 compose 与文档不把 bailian 写成默认用户路径 |
| 文档话术 | 「高质量语音默认」= cascade；bailian/Audio3/livekit = 实验/opt-in |
| Spike 结论 | SKIPPED/NO_GO → **禁止**改生产默认与排期半级联实现 |

本 PR **仅文档**；不改运行时默认值（默认值已符合本 ADR，由本文件锁定）。

---

## 7. 后果（Consequences）

**正向**

- 默认用户持续享受可控的 L3 工艺主路径与主回归。  
- 实验路径可并行演进，但不绑架默认 SLA。  
- OQ1 / PR-6s 证据纪律清晰，避免「脚手架已合 = 生产可翻」。

**代价**

- Omni/Audio3 听感红利不自动落到默认用户（须 opt-in 或未来过门禁）。  
- 半级联本轮不做，辅路径 L3 短期不承诺与 cascade 持平。  
- 运维/产品须用显式配置做实验，不能靠改一行默认「先翻了再说」。

---

## 8. 决策记录

**Accept（2026-08-10）**

1. **Cascade 保持默认质量承诺栈**（KD1）。  
2. **bailian / Audio3 / livekit 仅 opt-in 实验**；Audio3 生产受 **OQ1** 阻塞（KD16）。  
3. **禁止静默 E2E 翻盘**。  
4. **PR-6s = SKIPPED（无 live 证据）→ 本轮无 half-cascade 生产**（KD11）；PR-6i 不排期。  
5. 重议改默认必须新 ADR + Phase 5 门禁证据，不得以 PR 附带静默完成。

---

## 9. 参考

- 设计全文：CFC+ Rev C（`design-voice-system-cfc-plus` / `grok-design-doc-f77a7584`）  
- Must-set ADR：`docs/superpowers/specs/2026-08-04-realization-must-set-adr.md` §5 默认语音栈  
- 开放清单：`docs/superpowers/CURRENT-开放清单.md`  
- Spike：`scripts/spike-half-cascade.mjs`、`scripts/spike-audio3-session.mjs`（若已合入）；结论模板 `docs/superpowers/specs/spike-*-result.md`  
- 成本信封：`docs/COST-ENVELOPE.md`（主路径优先 cascade）  

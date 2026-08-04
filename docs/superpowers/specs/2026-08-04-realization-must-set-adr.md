# ADR · 真正实现 Must-set（正确性 / 追问评测 / 纵向边 / 诚实门禁）

> **日期：** 2026-08-04  
> **状态：** Accepted  
> **范围：** 代码可验收的 Must-set；**不**宣称 4 周真人 D4 主观通过或「完美产品 / Full product GO」

---

## 1. 背景

产品愿景是「私人认知专访编辑」：问得更深、记得更准、下次会回访、长期看见变化。  
工程上已有 MVP 闭环与大量回归，但缺统一 **可证伪的完成定义** 与 **防回退的 golden 门禁**。本 ADR 冻结 Must-set，作为后续 Phase 与对外表述的边界。

---

## 2. D1–D4 完成定义（Definition of Done）

| ID | 名称 | 通过条件（可证伪） | 本 Must-set |
|----|------|-------------------|-------------|
| **D1** | 闭环正确 | 专访→笔记→记忆 HITL→回访权威数据不丢；fail-loud；导出完整 | 部分：doNotSave 诚实、未确认 partial 不入权威稿（测） |
| **D2** | 追问质量 | Rubric 剧本确定性策略断言绿；长轮不无界复读（策略层） | **本批交付**：5 场景 craft golden 驱动 shipped `decideInterviewStrategy` / RAG refuse |
| **D3** | 纵向认知 | `contradicts` / `evolves_into`（或 supersede demote）**生产写入 + 策略/召回消费** | **本批交付**：域层 apply + guide/strategy/recall 消费测 |
| **D4** | 真人价值 | 用户本人 ≥4 周真实主题 + 主观「愿继续用」 | **明确推迟**：协议见使用方案；本 ADR **不**伪造 D4 通过 |

**对外表述纪律：** 仅当对应门禁有测试/证据时，才可说该条「已实现」。禁止把 D2 golden 绿说成「专业编辑级文采」；禁止把 D1 部分测说成 Full GO。

---

## 3. Must-set（本批必达）

1. **Craft eval factory** — ≥5 剧本（concrete-moment、decision_review 单次、debt_followup 不重复、contradiction_review 中后段至多一次、RAG/grounding refuse）调用 **真实** domain 路径，无 live LLM key。  
2. **Confirmed-memory + conflict discipline** — 仅 `status=confirmed` 进跨会话召回/packing；与笔记修正/显式纠正冲突的候选可标 conflict，**不能静默 approve 成 confirmed**。  
3. **Longitudinal produce + consume** — `applyCognitiveRelations` / `resolveMemoryConflict` 等生产写路径写入软链；guide checklist / `contradiction_review` / 召回排除 demoted 消费之。  
4. **Session authority / honesty** — 未确认 voice partial 不 commit 权威 turn；`doNotSave` 结束 **不**声称「档案已生成」。  
5. **文档对齐** — 本 ADR + `CURRENT-开放清单.md` 勾选；无「完美 / 真人 D4 已过」空话。

---

## 4. 非目标（默认拒绝）

- 多租户、多设备 CRDT、完整 AWS SDK  
- Omni + LiveKit + Cascade **同等**生产质量承诺（**默认质量承诺栈：Cascade**；其它为实验/降级）  
- Wave D 播客长 TTS、多搜索融合、第二厂商、全站 a11y、OTEL 看板（除非挡 Must）  
- 无 HITL 的「自动完美记忆」  
- 用 LLM-as-judge 作为唯一质量门（仅可辅助）  
- 全系统重写或放弃 Surreal 持久路径  

---

## 5. 默认语音栈意图

| 栈 | 角色 |
|----|------|
| **Cascade**（ASR → LLM → 流式 TTS） | **默认质量承诺**与主回归对象 |
| 文本专访 | 与 cascade 并列的保底主路径 |
| Omni / LiveKit | 实验或降级；不进入「已实现高质量语音」默认表述 |

---

## 6. 映射到代码 / 清单

| Must | 主要代码 | 测试 / 证据 |
|------|----------|-------------|
| Craft golden | `src/domain/strategy.ts`, `retrieval.ts`, `craft-golden.ts` | `craft-golden.test.ts` |
| Memory discipline | `memory.ts`, `memoryReview.ts`, `finalize.ts`, `context-pack.ts`, `routes/memory-candidates.ts`, `productApi.client` | domain + route 409 + **client 采纳 body.state**（`productApi.test` 409-adopt） |
| Longitudinal | `reasoning.ts`, `memory-consolidation.ts`, `context-pack` hints | longitudinal + strategy 消费测 |
| Authority / honesty | `finalize.ts`, `turnAssembler.ts`, `session-end-presentation.ts`, UI end hook | authority 测 + 既有 pipeline 测 |
| Docs | 本文件 + `CURRENT-开放清单.md` | 人工读证 |

---

## 7. 后续（非本批）

- Phase 3：4 周真人协议与 D4 签字  
- Track R 剩余：并发写锁、三栈收敛配置默认、导出边抽检运维  
- 主观 rubric 样本入库（脱敏）  

---

## 8. 决策

**Accept：** 以 Must-set + 自动化门禁作为「真正实现」工程上的当前完成合同；人类价值 D4 单独目标，不得与本批混称完成。

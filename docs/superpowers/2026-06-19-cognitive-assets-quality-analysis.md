# 认知资产重构(R1-R4)质量分析报告

分支 `refactor/v3-system-optimization`。本报告分析"认知资产区第一性重构"(7→3)的实现质量,基于复杂业务端到端验证 + 2 份独立对抗审查,并记录整改。

## 1. 做了什么(7 个平级 → 3 个功能)

| 阶段 | 内容 | 关键交付 |
|---|---|---|
| R1 清账 | 删死代码/死字段 + 补缺 + 修断路 | 删 ReadingAsset(从无生成)、theme.kind/pinned/lastActiveAt、播客 corpus-insight 死路径;补决策"确认"UI;**修播客"合成语音"名不副实**(原只标记 ready,现真跑 TTS) |
| R2 导航收 3 | 认知资产区收敛 + 笔记资产打通 | 我的资产(档案/资产 tab,sourceSessionId 串联)、外部调研、记忆;语料学习移系统区;播客降级为档案动作 |
| R3 外部调研合并 | 删 intel 子系统,统一 SearchBrief | 删 7 文件(IntelTask/IntelItem/triage/scheduler/IntelView/routes);intel 断点由"统一到本就喂专访的 SearchBrief"消除;持续追踪用 brief.tracked + 刷新 |
| R4 记忆简化 | 砍过度设计 | MemoryEdge 6×5 图 → record→theme 软链;memoryCorrections 喂专访改有界;已审候选保留窗口裁剪 |

## 2. 复杂业务端到端验证(`full-business-journey.test.ts`)

造一个产品经理就"团队授权与控制感"做决策专访的完整业务剧本,后端 server.inject 级走通全链路:
外部调研(追踪/刷新)→ 专访(简报上下文/多轮)→ 结束生成笔记 → 我的资产档案(sourceSessionId 聚合)→ 决策确认 → 导入资料(→RAG chunks + 记忆候选)→ HITL 审批 → 资料问答 RAG(召回+引用)→ 主题线聚合 → 导出/隐私(确认无 intel)→ 播客合成。

**结果:全链路数据正确流转,无断点、无 5xx、无数据丢失。** 这是重构后系统作为连贯业务可用的最强证据。

## 3. 对抗审查发现 + 处置

两份独立审查("找真问题不客套")揪出**测试绿掩盖的真问题**:

| 发现 | 严重度 | 处置 |
|---|---|---|
| **tracked brief 没真正喂专访**:`resolveInterviewSearchBrief` 选 brief 只按 id 或 [0],**完全不看 tracked**;R3 测试用硬编码 searchBriefId 绕过 → 假修复 | 高 | ✅ 修:无显式 id 时优先选 tracked brief 喂专访 + **真测试**(多 brief、非首位 tracked、不传 id、断言选中 tracked) |
| **播客 synthesize 竞态**:saveState 失败时用旧脚本合成却报成功 | 高 | ✅ 修:synthesize 端点接受 caller 传入的当前 script(直接用+持久化),消除 save-then-synthesize 竞态 |
| memoryEdges 迁移静默丢弃非主题边,无告警 | 中 | ✅ 修:丢弃数 >0 时 console.warn 记日志 |
| legacy.readings 经 spread 残留 localStorage(死数据) | 低 | ✅ 修:normalize 显式 delete(与 intel 一致) |
| 候选裁剪 createdAt 缺失边界未测 | 中(测试缺口) | ✅ 补:部分缺 createdAt 的脏数据裁剪测试 |
| 删除残留(ReadingAsset/corpus-insight/intel/theme 死字段) | — | 审查确认 src/ 内零残留 |
| privacy/migration intel 计数、strategy hasGraphReference | — | 审查确认消费信号未被改坏 |

**诚实接受未改(有意取舍,已记录):**
- 升级前无 sourceSessionId 的历史资产不进"档案"tab(但在"资产"tab 仍可见)——可接受,代码有注释。
- 外部调研无 key 刷新走本地降级,与系统既有离线 fallback 一致。
- theme 死字段在历史 localStorage 残留(死数据,不崩溃)——低优先,未清。
- "生成播客"档案入口(打开工作台并预选 note)——可接受的入口语义。

## 4. 验证

- tsc 0 错;确定性 vitest **653 passed**(起点 642);Playwright **26 passed**;复杂业务 E2E 全链路绿。
- 每阶段 fresh subagent + 我独立交叉验证;对抗审查后的整改均补了真测试。

## 5. 教训

再次印证:**fake/mock + 硬编码入参的测试会掩盖语义未兑现**。R3 "tracked 喂专访"测试绿却没真实现,只有独立对抗审查(看选择逻辑本身)才暴露。已修复并补了真验证选择逻辑的测试。

## 6. 提交

R1-R4 + 业务 E2E + 整改,全部只 add 计划/审查指定文件;zhuanfang/CLAUDE.md/memory/.claude 零误吞。

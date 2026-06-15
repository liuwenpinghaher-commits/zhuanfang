# 专访 1.0 — 审计驱动改进方案（总览）

> 本套方案由四路全局审计（架构 / 状态数据流 / 业务实现度 / 风险技术债）+ 一次后端类型检查复核得出。
> 每个 Phase 一个独立、可单独交付、可单独测试的文档。**按严重度排序：安全 → 正确性 → 构建完整性 → 可信度 → 坏功能 → 卫生。**

## 审计核心结论（为什么要做这些）

| # | 结论 | 证据 |
|---|------|------|
| A | **后端从未被类型检查** | 根 `tsconfig.json` `include:["src"]`、无 `apps/api/tsconfig.json`；植入的类型错误被 `tsc -b` 漏过；真查出 ~6–9 个潜在错误 |
| B | **状态总线在在线↔离线切换处丢数据** | 客户端只发 `{content}`，服务端用自己的 session；本地 fallback 分叉；整份 god-object 无版本号 PUT 覆盖（`App.tsx:168-183`） |
| C | **新增 4 个 LLM 模块未净化外部输入** | `grep sanitize apps/api/src/intelligence/` 为空；导入文档/搜索结果原文直入 prompt，经人审后注入每轮专访 |
| D | **LLM 失败即编造"救火"日记** | `finalize.ts:73` 确定性 fallback 硬编码 demo 场景；无 LLM 可观测性，降级不可见 |
| E | **第一屏（今日台/会前卡片）硬编码 demo** | `context-pack.ts:217-285` 硬编码 `控制感/救火/标题`，从不调 LLM；seed 是唯一初始态、连 reset 都重播种 |
| F | **坏功能/假承诺** | CosyVoice TTS 端点 400 且丢脚本；IntelTask `frequency` 是死字段无调度器；播客脚本是模板拼接 |
| G | **结构债** | `packages/mastra` 2438 行死代码；`App.tsx`/`engine.ts`/`bailian.ts` 三个 God 文件；LLM 层 8 模块仅 1 个有测试 |

> 真正做对、**不要动**的：LLM/确定性双路共享 merge 逻辑（结果类型不会漂移）；密钥卫生；敏感记忆真排除出上下文。

## Phase 地图

| Phase | 主题 | 解决 | 依赖 | 文档 |
|-------|------|------|------|------|
| 1 | LLM 信任边界与诚实降级 | C, D | 无 | `…01-llm-trust-boundary.md` |
| 2 | 状态一致性 | B | 无 | `…02-state-consistency.md` |
| 3 | 后端类型安全网 | A | 无 | `…03-backend-type-safety.md` |
| 4 | 去 seed 污染 + 真今日台/卡片 | E | 建议在 1、3 之后 | `…04-deseed-real-desk.md` |
| 5 | 修复坏功能 + 兑现承诺 | F | 无 | `…05-fix-broken-features.md` |
| 6 | 结构清理 + 测试 + 成本护栏 | G | 建议最后 | `…06-hygiene-tests-cost.md` |

**Phase 1、2、3 相互独立，可并行/任意顺序。** 4 依赖 3（类型安全）更稳；5、6 独立。建议执行顺序：**1 → 2 → 3 → 4 → 5 → 6**（安全与正确性优先）。

## 全局约定（所有 Phase 通用）

- **分支**：每个 Phase 在自己的分支上做（如 `fix/phase-1-llm-trust`），不要直接提交 `main`/当前 `refactor/v3-system-optimization`。
- **测试基线**：动手前 `npx vitest run` 应为 `331 passed`。每个 Task 末尾跑相关测试。
- **后端类型检查**：Phase 3 之前，后端无 tsc 覆盖；改后端文件后用 `npx tsc --noEmit --strict --skipLibCheck --target ES2022 --module ESNext --moduleResolution Node --esModuleInterop --resolveJsonModule --jsx react-jsx --lib ES2022,DOM,DOM.Iterable apps/api/src/server.ts` 临时自查（Phase 3 会把它固化进 build）。
- **提交信息**结尾加：`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- **执行方式**：每个 Phase 文档头部标注 REQUIRED SUB-SKILL；推荐 `superpowers:subagent-driven-development`（每 Task 一个 fresh subagent + 评审）。

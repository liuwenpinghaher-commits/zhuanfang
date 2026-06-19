# 系统模块第一性重构 质量分析报告

日期:2026-06-19 · 分支 main · 设计 `specs/2026-06-19-system-module-consolidation-design.md` · 计划 `plans/2026-06-19-system-module-refactor.md`

## 一句话结论
系统模块的问题不是"功能多"而是**断点多**(后端路由↔前端API↔UI↔引擎消费,四层里常有两层断)。本轮**逐条打通断点 + 收敛冗余 + 删死代码**,并经对抗审查抓出并整改了一处 🔴 假打通。最终 typecheck 0 错 · vitest 718 绿 · Playwright 33 绿。

## 做了什么(S1–S6)

| 阶段 | 内容 | 提交 |
|---|---|---|
| S1 数据治理打通 | productApi 加 `exportState/getPrivacyReport/purgeState`;ProfileView 加「数据治理」区(导出真下载 Blob、隐私报告真渲染 inventory、清空个人数据二次确认);App 接线 | d8cbb059 |
| S2 ConfigView 收敛 | 4 tab→2(状态/参数);删 provider 双显(只留 capabilities 真实健康);patch 单一真源(删 ConfigView 重复 tab,只在语料学习);删死路由 product-config(PATCH+rollback) | 9f664c01 |
| S3 引擎打通 | playbook rules 进实时语音 instructions;ruleType 驱动策略(替代脆弱中文关键词,关键词回退兼容);corrections 喂上下文 | 1c71cbc8 |
| S4 死代码清理 | 删 memory-corrections 死路由、realtimeEnabled 死开关(全链)、activeStrategies 死透传(+2 死测试)、SystemStatus.providers 死快照 | 9d4f1c79 |
| S5 测试套件+标准 | 验收标准文档(9 功能,每条:业务场景/步骤/预期输出/质量标准/检验方式)+ system-module-journey.test.ts(3 用例)+ 扩 full-business-journey + data-governance.spec | e60dc4ee |
| S6 验证+整改 | Playwright 回归修复(2-tab 选择子,957c5ddd)+ 对抗审查 + S3 假打通整改(405aee88)+ anysearch 超时(66102b0b) | 多个 |

## 对抗审查发现与整改

**S1/S2(独立审查):干净 ✅** — 数据治理端到端真闭环;**导出无 secret 泄露**经实跑+注入双验证(根因:ProviderConfig 类型层就无 apiKey 字段,非靠字符串过滤);purge 实跑验证清个人数据留结构;死路由删净。

**S3:🔴 抓到假打通(已整改)** — S3 最初只改了 `buildRealtimeVoiceInstructions`,其**唯一真实下游是 LiveKit(非默认路)**。专访三条路:
| 路径 | 整改前 playbook/corrections | 整改后 |
|---|---|---|
| LiveKit | ✅/✅ | ✅/✅ |
| **cascade(默认)** | ❌/❌ | ✅/✅(405aee88 让 `buildCharacterSystemPrompt` 注入) |
| Bailian WS | ✅/❌ | ✅/✅(App.tsx 补传 corrections) |

整改:`buildCharacterSystemPrompt(session, corrections)` 注入 playbook + corrections;`receiveTurn` 从 `state.memoryCorrections` 取出透传;**TDD 断言打到真实下发体**(`requestBody.messages[0].content`)。ruleType 驱动策略经审查确认真做实(链路完整、无 index 错位、枚举受控)。

**S4:做实 95%** — 删除项均无隐藏消费者;唯一瑕疵 Python 工具 docstring 过期(已随 405aee88 修)。

## 运行态验证(诚实记录)
- `GET /api/state/export`:真实,`stateDigest===restoredDigest`、`providerSecretsExcluded`、含恢复信息、**无 secret**。
- `GET /api/state/privacy-report`:真实分类 inventory。
- `PUT /api/state`、`GET capabilities`:即时正常。
- **curl `POST /api/search/briefs`/`auto-run` 一度变慢/超时**:诊断为**本机测试产物**——本轮反复 curl 起了多个 dev:api 实例争用持久 SQLite(.data/product-state.db),叠加首请求懒初始化 + 本机 TLS 拦截下 provider 探测。**非代码缺陷**:代码路径全同步无挂点;Playwright 干净服务器下 `data-governance.spec`(真实 POST /api/state/purge)与 `search.spec`(真实建简报)均绿。
- **附带健壮性修复**(66102b0b):`anysearch.ts` 是唯一未用 `fetchWithTimeout` 的搜索 provider,补上超时——AnySearch API 慢/不可达时**超时降级 local-demo 而非无限挂**(对齐 external-search 既有模式 + 离线降级原则)。

## 仍存在的局限(诚实)
- **fallback `buildAssistantTurn`**(无 LLM 降级模板)不注入 playbook/corrections——它是字面回复模板而非 system prompt,无正确注入点(有意取舍)。
- **LiveKit agent-context** 的 corrections 上游传入未单独运行态核验(非默认路)。
- **SQLite 持久库无 VACUUM**:反复写后 db 文件膨胀(空闲页),state 本身不大;非本轮引入,可后续加定期 VACUUM/brief 数上限。

## 最终验证
- `npm run typecheck`:exit 0
- `npx vitest run --exclude "**/*.real.test.ts"`:**718 passed**(84 files)
- `npx playwright test`:**33 passed**(含 data-governance 真实治理旅程)
- 提交纪律:全程仅 `git add` 各阶段指定文件,zhuanfang/CLAUDE.md/memory/.claude/张小珺资料 零误吞。

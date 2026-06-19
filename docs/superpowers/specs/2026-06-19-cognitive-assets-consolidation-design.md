# 认知资产区第一性重构 设计文档

**Goal:** 把"认知资产"区从 7 个平级、半数错位/重叠/带死代码的功能,收敛为 **3 个语义清晰、都真服务核心闭环的功能**;移走 2 个错位功能;清除死代码/死字段。让系统真正"可用、好用、不繁杂"。

**Architecture:** 纯前端 IA 重组 + domain/路由 的合并与清理,零新依赖。基于客观代码普查(4 份现状报告),按第一性需求保留/合并/删除。

**Tech Stack:** TypeScript, React, Fastify, Vitest, Playwright。验证:`npm run typecheck` / `npx vitest run --exclude "**/*.real.test.ts"` / `npx playwright test`。

---

## 1. 第一性判断

产品本质:**私人专访 → 沉淀认知 → 持续回访同一个人**。核心闭环:`专访 → 笔记/资产 → 主题线 → 喂回下次专访`。判断标准:是否真服务该闭环。

客观普查结论(file:line 证据见各现状报告):
- **真核心**:双轨笔记、资产库、主题线、记忆治理、联网素材(深度喂专访)。
- **断在闭环外**:情报中心——与联网素材调同一个 provider 方法 `createSearchBrief`,但 IntelItem 从不进专访上下文,只能转知识债;调度弱。
- **错位**:语料学习——调校引擎(学别人提问),非用户产出,却陈列在"我的成果"区。
- **边缘 + 带 bug**:播客——封闭输出无导出/分享;"合成语音"按钮调的端点不存在;corpus-insight 来源是死代码路径。
- **死代码/死字段**:`ReadingAsset`(有类型+4 路由,从无生成、前端不渲染);`LongTermTheme.kind/pinned/lastActiveAt`(零写零读);`memoryEdges`(6×5 图结构,关键词瞎连,LLM 不消费);决策"确认"路由有 UI 无;`intel.relatedDebtIds/relatedThemeIds`(从不消费)。

## 2. 目标形态:7 → 3

```
区2 · 认知资产
├─ ① 我的资产   双轨笔记 + 资产库 合一入口,内部两 tab:
│               · 档案:按会话(一次专访 = 笔记 + 该次产出资产,sessionId 串联)
│               · 资产:按类型横切(观点/问题/决策/债,筛选/搜索/状态)
├─ ② 外部调研   联网素材 ⊕ 情报中心 合一:单次调研→简报→喂专访(强路径);
│               可选「持续追踪」一个话题;追踪产出也喂回专访上下文(修 intel 断点)
└─ ③ 记忆       记忆治理简化:保留 候选→记录 HITL 闸门;edges 砍成"关联主题"软列表;
                corrections 并入 record;已审候选保留窗口裁剪

移出区2:
  · 语料学习 → 区3 系统(引擎调校进阶设置),功能保留换位置
  · 播客     → 降级为挂在专访/笔记上的「生成播客/导出」动作,撤出顶层导航
```

区3 系统 = 系统配置、个人档案、+ 语料学习(引擎调校)。

## 3. 分阶段实施(每阶段独立可交付、可测、可回滚)

### R1 · 清账(低风险,先扫干净)
- 删 `ReadingAsset`:类型(types.ts)、`ProductState.readings`、`apps/api/src/routes/assets.ts` 的 readings status/importance 路由、`searchProductAssets` 的 readings 分支、AssetsView 任何 readings 残留。`createReadingAssetsFromSearchBrief`(search-brief.ts)若存在一并删(它产出的 readings 无处展示)。
- 删 `LongTermTheme.kind/pinned/lastActiveAt`:types + seed + 迁移(normalizeProductState 不再补这三个字段;migrateThemesToTracks 相应精简)+ 任何引用。
- 删播客 corpus-insight 死路径:`generatePodcastEpisodeFromCorpusInsight`(podcast.ts)+ 路由 normalizeSourceType 的 corpus-insight 分支 + 类型枚举里的 corpus-insight。
- 修播客"合成语音"断路:前端调 `/api/podcast/episodes/:id/synthesize` 但无此路由 → 要么注册该 synthesize 端点(复用现有 TTS 合成逻辑),要么把前端改为现有可用路径。以"真能合成"为准。
- 补决策"确认"UI:AssetsView detail 面板加"确认决策"按钮,接 `POST /api/assets/decisions/:id/confirm`。
- 删 `intel.relatedDebtIds/relatedThemeIds`(为 R3 合并铺路;若 R3 紧接则可在 R3 一并处理)。
- 验收:typecheck 0;vitest 全绿(删除的实体相关测试同步删);死类型/字段全仓 grep 归零。

### R2 · 导航收 3 + 移位 + 笔记资产打通(可见的简化)
- `src/ui.ts` 导航:区2 = 我的资产(notes+assets)、外部调研(暂时仍是 search,intel R3 合)、记忆;语料学习移入区3 系统;播客撤出顶层。
- 我的资产:新建合并视图(或在 NotesView/AssetsView 外包一层带 tab 的容器),档案 tab 按 sessionId 把 note 和该次资产聚合展示;资产 tab 复用现有 AssetsView。note↔asset 双向锚点(note 显示"本次产出 N 观点/M 问题→",asset 显示来源会话)。
- 播客降级:从导航移除;在某次专访档案/笔记上提供"生成播客"动作入口(打开播客制作)。
- 语料学习:导航归入区3,视图不动。
- 验收:typecheck 0;vitest 全绿;Playwright 导航 spec 适配 3 区新结构 + 新增"档案 tab 看到笔记+资产、播客作为动作"的 e2e。

### R3 · 外部调研合并(最深,带迁移护栏)
- 合并 search + intel 为一个"外部调研"功能,共用 provider 调用层(抽 `executeExternalResearch(topic, provider, maxSources, recencyDays)`,消除 routes/search.ts 与 intel-run.ts 的重复 `createSearchBrief` 调用)。
- 数据模型收敛:把 intel 的"持续监控"语义并入调研——一个调研话题可标记为"持续追踪"(保留 keywords/frequency/lastRunAt 的有效部分),其产出统一为简报/来源,不再有独立的扁平 IntelItem 死流。**关键修复**:追踪产出真正进入 `buildInterviewContextPack`(像 search brief 一样),不再只能转知识债。
- 迁移:`normalizeProductState` 把历史 intelTasks/intelItems 迁移为调研话题/简报(或合理归并);保留往返无损测试。
- 前端:一个"外部调研"视图,列出调研话题(可单次/可追踪)+ 简报,带入专访入口统一。
- 验收:typecheck 0;vitest 全绿(含迁移测试);追踪产出进专访上下文有测试覆盖;Playwright 调研旅程。

### R4 · 记忆简化
- `memoryEdges`:从 6 targetType×5 relation×weight 的图,砍为"记录关联哪些主题"的软列表(`relatedThemeIds` 风格);删 relation/weight/假 evidenceQuote;消费点(context-pack graphReferences)相应简化或删。
- `memoryCorrections`:并入 `MemoryRecord`(作为 record 上的修订批注 / sourceType="manual_correction" 的记录),不再 ProductState 顶层独立;context-pack 的全量直传改为随 record 走。
- 已审候选裁剪:approved/rejected 的 memoryCandidates 保留窗口(如最近 200),normalize 时裁剪。
- 迁移护栏 + 往返测试。
- 验收:typecheck 0;vitest 全绿;记忆喂专访上下文行为不退化。

## 4. 真实业务端到端验证(全部开发完成后)

造一个**复杂真实业务剧本**,端到端走通核心闭环 + 重构后的 3 功能:
1. 外部调研:就某话题做调研 → 简报;标记持续追踪。
2. 专访:一键开始 → 多轮 → 简报作为上下文被引用 → 结束生成笔记 + 资产(观点/问题/决策/债)。
3. 我的资产:档案看到该次专访的笔记 + 产出资产;资产 tab 按类型管理;确认一个决策。
4. 主题线:产出按主题聚合,进主题线工作区看 资料/历次专访/产出。
5. 记忆:专访产生记忆候选 → HITL 确认 → 进记录 → 喂下次专访。
6. 导出:导出整个状态(隐私报告/备份)。
7. (降级)播客:对某次专访生成播客。
- 用 Playwright(离线确定性)跑通主旅程 + 运行态 curl 验证后端能力;真 LLM 路径用 `.real.test.ts`(有 key 时)抽验。

## 5. 质量验证

全部开发完成后,派独立对抗审查(像上轮一样)审 R1-R4 的实现质量(数据迁移无损/幂等、合并后无死字段残留、断点真修复、无新引入的"测试绿掩盖的缺陷"),整改后再交付。

## 6. 风险与护栏

- R3/R4 改数据模型 → 迁移函数 + 往返无损 + 幂等测试(沿用阶段 0a 的五重护栏)。
- 删功能 → 先 grep 全引用确认零生产消费再删;每阶段全测试绿 + Playwright 兜底。
- 提交纪律:每阶段只 `git add` 该阶段文件,严禁 `git add -A/.`(仓库有大量无关未提交改动 zhuanfang/CLAUDE.md/memory/.claude)。
- localStorage 粘滞:验证数据类改动用清缓存/无痕;前端状态会 PUT 覆盖 API。

## 7. 非目标

- 不动专访引擎内核、追问技法、语料习得算法(只整理接线/归并/降级)。
- 不引新依赖、不上向量库。
- 不做"硬容器 notebook"(已在主设计否决)。

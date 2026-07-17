# 全量验收缺陷修复设计

> 日期：2026-07-17  
> 依据：`docs/superpowers/2026-07-16-真人业务全链路验收报告.md` 中 20 项 P0/P1/P2 缺陷  
> 范围：修复当前代码，不以修改报告、跳过测试、放宽校验或伪造 provider 可用性代替修复

## 1. 目标

把验收发现从“已记录”推进到“根因修复 + 自动化回归 + 真实运行复验”。修复后必须满足：

1. 完整导出/恢复后，热态、冷层、turn 节点、来源边和反向召回一致。
2. 健康状态、保存提示、搜索能力、会话状态和引用展示都反映服务端真值。
3. 专访引擎能围绕具体主题推进，尊重显式修正，避免机械重复和伪历史引用。
4. 资产对话只引用真实存在的 citation，区分用户原话与系统派生资产。
5. 实时语音使用正确 API 基址，低可信/回灌/未收尾转写不直接污染权威会话。
6. “本次不保存”不留长期资产，且 UI 明确说明实际发生的删除结果。
7. 多个 active 会话可见、可选择恢复；开始新会话不会静默遗留或覆盖旧会话。

## 2. 全局不变量

- **服务端确认优先**：UI 只能在对应 API 成功响应后显示“已保存/已生成/已恢复”。
- **来源闭环**：每条 evidence anchor 要么指向可召回 turn，要么导入/审计明确失败；不得静默丢边后返回绿色。
- **引用同源**：模型上下文、策略轨迹和 UI 展示必须消费同一份结构化引用结果。
- **用户原话分级**：只有 transcript/turn 可标记为用户原话；note、point、memory、theme 都是派生资产。
- **低可信语音隔离**：实时 partial transcript 仅用于显示；通过稳定性和回灌检查的 final transcript 才能提交业务回合。
- **外部能力真值**：credential present 只代表 configured；真实探测成功才代表 available/ready。
- **无静默降级**：失败可以重试、切换 provider 或继续文字输入，但必须显式标注原 provider 失败和实际执行路径。
- **兼容现有契约**：不删除已有导出字段、公开路由或现有兼容导出；新增字段采用可选/向后兼容方式。
- **不污染用户数据**：恢复、语音和浏览器回归使用隔离数据库。

## 3. 子系统设计

### 3.1 数据恢复与图真值

导入事务在恢复 cold raw materials 后，必须把其中的 turns 投影给 Surreal 权威层，再构建 `part_of` 和 `derived_from`。采用“构造完整目标快照 → 校验来源端点 → 原子替换”的顺序：

1. 解析并校验 hot state、raw materials、audios。
2. 从 hot sessions 与 raw materials 合并出唯一 turn 集；同 ID 内容冲突时导入失败，不能任意覆盖。
3. 把合并后的 turn 投影作为本次 state replace 的 provenance 输入。
4. 完成 cold/hot 写入后运行图一致性审计；任何 missing、unexpected、dangling、node missing/unexpected 都使导入 receipt 标记失败并触发补偿回滚。
5. `GraphConsistencyReport.ok` 必须同时要求 `danglingProvenanceCount === 0`。

正常降冷仍保留现有“H1：热态 turns 清空但图节点不被误删”行为；只有显式删除 session 才级联删除 turn 与来源边。

### 3.2 Provider 健康、超时与构建边界

AnySearch 状态拆分为 `configured` 与 `available`：

- capability/config 接口报告 credential 和 endpoint 是否配置；
- 显式探测调用真实轻量请求并记录最近成功/失败时间；
- 搜索请求失败时返回结构化 provider failure；若配置了 Bailian，可由用户动作或明确策略切换，但 source trace 必须记录实际 provider，不能把 fallback 结果标成 AnySearch。

LLM turn 请求在前端采用有限状态机 `idle → submitting → succeeded|failed`。任何超时、AbortError、非 2xx 都必须离开“思考中”，保留用户输入并提供“重试本轮”；重试使用同一用户内容但生成新的幂等请求标识，避免重复持久化。

E2E 夹具改为当前合法契约：`mode` 使用合法枚举、`startedAt` 使用真实 ISO 时间。测试继续要求外部非法状态返回 422，不弱化写确认。

`vendor-livekit` 通过动态 import 只在 LiveKit 模式加载；Vite manualChunks 不把 LiveKit 放入首屏共享 chunk。构建门槛是无 `>500kB` 警告且首屏不请求 LiveKit chunk。

### 3.3 档案保存与会话生命周期

档案保存改成显式命令：`ProfileView` 提交完整 profile，`App` 调用带 revision 的服务端写入；仅响应成功后更新权威 state 并显示“已保存”。保存中禁用重复提交，冲突/失败显示错误并保留表单内容。autosave 不再承担“保存档案”按钮的语义。

会话创建使用规范化 topic 生成具体标题、开场和历史说明；空 topic 才使用泛化文案。长期主题“一键开始”在按钮附近显示推荐 mode 和原因，创建请求携带该 mode，不做不可见转换。

active 会话采用显式会话列表：展示模式、主题、开始时间、用户轮数、保存边界；用户选择“继续”才恢复对应会话。开始新会话时如果已有 active，会弹出选择：继续现有会话或明确新建；不会自动替用户结束/删除旧会话。

### 3.4 专访策略与知识一致性

阶段总结不再从最近一句抽取名词片段。服务端维护结构化会话状态：

- 当前核心命题；
- 已确认事实/观点；
- 用户显式修正；
- 未解决问题；
- 最近使用的策略和问题语义指纹。

总结输入包含全量压缩轨迹，并要求主线必须由至少两个不同回合支持；只出现一次且被否决/修正的片段不能成为主线。

记忆候选生成后增加一致性门：候选若与本场显式修正或 confirmed memory 冲突，则标记为 `needs-review`/pending 并写出冲突依据，不得作为无冲突候选展示；生成器提示和确定性后处理共同约束。

跳过控制基于“当前 assistant 问题”生成语义摘要，不再截取上一条用户回答。若无法稳定抽取，使用“当前问题”而不是半句话。

反重复策略用最近问题的规范化语义指纹、策略类型和未解决问题集合做选择：高相似问题必须切换为量化验证、反例、机制、时间线或边界之一。达到重复阈值时优先回到未解决问题，不再继续“复述 + 有没有阻力”。

### 3.5 统一引用与资产对话

服务端每轮返回结构化 `references[]`，每项包含稳定 ID、类型、文本、来源实体和 evidence turn。策略轨迹保存被实际选中的 reference ID 与文本。前端只渲染该响应中的引用，不再从 card/historyReferences 另选一条近似文本。

资产对话采用两阶段协议：先确定 citations 数组和编号，再让模型只能使用允许的 `[1..N]`。响应后执行引用校验：

- 删除或拒绝越界编号；
- 编号对应的 type 必须与文案一致；
- 只有 transcript 可称“原始记录/用户原话”；
- memory、point、note、theme 使用“已确认记忆/系统观点/会后笔记/长期主题”等准确标签；
- 无 citations 时不得生成“根据你的原话”等来源断言。

### 3.6 实时语音与保存边界

WebSocket 基址由 `VITE_PRODUCT_API_BASE_URL`/HTTP API URL统一派生：`http→ws`、`https→wss`，保留同源生产模式；禁止写死 `3210`。

级联 ASR 增加 turn assembler：

1. partial 仅更新 UI；final 进入短暂稳定窗口。
2. 组合连续 final 片段，使用现有 turn completeness 判断悬挂结尾；未完整时等待下一个 final，直到最大等待上限。
3. 保存最近 assistant TTS 文本及播放区间；与 TTS 高相似、发生在播放区间、且没有独立用户语音能量证据的文本进入隔离状态，不提交 LLM。
4. 极短但有意义的回答（如“对”“不是”）不能仅按长度删除；必须结合语音能量、时序、与当前问题的语义角色判断。
5. 被隔离/不完整内容在 UI 显示“等待确认”，允许用户确认、编辑或丢弃。

“本次不保存”成为会话级持久化策略，并由结束 API 返回结构化 receipt：`sessionDeleted`、`rawMaterialDeleted`、`audioDeleted`、`assetsCreated=0`。前端据 receipt 显示“不保存会话已结束，未写入长期资产”，绝不复用“档案已生成”提示。

## 4. 失败处理

- 导入图重建失败：补偿恢复 hot/cold/graph 快照，返回失败步骤和 receipt。
- Provider 探测失败：状态为 unavailable；不修改用户 provider 配置，不伪造 ready。
- LLM 超时：本轮不写 assistant turn，UI 离开 loading，用户可重试或编辑后提交。
- 引用校验失败：服务端返回可诊断错误，不把错误编号回复保存为 chat 历史。
- ASR 低可信：进入待确认区，不触发主持人和资产写入。
- no-save 清理部分失败：返回 partialFailure，UI 不显示成功并列出未清理层。

## 5. 测试策略

每项修复执行红—绿—重构：

- 单元：图审计 `ok`、turn 合并冲突、主题卡片、总结主线、候选冲突、跳过摘要、反重复、citation 校验、WS URL、voice turn assembler。
- API 集成：完整 export/import 后 provenance recall；AnySearch 探测；turn timeout；profile 显式保存；no-save receipt；active session 列表。
- Surreal 真实测试：源库与恢复库的 edge/node/recall 完全相同。
- 前端组件：保存中/成功/失败，provider unavailable，重试本轮，mode 原因，引用渲染，低可信语音确认，不保存真实提示。
- Playwright：更新合法夹具，跑资产页面、会话恢复、跨会话引用、非默认 API 端口语音连接。
- 构建：`npm run typecheck`、`npm run build`，确认无大 chunk 警告。
- 全量：`npx vitest run --reporter=verbose`；真实环境允许时运行 `E2E_REAL=1 npx playwright test --project=chromium`。
- 最终人工：隔离数据库中执行一次文本长访谈、一次真实麦克风回合、一次完整导出恢复和一次跨会话召回。

## 6. 修复批次与依赖

1. 数据恢复与图真值（独立、最高优先级）。
2. Provider/超时/夹具/chunk（运行可靠性）。
3. 档案保存与会话生命周期（为 UI E2E 提供可靠状态）。
4. 专访策略与知识一致性（依赖稳定会话状态）。
5. 统一引用与资产对话（依赖策略引用结构）。
6. 实时语音与保存边界（依赖会话生命周期和引用状态）。
7. 全量验证、真实恢复演练和浏览器回归。

## 7. 非目标

- 不替换现有 Surreal/SQLite 双层存储架构。
- 不把 AnySearch 第三方 502 伪装成“已修复”；修复的是能力真值、探测、错误和可追踪 fallback。
- 不为了消除构建警告移除 LiveKit 能力。
- 不自动批准或覆盖用户记忆。
- 不 push；提交仅存在于获批的隔离分支。

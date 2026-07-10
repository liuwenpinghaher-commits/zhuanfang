# 专访 1.0 · SurrealDB 最优化重构方案(R 系列)

> 状态:**已批准(2026-07-10),决策已定,执行中**。落地时每个阶段再按 writing-plans 展开为可执行分步计划(沿用 S0/P0/P1a-d 的既有节奏)。
>
> **用户决策(2026-07-10)**:
> 1. 音频**入库 bytes** 为目标方案(§9-1 取"最优";R0-S2 实测仍作守门,严重不达标才退文件方案)。
> 2. 新库直接 `surrealkv+versioned://`;**历史数据全部可清空(均为 demo),不做存量数据迁移**——R2 的迁移脚本降级为"清洁重建",H1 悬空清洗等迁移风险项作废。
> 3. **sqlite 档整体删除**:PRODUCT_STORE 收敛为 `memory | surreal` 两档;dual/dual-surreal 档、dual-write-repository、dual-surreal-cutover 守卫、三个 sqlite 冷层实现随之移除(新增收官阶段 R7 承载删除;R1/R2 期间 sqlite 实现仅作为测试对照保留,运行时双跑 soak 取消,等价保障改为测试层新旧实现对照)。
> 文档依据:`/Users/miaoma/Downloads/写作 3.0/docs/external/surrealdb-docs`(SurrealDB 3.x 官方文档本地副本);现状证据:本仓库 2026-07-10 主树(`packages/db/src/surreal/*`、`apps/api/src/*`)。
> 引擎现状:嵌入式 `@surrealdb/node@3.0.3`(SurrealDB 3.0.2)+ surrealkv,单进程独占。

---

## 0. 一句话结论

**把 SurrealDB 从「整状态快照的落库后端」升格为「实体级事实库 + 事务边界 + 同步骨干」**:16 类 blob 实体真表化、三个冷层 SQLite 并库、治理操作换成真 ACID 事务、写路径从整包 diff 收窄为实体命令、审计/同步改走 CHANGEFEED——每一步都由现有 1319 条测试 + 双跑等价比对护航,分七个阶段(R0–R6)渐进,任一阶段可独立停靠。

## 1. 现状诊断:钱花在哪、险埋在哪

(证据为主树 file:line;详细盘点见调研记录)

| # | 痛点 | 证据 | 代价 |
| --- | --- | --- | --- |
| P1 | **整状态模型**:对外契约是整 ProductState 读写;每笔写 = 多次整包深拷贝 + 整包 normalize;28MB 体限倒逼滚动窗钳制 | `surreal-product-state-repository.ts:202,209`;`storage.ts:7-13`(MAX_EVENT_LOG 等注释自陈"防撞 28MB") | 写放大随数据线性恶化;审计流水被迫截断 |
| P2 | **dual-write 每写双深拷贝+双稳定序列化比对** | `dual-write-repository.ts:87-89` | 每笔写至少 2×整包 clone + 2×整包排序序列化 |
| P3 | **state_meta.rest blob 藏 16 类实体**(profile/systemConfig/审计流水/chat/corpus/playbook…)完全不可查、不可索引、不可审计 | `surreal-product-state-repository.ts:55-60` | 建模债之王;所有针对这些实体的查询/一致性审计做不到 |
| P4 | **全局 HTTP 写串行化**:mutating 请求端到端单队列,靠 watchdog(10s 点名/360s 强放/断连放行)维稳,已付出两轮死锁修复 | `server.ts:484-596` | 吞吐上限=1;稳定性靠补丁而非模型 |
| P5 | **热态与三冷层(raw/audio/knowledge SQLite)+ local-object 文件无事务边界**;F-04 只能做应用层快照补偿 journal,补偿自身可失败 | `routes/state.ts:386-481` | 恢复/清空的原子性是"尽力而为",不是保证 |
| P6 | **knowledge 索引双份真相**:knowledge_chunks 的 embedding 以 JSON 文本存、无向量索引,与 surreal HNSW 并存,靠 epoch reindex 收敛 | `sqlite-knowledge-index-repository.ts:33-35,88` | 双写双查双漂移 |
| P7 | **persist 失败自愈掩盖**:基线不动、下笔补回,把确定性拒写掩成"下一笔成功";dual-surreal 下是静默数据蒸发路径,仅 `/api/health` 可感知 | `surreal-product-state-repository.ts:62-68,178-194` | 正确性风险,注释自陈 |
| P8 | **同连接事务竞争**:原生召回读与 persist 写偶发 `failed transaction`,靠 3.2s 重试阶梯兜底;重试匹配仅 `/failed transaction/i` | `:128-135,157-161` | 脆弱的运行时约定 |
| P9 | 前端整包 PUT + 409 + 整包三方合并 outbox | `routes/state.ts:56-66`;`offline-sync.ts` | 同步粒度=全库,冲突面最大化 |

**已经做对了的**(重构必须保留):SCHEMAFULL + ASSERT 枚举钳制、8 种 ENFORCED 边 + 级联 EVENT、HNSW+BM25(ngram zh)+ 原生 `search::rrf` 混合召回、diff-upsert 单事务、turn append-only 冷层、fail-closed cutover 守卫、graph 审计端点。

## 2. 文档确证的可用能力(重构的弹药库)

(路径相对 `surrealdb-docs/pages/`;★=本方案的关键依赖)

| 能力 | 文档 | 对本项目的意义 |
| --- | --- | --- |
| ★ 多语句 ACID 事务,快照隔离+提交期写写冲突检测(需应用重试) | `learn/querying/concepts-and-guides/transactions.md`、`transactions-and-isolation.md:14-18` | 治理操作(reset/purge/import)的真原子性;实体命令写 |
| ★ CHANGEFEED(表/库级,`SHOW CHANGES ... SINCE <versionstamp>`,含 `INCLUDE ORIGINAL` 反向 diff) | `learn/querying/real-time/changefeeds.md` | 审计骨干、派生索引重建、**前端增量同步的兜底通道**(轮询游标,不依赖 live query) |
| LIVE SELECT(含 DIFF/WHERE;**Node 嵌入引擎支持性文档空白,需 R0 实测**) | `live-queries.md` | 前端实时推送(可选增强,非依赖) |
| ★ DEFINE EVENT(同事务同步;ASYNC 带 RETRY/MAXDEPTH) | `defining-events.md:12,260-288` | 级联清理(已在用)、审计与业务写同事务 |
| ★ 复合数组 record ID + range 扫描(`table:[a,b]..`,零索引分区) | `record-ids-and-addressing.md:136-177`、`real-time-best-practices.md:13-168` | 审计/事件流水、turn 按会话分区的天然形态 |
| ★ COUNT 索引(v3.0+,可带 WHERE) | `index-types-and-strategies.md:92-111` | 隐私报告/实体计数/cutover 守卫零扫描 |
| ★ 预物化聚合视图(`DEFINE TABLE ... AS SELECT ... GROUP BY`,自动增量、分组 ID 可预测) | `tables.md:108-118`、`real-time-best-practices.md:355-418` | 主题资产计数、健康指标,替代应用层统计 |
| REFERENCE + ON DELETE(3.0+ 声明式引用完整性/级联) | `record-links-vs-graph-relations.md:200-222` | 锚点悬空问题的 schema 层解法候选 |
| DEFER / CONCURRENTLY / REBUILD INDEX | `index-types-and-strategies.md:145-167` | 批量导入与 FULLTEXT/HNSW 写解耦 |
| `search::rrf($lists,$limit,$k=60)` 原生 RRF | `functions/search.md:267-287` | 已在用,继续 |
| FULLTEXT BM25 + ANALYZER(无 CJK 分词器;`class`+`ngram(1,3)` 为官方语法内的近似方案;`mapper` 自定义词典) | `analyzers-and-tokenizers.md:45-79` | 中文检索质量提升空间 |
| surrealkv `+versioned`(建库时开启,VERSION 子句时间旅行)+ `surreal export --versions` | `file-backed.md:65-92`、`start.md:152-161`、`export.md` | 运维级备份/时间点回溯 |
| UPSERT+UNIQUE 幂等写;record-id 直取;EXPLAIN/ANALYZE | `idempotent-operations.md`、`performance-best-practices.md:129-163,225` | 写路径与查询体检的基本功 |

**文档确定性缺口(必须 R0 实测,不得假设)**:① `@surrealdb/node` 嵌入引擎的 LIVE SELECT / CHANGEFEED / export 方法支持性;② 大 bytes 值(音频 MB 级)的读写性能与尺寸边界(仅 value-log 分离存储的暗示,无官方尺寸指引);③ 事务冲突错误的确切形状(现重试匹配 `/failed transaction/i` 过窄);④ `VERSION` 子句完整语法。

## 3. 目标架构(North Star)

```
┌─ 前端 ──────────────────────────────────────────────┐
│ 命令式 API(细粒度)+ 增量同步(changefeed 游标轮询, │
│ live 可用则推送);离线 outbox 按实体合并(已有)      │
└──────────────┬──────────────────────────────────────┘
               │ HTTP(整包 PUT 仅保留为兼容通道)
┌─ apps/api ───┴──────────────────────────────────────┐
│ 命令端点 → 域层纯函数(不变) → 实体命令写(单事务)  │
│ 全局写锁只罩遗留整包路径,新路径靠 DB 乐观冲突+重试   │
└──────────────┬──────────────────────────────────────┘
┌─ SurrealDB(嵌入式 surrealkv,唯一权威) ────────────┐
│ 28+ 真表(热态 12+16 blob 实体+冷层 raw/audio/知识) │
│ 8 边 + EVENT 级联 + ASSERT 公理 + COUNT/物化视图      │
│ HNSW+BM25+rrf 统一召回;CHANGEFEED=审计/同步/重建骨干 │
│ 治理操作=单事务;state_meta 仅剩 {revision,schemaVer} │
└─────────────────────────────────────────────────────┘
   SQLite 只剩一个角色:冷备影子(soak 期),最终退役
```

三条设计公理:
1. **每一步保持对外契约不变或向后兼容**——域层纯函数生态与 `/api/state` 整包契约先不动,底下换血;等实体命令通道成熟再收窄整包通道。
2. **等价双跑先行**——每个搬迁阶段复用现成 dual-write/digest 基建做新旧等价比对,绿灯才切权威(P1d 已验证过这套打法)。
3. **确定性失败必须响亮**——新写路径(实体命令事务)失败直接向调用方报错,终结 P7 的"自愈掩盖";旧整包路径的自愈保留到退役。

## 4. 分阶段方案

### R0 · 前提验证 Spike(0.5~1 天,零生产改动)——**已完成,结论见 `2026-07-10-R0-spike-结论.md`**

> 实测更新(2026-07-10):S1 live 仅 unmanaged 路可用、changefeed 可用**但 3.0.2 有 dbg! stderr 噪声(定义 CHANGEFEED 的表每写十几行)→ R1b 暂不加 CHANGEFEED 子句,R5 启用前先评估/升级依赖**;S2 音频入库 bytes **通过,余量 20 倍+ → R2 定案入库**;S3 真冲突错误形状实测出**现货 bug**(现行重试匹配失效,修复并入 R1a);S4 **versioned 在 @surrealdb/node 3.0.3 不可用(连接挂死)→ R6 放弃 versioned,备份走 export/JSON;用户决策 2 相应作废**;S5 **ngram(1,3) 值得升**(单字/人名召回显著提升,体积 ~2.6x,R4 执行,需在真实体量复核)。

文档四个缺口逐一实测,产出决策矩阵(`docs/superpowers/specs/` 记录):

- S1:嵌入式 `@surrealdb/node` 能否 `LIVE SELECT`(SDK `.live()`/query 返回 uuid)、能否 `DEFINE TABLE ... CHANGEFEED` + `SHOW CHANGES`。→ 决定 R5 走推送还是游标轮询。
- S2:`bytes` 字段写读 1/5/20MB 音频的延迟与文件体积膨胀;单事务含 20MB bytes 是否稳定。→ 决定 R2 音频是"入库 bytes"还是"库存元数据+磁盘文件"。
- S3:两连接(或同连接并发)制造写写冲突,采集错误 message/code 的确切形状。→ 修正 `isTransientPersistError`(P8)并给 R3 的命令重试用。
- S4:`surrealkv+versioned://` 在 @surrealdb/node 的连接串写法与 `VERSION` 子句可用性。→ 决定 R6 备份故事。
- S5:`ngram(1,3)` vs 现行 `ngram(2,2)` 在真实中文语料上的召回质量 A/B(用现有 rag_chunk 测试语料)。→ 决定 R4 分词升级。

**Gate:S2/S3 是 R2/R3 的硬前提;S1 失败不阻塞任何阶段(R5 自动降级为游标轮询)。**

### R1 · 消灭 state_meta blob:16 类实体真表化(P3 → 0)

- 新迁移 `007_r1_entities.surql`:为 profile(单例)、system_config(单例)、profile_suggestion、interview_annotation、chat_session、memory_correction、podcast_episode、corpus_import、corpus_insight、playbook_patch、config_version 建 SCHEMAFULL 表(核心列 + rest FLEXIBLE,沿用 node-mapper 双 schema 模式);为 audit_event / ai_run_event / workflow_run / operational_check 建**append-only 流水表**,record ID 用复合数组 `audit_event:[<createdAt>, <id>]`,天然按时间 range 扫描、零索引分页(文档 `record-ids-and-addressing.md:151-177`)。
- `node-mapper.ts` NODE_MAPPINGS 从 12 扩到 27+;`META_KEYS` 收缩到 `{revision, schemaVersion}`;`loadState` 全表重建路径同步扩展。
- 流水表加 `CHANGEFEED 7d`(为 R5/审计预热)+ COUNT 索引。
- **滚动窗策略升级**:MAX_EVENT_LOG=1000 的内存钳制保留(整包契约还在),但落库侧流水表不截断——改由定期保留期清理(`DELETE audit_event:[NONE]..[<cutoff>]` range 删除)。这是"审计流水被 28MB 倒逼截断"的解药起点。
- 测试:现有整包 roundtrip 等价(digest)+ 新增每类实体的表级查询断言 + 迁移幂等;dual 档双跑 soak。
- **风险**:diff 面扩大 → persist 事务语句数增多。缓解:UPSERT 仍按 diff 只写变更;R0-S3 的冲突重试加固先行。

### R2 · 冷层并库:三个 SQLite + 知识索引归一(P5、P6 → 真事务)

- `008_r2_cold.surql`:
  - `raw_material`(session_id 主键,turns/strategy_trace 为 FLEXIBLE blob——逐字稿是只读整段读写,blob 合理)。
  - `audio`:按 R0-S2 决策——**入库 bytes**(首选,单库单事务)或**元数据表+磁盘文件**(兜底,文件删除留在事务外+回执)。
  - `knowledge_chunk`:替代 knowledge_chunks SQLite,embedding 直接 `array<float>` + **HNSW 索引 + BM25 全文**(与 rag_chunk 同款三件套),epoch 字段保留做 reindex 代际。**P6 双份真相就此终结**:八源知识召回改走原生混合检索(复用 recallRagChunks 的成熟 SurrealQL 模式,含 LET 子查询不叠 AND 的既有坑规避)。
- **治理操作改真事务**:reset/purge/import 的冷层+热态操作合并为单个 `BEGIN...COMMIT`(THROW 条件回滚)。F-04 的快照补偿 journal 只保留给 local-object 文件删除(文件系统无法入事务);`resetReceipt/purgeReceipt/importReceipt` 契约不变,但 `partialFailure` 的可能面从"任一库"缩到"仅文件层"。
- 仓库接口:`RawMaterialRepository/AudioRepository/KnowledgeIndexRepository` 接口不变,新增 Surreal 实现;`PRODUCT_STORE=surreal|dual-surreal` 档位下注入 Surreal 实现,sqlite 档维持旧实现(向后兼容+回退路径)。
- 迁移脚本 `migrate-cold-to-surreal.mjs`(沿用 migrate-sqlite-to-surreal 的校验+marker 模式);dual 双跑比对每库 digest。
- 测试:F-04 的故障注入测试全部改跑新路径(事务回滚断言替代补偿断言,补偿测试保留给文件层);E2E data-governance 复跑。

### R3 · 写路径收窄:实体命令 + 并发模型换轨(P1、P4、P7 减半)

这是收益最大、也最需克制的阶段。**不重写域层**——域层纯函数继续产出 next ProductState;变化在仓库层的落库方式与锁的范围。

- **实体命令接口**:`SurrealRepoHandle` 增加 `applyEntityCommand(cmd)`(如 `{kind:"upsert-note", note}`、`{kind:"confirm-decision", id}`):单事务内 UPSERT 目标实体 + 相关边 + `UPDATE state_meta:main SET revision += 1 WHERE revision = $expected`——**乐观锁下沉到 DB 语句**,冲突由事务失败+有界重试(R0-S3 的真实错误形状)解决。
- **试点路由**(读改写热点、语义局部):`POST /api/assets/decisions/:id/confirm`、`PATCH /api/memory-records/*`、note/annotation 编辑。这些路由**摘出全局写锁**,走"域层算 patch → 实体命令事务"。整包 PUT / interview /end 等宽事务路由留在写锁内(它们本来就该串行)。
- **persist queue 收缩**:实体命令是同步 await 的事务(失败即刻报错给调用方,P7 的掩盖在新路径终结);整包 replaceState 的异步队列+自愈保留,服务遗留通道。
- **审计同事务**:实体命令内直接 `CREATE audit_event:[...]`(同一 BEGIN 块),审计与业务写原子一致——比 DEFINE EVENT 更可控(EVENT 留给级联清理)。
- 度量闸门:压测脚本对比改造前后 p50/p95 写延迟与并发吞吐(目标:热点路由并发不再互相排队,p95 下降可测量)。
- **风险**:同一实体同时被"命令通道"和"整包通道"写 → 以 state_meta.revision 为全局闸(两通道都 CAS 同一 revision),不会静默交叠,只会 409/重试。

### R4 · 读路径下沉与物化(召回与统计)

- **COUNT 索引**:`userEntityCount`(cutover 守卫)、隐私报告实体清点、`/api/health` 实体规模——全部改 `SELECT count() FROM ... GROUP ALL` 走 COUNT 索引,零全表扫。
- **物化视图**:`DEFINE TABLE theme_stats AS SELECT count() AS assets, theme FROM belongs_to_theme GROUP BY theme`(自动增量、`theme_stats:[<theme>]` 直取);同法做会话统计、调试面板指标。
- **中文检索升级**(按 R0-S5 结论):`zh` analyzer 从 `ngram(2,2)` 调 `ngram(1,3)` 或加 `mapper` 领域词典(人名/术语);REBUILD INDEX 重建。
- **精排候选放大**:prefetchRecall 的 topN*4 候选集依赖域层 cosine 精排——把三因子(relevance/recency/importance)中 recency/importance 两因子并入 SurrealQL 投影字段,域层只做最终加权,减少整包字段搬运。
- 明确**不做**:把三因子精排整体塞进 SurrealQL(表达力换不来收益,域层纯函数可测性更好)。

### R5 · 同步骨干:CHANGEFEED 增量同步(P9 收窄)

- 库级 `CHANGEFEED 3d`(或按表白名单)。
- 新端点 `GET /api/state/changes?since=<versionstamp>`:封装 `SHOW CHANGES`,返回实体级变更 + 新游标。前端轮询该端点替代"整包 GET 对比"——离线 outbox 的三方合并已是实体感知(`mergeProductStates` 按 id 合并),天然消费实体级 delta,冲突面从全库缩到实体。
- R0-S1 若 live query 可用:加 WebSocket 推送(server 桥接 LIVE DIFF),轮询保留为兜底。**方案不依赖 live**。
- 整包 `PUT /api/state` 保留(兼容+导入),但前端主路径迁移到"命令端点 + changes 拉取"。
- 前端体积/复杂度闸门:此阶段做完后 `offline-sync.ts` 的 localStorage 全量双份问题(已知限制 M-2)顺势解决——outbox 只存命令与实体 delta。

### R6 · 运维收官与退役

- **versioned surrealkv 评估**(R0-S4):新库以 `surrealkv+versioned://` 建(注意:**只能建库时开启**),保留期对齐隐私政策;`surreal export --versions` 进备份 runbook;用户级 JSON 导出契约(StateExportBundle)不变。
- **dual-write 退役路径**:R1/R2 soak 绿后,per-write 双写比对(P2)降级为"抽样比对 + 每日全量 digest 任务"(changefeed 驱动),最终 sqlite 影子仅在 `dual-surreal` 档保留、默认关闭镜像同步比对。
- 档位收敛:`sqlite` 档进入维护模式(只修不增);文档与 README 更新;`.env.example` 增 `PRODUCT_STORE=dual-surreal` 推荐注释。
- 遗留清理:`promoted_from`/`corrects` 两张 schema 预留死表——接线(P4 系公理消费)或移除,不再悬置。

## 5. 明确不做(YAGNI 边界)

1. **不换 server 模式 / 多进程**:单用户本地产品,嵌入式单进程锁不是瓶颈;server 模式引入认证/网络面(2.x 起默认开认证),纯增复杂度。
2. **不重写域层纯函数为 async DB 查询**:前端 `buildInterviewCard` 同步调用链是既定架构决策(P2b 已论证否决全链 async),继续"预召回注入 + 纯函数"。
3. **不做按条冲突裁决 UI / IndexedDB outbox**(R5 已让问题面大幅缩小,再评估)。
4. **不把精排/推理搬进 SurrealQL**(表达力陷阱)。
5. **不动 8 边本体与公理体系**(①-⑤ 已闭环,R 系列只消费不重构)。

## 6. 风险登记与回退

| 风险 | 概率 | 缓解 | 回退 |
| --- | --- | --- | --- |
| bytes 大值性能不达标(S2 红) | 中 | R2 音频走"元数据入库+文件在盘"备选 | 冷层 audio 留 SQLite,其余照迁 |
| 嵌入式 changefeed/live 不可用(S1 红) | 低-中 | R5 降级为服务端内存 diff 广播(现有 revision 轮询增强) | R5 独立可弃,R1-R4 不受影响 |
| diff 面扩大后 persist 事务变慢/冲突增多 | 中 | S3 真实冲突形状 + 重试阶梯;流水表 append-only 天然无冲突 | 逐表回退 META_KEYS(mapper 是逐表注册的) |
| 迁移存量数据(H1 历史悬空 derived_from) | 已知 | 迁移脚本先跑 keepOnlyLiveTurnProvenance 清洗 + graph audit 后置校验(既有教训:migrate 假绿) | marker + fail-closed 守卫已在位 |
| 双通道写交叠 | 低 | 全局 revision CAS 一票制 | 试点路由退回写锁 |
| 中文 ngram 调参召回退化(S5 红) | 低 | A/B 后再切;REBUILD 可逆 | 保持 ngram(2,2) |

## 7. 验证策略(每阶段统一)

1. `npm run typecheck` + 全量 vitest(当前 1319 绿为基线,只增不减)。
2. **等价双跑**:dual 档 shadow digest 比对(既有基建)覆盖搬迁面;graph 一致性审计(`/api/ops/graph-consistency`)零悬空。
3. **故障注入**:R2 治理事务的 first/middle/last 失败断言"整体回滚"(替代补偿断言);R3 命令冲突注入断言重试/409。
4. **性能基准**:R3/R4 前后各跑一次写延迟/召回延迟基准脚本(新增 `scripts/bench-persist.mjs`),数字进阶段报告——"最优化"必须可度量。
5. E2E:clean-start / data-governance / real-assets(隔离 memory 档)+ 真实档位 soak 清单(运维窗口)。

## 8. 阶段依赖与建议排期

```
R0 (0.5-1d) ──┬── R1 (2-3d) ── R2 (3-4d) ── R3 (3-4d) ──┬── R5 (2-3d)
              │                                          │
              └──────────── R4 (1-2d, 可与 R3 并行) ──────┴── R6 (1-2d)
```

- 关键路径:R0 → R1 → R2 → R3。R4 独立性高可穿插;R5 依赖 R1(流水表)与 R0-S1;R6 收尾。
- 每阶段独立提交、独立可停靠:做完 R1 就已消灭最大建模债;做完 R2 治理操作即获真原子性;R3 起才动并发模型——风险从低到高排列。

## 9. 决策点(需要用户拍板的三件事)

1. **音频入库 or 文件在盘**(R2,待 R0-S2 数据)——入库=单一事务边界最干净;文件=零性能风险。
2. **versioned surrealkv**(R6)——时间旅行诱人,但只能建库时开启且加存储成本;建议新库默认开、保留期 30d。
3. **sqlite 档最终退役时间点**——本方案只降级不删除;完全退役建议放到 R 系列 soak 一个月后单独决策。

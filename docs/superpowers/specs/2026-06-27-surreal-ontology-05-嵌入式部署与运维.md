# SurrealDB × 本体论 · 05 嵌入式部署与运维

- 日期:2026-06-27 · 前置:[00 总纲](2026-06-27-surreal-ontology-00-总纲与决策.md)
- 决策 D2:**嵌入式进程内**(`@surrealdb/node`,`surrealkv://`),单用户本地零运维。

---

## 1. 选型与连接

- 包:`@surrealdb/node`(原生 addon,进程内引擎)。SDK 兼容 SurrealDB v2.x。
- 连接串:`surrealkv://<dataDir>/surreal`(LSM、ACID、嵌入式);开发可 `mem://`(测试)。
- 现状对照:`node:sqlite`(零安装、Node 内置)→ 引入原生 addon(各平台预编译二进制,数十 MB)。这是用 SurrealDB 必付的依赖成本(旧评估 §1 已诚实标注)。

```ts
// 草案:嵌入式连接(替代 createSqliteProductStateRepository 内脏)
import { Surreal } from '@surrealdb/node';
const db = new Surreal();
await db.connect(`surrealkv://${dataDir}/surreal`);
await db.use({ namespace: 'interview', database: 'main' });
```

---

## 2. 数据目录与备份

- 数据目录:沿用现 `.data/`(现 `product-state.db` 等所在),改为 `.data/surreal/`。
- 备份:**拷数据目录**(嵌入式即文件)——比 SQLite 的"拷单文件"略重(目录)但同性质;另提供 `surreal export`(逻辑导出 .surql)作迁移/可读备份。
- `.gitignore`:`.data/surreal/` 必须忽略(与现 `.data/` 一致;注意[中文 gitignore 编码陷阱](本仓历史问题),用 `git status` 核实真实字节)。

---

## 3. 兼容性与 spike(动手前必验)

- [ ] S1 `@surrealdb/node` 在 **Node 22.5+**(本项目 `engines`)装载成功;`mem://` 起一个库、建表、RELATE、KNN 查询跑通。
- [ ] S2 嵌入式向量:`DEFINE INDEX ... HNSW` + `<|K,EF|>` 在嵌入式引擎可用,维度对齐 bailian embedding。
- [ ] S3 全文 BM25 + 中文 analyzer 在嵌入式可用;`search::rrf()` 可用。
- [ ] S4 级联(references `ON DELETE CASCADE` 或 `DEFINE EVENT`)在嵌入式 v2.x 行为符合预期(A5)。
- [ ] S5 CI:加一条嵌入式冒烟(建库→读写→KNN),跨平台(本机 darwin;若有 Linux CI 需各自预编译 addon)。

> 任一 spike 不通过 → 回到 [00 §6 风险],评估降级(如先只迁节点/边、向量仍用 JS,或暂缓)。

---

## 4. 生产/Docker(现状与改动)

- 现 `Dockerfile` 跑 `npm run build` + 静态托管 + `tsx server.ts`(`startServer`)。嵌入式无独立服务,容器内 `surrealkv://` 落到挂载卷。
- 生产 auth/媒体回放/隐私清空等不变(那些是 API 层,不随存储变)。
- 注意:原生 addon 需匹配容器架构(Linux/arm64 等),build 链要装对应预编译二进制。

---

## 5. 运维动手清单

- [ ] T1 `storage-config`:env `PRODUCT_STORE=surreal|sqlite|memory` 选 repo 实现;缺省 sqlite(绞杀者期)。
- [ ] T2 备份脚本:`scripts/backup-surreal.mjs`(拷目录 + `surreal export`)。
- [ ] T3 恢复脚本 + 演练:从备份恢复,getState 等价校验。
- [ ] T4 健康检查:启动时连库 + `INFO FOR DB` 自检;失败 fail-loud(对齐现 server fail-loud 告警风格)。
- [ ] T5 数据迁移脚本入口(详见 [spec 06](2026-06-27-surreal-ontology-06-迁移阶段与回滚.md))。

> 验收:嵌入式库可起、可备份、可恢复;spike 全过;env 可在 sqlite/surreal 间切换。

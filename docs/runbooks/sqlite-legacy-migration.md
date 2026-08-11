# 旧版 SQLite 状态库迁移（C12 · runbook-only）

> **范围：** R7 删除 `PRODUCT_STORE=sqlite`（及 dual / dual-surreal）后，如何把 **历史个人数据** 接到当前 **Surreal 唯一持久档**。  
> **本 epic 交付：仅本文档。不交付** `scripts/migrate-sqlite-*`、只读 sqlite→JSON 工具，或启动时静默搬家。  
> **真源：** `apps/api/src/store-selection.ts`（R7 档位）· `GET/POST /api/state/export|import` · 启动日志 `legacy_sqlite_file_ignored`  
> **配套：** [`ALERTS.md`](./ALERTS.md) A-20 · [`../COST-ENVELOPE.md`](../COST-ENVELOPE.md) §8 · [`../DEPLOYMENT-CHECKLIST.md`](../DEPLOYMENT-CHECKLIST.md)

---

## 1. 先读这三条

1. **当前代码绝不打开旧 `.db` 当产品状态库。** 持久路径是 `PRODUCT_STATE_DB_PATH` 旁的 `.data/surreal/`（嵌入式 surrealkv），与历史 SQLite 文件无关。  
2. **唯一推荐数据路径：** 在 **仍能跑旧版** 的环境做 **export JSON** → 在 **新版** 做 **import**。  
3. **没有官方 sqlite→Surreal 迁移脚本。** 若运维需要专用工具，单开 epic；本 runbook 不假装已提供。

---

## 2. 症状与日志

| 现象 | 含义 |
| --- | --- |
| 升级后专访/记忆「全空」，但磁盘上仍有 `product-state.db` | 正常：新进程只连 Surreal；旧文件被忽略 |
| 启动 stderr 一次 JSON `legacy_sqlite_file_ignored` | 探测到遗留 `.db` 路径存在，**不阻塞**启动 |
| `PRODUCT_STORE=sqlite`（或 dual…） | 归一到 surreal 并打 `product_store_deprecated`；**仍不读**旧 sqlite 数据 |
| capabilities `productStore` / `stateStore` = `surreal` | 与 R7 一致；memory 档为测试/非持久 |

告警分级见 [ALERTS A-20](./ALERTS.md)。

---

## 3. 推荐步骤（export → import）

### 3.1 在旧版本上导出（必须仍能启动旧二进制/镜像）

```bash
export BASE=http://127.0.0.1:3210   # 旧实例
export PRODUCT_API_TOKEN='…'        # 若当时已开鉴权

curl -sS -H "Authorization: Bearer $PRODUCT_API_TOKEN" \
  "$BASE/api/state/export" -o zhuanfang-export.json

# 检查完整性（期望 complete；partial 时先按 runbook §2 补音频分卷）
jq '.completeness.status' zhuanfang-export.json
```

- 导出包含个人数据：**勿提交 git**。  
- 若旧实例已无法启动：只能从备份卷恢复旧镜像再 export；**本仓库不提供**离线读 sqlite 的脚本。

### 3.2 部署新版本（Surreal）

- `PRODUCT_STORE=surreal`（或省略，默认 surreal）。  
- 确认 **只有一个** API 占用 `.data/surreal`。  
- 生产 checklist：[`DEPLOYMENT-CHECKLIST.md`](../DEPLOYMENT-CHECKLIST.md)。

### 3.3 在新版本上导入

```bash
export BASE=https://your.host
export PRODUCT_API_TOKEN='…'

# 契约以当前 API 为准：通常需确认词 REPLACE_ALL_STATE（见 state 路由）
curl -sS -X POST -H "Authorization: Bearer $PRODUCT_API_TOKEN" \
  -H "Content-Type: application/json" \
  "$BASE/api/state/import" \
  --data-binary @zhuanfang-export.json
```

导入后检查：

1. `GET /api/health` → `ok && ready`  
2. UI / `GET /api/state` 抽样主题与记忆  
3. import receipt：`knowledgeIndex`  
   - `failed` → **热态可能已写入**；在资料/配置页 **重建知识索引**（见 [ALERTS A-18](./ALERTS.md)）  
   - 勿把「索引失败」当成「整库未导入」

### 3.4 清理（可选）

- 确认 import 与业务抽检通过后，可将旧 `product-state.db` **离线归档**（勿在未备份时 `rm`）。  
- 遗留文件不影响运行；仅避免运维误读「文件还在 = 数据已迁」。

---

## 4. 明确不做

| 项 | 说明 |
| --- | --- |
| `scripts/migrate-sqlite-*` | **本 epic 不交付** |
| 启动时自动读 sqlite 灌 Surreal | 禁止静默搬家（数据正确性与双开锁风险） |
| 把 `PRODUCT_STATE_DB_PATH` 指到旧 `.db` 当库 | 路径仅作 Surreal 目录锚点；**不会**打开该文件为 SQLite |
| 用 pytest/全量测当迁移验收 | 日常只对 **已部署 demo** 做 export/import 冒烟 |

---

## 5. 相关链接

| 文档 | 用途 |
| --- | --- |
| [`ALERTS.md`](./ALERTS.md) A-20 / A-18 | 遗留 sqlite 告警；import 索引失败 |
| [`README.md`](./README.md) | 双开锁、export partial、persist |
| [`../COST-ENVELOPE.md`](../COST-ENVELOPE.md) | 预算与 opt-in |
| [`../DEPLOYMENT-CHECKLIST.md`](../DEPLOYMENT-CHECKLIST.md) | 上线勾选 |
| `apps/api/src/store-selection.ts` | R7 档位归一与 deprecated 提示 |
| `packages/db/src/surreal/migrations/002_relations.surql` | 图边 schema（与 sqlite 无关；死表见 [reserved-graph-edges](./reserved-graph-edges.md)） |

**C12 完成定义：** 本文存在且写明 **export→import only、无官方迁移脚本**；启动可 warn `legacy_sqlite_file_ignored`。

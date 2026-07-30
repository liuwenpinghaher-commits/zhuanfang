# Track V3 · Live export smoke（2026-07-30）

> 维护路线图 Track V3 · checklist §8  
> 目标 API：compose 生产容器 `http://127.0.0.1:3210`（`.env.production.local`，密钥未入库）

## 命令

```bash
PRODUCT_API_BASE_URL=http://127.0.0.1:3210 \
PRODUCT_API_TOKEN='…' \
node scripts/backup-export-smoke.mjs
```

## 结果

```json
{
  "ok": true,
  "status": "complete",
  "reasons": [],
  "hasState": true
}
```

| 检查 | 结果 |
| --- | --- |
| HTTP `/api/state/export` + Bearer | 200 |
| `completeness.status` | **complete** |
| `completeness.reasons` | `[]` |
| 导出包含 state/package 载荷 | true |
| `audioVolumes.total` | 0（本卷无大音频分卷） |
| smoke 退出码 | 0 |

## 边界

- 只读导出；**未**执行 import 回灌或 purge（避免破坏演练卷）  
- 未把导出 JSON 写入仓库（含个人数据）  
- checklist §8 中「演练环境 import 抽检」仍可选，本 V3 以 **live completeness smoke** 为完成定义  

## 结论

**V3 closed.** Track V（V1–V3）齐 → 部署验证轨可宣称 **Full GO（验证维度）**；产品/运维签字仍见 `DEPLOYMENT-CHECKLIST.md` §10–§11。

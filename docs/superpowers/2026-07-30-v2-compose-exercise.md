# Track V2 · 真实 Provider Compose 演练（2026-07-30）

> 维护路线图 Track V2 · checklist §7  
> 代码 tip：`main` @ `1810ff6e`+ · env：`.env.production.local`（**未提交**）

## 执行步骤

1. `docker compose --env-file .env.production.local config -q` → OK  
2. `docker compose --env-file .env.production.local up --build -d` → 镜像 `zhuanfang:local` 重建成功（~6min）  
3. 带鉴权冒烟（§5 子集 + 短专访 + chat）→ **12/12 PASS**  
4. `docker compose down`（**无** `-v`）→ 卷 `10_zhuanfang-data` 仍在  
5. `docker compose up -d` → 会话数据仍在（sessions=1, revision=4, id 重叠=1）→ **VOLUME_PERSIST PASS**

## 冒烟明细

| 检查 | 结果 |
| --- | --- |
| `GET /api/health`（无 token） | 200 ready=true |
| `GET /api/system/capabilities`（Bearer） | 200 · `productStore=surreal` |
| `GET /api/state` 无 token | 401 |
| 跨站 Origin mutating | 403 |
| `GET /api/state` 有 token | 200 |
| 创建 daily 专访 + turn + end | 200（真实 LLM 路径） |
| `POST /api/chat` | 200 |
| 日志无 `auth_guard_inactive_in_production` | PASS |
| 日志无 `state_store_in_memory_in_production` | PASS |
| down 后卷保留 / up 后数据仍在 | PASS |

## 边界

- 未做完整浏览器 UI 点击（V1 Playwright 已覆盖 memory 档 UI；本项为 compose+真 key API）  
- 未强制跑 TTS/ASR 文件链路（无公网 CORPUS_AUDIO_PUBLIC_BASE_URL 时属可选）  
- 容器演练后保持 `up`（与演练前「已有 healthy 容器」一致）；数据在 named volume  

## 结论

**V2 closed.** Full GO 仍差 checklist §8 live export 抽检（可与 V3 合并）。

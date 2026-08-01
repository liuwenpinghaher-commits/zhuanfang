# 播客多源 LLM + 生产部署验证（2026-08-01）

> 验证主机：本地 macOS · Docker Compose 生产档 `:3210`  
> Git：`main` @ `31294d37`（`feat(podcast): LLM scripts for all source types with fail-loud honesty`）  
> 范围：外部调研 / 播客 / 记忆剩余收口中的 **播客多源脚本 LLM** 上线与生产冒烟

---

## 1. 变更摘要

| 项 | 说明 |
| --- | --- |
| 脚本生成 | `note` / `search-brief` / `theme` / `knowledge-debt` **全部**走 `generatePodcastScriptFromSource` |
| 失败语义 | 未配置 LLM → `503`；预算耗尽 → `429`；LLM 失败 → `502`；**不**用确定性模板脚本冒充 |
| 预算顺序 | 先校验来源（可 `422`），再 `tryConsume`，无效请求不烧配额 |
| UI 诚实文案 | 去掉「结构化模板脚本（可后续升级 LLM）」；改为「脚本将基于该来源由 LLM 生成，失败会如实提示」 |
| 创建默认 | 仍默认 **只落脚本**（`audioRenderStatus=pending`）；仅 `PODCAST_AUTO_RENDER_ON_CREATE=true\|1\|yes\|on` 时创建即 TTS |
| 主要文件 | `apps/api/src/intelligence/podcast-script-llm.ts`、`apps/api/src/routes/podcast.ts`、`src/features/podcast/PodcastStudioView.tsx` + 对应单测 |

记忆治理 / 外部调研：本轮扫描无新增 P0/P1 产品缺口（既有 redesign 与 fail-loud 搜索路径保持）。

---

## 2. 门禁矩阵（合入前）

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | **PASS** |
| 全量 Vitest | `npx vitest run` | **PASS** · **1618 pass / 6 skip** |
| Playwright 默认 e2e | `env -u PRODUCT_API_TOKEN -u VITE_PRODUCT_API_TOKEN … npx playwright test` | **PASS** · **38/38**（隔离端口 13210/13220/13230 + `scrubShellEnv`） |
| Push | `git push origin main` | `e80724b0..31294d37` |

---

## 3. 生产部署

```bash
# 避免 shell 污染生产 compose（历史教训：export 的 PRODUCT_API_TOKEN 等会串进容器）
env -u PRODUCT_API_TOKEN -u VITE_PRODUCT_API_TOKEN -u PRODUCT_WEB_ORIGINS \
  -u DEPLOYMENT_PROFILE -u PRODUCT_STATIC_DIR -u PRODUCT_ENV_FILE \
  docker compose --env-file .env.production.local up -d --build
```

| 检查 | 结果 |
| --- | --- |
| 容器 | `10-zhuanfang-1` **healthy** · `0.0.0.0:3210->3210` |
| `GET /api/health` | `200` · `ok/ready` · service `interview-product-api` |
| 静态 UI | `/` + hashed JS/CSS **200** |
| 鉴权 capabilities | Bearer 后 `200` · `productStore=surreal` |
| 前端 bundle | **含**新诚实文案；**不含**旧「结构化模板脚本」 |

关键 capabilities（节选）：`bailian-cosyvoice` ready、`bailian-character` ready、`bailian-responses` ready、embedding ready；`corpus-audio-public` degraded（未配 `CORPUS_AUDIO_PUBLIC_BASE_URL`，预期）。

---

## 4. 生产播客冒烟

### 4.1 多源脚本 LLM（create）

| 来源 | HTTP | 脚本 | 创建时音频态 |
| --- | ---: | --- | --- |
| note | 200 | 自然口播 LLM 正文（数百字级） | `pending` |
| theme | 200 | 自然口播 LLM 正文 | `pending` |
| knowledge-debt | 200 | 含「主持人 / 来宾」对谈形态 | `pending` |
| search-brief | — | 当时生产库无简报；单测/路由测已覆盖 | — |

模板特征串（如「结构化模板」「确定性脚本」）未出现在生成正文中。

### 4.2 TTS synthesize

| 场景 | 结果 |
| --- | --- |
| 系统默认音色 `longanhuan` + 短脚本 | **200 `rendered`** · OSS `audio/mpeg` 可拉 |
| 同音色 + 中等脚本（~90 字） | **200 `rendered`** · ~10s · `audio/mpeg` 可拉 |
| 音色探针 `longanhuan` | **OK** |
| 音色探针 `longyuan_v3` | **502** · CosyVoice **400**（脚本保留） |
| 长脚本（~500–800 字） | 曾出现 **timeout**（客户端 60s）或失败；**fail-loud**，脚本不丢 |
| 失败语义 | `audioRenderStatus=failed` + 真实错误文案 + HTTP 502 |

**结论：**

- TTS **已接通真实 CosyVoice**，默认音色 **`longanhuan` 可用**。
- 生产 `systemConfig.voice.podcastVoice` 为 `longanhuan`；硬编码/习惯使用的 `longyuan_v3` 在本环境会被 provider 拒绝，工作台应优先默认音色。
- 长文一次合成仍受 provider/超时约束；产品路径「先脚本、再确认合成」正确。

### 4.3 冒烟副作用

验证过程在生产库写入了若干测试剧集（rendered/failed 混合）。可选清理：个人页数据治理或按 episode `DELETE /api/podcast/episodes/:id`（需 Bearer）。**未**执行 `down -v` / purge。

---

## 5. 运维注意

1. **Compose 务必** `--env-file .env.production.local`，并对已 export 的鉴权/origins 变量 `env -u …`，避免污染。
2. 播客创建默认不扣 TTS；合成用 `POST /api/podcast/episodes/:id/synthesize`（可带 `script`）。
3. TTS 超时常量：`createBailianPodcastAudioClient` 内 `AbortSignal.timeout(60000)`；长脚本失败属已知边界，非本次回归。
4. 备份真源仍是 `GET /api/state/export`（鉴权）。

---

## 6. 结论

| 维度 | 判定 |
| --- | --- |
| 代码合入 | **GO** · `31294d37` on `main` |
| 自动化门禁 | **GO** · typecheck + 1618 unit + 38 e2e |
| Compose 生产部署 | **GO** · healthy surreal + 同源 SPA |
| 多源脚本 LLM | **GO** · 生产实测 note/theme/debt |
| TTS 闭环 | **Conditional GO** · 默认音色短/中脚本实听链路通；`longyuan_v3` 与超长脚本需产品侧避坑/后续增强 |

**总体：可继续作为当前生产运行版本。** 播客「全来源 LLM 脚本 + 诚实失败」目标已闭环；TTS 在默认配置下可用。

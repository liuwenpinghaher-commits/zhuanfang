# 实时专访交互与闭环优化 · 最终报告（2026-08-01）

> **代码 tip：** `main` @ follow-up residual closeout  
> **范围：** 实时专访页（`InterviewView`）交互体验 + 会中控制/结束交接闭环  
> **前置审查：** 对话优先、控制留痕、文本默认、结束交接  
> **关联：** 今日访谈台闭环 `6b295e0f`；播客/资产收口 `4a6d1b7a` / `31294d37`

---

## 1. 问题摘要（优化前）

截图场景（决策专访 · 控制感 · 0 轮）暴露：

1. **控制三块抢占首屏**，开场问题与输入区沉底，首轮不像「对话」。
2. **标题叠词**：`决策专访：继续追问：控制感`。
3. **文本/语音主通道不清晰**；副标题过度推销语音。
4. 控制虽有服务端 turns 反馈，但被布局挤出视口，**像点了没反应**。
5. `doNotSave` 单向、按钮无 pressed 态。
6. 结束成功 notice 偏泛，交接弱。

后端 turn/control/end 闭环本身已较强；瓶颈在**会中信息架构与反馈可见性**。

---

## 2. 实施方案与落地

### S1 — 对话优先布局（已落地）

| 改动 | 位置 |
| --- | --- |
| 0 轮 **开场 hero**（问题 + whyNow + 引导） | `InterviewView.tsx` |
| **访谈调节**折叠抽屉，默认收起 | 同上 |
| **composer 上移** + sticky | 同上 + `styles.css` |
| 标题去重 `formatInterviewHeaderTitle` | 导出并单测 |

### S2 — 控制留痕与忙态（已落地）

| 改动 | 位置 |
| --- | --- |
| 控制反馈 turn 样式 `turn-control` | UI |
| 顶栏芯片：强度 / 可写入 / 下轮 pendingControl | UI |
| submitting/finishing 互锁控制与结束 | UI |
| **doNotSave 可切换** + 文案「取消不保存」 | `turn-builder.ts` + UI |
| 0 轮调节提示「首轮后生效」 | UI |

### S3/S4 — 语音说明与结束交接（轻量已落地）

| 改动 | 位置 |
| --- | --- |
| 副标题：默认文本追问，语音可选 | UI |
| ⌘/Ctrl+Enter 提交 | UI |
| 结束成功 notice 带笔记标题 | `App.tsx` `finishInterview` |

### 续作（本批已补齐）

| 项 | 状态 |
| --- | --- |
| 结束回流「上场摘要」回 Home | **closed** |
| 结束二次确认 | **closed** |
| Esc 停录 | **closed** |
| 语音断连→可打字继续文案 | **closed** |
| 移动端专访布局（侧栏下沉/composer） | **closed** |

### 仍明确不做

- 重写策略引擎 / LLM prompt  
- 长列表虚拟化（无性能痛点前）  
- 强制默认开麦  
- Wave D 全量增强 / 多租户  

---

## 3. 关键文件

| 文件 | 变更 |
| --- | --- |
| `src/features/interview/InterviewView.tsx` | 布局与交互主改 |
| `src/features/interview/InterviewView.test.tsx` | 标题/开场 hero 单测 |
| `src/domain/turn-builder.ts` | doNotSave toggle + 反馈文案 |
| `src/App.tsx` | 结束交接文案 |
| `src/styles.css` | opening-hero / control-drawer / chips |

---

## 4. 完整回归结果（本报告执行时）

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| Git | `main` @ follow-up residual closeout · 与 origin 同步 · 干净 | **PASS** |
| Typecheck | `npm run typecheck` | **PASS** |
| Unit | `npx vitest run` | **PASS** · **1626 pass / 6 skip** · 160 files |
| E2E | scrub env · `npx playwright test` | **PASS** · **38/38** |

---

## 5. 业务闭环核对

| 路径 | 状态 |
| --- | --- |
| 文本提交 → 双回合 → 可继续 | 保持（既有 API + UI） |
| 失败重试本轮 | 保持 |
| 控制 → 服务端 turn 反馈 + 可见样式 | **增强** |
| doNotSave 开关 | **增强** |
| 结束 ≥1 用户轮 / loading / notes·memory 分流 | 保持 + notice 增强 |
| 语音 cascade / 打断 / 隔离转写 | 保持（未改管线） |

---

## 6. 成功标准对照

| 标准 | 结果 |
| --- | --- |
| 3 秒内知道回答开场 | **达标**（hero + composer 优先） |
| 控制动作可见反馈 | **达标**（turns + chips + pressed） |
| 忙态无幽灵点击 | **达标** |
| 文本默认、语音可选 | **达标** |
| 回归绿 | **达标** |

---

## 7. 部署建议

生产若仍跑旧 bundle，执行：

```bash
env -u PRODUCT_API_TOKEN -u VITE_PRODUCT_API_TOKEN -u PRODUCT_WEB_ORIGINS \
  -u DEPLOYMENT_PROFILE -u PRODUCT_STATIC_DIR -u PRODUCT_ENV_FILE \
  docker compose --env-file .env.production.local up -d --build --force-recreate
```

验证点：实时专访空场见「开场问题」大卡；「访谈调节」折叠；标题无双重「继续追问」。

---

## 8. 结论

**实时专访交互与闭环优化已完成并通过完整回归。**  
主路径后端闭环未削弱；前端信息架构达到审查方案的 S1–S4 轻量目标。  
任务可关闭；后续仅按痛点做移动端/结束摘要页等增强。

**报告人：** Oz  
**状态：** 完成  

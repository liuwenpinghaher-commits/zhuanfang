# 双轨笔记新工作流最终冒烟（2026-08-01）

> 环境：生产 compose `http://127.0.0.1:3210` · tip `main` @ `744e5a23`（文档归档 commit 见 `14cc5f5e`+）  
> 脚本：`scripts/notes-workflow-smoke.mjs`  
> 原始结果：`/tmp/notes-workflow-smoke.json`（本地临时，不入库）  
> **总结果：PASS**  
> **归档状态：已关闭（CURRENT + ARCHIVE §0.8）**

## 1. 范围

验证「双轨笔记阅读室」主闭环，而非整站回归：

1. 打开笔记页（生产鉴权 cookie bootstrap）
2. 清理顶栏空场（移除空场）
3. UI 表面：Hero / 搜索筛选 / 保存 / 开场 / 原文 / 播客 / 档案
4. 展开双轨
5. 查看原始材料
6. 保存回访问题 → 资产库落库且留在笔记页
7. 筛选「有回访问题」
8. 「用此问题开场」进入实时专访，并检查 session topicHint / relatedThemeIds

## 2. 预检（API / Bundle）

| 检查 | 结果 |
| --- | --- |
| `GET /api/health` | ok=true ready=true |
| 生产 state 笔记 | 2 条完整笔记；目标场 `日常复盘：关于「控制感」的专访` · nextQ=3 · keyQuoteAnchor=true · themes=1 |
| 冒烟前 active 空场 | 2（脚本内已 discard） |
| 前端 bundle 文案 | 命中：用下个问题开场 / 用此问题开场 / 保存到资产库 / 轻量记录 / 阅读与回访 / 查看来源原文 / 生成播客 / 打开专访档案 / 展开全部双轨与问题 / 有回访问题 |

## 3. UI 工作流步骤结果

| 步骤 | 状态 | 观察 |
| --- | --- | --- |
| runtime-bootstrap | **PASS** | `authRequired=true, cookieSet=true`（HttpOnly cookie，非 JSON 泄密） |
| cleanup-empty-sessions | **PASS** | 首页可见 2 个「移除空场」，已点击清理 |
| open-notes | **PASS** | 标题「从访谈沉淀认知资产」+ 副文案「阅读与回访」 |
| ui-markers | **PASS** | heroStart / save / startQ / raw / search / filterQ / podcast / archive 均可见 |
| expand-tracks | **PASS** | 「展开全部双轨与问题」可点 |
| open-raw-material | **PASS** | 原始材料区可展开（loading/内容/空态路径可达） |
| target-question | **PASS** | `你第一次意识到这个矛盾，是在什么具体事情发生之后？` |
| save-question | **PASS** | 留在笔记页；问题 `正在聚焦`；`whyImportant` 含「会后反馈」；`sourceSessionId=session-1785420930206-426c02`；UI「已保存到资产」 |
| filter-with-questions | **PASS** | 筛选后仍可见开场 CTA |
| start-with-question | **PASS** | 进入 `.interview-layout` |
| session-topic-binding | **PASS** | 新 session `daily`；`topicHint` 即为该回访问题；`relatedThemeIds=["theme-1785420944556-fba1b4"]` |

## 4. 闭环判定

| 业务闭环 | 判定 |
| --- | --- |
| 笔记阅读入口 | 通过 |
| 空场不永久挡路（可移除） | 通过 |
| 回访问题 → 资产（去重 UI + 元数据） | 通过 |
| 保存后不强制离开笔记 | 通过 |
| 回访问题 → 开场专访（topic 绑定） | 通过 |
| 主题软归属带入新 session | 通过 |
| 原文下钻入口 | 通过 |
| 播客 / 档案入口可见 | 通过（本次未点进二级页深测合成/高亮滚动） |

## 5. 残余与说明

- 冒烟会在生产库**新增/确认**一条会后问题资产，并可能新建一场 `daily` active session（0 轮）。可用笔记页/首页「移除空场」清理；问题资产保留符合产品语义。
- 「打开专访档案」高亮滚动、旁注写入 notice、播客跳转未在本轮逐一点击深测（入口可见性已覆盖）。
- 原始材料内容依赖冷层是否已 offload；本轮以「可展开且非白屏」为通过标准。

## 6. 复现命令

```bash
# 生产需已 up
node scripts/notes-workflow-smoke.mjs
# 或
SMOKE_BASE=http://127.0.0.1:3210 node scripts/notes-workflow-smoke.mjs
```

## 7. 结论

**双轨笔记新工作流端到端冒烟：通过（PASS）。**  
阅读室 + 回访发射台主路径在生产 bundle 上可运行，关键写路径（保存问题）与开场绑定（topicHint + relatedThemeIds）已核实。

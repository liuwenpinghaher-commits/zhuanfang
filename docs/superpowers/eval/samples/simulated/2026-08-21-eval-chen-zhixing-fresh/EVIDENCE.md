# 收工证据（新开一场）

## 部署

- 容器：`app-zhuanfang-1`
- 镜像：`sha256:960160a54de94f812b9f661de005d5c52698bdc4f2d1c221fa28492183b7140f`
- 创建：`2026-08-21T13:23:51Z`（含抽取 checkpoint、主持人追问默认 120 秒）

## 服务端日志

```
{"event":"end_stage","stage":"extract_ok","sessionId":"session-1787318660278-d49970","candidates":17}
{"event":"end_stage","stage":"finalize_ok","sessionId":"session-1787318660278-d49970"}
```

第一次收工即成功，没有走 extract_resume。

## 驱动回读

- 新会话 `session-1787318660278-d49970`（purge 后新建，不是旧场重试）
- 15 轮嘉宾 + 15 轮主持，8251 字，17.5 分钟，降级 0
- `/end` HTTP 200，session status=`completed`，endError 缺省
- 待确认记忆 17（还没点头进长期记忆）、观点 6、问题 3、知识债 3
- 产物原文见 `PRODUCTS.json`
- `driver.json` 是当时裁过的回放，**不是**驱动原始输出；本批收工毫秒未入仓，不事后用时间线冒充。下场起必须把驱动 `outFile` 原样入仓（含 `ended` / `endAttempts` / `endMs`）

## 引文核对约定（线上与复算同一套）

打开书核引文时，只认这一套，不再分 40/48：

1. 去掉中西引号，挤掉空白
2. 去掉省略号（`…` / `⋯` / 连续三点），**不去小数点**
3. 用规范化后前 **48** 字做包含匹配

线上回指（`memory-extraction-llm.ts`）和复算脚本（`scripts/eval/lib/audit-products.mjs`）必须跟这三条。`ellipsisInQuotes` 只计省略号，不计 `0.15` 这种小数点。

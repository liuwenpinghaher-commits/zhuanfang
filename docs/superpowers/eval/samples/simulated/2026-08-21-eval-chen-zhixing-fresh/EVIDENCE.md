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

本约定自 chen-fresh 批生效，覆盖后续全部批次（含林越）。前缀长度与归一化规则的任何变更，须双角色复审后才生效。

book / hard / productAudit 字段由当次人工对照产物与逐字稿填写，不是评分脚本生成。`points.evidence` 尚未纳入复算工具，观点引文只人工抽查。

近重：同一语义命题在任意两条书里资产中复现即计，不分跨类或类内。

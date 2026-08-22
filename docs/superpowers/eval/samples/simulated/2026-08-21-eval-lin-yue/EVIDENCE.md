# 收工证据（林越 · 新开一场）

## 部署

- 容器：`app-zhuanfang-1`
- 镜像：`sha256:586963d788332a00d31e9a3f5f47d7a943dd9befab62356c1a4cc6edf79e5c5b`
- 账号：`eval_sim`（评测仓；先核了分仓，witness 无同场）
- 本场前对评测仓做了清空，不是主人仓

## 服务端日志

```
{"event":"end_stage","stage":"extract_ok","sessionId":"session-1787326199901-48122a","candidates":14}
{"event":"end_stage","stage":"finalize_ok","sessionId":"session-1787326199901-48122a"}
```

第一次收工即成功，没有走 extract_resume。

## 驱动回读

- 新会话 `session-1787326199901-48122a`（评测仓清空后新建）
- 嘉宾林越（AI Agent / Coding 创业），15 轮嘉宾 + 15 轮主持，8390 字，18.2 分钟，降级 0
- `/end` HTTP 200，一次成功，`endMs=258832`，`endAttempts=1`，session status=`completed`
- 待确认记忆 14、观点 6、问题 3、知识债 2
- `driver.json` 是驱动原样输出（含 `ended` / `endAttempts` / `endMs`），没有裁剪
- 产物原文见 `PRODUCTS.json`

## 引文核对约定（与线上同一套）

1. 去掉中西引号，挤掉空白
2. 去掉省略号（`…` / `⋯` / 连续三点），不去小数点
3. 用规范化后前 48 字做包含匹配

本约定自 chen-fresh 批生效，覆盖后续全部批次（含本场）。前缀长度与归一化规则的任何变更，须双角色复审后才生效。

book / hard / productAudit 字段由当次人工对照产物与逐字稿填写，不是评分脚本生成。`points.evidence` 尚未纳入复算工具，观点引文只人工抽查。

近重：同一语义命题在任意两条书里资产中复现即计，不分跨类或类内。

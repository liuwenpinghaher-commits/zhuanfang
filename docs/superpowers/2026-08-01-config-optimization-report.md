# 系统配置端到端经营台优化报告（2026-08-01）

## 目标
把系统配置做成「一眼知健康 → 能改 → 改完可验证」的闭环。

## 交付
- URL：`?view=config&section=status|settings`（+ 可选 focus）；离开 my-assets 清 sticky query
- 产品策略脏草稿隔离；远端更新提示 + 放弃草稿
- 产品策略保存诚实（离线/outbox → warning）
- 状态：loading/错误/刷新；风险摘要；needs-key 一键去填密钥
- metrics 正式类型（去 as any）；restartRequired 保存 notice；清理生成物确认
- sticky 未保存底栏

## 验证
- typecheck PASS
- ConfigView unit 6/6 PASS
- 生产冒烟：`node scripts/config-workflow-smoke.mjs` → pass=9 fail=0 warn=0 ok=True
- compose rebuild 含 `config-risk-strip` / `去填写密钥`

## 脚本
`scripts/config-workflow-smoke.mjs`

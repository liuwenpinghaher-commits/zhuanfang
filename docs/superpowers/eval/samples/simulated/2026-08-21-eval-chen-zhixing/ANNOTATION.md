# 标注声明

本目录 `INTERVIEW-chen-zhixing.scorecard.json` 里的 `book` / `hard` 叙述字段，是 2026-08-21 人工对照对话写成的，**不是**评分脚本生成。

- 标注者：Grok 会话（对照线上会话 `session-1787297953231-372e89` 与 `transcript.md`）
- 时间：2026-08-21
- 本批降为**趋势参考件**，不计入任何验收门
- 下面这些是硬事实，不受标注方式影响：
  - `user_value_verdict` / `gateHumanValue` = `insufficient_data`（模拟嘉宾，不能当真人价值）
  - 嘉宾 15 轮、主持人 15 轮、约 7872 字已写进书
  - 收工两次失败，会话保持可重试（第一次驱动内连续失败；第二次单独再试 60.2 秒同样失败）
- 嘉宾把人设观点原句重复多遍（「良好定义」等），主持人追数表现只作趋势，不作能力证明
- `driverCookieMode: full-session`：本批起驱动全程带登录 cookie

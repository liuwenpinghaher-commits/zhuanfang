# 语料学习 + 个人档案端到端经营台（2026-08-01）

## 审查结论
两页内核可用（语料分析/补丁 HITL、档案治理与保存），断点在 URL 深链、分析后回流、档案表单脏状态与记忆经营入口。

## 交付
- URL：`view=corpus` / `view=profile`（并补 config/interview/search/podcast/track 读取）；离开 my-assets 清 sticky
- 语料：分析后高亮最新 insight；空态 CTA；应用补丁后「查看系统配置 / 去实时专访验证」
- 档案：表单 dirty 隔离与未保存提示；边界添加反馈；系统记忆「去记忆治理」
- 生产冒烟：pass=6 fail=0 warn=0 ok=True

## 验证
- typecheck PASS
- ProfileView unit 2/2 PASS
- compose rebuild + `node scripts/corpus-profile-smoke.mjs`

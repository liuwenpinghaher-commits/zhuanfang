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
- 产物原文见 `PRODUCTS.json`，驱动精简回放见 `driver.json`

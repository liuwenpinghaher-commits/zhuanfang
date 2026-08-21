# 收工证据（可复核）

本文件只记能从线上读回来的东西，不替代评分脚本。

## 部署

- 容器：`app-zhuanfang-1`
- 镜像：`sha256:a91423bc282717b24df113be859d98cb3a36c6c68c90fc3506d500b2ac507649`
- 镜像标签：`zhuanfang:local`
- 容器创建：`2026-08-21T11:19:58Z`（对应提交 `1d54224` 热更：抽取分片 + 归档 240 秒 + `end_stage` 日志）
- 用户当次明确「钥匙不用换了」后才热更，不是换钥记录。

## 服务端日志（demo `docker logs`）

```
{"event":"end_stage","stage":"extract_ok","sessionId":"session-1787297953231-372e89","candidates":13}
{"event":"end_stage","stage":"finalize_ok","sessionId":"session-1787297953231-372e89"}
```

## 产品态回读（2026-08-21 GET `/api/state` + GET session）

- 会话 `session-1787297953231-372e89` status=`completed`（收工后 turns 已卸到冷层，热态 turnCount=0）
- memoryCandidates=13、points=7、questions=3、debts=3、notes=1
- 驱动侧耗时 251823ms、HTTP 200

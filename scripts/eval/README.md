# 统一真人对抗评测

对着**已部署**系统打独立评测账号，不是再起一套库。

```bash
# 默认三场短文本（Grok 机可跑 HTTP；不要设 PRODUCT_API_TOKEN）
EVAL_TIER=smoke EVAL_MODALITY=text node scripts/eval/run.mjs

# 完整文本
EVAL_TIER=full EVAL_MODALITY=text EVAL_MAX_HOST_CALLS=180 node scripts/eval/run.mjs

# 语音：只在 demo 宿主机，显式打开
EVAL_TIER=full EVAL_MODALITY=voice node scripts/eval/run.mjs
```

## 开通评测用户（一次性，demo 机）

没有 HTTP 注册。密码只放未跟踪文件 `/opt/zhuanfang/app/.env.eval.local`，不要进 git，不要复用 `smoke_a`。

```bash
ssh -i ~/.ssh/id_tencent_lh ubuntu@82.157.130.140
# 容器内调用 createUser（路径随镜像）
docker exec -i app-zhuanfang-1 node --input-type=module -e "
  import { createUser, userExists } from './apps/api/src/auth/users.ts';
  for (const [u, p] of [['eval_sim', process.env.EVAL_SIM_PASSWORD], ['eval_witness', process.env.EVAL_WITNESS_PASSWORD]]) {
    if (!p) throw new Error('missing password for ' + u);
    if (!userExists(u, process.env)) createUser(u, p, process.env);
    console.log('ok', u);
  }
"
```

## 死命令

- 进程里出现 `PRODUCT_API_TOKEN` → 立刻退出 2，零写。
- 证明分仓之前禁止 PUT / purge / 建场。公网先 SSH 确认两个开关都开。
- 禁止 `RESET_ALL_DATA`、禁止复用 `voice-cascade.spec.ts`。
- 模拟样本不得写 GATE-HUMAN-VALUE = go。

旧入口 `scripts/run-all-interviews.sh` 只在 `EVAL_TIER=populate` 时跑，且**不再**裸 curl 清库。

#!/usr/bin/env bash
# 专访 1.0 服务器端部署：用当前工作树 rebuild compose（由 GHA scp 同步代码后调用）。
# 保留 .env.production.local，不经开发者本机网络。
set -euo pipefail

REPO_DIR="${ZHUANFANG_REPO_DIR:-/opt/zhuanfang/app}"
ENV_FILE="${ENV_FILE:-$REPO_DIR/.env.production.local}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"

cd "$REPO_DIR"

if [ ! -f "$ENV_FILE" ]; then
  echo "缺少 $ENV_FILE — 生产密钥必须事先落在服务器上" >&2
  exit 1
fi

if docker info >/dev/null 2>&1; then DOCKER=docker; else DOCKER="sudo docker"; fi

echo "==> $DOCKER compose up --build (zhuanfang)"
# 避免 host 已 export 的同名变量污染 compose
env -u PRODUCT_API_TOKEN -u VITE_PRODUCT_API_TOKEN -u PRODUCT_WEB_ORIGINS \
  -u DEPLOYMENT_PROFILE -u PRODUCT_STATIC_DIR -u PRODUCT_ENV_FILE -u VITE_BASE \
  $DOCKER compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --build --remove-orphans

echo "==> 等待健康"
for i in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:3210/api/health" >/dev/null 2>&1; then
    echo "健康检查通过"
    curl -fsS "http://127.0.0.1:3210/api/health" || true
    echo
    # 经 80 路径反代的冒烟（若写作台 nginx 在）
    curl -fsS -o /dev/null -w "proxy_zhuanfang=%{http_code}\n" "http://127.0.0.1/zhuanfang/" || true
    $DOCKER compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps
    exit 0
  fi
  sleep 3
done

echo "健康检查超时，最近日志:" >&2
$DOCKER compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" logs --tail=80 >&2 || true
exit 1

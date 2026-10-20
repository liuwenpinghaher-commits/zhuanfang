#!/usr/bin/env bash
# Manual lighthouse fallback when GitHub Actions billing is blocked.
# Packs with scripts/pack_lighthouse.sh, scp to the host, keeps .env.production.local,
# then runs deploy/prod/scripts/deploy.sh. Does not print or upload secrets.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

HOST="${DEPLOY_SSH_HOST:-deploy-host}"
REMOTE_TMP="${DEPLOY_REMOTE_TMP:-/tmp}"
REMOTE_APP="${DEPLOY_REMOTE_APP:-/opt/zhuanfang/app}"
REMOTE_ROOT="$(dirname "$REMOTE_APP")"

chmod +x "$ROOT/scripts/pack_lighthouse.sh"
bash "$ROOT/scripts/pack_lighthouse.sh" "$ROOT"

TARBALL="$ROOT/zhuanfang-deploy.tgz"
SUM="$ROOT/zhuanfang-deploy.tgz.sha256"
test -f "$TARBALL"
test -f "$SUM"

echo "==> upload $TARBALL → $HOST:$REMOTE_TMP/"
scp -o BatchMode=yes "$TARBALL" "$SUM" "$HOST:$REMOTE_TMP/"

echo "==> extract, restore env, rebuild"
# shellcheck disable=SC2029
ssh -o BatchMode=yes "$HOST" "REMOTE_TMP=$(printf %q "$REMOTE_TMP") REMOTE_APP=$(printf %q "$REMOTE_APP") REMOTE_ROOT=$(printf %q "$REMOTE_ROOT") bash -s" <<'REMOTE'
set -euo pipefail
test -f "$REMOTE_TMP/zhuanfang-deploy.tgz"
test -f "$REMOTE_APP/.env.production.local"
cd "$REMOTE_TMP"
sha256sum -c zhuanfang-deploy.tgz.sha256
cp -a "$REMOTE_APP/.env.production.local" "$REMOTE_TMP/zhuanfang.env.bak"
mkdir -p "$REMOTE_ROOT"
tar -xzf "$REMOTE_TMP/zhuanfang-deploy.tgz" -C "$REMOTE_ROOT"
cp -a "$REMOTE_TMP/zhuanfang.env.bak" "$REMOTE_APP/.env.production.local"
chmod 600 "$REMOTE_APP/.env.production.local"
chmod +x "$REMOTE_APP/deploy/prod/scripts/"*.sh || true
export ZHUANFANG_REPO_DIR="$REMOTE_APP"
bash "$REMOTE_APP/deploy/prod/scripts/deploy.sh"
REMOTE

echo "deploy_lighthouse done"

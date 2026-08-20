#!/usr/bin/env bash
# Run VOICE-* pack on the demo HOST with system Google Chrome.
# Does not install browsers into app-zhuanfang-1. Never RESET_ALL_DATA.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="${VOICE_EVAL_DIR:-/tmp/zhuanfang-voice-eval}"
ENVF="${EVAL_ENV_FILE:-/opt/zhuanfang/app/.env.eval.local}"
PRODENV="${PROD_ENV_FILE:-/opt/zhuanfang/app/.env.production.local}"

mkdir -p "$WORK/scripts" "$WORK/docs/superpowers/eval/samples/simulated"
rm -rf "$WORK/scripts/eval"
cp -a "$ROOT/scripts/eval" "$WORK/scripts/eval"
cp -a "$ROOT/scripts/gen-voice-fixtures.mjs" "$WORK/scripts/gen-voice-fixtures.mjs"
cat > "$WORK/package.json" <<'JSON'
{ "name": "zhuanfang-voice-eval", "private": true, "type": "module" }
JSON

AUTH=$(docker exec app-zhuanfang-1 printenv PRODUCT_AUTH_ENABLED || true)
SCOPED=$(docker exec app-zhuanfang-1 printenv PRODUCT_USER_SCOPED_STATE || true)
set -a
# shellcheck disable=SC1090
. "$ENVF"
set +a
DASHSCOPE_API_KEY=$(docker exec app-zhuanfang-1 printenv DASHSCOPE_API_KEY 2>/dev/null || true)
BAILIAN_API_KEY=$(docker exec app-zhuanfang-1 printenv BAILIAN_API_KEY 2>/dev/null || true)
echo "key_lens dashscope=${#DASHSCOPE_API_KEY} bailian=${#BAILIAN_API_KEY}"

export EVAL_API_BASE="${EVAL_API_BASE:-https://zhuanfang.qing.blue}"
export EVAL_USERNAME="${EVAL_USERNAME:-eval_sim}"
export EVAL_PASSWORD="${EVAL_SIM_PASSWORD:?missing EVAL_SIM_PASSWORD}"
export EVAL_WITNESS_USERNAME="${EVAL_WITNESS_USERNAME:-eval_witness}"
export EVAL_WITNESS_PASSWORD="${EVAL_WITNESS_PASSWORD:?missing EVAL_WITNESS_PASSWORD}"
export EVAL_TIER=full
export EVAL_MODALITY=voice
export EVAL_SKIP_TEXT=1
export EVAL_WRAPPING_AUTH="$AUTH"
export EVAL_WRAPPING_SCOPED="$SCOPED"
export EVAL_TTS_LOCAL=1
# Prefer Playwright's Chromium (matches tests/e2e fakeMic). Chrome channel is fallback.
unset EVAL_CHROME_CHANNEL || true
export EVAL_VOICE_IDS="${EVAL_VOICE_IDS:-}"
export DASHSCOPE_API_KEY="${DASHSCOPE_API_KEY:-}"
export BAILIAN_API_KEY="${BAILIAN_API_KEY:-}"
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
unset PRODUCT_API_TOKEN || true

cd "$WORK"
if [ ! -d node_modules/playwright ]; then
  npm install --no-audit --no-fund playwright@1.60.0 ws --registry=https://registry.npmmirror.com
fi
if [ ! -d "$HOME/.cache/ms-playwright" ] && [ ! -d /tmp/ms-playwright ]; then
  export PLAYWRIGHT_BROWSERS_PATH=/tmp/ms-playwright
  PLAYWRIGHT_DOWNLOAD_HOST="${PLAYWRIGHT_DOWNLOAD_HOST:-https://npmmirror.com/mirrors/playwright}" \
    npx playwright install chromium || npx playwright install chromium
fi
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/tmp/ms-playwright}"

if ! command -v espeak-ng >/dev/null || ! command -v sox >/dev/null; then
  sudo apt-get install -y espeak-ng sox >/tmp/espeak-install.log
fi
espeak-ng --version | head -1
sox --version | head -1
echo "starting voice eval on host chrome"
node scripts/eval/run.mjs
echo "voice eval finished"
ls -lt docs/superpowers/eval/samples/simulated | head

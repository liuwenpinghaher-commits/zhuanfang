#!/usr/bin/env bash
# Pack the lighthouse deploy tree. Shared by scripts/deploy_lighthouse.sh and GHA.
# Never include secrets. Keep src/features/memory. Drop AppleDouble / .DS_Store.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export COPYFILE_DISABLE=1
export COPY_EXTENDED_ATTRIBUTES_DISABLE=1

OUT_DIR="${1:-.}"
ARTIFACT_DIR="${PACK_ARTIFACT_DIR:-.deploy-artifact}"
TARBALL="${OUT_DIR%/}/zhuanfang-deploy.tgz"

rm -rf "$ARTIFACT_DIR"
mkdir -p "$ARTIFACT_DIR" "$(dirname "$TARBALL")"

rsync -a \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude '**/.venv' \
  --exclude '**/__pycache__' \
  --exclude '.data' \
  --exclude 'playwright-report' \
  --exclude 'test-results' \
  --exclude 'tests' \
  --exclude '**/*.test.ts' \
  --exclude '**/*.test.tsx' \
  --exclude '.codegraph' \
  --exclude '*.zip' \
  --exclude '.env' \
  --exclude '.env.local' \
  --exclude '.env.production.local' \
  --exclude '/memory' \
  --exclude '.superpowers' \
  --exclude 'agent' \
  --exclude '.deploy-artifact' \
  --exclude 'zhuanfang-deploy.tgz' \
  --exclude 'zhuanfang-deploy.tgz.sha256' \
  --exclude '._*' \
  --exclude '.DS_Store' \
  --exclude 'interview-materials-private' \
  ./ "$ARTIFACT_DIR/app/"

# AppleDouble / Finder junk must never reach Surreal schema apply.
find "$ARTIFACT_DIR/app" \( -name '._*' -o -name '.DS_Store' \) -delete

rm -f "$ARTIFACT_DIR/app/.env" \
      "$ARTIFACT_DIR/app/.env.local" \
      "$ARTIFACT_DIR/app/.env.production.local"

MEMORY_VIEW="$ARTIFACT_DIR/app/src/features/memory/MemoryGovernanceView.tsx"
if [ ! -f "$MEMORY_VIEW" ]; then
  echo "pack failed: missing $MEMORY_VIEW (do not exclude src/features/memory)" >&2
  exit 1
fi

if [ -e "$ARTIFACT_DIR/app/interview-materials-private" ]; then
  echo "pack failed: interviewee docs leaked into artifact" >&2
  exit 1
fi

if find "$ARTIFACT_DIR/app" -name '._*' | grep -q .; then
  echo "pack failed: AppleDouble files still present" >&2
  find "$ARTIFACT_DIR/app" -name '._*' >&2
  exit 1
fi

tar -C "$ARTIFACT_DIR" -czf "$TARBALL" app
# Checksum file must use a basename so remote `sha256sum -c` works after scp.
SUM_FILE="${TARBALL}.sha256"
TARBALL_NAME="$(basename "$TARBALL")"
(
  cd "$(dirname "$TARBALL")"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$TARBALL_NAME"
  else
    shasum -a 256 "$TARBALL_NAME"
  fi
) | tee "$SUM_FILE"
ls -lh "$TARBALL"
echo "packed $TARBALL"

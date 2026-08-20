#!/usr/bin/env bash
# Populate-only 10-persona battery. NOT the capability eval.
# Capability eval: node scripts/eval/run.mjs (EVAL_TIER=smoke|full).
#
# This script never issues a bare curl POST /api/state/purge.
# Purge requires EVAL_TIER=populate + EVAL_ALLOW_PURGE=1 + eval session login
# (handled inside run-interview.mjs). Without cookies, this shell exits non-zero.
set -uo pipefail
cd "$(dirname "$0")/.."

if [ -n "${PRODUCT_API_TOKEN:-}" ]; then
  echo '{"event":"eval_token_refused","reason":"PRODUCT_API_TOKEN_present"}'
  exit 2
fi

if [ "${EVAL_TIER:-}" != "populate" ]; then
  echo "run-all-interviews.sh is populate-only. Use: node scripts/eval/run.mjs"
  echo "Refusing default 20k cooperative battery."
  exit 2
fi

API="${EVAL_API_BASE:-${PRODUCT_API_BASE:-http://127.0.0.1:3210}}"
case "$API" in
  *qing.blue*)
    if [ -z "${EVAL_USERNAME:-}" ] || [ -z "${EVAL_PASSWORD:-}" ]; then
      echo '{"event":"eval_purge_blocked","reason":"qing_blue_requires_eval_login"}'
      exit 2
    fi
    ;;
esac

# Never curl purge. Cookie-less purge is forbidden.
if [ "${EVAL_ALLOW_PURGE:-0}" = "1" ] && [ -z "${EVAL_USERNAME:-}" ]; then
  echo '{"event":"eval_purge_blocked","reason":"eval_session_login_required"}'
  exit 2
fi

OUT=/tmp/interviews
mkdir -p "$OUT"
TARGET="${TARGET_CHARS:-20000}"

echo "MODE = POPULATE (no shell purge; run-interview.mjs honors EVAL_ALLOW_PURGE + login)"

for p in scripts/personas/*.json; do
  n=$(basename "$p" .json)
  echo ""
  echo "################ $n ################"
  if node scripts/run-interview.mjs "$p" "$OUT/$n.json" "$TARGET"; then
    echo "---- analyzing $n ----"
    node scripts/analyze-interview.mjs "$OUT/$n.json" "$OUT/$n-report.json" || echo "ANALYZE FAILED: $n"
  else
    echo "INTERVIEW FAILED: $n"
  fi
done

echo ""
echo "################ SUMMARY ################"
node -e '
const fs=require("fs");
const files=fs.readdirSync("/tmp/interviews").filter(f=>f.endsWith("-report.json")).sort();
let rows=[];
for(const f of files){
  try{const r=JSON.parse(fs.readFileSync("/tmp/interviews/"+f,"utf8"));
    rows.push({persona:r.persona.name, chars:r.hardMetrics.chars, met20k:r.hardMetrics.targetMet,
      iv:r.interviewQuality.total+"/60", asset:r.assetQuality.total+"/20",
      degraded:r.hardMetrics.stateDegradedEvents, repeats:r.hardMetrics.repeatedQuestionPrefixes,
      aside:r.hardMetrics.asideLeakInQuestions, assets:JSON.stringify(r.assetCounts).slice(0,80)});
  }catch(e){rows.push({persona:f, error:e.message});}
}
console.table(rows);
console.log("populate complete (20k is not a capability-eval pass line)");
'

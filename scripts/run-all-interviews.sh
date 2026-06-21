#!/usr/bin/env bash
# Run all 10 personas end-to-end through the REAL system: each runs a >=20K-char interview,
# finalizes, then is quality-analyzed. Sequential (shared state). Usage: bash scripts/run-all-interviews.sh
#
# Two modes:
#   ACCUMULATE (default) — purge ONCE at the start, then every interview accumulates into the same
#     state, so 专访档案 + 认知资产库 end up holding ALL 10 interviews. Use this to populate the app.
#   ISOLATE (ISOLATE=1)  — each interview purges to a clean state first, so per-interview quality is
#     measured without cross-contamination. NOTE: only the LAST interview survives in the archive.
set -uo pipefail
cd "$(dirname "$0")/.."
OUT=/tmp/interviews
mkdir -p "$OUT"
TARGET="${TARGET_CHARS:-20000}"
API="${PRODUCT_API_BASE:-http://127.0.0.1:3210}"

if [ "${ISOLATE:-0}" = "1" ]; then
  echo "MODE = ISOLATE (每次专访独立净化；只有最后一次会留在档案里，适合逐次质量测量)"
  # run-interview.mjs purges per-interview by default
else
  echo "MODE = ACCUMULATE (开头清一次，10 次专访累积进同一档案/资产库)"
  curl -fsS -X POST "$API/api/state/purge" -H 'content-type: application/json' \
    -d '{"confirm":"PURGE_PERSONAL_DATA","scope":"all"}' >/dev/null && echo "  initial purge ok"
  export SKIP_PURGE=1  # subsequent interviews skip the per-interview purge → accumulate
fi

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
const ok=rows.filter(r=>!r.error&&r.met20k&&parseInt(r.iv)>=48&&parseInt(r.asset)>=15);
console.log(`\n达标(20K+ & 访谈>=48/60 & 资产>=15/20): ${ok.length}/${rows.length}`);
'

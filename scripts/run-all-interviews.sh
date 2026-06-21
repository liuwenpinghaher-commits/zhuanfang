#!/usr/bin/env bash
# Run all 10 personas end-to-end through the REAL system: each purges to a clean state,
# runs a >=20K-char interview, finalizes, then is quality-analyzed. Sequential (shared state,
# isolated by the per-interview purge). Usage: bash scripts/run-all-interviews.sh
set -uo pipefail
cd "$(dirname "$0")/.."
OUT=/tmp/interviews
mkdir -p "$OUT"
TARGET="${TARGET_CHARS:-20000}"

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

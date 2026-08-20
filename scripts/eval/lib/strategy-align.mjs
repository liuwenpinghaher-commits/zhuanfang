/** strategyTrace vs utterance alignment from driver memory (not post-/end hot state). */
export function lastStrategy(trace) {
  if (!Array.isArray(trace) || !trace.length) return null;
  return trace[trace.length - 1];
}

export function strategiesIn(trace) {
  return (Array.isArray(trace) ? trace : []).map((t) => t?.strategy).filter(Boolean);
}

export function countStrategy(trace, name) {
  return strategiesIn(trace).filter((s) => s === name).length;
}

export function alignScore(trace, assistantTurns, { concept, title } = {}) {
  const names = strategiesIn(trace);
  if (!names.length) return { score: 0, reason: "empty_trace" };
  const blob = (assistantTurns ?? []).join("\n");
  let hits = 0;
  let need = 0;
  for (const s of names) {
    need += 1;
    if (s === "debt_followup" && concept && blob.includes(concept)) hits += 1;
    else if (s === "decision_review" && title && blob.includes(title)) hits += 1;
    else if (s === "concrete_example_probe" && /哪一|什么时候|谁|哪次|哪句/.test(blob)) hits += 1;
    else if (s === "contradiction_review" && /对立|相反|但是/.test(blob)) hits += 1;
    else if (s === "blindspot_probe") hits += 0.5;
    else if (s === "synthesis" && /总结|所以/.test(blob)) hits += 1;
    else hits += 0.3;
  }
  return { score: need ? hits / need : 0, names };
}

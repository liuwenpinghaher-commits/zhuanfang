/**
 * Layer 1 of the cascade turn-taking gate: judge whether the user's transcript
 * reads as a finished thought, purely from Chinese grammar surface cues. Cheap,
 * synchronous, no model. Clear cases resolve here; "ambiguous" escalates to the
 * LLM endpoint (Layer 2). Mirrors the VAD→semantic split used by LiveKit/Pipecat.
 */
export type Completeness = "complete" | "incomplete" | "ambiguous";

// Hanging connectives — almost always followed by more clause.
const TRAILING_CONNECTIVES = [
  "因为", "所以", "但是", "可是", "不过", "然后", "而且", "并且", "比如",
  "就是说", "首先", "其次", "另外", "还有", "如果", "虽然", "由于", "为了", "以及", "于是", "接着"
];
// Discourse fillers when left dangling — speaker is buffering, not done.
const TRAILING_FILLERS = ["那个", "这个", "就是", "呃", "嗯", "怎么说", "那种", "反正", "其实", "然后呢"];
// Single chars that, when sentence-final, almost ALWAYS still need a conjunct/
// object — strong "mid-clause" signal. Kept deliberately small: chars like
// 对/在/为/给 also end complete sentences ("你说得对", "我现在"), so they're
// excluded and fall through to "ambiguous" (let Layer 2 decide).
const TRAILING_REQUIRE_OBJECT = ["和", "跟", "与", "或", "把", "被"];
// Sentence-final particles — strong "done" when at the very end.
const FINAL_PARTICLES = ["吗", "呢", "吧", "啊", "呀", "嘛", "哈", "咯", "啦"];
// Terminal punctuation — done.
const TERMINAL_PUNCT = ["。", "！", "？", "!", "?", "…"];
// Semantic end-of-turn phrases (Layer-1 EoT upgrade) — common "I'm done" closers.
const SEMANTIC_DONE_PHRASES = [
  "就这些", "就这样", "说完了", "我的意思是这样", "大概就是这样", "先这样", "没了", "完毕"
];

export function assessTurnCompleteness(transcript: string): Completeness {
  // Strip trailing soft separators / whitespace (a comma is a pause, not an end).
  const t = transcript.replace(/[，、,\s]+$/u, "").trim();
  if (!t) return "incomplete";

  // Strong "incomplete": ends on a hanging connective or filler word.
  for (const w of [...TRAILING_CONNECTIVES, ...TRAILING_FILLERS]) {
    if (t.endsWith(w)) return "incomplete";
  }
  // Strong "incomplete": last char demands a following object/complement.
  if (TRAILING_REQUIRE_OBJECT.includes(t[t.length - 1])) return "incomplete";

  // Strong "complete": terminal punctuation.
  if (TERMINAL_PUNCT.includes(t[t.length - 1])) return "complete";
  // Strong "complete": ends on a sentence-final particle.
  if (FINAL_PARTICLES.includes(t[t.length - 1])) return "complete";
  // Strong "complete": semantic done phrases.
  for (const w of SEMANTIC_DONE_PHRASES) {
    if (t.endsWith(w)) return "complete";
  }

  // No clear surface signal → let the LLM endpoint decide.
  return "ambiguous";
}

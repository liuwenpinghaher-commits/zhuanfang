/**
 * Adversarial guest: scripted `text` is canonical; LLM only fills unspecified turns.
 * Cooperative 250–500 char answers are populate-only.
 */
const COUNSELOR_PATTERN_RES = [
  /你提到了[\s\S]{0,40}这听起来/,
  /在这个过程中有没有遇到过什么挑战/,
  /效果怎么样呢/,
  /是怎么处理的呢/,
  /那在这个过程中/,
  /听起来(你|好像|似乎)/
];

export { COUNSELOR_PATTERN_RES };

export function matchBehavior(behaviors, turnIndex) {
  const list = Array.isArray(behaviors) ? behaviors : [];
  for (const b of list) {
    if (behaviorMatches(b.at, turnIndex)) return b;
  }
  return null;
}

function behaviorMatches(at, turnIndex) {
  if (at == null) return false;
  const s = String(at).replace(/\s/g, "");
  const mEq = s.match(/^turn==(\d+)$/);
  if (mEq) return turnIndex === Number(mEq[1]);
  const mGe = s.match(/^turn>=(\d+)$/);
  if (mGe) return turnIndex >= Number(mGe[1]);
  if (s === `turn==${turnIndex}` || Number(at) === turnIndex) return true;
  return false;
}

const CANNED = {
  short_answer: "就那样吧，不好说。",
  hesitation: "那个……我再想想。",
  topic_contract: "就那样。",
  shame_contract: "这个……算了不说了。",
  do_not_write: "刚才那段别写进档案。",
  self_correction: "不对，刚才说错了，其实是我自己先松的口。",
  contradict_past: "现场其实比远程重要得多，我以前那套想反了。",
  abstract: "授权这事儿吧，得看整体情况，很难一句话说清。",
  insight: "后来那次例会上，三月三号老陈把权限表拍桌上，我才改口。",
  tension_side: "我选短期把控，代价是团队继续等我拍板。"
};

export function canonicalUtterance(behavior, turnIndex, { lastHost, seed } = {}) {
  if (behavior?.text) return String(behavior.text);
  if (behavior?.kind === "short_answer") {
    const cap = Number(behavior.maxChars ?? 40);
    const raw = CANNED.short_answer;
    return raw.slice(0, Math.max(8, cap));
  }
  if (behavior?.kind && CANNED[behavior.kind]) return CANNED[behavior.kind];
  if (turnIndex === 0) return seed || CANNED.abstract;
  if (lastHost && /为什么|哪一|什么时候|谁/.test(lastHost)) return CANNED.insight;
  return CANNED.short_answer;
}

export async function guestReply({ scenario, turnIndex, lastHost, history, env, guestCalls }) {
  const behavior = matchBehavior(scenario.guest?.behaviors, turnIndex);
  if (behavior?.text || behavior?.kind) {
    return { text: canonicalUtterance(behavior, turnIndex, { lastHost, seed: scenario.guest?.seed }), behavior, via: "script" };
  }
  const key = String(env?.DASHSCOPE_API_KEY ?? "").trim();
  const max = Number(env?.GUEST_MAX_CALLS_PER_RUN ?? 40);
  if (!key || guestCalls.count >= max) {
    return { text: canonicalUtterance({ kind: "short_answer", maxChars: 36 }, turnIndex, { lastHost }), behavior, via: "canned" };
  }
  guestCalls.count += 1;
  const model = env.INTERVIEWEE_MODEL || "qwen-plus";
  const url = `${env.BAILIAN_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1"}/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content:
            "你是不配合的受访者：短答、含糊、会收缩。不要写 250 字配合稿。每次最多 80 字。不要给建议清单。"
        },
        ...(history ?? []).slice(-6),
        { role: "user", content: `主持人问：${lastHost ?? "请继续"}` }
      ],
      temperature: 0.7,
      max_tokens: 180
    }),
    signal: AbortSignal.timeout(60000)
  });
  if (!res.ok) {
    return { text: canonicalUtterance({ kind: "short_answer" }, turnIndex), behavior, via: "canned-fallback" };
  }
  const j = await res.json();
  const text = j.choices?.[0]?.message?.content?.trim() || CANNED.short_answer;
  return { text: text.slice(0, 120), behavior, via: "llm" };
}

export function isCounselorPattern(text) {
  return COUNSELOR_PATTERN_RES.some((re) => re.test(String(text ?? "")));
}

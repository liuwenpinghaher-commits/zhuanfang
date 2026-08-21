/**
 * Open-the-book checks for a short voice interview. Asks what a reader sees,
 * not whether a scenario id string appeared.
 */

function textOf(turns, role) {
  return (turns ?? [])
    .filter((t) => t.role === role)
    .map((t) => String(t.content ?? "").trim())
    .filter(Boolean);
}

function isRepeatedSentence(text) {
  const t = String(text ?? "").replace(/\s+/g, "");
  if (t.length < 12) return false;
  const mid = Math.floor(t.length / 2);
  const a = t.slice(0, mid).replace(/[，。,.]+$/g, "");
  const b = t.slice(mid).replace(/^[，。,.]+/g, "");
  return a.length >= 8 && a === b;
}

function isThinHost(text) {
  const t = String(text ?? "").replace(/\s+/g, "");
  if (!t) return true;
  if (t.length < 8) return true;
  return /^(好[，,]?你说|嗯+|请继续|你说|继续说|再说)[。！.]*$/.test(t);
}

function titleLooksLikeTestId(title) {
  return /VOICE-|ADV-|CLOCK-|FLOW-/.test(String(title ?? ""));
}

export function assessVoiceBook({ scenario, session, turns, voice }) {
  const id = scenario?.id ?? "";
  const user = textOf(turns, "user");
  const assistant = textOf(turns, "assistant");
  const title = session?.title || session?.card?.title || "";
  const doubled = user.some(isRepeatedSentence);
  const storyHost = assistant[0] ?? "";
  const thinHost = assistant.length === 0 || isThinHost(storyHost);
  const notes = [];

  if (titleLooksLikeTestId(title)) notes.push("题目还是测试编号");
  if (doubled) notes.push("人的那句整句写了两遍");
  if (assistant.length === 0) notes.push("没有主持人回问");
  else if (thinHost) notes.push("主持人只客套接话，没追这件事");

  let echoOk = true;
  let bargeOk = true;
  let endpointOk = true;

  if (id === "VOICE-echo") {
    echoOk = Boolean(voice?.echoSpokeEarly) && voice?.echoCreatedTurn !== true && user.length >= 1 && !thinHost && !doubled;
    if (!voice?.echoSpokeEarly) notes.push("开场说话时没有插话，回声没测到");
    if (voice?.echoCreatedTurn) notes.push("开场那一下进了书");
  }
  if (id === "VOICE-endpoint") {
    endpointOk = user.length === 1 && !doubled && assistant.length >= 1;
    if (user.length !== 1) notes.push(`说完停切成了 ${user.length} 轮`);
  }
  if (id === "VOICE-barge") {
    const joined = user.join(" ");
    bargeOk = Boolean(voice?.bargeAttempted) && /救火|授权/.test(joined) && /打断/.test(joined) && !titleLooksLikeTestId(title);
    if (!voice?.bargeAttempted) notes.push("不是在主持人说话时插的");
    if (!/救火|授权/.test(joined)) notes.push("打断场里没有救火那句");
  }

  const pass = !doubled && assistant.length >= 1 && !titleLooksLikeTestId(title) && echoOk && endpointOk && bargeOk && !thinHost;
  return {
    pass,
    doubled,
    thinHost,
    title,
    user,
    assistant,
    echoOk,
    endpointOk,
    bargeOk,
    notes
  };
}

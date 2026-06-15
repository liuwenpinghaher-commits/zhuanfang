import { describe, expect, it } from "vitest";
import { buildInterviewGuide, createInitialProductState } from "../../../../src/domain/engine";
import type { BailianChatClient } from "../providers/bailian";
import { synthesizeInterviewCard } from "./interview-card-llm";

const mockChat = (json: string): BailianChatClient => ({
  async complete() {
    return json;
  }
});

describe("synthesizeInterviewCard", () => {
  it("maps LLM JSON fields to SynthesizedCard", async () => {
    const state = createInitialProductState();
    const guide = buildInterviewGuide(state);
    const payload = {
      whyNow: "最近搬家的不安反复出现，是时候说清楚。",
      suggestedOpening: "你最担心在新城市失去的是什么？",
      potentialTension: "你既想融入新环境，又不想放弃原来的圈子。",
      likelyOutputs: ["一个关于归属感的长期问题", "一条关于适应期的观察"]
    };

    const result = await synthesizeInterviewCard(state, guide, mockChat(JSON.stringify(payload)));

    expect(result.whyNow).toBe(payload.whyNow);
    expect(result.suggestedOpening).toBe(payload.suggestedOpening);
    expect(result.potentialTension).toBe(payload.potentialTension);
    expect(result.likelyOutputs).toEqual(payload.likelyOutputs);
  });

  it("falls back suggestedOpening to guide value when LLM omits it", async () => {
    const state = createInitialProductState();
    const guide = buildInterviewGuide(state);
    const payload = {
      whyNow: "今天适合聊这个。",
      // suggestedOpening intentionally missing
      potentialTension: "一些张力。",
      likelyOutputs: []
    };

    const result = await synthesizeInterviewCard(state, guide, mockChat(JSON.stringify(payload)));

    expect(result.whyNow).toBe("今天适合聊这个。");
    // Falls back to guide's suggestedOpening
    expect(result.suggestedOpening).toBe(guide.suggestedOpening);
  });

  it("throws when LLM returns malformed JSON", async () => {
    const state = createInitialProductState();
    const guide = buildInterviewGuide(state);

    await expect(
      synthesizeInterviewCard(state, guide, mockChat("not valid json"))
    ).rejects.toThrow();
  });

  it("throws when LLM returns JSON object missing whyNow", async () => {
    const state = createInitialProductState();
    const guide = buildInterviewGuide(state);
    const payload = { suggestedOpening: "开场。", potentialTension: "张力。", likelyOutputs: [] };

    await expect(
      synthesizeInterviewCard(state, guide, mockChat(JSON.stringify(payload)))
    ).rejects.toThrow("card synthesis missing whyNow");
  });
});

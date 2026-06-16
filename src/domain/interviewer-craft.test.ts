import { describe, expect, it } from "vitest";
import { INTERVIEWER_CRAFT_RULES, buildVoiceOpeningDiscipline } from "./interviewer-craft";
import type { InterviewCard } from "./types";

describe("interviewer craft", () => {
  it("craft rules cover the张小珺 techniques", () => {
    const t = INTERVIEWER_CRAFT_RULES;
    expect(t).toContain("每次只问一个核心问题");
    expect(t).toContain("具体");
    expect(t).toContain("二选一");
    expect(t).toContain("矛盾");
    expect(t).toContain("很难说");
    expect(t).toMatch(/总结|小结/);
  });
  it("opening discipline forbids small-talk and scripts the suggestedOpening", () => {
    const card = { suggestedOpening: "如果你允许短期失控，最坏会发生什么？" } as InterviewCard;
    const d = buildVoiceOpeningDiscipline(card);
    expect(d).toContain("如果你允许短期失控");
    expect(d).toContain("不寒暄");
    expect(d).toMatch(/你好吗|最近怎么样|刚来/);
    expect(d).toMatch(/跟踪点|续接|接着/);
  });
});

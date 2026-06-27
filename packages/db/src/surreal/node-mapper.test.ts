import { describe, it, expect } from "vitest";
import { NODE_MAPPINGS, toRecord, fromRecord, mappingFor } from "./node-mapper";

describe("node-mapper", () => {
  it("point 往返:核心字段 + rest 无损", () => {
    const m = mappingFor("points")!;
    const entity = {
      id: "pt_1", title: "标题", content: "内容", status: "稳定观点",
      confidence: "用户确认", evidence: ["e1"], relatedThemeIds: ["th_1"],
      important: true, updatedAt: "2026-06-27T00:00:00.000Z", sourceSessionId: "se_1"
    };
    const rec = toRecord(entity, m);
    expect(rec.status).toBe("稳定观点");            // 核心列(受 ASSERT)
    expect((rec.rest as Record<string, unknown>).evidence).toEqual(["e1"]); // 非核心进 rest
    expect((rec.rest as Record<string, unknown>).updatedAt).toBe("2026-06-27T00:00:00.000Z"); // 日期进 rest
    expect("id" in rec).toBe(false);               // id → 记录 id,不作字段
    const back = fromRecord("pt_1", rec);
    expect(back).toEqual(entity);                   // 完整无损
  });

  it("覆盖全部 12 本体映射", () => {
    expect(NODE_MAPPINGS.map((x) => x.stateKey).sort()).toEqual(
      ["debts","decisions","importSources","memoryCandidates","memoryRecords","notes","points","questions","ragChunks","searchBriefs","sessions","themes"].sort()
    );
  });
});

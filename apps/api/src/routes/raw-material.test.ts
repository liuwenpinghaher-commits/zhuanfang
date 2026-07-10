import { describe, it, expect } from "vitest";
import { offloadCompletedSession } from "./raw-material";
import { createInitialProductState } from "../../../../src/domain/engine";
import { buildApiServer } from "../server";

describe("offloadCompletedSession", () => {
  it("把指定会话的 turns/strategyTrace 抽成冷层载荷,热 state 剥离并打标", () => {
    const base = createInitialProductState();
    const state = { ...base, sessions: [{
      id: "s1", title: "t", mode: "daily", strength: "standard", status: "completed",
      startedAt: "2026-06-21T00:00:00.000Z", turns: [
        { id: "t1", role: "user", content: "原话", intent: "", timestamp: "2026-06-21T00:00:00.000Z" }
      ], strategyTrace: [], card: {} as any, guide: {} as any
    } as any] };
    const { hotState, material } = offloadCompletedSession(state, "s1");
    expect(material?.turns).toHaveLength(1);
    const s = hotState.sessions.find((x) => x.id === "s1")!;
    expect(s.turns).toHaveLength(0);
    expect(s.rawMaterialOffloaded).toBe(true);
  });
  it("会话不存在 → material undefined,hotState 原样", () => {
    const state = createInitialProductState();
    const { hotState, material } = offloadCompletedSession(state, "nope");
    expect(material).toBeUndefined();
    expect(hotState).toBe(state);
  });
});

describe("POST /api/admin/offload-completed", () => {
  it("回填锚点 + 降冷所有已完成会话,turns 移入冷层,memoryRecord 带回锚点", async () => {
    const server = buildApiServer({ env: {} });
    const base = (await server.inject({ method: "GET", url: "/api/state" })).json();
    const injected = {
      ...base,
      sessions: [
        {
          id: "s1",
          title: "t",
          mode: "daily",
          strength: "standard",
          status: "completed",
          startedAt: "2026-06-21T00:00:00.000Z",
          completedAt: "2026-06-21T00:10:00.000Z",
          turns: [
            { id: "t2", role: "user", content: "其实是怕我自己不再被需要。", intent: "", timestamp: "2026-06-21T00:00:00.000Z" }
          ],
          strategyTrace: [],
          card: {},
          guide: {}
        }
      ],
      memoryRecords: [
        {
          id: "m1",
          text: "怕不再被需要",
          status: "confirmed",
          sourceType: "interview",
          sourceId: "s1",
          evidenceQuote: "其实是怕我自己不再被需要。",
          createdAt: "2026-06-21T00:00:00.000Z",
          updatedAt: "2026-06-21T00:00:00.000Z"
        }
      ]
    };
    const imp = await server.inject({
      method: "POST",
      url: "/api/state/import",
      // F-04:裸 state(无 rawMaterials/audios)的 legacy 导入现在必须显式声明冷层模式。
      // 本测试随后要把 turns 降冷进全新的冷层,replace-all(清空冷层)正是干净起点语义。
      payload: { confirm: "REPLACE_ALL_STATE", state: injected, coldLayerMode: "replace-all" }
    });
    expect(imp.statusCode).toBe(200);

    const res = await server.inject({ method: "POST", url: "/api/admin/offload-completed" });
    expect(res.statusCode).toBe(200);
    expect(res.json().offloaded).toBeGreaterThanOrEqual(1);

    const after = (await server.inject({ method: "GET", url: "/api/state" })).json();
    const s1 = after.sessions.find((x: { id: string }) => x.id === "s1");
    expect(s1.turns).toHaveLength(0);
    expect(s1.rawMaterialOffloaded).toBe(true);
    expect(after.memoryRecords[0].evidenceAnchors).toEqual([{ sessionId: "s1", turnId: "t2" }]);

    const raw = await server.inject({ method: "GET", url: "/api/sessions/s1/raw-material" });
    expect(raw.statusCode).toBe(200);
    expect(raw.json().turns).toHaveLength(1);

    await server.close();
  });
});

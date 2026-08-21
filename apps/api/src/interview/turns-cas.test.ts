/**
 * PR-2: persist the guest sentence before the host LLM, CAS the host follow-up,
 * and keep login / other writes moving while a turn is thinking.
 */
import { describe, expect, it } from "vitest";
import { buildApiServer } from "../server";
import { createInitialProductState } from "../../../../src/domain/engine";
import { createInMemoryProductStateRepository } from "../product-state-repository";
import type { BailianCharacterInterviewClient } from "../providers/bailian";

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function hangingInterviewClient(opts?: {
  delta?: string;
  hangMs?: number;
}): BailianCharacterInterviewClient & { release: () => void } {
  let release!: () => void;
  const hang = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    release: () => release(),
    async createAssistantTurn() {
      await hang;
      return {
        providerId: "bailian-character",
        model: "test",
        content: "你刚才那件事具体卡在哪一步？",
        intent: "百炼角色扮演追问"
      };
    },
    async *createAssistantTurnStream({ signal }) {
      if (opts?.delta) {
        yield { type: "delta" as const, text: opts.delta };
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => resolve(), opts?.hangMs ?? 15_000);
        const onAbort = () => {
          clearTimeout(timer);
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        };
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
  };
}

describe("turns CAS persist", () => {
  it("/turns: guest sentence is in the book while the host LLM is still thinking", async () => {
    const repo = createInMemoryProductStateRepository(createInitialProductState());
    const interview = hangingInterviewClient();
    const server = buildApiServer({
      env: {},
      productStateRepository: repo,
      bailianInterviewClient: interview
    });
    await server.ready();
    try {
      const created = (
        await server.inject({ method: "POST", url: "/api/interview-sessions", payload: { mode: "daily" } })
      ).json() as { session: { id: string } };
      const id = created.session.id;
      const turn = server.inject({
        method: "POST",
        url: `/api/interview-sessions/${id}/turns`,
        payload: { content: "授权让我最难受的是那次救火" }
      });
      await tick(80);
      const mid = repo.getState().sessions.find((session) => session.id === id)!;
      expect(mid.turns.some((item) => item.role === "user" && item.content.includes("救火"))).toBe(true);
      expect(mid.turns.some((item) => item.role === "assistant")).toBe(false);

      const login = await Promise.race([
        server.inject({ method: "POST", url: "/api/auth/login", payload: {} }),
        tick(500).then(() => "timeout" as const)
      ]);
      expect(login).not.toBe("timeout");
      expect((login as { statusCode: number }).statusCode).toBe(400);

      const otherSession = await Promise.race([
        server.inject({ method: "POST", url: "/api/interview-sessions", payload: { mode: "daily" } }),
        tick(800).then(() => "timeout" as const)
      ]);
      expect(otherSession).not.toBe("timeout");
      expect((otherSession as { statusCode: number }).statusCode).toBe(200);

      interview.release();
      const done = await turn;
      expect(done.statusCode).toBe(200);
      const after = repo.getState().sessions.find((session) => session.id === id)!;
      expect(after.turns.some((item) => item.role === "assistant")).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("/turns/stream: cancel after a delta keeps the guest sentence and the spoken host half", async () => {
    const repo = createInMemoryProductStateRepository(createInitialProductState());
    const interview = hangingInterviewClient({ delta: "先听这半句" });
    const server = buildApiServer({
      env: {},
      productStateRepository: repo,
      bailianInterviewClient: interview
    });
    await server.ready();
    try {
      const created = (
        await server.inject({ method: "POST", url: "/api/interview-sessions", payload: { mode: "daily" } })
      ).json() as { session: { id: string } };
      const id = created.session.id;
      const stream = server.inject({
        method: "POST",
        url: `/api/interview-sessions/${id}/turns/stream`,
        payload: { content: "授权让我最难受的是那次救火" }
      });
      await tick(80);
      const mid = repo.getState().sessions.find((session) => session.id === id)!;
      expect(mid.turns.some((item) => item.role === "user" && item.content.includes("救火"))).toBe(true);

      const cancel = await server.inject({
        method: "POST",
        url: `/api/interview-sessions/${id}/turns/cancel`,
        payload: {}
      });
      expect(cancel.statusCode).toBe(200);
      expect((cancel.json() as { ok: boolean }).ok).toBe(true);

      const streamed = await stream;
      expect(streamed.statusCode).toBe(200);
      expect(streamed.payload).toContain("user_persisted");
      expect(streamed.payload).toContain("event: aborted");
      const after = repo.getState().sessions.find((session) => session.id === id)!;
      expect(after.turns.some((item) => item.role === "user" && item.content.includes("救火"))).toBe(true);
      expect(after.turns.some((item) => item.role === "assistant" && item.content.includes("先听这半句"))).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("login does not wait behind a hanging session-create embed", async () => {
    let release!: (value: number[][]) => void;
    const hang = new Promise<number[][]>((resolve) => {
      release = resolve;
    });
    const server = buildApiServer({
      env: {},
      embeddingClient: {
        providerId: "hang",
        embed: () => hang
      } as never
    });
    await server.ready();
    try {
      const longWrite = server.inject({
        method: "POST",
        url: "/api/interview-sessions",
        payload: { topicHint: "挂起建场" }
      });
      await tick(40);
      const login = await Promise.race([
        server.inject({ method: "POST", url: "/api/auth/login", payload: {} }),
        tick(500).then(() => "timeout" as const)
      ]);
      expect(login).not.toBe("timeout");
      expect((login as { statusCode: number }).statusCode).toBe(400);
      release([[0.1, 0.2]]);
      const created = await longWrite;
      expect(created.statusCode).toBe(200);
    } finally {
      await server.close();
    }
  });
});

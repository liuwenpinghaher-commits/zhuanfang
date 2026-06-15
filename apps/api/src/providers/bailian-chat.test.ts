import { describe, expect, it } from "vitest";
import { createBailianChatClient } from "./bailian";

describe("createBailianChatClient with telemetry", () => {
  it("returns content and survives a response carrying usage", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({
        choices: [{ message: { content: "你好" } }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
      }), { status: 200 });
    const client = createBailianChatClient({ apiKey: "k", fetchImpl: fetchImpl as never });
    const out = await client.complete({ messages: [{ role: "user", content: "hi" }] });
    expect(out).toBe("你好");
  });

  it("still throws on a non-ok response", async () => {
    const fetchImpl = async () => new Response("bad", { status: 500 });
    const client = createBailianChatClient({ apiKey: "k", fetchImpl: fetchImpl as never });
    await expect(client.complete({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow();
  });
});

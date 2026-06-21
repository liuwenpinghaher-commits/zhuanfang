import { describe, expect, it, vi } from "vitest";
import {
  createBailianStreamingTtsClient,
  type BailianStreamingTtsOptions,
  type WsLike
} from "./bailian-streaming-tts";

// Re-use the wsFactory type from the public options shape
type WsFactory = NonNullable<BailianStreamingTtsOptions["wsFactory"]>;

// ── Mock WebSocket harness ────────────────────────────────────────────────────
// The mock WS is event-driven: the test drives server events via callbacks.
// Pattern mirrors src/realtime/bailianWebsocket.test.ts but adapted for Node
// ws-style (on("message"), on("open"), on("error"), on("close")) rather than
// browser DOM-style onopen/onmessage properties.

type WsEventHandlers = {
  onOpen: () => void;
  onMessage: (data: Buffer | string, isBinary: boolean) => void;
  onError: (err: Error) => void;
  onClose: (code: number, reason: string) => void;
};

type MockWsInstance = {
  sent: string[];
  closed: boolean;
  handlers: Partial<WsEventHandlers>;
  // Simulate server pushing a JSON event
  serverSendJson: (obj: unknown) => void;
  // Simulate server pushing a binary audio chunk
  serverSendBinary: (chunk: Buffer) => void;
  // Simulate WS close from server side
  serverClose: (code?: number, reason?: string) => void;
};

function buildMockWsFactory(): {
  factory: WsFactory;
  instances: MockWsInstance[];
} {
  const instances: MockWsInstance[] = [];

  const factory: WsFactory = (_url: string, _opts: { headers: Record<string, string> }) => {
    const inst: MockWsInstance = {
      sent: [],
      closed: false,
      handlers: {},
      serverSendJson(obj) {
        inst.handlers.onMessage?.(Buffer.from(JSON.stringify(obj)), false);
      },
      serverSendBinary(chunk) {
        inst.handlers.onMessage?.(chunk, true);
      },
      serverClose(code = 1000, reason = "") {
        inst.handlers.onClose?.(code, reason);
      }
    };
    instances.push(inst);

    const wsObj = {
      // Node ws-style event registration — cast via unknown to satisfy WsLike overloads
      on(event: string, handler: (...args: unknown[]) => void) {
        if (event === "open") inst.handlers.onOpen = handler as () => void;
        if (event === "message")
          inst.handlers.onMessage = handler as (data: Buffer | string, isBinary: boolean) => void;
        if (event === "error") inst.handlers.onError = handler as (err: Error) => void;
        if (event === "close") inst.handlers.onClose = handler as (code: number, reason: string) => void;
        return wsObj as unknown as WsLike;
      },
      send(data: string) {
        inst.sent.push(data);
      },
      close() {
        inst.closed = true;
        inst.handlers.onClose?.(1000, "closed by client");
      }
    };
    return wsObj as unknown as WsLike;
  }

  return { factory, instances };
}

// ── Helper: parse sent messages ───────────────────────────────────────────────
function parseSent(inst: MockWsInstance) {
  return inst.sent.map((s) => JSON.parse(s));
}

// ── Tests ─────────────────────────────────────────────────────────────────────
describe("createBailianStreamingTtsClient", () => {
  it("threads prosody (rate/pitch/volume) into the run-task parameters when provided", async () => {
    const { factory, instances } = buildMockWsFactory();
    const client = createBailianStreamingTtsClient({ apiKey: "test-key", wsFactory: factory });
    void client.synthesizeStream(
      { segments: ["你认同这个顺序吗？"], prosody: { rate: 0.9, pitch: 0.96, volume: 46 } },
      { onAudio: vi.fn(), onComplete: vi.fn() }
    );
    await new Promise((r) => setTimeout(r, 0));
    const [inst] = instances;
    inst.handlers.onOpen!();
    await new Promise((r) => setTimeout(r, 0));
    const runTask = parseSent(inst).find((m) => m.header?.action === "run-task");
    expect(runTask.payload.parameters.rate).toBe(0.9);
    expect(runTask.payload.parameters.pitch).toBe(0.96);
    expect(runTask.payload.parameters.volume).toBe(46);
  });

  it("omits prosody params entirely when none is provided (default delivery)", async () => {
    const { factory, instances } = buildMockWsFactory();
    const client = createBailianStreamingTtsClient({ apiKey: "test-key", wsFactory: factory });
    void client.synthesizeStream({ segments: ["你好"] }, { onAudio: vi.fn(), onComplete: vi.fn() });
    await new Promise((r) => setTimeout(r, 0));
    const [inst] = instances;
    inst.handlers.onOpen!();
    await new Promise((r) => setTimeout(r, 0));
    const runTask = parseSent(inst).find((m) => m.header?.action === "run-task");
    expect(runTask.payload.parameters.rate).toBeUndefined();
    expect(runTask.payload.parameters.pitch).toBeUndefined();
  });

  it("sends run-task then continue-task per segment then finish-task, fires onAudio, calls onComplete on task-finished", async () => {
    const { factory, instances } = buildMockWsFactory();
    const client = createBailianStreamingTtsClient({
      apiKey: "test-key",
      wsFactory: factory
    });

    const onAudio = vi.fn();
    const onComplete = vi.fn();

    const synthesisPromise = client.synthesizeStream(
      { segments: ["我理解。", "你继续说。"] },
      { onAudio, onComplete }
    );

    // Let microtasks settle so WS is created and open handler is registered
    await new Promise((r) => setTimeout(r, 0));

    const [inst] = instances;
    expect(inst, "WS instance should be created").toBeTruthy();

    // Trigger WS open
    inst.handlers.onOpen!();

    // Give event loop a tick to process open → run-task send
    await new Promise((r) => setTimeout(r, 0));

    // After open: run-task should have been sent
    const msgs = parseSent(inst);
    const runTask = msgs.find((m) => m.header?.action === "run-task");
    expect(runTask, "run-task should be sent on open").toBeTruthy();
    expect(runTask.payload.model).toBe("cosyvoice-v3-plus");
    expect(runTask.payload.parameters.voice).toBe("longanyang");
    expect(runTask.header.task_id).toBeTruthy();

    // Simulate server: task-started → client should send continue-task per segment + finish-task
    inst.serverSendJson({
      header: { event: "task-started", task_id: runTask.header.task_id }
    });

    await new Promise((r) => setTimeout(r, 0));

    const msgs2 = parseSent(inst);
    const continueTasks = msgs2.filter((m) => m.header?.action === "continue-task");
    expect(continueTasks).toHaveLength(2);
    expect(continueTasks[0].payload.input.text).toBe("我理解。");
    expect(continueTasks[1].payload.input.text).toBe("你继续说。");

    const finishTask = msgs2.find((m) => m.header?.action === "finish-task");
    expect(finishTask, "finish-task should be sent after last segment").toBeTruthy();

    // Simulate server: binary audio chunk → onAudio
    const chunk = Buffer.from([0x49, 0x44, 0x33]);
    inst.serverSendBinary(chunk);
    await new Promise((r) => setTimeout(r, 0));
    expect(onAudio).toHaveBeenCalledWith(chunk);

    // Simulate server: task-finished → onComplete + promise resolves
    inst.serverSendJson({
      header: { event: "task-finished", task_id: runTask.header.task_id }
    });
    await synthesisPromise;
    expect(onComplete).toHaveBeenCalled();
  });

  it("uses custom voice when provided", async () => {
    const { factory, instances } = buildMockWsFactory();
    const client = createBailianStreamingTtsClient({ apiKey: "test-key", wsFactory: factory });

    const p = client.synthesizeStream(
      { segments: ["hello"], voice: "custom-voice-id" },
      { onAudio: vi.fn(), onComplete: vi.fn() }
    );

    await new Promise((r) => setTimeout(r, 0));
    const [inst] = instances;
    inst.handlers.onOpen!();
    await new Promise((r) => setTimeout(r, 0));

    const runTask = parseSent(inst).find((m) => m.header?.action === "run-task");
    expect(runTask?.payload.parameters.voice).toBe("custom-voice-id");

    // Wrap up cleanly
    inst.serverSendJson({ header: { event: "task-started" } });
    await new Promise((r) => setTimeout(r, 0));
    inst.serverSendJson({ header: { event: "task-finished" } });
    await p;
  });

  it("rejects and calls onError when task-failed is received", async () => {
    const { factory, instances } = buildMockWsFactory();
    const client = createBailianStreamingTtsClient({ apiKey: "test-key", wsFactory: factory });

    const onError = vi.fn();
    const p = client.synthesizeStream(
      { segments: ["测试"] },
      { onAudio: vi.fn(), onComplete: vi.fn(), onError }
    );

    await new Promise((r) => setTimeout(r, 0));
    const [inst] = instances;
    inst.handlers.onOpen!();
    await new Promise((r) => setTimeout(r, 0));

    inst.serverSendJson({
      header: { event: "task-failed", error_message: "synthesis failed" }
    });

    await expect(p).rejects.toThrow("synthesis failed");
    expect(onError).toHaveBeenCalled();
  });

  it("sends finish-task and closes on AbortSignal abort, no further onAudio calls", async () => {
    const { factory, instances } = buildMockWsFactory();
    const client = createBailianStreamingTtsClient({ apiKey: "test-key", wsFactory: factory });

    const onAudio = vi.fn();
    const onComplete = vi.fn();
    const controller = new AbortController();

    const p = client.synthesizeStream(
      { segments: ["一", "二", "三"] },
      { onAudio, onComplete },
      controller.signal
    );

    await new Promise((r) => setTimeout(r, 0));
    const [inst] = instances;
    inst.handlers.onOpen!();
    await new Promise((r) => setTimeout(r, 0));

    // Server sends task-started, client sends continue-task + finish-task
    inst.serverSendJson({ header: { event: "task-started" } });
    await new Promise((r) => setTimeout(r, 0));

    // Abort before task-finished
    controller.abort();
    await new Promise((r) => setTimeout(r, 0));

    // After abort: finish-task should be sent and WS should be closed
    const msgs = parseSent(inst);
    const finishTasks = msgs.filter((m) => m.header?.action === "finish-task");
    expect(finishTasks.length).toBeGreaterThanOrEqual(1);
    expect(inst.closed).toBe(true);

    // Any binary audio after abort should NOT trigger onAudio (already closed)
    const beforeCount = onAudio.mock.calls.length;
    inst.serverSendBinary(Buffer.from([0x00]));
    await new Promise((r) => setTimeout(r, 0));
    // The WS is closed so no more messages should be processed
    expect(onAudio.mock.calls.length).toBe(beforeCount);

    // Promise should settle (resolve or reject) after abort
    await p.catch(() => {
      // may resolve or reject after abort — both are acceptable
    });
  });

  it("rejects on WS error event", async () => {
    const { factory, instances } = buildMockWsFactory();
    const client = createBailianStreamingTtsClient({ apiKey: "test-key", wsFactory: factory });

    const p = client.synthesizeStream(
      { segments: ["测试"] },
      { onAudio: vi.fn(), onComplete: vi.fn() }
    );

    await new Promise((r) => setTimeout(r, 0));
    const [inst] = instances;
    inst.handlers.onError!(new Error("connection refused"));

    await expect(p).rejects.toThrow("connection refused");
  });

  // P1-09: a half-dead WS (opens but never emits task-started/audio) must not hang the
  // turn forever. The connect/first-progress timer fails it with "TTS timeout" and
  // closes the socket.
  it("fails with 'TTS timeout' and closes the WS if no progress arrives within connectTimeoutMs", async () => {
    const { factory, instances } = buildMockWsFactory();
    const client = createBailianStreamingTtsClient({
      apiKey: "test-key",
      wsFactory: factory,
      connectTimeoutMs: 10,
      overallTimeoutMs: 10_000
    });

    const onError = vi.fn();
    const p = client.synthesizeStream(
      { segments: ["测试"] },
      { onAudio: vi.fn(), onComplete: vi.fn(), onError }
    );

    await new Promise((r) => setTimeout(r, 0));
    const [inst] = instances;
    inst.handlers.onOpen!();
    // Server stays silent (no task-started, no audio) — simulate the half-dead case.

    await expect(p).rejects.toThrow("TTS timeout");
    expect(inst.closed).toBe(true);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "TTS timeout" }));
  });

  // P1-09: the connect timer must be cleared once real progress arrives, so a normal
  // (if slow) synthesis is NOT killed mid-stream by the first-progress guard.
  it("does not time out after task-started progress within the connect window", async () => {
    const { factory, instances } = buildMockWsFactory();
    const client = createBailianStreamingTtsClient({
      apiKey: "test-key",
      wsFactory: factory,
      connectTimeoutMs: 30,
      overallTimeoutMs: 10_000
    });

    const onComplete = vi.fn();
    const p = client.synthesizeStream(
      { segments: ["测试"] },
      { onAudio: vi.fn(), onComplete }
    );

    await new Promise((r) => setTimeout(r, 0));
    const [inst] = instances;
    inst.handlers.onOpen!();
    // Progress arrives before the connect timer fires → timer must be cleared.
    inst.serverSendJson({ header: { event: "task-started" } });
    // Wait past the (now-cleared) connect window to prove it no longer fires.
    await new Promise((r) => setTimeout(r, 50));
    inst.serverSendJson({ header: { event: "task-finished" } });

    await expect(p).resolves.toBeUndefined();
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});

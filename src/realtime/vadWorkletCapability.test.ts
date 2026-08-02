import { describe, expect, it, vi } from "vitest";
import { probeVadWorkletCapability } from "./vadWorkletCapability";

function makeDeps(overrides: {
  response?: Response;
  audioWorklet?: AudioWorklet;
  withoutAudioWorklet?: boolean;
  addModuleError?: Error;
} = {}) {
  const addModule = vi.fn(async () => {
    if (overrides.addModuleError) throw overrides.addModuleError;
  });
  return {
    fetchImpl: vi.fn(async () => overrides.response ?? new Response("worklet", {
      status: 200,
      headers: { "content-type": "text/javascript" },
    })),
    createAudioContext: () => ({
      audioWorklet: overrides.withoutAudioWorklet
        ? undefined
        : (overrides.audioWorklet ?? { addModule }),
      close: vi.fn(async () => undefined),
    }) as unknown as AudioContext,
  };
}

describe("probeVadWorkletCapability", () => {
  it("HTML fallback 被判定为 degraded 且始终关闭探测 context", async () => {
    const close = vi.fn(async () => undefined);
    const addModule = vi.fn(async () => undefined);
    const result = await probeVadWorkletCapability({
      fetchImpl: vi.fn(async () => new Response("<!doctype html>", {
        headers: { "content-type": "text/html" },
      })),
      createAudioContext: () => ({ audioWorklet: { addModule }, close }) as unknown as AudioContext,
    });

    expect(result).toEqual({ supported: false, reason: "mime" });
    expect(addModule).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("JavaScript MIME 且 addModule 成功时返回 supported", async () => {
    const result = await probeVadWorkletCapability(makeDeps({
      response: new Response("registerProcessor('vad', class {})", {
        status: 200,
        headers: { "content-type": "text/javascript" },
      }),
    }));

    expect(result).toEqual({ supported: true });
  });

  it("非 2xx 返回 fetch 原因", async () => {
    const result = await probeVadWorkletCapability(makeDeps({
      response: new Response("missing", { status: 404 }),
    }));

    expect(result).toEqual({ supported: false, reason: "fetch" });
  });

  it("没有 audioWorklet 返回 unsupported", async () => {
    const result = await probeVadWorkletCapability(makeDeps({ withoutAudioWorklet: true }));

    expect(result).toEqual({ supported: false, reason: "unsupported" });
  });

  it("addModule AbortError 返回 execution", async () => {
    const result = await probeVadWorkletCapability(makeDeps({
      addModuleError: new DOMException("Unable to load", "AbortError"),
    }));

    expect(result).toEqual({ supported: false, reason: "execution" });
  });
});

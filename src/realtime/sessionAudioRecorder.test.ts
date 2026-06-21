// @vitest-environment jsdom
/**
 * sessionAudioRecorder.test.ts
 *
 * TDD for the whole-session MediaRecorder wrapper. jsdom has no MediaRecorder,
 * so we inject a fake recorder via opts.recorderFactory and a fake clock via
 * opts.now. We assert the resolved durationMs, blob size, and mime.
 */
import { describe, it, expect, vi } from "vitest";
import { createSessionAudioRecorder, type MediaRecorderLike } from "./sessionAudioRecorder";

/** Minimal fake MediaRecorder whose data/stop events are fired manually. */
function makeFakeRecorder(mime: string): MediaRecorderLike & { emitData(blob: Blob): void; emitStop(): void } {
  const rec: MediaRecorderLike & { emitData(blob: Blob): void; emitStop(): void } = {
    mimeType: mime,
    state: "inactive",
    ondataavailable: null,
    onstop: null,
    start() {
      this.state = "recording";
    },
    stop() {
      this.state = "inactive";
      // Real MediaRecorder flushes a final dataavailable then onstop; the
      // test drives that explicitly via emitData/emitStop to stay deterministic.
    },
    emitData(blob: Blob) {
      this.ondataavailable?.({ data: blob });
    },
    emitStop() {
      this.onstop?.();
    },
  };
  return rec;
}

const fakeStream = {} as unknown as MediaStream;

describe("createSessionAudioRecorder", () => {
  it("resolves with durationMs, a non-empty blob, and the mime after stop()", async () => {
    let resolvedMime = "";
    const fake = makeFakeRecorder("audio/webm");
    const nowValues = [1000, 4000];
    let nowCall = 0;

    const recorder = createSessionAudioRecorder(fakeStream, {
      // jsdom has no MediaRecorder, so the wrapper resolves the mime via its
      // fallback ("audio/webm"); capture exactly what it hands the factory and
      // assert the resolved mime matches it (no hard-coded codec string).
      recorderFactory: (_s, mime) => {
        resolvedMime = mime;
        fake.mimeType = mime;
        return fake;
      },
      now: () => nowValues[Math.min(nowCall++, nowValues.length - 1)],
    });

    recorder.start();
    expect(fake.state).toBe("recording");

    // Two chunks arrive while recording.
    fake.emitData(new Blob(["chunk-one"], { type: "audio/webm" }));
    fake.emitData(new Blob(["chunk-two-longer"], { type: "audio/webm" }));

    const stopPromise = recorder.stop();
    // The wrapper called recorder.stop(); simulate the browser's final onstop.
    fake.emitStop();

    const result = await stopPromise;

    expect(result.durationMs).toBe(3000); // 4000 - 1000
    expect(result.mime).toBe(resolvedMime);
    expect(result.blob.size).toBeGreaterThan(0);
    expect(result.blob.type).toBe(resolvedMime);
  });

  it("clamps durationMs to >= 0 if the clock goes backwards", async () => {
    const fake = makeFakeRecorder("audio/webm");
    const nowValues = [5000, 1000]; // stop earlier than start (clock skew)
    let nowCall = 0;

    const recorder = createSessionAudioRecorder(fakeStream, {
      recorderFactory: () => fake,
      now: () => nowValues[Math.min(nowCall++, nowValues.length - 1)],
    });

    recorder.start();
    fake.emitData(new Blob(["x"], { type: "audio/webm" }));
    const stopPromise = recorder.stop();
    fake.emitStop();

    const result = await stopPromise;
    expect(result.durationMs).toBe(0);
  });

  it("passes the injected mime straight through when a recorderFactory is supplied", async () => {
    const seen: { stream: MediaStream; mime: string }[] = [];
    const fake = makeFakeRecorder("audio/webm");

    const recorder = createSessionAudioRecorder(fakeStream, {
      recorderFactory: (s, mime) => {
        seen.push({ stream: s, mime });
        fake.mimeType = mime;
        return fake;
      },
      now: () => 0,
    });

    recorder.start();
    const stopPromise = recorder.stop();
    fake.emitStop();
    await stopPromise;

    expect(seen).toHaveLength(1);
    expect(seen[0].stream).toBe(fakeStream);
    // No real MediaRecorder probing in tests — factory receives a concrete mime.
    expect(typeof seen[0].mime).toBe("string");
    expect(seen[0].mime.length).toBeGreaterThan(0);
  });
});

/**
 * Whole-session audio recorder built on MediaRecorder.
 *
 * Records the user's microphone for the full interview so the session audio can
 * be uploaded to the backend at /end. The browser's MediaRecorder is injected in
 * tests (jsdom has none) via opts.recorderFactory; the wall clock is injectable
 * via opts.now so duration assertions are deterministic.
 *
 * Recording is best-effort: callers must treat a failed start/stop/upload as
 * non-fatal — it must never block ending the interview.
 */

/** Minimal MediaRecorder surface this wrapper relies on. */
export interface MediaRecorderLike {
  start(): void;
  stop(): void;
  ondataavailable: ((e: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  mimeType: string;
  state: string;
}

export interface SessionAudioRecorder {
  start(): void;
  stop(): Promise<{ blob: Blob; mime: string; durationMs: number; recordingStartedAt: string }>;
}

export interface CreateSessionAudioRecorderOptions {
  /**
   * Builds the underlying recorder. Injected in tests; in production the default
   * uses the global MediaRecorder. When supplied, the resolved mime is passed in
   * directly (no support-probing) so tests fully control behaviour.
   */
  recorderFactory?: (stream: MediaStream, mime: string) => MediaRecorderLike;
  /** Monotonic clock (ms). Defaults to performance.now(); injectable for tests. */
  now?: () => number;
  /**
   * Wall-clock at start(), as an ISO-8601 string. Defaults to
   * () => new Date().toISOString(); injectable for deterministic tests. This is
   * intentionally a wall clock (not the monotonic `now`): the backend aligns each
   * turn's timestamp against it to seek the right offset in the recording.
   */
  wallClock?: () => string;
}

/** Picks the best supported container/codec, falling back to plain webm. */
function pickMime(): string {
  const MR = (globalThis as { MediaRecorder?: { isTypeSupported?: (t: string) => boolean } }).MediaRecorder;
  if (MR?.isTypeSupported?.("audio/webm;codecs=opus")) {
    return "audio/webm;codecs=opus";
  }
  return "audio/webm";
}

function defaultRecorderFactory(stream: MediaStream, mime: string): MediaRecorderLike {
  const MR = (globalThis as { MediaRecorder?: new (s: MediaStream, opts?: { mimeType?: string }) => MediaRecorderLike }).MediaRecorder;
  if (!MR) {
    throw new Error("MediaRecorder is not available in this environment");
  }
  return new MR(stream, { mimeType: mime });
}

export function createSessionAudioRecorder(
  stream: MediaStream,
  opts: CreateSessionAudioRecorderOptions = {}
): SessionAudioRecorder {
  const now = opts.now ?? (() => performance.now());
  const wallClock = opts.wallClock ?? (() => new Date().toISOString());
  // pickMime() guards its MediaRecorder probe — when a factory is injected (the
  // test path) the probe simply returns the plain "audio/webm" fallback, so the
  // factory still receives a concrete mime without a real MediaRecorder present.
  const mime = pickMime();
  const factory = opts.recorderFactory ?? defaultRecorderFactory;

  const recorder = factory(stream, mime);
  const chunks: Blob[] = [];
  let startTime = 0;
  let recordingStartedAt = "";
  let started = false;

  return {
    start() {
      if (started) return;
      started = true;
      startTime = now();
      recordingStartedAt = wallClock();
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          chunks.push(e.data);
        }
      };
      recorder.start();
    },

    stop(): Promise<{ blob: Blob; mime: string; durationMs: number; recordingStartedAt: string }> {
      return new Promise((resolve) => {
        recorder.onstop = () => {
          resolve({
            blob: new Blob(chunks, { type: mime }),
            mime,
            durationMs: Math.max(0, now() - startTime),
            recordingStartedAt,
          });
        };
        recorder.stop();
      });
    },
  };
}

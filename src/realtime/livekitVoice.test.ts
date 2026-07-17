import { describe, it, expect, vi, beforeEach } from "vitest";
import { createLivekitVoiceSession, type LivekitVoiceCallbacks } from "./livekitVoice";

const mockSetMicrophoneEnabled = vi.fn().mockResolvedValue(undefined);
const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockPublishData = vi.fn().mockResolvedValue(undefined);
const mockModuleLoadState = vi.hoisted(() => ({ count: 0 }));

vi.mock("livekit-client/source", () => {
  mockModuleLoadState.count += 1;
  function MockRoom() {
    return {
      connect: mockConnect,
      disconnect: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      localParticipant: {
        setMicrophoneEnabled: mockSetMicrophoneEnabled,
        publishData: mockPublishData,
        on: vi.fn(),
      },
      remoteParticipants: new Map(),
      state: "disconnected",
    };
  }

  return {
    Room: vi.fn(MockRoom),
    RoomEvent: {
      Connected: "connected",
      Disconnected: "disconnected",
      TrackSubscribed: "trackSubscribed",
      TrackUnsubscribed: "trackUnsubscribed",
      DataReceived: "dataReceived",
      ConnectionStateChanged: "connectionStateChanged",
      ParticipantConnected: "participantConnected",
      TranscriptionReceived: "transcriptionReceived",
      Reconnecting: "reconnecting",
      Reconnected: "reconnected",
    },
    ConnectionState: {
      Connected: "connected",
      Disconnected: "disconnected",
    },
    Track: {
      Kind: { Audio: "audio", Video: "video" },
    },
  };
});

const makeCallbacks = (): LivekitVoiceCallbacks => ({
  onStateChange: vi.fn(),
  onUserTranscript: vi.fn(),
  onAssistantTranscript: vi.fn(),
  onAudioLevel: vi.fn(),
  onError: vi.fn(),
});

describe("createLivekitVoiceSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    mockSetMicrophoneEnabled.mockResolvedValue(undefined);
  });

  it("does not load livekit-client until the LiveKit path is actually selected", () => {
    expect(mockModuleLoadState.count).toBe(0);
  });

  it("resolves with session controls on successful connect", async () => {
    const session = await createLivekitVoiceSession({
      serverUrl: "ws://127.0.0.1:7880",
      token: "test-token",
      interviewSessionId: "test-session-id",
      callbacks: makeCallbacks(),
    });

    expect(session).toHaveProperty("startListening");
    expect(session).toHaveProperty("interrupt");
    expect(session).toHaveProperty("close");
    expect(typeof session.startListening).toBe("function");
    expect(typeof session.interrupt).toBe("function");
    expect(typeof session.close).toBe("function");
  });

  it("calls onError when connection fails", async () => {
    mockConnect.mockRejectedValueOnce(new Error("Connection refused"));

    const callbacks = makeCallbacks();

    await expect(
      createLivekitVoiceSession({
        serverUrl: "ws://127.0.0.1:7880",
        token: "bad-token",
        interviewSessionId: "test",
        callbacks,
      })
    ).rejects.toThrow("Connection refused");

    expect(callbacks.onError).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// P1-7: interrupt() — honest behavior (SDK/architecture limitation annotated)
// ---------------------------------------------------------------------------

describe("createLivekitVoiceSession — P1-7/P1-10: interrupt() behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    mockSetMicrophoneEnabled.mockResolvedValue(undefined);
    mockPublishData.mockResolvedValue(undefined);
  });

  it("interrupt() does not throw synchronously", async () => {
    const session = await createLivekitVoiceSession({
      serverUrl: "ws://127.0.0.1:7880",
      token: "test-token",
      interviewSessionId: "test-session-id",
      callbacks: makeCallbacks(),
    });

    expect(() => session.interrupt()).not.toThrow();
  });

  it("interrupt() returns void (not a Promise)", async () => {
    const session = await createLivekitVoiceSession({
      serverUrl: "ws://127.0.0.1:7880",
      token: "test-token",
      interviewSessionId: "test-session-id",
      callbacks: makeCallbacks(),
    });

    const result = session.interrupt();
    // Should be void/undefined, not a Promise — callers must not await it
    expect(result).toBeUndefined();
  });

  it("interrupt() enables local microphone (minimum effective behavior)", async () => {
    const session = await createLivekitVoiceSession({
      serverUrl: "ws://127.0.0.1:7880",
      token: "test-token",
      interviewSessionId: "test-session-id",
      callbacks: makeCallbacks(),
    });

    session.interrupt();

    // Allow the internal async setMicrophoneEnabled promise to tick
    await new Promise((r) => setTimeout(r, 0));

    expect(mockSetMicrophoneEnabled).toHaveBeenCalledWith(true);
  });

  it("interrupt() does not throw when setMicrophoneEnabled rejects (mic already enabled)", async () => {
    mockSetMicrophoneEnabled.mockRejectedValueOnce(new Error("already enabled"));

    const session = await createLivekitVoiceSession({
      serverUrl: "ws://127.0.0.1:7880",
      token: "test-token",
      interviewSessionId: "test-session-id",
      callbacks: makeCallbacks(),
    });

    expect(() => session.interrupt()).not.toThrow();
    // Allow the rejection to be swallowed internally
    await new Promise((r) => setTimeout(r, 0));
  });

  it("P1-10: interrupt() publishes a reliable interrupt signal on the data channel", async () => {
    const session = await createLivekitVoiceSession({
      serverUrl: "ws://127.0.0.1:7880",
      token: "test-token",
      interviewSessionId: "test-session-id",
      callbacks: makeCallbacks(),
    });

    session.interrupt();

    expect(mockPublishData).toHaveBeenCalledTimes(1);
    const [payload, opts] = mockPublishData.mock.calls[0];
    // Payload is a UTF-8 encoded JSON envelope; decode + parse to assert shape.
    const decoded = JSON.parse(new TextDecoder().decode(payload as Uint8Array));
    expect(decoded.type).toBe("interrupt");
    expect(opts).toMatchObject({ reliable: true });
  });

  it("P1-10: interrupt() does not throw when publishData rejects (agent not ready)", async () => {
    mockPublishData.mockRejectedValueOnce(new Error("no agent"));

    const session = await createLivekitVoiceSession({
      serverUrl: "ws://127.0.0.1:7880",
      token: "test-token",
      interviewSessionId: "test-session-id",
      callbacks: makeCallbacks(),
    });

    expect(() => session.interrupt()).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });
});

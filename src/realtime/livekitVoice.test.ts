import { describe, it, expect, vi, beforeEach } from "vitest";
import { createLivekitVoiceSession, type LivekitVoiceCallbacks } from "./livekitVoice";

const mockConnect = vi.fn().mockResolvedValue(undefined);

vi.mock("livekit-client", () => {
  function MockRoom() {
    return {
      connect: mockConnect,
      disconnect: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      localParticipant: {
        setMicrophoneEnabled: vi.fn().mockResolvedValue(undefined),
        publishData: vi.fn(),
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
      DataReceived: "dataReceived",
      ConnectionStateChanged: "connectionStateChanged",
    },
    ConnectionState: {
      Connected: "connected",
      Disconnected: "disconnected",
    },
  };
});

describe("createLivekitVoiceSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
  });

  it("resolves with session controls on successful connect", async () => {
    const callbacks: LivekitVoiceCallbacks = {
      onStateChange: vi.fn(),
      onUserTranscript: vi.fn(),
      onAssistantTranscript: vi.fn(),
      onAudioLevel: vi.fn(),
      onError: vi.fn(),
    };

    const session = await createLivekitVoiceSession({
      serverUrl: "ws://127.0.0.1:7880",
      token: "test-token",
      interviewSessionId: "test-session-id",
      callbacks,
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

    const callbacks: LivekitVoiceCallbacks = {
      onStateChange: vi.fn(),
      onUserTranscript: vi.fn(),
      onAssistantTranscript: vi.fn(),
      onAudioLevel: vi.fn(),
      onError: vi.fn(),
    };

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

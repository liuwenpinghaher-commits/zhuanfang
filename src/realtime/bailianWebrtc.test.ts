import { describe, expect, it, vi } from "vitest";
import type { RealtimeVoiceSessionResponse } from "../api/productApi";
import { connectBailianRealtimeWebrtc } from "./bailianWebrtc";

describe("bailian realtime WebRTC connector", () => {
  it("opens microphone, sends session.update over the data channel, and exchanges SDP through the Product API", async () => {
    const audioTrack = { kind: "audio", stop: vi.fn() };
    const stream = {
      getTracks: () => [audioTrack]
    };
    const dataChannel = {
      readyState: "open",
      sent: [] as string[],
      send(message: string) {
        this.sent.push(message);
      },
      close: vi.fn()
    };
    const peerConnection = {
      addTrack: vi.fn(),
      createDataChannel: vi.fn(() => dataChannel),
      createOffer: vi.fn(async () => ({ type: "offer" as const, sdp: "offer-sdp" })),
      setLocalDescription: vi.fn(async () => undefined),
      setRemoteDescription: vi.fn(async () => undefined),
      close: vi.fn()
    };
    const peerConnectionFactory = vi.fn(() => peerConnection);
    const mediaDevices = {
      getUserMedia: vi.fn(async () => stream)
    };
    const productApiClient = {
      exchangeRealtimeVoiceSdp: vi.fn(async () => "answer-sdp")
    };
    const session = createRealtimeSession();

    const connection = await connectBailianRealtimeWebrtc(session, {
      mediaDevices,
      peerConnectionFactory,
      productApiClient
    });

    expect(mediaDevices.getUserMedia).toHaveBeenCalledWith({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
    expect(peerConnection.addTrack).toHaveBeenCalledWith(audioTrack, stream);
    expect(peerConnection.createDataChannel).toHaveBeenCalledWith("oai-events");
    expect(productApiClient.exchangeRealtimeVoiceSdp).toHaveBeenCalledWith(
      "/api/realtime-voice/sessions/rtv-test/webrtc/answer",
      "offer-sdp"
    );
    expect(peerConnection.setRemoteDescription).toHaveBeenCalledWith({
      type: "answer",
      sdp: "answer-sdp"
    });
    expect(dataChannel.sent).toEqual([JSON.stringify(session.sessionUpdate)]);

    connection.close();
    expect(dataChannel.close).toHaveBeenCalled();
    expect(peerConnection.close).toHaveBeenCalled();
    expect(audioTrack.stop).toHaveBeenCalled();
  });

  it("waits for the WebRTC data channel to open before sending session.update", async () => {
    let openListener: (() => void) | undefined;
    const stream = {
      getTracks: () => [{ stop: vi.fn() }]
    };
    const dataChannel = {
      readyState: "connecting",
      sent: [] as string[],
      send(message: string) {
        this.sent.push(message);
      },
      close: vi.fn(),
      addEventListener(type: string, listener: () => void) {
        if (type === "open") {
          openListener = listener;
        }
      },
      removeEventListener: vi.fn()
    };
    const peerConnection = {
      addTrack: vi.fn(),
      createDataChannel: vi.fn(() => dataChannel),
      createOffer: vi.fn(async () => ({ type: "offer" as const, sdp: "offer-sdp" })),
      setLocalDescription: vi.fn(async () => undefined),
      setRemoteDescription: vi.fn(async () => undefined),
      close: vi.fn()
    };
    const session = createRealtimeSession();

    const connectionPromise = connectBailianRealtimeWebrtc(session, {
      mediaDevices: { getUserMedia: vi.fn(async () => stream) },
      peerConnectionFactory: vi.fn(() => peerConnection),
      productApiClient: { exchangeRealtimeVoiceSdp: vi.fn(async () => "answer-sdp") }
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dataChannel.sent).toEqual([]);

    dataChannel.readyState = "open";
    openListener?.();

    const connection = await connectionPromise;
    expect(dataChannel.sent).toEqual([JSON.stringify(session.sessionUpdate)]);
    connection.close();
  });
});

function createRealtimeSession(): RealtimeVoiceSessionResponse {
  return {
    provider: "bailian",
    model: "qwen3.5-omni-plus-realtime",
    fallbackModel: "qwen3.5-omni-flash-realtime",
    transport: "webrtc",
    fallbackTransport: "websocket",
    vad: "server_vad",
    enableSearch: false,
    configured: true,
    apiKeyConfigured: true,
    webrtcEndpointConfigured: true,
    requiresServerSession: true,
    sessionId: "rtv-test",
    status: "ready",
    signaling: {
      method: "POST",
      path: "/api/realtime-voice/sessions/rtv-test/webrtc/answer",
      contentType: "application/sdp"
    },
    sessionUpdate: {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        voice: "Ethan",
        input_audio_format: "pcm",
        output_audio_format: "pcm",
        instructions: "你是一个真正的私人专访主持人。",
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          silence_duration_ms: 800
        }
      }
    },
    expiresAt: "2026-06-10T00:10:00.000Z"
  };
}

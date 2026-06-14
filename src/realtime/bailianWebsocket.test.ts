// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { RealtimeVoiceSessionResponse } from "../api/productApi";
import { connectBailianRealtimeWebsocket } from "./bailianWebsocket";

function createWebsocketSession(): RealtimeVoiceSessionResponse {
  return {
    provider: "bailian",
    model: "qwen3.5-omni-plus-realtime",
    fallbackModel: "qwen3.5-omni-flash-realtime",
    transport: "websocket",
    fallbackTransport: "websocket",
    vad: "server_vad",
    enableSearch: false,
    configured: true,
    apiKeyConfigured: true,
    webrtcEndpointConfigured: false,
    requiresServerSession: true,
    sessionId: "rtv-test-ws",
    status: "ready",
    signaling: {
      method: "POST",
      path: "/api/realtime-voice/sessions/rtv-test-ws/webrtc/answer",
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
    expiresAt: "2026-06-15T00:10:00.000Z"
  };
}

describe("connectBailianRealtimeWebsocket", () => {
  it("rejects when session status is not ready", async () => {
    const session = { ...createWebsocketSession(), status: "not-configured" as const };
    await expect(
      connectBailianRealtimeWebsocket(session, {})
    ).rejects.toThrow("not ready");
  });

  it("rejects when transport is not websocket", async () => {
    const session = { ...createWebsocketSession(), transport: "webrtc" as const };
    await expect(
      connectBailianRealtimeWebsocket(session, {})
    ).rejects.toThrow("Unsupported realtime transport");
  });

  it("connects to proxy, sends session.update, and handles audio events", async () => {
    const stream = {
      getTracks: () => [{ kind: "audio", stop: vi.fn() }]
    } as unknown as MediaStream;

    const mediaDevices = {
      getUserMedia: vi.fn(async () => stream)
    };

    let wsOnOpen!: () => void;
    let wsOnMessage!: (event: MessageEvent) => void;
    const wsSent: string[] = [];
    const wsClose = vi.fn();

    const originalWebSocket = (globalThis as Record<string, unknown>).WebSocket;
    (globalThis as Record<string, unknown>).WebSocket = class MockWebSocket {
      readyState: number;
      onopen: (() => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      constructor() {
        this.readyState = WebSocket.CONNECTING;
        wsOnOpen = () => { this.readyState = WebSocket.OPEN; this.onopen?.(); };
        wsOnMessage = (e) => this.onmessage?.(e);
      }
      send(message: string) { wsSent.push(message); }
      close = wsClose;
      addEventListener = vi.fn();
      removeEventListener = vi.fn();
    };

    const audioContext = {
      sampleRate: 16000,
      destination: {},
      createMediaStreamSource: vi.fn(() => ({ disconnect: vi.fn(), connect: vi.fn() })),
      createScriptProcessor: vi.fn(() => ({ disconnect: vi.fn(), connect: vi.fn(), onaudioprocess: null })),
      createBuffer: vi.fn((_ch: number, len: number, _sr: number) => ({
        length: len,
        getChannelData: vi.fn(() => new Float32Array(len))
      })),
      createBufferSource: vi.fn(() => ({
        buffer: null,
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        onended: null
      })),
      close: vi.fn()
    };

    const originalAudioContext = (globalThis as Record<string, unknown>).AudioContext;
    (globalThis as Record<string, unknown>).AudioContext = class MockAudioContext {
      constructor() { return audioContext; }
    };

    const onUserTranscript = vi.fn();
    const onAssistantTranscript = vi.fn();
    const onSpeechStart = vi.fn();
    const onSpeechEnd = vi.fn();

    const connectionPromise = connectBailianRealtimeWebsocket(
      createWebsocketSession(),
      {
        mediaDevices: mediaDevices as unknown as { getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream> },
        productApiBaseUrl: "ws://127.0.0.1:8787",
        onUserTranscript,
        onAssistantTranscript,
        onSpeechStart,
        onSpeechEnd
      }
    );

    await new Promise((r) => setTimeout(r, 10));

    expect(mediaDevices.getUserMedia).toHaveBeenCalledWith({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        sampleRate: 16000,
        channelCount: 1
      }
    });

    wsOnOpen?.();
    wsOnMessage?.(new MessageEvent("message", {
      data: JSON.stringify({ type: "proxy.connected" })
    }));

    const connection = await connectionPromise;
    expect(wsSent).toContain(JSON.stringify(createWebsocketSession().sessionUpdate));

    wsOnMessage?.(new MessageEvent("message", {
      data: JSON.stringify({ type: "input_audio_buffer.speech_started" })
    }));
    expect(onSpeechStart).toHaveBeenCalled();

    wsOnMessage?.(new MessageEvent("message", {
      data: JSON.stringify({ type: "response.audio_transcript.delta", delta: "你好" })
    }));
    expect(onAssistantTranscript).toHaveBeenCalledWith("你好", false);

    wsOnMessage?.(new MessageEvent("message", {
      data: JSON.stringify({ type: "response.audio_transcript.done", transcript: "你好，请问" })
    }));
    expect(onAssistantTranscript).toHaveBeenCalledWith("你好，请问", true);

    connection.close();
    expect(wsClose).toHaveBeenCalled();

    (globalThis as Record<string, unknown>).WebSocket = originalWebSocket;
    (globalThis as Record<string, unknown>).AudioContext = originalAudioContext;
  });
});

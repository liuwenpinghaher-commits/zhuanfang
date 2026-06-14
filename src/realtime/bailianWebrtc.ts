import type { ProductApiClient, RealtimeVoiceSessionResponse } from "../api/productApi";
import type { TurnDetector, TurnDetectorContext, TurnDetectorDecision } from "./turnDetectors";
import { createSilenceVadDetector, SILENCE_VAD_DETECTOR_ID } from "./turnDetectors";

export type TurnPhase = "idle" | "user_speaking" | "short_pause" | "long_pause" | "assistant_speaking" | "interrupted";

export interface TurnState {
  phase: TurnPhase;
  silenceMs: number;
  isUserSpeaking: boolean;
  isAssistantSpeaking: boolean;
  shouldInterrupt: boolean;
  backchannel: string | null;
  detectorId?: string;
  detectorReason?: string;
  detectorConfidence?: number;
  detectorDecision?: TurnDetectorDecision["decision"];
}

export interface TurnStateMachineUpdate {
  inputLevel: number;
  silenceMs: number;
  isAssistantSpeaking?: boolean;
  transcript?: string;
}

export interface TurnStateMachineOptions {
  silenceThresholdMs: number;
  longPauseThresholdMs: number;
  detector?: TurnDetector;
}

export interface TurnStateMachine {
  update(signal: TurnStateMachineUpdate): TurnState;
  getState(): TurnState;
  setAssistantSpeaking(value: boolean): void;
}

export function createTurnStateMachine(options: TurnStateMachineOptions): TurnStateMachine {
  const detector =
    options.detector ??
    createSilenceVadDetector({
      silenceThresholdMs: options.silenceThresholdMs,
      longPauseThresholdMs: options.longPauseThresholdMs
    });

  let phase: TurnPhase = "idle";
  let silenceMs = 0;
  let isUserSpeaking = false;
  let isAssistantSpeaking = false;
  let lastDecision: TurnDetectorDecision | null = null;

  function buildState(): TurnState {
    return {
      phase,
      silenceMs,
      isUserSpeaking,
      isAssistantSpeaking,
      shouldInterrupt: phase === "interrupted",
      backchannel: phase === "short_pause" ? "嗯" : null,
      detectorId: detector.id,
      detectorReason: lastDecision?.reason,
      detectorConfidence: lastDecision?.confidence,
      detectorDecision: lastDecision?.decision
    };
  }

  return {
    update(signal) {
      silenceMs = signal.silenceMs;
      isUserSpeaking = signal.inputLevel > 0.1;
      if (typeof signal.isAssistantSpeaking === "boolean") {
        isAssistantSpeaking = signal.isAssistantSpeaking;
      }

      const ctx: TurnDetectorContext = {
        inputLevel: signal.inputLevel,
        silenceMs: signal.silenceMs,
        isUserSpeaking,
        isAssistantSpeaking,
        transcript: signal.transcript
      };
      lastDecision = detector.evaluate(ctx);

      if (isUserSpeaking && isAssistantSpeaking) {
        phase = "interrupted";
      } else if (isUserSpeaking) {
        phase = "user_speaking";
      } else if (silenceMs < options.silenceThresholdMs) {
        phase = "short_pause";
      } else if (silenceMs < options.longPauseThresholdMs) {
        phase = "long_pause";
      } else if (isAssistantSpeaking) {
        phase = "assistant_speaking";
      } else {
        phase = "idle";
      }

      return buildState();
    },
    getState() {
      return buildState();
    },
    setAssistantSpeaking(value: boolean) {
      isAssistantSpeaking = value;
    }
  };
}

export { SILENCE_VAD_DETECTOR_ID };
export type { TurnDetector, TurnDetectorContext, TurnDetectorDecision } from "./turnDetectors";

interface MediaDevicesLike {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStreamLike>;
}

interface MediaStreamLike {
  getTracks(): MediaStreamTrackLike[];
}

interface MediaStreamTrackLike {
  stop(): void;
}

interface DataChannelLike {
  readyState?: string;
  send(message: string): void;
  close(): void;
  addEventListener?(type: "open" | "close" | "error", listener: () => void): void;
  removeEventListener?(type: "open" | "close" | "error", listener: () => void): void;
}

interface PeerConnectionLike {
  addTrack(track: MediaStreamTrackLike, stream: MediaStreamLike): void;
  createDataChannel(label: string): DataChannelLike;
  createOffer(): Promise<RTCSessionDescriptionInit>;
  setLocalDescription(description: RTCSessionDescriptionInit): Promise<void>;
  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
  close(): void;
}

interface ConnectBailianRealtimeWebrtcOptions {
  mediaDevices?: MediaDevicesLike;
  peerConnectionFactory?: () => PeerConnectionLike;
  productApiClient: ProductApiClientForRealtime;
}

export interface ProductApiClientForRealtime {
  exchangeRealtimeVoiceSdp: ProductApiClient["exchangeRealtimeVoiceSdp"];
  interruptRealtimeVoiceSession?: ProductApiClient["interruptRealtimeVoiceSession"];
}

export interface AssistantSpeechChunk {
  text: string;
  audioMs?: number;
  receivedAt: number;
}

export interface AssistantSpeechProgress {
  turnId?: string;
  providerTurnId?: string;
  startedAt: number;
  chunks: AssistantSpeechChunk[];
  totalChars: number;
  totalAudioMs: number;
  completed: boolean;
}

export interface InterruptAssistantOptions {
  reason?: "user_interrupt" | "provider_error";
  interruptedAtMs?: number;
}

export interface InterruptAssistantResult {
  truncated: boolean;
  spokenChars: number;
  originalChars: number;
  spokenTextSoFar: string;
  reason: "user_interrupt" | "provider_error";
}

export interface BailianRealtimeWebrtcConnection {
  session: RealtimeVoiceSessionResponse;
  stream: MediaStreamLike;
  peerConnection: PeerConnectionLike;
  dataChannel: DataChannelLike;
  beginAssistantTurn(input: { turnId?: string; providerTurnId?: string }): void;
  markAssistantSpeaking(input: { text: string; audioMs?: number }): void;
  completeAssistantTurn(): AssistantSpeechProgress | null;
  getAssistantProgress(): AssistantSpeechProgress | null;
  interruptAssistant(options?: InterruptAssistantOptions): Promise<InterruptAssistantResult | null>;
  close(): void;
}

export async function connectBailianRealtimeWebrtc(
  session: RealtimeVoiceSessionResponse,
  options: ConnectBailianRealtimeWebrtcOptions
): Promise<BailianRealtimeWebrtcConnection> {
  if (session.status !== "ready") {
    throw new Error(`Realtime voice session is not ready: ${session.status}`);
  }
  if (session.transport !== "webrtc") {
    throw new Error(`Unsupported realtime transport: ${session.transport}`);
  }

  const mediaDevices = options.mediaDevices ?? getBrowserMediaDevices();
  const peerConnectionFactory = options.peerConnectionFactory ?? getBrowserPeerConnectionFactory();
  const stream = await mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  });
  const peerConnection = peerConnectionFactory();
  const dataChannel = peerConnection.createDataChannel("oai-events");

  for (const track of stream.getTracks()) {
    peerConnection.addTrack(track, stream);
  }

  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);

  const offerSdp = offer.sdp;
  if (!offerSdp) {
    throw new Error("WebRTC offer did not include SDP.");
  }

  const answerSdp = await options.productApiClient.exchangeRealtimeVoiceSdp(session.signaling.path, offerSdp);
  await peerConnection.setRemoteDescription({ type: "answer", sdp: answerSdp });
  await waitForDataChannelOpen(dataChannel);
  dataChannel.send(JSON.stringify(session.sessionUpdate));

  let progress: AssistantSpeechProgress | null = null;

  function ensureProgress(input: { turnId?: string; providerTurnId?: string } = {}) {
    if (!progress || progress.completed) {
      progress = {
        turnId: input.turnId,
        providerTurnId: input.providerTurnId,
        startedAt: Date.now(),
        chunks: [],
        totalChars: 0,
        totalAudioMs: 0,
        completed: false
      };
    } else {
      if (input.turnId && !progress.turnId) progress.turnId = input.turnId;
      if (input.providerTurnId && !progress.providerTurnId) progress.providerTurnId = input.providerTurnId;
    }
    return progress;
  }

  return {
    session,
    stream,
    peerConnection,
    dataChannel,
    beginAssistantTurn(input) {
      ensureProgress(input);
    },
    markAssistantSpeaking(input) {
      const current = ensureProgress();
      const text = input.text ?? "";
      if (!text) return;
      current.chunks.push({
        text,
        audioMs: input.audioMs,
        receivedAt: Date.now()
      });
      current.totalChars += text.length;
      if (typeof input.audioMs === "number" && input.audioMs > current.totalAudioMs) {
        current.totalAudioMs = input.audioMs;
      }
    },
    completeAssistantTurn() {
      if (!progress) return null;
      progress.completed = true;
      return progress;
    },
    getAssistantProgress() {
      return progress;
    },
    async interruptAssistant(opts = {}) {
      if (!progress || progress.chunks.length === 0) {
        return null;
      }
      const reason = opts.reason ?? "user_interrupt";
      const spokenTextSoFar = progress.chunks.map((chunk) => chunk.text).join("");
      const interruptedAtMs = opts.interruptedAtMs ?? progress.totalAudioMs;
      let result: Awaited<ReturnType<NonNullable<ProductApiClientForRealtime["interruptRealtimeVoiceSession"]>>> | null = null;
      if (typeof options.productApiClient.interruptRealtimeVoiceSession === "function") {
        result = await options.productApiClient.interruptRealtimeVoiceSession(session.sessionId, {
          spokenTextSoFar,
          interruptedAtMs,
          assistantTurnId: progress.turnId,
          providerTurnId: progress.providerTurnId,
          reason
        });
      }
      progress.completed = true;
      return {
        truncated: result?.truncated ?? false,
        spokenChars: result?.spokenChars ?? spokenTextSoFar.length,
        originalChars: result?.originalChars ?? spokenTextSoFar.length,
        spokenTextSoFar,
        reason
      };
    },
    close() {
      dataChannel.close();
      peerConnection.close();
      for (const track of stream.getTracks()) {
        track.stop();
      }
    }
  };
}

function getBrowserMediaDevices(): MediaDevicesLike {
  if (typeof navigator === "undefined" || !navigator.mediaDevices) {
    throw new Error("Browser mediaDevices is not available.");
  }
  return navigator.mediaDevices;
}

function getBrowserPeerConnectionFactory(): () => PeerConnectionLike {
  if (typeof RTCPeerConnection === "undefined") {
    throw new Error("RTCPeerConnection is not available.");
  }
  return () => new RTCPeerConnection() as unknown as PeerConnectionLike;
}

function waitForDataChannelOpen(dataChannel: DataChannelLike, timeoutMs = 5000): Promise<void> {
  if (!dataChannel.readyState || dataChannel.readyState === "open") {
    return Promise.resolve();
  }
  if (dataChannel.readyState === "closed") {
    return Promise.reject(new Error("WebRTC data channel closed before it opened."));
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for WebRTC data channel to open."));
    }, timeoutMs);

    const handleOpen = () => {
      cleanup();
      resolve();
    };
    const handleClosed = () => {
      cleanup();
      reject(new Error("WebRTC data channel closed before it opened."));
    };

    const poll = setInterval(() => {
      if (dataChannel.readyState === "open") {
        handleOpen();
      } else if (dataChannel.readyState === "closed") {
        handleClosed();
      }
    }, 50);

    function cleanup() {
      clearTimeout(timeout);
      clearInterval(poll);
      dataChannel.removeEventListener?.("open", handleOpen);
      dataChannel.removeEventListener?.("close", handleClosed);
      dataChannel.removeEventListener?.("error", handleClosed);
    }

    dataChannel.addEventListener?.("open", handleOpen);
    dataChannel.addEventListener?.("close", handleClosed);
    dataChannel.addEventListener?.("error", handleClosed);
  });
}

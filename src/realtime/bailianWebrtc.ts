import type { ProductApiClient, RealtimeVoiceSessionResponse } from "../api/productApi";

export type TurnPhase = "idle" | "user_speaking" | "short_pause" | "long_pause" | "assistant_speaking" | "interrupted";

export interface TurnState {
  phase: TurnPhase;
  silenceMs: number;
  isUserSpeaking: boolean;
  isAssistantSpeaking: boolean;
  shouldInterrupt: boolean;
  backchannel: string | null;
}

export function createTurnStateMachine(options: {
  silenceThresholdMs: number;
  longPauseThresholdMs: number;
}): {
  update(signal: { inputLevel: number; silenceMs: number }): TurnState;
  getState(): TurnState;
} {
  let phase: TurnPhase = "idle";
  let silenceMs = 0;
  let isUserSpeaking = false;
  let isAssistantSpeaking = false;

  return {
    update(signal) {
      silenceMs = signal.silenceMs;
      isUserSpeaking = signal.inputLevel > 0.1;

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

      return this.getState();
    },
    getState() {
      return {
        phase,
        silenceMs,
        isUserSpeaking,
        isAssistantSpeaking,
        shouldInterrupt: phase === "interrupted",
        backchannel: phase === "short_pause" ? "嗯" : null,
      };
    },
  };
}

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
  productApiClient: Pick<ProductApiClient, "exchangeRealtimeVoiceSdp">;
}

export interface BailianRealtimeWebrtcConnection {
  session: RealtimeVoiceSessionResponse;
  stream: MediaStreamLike;
  peerConnection: PeerConnectionLike;
  dataChannel: DataChannelLike;
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

  return {
    session,
    stream,
    peerConnection,
    dataChannel,
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

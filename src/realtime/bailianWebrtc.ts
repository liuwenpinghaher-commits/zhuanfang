/**
 * Browser Bailian Omni WebRTC transport.
 * Completes SDP offer/answer via Product API, then uses the data channel for
 * the same realtime event shapes as the WebSocket path where possible.
 */
import type { RealtimeVoiceSessionResponse } from "../api/productApi";
import { withAuthTokenQuery, getProductApiBaseUrl } from "../api/productApi";
import type {
  BailianRealtimeWebrtcConnection,
  InterruptAssistantOptions,
  InterruptAssistantResult,
  AssistantSpeechProgress
} from "./realtimeTypes";

export interface ConnectBailianRealtimeWebrtcOptions {
  productApiBaseUrl?: string;
  onAudioLevel?: (level: number) => void;
  onSpeechStart?: () => void;
  onSpeechEnd?: () => void;
  onError?: (err: Error) => void;
  onConnectionLost?: (err: Error) => void;
  getMicStream?: () => Promise<MediaStream>;
}

function apiBase(url?: string): string {
  return (url ?? getProductApiBaseUrl()).replace(/\/+$/, "");
}

export async function connectBailianRealtimeWebrtc(
  session: RealtimeVoiceSessionResponse,
  options: ConnectBailianRealtimeWebrtcOptions = {}
): Promise<BailianRealtimeWebrtcConnection> {
  if (typeof RTCPeerConnection === "undefined") {
    throw new Error("RTCPeerConnection is not available in this environment.");
  }

  const getMic =
    options.getMicStream ??
    (() =>
      navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1
        }
      }));

  const stream = await getMic();
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
  });
  for (const track of stream.getTracks()) {
    pc.addTrack(track, stream);
  }

  // Remote audio playback
  const remoteAudio = new Audio();
  remoteAudio.autoplay = true;
  pc.ontrack = (ev) => {
    if (ev.streams[0]) {
      remoteAudio.srcObject = ev.streams[0];
      void remoteAudio.play().catch(() => {
        /* autoplay may require gesture; user already started recording */
      });
    }
  };

  const dataChannel = pc.createDataChannel("oai-events");
  let progress: AssistantSpeechProgress | null = null;
  let closed = false;

  dataChannel.onmessage = (ev) => {
    try {
      const msg = JSON.parse(String(ev.data)) as { type?: string; transcript?: string; delta?: string };
      if (msg.type === "input_audio_buffer.speech_started") options.onSpeechStart?.();
      if (msg.type === "input_audio_buffer.speech_stopped") options.onSpeechEnd?.();
    } catch {
      /* ignore */
    }
  };

  pc.onconnectionstatechange = () => {
    if (closed) return;
    if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
      options.onConnectionLost?.(new Error(`WebRTC connection ${pc.connectionState}`));
    }
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  // Wait briefly for ICE gathering (trickle not used on this simple path).
  await new Promise<void>((resolve) => {
    if (pc.iceGatheringState === "complete") {
      resolve();
      return;
    }
    const t = setTimeout(() => resolve(), 2500);
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === "complete") {
        clearTimeout(t);
        resolve();
      }
    };
  });

  const localSdp = pc.localDescription?.sdp;
  if (!localSdp) throw new Error("Failed to create local WebRTC offer SDP.");

  const answerUrl = withAuthTokenQuery(
    `${apiBase(options.productApiBaseUrl)}/api/realtime-voice/sessions/${encodeURIComponent(session.sessionId)}/webrtc/answer`
  );
  const answerRes = await fetch(answerUrl, {
    method: "POST",
    headers: { "content-type": "application/sdp", accept: "application/sdp" },
    body: localSdp
  });
  if (!answerRes.ok) {
    const body = await answerRes.text().catch(() => "");
    throw new Error(`WebRTC answer failed (${answerRes.status}): ${body || answerRes.statusText}`);
  }
  const answerSdp = await answerRes.text();
  await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

  const sendEvent = (payload: unknown) => {
    if (dataChannel.readyState === "open") {
      dataChannel.send(JSON.stringify(payload));
    }
  };

  return {
    session,
    stream,
    peerConnection: pc,
    dataChannel,
    updateInstructions(instructions: string) {
      sendEvent({
        type: "session.update",
        session: { instructions }
      });
    },
    beginAssistantTurn(input) {
      progress = {
        turnId: input.turnId,
        providerTurnId: input.providerTurnId,
        startedAt: Date.now(),
        chunks: [],
        totalChars: 0,
        totalAudioMs: 0,
        completed: false
      };
    },
    markAssistantSpeaking(input) {
      if (!progress) return;
      progress.chunks.push({ text: input.text, audioMs: input.audioMs, receivedAt: Date.now() });
      progress.totalChars += input.text.length;
      progress.totalAudioMs += input.audioMs ?? 0;
    },
    completeAssistantTurn() {
      if (!progress) return null;
      progress.completed = true;
      const done = progress;
      progress = null;
      return done;
    },
    getAssistantProgress() {
      return progress;
    },
    async interruptAssistant(options?: InterruptAssistantOptions): Promise<InterruptAssistantResult | null> {
      sendEvent({ type: "response.cancel" });
      sendEvent({ type: "input_audio_buffer.clear" });
      try {
        remoteAudio.pause();
        remoteAudio.currentTime = 0;
      } catch {
        /* ignore */
      }
      const spoken = progress;
      progress = null;
      return {
        truncated: Boolean(spoken && spoken.totalChars > 0),
        spokenChars: spoken?.totalChars ?? 0,
        originalChars: spoken?.totalChars ?? 0,
        spokenTextSoFar: spoken?.chunks.map((c) => c.text).join("") ?? "",
        reason: options?.reason ?? "user_interrupt"
      };
    },
    close() {
      closed = true;
      try {
        dataChannel.close();
      } catch {
        /* ignore */
      }
      try {
        pc.close();
      } catch {
        /* ignore */
      }
      for (const track of stream.getTracks()) track.stop();
      try {
        remoteAudio.pause();
        remoteAudio.srcObject = null;
      } catch {
        /* ignore */
      }
    }
  };
}

import type { RealtimeVoiceSessionResponse } from "../api/productApi";
import type {
  AssistantSpeechProgress,
  InterruptAssistantOptions,
  InterruptAssistantResult
} from "./bailianWebrtc";

export type { AssistantSpeechProgress, InterruptAssistantOptions, InterruptAssistantResult };

interface MediaDevicesLike {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
}

export interface BailianRealtimeWebsocketConnection {
  session: RealtimeVoiceSessionResponse;
  stream: MediaStream;
  beginAssistantTurn(input: { turnId?: string; providerTurnId?: string }): void;
  markAssistantSpeaking(input: { text: string; audioMs?: number }): void;
  completeAssistantTurn(): AssistantSpeechProgress | null;
  getAssistantProgress(): AssistantSpeechProgress | null;
  interruptAssistant(options?: InterruptAssistantOptions): Promise<InterruptAssistantResult | null>;
  close(): void;
}

export interface ConnectBailianRealtimeWebsocketOptions {
  mediaDevices?: MediaDevicesLike;
  productApiBaseUrl?: string;
  onTranscript?: (text: string, isFinal: boolean) => void;
  onAudioLevel?: (level: number) => void;
  onSpeechStart?: () => void;
  onSpeechEnd?: () => void;
  onError?: (error: Error) => void;
}

export async function connectBailianRealtimeWebsocket(
  session: RealtimeVoiceSessionResponse,
  options: ConnectBailianRealtimeWebsocketOptions
): Promise<BailianRealtimeWebsocketConnection> {
  if (session.status !== "ready") {
    throw new Error(`Realtime voice session is not ready: ${session.status}`);
  }
  if (session.transport !== "websocket") {
    throw new Error(`Unsupported realtime transport: ${session.transport}`);
  }

  const baseUrl = options.productApiBaseUrl ?? "ws://127.0.0.1:8787";
  const wsUrl = `${baseUrl}/api/realtime-voice/ws/${session.sessionId}`;
  const mediaDevices = options.mediaDevices ?? navigator.mediaDevices;

  const stream = await mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      sampleRate: 16000,
      channelCount: 1
    }
  });

  const audioContext = new AudioContext({ sampleRate: 16000 });
  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);

  const ws = new WebSocket(wsUrl);
  let progress: AssistantSpeechProgress | null = null;
  let closed = false;
  let audioQueue: Float32Array[] = [];
  let playbackNode: AudioBufferSourceNode | null = null;

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

  function scheduleAudioPlayback(pcmBase64: string) {
    try {
      const binaryStr = atob(pcmBase64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      const int16 = new Int16Array(bytes.buffer);
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) {
        float32[i] = int16[i] / 32768;
      }
      audioQueue.push(float32);
      playNextChunk();
    } catch {
      // skip malformed audio
    }
  }

  function playNextChunk() {
    if (!audioQueue.length || playbackNode) return;

    const chunk = audioQueue.shift()!;
    const buffer = audioContext.createBuffer(1, chunk.length, 24000);
    buffer.getChannelData(0).set(chunk);

    playbackNode = audioContext.createBufferSource();
    playbackNode.buffer = buffer;
    playbackNode.connect(audioContext.destination);
    playbackNode.onended = () => {
      playbackNode = null;
      playNextChunk();
    };
    playbackNode.start();
  }

  function stopPlayback() {
    if (playbackNode) {
      try { playbackNode.stop(); } catch { /* already stopped */ }
      playbackNode = null;
    }
    audioQueue = [];
  }

  return new Promise((resolve, reject) => {
    ws.onopen = () => {
      ws.send(JSON.stringify(session.sessionUpdate));
    };

    ws.onmessage = (event) => {
      if (closed) return;
      try {
        const msg = JSON.parse(event.data as string);
        handleServerEvent(msg);
      } catch {
        // non-JSON message, ignore
      }
    };

    ws.onerror = () => {
      if (!closed) {
        options.onError?.(new Error("WebSocket connection error"));
      }
    };

    ws.onclose = () => {
      closed = true;
      stopPlayback();
    };

    function handleServerEvent(msg: Record<string, unknown>) {
      const type = msg.type as string | undefined;

      switch (type) {
        case "proxy.connected": {
          processor.onaudioprocess = (e) => {
            if (closed || ws.readyState !== WebSocket.OPEN) return;
            const inputData = e.inputBuffer.getChannelData(0);
            const int16 = new Int16Array(inputData.length);
            for (let i = 0; i < inputData.length; i++) {
              int16[i] = Math.max(-32768, Math.min(32767, Math.round(inputData[i] * 32767)));
            }
            const bytes = new Uint8Array(int16.buffer);
            let binary = "";
            for (let i = 0; i < bytes.length; i++) {
              binary += String.fromCharCode(bytes[i]);
            }
            const base64 = btoa(binary);
            ws.send(JSON.stringify({
              type: "input_audio_buffer.append",
              audio: base64
            }));
            const level = Math.max(...Array.from(inputData).map(Math.abs));
            options.onAudioLevel?.(level);
          };
          source.connect(processor);
          processor.connect(audioContext.destination);
          resolve({
            session,
            stream,
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
              if (!progress || progress.chunks.length === 0) return null;
              const reason = opts.reason ?? "user_interrupt";
              const spokenTextSoFar = progress.chunks.map((c) => c.text).join("");
              const interruptedAtMs = opts.interruptedAtMs ?? progress.totalAudioMs;
              stopPlayback();
              ws.send(JSON.stringify({
                type: "response.cancel"
              }));
              progress.completed = true;
              return {
                truncated: true,
                spokenChars: spokenTextSoFar.length,
                originalChars: spokenTextSoFar.length,
                spokenTextSoFar,
                reason
              };
            },
            close() {
              closed = true;
              stopPlayback();
              processor.disconnect();
              source.disconnect();
              audioContext.close();
              for (const track of stream.getTracks()) {
                track.stop();
              }
              if (ws.readyState === WebSocket.OPEN) {
                ws.close(1000, "user closed");
              }
            }
          });
          break;
        }

        case "response.audio.delta": {
          const delta = msg.delta as string | undefined;
          if (delta) scheduleAudioPlayback(delta);
          break;
        }

        case "response.audio_transcript.delta": {
          const delta = msg.delta as string | undefined;
          if (delta) {
            ensureProgress();
            options.onTranscript?.(delta, false);
          }
          break;
        }

        case "response.audio_transcript.done": {
          const transcript = msg.transcript as string | undefined;
          if (transcript) {
            options.onTranscript?.(transcript, true);
          }
          break;
        }

        case "response.text.delta": {
          const delta = msg.delta as string | undefined;
          if (delta) {
            ensureProgress();
            options.onTranscript?.(delta, false);
          }
          break;
        }

        case "response.text.done": {
          const text = msg.text as string | undefined;
          if (text) {
            options.onTranscript?.(text, true);
          }
          break;
        }

        case "input_audio_buffer.speech_started": {
          stopPlayback();
          options.onSpeechStart?.();
          break;
        }

        case "input_audio_buffer.speech_stopped": {
          options.onSpeechEnd?.();
          break;
        }

        case "conversation.item.input_audio_transcription.delta": {
          const text = (msg.text as string ?? "") + (msg.stash as string ?? "");
          if (text) options.onTranscript?.(text, false);
          break;
        }

        case "conversation.item.input_audio_transcription.completed": {
          const transcript = msg.transcript as string | undefined;
          if (transcript) options.onTranscript?.(transcript, true);
          break;
        }

        case "error": {
          const error = msg.error as { message?: string } | undefined;
          options.onError?.(new Error(error?.message ?? "DashScope error"));
          break;
        }
      }
    }
  });
}

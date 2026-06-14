import type { RealtimeVoiceSessionResponse } from "../api/productApi";
import type {
  AssistantSpeechProgress,
  InterruptAssistantOptions,
  InterruptAssistantResult
} from "./bailianWebrtc";
import type { InterruptionScene } from "../domain/engine";
import { buildInterruptionContext, getInterruptionScene } from "../domain/engine";

export type { AssistantSpeechProgress, InterruptAssistantOptions, InterruptAssistantResult };

interface MediaDevicesLike {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
}

export interface BailianRealtimeWebsocketConnection {
  session: RealtimeVoiceSessionResponse;
  stream: MediaStream;
  setStrategy(strategy: string | undefined): void;
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
  onUserTranscript?: (text: string, isFinal: boolean) => void;
  onAssistantTranscript?: (text: string, isFinal: boolean) => void;
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
  let currentStrategy: string | undefined;
  let fullAssistantTranscript = "";
  let pendingInterruptionContext: string | null = null;
  let interruptionScene: InterruptionScene = "perspective_shift";
  let aiIsSpeaking = false;
  /** Accumulator for user voice energy during AI playback — triggers client-side
   *  interruption when the user starts speaking over the AI. */
  let userEnergyBuffer = 0;
  const CLIENT_INTERRUPT_THRESHOLD = 0.15;       // audio level that counts as speech
  const CLIENT_INTERRUPT_FRAMES = 8;             // consecutive high-energy frames needed
  let interruptFrameCounter = 0;

  function forceCancelIfUserSpeaks(level: number) {
    // Only check while AI is producing audio (playback in progress or
    // DashScope hasn't yet sent response.done).
    if (!aiIsSpeaking) {
      userEnergyBuffer = 0;
      interruptFrameCounter = 0;
      return;
    }
    if (level > CLIENT_INTERRUPT_THRESHOLD) {
      interruptFrameCounter++;
      userEnergyBuffer += level;
    } else {
      interruptFrameCounter = Math.max(0, interruptFrameCounter - 1);
      userEnergyBuffer *= 0.7;
    }
    if (interruptFrameCounter >= CLIENT_INTERRUPT_FRAMES) {
      userEnergyBuffer = 0;
      interruptFrameCounter = 0;
      cancelAndSaveContext();
      // Let the API re-enter listening mode; the current audio buffer will
      // be treated as new user speech.
      options.onSpeechStart?.();
    }
  }

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

  function cancelAndSaveContext() {
    aiIsSpeaking = false;
    const spoken = fullAssistantTranscript;
    const unspoken = progress && !progress.completed
      ? progress.chunks.slice(
          Math.floor(progress.chunks.length * (spoken.length / Math.max(1, progress.totalChars)))
        ).map(c => c.text).join("")
      : "";

    stopPlayback();
    ws.send(JSON.stringify({ type: "response.cancel" }));

    if (interruptionScene === "anchor_probe" || interruptionScene === "perspective_shift") {
      pendingInterruptionContext = buildInterruptionContext({
        spokenSoFar: spoken,
        unspokenContent: unspoken,
        strategy: currentStrategy,
        userInput: ""
      });
    }
  }

  function injectContextAndRespond(userInput: string) {
    if (!pendingInterruptionContext) return;

    const context = pendingInterruptionContext.replace("用户说：\"\"", `用户说："${userInput}"`);
    pendingInterruptionContext = null;

    ws.send(JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: context }]
      }
    }));
    ws.send(JSON.stringify({ type: "response.create" }));
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
            forceCancelIfUserSpeaks(level);
          };
          source.connect(processor);
          processor.connect(audioContext.destination);
          resolve({
            session,
            stream,
            setStrategy(strategy) {
              currentStrategy = strategy;
              interruptionScene = getInterruptionScene(strategy);
            },
            beginAssistantTurn(input) {
              fullAssistantTranscript = "";
              pendingInterruptionContext = null;
              ensureProgress(input);
            },
            markAssistantSpeaking(input) {
              const current = ensureProgress();
              const text = input.text ?? "";
              if (!text) return;
              fullAssistantTranscript += text;
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

              if (interruptionScene === "key_insight") {
                await new Promise(r => setTimeout(r, 500));
              }

              cancelAndSaveContext();
              progress.completed = true;
              return {
                truncated: true,
                spokenChars: spokenTextSoFar.length,
                originalChars: fullAssistantTranscript.length,
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
            options.onAssistantTranscript?.(delta, false);
          }
          break;
        }

        case "response.audio_transcript.done": {
          const transcript = msg.transcript as string | undefined;
          if (transcript) {
            options.onAssistantTranscript?.(transcript, true);
          }
          break;
        }

        case "response.text.delta": {
          const delta = msg.delta as string | undefined;
          if (delta) {
            ensureProgress();
            options.onAssistantTranscript?.(delta, false);
          }
          break;
        }

        case "response.text.done": {
          const text = msg.text as string | undefined;
          if (text) {
            options.onAssistantTranscript?.(text, true);
          }
          break;
        }

        case "response.created": {
          aiIsSpeaking = true;
          if (pendingInterruptionContext) {
            ws.send(JSON.stringify({ type: "response.cancel" }));
          }
          break;
        }

        case "response.done": {
          aiIsSpeaking = false;
          if (pendingInterruptionContext) {
            const userText = (msg as Record<string, unknown>).transcript as string ?? "";
            injectContextAndRespond(userText);
          }
          break;
        }

        case "input_audio_buffer.speech_started": {
          cancelAndSaveContext();
          options.onSpeechStart?.();
          break;
        }

        case "input_audio_buffer.speech_stopped": {
          options.onSpeechEnd?.();
          break;
        }

        case "conversation.item.input_audio_transcription.delta": {
          const text = (msg.text as string ?? "") + (msg.stash as string ?? "");
          if (text) options.onUserTranscript?.(text, false);
          break;
        }

        case "conversation.item.input_audio_transcription.completed": {
          const transcript = msg.transcript as string | undefined;
          if (transcript) {
            if (pendingInterruptionContext) {
              pendingInterruptionContext = pendingInterruptionContext.replace(
                /用户说：".*"/,
                `用户说："${transcript}"`
              );
            }
            options.onUserTranscript?.(transcript, true);
          }
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

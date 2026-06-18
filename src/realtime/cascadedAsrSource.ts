/**
 * Browser-side ASR source for the cascade pipeline.
 *
 * Reuses the same ASR proxy WS path as bailianWebsocket
 * (/api/realtime-voice/ws/:sessionId) but:
 *   - sends `session.update` with modalities:["text"] so omni
 *     transcribes the user's speech but does NOT produce audio output,
 *   - DOES NOT send response.create (that's the cascade orchestrator's job),
 *   - exposes AsrSource: register/start/stop/getExpressionState.
 *
 * Feature tracking (expressionDetector + speechFeatureTracker) mirrors
 * bailianWebsocket to keep expression-state evaluation consistent.
 */
import type { AsrSource, AsrEventHandlers } from "./cascadedPipeline";
import type { ExpressionState } from "../domain/types";
import { createExpressionStateDetector, type ExpressionStateInput } from "./expressionStateDetector";
import { createSpeechFeatureTracker, spectralCentroid } from "./speechFeatures";

/** Session-update payload for text-only (ASR) mode. */
function buildAsrSessionUpdate(instructions: string) {
  return {
    type: "session.update",
    session: {
      modalities: ["text"],
      input_audio_format: "pcm",
      // No output_audio_format / voice — we don't want audio from the model.
      instructions,
      turn_detection: {
        type: "server_vad",
        threshold: 0.5,
        silence_duration_ms: 600,
        // Pure transcriber: emit VAD turn events + transcription, but do NOT let
        // omni auto-generate a response each turn. The cascade orchestrator owns
        // the respond/留白 decision and the LLM+TTS reply. Verified accepted by
        // DashScope omni (spike-asr-create-response): server echoes create_response:false.
        // Without this, omni auto-creates a text response per turn → wasted work +
        // "conversation already has an active response" errors.
        create_response: false
      }
    }
  };
}

export interface CreateBrowserAsrSourceOptions {
  /** Full WS URL to the ASR proxy, e.g. "ws://127.0.0.1:8787/api/realtime-voice/ws/<sessionId>" */
  asrWsUrl: string;
  /** Called to get the mic stream — defaults to navigator.mediaDevices.getUserMedia. */
  getMicStream?: () => Promise<MediaStream>;
  /** Instructions forwarded to the model for the ASR-only session. */
  instructions?: string;
}

export function createBrowserAsrSource(opts: CreateBrowserAsrSourceOptions): AsrSource {
  const { asrWsUrl, getMicStream, instructions = "" } = opts;

  let handlers: AsrEventHandlers | null = null;
  let ws: WebSocket | null = null;
  let stream: MediaStream | null = null;
  let audioCtx: AudioContext | null = null;
  let processor: ScriptProcessorNode | null = null;
  let sourceNode: MediaStreamAudioSourceNode | null = null;
  let analyser: AnalyserNode | null = null;
  let freqData: Uint8Array<ArrayBuffer> | null = null;
  let closed = false;

  // Expression / feature tracking (same as bailianWebsocket)
  const expressionDetector = createExpressionStateDetector();
  const featureTracker = createSpeechFeatureTracker();

  let latestExpressionState: ExpressionState = "fluent";
  let latestPartialTranscript = "";
  let lowEnergyFrames = 0;
  let frameMs = 256; // will be updated once AudioContext is created

  let semanticFlags = {
    hasFilledPause: false,
    hasVagueTerm: false,
    hasEmotionWord: false,
    hasRepetition: false,
    hasFalseStart: false
  };

  function updateSemanticFlags(text: string) {
    latestPartialTranscript = text;
    featureTracker.onTranscript(text, Date.now());
    semanticFlags.hasFilledPause = /[嗯唔啊]/.test(text);
    semanticFlags.hasVagueTerm = /那个|这个|某种|怎么说呢|反正就是|你懂的|那种/.test(text);
    semanticFlags.hasEmotionWord = /矛盾|纠结|两难|不知道|不确定|也许|可能吧|烦|累|受不了|没办法|后悔|早知道|如果当初/.test(text);
    semanticFlags.hasRepetition = /(.)\1{2,}|(..+)\s*\1/.test(text);
    semanticFlags.hasFalseStart = /不是.{2,}是/.test(text);
  }

  function evaluateExpressionState(energy: number): ExpressionState {
    const now = Date.now();
    const features = featureTracker.features(now, latestPartialTranscript);
    const exprInput: ExpressionStateInput = {
      speechRate: features.speechRate,
      baselineSpeechRate: features.baselineSpeechRate,
      energy,
      baselineEnergy: 0.3,
      pitchTrend: features.pitchTrend,
      currentSilenceMs: lowEnergyFrames * frameMs,
      pausePosition: features.pausePosition,
      ...semanticFlags,
      samePointCount: features.samePointCount,
      timeSinceLastGuidance: features.timeSinceLastGuidance
    };
    return expressionDetector.evaluate(exprInput);
  }

  function stopMic() {
    if (processor) {
      try { processor.disconnect(); } catch { /* ok */ }
      processor = null;
    }
    if (sourceNode) {
      try { sourceNode.disconnect(); } catch { /* ok */ }
      sourceNode = null;
    }
    if (analyser) {
      try { analyser.disconnect(); } catch { /* ok */ }
      analyser = null;
    }
    if (audioCtx && audioCtx.state !== "closed") {
      audioCtx.close().catch(() => { /* ok */ });
      audioCtx = null;
    }
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      stream = null;
    }
  }

  async function startMic() {
    const getStream = getMicStream ?? (() =>
      navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 16000,
          channelCount: 1
        }
      })
    );

    stream = await getStream();
    audioCtx = new AudioContext({ sampleRate: 16000 });
    sourceNode = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    freqData = new Uint8Array(analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;
    sourceNode.connect(analyser);

    processor = audioCtx.createScriptProcessor(4096, 1, 1);
    frameMs = Math.round((4096 / audioCtx.sampleRate) * 1000);

    processor.onaudioprocess = (e) => {
      if (closed || !ws || ws.readyState !== WebSocket.OPEN) return;

      const inputData = e.inputBuffer.getChannelData(0);
      // Encode PCM16 as base64 and send to proxy
      const int16 = new Int16Array(inputData.length);
      for (let i = 0; i < inputData.length; i++) {
        int16[i] = Math.max(-32768, Math.min(32767, Math.round(inputData[i] * 32767)));
      }
      const bytes = new Uint8Array(int16.buffer);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: btoa(binary) }));

      // Update expression state
      const level = Math.max(...Array.from(inputData).map(Math.abs));
      if (analyser && freqData) {
        analyser.getByteFrequencyData(freqData);
        featureTracker.onCentroid(spectralCentroid(freqData, audioCtx!.sampleRate));
      }
      const ENERGY_THRESHOLD = 0.08;
      if (level > ENERGY_THRESHOLD) {
        lowEnergyFrames = 0;
      } else {
        lowEnergyFrames++;
      }
      latestExpressionState = evaluateExpressionState(level);
    };

    sourceNode.connect(processor);
    processor.connect(audioCtx.destination);
  }

  return {
    register(h: AsrEventHandlers) {
      handlers = h;
    },

    async start() {
      if (!handlers) {
        throw new Error("AsrSource: register() must be called before start()");
      }

      await startMic();

      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(asrWsUrl);
        ws = socket;

        socket.onopen = () => {
          // Text-only session: the model will transcribe but not generate audio
          socket.send(JSON.stringify(buildAsrSessionUpdate(instructions)));
        };

        socket.onmessage = (event) => {
          if (closed) return;
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(event.data as string);
          } catch {
            return;
          }

          const type = msg.type as string | undefined;

          switch (type) {
            case "proxy.connected":
              // Proxy is ready — resolve so startListening() can proceed
              resolve();
              break;

            case "input_audio_buffer.speech_started":
              handlers?.onSpeechStarted();
              break;

            case "input_audio_buffer.speech_stopped": {
              // Measure silence since last high-energy frame
              const silenceMs = lowEnergyFrames * frameMs;
              handlers?.onSpeechStopped(silenceMs);
              break;
            }

            case "conversation.item.input_audio_transcription.delta": {
              // Type guard: text and stash must both be strings (or absent → treat as "").
              // Non-string values (number, null, object, etc.) indicate a malformed delta;
              // skip silently and emit a structured warning so ops can detect schema drift.
              const rawText = msg.text;
              const rawStash = msg.stash;
              const textIsValid = rawText === undefined || typeof rawText === "string";
              const stashIsValid = rawStash === undefined || typeof rawStash === "string";
              if (!textIsValid || !stashIsValid) {
                console.warn(JSON.stringify({
                  event: "asr_invalid_delta",
                  textType: typeof rawText,
                  stashType: typeof rawStash,
                }));
                break;
              }
              const text = ((rawText as string | undefined) ?? "") + ((rawStash as string | undefined) ?? "");
              if (!text) {
                console.warn(JSON.stringify({ event: "asr_empty_transcript" }));
                break;
              }
              updateSemanticFlags(text);
              // Cumulative partial — orchestrator REPLACES the partial with it.
              handlers?.onTranscriptDelta(text, false);
              break;
            }

            case "conversation.item.input_audio_transcription.completed": {
              const transcript = msg.transcript as string | undefined;
              if (transcript) {
                updateSemanticFlags(transcript);
                // Finalized segment — orchestrator commits it.
                handlers?.onTranscriptDelta(transcript, true);
              }
              break;
            }

            case "error": {
              const errMsg = (msg.error as { message?: string } | undefined)?.message ?? "ASR error";
              if (!closed) {
                reject(new Error(errMsg));
              }
              break;
            }
          }
        };

        socket.onerror = () => {
          if (!closed) reject(new Error("ASR WebSocket error"));
        };

        socket.onclose = () => {
          ws = null;
        };
      });
    },

    stop() {
      closed = true;
      stopMic();
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close(1000, "cascade stop");
      }
      ws = null;
    },

    getExpressionState(): ExpressionState {
      return latestExpressionState;
    }
  };
}

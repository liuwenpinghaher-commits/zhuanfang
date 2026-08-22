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
import { createSileroVadController, type SileroVadController } from "./sileroVad";
import {
  computeAsrReconnectDelayMs,
  isRecoverableAsrCloseCode,
  type AsrConnectionEvent,
  type AsrConnectionState,
} from "./asrConnectionLifecycle";

/** Session-update payload for text-only (ASR) mode. */
function buildAsrSessionUpdate(instructions: string, silenceDurationMs = 900) {
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
        // Default 900ms: lower than legacy 1500 to cut endpoint tax; interview think-pauses
        // still survive via cascade minPause + incomplete wait. Override via silenceDurationMs.
        silence_duration_ms: silenceDurationMs,
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
  /**
   * server_vad silence before speech_stopped (ms).
   * Interview default 900 balances think-pauses vs TTFA; command profile can use 500–700.
   */
  silenceDurationMs?: number;
  /** Load browser Silero VAD (neural). Soft-fails if WASM unavailable. Default true. */
  enableSileroVad?: boolean;
  /** Called to get the mic stream — defaults to navigator.mediaDevices.getUserMedia. */
  getMicStream?: () => Promise<MediaStream>;
  /**
   * Invoked with the live mic stream once it is acquired (before the ASR
   * AudioContext graph is built). The caller can tee it into a whole-session
   * MediaRecorder. Best-effort: throwing here must not break ASR, so it's called
   * defensively. Does not alter any ASR behaviour.
   */
  onMicStream?: (stream: MediaStream) => void;
  /** Instructions forwarded to the model for the ASR-only session. */
  instructions?: string;
  /**
   * Max reconnect attempts after ASR start failure (default: 2).
   * Set to 0 to disable reconnect.
   */
  maxReconnectAttempts?: number;
  /**
   * Base delay in ms between reconnect attempts (default: 500).
   * Actual delay = baseReconnectDelayMs * attempt (linear backoff).
   * Injectable for tests (set to 0 for instant retries).
   */
  baseReconnectDelayMs?: number;
  /**
   * 审计修复(P2-22):连接建立(settled)之后的中途断连/服务端错误此前完全静默——UI 呈"在听"
   * 假象、麦克风帧被丢弃、无任何信号。此回调在会话中途链路死亡时触发一次,调用方据此提示
   * 用户并收尾(启动期失败仍走原 reject+重试路径,不经此回调)。
   */
  onConnectionLost?: (err: Error) => void;
  /** Reports the ASR connection lifecycle without exposing transcript or audio. */
  onConnectionStateChange?: (event: AsrConnectionEvent) => void;
  /** Preserves an unconfirmed provider partial for the caller's review boundary. */
  onRecoveryTranscript?: (item: { text: string; reason: string; code?: number }) => void;
  /** Mid-session reconnect budget. Defaults to five replacement sockets. */
  maxMidSessionReconnectAttempts?: number;
  /** Exponential mid-session reconnect base delay in ms. Defaults to 500. */
  midSessionReconnectBaseDelayMs?: number;
  /** Injectable delay primitive used by the reconnection policy. */
  wait?: (ms: number) => Promise<void>;
  /** Injectable entropy source used by the reconnect jitter policy. */
  random?: () => number;
}

export function createBrowserAsrSource(opts: CreateBrowserAsrSourceOptions): AsrSource {
  const {
    asrWsUrl,
    getMicStream,
    onMicStream,
    instructions = "",
    silenceDurationMs = 900,
    enableSileroVad = true,
    maxReconnectAttempts = 2,
    baseReconnectDelayMs = 500,
    onConnectionLost,
    onConnectionStateChange,
    onRecoveryTranscript,
    maxMidSessionReconnectAttempts = 5,
    midSessionReconnectBaseDelayMs = 500,
    wait = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    random = Math.random,
  } = opts;

  // P2-22:中途断连只上报一次(onerror 与 onclose 常成对触发)。
  let connectionLostNotified = false;
  function notifyConnectionLost(err: Error) {
    if (connectionLostNotified || closed) return;
    connectionLostNotified = true;
    try { onConnectionLost?.(err); } catch { /* 上报回调自身绝不破坏收尾 */ }
  }

  let handlers: AsrEventHandlers | null = null;
  let ws: WebSocket | null = null;
  let stream: MediaStream | null = null;
  let audioCtx: AudioContext | null = null;
  let processor: ScriptProcessorNode | null = null;
  let workletNode: AudioWorkletNode | null = null;
  let muteNode: GainNode | null = null;
  let sourceNode: MediaStreamAudioSourceNode | null = null;
  let analyser: AnalyserNode | null = null;
  let freqData: Uint8Array<ArrayBuffer> | null = null;
  let pcmTap: "worklet" | "silero" | "script" | "none" = "none";
  let pendingPcm: string[] = [];
  let closed = false;
  let lifecycle: AsrConnectionState | "idle" = "idle";
  let socketGeneration = 0;
  let recoveryTask: Promise<void> | null = null;
  let latestProviderPartial = "";

  // Expression / feature tracking (same as bailianWebsocket)
  const expressionDetector = createExpressionStateDetector();
  const featureTracker = createSpeechFeatureTracker();

  let latestExpressionState: ExpressionState = "fluent";
  let latestPartialTranscript = "";
  let latestEnergy = 0;
  let sileroSpeechProb = 0;
  let sileroVadCtrl: SileroVadController | null = null;
  let lowEnergyFrames = 0;
  let lastHighEnergyAtMs = 0;
  let echoCancellationEnabled = false;
  let frameMs = 256; // will be updated once AudioContext is created

  let semanticFlags = {
    hasFilledPause: false,
    hasVagueTerm: false,
    hasEmotionWord: false,
    hasRepetition: false,
    hasFalseStart: false
  };

  function emitConnectionState(
    state: AsrConnectionState,
    attempt: number,
    code?: number,
    reason?: string,
  ) {
    lifecycle = state;
    try {
      onConnectionStateChange?.({
        state,
        attempt,
        maxAttempts: state === "connecting" ? maxReconnectAttempts : maxMidSessionReconnectAttempts,
        code,
        reason,
      });
    } catch {
      // UI telemetry must never break the live audio path.
    }
  }

  function hasTerminalLifecycle() {
    return lifecycle === "exhausted" || lifecycle === "stopped";
  }

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

  type AsrDebugWindow = Window & {
    __asrTicks?: number;
    __asrPeak?: number;
    __asrCapture?: string;
    __asrWsReady?: boolean;
    __asrLastTranscriptAt?: number;
    __asrEchoCancellation?: boolean;
    __asrFeedPcm?: (data: ArrayLike<number>) => void;
    __zhuanfangAudioUnlock?: AudioContext;
  };

  function debugWindow(): AsrDebugWindow | null {
    return typeof window === "undefined" ? null : window as AsrDebugWindow;
  }

  function incrementAsrTicks() {
    const w = debugWindow();
    if (!w) return;
    w.__asrTicks = (w.__asrTicks ?? 0) + 1;
  }

  function resampleTo16k(input: Float32Array, fromRate: number): Float32Array {
    if (!fromRate || Math.abs(fromRate - 16000) < 1) return input;
    const ratio = fromRate / 16000;
    const outLen = Math.max(1, Math.floor(input.length / ratio));
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      out[i] = input[Math.min(input.length - 1, Math.floor(i * ratio))] ?? 0;
    }
    return out;
  }

  function sendPcmFrame(inputData: Float32Array, sourceRate?: number) {
    incrementAsrTicks();
    const ctxRate = sourceRate ?? audioCtx?.sampleRate ?? 16000;
    const samples = resampleTo16k(inputData, ctxRate);
    if (samples.length === 0) return;

    let level = 0;
    for (let i = 0; i < samples.length; i++) {
      const v = Math.abs(samples[i] ?? 0);
      if (v > level) level = v;
    }
    latestEnergy = Math.max(level, sileroSpeechProb);
    const wPeak = debugWindow();
    if (wPeak) wPeak.__asrPeak = Math.max(wPeak.__asrPeak ?? 0, level);
    if (analyser && freqData && audioCtx) {
      analyser.getByteFrequencyData(freqData);
      featureTracker.onCentroid(spectralCentroid(freqData, audioCtx.sampleRate));
    }
    const ENERGY_THRESHOLD = 0.08;
    if (level > ENERGY_THRESHOLD || sileroSpeechProb > 0.35) {
      lowEnergyFrames = 0;
      lastHighEnergyAtMs = Date.now();
    } else {
      lowEnergyFrames++;
    }
    latestExpressionState = evaluateExpressionState(level);

    const int16 = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      int16[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767)));
    }
    const bytes = new Uint8Array(int16.buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const audio = btoa(binary);
    const wReady = debugWindow();
    if (wReady) wReady.__asrWsReady = Boolean(ws && ws.readyState === WebSocket.OPEN && lifecycle === "ready");
    if (!ws || ws.readyState !== WebSocket.OPEN || lifecycle !== "ready") {
      pendingPcm.push(audio);
      if (pendingPcm.length > 80) pendingPcm.shift();
      return;
    }
    ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio }));
  }

  function flushPendingPcm() {
    if (!ws || ws.readyState !== WebSocket.OPEN || lifecycle !== "ready") return;
    const queued = pendingPcm;
    pendingPcm = [];
    for (const audio of queued) {
      ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio }));
    }
  }

  function feedPcmFromEval(data: ArrayLike<number>) {
    const arr = data instanceof Float32Array ? data : Float32Array.from(data);
    sendPcmFrame(arr, 16000);
  }

  function resolvePcmTapWorkletUrl(): string {
    const base =
      typeof import.meta !== "undefined" && import.meta.env?.BASE_URL
        ? String(import.meta.env.BASE_URL)
        : "/";
    const root = base.endsWith("/") ? base : `${base}/`;
    return `${root}pcm-tap.worklet.js`;
  }

  function acquireCaptureContext(): AudioContext {
    const w = debugWindow();
    const existing = w?.__zhuanfangAudioUnlock;
    if (existing && existing.state !== "closed") {
      return existing;
    }
    return new AudioContext({ sampleRate: 16000 });
  }

  function stopMic() {
    const w = debugWindow();
    if (w) {
      w.__asrFeedPcm = undefined;
      w.__asrCapture = "stopped";
    }
    if (sileroVadCtrl) {
      try { sileroVadCtrl.destroy(); } catch { /* ok */ }
      sileroVadCtrl = null;
      sileroSpeechProb = 0;
    }
    if (processor) {
      try { processor.disconnect(); } catch { /* ok */ }
      processor = null;
    }
    if (workletNode) {
      try { workletNode.port.onmessage = null; } catch { /* ok */ }
      try { workletNode.disconnect(); } catch { /* ok */ }
      workletNode = null;
    }
    if (muteNode) {
      try { muteNode.disconnect(); } catch { /* ok */ }
      muteNode = null;
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
      if (w && w.__zhuanfangAudioUnlock === audioCtx) {
        w.__zhuanfangAudioUnlock = undefined;
      }
      audioCtx.close().catch(() => { /* ok */ });
      audioCtx = null;
    }
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      stream = null;
    }
    pcmTap = "none";
    pendingPcm = [];
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

    const hookWin = debugWindow();
    if (hookWin) {
      hookWin.__asrTicks = hookWin.__asrTicks ?? 0;
      hookWin.__asrPeak = hookWin.__asrPeak ?? 0;
      hookWin.__asrCapture = "starting";
      hookWin.__asrFeedPcm = feedPcmFromEval;
    }

    stream = await getStream();
    const micTrack = stream.getAudioTracks()[0];
    const settings = micTrack?.getSettings?.();
    // Fake/eval MediaStreamDestination tracks often claim echoCancellation without a device.
    echoCancellationEnabled = settings?.echoCancellation === true && Boolean(settings.deviceId);
    const wEcho = debugWindow();
    if (wEcho) wEcho.__asrEchoCancellation = echoCancellationEnabled;
    // Tee the live mic stream to the caller (e.g. whole-session recorder) before
    // building the ASR graph. Defensive: a throwing/failing recorder must never
    // break ASR start.
    if (onMicStream) {
      try {
        onMicStream(stream);
      } catch (err) {
        console.warn(JSON.stringify({
          event: "asr_on_mic_stream_failed",
          error: err instanceof Error ? err.message : String(err),
        }));
      }
    }

    audioCtx = acquireCaptureContext();
    if (audioCtx.state === "suspended") {
      await audioCtx.resume().catch(() => undefined);
    }
    sourceNode = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    freqData = new Uint8Array(analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;
    sourceNode.connect(analyser);

    async function connectMuted(node: AudioNode) {
      muteNode = audioCtx!.createGain();
      muteNode.gain.value = 0;
      node.connect(muteNode);
      muteNode.connect(audioCtx!.destination);
    }

    if (audioCtx.audioWorklet) {
      try {
        await audioCtx.audioWorklet.addModule(resolvePcmTapWorkletUrl());
        workletNode = new AudioWorkletNode(audioCtx, "pcm-tap", {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
        });
        workletNode.port.onmessage = (event) => {
          const data = event.data;
          if (data instanceof Float32Array) sendPcmFrame(data);
        };
        sourceNode.connect(workletNode);
        await connectMuted(workletNode);
        pcmTap = "worklet";
        frameMs = Math.round((128 / audioCtx.sampleRate) * 1000);
      } catch (err) {
        console.warn(JSON.stringify({
          event: "asr_pcm_worklet_failed",
          error: err instanceof Error ? err.message : String(err),
        }));
        workletNode = null;
      }
    }

    if (enableSileroVad) {
      void createSileroVadController(stream, {
        onFrame: (probs, frame) => {
          sileroSpeechProb = probs.isSpeech;
          if (pcmTap === "silero" && frame && frame.length) {
            frameMs = Math.round((frame.length / 16000) * 1000);
            sendPcmFrame(frame, 16000);
          }
        }
      }).then(async (ctrl) => {
        if (closed) {
          try { ctrl.destroy(); } catch { /* ok */ }
          return;
        }
        sileroVadCtrl = ctrl;
        if (ctrl.ready) {
          await ctrl.start();
          if (pcmTap === "none") pcmTap = "silero";
        }
      }).catch((err) => {
        console.warn(JSON.stringify({
          event: "asr_silero_start_failed",
          error: err instanceof Error ? err.message : String(err)
        }));
        sileroVadCtrl = null;
      });
    }

    if (pcmTap !== "worklet") {
      processor = audioCtx.createScriptProcessor(4096, 1, 1);
      frameMs = Math.round((4096 / audioCtx.sampleRate) * 1000);
      processor.onaudioprocess = (e) => {
        sendPcmFrame(e.inputBuffer.getChannelData(0));
      };
      sourceNode.connect(processor);
      if (!muteNode) await connectMuted(processor);
      else processor.connect(muteNode);
      pcmTap = "script";
    }

    const w = debugWindow();
    if (w) {
      w.__asrTicks = w.__asrTicks ?? 0;
      w.__asrCapture = pcmTap;
      w.__asrFeedPcm = feedPcmFromEval;
    }
    console.info(JSON.stringify({
      event: "asr_pcm_tap_ready",
      pcmTap,
      contextState: audioCtx.state,
      sampleRate: audioCtx.sampleRate,
    }));
  }

  type SocketFailure = Error & { code?: number; reason?: string };

  function socketFailure(message: string, code?: number, reason?: string): SocketFailure {
    return Object.assign(new Error(message), { code, reason });
  }

  function flushProviderPartial(code?: number) {
    if (!latestProviderPartial) return;
    try {
      onRecoveryTranscript?.({
        text: latestProviderPartial,
        reason: "语音连接中断，尾段尚未由识别服务确认",
        code,
      });
    } catch {
      // The recovery boundary is best-effort and must not suppress reconnect.
    }
    latestProviderPartial = "";
  }

  function exhaustMidSession(code?: number, reason?: string) {
    if (closed || lifecycle === "exhausted" || lifecycle === "stopped") return;
    emitConnectionState("exhausted", maxMidSessionReconnectAttempts, code, reason);
    stopMic();
    notifyConnectionLost(socketFailure("语音识别连接已断开", code, reason));
  }

  async function recoverMidSession(code?: number, reason?: string) {
    flushProviderPartial(code);
    let lastCode = code;
    let lastReason = reason;

    for (let attempt = 1; attempt <= maxMidSessionReconnectAttempts; attempt++) {
      if (closed) return;
      emitConnectionState("reconnecting", attempt, lastCode, lastReason);
      await wait(computeAsrReconnectDelayMs(attempt, midSessionReconnectBaseDelayMs, random));
      if (closed) return;
      try {
        await connectSocket("recovery");
        return;
      } catch (error) {
        const failure = error as SocketFailure;
        lastCode = failure.code;
        lastReason = failure.reason ?? failure.message;
        if (!isRecoverableAsrCloseCode(lastCode, lastReason)) {
          exhaustMidSession(lastCode, lastReason);
          return;
        }
      }
    }
    exhaustMidSession(lastCode, lastReason);
  }

  function handleReadySocketTermination(code?: number, reason?: string) {
    if (closed || (recoveryTask && lifecycle !== "ready")) return;
    if (!isRecoverableAsrCloseCode(code, reason)) {
      // Local stop() marks the source closed and emits stopped before closing
      // the socket, so any termination reaching here came from the remote side.
      // Even a remote 1000 must be visible as terminal loss, not normal user stop.
      exhaustMidSession(code, reason);
      return;
    }
    const task = recoverMidSession(code, reason);
    let wrappedTask: Promise<void>;
    wrappedTask = task.finally(() => {
      if (recoveryTask === wrappedTask) recoveryTask = null;
    });
    recoveryTask = wrappedTask;
  }

  function connectSocket(mode: "initial" | "recovery"): Promise<void> {
    const generation = ++socketGeneration;
    const socket = new WebSocket(asrWsUrl);
    ws = socket;
    let ready = false;
    let settled = false;
    let terminationHandled = false;
    const isCurrent = () => !closed && ws === socket && generation === socketGeneration;

    return new Promise<void>((resolve, reject) => {
      const terminate = (event: { code?: number; reason?: string; closeSocket?: boolean }) => {
        if (terminationHandled || !isCurrent()) return;
        terminationHandled = true;
        if (event.closeSocket
          && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
          try { socket.close(1011, "asr provider error"); } catch { /* already closing/closed */ }
        }
        if (ws === socket) ws = null;
        if (!ready) {
          settled = true;
          reject(socketFailure(
            event.reason || "ASR WebSocket closed before ready",
            event.code,
            event.reason,
          ));
          return;
        }
        handleReadySocketTermination(event.code, event.reason);
      };

      socket.onopen = () => {
        if (!isCurrent()) return;
        socket.send(JSON.stringify(buildAsrSessionUpdate(instructions, silenceDurationMs)));
      };

      socket.onmessage = (event) => {
        if (!isCurrent()) return;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(event.data as string);
        } catch {
          return;
        }
        const type = msg.type as string | undefined;
        switch (type) {
          case "proxy.connected":
            if (settled) {
              flushPendingPcm();
              return;
            }
            ready = true;
            settled = true;
            latestProviderPartial = "";
            emitConnectionState("ready", 0);
            flushPendingPcm();
            resolve();
            break;
          case "proxy.upstream_ready":
            flushPendingPcm();
            break;
          case "input_audio_buffer.speech_started":
            handlers?.onSpeechStarted();
            break;
          case "input_audio_buffer.speech_stopped":
            handlers?.onSpeechStopped(lowEnergyFrames * frameMs);
            break;
          case "conversation.item.input_audio_transcription.delta": {
            const rawText = msg.text;
            const rawStash = msg.stash;
            const textIsValid = rawText === undefined || typeof rawText === "string";
            const stashIsValid = rawStash === undefined || typeof rawStash === "string";
            if (!textIsValid || !stashIsValid) {
              console.warn(JSON.stringify({ event: "asr_invalid_delta", textType: typeof rawText, stashType: typeof rawStash }));
              break;
            }
            const text = ((rawText as string | undefined) ?? "") + ((rawStash as string | undefined) ?? "");
            if (!text) {
              console.warn(JSON.stringify({ event: "asr_empty_transcript" }));
              break;
            }
            latestProviderPartial = text;
            updateSemanticFlags(text);
            const wDelta = debugWindow();
            if (wDelta) wDelta.__asrLastTranscriptAt = Date.now();
            handlers?.onTranscriptDelta(text, false);
            break;
          }
          case "conversation.item.input_audio_transcription.completed": {
            const transcript = msg.transcript as string | undefined;
            if (transcript) {
              latestProviderPartial = "";
              updateSemanticFlags(transcript);
              const wDone = debugWindow();
              if (wDone) wDone.__asrLastTranscriptAt = Date.now();
              handlers?.onTranscriptDelta(transcript, true);
            }
            break;
          }
          case "error": {
            const errMsg = (msg.error as { message?: string } | undefined)?.message ?? "ASR error";
            terminate({ reason: errMsg, closeSocket: true });
            break;
          }
        }
      };
      socket.onerror = () => terminate({ reason: "ASR WebSocket error", closeSocket: true });
      socket.onclose = (event) => terminate({ code: event?.code, reason: event?.reason });
    });
  }

  async function connectWithInitialRetries() {
    let lastError: Error = new Error("ASR start failed");
    for (let attempt = 0; attempt <= maxReconnectAttempts; attempt++) {
      if (closed) return;
      if (attempt > 0 && baseReconnectDelayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, baseReconnectDelayMs * attempt));
      }
      if (closed) return;
      try {
        await connectSocket("initial");
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const failure = error as SocketFailure;
        if (!isRecoverableAsrCloseCode(failure.code, failure.reason)) break;
        if (attempt < maxReconnectAttempts) {
          console.warn(JSON.stringify({ event: "asr_reconnect", attempt: attempt + 1, maxReconnectAttempts, error: lastError.message }));
        }
      }
    }
    throw lastError;
  }

  return {
    register(h: AsrEventHandlers) {
      handlers = h;
    },

    getRecentEnergy() {
      return latestEnergy;
    },

    async start() {
      if (!handlers) throw new Error("AsrSource: register() must be called before start()");
      if (lifecycle !== "idle") return;
      closed = false;
      emitConnectionState("connecting", 0);
      try {
        await startMic();
        if (closed) {
          stopMic();
          return;
        }
        await connectWithInitialRetries();
      } catch (error) {
        stopMic();
        if (!hasTerminalLifecycle()) {
          emitConnectionState("exhausted", maxReconnectAttempts);
        }
        throw error;
      }
    },

    stop() {
      if (closed) return;
      closed = true;
      socketGeneration++;
      const socket = ws;
      ws = null;
      stopMic();
      emitConnectionState("stopped", 0, 1000, "cascade stop");
      if (socket && socket.readyState === WebSocket.OPEN) socket.close(1000, "cascade stop");
    },

    getExpressionState(): ExpressionState {
      return latestExpressionState;
    },

    hasRecentUserEnergyEvidence(): boolean {
      if (sileroSpeechProb > 0.35) return true;
      return Date.now() - lastHighEnergyAtMs <= 1_500;
    },

    getEchoCancellationEnabled(): boolean {
      return echoCancellationEnabled;
    }
  };
}

import type { RealtimeVoiceSessionResponse } from "../api/productApi";
import type {
  AssistantSpeechProgress,
  InterruptAssistantOptions,
  InterruptAssistantResult
} from "./realtimeTypes";
import type { InterruptionScene } from "../domain/engine";
import { buildInterruptionContext, getInterruptionScene } from "../domain/engine";
import { createExpressionStateDetector, type ExpressionStateInput } from "./expressionStateDetector";
import { createSpeechFeatureTracker, spectralCentroid } from "./speechFeatures";
import { evaluateIntent } from "./interactionIntentEngine";
import type { InteractionPreSignals } from "../domain/types";
import { getProductApiBaseUrl } from "../api/productApi";
import { deriveRealtimeWsBaseUrl } from "./wsBaseUrl";

export type { AssistantSpeechProgress, InterruptAssistantOptions, InterruptAssistantResult };

interface MediaDevicesLike {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
}

export interface BailianRealtimeWebsocketConnection {
  session: RealtimeVoiceSessionResponse;
  stream: MediaStream;
  setStrategy(strategy: string | undefined): void;
  updatePreSignals(next: InteractionPreSignals | null): void;
  /**
   * Refresh the live (omni) model's system instructions mid-session by emitting a
   * `session.update`. Used to push freshly-recomputed memory recall on every user
   * turn (fills review 🔴-1) — the realtime model can't recompute recall itself, and
   * the opening sessionUpdate is only an opening-time snapshot. Safe to call before
   * the socket is OPEN: the frame is silently dropped (mirrors updatePreSignals).
   */
  updateInstructions(instructions: string): void;
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
  preSignals?: InteractionPreSignals | null;
  onUserTranscript?: (text: string, isFinal: boolean) => void;
  onAssistantTranscript?: (text: string, isFinal: boolean) => void;
  onAudioLevel?: (level: number) => void;
  onSpeechStart?: () => void;
  onSpeechEnd?: () => void;
  onGuidance?: (text: string) => void;
  onError?: (error: Error) => void;
  /**
   * P1-06: fired when the omni WS drops unexpectedly and a reconnect is being
   * attempted. `attempt` is 1-based. Optional — existing callers need no change.
   */
  onReconnecting?: (attempt: number, maxAttempts: number) => void;
  /** P1-06: fired once a reconnect succeeds and the proxy is ready again. */
  onReconnected?: () => void;
  /**
   * Max reconnect attempts after an unexpected drop (default: 3). 0 disables
   * reconnect (one connection only — previous behavior).
   */
  maxReconnectAttempts?: number;
  /**
   * Base delay in ms between reconnect attempts (default: 500). Actual delay =
   * baseReconnectDelayMs * attempt (linear backoff). Injectable for tests.
   */
  baseReconnectDelayMs?: number;
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

  const baseUrl = options.productApiBaseUrl ?? deriveRealtimeWsBaseUrl(getProductApiBaseUrl());
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
  // FFT tap for a real pitch/brightness signal (spectral centroid).
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  const freqData = new Uint8Array(analyser.frequencyBinCount);
  // Real frame duration: 4096 samples / sampleRate (~256ms). The previous code
  // assumed 32ms frames, under-reporting silence/duration by ~8x.
  const frameMs = Math.round((4096 / audioContext.sampleRate) * 1000);
  const interruptEvalFrames = Math.max(1, Math.round(250 / frameMs));
  const guidanceEvalFrames = Math.max(1, Math.round(480 / frameMs));

  // P1-06: `ws` is reassignable so an unexpected drop can be replaced by a fresh
  // socket without tearing down the mic/AudioContext/processor (those persist).
  let ws: WebSocket = new WebSocket(wsUrl);
  let progress: AssistantSpeechProgress | null = null;
  // `closed` = the connection is permanently shut (user called close(), or
  // reconnect attempts were exhausted). Distinct from a transient drop.
  let closed = false;
  // `userClosed` = close() was called by the caller — an unexpected onclose must
  // NOT trigger reconnect when this is set.
  let userClosed = false;
  // Reconnect bookkeeping (P1-06).
  const maxReconnectAttempts = options.maxReconnectAttempts ?? 3;
  const baseReconnectDelayMs = options.baseReconnectDelayMs ?? 500;
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // Set true once the first connection has resolved; reconnect logic only runs
  // for drops AFTER the initial connection is established.
  let initialConnected = false;
  let audioQueue: Float32Array[] = [];
  let playbackNode: AudioBufferSourceNode | null = null;
  let currentStrategy: string | undefined;
  let fullAssistantTranscript = "";
  // What the AI has actually VOCALIZED so far this turn, accumulated from the
  // audio-transcript stream (response.audio_transcript.delta). Distinct from
  // fullAssistantTranscript (the full planned reply, fed externally via
  // markAssistantSpeaking): spoken ≤ planned while audio is still playing. Used
  // by cancelAndSaveContext to split spoken vs. not-yet-spoken by character
  // count (卫生: replaces the unreliable chunk-ratio split).
  let spokenTranscript = "";
  let pendingInterruptionContext: string | null = null;
  let interruptionScene: InterruptionScene = "perspective_shift";
  let aiIsSpeaking = false;
  /** Expression-state-aware interrupt detection (replaces raw-energy gate from c2008a0f).
   *  Evaluates the user's speaking rhythm + semantic signals so that backchannel
   *  words (嗯, 对) don't interrupt, but real sentences do. */
  const expressionDetector = createExpressionStateDetector();
  /** Computes real speech features (rate, pitch trend, pause position, repetition)
   *  from transcript + FFT, replacing the previous hardcoded constants. */
  const featureTracker = createSpeechFeatureTracker();
  let guidanceCountThisTurn = 0;
  let preSignals: InteractionPreSignals | null = options.preSignals ?? null;
  /** Tracks how many processor frames since the last time energy was above the
   *  speech threshold — used as a proxy for silenceMs. */
  let lowEnergyFrames = 0;
  /** Tracks how many consecutive high-energy frames have been observed — used
   *  as a rough audioDuration estimate. */
  let highEnergyFrames = 0;
  /** Accumulates semantic flags extracted from the latest partial transcript. */
  let semanticFlags: { hasFilledPause: boolean; hasVagueTerm: boolean; hasEmotionWord: boolean; hasRepetition: boolean; hasFalseStart: boolean } = {
    hasFilledPause: false, hasVagueTerm: false, hasEmotionWord: false, hasRepetition: false, hasFalseStart: false,
  };
  let latestPartialTranscript = "";

  function updateSemanticFlags(text: string) {
    latestPartialTranscript = text;
    featureTracker.onTranscript(text, Date.now());
    semanticFlags.hasFilledPause = /[嗯唔啊]/.test(text);
    semanticFlags.hasVagueTerm = /那个|这个|某种|怎么说呢|反正就是|你懂的|那种/.test(text);
    semanticFlags.hasEmotionWord = /矛盾|纠结|两难|不知道|不确定|也许|可能吧|烦|累|受不了|没办法|后悔|早知道|如果当初/.test(text);
    semanticFlags.hasRepetition = /(.)\1{2,}|(..+)\s*\1/.test(text);
    semanticFlags.hasFalseStart = /不是.{2,}是/.test(text);
  }

  function evaluateExpressionIntent(energy: number): ReturnType<typeof evaluateIntent> {
    const now = Date.now();
    const features = featureTracker.features(now, latestPartialTranscript);
    const exprInput: ExpressionStateInput = {
      speechRate: features.speechRate,
      baselineSpeechRate: features.baselineSpeechRate,
      energy, baselineEnergy: 0.3,
      pitchTrend: features.pitchTrend,
      currentSilenceMs: lowEnergyFrames * frameMs,
      pausePosition: features.pausePosition,
      ...semanticFlags,
      samePointCount: features.samePointCount,
      timeSinceLastGuidance: features.timeSinceLastGuidance,
    };
    const exprState = expressionDetector.evaluate(exprInput);
    return evaluateIntent({
      expressionState: exprState,
      preSignals,
      isAssistantSpeaking: aiIsSpeaking,
      partialTranscript: latestPartialTranscript,
      audioDuration: highEnergyFrames * frameMs,
      energy,
      guidanceCountThisTurn,
      timeSinceLastGuidance: features.timeSinceLastGuidance,
      guidanceEnabled: true,
      guidanceBudget: { maxPerTurn: 2, minIntervalMs: 5000 },
    });
  }

  function handleIntentDecision(decision: ReturnType<typeof evaluateIntent>) {
    if (decision.intent === "interruption" && decision.action === "stop") {
      cancelAndSaveContext();
      options.onSpeechStart?.();
    } else if (decision.intent === "guidance" && decision.action === "nudge" && decision.detail?.text) {
      guidanceCountThisTurn++;
      featureTracker.markGuidance(Date.now());
      options.onGuidance?.(decision.detail.text);
    } else if (decision.intent === "noise") {
      // ignore
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

    // 卫生: split spoken vs. not-yet-spoken by ACTUAL vocalized character count,
    // not the old chunk-index ratio (which divided spoken.length by totalChars —
    // and since fullAssistantTranscript ≈ the sum of all chunk texts, the ratio
    // collapsed to ~1 and `unspoken` was almost always "").
    //
    // `spokenTranscript` is what the model has actually said out loud so far
    // (from the audio-transcript stream). The full planned reply is whichever of
    // fullAssistantTranscript (fed via markAssistantSpeaking) or the longer
    // spokenTranscript we have. Unspoken = the planned tail after the spoken
    // boundary, located by character count.
    const spoken = spokenTranscript || fullAssistantTranscript;
    const planned =
      fullAssistantTranscript.length >= spoken.length ? fullAssistantTranscript : spoken;
    const spokenChars = Math.min(spoken.length, planned.length);
    const unspoken = planned.slice(spokenChars);

    stopPlayback();
    ws.send(JSON.stringify({ type: "response.cancel" }));

    // P1-11: build a resume context for EVERY interruption scene except
    // backchannel (which is a non-substantive "嗯/对" and intentionally has no
    // recovery template — buildInterruptionContext returns "" for it). Previously
    // only anchor_probe/perspective_shift were covered, so key_insight and
    // transition interruptions silently lost their recovery prompt even though
    // signals.ts already has templates for them.
    if (interruptionScene !== "backchannel") {
      const context = buildInterruptionContext({
        spokenSoFar: spoken,
        unspokenContent: unspoken,
        strategy: currentStrategy,
        userInput: ""
      });
      // Guard against an empty template (e.g. a future scene with no copy) so we
      // never stash an empty resume context that injectContextAndRespond would
      // try to fill.
      if (context) pendingInterruptionContext = context;
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

  // ── Audio capture pipeline (wired once; survives socket reconnects) ─────────
  // The processor reads `ws` dynamically each frame, so replacing `ws` on
  // reconnect needs no re-wiring here. setupProcessor is idempotent.
  let processorWired = false;
  function setupProcessor() {
    if (processorWired) return;
    processorWired = true;
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
      // Sample a real pitch/brightness signal for the expression engine.
      analyser.getByteFrequencyData(freqData);
      featureTracker.onCentroid(spectralCentroid(freqData, audioContext.sampleRate));
      // Track silence / speech frames for expression-state evaluation
      const ENERGY_THRESHOLD = 0.08;
      if (level > ENERGY_THRESHOLD) {
        lowEnergyFrames = 0;
        highEnergyFrames++;
      } else {
        lowEnergyFrames++;
        highEnergyFrames = Math.max(0, highEnergyFrames - 1);
      }
      if (aiIsSpeaking && highEnergyFrames >= interruptEvalFrames) {
        const decision = evaluateExpressionIntent(level);
        handleIntentDecision(decision);
      } else if (!aiIsSpeaking && highEnergyFrames > 0 && highEnergyFrames % guidanceEvalFrames === 0) {
        // Periodically evaluate expression state while the user speaks
        // (~480ms cadence) to catch guidance opportunities without spamming.
        const decision = evaluateExpressionIntent(level);
        if (decision.intent === "guidance" && decision.action === "nudge") {
          handleIntentDecision(decision);
        }
      }
    };
    source.connect(processor);
    processor.connect(audioContext.destination);
  }

  function buildConnection(): BailianRealtimeWebsocketConnection {
    return {
      session,
      stream,
      setStrategy(strategy) {
        currentStrategy = strategy;
        interruptionScene = getInterruptionScene(strategy);
      },
      updatePreSignals(next) {
        preSignals = next;
      },
      updateInstructions(instructions) {
        // Guard exactly like the audio-append path: only push when the socket
        // is OPEN, otherwise drop silently (no throw) so a slow/closed
        // connection never breaks the per-turn recall refresh.
        if (closed || ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ type: "session.update", session: { instructions } }));
      },
      beginAssistantTurn(input) {
        fullAssistantTranscript = "";
        spokenTranscript = "";
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
        // P1-06: user-initiated close — mark userClosed so the onclose handler
        // does NOT attempt to reconnect.
        userClosed = true;
        closed = true;
        if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        stopPlayback();
        processor.disconnect();
        source.disconnect();
        audioContext.close();
        for (const track of stream.getTracks()) {
          track.stop();
        }
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close(1000, "user closed");
        }
      }
    };
  }

  // ── Reconnect (P1-06) ──────────────────────────────────────────────────────
  // After the initial connection is established, an unexpected socket drop (not
  // user-initiated) triggers a linear-backoff reconnect. The mic/AudioContext/
  // processor persist; only the WebSocket is replaced. On success the proxy
  // re-emits proxy.connected, which re-sends sessionUpdate (via onopen) and fires
  // onReconnected. After maxReconnectAttempts failures we give up: mark closed
  // and report a terminal error so the UI can surface "voice disconnected".
  function scheduleReconnect() {
    if (closed || userClosed) return;
    if (reconnectAttempts >= maxReconnectAttempts) {
      closed = true;
      stopPlayback();
      options.onError?.(new Error(
        `Realtime voice connection lost and could not reconnect after ${maxReconnectAttempts} attempts`
      ));
      return;
    }
    reconnectAttempts += 1;
    const attempt = reconnectAttempts;
    options.onReconnecting?.(attempt, maxReconnectAttempts);
    const delay = baseReconnectDelayMs * attempt;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (closed || userClosed) return;
      try {
        ws = new WebSocket(wsUrl);
        wireSocket();
      } catch (err) {
        options.onError?.(err instanceof Error ? err : new Error(String(err)));
        scheduleReconnect();
      }
    }, delay);
  }

  // Wire lifecycle handlers onto the CURRENT `ws`. Called for the initial socket
  // and again for each reconnect socket. `handleServerEvent` is nested so it
  // always closes over the live `ws`.
  function wireSocket() {
    const socket = ws;
    socket.onopen = () => {
      socket.send(JSON.stringify(session.sessionUpdate));
      // The scripted opening line is an INITIAL-connection-only concern. On a
      // reconnect mid-interview we must NOT replay the opening (the conversation
      // is already underway) — guard on initialConnected.
      if (session.openingLine && !initialConnected) {
        socket.send(JSON.stringify({
          type: "response.create",
          response: {
            instructions: `直接说出这句开场，不要任何寒暄或自我介绍：${session.openingLine}`
          }
        }));
      }
    };

    socket.onmessage = (event) => {
      if (closed) return;
      try {
        const msg = JSON.parse(event.data as string);
        handleServerEvent(msg);
      } catch {
        // non-JSON message, ignore
      }
    };

    socket.onerror = () => {
      if (!closed) {
        options.onError?.(new Error("WebSocket connection error"));
      }
    };

    socket.onclose = () => {
      // Ignore close events from a stale socket we've already replaced.
      if (socket !== ws) return;
      stopPlayback();
      if (userClosed || closed) {
        closed = true;
        return;
      }
      if (!initialConnected) {
        // Dropped before we ever connected — the initial Promise's reject path
        // (settled below) owns this case; just mark closed.
        return;
      }
      // Unexpected drop after a working connection → try to reconnect.
      scheduleReconnect();
    };

    function handleServerEvent(msg: Record<string, unknown>) {
      const type = msg.type as string | undefined;

      switch (type) {
        case "proxy.connected": {
          setupProcessor();
          reconnectAttempts = 0; // healthy connection — reset backoff counter
          if (!initialConnected) {
            initialConnected = true;
            initialResolve(buildConnection());
          } else {
            options.onReconnected?.();
          }
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
            // Track vocalized text for accurate spoken/unspoken split on interrupt.
            spokenTranscript += delta;
            options.onAssistantTranscript?.(delta, false);
          }
          break;
        }

        case "response.audio_transcript.done": {
          const transcript = msg.transcript as string | undefined;
          if (transcript) {
            // The done frame carries the full vocalized transcript — prefer it as
            // the authoritative spoken length over the accumulated deltas.
            if (transcript.length >= spokenTranscript.length) spokenTranscript = transcript;
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
          guidanceCountThisTurn = 0; // new AI turn -> reset the user's per-turn guidance budget
          // New AI turn: reset the vocalized-transcript accumulator so an
          // interrupt mid-turn measures spoken length against THIS turn only
          // (unless App already seeded it via beginAssistantTurn). Don't clear if
          // we're about to cancel a resume turn we just queued.
          if (!pendingInterruptionContext) {
            spokenTranscript = "";
          } else {
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
          // P1-07: validate the non-standard {text, stash} delta shape before
          // concatenating (mirrors cascadedAsrSource). text/stash must each be a
          // string or absent; any non-string value (number, null, object…) is a
          // malformed delta — skip it and emit a structured warning so ops can
          // detect DashScope schema drift, instead of silently coercing garbage
          // ("[object Object]") into the transcript.
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
          if (text) {
            updateSemanticFlags(text);
            options.onUserTranscript?.(text, false);
          }
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
  }

  // Kick off the initial connection. The returned Promise resolves on the first
  // proxy.connected (via initialResolve), or rejects if the very first socket
  // errors/closes before connecting.
  let initialResolve!: (conn: BailianRealtimeWebsocketConnection) => void;
  let initialReject!: (err: Error) => void;
  const connectionPromise = new Promise<BailianRealtimeWebsocketConnection>((resolve, reject) => {
    initialResolve = resolve;
    initialReject = reject;
  });

  // If the very first socket fails before proxy.connected, reject the promise.
  // (Reconnect only applies AFTER initialConnected; pre-connect failure is a
  // hard error for the caller to handle.)
  const initialSocket = ws;
  const failInitial = (err: Error) => {
    if (initialConnected || closed || userClosed) return;
    closed = true;
    stopPlayback();
    initialReject(err);
  };
  const priorOnError = () => failInitial(new Error("WebSocket connection error"));
  const priorOnClose = () => failInitial(new Error("WebSocket closed before ready"));
  // Wire the standard handlers, then layer the initial-failure guards on top of
  // the same socket so a pre-connect drop rejects the returned Promise.
  wireSocket();
  const wiredOnError = initialSocket.onerror;
  const wiredOnClose = initialSocket.onclose;
  initialSocket.onerror = (ev) => { wiredOnError?.call(initialSocket, ev as Event); priorOnError(); };
  initialSocket.onclose = (ev) => { wiredOnClose?.call(initialSocket, ev as CloseEvent); priorOnClose(); };

  return connectionPromise;
}

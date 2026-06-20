/**
 * Shared realtime-voice types.
 *
 * These interfaces were previously defined in `bailianWebrtc.ts`. That module's
 * WebRTC *runtime* (`connectBailianRealtimeWebrtc`) was dead code (the app falls
 * back to the WebSocket path — see App's `webrtc_incomplete_fallback_to_ws`) and
 * has been removed (P2-6). The data/contract types it exported are still needed
 * by the live WebSocket client (`bailianWebsocket.ts`) and by `App.tsx`'s
 * realtime-connection union type, so they live here in a lightweight,
 * runtime-free module that any layer can import without pulling in WebRTC
 * plumbing.
 */
import type { RealtimeVoiceSessionResponse } from "../api/productApi";

/** One streamed chunk of the assistant's spoken reply. */
export interface AssistantSpeechChunk {
  text: string;
  audioMs?: number;
  receivedAt: number;
}

/** Accumulated progress of the assistant's current spoken turn. */
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

/**
 * Connection shape for the (now-removed) WebRTC omni transport. Retained as a
 * type only so App's `realtimeVoiceConnection` union still type-checks; the app
 * uses the structurally-compatible WebSocket connection at runtime. Browser DOM
 * types are used for the transport handles (the old `*Like` test seams went away
 * with the runtime).
 */
export interface BailianRealtimeWebrtcConnection {
  session: RealtimeVoiceSessionResponse;
  stream: MediaStream;
  peerConnection: RTCPeerConnection;
  dataChannel: RTCDataChannel;
  updateInstructions(instructions: string): void;
  beginAssistantTurn(input: { turnId?: string; providerTurnId?: string }): void;
  markAssistantSpeaking(input: { text: string; audioMs?: number }): void;
  completeAssistantTurn(): AssistantSpeechProgress | null;
  getAssistantProgress(): AssistantSpeechProgress | null;
  interruptAssistant(options?: InterruptAssistantOptions): Promise<InterruptAssistantResult | null>;
  close(): void;
}

export interface BufferedRecoveryTranscript {
  committed: string;
  partial: string;
  speechStarted: boolean;
  speechStoppedSilenceMs: number | null;
}

export interface RecoveryTranscriptBuffer {
  begin(): void;
  captureTranscript(text: string, isFinal: boolean): boolean;
  captureSpeechStarted(): boolean;
  captureSpeechStopped(silenceMs: number): boolean;
  release(): BufferedRecoveryTranscript | null;
  clear(): void;
}

function emptyBuffer(): BufferedRecoveryTranscript {
  return {
    committed: "",
    partial: "",
    speechStarted: false,
    speechStoppedSilenceMs: null,
  };
}

/**
 * Freezes ASR events from a replacement connection while an interrupted tail is
 * waiting for human review. Cumulative partials are compacted to the latest value,
 * so leaving the review open cannot grow an unbounded event queue.
 */
export function createRecoveryTranscriptBuffer(): RecoveryTranscriptBuffer {
  let buffered: BufferedRecoveryTranscript | null = null;

  return {
    begin() {
      buffered = emptyBuffer();
    },

    captureTranscript(text, isFinal) {
      if (!buffered) return false;
      if (isFinal) {
        buffered.committed += text;
        buffered.partial = "";
      } else {
        buffered.partial = text;
      }
      return true;
    },

    captureSpeechStarted() {
      if (!buffered) return false;
      buffered.speechStarted = true;
      // A resumed utterance supersedes the previous VAD stop. Replaying that old
      // stop after review would submit while the user is already speaking again.
      buffered.speechStoppedSilenceMs = null;
      return true;
    },

    captureSpeechStopped(silenceMs) {
      if (!buffered) return false;
      buffered.speechStoppedSilenceMs = silenceMs;
      return true;
    },

    release() {
      const snapshot = buffered;
      buffered = null;
      return snapshot;
    },

    clear() {
      buffered = null;
    },
  };
}

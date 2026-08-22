export type VoiceUiStatus =
  | "idle"
  | "connecting"
  | "thinking"
  | "listening"
  | "speaking"
  | "interrupted"
  | "reconnecting"
  | "degraded"
  | "exhausted";

type VoiceTransportLifecycleState =
  | "connecting"
  | "ready"
  | "reconnecting"
  | "exhausted"
  | "stopped";

type VoiceTransportPriority = "open" | "reconnecting" | "exhausted";

export interface VoiceTransportStateGuard {
  beginSession(): number;
  isCurrent(epoch: number): boolean;
  transition(epoch: number, state: VoiceTransportLifecycleState): boolean;
  allowsPipelineState(epoch: number): boolean;
  invalidate(epoch?: number): boolean;
}

export function createVoiceTransportStateGuard(): VoiceTransportStateGuard {
  let currentEpoch = 0;
  let priority: VoiceTransportPriority = "exhausted";

  return {
    beginSession() {
      currentEpoch += 1;
      priority = "open";
      return currentEpoch;
    },
    isCurrent(epoch) {
      return epoch === currentEpoch;
    },
    transition(epoch, state) {
      if (epoch !== currentEpoch) return false;
      if (state === "exhausted") {
        priority = "exhausted";
        return true;
      }
      if (priority === "exhausted") return false;
      if (state === "reconnecting") priority = "reconnecting";
      if (state === "ready") priority = "open";
      return true;
    },
    allowsPipelineState(epoch) {
      return epoch === currentEpoch && priority === "open";
    },
    invalidate(epoch) {
      if (epoch != null && epoch !== currentEpoch) return false;
      currentEpoch += 1;
      priority = "exhausted";
      return true;
    },
  };
}

interface CloseablePipeline {
  close(): void;
}

interface CloseableTts {
  close?(): void;
}

interface MutableVoiceRef<T> {
  current: T | null;
}

interface PendingVoiceReview {
  text: string;
  source: "echo" | "recovery";
}

interface TerminateVoicePipelineDeps {
  epoch: number;
  guard: VoiceTransportStateGuard;
  pipelineRef: MutableVoiceRef<CloseablePipeline>;
  ttsRef: MutableVoiceRef<CloseableTts>;
  pendingReview: PendingVoiceReview | null;
  updateInterviewInput: (merge: (current: string) => string) => void;
  clearReview: () => void;
  setRecording: (recording: boolean) => void;
  setVoiceStatus: (status: VoiceUiStatus) => void;
  clearLiveTranscript: () => void;
}

export interface VoicePipelineTerminationResult {
  terminated: boolean;
  preservedReview: boolean;
  noticeDetail: string;
}

const REVIEW_PRESERVED_NOTICE = "待确认转写已转入输入框，需用户检查后手动发送；尚未写入专访。";
const TEXT_INTERVIEW_CONTINUES_NOTICE = "本场文字专访仍可继续，可直接打字或重新点击「语音」。";

export function terminateVoicePipelineAfterExhaustion(
  deps: TerminateVoicePipelineDeps,
): VoicePipelineTerminationResult {
  if (!deps.guard.transition(deps.epoch, "exhausted")) {
    return { terminated: false, preservedReview: false, noticeDetail: "" };
  }

  const reviewText = deps.pendingReview?.text.trim() ?? "";
  if (reviewText) {
    deps.updateInterviewInput((current) => {
      const currentText = current.trim();
      if (!currentText) return reviewText;
      if (currentText.includes(reviewText)) return current;
      return `${current.trimEnd()}\n${reviewText}`;
    });
  }
  deps.clearReview();
  deps.clearLiveTranscript();
  deps.setRecording(false);
  deps.setVoiceStatus("exhausted");

  const pipeline = deps.pipelineRef.current;
  const tts = deps.ttsRef.current;
  deps.pipelineRef.current = null;
  deps.ttsRef.current = null;
  deps.guard.invalidate(deps.epoch);
  if (pipeline) pipeline.close();
  else tts?.close?.();

  const preservedReview = reviewText.length > 0;
  return {
    terminated: true,
    preservedReview,
    noticeDetail: preservedReview ? REVIEW_PRESERVED_NOTICE : TEXT_INTERVIEW_CONTINUES_NOTICE,
  };
}

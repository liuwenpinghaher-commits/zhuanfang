import { useCallback, useRef, useState } from "react";
import type { InterviewMode, InterviewSession, ProductState } from "../domain/types";

/**
 * Stage-3 B4: extract interview session shell state + re-entry guards from App.
 * Voice pipeline wiring stays in App until a fuller useRealtimeVoiceSession extraction.
 */
export function useInterviewSessionShell() {
  const [session, setSession] = useState<InterviewSession | null>(null);
  const [pendingMode, setPendingMode] = useState<InterviewMode>("decision");
  const [startingInterview, setStartingInterview] = useState(false);
  const [submittingTurn, setSubmittingTurn] = useState(false);
  const [finishingInterview, setFinishingInterview] = useState(false);
  const startingRef = useRef(false);
  const finishingRef = useRef(false);
  const togglingRef = useRef(false);

  const beginStartGuard = useCallback(() => {
    if (startingRef.current) return false;
    startingRef.current = true;
    setStartingInterview(true);
    return true;
  }, []);

  const endStartGuard = useCallback(() => {
    startingRef.current = false;
    setStartingInterview(false);
  }, []);

  const beginFinishGuard = useCallback(() => {
    if (finishingRef.current) return false;
    finishingRef.current = true;
    setFinishingInterview(true);
    return true;
  }, []);

  const endFinishGuard = useCallback(() => {
    finishingRef.current = false;
    setFinishingInterview(false);
  }, []);

  const continueFromState = useCallback((productState: ProductState, sessionId: string) => {
    const target = productState.sessions.find((item) => item.id === sessionId && item.status === "active");
    if (!target) return null;
    setSession(target);
    return target;
  }, []);

  return {
    session,
    setSession,
    pendingMode,
    setPendingMode,
    startingInterview,
    submittingTurn,
    setSubmittingTurn,
    finishingInterview,
    startingRef,
    finishingRef,
    togglingRef,
    beginStartGuard,
    endStartGuard,
    beginFinishGuard,
    endFinishGuard,
    continueFromState
  };
}

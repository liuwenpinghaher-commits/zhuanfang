/**
 * Interview session lifecycle actions extracted from App.tsx (architecture split).
 * Owns: continue / discard / launch / start / submitTurn / finish / applyControl.
 * Voice pipeline state stays in App (or useRealtimeVoiceControls).
 */
import type { Dispatch, FormEvent, MutableRefObject, SetStateAction } from "react";
import { ApiError, isNetworkError, productApiClient } from "../api/productApi";
import { makeId, resolveInterviewTopicHint } from "../domain/engine";
import { buildInterviewEndPresentation } from "../domain/session-end-presentation";
import { pcmS16leMonoToWav } from "../realtime/pcmWav";
import type { CascadedPipeline, TtsSink } from "../realtime/cascadedPipeline";
import type { SessionAudioRecorder } from "../realtime/sessionAudioRecorder";
import type {
  InterviewControlAction,
  InterviewMode,
  InterviewSession,
  ProductState
} from "../domain/types";
import { buildNotice, interviewControlGroups, type UiNotice, type View } from "../ui";

export type LastInterviewSummary = {
  noteTitle: string;
  pendingMemory: number;
  destination: "notes" | "memory";
  doNotSave: boolean;
  finishedAt: string;
  awaitingMemoryConfirm: boolean;
};

export interface UseInterviewSessionActionsArgs {
  productState: ProductState;
  setProductState: Dispatch<SetStateAction<ProductState>>;
  session: InterviewSession | null;
  setSession: Dispatch<SetStateAction<InterviewSession | null>>;
  pendingMode: InterviewMode;
  setPendingMode: Dispatch<SetStateAction<InterviewMode>>;
  activeSearchBriefId: string | undefined;
  setActiveSearchBriefId: Dispatch<SetStateAction<string | undefined>>;
  recommendedMode: InterviewMode;
  interviewInput: string;
  setInterviewInput: Dispatch<SetStateAction<string>>;
  setFailedTurnContent: Dispatch<SetStateAction<string | null>>;
  setSubmittingTurn: Dispatch<SetStateAction<boolean>>;
  setStartingInterview: Dispatch<SetStateAction<boolean>>;
  setFinishingInterview: Dispatch<SetStateAction<boolean>>;
  setLastInterviewSummary: Dispatch<SetStateAction<LastInterviewSummary | null>>;
  setNotice: Dispatch<SetStateAction<UiNotice | null>>;
  setView: Dispatch<SetStateAction<View>>;
  setApiPersistenceEnabled: Dispatch<SetStateAction<boolean>>;
  startingRef: MutableRefObject<boolean>;
  finishingRef: MutableRefObject<boolean>;
  pendingSessionCreateRef: MutableRefObject<{ id: string; signature: string } | null>;
  audioRecorderRef: MutableRefObject<SessionAudioRecorder | null>;
  ttsSinkRef: MutableRefObject<TtsSink | null>;
  /** cascadePipelineRef unused in finish path but kept for future drain symmetry */
  cascadePipelineRef?: MutableRefObject<CascadedPipeline | null>;
  adoptServerState: (state: ProductState) => void;
  closeRealtimeVoiceSession: () => void;
  scheduleReconnectProbe: () => void;
  /** After a control lands, push pendingControl into the live omni session if connected. */
  onControlApplied?: (session: InterviewSession) => void;
  /** Persist local asset edits before the server reads the book to open a session. */
  flushPendingProductState?: () => Promise<boolean>;
}

export function useInterviewSessionActions(args: UseInterviewSessionActionsArgs) {
  const {
    productState,
    setProductState,
    session,
    setSession,
    pendingMode,
    setPendingMode,
    activeSearchBriefId,
    setActiveSearchBriefId,
    recommendedMode,
    interviewInput,
    setInterviewInput,
    setFailedTurnContent,
    setSubmittingTurn,
    setStartingInterview,
    setFinishingInterview,
    setLastInterviewSummary,
    setNotice,
    setView,
    setApiPersistenceEnabled,
    startingRef,
    finishingRef,
    pendingSessionCreateRef,
    audioRecorderRef,
    ttsSinkRef,
    adoptServerState,
    closeRealtimeVoiceSession,
    scheduleReconnectProbe,
    onControlApplied,
    flushPendingProductState
  } = args;

  /** 继续一个未完成的 active 会话:把它装回 session 并切到工作台。 */
  function continueInterview(sessionId: string) {
    const target = productState.sessions.find((item) => item.id === sessionId && item.status === "active");
    if (!target) {
      setNotice(buildNotice("warning", "无法继续", "这条未完成的专访已不存在或已结束。"));
      return;
    }
    closeRealtimeVoiceSession();
    setInterviewInput("");
    setFailedTurnContent(null);
    setPendingMode(target.mode);
    setSession(target);
    setView("interview");
  }

  async function discardEmptyInterview(sessionId: string) {
    try {
      const result = await productApiClient.discardInterviewSession(sessionId);
      adoptServerState(result.state);
      setApiPersistenceEnabled(true);
      if (session?.id === sessionId) {
        setSession(null);
      }
      setNotice(buildNotice("info", "已移除空场专访", "尚未产生对话的会话已清理。"));
    } catch (err) {
      const message = err instanceof Error ? err.message : "请稍后重试。";
      // 后端不可达时本地乐观清理空壳，避免横幅长期占位
      if (isNetworkError(err)) {
        setApiPersistenceEnabled(false);
        const next = productState.sessions.find((s) => s.id === sessionId);
        const userTurns = next?.turns.filter((turn) => turn.role === "user").length ?? 0;
        if (next?.status === "active" && userTurns === 0) {
          setProductState({
            ...productState,
            sessions: productState.sessions.filter((s) => s.id !== sessionId)
          });
          if (session?.id === sessionId) setSession(null);
          setNotice(buildNotice("warning", "已在本地移除空场（尚未同步）", message));
          return;
        }
      }
      setNotice(buildNotice("danger", "无法移除空场", message));
    }
  }

  async function startInterview(
    mode: InterviewMode = pendingMode,
    searchBriefId = activeSearchBriefId,
    topicHint?: string,
    relatedThemeIds?: string[]
  ) {
    if (startingRef.current) return; // 已在创建中 → 跳过,避免双触发产生多个空 session
    startingRef.current = true;
    setStartingInterview(true);
    const normalizedTopicHint =
      topicHint?.trim() || resolveInterviewTopicHint(productState, searchBriefId ? { searchBriefId } : {});
    const normalizedThemeIds = Array.from(new Set((relatedThemeIds ?? []).filter(Boolean)));
    const createSignature = JSON.stringify({
      mode,
      searchBriefId: searchBriefId || "",
      topicHint: normalizedTopicHint,
      relatedThemeIds: normalizedThemeIds
    });
    if (pendingSessionCreateRef.current?.signature !== createSignature) {
      pendingSessionCreateRef.current = { id: makeId("session-create"), signature: createSignature };
    }
    const clientRequestId = pendingSessionCreateRef.current.id;
    try {
      const saved = flushPendingProductState ? await flushPendingProductState() : true;
      if (!saved) {
        setNotice(buildNotice("danger", "这场没开", "刚改的还没写进书里。恢复连接后再点一次。"));
        return;
      }
      const apiRun = await productApiClient.createInterviewSession({
        mode,
        strength: productState.profile.preferredStrength,
        ...(searchBriefId ? { searchBriefId } : {}),
        topicHint: normalizedTopicHint,
        ...(normalizedThemeIds.length > 0 ? { relatedThemeIds: normalizedThemeIds } : {}),
        clientRequestId
      });
      pendingSessionCreateRef.current = null;
      setSession(apiRun.session);
      adoptServerState(apiRun.state);
      closeRealtimeVoiceSession();
      setApiPersistenceEnabled(true);
      setView("interview");
      return;
    } catch (err) {
      // 失败即如实暴露——专访追问/归档都依赖服务端 LLM，离线本地草稿会话（确定性引擎
      // 模板追问冒充 AI 追问）已剔除。后端不可达就是不能用。
      const message = err instanceof Error && err.message ? err.message : "请检查服务后重试。";
      if (isNetworkError(err)) {
        setApiPersistenceEnabled(false);
        scheduleReconnectProbe();
        setNotice(buildNotice("danger", "无法开始专访", "后端不可达，专访功能不可用。恢复连接后请重试。"));
      } else {
        pendingSessionCreateRef.current = null;
        setNotice(buildNotice("danger", "无法开始专访", message));
      }
    } finally {
      startingRef.current = false;
      setStartingInterview(false);
    }
  }

  /** 一键开始：直接传参给 startInterview，不依赖 setState 后的值。 */
  async function launchInterview(
    mode: InterviewMode = recommendedMode,
    searchBriefId = activeSearchBriefId,
    topicHint?: string,
    relatedThemeIds?: string[],
    attachBrief = true
  ) {
    const activeSessions = productState.sessions.filter((item) => item.status === "active");
    if (activeSessions.length > 0) {
      const confirmed = window.confirm(
        `当前还有 ${activeSessions.length} 场未完成专访。继续新建会保留这些会话，你可以稍后逐一恢复。仍要新建吗？`
      );
      if (!confirmed) {
        setNotice(buildNotice("info", "已保留未完成专访", "请从页面顶部选择一场继续。"));
        return;
      }
    }
    setPendingMode(mode);
    if (attachBrief) {
      setActiveSearchBriefId(searchBriefId);
    }
    setSession(null);
    await startInterview(mode, attachBrief ? searchBriefId : undefined, topicHint, relatedThemeIds);
  }

  async function submitTurn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || !interviewInput.trim()) {
      return;
    }
    const content = interviewInput;
    setInterviewInput("");
    setSubmittingTurn(true);

    try {
      const apiRun = await productApiClient.sendInterviewTurn(session.id, { content });
      // Use the server's authoritative session — it already carries the new
      // user+assistant turns AND its own interactionPreSignals. (The old code
      // spread the STALE closure `session` here, which dropped the new turns
      // whenever the reply included pre_signals, i.e. always with the real LLM.)
      setSession(apiRun.session);
      setFailedTurnContent(null);
      adoptServerState(apiRun.state);
      setApiPersistenceEnabled(true);
    } catch (err) {
      // 失败即如实暴露、恢复输入让用户重试——离线本地"确定性引擎追问"已剔除。
      const message = err instanceof Error && err.message ? err.message : "本轮未送到服务端，请重试。";
      if (isNetworkError(err)) {
        setApiPersistenceEnabled(false);
      }
      setNotice(buildNotice("danger", "本轮未送达", message));
      setInterviewInput(content);
      setFailedTurnContent(content);
    } finally {
      setSubmittingTurn(false);
    }
  }

  async function finishInterview() {
    if (!session) {
      return;
    }
    if (finishingRef.current) return; // 防重入:/end 在途(LLM 档案抽取慢),忽略重复点击
    // Align with the server's rule: at least one USER turn (control feedback turns
    // don't count). Pre-checking avoids a 422 that the catch would misread as offline.
    const userTurnCount = session.turns.filter((turn) => turn.role === "user").length;
    if (userTurnCount === 0) {
      setNotice(buildNotice("warning", "还不能结束", "先回答至少一轮，再结束本场。"));
      return;
    }

    finishingRef.current = true;
    setFinishingInterview(true);
    try {
      const endedSessionId = session.id;
      const apiRun = await productApiClient.endInterviewSession(endedSessionId);
      // The /end response is already the authoritative LIGHT state (turns
      // offloaded to cold storage). Adopt it so the autosave effect doesn't PUT
      // the (now empty) turns back and re-inflate the just-offloaded session.
      adoptServerState(apiRun.state);
      setApiPersistenceEnabled(true);
      // Whole-session voice recording: stop it BEFORE closeRealtimeVoiceSession()
      // tears down the mic tracks (MediaRecorder needs the live stream to flush its
      // final chunk), then upload. Best-effort — a failed upload only warns; it must
      // not block ending the interview. On the text path the ref is null → skipped.
      // 「本场不保存」(doNotSave) 的会话：两路音频（受访者麦克风 + 主持人 TTS）一律
      // 不上传——用户明确要求不落盘，录音仍需 stop 以释放 MediaRecorder，但直接丢弃。
      const skipAudioUpload = session.doNotSave === true;
      if (skipAudioUpload) {
        console.info(JSON.stringify({ event: "audio_upload_skipped_do_not_save", sessionId: endedSessionId }));
      }
      const recorder = audioRecorderRef.current;
      audioRecorderRef.current = null;
      if (recorder) {
        if (skipAudioUpload) {
          void recorder.stop().catch(() => {
            /* discarded */
          });
        } else {
          void recorder
            .stop()
            .then(
              ({
                blob,
                durationMs,
                recordingStartedAt
              }: {
                blob: Blob;
                durationMs: number;
                recordingStartedAt: string;
              }) => productApiClient.uploadSessionAudio(endedSessionId, blob, durationMs, recordingStartedAt)
            )
            .catch(() =>
              setNotice(buildNotice("warning", "录音未保存", "本场语音录音上传失败，不影响笔记与资产。"))
            );
        }
      }
      // Host (interviewer) TTS audio: drain the sink's side-channel PCM tap, wrap
      // as WAV, upload as role=interviewer. Best-effort and non-blocking — a
      // failure only warns to console. No recordingStartedAt: the host audio is
      // stitched-together AI speech with no continuous timeline, so per-turn seek
      // doesn't apply (the viewer plays it as one continuous track). The sink ref
      // is cleared by closeRealtimeVoiceSession() below; read it before that.
      const ttsSink = ttsSinkRef.current;
      if (!skipAudioUpload && ttsSink?.getRecordedPcm) {
        const rec = ttsSink.getRecordedPcm();
        if (rec && rec.pcm.length > 0) {
          const wav = pcmS16leMonoToWav(rec.pcm, rec.sampleRate);
          void productApiClient
            .uploadSessionAudio(endedSessionId, wav, undefined, undefined, "interviewer")
            .catch((err: unknown) => {
              console.warn(
                JSON.stringify({
                  event: "interviewer_audio_upload_failed",
                  error: err instanceof Error ? err.message : String(err)
                })
              );
            });
        }
      }
      setSession(null);
      closeRealtimeVoiceSession();
      // Journey honesty (R-P1-04 / doNotSave): pure presentation rules — doNotSave never claims archive.
      const presentation = buildInterviewEndPresentation({
        doNotSave: skipAudioUpload,
        pendingMemoryCandidateCount: Number(apiRun.pendingMemoryCandidateCount ?? 0),
        longTermRecallRequiresApproval: apiRun.longTermRecallRequiresApproval === true,
        noteTitle: apiRun.note?.title
      });
      setLastInterviewSummary({
        ...presentation.lastSummary,
        finishedAt: new Date().toISOString()
      });
      setNotice(
        buildNotice(presentation.noticeKind, presentation.noticeTitle, presentation.noticeBody)
      );
      setView(presentation.destination === "memory" ? "memory" : "home");
      return;
    } catch (err) {
      // 已结束(409)/会话不存在(404):这场专访其实已经收尾(常见于 /end 调 LLM 较慢时用户
      // 重复点"结束")。与成功路同归今日台，绝不误报"结束失败"或谎称已跳到笔记。
      if (err instanceof ApiError && (err.status === 409 || err.status === 404)) {
        setSession(null);
        closeRealtimeVoiceSession();
        setNotice(buildNotice("info", "专访已结束", "这场专访已经收尾，可在下方「上场摘要」或笔记/资产中继续。"));
        setView("home");
        return;
      }
      // 失败即如实暴露——会话保持打开可重试，离线本地确定性 finalize（模板轻量档案）已剔除。
      const message = err instanceof Error && err.message ? err.message : "请稍后重试。本次未生成档案。";
      if (isNetworkError(err)) {
        setApiPersistenceEnabled(false);
        setNotice(buildNotice("danger", "结束失败", "后端不可达，无法归档。会话已保留，恢复连接后请重试。"));
      } else {
        setNotice(buildNotice("danger", "结束失败", `${message}`));
      }
    } finally {
      finishingRef.current = false;
      setFinishingInterview(false);
    }
  }

  async function applyInterviewControl(action: InterviewControlAction) {
    if (!session) {
      return;
    }
    const controlLabel =
      interviewControlGroups.flatMap((group) => group.actions).find((option) => option.id === action)?.label ??
      "访谈控制";

    try {
      const apiRun = await productApiClient.applyInterviewControl(session.id, { action });
      setSession(apiRun.session);
      adoptServerState(apiRun.state);
      setApiPersistenceEnabled(true);
      onControlApplied?.(apiRun.session);
      setNotice(buildNotice("info", "访谈控制已应用", `下一轮会按「${controlLabel}」调整。`));
    } catch (err) {
      // 失败即如实暴露——离线本地控制分叉已剔除（会话是服务端权威的，本地改了也不生效）。
      const message = err instanceof Error && err.message ? err.message : "请稍后重试。";
      if (isNetworkError(err)) {
        setApiPersistenceEnabled(false);
      }
      setNotice(buildNotice("danger", "控制未生效", message));
    }
  }

  async function suppressRevisit(kind: "decision" | "debt", label: string) {
    if (!session) return;
    try {
      const apiRun = await productApiClient.suppressInterviewRevisit(session.id, { kind, label });
      setSession(apiRun.session);
      adoptServerState(apiRun.state);
      setApiPersistenceEnabled(true);
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message : "请稍后重试。";
      if (isNetworkError(err)) {
        setApiPersistenceEnabled(false);
      }
      setNotice(buildNotice("danger", "没能记下不追", message));
    }
  }

  return {
    continueInterview,
    discardEmptyInterview,
    launchInterview,
    startInterview,
    submitTurn,
    finishInterview,
    applyInterviewControl,
    suppressRevisit
  };
}

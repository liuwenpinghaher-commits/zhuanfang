import { useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { ApiError, isNetworkError, productApiClient } from "../api/productApi";
import { isPristineDemoState, productStateContentSignature } from "../domain/storage";
import {
  backupUnsyncedState,
  clearOfflineOutbox,
  hasUnsyncedLocalChanges,
  nextBackoffMs,
  reconcileOfflineOutbox,
  upsertOfflineOutbox,
  writeOfflineOutbox,
  type OfflineOutbox,
  type OfflineSyncConflict
} from "../domain/offline-sync";
import type { ProductState } from "../domain/types";
import { buildNotice, type UiNotice } from "../ui";

export interface SyncConflictState {
  outbox: OfflineOutbox;
  remoteState: ProductState;
  mergedState: ProductState;
  conflicts: OfflineSyncConflict[];
}

interface UseOfflineProductSyncArgs {
  productState: ProductState;
  setProductState: Dispatch<SetStateAction<ProductState>>;
  productStateRef: MutableRefObject<ProductState>;
  apiPersistenceEnabled: boolean;
  setApiPersistenceEnabled: Dispatch<SetStateAction<boolean>>;
  setNotice: Dispatch<SetStateAction<UiNotice | null>>;
  /** Seed outbox from App mount (may restore pending local work). */
  initialOutbox: OfflineOutbox | null;
}

/**
 * Offline outbox + three-way merge + autosave backoff (F-05).
 * Extracted from App.tsx to shrink the shell and keep sync logic cohesive.
 */
export function useOfflineProductSync({
  productState,
  setProductState,
  productStateRef,
  apiPersistenceEnabled,
  setApiPersistenceEnabled,
  setNotice,
  initialOutbox
}: UseOfflineProductSyncArgs) {
  const lastSavedContentRef = useRef<string>("");
  const offlineOutboxRef = useRef<OfflineOutbox | null>(initialOutbox);
  const lastSyncedStateRef = useRef<ProductState>(initialOutbox?.baseState ?? productState);
  const offlineObservedSignatureRef = useRef(productStateContentSignature(productState));
  const [syncConflict, setSyncConflict] = useState<SyncConflictState | null>(null);
  const [syncResolving, setSyncResolving] = useState(false);
  const autosaveFailuresRef = useRef(0);
  const autosaveRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [autosaveRetryNonce, setAutosaveRetryNonce] = useState(0);
  const reconnectFailuresRef = useRef(0);
  const [reconnectNonce, setReconnectNonce] = useState(0);
  const reconnectProbeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const outboxStagingFailedRef = useRef(false);
  const outboxStagingNoticeShownRef = useRef(false);
  const offlineSyncQueueRef = useRef<Promise<void>>(Promise.resolve());

  function scheduleReconnectProbe() {
    if (reconnectProbeTimerRef.current !== null) return;
    reconnectFailuresRef.current += 1;
    const delayMs = nextBackoffMs(reconnectFailuresRef.current);
    reconnectProbeTimerRef.current = setTimeout(() => {
      reconnectProbeTimerRef.current = null;
      setReconnectNonce((n) => n + 1);
    }, delayMs);
  }

  function cancelReconnectProbe() {
    if (reconnectProbeTimerRef.current !== null) {
      clearTimeout(reconnectProbeTimerRef.current);
      reconnectProbeTimerRef.current = null;
    }
  }

  function shouldProbeReconnect(err: unknown): boolean {
    return isNetworkError(err) || (err instanceof ApiError && err.status >= 500);
  }

  function writePendingOutbox(next: OfflineOutbox) {
    offlineOutboxRef.current = next;
    if (!writeOfflineOutbox(next)) {
      outboxStagingFailedRef.current = true;
      if (!outboxStagingNoticeShownRef.current) {
        outboxStagingNoticeShownRef.current = true;
        setNotice(
          buildNotice(
            "danger",
            "离线同步队列无法保存",
            "浏览器存储空间不足或被禁用。请先导出备份，并保持本页面打开，避免未同步修改丢失。"
          )
        );
      }
      return;
    }
    outboxStagingFailedRef.current = false;
    outboxStagingNoticeShownRef.current = false;
  }

  function stageOfflineState(localState: ProductState, conflicts?: OfflineSyncConflict[]): OfflineOutbox {
    const next = upsertOfflineOutbox({
      existing: offlineOutboxRef.current,
      baseState: lastSyncedStateRef.current,
      localState,
      ...(conflicts ? { conflicts } : {})
    });
    writePendingOutbox(next);
    return next;
  }

  function clearPendingSync() {
    offlineOutboxRef.current = null;
    outboxStagingFailedRef.current = false;
    outboxStagingNoticeShownRef.current = false;
    clearOfflineOutbox();
    setSyncConflict(null);
  }

  function acceptAuthoritativeState(state: ProductState) {
    const signature = productStateContentSignature(state);
    lastSavedContentRef.current = signature;
    lastSyncedStateRef.current = state;
    offlineObservedSignatureRef.current = signature;
    clearPendingSync();
    productStateRef.current = state;
    setProductState(state);
    setApiPersistenceEnabled(true);
    reconnectFailuresRef.current = 0;
    cancelReconnectProbe();
  }

  function acknowledgeSavedState(serverState: ProductState, attemptedSignature: string) {
    autosaveFailuresRef.current = 0;
    lastSyncedStateRef.current = serverState;
    setSyncConflict(null);
    setApiPersistenceEnabled(true);
    const current = productStateRef.current;
    const currentSignature = productStateContentSignature(current);
    if (currentSignature === attemptedSignature) {
      const serverSignature = productStateContentSignature(serverState);
      lastSavedContentRef.current = serverSignature;
      offlineObservedSignatureRef.current = serverSignature;
      productStateRef.current = serverState;
      setProductState(serverState);
      clearPendingSync();
      return;
    }

    lastSavedContentRef.current = attemptedSignature;
    const currentWithRevision =
      current.revision === serverState.revision ? current : { ...current, revision: serverState.revision };
    productStateRef.current = currentWithRevision;
    offlineObservedSignatureRef.current = currentSignature;
    setProductState(currentWithRevision);

    const pending = upsertOfflineOutbox({
      baseState: serverState,
      localState: currentWithRevision
    });
    writePendingOutbox(pending);
  }

  function presentSyncConflict(
    outbox: OfflineOutbox,
    remoteState: ProductState,
    mergedState: ProductState,
    conflicts: OfflineSyncConflict[]
  ) {
    const pending = upsertOfflineOutbox({
      existing: outbox,
      baseState: outbox.baseState,
      localState: mergedState,
      conflicts
    });
    writePendingOutbox(pending);
    lastSyncedStateRef.current = remoteState;
    lastSavedContentRef.current = productStateContentSignature(remoteState);
    offlineObservedSignatureRef.current = productStateContentSignature(mergedState);
    productStateRef.current = mergedState;
    setProductState(mergedState);
    setApiPersistenceEnabled(false);
    setSyncConflict({ outbox: pending, remoteState, mergedState, conflicts });
    setNotice(
      buildNotice(
        "warning",
        "离线修改与服务器版本存在冲突",
        `检测到 ${conflicts.length} 处同一内容被双端修改。系统已保留本地工作，等待你选择版本。`
      )
    );
  }

  async function synchronizeOfflineOutboxCore(
    inputOutbox: OfflineOutbox,
    remoteState: ProductState,
    retryBudget = 1,
    isCancelled: () => boolean = () => false
  ): Promise<void> {
    let outbox = inputOutbox;
    const latestLocal = productStateRef.current;
    if (productStateContentSignature(latestLocal) !== productStateContentSignature(outbox.localState)) {
      outbox = upsertOfflineOutbox({
        existing: outbox,
        baseState: outbox.baseState,
        localState: latestLocal
      });
      writePendingOutbox(outbox);
    }

    const reconciliation = reconcileOfflineOutbox(outbox, remoteState);
    if (isCancelled()) return;
    if (reconciliation.status === "conflict") {
      presentSyncConflict(outbox, remoteState, reconciliation.state, reconciliation.conflicts);
      return;
    }

    if (productStateContentSignature(reconciliation.state) === productStateContentSignature(remoteState)) {
      acceptAuthoritativeState(remoteState);
      return;
    }

    const attempted = { ...reconciliation.state, revision: remoteState.revision };
    const attemptedSignature = productStateContentSignature(attempted);
    outbox = upsertOfflineOutbox({
      existing: outbox,
      baseState: outbox.baseState,
      localState: attempted
    });
    writePendingOutbox(outbox);
    productStateRef.current = attempted;
    offlineObservedSignatureRef.current = attemptedSignature;
    lastSavedContentRef.current = attemptedSignature;
    setProductState(attempted);
    const result = await productApiClient.saveState(attempted);
    if (isCancelled()) return;
    if (!result.conflicted) {
      acknowledgeSavedState(result.state, attemptedSignature);
      setNotice(buildNotice("success", "离线修改已同步", "本地与服务器的非冲突修改已合并并保存。"));
      return;
    }

    const rebased = upsertOfflineOutbox({
      baseState: remoteState,
      localState: attempted
    });
    writePendingOutbox(rebased);
    if (retryBudget > 0) {
      await synchronizeOfflineOutboxCore(rebased, result.state, retryBudget - 1, isCancelled);
      return;
    }
    const finalReconciliation = reconcileOfflineOutbox(rebased, result.state);
    if (finalReconciliation.status === "conflict") {
      presentSyncConflict(rebased, result.state, finalReconciliation.state, finalReconciliation.conflicts);
      return;
    }
    throw new Error("同步期间服务器持续更新，已保留 outbox，稍后重试。");
  }

  function synchronizeOfflineOutbox(
    inputOutbox: OfflineOutbox,
    remoteState: ProductState,
    retryBudget = 1,
    isCancelled: () => boolean = () => false
  ): Promise<void> {
    const run = async () => {
      if (isCancelled()) return;
      const livePending = offlineOutboxRef.current;
      if (!livePending) {
        if (remoteState.revision > lastSyncedStateRef.current.revision) {
          acceptAuthoritativeState(remoteState);
        }
        return;
      }
      await synchronizeOfflineOutboxCore(livePending, remoteState, retryBudget, isCancelled);
    };
    const chained = offlineSyncQueueRef.current.then(run, run);
    offlineSyncQueueRef.current = chained.then(
      () => undefined,
      () => undefined
    );
    return chained;
  }

  // Autosave when online; stage outbox when offline.
  useEffect(() => {
    const signature = productStateContentSignature(productState);
    if (!apiPersistenceEnabled) {
      if (signature !== offlineObservedSignatureRef.current) {
        stageOfflineState(productState, syncConflict?.conflicts);
        offlineObservedSignatureRef.current = signature;
        if (!syncConflict) {
          scheduleReconnectProbe();
        }
      }
      return;
    }
    if (signature === lastSavedContentRef.current) {
      return;
    }
    const timer = setTimeout(() => {
      const pending = stageOfflineState(productState);
      productApiClient
        .saveState(productState)
        .then(({ state: server, conflicted }) => {
          if (autosaveRetryTimerRef.current !== null) {
            clearTimeout(autosaveRetryTimerRef.current);
            autosaveRetryTimerRef.current = null;
          }
          if (conflicted) {
            void synchronizeOfflineOutbox(pending, server).catch((err) => {
              setApiPersistenceEnabled(false);
              setNotice(buildNotice("warning", "同步暂未完成", err instanceof Error ? err.message : String(err)));
              if (shouldProbeReconnect(err)) {
                scheduleReconnectProbe();
              }
            });
          } else {
            acknowledgeSavedState(server, signature);
          }
        })
        .catch((err) => {
          autosaveFailuresRef.current += 1;
          console.warn(
            JSON.stringify({
              event: "autosave_failed",
              consecutiveFailures: autosaveFailuresRef.current,
              error: String(err)
            })
          );
          const governanceInFlight = err instanceof ApiError && err.status === 409;
          const retryable =
            isNetworkError(err) || (err instanceof ApiError && err.status >= 500) || governanceInFlight;
          if (retryable && autosaveRetryTimerRef.current === null) {
            const delayMs = nextBackoffMs(autosaveFailuresRef.current);
            autosaveRetryTimerRef.current = setTimeout(() => {
              autosaveRetryTimerRef.current = null;
              setAutosaveRetryNonce((n) => n + 1);
            }, delayMs);
          }
          if (err instanceof ApiError && err.status === 413) {
            setNotice(
              buildNotice(
                "warning",
                "本地改动尚未同步到服务器",
                "数据体积超出服务器限制；离线 outbox 已保留，请先导出备份并清理超大内容。"
              )
            );
          } else if (governanceInFlight) {
            setNotice(
              buildNotice(
                "warning",
                "服务器正在执行数据治理",
                "清空/导入/重置进行中，你的本地改动已保留，将在其完成后自动重试同步。"
              )
            );
          } else if (autosaveFailuresRef.current === 2) {
            setNotice(
              buildNotice(
                "warning",
                "本地改动尚未同步到服务器",
                "连续保存失败，请检查后端是否在运行；离线 outbox 已保存，并会按间隔自动重试。"
              )
            );
          }
        });
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional signature-driven autosave
  }, [productState, apiPersistenceEnabled, autosaveRetryNonce, syncConflict]);

  // Mount + reconnect probe (also driven by reconnectNonce).
  useEffect(() => {
    let cancelled = false;

    productApiClient
      .getState()
      .then(async (remoteState) => {
        if (cancelled) return;
        reconnectFailuresRef.current = 0;
        cancelReconnectProbe();
        let pending = offlineOutboxRef.current;
        if (!pending && hasUnsyncedLocalChanges()) {
          pending = upsertOfflineOutbox({
            baseState: remoteState,
            localState: productStateRef.current
          });
          writePendingOutbox(pending);
        }
        if (!pending && outboxStagingFailedRef.current) {
          pending = upsertOfflineOutbox({
            baseState: lastSyncedStateRef.current,
            localState: productStateRef.current
          });
          writePendingOutbox(pending);
        }
        if (!pending) {
          acceptAuthoritativeState(remoteState);
          return;
        }
        await synchronizeOfflineOutbox(pending, remoteState, 1, () => cancelled);
      })
      .catch((err) => {
        if (!cancelled) {
          setApiPersistenceEnabled(false);
          if (offlineOutboxRef.current) {
            setNotice(
              buildNotice(
                "warning",
                "离线修改仍在等待同步",
                err instanceof Error ? err.message : "后端当前不可用；持久 outbox 已保留本地工作。"
              )
            );
          }
          if (shouldProbeReconnect(err)) {
            scheduleReconnectProbe();
          }
        }
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reconnectNonce]);

  useEffect(() => {
    return () => {
      cancelReconnectProbe();
      if (autosaveRetryTimerRef.current !== null) {
        clearTimeout(autosaveRetryTimerRef.current);
        autosaveRetryTimerRef.current = null;
      }
    };
  }, []);

  async function keepLocalConflictVersion() {
    if (!syncConflict || syncResolving) return;
    setSyncResolving(true);
    const resolved = upsertOfflineOutbox({
      baseState: syncConflict.remoteState,
      localState: productStateRef.current
    });
    writePendingOutbox(resolved);
    setSyncConflict(null);
    try {
      await synchronizeOfflineOutbox(resolved, syncConflict.remoteState, 1);
    } catch (err) {
      setApiPersistenceEnabled(false);
      setNotice(buildNotice("warning", "本地版本尚未同步", err instanceof Error ? err.message : String(err)));
      if (shouldProbeReconnect(err)) {
        scheduleReconnectProbe();
      }
    } finally {
      setSyncResolving(false);
    }
  }

  async function useRemoteConflictVersion() {
    if (!syncConflict || syncResolving) return;
    setSyncResolving(true);
    try {
      const latestRemote = await productApiClient.getState();
      backupUnsyncedState(productStateRef.current);
      acceptAuthoritativeState(latestRemote);
      if (isPristineDemoState(latestRemote)) {
        setNotice(
          buildNotice(
            "warning",
            "已采用服务器版本（疑似示例/初始数据）",
            "服务器返回的内容与首次运行的示例数据一致，后端可能被重置或损坏后重启。若这不是你预期的恢复结果，本地版本已备份，请检查后端后再决定。"
          )
        );
      } else {
        setNotice(buildNotice("info", "已采用服务器版本", "本地冲突修改已由你明确放弃，已加载服务器最新版本。"));
      }
    } catch {
      setNotice(
        buildNotice("warning", "暂时无法采用服务器版本", "后端当前不可用；本地 outbox 与冲突状态仍保留，请稍后重试。")
      );
      scheduleReconnectProbe();
    } finally {
      setSyncResolving(false);
    }
  }


  /** Offline-only local reset: drop pending outbox and treat `state` as the new offline baseline (no autosave stage). */
  function alignOfflineBaseline(state: ProductState) {
    clearPendingSync();
    const signature = productStateContentSignature(state);
    lastSyncedStateRef.current = state;
    lastSavedContentRef.current = signature;
    offlineObservedSignatureRef.current = signature;
    productStateRef.current = state;
    setProductState(state);
  }

  return {
    syncConflict,
    syncResolving,
    lastSavedContentRef,
    offlineOutboxRef,
    lastSyncedStateRef,
    acceptAuthoritativeState,
    synchronizeOfflineOutbox,
    writePendingOutbox,
    scheduleReconnectProbe,
    shouldProbeReconnect,
    keepLocalConflictVersion,
    useRemoteConflictVersion,
    alignOfflineBaseline
  };
}

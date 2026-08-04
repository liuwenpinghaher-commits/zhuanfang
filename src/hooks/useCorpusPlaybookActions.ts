/**
 * Corpus / playbook patch actions extracted from App.tsx (architecture split).
 */
import type { Dispatch, SetStateAction } from "react";
import { ApiError, productApiClient } from "../api/productApi";
import { dedupeGeneratedArtifacts, deleteCorpusInsightBundle } from "../domain/lifecycle";
import type { ProductState } from "../domain/types";
import { buildNotice, type UiNotice } from "../ui";

export interface UseCorpusPlaybookActionsArgs {
  productState: ProductState;
  setProductState: Dispatch<SetStateAction<ProductState>>;
  setNotice: Dispatch<SetStateAction<UiNotice | null>>;
  setView: Dispatch<SetStateAction<string>>; // App View union accepted as string
  setCorpusAudioBase64: Dispatch<SetStateAction<string>>;
  setCorpusAudioFileName: Dispatch<SetStateAction<string>>;
  setCorpusMediaType: Dispatch<SetStateAction<string>>;
  setCorpusSourceUrl: Dispatch<SetStateAction<string>>;
  adoptServerState: (state: ProductState) => void;
}

export function useCorpusPlaybookActions({
  productState,
  setProductState,
  setNotice,
  setView,
  setCorpusAudioBase64,
  setCorpusAudioFileName,
  setCorpusMediaType,
  setCorpusSourceUrl,
  adoptServerState
}: UseCorpusPlaybookActionsArgs) {
  function selectCorpusAudioFile(audioBase64: string, fileName: string) {
    setCorpusAudioBase64(audioBase64);
    setCorpusAudioFileName(fileName);
    setCorpusMediaType("audio");
    setCorpusSourceUrl("");
  }

  function clearCorpusAudioFile() {
    setCorpusAudioBase64("");
    setCorpusAudioFileName("");
  }

  function removeCorpusInsight(insightId: string) {
    if (
      typeof window !== "undefined" &&
      !window.confirm("确定要删除这次语料分析吗？已应用的 PlaybookPatch 会保留为历史记录。")
    ) {
      return;
    }
    setProductState(deleteCorpusInsightBundle(productState, insightId));
    setNotice(buildNotice("warning", "语料分析已删除", "已应用的引擎补丁仍会保留。"));
  }

  function applyPlaybookPatch(patchId: string, overrideRules?: string[]) {
    productApiClient
      .applyPlaybookPatch(patchId, overrideRules)
      .then((next) => {
        adoptServerState(next);
        setNotice(buildNotice("success", "PlaybookPatch 已应用", "系统配置已记录新的访谈策略版本。"));
        setView("config");
      })
      .catch((err) => {
        const conflict = err instanceof ApiError && (err.status === 409 || err.status === 404);
        setNotice(
          buildNotice(
            "warning",
            conflict ? "无法应用" : "操作失败",
            conflict
              ? "该补丁已处置(已应用或已撤销)或不存在,不能重复应用。"
              : "应用补丁需要后端在线。"
          )
        );
      });
  }

  function revertPatch(patchId: string) {
    productApiClient
      .revertPlaybookPatch(patchId)
      .then((next) => {
        adoptServerState(next);
        setNotice(buildNotice("info", "已撤销应用", "该访谈策略补丁已回退，后续访谈不再套用它。"));
      })
      .catch((err) => {
        const conflict = err instanceof ApiError && (err.status === 422 || err.status === 404);
        setNotice(
          buildNotice(
            "warning",
            conflict ? "无法撤销" : "操作失败",
            conflict ? "只有已应用的补丁可以撤销。" : "撤销补丁需要后端在线。"
          )
        );
      });
  }

  function cleanupGeneratedArtifacts() {
    const result = dedupeGeneratedArtifacts(productState);
    const removedTotal =
      result.removed.searchBriefs + result.removed.podcastEpisodes + result.removed.corpusInsights;
    setProductState(result.nextState);
    setNotice(
      removedTotal > 0
        ? buildNotice(
            "warning",
            "重复生成物已清理",
            `删除 ${result.removed.searchBriefs} 份搜索简报、${result.removed.podcastEpisodes} 条播客、${result.removed.corpusInsights} 次语料分析。`
          )
        : buildNotice("info", "没有发现重复生成物", "搜索简报、播客和语料分析都已保持唯一。")
    );
  }

  return {
    selectCorpusAudioFile,
    clearCorpusAudioFile,
    removeCorpusInsight,
    applyPlaybookPatch,
    revertPatch,
    cleanupGeneratedArtifacts
  };
}

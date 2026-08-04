/**
 * Search-brief related actions extracted from App.tsx (architecture split).
 */
import type { Dispatch, SetStateAction } from "react";
import {
  createKnowledgeDebtFromSearchBrief,
  createPointFromSearchBrief,
  createQuestionFromSearchBrief
} from "../domain/search-brief";
import { deleteSearchBrief } from "../domain/lifecycle";
import type { ProductState, SearchProviderId } from "../domain/types";
import { buildNotice, type UiNotice } from "../ui";

export interface UseSearchBriefActionsArgs {
  productState: ProductState;
  setProductState: Dispatch<SetStateAction<ProductState>>;
  setNotice: Dispatch<SetStateAction<UiNotice | null>>;
  setActiveSearchBriefId: Dispatch<SetStateAction<string | undefined>>;
  launchInterview: (mode: "learning", briefId: string) => void;
  createSearchMaterial: (providerId: SearchProviderId) => void | Promise<void>;
  searchTaskProviderId?: SearchProviderId;
  defaultSearchProvider: SearchProviderId;
}

export function useSearchBriefActions({
  productState,
  setProductState,
  setNotice,
  setActiveSearchBriefId,
  launchInterview,
  createSearchMaterial,
  searchTaskProviderId,
  defaultSearchProvider
}: UseSearchBriefActionsArgs) {
  function retrySearchMaterial() {
    return createSearchMaterial(searchTaskProviderId ?? defaultSearchProvider);
  }

  function startFromBrief(briefId: string) {
    launchInterview("learning", briefId);
  }

  function briefToDebt(briefId: string) {
    const result = createKnowledgeDebtFromSearchBrief(productState, briefId);
    if (!result) {
      setNotice(buildNotice("warning", "转换失败", "未找到该搜索简报。"));
      return;
    }
    setProductState(result.nextState);
    setNotice(buildNotice("success", "已转为知识债", "已加入资产库，可在下一次专访中校验。"));
  }

  function briefToPoint(briefId: string) {
    const result = createPointFromSearchBrief(productState, briefId);
    if (!result) {
      setNotice(buildNotice("warning", "转换失败", "未找到该搜索简报。"));
      return;
    }
    setProductState(result.nextState);
    setNotice(buildNotice("success", "已转为观点", "已从简报生成观点草稿，可在资产库继续打磨。"));
  }

  function briefToQuestion(briefId: string) {
    const result = createQuestionFromSearchBrief(productState, briefId);
    if (!result) {
      setNotice(buildNotice("warning", "转换失败", "未找到该搜索简报。"));
      return;
    }
    setProductState(result.nextState);
    setNotice(buildNotice("success", "已转为专访问题", "已加入问题资产，可带入下一次专访。"));
  }

  function removeSearchBrief(briefId: string) {
    if (typeof window !== "undefined" && !window.confirm("确定要删除这份搜索简报吗？已生成的访谈和资产不会被删除。")) {
      return;
    }
    setProductState(deleteSearchBrief(productState, briefId));
    setActiveSearchBriefId((current) => (current === briefId ? undefined : current));
    setNotice(buildNotice("warning", "搜索简报已删除", "历史访谈和资产保持不变。"));
  }

  function setDefaultSearchProvider(provider: SearchProviderId) {
    const nextConfig = {
      ...productState.systemConfig,
      search: { ...productState.systemConfig.search, activeProvider: provider }
    };
    setProductState({
      ...productState,
      systemConfig: nextConfig
    });
    setNotice(buildNotice("success", "默认搜索 Provider 已更新", `当前默认 provider：${provider}`));
  }

  return {
    retrySearchMaterial,
    startFromBrief,
    briefToDebt,
    briefToPoint,
    briefToQuestion,
    removeSearchBrief,
    setDefaultSearchProvider
  };
}

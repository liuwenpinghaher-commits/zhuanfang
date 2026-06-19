import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SystemCapabilitiesResponse, SystemConfigResponse } from "../../api/productApi";
import { searchProviderIds, searchProviderLabels } from "../../capabilities/contracts";
import { buildSystemStatus, createInitialProductState } from "../../domain/engine";
import { ConfigView } from "./ConfigView";

describe("ConfigView", () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    root = undefined;
    container?.remove();
    container = undefined;
  });

  it("renders live Product API capability health on the provider page", () => {
    const state = createInitialProductState();
    const systemCapabilities: SystemCapabilitiesResponse = {
      generatedAt: "2026-06-10T00:00:00.000Z",
      configVersion: "base-v1",
      runtime: {
        service: "interview-product-api",
        stateStore: "memory"
      },
      capabilities: [
        {
          id: "anysearch",
          kind: "search",
          label: "AnySearch",
          status: "needs-key",
          active: false,
          detail: "ANYSEARCH_API_KEY 未配置，AnySearch 将降级为本地可复核素材。",
          requiredEnv: ["ANYSEARCH_API_KEY"],
          lastCheckedAt: "2026-06-10T00:00:00.000Z"
        }
      ]
    };

    renderView(state, systemCapabilities);

    expect(container?.textContent).toContain("Product API 实时状态");
    expect(container?.textContent).toContain("memory");
    expect(container?.textContent).toContain("ANYSEARCH_API_KEY 未配置");
    expect(container?.textContent).toContain("ANYSEARCH_API_KEY");
  });

  it("renders editable runtime settings and saves changed values", () => {
    const state = createInitialProductState();
    const systemCapabilities: SystemCapabilitiesResponse = {
      generatedAt: "2026-06-10T00:00:00.000Z",
      configVersion: "base-v1",
      runtime: {
        service: "interview-product-api",
        stateStore: "memory"
      },
      capabilities: []
    };
    const runtimeConfig: SystemConfigResponse = {
      generatedAt: "2026-06-10T00:00:00.000Z",
      envFilePath: "/tmp/.env.local",
      sections: [
        {
          id: "secrets",
          label: "密钥",
          settings: [
            {
              key: "DASHSCOPE_API_KEY",
              section: "secrets",
              label: "DashScope / 百炼 API Key",
              description: "百炼主密钥。",
              valueKind: "secret",
              secret: true,
              required: true,
              configured: false,
              value: null,
              maskedValue: "未配置",
              restartRequired: false
            }
          ]
        },
        {
          id: "models",
          label: "模型",
          settings: [
            {
              key: "BAILIAN_SEARCH_MODEL",
              section: "models",
              label: "联网搜索模型",
              description: "用于百炼联网搜索。",
              valueKind: "string",
              secret: false,
              required: false,
              configured: true,
              value: "qwen-plus",
              defaultValue: "qwen3.7-plus",
              restartRequired: false
            }
          ]
        }
      ]
    };
    const onSaveRuntimeConfig = vi.fn();

    renderView(state, systemCapabilities, {
      runtimeConfig,
      section: "settings",
      onSaveRuntimeConfig
    });

    const keyInput = container?.querySelector<HTMLInputElement>('input[name="DASHSCOPE_API_KEY"]');
    const modelInput = container?.querySelector<HTMLInputElement>('input[name="BAILIAN_SEARCH_MODEL"]');
    expect(container?.textContent).toContain("服务端配置（env）");
    expect(container?.textContent).toContain("/tmp/.env.local");
    expect(keyInput?.placeholder).toContain("未配置");
    expect(modelInput?.value).toBe("qwen-plus");

    act(() => {
      keyInput!.value = "secret-dashscope-key";
      keyInput!.dispatchEvent(new Event("input", { bubbles: true }));
      modelInput!.value = "qwen3.7-plus";
      modelInput!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      container?.querySelector<HTMLButtonElement>('[data-testid="save-runtime-config"]')?.click();
    });

    expect(onSaveRuntimeConfig).toHaveBeenCalledWith({
      DASHSCOPE_API_KEY: "secret-dashscope-key",
      BAILIAN_SEARCH_MODEL: "qwen3.7-plus"
    });
  });

  it("edits product strategy settings and saves the next system config", () => {
    const state = createInitialProductState();
    const onSaveProductConfig = vi.fn();

    renderView(state, emptyCapabilities(), {
      section: "settings",
      onSaveProductConfig,
      // The voice dropdowns are data-driven from `voices` (verified cosyvoice-v3-plus
      // presets); supply the ones the test selects.
      voices: [
        { voice: "longanyang", name: "龙安洋·阳光男声", description: "" },
        { voice: "longanhuan", name: "龙安欢·元气女声", description: "" }
      ]
    });

    const providerSelect = container?.querySelector<HTMLSelectElement>('select[name="search.activeProvider"]');
    const recencyInput = container?.querySelector<HTMLInputElement>('input[name="search.recencyDays"]');
    const maxSourcesInput = container?.querySelector<HTMLInputElement>('input[name="search.maxSources"]');
    const webInInterviewSelect = container?.querySelector<HTMLSelectElement>('select[name="search.allowWebInInterview"]');
    const podcastVoiceSelect = container?.querySelector<HTMLSelectElement>('select[name="voice.podcastVoice"]');
    const silenceInput = container?.querySelector<HTMLInputElement>('input[name="interview.silenceHoldMs"]');
    const followUpInput = container?.querySelector<HTMLInputElement>('input[name="interview.maxFollowUpDepth"]');

    expect(container?.textContent).toContain("产品策略");
    expect(providerSelect?.value).toBe("bailian");
    expect(recencyInput?.value).toBe("14");

    act(() => {
      providerSelect!.value = "anysearch";
      providerSelect!.dispatchEvent(new Event("change", { bubbles: true }));
      recencyInput!.value = "7";
      recencyInput!.dispatchEvent(new Event("input", { bubbles: true }));
      maxSourcesInput!.value = "3";
      maxSourcesInput!.dispatchEvent(new Event("input", { bubbles: true }));
      webInInterviewSelect!.value = "false";
      webInInterviewSelect!.dispatchEvent(new Event("change", { bubbles: true }));
      podcastVoiceSelect!.value = "longanhuan";
      podcastVoiceSelect!.dispatchEvent(new Event("change", { bubbles: true }));
      silenceInput!.value = "1600";
      silenceInput!.dispatchEvent(new Event("input", { bubbles: true }));
      followUpInput!.value = "6";
      followUpInput!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      container?.querySelector<HTMLButtonElement>('[data-testid="save-product-config"]')?.click();
    });

    expect(onSaveProductConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        search: expect.objectContaining({
          activeProvider: "anysearch",
          recencyDays: 7,
          maxSources: 3,
          allowWebInInterview: false
        }),
        voice: expect.objectContaining({
          podcastVoice: "longanhuan"
        }),
        interview: expect.objectContaining({
          silenceHoldMs: 1600,
          maxFollowUpDepth: 6
        })
      })
    );
  });

  it("provider select options match the single-source searchProviderLabels exactly", () => {
    const state = createInitialProductState();

    renderView(state, emptyCapabilities(), {
      section: "settings",
      voices: [
        { voice: "longanyang", name: "龙安洋·阳光男声", description: "" },
        { voice: "longanhuan", name: "龙安欢·元气女声", description: "" }
      ]
    });

    const providerSelect = container?.querySelector<HTMLSelectElement>('select[name="search.activeProvider"]');
    const optionValues = Array.from(providerSelect?.options ?? []).map((o) => o.value);

    // Must match searchProviderIds exactly (same set, same order)
    expect(optionValues).toEqual(searchProviderIds);

    // Each option label must match the searchProviderLabels entry
    const optionTexts = Array.from(providerSelect?.options ?? []).map((o) => o.text);
    const expectedTexts = searchProviderIds.map((id) => searchProviderLabels[id]);
    expect(optionTexts).toEqual(expectedTexts);
  });

  function renderView(
    state: ReturnType<typeof createInitialProductState>,
    systemCapabilities: SystemCapabilitiesResponse,
    overrides: Partial<ComponentProps<typeof ConfigView>> = {}
  ) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        <ConfigView
          state={state}
          status={buildSystemStatus(state)}
          systemCapabilities={systemCapabilities}
          runtimeConfig={null}
          runtimeConfigSaving={false}
          section="status"
          onSection={vi.fn()}
          onCleanupGeneratedArtifacts={vi.fn()}
          onSaveRuntimeConfig={vi.fn()}
          onSaveProductConfig={vi.fn()}
          voices={[]}
          voicesLoading={false}
          onUploadVoice={vi.fn()}
          onDeleteVoice={vi.fn()}
          {...overrides}
        />
      );
    });
  }

  function emptyCapabilities(): SystemCapabilitiesResponse {
    return {
      generatedAt: "2026-06-10T00:00:00.000Z",
      configVersion: "base-v1",
      runtime: {
        service: "interview-product-api",
        stateStore: "memory"
      },
      capabilities: []
    };
  }
});

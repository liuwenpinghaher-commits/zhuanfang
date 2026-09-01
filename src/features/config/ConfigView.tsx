import { Archive, Cpu, Mic, RefreshCcw, Search, ShieldCheck, Sliders, Upload, Volume2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SystemCapabilitiesResponse, SystemConfigResponse, SystemConfigSetting, SystemConfigUpdateRequest, VoiceInfo } from "../../api/productApi";
import { selectableSearchProviderIds, searchProviderLabels } from "../../capabilities/contracts";
import { HeaderBlock } from "../../components/HeaderBlock";
import { Metric } from "../../components/Metric";
import type { buildSystemStatus } from "../../domain/engine";
import type { ProductState, SearchProviderId, SystemConfig } from "../../domain/types";
import { podcastVoiceSelectOptions } from "../../domain/podcast-voices";
import { configSectionOptions, type ConfigSection } from "../../ui";

interface ConfigViewProps {
  state: ProductState;
  status: ReturnType<typeof buildSystemStatus>;
  systemCapabilities: SystemCapabilitiesResponse | null;
  runtimeConfig: SystemConfigResponse | null;
  runtimeConfigSaving: boolean;
  section: ConfigSection;
  onSection: (section: ConfigSection) => void;
  onCleanupGeneratedArtifacts: () => void;
  onSaveRuntimeConfig: (updates: SystemConfigUpdateRequest) => void;
  onSaveProductConfig: (config: SystemConfig) => void | Promise<void>;
  productConfigSaving?: boolean;
  voices: VoiceInfo[];
  voicesLoading: boolean;
  onUploadVoice: (audioBase64: string, name: string) => Promise<void>;
  onDeleteVoice: (voiceId: string) => Promise<void>;
  onOpenCorpus?: () => void;
}

export function ConfigView({
  state,
  status,
  systemCapabilities,
  runtimeConfig,
  runtimeConfigSaving,
  section,
  onSection,
  onCleanupGeneratedArtifacts,
  onSaveRuntimeConfig,
  onSaveProductConfig,
  productConfigSaving = false,
  voices,
  voicesLoading,
  onUploadVoice,
  onDeleteVoice,
  onOpenCorpus
}: ConfigViewProps) {
  const [runtimeDraft, setRuntimeDraft] = useState<Record<string, string>>({});
  const [runtimeDirty, setRuntimeDirty] = useState<Record<string, boolean>>({});
  const [productDraft, setProductDraft] = useState<SystemConfig>(() => state.systemConfig);
  const [productDirty, setProductDirty] = useState(false);

  useEffect(() => {
    if (!runtimeConfig) {
      setRuntimeDraft({});
      setRuntimeDirty({});
      return;
    }

    setRuntimeDraft(buildRuntimeConfigDraft(runtimeConfig));
    setRuntimeDirty({});
  }, [runtimeConfig]);

  useEffect(() => {
    setProductDraft(state.systemConfig);
    setProductDirty(false);
  }, [state.systemConfig]);

  const runtimeDirtyCount = useMemo(() => Object.values(runtimeDirty).filter(Boolean).length, [runtimeDirty]);
  const appliedPatchCount = useMemo(
    () => state.playbookPatches.filter((patch) => patch.status === "applied").length,
    [state.playbookPatches]
  );

  function updateRuntimeSetting(setting: SystemConfigSetting, value: string) {
    setRuntimeDraft((current) => ({ ...current, [setting.key]: value }));
    setRuntimeDirty((current) => ({ ...current, [setting.key]: true }));
  }

  function saveRuntimeConfig() {
    if (!runtimeConfig) {
      return;
    }

    const updates = runtimeConfig.sections
      .flatMap((runtimeSection) => runtimeSection.settings)
      .reduce<SystemConfigUpdateRequest>((nextUpdates, setting) => {
        if (!runtimeDirty[setting.key]) {
          return nextUpdates;
        }
        const value = runtimeDraft[setting.key] ?? "";
        if (setting.secret && !value.trim()) {
          return nextUpdates;
        }
        nextUpdates[setting.key] = setting.valueKind === "number" ? Number(value) : value;
        return nextUpdates;
      }, {});

    if (Object.keys(updates).length > 0) {
      onSaveRuntimeConfig(updates);
    }
  }

  function updateProductConfig(updater: (config: SystemConfig) => SystemConfig) {
    setProductDraft((current) => updater(current));
    setProductDirty(true);
  }

  async function saveProductConfig() {
    if (!productDirty || productConfigSaving) return;
    await onSaveProductConfig(productDraft);
  }

  const runtimeEditable = runtimeConfig?.editable !== false;
  const interviewModelLabel =
    systemCapabilities?.capabilities.find((capability) => capability.id === "bailian-character")?.model
    ?? status.activeProviders.interviewModel;

  return (
    <section className="view-stack">
      <HeaderBlock
        eyebrow="系统配置"
        title="实时能力状态与运行参数"
        subtitle="两套配置边界：服务端 env（密钥/模型/端点，PATCH /api/system/config）≠ 产品策略 systemConfig（搜索/语音/访谈默认，写入 ProductState）。状态页展示能力健康。" />
      <section className="panel config-tabs" aria-label="系统配置分段">
        {configSectionOptions.map((option) => (
          <button
            className={section === option.id ? "config-tab active" : "config-tab"}
            type="button"
            key={option.id}
            onClick={() => onSection(option.id)}>
            <strong>{option.label}</strong>
            <span>{option.description}</span>
          </button>
        ))}
      </section>

      {section === "status" && (
        <div className="view-stack">
          <section className="panel">
            <div className="panel-title"><ShieldCheck size={18} /><h2>Product API 实时状态</h2></div>
            {systemCapabilities ? (
              <>
                <div className="config-hint">
                  <span>{systemCapabilities.runtime.service}</span>
                  <span>状态库：{systemCapabilities.runtime.stateStore}</span>
                  <span>引擎版本：{systemCapabilities.configVersion}</span>
                  <span>检查时间：{new Date(systemCapabilities.generatedAt).toLocaleString("zh-CN")}</span>
                </div>
                {(systemCapabilities as { metrics?: { voice?: { ttfaP50Ms?: number; ttfaP95Ms?: number; sampleCount?: number; interruptCount?: number; bargeInSuccessRate?: number; interruptRecoveryRate?: number; budgetHint?: { ttfaP95TargetMs?: number } }; recall?: { empty?: number; low_score?: number; hit?: number }; grounding?: { grounded?: number; refused?: number; citationPresentRate?: number } } }).metrics && (
                  <div className="config-hint" data-testid="runtime-metrics-strip">
                    <span>
                      语音 TTFA p50/p95：
                      {(systemCapabilities as any).metrics?.voice?.ttfaP50Ms ?? "—"}
                      {" / "}
                      {(systemCapabilities as any).metrics?.voice?.ttfaP95Ms ?? "—"}
                      ms
                      {typeof (systemCapabilities as any).metrics?.voice?.ttfaP95Ms === "number" &&
                      (systemCapabilities as any).metrics.voice.ttfaP95Ms >
                        ((systemCapabilities as any).metrics?.voice?.budgetHint?.ttfaP95TargetMs ?? 1200)
                        ? " ⚠ 高于 mouth-to-ear p95 预算"
                        : typeof (systemCapabilities as any).metrics?.voice?.ttfaP95Ms === "number" &&
                            (systemCapabilities as any).metrics.voice.ttfaP95Ms > 700
                          ? " ⚠ 高于 700ms 人感参考"
                          : ""}
                    </span>
                    <span data-testid="voice-ttfa-segments">
                      分段 p50：
                      {(() => {
                        const seg = (systemCapabilities as any).metrics?.voice?.segments;
                        const fmt = (s?: { p50Ms?: number }) =>
                          typeof s?.p50Ms === "number" ? `${Math.round(s.p50Ms)}` : "—";
                        return `VAD→STT ${fmt(seg?.vadEndToStt)} / STT→应答 ${fmt(seg?.sttToLlm)} / LLM TTFT ${fmt(seg?.llmTtft)} / TTS TTFB ${fmt(seg?.ttsTtfb)} ms`;
                      })()}
                    </span>
                    <span>
                      召回 hit/empty/low：
                      {(systemCapabilities as any).metrics?.recall?.hit ?? 0}/
                      {(systemCapabilities as any).metrics?.recall?.empty ?? 0}/
                      {(systemCapabilities as any).metrics?.recall?.low_score ?? 0}
                    </span>
                    <span>打断样本：{(systemCapabilities as any).metrics?.voice?.interruptCount ?? 0}</span>
                    <span>
                      barge-in 成功率：
                      {typeof (systemCapabilities as any).metrics?.voice?.bargeInSuccessRate === "number"
                        ? `${Math.round((systemCapabilities as any).metrics.voice.bargeInSuccessRate * 100)}%`
                        : "—"}
                    </span>
                    <span>
                      引用/拒召：
                      {(systemCapabilities as any).metrics?.grounding?.grounded ?? 0}/
                      {(systemCapabilities as any).metrics?.grounding?.refused ?? 0}
                      {typeof (systemCapabilities as any).metrics?.grounding?.citationPresentRate === "number"
                        ? ` · cite ${Math.round((systemCapabilities as any).metrics.grounding.citationPresentRate * 100)}%`
                        : ""}
                    </span>
                  </div>
                )}
                <div className="provider-grid">
                  {systemCapabilities.capabilities.map((capability) => (
                    <article className="provider-card live-provider-card" key={capability.id}>
                      <span className="status-pill">{capability.kind} · {formatCapabilityHealth(capability.status)}</span>
                      <h3>{capability.label}</h3>
                      <p>{capability.detail}</p>
                      <small>{capability.active ? "当前启用" : "未启用"} · {new Date(capability.lastCheckedAt).toLocaleDateString("zh-CN")}</small>
                      {(capability.model || capability.transport || capability.requiredEnv.length > 0) && (
                        <div className="provider-meta-list">
                          {capability.model && <span>模型：{capability.model}</span>}
                          {capability.transport && <span>传输：{capability.transport}</span>}
                          {capability.requiredEnv.length > 0 && <span>Env：{capability.requiredEnv.join(" / ")}</span>}
                        </div>
                      )}
                    </article>
                  ))}
                </div>
              </>
            ) : (
              <p className="muted-copy">Product API 实时状态暂不可用。请确认 API 服务已启动，再回到本页查看能力健康。</p>
            )}
          </section>

          <div className="dashboard-grid">
            <section className="panel">
              <div className="panel-title"><Cpu size={18} /><h2>当前引擎</h2></div>
              <dl className="detail-list">
                <dt>配置版本</dt>
                <dd>{status.configVersion}</dd>
                <dt>访谈策略</dt>
                <dd>{state.systemConfig.interview.playbookVersion}</dd>
                <dt>访谈模型</dt>
                <dd>{interviewModelLabel}</dd>
                <dt>已应用补丁</dt>
                <dd>{appliedPatchCount}</dd>
              </dl>
            </section>
            <section className="panel">
              <div className="panel-title"><Search size={18} /><h2>搜索能力</h2></div>
              <dl className="detail-list">
                <dt>活跃 Provider</dt>
                <dd>{status.activeProviders.search}</dd>
                <dt>会中引用</dt>
                <dd>{state.systemConfig.search.allowWebInInterview ? "开启" : "关闭"}</dd>
              </dl>
            </section>
            <section className="panel">
              <div className="panel-title"><Volume2 size={18} /><h2>语音能力</h2></div>
              <dl className="detail-list">
                <dt>TTS</dt>
                <dd>{state.systemConfig.voice.ttsProvider}</dd>
              </dl>
            </section>
          </div>

          <section className="panel">
            <div className="panel-title"><ShieldCheck size={18} /><h2>系统观测</h2></div>
            <ul className="clean-list">
              {status.observations.map((item, obsIdx) => <li key={`obs-${obsIdx}`}>{item}</li>)}
            </ul>
          </section>

          <section className="panel">
            <div className="panel-title"><Archive size={18} /><h2>生成物治理</h2></div>
            <div className="metric-row compact">
              <Metric label="搜索简报" value={state.searchBriefs.length} />
              <Metric label="播客生成" value={state.podcastEpisodes.length} />
              <Metric label="语料分析" value={state.corpusInsights.length} />
            </div>
            <div className="record-actions">
              <button className="secondary-action" type="button" onClick={onCleanupGeneratedArtifacts}>
                <RefreshCcw size={16} />清理重复生成物
              </button>
              {onOpenCorpus && (
                <button className="secondary-action" type="button" onClick={onOpenCorpus}>
                  <Upload size={16} />引擎调校 · 语料学习
                </button>
              )}
            </div>
          </section>
        </div>
      )}

      {section === "settings" && (
        <div className="view-stack">
          <section className="panel">
            <div className="panel-title"><ShieldCheck size={18} /><h2>服务端配置（env）</h2></div>
            <p className="muted-copy">
              {runtimeEditable
                ? "服务端运行配置（密钥、模型名、端点）。写入本机 API 的环境文件；密钥留空表示保持不变。与下方「产品策略」分开。"
                : "线上钥匙在服务器配置文件里。这一页只能看是否已配置，改了重启也会丢，所以不能从这里改。"}
            </p>
            {runtimeConfig ? (
              <>
                <div className="config-hint">
                  {runtimeEditable && runtimeConfig.envFilePath ? <span>Env 文件：{runtimeConfig.envFilePath}</span> : null}
                  <span>读取时间：{new Date(runtimeConfig.generatedAt).toLocaleString("zh-CN")}</span>
                  {runtimeEditable ? <span>已修改：{runtimeDirtyCount} 项</span> : <span>只读</span>}
                </div>
                <div className="runtime-config-sections">
                  {runtimeConfig.sections.map((runtimeSection) => (
                    <section className="runtime-config-section" key={runtimeSection.id}>
                      <h3>{runtimeSection.label}</h3>
                      <div className="runtime-setting-grid">
                        {runtimeSection.settings.map((setting) => (
                          <RuntimeSettingField
                            key={setting.key}
                            setting={setting}
                            value={runtimeDraft[setting.key] ?? ""}
                            disabled={!runtimeEditable}
                            onChange={(value) => updateRuntimeSetting(setting, value)} />
                        ))}
                      </div>
                    </section>
                  ))}
                </div>
                {runtimeEditable ? (
                <div className="record-actions">
                  <button
                    className="primary-action"
                    type="button"
                    data-testid="save-runtime-config"
                    onClick={saveRuntimeConfig}
                    disabled={runtimeConfigSaving || runtimeDirtyCount === 0}
>
                    <ShieldCheck size={16} />{runtimeConfigSaving ? "保存中" : "保存服务端配置"}
                  </button>
                </div>
                ) : null}
              </>
            ) : (
              <p className="muted-copy">Product API 配置接口暂不可用，无法编辑服务端 env。</p>
            )}
          </section>

          <VoiceCloningPanel
            voices={voices}
            loading={voicesLoading}
            onUpload={onUploadVoice}
            onDelete={onDeleteVoice} />

          <section className="panel">
            <div className="panel-title"><Sliders size={18} /><h2>产品策略</h2></div>
            <p className="muted-copy">产品策略（ProductState.systemConfig）：搜索默认 provider、语音/访谈节奏、记忆召回开关等。写入产品状态并走 autosave，不包含 API 密钥。</p>
            <div className="runtime-config-sections">
              <section className="runtime-config-section">
                <h3>联网素材</h3>
                <div className="runtime-setting-grid">
                  <label className="field-stack runtime-setting-field" htmlFor="product-search-provider">
                    <span className="field-label">默认搜索 Provider</span>
                    <select
                      id="product-search-provider"
                      name="search.activeProvider"
                      value={
                        productDraft.search.activeProvider === "anysearch" ? "anysearch" : "bailian"
                      }
                      onChange={(event) => {
                        const nextValue = event.target.value as SearchProviderId;
                        updateProductConfig((config) => ({
                          ...config,
                          search: { ...config.search, activeProvider: nextValue }
                        }));
                      }}
>
                      {selectableSearchProviderIds.map((provider) => (
                        <option value={provider} key={provider}>{searchProviderLabels[provider]}</option>
                      ))}
                    </select>
                    <span className="field-help">影响“联网素材”默认使用的 provider。</span>
                    {(() => {
                      // Cross-reference the selected provider with its live capability health
                      // so users see "selected but degraded/needs-key" without leaving the tab.
                      const capId = productDraft.search.activeProvider === "bailian"
                        ? "bailian-responses"
                        : productDraft.search.activeProvider === "anysearch"
                          ? "anysearch"
                          : null;
                      const cap = capId ? systemCapabilities?.capabilities.find((c) => c.id === capId) : null;
                      if (!cap || cap.status === "ready") return null;
                      return (
                        <span className="field-help" style={{ color: "var(--accent-amber)" }}>
                          ⚠ 所选 provider 当前状态：{cap.status}
                          {cap.requiredEnv && cap.requiredEnv.length > 0 ? `（需在「服务端配置」填 ${cap.requiredEnv.join("、")}）` : ""}
                        </span>
                      );
                    })()}
                  </label>
                  <label className="field-stack runtime-setting-field" htmlFor="product-search-recency">
                    <span className="field-label">搜索时效窗口</span>
                    <input
                      id="product-search-recency"
                      name="search.recencyDays"
                      type="number"
                      min={1}
                      max={365}
                      value={productDraft.search.recencyDays}
                      onInput={(event) => {
                        const nextValue = clampInteger(event.currentTarget.value, 1, 365);
                        updateProductConfig((config) => ({
                          ...config,
                          search: { ...config.search, recencyDays: nextValue }
                        }));
                      }} />
                    <span className="field-help">创建搜索简报时传给 provider 的 recencyDays。</span>
                  </label>
                  <label className="field-stack runtime-setting-field" htmlFor="product-search-max-sources">
                    <span className="field-label">最大来源数</span>
                    <input
                      id="product-search-max-sources"
                      name="search.maxSources"
                      type="number"
                      min={1}
                      max={10}
                      value={productDraft.search.maxSources}
                      onInput={(event) => {
                        const nextValue = clampInteger(event.currentTarget.value, 1, 10);
                        updateProductConfig((config) => ({
                          ...config,
                          search: { ...config.search, maxSources: nextValue }
                        }));
                      }} />
                    <span className="field-help">控制每份联网素材保留的来源数量。</span>
                  </label>
                  <label className="field-stack runtime-setting-field" htmlFor="product-search-web-context">
                    <span className="field-label">允许会中引用联网素材</span>
                    <select
                      id="product-search-web-context"
                      name="search.allowWebInInterview"
                      value={String(productDraft.search.allowWebInInterview)}
                      onChange={(event) => {
                        const nextValue = event.target.value === "true";
                        updateProductConfig((config) => ({
                          ...config,
                          search: { ...config.search, allowWebInInterview: nextValue }
                        }));
                      }}
>
                      <option value="true">开启</option>
                      <option value="false">关闭</option>
                    </select>
                    <span className="field-help">关闭后，专访卡不主动带入联网素材。</span>
                  </label>
                </div>
              </section>

              <section className="runtime-config-section">
                <h3>外部调研自动化</h3>
                <div className="runtime-setting-grid">
                  <label className="field-stack runtime-setting-field" htmlFor="product-research-auto-schedule">
                    <span className="field-label">后台定时调研</span>
                    <select
                      id="product-research-auto-schedule"
                      name="research.autoScheduleEnabled"
                      value={String(productDraft.research?.autoScheduleEnabled ?? false)}
                      onChange={(event) => {
                        const nextValue = event.target.value === "true";
                        updateProductConfig((config) => ({
                          ...config,
                          research: { ...config.research, autoScheduleEnabled: nextValue }
                        }));
                      }}
>
                      <option value="true">开启</option>
                      <option value="false">关闭</option>
                    </select>
                    <span className="field-help">开启后，常驻服务会按下方间隔自动生成新简报、刷新过期的追踪简报并去重来源。需 API 服务保持运行；改动在下一个调度周期生效。</span>
                  </label>
                  <label className="field-stack runtime-setting-field" htmlFor="product-research-interval">
                    <span className="field-label">调度间隔（分钟）</span>
                    <input
                      id="product-research-interval"
                      name="research.scheduleIntervalMin"
                      type="number"
                      min={15}
                      max={10080}
                      value={productDraft.research?.scheduleIntervalMin ?? 1440}
                      onInput={(event) => {
                        const nextValue = clampInteger(event.currentTarget.value, 15, 10080);
                        updateProductConfig((config) => ({
                          ...config,
                          research: { ...config.research, scheduleIntervalMin: nextValue }
                        }));
                      }} />
                    <span className="field-help">默认 1440（24 小时）。最短 15 分钟。非常驻部署可改用「外部调研 → 自动盯梢」手动触发。</span>
                  </label>
                </div>
              </section>

<section className="runtime-config-section">
                <h3>记忆与上下文</h3>
                <div className="runtime-setting-grid">
                  <label className="field-stack runtime-setting-field" htmlFor="product-memory-pending">
                    <span className="field-label">待审候选可进专访上下文</span>
                    <select
                      id="product-memory-pending"
                      name="memory.includePendingCandidatesInContext"
                      value={String(productDraft.memory.includePendingCandidatesInContext)}
                      onChange={(event) => {
                        const nextValue = event.target.value === "true";
                        updateProductConfig((config) => ({
                          ...config,
                          memory: { ...config.memory, includePendingCandidatesInContext: nextValue }
                        }));
                      }}
>
                      <option value="false">关闭（默认·须 HITL 确认后才跨会话召回）</option>
                      <option value="true">开启（仅本场 guide 可引用重叠待审文案）</option>
                    </select>
                    <span className="field-help">
                      开启后，与当前话题有词重叠的 pending 候选会进入本场 relevantMemories；关闭时待审永不进模型。跨会话向量召回仍须「确认记住」。
                    </span>
                  </label>
                  <label className="field-stack runtime-setting-field" htmlFor="product-memory-sensitive">
                    <span className="field-label">敏感记忆可进模型上下文</span>
                    <select
                      id="product-memory-sensitive"
                      name="memory.includeSensitiveMemoriesInContext"
                      value={String(productDraft.memory.includeSensitiveMemoriesInContext)}
                      onChange={(event) => {
                        const nextValue = event.target.value === "true";
                        updateProductConfig((config) => ({
                          ...config,
                          memory: { ...config.memory, includeSensitiveMemoriesInContext: nextValue }
                        }));
                      }}
>
                      <option value="false">关闭（默认）</option>
                      <option value="true">开启</option>
                    </select>
                    <span className="field-help">默认敏感 confirmed/pending 不进 prompt；仅在你明确需要时开启。</span>
                  </label>
                </div>
              </section>

              <section className="runtime-config-section">
                <h3>语音与访谈</h3>
                <div className="runtime-setting-grid">
                  <label className="field-stack runtime-setting-field" htmlFor="product-default-voice">
                    <span className="field-label">默认访谈声音</span>
                    <select
                      id="product-default-voice"
                      name="voice.defaultVoice"
                      value={productDraft.voice.defaultVoice}
                      onChange={(event) => {
                        const nextValue = event.target.value;
                        updateProductConfig((config) => ({
                          ...config,
                          voice: { ...config.voice, defaultVoice: nextValue }
                        }));
                      }}
>
                      {[
                        ...voices,
                        ...(productDraft.voice.defaultVoice &&
                        !voices.some((v) => v.voice === productDraft.voice.defaultVoice)
                          ? [{
                              voice: productDraft.voice.defaultVoice,
                              name: productDraft.voice.defaultVoice.includes("zhangxj") ? "张小珺" : productDraft.voice.defaultVoice,
                              description: ""
                            }]
                          : [])
                      ].map((v) => (
                        <option key={v.voice} value={v.voice}>{v.name} ({v.voice})</option>
                      ))}
                    </select>
                    <span className="field-help">实时专访或默认语音入口使用的声音配置。</span>
                  </label>
                  <label className="field-stack runtime-setting-field" htmlFor="product-podcast-voice">
                    <span className="field-label">播客默认声音</span>
                    <select
                      id="product-podcast-voice"
                      name="voice.podcastVoice"
                      value={productDraft.voice.podcastVoice}
                      onChange={(event) => {
                        const nextValue = event.target.value;
                        updateProductConfig((config) => ({
                          ...config,
                          voice: { ...config.voice, podcastVoice: nextValue }
                        }));
                      }}
>
                      {podcastVoiceSelectOptions(productDraft.voice.podcastVoice).map((v) => (
                        <option key={v.voice} value={v.voice}>{v.name} ({v.voice})</option>
                      ))}
                    </select>
                    <span className="field-help">影响播客工作台新建节目时的默认声音。主持对谈时这是主持人。</span>
                  </label>
                  <label className="field-stack runtime-setting-field" htmlFor="product-podcast-guest-voice">
                    <span className="field-label">播客默认来宾</span>
                    <select
                      id="product-podcast-guest-voice"
                      name="voice.podcastGuestVoice"
                      value={productDraft.voice.podcastGuestVoice ?? ""}
                      onChange={(event) => {
                        const nextValue = event.target.value.trim();
                        updateProductConfig((config) => {
                          const nextVoice = { ...config.voice };
                          if (nextValue) nextVoice.podcastGuestVoice = nextValue;
                          else delete nextVoice.podcastGuestVoice;
                          return { ...config, voice: nextVoice };
                        });
                      }}
                    >
                      <option value="">生成主持对谈时自动配对</option>
                      {podcastVoiceSelectOptions(productDraft.voice.podcastGuestVoice ?? "").map((v) => (
                        <option key={v.voice} value={v.voice}>{v.name} ({v.voice})</option>
                      ))}
                    </select>
                    <span className="field-help">只影响下一期主持对谈。单人旁白不用这一栏。</span>
                  </label>
                  <label className="field-stack runtime-setting-field" htmlFor="product-realtime-mode">
                    <span className="field-label">实时语音模式</span>
                    <select
                      id="product-realtime-mode"
                      name="voice.realtimeMode"
                      value={productDraft.voice.realtimeMode}
                      onChange={(event) => {
                        const nextValue = event.target.value as "bailian" | "livekit" | "cascade";
                        updateProductConfig((config) => ({
                          ...config,
                          voice: { ...config.voice, realtimeMode: nextValue }
                        }));
                      }}
>
                      <option value="cascade">级联 (ASR→分析→TTS)</option>
                      <option value="bailian">百炼 S2S (直通 omni)</option>
                      <option value="livekit">LiveKit (外接 Python agent)</option>
                    </select>
                    <span className="field-help">级联模式：ASR 转写 → LLM 追问 → CosyVoice TTS，支持打断和深度分析。</span>
                  </label>
                  <label className="field-stack runtime-setting-field" htmlFor="product-silence-hold">
                    <span className="field-label">留白阈值</span>
                    <input
                      id="product-silence-hold"
                      name="interview.silenceHoldMs"
                      type="number"
                      min={300}
                      max={6000}
                      value={productDraft.interview.silenceHoldMs}
                      onInput={(event) => {
                        const nextValue = clampInteger(event.currentTarget.value, 300, 6000);
                        updateProductConfig((config) => ({
                          ...config,
                          interview: { ...config.interview, silenceHoldMs: nextValue }
                        }));
                      }} />
                    <span className="field-help">级联语音里，停这么久才当一句说完。加大更不容易被打断。</span>
                  </label>
                  <label className="field-stack runtime-setting-field" htmlFor="product-follow-up-depth">
                    <span className="field-label">最大追问深度</span>
                    <input
                      id="product-follow-up-depth"
                      name="interview.maxFollowUpDepth"
                      type="number"
                      min={1}
                      max={12}
                      value={productDraft.interview.maxFollowUpDepth}
                      onInput={(event) => {
                        const nextValue = clampInteger(event.currentTarget.value, 1, 12);
                        updateProductConfig((config) => ({
                          ...config,
                          interview: { ...config.interview, maxFollowUpDepth: nextValue }
                        }));
                      }} />
                    <span className="field-help">用于控制同一主题最多连续推进的追问层级。</span>
                  </label>
                  <label className="field-stack runtime-setting-field" htmlFor="product-guidance-enabled">
                    <span className="field-label">主动引导</span>
                    <select
                      id="product-guidance-enabled"
                      value={productDraft.interview.guidanceEnabled ? "on" : "off"}
                      onChange={(event) => {
                        updateProductConfig((config) => ({
                          ...config,
                          interview: { ...config.interview, guidanceEnabled: event.target.value === "on" }
                        }));
                      }}
>
                      <option value="on">启用</option>
                      <option value="off">关闭</option>
                    </select>
                    <span className="field-help">直通语音里，你停顿时要不要轻推一句。级联开口时机看上面的留白。</span>
                  </label>
                  <label className="field-stack runtime-setting-field" htmlFor="product-guidance-frequency">
                    <span className="field-label">引导频率</span>
                    <select
                      id="product-guidance-frequency"
                      value={productDraft.interview.guidanceFrequency}
                      onChange={(event) => {
                        const next = event.target.value as "low" | "medium" | "high";
                        const budget =
                          next === "low"
                            ? { maxGuidancePerTurn: 1, minGuidanceIntervalMs: 8000 }
                            : next === "high"
                              ? { maxGuidancePerTurn: 3, minGuidanceIntervalMs: 2500 }
                              : { maxGuidancePerTurn: 2, minGuidanceIntervalMs: 5000 };
                        updateProductConfig((config) => ({
                          ...config,
                          interview: { ...config.interview, guidanceFrequency: next, ...budget }
                        }));
                      }}
>
                      <option value="low">低 — 仅在明显模糊或矛盾时介入</option>
                      <option value="medium">中 — 在关键锚点和情感信号处介入</option>
                      <option value="high">高 — 积极介入，发现锚点即追问</option>
                    </select>
                    <span className="field-help">直通语音里，停顿时插一句的频率。级联追问深度看上面那格。</span>
                  </label>
                </div>
              </section>
            </div>
            <div className="record-actions">
              <button
                className="primary-action"
                type="button"
                data-testid="save-product-config"
                onClick={() => void saveProductConfig()}
                disabled={!productDirty || productConfigSaving}
>
                <ShieldCheck size={16} />{productConfigSaving ? "保存中" : "保存产品策略"}
              </button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}

function clampInteger(value: string, min: number, max: number) {
  const parsedValue = Number(value);
  if (!Number.isFinite(parsedValue)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.floor(parsedValue)));
}

function buildRuntimeConfigDraft(runtimeConfig: SystemConfigResponse) {
  return runtimeConfig.sections
    .flatMap((section) => section.settings)
    .reduce<Record<string, string>>((draft, setting) => {
      draft[setting.key] = setting.secret ? "" : String(setting.value ?? "");
      return draft;
    }, {});
}

function RuntimeSettingField({
  setting,
  value,
  onChange,
  disabled = false
}: {
  setting: SystemConfigSetting;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const fieldId = `runtime-setting-${setting.key}`;
  const helpText = [
    setting.description,
    setting.defaultValue ? `默认：${setting.defaultValue}` : "",
    setting.restartRequired ? "保存后需要重启 API 才能完全生效。" : ""
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <label className="field-stack runtime-setting-field" htmlFor={fieldId}>
      <span className="field-label">{setting.label}</span>
      {setting.valueKind === "select" ? (
        <select id={fieldId} name={setting.key} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
          {(setting.options ?? []).map((option) => (
            <option value={option.value} key={option.value || "empty"}>{option.label}</option>
          ))}
        </select>
      ) : setting.valueKind === "boolean" ? (
        <select id={fieldId} name={setting.key} value={value || "false"} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
          <option value="true">开启</option>
          <option value="false">关闭</option>
        </select>
      ) : (
        <input
          id={fieldId}
          name={setting.key}
          type={setting.secret ? "password" : setting.valueKind === "number" ? "number" : "text"}
          value={value}
          disabled={disabled}
          placeholder={setting.secret ? setting.maskedValue ?? "未配置" : setting.defaultValue}
          onInput={(event) => onChange(event.currentTarget.value)} />
      )}
      <span className="field-help">
        {helpText}
        {setting.secret && setting.configured ? ` 当前：${setting.maskedValue}` : ""}
      </span>
    </label>
  );
}

function VoiceCloningPanel({
  voices,
  loading,
  onUpload,
  onDelete
}: {
  voices: VoiceInfo[];
  loading: boolean;
  onUpload: (audioBase64: string, name: string) => Promise<void>;
  onDelete: (voiceId: string) => Promise<void>;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [voiceName, setVoiceName] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [error, setError] = useState("");

  const customVoices = voices.filter((v) => v.createdAt);

  async function handleUpload() {
    if (!selectedFile) return;
    setUploading(true);
    setError("");
    try {
      const reader = new FileReader();
      const base64 = await new Promise<string>((resolve, reject) => {
        reader.onload = () => {
          const result = reader.result as string;
          const commaIdx = result.indexOf(",");
          resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
        };
        reader.onerror = () => reject(new Error("File read failed"));
        reader.readAsDataURL(selectedFile);
      });
      await onUpload(base64, voiceName || selectedFile.name.replace(/\.[^.]+$/, ""));
      setSelectedFile(null);
      setVoiceName("");
      if (fileRef.current) fileRef.current.value = "";
    } catch (err) {
      setError(err instanceof Error ? err.message : "上传失败");
    } finally {
      setUploading(false);
    }
  }

  return (
    <section className="panel voice-cloning-panel">
      <div className="panel-title"><Upload size={18} /><h2>声音复刻</h2></div>
      <p className="voice-cloning-hint">
        上传 10–20 秒清晰录音（WAV/MP3/M4A），复刻后会设成默认主持人。
        绑定模型是 qwen-audio-3.0-tts-plus。创建走官方 DashScope，合成仍走 token-plan。
      </p>

      <div className="voice-cloning-upload">
        <input
          ref={fileRef}
          type="file"
          accept="audio/wav,audio/mp3,audio/m4a,.wav,.mp3,.m4a"
          onChange={(e) => setSelectedFile(e.target.files?.[0] ?? null)} />
        <input
          type="text"
          placeholder="音色名称（可选）"
          value={voiceName}
          onChange={(e) => setVoiceName(e.target.value)}
          className="voice-name-input" />
        <button
          type="button"
          className="primary-action"
          disabled={!selectedFile || uploading}
          onClick={handleUpload}>
          {uploading ? "创建中…" : "创建音色"}
        </button>
      </div>

      {error && <p className="voice-cloning-error">{error}</p>}

      {customVoices.length > 0 && (
        <div className="voice-cloning-list">
          <span className="label">我的音色</span>
          {customVoices.map((v) => (
            <div key={v.voice} className="voice-cloning-item">
              <span>{v.name}</span>
              <small>{v.voice}</small>
              <button
                type="button"
                className="text-button danger-button"
                onClick={() => onDelete(v.voice)}>
                删除
              </button>
            </div>
          ))}
        </div>
      )}

      {loading && <p className="voice-cloning-loading">加载音色列表…</p>}
    </section>
  );
}

function formatCapabilityHealth(status: SystemCapabilitiesResponse["capabilities"][number]["status"]) {
  const labels: Record<SystemCapabilitiesResponse["capabilities"][number]["status"], string> = {
    ready: "可用",
    degraded: "降级",
    "needs-key": "缺少 key",
    "needs-endpoint": "缺少 endpoint",
    disabled: "未启用"
  };
  return labels[status];
}

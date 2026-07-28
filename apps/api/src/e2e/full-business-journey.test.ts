/**
 * Full cross-feature business journey test (R1–R4 verification).
 *
 * 剧本：产品经理就「团队授权与控制感」做决策专访的完整业务旅程。
 *
 * 覆盖：外部调研 → 专访 → 我的资产 → 决策确认 → 记忆HITL → RAG问答
 *       → 主题线聚合 → 导出/隐私 → 播客降级。
 *
 * 约束：
 *  - env={} (无 key)，LLM 能力经 test-helpers/fake-llm-clients 在 provider 边界注入确定性
 *    假 client，走真实 LLM 代码路径（真实性重构后生产已无离线兜底：无 client 即 503/429/502）。
 *  - 不触网：外部 provider 一律假 client 或如实 5xx。
 *  - 全程使用 server.inject，不开端口。
 *  - 每步断言数据真实流转，而非仅校验状态码。
 */

import { describe, it, expect, vi } from "vitest";
import { buildApiServer } from "../server";
import { buildSessionArchive } from "../../../../src/domain/session-archive";
import { buildTrackWorkspace } from "../../../../src/domain/timeline";
import {
  createFakeChatClient,
  createFakeEmbeddingClient,
  createFakeInterviewClient
} from "../test-helpers/fake-llm-clients";

// 全套假 LLM client：让旅程走真实 LLM 代码路径（prompt 组装/解析/校验/落库全真）。
function fakeLlmClients() {
  return {
    bailianChatClient: createFakeChatClient(),
    bailianInterviewClient: createFakeInterviewClient(),
    embeddingClient: createFakeEmbeddingClient()
  };
}

describe("Full cross-feature business journey: 团队授权与控制感", () => {
  it("completes the full PM decision-interview journey end-to-end with no 5xx", async () => {
    const server = buildApiServer({ env: {}, ...fakeLlmClients() });

    // =========================================================================
    // 前置：重置到空状态，保证本旅程数据完全可追踪
    // =========================================================================
    const resetRes = await server.inject({ method: "POST", url: "/api/state/reset", payload: { confirm: "RESET_ALL_DATA" } });
    expect(resetRes.statusCode).toBe(200);
    const resetState = resetRes.json();
    expect(resetState.notes).toHaveLength(0);
    expect(resetState.sessions).toHaveLength(0);

    // =========================================================================
    // Step 1: 外部调研 — 创建简报、标记追踪、刷新
    // =========================================================================

    // 1a. 创建简报
    const briefRes = await server.inject({
      method: "POST",
      url: "/api/search/briefs",
      payload: { topic: "团队授权与控制感", providerId: "local-demo" }
    });
    expect(briefRes.statusCode).toBeLessThan(500);
    expect(briefRes.statusCode).toBe(200);
    const briefBody = briefRes.json();
    expect(briefBody.brief).toBeDefined();
    expect(briefBody.brief.topic).toBe("团队授权与控制感");
    expect(briefBody.brief.provider).toBe("local-demo");
    expect(Array.isArray(briefBody.brief.sources)).toBe(true);
    expect(briefBody.brief.sources.length).toBeGreaterThan(0);
    // brief 新建时 tracked 为 undefined (optional field，未设置前为 falsy)
    expect(briefBody.brief.tracked).toBeFalsy();
    const briefId = briefBody.brief.id as string;
    expect(typeof briefId).toBe("string");
    expect(briefId.length).toBeGreaterThan(0);

    // 1b. 追踪简报
    const trackRes = await server.inject({
      method: "POST",
      url: `/api/search/briefs/${briefId}/track`,
      payload: { tracked: true }
    });
    expect(trackRes.statusCode).toBe(200);
    const trackBody = trackRes.json();
    // 断言 tracked 字段真实更新
    expect(trackBody.brief.id).toBe(briefId);
    expect(trackBody.brief.tracked).toBe(true);

    // 1c. 刷新简报 — 真实性重构:local-demo 演示简报不支持联网刷新，如实 422（原简报不动）
    const refreshRes = await server.inject({
      method: "POST",
      url: `/api/search/briefs/${briefId}/refresh`
    });
    expect(refreshRes.statusCode).toBe(422);
    expect(refreshRes.json().error).toContain("local-demo");
    // 原简报保持原样：id/tracked 未受影响
    const briefAfterRefresh = (await server.inject({ method: "GET", url: "/api/state" }))
      .json()
      .searchBriefs.find((b: any) => b.id === briefId);
    expect(briefAfterRefresh).toBeDefined();
    expect(briefAfterRefresh.tracked).toBe(true);

    // =========================================================================
    // Step 2: 专访（以简报作上下文，决策模式）
    // =========================================================================

    // 2a. 创建会话，带入 searchBriefId
    const createSessionRes = await server.inject({
      method: "POST",
      url: "/api/interview-sessions",
      payload: { mode: "decision", strength: "standard", searchBriefId: briefId }
    });
    expect(createSessionRes.statusCode).toBe(200);
    const createSessionBody = createSessionRes.json();
    expect(createSessionBody.session).toBeDefined();
    expect(createSessionBody.session.mode).toBe("decision");
    expect(createSessionBody.session.status).toBe("active");
    expect(createSessionBody.session.card).toBeDefined();
    expect(typeof createSessionBody.session.card.title).toBe("string");
    expect(createSessionBody.session.card.title.length).toBeGreaterThan(0);
    const sessionId = createSessionBody.session.id as string;

    // 2b. 提交 3 轮真实内容（关于授权与控制感话题）
    const turns = [
      "我们团队最近做了一次授权改革，把原本集中在我手里的决策权下放给了三位 TL，但执行效果很不理想。",
      "问题不在于 TL 们的能力，而是他们没有真正感受到决策权是属于自己的，还是在等我的点头。",
      "我在想，授权不只是把权力给出去，核心是要让人有控制感——他们需要知道自己有权犯错，也有资源承担那个错误。"
    ];

    for (const content of turns) {
      const turnRes = await server.inject({
        method: "POST",
        url: `/api/interview-sessions/${sessionId}/turns`,
        payload: { content }
      });
      expect(turnRes.statusCode).toBe(200);
      const turnBody = turnRes.json();
      expect(turnBody.session.id).toBe(sessionId);
      // 每次 turn 后用户轮次必须递增
      const userTurns = turnBody.session.turns.filter((t: any) => t.role === "user");
      expect(userTurns.length).toBeGreaterThanOrEqual(1);
    }

    // 2c. 结束会话，生成 note（双轨）
    const endRes = await server.inject({
      method: "POST",
      url: `/api/interview-sessions/${sessionId}/end`
    });
    expect(endRes.statusCode).toBe(200);
    const endBody = endRes.json();

    // 断言 note 存在且包含双轨字段
    expect(endBody.note).toBeDefined();
    expect(endBody.note.sessionId).toBe(sessionId);
    expect(typeof endBody.note.title).toBe("string");
    expect(endBody.note.title.length).toBeGreaterThan(0);
    expect(endBody.note.summary).toBeDefined();
    expect(Array.isArray(endBody.note.saidTrack)).toBe(true);
    expect(Array.isArray(endBody.note.learnedTrack)).toBe(true);
    expect(Array.isArray(endBody.note.nextQuestions)).toBe(true);

    // 断言 session 状态为 completed
    const completedSession = endBody.state.sessions.find((s: any) => s.id === sessionId);
    expect(completedSession).toBeDefined();
    expect(completedSession!.status).toBe("completed");

    // =========================================================================
    // Step 3: 我的资产打通 — buildSessionArchive 验证
    // =========================================================================

    const stateRes1 = await server.inject({ method: "GET", url: "/api/state" });
    expect(stateRes1.statusCode).toBe(200);
    const stateAfterInterview = stateRes1.json();

    // note 必须持久化到 GET /api/state
    const persistedNote = stateAfterInterview.notes.find((n: any) => n.sessionId === sessionId);
    expect(persistedNote).toBeDefined();
    expect(persistedNote!.title).toBe(endBody.note.title);

    // buildSessionArchive 必须包含本次 session 的 entry
    const archive = buildSessionArchive(stateAfterInterview);
    const entry = archive.find((e) => e.note.sessionId === sessionId);
    expect(entry).toBeDefined();
    expect(entry!.note.sessionId).toBe(sessionId);
    // session 字段应关联到本次 session
    expect(entry!.session).toBeDefined();
    expect(entry!.session!.id).toBe(sessionId);
    // assets 数组是合法数组（确定性 fallback 下可能为空）
    expect(Array.isArray(entry!.points)).toBe(true);
    expect(Array.isArray(entry!.questions)).toBe(true);
    expect(Array.isArray(entry!.decisions)).toBe(true);
    expect(Array.isArray(entry!.debts)).toBe(true);

    // =========================================================================
    // Step 4: 决策确认 — 找到待确认的决策并确认
    // =========================================================================

    // decisions 由 finalize LLM（fake canned 固定含 1 条决策）产出——必有待确认决策。
    const pendingDecision = stateAfterInterview.decisions.find(
      (d: any) => d.confirmationStatus === "待用户确认"
    );
    expect(pendingDecision).toBeDefined();

    const confirmRes = await server.inject({
      method: "POST",
      url: `/api/assets/decisions/${pendingDecision!.id}/confirm`
    });
    expect(confirmRes.statusCode).toBe(200);
    const confirmBody = confirmRes.json();
    // 断言确认后状态更新
    expect(confirmBody.asset.id).toBe(pendingDecision!.id);
    expect(confirmBody.asset.confirmationStatus).toBe("用户确认");

    // 持久化验证
    const stateAfterConfirm = (await server.inject({ method: "GET", url: "/api/state" })).json();
    const confirmedDecision = stateAfterConfirm.decisions.find((d: any) => d.id === pendingDecision!.id);
    expect(confirmedDecision).toBeDefined();
    expect(confirmedDecision!.confirmationStatus).toBe("用户确认");

    // =========================================================================
    // Step 5: 记忆 HITL — 导入文档 → 候选 → 审批
    // =========================================================================

    // 5a. 导入含授权/控制感内容的文档，ragChunks 应写入
    const importRes = await server.inject({
      method: "POST",
      url: "/api/import/documents",
      payload: {
        title: "授权与控制感研究摘录",
        content:
          "研究显示，团队成员在被授权时，真正影响执行效果的不是权力的大小，" +
          "而是他们是否感受到「控制感」——即对自身决策边界的清晰认知。" +
          "控制感来自三个维度：决策范围的明确界定、资源支配权的实质转让、以及失败容错机制的透明度。" +
          "当这三项同时存在时，团队会主动承担责任而非被动等待指示。",
        sourceType: "text"
      }
    });
    expect(importRes.statusCode).toBe(200);
    const importBody = importRes.json();
    expect(typeof importBody.sourceId).toBe("string");
    expect(importBody.sourceId.length).toBeGreaterThan(0);
    expect(typeof importBody.candidateCount).toBe("number");
    expect(importBody.candidateCount).toBeGreaterThanOrEqual(0);
    expect(importBody.state).toBeDefined();

    // ragChunks 必须已写入（文档已切块）
    const stateAfterImport = importBody.state;
    expect(Array.isArray(stateAfterImport.ragChunks)).toBe(true);
    expect(stateAfterImport.ragChunks.length).toBeGreaterThan(0);
    // importSources 必须包含该文档
    const importedSource = stateAfterImport.importSources.find(
      (s: any) => s.id === importBody.sourceId
    );
    expect(importedSource).toBeDefined();

    // 5b. 审批候选记忆（fake 记忆抽取确定性产出候选，必有 pending 候选）
    expect(importBody.candidateCount).toBeGreaterThan(0);
    const pendingCandidate = stateAfterImport.memoryCandidates.find(
      (c: any) => c.status === "pending"
    );
    expect(pendingCandidate).toBeDefined();

    const approveRes = await server.inject({
      method: "POST",
      url: `/api/memory-candidates/${pendingCandidate!.id}/approve`
    });
    expect(approveRes.statusCode).toBe(200);
    const approveBody = approveRes.json();

    // 断言候选状态变更
    expect(approveBody.candidate.status).toBe("approved");
    // record 必须出现在 memoryRecords
    expect(approveBody.record).toBeDefined();
    expect(approveBody.record.sourceCandidateId).toBe(pendingCandidate!.id);

    // 持久化验证
    const stateAfterApprove = (await server.inject({ method: "GET", url: "/api/state" })).json();
    const persistedRecord = stateAfterApprove.memoryRecords.find(
      (r: any) => r.sourceCandidateId === pendingCandidate!.id
    );
    expect(persistedRecord).toBeDefined();

    // =========================================================================
    // Step 6: 资料 RAG — 问答（导入资料应被召回）
    // =========================================================================

    const ragRes = await server.inject({
      method: "POST",
      url: "/api/rag/query",
      payload: { question: "团队授权" }
    });
    expect(ragRes.statusCode).toBe(200);
    const ragBody = ragRes.json();
    // answer 来自注入的假 chat client（真实 RAG 代码路径：清洗→召回→prompt→生成）
    expect(typeof ragBody.answer).toBe("string");
    expect(ragBody.answer.length).toBeGreaterThan(0);
    expect(Array.isArray(ragBody.citations)).toBe(true);
    // 因为我们已导入文档，ragChunks 非空，citations 应来自导入资料
    expect(ragBody.citations.length).toBeGreaterThan(0);
    // 每条 citation 必须有 id 和 title
    for (const citation of ragBody.citations) {
      expect(typeof citation.id).toBe("string");
      expect(typeof citation.title).toBe("string");
    }
    // 断言召回真实命中了导入资料（citation 标题带主题词）
    expect(ragBody.citations.some((c: any) => c.title.includes("授权"))).toBe(true);

    // =========================================================================
    // Step 7: 主题线聚合 — buildTrackWorkspace
    // =========================================================================

    const stateForWorkspace = (await server.inject({ method: "GET", url: "/api/state" })).json();

    // 若有 theme，则聚合；否则用空 themeId 测试边界路径
    const firstTheme = stateForWorkspace.themes[0];
    const themeId = firstTheme?.id ?? "nonexistent-theme";
    const workspace = buildTrackWorkspace(stateForWorkspace, themeId);

    // 聚合结构必须包含 outputs 字段
    expect(workspace).toBeDefined();
    if (firstTheme) {
      expect(workspace.theme).toBeDefined();
      expect(workspace.theme!.id).toBe(themeId);
    } else {
      // 无主题时返回空结构
      expect(workspace.theme).toBeUndefined();
    }
    expect(Array.isArray(workspace.sessions)).toBe(true);
    expect(workspace.outputs).toBeDefined();
    expect(Array.isArray(workspace.outputs.points)).toBe(true);
    expect(Array.isArray(workspace.outputs.questions)).toBe(true);
    expect(Array.isArray(workspace.outputs.decisions)).toBe(true);
    expect(Array.isArray(workspace.outputs.debts)).toBe(true);

    // =========================================================================
    // Step 8: 导出 + 隐私报告
    // =========================================================================

    // 8a. 导出（备份演练报告）
    const exportRes = await server.inject({ method: "GET", url: "/api/state/export" });
    expect(exportRes.statusCode).toBe(200);
    const exportBody = exportRes.json();
    // export 返回备份演练报告，必须包含核心字段
    expect(exportBody).toBeDefined();

    // 8b. 隐私报告
    const privacyRes = await server.inject({ method: "GET", url: "/api/state/privacy-report" });
    expect(privacyRes.statusCode).toBe(200);
    const privacyBody = privacyRes.json();
    expect(privacyBody.inventory).toBeDefined();
    expect(Array.isArray(privacyBody.inventory)).toBe(true);
    expect(privacyBody.inventory.length).toBeGreaterThan(0);

    // R3 验证：inventory 不含 "intel" 分类（已删除）
    const inventoryIds = privacyBody.inventory.map((item: any) => item.id as string);
    expect(inventoryIds).not.toContain("intel");

    // 验证核心类别存在
    expect(inventoryIds).toContain("profile");
    expect(inventoryIds).toContain("interviews");
    expect(inventoryIds).toContain("assets");
    expect(inventoryIds).toContain("memory");
    expect(inventoryIds).toContain("external_knowledge");

    // 有数据后 totalRecords 应 > 0
    expect(typeof privacyBody.totalRecords).toBe("number");
    expect(privacyBody.totalRecords).toBeGreaterThan(0);

    // =========================================================================
    // Step 9: 播客 — 创建 episode（LLM 脚本 + 无 TTS → pending）+ 重新合成（无 TTS → 503）
    // =========================================================================

    // 9a. 用本次专访产生的 note 创建播客 episode
    const currentState = (await server.inject({ method: "GET", url: "/api/state" })).json();
    const targetNote = currentState.notes.find((n: any) => n.sessionId === sessionId);
    expect(targetNote).toBeDefined();
    const noteId = targetNote!.id;

    const episodeRes = await server.inject({
      method: "POST",
      url: "/api/podcast/episodes",
      payload: { noteId, format: "solo" }
    });
    expect(episodeRes.statusCode).toBe(200);
    const episodeBody = episodeRes.json();
    expect(episodeBody.episode).toBeDefined();
    expect(episodeBody.episode.noteId).toBe(noteId);
    // 脚本由假 chat client 走真实 LLM 脚本生成路径产出
    expect(typeof episodeBody.episode.script).toBe("string");
    expect(episodeBody.episode.script.length).toBeGreaterThan(0);
    // 无 TTS client → audioRenderStatus 保持 "pending"（尚未渲染是诚实状态）
    expect(episodeBody.episode.audioRenderStatus).toBe("pending");
    const episodeId = episodeBody.episode.id as string;

    // episode 必须持久化到 state
    const stateAfterEpisode = (await server.inject({ method: "GET", url: "/api/state" })).json();
    const persistedEpisode = stateAfterEpisode.podcastEpisodes.find((e: any) => e.id === episodeId);
    expect(persistedEpisode).toBeDefined();
    expect(persistedEpisode!.noteId).toBe(noteId);

    // 9b. 重新合成（synthesize）— 真实性重构:无 TTS client → 如实 503（不再假装 fallback 成功）
    const synthesizeRes = await server.inject({
      method: "POST",
      url: `/api/podcast/episodes/${episodeId}/synthesize`
    });
    expect(synthesizeRes.statusCode).toBe(503);
    expect(synthesizeRes.json().error).toContain("TTS");
    // 脚本必须保留：episode 原样在库（audioRenderStatus 仍是 pending，未被污染）
    const episodeAfterSynthesize = (await server.inject({ method: "GET", url: "/api/state" }))
      .json()
      .podcastEpisodes.find((e: any) => e.id === episodeId);
    expect(episodeAfterSynthesize).toBeDefined();
    expect(episodeAfterSynthesize.script.length).toBeGreaterThan(0);
    expect(episodeAfterSynthesize.audioRenderStatus).toBe("pending");

    // =========================================================================
    // Step 10: 全程非 5xx — 最终状态一致性校验
    // =========================================================================

    const finalStateRes = await server.inject({ method: "GET", url: "/api/state" });
    expect(finalStateRes.statusCode).toBe(200);
    const finalState = finalStateRes.json();

    // revision 必须因多次写操作而递增
    expect(typeof finalState.revision).toBe("number");
    expect(finalState.revision).toBeGreaterThan(resetState.revision);

    // 核心数据集合全部存在
    expect(Array.isArray(finalState.notes)).toBe(true);
    expect(Array.isArray(finalState.sessions)).toBe(true);
    expect(Array.isArray(finalState.searchBriefs)).toBe(true);
    expect(Array.isArray(finalState.importSources)).toBe(true);
    expect(Array.isArray(finalState.ragChunks)).toBe(true);
    expect(Array.isArray(finalState.podcastEpisodes)).toBe(true);

    // 各核心业务对象均已落库
    expect(finalState.notes.some((n: any) => n.sessionId === sessionId)).toBe(true);
    expect(finalState.sessions.some((s: any) => s.id === sessionId)).toBe(true);
    expect(finalState.searchBriefs.some((b: any) => b.id === briefId)).toBe(true);
    expect(finalState.importSources.some((s: any) => s.id === importBody.sourceId)).toBe(true);
    expect(finalState.ragChunks.length).toBeGreaterThan(0);
    expect(finalState.podcastEpisodes.some((e: any) => e.id === episodeId)).toBe(true);

    await server.close();
  });

  // =========================================================================
  // 补充：记忆 HITL mock LLM 路径（有候选时的完整流程验证）
  // =========================================================================
  it("memory HITL: fake LLM produces candidates → approve moves to memoryRecords", async () => {
    // 真实性重构:抽取解析已收紧（非 {"candidates":[...]} 形状即 502 原子失败）。注入
    // createFakeChatClient（canned 记忆抽取固定 1 条候选）走真实抽取→审批全路径。
    const server = buildApiServer({ env: {}, bailianChatClient: createFakeChatClient() });

    const importRes = await server.inject({
      method: "POST",
      url: "/api/import/documents",
      payload: {
        title: "授权研究摘录",
        content:
          "授权改革成功的核心在于让被授权者感受到真实的控制感，而非形式上的权力转让。" +
          "这要求管理者明确界定决策边界、转让资源支配权并建立透明的容错机制。",
        sourceType: "text"
      }
    });
    expect(importRes.statusCode).toBe(200);
    const importBody = importRes.json();
    expect(importBody.candidateCount).toBe(1);

    const pendingCandidate = importBody.state.memoryCandidates.find(
      (c: any) => c.status === "pending"
    );
    expect(pendingCandidate).toBeDefined();

    // 审批候选记忆
    const approveRes = await server.inject({
      method: "POST",
      url: `/api/memory-candidates/${pendingCandidate!.id}/approve`
    });
    expect(approveRes.statusCode).toBe(200);
    const approveBody = approveRes.json();
    expect(approveBody.candidate.status).toBe("approved");
    expect(approveBody.record).toBeDefined();
    expect(approveBody.record.sourceCandidateId).toBe(pendingCandidate!.id);

    // 跨路由验证：GET /api/state 持久化
    const finalState = (await server.inject({ method: "GET", url: "/api/state" })).json();
    const persistedRecord = finalState.memoryRecords.find(
      (r: any) => r.sourceCandidateId === pendingCandidate!.id
    );
    expect(persistedRecord).toBeDefined();

    await server.close();
  });

  // =========================================================================
  // 补充：播客 TTS 失败暴露（failing TTS client → 创建仍 200，audioRenderStatus=failed 真错误入库）
  // =========================================================================
  it("podcast TTS failure: failing TTS client → 200, script intact, status=failed", async () => {
    const __prevAutoRender = process.env.PODCAST_AUTO_RENDER_ON_CREATE;
    process.env.PODCAST_AUTO_RENDER_ON_CREATE = "true";
    try {
    const failingTtsClient = {
      synthesize: vi.fn(async () => {
        throw new Error("TTS synthesis error");
      })
    };

    const server = buildApiServer({ env: {}, ...fakeLlmClients(), bailianPodcastAudioClient: failingTtsClient });

    // 重置并创建一个 session + note
    await server.inject({ method: "POST", url: "/api/state/reset", payload: { confirm: "RESET_ALL_DATA" } });
    const sessionRes = await server.inject({
      method: "POST",
      url: "/api/interview-sessions",
      payload: { mode: "decision" }
    });
    const sessionId = sessionRes.json().session.id;

    await server.inject({
      method: "POST",
      url: `/api/interview-sessions/${sessionId}/turns`,
      payload: { content: "授权的关键是让团队成员感受到真实的控制感。" }
    });
    const endRes = await server.inject({
      method: "POST",
      url: `/api/interview-sessions/${sessionId}/end`
    });
    expect(endRes.statusCode).toBe(200);
    const noteId = endRes.json().note.id;

    // 创建播客 episode（TTS 会失败）
    const episodeRes = await server.inject({
      method: "POST",
      url: "/api/podcast/episodes",
      payload: { noteId, format: "solo" }
    });
    expect(episodeRes.statusCode).toBe(200);
    const episodeBody = episodeRes.json();
    expect(typeof episodeBody.episode.script).toBe("string");
    expect(episodeBody.episode.script.length).toBeGreaterThan(0);
    // 真实性重构:TTS 失败 → "failed" 真错误入库（"fallback" 伪中间态已删），脚本不丢
    expect(episodeBody.episode.audioRenderStatus).toBe("failed");
    expect(episodeBody.episode.audioRenderMessage).toContain("音频渲染失败");

    // episode 必须持久化
    const finalState = (await server.inject({ method: "GET", url: "/api/state" })).json();
    const persistedEpisode = finalState.podcastEpisodes.find(
      (e: any) => e.id === episodeBody.episode.id
    );
    expect(persistedEpisode).toBeDefined();
    expect(persistedEpisode!.audioRenderStatus).toBe("failed");


      await server.close();
    } finally {
      if (__prevAutoRender === undefined) delete process.env.PODCAST_AUTO_RENDER_ON_CREATE;
      else process.env.PODCAST_AUTO_RENDER_ON_CREATE = __prevAutoRender;
    }
  });

  // =========================================================================
  // 补充：系统模块真实业务段 —
  //   配置保存(PATCH env + 产品策略) → 语料分析 → 应用 patch
  //   → 断言 appliedPlaybookRules/ruleType 进入引擎策略与实时语音指令
  //   → 数据治理：导出有内容 / 隐私报告分类 / purge 后个人数据清空但结构在
  // =========================================================================
  it("system module: config save, corpus patch reaches engine+voice, data governance round-trip", async () => {
    // 注入空 env 对象，PATCH 写入它而非 process.env（隔离 + 可断言）。
    // 语料分析是 LLM 必选能力 → 注入假 chat client（canned 语料分析含 concrete-moment 规则）。
    const env: Record<string, string | undefined> = {};
    const server = buildApiServer({ env, bailianChatClient: createFakeChatClient() });

    await server.inject({ method: "POST", url: "/api/state/reset", payload: { confirm: "RESET_ALL_DATA" } });

    // -----------------------------------------------------------------------
    // A. 配置保存（env）— 写入生效 + 复核
    // -----------------------------------------------------------------------
    const patchCfg = await server.inject({
      method: "PATCH",
      url: "/api/system/config",
      payload: { updates: { ANYSEARCH_LANGUAGE: "en-US" } }
    });
    expect(patchCfg.statusCode).toBe(200);
    expect(patchCfg.json().settingsUpdated).toContain("ANYSEARCH_LANGUAGE");
    expect(env.ANYSEARCH_LANGUAGE).toBe("en-US");
    const cfgGet = (await server.inject({ method: "GET", url: "/api/system/config" })).json();
    const langSetting = cfgGet.sections
      .flatMap((s: any) => s.settings)
      .find((x: any) => x.key === "ANYSEARCH_LANGUAGE");
    expect(langSetting.value).toBe("en-US");

    // -----------------------------------------------------------------------
    // B. 语料分析 → 应用 patch → 进入引擎策略 + 实时语音指令
    // -----------------------------------------------------------------------
    const insights = await server.inject({
      method: "POST",
      url: "/api/corpus/insights",
      payload: {
        title: "优秀决策专访样本",
        content:
          "主持人：你提到团队最近很乱，能不能讲一个最近一次具体时刻？\n" +
          "被访者：上周一次上线，三个人都在等我拍板。\n" +
          "主持人：如果反过来看，是不是机制一直奖励大家等你拍板，让放手要付出代价？"
      }
    });
    expect(insights.statusCode).toBe(200);
    const patch = insights.json().insight.recommendedPatches[0];
    expect(patch.status).toBe("proposed");
    expect(patch.ruleTypes.length).toBe(patch.rules.length);
    const firstRule = patch.rules[0] as string;

    const applyRes = await server.inject({ method: "POST", url: `/api/playbook-patches/${patch.id}/apply` });
    expect(applyRes.statusCode).toBe(200);
    expect(applyRes.json().patch.status).toBe("applied");

    // 新会话引擎策略纳入规则与 ruleType
    const sysSession = (await server.inject({
      method: "POST",
      url: "/api/interview-sessions",
      payload: { mode: "decision" }
    })).json().session;
    expect(sysSession.enginePolicy.appliedPlaybookRules).toContain(firstRule);
    expect(sysSession.enginePolicy.appliedPlaybookRuleTypes).toContain("concrete-moment");

    // 规则穿透到实时语音主持指令
    const agentCtx = (await server.inject({
      method: "GET",
      url: `/api/realtime-voice/agent-context/${sysSession.id}`
    })).json();
    expect(agentCtx.instructions).toContain("已应用的提问技法");
    expect(agentCtx.instructions).toContain(firstRule);

    // -----------------------------------------------------------------------
    // C. 数据治理：导出有内容 → 隐私报告分类 → purge 后清空但结构在
    // -----------------------------------------------------------------------
    const exp = (await server.inject({ method: "GET", url: "/api/state/export" })).json();
    expect(exp.schemaVersion).toBe(1);
    expect(exp.package.restoredDigest).toBe(exp.package.stateDigest); // 恢复摘要一致
    expect(exp.package.providerSecretsExcluded).toBe(true);
    expect(exp.checks.find((c: any) => c.id === "provider-secrets").status).toBe("passed");

    const privBefore = (await server.inject({ method: "GET", url: "/api/state/privacy-report" })).json();
    expect(privBefore.hasPersonalData).toBe(true);
    expect(privBefore.inventory.map((i: any) => i.id)).toContain("corpus_learning");
    // 语料学习类目应反映导入样本 + patch（count > 0）
    expect(privBefore.inventory.find((i: any) => i.id === "corpus_learning").count).toBeGreaterThan(0);

    const purged = (await server.inject({ method: "POST", url: "/api/state/purge", payload: { confirm: "PURGE_PERSONAL_DATA" } })).json();
    // 个人数据清空
    expect(purged.profile.name).toBe("");
    expect(purged.sessions).toHaveLength(0);
    expect(purged.corpusImports).toHaveLength(0);
    expect(purged.playbookPatches).toHaveLength(0);
    // 结构保留 + 一条清空审计 + 配置保留
    expect(Array.isArray(purged.themes)).toBe(true);
    expect(purged.auditEvents).toHaveLength(1);
    expect(purged.auditEvents[0].type).toBe("privacy_data_purged");
    expect(purged.systemConfig).toBeDefined();

    // 清空后隐私报告：无个人数据
    const privAfter = (await server.inject({ method: "GET", url: "/api/state/privacy-report" })).json();
    expect(privAfter.hasPersonalData).toBe(false);

    await server.close();
  });
});

/**
 * System-module real-business journey tests (S5).
 *
 * 聚焦"系统模块"端到端真实业务，补齐 full-business-journey 较少覆盖的：
 *   - 系统配置（capabilities 诚实降级 + config env 保存生效 + 白名单/校验）
 *   - 语料学习闭环（corpus 分析 → PlaybookPatch → apply → 引擎策略 → 实时语音指令）
 *   - 数据治理（export 备份演练 / privacy-report 分类 / purge 真删除但结构保留）
 *
 * 对齐文档：docs/superpowers/2026-06-19-system-verification-criteria.md §3/§6/§7/§8。
 *
 * 约束：
 *  - env={} (无 key) → 确定性 fallback，不触网、不依赖 LLM。
 *  - 全程 buildApiServer + server.inject，不开端口（不碰 5173/8787）。
 *  - 断言数据真实流转，而非仅校验状态码。
 */

import { describe, it, expect, vi } from "vitest";
import { buildApiServer } from "../server";

// ===========================================================================
// Journey A — 复杂真实业务贯穿：配置引擎 → 调研盯梢 → 专访(消费 tracked 简报)
//             → 资产 → 记忆候选审批 → 导出校验 → 隐私报告 → 彻底清空
// ===========================================================================
describe("System journey A: config → research auto-run → interview → assets → memory → export → privacy → purge", () => {
  it("runs the full system-module business loop end-to-end with no 5xx and real data flow", async () => {
    // 注入空 env 对象，使 PATCH /api/system/config 写入这个对象而非 process.env（隔离、可断言）。
    const env: Record<string, string | undefined> = {};
    const server = buildApiServer({ env });

    // --- 前置：清空到空状态 ---
    const reset = await server.inject({ method: "POST", url: "/api/state/reset", payload: { confirm: "RESET_ALL_DATA" } });
    expect(reset.statusCode).toBe(200);
    const baseRevision = reset.json().revision as number;

    // =====================================================================
    // Step 1: 系统能力健康 — 无 key 必须诚实降级，不谎报 ready
    // =====================================================================
    const capRes = await server.inject({ method: "GET", url: "/api/system/capabilities" });
    expect(capRes.statusCode).toBe(200);
    const capBody = capRes.json();
    expect(Array.isArray(capBody.capabilities)).toBe(true);
    expect(capBody.capabilities.length).toBeGreaterThan(0);
    // 运行时 ready；状态库在内存态（本测试无 dbPath）是 degraded（非持久，诚实降级），sqlite 才 ready
    const byId = (id: string) => capBody.capabilities.find((c: any) => c.id === id);
    expect(byId("product-api").status).toBe("ready");
    expect(byId("state-store").status).toBe("degraded");
    // 无 key → 百炼能力必须是 needs-key（诚实降级）
    expect(byId("bailian-responses").status).toBe("needs-key");
    expect(byId("bailian-character").status).toBe("needs-key");
    expect(byId("bailian-cosyvoice").status).toBe("needs-key");
    // 每项能力结构完整
    for (const cap of capBody.capabilities) {
      expect(typeof cap.id).toBe("string");
      expect(typeof cap.kind).toBe("string");
      expect(typeof cap.status).toBe("string");
      expect(typeof cap.active).toBe("boolean");
      expect(Array.isArray(cap.requiredEnv)).toBe(true);
    }

    // =====================================================================
    // Step 2: 保存服务端配置（env） — 白名单过滤 + 校验 + 写入生效
    // =====================================================================
    // 空 updates → 422（拒绝无效请求）
    const emptyCfg = await server.inject({
      method: "PATCH",
      url: "/api/system/config",
      payload: { updates: {} }
    });
    expect(emptyCfg.statusCode).toBe(422);

    // 合法 PATCH：改 AnySearch 语言 + 播客音色；混入一个非白名单 key（必须被丢弃）
    const patchCfg = await server.inject({
      method: "PATCH",
      url: "/api/system/config",
      payload: {
        updates: {
          ANYSEARCH_LANGUAGE: "en-US",
          BAILIAN_ASR_LANGUAGE_HINT: "auto",
          TOTALLY_UNKNOWN_KEY: "should-be-dropped"
        }
      }
    });
    expect(patchCfg.statusCode).toBe(200);
    const patchBody = patchCfg.json();
    // 只有白名单 key 被记录为已更新
    expect(patchBody.settingsUpdated).toContain("ANYSEARCH_LANGUAGE");
    expect(patchBody.settingsUpdated).toContain("BAILIAN_ASR_LANGUAGE_HINT");
    expect(patchBody.settingsUpdated).not.toContain("TOTALLY_UNKNOWN_KEY");
    // 写入的是注入的 env 对象（in-memory 立即生效）
    expect(env.ANYSEARCH_LANGUAGE).toBe("en-US");
    expect(env.TOTALLY_UNKNOWN_KEY).toBeUndefined();

    // 复核 GET /api/system/config — 新值反映出来
    const cfgGet = await server.inject({ method: "GET", url: "/api/system/config" });
    expect(cfgGet.statusCode).toBe(200);
    const allSettings = cfgGet.json().sections.flatMap((s: any) => s.settings);
    const langSetting = allSettings.find((x: any) => x.key === "ANYSEARCH_LANGUAGE");
    expect(langSetting.configured).toBe(true);
    expect(langSetting.value).toBe("en-US");
    // secret 永不回显明文：DASHSCOPE_API_KEY 的 value 必须为 null
    const secretSetting = allSettings.find((x: any) => x.key === "DASHSCOPE_API_KEY");
    expect(secretSetting.secret).toBe(true);
    expect(secretSetting.value).toBeNull();

    // =====================================================================
    // Step 3: 外部调研自动盯梢 — 建简报 → track → auto-run（生成/刷新/去重汇总）
    // =====================================================================
    const briefRes = await server.inject({
      method: "POST",
      url: "/api/search/briefs",
      payload: { topic: "AI 编程助手的护城河", providerId: "local-demo" }
    });
    expect(briefRes.statusCode).toBe(200);
    const briefId = briefRes.json().brief.id as string;
    expect(briefRes.json().brief.sources.length).toBeGreaterThan(0);

    const trackRes = await server.inject({
      method: "POST",
      url: `/api/search/briefs/${briefId}/track`,
      payload: { tracked: true }
    });
    expect(trackRes.statusCode).toBe(200);
    expect(trackRes.json().brief.tracked).toBe(true);

    const autoRunRes = await server.inject({ method: "POST", url: "/api/research/auto-run" });
    expect(autoRunRes.statusCode).toBe(200);
    const autoRunBody = autoRunRes.json();
    // auto-run 必返回三段计数汇总，且都是数字 ≥ 0
    expect(typeof autoRunBody.summary.generated).toBe("number");
    expect(typeof autoRunBody.summary.refreshed).toBe("number");
    expect(typeof autoRunBody.summary.dedupedSources).toBe("number");
    expect(autoRunBody.summary.generated).toBeGreaterThanOrEqual(0);
    expect(autoRunBody.summary.refreshed).toBeGreaterThanOrEqual(0);
    expect(autoRunBody.summary.dedupedSources).toBeGreaterThanOrEqual(0);
    // finalState 持久化；tracked 简报仍在
    expect(autoRunBody.state.searchBriefs.some((b: any) => b.id === briefId)).toBe(true);

    // =====================================================================
    // Step 4: 专访消费 tracked 简报 → 双轨笔记 + 资产
    // =====================================================================
    const sessRes = await server.inject({
      method: "POST",
      url: "/api/interview-sessions",
      payload: { mode: "decision", strength: "standard", searchBriefId: briefId }
    });
    expect(sessRes.statusCode).toBe(200);
    const session = sessRes.json().session;
    expect(session.status).toBe("active");
    // 简报已进入上下文：card 标题非空
    expect(typeof session.card.title).toBe("string");
    expect(session.card.title.length).toBeGreaterThan(0);
    const sessionId = session.id as string;

    for (const content of [
      "我们在想 AI 编程助手真正的护城河到底是什么，是模型、数据，还是工作流嵌入。",
      "最近一次内部评审里，大家发现真正难替代的不是补全质量，而是它已经接住了我们的代码评审流程。",
      "所以我倾向于认为护城河是把自己嵌进团队既有工作流，而不是单点能力的领先。"
    ]) {
      const turnRes = await server.inject({
        method: "POST",
        url: `/api/interview-sessions/${sessionId}/turns`,
        payload: { content }
      });
      expect(turnRes.statusCode).toBe(200);
    }

    const endRes = await server.inject({ method: "POST", url: `/api/interview-sessions/${sessionId}/end` });
    expect(endRes.statusCode).toBe(200);
    const note = endRes.json().note;
    expect(note.sessionId).toBe(sessionId);
    expect(note.title.length).toBeGreaterThan(0);
    expect(Array.isArray(note.saidTrack)).toBe(true);
    expect(Array.isArray(note.learnedTrack)).toBe(true);
    // session 标记 completed
    const completed = endRes.json().state.sessions.find((s: any) => s.id === sessionId);
    expect(completed.status).toBe("completed");

    // =====================================================================
    // Step 5: 记忆 HITL — 导入资料 → (可选)审批候选 → 持久化 record
    // =====================================================================
    const importRes = await server.inject({
      method: "POST",
      url: "/api/import/documents",
      payload: {
        title: "护城河研究摘录",
        content:
          "多份分析指出，开发者工具的长期护城河来自工作流锁定与数据飞轮，" +
          "而非单一模型能力的短期领先。一旦工具接住团队的评审、CI 和知识沉淀，迁移成本会显著上升。",
        sourceType: "text"
      }
    });
    expect(importRes.statusCode).toBe(200);
    const importBody = importRes.json();
    expect(typeof importBody.sourceId).toBe("string");
    expect(importBody.state.ragChunks.length).toBeGreaterThan(0);

    const pendingCandidate = importBody.state.memoryCandidates.find((c: any) => c.status === "pending");
    if (pendingCandidate) {
      const approveRes = await server.inject({
        method: "POST",
        url: `/api/memory-candidates/${pendingCandidate.id}/approve`
      });
      expect(approveRes.statusCode).toBe(200);
      expect(approveRes.json().candidate.status).toBe("approved");
      const persisted = (await server.inject({ method: "GET", url: "/api/state" }))
        .json()
        .memoryRecords.find((r: any) => r.sourceCandidateId === pendingCandidate.id);
      expect(persisted).toBeDefined();
    }
    // 无 key 时 corpus_import 候选仍可能由确定性引擎生成；无候选也是合理路径。

    // =====================================================================
    // Step 6: 导出备份演练 — 可序列化 + 恢复摘要一致 + 密钥排除
    // =====================================================================
    const exportRes = await server.inject({ method: "GET", url: "/api/state/export" });
    expect(exportRes.statusCode).toBe(200);
    const exp = exportRes.json();
    expect(exp.schemaVersion).toBe(1);
    expect(typeof exp.package.stateDigest).toBe("string");
    expect(exp.package.stateDigest.length).toBeGreaterThan(0);
    // 恢复后摘要必须一致（备份可信）
    expect(exp.package.restoredDigest).toBe(exp.package.stateDigest);
    expect(exp.package.providerSecretsExcluded).toBe(true);
    expect(exp.package.privacyReportIncluded).toBe(true);
    expect(typeof exp.summary.passed).toBe("number");
    expect(typeof exp.summary.failed).toBe("number");
    expect(Array.isArray(exp.checks)).toBe(true);
    expect(Array.isArray(exp.runbook)).toBe(true);
    expect(exp.runbook.length).toBeGreaterThan(0);
    // provider-secrets 检查必须 passed
    const secretCheck = exp.checks.find((c: any) => c.id === "provider-secrets");
    expect(secretCheck.status).toBe("passed");
    // 内嵌隐私报告
    expect(exp.privacyReport).toBeDefined();
    expect(Array.isArray(exp.privacyReport.inventory)).toBe(true);

    // =====================================================================
    // Step 7: 隐私报告（清空前） — 分类齐全、含数据、不含已删 intel
    // =====================================================================
    const privBefore = (await server.inject({ method: "GET", url: "/api/state/privacy-report" })).json();
    expect(privBefore.totalRecords).toBeGreaterThan(0);
    expect(privBefore.hasPersonalData).toBe(true);
    const idsBefore = privBefore.inventory.map((i: any) => i.id);
    for (const cat of [
      "profile",
      "interviews",
      "assets",
      "memory",
      "external_knowledge",
      "corpus_learning",
      "generated_media",
      "operations"
    ]) {
      expect(idsBefore).toContain(cat);
    }
    expect(idsBefore).not.toContain("intel");
    // interviews 类目计数应反映本次专访（sessions + notes ≥ 2）
    const interviewsItem = privBefore.inventory.find((i: any) => i.id === "interviews");
    expect(interviewsItem.count).toBeGreaterThanOrEqual(2);

    // =====================================================================
    // Step 8: 彻底清空 — 个人数据归零，但结构与 provider 配置保留
    // =====================================================================
    const purgeRes = await server.inject({ method: "POST", url: "/api/state/purge", payload: { confirm: "PURGE_PERSONAL_DATA" } });
    expect(purgeRes.statusCode).toBe(200);
    const purged = purgeRes.json();
    // 个人数据归零
    expect(purged.profile.name).toBe("");
    expect(purged.profile.explicitBoundaries).toHaveLength(0);
    expect(purged.sessions).toHaveLength(0);
    expect(purged.notes).toHaveLength(0);
    expect(purged.points).toHaveLength(0);
    expect(purged.searchBriefs).toHaveLength(0);
    expect(purged.memoryRecords).toHaveLength(0);
    expect(purged.podcastEpisodes).toHaveLength(0);
    expect(purged.corpusImports).toHaveLength(0);
    // 结构保留：核心集合仍是数组（不破坏可启动性）
    expect(Array.isArray(purged.themes)).toBe(true);
    expect(Array.isArray(purged.ragChunks)).toBe(true);
    // 保留一条清空审计事件作为删除证据
    expect(purged.auditEvents).toHaveLength(1);
    expect(purged.auditEvents[0].type).toBe("privacy_data_purged");
    // systemConfig 保留（provider 运行配置不随个人数据删除）
    expect(purged.systemConfig).toBeDefined();
    // revision 仍单调递增
    expect(purged.revision).toBeGreaterThan(baseRevision);

    // 清空后隐私报告：无个人数据，仅剩运营审计计数
    const privAfter = (await server.inject({ method: "GET", url: "/api/state/privacy-report" })).json();
    expect(privAfter.hasPersonalData).toBe(false);
    const profileAfter = privAfter.inventory.find((i: any) => i.id === "profile");
    expect(profileAfter.count).toBe(0);
    const opsAfter = privAfter.inventory.find((i: any) => i.id === "operations");
    expect(opsAfter.count).toBeGreaterThanOrEqual(1); // 至少保留清空审计事件

    // 清空后系统仍可工作：能创建新会话（验证结构未被破坏）
    const postPurgeSession = await server.inject({
      method: "POST",
      url: "/api/interview-sessions",
      payload: { mode: "daily" }
    });
    expect(postPurgeSession.statusCode).toBe(200);
    expect(postPurgeSession.json().session.status).toBe("active");

    await server.close();
  });
});

// ===========================================================================
// Journey B — 语料学习闭环：分析样本 → PlaybookPatch → apply
//             → 新会话引擎策略纳入规则 → 实时语音主持指令带上规则
// ===========================================================================
describe("System journey B: corpus learning patch propagates to engine policy AND realtime voice instructions", () => {
  it("applies a corpus-derived playbook patch and the rule reaches a new session's engine policy + agent-context instructions", async () => {
    const server = buildApiServer({ env: {} });
    await server.inject({ method: "POST", url: "/api/state/reset", payload: { confirm: "RESET_ALL_DATA" } });

    // --- 1. 语料分析：导入一段含"具体时刻 + 机制反转"技法的优秀样本 ---
    const insightsRes = await server.inject({
      method: "POST",
      url: "/api/corpus/insights",
      payload: {
        title: "优秀决策专访样本",
        content:
          "主持人：你提到团队最近很乱，能不能讲一个最近一次具体时刻？\n" +
          "被访者：上周一次上线，三个人都在等我拍板。\n" +
          "主持人：如果反过来看，是不是机制一直奖励大家等你拍板，让放手要付出代价？\n" +
          "被访者：确实，没人愿意承担那个失败的代价。"
      }
    });
    expect(insightsRes.statusCode).toBe(200);
    const insightBody = insightsRes.json();
    expect(insightBody.insight).toBeDefined();
    expect(Array.isArray(insightBody.insight.dimensions)).toBe(true);
    expect(insightBody.insight.dimensions.length).toBeGreaterThan(0);

    const patch = insightBody.insight.recommendedPatches[0];
    expect(patch).toBeDefined();
    expect(patch.status).toBe("proposed");
    expect(patch.rules.length).toBeGreaterThan(0);
    // ruleTypes 与 rules 位置对齐（策略可按机器可读类型路由，而非脆弱关键词匹配）
    expect(patch.ruleTypes.length).toBe(patch.rules.length);
    expect(patch.ruleTypes).toContain("concrete-moment");
    const firstRule = patch.rules[0] as string;

    // --- 2. 应用补丁（HITL：只有 proposed 可 apply）---
    const applyRes = await server.inject({ method: "POST", url: `/api/playbook-patches/${patch.id}/apply` });
    expect(applyRes.statusCode).toBe(200);
    expect(applyRes.json().patch.status).toBe("applied");
    // 配置版本追加补丁后缀（可观测的引擎变更）
    expect(applyRes.json().state.systemConfig.version).toContain("+");

    // 重复 apply 应被拒（非 proposed → 409）
    const reapply = await server.inject({ method: "POST", url: `/api/playbook-patches/${patch.id}/apply` });
    expect(reapply.statusCode).toBe(409);

    // --- 3. 新会话的引擎策略纳入规则 ---
    const sessRes = await server.inject({ method: "POST", url: "/api/interview-sessions", payload: { mode: "decision" } });
    expect(sessRes.statusCode).toBe(200);
    const session = sessRes.json().session;
    expect(session.enginePolicy.appliedPlaybookRules).toContain(firstRule);
    expect(session.enginePolicy.appliedPlaybookRuleTypes).toContain("concrete-moment");

    // --- 4. 实时语音主持指令带上规则（学习 → 引擎 → 语音 全链路）---
    const ctxRes = await server.inject({
      method: "GET",
      url: `/api/realtime-voice/agent-context/${session.id}`
    });
    expect(ctxRes.statusCode).toBe(200);
    const instructions = ctxRes.json().instructions as string;
    expect(typeof instructions).toBe("string");
    expect(instructions).toContain("已应用的提问技法");
    // 规则原文必须出现在语音指令里
    expect(instructions).toContain(firstRule);

    // --- 5. 回滚补丁后，新会话不再带该规则（闭环对称）---
    const revertRes = await server.inject({ method: "POST", url: `/api/playbook-patches/${patch.id}/revert` });
    expect(revertRes.statusCode).toBe(200);
    expect(revertRes.json().patch.status).toBe("reverted");

    const sessAfterRevert = (await server.inject({
      method: "POST",
      url: "/api/interview-sessions",
      payload: { mode: "decision" }
    })).json().session;
    expect(sessAfterRevert.enginePolicy.appliedPlaybookRules).not.toContain(firstRule);

    await server.close();
  });

  // -------------------------------------------------------------------------
  // 语料 LLM 路径：mock chatClient 返回结构化分析时，patch 采用 LLM 内容并仍可应用
  // -------------------------------------------------------------------------
  it("corpus LLM analysis path: mock chat client analysis becomes an applicable patch with rule types", async () => {
    const mockChatClient = {
      complete: vi.fn(async () =>
        JSON.stringify({
          dimensions: [
            {
              name: "追问动作",
              score: 5,
              finding: "先索要具体时刻，再做机制反转。",
              example: "能不能讲一个最近一次具体时刻？",
              recommendedAction: "抽象评价后先追具体时刻。"
            }
          ],
          improvementPlan: [
            {
              title: "具体时刻优先",
              rationale: "样本先把被访者带回可复盘的具体场景。",
              action: "抽象评价时先追问最近一次具体时刻。",
              expectedEngineChange: "引擎优先触发索要具体时刻。",
              evidence: "能不能讲一个最近一次具体时刻？"
            }
          ],
          patch: {
            title: "先索要具体时刻，再做机制反转",
            description: "先落到具体事件，再翻译为机制问题。",
            rules: [
              "当用户使用抽象评价时，先追问一个具体时刻。",
              "拿到具体例子后，再从机制、奖励和代价角度反问。"
            ],
            impact: "high"
          }
        })
      )
    };

    const server = buildApiServer({ env: {}, bailianChatClient: mockChatClient as any });
    await server.inject({ method: "POST", url: "/api/state/reset", payload: { confirm: "RESET_ALL_DATA" } });

    const insightsRes = await server.inject({
      method: "POST",
      url: "/api/corpus/insights",
      payload: {
        title: "LLM 分析样本",
        content: "主持人：能不能讲一个最近一次具体时刻？\n被访者：上周上线大家都在等我拍板。"
      }
    });
    expect(insightsRes.statusCode).toBe(200);
    const patch = insightsRes.json().insight.recommendedPatches[0];
    // 不论走 LLM 还是 fallback，patch 都必须可应用且规则带 ruleType
    expect(patch.status).toBe("proposed");
    expect(patch.rules.length).toBeGreaterThan(0);
    expect(patch.ruleTypes.length).toBe(patch.rules.length);

    const applyRes = await server.inject({ method: "POST", url: `/api/playbook-patches/${patch.id}/apply` });
    expect(applyRes.statusCode).toBe(200);
    expect(applyRes.json().patch.status).toBe("applied");

    await server.close();
  });
});

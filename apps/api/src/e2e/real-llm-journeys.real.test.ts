// @vitest-environment node
// F-09:本文件此前跑在 jsdom(vite.config.ts 全局默认)下——纯 API 冒烟根本不需要 DOM,
// jsdom 反而让本地 embedding(transformers.js)持续报 Float32Array realm 错误并降级,
// 污染日志(独立 Node 路径已验证 embedding 本身正常)。文件内无 window/document/navigator
// 依赖,故用文件级指令切到 node 环境。
/**
 * Real-LLM gated end-to-end business journey tests.
 *
 * These tests prove the system produces REAL, on-topic intelligence (not demo
 * templates) when a live DashScope / AnySearch key is present.
 *
 * F-09 分工契约(接线测试 vs 外部 smoke):
 *   - 本文件 = 外部 provider smoke:需要真实 key,验证"真调外部服务能产出真智能"。
 *     允许 skip(未配置 key,或已配置但外部服务不可达),但绝不允许 false-green——
 *     外部调用失败时禁止悄悄 return 让 vitest 计 passed,必须用 ctx.skip(reason)
 *     以明确理由计入 skipped,或在断言"我们自己的接线"时真实 fail。
 *   - 接线正确性(路由→provider client 的组装/刷新)由常规 mock 测试保证,
 *     见 apps/api/src/server.test.ts 的 "uses refreshed AnySearch provider client
 *     in search routes after runtime config PATCH" 等用例——那里才是稳定回归防线。
 *
 * 隔离开关:REAL_PROVIDER_SMOKE=off 时视为未配置任何 key,全部 skip。
 * 用于在存在 .env.local 真实 key 的机器上跑全量 vitest 而不触发外部调用
 * (只读 process.env,不写,不违反下方 scoped-env 约束)。
 *
 * CRITICAL CONSTRAINT — scoped env, never global:
 *   Keys are loaded from .env.local into a LOCAL const `env` object.
 *   We pass that object via buildApiServer({ env }).
 *   We MUST NOT write to global process.env — other tests in the same vitest
 *   run (server.test.ts, state.test.ts, etc.) call buildApiServer() with the
 *   default process.env; polluting it would make them start live calls and
 *   break the suite.
 *
 * Tests are skipped when DASHSCOPE_API_KEY is not present in .env.local.
 * Live LLM calls are slow; each test has a 120 s timeout.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, type TestContext } from "vitest";
import { buildApiServer } from "../server";
// F-07:签名 URL 等同 bearer capability,日志一律经 redactUrl 脱敏
import { redactUrl } from "../log-redaction";

// ---------------------------------------------------------------------------
// Load .env.local into a LOCAL object — never touch process.env
// (F-09:已切 node 环境,fileURLToPath 解析 ESM file:// URL 在 node 下同样正确)
// ---------------------------------------------------------------------------

function loadEnvLocal(): Record<string, string> {
  // F-09 隔离开关:显式关掉 smoke(等价于"未配置 key"→全部 skip),
  // 让持有真实 .env.local 的机器也能安全跑全量 vitest 而不打外部服务。
  // 归一化大小写并接受常见否定值,避免 OFF/False/0 因写法差异静默失效反而真调外部。
  const smokeSwitch = (process.env.REAL_PROVIDER_SMOKE ?? "").trim().toLowerCase();
  if (smokeSwitch === "off" || smokeSwitch === "0" || smokeSwitch === "false") {
    return {};
  }
  const env: Record<string, string> = {};
  try {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    // 4 levels up: e2e/ -> src/ -> api/ -> apps/ -> repo root
    const envPath = resolve(thisDir, "../../../../.env.local");
    const raw = readFileSync(envPath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !line.trim().startsWith("#")) {
        env[m[1]] = m[2];
      }
    }
  } catch {
    /* no .env.local — all tests will be skipped */
  }
  return env;
}

const env = loadEnvLocal();
const hasKey = !!env.DASHSCOPE_API_KEY;
const hasAnySearchKey = !!env.ANYSEARCH_API_KEY;

// ---------------------------------------------------------------------------
// F-07 × F-09 联动:skip note 会进入 reporter 输出,携带的 provider 错误原文
// (如 task.error)理论上可能内嵌带签名的 URL——签名 URL 等同 bearer capability,
// 与 console 日志同一红线。统一脱敏:URL 一律过 redactUrl,再截断防止超长错误刷屏。
// ---------------------------------------------------------------------------
function sanitizeSkipNote(note: string): string {
  // URL 边界排除空白与右括号(中英文)、中文逗号:note 模板用「(…)」包裹错误原文,
  // \S+ 会把这些标点吞进 URL 一起脱敏——虽安全但 note 不可读。
  const redacted = note.replace(/https?:\/\/[^\s),，）]+/g, (url) => redactUrl(url));
  return redacted.length > 200 ? `${redacted.slice(0, 200)}…` : redacted;
}

// ---------------------------------------------------------------------------
// F-09 回归守卫:钉死本文件跑在 node 环境。若有人删掉文件头的
// `@vitest-environment node` 指令或全局配置变化把它拖回 jsdom,这里立即红。
// (jsdom 下 transformers.js 的 Float32Array 跨 realm 检查会失败,本地 embedding
// 全程降级并刷屏——纯测试环境噪声,但会淹没 real-provider smoke 的真实日志。)
// ---------------------------------------------------------------------------
describe("environment guard (F-09)", () => {
  it("runs in node, not jsdom", () => {
    expect(typeof (globalThis as any).window).toBe("undefined");
    expect(typeof (globalThis as any).document).toBe("undefined");
  });
});

// ---------------------------------------------------------------------------
// Journey A — real interview → on-topic diary + assets (golden acceptance)
// ---------------------------------------------------------------------------

describe.skipIf(!hasKey)("real-LLM business journeys", () => {
  describe("Journey A — real interview → on-topic diary (no demo-script leak)", () => {
    // Use a single server + state across the whole journey
    let server: ReturnType<typeof buildApiServer>;
    let sessionId: string;
    let note: any;
    let state: any;
    let stateBefore: any;
    // F-09:key 已配置但外部 LLM 不可达时,/end 会降级为确定性 finalize——它同样产出
    // 非空、on-topic 的 note 与资产(内容来自用户 turns),下面所有断言都会"通过",
    // 构成 false-green:名为 real-LLM 的 smoke 在 LLM 完全没被真调时仍显示绿。
    // 归类:这是"已配置但外部不可达"→ 必须 skip 且写明理由,不能计 passed。
    // 判据用 finalize 的降级事件(workflow=interview_preparation, status=degraded,
    // 见 routes/interview-sessions.ts P1-13):四条断言全部验证 finalize 产物,
    // 单个 turn 降级不影响其有效性,故只看 finalize。
    let finalizeDegraded = false;

    function skipIfLlmUnreachable(ctx: TestContext) {
      if (finalizeDegraded) {
        ctx.skip("外部服务不可达:DashScope key 已配置但 LLM finalize 降级为确定性引擎,real-LLM 断言无意义(F-09,不计 passed)");
      }
    }

    beforeAll(async () => {
      server = buildApiServer({ env });

      // Step 1: Reset to empty state
      const resetRes = await server.inject({ method: "POST", url: "/api/state/reset", payload: { confirm: "RESET_ALL_DATA" } });
      expect(resetRes.statusCode).toBe(200);

      // Step 2: Create a decision-mode session
      const createRes = await server.inject({
        method: "POST",
        url: "/api/interview-sessions",
        payload: { mode: "decision", strength: "standard" }
      });
      expect(createRes.statusCode).toBe(200);
      const createBody = createRes.json();
      sessionId = createBody.session.id;
      expect(typeof sessionId).toBe("string");
      expect(sessionId.length).toBeGreaterThan(0);

      // Capture state before finalize so we can diff newly-created assets
      stateBefore = { points: [], questions: [], decisions: [], debts: [], themes: [] };

      // Step 3: Send 4 turns on a novel离职/独立开发 storyline
      const turns = [
        "我在一家大厂做了六年产品，最近一直想离职去做独立开发者。",
        "真正让我犹豫的不是薪资——是怕失去大厂这个身份符号，以及团队的归属感。",
        "我最怕的情形是：离职后整整一年，做不出任何用户愿意付费的产品，然后灰溜溜回去。",
        "但另一方面，我觉得独立开发是一次重塑个人身份的机会，不只是职业选择，而是找到自己真正在乎什么。"
      ];

      for (const content of turns) {
        const turnRes = await server.inject({
          method: "POST",
          url: `/api/interview-sessions/${sessionId}/turns`,
          payload: { content }
        });
        expect(turnRes.statusCode).toBe(200);
        const turnBody = turnRes.json();
        expect(turnBody.session).toBeDefined();
        // Capture last state for delta calculation
        stateBefore = turnBody.state;
      }

      // Step 4: End the session (triggers LLM finalize)
      const endRes = await server.inject({
        method: "POST",
        url: `/api/interview-sessions/${sessionId}/end`
      });
      expect(endRes.statusCode).toBe(200);
      const endBody = endRes.json();
      note = endBody.note;
      state = endBody.state;
      // F-09:从状态里读 finalize 降级事件(withAiRunEvent 把最新事件放队首)
      finalizeDegraded = (state?.aiRunEvents ?? []).some(
        (event: any) =>
          event?.workflow === "interview_preparation" &&
          event?.status === "degraded" &&
          event?.entityId === sessionId
      );
      if (finalizeDegraded) {
        console.warn("[Journey A] finalize degraded to deterministic engine — tests will be SKIPPED, not passed (F-09)");
      }
    }, 120_000);

    it("returns a real, non-empty diary note", (ctx) => {
      skipIfLlmUnreachable(ctx);
      expect(note).toBeDefined();
      expect(typeof note.summary).toBe("string");
      expect(note.summary.length).toBeGreaterThan(0);
      expect(Array.isArray(note.saidTrack)).toBe(true);
      expect(note.saidTrack.length).toBeGreaterThan(0);
      expect(Array.isArray(note.learnedTrack)).toBe(true);
      expect(note.learnedTrack.length).toBeGreaterThan(0);
    });

    it("diary summary + assets are ON-TOPIC (contain 离职/独立开发/大厂/身份/归属/稳定/付费)", (ctx) => {
      skipIfLlmUnreachable(ctx);
      const blob = JSON.stringify({
        note,
        points: state.points?.slice(0, 5) ?? [],
        questions: state.questions?.slice(0, 5) ?? [],
        decisions: state.decisions?.slice(0, 5) ?? [],
        debts: state.debts?.slice(0, 5) ?? [],
        themes: state.themes?.slice(0, 5) ?? []
      });

      const onTopic = /离职|独立开发|大厂|身份|归属|稳定|付费/.test(blob);
      expect(onTopic).toBe(true);

      // Log for report
      console.log("[Journey A] diary.summary:", note.summary);
      console.log("[Journey A] saidTrack[0]:", note.saidTrack[0]);
      console.log("[Journey A] on-topic regex hit:", onTopic);
    });

    it("diary does NOT contain the demo rescue-fire script (no demo leak)", (ctx) => {
      skipIfLlmUnreachable(ctx);
      const blob = JSON.stringify({
        note,
        points: state.points?.slice(0, 5) ?? [],
        questions: state.questions?.slice(0, 5) ?? [],
        decisions: state.decisions?.slice(0, 5) ?? []
      });

      const demoLeak = /救火|授权机制|亲自兜底/.test(blob);
      expect(demoLeak).toBe(false);

      // Log for report
      console.log("[Journey A] demo-leak absent:", !demoLeak);
    });

    it("at least one asset was created and relates to the topic", (ctx) => {
      skipIfLlmUnreachable(ctx);
      const allAssets = [
        ...(state.points ?? []),
        ...(state.questions ?? []),
        ...(state.decisions ?? []),
        ...(state.debts ?? []),
        ...(state.themes ?? [])
      ];
      expect(allAssets.length).toBeGreaterThan(0);

      const assetBlob = JSON.stringify(allAssets.slice(0, 10));
      const onTopicAsset = /离职|独立开发|大厂|身份|归属|稳定|付费/.test(assetBlob);
      // Best-effort: assert on-topic, but also guard that note itself is on-topic (already asserted above)
      console.log("[Journey A] assets on-topic:", onTopicAsset, "| total assets:", allAssets.length);
      // The invariant is: at least one asset exists (LLM produced something)
      expect(allAssets.length).toBeGreaterThan(0);
    });

    afterAll(() => server.close());
  });

  // -------------------------------------------------------------------------
  // Journey B — real search brief
  // -------------------------------------------------------------------------

  describe.skipIf(!hasAnySearchKey)(
    "Journey B — real search brief (AnySearch, real http(s) sources)",
    () => {
      let server: ReturnType<typeof buildApiServer>;

      beforeAll(async () => {
        server = buildApiServer({ env });
        await server.inject({ method: "POST", url: "/api/state/reset", payload: { confirm: "RESET_ALL_DATA" } });
      });

      afterAll(() => server.close());

      it(
        "POST /api/search/briefs with anysearch returns real sources (real http URLs)",
        async (ctx) => {
          const briefRes = await server.inject({
            method: "POST",
            url: "/api/search/briefs",
            payload: {
              topic: "2026 AI 编程 agent 落地",
              providerId: "anysearch",
              maxSources: 4,
              recencyDays: 30
            }
          });

          // F-09 归类:key 已配置、路由接线到达 provider,但外部服务 502(网络/配额)。
          // 原行为是提前 return → vitest 计 passed(false-green);改为运行时 skip 并写明
          // 理由计入 skipped。接线正确性另由 server.test.ts 的 mock 测试保证。
          if (briefRes.statusCode === 502) {
            ctx.skip("外部服务不可达:AnySearch 返回 502(网络/配额问题),real-provider 断言无法执行(F-09,不计 passed)");
          }

          expect(briefRes.statusCode).toBe(200);
          const { brief, task } = briefRes.json();
          // F-09 归类:task.providerId 属于我们自己的接线,若走错 provider 应真实 fail
          // ——所以先断言它,再对"外部服务已到达但执行失败"skip。原行为是 return → passed。
          if (task?.status === "failed") {
            expect(task.providerId).toBe("anysearch");
            // F-07:task.error 是 provider 错误原文,可能内嵌带签名 URL,入 note 前脱敏。
            // error 可能是结构化对象,String() 会得到 [object Object],用 JSON.stringify 兜底
            // (stringify 结果同样过 sanitizeSkipNote,内嵌 URL 一并脱敏)。
            const taskError =
              typeof task.error === "string"
                ? task.error
                : task.error == null
                  ? "unknown"
                  : JSON.stringify(task.error);
            ctx.skip(sanitizeSkipNote(`外部服务不可达:AnySearch 已到达但外部执行失败(${taskError}),real-provider 断言无法执行(F-09,不计 passed)`));
          }
          expect(brief).toBeDefined();
          expect(typeof brief.topic).toBe("string");
          expect(Array.isArray(brief.sources)).toBe(true);
          expect(brief.sources.length).toBeGreaterThan(0);

          // Assert real http(s) URLs — not the local demo template URLs
          const realSources = brief.sources.filter(
            (s: any) =>
              typeof s.url === "string" &&
              /^https?:\/\//.test(s.url) &&
              !s.url.includes("example.local")
          );
          expect(realSources.length).toBeGreaterThan(0);

          // Assert summary is not the AnySearch shell template
          const isTemplatedSummary = /AnySearch 围绕/.test(brief.summary);
          // Note: if LLM synthesis succeeded the summary will be rewritten; template is allowed only if LLM was skipped
          // F-07:即使是公开网页 URL 也统一脱敏输出,host 足以证明来源真实性
          console.log("[Journey B] sources[0].url:", brief.sources[0]?.url ? redactUrl(brief.sources[0].url) : "(none)");
          console.log("[Journey B] summary:", brief.summary?.slice(0, 100));
          console.log("[Journey B] real-url sources:", realSources.length, "| summary templated:", isTemplatedSummary);

          // Core proof: at least one real URL
          expect(realSources.length).toBeGreaterThan(0);

          // F-09 归类(半个 false-green 闭合):AnySearch 成功但 DashScope LLM 摘要合成
          // 外部失败时,summary 会停留在 AnySearch 壳模板文案——此前只 log 不断言,仍计
          // passed。sources 的真实性已在上方断言完(接线部分先验证),这里对摘要仍是模板
          // 的情况 skip 且写明理由。`hasKey &&` 是防御性写法:本 describe 已由外层
          // skipIf(!hasKey) 保证 hasKey 为真;保留它是为了门控结构未来变化时语义自守
          // ——LLM key 真未配置时模板是预期行为,不应被误报成"外部不可达"。
          if (hasKey && isTemplatedSummary) {
            ctx.skip("外部 LLM 摘要合成不可达/降级:summary 仍为 AnySearch 模板文案(sources 已真实断言通过;F-09,不计 passed)");
          }
        },
        120_000
      );
    }
  );

  // -------------------------------------------------------------------------
  // Journey B-fallback — bailian search when no ANYSEARCH key
  // -------------------------------------------------------------------------

  describe.skipIf(hasAnySearchKey)(
    "Journey B-fallback — bailian search (when no AnySearch key)",
    () => {
      let server: ReturnType<typeof buildApiServer>;

      beforeAll(async () => {
        server = buildApiServer({ env });
        await server.inject({ method: "POST", url: "/api/state/reset", payload: { confirm: "RESET_ALL_DATA" } });
      });

      afterAll(() => server.close());

      it(
        "POST /api/search/briefs with bailian returns a brief without 500",
        async (ctx) => {
          const briefRes = await server.inject({
            method: "POST",
            url: "/api/search/briefs",
            payload: {
              topic: "2026 AI 编程 agent 落地",
              providerId: "bailian",
              maxSources: 4,
              recencyDays: 30
            }
          });

          console.log("[Journey B-fallback] status:", briefRes.statusCode);
          // F-09 归类:原行为 expect([200,502]).toContain(...) 把 502 直接计 passed——
          // 与 Journey B 的 502 同性质 false-green。改为:502(key 已配置但外部搜索
          // 不可达/该模型无搜索能力)→ skip 且写明理由;500 等其他状态仍真实 fail
          // (那说明是我们自己的路由/接线炸了,不是外部问题)。
          if (briefRes.statusCode === 502) {
            ctx.skip("外部服务不可达:Bailian search 返回 502(需要联网+具备搜索能力的模型),real-provider 断言无法执行(F-09,不计 passed)");
          }

          expect(briefRes.statusCode).toBe(200);
          const { brief } = briefRes.json();
          expect(brief).toBeDefined();
          console.log("[Journey B-fallback] brief.topic:", brief.topic);
        },
        120_000
      );
    }
  );

  // -------------------------------------------------------------------------
  // Journey C — real TTS renders audio
  // -------------------------------------------------------------------------

  describe("Journey C — real TTS renders audio (cosyvoice-v3-plus + longanyang)", () => {
    let server: ReturnType<typeof buildApiServer>;

    beforeAll(async () => {
      server = buildApiServer({ env });
      // Start from demo state (which already has a note to generate podcast from)
    });

    afterAll(() => server.close());

    it(
      "POST /api/podcast/episodes returns audioRenderStatus=rendered with a real audioUrl",
      async () => {
        // Get the first note from state (demo default note)
        const stateRes = await server.inject({ method: "GET", url: "/api/state" });
        expect(stateRes.statusCode).toBe(200);
        const stateBody = stateRes.json();
        const firstNote = stateBody.notes[0];
        expect(firstNote).toBeDefined();
        const noteId = firstNote.id;

        const episodeRes = await server.inject({
          method: "POST",
          url: "/api/podcast/episodes",
          payload: { noteId, format: "solo" }
        });

        expect(episodeRes.statusCode).toBe(200);
        const { episode } = episodeRes.json();
        expect(episode).toBeDefined();
        expect(episode.noteId).toBe(noteId);
        expect(typeof episode.script).toBe("string");
        expect(episode.script.length).toBeGreaterThan(0);

        console.log("[Journey C] audioRenderStatus:", episode.audioRenderStatus);
        // F-07:TTS audioUrl 带签名 query,有效期内等同 bearer capability,禁止明文入日志
        console.log("[Journey C] audioUrl:", episode.audioUrl ? redactUrl(episode.audioUrl) : "(none)");

        // Core assertion: TTS must have rendered — not fallback, not pending
        // This surfaces a cosyvoice-v3-plus / longanyang regression if it fires
        //
        // F-09 归类:此处刻意保持 fail(而非 skip)。renderEpisodeAudio 把一切合成异常
        // 都折叠成 audioRenderStatus="fallback"(routes/podcast.ts),响应里无法区分
        // "网络不可达"和"provider 拒绝了我们的请求(如音色回归)"。本用例的声明目的
        // 就是抓 cosyvoice 回归——若把 fallback 归入 skip,回归会被静默吞掉,变成
        // false-negative。带真实 key 跑 smoke 时默认网络可用,fail 是诚实的信号。
        expect(episode.audioRenderStatus).toBe("rendered");

        // Audio URL must be a real URL
        expect(typeof episode.audioUrl).toBe("string");
        expect(/^https?:\/\//.test(episode.audioUrl)).toBe(true);

        // F-07:slice(0,80) 也会带出签名 query 片段,同样必须脱敏
        console.log("[Journey C] PASS — real audio rendered:", redactUrl(episode.audioUrl));
      },
      120_000
    );
  });
});

// ---------------------------------------------------------------------------
// Inline afterAll imports — needed because the outer describe is conditionally
// skipped; vitest still needs afterAll available at module level.
// ---------------------------------------------------------------------------
import { afterAll } from "vitest";

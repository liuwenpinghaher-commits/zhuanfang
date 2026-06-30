import { test, expect, type Page } from "@playwright/test";
import type { ProductState, SearchBrief, SourceHighlight } from "../../src/domain/types";

/**
 * 真实业务 E2E（不 mock）·外部调研 / 搜索模块
 *
 * 前端 baseURL http://127.0.0.1:3220（playwright.config）直连真后端 http://127.0.0.1:3210（真 key）。
 * 整个文件无 page.route —— UI 操作经 productApiClient 打到真 3210，关键正确性断言走后端真实副作用 GET /api/state。
 *
 * 为什么改成「种子注入」而非「UI 创建简报」：
 *   旧版用 UI 点「生成简报」来制造被测简报。但创建简报后端会走 enrichBriefInput（LLM 联网合成 insights，
 *   实测单条 ~16s）+ 联网搜索，本质慢；E2E 频繁跑会撑爆 timeout，且 in-flight 堆积拖垮共享后端
 *   （reset/turn 卡满 30s，整套 6–8 分钟）。改为 PUT /api/state 注入 searchBriefs 种子（确定性、秒级），
 *   只测**不联网的确定性业务流**（持续追踪开关 / 带入专访绑定）。创建简报的联网路径单列一个 test.skip
 *   说明本质慢，作为 provider+LLM 集成测试手动验证，不进常规套件。
 *
 * 种子为何是「真后端状态」而非 mock：
 *   PUT /api/state 经 normalizeProductState → normalizeSearchBriefs（src/domain/storage.ts:245）。
 *   normalizeSearchBriefs 对每条简报 `...brief` 整体保留，仅对 facts/controversies/opposingViews/
 *   interviewAngles 四个列表字段做空值回填——所以注入的 id/topic/provider/status/tracked/sources/createdAt
 *   等字段原样落库，经 GET 返回，是真实后端持久化状态，不是网络拦截。本文件在 seedState 内用 expect 实测
 *   注入后 GET /api/state 的 searchBriefs 真包含种子（见 seedState）。
 *   注：systemConfig.search.activeProvider 受 normalizeProductState 保护，PUT 改不动——本文件不碰它，
 *   种子简报的 provider 字段单独用合法值 "local-demo"，与 activeProvider 无关。
 *
 * 隔离 + 自动盯梢陷阱：
 *   每个 test 先 POST /api/state/reset 回到 createInitialProductState。注意前端「打开即更新」会在首次进入
 *   外部调研视图时自动触发一次 POST /api/research/auto-run（App.tsx:278，每会话一次、静默、失败不打扰），
 *   且 buildProactiveSearchAgenda 即使主题/知识债为空也恒返回 4 条 agenda → auto-run 恒会 append 若干降级
 *   占位简报。因此：
 *     - 用例 1（空状态）在「进入视图之前」就断言后端 searchBriefs 为空（确定性，绕开 auto-run 污染），
 *       进入后只断言空状态 CTA 的首帧渲染。
 *     - 用例 2/3 注入的种子用**唯一 topic**，断言/定位一律按该 topic 过滤（locator.filter({hasText})
 *       + briefs().find(byId)），auto-run append 的其它行不干扰；且 auto-run 是 append 不删除，种子必存活。
 */

const API = "http://127.0.0.1:3210";

/* ---------- 类型化助手（GET /api/state 读真后端） ---------- */

interface SessionCard {
  searchBriefId?: string;
}
interface SessionLike {
  id: string;
  status: string;
  card?: SessionCard;
}

async function getState(page: Page): Promise<ProductState & { revision?: number }> {
  return (await page.request.get(`${API}/api/state`)).json();
}

async function briefs(page: Page): Promise<SearchBrief[]> {
  return (await getState(page)).searchBriefs ?? [];
}

async function sessions(page: Page): Promise<SessionLike[]> {
  return ((await getState(page)) as { sessions?: SessionLike[] }).sessions ?? [];
}

/** 合法 SourceHighlight 种子（usage 取类型枚举内合法值）。 */
function makeSource(id: string): SourceHighlight {
  return {
    id,
    title: `来源 ${id}`,
    url: `https://example.com/${id}`,
    publisher: "示例媒体",
    publishedAt: new Date().toISOString(),
    snippet: "用于确定性 E2E 的占位来源摘要。",
    relevanceScore: 0.8,
    usage: "interview-context"
  };
}

/**
 * 构造一条形状完整、合法的 SearchBrief 种子（按 src/domain/types.ts:1004 的 SearchBrief 必填字段逐一给值）。
 * provider 用 "local-demo"（SearchProviderId 合法值），与受保护的 systemConfig.activeProvider 无关。
 */
function makeBrief(id: string, topic: string, overrides: Partial<SearchBrief> = {}): SearchBrief {
  const now = new Date().toISOString();
  return {
    id,
    topic,
    provider: "local-demo",
    status: "ready",
    summary: `关于「${topic}」的确定性测试简报。`,
    facts: ["事实占位 A", "事实占位 B"],
    controversies: ["争议占位 A"],
    opposingViews: ["反方占位 A"],
    interviewAngles: ["专访角度占位 A"],
    discussionTopics: ["讨论主题占位 A", "讨论主题占位 B"],
    sourceAngles: ["来源角度占位 A"],
    sources: [makeSource(`${id}-src-1`), makeSource(`${id}-src-2`)],
    sourceTrace: [],
    appliedToSessionIds: [],
    createdAt: now,
    tracked: false,
    ...overrides
  };
}

/**
 * 把若干 searchBriefs 注入真后端 state（真实持久化，不是 mock），并**当场验证种子生效**。
 * 必须先读当前 revision —— PUT /api/state 用乐观锁，revision 不等会 409（state.ts:52）。
 */
async function seedState(page: Page, seedBriefs: SearchBrief[]): Promise<void> {
  const cur = await getState(page);
  // 用 reset 后的 cur(createEmptyProductState:空 themes/debts/decisions/memory)作基底,而非
  // createInitialProductState(含 demo 主题/知识债)。否则注入 brief 后 state 仍带 demo 资产 →
  // buildProactiveSearchAgenda 产非空议程 → 前端"打开即更新"自动 auto-run 联网 demo 主题、拖垮后端
  // (reset 卡满)。注入 brief 本身不算"可调研资产",干净状态下议程应为空、不该自动联网。
  const next: ProductState & { revision: number } = {
    ...(cur as ProductState),
    searchBriefs: seedBriefs,
    revision: cur.revision ?? 0
  };
  const res = await page.request.put(`${API}/api/state`, { data: next });
  expect(res.ok(), `PUT /api/state 注入 searchBriefs 种子应成功（乐观锁 revision=${cur.revision}）`).toBeTruthy();

  // 实测：注入的每条种子（按 id）确实落库并经 GET 返回 —— 证明 normalizeSearchBriefs 未剥离种子字段。
  const persisted = await briefs(page);
  for (const seed of seedBriefs) {
    const got = persisted.find((b) => b.id === seed.id);
    expect(got, `注入的简报 id=${seed.id} 应在 GET /api/state.searchBriefs 中`).toBeDefined();
    expect(got?.topic, "注入简报的 topic 应原样保留").toBe(seed.topic);
    expect(got?.provider, "注入简报的 provider 应原样保留").toBe(seed.provider);
    expect(Boolean(got?.tracked), "注入简报的 tracked 应原样保留").toBe(Boolean(seed.tracked));
  }
}

/** reset → 可选注入种子 → 打开应用并加载真后端 state（清 localStorage 防离线 demo 分叉）。 */
async function bootApp(page: Page, seedBriefs?: SearchBrief[]): Promise<void> {
  await page.request.post(`${API}/api/state/reset`);
  if (seedBriefs) {
    await seedState(page, seedBriefs);
  }
  await page.goto("/");
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
  await expect(page.getByRole("button", { name: "今日访谈台" })).toBeVisible({ timeout: 15_000 });
}

/** 进入「外部调研」视图，等视图标题出现。 */
async function openResearchView(page: Page): Promise<void> {
  await page.getByRole("button", { name: "外部调研" }).click();
  await expect(page.getByText("主动搜集热点、素材和可讨论主题")).toBeVisible({ timeout: 10_000 });
}

/* ====================================================================== */

test.describe("真实业务·外部调研/搜索（UI→真后端 3210，无 mock）", () => {
  // ----------------------------------------------------------------
  // 用例 1：空状态 —— reset 后后端 searchBriefs 为空 + 视图内显示「还没有搜索简报…」CTA。
  //
  // 注意「打开即更新」：进入外部调研视图会触发一次 auto-run（append 降级占位简报）。所以后端为空的
  // 断言放在「进入视图之前」（reset 直后，确定性）；进入视图后只断言空状态 CTA 的首帧渲染（auto-run
  // 往返之前空状态 DOM 已先渲染）。
  // ----------------------------------------------------------------
  test("空状态：reset 后后端 searchBriefs 空 + 视图显示自动盯梢 CTA", async ({ page }) => {
    test.setTimeout(60_000);
    await bootApp(page); // 无种子 —— 干净起点

    // 后端真实副作用：reset 后 searchBriefs 为空（createInitialProductState，先于进入视图断言）。
    expect((await briefs(page)).length, "reset 后后端 searchBriefs 应为空").toBe(0);

    await openResearchView(page);

    // 空状态提示文案 + 空状态内的「自动盯梢」CTA 按钮（首帧渲染，先于 auto-run 往返）。
    await expect(
      page.getByText("还没有搜索简报。点「自动盯梢」，从你的主题和知识债自动采集情报。")
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "自动盯梢" }).first()).toBeVisible();
  });

  // ----------------------------------------------------------------
  // 用例 2：持续追踪开关 —— 注入一条 brief → 进外部调研 → UI 标记/取消「持续追踪」
  //         → 断言后端 brief.tracked 真实翻转（走 POST /api/search/briefs/:id/track，不联网）。
  // ----------------------------------------------------------------
  test("持续追踪开关：标记→取消，后端 brief.tracked 真实翻转（不联网）", async ({ page }) => {
    test.setTimeout(60_000);
    const briefId = `brief-track-${Date.now()}`;
    const topic = `大模型推理成本-${Date.now()}`; // 唯一 topic：与 auto-run append 行不冲突
    await bootApp(page, [makeBrief(briefId, topic, { tracked: false })]);
    await openResearchView(page);

    // 用唯一 topic 精确定位种子卡片（auto-run 的占位行不会命中此 topic）。
    const card = page.locator("article.record-row").filter({ hasText: topic });
    await expect(card).toBeVisible({ timeout: 10_000 });

    // 起点：种子未追踪 → 按钮文案「持续追踪」。
    expect((await briefs(page)).find((b) => b.id === briefId)?.tracked ?? false, "种子初始未追踪").toBe(false);
    await expect(card.getByRole("button", { name: "持续追踪", exact: true })).toBeVisible();

    // —— 标记追踪 ——
    await card.getByRole("button", { name: "持续追踪", exact: true }).click();
    await expect(page.getByText("已标记为持续追踪", { exact: true })).toBeVisible({ timeout: 8000 });
    // 后端真实副作用：该 brief.tracked === true（按 id 断言，不受其它行影响）。
    await expect
      .poll(async () => (await briefs(page)).find((b) => b.id === briefId)?.tracked === true, {
        timeout: 15_000,
        intervals: [500]
      })
      .toBeTruthy();
    await expect(card.getByRole("button", { name: "持续追踪中", exact: true })).toBeVisible();

    // —— 取消追踪 ——
    await card.getByRole("button", { name: "持续追踪中", exact: true }).click();
    await expect(page.getByText("已取消持续追踪", { exact: true })).toBeVisible({ timeout: 8000 });
    // 后端真实副作用：该 brief.tracked === false。
    await expect
      .poll(async () => (await briefs(page)).find((b) => b.id === briefId)?.tracked === false, {
        timeout: 15_000,
        intervals: [500]
      })
      .toBeTruthy();
    await expect(card.getByRole("button", { name: "持续追踪", exact: true })).toBeVisible();
  });

  // ----------------------------------------------------------------
  // 用例 3：带入专访 —— 注入一条 brief → UI「带入专访」
  //         → 断言后端某 session.card.searchBriefId 绑定该 brief（创建 session，不联网搜索）。
  //
  // 链路：onUseBrief → startFromBrief → launchInterview("learning", briefId)
  //   → POST /api/interview-sessions { searchBriefId } → createSessionDraft 把 searchBriefId 写进
  //     session.card.searchBriefId（interview-sessions.ts:130）→ replaceState 落库。整段无联网搜索。
  // ----------------------------------------------------------------
  test("带入专访：UI 带入 → 后端 session.card.searchBriefId 绑定该简报（不联网）", async ({ page }) => {
    test.setTimeout(60_000);
    const briefId = `brief-use-${Date.now()}`;
    const topic = `AI Agent 落地案例-${Date.now()}`;
    await bootApp(page, [makeBrief(briefId, topic)]);
    await openResearchView(page);

    const card = page.locator("article.record-row").filter({ hasText: topic });
    await expect(card).toBeVisible({ timeout: 10_000 });

    // 起点：尚无 session 绑定该 brief。
    expect(
      (await sessions(page)).some((s) => s.card?.searchBriefId === briefId),
      "带入前不应存在绑定该 brief 的 session"
    ).toBe(false);

    // 「带入专访」入口可见 → 点击（触发 launchInterview("learning", briefId)）。
    const useBtn = card.getByRole("button", { name: "带入专访" });
    await expect(useBtn).toBeVisible();
    await useBtn.click();

    // 进入 interview 区域：加载中 eyebrow「专访启动」，加载完成「实时专访」，二者其一可见。
    await expect(
      page.getByText("专访启动").or(page.getByText("实时专访"))
    ).toBeVisible({ timeout: 30_000 });

    // 后端真实副作用：存在一个 session 的 card.searchBriefId 指向这条简报。
    await expect
      .poll(async () => (await sessions(page)).some((s) => s.card?.searchBriefId === briefId), {
        timeout: 30_000,
        intervals: [1000]
      })
      .toBeTruthy();
  });

  // ----------------------------------------------------------------
  // 用例 4：创建简报（联网 LLM enrich）—— SKIP。
  //
  // UI 点「生成简报」会走 POST /api/search/briefs → enrichBriefInput（LLM 联网合成 insights，实测单条
  // ~16s）+ provider 联网搜索，本质慢。常规套件频繁跑会撑爆 timeout 且 in-flight 堆积拖垮共享后端。
  // 这是 provider + LLM 的集成测试，单独手动验证（确认 16s 内返回、provider 字段正确），不进常规套件。
  // 创建/落库的「不联网确定性业务流」已由用例 2/3（种子注入）覆盖。
  // ----------------------------------------------------------------
  test.skip("创建简报（联网 LLM enrich）：UI 生成 → 后端 searchBriefs +1（慢·手动验证）", async ({ page }) => {
    test.setTimeout(120_000); // LLM enrich ~16s/条 + 联网搜索，常规套件不跑
    await bootApp(page);
    await openResearchView(page);

    const before = (await briefs(page)).length;
    const topic = "AI 产品商业化路径";
    await page.getByLabel("追踪主题").fill(topic);
    await page.locator("#search-provider").selectOption("local-demo");
    await page.getByRole("button", { name: "生成简报" }).click();

    await expect(page.getByText(/搜索简报已生成|搜索已降级完成/)).toBeVisible({ timeout: 90_000 });
    await expect
      .poll(async () => (await briefs(page)).some((b) => b.topic === topic), {
        timeout: 30_000,
        intervals: [1000]
      })
      .toBeTruthy();
    expect((await briefs(page)).length).toBe(before + 1);
  });

  // ----------------------------------------------------------------
  // 用例 5：自动盯梢（auto-run）—— SKIP（保持）。
  //
  // auto-run 固定用 systemConfig.activeProvider=bailian（受保护不可切），真联网每条可达 30s、串行多条
  // 堆积拖垮后端，E2E 不可测。并发保护（autoRunInFlight 标志）逻辑已由单元测试 apps/api/src/routes/
  // search.test.ts 覆盖。
  // ----------------------------------------------------------------
  test.skip("自动盯梢：返回 summary 不卡 + 并发第二次被跳过（联网·单测已覆盖）", async ({ page }) => {
    test.setTimeout(120_000);
    await bootApp(page);
    await openResearchView(page);

    const single = await (await page.request.post(`${API}/api/research/auto-run`)).json();
    expect(typeof single.summary?.generated).toBe("number");
    expect(typeof single.summary?.refreshed).toBe("number");
    expect(typeof single.summary?.dedupedSources).toBe("number");

    // 并发保护：两个请求同时在途，其一必命中 in-flight 短路（note=已有自动调研在进行中）。
    const [a, b] = await Promise.all([
      page.request.post(`${API}/api/research/auto-run`).then((r) => r.json()),
      page.request.post(`${API}/api/research/auto-run`).then((r) => r.json())
    ]);
    const summaries = [a.summary, b.summary];
    const skipped = summaries.find(
      (s) => typeof s?.note === "string" && s.note.includes("已有自动调研在进行中")
    );
    expect(skipped).toBeDefined();
    expect(skipped!.generated).toBe(0);
    expect(skipped!.refreshed).toBe(0);
  });
});

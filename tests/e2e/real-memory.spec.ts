import { test, expect, type Page } from "@playwright/test";
import { createInitialProductState } from "../../src/domain/engine";
import type { MemoryCandidate, MemoryRecord, ProductState } from "../../src/domain/types";
import { resetServerState } from "./helpers";

/**
 * 真实业务 E2E（不 mock）·记忆治理模块
 *
 * 前端 baseURL http://127.0.0.1:3220（playwright.config）直连真后端 http://127.0.0.1:3210（真 key）。
 * 整个文件无 page.route —— UI 操作经 productApiClient 打到真 3210，断言走后端真实副作用 GET /api/state。
 *
 * 隔离：每个 test 先 POST /api/state/reset（state 已在 reset 实现里有备份/可重置）回到 createInitialProductState
 *       （memoryCandidates / memoryRecords 均为空）。
 *
 * 候选来源（两条路径，都不是 mock）：
 *   A. 确定性快路：reset 后用 PUT /api/state 向真后端注入一条 pending 候选。
 *      normalizeProductState 会保留全部 pending 候选（src/domain/storage.ts），后端持久化并经 GET 返回，
 *      所以这是真实后端状态，不是拦截。绝大多数用例走这条，快且稳。
 *   B. 真实慢路：跑一场真访谈到 finalize，由真 LLM 抽取 memoryCandidates。单独一个 test 覆盖，setTimeout 拉满。
 *
 * 断言语义（已对照 src/domain/memory.ts 的纯函数后置条件，避免错误断言）：
 *   - approve：候选 status pending→approved（仍留在数组里，不是删除）；干净起点下会新增一条
 *     status==="confirmed" 的 MemoryRecord（reset 后无既有记忆，故不会走 dedup 合并分支）。
 *     => 断言 confirmed 记忆 0→≥1，且 pending 候选数下降。
 *   - reject：候选 status pending→rejected（仍留在数组里，NOT removed）。
 *     => 断言该候选 status==="rejected"，pending 数下降，但 memoryCandidates.length 不变。
 *   - 修正：候选 text 原地更新，status 仍 pending。 => 断言后端该候选 .text === 新文本。
 *   - consolidate：POST /api/memory/consolidate 返回 { state, summary:{deprecated} }；无近重复时 deprecated=0、
 *     记忆不变。 => 断言不崩（state 仍在、confirmed 数不丢），合并按钮仅在 confirmed≥2 时渲染。
 */

const API = "http://127.0.0.1:3210";

/* ---------- 真后端状态读写助手 ---------- */

async function getState(page: Page): Promise<ProductState & { revision?: number }> {
  return (await page.request.get(`${API}/api/state`)).json();
}

/** 真后端待审（pending）候选 —— UI 只渲染 pending，断言也以 pending 为准。 */
async function pendingCandidates(page: Page): Promise<MemoryCandidate[]> {
  const st = await getState(page);
  return (st.memoryCandidates ?? []).filter((c) => c.status === "pending");
}

/** 真后端已确认（confirmed）长期记忆。 */
async function confirmedRecords(page: Page): Promise<MemoryRecord[]> {
  const st = await getState(page);
  return (st.memoryRecords ?? []).filter((r) => r.status === "confirmed");
}

function makeCandidate(id: string, text: string): MemoryCandidate {
  return {
    id,
    text,
    status: "pending",
    sourceType: "interview_session",
    sourceId: `note-${id}`,
    evidenceQuote: "我不想每次都替团队兜底",
    reason: "连续三次提到授权边界，评分 0.85",
    sensitivity: "normal",
    reviewScore: 0.85,
    reviewSignals: ["高频词汇", "情感强度"],
    createdAt: new Date().toISOString()
  };
}

function confirmedRecord(id: string, text: string): MemoryRecord {
  const now = new Date().toISOString();
  return {
    id,
    text,
    status: "confirmed",
    sourceType: "interview_session",
    sourceId: `note-${id}`,
    evidenceQuote: "",
    sensitivity: "normal",
    createdAt: now,
    updatedAt: now
  };
}

/**
 * 把若干 candidates / records 注入真后端 state（真实持久化，不是 mock）。
 * 必须先读当前 revision —— PUT /api/state 用乐观锁，revision 不等会 409。
 */
async function seedState(
  page: Page,
  seed: { candidates?: MemoryCandidate[]; records?: MemoryRecord[] }
): Promise<void> {
  const cur = await getState(page);
  const next: ProductState & { revision: number } = {
    ...createInitialProductState(),
    memoryCandidates: seed.candidates ?? [],
    memoryRecords: seed.records ?? [],
    revision: cur.revision ?? 0
  };
  const res = await page.request.put(`${API}/api/state`, { data: next });
  expect(res.ok(), `PUT /api/state 注入种子应成功（乐观锁 revision=${cur.revision}）`).toBeTruthy();
}

/** reset → 可选注入 → 打开应用并加载真后端 state（清 localStorage 防离线 demo 分叉）。 */
async function bootMemoryView(
  page: Page,
  seed?: { candidates?: MemoryCandidate[]; records?: MemoryRecord[] }
): Promise<void> {
  await resetServerState(page, API); // F-08:reset 需 confirm,统一走 helper
  if (seed) {
    await seedState(page, seed);
  }
  await page.goto("/");
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
  await expect(page.getByRole("button", { name: "今日访谈台" })).toBeVisible({ timeout: 15_000 });

  // 进入「记忆」视图（左侧导航按钮 → 视图标题）。
  await page.getByRole("button", { name: "记忆" }).click();
  await expect(page.getByText("导入资料，审核长期记忆")).toBeVisible({ timeout: 10_000 });
}

/* ---------- 文本访谈助手（仅 finalize 慢路 test 用） ---------- */

interface Turn {
  role: string;
  content: string;
}
interface Session {
  id: string;
  status: string;
  turns?: Turn[];
}

async function activeSession(page: Page): Promise<Session | undefined> {
  const st = await getState(page);
  return ((st as { sessions?: Session[] }).sessions ?? []).find((s) => s.status === "active");
}

async function submitTurn(page: Page, text: string, expectUserCount: number): Promise<void> {
  await page.getByLabel("你的回答").fill(text);
  await page.getByRole("button", { name: "提交表达" }).click();
  await expect
    .poll(async () => ((await activeSession(page))?.turns ?? []).filter((t) => t.role === "user").length, {
      timeout: 45_000,
      intervals: [1500]
    })
    .toBe(expectUserCount);
}

/* ====================================================================== */

test.describe("真实业务·记忆治理（UI→真后端 3210，无 mock）", () => {
  test("进入记忆视图：reset 后空状态提示（待审 0 / 已确认 0）", async ({ page }) => {
    test.setTimeout(60_000);
    await bootMemoryView(page); // 无种子 —— 干净起点

    // 待审候选区：标题计数为 0 + 空状态文案（MemoryGovernanceView pending 分支）。
    await expect(page.getByText(/待审候选记忆（0）/)).toBeVisible();
    await expect(
      page.getByText("暂无待审候选。导入资料或完成一次专访后会产生候选记忆。")
    ).toBeVisible();

    // 已确认长期记忆区：同样空。
    await expect(page.getByText(/已确认的长期记忆（0）/)).toBeVisible();
    await expect(
      page.getByText("还没有确认的长期记忆。审批候选记忆后，它们会出现在这里。")
    ).toBeVisible();

    // 后端真实副作用：确实零候选零记忆。
    const st = await getState(page);
    expect((st.memoryCandidates ?? []).filter((c) => c.status === "pending").length).toBe(0);
    expect((st.memoryRecords ?? []).filter((r) => r.status === "confirmed").length).toBe(0);
  });

  test("approve 候选 → 后端候选转正式记忆（confirmed 0→1，pending 下降）", async ({ page }) => {
    test.setTimeout(60_000);
    const candId = `cand-approve-${Date.now()}`;
    const candText = "用户在授权边界上反复摇摆，倾向于把难题转嫁给团队。";
    await bootMemoryView(page, { candidates: [makeCandidate(candId, candText)] });

    // 起点核对：1 条 pending，0 条 confirmed。
    expect((await pendingCandidates(page)).length).toBe(1);
    expect((await confirmedRecords(page)).length).toBe(0);

    // 候选卡片可见 → 点「确认记住」（approve，无二次确认弹窗）。
    const card = page.locator("article.record-row").filter({ hasText: candText });
    await expect(card).toBeVisible({ timeout: 8000 });
    await card.getByRole("button", { name: "确认记住" }).click();

    // 后端真实副作用：新增一条 confirmed 长期记忆。
    await expect
      .poll(async () => (await confirmedRecords(page)).length, { timeout: 20_000, intervals: [800] })
      .toBe(1);

    // 候选已离开 pending（status→approved，仍在数组内，但不再待审）。
    await expect
      .poll(async () => (await pendingCandidates(page)).length, { timeout: 10_000, intervals: [500] })
      .toBe(0);

    // 转正的记忆文本就是候选文本，且 sourceCandidateId 指回原候选（approveMemoryCandidate 写入）。
    const confirmed = await confirmedRecords(page);
    expect(confirmed[0]?.text).toBe(candText);
    expect(confirmed[0]?.sourceCandidateId).toBe(candId);

    // UI 同步：已确认计数变为 1。
    await expect(page.getByText(/已确认的长期记忆（1）/)).toBeVisible({ timeout: 8000 });
  });

  test("reject 候选 → 后端候选被否决（status=rejected，移出待审）", async ({ page }) => {
    test.setTimeout(60_000);
    const candId = `cand-reject-${Date.now()}`;
    const candText = "用户倾向于逃避关键决策，凡事都想等更多信息再说。";
    await bootMemoryView(page, { candidates: [makeCandidate(candId, candText)] });

    expect((await pendingCandidates(page)).length).toBe(1);

    const card = page.locator("article.record-row").filter({ hasText: candText });
    await expect(card).toBeVisible({ timeout: 8000 });
    // 「不要记」= reject（无二次确认弹窗）。
    await card.getByRole("button", { name: "不要记" }).click();

    // 后端真实副作用：该候选移出 pending。
    await expect
      .poll(async () => (await pendingCandidates(page)).length, { timeout: 20_000, intervals: [800] })
      .toBe(0);

    // reject 是原地改 status（不是物理删除）：数组仍含该条，且 status==="rejected"。
    const st = await getState(page);
    const all = st.memoryCandidates ?? [];
    const rejected = all.find((c) => c.id === candId);
    expect(rejected, "被拒候选仍应保留在 memoryCandidates 数组中（仅状态变更）").toBeTruthy();
    expect(rejected?.status).toBe("rejected");

    // 不应误转为长期记忆。
    expect((await confirmedRecords(page)).length).toBe(0);

    // UI 同步：待审计数回到 0 + 空状态。
    await expect(page.getByText(/待审候选记忆（0）/)).toBeVisible({ timeout: 8000 });
  });

  test("内联修正候选文本（修正→textarea→改→保存修正）→ 后端候选文本更新", async ({ page }) => {
    test.setTimeout(60_000);
    const candId = `cand-edit-${Date.now()}`;
    const oldText = "用户对商业化路径没有清晰判断。";
    const newText = "用户认为商业化路径不清晰，但坚持这个方向有独特的认知价值，先做产品再谈变现。";
    await bootMemoryView(page, { candidates: [makeCandidate(candId, oldText)] });

    const card = page.locator("article.record-row").filter({ hasText: oldText });
    await expect(card).toBeVisible({ timeout: 8000 });

    // 进入内联编辑：点「修正」→ 出现 textarea（aria-label=修正候选记忆内容）。
    await card.getByRole("button", { name: "修正" }).click();
    const editor = page.getByLabel("修正候选记忆内容");
    await expect(editor).toBeVisible({ timeout: 5000 });
    await expect(editor).toHaveValue(new RegExp(oldText.slice(0, 8)));

    // 改写后点「保存修正」（onEditCandidate → PATCH /api/memory-candidates/:id）。
    await editor.fill(newText);
    await card.getByRole("button", { name: "保存修正" }).click();

    // 编辑器退出。
    await expect(editor).not.toBeVisible({ timeout: 8000 });

    // 后端真实副作用：该候选 text 已更新为新文本，且仍是 pending（修正不改变审核态）。
    await expect
      .poll(
        async () => {
          const c = (await getState(page)).memoryCandidates?.find((x) => x.id === candId);
          return c?.text ?? "";
        },
        { timeout: 20_000, intervals: [800] }
      )
      .toBe(newText);
    const cand = (await getState(page)).memoryCandidates?.find((x) => x.id === candId);
    expect(cand?.status).toBe("pending");

    // UI 同步：卡片正文显示新文本。
    await expect(page.getByText(newText)).toBeVisible({ timeout: 8000 });
  });

  test("整理记忆（confirmed≥2 才出按钮）→ POST /api/memory/consolidate 真实触发且不崩", async ({ page }) => {
    test.setTimeout(120_000); // consolidate 在配 chat client 时会跑真 LLM 概括；env 无 key 时退化为纯去重。

    // 注入两条 confirmed 长期记忆，使「整理记忆」按钮确定性渲染（仅 confirmed≥2 才出）。
    const records = [
      confirmedRecord(`rec-consolidate-1-${Date.now()}`, "用户在授权边界上反复摇摆。"),
      confirmedRecord(`rec-consolidate-2-${Date.now()}`, "用户倾向于让团队自主决策，但又担心失控。")
    ];
    await bootMemoryView(page, { records });

    // 已确认标题计数为 2，两条记录可见。
    await expect(page.getByText(/已确认的长期记忆（2）/)).toBeVisible({ timeout: 8000 });
    const beforeCount = (await confirmedRecords(page)).length;
    expect(beforeCount).toBe(2);

    // consolidate 前端有 window.confirm 二次确认 —— 自动接受。
    page.on("dialog", (dialog) => dialog.accept());

    const consolidateBtn = page.getByRole("button", { name: "整理记忆" });
    await expect(consolidateBtn).toBeVisible();
    await consolidateBtn.click();

    // 真实触发后端：成功分支会弹「记忆已整理」通知（App.consolidateMemory 成功回调），证明 POST 闭环未崩。
    await expect(page.getByText("记忆已整理")).toBeVisible({ timeout: 60_000 });

    // 后端真实副作用：state 仍健全 —— 这两条文本不构成近重复，不应被误删/误降级，confirmed 数仍为 2。
    const st = await getState(page);
    expect(Array.isArray(st.memoryRecords), "consolidate 后 state.memoryRecords 应仍是数组（后端未崩）").toBeTruthy();
    expect((await confirmedRecords(page)).length).toBe(2);

    // 主导航仍可用（界面未崩）。
    await expect(page.getByRole("button", { name: "今日访谈台" })).toBeVisible();
  });

  /**
   * 慢路·真实候选来源：跑一场真文本访谈 → 结束 finalize → 真 LLM 抽取 memoryCandidates →
   * 进记忆视图 approve 真实候选 → 断言后端转为正式记忆。
   * 这条覆盖「候选确实由真实业务产生（非注入）」并端到端验证审批副作用。真 LLM 慢，超时拉满。
   */
  test("@slow 真访谈 finalize 产真实候选 → 记忆视图 approve → 后端转正式记忆", async ({ page }) => {
    test.setTimeout(300_000);
    await resetServerState(page, API); // F-08:reset 需 confirm,统一走 helper
    await page.goto("/");
    await page.evaluate(() => window.localStorage.clear());
    await page.reload();
    await expect(page.getByRole("button", { name: "今日访谈台" })).toBeVisible({ timeout: 15_000 });

    // 开场 → 真实两轮表达。
    await page.getByRole("button", { name: "今日访谈台" }).click();
    await page.getByRole("button", { name: /一键开始/ }).click();
    await submitTurn(
      page,
      "我在纠结要不要把语音专访产品做成正式认知产品，担心商业化路径不清晰，但又觉得这个方向有独特价值。",
      1
    );
    await expect
      .poll(async () => ((await activeSession(page))?.turns ?? []).filter((t) => t.role === "assistant").length, {
        timeout: 30_000,
        intervals: [1000]
      })
      .toBeGreaterThan(0);
    await submitTurn(page, "具体说，我担心市场太小，投入大量精力却没有足够付费用户，这个风险我评估不清。", 2);

    // 结束 → 真实 finalize（慢，真 LLM 抽资产+候选记忆）。
    await page.getByRole("button", { name: /结束并生成档案/ }).click();
    await expect
      .poll(async () => (await pendingCandidates(page)).length, { timeout: 200_000, intervals: [3000] })
      .toBeGreaterThan(0);

    const seededPending = await pendingCandidates(page);
    const target = seededPending[0];
    const baselineConfirmed = (await confirmedRecords(page)).length;
    console.log(
      `[real-memory@slow] finalize 产候选 ${seededPending.length} 条 | 现有 confirmed ${baselineConfirmed} 条 | 将 approve: "${target.text.slice(0, 30)}…"`
    );

    // 进记忆视图，approve 这条真实候选。
    await page.getByRole("button", { name: "记忆" }).click();
    await expect(page.getByText("导入资料，审核长期记忆")).toBeVisible({ timeout: 10_000 });

    const card = page.locator("article.record-row").filter({ hasText: target.text });
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card.getByRole("button", { name: "确认记住" }).click();

    // 后端真实副作用：confirmed 记忆 +1（或 dedup 合并刷新既有 —— 至少不少于基线，且该候选离开 pending）。
    await expect
      .poll(async () => (await confirmedRecords(page)).length, { timeout: 30_000, intervals: [1000] })
      .toBeGreaterThanOrEqual(baselineConfirmed + 1);
    await expect
      .poll(async () => (await pendingCandidates(page)).some((c) => c.id === target.id), {
        timeout: 15_000,
        intervals: [800]
      })
      .toBe(false);
  });
});

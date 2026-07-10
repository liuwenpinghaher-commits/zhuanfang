import { test, expect, type Page } from "@playwright/test";
import { createInitialProductState } from "../../src/domain/engine";
import { resetServerState } from "./helpers";

/**
 * 真实业务 E2E·认知资产模块(不 mock):前端 127.0.0.1:3220 直连真后端 127.0.0.1:3210。
 *
 * 与 my-assets.spec.ts(mock 8787 的前端单元测)的区别:这里所有断言都校验后端 GET /api/state
 * 的真实副作用(confirmationStatus / status 字段真的变了),而不是只看 UI 文案。
 *
 * 关键事实(读源码确认,2026-06-30):
 *  - POST /api/state/reset → repository.resetState() → createEmptyProductState():
 *    清空 points/questions/decisions/debts/notes 等全部资产数组(保留 profile/systemConfig)。
 *    因此 reset 后是「空状态」,没有任何样本资产 —— 需要数据的用例用 PUT /api/state 注入种子。
 *  - confirm 决策走服务端权威路由 POST /api/assets/decisions/:id/confirm,
 *    把 confirmationStatus 从「待用户确认」→「用户确认」(立即落库)。
 *  - point/question/debt/决策复盘 的状态变更没有专用后端路由(已删):前端用纯 reducer 改本地
 *    ProductState,再经 300ms 去抖 PUT /api/state(带 revision 乐观锁)落库。后端 status 字段随之变。
 *  - 前端挂载时 GET /api/state 采用远端状态并开启持久化(apiPersistenceEnabled),
 *    所以先 PUT 种子、再 page.goto,UI 会加载到种子且本地改动会被 PUT 回后端。
 *  - 导航按钮「我的资产」(ui.ts);资产库 tab 标题 h1「观点、问题、决策和知识债」;
 *    决策确认按钮「确认决策」,确认后显示状态药丸「已用户确认」。
 */

const API = "http://127.0.0.1:3210";

interface AnyState {
  revision?: number;
  decisions?: Array<{ id: string; confirmationStatus?: string; status?: string }>;
  points?: Array<{ id: string; status?: string }>;
  questions?: Array<{ id: string; status?: string }>;
  debts?: Array<{ id: string; status?: string }>;
  notes?: Array<{ id: string }>;
}

async function getState(page: Page): Promise<AnyState> {
  return (await page.request.get(`${API}/api/state`)).json();
}

/**
 * 干净起点。reset 把后端清成空状态(createEmptyProductState),保证每个 test 互不串扰。
 */
async function reset(page: Page): Promise<void> {
  // F-08:reset 契约要求 body confirm="RESET_ALL_DATA"(F-05 防误触),裸 POST 会 422。
  // 统一走 helpers.resetServerState,非 2xx 会抛带响应体的错误。
  await resetServerState(page, API);
}

/**
 * 把一份认知资产种子写进后端(reset 之后调用)。先读当前 revision 满足乐观锁,再 PUT 合并。
 * 注入的资产是「真实业务数据」:UI 直接读后端这份状态来操作,断言再校验后端字段变化。
 *
 * 种子刻意覆盖各资产类型的初始状态:
 *  - decision: confirmationStatus「待用户确认」→ 触发「确认决策」按钮;status「待复盘」。
 *  - point/question/debt: 各自的可流转初始状态。
 *  - note: sessionId 与各资产 sourceSessionId 对齐,使「专访档案」tab 出现一张卡(带「生成播客」)。
 */
async function seedAssets(page: Page): Promise<AnyState> {
  const cur = await getState(page);
  const sid = "session-e2e-assets";
  // 用 createInitialProductState() 作基底(对齐 real-memory/real-search,已验证前端能稳定加载),而非
  // reset 后的 createEmptyProductState —— 后者作基底时前端 reload 加载注入种子会持续重渲染、访谈台 15s 不出现。
  const seeded = {
    ...createInitialProductState(),
    sessions: [
      {
        id: sid,
        title: "授权边界与控制感(E2E 种子)",
        status: "completed",
        mode: "text",
        strength: "standard",
        createdAt: "2026-06-05T09:00:00.000Z",
        updatedAt: "2026-06-05T09:30:00.000Z",
        turns: [],
        // card 必填(InterviewSession.card: InterviewCard):前端 buildPerspectiveCoverage 等同步读
        // session.card.title/suggestedPerspectives,缺它 buildInterviewCard 会崩、整个 app 白屏。
        card: {
          title: "授权边界与控制感",
          whyNow: "连续提到放权焦虑,适合本轮深入。",
          suggestedOpening: "上次你说再这样就变成项目经理了,展开聊聊?",
          historyReferences: ["团队救火", "授权边界"],
          potentialTension: "想放权又怕短期失控。",
          suggestedPerspectives: ["机制视角", "代价视角"],
          likelyOutputs: ["明确授权边界的判断标准"]
        }
      }
    ],
    notes: [
      {
        id: "note-e2e-1",
        sessionId: sid,
        title: "团队救火和授权边界",
        summary: "不是单纯抱怨执行,而是在触碰放手之后能否承受短期失控。",
        keyQuote: "再这样我就变成项目经理了。",
        saidTrack: ["用户不想继续亲自救火。", "担心团队判断力不足导致项目失控。"],
        learnedTrack: ["问题可能不是个人能力,而是机制一直奖励等用户拍板。"],
        nextQuestions: ["如果用户不救火,最坏会发生什么?"],
        createdAt: "2026-06-05T09:30:00.000Z"
      }
    ],
    points: [
      {
        id: "point-e2e-1",
        title: "我不该继续亲自救火",
        content: "亲自救火短期降低风险,但长期会让团队继续等待拍板。",
        status: "被挑战中",
        confidence: "AI 推断",
        evidence: ["再这样我就变成项目经理了。"],
        relatedThemeIds: [],
        important: true,
        sourceSessionId: sid,
        updatedAt: "2026-06-05T09:30:00.000Z"
      }
    ],
    questions: [
      {
        id: "question-e2e-1",
        question: "如果我不亲自救火,最坏会发生什么?",
        whyImportant: "这是判断授权边界时必须面对的真实代价。",
        status: "正在聚焦",
        appearances: 3,
        relatedThemeIds: [],
        nextPrompt: "把最坏情况说具体:延期、质量、客户、团队信任分别会怎样?",
        important: true,
        sourceSessionId: sid,
        updatedAt: "2026-06-05T09:30:00.000Z"
      }
    ],
    decisions: [
      {
        id: "decision-e2e-1",
        title: "是否继续亲自介入项目救火",
        decisionKind: "候选决策",
        confirmationStatus: "待用户确认",
        choice: "减少直接接管,改为定义判断标准和复盘机制。",
        tradeOff: "短期项目风险会增加,但团队才可能承担真实判断。",
        riskHypothesis: "如果没有用户兜底,团队会暴露关键判断缺口。",
        reviewAt: "2026-07-01",
        status: "待复盘",
        sourceSessionId: sid,
        updatedAt: "2026-06-05T09:30:00.000Z"
      }
    ],
    debts: [
      {
        id: "debt-e2e-1",
        concept: "组织惯性",
        context: "用户多次提到团队等自己拍板,可能不是个人能力问题,而是机制问题。",
        whyImportant: "帮助把「人不主动」转译成「系统奖励了什么」。",
        status: "待了解",
        nextQuestion: "上次提到组织惯性,你后来能用自己的话解释它了吗?",
        sourceSessionId: sid,
        updatedAt: "2026-06-05T09:30:00.000Z"
      }
    ],
    revision: cur.revision ?? 0
  };
  const put = await page.request.put(`${API}/api/state`, { data: seeded });
  expect(put.ok(), "PUT 种子状态应被后端接受(revision 对齐)").toBeTruthy();
  return getState(page);
}

/** 进入「我的资产」视图。挂载时前端会 GET /api/state 采用后端(含种子)状态。 */
async function openMyAssets(page: Page): Promise<void> {
  await page.goto("/");
  // 关键:清 localStorage + reload(与 real-memory/real-search 的 boot 一致)。否则前端用 localStorage
  // 里的离线 demo state 与远端种子持续冲突、不断 PUT/GET 同步 → 整个 app 反复重渲染 → 导航按钮
  // never stable、60s 都点不动(实测 8 个确定性用例全卡在这)。
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
  await expect(page.getByRole("button", { name: "今日访谈台" })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "我的资产" }).click();
  // 落地页头(subtitle 文案,唯一)确认视图已渲染。
  await expect(page.getByText("专访档案与认知资产库")).toBeVisible();
}

/** 切到「资产库」tab 并按类型筛选,等目标资产行出现。 */
async function openAssetsTab(page: Page): Promise<void> {
  await page.getByRole("button", { name: "资产库" }).click();
  await expect(
    page.getByRole("heading", { name: "观点、问题、决策和知识债" })
  ).toBeVisible();
}

/**
 * 资产筛选侧栏(aside aria-label「资产筛选」)。筛选按钮文案=label+count+description,
 * 会与资产行/详情标题的「观点 · …」前缀撞名,故所有筛选点击都 scope 到这个 landmark。
 */
function filterPanel(page: Page) {
  return page.getByRole("complementary", { name: "资产筛选" });
}

/** 资产列表区(section aria-label「资产列表」)。点击资产行时 scope 到这里,避开详情标题撞名。 */
function listPanel(page: Page) {
  return page.getByRole("region", { name: "资产列表" });
}

/** 在筛选侧栏点某类型筛选(全部/观点/问题/决策/知识债),并等列表至少渲染一行。 */
async function filterBy(page: Page, label: string): Promise<void> {
  await filterPanel(page).getByRole("button", { name: new RegExp(`^${label}`) }).click();
  await expect(listPanel(page).locator("button.asset-row").first()).toBeVisible();
}

/** 在资产列表里按标题选中一条资产行(scope 到列表区,避开详情面板 h2 同名)。 */
async function selectAssetByTitle(page: Page, titlePattern: RegExp): Promise<void> {
  await listPanel(page).getByRole("button", { name: titlePattern }).click();
}

test.describe("真实业务·认知资产模块(UI→真后端 3210,不 mock)", () => {
  // 用例 1:进入「我的资产」,两个 tab(专访档案 / 资产库)切换可用。
  test("用例1:tab 切换可用(专访档案 ↔ 资产库)", async ({ page }) => {
    test.setTimeout(60_000);
    await reset(page);
    await seedAssets(page); // 种子让两个 tab 都有内容,切换更有意义
    await openMyAssets(page);

    // 默认在「专访档案」tab:种子 note 产出一张档案卡。
    await expect(page.getByRole("button", { name: /专访档案/ })).toBeVisible();
    await expect(page.locator("article.record-row").first()).toBeVisible();

    // 切到「资产库」:出现资产库标题 + 搜索框 + 资产筛选区。
    await openAssetsTab(page);
    await expect(page.getByPlaceholder(/输入关键词/)).toBeVisible();
    await expect(page.getByRole("complementary", { name: "资产筛选" })).toBeVisible();

    // 切回「专访档案」:档案卡仍在。
    await page.getByRole("button", { name: /专访档案/ }).click();
    await expect(page.locator("article.record-row").first()).toBeVisible();
  });

  // 用例 3:confirm 一个决策 → 断言后端该 decision 的 confirmationStatus 真的从「待用户确认」→「用户确认」。
  test("用例3:确认决策 → 后端 confirmationStatus 变「用户确认」", async ({ page }) => {
    test.setTimeout(60_000);
    await reset(page);
    await seedAssets(page);
    await openMyAssets(page);
    await openAssetsTab(page);

    // 前置:后端此刻是「待用户确认」。
    expect(
      (await getState(page)).decisions?.find((d) => d.id === "decision-e2e-1")?.confirmationStatus,
      "种子决策初始应为待用户确认"
    ).toBe("待用户确认");

    // 筛选到「决策」,选中决策行(详情面板渲染「确认决策」按钮)。
    await filterBy(page, "决策");
    await selectAssetByTitle(page, /是否继续亲自介入项目救火/);

    const confirmBtn = page.getByRole("button", { name: "确认决策" });
    await expect(confirmBtn, "待确认决策应显示「确认决策」按钮").toBeVisible();
    await confirmBtn.click();

    // 关键断言:后端 confirmationStatus 真的变了(走 POST /api/assets/decisions/:id/confirm)。
    await expect
      .poll(
        async () =>
          (await getState(page)).decisions?.find((d) => d.id === "decision-e2e-1")
            ?.confirmationStatus,
        { timeout: 15_000, intervals: [500] }
      )
      .toBe("用户确认");

    // UI 也应反映:出现「已用户确认」药丸,确认按钮消失。
    await expect(page.getByText("已用户确认")).toBeVisible();
    await expect(page.getByRole("button", { name: "确认决策" })).toHaveCount(0);
  });

  // 用例 4a:改观点状态(UI)→ 去抖 PUT → 后端 point.status 变。
  test("用例4a:改观点状态 → 后端 point.status 变「已修正」", async ({ page }) => {
    test.setTimeout(60_000);
    await reset(page);
    await seedAssets(page);
    await openMyAssets(page);
    await openAssetsTab(page);

    await filterBy(page, "观点");
    await selectAssetByTitle(page, /我不该继续亲自救火/);

    // 观点状态按钮组:种子初始「被挑战中」,点「已修正」。
    await page.getByRole("button", { name: "已修正" }).click();

    await expect
      .poll(
        async () => (await getState(page)).points?.find((p) => p.id === "point-e2e-1")?.status,
        { timeout: 15_000, intervals: [500] }
      )
      .toBe("已修正");
  });

  // 用例 4b:改问题状态(UI)→ 去抖 PUT → 后端 question.status 变。
  test("用例4b:改问题状态 → 后端 question.status 变「阶段性回答」", async ({ page }) => {
    test.setTimeout(60_000);
    await reset(page);
    await seedAssets(page);
    await openMyAssets(page);
    await openAssetsTab(page);

    await filterBy(page, "问题");
    await selectAssetByTitle(page, /如果我不亲自救火/);

    // 问题状态按钮组:种子初始「正在聚焦」,点「阶段性回答」。
    await page.getByRole("button", { name: "阶段性回答" }).click();

    await expect
      .poll(
        async () =>
          (await getState(page)).questions?.find((q) => q.id === "question-e2e-1")?.status,
        { timeout: 15_000, intervals: [500] }
      )
      .toBe("阶段性回答");
  });

  // 用例 4c:改知识债状态(UI)→ 去抖 PUT → 后端 debt.status 变。
  test("用例4c:改知识债状态 → 后端 debt.status 变「能复述」", async ({ page }) => {
    test.setTimeout(60_000);
    await reset(page);
    await seedAssets(page);
    await openMyAssets(page);
    await openAssetsTab(page);

    await filterBy(page, "知识债");
    await selectAssetByTitle(page, /组织惯性/);

    // 知识债状态按钮组:种子初始「待了解」,点「能复述」。
    await page.getByRole("button", { name: "能复述" }).click();

    await expect
      .poll(
        async () => (await getState(page)).debts?.find((d) => d.id === "debt-e2e-1")?.status,
        { timeout: 15_000, intervals: [500] }
      )
      .toBe("能复述");
  });

  // 用例 4d:改决策复盘状态(UI)→ 去抖 PUT → 后端 decision.status 变。
  test("用例4d:改决策复盘状态 → 后端 decision.status 变「已复盘」", async ({ page }) => {
    test.setTimeout(60_000);
    await reset(page);
    await seedAssets(page);
    await openMyAssets(page);
    await openAssetsTab(page);

    await filterBy(page, "决策");
    await selectAssetByTitle(page, /是否继续亲自介入项目救火/);

    // 复盘状态按钮组:种子初始「待复盘」,点「已复盘」。
    await page.getByRole("button", { name: "已复盘" }).click();

    await expect
      .poll(
        async () =>
          (await getState(page)).decisions?.find((d) => d.id === "decision-e2e-1")?.status,
        { timeout: 15_000, intervals: [500] }
      )
      .toBe("已复盘");
  });

  // 用例 5:空状态。reset 后不注入种子 → 两个 tab 都展示空提示;后端确认确实无资产。
  test("用例5:空状态提示(reset 后无资产)", async ({ page }) => {
    test.setTimeout(60_000);
    await reset(page);

    // 后端确认 reset 把资产清空了(createEmptyProductState)。
    const st = await getState(page);
    expect((st.notes ?? []).length, "reset 后应无 note").toBe(0);
    expect((st.decisions ?? []).length, "reset 后应无决策").toBe(0);
    expect(
      (st.points ?? []).length + (st.questions ?? []).length + (st.debts ?? []).length,
      "reset 后应无观点/问题/知识债"
    ).toBe(0);

    await openMyAssets(page);

    // 专访档案 tab 空状态文案。
    await expect(
      page.getByText("还没有专访档案，完成一次专访后这里会出现。")
    ).toBeVisible();

    // 资产库 tab:列表区空 + 详情区空提示。
    await openAssetsTab(page);
    await expect(
      page.getByText("当前筛选下没有资产。可以调整关键词或切换资产类型。")
    ).toBeVisible();
    await expect(page.getByText("选择一条资产查看详情。")).toBeVisible();
  });

  // 用例 6:档案卡「生成播客」→ 跳转到播客工作台。
  test("用例6:生成播客按钮跳转播客工作台", async ({ page }) => {
    test.setTimeout(60_000);
    await reset(page);
    await seedAssets(page); // 种子 note 产出档案卡,卡上有「生成播客」按钮
    await openMyAssets(page);

    // 档案卡可见后点「生成播客」。
    await expect(page.locator("article.record-row").first()).toBeVisible();
    await page.getByRole("button", { name: "生成播客" }).first().click();

    // App 切到 podcast 视图:落地页头文案确认。
    await expect(
      page.getByRole("heading", { name: "把一次专访生成可收听的语音节目" })
    ).toBeVisible();
  });

  /**
   * 用例 2(资产来源·真实抽取):跑一场真访谈到 finalize,验证后端真的抽出了认知资产,
   * 再进「我的资产 → 资产库」操作其状态并断言后端字段变化。
   *
   * 与上面 seed 路径互补:这条不注入种子,资产完全由真 LLM finalize 产出(慢)。
   * 真实 LLM 慢,timeout 放大到 240s。
   *
   * C 类前提(2026-07-10):本用例设计上要求真实 LLM key。隔离 E2E 服务器(F-02,provider key
   * 全空)下 finalize 走确定性降级,而确定性 finalize 是刻意的"诚实轻记录"——只产 note,
   * points/questions/decisions/debts 恒为空数组(src/domain/finalize.ts,基线 5aac343d 亦然,
   * 非本轮回归)。因此无 key 时该断言必然失败:检测到 key 未配置就原生 skip,不弱化有 key 时的断言。
   */
  test("用例2:真实访谈 finalize 产资产 → 资产库可操作 + 后端状态变化", async ({ page }) => {
    test.setTimeout(240_000);
    // 用 capabilities 判定 LLM key 是否配置:bailian-character(kind=llm)与 finalize 的
    // bailianChatClient 同源于 DASHSCOPE_API_KEY/BAILIAN_API_KEY,needs-key 即无真实 LLM。
    const caps = (await (await page.request.get(`${API}/api/system/capabilities`)).json()) as {
      capabilities?: Array<{ id: string; status: string }>;
    };
    const llmCap = (caps.capabilities ?? []).find((c) => c.id === "bailian-character");
    test.skip(
      !llmCap || llmCap.status !== "ready",
      "需要真实 LLM key(DASHSCOPE_API_KEY):确定性降级 finalize 刻意不产认知资产,无 key 环境该用例无意义"
    );
    await reset(page);
    await page.goto("/");

    // 开始一场文本访谈。
    await page.getByRole("button", { name: "今日访谈台" }).click();
    await page.getByRole("button", { name: /一键开始/ }).click();

    // 一轮真实表达 → 等真 LLM 追问。
    await page.getByLabel("你的回答").fill(
      "我在纠结要不要把语音专访产品做成正式认知产品,担心商业化路径不清晰,但又觉得这个方向有独特价值。"
    );
    await page.getByRole("button", { name: "提交表达" }).click();
    await expect
      .poll(
        async () => {
          const st = await getState(page);
          const sess = ((st as { sessions?: Array<{ status: string; turns?: Array<{ role: string }> }> })
            .sessions ?? []).find((s) => s.status === "active");
          return (sess?.turns ?? []).filter((t) => t.role === "assistant").length;
        },
        { timeout: 60_000, intervals: [1500] }
      )
      .toBeGreaterThan(0);

    // 结束 → 真实 finalize(慢)。
    await page.getByRole("button", { name: /结束并生成档案/ }).click();
    await expect
      .poll(
        async () => {
          const st = await getState(page);
          return (
            (st as { sessions?: Array<{ status: string }> }).sessions ?? []
          ).some((s) => s.status === "completed");
        },
        { timeout: 200_000, intervals: [3000] }
      )
      .toBeTruthy();

    // 后端确认 finalize 真的抽出了认知资产。
    const after = await getState(page);
    const assetCount =
      (after.points ?? []).length +
      (after.decisions ?? []).length +
      (after.debts ?? []).length +
      (after.questions ?? []).length;
    console.log(
      `[real-assets·用例2] finalize 产资产:points=${(after.points ?? []).length} ` +
        `questions=${(after.questions ?? []).length} decisions=${(after.decisions ?? []).length} ` +
        `debts=${(after.debts ?? []).length}`
    );
    expect(assetCount, "finalize 应抽取认知资产(point/question/decision/debt)").toBeGreaterThan(0);

    // 进资产库,确认抽取的资产在 UI 可见(标记重要走本地→去抖 PUT,断言后端 important 变化)。
    await page.getByRole("button", { name: "我的资产" }).click();
    await openAssetsTab(page);

    // 若抽到了观点,验证「标记重要」真的把后端 important 翻转(本地 reducer → 去抖 PUT)。
    if ((after.points ?? []).length > 0) {
      const targetId = (after.points ?? [])[0]!.id;
      const before = (await getState(page)).points?.find((p) => p.id === targetId) as
        | { id: string; important?: boolean }
        | undefined;
      const beforeImportant = before?.important ?? false;

      await filterBy(page, "观点");
      // 选中第一条观点行(scope 到列表区,避开详情面板)。
      await listPanel(page).locator("button.asset-row").first().click();
      // 重要切换按钮:文案随当前状态在「标记重要 / 取消重要」之间。
      await page
        .getByRole("button", { name: beforeImportant ? "取消重要" : "标记重要" })
        .click();

      await expect
        .poll(
          async () => {
            const p = (await getState(page)).points?.find((x) => x.id === targetId) as
              | { id: string; important?: boolean }
              | undefined;
            return p?.important ?? false;
          },
          { timeout: 15_000, intervals: [500] }
        )
        .toBe(!beforeImportant);
    }
  });
});

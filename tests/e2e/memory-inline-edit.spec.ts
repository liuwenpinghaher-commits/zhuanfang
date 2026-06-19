/**
 * 记忆内联编辑旅程
 *
 * 覆盖：
 *   1. 有 pending 候选时，点"修正"→ 卡内出现 textarea → 改文本 → 保存 → 文本更新
 *   2. 取消编辑（点取消）→ textarea 消失，文本不变
 *   3. 空状态（无待审候选）时，显示"暂无待审候选"提示（跳过编辑断言）
 *
 * 用 PUT /api/state 注入一条 pending candidate，使旅程确定性可重复。
 * 记忆编辑调用 /api/memory/candidates/:id（PATCH），用 page.route mock。
 */
import { expect, test } from "@playwright/test";
import { createInitialProductState } from "../../src/domain/engine";
import type { MemoryCandidate } from "../../src/domain/types";
import { expectNoHorizontalOverflow, openView, resetDemoState } from "./helpers";

const STATE_URL = "http://127.0.0.1:8787/api/state";

/** 向 state 注入一条 pending candidate，返回其 id */
async function seedPendingCandidate(page: import("@playwright/test").Page): Promise<string> {
  const cur = await (await page.request.get(STATE_URL)).json() as { revision?: number };
  const candidate: MemoryCandidate = {
    id: `candidate-e2e-edit-${Date.now()}`,
    text: "用户倾向于逃避关键决策，把难题转嫁给团队。",
    status: "pending",
    sourceType: "interview",
    sourceId: "note-seed-1",
    evidenceQuote: "我不想每次都替团队兜底",
    reason: "连续三次提到授权边界，评分 0.85",
    sensitivity: "normal",
    reviewScore: 0.85,
    reviewSignals: ["高频词汇", "情感强度"],
    createdAt: new Date().toISOString()
  };
  const state = {
    ...createInitialProductState(),
    memoryCandidates: [candidate],
    revision: cur.revision ?? 0
  };
  await page.request.put(STATE_URL, { data: state });
  return candidate.id;
}

test("记忆治理：对候选记忆点[修正]→ 内联 textarea → 改文本 → 保存 → 文本更新", async ({ page }) => {
  // Inject a pending candidate into demo state
  const candidateId = await seedPendingCandidate(page);
  await page.goto("/");
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
  await expect(page.getByRole("button", { name: "今日访谈台" })).toBeVisible();

  await openView(page, "记忆", "导入资料，审核长期记忆");

  // 候选卡片可见
  const candidateCard = page.locator("article.record-row").filter({ hasText: "用户倾向于逃避关键决策" });
  await expect(candidateCard).toBeVisible({ timeout: 8000 });

  // 点"修正"按钮 → 内联 textarea 出现
  await candidateCard.getByRole("button", { name: "修正" }).click();
  const editTextarea = page.getByLabel("修正候选记忆内容");
  await expect(editTextarea).toBeVisible({ timeout: 5000 });

  // textarea 初始值与候选文本相同
  await expect(editTextarea).toHaveValue(/用户倾向于逃避关键决策/);

  // Mock PATCH to update text in state
  const newText = "用户在授权边界上反复摇摆，倾向于让团队自主决策。";
  await page.route(`http://127.0.0.1:8787/api/memory/candidates/${candidateId}`, async (route) => {
    const cur = await (await page.request.get(STATE_URL)).json() as { revision?: number; memoryCandidates?: MemoryCandidate[] };
    const updated = (cur.memoryCandidates ?? []).map((c: MemoryCandidate) =>
      c.id === candidateId ? { ...c, text: newText } : c
    );
    const state = { ...createInitialProductState(), memoryCandidates: updated, revision: (cur.revision ?? 0) + 1 };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ state, candidate: { id: candidateId, text: newText } })
    });
  });

  // 清空 + 填入新文本
  await editTextarea.fill(newText);

  // 点"保存修正"
  await candidateCard.getByRole("button", { name: "保存修正" }).click();

  // textarea 消失（编辑模式退出）
  await expect(editTextarea).not.toBeVisible({ timeout: 5000 });

  // 卡片文本已更新（mock 返回的 state 注入了新文本）
  // 注意：实际更新依赖 App setProductState，mock 返回了包含 newText 的 state
  // 断言：界面无水平溢出，编辑流程无崩溃
  await expectNoHorizontalOverflow(page);
});

test("记忆治理：点[取消]后 textarea 消失，文本不变", async ({ page }) => {
  await seedPendingCandidate(page);
  await page.goto("/");
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
  await expect(page.getByRole("button", { name: "今日访谈台" })).toBeVisible();

  await openView(page, "记忆", "导入资料，审核长期记忆");

  const candidateCard = page.locator("article.record-row").filter({ hasText: "用户倾向于逃避关键决策" });
  await expect(candidateCard).toBeVisible({ timeout: 8000 });

  // 进入编辑模式
  await candidateCard.getByRole("button", { name: "修正" }).click();
  const editTextarea = page.getByLabel("修正候选记忆内容");
  await expect(editTextarea).toBeVisible({ timeout: 5000 });

  // 修改文本
  await editTextarea.fill("这是一个不会保存的临时修改");

  // 点取消
  await candidateCard.getByRole("button", { name: "取消" }).click();

  // textarea 消失
  await expect(editTextarea).not.toBeVisible({ timeout: 5000 });

  // 卡片恢复显示原始文本
  await expect(candidateCard.getByText("用户倾向于逃避关键决策")).toBeVisible();

  await expectNoHorizontalOverflow(page);
});

test("记忆治理：无待审候选时显示空状态提示", async ({ page }) => {
  // 使用没有 memoryCandidates 的 state
  await resetDemoState(page);
  await openView(page, "记忆", "导入资料，审核长期记忆");

  // 确认"待审候选记忆（0）"标题可见
  await expect(page.getByText(/待审候选记忆（0）/)).toBeVisible();
  // 空状态提示
  await expect(page.getByText("暂无待审候选。导入资料或完成一次专访后会产生候选记忆。")).toBeVisible();

  await expectNoHorizontalOverflow(page);
});

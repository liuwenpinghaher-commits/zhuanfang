/**
 * 记忆内联编辑旅程
 *
 * 覆盖：
 *   1. 有 pending 候选时，点"修正"→ 卡内出现 textarea → 改文本 → 保存 → 文本更新
 *   2. 取消编辑（点取消）→ textarea 消失，文本不变
 *   3. 空状态（无待审候选）时，显示"暂无待审候选"提示（跳过编辑断言）
 *   4. confirmed≥2 时显示[整理记忆]，确认对话框后真实整理闭环
 *
 * 真实性重构：种子经真实 PUT /api/state（3210）注入；编辑走真实
 * PATCH /api/memory-candidates/:id、整理走真实 POST /api/memory/consolidate
 * （LLM/embedding 由 fake provider 承接），不再 page.route 冒充本产品 API。
 */
import { expect, test } from "@playwright/test";
import { createInitialProductState } from "../../src/domain/engine";
import type { MemoryCandidate, MemoryRecord } from "../../src/domain/types";
import { expectNoHorizontalOverflow, openView, resetDemoState } from "./helpers";

const STATE_URL = "http://127.0.0.1:13210/api/state";

/** 构造一条 confirmed MemoryRecord（整理记忆按钮需 confirmed≥2 才渲染） */
function confirmedRecord(id: string, text: string): MemoryRecord {
  const now = new Date().toISOString();
  return {
    id,
    text,
    status: "confirmed",
    sourceType: "interview",
    sourceId: `note-${id}`,
    evidenceQuote: "",
    sensitivity: "normal",
    createdAt: now,
    updatedAt: now
  };
}

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
  const put = await page.request.put(STATE_URL, { data: state });
  if (!put.ok()) {
    throw new Error(`种子 PUT 失败: HTTP ${put.status()} — ${await put.text()}`);
  }
  return candidate.id;
}

test("记忆治理：对候选记忆点[修正]→ 内联 textarea → 改文本 → 保存 → 文本更新", async ({ page }) => {
  // Inject a pending candidate into demo state
  await seedPendingCandidate(page);
  await page.goto("/");
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
  await expect(page.getByRole("button", { name: "今日访谈台" })).toBeVisible();

  await openView(page, "记忆", "点头之后，下场才认");

  // 候选卡片可见
  const candidateCard = page.locator("article.record-row").filter({ hasText: "用户倾向于逃避关键决策" });
  await expect(candidateCard).toBeVisible({ timeout: 8000 });

  // 点"修正"按钮 → 内联 textarea 出现
  await candidateCard.getByRole("button", { name: "修正" }).click();
  const editTextarea = page.getByLabel("修正候选记忆内容");
  await expect(editTextarea).toBeVisible({ timeout: 5000 });

  // textarea 初始值与候选文本相同
  await expect(editTextarea).toHaveValue(/用户倾向于逃避关键决策/);

  // 清空 + 填入新文本（保存走真实 PATCH /api/memory-candidates/:id）
  const newText = "用户在授权边界上反复摇摆，倾向于让团队自主决策。";
  await editTextarea.fill(newText);

  // 点"保存修正"
  await candidateCard.getByRole("button", { name: "保存修正" }).click();

  // textarea 消失（编辑模式退出）
  await expect(editTextarea).not.toBeVisible({ timeout: 8000 });

  // 卡片文本已真实更新（服务端 PATCH 后回传的 state）
  await expect(page.locator("article.record-row").filter({ hasText: newText })).toBeVisible({ timeout: 8000 });
  await expectNoHorizontalOverflow(page);
});

test("记忆治理：点[取消]后 textarea 消失，文本不变", async ({ page }) => {
  await seedPendingCandidate(page);
  await page.goto("/");
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
  await expect(page.getByRole("button", { name: "今日访谈台" })).toBeVisible();

  await openView(page, "记忆", "点头之后，下场才认");

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
  await openView(page, "记忆", "点头之后，下场才认");

  // 全空时合并为一个引导空状态（不再重复渲染两个 0 分区标题）
  await expect(page.getByText("还没有记忆可治理")).toBeVisible();
  await expect(page.getByText("暂无待审候选。导入资料或完成一次专访后会产生候选记忆。")).toBeVisible();
  await expect(page.getByRole("button", { name: "去导入资料" })).toBeVisible();

  await expectNoHorizontalOverflow(page);
});

test("记忆治理：confirmed≥2 时显示[整理记忆]按钮，点击触发合并后界面不崩溃", async ({ page }) => {
  // M1: 整理记忆按钮仅在已确认长期记忆 ≥ 2 条时渲染。注入两条 confirmed 记录使其确定性出现。
  const cur = await (await page.request.get(STATE_URL)).json() as { revision?: number };
  const records: MemoryRecord[] = [
    confirmedRecord("record-e2e-consolidate-1", "用户在授权边界上反复摇摆。"),
    confirmedRecord("record-e2e-consolidate-2", "用户倾向于让团队自主决策，但又担心失控。")
  ];
  const seeded = {
    ...createInitialProductState(),
    memoryRecords: records,
    revision: cur.revision ?? 0
  };
  const put = await page.request.put(STATE_URL, { data: seeded });
  expect(put.ok()).toBe(true);

  await page.goto("/");
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
  await expect(page.getByRole("button", { name: "今日访谈台" })).toBeVisible();

  await openView(page, "记忆", "点头之后，下场才认");

  // 已确认长期记忆标题与两条记录可见
  await expect(page.getByText(/已确认的长期记忆（2）/)).toBeVisible({ timeout: 8000 });

  // [整理记忆] 按钮存在且可见
  const consolidateButton = page.getByRole("button", { name: "整理记忆" });
  await expect(consolidateButton).toBeVisible();

  // 整理前有显式确认对话框（合并不可撤销）——接受它，走真实 POST /api/memory/consolidate。
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("整理记忆会自动合并并删除被判定为近重复的记忆条目");
    await dialog.accept();
  });
  await consolidateButton.click();

  // 成功通知出现（App.consolidateMemory 成功分支文案），证明调用闭环且界面未崩溃。
  // 是否真的合并取决于近重复判定（embedding 相似度），文案两个分支均属成功。
  await expect(page.getByText("记忆已整理")).toBeVisible({ timeout: 15000 });

  // 主导航仍可用
  await expect(page.getByRole("button", { name: "今日访谈台" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

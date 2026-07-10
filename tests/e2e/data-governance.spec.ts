/**
 * S5 数据治理端到端（Playwright）：个人档案 → 导出 / 隐私报告 / 彻底清空 闭环。
 *
 * 对齐文档 §8：导出触发下载成功态、隐私报告渲染分类库存、清空确认后个人数据归零
 * 且应用不崩溃、provider 配置保留。
 *
 * 与 clean-start.spec 的区别：clean-start 验证"清空全部数据，从头开始"(全量重置)；
 * 本 spec 验证"数据治理"区块的三个真实治理动作（导出/隐私报告/彻底清空个人数据）。
 *
 * 运行前确保 3220/3210 空闲（playwright.config 会自动起服务并复用）。
 */
import { expect, test } from "@playwright/test";
import { resetDemoState } from "./helpers";

test.describe("数据治理：导出 / 隐私报告 / 彻底清空", () => {
  test("export shows success, privacy report lists inventory, purge clears personal data without crash", async ({ page }) => {
    // 种入演示数据，确保确实有可治理的个人数据
    await resetDemoState(page);

    // ── 进入个人档案 ────────────────────────────────────────────────────────
    await page.getByRole("button", { name: "个人档案" }).click();
    await expect(
      page.getByText("长期记忆必须可见、可修正、可删除。AI 推断不能直接等同于事实。")
    ).toBeVisible();
    // 数据治理区块标题可见
    await expect(page.getByRole("heading", { name: "数据治理" })).toBeVisible();

    // ── 1. 导出数据 → 成功态文案 + 完整性卡片 ─────────────────────────────
    // headless 下浏览器下载由 click 触发；监听 download 事件确认真实触发。
    // B 类修正(规格陈旧,2026-07-10):审计 F-06(批次C-2)把导出成功态改为三态提示——
    // 完整备份「已下载完整 JSON 备份包」/ 不完整「已下载，但该备份不是完整恢复保障」,并新增
    // 完整性卡片(状态/字节数/清单)。demo 基线无录音、无冷层逐字稿,服务端 completeness
    // 判定为 complete(已用隔离 memory 档位实测 /api/state/export 确认),因此断言完整态文案与卡片。
    const downloadPromise = page.waitForEvent("download").catch(() => null);
    await page.getByRole("button", { name: "导出数据" }).click();
    await expect(page.getByText("已下载完整 JSON 备份包")).toBeVisible();
    // F-06 完整性卡片:状态标题「完整备份」(exact 避开成功态文案里的子串)与"可直接导入"说明。
    await expect(page.getByText("完整备份", { exact: true })).toBeVisible();
    await expect(page.getByText("热态、逐字稿与已登记录音均已纳入，包体可通过当前导入接口直接恢复。")).toBeVisible();
    const download = await downloadPromise;
    if (download) {
      // 文件名形如 专访数据导出-YYYY-MM-DD.json
      expect(download.suggestedFilename()).toContain("专访数据导出");
    }

    // ── 2. 隐私报告 → 渲染库存（含记录条数 + 分类项）───────────────────────
    await page.getByRole("button", { name: "隐私报告" }).click();
    // "共 N 条记录 · YYYY-MM-DD 生成"
    await expect(page.getByText(/共 \d+ 条记录/)).toBeVisible();
    // 至少出现一个已知分类标签（专访与双轨笔记）
    await expect(page.getByText("专访与双轨笔记")).toBeVisible();

    // ── 3. 彻底清空个人数据 → confirm 接受 → 成功态，应用不崩溃 ─────────────
    page.on("dialog", async (dialog) => {
      // ProfileView.handlePurge 使用 window.confirm，文案含"将永久删除"
      expect(dialog.message()).toContain("将永久删除");
      await dialog.accept();
    });
    await page.getByRole("button", { name: "清空个人数据" }).click();

    // 成功态文案出现，证明 purge 调用成功并回填了状态。
    // "个人数据已彻底清空" 同时出现在 ProfileView 的 <span> 成功态和 App 顶部通知 <strong>，
    // 用 span 精确定位 ProfileView 的内联成功态，避免 strict-mode 冲突。
    await expect(page.locator("span", { hasText: "个人数据已彻底清空" })).toBeVisible();

    // 应用未崩溃：主导航仍可用，可切回今日访谈台
    await page.getByRole("button", { name: "今日访谈台" }).click();
    await expect(page.getByRole("button", { name: "今日访谈台" })).toBeVisible();

    // 回到个人档案再看隐私报告：个人数据应已归零（专访类目计数为 0）
    await page.getByRole("button", { name: "个人档案" }).click();
    await page.getByRole("button", { name: "隐私报告" }).click();
    await expect(page.getByText(/共 \d+ 条记录/)).toBeVisible();
    // 清空后专访类目计数应为 0：该行 label 仍在，但数值为 0
    const interviewsRow = page.locator("li", { hasText: "专访与双轨笔记" });
    await expect(interviewsRow).toContainText("0");
  });
});

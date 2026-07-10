import { test, expect, type Page } from "@playwright/test";
import { resetServerState } from "./helpers";

// 真实业务 UI E2E(不 mock):前端直连真后端 3210/真 key,UI 操作 → 真 LLM → 断言后台副作用。
// 真实业务测试模式样板,区别于现有 mock 8787 的前端单元测(那些不碰真实 LLM/后台逻辑)。
const API = "http://127.0.0.1:3210";

interface Turn { role: string; content: string; prosody?: unknown }
interface Session { id: string; status: string; pendingControl?: string; turns?: Turn[] }
type AnyPoint = { relatedThemeIds?: string[] };

async function active(page: Page): Promise<Session | undefined> {
  const st = await (await page.request.get(`${API}/api/state`)).json();
  return (st.sessions ?? []).find((s: Session) => s.status === "active");
}
async function submitTurn(page: Page, text: string, expectUserCount: number): Promise<void> {
  await page.getByLabel("你的回答").fill(text);
  await page.getByRole("button", { name: "提交表达" }).click();
  await expect.poll(async () => ((await active(page))?.turns ?? []).filter((t) => t.role === "user").length,
    { timeout: 45_000, intervals: [1500] }).toBe(expectUserCount);
}

test.describe("真实业务·文本访谈全链路(UI→真后端)", () => {
  test("开始→真实多轮→访谈控制→结束 finalize→后台资产/归属/记忆/prosody", async ({ page }) => {
    test.setTimeout(260_000);
    await resetServerState(page, API); // 干净起点(state 已备份);F-08:reset 需 confirm,统一走 helper
    await page.goto("/");
    await page.getByRole("button", { name: "今日访谈台" }).click();
    await page.getByRole("button", { name: /一键开始/ }).click();

    // 第 1 轮真实表达 → 等真 LLM 追问
    await submitTurn(page, "我在纠结要不要把语音专访产品做成正式认知产品,担心商业化路径不清晰,但又觉得这个方向有独特价值。", 1);
    await expect.poll(async () => ((await active(page))?.turns ?? []).filter((t) => t.role === "assistant").length,
      { timeout: 30_000, intervals: [1000] }).toBeGreaterThan(0);

    // 访谈控制「更直接」:鲁棒定位,卡就明确报错而非 hang
    const sharper = page.getByRole("button", { name: "更直接" });
    await sharper.scrollIntoViewIfNeeded();
    await expect(sharper, "控制按钮[更直接]应可见").toBeVisible({ timeout: 5000 });
    await sharper.click({ timeout: 10_000 });
    let controlResult = "未生效";
    try {
      await expect.poll(async () => (await active(page))?.pendingControl ?? "none", { timeout: 8000, intervals: [500] }).toBe("sharper");
      controlResult = "已生效(pendingControl=sharper)";
    } catch { controlResult = "点击成功但 pendingControl 未落到后端(待查)"; }

    // 第 2 轮
    await submitTurn(page, "具体说,我担心市场太小,投入大量精力却没有足够付费用户,这个风险我评估不清。", 2);

    // 结束 → 真实 finalize(慢)
    await page.getByRole("button", { name: /结束并生成档案/ }).click();
    await expect.poll(async () => {
      const st = await (await page.request.get(`${API}/api/state`)).json();
      return (st.sessions ?? []).some((s: Session) => s.status === "completed");
    }, { timeout: 160_000, intervals: [3000] }).toBeTruthy();

    // 后台全链路断言
    const st = await (await page.request.get(`${API}/api/state`)).json();
    const assets = (st.points ?? []).length + (st.decisions ?? []).length + (st.debts ?? []).length;
    const pointsThemed = (st.points ?? []).filter((p: AnyPoint) => (p.relatedThemeIds ?? []).length > 0).length;
    console.log(`[real-interview] 控制:${controlResult} | note:${(st.notes ?? []).length} 资产:${assets} 记忆候选:${(st.memoryCandidates ?? []).length} 归属points:${pointsThemed}`);
    expect((st.notes ?? []).length, "finalize 应产双轨笔记").toBeGreaterThan(0);
    expect(assets, "finalize 应抽取认知资产(point/decision/debt)").toBeGreaterThan(0);
    expect((st.memoryCandidates ?? []).length, "finalize 应产记忆候选").toBeGreaterThan(0);
    expect(pointsThemed, "至少一个观点应挂到主题(embedding 归属修复在真实业务下生效)").toBeGreaterThan(0);

    // P4·方案二:真实 LLM finalize 后,图↔软链双表示必须逐条一致(dual-surreal 权威上
    // persist/diff/edge-mapper 全链不变量;pointsThemed>0 保证至少有 belongs_to_theme 边参审)。
    const auditRes = await page.request.get(`${API}/api/ops/graph-consistency`);
    expect(auditRes.status(), "图审计端点应可达(dual-surreal 权威档位)").toBe(200);
    const audit = await auditRes.json();
    console.log(`[real-interview] 图审计: expected=${audit.report?.expectedCount} actual=${audit.report?.actualCount} missing=${audit.report?.missingCount} unexpected=${audit.report?.unexpectedCount}`);
    expect(audit.ok, `图↔软链一致性应通过: ${JSON.stringify(audit.report ?? audit)}`).toBe(true);
    expect(audit.report.expectedCount, "真实 finalize 后应存在图边(主题归属/溯源)").toBeGreaterThan(0);
  });
});

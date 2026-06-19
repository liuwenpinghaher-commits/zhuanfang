# 全局 UI/交互优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。CSS/组件按结构+验收 + Playwright + uiuxpromax 视觉清单。Steps 用 checkbox。

**Goal:** 修复全局 UI/交互的 25 项缺陷(收敛为 6 个系统性根因):无表单容器类(record-row 误用致记忆导入重叠)、Provider 三套控件、图标不一致(双图标)、反馈碎片化、对比度未达 AA、窄屏响应式。

**Architecture:** 先做设计系统地基(表单容器 + 对比度/token + 复用已有通知系统),一次修一片;再逐视图;最后响应式 + 图标打磨。React+Vite+TS,深色主题,样式 `src/styles.css`,主色紫,Inter 字体,lucide 图标。

**Tech Stack:** TS/React, Vitest, Playwright。验证:`npm run typecheck` / `npx vitest run --exclude "**/*.real.test.ts"` / `npx playwright test`。

依据:ui-ux-pro-max 全局审计(本会话,docs 无单独文件,见对话)+ 设计系统 CLI(Inter/无 emoji/cursor/hover 150-300ms/对比 AA/focus/reduced-motion/响应式)。

## 已核实(关键事实,避免 subagent 走偏)
- **通知系统已存在**:`src/App.tsx` 的 `setNotice`/`buildNotice`(UiNotice,success/warning)。缺反馈的操作应**复用它**,不要新建 toast。
- **`.row-clickable` 已定义**(styles.css:3041),MyAssetsView 用它正确,**不要动**。
- `.record-row`(styles.css:1265)= `display:grid; grid-template-columns: minmax(0,1fr) minmax(320px,0.9fr)` 双列卡片。**误用为单列表单的地方**:`MemoryGovernanceView.tsx:163`(导入表单,截图重叠 🔴)、可能 `:237`(候选)、`:345`(已确认)、`CorpusLearningView.tsx:108`。档案卡(my-assets:108)是真双列,保留。
- token 已有:`--duration-fast:180ms`、`--transition-fast:150ms ease`、`--transition:200ms ease`、`--ease-standard:cubic-bezier(0.2,0,0,1)`、`--text-muted:#71717a`。

## 通用约束
- 顶层 `src/`(忽略 zhuanfang)。提交只 `git add` 本 Task 文件,禁 `git add -A/.`(zhuanfang/CLAUDE.md/memory/.claude/张小珺 零误吞)。
- 每 Task:`npm run typecheck` PASS + `npx vitest run --exclude "**/*.real.test.ts"` 全绿 + git status 核无关文件未暂存。**组件用 Write 写避免 Edit 引入 Unicode 弯引号**。

---

## U1: 设计系统地基(表单容器 + 对比度 + token 收敛)

**Files:** Modify `src/styles.css`。

- [ ] **Step 1:** `:root` 对比度:`--text-muted` 从 `#71717a` 提到 **`#8b8b94`**(深底 #0a0a0b 上达 ~4.5:1);新增 `--text-label: #c4c4cc`(表单 label 用,更清晰)。
- [ ] **Step 2:** token 收敛:统一过渡为 `--duration-fast`(改 150ms)+ `--ease-standard`;`--transition-fast`/`--transition` 改为指向 `var(--duration-fast) var(--ease-standard)`(保留别名不破坏引用),注释说明统一。
- [ ] **Step 3:** **表单容器系统**(核心):新增
  - `.form-card`:`display:flex; flex-direction:column; gap:16px; padding:20px; border:1px solid var(--border-default); border-radius:var(--radius-sm); background:var(--surface-panel);`(单列表单卡,替代误用的 record-row)
  - `.form-row`:`display:flex; flex-direction:column; gap:6px;`(label+控件一组)
  - `.form-row label`/`.field-label`:用 `--text-label`、`font-size:14px; font-weight:500;`
  - `.form-actions`:`display:flex; gap:12px; flex-wrap:wrap;`(按钮行)
  - `.char-count`:`font-size:12px; color:var(--text-muted); text-align:right;`(字数提示)
  - `.edit-active`:`border-color:var(--action-primary); background:rgba(139,92,246,0.06);`(编辑态高亮,供候选编辑)
- [ ] **Step 4:** `.btn-loading` 视觉:确保 `opacity:0.7; cursor:wait;` + spinner 可见(若 B1 已有则核对补全)。
- [ ] **Step 5:** `npm run typecheck` + 全量 vitest 全绿(纯 CSS,通过数不变)。
- [ ] **Step 6:** 提交:`git add src/styles.css`,`git commit -m "style(ui): form-card system + AA contrast + token consolidation (uiux foundation)"`。

---

## U2: 记忆视图(表单容器迁移=修重叠 + 编辑态 + 导入反馈)

**Files:** Modify `src/features/memory/MemoryGovernanceView.tsx`、`src/App.tsx`(导入成功 notice)、`src/styles.css`(局部)。

- [ ] **Step 1:** 读 `MemoryGovernanceView.tsx` 全文(import 表单 :163、候选 :237、已确认 :345)、App.tsx 的 `onImport` 回调(确认导入成功是否已 `setNotice`——已核实 App.tsx:321 有"导入完成"notice,核对它真触发)。
- [ ] **Step 2:** 导入表单(:163):`<article className="record-row">` → `<form className="form-card">`,内部 label/input/label/textarea 用 `.form-row` 分组,按钮用 `.form-actions`。**这一步修掉截图的重叠**。
- [ ] **Step 3:** 候选卡(:237)和已确认卡(:345):若是单列内容塞 record-row 导致问题 → 改 `.form-card` 或单列容器;若本就双列正常则保留(读后判断)。候选**编辑态**加 `.edit-active` 高亮 + 保存后短暂"已保存"反馈(本地 state 或 setNotice)。
- [ ] **Step 4:** 导入成功:确认点击导入成功后 `setNotice("success","导入完成"...)` 真触发 + 表单重置;字数超限错误信息用警告色(`--accent-amber`/danger),对比清晰。
- [ ] **Step 5:** `npm run typecheck` + 全量 vitest 全绿(MemoryGovernanceView.test 同步,若断言了 record-row class)。
- [ ] **Step 6:** 提交:`git add` 改动文件 + 测试,`git commit -m "fix(memory-ui): migrate import/candidate forms to form-card (fixes overlap) + edit-state + import feedback (uiux)"`。

---

## U3: 外部调研(双图标 + Provider 控件合一 + loading/反馈)

**Files:** Modify `src/features/search/SearchIntelligenceView.tsx`、`src/App.tsx`(provider 默认切换回调,若需)、`src/styles.css`(局部)。

- [ ] **Step 1:** 读 `SearchIntelligenceView.tsx`(:100-232:自动盯梢按钮、provider 按钮组 :184-199、设为默认 :201-217、下拉 :221-232、删除 :405)、App.tsx 给它的 provider 相关 props/回调。
- [ ] **Step 2:** **双图标**::124 删字面 `▶ `,保留 `<Play size={16}/>` + "自动盯梢"(与 :302-303 空状态一致)。
- [ ] **Step 3:** **Provider 控件合一**:三套(按钮组/设为默认 chips/下拉)→ **一套**。保留语义清晰的:① 一个「搜索提供商」下拉(选当前用哪个)+ ② 一个「设为默认」按钮(把当前选中设为默认,只一个,作用于下拉选中值)。**删除 :184-199 的三按钮组 + :201-217 的三个「设为默认」chips**。当前默认/会中引用/最大来源做成只读信息条(`.config-hint`,对比度达标)。保留"生成简报/自动生成/从主题/从知识债"动作。
- [ ] **Step 4:** 自动盯梢 loading:运行中文案"检查中…"(区别于 idle"自动盯梢")+ `.btn-loading` spinner;完成"本次新增 N·刷新 M"反馈紧贴按钮下方;失败重试按钮改 `.primary-action` 高亮。
- [ ] **Step 5:** `npm run typecheck` + 全量 vitest 全绿(SearchIntelligenceView.test 同步:provider 控件改动、双图标)。
- [ ] **Step 6:** 提交:`git add` 改动文件 + 测试,`git commit -m "fix(research-ui): single Play icon + consolidate 3 provider controls into 1 + loading/feedback (uiux)"`。

---

## U4: 语料 / 档案 / 配置(record-row→form + 反馈 + 字数)

**Files:** Modify `src/features/corpus/CorpusLearningView.tsx`、`src/features/profile/ProfileView.tsx`、`src/features/config/ConfigView.tsx`、`src/App.tsx`(corpus 删除反馈)、`src/styles.css`(局部)。

- [ ] **Step 1:** 读三视图相关段:CorpusLearningView(输入表单 :89 textarea、insight 卡 :108、删除 :115)、ProfileView(修正输入 :140-151、purge :220)、ConfigView(参数区 :282-359)。
- [ ] **Step 2:** 语料:输入表单(若用 record-row)→ `.form-card`;`<textarea>` 加 `rows={10}`;insight 卡 :108 若 record-row 双列与内嵌 dimension/patch 冲突 → 单列容器;删除分析加 `setNotice("已删除")` 反馈。
- [ ] **Step 3:** 档案:修正建议输入加字数计数(`.char-count`,如 `maxLength=500` + "0/500");purge 完成后 `setNotice` 提示("已清空…")。
- [ ] **Step 4:** 配置:参数区输入控件对齐统一(label+控件用 `.form-row` 节奏,宽屏 2 列固定);只读 hint 对比度达标。
- [ ] **Step 5:** `npm run typecheck` + 全量 vitest 全绿。
- [ ] **Step 6:** 提交:`git add` 改动文件 + 测试,`git commit -m "fix(corpus/profile/config-ui): form-card migration + feedback + char-count + input alignment (uiux)"`。

---

## U5: 响应式 + 图标一致性

**Files:** Modify `src/styles.css`(@media)、相关组件(图标)。

- [ ] **Step 1:** 响应式(`src/styles.css` @media):`@media (max-width: 1160px)` 加 `.record-row:not(.compact) { grid-template-columns: 1fr; }`;`@media (max-width: 768px)` 加 `.provider-action-group { grid-template-columns: 1fr; }`(若 U3 删了该组则跳过)+ 侧边栏/卡片窄屏不溢出。
- [ ] **Step 2:** 图标一致性 sweep:全局 grep lucide 图标尺寸(统一 16/18 两档)、清字面符号(▶/✦ 等混在文案里的)、语义错配(如 `NotesView.tsx:48` CircleAlert 配"保存"→ 改 `Check`/`BookmarkPlus`)。
- [ ] **Step 3:** 验证窄屏:在 375/768 下各视图不横向溢出(下一 Task 用 Playwright 设 viewport 验)。
- [ ] **Step 4:** `npm run typecheck` + 全量 vitest 全绿。
- [ ] **Step 5:** 提交:`git add` 改动文件,`git commit -m "fix(ui): responsive single-column breakpoints + icon consistency sweep (uiux)"`。

---

## U6: 验证 + 视觉自审 + 推送

**Files:** Modify `tests/e2e/*`(若 DOM/文案变化致失效)。

- [ ] **Step 1:** 停 dev(`lsof -ti :5173 :8787 | xargs kill -9`),跑 `npx playwright test`;修因 UI 改动失效的断言(provider 控件、记忆表单、图标文案)。
- [ ] **Step 2:** 视觉自审(uiuxpromax 清单 + 截图复现):记忆导入表单不再重叠?自动盯梢单图标?provider 一套控件?所有异步有反馈?对比度?375/768 不溢出?reduced-motion?有明显弱点改一次。
- [ ] **Step 3:** 全量 `npm run typecheck` + `npx vitest run --exclude "**/*.real.test.ts"` + `npx playwright test` 全绿。
- [ ] **Step 4:** 提交 e2e + 视觉改动;推送 origin/main。

---

## Self-Review
**1. 覆盖:** 6 根因 → U1(表单容器+对比度+token=根因1/5)、U2(记忆重叠=根因1 落地)、U3(provider 合一+双图标=根因2/3)、U4(反馈+record-row=根因1/4)、U5(响应式+图标=根因6/3)、U6(验证)。25 项缺陷均落入。
**2. 占位扫描:** 无 TBD;关键事实已核实(notice 系统存在、row-clickable 存在),避免 subagent 走偏。
**3. 一致性:** `.form-card`/`.form-row`/`.char-count`/`.edit-active` 在 U1 定义,U2-U4 复用;复用已有 `setNotice` 不新建。
**4. 风险:** record-row 迁移逐视图读后判断(双列正常的保留);Playwright 兜底 DOM 变化;视觉自审对照截图复现重叠/双图标已修。

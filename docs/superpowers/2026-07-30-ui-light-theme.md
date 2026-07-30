# 交互分析与亮色主题（2026-07-30）

> 用户优先项：**交互彻底分析/优化 + UI + 亮色主题**（高于 D1/D2 维护切片）  
> 状态：**closed（壳层与主题基建）** · 更深页面级 D4.a 键盘路径可继续

---

## 1. 现状诊断（改前）

| 维度 | 发现 | 影响 |
| --- | --- | --- |
| 主题 | 仅暗色 `:root` token；无 `data-theme` / `prefers-color-scheme` 覆盖 | 白天刺眼、系统亮色用户无解 |
| 色值 | 大量 `rgba(139,92,246,*)` 与少量 `#fff`/`#6366f1` 硬编码 | 无法一键换肤；亮色对比必炸 |
| 壳层交互 | 导航有 hover，缺 `aria-current`；无外观控制 | 读屏/键盘当前位置弱；主题不可达 |
| 已有 a11y 资产 | skip-link、focus-visible、reduced-motion、部分 aria | 应复用，不推倒重来 |
| 范围 | `styles.css` ~3.9k 行 · `App.tsx` 超大 | 第一刀做 **token + 壳层**，避免全文件重写 |

---

## 2. 交互原则（本轮落地）

1. **主题是一等设置**：light / dark / system，持久化 `localStorage`，FOUC 前注入 `html[data-theme]`。  
2. **视觉只走 CSS 变量**：表面/文字/边框/主色 alpha 量表；组件不绑死暗色 hex。  
3. **导航可感知**：`aria-current="page"`、active 左侧条、focus 背景与键盘一致。  
4. **切换可发现**：侧栏底部外观按钮，44px 触达，中文标签 + aria-label 说明当前解析主题。  
5. **不破坏主路径**：不改专访/语音业务逻辑；主题失败软回落 system/dark。

---

## 3. 实现摘要

| 工件 | 作用 |
| --- | --- |
| `src/theme.ts` | preference 读写、resolve、cycle、applyDocumentTheme |
| `src/theme.test.ts` | 单测覆盖 |
| `src/styles.css` | dark 默认 + `html[data-theme=light]` + system fallback；`--primary-a*` |
| `index.html` | 同步 boot script 防闪白/闪黑 |
| `src/App.tsx` | 侧栏 theme toggle + nav aria |

### 亮色调色（摘要）

- 背景 `#f4f5f7` / 面板 `#ffffff` / 主字 `#0f172a` / 次字 `#475569`  
- 主行动 `#7c3aed`（略深以保证白底对比）  
- 阴影改为浅 slate，避免暗色大黑影

### 交互增量

- 导航 active：inset 主色条  
- theme toggle：system → light → dark 循环  
- 监听 `prefers-color-scheme` 变更（仅 system 模式生效）

---

## 4. 未纳入本轮（诚实边界）

- 各业务页逐屏视觉精修 / 移动抽屉导航  
- 完整键盘陷阱审计（D4.a）  
- 对比度自动化（axe）与截图回归  
- 图表/第三方组件若有内联色仍可能需个案

---

## 5. 验证

```bash
npm run typecheck
env -u DASHSCOPE_API_KEY -u BAILIAN_API_KEY REAL_PROVIDER_SMOKE=off npm test -- --run src/theme.test.ts
npm run build
```

手动：侧栏「外观」切换三态；刷新保持；OS 主题变化时 system 跟随。

---

## 6. 下一步建议

1. D4.a：专访页 Tab/Esc/主按钮全键盘路径  
2. 首页/专访 hero 在亮色下的节奏与留白二次打磨  
3. 可选：配置页增加与侧栏同步的外观设置项（同一 storage key）

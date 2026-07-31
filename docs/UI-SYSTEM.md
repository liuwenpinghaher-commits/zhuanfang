# UI 系统规范（控件 · 间距 · 层级）

> **状态：** Wave A closed · Wave B 待开  
> **日期：** 2026-07-31  
> **真源实现：** `src/styles.css` CSS variables + 全局控件选择器  
> **验收主题：** 亮色优先，暗色同步

本文件定义全站视觉与表单的**硬规则**。页面不得再靠内联 `style={{}}` 各自发明输入框样式。

---

## 1. 目标与完成定义

### 1.1 目标
- 全站 `input` / `textarea` / `select` 观感统一、亮色下清晰、focus 可达
- 间距只走 4px 网格（`--space-*`）
- 视觉层级：页头 > 面板标题 > 字段标签 > 正文 > 辅助说明
- 主操作一眼可辨；次操作不抢主 CTA

### 1.2 Wave A 完成定义（本轮）
- [x] `--control-*` token 亮/暗齐全
- [x] 全局表单控件样式统一（含 placeholder / hover / focus / disabled）
- [x] `.field-stack` / `.form-card` / `.form-actions` 对齐
- [x] 素材库去掉内联样式，成为参考页
- [x] 视觉回归基线更新（实施后）
- [x] Docker 生产镜像含新 CSS（实施后）

---

## 2. 间距系统（Spacing）

| Token | 值 | 用途 |
| --- | --- | --- |
| `--space-1` | 4px | 紧贴微调 |
| `--space-2` | 8px | 芯片内边距、小 gap |
| `--space-3` | 12px | 字段 label→control |
| `--space-4` | 16px | 字段之间、按钮组 |
| `--space-5` | 20px | 面板内边距 |
| `--space-6` | 24px | 面板之间（view-stack） |
| `--space-7` | 32px | 区块分隔 |
| `--space-8` | 40px | 页级大留白 |

**规则**
- 禁止随意 `0.85rem` / `13px` 间距；换算到最近 `--space-*`
- `view-stack` gap = `--space-6`
- `panel` padding = `--space-5`
- 字段栈 gap（label→input）= `--space-2`（8px）
- 表单字段之间 = `--space-4`

---

## 3. 视觉层级（Hierarchy）

| 层级 | 元素 | 规格 |
| --- | --- | --- |
| H1 | `.page-header h1` | `--text-display` · weight 750 · primary |
| H2 | `.panel-title h2` | `--text-title` · weight 650 · primary |
| Label | `.field-label` | 13px · weight 650 · `--text-label` |
| Body | 段落 / 列表主文 | `--text-body` · `--text-secondary` |
| Help | `.field-help` | 12px · `--text-muted` · line-height 1.5 |
| Eyebrow | `.eyebrow` | 11px · uppercase · primary 色 |

**规则**
- 一个面板只有一个 H2
- 辅助说明永不比 label 更重/更深
- 错误文案用 `--status-danger-fg`；成功用 `--status-success-fg`

---

## 4. 表单控件（Controls）

### 4.1 Tokens

| Token | 暗色意图 | 亮色意图 |
| --- | --- | --- |
| `--control-bg` | raised 表面 | 纯白 |
| `--control-bg-hover` | 略亮 | 极浅灰 |
| `--control-border` | border-soft | 可见灰边 `#cbd5e1` 级 |
| `--control-border-hover` | 更亮边 | `#94a3b8` |
| `--control-border-focus` | action-primary | action-primary |
| `--control-text` | text-primary | text-primary |
| `--control-placeholder` | 可读 muted | `#94a3b8` 级 |
| `--control-height` | 44px | 44px |
| `--control-radius` | 12px | 12px |
| `--control-padding-x` | 14px | 14px |
| `--control-shadow-focus` | primary 环 | primary 环 |

### 4.2 行为
- 默认：实线边框 + 不透明底（**禁止**亮色下近白边消失）
- Hover：边框加深，背景微变
- Focus-visible：`box-shadow: var(--control-shadow-focus)`，outline none
- Disabled：opacity 0.55 + not-allowed
- Textarea：min-height 140px，resize vertical
- Select：与 input 同高，自定义外观尽量保持系统箭头可读

### 4.3 结构 class

```html
<label class="field-stack" for="id">
  <span class="field-label">标题</span>
  <input id="id" />
  <span class="field-help">可选说明</span>
</label>

<div class="form-actions">
  <label class="secondary-action file-button">选择文件<input type="file" class="sr-only" /></label>
  <button class="primary-action" type="button">导入</button>
  <span class="field-status is-success">完成</span>
</div>
```

- 新表单优先：`panel` + `field-stack` + `form-actions`
- `form-card` 用于嵌套在大面板内的子表单
- **禁止**在 feature 里写 `style={{ border, background, height }}` 覆盖控件

---

## 5. 按钮层级

| 类 | 用途 |
| --- | --- |
| `.primary-action` | 页/面板唯一主行动 |
| `.secondary-action` | 次要、取消、选择文件 |
| `.text-button` / `.link-button` | 三级文字链 |
| `.danger-button` | 破坏性 |
| `.icon-button` | 图标-only，方触达 ≥40px |

一屏主 CTA 不超过 1 个（面板级可各有一个）。

---

## 6. 列表与空状态

- 列表行：`.list-row`（左主文、右动作）
- 元信息：`.field-help` 或 `.list-row-meta`
- 空状态：`.empty-module` / `.empty-hint`，dashed 容器

---

## 7. 反模式（禁止）

- 原生未样式化白框贴在浅紫 panel 上
- 内联 `style={{ display: flex, gap: "0.85rem" }}` 充当布局系统
- placeholder 当 label
- 用颜色作为唯一错误指示（需文案）
- 亮色下 `#e2e8f0` 边框配白底又无 hover——边框必须可见

---

## 8. 验收清单（每页）

- [ ] 亮色：输入框边框清晰、focus 环可见
- [ ] 暗色：输入框不融进 panel
- [ ] Tab 顺序与视觉顺序一致
- [ ] 主按钮 disabled 态明确
- [ ] 无水平溢出（390 / 1440）
- [ ] 无新增内联布局样式（除动态 width % 等数据态）

---

## 9. 实施顺序

1. **Wave A** — 全局 control tokens + 表单 CSS + 素材库参考页（本轮）  
2. **Wave B** — 档案 / 专访 / 首页逐页去内联、对齐密度  
3. **Wave C** — 交互微动效与状态机视觉  
4. **Wave D** — 组件 gallery 截图 + Docker 发布检查  

**相关：** `docs/superpowers/2026-07-30-ui-visual-redesign.md`（壳层）· `docs/superpowers/2026-07-30-ui-light-theme.md`（主题）

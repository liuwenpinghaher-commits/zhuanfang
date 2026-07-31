# 全站视觉重做（2026-07-30）

> 用户请求：**全站逐页视觉重做**（在亮色主题基建之上）  
> 策略：先统一设计系统与共享原语，再抬升高频页表面；**不**为每个 feature 复制一套孤立 CSS。

---

## 1. 方法

1. 盘点 15 个 `src/features/*` 视图 —— 几乎都复用 `view-stack` / `page-header` / `panel` / `primary-action`。  
2. 抬升 **token + 共享原语** → 自动惠及全站。  
3. 重点打磨主路径表面：首页、专访启动/会话、主题芯片、资产工作台、空状态、表单。  
4. 去掉依赖外链 Unsplash 的启动背景（离线/隐私/亮色不可控）。

---

## 2. 设计系统增量

| 层 | 内容 |
| --- | --- |
| 间距 | `--space-1…8` |
| 圆角 | `--radius-xs/md/xl/pill` |
| 字号 | `--text-display/title/body/small` |
| 状态色 | `--status-*-bg/border/fg`（亮暗双套） |
| Hero | `--surface-hero` / `--surface-hero-border` |
| 修复 | `--accent-indigo` 循环引用；补 `--surface-base` |

---

## 3. 全站共享表面（所有页）

- **page-header**：hero 卡片化（渐变底 + 边框 + 更强标题层级）  
- **panel**：更轻阴影、hover 微抬、title 底部分割 + 图标着色  
- **按钮**：主按钮渐变/内高光；次按钮面板底；危险态走 status token  
- **metric / mode-option / chips / pills**：圆角与对比统一  
- **main-area**：淡 radial wash，避免「一片死灰/死黑」  
- **notice / danger-zone / 冲突警示**：主题安全，不再写死粉红 hex  

---

## 4. 主路径页表面

| 区域 | 改动 |
| --- | --- |
| 专访启动 | CSS-only 光场 hero + 玻璃内卡；去掉 Unsplash |
| 会话壳 | conversation header 微渐变；layout 间距与圆角 |
| 首页主题芯片 | pill + 轻抬 hover + badge 边框 |
| 资产工作台 | 面板/行卡片化 hover |
| 空状态 | dashed 容器 + 图标强调 |
| 表单控件 | 更高触达、focus-ring 统一 |

---

## 5. 覆盖关系

因各页共用 class，下列视图均直接受益，无需逐文件重写 TSX：

Home · Interview · Notes · Material · Asset Chat · My Assets · Search · Memory · Podcast · Profile · Config · Corpus · Themes · Track · 壳层 banner

---

## 6. 验证

```bash
npm run typecheck
env -u DASHSCOPE_API_KEY -u BAILIAN_API_KEY REAL_PROVIDER_SMOKE=off npm test -- --run src/theme.test.ts src/ui.test.ts
npm run build
```

手动：亮/暗切换下扫首页、专访启动、专访中、资产、配置。

---

## 7. 后续可加深（非阻塞）

- 单页插图/空状态插画  
- 播客播放器专用视觉  
- D4.a 键盘路径与焦点陷阱  
- Playwright 视觉快照

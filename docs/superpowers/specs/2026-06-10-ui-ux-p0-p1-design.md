# UI/UX P0-P1 Optimization Design

## Goal

Improve the current interview product prototype from a feature-complete demo into a more usable, accessible, and professionally structured workbench without changing the core business model.

This phase focuses on:

- P0 accessibility and touch usability.
- P1 navigation hierarchy and operation feedback.
- A minimal design-token foundation for later visual work.

This phase does not attempt a full redesign of every page. The interview launch screen remains immersive and simple; all other screens remain dense, professional workbench views.

## Product Positioning

The product is a private interview editor and cognitive-asset workbench. Users come here to prepare interviews, run interview sessions, collect external materials, transform sessions into assets, and inspect system configuration.

The UI should feel:

- Calm and operational.
- Information-dense but scannable.
- Transparent about AI inference and provider status.
- Human during the interview flow.
- Configurable without exposing noise on the main task path.

## Audit Findings

### Navigation

The current top-level navigation has ten equally weighted entries:

- 今日访谈台
- 实时专访
- 联网素材
- 语料学习
- 播客工作台
- 双轨笔记
- 资产库
- 长期追踪
- 系统配置
- 个人档案

This is manageable on desktop but poor on mobile. Mobile currently shows every nav item as a full-width 42px button before the user reaches page content.

### Accessibility

The current implementation lacks:

- Skip link to main content.
- Consistent focus-visible styles.
- Visible labels for several form controls.
- `aria-live` feedback for create/analyze/generate/apply operations.
- Enough touch target height for small buttons and status controls.

### Interaction Feedback

The following actions complete silently:

- Generate search brief.
- Analyze imported interview.
- Generate podcast.
- Apply PlaybookPatch.
- Save memory correction.
- Reset demo data.

The UI should show clear action status, prevent accidental duplicate actions, and expose recovery or confirmation where needed.

### Visual System

The current CSS uses many raw hex values. It works, but there is no semantic token layer for surfaces, text, border, action, success, warning, danger, focus, and shadow.

## Design Direction

### Navigation Model

Use a grouped workbench navigation model:

- 今日
  - 今日访谈台
  - 实时专访
- 素材
  - 联网素材
  - 语料学习
  - 播客工作台
- 资产
  - 双轨笔记
  - 资产库
  - 长期追踪
- 系统
  - 系统配置
  - 个人档案

Desktop keeps the sidebar but adds group labels. Mobile uses a compact grouped navigation surface with two-column items and at least 44px touch height.

### Form Model

Every input/select/textarea must have:

- Visible label.
- Helper text when the field controls non-obvious behavior.
- Stable `id` and `htmlFor`.
- At least 44px height for touch.

### Feedback Model

Introduce a lightweight `UiNotice` state:

- `kind`: success, info, warning, danger.
- `message`: visible status text.
- `detail`: optional short explanation.

Use one polite live region near the main content. Actions update the notice immediately after local deterministic operations. This prepares the UI for real async providers later without adding unnecessary complexity in this phase.

### Design Tokens

Add semantic CSS tokens under `:root`:

- Surface: app, panel, muted, raised.
- Text: primary, secondary, muted, inverse.
- Border: default, strong.
- Action: primary, primary-hover, accent, danger.
- Focus: ring.
- Radius and shadow.
- Transition duration and easing.

Do not migrate every CSS rule in this phase. Prioritize shared components and interactive states.

### Touch and Keyboard

Minimum interactive size:

- Primary/secondary/nav buttons: 44px.
- Status action buttons: 36px visually but 44px effective height in this phase.
- Icon buttons: 44px square.

Keyboard:

- Add skip link.
- Add `:focus-visible` ring.
- Preserve tab order based on DOM order.

### Interview Launch

Keep the immersive launch screen:

- Theme/title.
- Why now.
- Opening question.
- One source/material summary when present.
- Start button.

Do not show full provider config, asset counts, or search result lists on the launch screen.

## Business Logic Adjustments

This phase does not change domain model behavior. It improves UI-level workflow clarity:

- Search brief creation shows feedback and selects the created brief.
- Corpus analysis shows feedback and makes new patches discoverable.
- Podcast generation shows feedback and keeps selected note.
- Patch approval shows feedback and moves the user to system configuration.
- Reset should require browser confirmation before destructive state reset.

## Acceptance Criteria

- All form fields in search, corpus learning, podcast, assets search, profile correction have visible labels.
- Navigation is visually grouped on desktop.
- Mobile navigation no longer appears as one long undifferentiated list.
- No interactive control is below 44px effective height except non-interactive status pills.
- Keyboard focus is visible on all buttons, links, inputs, textareas, and selects.
- A skip link lets keyboard users jump to main content.
- Actions show a visible live-region notice.
- `npm test -- --run` passes.
- `npm run build` passes.
- Browser verification confirms core flows still work:
  - create search brief
  - enter launch screen from brief
  - start interview
  - analyze corpus
  - generate podcast
  - apply patch
  - view system config
- Mobile 390px has no horizontal overflow on key screens.

## Deferred to Phase 2

- Full asset-library redesign into list/detail panel.
- Real tabbed system configuration.
- Toast auto-dismiss lifecycle.
- Dark mode.
- Route/deep-link support.
- Full component extraction from `App.tsx`.
- Chart library replacement for cognitive radar.

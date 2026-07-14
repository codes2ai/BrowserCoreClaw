# Design QA — Google 新闻监控 v0.4.4

**Evidence**

- Source problem screenshot: `/var/folders/g2/r66gs5k91ks54x8_tm4935mh0000gn/T/codex-clipboard-1e8bef05-9091-45a2-8724-c63de96acd5a.png`
- Source table-layout screenshot: `/var/folders/g2/r66gs5k91ks54x8_tm4935mh0000gn/T/codex-clipboard-1e6fd18e-faa3-4181-aca0-9f9f1971d499.png`
- Source inline-help screenshot: `/var/folders/g2/r66gs5k91ks54x8_tm4935mh0000gn/T/codex-clipboard-61e20205-ac13-4ce4-b746-bb92f9ad53ce.png`
- Browser-rendered implementation: `design-qa-artifacts/google-news-v3-compact-header-390x844.jpg`
- Normalized focused comparison: `design-qa-artifacts/google-news-v3-header-comparison.png`
- Adaptive data-table evidence: `design-qa-artifacts/google-news-v031-data-bottom-actions-440x1118.jpg`
- Adaptive records-table evidence: `design-qa-artifacts/google-news-v031-records-bottom-actions-440x1118.jpg`
- Fixed parameter-actions evidence: `design-qa-artifacts/google-news-v040-params-fixed-actions-440x1118.jpg`
- Record-filter evidence: `design-qa-artifacts/google-news-v040-record-filters-440x1118.jpg`
- Inline-help implementation: `design-qa-artifacts/google-news-v041-title-guide-390x844.jpg`
- Inline-help source/implementation comparison: `design-qa-artifacts/google-news-v041-guide-comparison.png`
- Modal implementation: `design-qa-artifacts/google-news-v042-guide-modal-390x844.png`
- Closed/open modal comparison: `design-qa-artifacts/google-news-v042-guide-modal-comparison.png`
- Viewports: 390 × 844, 440 × 1118, and 1280 × 720
- States: Google 新闻监控 / 运行参数, 运行记录, 数据 / empty local-preview data / collapsed run options / 使用说明弹窗 closed and open

**Full-view comparison evidence**

The source screenshot is evidence of the rejected state, not a visual target to reproduce. Its back control and introduction hero consume the complete visible region before any working parameters appear. In v0.3.0, the back control ends at 42 px, the feature header is 52 px high, the page tabs end at 147 px, and the first keyword input begins at 348 px. The functional form is visible in the first viewport with no document-level horizontal overflow.

**Focused region comparison evidence**

The normalized top-region comparison shows the intended hierarchy change: the eyebrow, tags, and multi-line description are removed; title, version, and run action share one compact row; tabs and task status immediately follow. This directly addresses the user's request to prioritize the feature workspace over introductory content.

The v0.4.1 source/implementation comparison places the supplied inline question-mark pattern and the rendered feature toolbar in one image. The implementation preserves the reference's compact text-plus-question-icon affordance while fitting the existing side-panel title row. The help entry sits beside the version badge; the normal tab strip now contains only 运行参数、运行记录 and 数据.

The v0.4.2 closed/open comparison uses the established 390 × 844 feature screen as the baseline and places the rendered modal state beside it. This is intentionally an interaction-state comparison rather than a pixel-identical source match: the title entry and underlying workspace stay in place while the instructions appear in a centered, dimmed overlay.

**Required fidelity surfaces**

- Fonts and typography: the existing system Chinese/Latin stack is preserved. The title remains at the compact 17 px tool-title scale; the help entry uses a compact 10 px label with ellipsis-safe title layout.
- Spacing and layout rhythm: the feature header remains 52 px high at the 390 × 844 target viewport. The modal is 366 × 527 px with 12 px side margins, fits fully inside the viewport, and does not introduce document-level overflow. Existing card, field, tab, and sticky-action spacing remains consistent beneath the overlay.
- Colors and visual tokens: existing blue actions, neutral surfaces, semantic notices, borders, and focus treatment are preserved; no new palette was introduced.
- Image quality and assets: the question-circle icon is a local SVG asset sourced from Bootstrap Icons, with its MIT license included in `src/assets/icons/`. It renders at its native 14 × 14 slot without stretching.
- Copy and content: long introductory copy and decorative tags remain removed from the primary workspace. The inline entry uses the requested “使用说明” wording, and the former page content is now presented in a concise modal with an explicit “知道了” action.

**Interactions and functional checks**

- Google tab preparation: mocked Chrome Tabs API test passed for both auto-create and reuse paths.
- Polling control: enabled state exposes an active 1–1440 minute interval field; implementation uses a repeated round loop and an interruptible wait between rounds.
- Stop behavior: available while collecting and while waiting for the next polling round.
- Feature lifetime: returning to the catalog hides the mounted feature instead of unmounting it. A changed keyword remained intact after catalog → reopen, proving that the same task/UI instance survives this navigation.
- Run records: each keyword attempt creates its own row with keyword, round, status, data count, and duration.
- Record retention: automated check passed with 205 fixtures for each of six status groups; the retained result was exactly 200 per group and 1200 total.
- Record filters: keyword and status selectors render in the records page; selecting the `error` status updated the UI state, and an automated keyword + status combination check returned only the matching record.
- Export controls: JSON and table/CSV actions are present on the data page and disabled when no data exists.
- Bottom actions: record clearing and data export/clearing controls render in the persistent bottom action bar, not inside the table header.
- Parameter actions: at both 440 × 1118 and 440 × 720, the parameter action bar remains at the viewport bottom. With expanded options at 440 × 720, the workspace client height is 398 px and scroll height is 1097 px, while the footer remains at y=611–695.
- Adaptive tables: at 440 × 1118 the records and data table shells grow to 687 px, while the action bar ends at y=1093 in the 1118 px viewport. The document remains exactly one viewport high, so there is no blank document area below the feature.
- Export serialization: passed with commas, embedded quotes, Unicode BOM, and spreadsheet-formula neutralization.
- Responsive layout: 390 px document width equals viewport width; no page-level overflow.
- Inline help: title, `v0.4.2`, “使用说明” and the run action fit in the compact header at 390 × 844. Clicking the only 使用说明 trigger opens one `aria-modal` dialog, sets `aria-expanded="true"`, and moves focus to the close button.
- Modal dismissal: the top-right X, the “知道了” action and Escape all close the dialog, restore `aria-expanded="false"`, and return focus to the title-row trigger.
- Page preservation: opening and closing the instructions from 数据(0) leaves 数据(0) selected. The visible feature tabs remain exactly 运行参数、运行记录(0) and 数据(0); the help content no longer replaces the workspace.
- Browser console warnings/errors: none.
- Keyword interval: the form exposes a millisecond range such as `100 - 1000 ms`; each keyword gap samples the range again. JSON mode receives the min/max pair, legacy single-value settings are migrated, reversed bounds are normalized, and an automated wait-path check confirms a seeded midpoint is passed to the real wait function.

**Findings**

No actionable P0, P1, or P2 visual or interaction findings remain for the local side-panel UI.

**Comparison history**

- P1 before: the introduction hero occupied the initial viewport and hid the working form. Fix: replaced it with a one-row 52 px feature toolbar and shortened the back control. Post-fix evidence: `google-news-v3-header-comparison.png`.
- P1 before: polling parameters existed but the run stopped after one round. Fix: added continuous rounds, interruptible polling waits, next-run status, and round counts.
- P1 before: running required a manually prepared Google page. Fix: added Google-tab discovery and automatic creation.
- P2 before: data had no export path. Fix: added tested JSON and CSV/table downloads.
- P2 before: table height was capped and left a large blank area below the feature; table controls also consumed space above the table. Fix: made both table pages fill the remaining viewport, moved their controls into the persistent bottom action bar, and kept overflow inside the table shell.
- P1 before: returning to the feature catalog unmounted Google 新闻监控 and stopped its active capture. Fix: catalog/settings navigation now preserves the mounted feature instance; reopening the same feature restores its live state.
- P2 before: one batch produced a single summary record and all statuses shared a 200-row cap. Fix: records are now generated per keyword attempt, retained at 200 rows per status, and filterable by keyword and status.
- P2 before: parameter actions only appeared after scrolling through the form. Fix: the parameter workspace now scrolls internally beneath a persistent bottom action bar.
- P1 before: the first compact-help implementation inherited the global button font rule and wrapped below the title at 390 px (76.5 px header, 96 px help button). Fix: scoped the compact button typography to the Google 新闻 monitor and set a single-line 24 px control. Post-fix evidence measures a 52 px header, a 71.88 px help button, no overflow, and all title-row items aligned.
- P1 before: clicking the title-row help entry replaced the active workspace with a standalone instructions page. Fix: moved the same content into an accessible modal and kept the current tab mounted beneath it. Post-fix evidence shows the modal contained at 366 × 527 px, keyboard dismissal working, and 数据(0) remaining selected across open/close.
- P1 before: the web preview handled only the first keyword, so its keyword-interval branch was never reached; millisecond input also made short values appear ineffective. Fix: both preview and extension paths now iterate all keywords through the same seconds-to-milliseconds wait helper, show a visible waiting message, and expose the interval in the collapsed options summary.

**Follow-up polish**

- P3: reload the unpacked extension and run a two-round live polling task to confirm the installed Chrome debugger lifecycle, per-keyword record transitions, and download prompts in the user's profile.

final result: passed

---

## 功能列表图标网格（2026-07-14）

### 测试范围

- **参考图：** `/var/folders/g2/r66gs5k91ks54x8_tm4935mh0000gn/T/codex-clipboard-4ca25d4c-fad2-4ea8-9756-1d700118e113.png`
- **实现页面：** `http://127.0.0.1:4173/sidepanel.html`
- **验证视口：** 428 × 800（浏览器侧边栏宽度）
- **参考解读：** 采用参考图的“紧凑图标 + 名称”网格排版；平台缩写图标沿用产品既有视觉，而非引入参考图中的第三方站点 Logo。

### 已验证交互

- 每个分组内功能按固定宽度、左对齐的图标网格排列；侧边栏宽度下，三个功能可在一行展示。
- 功能图标点击后可进入对应功能页面，且可通过“功能列表”返回主界面。
- 每个图标右上角的问号可悬停、点击或键盘聚焦，显示该功能简介。
- 窄屏下提示气泡最大宽度受限；实测 428px 视口中，提示框边界为 `x=3.25`、`right=147.25`，未溢出左侧页面边界。
- 控制台错误：无。

### 对比与修正记录

1. 初版使用自动填充的弹性列，单个或少量功能会被居中拉伸，不符合参考图的紧凑排列。
2. 改为固定图标轨道、左对齐的网格，并收窄组内间距，使各平台分组的视觉密度一致。
3. 初版问号提示在侧边栏左侧可能越界；已增加响应式最大宽度，复验通过。

### 结论

没有遗留的 P0/P1/P2 视觉或交互问题。

**Final result:** passed

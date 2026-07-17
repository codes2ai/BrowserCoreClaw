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
- Keyword interval: every feature defaults to `1000 - 6000 ms`; each task gap samples the range again. JSON mode receives the min/max pair, legacy single-value settings are migrated, reversed bounds are normalized, and an automated wait-path check confirms a seeded midpoint is passed to the real wait function.

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

# Design QA — 数据标识详情弹窗（2026-07-17）

## Evidence

- Source visual truth: `/var/folders/g2/r66gs5k91ks54x8_tm4935mh0000gn/T/codex-clipboard-9ea4fc3e-4a02-4087-83d0-6849628ce31c.png`
- Browser-rendered implementation: `/Users/hmcm/work/codex/BrowserCoreClaw/.qa-artifacts/transfer-data-detail-desktop.jpg`
- Browser preview: `http://127.0.0.1:4207/sidepanel.html`；桌面视口 1280 × 720，响应式视口 390 × 844。
- Compared state: 数据传输 / 数据 Tab / 点击首条“标题 / 唯一标识”后的数据详情弹窗。

## Findings

No actionable P0, P1, or P2 visual, responsive, accessibility, or core-interaction findings remain.

- Visual hierarchy: 参考图标注的数据标识单元格保持原表格位置与两行信息结构；实现只把该区域转为可聚焦的详情入口，弹窗继续沿用现有墨绿、浅灰表面、细边框和圆角体系。
- Full-field display: 弹窗直接遍历当前记录的原始对象，本地预览首条记录实测展示 9 / 9 个字段；普通值、空值、长文本、链接、数组和对象均使用对应的可读格式。
- Layout: 桌面弹窗为 900 × 672 px，完整位于 1280 × 720 视口内；字段内容在弹窗内部滚动，页面没有水平溢出。
- Responsive behavior: 390 × 844 下弹窗边界为 x=10–380、y=10–834，字段名和值切换为单列，页面仍无水平溢出。
- Accessibility: 弹窗使用 `role="dialog"`、`aria-modal="true"` 和标题关联；打开后焦点进入关闭按钮，Escape 关闭后焦点回到原数据标识，页面滚动锁同步恢复。
- Link safety: 仅 `http:` 与 `https:` 字符串会渲染为可点击链接，并使用新窗口与 `rel="noreferrer"`；其余字段按文本或格式化 JSON 展示。

## Primary interactions tested

- 从主导航进入“数据传输”，点击唯一的“Kimi 最新动态”数据标识，弹窗正常打开。
- 弹窗字段计数为 9，两个安全链接、数组 `tags` 与对象 `metadata` 均正确呈现。
- Escape 关闭弹窗后，`dialogOpen=false`、`bodyOverflow` 恢复为空，活动焦点回到“查看数据详情：Kimi 最新动态”。
- 桌面与移动端均无文档级横向溢出；最新页面调试日志为空。
- `npm run check` 与 `git diff --check` 通过。

## Comparison history

- Pass 1: 数据标识仅展示标题和链接，无法查看采集记录中未上表的原始字段。Fix: 将标识单元格改为详情入口，并新增完整原始字段弹窗。
- Pass 2: 浏览器默认焦点描边颜色与现有绿色交互体系不一致。Fix: 为弹窗按钮补充项目统一的绿色半透明焦点环，并重新进行桌面同屏视觉比较。
- Pass 3: 验证桌面、移动端、Escape、焦点恢复、内部滚动与安全链接；未发现新的 P0/P1/P2 问题。

final result: passed

---

## 运行器三栏字段配置（2026-07-17）

### Evidence

- Source visual truth: `/var/folders/g2/r66gs5k91ks54x8_tm4935mh0000gn/T/codex-clipboard-6ff301cb-0b5b-49b3-972f-1d29699620cf.png`
- Browser preview: `http://127.0.0.1:4173/sidepanel.html`
- Compared state: 设置 / 运行器；来源为 `xiaohongshu/keyword-search`，配置目标为 `xiaohongshu/post-detail` 与 `google/google-news`。

### Verification

- 桌面状态按参考图拆为“功能列表 / 可调用能力 / 字段配置”三栏；1600px 验收视口的计算列宽为 `421.539px / 540.445px / 508.008px`，页面无水平溢出。
- 中栏每个平台能力列表的 `distinctLeftEdges` 均为 1，确认所有目标能力维持单列排列。
- 点击未启用能力会同时加入白名单并聚焦右侧配置；已启用能力之间可以独立切换配置。
- 右栏覆盖目标能力的输出字段、自动输入参数、结果数（能力支持时）、并发数、调用间隔与强制更新策略。
- Google 能力并发数从 1 改为 3、取消 `title` 字段后，切换至其他能力再返回，参数仍为 3，字段仍保持未选中。
- 最新本地预览无当前端口的 error/warning 日志；`npm run check` 与 `git diff --check` 通过。

### Findings

No P0/P1/P2 visual, responsive, or core-interaction findings remain.

final result: passed

---

# Design QA — 数据传输筛选工作台（2026-07-17）

## Evidence

- Source visual truth: `/Users/hmcm/.codex/generated_images/019f5983-5d35-7590-b2ab-06f9a0aef0c1/exec-addd3f6a-f07a-432e-aa72-128c20404d48.png`
- Saved source: `/Users/hmcm/work/codex/BrowserCoreClaw/.qa-artifacts/transfer-filter-reference.png`
- Browser-rendered data view: `/Users/hmcm/work/codex/BrowserCoreClaw/.qa-artifacts/transfer-filter-data-desktop.jpg`
- Browser-rendered task view: `/Users/hmcm/work/codex/BrowserCoreClaw/.qa-artifacts/transfer-filter-tasks-desktop.jpg`
- Browser-rendered mobile view: `/Users/hmcm/work/codex/BrowserCoreClaw/.qa-artifacts/transfer-filter-mobile.jpg`
- Same-input full-view comparison: `/Users/hmcm/work/codex/BrowserCoreClaw/.qa-artifacts/transfer-filter-comparison.jpg`
- Browser preview used: `http://127.0.0.1:4174/sidepanel.html`; desktop viewport 1280 × 900, responsive check 390 × 844.
- State compared: 数据传输 / 数据 Tab / 紧凑筛选默认收起；同一工作台还验证了任务 Tab 的失败状态与错误信息。

## Findings

No actionable P0, P1, or P2 findings remain.

- Fonts and typography: 沿用现有 BrowserCoreClaw 的标题、正文和 11–14px 表格字体层级；表格主标识与次级链接采用明确的粗细和截断规则，密集数据仍可扫描。
- Spacing and layout rhythm: 保持参考图“标题 → Tab → 筛选 → 表格”的数据优先顺序；完整筛选收起为紧凑入口，展开后使用三列字段网格，避免默认状态挤压表格高度。
- Colors and visual tokens: 使用项目既有墨绿、浅灰表面、细边框与绿色/蓝色/红色/灰色状态色；传输中、成功、失败、无需传输在数据与任务表保持一致。
- Image quality and asset fidelity: 此页面没有新增图片、Logo 或插画资产；同屏对比中保留现有项目品牌标记，未用占位图、手绘 SVG 或 CSS 图形替代视觉资源。
- Copy and content: 数据 Tab 明确区分“本地已保存”和“传输状态”；任务 Tab 增加触发来源、数据范围、进度和错误信息，远程未接入状态也不会误导为已上传。
- Focused comparison: 同屏对比文件覆盖标题、Tab、筛选工具栏和表格密度。参考稿为更偏演示的数据大表；实现按照现有应用的全局头部与卡片系统适配，并保留了参考稿的核心层级和筛选入口。

## Primary interactions tested

- 从全局导航进入“数据传输”，本地网页预览可显示聚合示例数据与任务。
- 数据 Tab：展开筛选后选择“微博”，列表从 5 条收敛为 1 条，状态统计同步更新。
- 任务 Tab：切换 Tab 后可见 4 条任务；展开筛选并选择“失败”，仅保留失败任务且显示“远程归档服务尚未连接。”错误信息。
- 数据与任务均可独立展开/收起筛选条件、清空条件、刷新本地聚合结果，并具备分页状态。
- 390 × 844 响应式检查：`document.documentElement.scrollWidth` 与 `body.scrollWidth` 均为 390，表格通过内部横向容器处理宽列，无页面横向溢出。
- 浏览器控制台：最新预览页没有 error 日志。

## Comparison history

- Pass 1: 发现筛选默认展开会让小数据量页面的表格视觉重心下移，与参考稿的数据优先布局不一致。
- Fix: 将数据与任务的高级筛选默认改为收起，保留“展开筛选”操作与全部筛选字段。
- Pass 2: 重新捕捉桌面数据视图、任务视图、移动视图并制作同屏比较；表格在首屏获得更高优先级，筛选仍可完整访问，未发现新的 P0/P1/P2 问题。

## Follow-up polish

- P3: 远程存储接入后，可在当前禁用按钮位置加入连接目标与批次发起操作，并将真实传输任务写入独立归档索引。

final result: passed

---

## 全局头部与数据传输占位页（2026-07-17）

### Evidence

- Source visual truth: `/var/folders/g2/r66gs5k91ks54x8_tm4935mh0000gn/T/codex-clipboard-94d0e9bc-8f82-49fc-a159-72238c979104.png`
- Browser-rendered feature page: `.qa-artifacts/header-feature-google-desktop.png`
- Browser-rendered data-transfer page: `.qa-artifacts/header-transfer-desktop.png`
- Browser-rendered mobile data-transfer page: `.qa-artifacts/header-transfer-mobile.png`
- Full-view and focused-header comparison: `.qa-artifacts/header-comparison-final.png`
- Viewport: desktop `1280 × 720`; mobile `390 × 844`
- State: Google 新闻监控功能页；数据传输占位页；设置页主导航切换。

### Full-view comparison evidence

用户提供的参考头部包含左侧品牌、右侧主导航、激活项底部标记和浅色分隔线。实现将同一全局头部保留在功能页顶部，移除与顶部“功能列表”重复的页内返回按钮；在右侧新增“数据传输”，其余“功能列表”“设置”入口保持可用。数据传输页沿用现有设置页的页面宽度、背景、边框和排版语言，并明确标识为不会发送本地数据的占位页。

### Focused region comparison evidence

对照图将参考头部和 Google 新闻监控功能页顶部置于同一画面。两侧均保持左品牌、右导航和激活下划线的空间关系；实现因本次需求新增第三个“数据传输”导航项，属于预期差异。功能页截图确认标题、Tab 与运行按钮完整位于全局头部之下，没有被导航遮挡。

### Required fidelity surfaces

- Fonts and typography: 沿用现有系统字体、品牌字重和 13px 主导航字号；数据传输页标题与设置页标题保持同一层级和行高。
- Spacing and layout rhythm: 全局头部维持既有 72px 桌面高度和 64px 移动高度；功能页通过统一高度变量重新计算固定操作区，Google 新闻监控在 `1280 × 720` 下无底部遮挡。
- Colors and visual tokens: 复用现有白色头部、浅灰分隔线、深绿色激活色及绿色底部标记；数据传输占位状态不伪装成已连接或成功同步。
- Image quality and asset fidelity: 沿用现有 BC 品牌标识，无新增或替代图像资产、占位插图或手绘图形。
- Copy and content: “数据传输”“远程归档准备中”“不会读取、上传或传输任何本地数据”清晰说明当前边界；同步范围覆盖采集数据、任务记录和功能配置。

### Primary interactions tested

- 从功能列表进入 Google 新闻监控后，全局头部持续可见。
- 从功能页通过“功能列表”返回目录，再通过“数据传输”打开占位页。
- “数据传输”处于激活状态，远程存储按钮为禁用态，页面不触发任何传输操作。
- 从数据传输页切换到设置页，设置页标题和主导航激活态正常。
- 移动端 `390 × 844` 下，三项主导航无横向溢出；数据传输范围卡片改为单列。
- 浏览器控制台未发现页面脚本错误。

### Findings

No P0/P1/P2 visual, responsive, accessibility, or core-interaction findings remain.

### Comparison history

- Pass 1: 完成参考头部与功能页全局导航的同屏对照；未发现需要修复的 P0/P1/P2 差异。新增的“数据传输”标签为用户明确要求，保留为有意差异。
- Pass 2: 在移动端检查三项主导航与数据传输占位内容，确认无横向溢出或控制项裁切。

### Follow-up polish

- P3: 远程存储接入后，可在此页增加连接配置、同步范围选择、最近一次归档记录和失败重试能力。

final result: passed

---

## 运行器映射交互（2026-07-17）

### Evidence

- Source visual truth: `/var/folders/g2/r66gs5k91ks54x8_tm4935mh0000gn/T/codex-clipboard-83a51ceb-36c6-4483-95f7-a3ccaa230b46.png`
- Browser-rendered full implementation: `.qa-artifacts/runner-capabilities-cdp-full.png`
- Focused source/implementation comparison: `.qa-artifacts/runner-capabilities-comparison.png`
- Viewport: `1280 × 720` CSS px at DPR 2; full-page evidence is `2560 × 2892` px.
- State: 设置 / 运行器；来源为“小红书 / 关键词搜索”；已启用“小红书正文采集”。

### Full-view comparison evidence

实现保留既有“左侧来源功能、右侧可调用能力”的双栏关系与绿色选中态。右侧每个能力从“名称、内部 ID、功能简介”收敛为“名称、内部 ID”，平台分组、多选复选框、已启用计数和已选目标回显均保持原位，页面层级没有因本次精简而重排。

### Focused region comparison evidence

`.qa-artifacts/runner-capabilities-comparison.png` 将用户标注的旧能力列表与本轮浏览器渲染结果并排。旧卡片中红框标出的说明句已全部移除；新卡片与左侧来源列表一致，均使用能力名称作为主信息、Runner ID 作为次信息。右侧卡片高度从内容驱动的多行布局统一为 54px，选中与未选状态仍清晰可辨。

### Required fidelity surfaces

- Fonts and typography: 复用现有系统中文字体、12px 能力名称与 10px 等宽 Runner ID；右侧名称字重与左侧统一为 750，文本均单行截断。
- Spacing and layout rhythm: 来源和目标卡片实测高度均为 54px；目标卡片改为垂直居中，复选框、名称和 ID 的间距与左侧两行结构一致。
- Colors and visual tokens: 继续使用现有绿色边框、浅绿选中背景、白色卡片与灰色次文本，没有引入新色板或状态语义。
- Image quality and asset fidelity: 本区域不包含图片资产；复选框继续使用现有原生控件结构，没有新增或替换图标。
- Copy and content: 右侧 10 个候选能力均只显示名称与 Runner ID；浏览器实测额外功能简介数量为 0。

### Interactions and functional checks

- 勾选“Google 新闻监控”后，已启用计数从 1 更新为 2，已选目标即时加入该能力，保存按钮由禁用变为可用。
- 切换左侧来源至“Google 新闻监控”后，右侧来源标题与 ID 同步更新，来源能力不会出现在自己的目标候选中。
- 切回“小红书 / 关键词搜索”并取消测试勾选后，原始 1 个目标恢复，保存按钮重新禁用，未留下测试配置。
- 来源卡片和目标卡片的浏览器测量高度均为 54px；目标说明文本计数为 0。
- `npm run check`、`git diff --check` 通过；浏览器控制台无 warning/error。

### Findings

No actionable P0/P1/P2 visual, responsive, accessibility, or core-interaction findings remain.

### Comparison history

- P2 before: 右侧能力卡片同时展示 Runner ID 与多行功能简介，导致列表密度高于左侧来源列表，扫描路径不一致。Fix: 从 Runner 展示模型和目标卡片中移除 `description`，统一为名称 + ID，并将卡片高度、间距和字重对齐左侧。Post-fix evidence: `.qa-artifacts/runner-capabilities-comparison.png`。

### Follow-up polish

- P3: 当 Runner 数量继续增长时，可再为左右两栏增加按名称或 ID 搜索；当前 11 个能力无需额外筛选控件。

final result: passed

---

## 运行器目标能力固定单列（2026-07-17）

### Evidence

- Source visual truth: `/var/folders/g2/r66gs5k91ks54x8_tm4935mh0000gn/T/codex-clipboard-7d22731e-f6c6-4c7c-b67b-80c84dfebd0a.png`
- Browser-rendered full implementation: `.qa-artifacts/runner-capabilities-single-column-full.png`
- Focused source/implementation comparison: `.qa-artifacts/runner-capabilities-single-column-comparison.png`
- Viewport: `1280 × 720` CSS px at DPR 2; full-page CSS content height为 `1630px`。
- State: 设置 / 运行器；来源为“小红书 / 关键词搜索”；已启用“小红书正文采集”。

### Full-view comparison evidence

右侧四个平台的目标能力列表均改为固定单列，每项能力独占一行。左侧来源列表、平台分组、已选目标、清空配置与底部保存区均保持原有结构；单列带来的额外页面高度通过正常页面滚动承载，没有增加栏内滚动或裁切。

### Focused region comparison evidence

`.qa-artifacts/runner-capabilities-single-column-comparison.png` 将用户标注的双列状态与实现并排。参考图中微博首行的两张并排卡片，在实现中已按“微博博主博文采集、微博博主信息采集、微博正文采集”顺序逐行展示；Google、抖音和小红书使用相同规则。

### Required fidelity surfaces

- Fonts and typography: 名称、Runner ID、字重、字号和截断规则未改动，单列只影响排列方式。
- Spacing and layout rhythm: 四个目标分组的计算样式均只有一个网格轨道；每组卡片左边缘实测只有一个，卡片宽度统一为 `651px`。
- Colors and visual tokens: 现有边框、背景、选中绿和分组表面完全保留。
- Image quality and asset fidelity: 本区域不包含图片资产，本轮没有新增或替换图标。
- Copy and content: 10 个候选能力及名称、Runner ID 均完整保留，没有因单列化改变内容或排序。

### Interactions and functional checks

- 桌面 `1280px` 视口下，Google、微博、抖音、小红书四个目标分组的 `distinctLeftEdges` 均为 1，确认不存在第二列。
- 默认“小红书正文采集”仍为唯一选中项，顶部继续显示“1 个已启用”；保存按钮保持禁用，说明验证没有产生设置修改。
- 页面 `scrollWidth` 与视口宽度均为 `1280px`，无横向溢出。
- `npm run check`、`git diff --check` 通过；浏览器控制台无 warning/error。

### Findings

No actionable P0/P1/P2 visual, responsive, accessibility, or core-interaction findings remain.

### Comparison history

- P2 before: 宽屏下目标能力使用两列网格，同一平台的能力会并排展示，不符合“一行一个能力”的明确要求。Fix: 将 `.settings-runner-target-list` 的网格轨道固定为单列，并移除移动端重复覆盖。Post-fix evidence: `.qa-artifacts/runner-capabilities-single-column-comparison.png`。

### Follow-up polish

- 无；本次为明确的固定排列约束，不保留多列变体。

final result: passed

---

## 功能列表图标网格（2026-07-14）

### 测试范围

- **参考图：** `/var/folders/g2/r66gs5k91ks54x8_tm4935mh0000gn/T/codex-clipboard-4ca25d4c-fad2-4ea8-9756-1d700118e113.png`
- **实现页面：** `http://127.0.0.1:4173/sidepanel.html`
- **验证视口：** 1280 × 900（浏览器完整控制台标签页）
- **参考解读：** 采用参考图的“紧凑图标 + 名称”网格排版；平台缩写图标沿用产品既有视觉，而非引入参考图中的第三方站点 Logo。

### 已验证交互

- 每个分组内功能按固定宽度、左对齐的图标网格排列；完整控制台标签页中按可用宽度自然换行展示。
- 功能图标点击后可进入对应功能页面，且可通过“功能列表”返回主界面。
- 每个图标右上角的问号可悬停、点击或键盘聚焦，显示该功能简介。
- 窄屏下提示气泡最大宽度受限；实测 428px 视口中，提示框边界为 `x=3.25`、`right=147.25`，未溢出左侧页面边界。
- 控制台错误：无。

### 对比与修正记录

1. 初版使用自动填充的弹性列，单个或少量功能会被居中拉伸，不符合参考图的紧凑排列。
2. 改为固定图标轨道、左对齐的网格，并收窄组内间距，使各平台分组的视觉密度一致。
3. 初版问号提示在窄视口左侧可能越界；已增加响应式最大宽度，复验通过。

### 结论

没有遗留的 P0/P1/P2 视觉或交互问题。

**Final result:** passed

---

## 全局设置页面（2026-07-15）

### Evidence

- Source visual truth: `/var/folders/g2/r66gs5k91ks54x8_tm4935mh0000gn/T/codex-clipboard-331b32b8-f024-4e5b-a93e-25ec41c30892.png`
- Browser-rendered full implementation: `.qa/settings-desktop.png`
- Focused source/implementation comparison: `.qa/settings-tabs-comparison.png`
- Desktop viewport: 1280 × 768
- Responsive viewport: 390 × 844
- State: 设置 / 基础 active; Limit and 存储 also opened and inspected

### Full-view comparison evidence

The source provides the horizontal settings-navigation pattern rather than a complete product settings screen. The implementation keeps the existing BrowserCoreClaw header and design tokens, then places a compact, full-width category strip directly below the settings heading. The active category uses the same thin warm-red underline and neutral inactive labels as the reference. The settings content below the strip deliberately follows the product's existing white surface, green scope badge, compact form-control, and border system.

### Focused region comparison evidence

`.qa/settings-tabs-comparison.png` places the 1222 × 50 source navigation above the 1132 × 46 implementation capture. The implementation matches the source's single-row rhythm, low-height divider, centered tab labels, thin active underline, and quiet inactive state. It contains only 基础、Limit、存储 because those are the requested product categories. Reference-specific GitHub destinations and icons are intentionally not copied.

### Required fidelity surfaces

- Fonts and typography: the existing Inter/system Chinese stack is preserved. Category labels use 13 px semibold text and retain clear active/inactive hierarchy. Form titles, labels, descriptions, helper text, and values remain readable at desktop and 390 px.
- Spacing and layout rhythm: the reference's 40 px navigation is represented by a 46 px strip, including a practical pointer/touch target. Desktop form rows use a two-column information/control layout; at 390 px they collapse to one column without horizontal overflow.
- Colors and visual tokens: the reference's warm-red active underline is preserved while surfaces, input focus, status notices, and scope badges reuse BrowserCoreClaw's existing green and neutral tokens.
- Image quality and asset fidelity: the reference does not prescribe product imagery. The configurable Logo uses the uploaded raster image at native aspect ratio with `object-fit: cover`; the product's existing BC fallback remains sharp at both header and preview sizes.
- Copy and content: 基础 explains global name/Logo behavior, Limit describes the 120-second task maximum and failure behavior, and 存储 clearly states that only local storage is currently available.
- Icons: GitHub-specific reference icons were not relevant to the three requested BrowserCoreClaw categories, so no placeholder or custom icon substitutes were introduced.

### Interaction and functional checks

- The 基础、Limit and 存储 categories each open their matching region and expose semantic labels.
- Changing the name enabled 保存设置; saving updated both the header brand and document title immediately and displayed a success notice.
- 恢复全部默认值 followed by 保存设置 restored BrowserCoreClaw and removed test state.
- Limit displayed 120 秒 / S by default and exposed the requested 10–86400 input range.
- 存储 displayed 本地（当前使用）; 其他（即将支持） was visible and disabled.
- Logo upload validates PNG/JPG/WebP/GIF and a 1 MB maximum; default-logo restoration is disabled when no custom Logo exists.
- At 390 × 844, document `scrollWidth` and `clientWidth` were both 390; no page-level horizontal overflow occurred.
- Browser console warnings/errors: none.
- Automated validation covered settings normalization, default values, unsupported-storage fallback, timeout rejection, and timeout-triggered stop behavior.

### Findings

No actionable P0, P1, or P2 visual, responsive, accessibility, or core-interaction findings remain.

### Comparison history

- Pass 1: no P0/P1/P2 mismatch was found. The reference navigation pattern, existing application design system, responsive form behavior, and required settings interactions were all present, so no corrective visual iteration was required.

### Follow-up polish

- P3: validate a real custom Logo upload in the unpacked Chrome extension after reload; browser automation verified the control and validation states but did not attach a user image.

final result: passed

---

# Design QA — 紧凑列设置

- Source visual truth: `/var/folders/g2/r66gs5k91ks54x8_tm4935mh0000gn/T/codex-clipboard-45724cd0-83f4-4685-84ad-f8ef85feacd2.png`
- Saved reference: `/Users/hmcm/work/codex/BrowserCoreClaw/artifacts/column-settings-reference.png`
- Implementation screenshot: `/Users/hmcm/work/codex/BrowserCoreClaw/artifacts/column-settings-compact.png`
- Side-by-side evidence: `/Users/hmcm/work/codex/BrowserCoreClaw/artifacts/column-settings-comparison-desktop.png`
- Viewport: implementation 1280 × 720；comparison 1280 × 800
- State: Google 新闻监控 / 数据 Tab / 列设置浮层展开 / 7 个字段全部显示

## Full-view comparison evidence

参考图使用紧凑入口触发字段浮层，字段以单列勾选清单展示，底部提供重置操作。实现保持相同的信息结构，同时将入口放入现有数据卡片标题右侧，避免额外占用垂直空间；浮层覆盖内容而不推动筛选区和表格下移。

## Focused region comparison evidence

同屏对比图左侧为参考控件，右侧为 BrowserCoreClaw 实现。两者均包含紧凑入口、单列复选项、蓝色选中状态和底部重置操作。实现没有复制参考图中的拖拽手柄，因为当前功能只定义显示字段，不包含列排序；入口使用明确的“列设置”文字和数量徽标，替代只有图标和悬浮提示的入口。

## Findings

- No P0/P1/P2 findings.
- Fonts and typography: 沿用项目现有系统字体、标题层级与小字号控件规范；字段标签保持单行省略。
- Spacing and layout rhythm: 入口并入标题行，浮层宽 240px，字段列表内部滚动，未增加数据页固定高度。
- Colors and visual tokens: 使用现有蓝色主色、边框色、圆角和阴影变量，与 Google 及其他平台功能一致。
- Image quality and asset fidelity: 本次为原生表单控件，没有新增或替代图片资产；未使用占位图、手绘 SVG 或装饰性图形。
- Copy and content: 使用“列设置”“显示字段”“已选”“重置为全部显示”，语义明确并保留字段总数反馈。

## Primary interactions tested

- 打开与关闭列设置浮层。
- 取消“描述”字段后，入口从 7/7 更新为 6/7，表格同步移除该表头。
- 点击“重置为全部显示”后恢复 7/7。
- 复选项、浮层滚动区、重置禁用态均正常。
- 浏览器控制台未发现页面脚本错误。

## Comparison history

- Pass 1: 参考图与实现同屏检查；未发现需要修复的 P0/P1/P2 差异。拖拽手柄和纯图标入口属于未要求的列排序能力，保留为明确文字入口是有意的产品差异。

## Follow-up polish

- P3: 如果后续增加列排序，可在同一浮层中加入拖拽手柄，并将重置扩展为同时恢复默认顺序与显示状态。

final result: passed

---

## 本轮最终状态（运行器映射 UI，2026-07-17）

原本受阻的本地浏览器复验已完成；运行器的来源切换、目标多选、即时回显、来源自排除与保存状态均通过。完整渲染证据与本轮“能力名称 + Runner ID”精简对照见上方“运行器映射交互（2026-07-17）”。

final result: passed

---

## 运行器左侧自适应与默认链路（2026-07-16）

### Evidence

- Source visual truth: `/var/folders/g2/r66gs5k91ks54x8_tm4935mh0000gn/T/codex-clipboard-b2dc7218-6e71-4511-b60c-7d55243426a9.png`
- Browser-rendered implementation: `.qa-artifacts/runner-responsive-default-desktop.png`
- Focused comparison: `.qa-artifacts/runner-comparison.png`
- State: 设置 / 运行器；来源功能为 `xiaohongshu/keyword-search`

### Verification

- 左侧功能列表不再设置固定最小高度、最大高度或内部滚动裁切；11 个功能通过正常页面滚动完整参与布局，避免末尾出现由固定高度造成的空白区域。
- 在同一浏览器渲染状态中，左侧“小红书 / 关键词搜索”具有选中态；右侧显示“1 个已启用”、已选目标“小红书正文采集”，对应复选框为已选中状态。
- 右侧内容区域保持可伸缩列，窄屏断点下切换为上下排列；左侧不再依赖固定宽高来承载功能数量。
- 验证时临时关闭了本地预览页的浏览器缓存并重载；已恢复默认浏览器视口，未向产品写入浏览器状态。
- 自动化检查覆盖默认映射、旧设置的兼容补齐、显式清空映射不被重建这三种情形。

### Comparison history

- Pass 1: 对比图显示参考图中的问题来自左栏固定高度后的大块空白；实现去除该约束，并维持既有的左右来源/目标结构。
- Pass 2: 重新加载预览后，检查“小红书关键词搜索 → 小红书正文采集”的默认选中与复选框状态，结果一致。

### Findings

No P0/P1/P2 visual, responsive, or core-interaction findings remain.

final result: passed

---

# Design QA — 数据传输筛选工作台（2026-07-17）

## Evidence

- Source visual truth: `/Users/hmcm/.codex/generated_images/019f5983-5d35-7590-b2ab-06f9a0aef0c1/exec-addd3f6a-f07a-432e-aa72-128c20404d48.png`
- Browser-rendered data view: `/Users/hmcm/work/codex/BrowserCoreClaw/.qa-artifacts/transfer-filter-data-desktop.jpg`
- Browser-rendered task view: `/Users/hmcm/work/codex/BrowserCoreClaw/.qa-artifacts/transfer-filter-tasks-desktop.jpg`
- Browser-rendered mobile view: `/Users/hmcm/work/codex/BrowserCoreClaw/.qa-artifacts/transfer-filter-mobile.jpg`
- Same-input full-view comparison: `/Users/hmcm/work/codex/BrowserCoreClaw/.qa-artifacts/transfer-filter-comparison.jpg`
- Browser preview: `http://127.0.0.1:4174/sidepanel.html`; desktop 1280 × 900; responsive check 390 × 844.
- Compared state: 数据传输 / 数据 Tab / 紧凑筛选默认收起；任务 Tab 另行验证失败状态和错误信息。

## Findings

No actionable P0, P1, or P2 findings remain.

- Fonts and typography: 沿用项目现有标题、正文和密集表格字级；标题/链接主次层级与截断规则可读。
- Spacing and layout rhythm: 保持“标题 → Tab → 筛选 → 表格”的数据优先顺序；高级筛选默认收起，展开后提供平台、功能、状态、时间等全部字段。
- Colors and visual tokens: 复用现有墨绿、浅灰、边框与绿色/蓝色/红色/灰色语义状态，数据与任务表一致。
- Image quality and asset fidelity: 页面没有新增图片或插画；未用占位图、手绘 SVG 或 CSS 图形替代视觉资产。
- Copy and content: 本地状态与传输状态分列；任务含触发来源、数据范围、进度和错误信息，远程未接入不会误导为已上传。
- Focused comparison: 同屏比较覆盖标题、Tab、筛选工具栏和表格密度。实现按既有全局头部与卡片系统适配，保留参考稿的核心层级与筛选入口。

## Primary interactions tested

- 进入“数据传输”后，网页预览显示本地聚合示例数据与任务。
- 数据 Tab 选择“微博”平台，列表从 5 条收敛为 1 条，统计同步更新。
- 任务 Tab 选择“失败”状态，仅保留失败任务并展示“远程归档服务尚未连接。”。
- 数据、任务分别支持展开/收起筛选、清空条件、刷新和分页状态。
- 390 × 844 下，`document.documentElement.scrollWidth` 与 `body.scrollWidth` 均为 390；宽表仅在自身容器内滚动。
- 最新浏览器预览控制台无 error 日志。

## Comparison history

- Pass 1: 高级筛选默认展开，让小数据量页面的表格视觉重心下移，与参考稿的数据优先布局不一致。
- Fix: 将数据与任务高级筛选默认改为收起，保留完整筛选字段和“展开筛选”入口。
- Pass 2: 重新捕捉桌面数据、任务、移动端，并制作同屏比较；未发现新的 P0/P1/P2 问题。

## Follow-up polish

- P3: 接入远程存储后，在现有禁用按钮位置增加连接目标和批次发起操作，并把真实归档任务写入独立索引。

final result: passed

---

# Design QA — 功能页页面参数拆分（2026-07-17）

## Evidence

- Source visual truth: `/Users/hmcm/work/codex/BrowserCoreClaw/.qa-artifacts/page-parameters-reference.png`
- Browser-rendered Google state: `/Users/hmcm/work/codex/BrowserCoreClaw/.qa-artifacts/page-parameters-google-detail.png`
- Browser-rendered empty-state sample: `/Users/hmcm/work/codex/BrowserCoreClaw/.qa-artifacts/page-parameters-placeholder-detail.png`
- Browser preview: `http://127.0.0.1:4173/sidepanel.html` at 1280 × 720.
- Compared states: Google 新闻监控（有页面参数）与微博正文采集（无页面参数）。

## Findings

No actionable P0, P1, or P2 visual or interaction findings remain.

- Layout: 参数区域按“表单 → 页面参数 → 运行选项”垂直拆分；两个折叠卡沿用项目既有边框、摘要和操作按钮密度。
- Hierarchy: 页面参数默认收起，并通过箭头、摘要与“展开参数”明确提示可操作；运行选项不再承载页面语言、页面时间范围或平台筛选条件。
- Empty state: 没有页面参数的功能仍显示可展开卡片，展开后给出“暂无页面参数”及默认页面状态说明，避免用户误以为区域无效。
- Visual comparison: 参考图中的筛选字段已从运行选项中剥离；实现中 Google 的时间范围与界面语言独立显示。浏览器安全策略阻止打开本地对照 HTML，因此未在浏览器中打开 `.qa-artifacts/page-parameters-comparison.html`；参考图与浏览器截图已分别做视觉检查。

## Primary interactions tested

- Google 页面参数默认收起，点击后展开“时间范围”“界面语言”两项；界面语言切换为 `English` 后仍保持所选值。
- Google 运行选项展开后不包含“时间范围”或“界面语言”。
- 微博正文采集的页面参数默认收起，展开后显示“暂无页面参数”说明，运行选项保持独立可展开。
- `npm run check` 通过：4 个分组、11 个功能、113 个 JavaScript 文件。

## Comparison history

- Pass 1: 页面筛选与运行调度配置混在同一折叠卡，难以区分哪些值会直接影响目标网站页面。
- Fix: 新增统一的页面参数卡片；小红书关键词搜索迁移五个筛选条件，Google 新闻监控迁移时间范围和界面语言，其余功能复用明确的空状态。
- Pass 2: 验证展开/收起、选择控件和运行选项的字段隔离；未发现新的 P0/P1/P2 问题。

final result: passed

# Design QA — Desktop Capability Windows（2026-07-17）

## Evidence

- Source visual truth: `/Users/hmcm/Documents/Codex/2026-07-13/https-github-com-zhangzhongmiao-zhangzhongmiao/outputs/xiaoyu-ai-audit/02-chat-file-access.png`
- Source visual truth: `/Users/hmcm/Documents/Codex/2026-07-13/https-github-com-zhangzhongmiao-zhangzhongmiao/outputs/xiaoyu-ai-audit/03-news-dashboard.png`
- Source visual truth: `/Users/hmcm/Documents/Codex/2026-07-13/https-github-com-zhangzhongmiao-zhangzhongmiao/outputs/xiaoyu-ai-audit/06-typhoon-tool.png`
- User-annotated layout target: `/var/folders/g2/r66gs5k91ks54x8_tm4935mh0000gn/T/codex-clipboard-150d34f9-751d-4a07-8d5c-69ad9c89a0e2.png`
- User-annotated topbar target: `/var/folders/g2/r66gs5k91ks54x8_tm4935mh0000gn/T/codex-clipboard-0912bbd8-dd72-4fbc-bb97-901f38cfb89e.png`
- Implementation: `/Users/hmcm/work/codex/BrowserCoreClaw/desktop/desktop-client-demo.html`
- Generated visual asset: `/Users/hmcm/work/codex/BrowserCoreClaw/desktop/assets/images/ai-intelligence-core.png`
- Layout target: user-specified desktop structure—left/center/right width ratio `1:2:1`; left vertical ratio `1:2`; right vertical ratio `1:1:2`.
- Intended viewport: desktop 1440 × 900
- State: AI 指挥中枢 / Agent 对话 / application capability window closed / live stream active
- Required interaction states: open each of the six capability windows; drag; minimize/restore; maximize/restore; close; open nested task, browser, and task-detail surfaces.

## Implemented fidelity surfaces

- Information architecture: the annotated horizontal workspace-navigation block is removed from the visible application shell. The main application surface continues to use exact `1fr 2fr 1fr` tracks: statistics and priority intelligence on the left, the existing AI core/workbench in the center, and acquisition configuration plus live results on the right.
- Topbar annotation: the AI 指挥中枢 title block is positioned at the exact horizontal center of the application bar. The global search and topbar 新建任务 action are removed; the notification control remains right-aligned as shown by the annotation.
- Left rail hierarchy: uses exact `1fr 2fr` rows. The upper module contains four statistics and three health measures; the lower module contains a five-item priority intelligence list with direct links into the news/results workbenches, task detail, and login handling.
- Right rail hierarchy: uses exact `1fr 1fr 2fr` rows. The first module exposes the active acquisition profile and approval state, the second now exposes all six desktop capabilities, and the third is a live acquisition feed.
- Capability model: 任务中心、采集功能、登录会话、数据中心、运行日志 and 系统设置 are consolidated into the right-side application launcher. Each launcher opens a floating application window without replacing the central Agent workbench.
- Desktop-window behavior: the floating window includes a native-style title bar, per-capability icon and status line, close/minimize/maximize controls, title-bar dragging, double-click maximize, background dismissal, Escape handling, focus return, and a minimized dock state that leaves the underlying console interactive.
- Nested interaction behavior: actions inside cloned capability content are rewired for the floating-window context. Task creation, browser login, task detail, filters, data search, settings navigation, toast actions, and cross-capability links remain interactive; nested task/browser/drawer layers render above the capability window.
- Visual hierarchy: replaces the generic light admin dashboard with a dark navy AI operations system. The central intelligence core is now the primary visual anchor; live state, current mission, dialogue, and approval remain legible around it.
- Reference fidelity: the initial Agent view follows the compact three-panel command-console feeling from `02-chat-file-access.png`; the 新闻态势 workbench adds the left ranking / central signal globe / right insight structure seen in `03-news-dashboard.png`; persistent mission status and dense telemetry follow `06-typhoon-tool.png`.
- Typography and density: Chinese task copy stays readable while operational labels, counters, IDs, and state metadata use a restrained monospace treatment.
- Colors and tokens: near-black navy surfaces, cool blue intelligence accents, green live states, amber approvals, thin borders, and controlled glow replace the previous light neutral palette.
- Image quality and assets: the central globe is a dedicated 1672 × 941 generated raster asset. Navigation and action icons use local Bootstrap Icons SVG assets with the included MIT license; existing platform logo assets are reused rather than approximated with text glyphs.
- Interaction model: natural-language entry remains fixed at the bottom, the Agent exposes the generated plan before execution, and external access or writes require explicit approval. Priority intelligence items navigate to their matching detail/workbench. Capability entries now open desktop-like windows instead of replacing the main page. The live feed supports pause/resume and appends realistic records while active.
- Business workbench: Agent 对话、新闻态势 and 任务结果 remain separate working views with realistic monitoring data.
- Responsive behavior: the three main columns retain the exact `1:2:1` ratio across supported desktop widths. Below 1320 px, the center's internal AI-core/dialogue pair stacks vertically while the global three-column shell remains intact.

## Structural and functional checks

- Embedded JavaScript compiles successfully.
- 84 element IDs were checked; no duplicates were found.
- Every `getElementById` reference resolves to an existing element.
- All local image and icon references resolve successfully.
- CSS braces are balanced with no negative nesting depth.
- Project validation passed: 4 groups, 11 features, 120 JavaScript files.
- Static capability check passed: all six required launcher values are present; the former top navigation is explicitly hidden; close, minimize, maximize, and drag-handle controls are present.
- Primary interaction code covers floating capability windows, workbench switching, priority-item routing, prompt submission, suggested commands, plan generation, approve/cancel, live-feed pause/resume, simulated live records, and form fallback.

## Blocker

The implementation is opened through a local `file://` URL. The selected in-app browser rejects programmatic control of that URL under its browser security policy, so a browser-rendered screenshot and live interaction pass for the floating-window and centered-topbar states could not be produced without changing browser surfaces or using a prohibited workaround. Both annotated source images were inspected directly, and static implementation checks pass, but the composed interface still requires manual refresh and visual acceptance in the already-open tab.

final result: blocked

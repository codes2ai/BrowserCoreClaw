import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifestPath = join(root, "manifest.json");
const configPath = join(root, "src/config/groups.json");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

const manifest = readJson(manifestPath);
if (manifest.manifest_version !== 3) {
  throw new Error("manifest.json 必须使用 Manifest V3。 ");
}
if (manifest.permissions?.includes("sidePanel") || manifest.side_panel) {
  throw new Error("控制台已改为完整标签页，manifest.json 不应再声明 Side Panel。 ");
}
if (!manifest.permissions?.includes("tabs")) {
  throw new Error("唯一控制台标签页需要 tabs 权限。 ");
}
if (!manifest.permissions?.includes("scripting")) {
  throw new Error("平台非调试采集需要 scripting 权限。 ");
}
if (manifest.permissions?.includes("debugger")) {
  throw new Error("全部采集功能已迁移到 scripting，不应继续申请 debugger 权限。 ");
}
if (!manifest.permissions?.includes("unlimitedStorage")) {
  throw new Error("数据存储条数设为 0 时需要 unlimitedStorage 权限。 ");
}
const serviceWorkerSource = readFileSync(join(root, "src/background/service-worker.js"), "utf8");
if (
  !serviceWorkerSource.includes('const DASHBOARD_PATH = "sidepanel.html";')
  || !serviceWorkerSource.includes("chrome.action.onClicked.addListener")
  || !serviceWorkerSource.includes("chrome.tabs.query({}, done)")
  || !serviceWorkerSource.includes("chrome.windows.update(existing.windowId, { focused: true }, done)")
  || !serviceWorkerSource.includes("dashboardOpenPromise")
) {
  throw new Error("扩展图标没有配置为定位唯一的完整控制台标签页。 ");
}

const config = readJson(configPath);
if (!Array.isArray(config.groups) || config.groups.length === 0) {
  throw new Error("groups.json 至少需要一个分组。 ");
}

const featureKeys = new Set();
for (const group of config.groups) {
  if (!group.id || !group.name || !Array.isArray(group.features)) {
    throw new Error(`分组配置不完整：${group.id || "unknown"}`);
  }
  if (!group.image || !existsSync(join(root, group.image))) {
    throw new Error(`分组平台图片不存在：${group.id || "unknown"} / ${group.image || "empty"}`);
  }

  for (const feature of group.features) {
    const key = `${group.id}/${feature.id}`;
    if (featureKeys.has(key)) {
      throw new Error(`功能 ID 重复：${key}`);
    }
    featureKeys.add(key);

    for (const field of ["entry", "style", "runner"]) {
      if (!feature[field] || !existsSync(join(root, feature[field]))) {
        throw new Error(`${key} 的 ${field} 文件不存在：${feature[field] || "empty"}`);
      }
    }

    const expectedDirectory = `src/groups/${group.id}/${feature.id}/`;
    if (
      !feature.entry.startsWith(expectedDirectory)
      || !feature.style.startsWith(expectedDirectory)
      || !feature.runner.startsWith(expectedDirectory)
    ) {
      throw new Error(`${key} 必须放在 ${expectedDirectory} 下。`);
    }
  }
}

const runnerRegistryModule = await import(pathToFileURL(join(root, "src/runners/registry.js")).href);
const runnerRegistryState = runnerRegistryModule.validateFeatureRunnerRegistry([...featureKeys]);
if (!runnerRegistryState.valid) {
  throw new Error(
    `Runner 注册表与功能配置不一致：缺失 ${runnerRegistryState.missing.join(", ") || "无"}；多余 ${runnerRegistryState.unexpected.join(", ") || "无"}`
  );
}
const runnerSamples = {
  "google/google-news": { keywords: ["OpenAI"] },
  "weibo/profile-posts": { profileUrls: ["https://weibo.com/u/2656274875"] },
  "weibo/profile-info": { profileUrls: ["https://weibo.com/u/2656274875"] },
  "weibo/post-detail": { postUrls: ["https://weibo.com/2656274875/R8TUWtvwU"] },
  "douyin/profile-posts": { profileUrls: ["https://www.douyin.com/user/MS4wLjABAAAA-test"] },
  "douyin/profile-info": { profileUrls: ["https://www.douyin.com/user/MS4wLjABAAAA-test"] },
  "douyin/post-detail": { postUrls: ["https://www.douyin.com/video/7660418654437248294"] },
  "xiaohongshu/keyword-search": { keywords: ["OpenAI"] },
  "xiaohongshu/profile-notes": { profileUrls: ["https://www.xiaohongshu.com/user/profile/abc123"] },
  "xiaohongshu/profile-info": { profileUrls: ["https://www.xiaohongshu.com/user/profile/abc123"] },
  "xiaohongshu/post-detail": { postUrls: ["https://www.xiaohongshu.com/explore/64b1234567890abcdef12345"] }
};
for (const descriptor of runnerRegistryModule.listFeatureRunners()) {
  const runner = runnerRegistryModule.getFeatureRunner(descriptor.featureId);
  const parameters = runner.validate({
    ...runnerSamples[descriptor.featureId],
    concurrency: 99,
    intervalMinMs: 6000,
    intervalMaxMs: 1000
  });
  if (
    parameters.concurrency !== 3
    || parameters.intervalMinMs !== 1000
    || parameters.intervalMaxMs !== 6000
    || parameters.forceUpdateData !== false
  ) {
    throw new Error(`${descriptor.featureId} Runner 没有统一规范化并发数、执行间隔或强制更新开关。`);
  }
}
const forceUpdateRunnerParameters = runnerRegistryModule.getFeatureRunner("google/google-news").validate({
  ...runnerSamples["google/google-news"],
  forceUpdateData: true
});
if (forceUpdateRunnerParameters.forceUpdateData !== true) {
  throw new Error("Runner 没有保留 forceUpdateData 参数。");
}
const featureRunnerModule = await import(pathToFileURL(join(root, "src/shared/feature-runner.js")).href);
const runnerFixture = featureRunnerModule.createBatchFeatureRunner({
  featureId: "fixture/mock",
  name: "Runner 测试",
  inputKey: "inputs",
  inputLabel: "测试输入",
  supportsPolling: false,
  validateInput: Boolean,
  async executeItem({ input }) {
    if (input === "failed") throw new Error("测试失败");
    return { ok: true, data: { rows: input === "empty" ? [] : [{ id: input, value: input }] } };
  },
  async stopItem() {
    return { ok: true };
  },
  toRows(data) {
    return data?.rows || [];
  }
});
const runnerFixtureResult = await runnerFixture.run({
  inputs: ["first", "empty", "failed"],
  concurrency: 3,
  intervalMinMs: 100,
  intervalMaxMs: 100
}, { taskId: "fixture-task", timeoutSeconds: 1 });
if (
  runnerFixtureResult.status !== "partial"
  || runnerFixtureResult.resultCount !== 1
  || runnerFixtureResult.uniqueResultCount !== 1
  || runnerFixtureResult.failedCount !== 1
  || !runnerFixtureResult.items.find((item) => item.input === "first")?.rowKeys?.includes("first")
  || !runnerFixtureResult.items.every((item) => item.runId?.startsWith("fixture-task-R1-I"))
  || runnerFixtureResult.items.find((item) => item.input === "empty")?.status !== "no_data"
) {
  throw new Error("统一 Runner 没有正确汇总成功、无数据和失败输入。 ");
}
const dataUpdatePolicyModule = await import(pathToFileURL(join(root, "src/shared/data-update-policy.js")).href);
const xiaohongshuPostDetailDataRowModule = await import(pathToFileURL(join(
  root,
  "src/groups/xiaohongshu/post-detail/data-row.js"
)).href);
const existingDataRows = [
  { id: "same", title: "旧标题", capturedAt: "2026-07-16 10:00:00" },
  { id: "keep", title: "保留记录" }
];
const incomingDataRows = [
  { id: "same", title: "新标题", capturedAt: "2026-07-16 11:00:00" },
  { id: "new", title: "新增记录" }
];
const keepExistingRows = dataUpdatePolicyModule.mergeDataRowsByKey({
  currentRows: existingDataRows,
  incomingRows: incomingDataRows,
  getKey: (row) => row.id
});
const overwriteExistingRows = dataUpdatePolicyModule.mergeDataRowsByKey({
  currentRows: existingDataRows,
  incomingRows: incomingDataRows,
  getKey: (row) => row.id,
  forceUpdateData: true
});
if (
  dataUpdatePolicyModule.normalizeForceUpdateData(true) !== true
  || dataUpdatePolicyModule.normalizeForceUpdateData("true") !== false
  || keepExistingRows.rows.find((row) => row.id === "same")?.title !== "旧标题"
  || keepExistingRows.addedCount !== 1
  || overwriteExistingRows.rows.find((row) => row.id === "same")?.title !== "新标题"
  || overwriteExistingRows.addedCount !== 1
) {
  throw new Error("强制更新数据开关没有正确区分保留旧数据和覆盖同键数据。 ");
}
const refreshedXiaohongshuPost = xiaohongshuPostDetailDataRowModule.mergeXiaohongshuPostDetailDataRow(
  { likes: "2", favorites: "8", comments: "4", shares: "1" },
  {
    likes: "3",
    favorites: "0",
    comments: "5",
    shares: "0",
    capturedInteractionFields: ["likes", "comments"]
  }
);
if (
  refreshedXiaohongshuPost.likes !== "3"
  || refreshedXiaohongshuPost.comments !== "5"
  || refreshedXiaohongshuPost.favorites !== "8"
  || refreshedXiaohongshuPost.shares !== "1"
) {
  throw new Error("小红书正文强制更新没有正确覆盖可读取互动数或保留未公开互动数。 ");
}
const runnerControllerSource = readFileSync(join(root, "src/background/runner-controller.js"), "utf8");
if (
  !runnerControllerSource.includes("persistRunnerProgressRecord")
  || !runnerControllerSource.includes("TASK_EXECUTION_TYPE_RUNNER")
  || !runnerControllerSource.includes("runnerTaskId")
  || !runnerControllerSource.includes("addedCountsByRunId")
  || !runnerControllerSource.includes("limitItemsPerGroup")
  || !runnerControllerSource.includes("mergeDataRowsByKey")
  || !runnerControllerSource.includes("normalized.parameters.forceUpdateData")
  || !runnerControllerSource.includes("projectRunnerOutputRows")
  || !runnerControllerSource.includes("normalized.execution.outputFields")
) {
  throw new Error("Runner 单项任务没有合并到原功能运行记录、复用全局记录限额或支持强制更新。 ");
}
if (
  !serviceWorkerSource.includes("MESSAGE_EXECUTE_FEATURE_RUNNER")
  || !serviceWorkerSource.includes("executeFeatureRunner")
  || !serviceWorkerSource.includes("MESSAGE_STOP_FEATURE_RUNNER")
  || !serviceWorkerSource.includes("getFeatureRunnerTask")
) {
  throw new Error("Service Worker 没有完整注册 Runner 的执行、停止和状态查询入口。 ");
}

const runStatusSource = readFileSync(join(root, "src/shared/feature-run-status.js"), "utf8");
const globalSettingsSource = readFileSync(join(root, "src/shared/global-settings.js"), "utf8");
const taskTimeoutSource = readFileSync(join(root, "src/shared/task-timeout.js"), "utf8");
const executionIntervalSource = readFileSync(join(root, "src/shared/execution-interval.js"), "utf8");
const inputListPaginationSource = readFileSync(join(root, "src/shared/input-list-pagination.js"), "utf8");
const featureShellSource = readFileSync(join(root, "src/groups/feature-shell.css"), "utf8");
const tabScriptClientSource = readFileSync(join(root, "src/background/tab-script-client.js"), "utf8");
const appSource = readFileSync(join(root, "src/app/app.js"), "utf8");
const appStyleSource = readFileSync(join(root, "src/app/app.css"), "utf8");
if (
  !runStatusSource.includes("FEATURE_RUN_STATUS_EVENT")
  || !runStatusSource.includes("setFeatureRunning")
  || !appSource.includes("feature-running-dot")
  || !appSource.includes("runningFeatures")
) {
  throw new Error("功能列表缺少统一运行状态或绿色状态点。 ");
}
if (
  !globalSettingsSource.includes("taskTimeoutSeconds: 120")
  || !globalSettingsSource.includes("dataStorageLimit: 3000")
  || !globalSettingsSource.includes("taskRecordsPerStatusLimit: 200")
  || !globalSettingsSource.includes('type: "local"')
  || !appSource.includes('data-settings-tab="basic"')
  || !appSource.includes('data-settings-tab="limits"')
  || !appSource.includes('data-settings-tab="storage"')
  || !appSource.includes('data-settings-tab="runner"')
  || !appSource.includes("select-runner-source")
  || !appSource.includes("settings-runner-sources")
  || !appSource.includes("data-runner-target")
  || !appSource.includes("callableByFeature")
  || !appSource.includes("data-setting-logo")
  || !appSource.includes('data-setting-field="dataStorageLimit"')
  || !appSource.includes('data-setting-field="taskRecordsPerStatusLimit"')
  || !taskTimeoutSource.includes("runWithTaskTimeout")
  || !executionIntervalSource.includes("DEFAULT_EXECUTION_INTERVAL_MIN_MS = 1000")
  || !executionIntervalSource.includes("DEFAULT_EXECUTION_INTERVAL_MAX_MS = 6000")
  || !inputListPaginationSource.includes("DEFAULT_INPUT_LIST_PAGE_SIZE = 10")
  || !featureShellSource.includes(".input-list-pagination")
  || !tabScriptClientSource.includes("chrome.scripting.executeScript")
  || !tabScriptClientSource.includes("chrome.tabs.update")
) {
  throw new Error("全局基础、Limit、存储、运行器设置或任务超时控制没有完整接入。 ");
}
if (
  !appSource.includes("openTransferDataDetail")
  || !appSource.includes('data-transfer-action="open-data-detail"')
  || !appSource.includes("data-transfer-row-id")
  || !appSource.includes('role="dialog"')
  || !appSource.includes("Object.entries(raw)")
  || !appStyleSource.includes(".transfer-data-detail-dialog")
  || !appStyleSource.includes(".transfer-data-identifier")
) {
  throw new Error("数据传输列表没有完整接入原始数据字段详情弹窗。 ");
}
const transferWorkspaceModule = await import(pathToFileURL(join(root, "src/shared/transfer-workspace.js")).href);
const transferPreview = await transferWorkspaceModule.loadTransferWorkspace([]);
const transferPreviewRaw = transferPreview.dataRows[0]?.raw;
if (
  !transferPreviewRaw
  || Object.keys(transferPreviewRaw).length < 8
  || !Array.isArray(transferPreviewRaw.tags)
  || transferPreviewRaw.metadata?.preview !== true
) {
  throw new Error("数据传输预览记录没有提供可核对的完整原始字段。 ");
}

const paginatedInputMonitors = [
  ["src/groups/google/google-news/monitor.js", 'state.config.keywords.join("\\n")'],
  ["src/groups/xiaohongshu/keyword-search/monitor.js", 'state.config.keywords.join("\\n")'],
  ["src/groups/xiaohongshu/profile-notes/monitor.js", 'state.profileUrls.filter(Boolean).join("\\n")'],
  ["src/groups/xiaohongshu/profile-info/monitor.js", 'state.profileUrls.filter(Boolean).join("\\n")'],
  ["src/groups/weibo/profile-monitor.js", 'state.profileUrls.filter(Boolean).join("\\n")']
];
for (const [relativePath, completeBatchMarker] of paginatedInputMonitors) {
  const source = readFileSync(join(root, relativePath), "utf8");
  if (
    !source.includes("paginateInputList")
    || !source.includes("renderInputListPagination")
    || !source.includes("inputListPage")
    || (
      !source.includes('case "set-input-list-page"')
      && !source.includes('action === "set-input-list-page"')
    )
    || !source.includes(completeBatchMarker)
  ) {
    throw new Error(`输入列表分页或全量批量编辑没有完整接入：${relativePath}`);
  }
}

for (const relativePath of [
  "src/groups/google/google-news/monitor.js",
  "src/groups/xiaohongshu/keyword-search/monitor.js",
  "src/groups/xiaohongshu/profile-notes/monitor.js",
  "src/groups/xiaohongshu/profile-info/monitor.js",
  "src/groups/weibo/profile-monitor.js"
]) {
  const source = readFileSync(join(root, relativePath), "utf8");
  if (!source.includes("setFeatureRunning") || !source.includes(", true)") || !source.includes(", false)")) {
    throw new Error(`功能运行状态没有覆盖开始和结束：${relativePath}`);
  }
}

for (const relativePath of [
  "src/groups/google/google-news/monitor.js",
  "src/groups/xiaohongshu/keyword-search/monitor.js",
  "src/groups/xiaohongshu/profile-notes/monitor.js",
  "src/groups/xiaohongshu/profile-info/monitor.js",
  "src/groups/weibo/profile-monitor.js"
]) {
  const source = readFileSync(join(root, relativePath), "utf8");
  if (!source.includes("loadTaskTimeoutSeconds") || !source.includes("runWithTaskTimeout") || !source.includes("onTimeout")) {
    throw new Error(`全局任务超时没有覆盖运行入口：${relativePath}`);
  }
  if (
    !source.includes("loadGlobalStorageLimits")
    || !source.includes("dataStorageLimit")
    || !source.includes("taskRecordsPerStatusLimit")
    || !source.includes("applyItemLimit")
  ) {
    throw new Error(`全局数据与任务记录限制没有覆盖运行入口：${relativePath}`);
  }
  if (
    !source.includes("DEFAULT_EXECUTION_INTERVAL_MIN_MS")
    || !source.includes("DEFAULT_EXECUTION_INTERVAL_MAX_MS")
  ) {
    throw new Error(`统一的 1000–6000 ms 默认执行间隔没有覆盖运行入口：${relativePath}`);
  }
}

const javascriptFiles = walk(join(root, "src"))
  .concat(walk(join(root, "scripts")))
  .filter((path) => [".js", ".mjs"].includes(extname(path)));

for (const file of javascriptFiles) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status || 1);
  }
}

const recordsModule = await import(pathToFileURL(join(
  root,
  "src/groups/google/google-news/monitor.js"
)).href);
const googleNewsBackgroundModule = await import(pathToFileURL(join(
  root,
  "src/groups/google/google-news/background.js"
)).href);
for (const noResultsText of [
  "未搜到与“讯飞星火”相关的新闻。",
  "未搜到与“\n讯飞星火\n”相关的新闻。",
  "未找到与测试词相关的新闻",
  "Your search did not match any news results",
  "No news results"
]) {
  if (!googleNewsBackgroundModule.isGoogleNewsNoResultsText(noResultsText)) {
    throw new Error(`Google 新闻无数据提示没有被识别：${noResultsText}`);
  }
}
if (googleNewsBackgroundModule.isGoogleNewsNoResultsText("OpenAI 发布了新的模型产品")) {
  throw new Error("正常 Google 新闻正文被错误识别为无数据。 ");
}
for (const riskControlState of [
  { href: "https://www.google.com/sorry/index?continue=https://www.google.com/search" },
  { pathname: "/sorry/index" },
  { text: "我们的系统检测到您的计算机网络中存在异常流量。请进行人机身份验证。" },
  { hasCaptchaFrame: true }
]) {
  if (!googleNewsBackgroundModule.isGoogleNewsRiskControlState(riskControlState)) {
    throw new Error(`Google 风控页面没有被识别：${JSON.stringify(riskControlState)}`);
  }
}
if (googleNewsBackgroundModule.isGoogleNewsRiskControlState({
  href: "https://www.google.com/search?q=OpenAI&tbm=nws",
  text: "OpenAI 发布了新的模型产品"
})) {
  throw new Error("正常 Google 新闻结果页被错误识别为风控页面。 ");
}
const inputListPaginationModule = await import(pathToFileURL(join(
  root,
  "src/shared/input-list-pagination.js"
)).href);
const paginationItems = Array.from({ length: 50 }, (_, index) => `item-${index + 1}`);
const firstInputPage = inputListPaginationModule.paginateInputList(paginationItems, 1);
const lastInputPage = inputListPaginationModule.paginateInputList(paginationItems, 99);
if (
  firstInputPage.page !== 1
  || firstInputPage.pageCount !== 5
  || firstInputPage.items.length !== 10
  || firstInputPage.items[0]?.index !== 0
  || firstInputPage.items[9]?.index !== 9
  || lastInputPage.page !== 5
  || lastInputPage.items[0]?.index !== 40
  || lastInputPage.items[9]?.index !== 49
  || inputListPaginationModule.pageForInputIndex(49) !== 5
  || inputListPaginationModule.clampInputListPage(5, paginationItems.slice(0, 40)) !== 4
) {
  throw new Error("输入列表没有按每页 10 条正确分页或保留原始索引。 ");
}
const inputPaginationHtml = inputListPaginationModule.renderInputListPagination(lastInputPage, {
  itemLabel: "个关键词"
});
if (
  !inputPaginationHtml.includes("显示 41-50 / 50 个关键词")
  || !inputPaginationHtml.includes('data-action="set-input-list-page"')
  || !inputPaginationHtml.includes('aria-current="page"')
) {
  throw new Error("输入列表分页控件没有正确展示范围、页码和导航操作。 ");
}
const dataTableFilterModule = await import(pathToFileURL(join(
  root,
  "src/shared/data-table-filter.js"
)).href);
const dataFilterDefinitions = [
  { key: "keyword", label: "关键词", type: "select" },
  { key: "title", label: "标题" },
  { key: "author", label: "作者", keys: ["author", "source"] }
];
const dataFilterRows = [
  { keyword: "OpenAI", title: "模型发布", author: "甲" },
  { keyword: "OpenAI", title: "行业观察", source: "乙" },
  { keyword: "人工智能", title: "模型观察", author: "丙" }
];
const dataFilterValues = dataTableFilterModule.createDataFilterValues(dataFilterDefinitions);
dataFilterValues.keyword = "OpenAI";
dataFilterValues.title = "模型";
const filteredDataRows = dataTableFilterModule.filterDataRows(
  dataFilterRows,
  dataFilterDefinitions,
  dataFilterValues
);
if (
  filteredDataRows.length !== 1
  || filteredDataRows[0].author !== "甲"
  || dataTableFilterModule.countActiveDataFilters(dataFilterDefinitions, dataFilterValues) !== 2
) {
  throw new Error("数据表格的文本包含筛选、下拉精确筛选或启用数量统计不正确。 ");
}
const dataFilterMarkup = dataTableFilterModule.renderDataFilterPanel({
  rows: dataFilterRows,
  definitions: dataFilterDefinitions,
  values: dataFilterValues,
  expanded: true,
  escapeHtml: (value) => String(value)
});
if (
  !dataFilterMarkup.includes('data-action="toggle-data-filters"')
  || !dataFilterMarkup.includes('data-action="clear-data-filters"')
  || !dataFilterMarkup.includes("显示 1 / 3 条")
) {
  throw new Error("数据筛选面板缺少收起、清空或筛选结果统计。 ");
}
const copiedJsonFixture = dataTableFilterModule.serializeRowsAsJson(filteredDataRows, (rows) => (
  rows.map((row) => ({ keyword: row.keyword, title: row.title }))
));
if (!copiedJsonFixture.includes('"title": "模型发布"') || copiedJsonFixture.includes('"author"')) {
  throw new Error("复制 JSON 没有使用筛选后的数据或规范化导出字段。 ");
}
const dataFilterSource = readFileSync(join(root, "src/shared/data-table-filter.js"), "utf8");
if (
  !dataFilterSource.includes("openRowsJsonPreview")
  || !dataFilterSource.includes("data-json-preview")
  || !dataFilterSource.includes("data-json-copy")
  || !dataFilterSource.includes("一键复制")
) {
  throw new Error("JSON 数据预览弹窗或一键复制能力不完整。 ");
}

const dataColumnSettingsModule = await import(pathToFileURL(join(
  root,
  "src/shared/data-column-settings.js"
)).href);
const dataColumnDefinitions = [
  { key: "title", label: "标题" },
  { key: "author", label: "作者" },
  { key: "url", label: "链接", type: "link" }
];
const dataColumnVisibility = dataColumnSettingsModule.createDataColumnVisibility(
  dataColumnDefinitions,
  { title: true, author: false, url: true }
);
const projectedDataRows = dataColumnSettingsModule.projectDataRowsByColumns(
  [{ title: "模型发布", author: "测试作者", url: "https://example.com/item" }],
  dataColumnDefinitions,
  dataColumnVisibility
);
const dataColumnMarkup = dataColumnSettingsModule.renderDataColumnSettingsPanel({
  columns: dataColumnDefinitions,
  visibility: dataColumnVisibility,
  expanded: true,
  escapeHtml: (value) => String(value)
});
const configuredTableMarkup = dataColumnSettingsModule.renderConfiguredDataTable({
  rows: projectedDataRows,
  columns: dataColumnDefinitions,
  visibility: dataColumnVisibility,
  escapeHtml: (value) => String(value)
});
const configuredCsv = dataColumnSettingsModule.serializeDataRowsCsv(
  projectedDataRows,
  dataColumnDefinitions,
  dataColumnVisibility
);
const fallbackVisibility = dataColumnSettingsModule.getVisibleDataColumns(
  dataColumnDefinitions,
  { title: false, author: false, url: false }
);
if (
  Object.keys(projectedDataRows[0]).join(",") !== "title,url"
  || !dataColumnMarkup.includes('data-data-column="author"')
  || !dataColumnMarkup.includes("已选 2 / 3")
  || !dataColumnMarkup.includes("重置为全部显示")
  || !dataColumnMarkup.includes('role="dialog"')
  || configuredTableMarkup.includes("<th>作者</th>")
  || !configuredTableMarkup.includes("<th>标题</th>")
  || configuredCsv.includes('"author"')
  || !configuredCsv.startsWith('\uFEFF"title","url"')
  || fallbackVisibility.length !== 1
  || fallbackVisibility[0].key !== "title"
) {
  throw new Error("表头显示设置、至少保留一列或按当前字段输出数据不正确。 ");
}
let dataColumnRenderScheduled = false;
dataColumnSettingsModule.scheduleDataColumnRender(() => {
  dataColumnRenderScheduled = true;
});
if (dataColumnRenderScheduled) {
  throw new Error("列设置不应在原生点击或 change 事件尚未结束时同步替换页面节点。 ");
}
await new Promise((resolve) => setTimeout(resolve, 0));
if (!dataColumnRenderScheduled) {
  throw new Error("列设置延迟重绘没有在交互结束后执行。 ");
}

const directDataFilterMonitors = [
  "src/groups/google/google-news/monitor.js",
  "src/groups/xiaohongshu/keyword-search/monitor.js",
  "src/groups/xiaohongshu/profile-notes/monitor.js",
  "src/groups/xiaohongshu/profile-info/monitor.js",
  "src/groups/weibo/profile-monitor.js"
];
for (const relativePath of directDataFilterMonitors) {
  const source = readFileSync(join(root, relativePath), "utf8");
  if (
    !source.includes("renderDataFilterPanel")
    || !source.includes("filterDataRows")
    || !source.includes('data-action="copy-json"')
    || !source.includes("openRowsJsonPreview")
    || !source.includes("筛选后的表格数据")
    || source.includes('data-action="export-json"')
  ) {
    throw new Error(`数据筛选、复制 JSON 或筛选后表格导出没有完整接入：${relativePath}`);
  }
  if (
    !source.includes("renderDataColumnSettingsPanel")
    || !source.includes("createDataColumnVisibility")
    || !source.includes("projectDataRowsByColumns")
    || !source.includes("downloadDataRowsCsv")
    || !source.includes("scheduleDataColumnRender")
    || !source.includes("dataColumnVisibility")
    || !source.includes("toggle-data-columns")
  ) {
    throw new Error(`表头设置或按显示字段输出没有完整接入：${relativePath}`);
  }
}
for (const platform of ["weibo", "douyin"]) {
  for (const feature of ["profile-posts", "profile-info", "post-detail"]) {
    const relativePath = `src/groups/${platform}/${feature}/monitor.js`;
    const source = readFileSync(join(root, relativePath), "utf8");
    if (!source.includes("dataFilters:") || !source.includes("dataColumns:") || !source.includes("buildExportRows:") || !source.includes("emptyDataText:")) {
      throw new Error(`配置化数据筛选字段或复制 JSON 映射没有完整接入：${relativePath}`);
    }
  }
}
const sharedDateModule = await import(pathToFileURL(join(root, "src/shared/date-normalizer.js")).href);
const googleDateReference = new Date(2026, 6, 15, 0, 15, 0);
const googlePublishedDateCases = new Map([
  ["2025-11-18T18:30:00+08:00", "2025-11-18"],
  ["30分钟前", "2026-07-14"],
  ["45 minutes ago", "2026-07-14"],
  ["2小时前", "2026-07-14"],
  ["just now", "2026-07-15"]
]);
for (const [rawDate, expectedDate] of googlePublishedDateCases) {
  const normalizedDate = sharedDateModule.normalizePublishedDate(rawDate, {
    referenceDate: googleDateReference
  });
  if (normalizedDate !== expectedDate) {
    throw new Error(`Google 新闻发布时间 ${rawDate} 标准化错误：${normalizedDate}，预期 ${expectedDate}。`);
  }
}
if (sharedDateModule.formatLocalCalendarDate(googleDateReference) !== "2026-07-15") {
  throw new Error("Google 新闻采集时间没有转换为本地 YYYY-MM-DD。 ");
}
const googlePublishedDateTimeCases = new Map([
  ["30分钟前", "2026-07-14 23:45:00"],
  ["2小时前", "2026-07-14 22:15:00"],
  ["just now", "2026-07-15 00:15:00"]
]);
for (const [rawDate, expectedDate] of googlePublishedDateTimeCases) {
  const normalizedDate = sharedDateModule.normalizePublishedDateTime(rawDate, {
    referenceDate: googleDateReference
  });
  if (normalizedDate !== expectedDate) {
    throw new Error(`Google 新闻精确发布时间 ${rawDate} 标准化错误：${normalizedDate}，预期 ${expectedDate}。`);
  }
}
const googleMachineTimeReference = new Date(2026, 6, 15, 16, 2, 37);
if (sharedDateModule.formatLocalDateTime(googleMachineTimeReference) !== "2026-07-15 16:02:37") {
  throw new Error("Google 新闻时间戳没有转换为本地 YYYY-MM-DD HH:mm:ss。 ");
}
const googleNewsExportModule = await import(pathToFileURL(join(
  root,
  "src/groups/google/google-news/export-data.js"
)).href);
const googleNewsExportRow = googleNewsExportModule.buildGoogleNewsExportRows([{
  title: "测试新闻",
  publishedAt: "2026-07-14",
  collectedAt: "2026-07-15",
  capturedAt: "2026-07-14T20:15:00.000Z"
}])[0];
if (
  googleNewsExportRow.publishedAt !== "2026-07-14"
  || googleNewsExportRow.collectedAt !== "2026-07-15"
) {
  throw new Error("Google 新闻发布时间和采集时间没有作为两个独立字段导出。 ");
}
const globalSettingsModule = await import(pathToFileURL(join(root, "src/shared/global-settings.js")).href);
const defaultGlobalSettings = globalSettingsModule.getDefaultGlobalSettings();
const legacyRunnerDefaultSettings = globalSettingsModule.normalizeGlobalSettings({ runners: {} });
const explicitEmptyRunnerSettings = globalSettingsModule.normalizeGlobalSettings({
  runners: { callableByFeature: {} }
});
const normalizedGlobalSettings = globalSettingsModule.normalizeGlobalSettings({
  interface: { appName: "  自定义采集中心  ", logoDataUrl: "invalid" },
  limits: { taskTimeoutSeconds: 5 },
  storage: { type: "other" },
  runners: {
    callableByFeature: {
      "xiaohongshu/keyword-search": [
        "xiaohongshu/post-detail",
        "xiaohongshu/post-detail",
        "invalid",
        "xiaohongshu/keyword-search"
      ],
      invalid: ["weibo/post-detail"]
    },
    configurationByBinding: {
      "xiaohongshu/keyword-search": {
        "xiaohongshu/post-detail": {
          outputFields: ["noteId", "title", "invalid", "title"],
          parameters: {
            concurrency: 9,
            intervalMinMs: 4200,
            intervalMaxMs: 900,
            forceUpdateData: true
          }
        }
      }
    }
  }
});
const normalizedRunnerConfiguration = globalSettingsModule.getRunnerBindingConfiguration(
  normalizedGlobalSettings,
  "xiaohongshu/keyword-search",
  "xiaohongshu/post-detail"
);
if (
  JSON.stringify(defaultGlobalSettings.runners.callableByFeature) !== JSON.stringify({
    "xiaohongshu/keyword-search": ["xiaohongshu/post-detail"]
  })
  || JSON.stringify(legacyRunnerDefaultSettings.runners.callableByFeature) !== JSON.stringify({
    "xiaohongshu/keyword-search": ["xiaohongshu/post-detail"]
  })
  || Object.keys(explicitEmptyRunnerSettings.runners.callableByFeature).length !== 0
  || normalizedGlobalSettings.interface.appName !== "自定义采集中心"
  || normalizedGlobalSettings.interface.logoDataUrl !== ""
  || normalizedGlobalSettings.limits.taskTimeoutSeconds !== 10
  || normalizedGlobalSettings.limits.dataStorageLimit !== 3000
  || normalizedGlobalSettings.limits.taskRecordsPerStatusLimit !== 200
  || normalizedGlobalSettings.storage.type !== "local"
  || JSON.stringify(normalizedGlobalSettings.runners.callableByFeature) !== JSON.stringify({
    "xiaohongshu/keyword-search": ["xiaohongshu/post-detail"]
  })
  || JSON.stringify(normalizedRunnerConfiguration.outputFields) !== JSON.stringify(["noteId", "title"])
  || normalizedRunnerConfiguration.parameters.concurrency !== 3
  || normalizedRunnerConfiguration.parameters.intervalMinMs !== 900
  || normalizedRunnerConfiguration.parameters.intervalMaxMs !== 4200
  || normalizedRunnerConfiguration.parameters.forceUpdateData !== true
  || !globalSettingsModule.isRunnerCallableByFeature(
    normalizedGlobalSettings,
    "xiaohongshu/keyword-search",
    "xiaohongshu/post-detail"
  )
  || globalSettingsModule.isRunnerCallableByFeature(
    normalizedGlobalSettings,
    "xiaohongshu/keyword-search",
    "weibo/post-detail"
  )
) {
  throw new Error("全局设置或运行器调用映射的标准化结果不正确。 ");
}
const boundRunnerAutomationModule = await import(pathToFileURL(join(
  root,
  "src/shared/bound-runner-automation.js"
)).href);
const boundRunnerTargets = boundRunnerAutomationModule.normalizeBoundRunnerTargets([
  {
    id: "xiaohongshu/post-detail",
    name: "小红书正文采集",
    configuration: {
      outputFields: ["noteId", "title"],
      parameters: {
        concurrency: 2,
        intervalMinMs: 1200,
        intervalMaxMs: 2400,
        forceUpdateData: true
      }
    }
  },
  { id: "xiaohongshu/post-detail", name: "重复目标" },
  { id: "invalid", name: "无效目标" }
]);
const autoRunnableTargets = boundRunnerAutomationModule.getAutoRunnableBoundRunnerTargets(
  "xiaohongshu/keyword-search",
  boundRunnerTargets
);
const automaticRunnerRequests = boundRunnerAutomationModule.buildAutomaticBoundRunnerRequests({
  sourceFeatureId: "xiaohongshu/keyword-search",
  targets: boundRunnerTargets,
  rows: [
    { url: "https://www.xiaohongshu.com/explore/64b1234567890abcdef12345" },
    { url: "https://www.xiaohongshu.com/explore/64b1234567890abcdef12345" },
    { url: "https://example.com/not-a-xiaohongshu-post" }
  ],
  forceUpdateData: true
});
if (
  boundRunnerAutomationModule.normalizeAutoRunBoundRunners(true) !== true
  || boundRunnerAutomationModule.normalizeAutoRunBoundRunners("true") !== false
  || boundRunnerTargets.length !== 1
  || autoRunnableTargets[0]?.autoRunnable !== true
  || automaticRunnerRequests.length !== 1
  || automaticRunnerRequests[0].featureId !== "xiaohongshu/post-detail"
  || automaticRunnerRequests[0].parameters.postUrls.length !== 1
  || automaticRunnerRequests[0].parameters.concurrency !== 2
  || automaticRunnerRequests[0].parameters.intervalMinMs !== 1200
  || automaticRunnerRequests[0].parameters.intervalMaxMs !== 2400
  || automaticRunnerRequests[0].parameters.forceUpdateData !== true
  || automaticRunnerRequests[0].execution.sourceFeatureId !== "xiaohongshu/keyword-search"
  || JSON.stringify(automaticRunnerRequests[0].execution.outputFields) !== JSON.stringify(["noteId", "title"])
) {
  throw new Error("绑定 Runner 的目标解析或自动运行参数转换不正确。 ");
}
const xiaohongshuKeywordMonitorSource = readFileSync(
  join(root, "src/groups/xiaohongshu/keyword-search/monitor.js"),
  "utf8"
);
if (
  !appSource.includes("boundRunnerTargets")
  || !xiaohongshuKeywordMonitorSource.includes("绑定的运行器")
  || !xiaohongshuKeywordMonitorSource.includes("自动运行运行器")
  || !xiaohongshuKeywordMonitorSource.includes("buildAutomaticBoundRunnerRequests")
  || !xiaohongshuKeywordMonitorSource.includes("MESSAGE_STOP_FEATURE_RUNNER")
  || !xiaohongshuKeywordMonitorSource.includes("autoRunBoundRunners")
) {
  throw new Error("绑定 Runner 的运行选项展示或自动执行链路没有完整接入。 ");
}
const storageLimitsModule = await import(pathToFileURL(join(root, "src/shared/storage-limits.js")).href);
if (
  storageLimitsModule.applyItemLimit([1, 2, 3], 2).length !== 2
  || storageLimitsModule.applyItemLimit([1, 2, 3], 0).length !== 3
  || storageLimitsModule.formatLimitValue(0) !== "无限"
) {
  throw new Error("数据存储条数限制或 0=无限逻辑不正确。 ");
}
const perStatusFixture = [
  { status: "success", id: 1 },
  { status: "success", id: 2 },
  { status: "success", id: 3 },
  { status: "error", id: 4 },
  { status: "error", id: 5 },
  { status: "error", id: 6 }
];
if (
  storageLimitsModule.limitItemsPerGroup(perStatusFixture, (item) => item.status, 2).length !== 4
  || storageLimitsModule.limitItemsPerGroup(perStatusFixture, (item) => item.status, 0).length !== 6
) {
  throw new Error("任务记录没有按各状态分别限制，或 0=无限逻辑不正确。 ");
}
const executionIntervalModule = await import(pathToFileURL(join(root, "src/shared/execution-interval.js")).href);
const migratedKeywordInterval = executionIntervalModule.migrateLegacyExecutionInterval({
  keywordIntervalMinMs: 100,
  keywordIntervalMaxMs: 1000
}, {
  minKey: "keywordIntervalMinMs",
  maxKey: "keywordIntervalMaxMs",
  legacyMinMs: 100,
  legacyMaxMs: 1000
});
const migratedProfileInterval = executionIntervalModule.migrateLegacyExecutionInterval({
  intervalMinMs: 100,
  intervalMaxMs: 6000
}, {
  legacyMinMs: 100,
  legacyMaxMs: 6000
});
const preservedCustomInterval = executionIntervalModule.migrateLegacyExecutionInterval({
  intervalMinMs: 1500,
  intervalMaxMs: 5000
}, {
  legacyMinMs: 100,
  legacyMaxMs: 6000
});
if (
  migratedKeywordInterval.keywordIntervalMinMs !== 1000
  || migratedKeywordInterval.keywordIntervalMaxMs !== 6000
  || migratedProfileInterval.intervalMinMs !== 1000
  || migratedProfileInterval.intervalMaxMs !== 6000
  || preservedCustomInterval.intervalMinMs !== 1500
  || preservedCustomInterval.intervalMaxMs !== 5000
) {
  throw new Error("统一执行间隔默认值迁移或自定义区间保留逻辑不正确。 ");
}
const taskTimeoutModule = await import(pathToFileURL(join(root, "src/shared/task-timeout.js")).href);
let timeoutStopCalled = false;
let timeoutError = null;
try {
  await taskTimeoutModule.runWithTaskTimeout(
    () => new Promise((resolve) => setTimeout(resolve, 30)),
    { timeoutSeconds: 0.005, onTimeout: () => { timeoutStopCalled = true; } }
  );
} catch (error) {
  timeoutError = error;
}
await new Promise((resolve) => setTimeout(resolve, 0));
if (!timeoutStopCalled || timeoutError?.code !== taskTimeoutModule.TASK_TIMEOUT_ERROR_CODE) {
  throw new Error("任务超时没有停止对应任务并返回失败状态。 ");
}
const pausedTimeoutResult = await taskTimeoutModule.runWithTaskTimeout(
  () => new Promise((resolve) => setTimeout(() => resolve("verified"), 20)),
  { timeoutSeconds: 0.005, isPaused: () => true }
);
if (pausedTimeoutResult !== "verified") {
  throw new Error("人工验证期间任务超时没有暂停计时。 ");
}
const recordStatuses = ["running", "success", "empty", "verification", "risk", "partial", "error", "stopped", "preview"];
const recordFixtures = recordStatuses.flatMap((statusKey) => (
  Array.from({ length: 205 }, (_, index) => ({
    id: `${statusKey}-${index}`,
    statusKey,
    status: statusKey,
    tone: statusKey
  }))
));
const limitedRecords = recordsModule.limitRecordsPerStatus(recordFixtures);
for (const statusKey of recordStatuses) {
  const count = limitedRecords.filter((record) => (
    recordsModule.getRecordStatusKey(record) === statusKey
  )).length;
  if (count !== 200) {
    throw new Error(`运行记录状态 ${statusKey} 应保留 200 条，实际为 ${count} 条。`);
  }
}
const filteredRecords = recordsModule.filterRecords([
  { keyword: "OpenAI", statusKey: "success" },
  { keyword: "OpenAI", statusKey: "error" },
  { keyword: "人工智能", statusKey: "success" }
], { keyword: "OpenAI", status: "success" });
if (filteredRecords.length !== 1 || filteredRecords[0].keyword !== "OpenAI") {
  throw new Error("运行记录关键词与状态组合筛选失败。");
}

const normalizedIntervalRange = recordsModule.normalizeKeywordIntervalRange({
  keywordIntervalMinMs: 1000,
  keywordIntervalMaxMs: 100
});
if (normalizedIntervalRange.keywordIntervalMinMs !== 100 || normalizedIntervalRange.keywordIntervalMaxMs !== 1000) {
  throw new Error("关键词间隔区间没有正确排序。");
}
let waitedKeywordInterval = null;
await recordsModule.waitForKeywordInterval(
  { keywordIntervalMinMs: 100, keywordIntervalMaxMs: 1000 },
  { stopRequested: false },
  {
    randomFunction: () => 0.5,
    waitFunction: async (milliseconds) => { waitedKeywordInterval = milliseconds; }
  }
);
if (waitedKeywordInterval !== 550) {
  throw new Error(`关键词随机间隔没有传入等待流程，实际为 ${waitedKeywordInterval}。`);
}

const xiaohongshuFiltersModule = await import(pathToFileURL(join(
  root,
  "src/groups/xiaohongshu/keyword-search/filter-options.js"
)).href);
const normalizedXiaohongshuFilters = xiaohongshuFiltersModule.normalizeXiaohongshuFilters({
  sort: "latest",
  publishTime: "day",
  location: "nearby"
});
if (normalizedXiaohongshuFilters.sort !== "latest" || normalizedXiaohongshuFilters.publishTime !== "day" || normalizedXiaohongshuFilters.location !== "nearby") {
  throw new Error("小红书页面筛选条件没有正确标准化。");
}
const xiaohongshuSearchModule = await import(pathToFileURL(join(
  root,
  "src/groups/xiaohongshu/keyword-search/search-url.js"
)).href);
const xiaohongshuSearchUrl = xiaohongshuSearchModule.buildXiaohongshuSearchUrl("openai");
if (!/\/search_result_ai\?keyword=openai&source=web_explore_feed$/.test(xiaohongshuSearchUrl)) {
  throw new Error(`小红书搜索地址构建错误：${xiaohongshuSearchUrl}`);
}

const xiaohongshuDateModule = await import(pathToFileURL(join(
  root,
  "src/groups/xiaohongshu/date-normalizer.js"
)).href);
const xiaohongshuReferenceDate = new Date(2026, 6, 15, 4, 26, 0);
const xiaohongshuDateCases = new Map([
  ["2025-11-18", "2025-11-18"],
  ["2025年8月6日 12:30", "2025-08-06"],
  ["2024年1月2日", "2024-01-02"],
  ["04-11", "2026-04-11"],
  ["12-13", "2025-12-13"],
  ["6天前", "2026-07-09"],
  ["3小时前", "2026-07-15"],
  ["昨天 18:20", "2026-07-14"]
]);
for (const [rawDate, expectedDate] of xiaohongshuDateCases) {
  const normalizedDate = xiaohongshuDateModule.normalizeXiaohongshuPublishedDate(rawDate, {
    referenceDate: xiaohongshuReferenceDate
  });
  if (normalizedDate !== expectedDate) {
    throw new Error(`小红书发布时间 ${rawDate} 标准化错误：${normalizedDate}，预期 ${expectedDate}。`);
  }
}
if (xiaohongshuDateModule.normalizeXiaohongshuPublishedDate("2026-02-30", {
  referenceDate: xiaohongshuReferenceDate
}) !== "") {
  throw new Error("小红书无效发布时间没有被拒绝。 ");
}

const xiaohongshuMonitorSource = readFileSync(join(
  root,
  "src/groups/xiaohongshu/keyword-search/monitor.js"
), "utf8");
if (!/function sendMessage\(message\)\s*\{\s*return callChrome\(/.test(xiaohongshuMonitorSource)) {
  throw new Error("小红书运行页缺少向后台发送采集指令的 sendMessage 通道。");
}

const xiaohongshuBackgroundSource = readFileSync(join(
  root,
  "src/groups/xiaohongshu/keyword-search/background.js"
), "utf8");
if (!/waitForFilteredSearchResults/.test(xiaohongshuBackgroundSource) || /await sleep\(900\);/.test(xiaohongshuBackgroundSource)) {
  throw new Error("小红书筛选后缺少结果稳定等待，或仍在使用固定 900 ms 等待。");
}
if (
  !xiaohongshuBackgroundSource.includes("let managedLoginTabId = null;")
  || !xiaohongshuBackgroundSource.includes("每次检测都使用专用临时页")
  || !xiaohongshuBackgroundSource.includes("await closePluginCreatedTab(tab.id);")
  || !xiaohongshuBackgroundSource.includes("const tab = await getManagedLoginTab(true);")
  || !xiaohongshuBackgroundSource.includes("const hasRequestedTab = Number.isInteger(parsedTabId) && parsedTabId > 0;")
) {
  throw new Error("小红书登录检测专用页、独立采集页或自动关闭策略未正确处理。 ");
}
const xiaohongshuLoginGateSource = readFileSync(join(
  root,
  "src/groups/xiaohongshu/keyword-search/login-gate.js"
), "utf8");
if (
  !xiaohongshuLoginGateSource.includes("function waitForNextPaint()")
  || !xiaohongshuLoginGateSource.includes("xhs-login-progress")
  || !xiaohongshuLoginGateSource.includes("正在准备登录检测，检测页会在后台打开。")
) {
  throw new Error("小红书登录检测页面没有展示可感知的检查过程。 ");
}
const weiboProfilePostsBackgroundSource = readFileSync(join(
  root,
  "src/groups/weibo/profile-posts/background.js"
), "utf8");
const weiboProfilePostsLoginGateSource = readFileSync(join(
  root,
  "src/groups/weibo/profile-posts/login-gate.js"
), "utf8");
const weiboProfilePostsIndexSource = readFileSync(join(
  root,
  "src/groups/weibo/profile-posts/index.js"
), "utf8");
if (
  !weiboProfilePostsBackgroundSource.includes("export async function checkWeiboProfilePostsLogin()")
  || !weiboProfilePostsBackgroundSource.includes("export async function openWeiboProfilePostsLogin()")
  || !weiboProfilePostsBackgroundSource.includes("let managedLoginTabId = null;")
  || !weiboProfilePostsBackgroundSource.includes("active: false")
  || !weiboProfilePostsBackgroundSource.includes("loggedInPolls >= 3")
  || !weiboProfilePostsBackgroundSource.includes("await closePluginCreatedTab(tab.id);")
  || !weiboProfilePostsLoginGateSource.includes("MESSAGE_CHECK_WEIBO_PROFILE_POSTS_LOGIN")
  || !weiboProfilePostsLoginGateSource.includes("MESSAGE_OPEN_WEIBO_PROFILE_POSTS_LOGIN")
  || !weiboProfilePostsLoginGateSource.includes("微博登录检测进度")
  || !weiboProfilePostsLoginGateSource.includes("仅检测到登录成功后")
  || !weiboProfilePostsIndexSource.includes("mountWeiboProfilePostsLoginGate")
) {
  throw new Error("微博博主博文采集缺少登录检测门禁、检测过程或独立临时页清理。 ");
}
if (
  !serviceWorkerSource.includes("MESSAGE_CHECK_WEIBO_PROFILE_POSTS_LOGIN")
  || !serviceWorkerSource.includes("MESSAGE_OPEN_WEIBO_PROFILE_POSTS_LOGIN")
  || !serviceWorkerSource.includes("checkWeiboProfilePostsLogin")
  || !serviceWorkerSource.includes("openWeiboProfilePostsLogin")
) {
  throw new Error("微博博主博文采集登录检测消息没有接入后台服务。 ");
}
const xiaohongshuPageExtractSource = readFileSync(join(
  root,
  "src/groups/xiaohongshu/keyword-search/page-extract.js"
), "utf8");
if (
  !/waitForSelection/.test(xiaohongshuPageExtractSource)
  || !/resultSignature/.test(xiaohongshuPageExtractSource)
  || !/normalizeLikes/.test(xiaohongshuPageExtractSource)
) {
  throw new Error("小红书筛选条件或结果稳定性检测没有接入页面脚本。");
}
const xiaohongshuLikes = await import(pathToFileURL(join(
  root,
  "src/groups/xiaohongshu/likes-normalizer.js"
)).href);
for (const [input, expected] of [["赞", "0"], ["点赞", "0"], ["", "0"], [null, "0"], ["点赞 18", "18"], ["1.2万", "1.2万"]]) {
  const actual = xiaohongshuLikes.normalizeXiaohongshuLikes(input);
  if (actual !== expected) {
    throw new Error(`小红书点赞数归一错误：${String(input)} 应为 ${expected}，实际为 ${actual}。`);
  }
}
const xiaohongshuKeywordExport = await import(pathToFileURL(join(
  root,
  "src/groups/xiaohongshu/keyword-search/export-data.js"
)).href);
if (xiaohongshuKeywordExport.buildXiaohongshuKeywordExportRows([{ likes: "赞" }])[0].likes !== "0") {
  throw new Error("小红书关键词数据导出没有将无点赞数归一为 0。");
}

const googleNewsPageExtractSource = readFileSync(join(
  root,
  "src/groups/google/google-news/page-extract.js"
), "utf8");
if (
  !googleNewsPageExtractSource.includes("a.aJWbwf")
  || !googleNewsPageExtractSource.includes('getAttribute("data-ts")')
  || !googleNewsPageExtractSource.includes('container.querySelector("[data-ts], [data-timestamp]")')
  || !googleNewsPageExtractSource.includes("publishedAtTimestamp")
) {
  throw new Error("Google 新闻没有按单条卡片读取真实发布时间戳。 ");
}

const weiboDateModule = await import(pathToFileURL(join(
  root,
  "src/groups/weibo/date-normalizer.js"
)).href);
const weiboReferenceDate = new Date(2026, 6, 16, 12, 0, 0);
const weiboDateCases = new Map([
  ["26-7-16 11:16", "2026-7-16 11:16"],
  ["2026-07-15 11:00", "2026-7-15 11:00"],
  ["2026年7月6日 01:02", "2026-7-6 01:02"],
  ["昨天 09:30", "2026-7-15 09:30"],
  ["Houson猴姆", ""]
]);
for (const [rawDate, expectedDate] of weiboDateCases) {
  const actualDate = weiboDateModule.normalizeWeiboPublishedAt(rawDate, { referenceDate: weiboReferenceDate });
  if (actualDate !== expectedDate) {
    throw new Error(`微博发布时间 ${rawDate} 标准化错误：${actualDate}，预期 ${expectedDate}。`);
  }
}
const weiboPageExtractSource = readFileSync(join(root, "src/groups/weibo/page-extract.js"), "utf8");
if (
  !weiboPageExtractSource.includes("publishedAtFromCard")
  || !weiboPageExtractSource.includes("isPublishedAtText")
  || weiboPageExtractSource.includes('publishedAt: normalText(canonicalLink?.getAttribute("title") || canonicalLink?.innerText)')
) {
  throw new Error("微博正文发布时间没有限定为日期链接，仍可能误取作者名称。");
}
const weiboPostDetailExport = await import(pathToFileURL(join(
  root,
  "src/groups/weibo/post-detail/export-data.js"
)).href);
const weiboPostExportRows = weiboPostDetailExport.buildWeiboPostDetailExportRows([
  { postId: "one", publishedAt: "26-7-16 11:16", capturedAt: "2026-07-16T03:25:09.573Z" },
  { postId: "three", author: "Houson猴姆", publishedAt: "Houson猴姆", capturedAt: "2026-07-16T03:23:17.037Z" }
]);
if (weiboPostExportRows[0].publishedAt !== "2026-7-16 11:16" || weiboPostExportRows[1].publishedAt !== "") {
  throw new Error("微博正文导出没有修正两位年份或错误的作者名称发布时间。");
}
const weiboPostDetailMonitorSource = readFileSync(join(root, "src/groups/weibo/post-detail/monitor.js"), "utf8");
const weiboProfileInfoMonitorSource = readFileSync(join(root, "src/groups/weibo/profile-info/monitor.js"), "utf8");
const weiboProfilePostsMonitorSource = readFileSync(join(root, "src/groups/weibo/profile-posts/monitor.js"), "utf8");
const weiboProfileMonitorSource = readFileSync(join(root, "src/groups/weibo/profile-monitor.js"), "utf8");
if (
  !weiboPostDetailMonitorSource.includes('defaultUrls: ["https://weibo.com/2656274875/R8TUWtvwU"]')
  || !weiboProfileInfoMonitorSource.includes('defaultUrls: ["https://weibo.com/u/2656274875"]')
  || !readFileSync(join(root, "src/groups/weibo/profile-monitor.js"), "utf8").includes("uniqueUrls(settings.defaultUrls)")
) {
  throw new Error("微博正文/博主信息采集没有配置默认示例链接，或共享模板未读取默认链接。");
}
if (
  !weiboProfilePostsMonitorSource.includes("defaultLimit: 10")
  || !weiboProfilePostsMonitorSource.includes("defaultLimitVersion: 1")
  || !weiboProfilePostsMonitorSource.includes("随机等待 2.2–4.5 秒")
  || !weiboProfileMonitorSource.includes("settings.defaultLimit")
  || !weiboProfileMonitorSource.includes("savedConfig.defaultLimitVersion")
  || !weiboProfilePostsBackgroundSource.includes("function randomScrollPause()")
  || !weiboProfilePostsBackgroundSource.includes("2200 + Math.random() * 2301")
  || !weiboProfilePostsBackgroundSource.includes("waitForScrollPause")
  || weiboProfilePostsBackgroundSource.includes("await sleep(1100)")
  || !weiboPageExtractSource.includes("minimumRatio")
  || !weiboPageExtractSource.includes("maximumRatio")
  || !weiboPageExtractSource.includes('window.scrollTo({ top: to, behavior: "smooth" })')
) {
  throw new Error("微博博主博文采集没有接入默认 10 条、短距离滚动或随机停顿策略。");
}

const xiaohongshuProfileMonitor = await import(pathToFileURL(join(
  root,
  "src/groups/xiaohongshu/profile-notes/monitor.js"
)).href);
const profileIntervalRange = xiaohongshuProfileMonitor.normalizeProfileIntervalRange({
  intervalMinMs: 6000,
  intervalMaxMs: 100
});
if (profileIntervalRange.intervalMinMs !== 100 || profileIntervalRange.intervalMaxMs !== 6000) {
  throw new Error("博主主页采集的随机间隔区间没有正确排序。");
}
let waitedProfileInterval = null;
await xiaohongshuProfileMonitor.waitForProfileInterval(
  { intervalMinMs: 100, intervalMaxMs: 6000 },
  { stopRequested: false },
  {
    randomFunction: () => 0.5,
    waitFunction: async (milliseconds) => { waitedProfileInterval = milliseconds; }
  }
);
if (waitedProfileInterval !== 3050) {
  throw new Error(`博主主页随机间隔没有传入等待流程，实际为 ${waitedProfileInterval}。`);
}
const profileRecordFixtures = recordStatuses.flatMap((statusKey) => (
  Array.from({ length: 205 }, (_, index) => ({ id: `${statusKey}-${index}`, statusKey }))
));
const limitedProfileRecords = xiaohongshuProfileMonitor.limitProfileRecordsPerStatus(profileRecordFixtures);
for (const statusKey of recordStatuses.filter((statusKey) => !["preview", "empty", "verification", "risk"].includes(statusKey))) {
  const count = limitedProfileRecords.filter((record) => (
    xiaohongshuProfileMonitor.getProfileRecordStatusKey(record) === statusKey
  )).length;
  if (count !== 200) {
    throw new Error(`博主主页运行记录状态 ${statusKey} 应保留 200 条，实际为 ${count} 条。`);
  }
}
const updatedProfileRecords = xiaohongshuProfileMonitor.updateProfileRecord([{
  id: "XHP-1",
  statusKey: "running",
  status: "运行中",
  resultCount: 0,
  addedCount: 0,
  duration: "-"
}], "XHP-1", {
  statusKey: "success",
  status: "完成",
  tone: "success",
  resultCount: 20,
  addedCount: 12,
  duration: "1.2 秒"
});
if (
  updatedProfileRecords[0].status !== "完成"
  || updatedProfileRecords[0].resultCount !== 20
  || updatedProfileRecords[0].addedCount !== 12
  || updatedProfileRecords[0].duration !== "1.2 秒"
) {
  throw new Error("博主博文任务完成后没有正确回写状态、结果数量、新增数量或耗时。");
}

const xiaohongshuProfileExport = await import(pathToFileURL(join(
  root,
  "src/groups/xiaohongshu/profile-notes/export-data.js"
)).href);
const profileExportRows = xiaohongshuProfileExport.buildXiaohongshuProfileExportRows([{
  noteId: "note-123",
  noteTitle: "测试笔记",
  noteLikes: "赞",
  noteUrl: "https://www.xiaohongshu.com/user/profile/a/b"
}]);
if (
  profileExportRows[0].noteId !== "note-123"
  || profileExportRows[0].noteTitle !== "测试笔记"
  || profileExportRows[0].noteLikes !== "0"
  || "nickname" in profileExportRows[0]
) {
  throw new Error("博主主页导出字段映射错误。");
}
if (!xiaohongshuProfileExport.serializeXiaohongshuProfileCsv(profileExportRows).includes("noteTitle")) {
  throw new Error("博主主页 CSV 导出缺少笔记字段。");
}
const xiaohongshuProfileBackgroundSource = readFileSync(join(
  root,
  "src/groups/xiaohongshu/profile-notes/background.js"
), "utf8");
if (!/waitForProfilePage/.test(xiaohongshuProfileBackgroundSource)
  || !/collectProfileData/.test(xiaohongshuProfileBackgroundSource)
  || !/scrollPageToBottom/.test(xiaohongshuProfileBackgroundSource)
  || !/executeTabFunction/.test(xiaohongshuProfileBackgroundSource)
  || !/navigateTab/.test(xiaohongshuProfileBackgroundSource)) {
  throw new Error("博主主页采集缺少页面稳定等待、滚动加载或跳转链路。");
}
const xiaohongshuProfilePageSource = readFileSync(join(
  root,
  "src/groups/xiaohongshu/profile-notes/page-extract.js"
), "utf8");
if (!/section\.note-item/.test(xiaohongshuProfilePageSource)
  || !/a\.title/.test(xiaohongshuProfilePageSource)
  || !/normalizeLikes/.test(xiaohongshuProfilePageSource)
  || /user-redId|user-interactions|user-desc/.test(xiaohongshuProfilePageSource)
  || !/loading:\s*cards\.length\s*===\s*0\s*&&\s*hasVisibleLoading\(\)/.test(xiaohongshuProfilePageSource)) {
  throw new Error("博主主页页面解析没有正确限制为笔记卡片字段。");
}

const xiaohongshuProfileInfoExport = await import(pathToFileURL(join(
  root,
  "src/groups/xiaohongshu/profile-info/export-data.js"
)).href);
const profileInfoExportRows = xiaohongshuProfileInfoExport.buildXiaohongshuProfileInfoExportRows([{
  profileId: "profile-123",
  nickname: "测试博主",
  followers: "88"
}]);
if (profileInfoExportRows[0].profileId !== "profile-123" || profileInfoExportRows[0].nickname !== "测试博主" || profileInfoExportRows[0].followers !== "88") {
  throw new Error("博主信息导出字段映射错误。");
}
const xiaohongshuProfileInfoBackgroundSource = readFileSync(join(
  root,
  "src/groups/xiaohongshu/profile-info/background.js"
), "utf8");
if (!/waitForProfileInfo/.test(xiaohongshuProfileInfoBackgroundSource)
  || !/navigateTab/.test(xiaohongshuProfileInfoBackgroundSource)
  || !/executeTabFunction/.test(xiaohongshuProfileInfoBackgroundSource)
  || !/captureXiaohongshuProfileInfo/.test(xiaohongshuProfileInfoBackgroundSource)) {
  throw new Error("博主信息采集缺少页面稳定等待或导航链路。");
}
const xiaohongshuProfileInfoPageSource = readFileSync(join(
  root,
  "src/groups/xiaohongshu/profile-info/page-extract.js"
), "utf8");
if (!/user-redId/.test(xiaohongshuProfileInfoPageSource)
  || !/user-interactions/.test(xiaohongshuProfileInfoPageSource)
  || !/user-desc/.test(xiaohongshuProfileInfoPageSource)
  || /section\.note-item/.test(xiaohongshuProfileInfoPageSource)) {
  throw new Error("博主信息页面解析缺少资料字段，或意外接入了博文卡片。");
}

const taskDetailModule = await import(pathToFileURL(join(root, "src/shared/task-detail.js")).href);
const taskRecordTypeModule = await import(pathToFileURL(join(root, "src/shared/task-record-type.js")).href);
if (
  taskRecordTypeModule.normalizeTaskExecutionType({}) !== "manual"
  || taskRecordTypeModule.normalizeTaskExecutionType({ executionType: "runner" }) !== "runner"
  || taskRecordTypeModule.getTaskExecutionTypeLabel("runner") !== "运行器"
) {
  throw new Error("任务运行类型没有正确兼容旧记录或识别 Runner 记录。 ");
}
const taskId = "TASK-20260714";
const taskRecords = [
  { id: `${taskId}-R1-K1`, runId: taskId, keyword: "OpenAI", round: 1, statusKey: "success", status: "完成", resultCount: 3, addedCount: 2, duration: "1 秒" },
  { id: `${taskId}-R1-K2`, runId: taskId, runnerTaskId: "RUNNER-PARENT-1", executionType: "runner", keyword: "人工智能", round: 1, statusKey: "error", status: "失败", resultCount: 0, addedCount: 0, duration: "500 ms", error: "页面脚本执行失败" }
];
const taskDetails = taskDetailModule.getTaskRecordDetails(taskRecords, taskRecords[1].id);
if (taskDetails?.record?.keyword !== "人工智能" || taskDetails.record.round !== 1 || taskDetails.record.error !== "页面脚本执行失败") {
  throw new Error("任务明细没有正确定位到当前关键词任务。");
}
const taskDetailMarkup = taskDetailModule.renderTaskDetailModal({
  detail: taskDetails,
  prefix: "test",
  featureName: "测试功能",
  escapeHtml: (value) => String(value),
  renderStatus: (record) => record.status
});
if (
  !taskDetailMarkup.includes("人工智能")
  || !taskDetailMarkup.includes("页面脚本执行失败")
  || !taskDetailMarkup.includes("结果数量")
  || !taskDetailMarkup.includes("新增数量")
  || !taskDetailMarkup.includes("运行类型")
  || !taskDetailMarkup.includes("运行器")
  || !taskDetailMarkup.includes("父 Runner 任务")
  || taskDetailMarkup.includes("执行明细")
  || taskDetailMarkup.includes("采集数据")
) {
  throw new Error("任务明细没有正确显示单个关键词任务或仍包含已移除区块。");
}
for (const relativePath of [
  "src/groups/google/google-news/monitor.js",
  "src/groups/xiaohongshu/keyword-search/monitor.js",
  "src/groups/xiaohongshu/profile-notes/monitor.js",
  "src/groups/xiaohongshu/profile-info/monitor.js",
  "src/groups/weibo/profile-monitor.js"
]) {
  const source = readFileSync(join(root, relativePath), "utf8");
  if (
    !source.includes("结果数量")
    || !source.includes("新增数量")
    || !source.includes("addedCount")
    || !source.includes('data-record-filter="executionType"')
    || !source.includes("TASK_EXECUTION_TYPE_MANUAL")
    || !source.includes("normalizeTaskExecutionType")
    || !source.includes("<th>类型</th>")
    || !source.includes('data-field="forceUpdateData"')
    || !source.includes("强制更新数据")
    || !source.includes("mergeDataRowsByKey")
  ) {
    throw new Error(`功能缺少运行记录字段、强制更新数据开关或统一去重策略：${relativePath}`);
  }
}

const taskPool = await import(pathToFileURL(join(root, "src/shared/concurrent-task-pool.js")).href);
if (
  taskPool.normalizeTaskConcurrency() !== 1
  || taskPool.normalizeTaskConcurrency(0) !== 1
  || taskPool.normalizeTaskConcurrency(99) !== 3
) {
  throw new Error("任务并发数没有限制在 1–3 的安全范围内。");
}
const unifiedFeatureStyles = readFileSync(join(root, "src/groups/xiaohongshu/keyword-search/styles.css"), "utf8");
if (
  !unifiedFeatureStyles.includes("--xhs-blue: #2f73e8;")
  || !unifiedFeatureStyles.includes("--xhs-blue-dark: #1f5ec7;")
  || !unifiedFeatureStyles.includes("--xhs-blue-soft: #edf4ff;")
  || !/\.xhs-stop-button\s*\{\s*border:\s*1px solid #d85050;\s*background:\s*#d85050;/s.test(unifiedFeatureStyles)
) {
  throw new Error("功能运行按钮的蓝色待运行、红色停止状态没有统一。" );
}
let activeTaskCount = 0;
let maxActiveTaskCount = 0;
const completedConcurrentTasks = [];
await taskPool.runConcurrentTasks(["a", "b", "c", "d"], {
  concurrency: 2,
  worker: async (item) => {
    activeTaskCount += 1;
    maxActiveTaskCount = Math.max(maxActiveTaskCount, activeTaskCount);
    await new Promise((resolve) => setTimeout(resolve, 1));
    completedConcurrentTasks.push(item);
    activeTaskCount -= 1;
  }
});
if (maxActiveTaskCount !== 2 || completedConcurrentTasks.length !== 4) {
  throw new Error("任务并发池没有按设定并发数完成全部独立任务。");
}
const concurrentMonitorFiles = [
  ["src/groups/google/google-news/monitor.js", /getOrCreateGoogleTab\(null, true\)/],
  ["src/groups/xiaohongshu/keyword-search/monitor.js", /isolated:\s*true/],
  ["src/groups/xiaohongshu/profile-notes/monitor.js", /isolated:\s*true/],
  ["src/groups/xiaohongshu/profile-info/monitor.js", /isolated:\s*true/],
  ["src/groups/weibo/profile-monitor.js", /isolated:\s*true/]
];
for (const [relativePath, isolatedTabMarker] of concurrentMonitorFiles) {
  const source = readFileSync(join(root, relativePath), "utf8");
  if (!/runConcurrentTasks/.test(source) || !isolatedTabMarker.test(source)) {
    throw new Error(`${relativePath} 没有接入独立标签页的并发任务流程。`);
  }
}

const isolatedTargetPageFiles = [
  "src/groups/google/google-news/monitor.js",
  "src/groups/xiaohongshu/keyword-search/background.js",
  "src/groups/xiaohongshu/profile-notes/background.js",
  "src/groups/xiaohongshu/profile-info/background.js",
  "src/groups/xiaohongshu/post-detail/background.js",
  "src/groups/weibo/profile-posts/background.js",
  "src/groups/weibo/profile-info/background.js",
  "src/groups/weibo/post-detail/background.js",
  "src/groups/douyin/capture.js"
];
for (const relativePath of isolatedTargetPageFiles) {
  const source = readFileSync(join(root, relativePath), "utf8");
  if (!/isolated/.test(source) || !/active:\s*false/.test(source)) {
    throw new Error(`${relativePath} 没有为采集任务保留独立且不抢焦点的目标标签页。`);
  }
}

const douyinCaptureModule = await import(pathToFileURL(join(root, "src/groups/douyin/capture.js")).href);
if (
  douyinCaptureModule.getDouyinPostId("https://www.douyin.com/video/7599201948415610811") !== "7599201948415610811"
  || douyinCaptureModule.getDouyinPostId("https://www.douyin.com/user/example?modal_id=7533090992522562852") !== "7533090992522562852"
  || douyinCaptureModule.getDouyinPostId("https://v.douyin.com/example/") !== ""
) {
  throw new Error("抖音作品目标 ID 解析不正确，无法校验采集结果是否属于输入链接。");
}
const douyinCaptureSource = readFileSync(join(root, "src/groups/douyin/capture.js"), "utf8");
const douyinPageExtractSource = readFileSync(join(root, "src/groups/douyin/page-extract.js"), "utf8");
if (
  !douyinCaptureSource.includes("DOUYIN_POST_NOT_FOUND")
  || !douyinCaptureSource.includes("expectedVideoId")
  || !douyinCaptureSource.includes("completed || session.stopped || unavailable")
  || !douyinPageExtractSource.includes("web_video_404_link")
  || !douyinPageExtractSource.includes("video_id_mismatch")
  || !douyinPageExtractSource.includes("unavailable: redirectedFromMissingVideo || videoIdMismatch")
) {
  throw new Error("抖音失效作品跳转、作品 ID 一致性校验或失效标签页清理没有完整接入。");
}

const xiaohongshuPostDetailModule = await import(pathToFileURL(join(root, "src/groups/xiaohongshu/post-detail/background.js")).href);
if (
  xiaohongshuPostDetailModule.getXiaohongshuNoteId("https://www.xiaohongshu.com/explore/6a584af2000000000103273f") !== "6a584af2000000000103273f"
  || xiaohongshuPostDetailModule.getXiaohongshuNoteId("https://www.xiaohongshu.com/search_result/6a584af2000000000103273f?xsec_token=test") !== "6a584af2000000000103273f"
  || xiaohongshuPostDetailModule.getXiaohongshuNoteId("https://www.xiaohongshu.com/user/profile/55a72e6662a60c578b0e9eb9/6a584af2000000000103273f") !== "6a584af2000000000103273f"
  || xiaohongshuPostDetailModule.isXiaohongshuPostUrl("https://example.com/explore/6a584af2000000000103273f")
) {
  throw new Error("小红书正文链接或目标笔记 ID 解析不正确。");
}
const xiaohongshuPostDetailSource = readFileSync(join(root, "src/groups/xiaohongshu/post-detail/background.js"), "utf8");
const xiaohongshuPostPageSource = readFileSync(join(root, "src/groups/xiaohongshu/post-detail/page-extract.js"), "utf8");
const xiaohongshuPostMonitorSource = readFileSync(join(root, "src/groups/xiaohongshu/post-detail/monitor.js"), "utf8");
if (
  !xiaohongshuPostDetailSource.includes("expectedNoteId")
  || !xiaohongshuPostDetailSource.includes("session.closeOnExit")
  || !xiaohongshuPostPageSource.includes("#detail-title")
  || !xiaohongshuPostPageSource.includes("#detail-desc")
  || !xiaohongshuPostPageSource.includes("当前笔记暂时无法浏览")
  || !xiaohongshuPostMonitorSource.includes('supportsPolling: false')
  || !xiaohongshuPostMonitorSource.includes('hasLimit: false')
  || !serviceWorkerSource.includes("MESSAGE_CAPTURE_XIAOHONGSHU_POST_DETAIL")
) {
  throw new Error("小红书正文稳定等待、失效链接拦截、数据界面或后台消息路由没有完整接入。");
}

const targetTabCleanupFiles = [
  "src/groups/xiaohongshu/keyword-search/background.js",
  "src/groups/xiaohongshu/profile-notes/background.js",
  "src/groups/xiaohongshu/profile-info/background.js",
  "src/groups/xiaohongshu/post-detail/background.js",
  "src/groups/weibo/profile-posts/background.js",
  "src/groups/weibo/profile-info/background.js",
  "src/groups/weibo/post-detail/background.js",
  "src/groups/douyin/capture.js"
];
for (const relativePath of targetTabCleanupFiles) {
  const source = readFileSync(join(root, relativePath), "utf8");
  if (
    !source.includes("closePluginCreatedTab")
    || !source.includes("completed || session.stopped")
    || !source.includes("Boolean(options.isolated) && !hasRequestedTab")
  ) {
    throw new Error(`${relativePath} 没有按成功/停止关闭、异常保留的采集标签页清理策略运行。`);
  }
}
const nonDebuggerCaptureFiles = [
  "src/groups/google/google-news/background.js",
  ...targetTabCleanupFiles
];
for (const relativePath of nonDebuggerCaptureFiles) {
  const source = readFileSync(join(root, relativePath), "utf8");
  if (
    !source.includes("executeTabFunction")
    || !source.includes("navigateTab")
    || /debugger-client|attachDebugger|detachDebugger|chrome\.debugger|sendCommand\(|Runtime\.evaluate|Page\.navigate/.test(source)
  ) {
    throw new Error(`${relativePath} 仍包含调试协议调用或没有接入统一页面脚本客户端。`);
  }
}
const googleMonitorCleanupSource = readFileSync(join(root, "src/groups/google/google-news/monitor.js"), "utf8");
const googleBackgroundCleanupSource = readFileSync(join(root, "src/groups/google/google-news/background.js"), "utf8");
if (
  !googleMonitorCleanupSource.includes("ownedTargetTabIds")
  || !googleMonitorCleanupSource.includes("closePluginCreatedGoogleTab")
  || !googleMonitorCleanupSource.includes('finishRecord(keywordRecord.record, keywordRecord.startedAtMs, "empty", 0)')
  || !googleMonitorCleanupSource.includes('finishRecord(keywordRecord.record, keywordRecord.startedAtMs, "risk", 0, 0, errorText)')
  || !googleMonitorCleanupSource.includes("riskControlTriggered")
  || !googleMonitorCleanupSource.includes("haltForRiskControl")
  || !googleMonitorCleanupSource.includes("verificationPending")
  || !googleMonitorCleanupSource.includes("isPaused:")
  || !googleMonitorCleanupSource.includes("MESSAGE_GOOGLE_NEWS_CAPTURE_STATUS")
  || !googleBackgroundCleanupSource.includes("empty: Boolean(pageState?.noResults")
  || !googleBackgroundCleanupSource.includes("isGoogleNewsNoResultsText")
  || !googleBackgroundCleanupSource.includes("isGoogleNewsRiskControlState")
  || !googleBackgroundCleanupSource.includes('notifyCaptureStatus(session, "waiting_verification"')
  || !googleBackgroundCleanupSource.includes('notifyCaptureStatus(session, "verification_passed"')
  || !googleBackgroundCleanupSource.includes('notifyCaptureStatus(session, "capture_resumed"')
  || !googleBackgroundCleanupSource.includes("focusVerificationTab")
  || !googleBackgroundCleanupSource.includes("executeTabFunction")
  || !googleBackgroundCleanupSource.includes("navigateTab")
  || !serviceWorkerSource.includes("errorCode: error.code")
) {
  throw new Error("Google 新闻监控没有完整使用非调试采集、人工验证恢复或采集标签页清理。 ");
}

const persistentFeatureRuns = [
  [
    "src/groups/google/google-news/monitor.js",
    "activeGoogleNewsRun",
    "GOOGLE_NEWS_RUN_FINISHED_EVENT"
  ],
  [
    "src/groups/xiaohongshu/keyword-search/monitor.js",
    "activeXiaohongshuKeywordRun",
    "XIAOHONGSHU_KEYWORD_RUN_FINISHED_EVENT"
  ]
];
for (const [relativePath, activeRunName, finishedEventName] of persistentFeatureRuns) {
  const source = readFileSync(join(root, relativePath), "utf8");
  const cleanupStart = source.lastIndexOf("return () => {");
  const cleanupSource = cleanupStart >= 0 ? source.slice(cleanupStart) : "";
  if (
    !source.includes(`let ${activeRunName} = null;`)
    || !source.includes(finishedEventName)
    || /stopRequested\s*=\s*true|MESSAGE_STOP_/.test(cleanupSource)
  ) {
    throw new Error(`${relativePath} 在切换功能页面时仍可能终止后台任务。`);
  }
}

const runtimeJsonParameterSources = [
  "src/groups/google/google-news/monitor.js",
  "src/groups/xiaohongshu/keyword-search/monitor.js",
  "src/groups/xiaohongshu/profile-notes/monitor.js",
  "src/groups/xiaohongshu/profile-info/monitor.js",
  "src/groups/weibo/profile-monitor.js"
];
for (const relativePath of runtimeJsonParameterSources) {
  const source = readFileSync(join(root, relativePath), "utf8");
  if (
    !source.includes("运行参数 JSON")
    || !source.includes("校验并应用")
    || !source.includes('data-action="set-mode"')
    || !source.includes('data-action="apply-json"')
    || !source.includes("data-json-input")
    || !source.includes("JSON 参数已校验并同步到表单。")
    || !source.includes("JSON 顶层必须是一个对象。")
  ) {
    throw new Error(`运行参数缺少表单/JSON 双模式、校验或同步能力：${relativePath}`);
  }
}
const sharedRuntimeJsonFeatureMonitors = [
  ...["profile-posts", "profile-info", "post-detail"].flatMap((feature) => [
    `src/groups/weibo/${feature}/monitor.js`,
    `src/groups/douyin/${feature}/monitor.js`
  ]),
  "src/groups/xiaohongshu/post-detail/monitor.js"
];
for (const relativePath of sharedRuntimeJsonFeatureMonitors) {
  const source = readFileSync(join(root, relativePath), "utf8");
  if (!source.includes("createWeiboProfileMonitor")) {
    throw new Error(`功能没有接入带 JSON 参数模式的统一任务界面：${relativePath}`);
  }
}
const runtimeJsonCoveredFeatures = 2 + 2 + sharedRuntimeJsonFeatureMonitors.length;
if (runtimeJsonCoveredFeatures !== featureKeys.size) {
  throw new Error(`运行参数 JSON 覆盖数量不完整：${runtimeJsonCoveredFeatures}/${featureKeys.size}`);
}

const runnerPanelSource = readFileSync(join(root, "src/shared/feature-runner-panel.js"), "utf8");
if (
  !runnerPanelSource.includes("getFeatureRunnerPanelState")
  || !runnerPanelSource.includes("handleFeatureRunnerPanelAction")
  || !runnerPanelSource.includes("MESSAGE_VALIDATE_FEATURE_RUNNER")
  || !runnerPanelSource.includes("MESSAGE_EXECUTE_FEATURE_RUNNER")
  || !runnerPanelSource.includes("MESSAGE_STOP_FEATURE_RUNNER")
  || !runnerPanelSource.includes("MESSAGE_FEATURE_RUNNER_TASK_STATUS")
  || !runnerPanelSource.includes("data-runner-json-input")
) {
  throw new Error("共享 Runner 面板缺少配置校验、执行、停止或任务状态能力。");
}
for (const relativePath of runtimeJsonParameterSources) {
  const source = readFileSync(join(root, relativePath), "utf8");
  if (
    !source.includes('data-mode="runner"')
    || !source.includes("renderFeatureRunnerPanel")
    || !source.includes("handleFeatureRunnerPanelAction")
    || !source.includes("subscribeFeatureRunnerPanel")
    || !source.includes("updateFeatureRunnerDraft")
  ) {
    throw new Error(`运行参数缺少统一 Runner 页签或消息交互：${relativePath}`);
  }
}
if (
  !featureShellSource.includes(".feature-runner-panel")
  || !featureShellSource.includes(".feature-runner-status")
  || !featureShellSource.includes(".task-execution-type")
  || !featureShellSource.includes(".task-execution-type.runner")
) {
  throw new Error("功能公共样式缺少 Runner 配置面板或任务状态样式。");
}

console.log(`验证通过：${config.groups.length} 个分组，${featureKeys.size} 个功能，${javascriptFiles.length} 个 JavaScript 文件。`);

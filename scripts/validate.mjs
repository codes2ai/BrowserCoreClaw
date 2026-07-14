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

const config = readJson(configPath);
if (!Array.isArray(config.groups) || config.groups.length === 0) {
  throw new Error("groups.json 至少需要一个分组。 ");
}

const featureKeys = new Set();
for (const group of config.groups) {
  if (!group.id || !group.name || !Array.isArray(group.features)) {
    throw new Error(`分组配置不完整：${group.id || "unknown"}`);
  }

  for (const feature of group.features) {
    const key = `${group.id}/${feature.id}`;
    if (featureKeys.has(key)) {
      throw new Error(`功能 ID 重复：${key}`);
    }
    featureKeys.add(key);

    for (const field of ["entry", "style"]) {
      if (!feature[field] || !existsSync(join(root, feature[field]))) {
        throw new Error(`${key} 的 ${field} 文件不存在：${feature[field] || "empty"}`);
      }
    }

    const expectedDirectory = `src/groups/${group.id}/${feature.id}/`;
    if (!feature.entry.startsWith(expectedDirectory) || !feature.style.startsWith(expectedDirectory)) {
      throw new Error(`${key} 必须放在 ${expectedDirectory} 下。`);
    }
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
const recordStatuses = ["running", "success", "partial", "error", "stopped", "preview"];
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
const xiaohongshuPageExtractSource = readFileSync(join(
  root,
  "src/groups/xiaohongshu/keyword-search/page-extract.js"
), "utf8");
if (!/waitForSelection/.test(xiaohongshuPageExtractSource) || !/resultSignature/.test(xiaohongshuPageExtractSource)) {
  throw new Error("小红书筛选条件或结果稳定性检测没有接入页面脚本。");
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
for (const statusKey of recordStatuses.filter((statusKey) => statusKey !== "preview")) {
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
  duration: "-"
}], "XHP-1", {
  statusKey: "success",
  status: "完成",
  tone: "success",
  resultCount: 20,
  duration: "1.2 秒"
});
if (updatedProfileRecords[0].status !== "完成" || updatedProfileRecords[0].resultCount !== 20 || updatedProfileRecords[0].duration !== "1.2 秒") {
  throw new Error("博主博文任务完成后没有正确回写状态、笔记数或耗时。");
}

const xiaohongshuProfileExport = await import(pathToFileURL(join(
  root,
  "src/groups/xiaohongshu/profile-notes/export-data.js"
)).href);
const profileExportRows = xiaohongshuProfileExport.buildXiaohongshuProfileExportRows([{
  noteId: "note-123",
  noteTitle: "测试笔记",
  noteUrl: "https://www.xiaohongshu.com/user/profile/a/b"
}]);
if (profileExportRows[0].noteId !== "note-123" || profileExportRows[0].noteTitle !== "测试笔记" || "nickname" in profileExportRows[0]) {
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
  || !/window\.scrollTo/.test(xiaohongshuProfileBackgroundSource)
  || !/Page\.navigate/.test(xiaohongshuProfileBackgroundSource)) {
  throw new Error("博主主页采集缺少页面稳定等待、滚动加载或跳转链路。");
}
const xiaohongshuProfilePageSource = readFileSync(join(
  root,
  "src/groups/xiaohongshu/profile-notes/page-extract.js"
), "utf8");
if (!/section\.note-item/.test(xiaohongshuProfilePageSource)
  || !/a\.title/.test(xiaohongshuProfilePageSource)
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
  || !/Page\.navigate/.test(xiaohongshuProfileInfoBackgroundSource)
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
const taskId = "TASK-20260714";
const taskRecords = [
  { id: `${taskId}-R1-K1`, runId: taskId, keyword: "OpenAI", round: 1, statusKey: "success", status: "完成", resultCount: 3, duration: "1 秒" },
  { id: `${taskId}-R1-K2`, runId: taskId, keyword: "人工智能", round: 1, statusKey: "error", status: "失败", resultCount: 0, duration: "500 ms", error: "页面脚本执行失败" }
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
  || taskDetailMarkup.includes("执行明细")
  || taskDetailMarkup.includes("采集数据")
) {
  throw new Error("任务明细没有正确显示单个关键词任务或仍包含已移除区块。");
}

console.log(`验证通过：${config.groups.length} 个分组，${featureKeys.size} 个功能，${javascriptFiles.length} 个 JavaScript 文件。`);

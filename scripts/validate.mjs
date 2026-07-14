import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
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

console.log(`验证通过：${config.groups.length} 个分组，${featureKeys.size} 个功能，${javascriptFiles.length} 个 JavaScript 文件。`);

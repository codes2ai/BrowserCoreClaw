export const TRANSFER_ARCHIVE_STORAGE_KEY = "browserCoreClawTransferArchiveV1";
export const TRANSFER_STATUS = Object.freeze({
  TRANSFERRING: "transferring",
  SUCCESS: "success",
  FAILED: "failed",
  NOT_REQUIRED: "not_required"
});

function callChrome(callbackApi) {
  return new Promise((resolve, reject) => callbackApi((result) => {
    const error = chrome.runtime.lastError;
    if (error) reject(new Error(error.message));
    else resolve(result);
  }));
}

function hasExtensionStorage() {
  return Boolean(globalThis.chrome?.runtime?.id && chrome.storage?.local);
}

function text(value) {
  return String(value ?? "").trim();
}

function toTimestamp(value) {
  const timestamp = new Date(value || 0).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function normalizeTransferStatus(value) {
  const candidate = text(value).toLocaleLowerCase("zh-CN");
  if (["transferring", "running", "传输中", "同步中"].includes(candidate)) return TRANSFER_STATUS.TRANSFERRING;
  if (["success", "completed", "成功", "完成"].includes(candidate)) return TRANSFER_STATUS.SUCCESS;
  if (["failed", "error", "失败"].includes(candidate)) return TRANSFER_STATUS.FAILED;
  return TRANSFER_STATUS.NOT_REQUIRED;
}

function recordKey(featureId, row, index) {
  const stableValue = text(
    row?.id
    || row?.url
    || row?.postUrl
    || row?.profileUrl
    || row?.videoId
    || row?.noteId
    || row?.postId
    || row?.profileId
    || row?.title
    || row?.nickname
  );
  return `${featureId}:${stableValue || index}`;
}

function describeRow(row = {}) {
  const title = text(
    row.title
    || row.noteTitle
    || row.postTitle
    || row.nickname
    || row.author
    || row.username
    || row.name
    || row.postId
    || row.profileId
    || row.id
  );
  const identifier = text(
    row.url
    || row.postUrl
    || row.profileUrl
    || row.videoUrl
    || row.noteUrl
    || row.videoId
    || row.postId
    || row.profileId
    || row.id
  );
  const searchable = [
    title,
    identifier,
    row.description,
    row.content,
    row.keyword,
    row.author,
    row.nickname,
    row.source
  ].map(text).filter(Boolean).join(" ");
  return {
    title: title || identifier || "未命名数据",
    identifier: identifier || "-",
    searchable
  };
}

function normalizeDataRows(descriptors, values, archive = {}) {
  const dataTransferStates = archive?.dataStatusByKey && typeof archive.dataStatusByKey === "object"
    ? archive.dataStatusByKey
    : {};
  return descriptors.flatMap((descriptor) => {
    const saved = values?.[descriptor.storageKey];
    const rows = Array.isArray(saved?.dataRows) ? saved.dataRows : [];
    return rows.map((row, index) => {
      const key = recordKey(descriptor.featureId, row, index);
      const description = describeRow(row);
      const transfer = dataTransferStates[key] || {};
      return {
        id: key,
        featureId: descriptor.featureId,
        featureName: descriptor.featureName,
        platformId: descriptor.platformId,
        platformName: descriptor.platformName,
        title: description.title,
        identifier: description.identifier,
        searchable: description.searchable,
        collectedAt: text(row?.collectedAt || row?.capturedAt || row?.createdAt || row?.publishedAt || row?.time),
        localUpdatedAt: text(row?.updatedAt || row?.collectedAt || row?.capturedAt || row?.createdAt || row?.publishedAt || row?.time),
        localStatus: "stored",
        transferStatus: normalizeTransferStatus(transfer?.status || row?.transferStatus),
        raw: row
      };
    });
  }).sort((left, right) => toTimestamp(right.localUpdatedAt) - toTimestamp(left.localUpdatedAt));
}

function normalizeArchiveTask(task, descriptorByFeatureId) {
  const featureId = text(task?.featureId || task?.sourceFeatureId);
  const descriptor = descriptorByFeatureId.get(featureId);
  const status = normalizeTransferStatus(task?.status);
  const dataCount = Math.max(0, Number(task?.dataCount ?? task?.resultCount ?? task?.total ?? 0) || 0);
  const processed = Math.max(0, Number(task?.processed ?? task?.progress?.current ?? 0) || 0);
  return {
    id: text(task?.id || task?.taskId) || `archive-${featureId || "unknown"}-${task?.createdAt || ""}`,
    featureId,
    featureName: descriptor?.featureName || text(task?.featureName) || "未知功能",
    platformId: descriptor?.platformId || text(task?.platformId),
    platformName: descriptor?.platformName || text(task?.platformName) || "未知平台",
    trigger: text(task?.trigger || task?.executionType || "manual") || "manual",
    createdAt: text(task?.createdAt || task?.startedAt || task?.updatedAt),
    updatedAt: text(task?.updatedAt || task?.finishedAt || task?.createdAt || task?.startedAt),
    dataCount,
    processed,
    status,
    error: text(task?.error),
    virtual: false
  };
}

function buildNoTransferTasks(dataRows, tasks) {
  const existingFeatureIds = new Set(tasks.map((task) => task.featureId).filter(Boolean));
  const groups = new Map();
  dataRows.forEach((row) => {
    if (!groups.has(row.featureId)) groups.set(row.featureId, []);
    groups.get(row.featureId).push(row);
  });
  return [...groups.entries()]
    .filter(([featureId]) => !existingFeatureIds.has(featureId))
    .map(([featureId, rows]) => {
      const latest = [...rows].sort((left, right) => toTimestamp(right.localUpdatedAt) - toTimestamp(left.localUpdatedAt))[0];
      return {
        id: `local-${featureId}`,
        featureId,
        featureName: latest.featureName,
        platformId: latest.platformId,
        platformName: latest.platformName,
        trigger: "local",
        createdAt: latest.localUpdatedAt,
        updatedAt: latest.localUpdatedAt,
        dataCount: rows.length,
        processed: 0,
        status: TRANSFER_STATUS.NOT_REQUIRED,
        error: "",
        virtual: true
      };
    });
}

function normalizeTasks(descriptors, dataRows, archive) {
  const descriptorByFeatureId = new Map(descriptors.map((item) => [item.featureId, item]));
  const storedTasks = Array.isArray(archive?.tasks) ? archive.tasks : [];
  const tasks = storedTasks.map((task) => normalizeArchiveTask(task, descriptorByFeatureId));
  return [...tasks, ...buildNoTransferTasks(dataRows, tasks)]
    .sort((left, right) => toTimestamp(right.updatedAt) - toTimestamp(left.updatedAt));
}

function previewWorkspace() {
  const rows = [
    ["google/google-news", "Google", "Google 新闻监控", "Kimi 最新动态", "https://news.example.com/kimi", "2026-07-17 10:28:12", TRANSFER_STATUS.TRANSFERRING],
    ["xiaohongshu/post-detail", "小红书", "小红书正文采集", "小红书正文示例", "https://www.xiaohongshu.com/explore/example", "2026-07-17 10:15:42", TRANSFER_STATUS.SUCCESS],
    ["weibo/post-detail", "微博", "微博正文采集", "微博正文示例", "https://weibo.com/example", "2026-07-17 09:54:38", TRANSFER_STATUS.FAILED],
    ["douyin/post-detail", "抖音", "抖音博文采集", "抖音作品示例", "https://www.douyin.com/video/example", "2026-07-17 09:31:06", TRANSFER_STATUS.NOT_REQUIRED],
    ["xiaohongshu/profile-info", "小红书", "小红书博主信息采集", "小红书博主资料", "https://www.xiaohongshu.com/user/profile", "2026-07-16 21:11:25", TRANSFER_STATUS.SUCCESS]
  ].map(([featureId, platformName, featureName, title, identifier, time, transferStatus], index) => ({
    id: `preview-${index + 1}`,
    featureId,
    featureName,
    platformId: featureId.split("/")[0],
    platformName,
    title,
    identifier,
    searchable: `${title} ${identifier} ${featureName} ${platformName}`,
    collectedAt: time,
    localUpdatedAt: time,
    localStatus: "stored",
    transferStatus,
    raw: {
      id: `preview-data-${index + 1}`,
      title,
      url: identifier,
      description: `${title} 的本地预览示例数据，用于核对完整字段展示。`,
      source: platformName,
      author: index === 0 ? "示例作者" : "本地采集账号",
      collectedAt: time,
      tags: [platformName, "本地数据", "预览"],
      metadata: {
        featureId,
        preview: true,
        sequence: index + 1
      }
    }
  }));
  const tasks = [
    { id: "ARC-20260717-001", featureId: "google/google-news", featureName: "Google 新闻监控", platformId: "google", platformName: "Google", trigger: "manual", createdAt: "2026-07-17 10:28:12", updatedAt: "2026-07-17 10:29:08", dataCount: 142, processed: 56, status: TRANSFER_STATUS.TRANSFERRING, error: "", virtual: false },
    { id: "ARC-20260717-002", featureId: "xiaohongshu/post-detail", featureName: "小红书正文采集", platformId: "xiaohongshu", platformName: "小红书", trigger: "manual", createdAt: "2026-07-17 10:15:42", updatedAt: "2026-07-17 10:16:21", dataCount: 30, processed: 30, status: TRANSFER_STATUS.SUCCESS, error: "", virtual: false },
    { id: "ARC-20260717-003", featureId: "weibo/post-detail", featureName: "微博正文采集", platformId: "weibo", platformName: "微博", trigger: "runner", createdAt: "2026-07-17 09:54:38", updatedAt: "2026-07-17 09:55:02", dataCount: 24, processed: 6, status: TRANSFER_STATUS.FAILED, error: "远程归档服务尚未连接。", virtual: false },
    { id: "LOCAL-DOUYIN", featureId: "douyin/post-detail", featureName: "抖音博文采集", platformId: "douyin", platformName: "抖音", trigger: "local", createdAt: "2026-07-17 09:31:06", updatedAt: "2026-07-17 09:31:06", dataCount: 18, processed: 0, status: TRANSFER_STATUS.NOT_REQUIRED, error: "", virtual: true }
  ];
  return { isPreview: true, dataRows: rows, taskRows: tasks, loadedAt: "2026-07-17 10:30:00" };
}

export async function loadTransferWorkspace(descriptors = []) {
  const validDescriptors = (Array.isArray(descriptors) ? descriptors : []).filter((item) => item?.featureId && item?.storageKey);
  if (!hasExtensionStorage()) return previewWorkspace();

  const keys = [...new Set([
    ...validDescriptors.map((item) => item.storageKey),
    TRANSFER_ARCHIVE_STORAGE_KEY
  ])];
  const values = await callChrome((done) => chrome.storage.local.get(keys, done));
  const archive = values?.[TRANSFER_ARCHIVE_STORAGE_KEY] && typeof values[TRANSFER_ARCHIVE_STORAGE_KEY] === "object"
    ? values[TRANSFER_ARCHIVE_STORAGE_KEY]
    : {};
  const dataRows = normalizeDataRows(validDescriptors, values, archive);
  return {
    isPreview: false,
    dataRows,
    taskRows: normalizeTasks(validDescriptors, dataRows, archive),
    loadedAt: new Date().toISOString()
  };
}

function includesSearch(row, query, fields) {
  const expected = text(query).toLocaleLowerCase("zh-CN");
  if (!expected) return true;
  return fields.map((field) => text(row?.[field]).toLocaleLowerCase("zh-CN")).join(" ").includes(expected);
}

function matchesDateRange(value, start, end) {
  const date = text(value).slice(0, 10);
  if (text(start) && (!date || date < start)) return false;
  if (text(end) && (!date || date > end)) return false;
  return true;
}

function matchesChoice(actual, expected) {
  return !text(expected) || text(expected) === "__all__" || text(actual) === text(expected);
}

export function filterTransferDataRows(rows = [], filters = {}) {
  return (Array.isArray(rows) ? rows : []).filter((row) => (
    includesSearch(row, filters.query, ["title", "identifier", "searchable"])
    && matchesChoice(row.platformId, filters.platform)
    && matchesChoice(row.featureId, filters.feature)
    && matchesChoice(row.localStatus, filters.localStatus)
    && matchesChoice(row.transferStatus, filters.transferStatus)
    && matchesDateRange(row.collectedAt, filters.dateStart, filters.dateEnd)
  ));
}

export function filterTransferTaskRows(rows = [], filters = {}) {
  return (Array.isArray(rows) ? rows : []).filter((row) => (
    includesSearch(row, filters.query, ["id", "featureName", "platformName", "error"])
    && matchesChoice(row.platformId, filters.platform)
    && matchesChoice(row.featureId, filters.feature)
    && matchesChoice(row.trigger, filters.trigger)
    && matchesChoice(row.status, filters.status)
    && matchesDateRange(row.createdAt, filters.dateStart, filters.dateEnd)
  ));
}

export function getTransferFilterOptions(rows = [], key, labelKey = key) {
  const values = new Map();
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const value = text(row?.[key]);
    const label = text(row?.[labelKey]) || value;
    if (value && !values.has(value)) values.set(value, label);
  });
  return [...values.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((left, right) => left.label.localeCompare(right.label, "zh-CN", { numeric: true }));
}

export function paginateTransferRows(rows = [], page = 1, pageSize = 20) {
  const source = Array.isArray(rows) ? rows : [];
  const size = Math.max(1, Number(pageSize) || 20);
  const pageCount = Math.max(1, Math.ceil(source.length / size));
  const currentPage = Math.min(Math.max(1, Number(page) || 1), pageCount);
  const start = (currentPage - 1) * size;
  return {
    currentPage,
    pageCount,
    total: source.length,
    start,
    end: Math.min(start + size, source.length),
    items: source.slice(start, start + size)
  };
}

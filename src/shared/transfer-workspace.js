import { getCanonicalRecord } from "./canonical-data.js";
import {
  createTransferStrategyResolver,
  TRANSFER_ACTIONS
} from "./transfer-settings.js";

export const TRANSFER_ARCHIVE_STORAGE_KEY = "browserCoreClawTransferArchiveV1";
export const MESSAGE_RECONCILE_TRANSFER_DATA = "browser-core-claw:transfer:reconcile";
export const TRANSFER_STATUS = Object.freeze({
  PENDING: "pending",
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

export async function requestTransferDataReconcile(options = {}) {
  if (!hasExtensionStorage() || typeof chrome.runtime?.sendMessage !== "function") {
    return { ok: true, preview: true, initializedCount: 0 };
  }
  const response = await callChrome((done) => chrome.runtime.sendMessage({
    type: MESSAGE_RECONCILE_TRANSFER_DATA,
    options: isRecord(options) ? options : {}
  }, done));
  if (response?.ok === false) throw new Error(response.error || "后台传输策略同步失败。");
  return response || { ok: true, initializedCount: 0 };
}

function text(value) {
  return String(value ?? "").trim();
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function stringList(value) {
  const source = Array.isArray(value) ? value : value == null || value === "" ? [] : [value];
  return [...new Set(source.map(text).filter(Boolean))];
}

function normalizePersistedDecision(value) {
  if (!isRecord(value)) return null;
  return {
    ...value,
    action: text(value.action),
    reason: text(value.reason),
    strategyId: text(value.strategyId),
    strategyName: text(value.strategyName),
    strategyType: text(value.strategyType),
    channelIds: stringList(value.channelIds ?? value.channelId),
    channelNames: stringList(value.channelNames ?? value.channelName),
    decidedAt: text(value.decidedAt || value.capturedAt)
  };
}

function normalizeChannelResults(value) {
  if (Array.isArray(value)) {
    return value.map((item) => isRecord(item) ? { ...item } : item);
  }
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    isRecord(item) ? { ...item } : item
  ]));
}

function channelResultEntries(value) {
  if (Array.isArray(value)) return value.filter(isRecord);
  return isRecord(value) ? Object.values(value).filter(isRecord) : [];
}

function latestDateValue(values) {
  return values.map(text).filter(Boolean).sort((left, right) => toTimestamp(right) - toTimestamp(left))[0] || "";
}

function attemptCount(value) {
  if (value === "" || value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : null;
}

function totalAttemptCount(transfer, channelExecutions) {
  const storedTotal = attemptCount(transfer.attemptCount ?? transfer.totalAttemptCount ?? transfer.attempts);
  if (storedTotal != null) return storedTotal;
  return channelExecutions.reduce((total, item) => (
    total + (attemptCount(item.attemptCount ?? item.attempts) || 0)
  ), 0);
}

export function resolveTransferErrorValue(transfer = {}, channelExecutions = []) {
  const results = Array.isArray(channelExecutions)
    ? channelExecutions.filter(isRecord)
    : channelResultEntries(channelExecutions);
  return transfer?.error
    || results.find((item) => item.error)?.error
    || results.find((item) => item.lastFailure?.error)?.lastFailure?.error
    || "";
}

function errorText(value) {
  if (typeof value === "string") return value.trim();
  if (isRecord(value) && text(value.message)) return text(value.message);
  if (value == null || value === "") return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toTimestamp(value) {
  const timestamp = new Date(value || 0).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function normalizeTransferStatus(value) {
  const candidate = text(value).toLocaleLowerCase("zh-CN");
  if (["pending", "queued", "waiting", "待传输", "待同步", "等待"].includes(candidate)) return TRANSFER_STATUS.PENDING;
  if (["transferring", "running", "传输中", "同步中"].includes(candidate)) return TRANSFER_STATUS.TRANSFERRING;
  if (["success", "completed", "成功", "完成"].includes(candidate)) return TRANSFER_STATUS.SUCCESS;
  if (["failed", "error", "失败"].includes(candidate)) return TRANSFER_STATUS.FAILED;
  if (["not_required", "not-required", "skipped", "无需传输", "无需推送", "跳过"].includes(candidate)) return TRANSFER_STATUS.NOT_REQUIRED;
  return TRANSFER_STATUS.PENDING;
}

function entityTypeLabel(value) {
  return ({ content: "内容", profile: "博主资料" })[text(value)] || "其他";
}

function contentTypeLabel(value) {
  return ({ news: "新闻", note: "笔记", post: "博文", video: "视频" })[text(value)] || "";
}

function recordKey(featureId, row, index) {
  const stableValue = text(
    row?.id
    || row?.url
    || row?.postUrl
    || row?.profileUrl
    || row?.videoUrl
    || row?.noteUrl
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

function describeCanonicalRow(canonical = {}, fallback = {}) {
  const title = text(canonical.title) || text(fallback.title) || "未命名数据";
  const identifier = text(canonical.canonicalUrl)
    || text(canonical.platformEntityId)
    || text(fallback.identifier || fallback.url || fallback.postUrl || fallback.profileUrl)
    || "-";
  const searchable = [
    title,
    identifier,
    canonical.text,
    canonical.summary,
    canonical.author?.name,
    canonical.profile?.displayName,
    canonical.sourceContext?.query,
    fallback.keyword
  ].map(text).filter(Boolean).join(" ");
  return { title, identifier, searchable };
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
      const canonical = getCanonicalRecord(descriptor.featureId, row);
      const description = describeCanonicalRow(canonical, describeRow(row));
      const hasPersistedTransferState = hasOwn(dataTransferStates, key);
      const storedValue = dataTransferStates[key];
      const transfer = isRecord(storedValue)
        ? { ...storedValue }
        : typeof storedValue === "string"
          ? { status: storedValue }
          : {};
      const persistedTransferDecision = normalizePersistedDecision(transfer.decision || transfer.transferDecision);
      const storedTransferStatus = normalizeTransferStatus(
        hasPersistedTransferState ? transfer.status : row?.transferStatus
      );
      const transferChannelResults = normalizeChannelResults(transfer.channelResults);
      const channelExecutions = channelResultEntries(transferChannelResults);
      const transferError = resolveTransferErrorValue(transfer, channelExecutions);
      return {
        id: key,
        featureId: descriptor.featureId,
        featureName: descriptor.featureName,
        platformId: descriptor.platformId,
        platformName: descriptor.platformName,
        title: description.title,
        identifier: description.identifier,
        searchable: description.searchable,
        entityType: text(canonical.entityType) || "unknown",
        contentType: text(canonical.contentType),
        entityTypeLabel: entityTypeLabel(canonical.entityType),
        contentTypeLabel: contentTypeLabel(canonical.contentType),
        collectedAt: text(canonical.collectedAt || row?.collectedAt || row?.capturedAt || row?.createdAt || row?.publishedAt || row?.time),
        localUpdatedAt: text(row?.updatedAt || canonical.collectedAt || row?.collectedAt || row?.capturedAt || row?.createdAt || row?.publishedAt || row?.time),
        localStatus: "stored",
        storedTransferStatus,
        transferStatus: storedTransferStatus,
        transferStatePersisted: hasPersistedTransferState,
        transferStatusSource: hasPersistedTransferState ? "archive" : "source",
        persistedTransferDecision,
        transferDecision: persistedTransferDecision,
        transferChannelResults,
        transferError,
        transferErrorText: errorText(transferError),
        transferAttemptCount: totalAttemptCount(transfer, channelExecutions),
        transferAttemptAt: text(transfer.lastAttemptAt || transfer.attemptAt || transfer.attemptedAt) || latestDateValue(channelExecutions.map((item) => item.lastAttemptAt || item.attemptAt || item.attemptedAt)),
        transferCompletedAt: text(transfer.completedAt) || latestDateValue(channelExecutions.map((item) => item.completedAt)),
        transferUpdatedAt: text(transfer.updatedAt),
        transferDeliveryUncertain: transfer.deliveryUncertain === true,
        transferArchiveState: hasPersistedTransferState ? transfer : null,
        canonical,
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
        status: TRANSFER_STATUS.PENDING,
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
    ["google/google-news", "Google", "Google 新闻监控", "Kimi 最新动态", "https://news.example.com/kimi", "2026-07-17 10:28:12", TRANSFER_STATUS.PENDING],
    ["xiaohongshu/post-detail", "小红书", "小红书正文采集", "小红书正文示例", "https://www.xiaohongshu.com/explore/example", "2026-07-17 10:15:42", TRANSFER_STATUS.SUCCESS],
    ["weibo/post-detail", "微博", "微博正文采集", "微博正文示例", "https://weibo.com/example", "2026-07-17 09:54:38", TRANSFER_STATUS.FAILED],
    ["douyin/post-detail", "抖音", "抖音博文采集", "抖音作品示例", "https://www.douyin.com/video/example", "2026-07-17 09:31:06", TRANSFER_STATUS.NOT_REQUIRED],
    ["xiaohongshu/profile-info", "小红书", "小红书博主信息采集", "小红书博主资料", "https://www.xiaohongshu.com/user/profile", "2026-07-16 21:11:25", TRANSFER_STATUS.TRANSFERRING]
  ].map(([featureId, platformName, featureName, title, identifier, time, transferStatus], index) => {
    const raw = {
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
    };
    const canonical = getCanonicalRecord(featureId, raw);
    const isFailure = transferStatus === TRANSFER_STATUS.FAILED;
    const failureError = isFailure
      ? "默认 API 通道：API 返回 HTTP 503；上游归档服务暂时不可用，已按当前设置完成全部重试，仍未传输成功。"
      : "";
    const failureDecision = isFailure ? {
      action: TRANSFER_ACTIONS.CHANNEL,
      reason: "strategy_channel",
      strategyId: "preview-failure-strategy",
      strategyName: "网页预览失败策略",
      strategyType: "channel",
      typePriority: 200,
      priority: 80,
      channelIds: ["preview-primary-api", "preview-audit-api"],
      channelNames: ["默认 API 通道", "审计 API 通道"],
      decidedAt: "2026-07-17T09:54:37.000Z",
      capturedAt: "2026-07-17T09:54:37.000Z"
    } : null;
    const failureAttempts = isFailure ? Array.from({ length: 4 }, (_, attemptIndex) => ({
      attemptNumber: attemptIndex + 1,
      attempted: true,
      attemptedAt: new Date(Date.UTC(2026, 6, 17, 9, 54, 38 + attemptIndex * 8)).toISOString(),
      failedAt: new Date(Date.UTC(2026, 6, 17, 9, 54, 39 + attemptIndex * 8)).toISOString(),
      failureKind: "http",
      httpStatus: 503,
      statusText: "Service Unavailable",
      responseContentType: "application/json; charset=utf-8",
      responseBody: JSON.stringify({
        code: "ARCHIVE_TEMPORARILY_UNAVAILABLE",
        message: "上游归档服务正在维护，请稍后重试。",
        requestId: `preview-request-${attemptIndex + 1}`,
        token: "[敏感信息已隐藏]"
      }, null, 2),
      responseBodyTruncated: false,
      responseBodyReadError: "",
      errorName: "",
      errorMessage: "",
      error: "API 返回 HTTP 503 Service Unavailable",
      deliveryUncertain: false,
      retryEligible: true,
      willRetry: attemptIndex < 3
    })) : [];
    const failureAttemptHistory = failureAttempts.map(({ responseBody, ...attempt }) => ({
      ...attempt,
      responseBodyCaptured: Boolean(responseBody)
    }));
    const failureChannelResults = isFailure ? {
      "preview-primary-api": {
        channelId: "preview-primary-api",
        channelName: "默认 API 通道",
        channelType: "api",
        status: TRANSFER_STATUS.FAILED,
        attemptedAt: "2026-07-17T09:54:38.000Z",
        lastAttemptAt: "2026-07-17T09:55:02.000Z",
        completedAt: "2026-07-17T09:55:03.000Z",
        httpStatus: 503,
        attemptCount: 4,
        idempotencyKey: "bcc-preview-failure-primary",
        error: "API 返回 HTTP 503；上游归档服务暂时不可用。",
        deliveryUncertain: false,
        retryable: false,
        retryEligible: true,
        failureKind: "http",
        lastFailure: failureAttempts.at(-1),
        attemptHistory: failureAttemptHistory
      },
      "preview-audit-api": {
        channelId: "preview-audit-api",
        channelName: "审计 API 通道",
        channelType: "api",
        status: TRANSFER_STATUS.SUCCESS,
        attemptedAt: "2026-07-17T09:54:39.000Z",
        lastAttemptAt: "2026-07-17T09:54:39.000Z",
        completedAt: "2026-07-17T09:54:40.000Z",
        httpStatus: 202,
        attemptCount: 1,
        idempotencyKey: "bcc-preview-failure-audit",
        error: "",
        deliveryUncertain: false,
        retryable: false,
        retryEligible: false,
        failureKind: "",
        lastFailure: null,
        attemptHistory: []
      }
    } : {};
    const failureArchiveState = isFailure ? {
      status: TRANSFER_STATUS.FAILED,
      action: TRANSFER_ACTIONS.CHANNEL,
      reason: "strategy_channel",
      featureId,
      platformId: featureId.split("/")[0],
      decision: failureDecision,
      channelResults: failureChannelResults,
      attemptCount: 5,
      error: failureError,
      deliveryUncertain: false,
      attemptedAt: "2026-07-17T09:54:38.000Z",
      completedAt: "2026-07-17T09:55:03.000Z",
      createdAt: "2026-07-17T09:54:37.000Z",
      updatedAt: "2026-07-17T09:55:03.000Z"
    } : null;
    return {
      id: `preview-${index + 1}`,
      featureId,
      featureName,
      platformId: featureId.split("/")[0],
      platformName,
      title: canonical.title || title,
      identifier: canonical.canonicalUrl || identifier,
      searchable: `${title} ${identifier} ${featureName} ${platformName}`,
      entityType: canonical.entityType,
      contentType: canonical.contentType,
      entityTypeLabel: entityTypeLabel(canonical.entityType),
      contentTypeLabel: contentTypeLabel(canonical.contentType),
      collectedAt: time,
      localUpdatedAt: time,
      localStatus: "stored",
      storedTransferStatus: transferStatus,
      transferStatus,
      transferStatePersisted: isFailure,
      transferStatusSource: "preview",
      persistedTransferDecision: failureDecision,
      transferDecision: failureDecision,
      transferChannelResults: failureChannelResults,
      transferError: failureError,
      transferErrorText: failureError,
      transferAttemptCount: isFailure ? 5 : 0,
      transferAttemptAt: isFailure ? "2026-07-17T09:55:02.000Z" : time,
      transferCompletedAt: isFailure ? "2026-07-17T09:55:03.000Z" : transferStatus === TRANSFER_STATUS.SUCCESS ? time : "",
      transferUpdatedAt: isFailure ? "2026-07-17T09:55:03.000Z" : time,
      transferDeliveryUncertain: false,
      transferArchiveState: failureArchiveState,
      canonical,
      raw
    };
  });
  const tasks = [
    { id: "ARC-20260717-001", featureId: "google/google-news", featureName: "Google 新闻监控", platformId: "google", platformName: "Google", trigger: "manual", createdAt: "2026-07-17 10:28:12", updatedAt: "2026-07-17 10:29:08", dataCount: 142, processed: 56, status: TRANSFER_STATUS.TRANSFERRING, error: "", virtual: false },
    { id: "ARC-20260717-002", featureId: "xiaohongshu/post-detail", featureName: "小红书正文采集", platformId: "xiaohongshu", platformName: "小红书", trigger: "manual", createdAt: "2026-07-17 10:15:42", updatedAt: "2026-07-17 10:16:21", dataCount: 30, processed: 30, status: TRANSFER_STATUS.SUCCESS, error: "", virtual: false },
    { id: "ARC-20260717-003", featureId: "weibo/post-detail", featureName: "微博正文采集", platformId: "weibo", platformName: "微博", trigger: "runner", createdAt: "2026-07-17 09:54:38", updatedAt: "2026-07-17 09:55:02", dataCount: 24, processed: 6, status: TRANSFER_STATUS.FAILED, error: "远程归档服务尚未连接。", virtual: false },
    { id: "LOCAL-DOUYIN", featureId: "douyin/post-detail", featureName: "抖音博文采集", platformId: "douyin", platformName: "抖音", trigger: "local", createdAt: "2026-07-17 09:31:06", updatedAt: "2026-07-17 09:31:06", dataCount: 18, processed: 0, status: TRANSFER_STATUS.NOT_REQUIRED, error: "", virtual: true }
  ];
  return { isPreview: true, dataRows: rows, taskRows: tasks, loadedAt: "2026-07-17 10:30:00" };
}

export function applyTransferStrategiesToRows(rows = [], settings = {}, options = {}) {
  const resolveStrategy = createTransferStrategyResolver(settings);
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const storedTransferStatus = normalizeTransferStatus(row?.storedTransferStatus ?? row?.transferStatus);
    if (settings?.enabled !== true) {
      return {
        ...row,
        storedTransferStatus,
        transferStatus: TRANSFER_STATUS.NOT_REQUIRED,
        transferDecision: resolveStrategy(row),
        transferDecisionSource: "global-switch"
      };
    }
    const preferPersisted = options.preferPersisted === true || row?.transferStatePersisted === true;
    if (preferPersisted) {
      const hasPersistedState = row?.transferStatePersisted === true;
      return {
        ...row,
        storedTransferStatus,
        transferStatus: hasPersistedState ? storedTransferStatus : TRANSFER_STATUS.NOT_REQUIRED,
        transferDecision: hasPersistedState
          ? row?.persistedTransferDecision || row?.transferDecision || null
          : {
              action: TRANSFER_ACTIONS.NOT_REQUIRED,
              reason: "legacy_baseline",
              strategyId: "",
              strategyName: "",
              strategyType: "",
              typePriority: 0,
              priority: 0,
              channelIds: [],
              channelNames: []
            },
        transferDecisionSource: hasPersistedState ? "archive" : "unresolved-baseline"
      };
    }

    const decision = resolveStrategy(row);
    const transferStatus = decision.action === TRANSFER_ACTIONS.NOT_REQUIRED
      ? TRANSFER_STATUS.NOT_REQUIRED
      : storedTransferStatus === TRANSFER_STATUS.NOT_REQUIRED
        ? TRANSFER_STATUS.PENDING
        : storedTransferStatus;
    return {
      ...row,
      storedTransferStatus,
      transferStatus,
      transferDecision: decision,
      transferDecisionSource: options.preview === true || row?.transferStatusSource === "preview" ? "preview" : "derived"
    };
  });
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
    && matchesChoice(row.entityType, filters.entityType)
    && matchesChoice(row.contentType, filters.contentType)
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

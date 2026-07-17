import { getFeatureRunner, listFeatureRunners } from "../runners/registry.js";
import { getCanonicalRecord } from "../shared/canonical-data.js";
import {
  createTransferStrategyResolver,
  normalizeTransferSettings,
  TRANSFER_ACTIONS,
  TRANSFER_CHANNEL_TYPES,
  TRANSFER_SETTINGS_STORAGE_KEY
} from "../shared/transfer-settings.js";
import {
  TRANSFER_ARCHIVE_STORAGE_KEY,
  TRANSFER_STATUS
} from "../shared/transfer-workspace.js";

const TRANSFER_REQUEST_TIMEOUT_MS = 30000;
const TRANSFER_ERROR_MAX_LENGTH = 1000;
const TRANSFER_FAILURE_RESPONSE_MAX_BYTES = 16384;
const TRANSFER_BATCH_FAILURE_BODY_BUDGET = 262144;
const TRANSFER_ATTEMPT_HISTORY_LIMIT = 20;

function text(value, maximum = 2000) {
  return String(value ?? "").trim().slice(0, maximum);
}

function clone(value) {
  if (value === undefined) return undefined;
  try {
    return typeof structuredClone === "function"
      ? structuredClone(value)
      : JSON.parse(JSON.stringify(value));
  } catch {
    return value && typeof value === "object" ? { ...value } : value;
  }
}

function isoNow(now = Date.now) {
  const value = typeof now === "function" ? now() : now;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function rowsFromStorageValue(value) {
  return Array.isArray(value?.dataRows) ? value.dataRows.filter(Boolean) : [];
}

function hasStorageApi(chromeApi) {
  return Boolean(chromeApi?.storage?.local?.get && chromeApi?.storage?.local?.set);
}

function callChrome(chromeApi, callbackApi) {
  return new Promise((resolve, reject) => callbackApi((result) => {
    const error = chromeApi?.runtime?.lastError;
    if (error) reject(new Error(error.message));
    else resolve(result);
  }));
}

function getStorage(chromeApi, keys) {
  return callChrome(chromeApi, (done) => chromeApi.storage.local.get(keys, done));
}

function setStorage(chromeApi, values) {
  return callChrome(chromeApi, (done) => chromeApi.storage.local.set(values, done));
}

export function listTransferRunnerDescriptors() {
  return listFeatureRunners().map(({ featureId, name }) => {
    const runner = getFeatureRunner(featureId);
    return {
      featureId,
      featureName: name,
      platformId: featureId.split("/")[0] || "",
      storageKey: text(runner?.storageKey, 240)
    };
  }).filter((descriptor) => descriptor.storageKey);
}

export function getTransferRecordStableValue(row = {}) {
  return text(
    row?.id
    || row?.url
    || row?.postUrl
    || row?.profileUrl
    || row?.videoUrl
    || row?.noteUrl
  );
}

function getTransferArchiveRecordValue(row = {}) {
  return text(
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
}

/**
 * 与传输工作区使用同一记录键格式。没有稳定字段时仍返回索引键，但这类
 * 记录只会被标记为无需传输，绝不会进入网络执行。
 */
export function createTransferRecordKey(featureId, row, index = 0) {
  const archiveValue = getTransferArchiveRecordValue(row);
  return `${text(featureId, 240)}:${archiveValue || Math.max(0, Number(index) || 0)}`;
}

/**
 * 只把 old/new 之间新增的稳定键作为可执行记录。同键内容更新、数组重排
 * 和重复键不会触发二次投递；无稳定键记录返回为 safeOnly 候选。
 */
export function collectNewTransferRecords(descriptor, change = {}) {
  const oldRows = rowsFromStorageValue(change.oldValue);
  const newRows = rowsFromStorageValue(change.newValue);
  const oldKeys = new Set(oldRows.map((row) => {
    const stableValue = getTransferRecordStableValue(row);
    return stableValue ? createTransferRecordKey(descriptor.featureId, row) : "";
  }).filter(Boolean));
  const seenNewKeys = new Set();
  const records = [];

  newRows.forEach((row, index) => {
    const stableValue = getTransferRecordStableValue(row);
    const key = createTransferRecordKey(descriptor.featureId, row, index);
    if (!stableValue) {
      records.push({ key, row, index, stable: false, safeOnly: true });
      return;
    }
    if (oldKeys.has(key) || seenNewKeys.has(key)) return;
    seenNewKeys.add(key);
    records.push({ key, row, index, stable: true, safeOnly: false });
  });
  return records;
}

export function createDecisionSnapshot(decision = {}, capturedAt = new Date().toISOString()) {
  return {
    action: decision.action === TRANSFER_ACTIONS.CHANNEL
      ? TRANSFER_ACTIONS.CHANNEL
      : TRANSFER_ACTIONS.NOT_REQUIRED,
    reason: text(decision.reason, 160),
    strategyId: text(decision.strategyId, 240),
    strategyName: text(decision.strategyName, 160),
    strategyType: text(decision.strategyType, 80),
    typePriority: Number(decision.typePriority) || 0,
    priority: Number(decision.priority) || 0,
    channelIds: Array.isArray(decision.channelIds) ? [...decision.channelIds] : [],
    channelNames: Array.isArray(decision.channelNames) ? [...decision.channelNames] : [],
    decidedAt: capturedAt,
    capturedAt
  };
}

export function createNoTransferDecision(reason) {
  return {
    action: TRANSFER_ACTIONS.NOT_REQUIRED,
    reason: text(reason, 160),
    strategyId: "",
    strategyName: "",
    strategyType: "",
    typePriority: 0,
    priority: 0,
    channelIds: [],
    channelNames: []
  };
}

export function createTransferRecordPlan({
  descriptor,
  row,
  index = 0,
  settings,
  capturedAt = new Date().toISOString()
} = {}) {
  const featureId = text(descriptor?.featureId, 240);
  const platformId = text(descriptor?.platformId, 160) || featureId.split("/")[0] || "";
  const stable = Boolean(getTransferRecordStableValue(row));
  const resolveStrategy = createTransferStrategyResolver(settings);
  const resolvedDecision = stable
    ? resolveStrategy({ featureId, platformId })
    : createNoTransferDecision("unstable_record_key");
  const normalizedSettings = normalizeTransferSettings(settings);
  const channelsById = new Map(normalizedSettings.channels.map((channel) => [channel.id, channel]));
  const channels = resolvedDecision.action === TRANSFER_ACTIONS.CHANNEL
    ? resolvedDecision.channelIds.map((channelId) => channelsById.get(channelId)).filter(Boolean)
    : [];
  const decision = channels.length || resolvedDecision.action !== TRANSFER_ACTIONS.CHANNEL
    ? resolvedDecision
    : createNoTransferDecision("strategy_channel_unavailable");
  const canonical = getCanonicalRecord(featureId, row || {});
  return {
    key: createTransferRecordKey(featureId, row, index),
    featureId,
    platformId,
    stable,
    row: clone(row || {}),
    canonical: clone(canonical),
    decision: createDecisionSnapshot(decision, capturedAt),
    channels: channels.map((channel) => clone(channel)),
    capturedAt
  };
}

function pendingChannelResult(channel = {}) {
  return {
    channelId: text(channel.id, 240),
    channelName: text(channel.name, 160),
    channelType: text(channel.type, 80),
    status: TRANSFER_STATUS.PENDING,
    attemptedAt: "",
    completedAt: "",
    httpStatus: 0,
    attemptCount: 0,
    idempotencyKey: "",
    error: "",
    deliveryUncertain: false,
    retryEligible: false,
    failureKind: "",
    lastFailure: null,
    attemptHistory: []
  };
}

export function createTransferStatusEntry(plan = {}, createdAt = plan.capturedAt || new Date().toISOString()) {
  const shouldTransfer = plan.decision?.action === TRANSFER_ACTIONS.CHANNEL && plan.channels?.length;
  return {
    status: shouldTransfer ? TRANSFER_STATUS.PENDING : TRANSFER_STATUS.NOT_REQUIRED,
    action: shouldTransfer ? TRANSFER_ACTIONS.CHANNEL : TRANSFER_ACTIONS.NOT_REQUIRED,
    reason: text(plan.decision?.reason, 160),
    featureId: text(plan.featureId, 240),
    platformId: text(plan.platformId, 160),
    decision: clone(plan.decision),
    channelResults: Object.fromEntries((shouldTransfer ? plan.channels : []).map((channel) => (
      [channel.id, pendingChannelResult(channel)]
    ))),
    attemptCount: 0,
    error: "",
    deliveryUncertain: false,
    attemptedAt: "",
    completedAt: shouldTransfer ? "" : createdAt,
    createdAt,
    updatedAt: createdAt
  };
}

export function createLegacyBaselineEntry(descriptor, row, index, createdAt = new Date().toISOString()) {
  const featureId = text(descriptor?.featureId, 240);
  const decision = createDecisionSnapshot(createNoTransferDecision("legacy_baseline"), createdAt);
  return createTransferStatusEntry({
    featureId,
    platformId: text(descriptor?.platformId, 160) || featureId.split("/")[0] || "",
    decision,
    channels: [],
    capturedAt: createdAt,
    key: createTransferRecordKey(featureId, row, index)
  }, createdAt);
}

export function createLegacyBaselineStatuses({
  descriptors = [],
  values = {},
  archive = {},
  createdAt = new Date().toISOString()
} = {}) {
  const dataStatusByKey = archive?.dataStatusByKey && typeof archive.dataStatusByKey === "object"
    ? { ...archive.dataStatusByKey }
    : {};
  let initializedCount = 0;
  for (const descriptor of descriptors) {
    rowsFromStorageValue(values?.[descriptor.storageKey]).forEach((row, index) => {
      const key = createTransferRecordKey(descriptor.featureId, row, index);
      if (dataStatusByKey[key]?.status) return;
      dataStatusByKey[key] = createLegacyBaselineEntry(descriptor, row, index, createdAt);
      initializedCount += 1;
    });
  }
  return { dataStatusByKey, initializedCount };
}

export function recoverInterruptedTransferStatuses(
  archive = {},
  recoveredAt = new Date().toISOString()
) {
  const currentStatuses = archive?.dataStatusByKey && typeof archive.dataStatusByKey === "object"
    ? archive.dataStatusByKey
    : {};
  let recoveredCount = 0;
  const dataStatusByKey = Object.fromEntries(Object.entries(currentStatuses).map(([key, entry]) => {
    if (!entry || typeof entry !== "object") return [key, entry];
    const topInterrupted = [TRANSFER_STATUS.PENDING, TRANSFER_STATUS.TRANSFERRING].includes(entry.status);
    let channelInterrupted = false;
    const channelResults = Object.fromEntries(Object.entries(entry.channelResults || {}).map(([channelId, result]) => {
      if (!result || typeof result !== "object") return [channelId, result];
      if (![TRANSFER_STATUS.PENDING, TRANSFER_STATUS.TRANSFERRING].includes(result.status)) {
        return [channelId, result];
      }
      channelInterrupted = true;
      const deliveryUncertain = result.status === TRANSFER_STATUS.TRANSFERRING;
      const recoveryMessage = deliveryUncertain
        ? "后台执行器曾中断，远端是否收到数据无法确认；系统未自动重试。"
        : "后台执行器在请求开始前中断；系统未自动重试。";
      const recoveryFailure = createTransferFailureSnapshot(
        transferExecutionError(recoveryMessage, {
          attempted: deliveryUncertain,
          deliveryUncertain,
          failureDetail: { kind: "worker_interrupted" }
        }),
        {
          attemptNumber: Number(result.attemptCount) || 0,
          attemptedAt: result.lastAttemptAt || result.attemptedAt || "",
          failedAt: recoveredAt,
          willRetry: false
        }
      );
      return [channelId, {
        ...result,
        status: TRANSFER_STATUS.FAILED,
        completedAt: recoveredAt,
        error: recoveryMessage,
        deliveryUncertain,
        retryable: false,
        retryEligible: false,
        failureKind: recoveryFailure.failureKind,
        lastFailure: recoveryFailure,
        attemptHistory: deliveryUncertain
          ? [
            ...(Array.isArray(result.attemptHistory)
              ? result.attemptHistory.map(createTransferAttemptHistoryEntry)
              : []),
            createTransferAttemptHistoryEntry(recoveryFailure)
          ]
            .slice(-TRANSFER_ATTEMPT_HISTORY_LIMIT)
          : Array.isArray(result.attemptHistory) ? result.attemptHistory : []
      }];
    }));
    if (!topInterrupted && !channelInterrupted) return [key, entry];
    recoveredCount += 1;
    const deliveryUncertain = entry.status === TRANSFER_STATUS.TRANSFERRING
      || Object.values(channelResults).some((result) => result?.deliveryUncertain === true);
    const summary = summarizeTransferChannelResults(channelResults);
    return [key, {
      ...entry,
      status: TRANSFER_STATUS.FAILED,
      channelResults,
      error: summary.error || (deliveryUncertain
        ? "后台执行器曾中断，投递结果无法确认；系统未自动重试。"
        : "后台执行器在请求开始前中断；系统未自动重试。"),
      deliveryUncertain,
      completedAt: recoveredAt,
      updatedAt: recoveredAt
    }];
  }));
  return { dataStatusByKey, recoveredCount };
}

export function parseTransferApiHeaders(value) {
  if (!value) return { "Content-Type": "application/json" };
  let source = value;
  if (typeof source === "string") {
    try {
      source = JSON.parse(source);
    } catch {
      throw new Error("API 请求头不是有效的 JSON 对象。");
    }
  }
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error("API 请求头必须是 JSON 对象。");
  }
  const headers = Object.fromEntries(Object.entries(source).map(([key, headerValue]) => [
    text(key, 240),
    text(headerValue, 4000)
  ]).filter(([key]) => key && !["content-type", "idempotency-key"].includes(key.toLowerCase())));
  headers["Content-Type"] = "application/json";
  return headers;
}

export function endpointToOriginPattern(endpoint) {
  let url;
  try {
    url = new URL(text(endpoint));
  } catch {
    throw new Error("API POST 地址无效。");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("API POST 地址仅支持 HTTP 或 HTTPS。");
  }
  return `${url.origin}/*`;
}

function transferChannelExecutionSignature(channel = {}) {
  const config = channel?.config && typeof channel.config === "object" ? channel.config : {};
  return JSON.stringify(channel?.type === TRANSFER_CHANNEL_TYPES.MONGODB
    ? [channel.id, channel.type, channel.enabled === true, config.connectionString, config.database, config.collection]
    : [channel.id, channel.type, channel.enabled === true, config.endpoint, config.headers]);
}

function fallbackTransferHash(value) {
  let hash = 2166136261;
  for (const character of String(value || "")) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function asTransferPlans(value) {
  return (Array.isArray(value) ? value : [value]).filter((plan) => plan && typeof plan === "object");
}

export function chunkTransferPlans(plans = [], batchSize = 20) {
  const source = asTransferPlans(plans);
  const size = Math.max(1, Math.trunc(Number(batchSize)) || 1);
  const batches = [];
  for (let index = 0; index < source.length; index += size) {
    batches.push(source.slice(index, index + size));
  }
  return batches;
}

export function groupTransferPlansByChannel(plans = []) {
  const groups = new Map();
  for (const plan of asTransferPlans(plans)) {
    for (const channel of Array.isArray(plan.channels) ? plan.channels : []) {
      if (!channel?.id) continue;
      if (!groups.has(channel.id)) groups.set(channel.id, { channel, plans: [] });
      groups.get(channel.id).plans.push(plan);
    }
  }
  return [...groups.values()];
}

export function isRetryableTransferHttpStatus(status) {
  const value = Number(status) || 0;
  return value === 408 || value === 429 || (value >= 500 && value <= 599);
}

export async function createTransferIdempotencyKey(planOrPlans = {}, channel = {}, cryptoApi = globalThis.crypto) {
  const plans = asTransferPlans(planOrPlans);
  const source = [
    plans.map((plan) => text(plan.key, 1000)).sort().join("\n"),
    text(channel.id, 240),
    plans.map((plan) => Number(plan.canonical?.schemaVersion) || 1).join(",")
  ].join("|");
  if (cryptoApi?.subtle?.digest && typeof TextEncoder === "function") {
    const digest = await cryptoApi.subtle.digest("SHA-256", new TextEncoder().encode(source));
    const hexadecimal = [...new Uint8Array(digest)]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
    return `bcc-${hexadecimal}`;
  }
  return `bcc-${fallbackTransferHash(source)}`;
}

export function createTransferApiPayload(planOrPlans = {}, idempotencyKey = "") {
  const plans = asTransferPlans(planOrPlans);
  const firstPlan = plans[0] || {};
  const recordKeys = plans.map((plan) => text(plan.key, 1000));
  const commonValue = (selector, maximum) => {
    const values = [...new Set(plans.map((plan) => text(selector(plan), maximum)))];
    return values.length === 1 ? values[0] : "";
  };
  return {
    records: plans.map((plan) => clone(plan.canonical || {})),
    transfer: {
      idempotencyKey: text(idempotencyKey, 160),
      recordKey: recordKeys.length === 1 ? recordKeys[0] : "",
      recordKeys,
      batchSize: plans.length,
      featureId: commonValue((plan) => plan.featureId, 240),
      platformId: commonValue((plan) => plan.platformId, 160),
      strategyId: commonValue((plan) => plan.decision?.strategyId, 240),
      capturedAt: text(firstPlan.capturedAt, 80)
    }
  };
}

export function sanitizeTransferErrorMessage(error) {
  const source = text(error?.message || error, TRANSFER_ERROR_MAX_LENGTH);
  if (!source) return "传输失败";
  return source
    .replace(/mongodb(?:\+srv)?:\/\/[^\s]+/gi, "[MongoDB 连接信息已隐藏]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [敏感信息已隐藏]")
    .replace(/((?:authorization|password|passwd|secret|token|cookie|api[-_]?key|access[-_]?key|client[-_]?secret)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[敏感信息已隐藏]")
    .replace(/https?:\/\/[^\s，；]+/gi, (candidate) => {
      try {
        return new URL(candidate).origin;
      } catch {
        return "[API 地址已隐藏]";
      }
    })
    .slice(0, TRANSFER_ERROR_MAX_LENGTH);
}

const TRANSFER_FAILURE_SENSITIVE_KEY = /(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|token|api[-_]?key|access[-_]?key|client[-_]?secret|credential|connectionstring)/i;

function redactTransferFailureText(value) {
  return String(value ?? "")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [敏感信息已隐藏]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^@\s/]+@/gi, "$1[凭据已隐藏]@")
    .replace(/((?:authorization|password|passwd|secret|token|cookie|api[-_]?key|access[-_]?key|client[-_]?secret)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[敏感信息已隐藏]");
}

function redactTransferFailureJson(value, depth = 0) {
  if (depth > 12) return "[嵌套内容已省略]";
  if (Array.isArray(value)) return value.map((item) => redactTransferFailureJson(item, depth + 1));
  if (typeof value === "string") return redactTransferFailureText(value);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    TRANSFER_FAILURE_SENSITIVE_KEY.test(key)
      ? "[敏感信息已隐藏]"
      : redactTransferFailureJson(item, depth + 1)
  ]));
}

export function sanitizeTransferFailureResponseBody(value, alreadyTruncated = false) {
  const raw = String(value ?? "");
  let sanitized = raw;
  try {
    sanitized = JSON.stringify(redactTransferFailureJson(JSON.parse(raw)), null, 2);
  } catch {
    sanitized = redactTransferFailureText(raw);
  }
  const truncated = alreadyTruncated || sanitized.length > TRANSFER_FAILURE_RESPONSE_MAX_BYTES;
  return {
    body: sanitized.slice(0, TRANSFER_FAILURE_RESPONSE_MAX_BYTES),
    truncated
  };
}

async function readTransferFailureResponse(response) {
  const statusText = text(redactTransferFailureText(response?.statusText), 300);
  let responseContentType = "";
  try {
    responseContentType = text(response?.headers?.get?.("content-type"), 300);
  } catch {
    responseContentType = "";
  }

  let rawBody = "";
  let transportTruncated = false;
  let responseBodyReadError = "";
  try {
    if (response?.body?.getReader && typeof TextDecoder === "function") {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let capturedBytes = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          const bytes = chunk.value instanceof Uint8Array
            ? chunk.value
            : new Uint8Array(chunk.value || []);
          const remaining = TRANSFER_FAILURE_RESPONSE_MAX_BYTES - capturedBytes;
          if (remaining <= 0) {
            transportTruncated = true;
            await reader.cancel?.();
            break;
          }
          const accepted = bytes.byteLength > remaining ? bytes.subarray(0, remaining) : bytes;
          rawBody += decoder.decode(accepted, { stream: true });
          capturedBytes += accepted.byteLength;
          if (bytes.byteLength > remaining) {
            transportTruncated = true;
            await reader.cancel?.();
            break;
          }
        }
        rawBody += decoder.decode();
      } finally {
        reader.releaseLock?.();
      }
    } else if (typeof response?.text === "function") {
      const completeBody = String(await response.text());
      transportTruncated = completeBody.length > TRANSFER_FAILURE_RESPONSE_MAX_BYTES;
      rawBody = completeBody.slice(0, TRANSFER_FAILURE_RESPONSE_MAX_BYTES);
    }
  } catch (error) {
    responseBodyReadError = sanitizeTransferErrorMessage(error);
  }

  const sanitized = sanitizeTransferFailureResponseBody(rawBody, transportTruncated);
  return {
    kind: "http",
    statusText,
    responseContentType,
    responseBody: sanitized.body,
    responseBodyTruncated: sanitized.truncated,
    responseBodyReadError
  };
}

function createTransferFailureSnapshot(error, options = {}) {
  const detail = error?.failureDetail && typeof error.failureDetail === "object"
    ? error.failureDetail
    : {};
  const attempted = error?.attempted === true;
  const completeResponseBody = String(detail.responseBody ?? "");
  const responseBodyMaximum = Math.min(
    TRANSFER_FAILURE_RESPONSE_MAX_BYTES,
    Math.max(1, Number(options.responseBodyMaximum) || TRANSFER_FAILURE_RESPONSE_MAX_BYTES)
  );
  return {
    attemptNumber: Math.max(0, Number(options.attemptNumber) || 0),
    attempted,
    attemptedAt: attempted ? text(options.attemptedAt, 80) : "",
    failedAt: text(options.failedAt, 80),
    failureKind: text(detail.kind, 80) || (attempted ? "request" : "preflight"),
    httpStatus: Number(error?.httpStatus) || Number(detail.httpStatus) || 0,
    statusText: text(redactTransferFailureText(detail.statusText), 300),
    responseContentType: text(detail.responseContentType, 300),
    responseBody: completeResponseBody.slice(0, responseBodyMaximum),
    responseBodyTruncated: detail.responseBodyTruncated === true
      || completeResponseBody.length > responseBodyMaximum,
    responseBodyReadError: text(detail.responseBodyReadError, TRANSFER_ERROR_MAX_LENGTH),
    errorName: text(detail.errorName, 120),
    errorMessage: text(detail.errorMessage, TRANSFER_ERROR_MAX_LENGTH),
    abortReason: text(detail.abortReason, 120),
    error: sanitizeTransferErrorMessage(error),
    deliveryUncertain: error?.deliveryUncertain === true,
    retryEligible: error?.retryable === true,
    willRetry: options.willRetry === true
  };
}

function createTransferAttemptHistoryEntry(failure = {}) {
  return {
    attemptNumber: Math.max(0, Number(failure.attemptNumber) || 0),
    attempted: failure.attempted === true,
    attemptedAt: text(failure.attemptedAt, 80),
    failedAt: text(failure.failedAt, 80),
    failureKind: text(failure.failureKind, 80),
    httpStatus: Math.max(0, Number(failure.httpStatus) || 0),
    statusText: text(failure.statusText, 300),
    responseContentType: text(failure.responseContentType, 300),
    responseBodyCaptured: Boolean(failure.responseBody),
    responseBodyTruncated: failure.responseBodyTruncated === true,
    responseBodyReadError: text(failure.responseBodyReadError, TRANSFER_ERROR_MAX_LENGTH),
    errorName: text(failure.errorName, 120),
    errorMessage: text(failure.errorMessage, TRANSFER_ERROR_MAX_LENGTH),
    abortReason: text(failure.abortReason, 120),
    error: text(failure.error, TRANSFER_ERROR_MAX_LENGTH),
    deliveryUncertain: failure.deliveryUncertain === true,
    retryEligible: failure.retryEligible === true,
    willRetry: failure.willRetry === true
  };
}

export function summarizeTransferChannelResults(channelResults = {}) {
  const results = Object.values(channelResults && typeof channelResults === "object" ? channelResults : {});
  if (!results.length) {
    return { status: TRANSFER_STATUS.FAILED, completed: true, error: "策略未解析出可执行通道。" };
  }
  const pending = results.some((result) => result?.status === TRANSFER_STATUS.PENDING);
  const transferring = results.some((result) => result?.status === TRANSFER_STATUS.TRANSFERRING);
  const failed = results.filter((result) => result?.status === TRANSFER_STATUS.FAILED);
  const success = results.every((result) => result?.status === TRANSFER_STATUS.SUCCESS);
  const notRequired = results.every((result) => result?.status === TRANSFER_STATUS.NOT_REQUIRED);
  if (success) return { status: TRANSFER_STATUS.SUCCESS, completed: true, error: "" };
  if (notRequired) return { status: TRANSFER_STATUS.NOT_REQUIRED, completed: true, error: "" };
  if (pending || transferring) {
    return {
      status: transferring ? TRANSFER_STATUS.TRANSFERRING : TRANSFER_STATUS.PENDING,
      completed: false,
      error: ""
    };
  }
  return {
    status: TRANSFER_STATUS.FAILED,
    completed: true,
    error: failed.map((result) => `${result.channelName || result.channelId}：${result.error || "传输失败"}`)
      .join("；")
      .slice(0, TRANSFER_ERROR_MAX_LENGTH)
  };
}

export function sumTransferAttemptCount(channelResults = {}) {
  return Object.values(channelResults && typeof channelResults === "object" ? channelResults : {})
    .reduce((total, result) => total + Math.max(0, Number(result?.attemptCount) || 0), 0);
}

async function containsEndpointPermission(chromeApi, endpoint) {
  const originPattern = endpointToOriginPattern(endpoint);
  if (!chromeApi?.permissions?.contains) return false;
  return Boolean(await callChrome(chromeApi, (done) => chromeApi.permissions.contains({
    origins: [originPattern]
  }, done)));
}

function transferExecutionError(message, options = {}) {
  const error = new Error(message);
  error.transferExecution = true;
  error.deliveryUncertain = options.deliveryUncertain === true;
  error.retryable = options.retryable === true;
  error.httpStatus = Number(options.httpStatus) || 0;
  error.attempted = options.attempted === true;
  error.failureDetail = options.failureDetail && typeof options.failureDetail === "object"
    ? clone(options.failureDetail)
    : { kind: error.attempted ? "request" : "preflight" };
  return error;
}

async function executeApiBatch({
  chromeApi,
  fetchImpl,
  channel,
  plans,
  activeAbortControllers,
  executionGate,
  onRequestStart,
  onRequestCancelled
}) {
  const endpoint = text(channel?.config?.endpoint);
  if (!endpoint) throw transferExecutionError("API POST 地址为空。");
  if (typeof fetchImpl !== "function") {
    throw transferExecutionError("当前环境不支持 fetch，无法执行 API POST。");
  }

  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let requestStarted = false;
  let attemptPersisted = false;
  let timeout = null;
  if (controller) {
    controller.transferAbortReason = "";
    activeAbortControllers?.add(controller);
  }
  try {
    if (typeof executionGate === "function" && !await executionGate()) {
      throw transferExecutionError("传输设置已变化，本次 API POST 未执行。");
    }
    const permitted = await containsEndpointPermission(chromeApi, endpoint);
    if (!permitted) {
      throw transferExecutionError(`尚未授予 API 目标地址权限：${endpointToOriginPattern(endpoint)}`);
    }
    const headers = parseTransferApiHeaders(channel?.config?.headers);
    const idempotencyKey = await createTransferIdempotencyKey(plans, channel);
    headers["Idempotency-Key"] = idempotencyKey;
    if (controller?.signal?.aborted) {
      throw transferExecutionError("传输设置已变化，本次 API POST 未执行。");
    }
    if (typeof executionGate === "function" && !await executionGate()) {
      throw transferExecutionError("传输设置已变化，本次 API POST 未执行。");
    }
    await onRequestStart?.({ idempotencyKey });
    attemptPersisted = true;
    if (controller?.signal?.aborted || typeof executionGate === "function" && !await executionGate()) {
      await onRequestCancelled?.();
      attemptPersisted = false;
      throw transferExecutionError("传输设置已变化，本次 API POST 未执行。");
    }
    requestStarted = true;
    if (controller) {
      timeout = setTimeout(() => {
        controller.transferAbortReason = "timeout";
        controller.abort();
      }, TRANSFER_REQUEST_TIMEOUT_MS);
    }
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(createTransferApiPayload(plans, idempotencyKey)),
      credentials: "omit",
      redirect: "manual",
      signal: controller?.signal
    });
    if (controller?.signal?.aborted) {
      throw transferExecutionError("API POST 已取消；远端是否收到数据无法确认。", {
        deliveryUncertain: true
      });
    }
    if (!response?.ok) {
      const httpStatus = Number(response?.status) || 0;
      const failureDetail = await readTransferFailureResponse(response);
      const statusLabel = failureDetail.statusText ? ` ${failureDetail.statusText}` : "";
      throw transferExecutionError(`API 返回 HTTP ${httpStatus}${statusLabel}`, {
        httpStatus,
        attempted: true,
        retryable: isRetryableTransferHttpStatus(httpStatus),
        failureDetail: { ...failureDetail, httpStatus }
      });
    }
    return { httpStatus: Number(response.status) || 200, idempotencyKey };
  } catch (error) {
    if (attemptPersisted && !requestStarted) {
      await onRequestCancelled?.();
      attemptPersisted = false;
    }
    if (controller?.signal?.aborted || error?.name === "AbortError") {
      throw transferExecutionError(
        requestStarted
          ? controller?.transferAbortReason === "transfer_disabled"
            ? "总开关已关闭，正在执行的 API POST 已取消；远端是否收到数据无法确认。"
            : "API POST 已取消或超时；远端是否收到数据无法确认。"
          : "传输设置已变化，本次 API POST 未执行。",
        {
          attempted: requestStarted,
          deliveryUncertain: requestStarted,
          failureDetail: {
            kind: requestStarted
              ? controller?.transferAbortReason === "timeout" ? "timeout" : "cancelled"
              : "preflight",
            abortReason: text(controller?.transferAbortReason, 120)
          }
        }
      );
    }
    if (error?.transferExecution === true) throw error;
    if (!requestStarted) {
      throw transferExecutionError(error?.message || "API 通道配置无效，本次 POST 未执行。", {
        failureDetail: {
          kind: "preflight",
          errorName: text(error?.name, 120),
          errorMessage: sanitizeTransferErrorMessage(error)
        }
      });
    }
    throw transferExecutionError("API POST 请求失败；远端是否收到数据无法确认。", {
      attempted: true,
      deliveryUncertain: true,
      failureDetail: {
        kind: "network",
        errorName: text(error?.name, 120),
        errorMessage: sanitizeTransferErrorMessage(error)
      }
    });
  } finally {
    if (timeout) clearTimeout(timeout);
    if (controller) activeAbortControllers?.delete(controller);
  }
}

async function executeChannelBatch({
  chromeApi,
  fetchImpl,
  channel,
  plans,
  activeAbortControllers,
  executionGate,
  onRequestStart,
  onRequestCancelled
}) {
  if (channel?.type === TRANSFER_CHANNEL_TYPES.MONGODB) {
    throw transferExecutionError("浏览器扩展不能直接连接 MongoDB，请改用具备服务端适配器的 API 通道。");
  }
  if (channel?.type !== TRANSFER_CHANNEL_TYPES.API) {
    throw transferExecutionError(`暂不支持执行通道类型：${text(channel?.type) || "unknown"}`);
  }
  return executeApiBatch({
    chromeApi,
    fetchImpl,
    channel,
    plans,
    activeAbortControllers,
    executionGate,
    onRequestStart,
    onRequestCancelled
  });
}

export function createTransferController({
  chromeApi = globalThis.chrome,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  descriptors = listTransferRunnerDescriptors(),
  now = Date.now,
  logger = globalThis.console
} = {}) {
  const descriptorByStorageKey = new Map(descriptors.map((descriptor) => [descriptor.storageKey, descriptor]));
  let workQueue = Promise.resolve();
  let archiveQueue = Promise.resolve();
  let installed = false;
  let baselineInitialized = false;
  const baselineInitializedStorageKeys = new Set();
  let startupRecoveryComplete = false;
  let transferEnabled = false;
  let settingsGeneration = 0;
  let storageListener = null;
  const activeAbortControllers = new Set();

  const enqueue = (operation) => {
    const queued = workQueue.catch(() => undefined).then(operation);
    workQueue = queued.then(() => undefined, () => undefined);
    return queued;
  };

  const initializeSettingsGate = (value) => {
    if (settingsGeneration === 0) {
      transferEnabled = normalizeTransferSettings(value).enabled;
      settingsGeneration = 1;
    }
    return { enabled: transferEnabled, generation: settingsGeneration };
  };

  const applySettingsChange = (value) => {
    const nextEnabled = normalizeTransferSettings(value).enabled;
    transferEnabled = nextEnabled;
    settingsGeneration += 1;
    for (const controller of activeAbortControllers) {
      controller.transferAbortReason = nextEnabled ? "settings_changed" : "transfer_disabled";
      controller.abort();
    }
    return { enabled: transferEnabled, generation: settingsGeneration };
  };

  const mutateArchiveStatus = (key, mutation) => {
    const queued = archiveQueue.catch(() => undefined).then(async () => {
      const values = await getStorage(chromeApi, TRANSFER_ARCHIVE_STORAGE_KEY);
      const archive = values?.[TRANSFER_ARCHIVE_STORAGE_KEY] && typeof values[TRANSFER_ARCHIVE_STORAGE_KEY] === "object"
        ? values[TRANSFER_ARCHIVE_STORAGE_KEY]
        : {};
      const statuses = archive.dataStatusByKey && typeof archive.dataStatusByKey === "object"
        ? archive.dataStatusByKey
        : {};
      const output = await mutation(statuses[key], archive);
      if (!output?.next) return output?.result;
      await setStorage(chromeApi, {
        [TRANSFER_ARCHIVE_STORAGE_KEY]: {
          ...archive,
          dataStatusByKey: { ...statuses, [key]: output.next }
        }
      });
      return output.result;
    });
    archiveQueue = queued.then(() => undefined, () => undefined);
    return queued;
  };

  const mutateArchiveStatuses = (plans, mutation) => {
    const uniquePlans = [...new Map(asTransferPlans(plans).map((plan) => [plan.key, plan])).values()];
    const queued = archiveQueue.catch(() => undefined).then(async () => {
      const values = await getStorage(chromeApi, TRANSFER_ARCHIVE_STORAGE_KEY);
      const archive = values?.[TRANSFER_ARCHIVE_STORAGE_KEY] && typeof values[TRANSFER_ARCHIVE_STORAGE_KEY] === "object"
        ? values[TRANSFER_ARCHIVE_STORAGE_KEY]
        : {};
      const statuses = archive.dataStatusByKey && typeof archive.dataStatusByKey === "object"
        ? archive.dataStatusByKey
        : {};
      const nextStatuses = { ...statuses };
      const results = new Map();
      let changed = false;
      for (const plan of uniquePlans) {
        const output = await mutation(statuses[plan.key], plan, archive);
        results.set(plan.key, output?.result);
        if (!output?.next) continue;
        nextStatuses[plan.key] = output.next;
        changed = true;
      }
      if (changed) {
        await setStorage(chromeApi, {
          [TRANSFER_ARCHIVE_STORAGE_KEY]: {
            ...archive,
            dataStatusByKey: nextStatuses
          }
        });
      }
      return results;
    });
    archiveQueue = queued.then(() => undefined, () => undefined);
    return queued;
  };

  const reservePlan = (plan) => mutateArchiveStatus(plan.key, (current) => {
    if (current?.status) return { result: false };
    return { next: createTransferStatusEntry(plan), result: true };
  });

  const updateBatchChannelResults = (plans, channel, createPatch) => mutateArchiveStatuses(
    plans,
    (current, plan) => {
      if (!current?.status) return { result: null };
      const previous = current.channelResults?.[channel.id] || pendingChannelResult(channel);
      const patch = typeof createPatch === "function"
        ? createPatch(previous, plan, current)
        : createPatch;
      const channelResults = {
        ...(current.channelResults || {}),
        [channel.id]: { ...previous, ...(patch || {}) }
      };
      const summary = summarizeTransferChannelResults(channelResults);
      const updatedAt = text(patch?.completedAt || patch?.lastAttemptAt || patch?.attemptedAt) || isoNow(now);
      const hasPatchedAttemptedAt = Object.prototype.hasOwnProperty.call(patch || {}, "attemptedAt");
      const next = {
        ...current,
        status: summary.status,
        channelResults,
        attemptCount: sumTransferAttemptCount(channelResults),
        error: summary.error,
        deliveryUncertain: Object.values(channelResults).some((result) => result?.deliveryUncertain === true),
        attemptedAt: hasPatchedAttemptedAt ? patch.attemptedAt || "" : current.attemptedAt || "",
        completedAt: summary.completed ? updatedAt : "",
        updatedAt
      };
      return { next, result: next.channelResults[channel.id] };
    }
  );

  const stopPlanBecauseTransferDisabled = (plan) => mutateArchiveStatus(plan.key, (current) => {
    if (!current?.status) return { result: null };
    const results = Object.values(current.channelResults || {});
    const hasStarted = results.some((result) => (
      result?.status !== TRANSFER_STATUS.PENDING
      || Math.max(0, Number(result?.attemptCount) || 0) > 0
    ));
    const completedAt = isoNow(now);
    const channelResults = Object.fromEntries(Object.entries(current.channelResults || {}).map(([channelId, result]) => [
      channelId,
      result?.status === TRANSFER_STATUS.PENDING
        ? {
            ...result,
            status: hasStarted ? TRANSFER_STATUS.FAILED : TRANSFER_STATUS.NOT_REQUIRED,
            completedAt,
            error: hasStarted ? "总开关已关闭，该通道未继续执行。" : "",
            deliveryUncertain: false
          }
        : result
    ]));
    const decision = hasStarted
      ? current.decision
      : createDecisionSnapshot(createNoTransferDecision("transfer_disabled"), completedAt);
    const summary = summarizeTransferChannelResults(channelResults);
    return {
      next: {
        ...current,
        status: summary.status,
        action: hasStarted ? current.action : TRANSFER_ACTIONS.NOT_REQUIRED,
        reason: hasStarted ? current.reason : "transfer_disabled",
        decision,
        channelResults,
        error: summary.error,
        deliveryUncertain: Object.values(channelResults).some((result) => result?.deliveryUncertain === true),
        completedAt,
        updatedAt: completedAt
      },
      result: summary.status
    };
  });

  const validateBatchRoute = (plans, channelId, settings) => {
    const currentChannel = settings.channels.find((item) => item.id === channelId);
    if (!currentChannel?.enabled) {
      return { valid: false, currentChannel, reason: "通道已删除或停用，本次传输未执行。" };
    }
    const resolveStrategy = createTransferStrategyResolver(settings);
    const stillRouted = plans.every((plan) => {
      const decision = resolveStrategy({ featureId: plan.featureId, platformId: plan.platformId });
      return decision.action === TRANSFER_ACTIONS.CHANNEL
        && decision.strategyId === plan.decision?.strategyId
        && decision.channelIds.includes(channelId);
    });
    return stillRouted
      ? { valid: true, currentChannel, reason: "" }
      : { valid: false, currentChannel, reason: "命中的策略或通道绑定已变化，本次传输未执行。" };
  };

  const failBatchWithoutRequest = (plans, channel, error) => {
    const completedAt = isoNow(now);
    return updateBatchChannelResults(plans, channel, (previous) => {
      const failure = createTransferFailureSnapshot(error, {
        attemptNumber: Number(previous.attemptCount) || 0,
        failedAt: completedAt,
        willRetry: false
      });
      return {
        status: TRANSFER_STATUS.FAILED,
        completedAt,
        httpStatus: Number(error?.httpStatus) || 0,
        error: sanitizeTransferErrorMessage(error),
        deliveryUncertain: error?.deliveryUncertain === true,
        retryable: false,
        retryEligible: error?.retryable === true,
        failureKind: failure.failureKind,
        lastFailure: failure,
        attemptHistory: Array.isArray(previous.attemptHistory) ? previous.attemptHistory : []
      };
    });
  };

  const executePlanBatch = async (plans, channel, settingsSnapshot, discoveryGeneration) => {
    if (!plans.length) return;
    const settingsValues = await getStorage(chromeApi, TRANSFER_SETTINGS_STORAGE_KEY);
    const currentSettings = normalizeTransferSettings(settingsValues?.[TRANSFER_SETTINGS_STORAGE_KEY]);
    if (!installed) {
      transferEnabled = currentSettings.enabled;
      settingsGeneration += 1;
    } else {
      initializeSettingsGate(currentSettings);
    }
    if (!currentSettings.enabled || !transferEnabled) {
      for (const plan of plans) await stopPlanBecauseTransferDisabled(plan);
      return;
    }
    if (installed && settingsGeneration !== discoveryGeneration) {
      await failBatchWithoutRequest(
        plans,
        channel,
        transferExecutionError("传输设置已变化，本次 API POST 未执行。")
      );
      return;
    }

    const route = validateBatchRoute(plans, channel.id, currentSettings);
    if (!route.valid) {
      await failBatchWithoutRequest(plans, channel, transferExecutionError(route.reason));
      return;
    }
    const currentChannel = route.currentChannel;
    const executionGeneration = settingsGeneration;
    const channelSignature = transferChannelExecutionSignature(currentChannel);
    const expectedRetryCount = settingsSnapshot.retryCount;
    const expectedBatchSize = settingsSnapshot.batchSize;
    const executionGate = async () => {
      if (!transferEnabled || settingsGeneration !== executionGeneration) return false;
      const latestValues = await getStorage(chromeApi, TRANSFER_SETTINGS_STORAGE_KEY);
      const latestSettings = normalizeTransferSettings(latestValues?.[TRANSFER_SETTINGS_STORAGE_KEY]);
      if (
        !latestSettings.enabled
        || latestSettings.retryCount !== expectedRetryCount
        || latestSettings.batchSize !== expectedBatchSize
      ) return false;
      const latestRoute = validateBatchRoute(plans, channel.id, latestSettings);
      return Boolean(
        latestRoute.valid
        && transferChannelExecutionSignature(latestRoute.currentChannel) === channelSignature
      );
    };

    const maximumAttempts = 1 + expectedRetryCount;
    for (let attemptIndex = 0; attemptIndex < maximumAttempts; attemptIndex += 1) {
      const attemptedAt = isoNow(now);
      const preRequestChannelResults = new Map();
      try {
        const result = await executeChannelBatch({
          chromeApi,
          fetchImpl,
          channel: currentChannel,
          plans,
          activeAbortControllers,
          executionGate,
          onRequestStart: ({ idempotencyKey }) => updateBatchChannelResults(
            plans,
            currentChannel,
            (previous, plan) => {
              preRequestChannelResults.set(plan.key, { ...previous });
              return {
                status: TRANSFER_STATUS.TRANSFERRING,
                attemptCount: Math.max(0, Number(previous.attemptCount) || 0) + 1,
                idempotencyKey,
                attemptedAt: previous.attemptedAt || attemptedAt,
                lastAttemptAt: attemptedAt,
                completedAt: "",
                httpStatus: 0,
                error: "",
                deliveryUncertain: false,
                retryable: false,
                retryEligible: false,
                failureKind: ""
              };
            }
          ),
          onRequestCancelled: async () => {
            const restored = await updateBatchChannelResults(
              plans,
              currentChannel,
              (previous, plan) => preRequestChannelResults.get(plan.key) || {
                status: TRANSFER_STATUS.PENDING,
                attemptCount: Math.max(0, (Number(previous.attemptCount) || 0) - 1),
                idempotencyKey: "",
                attemptedAt: "",
                lastAttemptAt: "",
                completedAt: "",
                httpStatus: 0,
                error: "",
                deliveryUncertain: false,
                retryable: false,
                retryEligible: false,
                failureKind: ""
              }
            );
            preRequestChannelResults.clear();
            return restored;
          }
        });
        const completedAt = isoNow(now);
        await updateBatchChannelResults(plans, currentChannel, {
          status: TRANSFER_STATUS.SUCCESS,
          completedAt,
          httpStatus: result.httpStatus,
          error: "",
          deliveryUncertain: false,
          retryable: false,
          retryEligible: false,
          failureKind: ""
        });
        return;
      } catch (error) {
        let disabledBeforeRequest = error?.attempted !== true && !transferEnabled;
        if (error?.attempted !== true && !disabledBeforeRequest) {
          try {
            const latestValues = await getStorage(chromeApi, TRANSFER_SETTINGS_STORAGE_KEY);
            disabledBeforeRequest = !normalizeTransferSettings(
              latestValues?.[TRANSFER_SETTINGS_STORAGE_KEY]
            ).enabled;
          } catch {
            disabledBeforeRequest = false;
          }
        }
        if (disabledBeforeRequest) {
          for (const plan of plans) await stopPlanBecauseTransferDisabled(plan);
          return;
        }
        const canRetry = error?.retryable === true
          && error?.deliveryUncertain !== true
          && attemptIndex + 1 < maximumAttempts;
        const completedAt = isoNow(now);
        const responseBodyMaximum = Math.min(
          TRANSFER_FAILURE_RESPONSE_MAX_BYTES,
          Math.max(1, Math.floor(TRANSFER_BATCH_FAILURE_BODY_BUDGET / Math.max(1, plans.length)))
        );
        await updateBatchChannelResults(plans, currentChannel, (previous) => {
          const failure = createTransferFailureSnapshot(error, {
            attemptNumber: Number(previous.attemptCount) || 0,
            attemptedAt,
            failedAt: completedAt,
            willRetry: canRetry,
            responseBodyMaximum
          });
          const attemptHistory = error?.attempted === true
            ? [
              ...(Array.isArray(previous.attemptHistory)
                ? previous.attemptHistory.map(createTransferAttemptHistoryEntry)
                : []),
              createTransferAttemptHistoryEntry(failure)
            ]
              .slice(-TRANSFER_ATTEMPT_HISTORY_LIMIT)
            : Array.isArray(previous.attemptHistory) ? previous.attemptHistory : [];
          return {
            status: canRetry ? TRANSFER_STATUS.PENDING : TRANSFER_STATUS.FAILED,
            completedAt: canRetry ? "" : completedAt,
            lastAttemptAt: error?.attempted === true ? attemptedAt : previous.lastAttemptAt || "",
            httpStatus: Number(error?.httpStatus) || 0,
            error: sanitizeTransferErrorMessage(error),
            deliveryUncertain: error?.deliveryUncertain === true,
            retryable: canRetry,
            retryEligible: error?.retryable === true,
            failureKind: failure.failureKind,
            lastFailure: failure,
            attemptHistory
          };
        });
        if (!canRetry) return;
      }
    }
  };

  const processStorageOperations = async (operations = []) => {
    const discovered = operations.flatMap(({ descriptor, change }) => (
      collectNewTransferRecords(descriptor, change).map((candidate) => ({ descriptor, candidate }))
    ));
    if (!discovered.length) return { discoveredCount: 0, reservedCount: 0, batchCount: 0 };
    const values = await getStorage(chromeApi, TRANSFER_SETTINGS_STORAGE_KEY);
    const settings = normalizeTransferSettings(values?.[TRANSFER_SETTINGS_STORAGE_KEY]);
    initializeSettingsGate(settings);
    const discoveryGeneration = settingsGeneration;
    const capturedAt = isoNow(now);
    let reservedCount = 0;
    const executablePlans = [];
    for (const { descriptor, candidate } of discovered) {
      const plan = createTransferRecordPlan({
        descriptor,
        row: candidate.row,
        index: candidate.index,
        settings,
        capturedAt
      });
      const reserved = await reservePlan(plan);
      if (!reserved) continue;
      reservedCount += 1;
      if (plan.decision.action === TRANSFER_ACTIONS.CHANNEL) executablePlans.push(plan);
    }
    let batchCount = 0;
    for (const group of groupTransferPlansByChannel(executablePlans)) {
      for (const batch of chunkTransferPlans(group.plans, settings.batchSize)) {
        batchCount += 1;
        await executePlanBatch(batch, group.channel, settings, discoveryGeneration);
      }
    }
    return { discoveredCount: discovered.length, reservedCount, batchCount };
  };

  const processStorageChange = (descriptor, change) => processStorageOperations([{ descriptor, change }]);

  const recoverInterruptedTransfers = async () => {
    if (startupRecoveryComplete) return { recoveredCount: 0 };
    const values = await getStorage(chromeApi, TRANSFER_ARCHIVE_STORAGE_KEY);
    const archive = values?.[TRANSFER_ARCHIVE_STORAGE_KEY] && typeof values[TRANSFER_ARCHIVE_STORAGE_KEY] === "object"
      ? values[TRANSFER_ARCHIVE_STORAGE_KEY]
      : {};
    const recovered = recoverInterruptedTransferStatuses(archive, isoNow(now));
    if (recovered.recoveredCount) {
      await setStorage(chromeApi, {
        [TRANSFER_ARCHIVE_STORAGE_KEY]: {
          ...archive,
          dataStatusByKey: recovered.dataStatusByKey
        }
      });
    }
    startupRecoveryComplete = true;
    return { recoveredCount: recovered.recoveredCount };
  };

  const initializeLegacyBaseline = async (storageOverrides = {}, targetDescriptors = descriptors) => {
    if (!hasStorageApi(chromeApi)) return { ok: false, initializedCount: 0, reason: "storage_unavailable" };
    const baselineDescriptors = [...new Map((Array.isArray(targetDescriptors) ? targetDescriptors : [])
      .filter((descriptor) => descriptor?.storageKey)
      .map((descriptor) => [descriptor.storageKey, descriptor])).values()];
    const keys = [
      ...baselineDescriptors.map((descriptor) => descriptor.storageKey),
      TRANSFER_ARCHIVE_STORAGE_KEY,
      TRANSFER_SETTINGS_STORAGE_KEY
    ];
    const storedValues = await getStorage(chromeApi, keys);
    const values = { ...storedValues, ...storageOverrides };
    initializeSettingsGate(values?.[TRANSFER_SETTINGS_STORAGE_KEY]);
    const archive = values?.[TRANSFER_ARCHIVE_STORAGE_KEY] && typeof values[TRANSFER_ARCHIVE_STORAGE_KEY] === "object"
      ? values[TRANSFER_ARCHIVE_STORAGE_KEY]
      : {};
    const baseline = createLegacyBaselineStatuses({
      descriptors: baselineDescriptors,
      values,
      archive,
      createdAt: isoNow(now)
    });
    if (baseline.initializedCount) {
      await setStorage(chromeApi, {
        [TRANSFER_ARCHIVE_STORAGE_KEY]: {
          ...archive,
          dataStatusByKey: baseline.dataStatusByKey
        }
      });
    }
    for (const descriptor of baselineDescriptors) {
      baselineInitializedStorageKeys.add(descriptor.storageKey);
    }
    baselineInitialized = descriptors.every((descriptor) => (
      baselineInitializedStorageKeys.has(descriptor.storageKey)
    ));
    return { ok: true, initializedCount: baseline.initializedCount };
  };

  const reconcile = () => enqueue(async () => {
    const recovery = await recoverInterruptedTransfers();
    const baseline = await initializeLegacyBaseline();
    return {
      ...baseline,
      ...recovery,
      controller: {
        installed,
        runnerCount: descriptors.length
      }
    };
  });

  const install = () => {
    if (installed || !hasStorageApi(chromeApi) || !chromeApi?.storage?.onChanged?.addListener) {
      return { installed, ready: Promise.resolve({ ok: false, initializedCount: 0 }) };
    }
    storageListener = (changes, areaName) => {
      if (areaName !== "local") return;
      const settingsChange = changes?.[TRANSFER_SETTINGS_STORAGE_KEY];
      if (settingsChange) applySettingsChange(settingsChange.newValue);
      const archiveChange = changes?.[TRANSFER_ARCHIVE_STORAGE_KEY];
      const archiveReset = Boolean(archiveChange && !archiveChange.newValue?.dataStatusByKey);
      if (archiveReset) {
        baselineInitialized = false;
        baselineInitializedStorageKeys.clear();
        startupRecoveryComplete = false;
      }
      const operations = Object.entries(changes || {})
        .map(([storageKey, change]) => ({ descriptor: descriptorByStorageKey.get(storageKey), change }))
        .filter((item) => item.descriptor);
      if (!operations.length && !archiveReset) return;
      enqueue(async () => {
        await recoverInterruptedTransfers();
        const descriptorsNeedingBaseline = operations.filter(({ descriptor }) => (
          !baselineInitializedStorageKeys.has(descriptor.storageKey)
        ));
        if (descriptorsNeedingBaseline.length) {
          const oldValueOverrides = Object.fromEntries(descriptorsNeedingBaseline.map(({ descriptor, change }) => [
            descriptor.storageKey,
            change?.oldValue || { dataRows: [] }
          ]));
          await initializeLegacyBaseline(
            oldValueOverrides,
            descriptorsNeedingBaseline.map(({ descriptor }) => descriptor)
          );
        } else if (archiveReset && !operations.length) {
          await initializeLegacyBaseline();
        }
        await processStorageOperations(operations);
      }).catch((error) => logger?.error?.("数据传输同步失败：", error));
    };
    chromeApi.storage.onChanged.addListener(storageListener);
    installed = true;
    // Worker 每次启动都先收口上次中断的执行状态，但此处不能直接读取 Runner
    // 当前值建立历史基线：若本次启动正是由 storage change 唤醒，当前值已经
    // 含有新行，会吞掉首批增量。基线延后到首个 Runner 事件并使用 oldValue。
    const ready = enqueue(async () => ({
      ok: true,
      initializedCount: 0,
      deferredBaseline: true,
      ...await recoverInterruptedTransfers()
    }));
    ready.catch((error) => logger?.error?.("传输历史状态恢复失败：", error));
    return { installed: true, ready };
  };

  const dispose = () => {
    if (storageListener && chromeApi?.storage?.onChanged?.removeListener) {
      chromeApi.storage.onChanged.removeListener(storageListener);
    }
    for (const controller of activeAbortControllers) {
      controller.transferAbortReason = "transfer_disabled";
      controller.abort();
    }
    activeAbortControllers.clear();
    installed = false;
    baselineInitialized = false;
    baselineInitializedStorageKeys.clear();
    startupRecoveryComplete = false;
    transferEnabled = false;
    settingsGeneration = 0;
    storageListener = null;
  };

  return {
    install,
    dispose,
    reconcile,
    initializeLegacyBaseline: () => enqueue(async () => {
      await recoverInterruptedTransfers();
      return initializeLegacyBaseline();
    }),
    processStorageChange: (descriptor, change) => enqueue(async () => {
      await recoverInterruptedTransfers();
      if (!baselineInitializedStorageKeys.has(descriptor?.storageKey)) {
        await initializeLegacyBaseline({
          [descriptor?.storageKey]: change?.oldValue || { dataRows: [] }
        }, [descriptor]);
      }
      return processStorageChange(descriptor, change);
    }),
    getState() {
      return {
        installed,
        baselineInitialized,
        baselineInitializedCount: baselineInitializedStorageKeys.size,
        startupRecoveryComplete,
        transferEnabled,
        settingsGeneration,
        runnerCount: descriptors.length
      };
    }
  };
}

let defaultController = null;

export function installTransferController(options = {}) {
  if (!defaultController) defaultController = createTransferController(options);
  const state = defaultController.install();
  return { ...state, controller: defaultController };
}

import { getFeatureRunner, listFeatureRunners } from "../runners/registry.js";
import { setFeatureRunning } from "../shared/feature-run-status.js";
import {
  applyItemLimit,
  limitItemsPerGroup,
  loadGlobalStorageLimits
} from "../shared/storage-limits.js";
import { TASK_EXECUTION_TYPE_RUNNER } from "../shared/task-record-type.js";
import { mergeDataRowsByKey } from "../shared/data-update-policy.js";
import { MESSAGE_FEATURE_RUNNER_TASK_STATUS } from "./runner-messages.js";

const TASK_STORAGE_PREFIX = "browserCoreClawRunnerTask:";
const TASK_INDEX_STORAGE_KEY = "browserCoreClawRunnerTaskIndexV1";
const activeTasks = new Map();
const featureActiveCounts = new Map();
let storageQueue = Promise.resolve();
let featureStorageQueue = Promise.resolve();

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

function taskStorageKey(taskId) {
  return `${TASK_STORAGE_PREFIX}${taskId}`;
}

function createTaskId(featureId) {
  const prefix = featureId.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toUpperCase();
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}

function publicTaskSnapshot(snapshot) {
  if (!snapshot) return null;
  return JSON.parse(JSON.stringify(snapshot));
}

function formatRecordTime(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return String(value || "-");
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date);
}

function formatRecordDuration(milliseconds) {
  const value = Number(milliseconds);
  if (!Number.isFinite(value) || value < 0) return "-";
  return value < 1000
    ? `${value} ms`
    : `${(value / 1000).toFixed(value < 10000 ? 1 : 0)} 秒`;
}

function runnerRecordStatus(status) {
  return ({
    running: { statusKey: "running", status: "运行中", tone: "running" },
    success: { statusKey: "success", status: "完成", tone: "success" },
    no_data: { statusKey: "empty", status: "无数据", tone: "success" },
    failed: { statusKey: "error", status: "失败", tone: "error" },
    stopped: { statusKey: "stopped", status: "已停止", tone: "stopped" }
  })[status] || { statusKey: "running", status: "运行中", tone: "running" };
}

function storedRecordStatusKey(record) {
  if (record?.statusKey) return record.statusKey;
  const status = String(record?.status || "");
  if (/无数据/.test(status)) return "empty";
  if (/停止/.test(status)) return "stopped";
  if (/失败/.test(status)) return "error";
  if (/完成/.test(status)) return "success";
  return "running";
}

function stripRunnerItemInternals(item = {}) {
  const { rowKeys: _rowKeys, unkeyedResultCount: _unkeyedResultCount, ...publicItem } = item;
  return publicItem;
}

function normalizeRunnerOutputFields(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((item) => String(item || "").trim())
    .filter((item) => /^[a-z][a-z0-9_]*$/i.test(item)))];
}

function projectRunnerOutputRows(rows, outputFields) {
  if (!Array.isArray(rows) || !outputFields.length) return rows;
  const selected = new Set(["id", ...outputFields]);
  return rows.map((row) => Object.fromEntries(
    Object.entries(row && typeof row === "object" ? row : {})
      .filter(([key]) => selected.has(key))
  ));
}

function enqueueFeatureStorageMutation(runner, mutation) {
  if (!hasExtensionStorage() || !runner?.storageKey) return Promise.resolve(null);
  const operation = featureStorageQueue
    .catch(() => {})
    .then(async () => {
      const values = await callChrome((done) => chrome.storage.local.get(runner.storageKey, done));
      const saved = values?.[runner.storageKey] && typeof values[runner.storageKey] === "object"
        ? values[runner.storageKey]
        : {};
      const output = await mutation(saved);
      if (!output?.saved) return output?.result ?? null;
      await callChrome((done) => chrome.storage.local.set({
        [runner.storageKey]: output.saved
      }, done));
      return output.result ?? null;
    });
  featureStorageQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

async function persistRunnerProgressRecord(runner, snapshot, progress) {
  if (!["item_started", "item_finished"].includes(progress?.phase) || !progress.runId) return;
  const limits = await loadGlobalStorageLimits().catch(() => ({ taskRecordsPerStatusLimit: 200 }));
  await enqueueFeatureStorageMutation(runner, async (saved) => {
    const records = Array.isArray(saved.records) ? saved.records : [];
    const current = records.find((record) => String(record?.id || "") === progress.runId) || {};
    const statusMeta = progress.phase === "item_finished"
      ? runnerRecordStatus(progress.status)
      : runnerRecordStatus("running");
    const nextRecord = {
      ...current,
      id: progress.runId,
      runId: progress.runId,
      runnerTaskId: snapshot.taskId,
      sourceFeatureId: snapshot.sourceFeatureId || "",
      executionType: TASK_EXECUTION_TYPE_RUNNER,
      startedAt: current.startedAt || formatRecordTime(progress.startedAt || progress.itemStartedAt),
      keyword: String(progress.input || current.keyword || "-"),
      round: Number(progress.round) || current.round || 1,
      ...statusMeta,
      resultCount: progress.phase === "item_finished" ? Number(progress.resultCount) || 0 : Number(current.resultCount) || 0,
      addedCount: Number(current.addedCount) || 0,
      duration: progress.phase === "item_finished" ? formatRecordDuration(progress.durationMs) : current.duration || "-",
      error: progress.phase === "item_finished" ? String(progress.error || "") : String(current.error || ""),
      finishedAt: progress.phase === "item_finished" ? String(progress.finishedAt || "") : String(current.finishedAt || "")
    };
    const nextRecords = [nextRecord, ...records.filter((record) => String(record?.id || "") !== progress.runId)];
    return {
      saved: {
        ...saved,
        records: limitItemsPerGroup(
          nextRecords,
          storedRecordStatusKey,
          Number(limits.taskRecordsPerStatusLimit)
        )
      }
    };
  });
}

function notifyTaskStatus(snapshot) {
  try {
    chrome.runtime.sendMessage({
      type: MESSAGE_FEATURE_RUNNER_TASK_STATUS,
      options: publicTaskSnapshot(snapshot)
    }, () => void chrome.runtime.lastError);
  } catch {
    // 没有打开控制台时不影响后台 Runner。
  }
}

function enqueueTaskSnapshot(snapshot) {
  if (!hasExtensionStorage()) return Promise.resolve();
  storageQueue = storageQueue
    .catch(() => {})
    .then(async () => {
      const limits = await loadGlobalStorageLimits().catch(() => ({ taskRecordsPerStatusLimit: 200 }));
      const values = await callChrome((done) => chrome.storage.local.get(TASK_INDEX_STORAGE_KEY, done));
      const index = Array.isArray(values?.[TASK_INDEX_STORAGE_KEY])
        ? values[TASK_INDEX_STORAGE_KEY].filter((item) => item?.taskId !== snapshot.taskId)
        : [];
      const nextIndex = [
        {
          taskId: snapshot.taskId,
          featureId: snapshot.featureId,
          status: snapshot.status,
          updatedAt: snapshot.updatedAt
        },
        ...index
      ];
      const perStatusLimit = Number(limits.taskRecordsPerStatusLimit);
      const counts = new Map();
      const limitedIndex = perStatusLimit === 0 ? nextIndex : nextIndex.filter((item) => {
        const count = counts.get(item.status) || 0;
        if (count >= perStatusLimit) return false;
        counts.set(item.status, count + 1);
        return true;
      });
      const removedTaskIds = index
        .map((item) => item.taskId)
        .filter((taskId) => !limitedIndex.some((item) => item.taskId === taskId));
      await callChrome((done) => chrome.storage.local.set({
        [taskStorageKey(snapshot.taskId)]: publicTaskSnapshot(snapshot),
        [TASK_INDEX_STORAGE_KEY]: limitedIndex
      }, done));
      if (removedTaskIds.length) {
        await callChrome((done) => chrome.storage.local.remove(
          removedTaskIds.map(taskStorageKey),
          done
        )).catch(() => {});
      }
    });
  return storageQueue;
}

async function updateFeatureRunning(featureId, delta) {
  const count = Math.max(0, (featureActiveCounts.get(featureId) || 0) + delta);
  if (count) featureActiveCounts.set(featureId, count);
  else featureActiveCounts.delete(featureId);
  await setFeatureRunning(featureId, count > 0);
}

function normalizeRunnerRequest(value = {}) {
  const request = value?.config && typeof value.config === "object" ? value.config : value;
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("Runner 配置必须是一个对象。");
  }
  const schemaVersion = Number(request.schemaVersion ?? 1);
  if (schemaVersion !== 1) throw new Error(`不支持的 Runner schemaVersion：${schemaVersion}`);
  const featureId = String(request.featureId || "").trim();
  const runner = getFeatureRunner(featureId);
  if (!runner) throw new Error(`未注册运行器：${featureId || "empty"}`);
  const parameters = runner.validate(request.parameters);
  const execution = {
    persistData: request.execution?.persistData !== false,
    sourceFeatureId: String(request.execution?.sourceFeatureId || request.sourceFeatureId || "").trim(),
    outputFields: normalizeRunnerOutputFields(request.execution?.outputFields)
  };
  return { schemaVersion, featureId, runner, parameters, execution };
}

async function persistRunnerData(runner, result, forceUpdateData = false) {
  const emptyResult = { addedCount: 0, addedCountsByRunId: new Map() };
  if (!hasExtensionStorage() || !runner.storageKey || !Array.isArray(result.data)) return emptyResult;
  const limits = await loadGlobalStorageLimits().catch(() => ({ dataStorageLimit: 3000 }));
  return enqueueFeatureStorageMutation(runner, async (saved) => {
    const currentRows = Array.isArray(saved.dataRows) ? saved.dataRows : [];
    const merged = mergeDataRowsByKey({
      currentRows,
      incomingRows: result.data,
      getKey: (row) => runner.getRowKey(row),
      forceUpdateData,
      mergeRow: (previous, row) => ({
        ...runner.mergeRow(previous, row),
        runnerTaskId: result.taskId,
        runnerFeatureId: result.featureId
      })
    });
    const unclaimedNewKeys = new Set(merged.addedKeys);
    const addedCountsByRunId = new Map();
    for (const item of Array.isArray(result.items) ? result.items : []) {
      let itemAddedCount = Number(item.unkeyedResultCount) || 0;
      for (const rawKey of Array.isArray(item.rowKeys) ? item.rowKeys : []) {
        const key = String(rawKey ?? "").trim();
        if (!unclaimedNewKeys.has(key)) continue;
        unclaimedNewKeys.delete(key);
        itemAddedCount += 1;
      }
      addedCountsByRunId.set(item.runId, itemAddedCount);
    }
    const dataRows = applyItemLimit(merged.rows, limits.dataStorageLimit);
    return {
      saved: { ...saved, dataRows },
      result: {
        addedCount: merged.addedCount,
        addedCountsByRunId
      }
    };
  });
}

async function updateRunnerRecordAddedCounts(runner, addedCountsByRunId) {
  if (!(addedCountsByRunId instanceof Map) || !addedCountsByRunId.size) return;
  await enqueueFeatureStorageMutation(runner, async (saved) => ({
    saved: {
      ...saved,
      records: (Array.isArray(saved.records) ? saved.records : []).map((record) => (
        addedCountsByRunId.has(record?.id)
          ? { ...record, addedCount: addedCountsByRunId.get(record.id) }
          : record
      ))
    }
  }));
}

async function failRunningRunnerRecords(runner, taskId, errorText) {
  await enqueueFeatureStorageMutation(runner, async (saved) => ({
    saved: {
      ...saved,
      records: (Array.isArray(saved.records) ? saved.records : []).map((record) => (
        record?.runnerTaskId === taskId && storedRecordStatusKey(record) === "running"
          ? {
            ...record,
            status: "失败",
            statusKey: "error",
            tone: "error",
            error: errorText,
            finishedAt: new Date().toISOString()
          }
          : record
      ))
    }
  }));
}

export function listRegisteredFeatureRunners() {
  return { ok: true, runners: listFeatureRunners() };
}

export function validateFeatureRunnerRequest(options = {}) {
  const normalized = normalizeRunnerRequest(options);
  return {
    ok: true,
    config: {
      schemaVersion: normalized.schemaVersion,
      featureId: normalized.featureId,
      parameters: normalized.parameters,
      execution: normalized.execution
    }
  };
}

export async function executeFeatureRunner(options = {}) {
  const normalized = normalizeRunnerRequest(options);
  const taskId = String(options.taskId || options.config?.taskId || "").trim()
    || createTaskId(normalized.featureId);
  if (activeTasks.has(taskId)) throw new Error(`Runner 任务已存在：${taskId}`);

  const startedAt = new Date().toISOString();
  const snapshot = {
    taskId,
    featureId: normalized.featureId,
    sourceFeatureId: normalized.execution.sourceFeatureId,
    status: "running",
    parameters: normalized.parameters,
    progress: { phase: "task_started", current: 0, total: normalized.parameters[normalized.runner.inputKey].length },
    resultCount: 0,
    addedCount: 0,
    failedCount: 0,
    startedAt,
    finishedAt: "",
    updatedAt: startedAt,
    error: ""
  };
  activeTasks.set(taskId, { runner: normalized.runner, snapshot });
  await updateFeatureRunning(normalized.featureId, 1);
  await enqueueTaskSnapshot(snapshot).catch(() => {});
  notifyTaskStatus(snapshot);

  try {
    const result = await normalized.runner.run(normalized.parameters, {
      taskId,
      async reportProgress(progress) {
        snapshot.progress = stripRunnerItemInternals(progress);
        snapshot.updatedAt = new Date().toISOString();
        await Promise.all([
          enqueueTaskSnapshot(snapshot).catch(() => {}),
          persistRunnerProgressRecord(normalized.runner, snapshot, progress).catch(() => {})
        ]);
        notifyTaskStatus(snapshot);
      }
    });
    const persistence = normalized.execution.persistData
      ? await persistRunnerData(normalized.runner, result, normalized.parameters.forceUpdateData)
      : { addedCount: 0, addedCountsByRunId: new Map() };
    await updateRunnerRecordAddedCounts(
      normalized.runner,
      persistence.addedCountsByRunId
    ).catch(() => {});
    const publicItems = result.items.map((item) => ({
      ...stripRunnerItemInternals(item),
      addedCount: persistence.addedCountsByRunId.get(item.runId) || 0
    }));
    Object.assign(snapshot, {
      status: result.status,
      resultCount: result.resultCount,
      uniqueResultCount: result.uniqueResultCount,
      addedCount: persistence.addedCount,
      failedCount: result.failedCount,
      finishedAt: result.finishedAt,
      updatedAt: result.finishedAt,
      durationMs: result.durationMs,
      items: publicItems,
      error: result.status === "failed"
        ? result.items.find((item) => item.status === "failed")?.error || "运行器执行失败。"
        : ""
    });
    await enqueueTaskSnapshot(snapshot).catch(() => {});
    notifyTaskStatus(snapshot);
    return {
      ...result,
      data: projectRunnerOutputRows(result.data, normalized.execution.outputFields),
      items: publicItems,
      addedCount: persistence.addedCount,
      persisted: normalized.execution.persistData
    };
  } catch (error) {
    const finishedAt = new Date().toISOString();
    const errorText = error?.message || String(error);
    Object.assign(snapshot, {
      status: "failed",
      finishedAt,
      updatedAt: finishedAt,
      error: errorText
    });
    await failRunningRunnerRecords(normalized.runner, taskId, errorText).catch(() => {});
    await enqueueTaskSnapshot(snapshot).catch(() => {});
    notifyTaskStatus(snapshot);
    throw error;
  } finally {
    activeTasks.delete(taskId);
    await updateFeatureRunning(normalized.featureId, -1);
  }
}

export async function stopFeatureRunner(options = {}) {
  const taskId = String(options.taskId || "").trim();
  if (!taskId) throw new Error("缺少 Runner 任务编号。");
  const active = activeTasks.get(taskId);
  if (!active) return { ok: true, taskId, stopped: false };
  active.snapshot.status = "stopping";
  active.snapshot.updatedAt = new Date().toISOString();
  await enqueueTaskSnapshot(active.snapshot).catch(() => {});
  notifyTaskStatus(active.snapshot);
  return active.runner.stop(taskId);
}

export async function getFeatureRunnerTask(options = {}) {
  const taskId = String(options.taskId || "").trim();
  if (!taskId) throw new Error("缺少 Runner 任务编号。");
  const active = activeTasks.get(taskId);
  if (active) return { ok: true, task: publicTaskSnapshot(active.snapshot) };
  if (!hasExtensionStorage()) return { ok: true, task: null };
  const key = taskStorageKey(taskId);
  const values = await callChrome((done) => chrome.storage.local.get(key, done));
  return { ok: true, task: values?.[key] || null };
}

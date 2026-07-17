import {
  DEFAULT_TASK_CONCURRENCY,
  normalizeTaskConcurrency,
  runConcurrentTasks
} from "./concurrent-task-pool.js";
import {
  DEFAULT_EXECUTION_INTERVAL_MAX_MS,
  DEFAULT_EXECUTION_INTERVAL_MIN_MS
} from "./execution-interval.js";
import { loadTaskTimeoutSeconds, runWithTaskTimeout } from "./task-timeout.js";
import { normalizeForceUpdateData } from "./data-update-policy.js";

export const FEATURE_RUNNER_STATUSES = Object.freeze({
  RUNNING: "running",
  SUCCESS: "success",
  PARTIAL: "partial",
  NO_DATA: "no_data",
  FAILED: "failed",
  STOPPED: "stopped"
});

function asInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function uniqueStrings(values) {
  return Array.from(new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value ?? "").trim())
      .filter(Boolean)
  ));
}

function normalizeIntervalRange(input = {}) {
  const first = asInteger(
    input.intervalMinMs ?? input.keywordIntervalMinMs,
    DEFAULT_EXECUTION_INTERVAL_MIN_MS,
    100,
    6000
  );
  const second = asInteger(
    input.intervalMaxMs ?? input.keywordIntervalMaxMs,
    DEFAULT_EXECUTION_INTERVAL_MAX_MS,
    100,
    6000
  );
  return {
    intervalMinMs: Math.min(first, second),
    intervalMaxMs: Math.max(first, second)
  };
}

function createTaskId(featureId) {
  const prefix = featureId.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toUpperCase();
  const random = Math.random().toString(36).slice(2, 7).toUpperCase();
  return `${prefix}-${Date.now()}-${random}`;
}

function stopError() {
  const error = new Error("任务已停止");
  error.code = "BROWSER_CORE_CLAW_RUNNER_STOPPED";
  return error;
}

function throwIfStopped(session, signal) {
  if (session.stopped || signal?.aborted) throw stopError();
}

async function waitInterruptibly(milliseconds, session, signal) {
  const deadline = Date.now() + Math.max(0, Number(milliseconds) || 0);
  while (Date.now() < deadline) {
    if (session.stopped || signal?.aborted) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(200, deadline - Date.now())));
  }
  return true;
}

function randomInterval(parameters) {
  const minimum = parameters.intervalMinMs;
  const maximum = parameters.intervalMaxMs;
  return Math.round(minimum + Math.random() * Math.max(0, maximum - minimum));
}

function resultStatus({ stopped, failedCount, completedCount, resultCount }) {
  if (stopped) return FEATURE_RUNNER_STATUSES.STOPPED;
  if (failedCount > 0 && completedCount === 0) return FEATURE_RUNNER_STATUSES.FAILED;
  if (failedCount > 0) return FEATURE_RUNNER_STATUSES.PARTIAL;
  if (resultCount === 0) return FEATURE_RUNNER_STATUSES.NO_DATA;
  return FEATURE_RUNNER_STATUSES.SUCCESS;
}

/**
 * 为一个已经存在单项后台采集函数的功能创建标准 Runner。
 * Runner 只负责任务执行与返回结果；页面展示和按钮交互不进入这一层。
 */
export function createBatchFeatureRunner(definition) {
  const featureId = String(definition?.featureId || "").trim();
  if (!/^[-a-z0-9]+\/[-a-z0-9]+$/i.test(featureId)) {
    throw new Error(`Runner 功能标识不正确：${featureId || "empty"}`);
  }
  if (typeof definition.executeItem !== "function") {
    throw new Error(`${featureId} 缺少 executeItem。`);
  }
  if (typeof definition.stopItem !== "function") {
    throw new Error(`${featureId} 缺少 stopItem。`);
  }

  const inputKey = String(definition.inputKey || "inputs");
  const inputLabel = String(definition.inputLabel || "输入项");
  const hasLimit = definition.hasLimit !== false;
  const supportsPolling = definition.supportsPolling !== false;
  const activeSessions = new Map();

  const normalizeParameters = (input) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("parameters 必须是一个对象。");
    }
    if (!Array.isArray(input[inputKey])) {
      throw new Error(`${inputKey} 必须是字符串数组。`);
    }

    const inputs = uniqueStrings(input[inputKey]);
    if (!inputs.length) throw new Error(`请至少提供一个${inputLabel}。`);
    for (const value of inputs) {
      if (typeof definition.validateInput === "function" && !definition.validateInput(value)) {
        throw new Error(`${inputLabel}格式不正确：${value}`);
      }
    }

    if (input.polling !== undefined && typeof input.polling !== "boolean") {
      throw new Error("polling 必须是布尔值 true 或 false。");
    }
    if (input.forceUpdateData !== undefined && typeof input.forceUpdateData !== "boolean") {
      throw new Error("forceUpdateData 必须是布尔值 true 或 false。");
    }

    const normalized = {
      [inputKey]: inputs,
      concurrency: normalizeTaskConcurrency(input.concurrency ?? DEFAULT_TASK_CONCURRENCY),
      ...normalizeIntervalRange(input),
      forceUpdateData: normalizeForceUpdateData(input.forceUpdateData),
      polling: supportsPolling ? Boolean(input.polling) : false,
      pollingMinutes: supportsPolling
        ? asInteger(input.pollingMinutes, 10, 1, 1440)
        : 0
    };
    if (hasLimit) {
      normalized.limit = asInteger(input.limit, Number(definition.defaultLimit) || 20, 1, 100);
    }
    if (typeof definition.normalizeExtraParameters === "function") {
      Object.assign(normalized, definition.normalizeExtraParameters(input, normalized));
    }
    return normalized;
  };

  const getRowKey = (row) => {
    const value = typeof definition.getRowKey === "function"
      ? definition.getRowKey(row)
      : row?.id;
    return String(value ?? "").trim();
  };
  const mergeRow = typeof definition.mergeRow === "function"
    ? definition.mergeRow
    : (previous, row) => ({ ...previous, ...row });

  const run = async (rawParameters, context = {}) => {
    const parameters = normalizeParameters(rawParameters);
    const taskId = String(context.taskId || "").trim() || createTaskId(featureId);
    if (activeSessions.has(taskId)) throw new Error(`任务已经在运行：${taskId}`);

    const session = {
      taskId,
      stopped: false,
      activeItemRunIds: new Set()
    };
    activeSessions.set(taskId, session);
    const startedAtMs = Date.now();
    const items = [];
    const rowsByKey = new Map();
    const rowsWithoutKey = [];
    let resultCount = 0;
    let failedCount = 0;
    let completedCount = 0;
    let round = 0;
    const timeoutSeconds = Number(context.timeoutSeconds)
      || await loadTaskTimeoutSeconds().catch(() => 120);

    const report = (detail) => Promise.resolve(context.reportProgress?.({
      taskId,
      featureId,
      startedAt: new Date(startedAtMs).toISOString(),
      ...detail
    })).catch(() => {});

    try {
      do {
        round += 1;
        await report({ phase: "round_started", round, total: parameters[inputKey].length });
        await runConcurrentTasks(parameters[inputKey], {
          concurrency: parameters.concurrency,
          shouldStop: () => session.stopped || context.signal?.aborted,
          worker: async (inputValue, index) => {
            if (index >= parameters.concurrency) {
              const intervalMs = randomInterval(parameters);
              await report({
                phase: "waiting_interval",
                round,
                index,
                input: inputValue,
                intervalMs
              });
              const waited = await waitInterruptibly(intervalMs, session, context.signal);
              if (!waited) return;
            }
            if (session.stopped || context.signal?.aborted) return;

            const itemStartedAtMs = Date.now();
            const itemRunId = `${taskId}-R${round}-I${index + 1}`;
            session.activeItemRunIds.add(itemRunId);
            await report({
              phase: "item_started",
              round,
              index,
              input: inputValue,
              runId: itemRunId,
              itemStartedAt: new Date(itemStartedAtMs).toISOString(),
              active: session.activeItemRunIds.size
            });
            try {
              const response = await runWithTaskTimeout(() => definition.executeItem({
                input: inputValue,
                index,
                round,
                runId: itemRunId,
                taskId,
                parameters,
                context
              }), {
                timeoutSeconds,
                onTimeout: () => definition.stopItem({ runId: itemRunId }).catch(() => null)
              });
              throwIfStopped(session, context.signal);
              if (!response?.ok) throw new Error(response?.error || `${inputLabel}采集失败。`);

              const rows = typeof definition.toRows === "function"
                ? definition.toRows(response.data, inputValue, { taskId, itemRunId, round, index })
                : [];
              const normalizedRows = Array.isArray(rows) ? rows.filter(Boolean) : [];
              const rowKeys = [];
              let unkeyedResultCount = 0;
              for (const row of normalizedRows) {
                const key = getRowKey(row);
                if (key) {
                  rowKeys.push(key);
                  rowsByKey.set(key, { ...rowsByKey.get(key), ...row });
                } else {
                  unkeyedResultCount += 1;
                  rowsWithoutKey.push(row);
                }
              }
              resultCount += normalizedRows.length;
              completedCount += 1;
              const item = {
                runId: itemRunId,
                input: inputValue,
                index,
                round,
                status: normalizedRows.length
                  ? FEATURE_RUNNER_STATUSES.SUCCESS
                  : FEATURE_RUNNER_STATUSES.NO_DATA,
                resultCount: normalizedRows.length,
                rowKeys: Array.from(new Set(rowKeys)),
                unkeyedResultCount,
                startedAt: new Date(itemStartedAtMs).toISOString(),
                finishedAt: new Date().toISOString(),
                durationMs: Date.now() - itemStartedAtMs,
                error: ""
              };
              items.push(item);
              await report({ phase: "item_finished", ...item });
            } catch (error) {
              if (session.stopped || context.signal?.aborted || error?.code === "BROWSER_CORE_CLAW_RUNNER_STOPPED") {
                const item = {
                  runId: itemRunId,
                  input: inputValue,
                  index,
                  round,
                  status: FEATURE_RUNNER_STATUSES.STOPPED,
                  resultCount: 0,
                  rowKeys: [],
                  unkeyedResultCount: 0,
                  startedAt: new Date(itemStartedAtMs).toISOString(),
                  finishedAt: new Date().toISOString(),
                  durationMs: Date.now() - itemStartedAtMs,
                  error: "任务已停止"
                };
                items.push(item);
                await report({ phase: "item_finished", ...item });
                return;
              }
              failedCount += 1;
              const item = {
                runId: itemRunId,
                input: inputValue,
                index,
                round,
                status: FEATURE_RUNNER_STATUSES.FAILED,
                resultCount: 0,
                rowKeys: [],
                unkeyedResultCount: 0,
                startedAt: new Date(itemStartedAtMs).toISOString(),
                finishedAt: new Date().toISOString(),
                durationMs: Date.now() - itemStartedAtMs,
                error: error?.message || String(error)
              };
              items.push(item);
              await report({ phase: "item_finished", ...item });
            } finally {
              session.activeItemRunIds.delete(itemRunId);
            }
          }
        });

        if (session.stopped || context.signal?.aborted || !parameters.polling) break;
        const pollingMs = parameters.pollingMinutes * 60 * 1000;
        await report({
          phase: "waiting_polling",
          round,
          pollingMs,
          nextRunAt: new Date(Date.now() + pollingMs).toISOString()
        });
        const waited = await waitInterruptibly(pollingMs, session, context.signal);
        if (!waited) break;
      } while (!session.stopped && !context.signal?.aborted);

      const data = [...rowsByKey.values(), ...rowsWithoutKey];
      const status = resultStatus({
        stopped: session.stopped || context.signal?.aborted,
        failedCount,
        completedCount,
        resultCount: data.length
      });
      const result = {
        ok: status !== FEATURE_RUNNER_STATUSES.FAILED,
        taskId,
        featureId,
        status,
        parameters,
        rounds: round,
        inputCount: parameters[inputKey].length,
        completedCount,
        failedCount,
        resultCount,
        uniqueResultCount: data.length,
        startedAt: new Date(startedAtMs).toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAtMs,
        items,
        data
      };
      await report({ phase: "task_finished", ...result, data: undefined, items: undefined });
      return result;
    } finally {
      activeSessions.delete(taskId);
    }
  };

  const stop = async (taskId) => {
    const normalizedTaskId = String(taskId || "").trim();
    const session = activeSessions.get(normalizedTaskId);
    if (!session) return { ok: true, stopped: false, taskId: normalizedTaskId };
    session.stopped = true;
    await Promise.all([...session.activeItemRunIds].map((runId) => (
      definition.stopItem({ runId }).catch(() => null)
    )));
    return { ok: true, stopped: true, taskId: normalizedTaskId };
  };

  return Object.freeze({
    featureId,
    name: String(definition.name || featureId),
    storageKey: String(definition.storageKey || ""),
    inputKey,
    supportsPolling,
    normalizeParameters,
    validate: normalizeParameters,
    getRowKey,
    mergeRow,
    run,
    stop,
    isRunning(taskId) {
      return activeSessions.has(String(taskId || "").trim());
    }
  });
}

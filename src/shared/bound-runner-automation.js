import {
  DEFAULT_EXECUTION_INTERVAL_MAX_MS,
  DEFAULT_EXECUTION_INTERVAL_MIN_MS
} from "./execution-interval.js";
import { normalizeRunnerBindingConfiguration } from "./runner-capability-schema.js";

const AUTO_RUNNER_CONNECTIONS = Object.freeze({
  "xiaohongshu/keyword-search": Object.freeze({
    "xiaohongshu/post-detail": Object.freeze({
      inputKey: "postUrls",
      inputLabel: "小红书正文链接",
      getInputs: (rows) => rows
        .map((row) => String(row?.url || row?.postUrl || "").trim())
        .filter((url) => /^https?:\/\/(?:www\.)?xiaohongshu\.com\//i.test(url))
    })
  })
});

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean))];
}

export function normalizeAutoRunBoundRunners(value) {
  return value === true;
}

export function normalizeBoundRunnerTargets(value) {
  const values = Array.isArray(value) ? value : [];
  const known = new Set();
  return values.reduce((targets, value) => {
    const id = String(value?.id || value?.featureId || "").trim();
    if (!/^[-a-z0-9]+\/[-a-z0-9]+$/i.test(id) || known.has(id)) return targets;
    known.add(id);
    targets.push({
      id,
      name: String(value?.name || id).trim() || id,
      description: String(value?.description || "").trim(),
      configuration: value?.configuration && typeof value.configuration === "object"
        ? normalizeRunnerBindingConfiguration(id, value.configuration)
        : null
    });
    return targets;
  }, []);
}

export function getAutoRunnableBoundRunnerTargets(sourceFeatureId, targets) {
  const sourceId = String(sourceFeatureId || "").trim();
  const connections = AUTO_RUNNER_CONNECTIONS[sourceId] || {};
  return normalizeBoundRunnerTargets(targets).map((target) => ({
    ...target,
    autoRunnable: Boolean(connections[target.id]),
    inputLabel: connections[target.id]?.inputLabel || ""
  }));
}

/**
 * 将来源功能本轮产生的行数据转换为后台 Runner 请求。
 * 映射未定义或没有可用输入时不会创建任务，避免把历史数据或不兼容字段误传给目标功能。
 */
export function buildAutomaticBoundRunnerRequests(options = {}) {
  const sourceFeatureId = String(options.sourceFeatureId || "").trim();
  const connections = AUTO_RUNNER_CONNECTIONS[sourceFeatureId] || {};
  const rows = Array.isArray(options.rows) ? options.rows : [];
  const forceUpdateData = Boolean(options.forceUpdateData);

  return getAutoRunnableBoundRunnerTargets(sourceFeatureId, options.targets)
    .flatMap((target) => {
      const connection = connections[target.id];
      if (!connection) return [];
      const inputs = uniqueStrings(connection.getInputs(rows));
      if (!inputs.length) return [];
      const configuredParameters = target.configuration?.parameters || {};
      return [{
        featureId: target.id,
        target,
        parameters: {
          ...configuredParameters,
          [connection.inputKey]: inputs,
          concurrency: configuredParameters.concurrency ?? 1,
          intervalMinMs: configuredParameters.intervalMinMs ?? DEFAULT_EXECUTION_INTERVAL_MIN_MS,
          intervalMaxMs: configuredParameters.intervalMaxMs ?? DEFAULT_EXECUTION_INTERVAL_MAX_MS,
          forceUpdateData: target.configuration
            ? configuredParameters.forceUpdateData === true
            : forceUpdateData,
          polling: false
        },
        execution: {
          persistData: true,
          sourceFeatureId,
          outputFields: target.configuration?.outputFields || []
        }
      }];
    });
}

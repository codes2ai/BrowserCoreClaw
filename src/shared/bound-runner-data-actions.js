import { MESSAGE_EXECUTE_FEATURE_RUNNER } from "../background/runner-messages.js";
import {
  getRunnerCapabilitySchema,
  normalizeRunnerBindingConfiguration
} from "./runner-capability-schema.js";
import {
  getBoundRunnerSourceFields,
  getValidBoundRunnerRowInputs,
  normalizeBoundRunnerTargets
} from "./bound-runner-automation.js";

function isExtensionRuntime() {
  return Boolean(globalThis.chrome?.runtime?.id && chrome.runtime?.sendMessage);
}

function callChrome(callbackApi) {
  return new Promise((resolve, reject) => callbackApi((result) => {
    const error = chrome.runtime.lastError;
    if (error) reject(new Error(error.message));
    else resolve(result);
  }));
}

function sendMessage(message) {
  if (!isExtensionRuntime()) {
    return Promise.reject(new Error("Runner 只能在已加载扩展的 Chrome 控制台中运行。"));
  }
  return callChrome((done) => chrome.runtime.sendMessage(message, done));
}

function createManualTaskId(sourceFeatureId, targetFeatureId) {
  const source = String(sourceFeatureId || "").replace(/[^a-z0-9]+/gi, "-").toUpperCase();
  const target = String(targetFeatureId || "").replace(/[^a-z0-9]+/gi, "-").toUpperCase();
  return `MANUAL-${source}-${target}-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}

export function buildBoundRunnerDataRequest({ sourceFeatureId, target, row }) {
  const targetId = String(target?.id || "").trim();
  const schema = getRunnerCapabilitySchema(targetId);
  const configuration = normalizeRunnerBindingConfiguration(targetId, target?.configuration);
  const sourceFields = getBoundRunnerSourceFields(sourceFeatureId, target);
  const inputs = getValidBoundRunnerRowInputs(sourceFeatureId, target, row, sourceFields);
  const inputKeys = configuration.inputFields.length ? configuration.inputFields : [schema.inputKey];

  if (!sourceFields.length) {
    throw new Error("未配置可传递的来源字段，请在“设置 / 运行器”中重新选择输出字段。");
  }
  if (!inputs.length) {
    throw new Error("当前数据行没有符合目标 Runner 格式要求的输入值。");
  }
  if (!inputKeys.every((key) => key === schema.inputKey)) {
    throw new Error("Runner 输入字段配置无效，请重新保存运行器配置。");
  }

  return {
    schemaVersion: 1,
    taskId: createManualTaskId(sourceFeatureId, targetId),
    featureId: targetId,
    parameters: {
      ...configuration.parameters,
      [schema.inputKey]: inputs,
      polling: false
    },
    execution: {
      persistData: true,
      sourceFeatureId: String(sourceFeatureId || "").trim(),
      outputFields: configuration.outputFields
    }
  };
}

/**
 * 将来源数据表的单行数据按已保存的运行器字段配置转成后台任务。
 * 目标 Runner 仍负责自己的数据与任务记录；onResult 可将完整响应回写来源行。
 */
export function createBoundRunnerDataActions({ sourceFeatureId, targets, onNotice, onResult } = {}) {
  const normalizedSourceId = String(sourceFeatureId || "").trim();
  const normalizedTargets = normalizeBoundRunnerTargets(targets);
  const targetsById = new Map(normalizedTargets.map((target) => [target.id, target]));
  const activeActions = new Set();
  let renderedRows = [];
  const notify = typeof onNotice === "function" ? onNotice : () => {};
  const handleResult = typeof onResult === "function" ? onResult : async () => {};
  const actionKey = (targetId, rowIndex) => `${targetId}:${rowIndex}`;

  const tableColumn = (rows, escapeHtml = (value) => String(value ?? ""), sourceRows = rows) => {
    renderedRows = Array.isArray(sourceRows) ? sourceRows : [];
    if (!normalizedTargets.length) return null;
    return {
      label: "操作",
      className: "bound-runner-action-cell",
      render(row, rowIndex) {
        const sourceRow = renderedRows[rowIndex] || row;
        const actions = normalizedTargets.map((target) => {
          const key = actionKey(target.id, rowIndex);
          const running = activeActions.has(key);
          const available = getValidBoundRunnerRowInputs(
            normalizedSourceId,
            target,
            sourceRow,
            getBoundRunnerSourceFields(normalizedSourceId, target)
          ).length > 0;
          const disabled = running || !available;
          const title = running
            ? `${target.name} 正在运行`
            : available
              ? `将当前行数据交给 ${target.name}`
              : "当前行没有可传递的 Runner 输入";
          return `<button class="bound-runner-action" type="button" data-action="run-bound-runner" data-bound-runner-target="${escapeHtml(target.id)}" data-bound-runner-row-index="${rowIndex}" title="${escapeHtml(title)}" ${disabled ? "disabled" : ""}>${running ? "运行中…" : "运行器"}<small>${escapeHtml(target.name)}</small></button>`;
        }).join("");
        return `<div class="bound-runner-actions">${actions}</div>`;
      }
    };
  };

  const run = async (targetId, rowIndex) => {
    const target = targetsById.get(String(targetId || "").trim());
    const row = renderedRows[Number(rowIndex)];
    if (!target || !row) return null;
    const key = actionKey(target.id, rowIndex);
    if (activeActions.has(key)) return null;
    activeActions.add(key);
    notify({ tone: "info", text: `正在运行 ${target.name}，仅处理当前数据行…` });
    try {
      const request = buildBoundRunnerDataRequest({ sourceFeatureId: normalizedSourceId, target, row });
      const response = await sendMessage({ type: MESSAGE_EXECUTE_FEATURE_RUNNER, options: request });
      if (!response || (response.ok === false && !response.status)) {
        throw new Error(response?.error || `${target.name} 运行失败。`);
      }
      await handleResult({
        sourceFeatureId: normalizedSourceId,
        target,
        row,
        response
      });
      notify({
        tone: response.status === "failed" ? "error" : response.status === "partial" ? "warning" : "success",
        text: `${target.name} 已${response.status === "failed" ? "失败" : "完成"}：结果 ${Number(response.resultCount) || 0} 条，新增 ${Number(response.addedCount) || 0} 条。`
      });
      return response;
    } catch (error) {
      notify({ tone: "error", text: `${target.name} 运行失败：${error.message || String(error)}` });
      return null;
    } finally {
      activeActions.delete(key);
      notify(null);
    }
  };

  return { tableColumn, run, hasTargets: normalizedTargets.length > 0 };
}

import {
  DEFAULT_EXECUTION_INTERVAL_MAX_MS,
  DEFAULT_EXECUTION_INTERVAL_MIN_MS
} from "./execution-interval.js";
import {
  getRunnerCapabilitySchema,
  normalizeRunnerBindingConfiguration
} from "./runner-capability-schema.js";
import { getFeatureRunner } from "../runners/registry.js";

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value ?? "").trim())
    .filter(Boolean))];
}

function flattenRowValue(value) {
  if (Array.isArray(value)) return value.flatMap(flattenRowValue);
  if (value === null || value === undefined || typeof value === "object") return [];
  return [value];
}

function fallbackSourceFields(sourceFeatureId, targetFeatureId) {
  const sourceFields = new Set(
    getRunnerCapabilitySchema(sourceFeatureId).outputFields.map((field) => field.key)
  );
  const inputKey = getRunnerCapabilitySchema(targetFeatureId).inputKey;
  const preferred = inputKey === "keywords"
    ? ["keyword", "title"]
    : inputKey === "profileUrls"
      ? ["profileUrl", "authorUrl"]
      : inputKey === "postUrls"
        ? ["postUrl", "noteUrl", "url"]
        : [];
  return preferred.filter((field) => sourceFields.has(field));
}

export function getBoundRunnerSourceFields(sourceFeatureId, target) {
  const targetId = String(target?.id || target?.featureId || "").trim();
  const configuration = normalizeRunnerBindingConfiguration(targetId, target?.configuration);
  return configuration.sourceOutputFields.length
    ? configuration.sourceOutputFields
    : fallbackSourceFields(sourceFeatureId, targetId);
}

export function getBoundRunnerRowInputs(row, sourceFields) {
  return uniqueStrings((Array.isArray(sourceFields) ? sourceFields : [])
    .flatMap((field) => flattenRowValue(row?.[field])));
}

function isValidTargetInput(targetId, schema, configuredParameters, input) {
  const runner = getFeatureRunner(targetId);
  if (runner?.isValidInput) return runner.isValidInput(input);
  if (!runner?.validate) return true;
  try {
    runner.validate({
      ...configuredParameters,
      [schema.inputKey]: [input],
      polling: false
    });
    return true;
  } catch {
    return false;
  }
}

export function getValidBoundRunnerRowInputs(sourceFeatureId, target, row, sourceFields = null) {
  const targetId = String(target?.id || target?.featureId || "").trim();
  const fields = Array.isArray(sourceFields)
    ? sourceFields
    : getBoundRunnerSourceFields(sourceFeatureId, target);
  const schema = getRunnerCapabilitySchema(targetId);
  const configuration = normalizeRunnerBindingConfiguration(targetId, target?.configuration);
  return getBoundRunnerRowInputs(row, fields).filter((input) => (
    isValidTargetInput(targetId, schema, configuration.parameters, input)
  ));
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
  return normalizeBoundRunnerTargets(targets).map((target) => ({
    ...target,
    autoRunnable: getBoundRunnerSourceFields(sourceFeatureId, target).length > 0,
    inputLabel: getRunnerCapabilitySchema(target.id).inputLabel || "输入项"
  }));
}

/**
 * 将来源功能本轮产生的行数据转换为后台 Runner 请求。
 * 映射未定义或没有可用输入时不会创建任务，避免把历史数据或不兼容字段误传给目标功能。
 */
export function buildAutomaticBoundRunnerRequests(options = {}) {
  const sourceFeatureId = String(options.sourceFeatureId || "").trim();
  const rows = Array.isArray(options.rows) ? options.rows : [];
  const forceUpdateData = Boolean(options.forceUpdateData);

  return getAutoRunnableBoundRunnerTargets(sourceFeatureId, options.targets)
    .flatMap((target) => {
      if (!target.autoRunnable) return [];
      const schema = getRunnerCapabilitySchema(target.id);
      const sourceFields = getBoundRunnerSourceFields(sourceFeatureId, target);
      const configuredParameters = target.configuration?.parameters || {};
      const sourceBindings = rows.map((row, sourceRowIndex) => ({
        sourceRowIndex,
        sourceRowId: String(row?.id || row?.canonical?.id || "").trim(),
        inputs: getValidBoundRunnerRowInputs(sourceFeatureId, target, row, sourceFields)
      })).filter((binding) => binding.inputs.length);
      const inputs = uniqueStrings(sourceBindings.flatMap((binding) => binding.inputs));
      if (!inputs.length) return [];
      return [{
        featureId: target.id,
        target,
        sourceFields,
        sourceBindings,
        parameters: {
          ...configuredParameters,
          [schema.inputKey]: inputs,
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

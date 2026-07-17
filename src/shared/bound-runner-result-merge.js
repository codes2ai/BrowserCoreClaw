import { getFeatureRunner } from "../runners/registry.js";
import { withCanonicalRecord } from "./canonical-data.js";
import {
  getBoundRunnerSourceFields,
  getValidBoundRunnerRowInputs
} from "./bound-runner-automation.js";
import {
  getRunnerCapabilitySchema,
  normalizeRunnerBindingConfiguration
} from "./runner-capability-schema.js";

const PROTECTED_SOURCE_FIELDS = new Set([
  "id",
  "canonical",
  "runnerTaskId",
  "runnerFeatureId",
  "capturedAt",
  "collectedAt"
]);

function text(value) {
  return String(value ?? "").trim();
}

function hasUsableValue(value) {
  if (value === 0 || value === false) return true;
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return true;
  return text(value).length > 0;
}

function cloneResultData(value) {
  if (!value || typeof value !== "object") return value;
  try {
    return typeof structuredClone === "function"
      ? structuredClone(value)
      : JSON.parse(JSON.stringify(value));
  } catch {
    return Array.isArray(value) ? [...value] : { ...value };
  }
}

function inputResultMap(response) {
  const map = new Map();
  for (const result of Array.isArray(response?.inputResults) ? response.inputResults : []) {
    const input = text(result?.input);
    if (!input) continue;
    const current = map.get(input) || [];
    current.push({
      input,
      status: text(result?.status) || text(response?.status),
      error: text(result?.error),
      data: (Array.isArray(result?.data) ? result.data : []).map(cloneResultData)
    });
    map.set(input, current);
  }
  return map;
}

function mergeFlatRunnerFields(sourceRow, targetId, target, targetRow) {
  if (!targetRow || typeof targetRow !== "object") return { ...sourceRow };
  const configuration = normalizeRunnerBindingConfiguration(targetId, target?.configuration);
  const selectedFields = configuration.outputFields.length
    ? configuration.outputFields
    : getRunnerCapabilitySchema(targetId).outputFields.map((field) => field.key);
  const targetRunner = getFeatureRunner(targetId);
  const mergedTarget = typeof targetRunner?.mergeRow === "function"
    ? targetRunner.mergeRow(sourceRow, targetRow)
    : { ...sourceRow, ...targetRow };
  const mergedSource = { ...sourceRow };

  for (const field of selectedFields) {
    if (PROTECTED_SOURCE_FIELDS.has(field)) continue;
    const value = mergedTarget?.[field];
    if (hasUsableValue(value)) mergedSource[field] = value;
  }
  return mergedSource;
}

/**
 * 将 Runner 的按输入完整结果回写到来源功能数据行。
 * 单结果会按目标 Runner 的输出字段平铺更新；完整结果始终保存在
 * canonical.platformExtra.runnerOutputs[targetFeatureId] 中。
 */
export function mergeBoundRunnerResultsIntoSourceRows({
  sourceFeatureId,
  target,
  rows,
  response
} = {}) {
  const sourceRows = Array.isArray(rows) ? rows : [];
  const targetId = text(target?.id || target?.featureId || response?.featureId);
  const sourceFields = getBoundRunnerSourceFields(sourceFeatureId, target);
  const resultsByInput = inputResultMap(response);
  if (!targetId || !sourceFields.length || !resultsByInput.size) {
    return { rows: sourceRows, updatedCount: 0 };
  }

  let updatedCount = 0;
  const nextRows = sourceRows.map((row) => {
    const inputs = getValidBoundRunnerRowInputs(sourceFeatureId, target, row, sourceFields);
    const matchedResults = inputs.flatMap((input) => resultsByInput.get(input) || []);
    if (!matchedResults.length) return row;

    const fullData = matchedResults.flatMap((result) => result.data);
    const flatRow = fullData.length === 1
      ? mergeFlatRunnerFields(row, targetId, target, fullData[0])
      : { ...row };
    const rebuilt = withCanonicalRecord(sourceFeatureId, flatRow);
    const previousOutputs = row?.canonical?.platformExtra?.runnerOutputs;
    const runnerOutputs = previousOutputs && typeof previousOutputs === "object" && !Array.isArray(previousOutputs)
      ? { ...previousOutputs }
      : {};
    const configuration = normalizeRunnerBindingConfiguration(targetId, target?.configuration);
    const matchedStatuses = [...new Set(matchedResults.map((result) => result.status).filter(Boolean))];
    runnerOutputs[targetId] = {
      schemaVersion: 1,
      taskId: text(response?.taskId),
      featureId: targetId,
      status: matchedStatuses.length === 1 ? matchedStatuses[0] : text(response?.status),
      inputs,
      completedAt: text(response?.finishedAt) || new Date().toISOString(),
      selectedFields: [...configuration.outputFields],
      data: fullData,
      errors: matchedResults.map((result) => result.error).filter(Boolean)
    };
    updatedCount += 1;
    return {
      ...rebuilt,
      canonical: {
        ...rebuilt.canonical,
        platformExtra: {
          ...rebuilt.canonical.platformExtra,
          runnerOutputs
        }
      }
    };
  });

  return { rows: nextRows, updatedCount };
}

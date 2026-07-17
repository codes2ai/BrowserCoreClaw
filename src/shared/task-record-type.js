export const TASK_EXECUTION_TYPE_MANUAL = "manual";
export const TASK_EXECUTION_TYPE_RUNNER = "runner";

export function normalizeTaskExecutionType(value) {
  const candidate = typeof value === "object" && value !== null
    ? value.executionType
    : value;
  return candidate === TASK_EXECUTION_TYPE_RUNNER
    ? TASK_EXECUTION_TYPE_RUNNER
    : TASK_EXECUTION_TYPE_MANUAL;
}

export function getTaskExecutionTypeLabel(value) {
  return normalizeTaskExecutionType(value) === TASK_EXECUTION_TYPE_RUNNER
    ? "运行器"
    : "普通运行";
}

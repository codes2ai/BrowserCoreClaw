import { loadGlobalSettings } from "./global-settings.js";

export const DEFAULT_DATA_STORAGE_LIMIT = 3000;
export const DEFAULT_TASK_RECORDS_PER_STATUS_LIMIT = 200;

function asLimit(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function applyItemLimit(items, limit) {
  const values = Array.isArray(items) ? items : [];
  const normalizedLimit = asLimit(limit, DEFAULT_DATA_STORAGE_LIMIT);
  return normalizedLimit === 0 ? values.slice() : values.slice(0, normalizedLimit);
}

export function limitItemsPerGroup(items, groupKey, limit) {
  const values = Array.isArray(items) ? items : [];
  const normalizedLimit = asLimit(limit, DEFAULT_TASK_RECORDS_PER_STATUS_LIMIT);
  if (normalizedLimit === 0) return values.slice();

  const counts = new Map();
  return values.filter((item) => {
    const key = groupKey(item);
    const count = counts.get(key) || 0;
    if (count >= normalizedLimit) return false;
    counts.set(key, count + 1);
    return true;
  });
}

export function formatLimitValue(limit) {
  const normalizedLimit = asLimit(limit, 0);
  return normalizedLimit === 0 ? "无限" : `${normalizedLimit} 条`;
}

export async function loadGlobalStorageLimits() {
  const settings = await loadGlobalSettings();
  return {
    dataStorageLimit: asLimit(settings?.limits?.dataStorageLimit, DEFAULT_DATA_STORAGE_LIMIT),
    taskRecordsPerStatusLimit: asLimit(
      settings?.limits?.taskRecordsPerStatusLimit,
      DEFAULT_TASK_RECORDS_PER_STATUS_LIMIT
    )
  };
}

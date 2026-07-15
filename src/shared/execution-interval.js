export const DEFAULT_EXECUTION_INTERVAL_MIN_MS = 1000;
export const DEFAULT_EXECUTION_INTERVAL_MAX_MS = 6000;

export function migrateLegacyExecutionInterval(config, options = {}) {
  if (!config || typeof config !== "object" || Array.isArray(config)) return config;
  const minKey = options.minKey || "intervalMinMs";
  const maxKey = options.maxKey || "intervalMaxMs";
  const legacyMinMs = Number(options.legacyMinMs);
  const legacyMaxMs = Number(options.legacyMaxMs);
  if (
    Number(config[minKey]) !== legacyMinMs
    || Number(config[maxKey]) !== legacyMaxMs
  ) {
    return config;
  }
  return {
    ...config,
    [minKey]: DEFAULT_EXECUTION_INTERVAL_MIN_MS,
    [maxKey]: DEFAULT_EXECUTION_INTERVAL_MAX_MS
  };
}

import { normalizeRunnerBindingConfiguration } from "./runner-capability-schema.js";

export const GLOBAL_SETTINGS_STORAGE_KEY = "browserCoreClawGlobalSettingsV1";
export const GLOBAL_SETTINGS_CHANGED_EVENT = "browser-core-claw-global-settings-changed";

export const DEFAULT_GLOBAL_SETTINGS = Object.freeze({
  interface: Object.freeze({
    appName: "BrowserCoreClaw",
    logoDataUrl: ""
  }),
  limits: Object.freeze({
    taskTimeoutSeconds: 120,
    dataStorageLimit: 3000,
    taskRecordsPerStatusLimit: 200
  }),
  storage: Object.freeze({
    type: "local"
  }),
  runners: Object.freeze({
    // 来源功能 ID -> 可被其调用的目标 Runner 功能 ID 列表。
    callableByFeature: Object.freeze({
      "xiaohongshu/keyword-search": Object.freeze(["xiaohongshu/post-detail"])
    }),
    // 来源功能 ID -> 目标 Runner 功能 ID -> 字段与调用参数。
    configurationByBinding: Object.freeze({})
  })
});

function cloneDefaultRunnerBindings() {
  return Object.fromEntries(Object.entries(DEFAULT_GLOBAL_SETTINGS.runners.callableByFeature)
    .map(([sourceFeatureId, targetFeatureIds]) => [sourceFeatureId, [...targetFeatureIds]]));
}

function cloneDefaults() {
  return {
    interface: { ...DEFAULT_GLOBAL_SETTINGS.interface },
    limits: { ...DEFAULT_GLOBAL_SETTINGS.limits },
    storage: { ...DEFAULT_GLOBAL_SETTINGS.storage },
    runners: {
      callableByFeature: cloneDefaultRunnerBindings(),
      configurationByBinding: {}
    }
  };
}

function isExtensionStorageAvailable() {
  return Boolean(globalThis.chrome?.runtime?.id && chrome.storage?.local);
}

function callChrome(callbackApi) {
  return new Promise((resolve, reject) => {
    callbackApi((result) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result);
    });
  });
}

function asInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function normalizeFeatureId(value) {
  const id = String(value || "").trim();
  return /^[-a-z0-9]+\/[-a-z0-9]+$/i.test(id) ? id : "";
}

function normalizeRunnerBindings(value) {
  const rawBindings = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
  const callableByFeature = {};

  for (const [rawSourceId, rawTargetIds] of Object.entries(rawBindings)) {
    const sourceId = normalizeFeatureId(rawSourceId);
    if (!sourceId || !Array.isArray(rawTargetIds)) continue;
    const targets = [...new Set(rawTargetIds
      .map(normalizeFeatureId)
      .filter((targetId) => targetId && targetId !== sourceId))];
    if (targets.length) callableByFeature[sourceId] = targets;
  }
  return callableByFeature;
}

function normalizeRunnerBindingConfigurations(value) {
  const rawConfigurations = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
  const configurationByBinding = {};

  for (const [rawSourceId, rawTargets] of Object.entries(rawConfigurations)) {
    const sourceId = normalizeFeatureId(rawSourceId);
    if (!sourceId || !rawTargets || typeof rawTargets !== "object" || Array.isArray(rawTargets)) continue;
    const targets = {};
    for (const [rawTargetId, rawConfiguration] of Object.entries(rawTargets)) {
      const targetId = normalizeFeatureId(rawTargetId);
      if (!targetId || targetId === sourceId || !rawConfiguration || typeof rawConfiguration !== "object") continue;
      targets[targetId] = normalizeRunnerBindingConfiguration(targetId, rawConfiguration);
    }
    if (Object.keys(targets).length) configurationByBinding[sourceId] = targets;
  }
  return configurationByBinding;
}

export function normalizeGlobalSettings(value = {}) {
  const defaults = cloneDefaults();
  const appName = String(value?.interface?.appName || "").trim().slice(0, 40);
  const logoDataUrl = String(value?.interface?.logoDataUrl || "").trim();
  return {
    interface: {
      appName: appName || defaults.interface.appName,
      logoDataUrl: /^data:image\/(?:png|jpeg|webp|gif);base64,/i.test(logoDataUrl) ? logoDataUrl : ""
    },
    limits: {
      taskTimeoutSeconds: asInteger(
        value?.limits?.taskTimeoutSeconds,
        defaults.limits.taskTimeoutSeconds,
        10,
        86400
      ),
      dataStorageLimit: asInteger(
        value?.limits?.dataStorageLimit,
        defaults.limits.dataStorageLimit,
        0,
        10000000
      ),
      taskRecordsPerStatusLimit: asInteger(
        value?.limits?.taskRecordsPerStatusLimit,
        defaults.limits.taskRecordsPerStatusLimit,
        0,
        1000000
      )
    },
    storage: {
      type: value?.storage?.type === "local" ? "local" : defaults.storage.type
    },
    runners: {
      // 旧版本不存在此字段时补齐默认链路；用户明确保存空对象后仍可清空全部映射。
      callableByFeature: value?.runners?.callableByFeature === undefined
        ? cloneDefaultRunnerBindings()
        : normalizeRunnerBindings(value.runners.callableByFeature),
      configurationByBinding: normalizeRunnerBindingConfigurations(
        value?.runners?.configurationByBinding
      )
    }
  };
}

/**
 * 返回某个来源功能允许调用的 Runner 功能标识。该配置只定义调用权限与链路，
 * 不会自行创建或自动执行任务。
 */
export function getCallableRunnerFeatureIds(settings, sourceFeatureId) {
  const sourceId = normalizeFeatureId(sourceFeatureId);
  if (!sourceId) return [];
  return [...(normalizeGlobalSettings(settings).runners.callableByFeature[sourceId] || [])];
}

export function isRunnerCallableByFeature(settings, sourceFeatureId, targetFeatureId) {
  const targetId = normalizeFeatureId(targetFeatureId);
  return Boolean(targetId && getCallableRunnerFeatureIds(settings, sourceFeatureId).includes(targetId));
}

export function getRunnerBindingConfiguration(settings, sourceFeatureId, targetFeatureId) {
  const sourceId = normalizeFeatureId(sourceFeatureId);
  const targetId = normalizeFeatureId(targetFeatureId);
  const normalized = normalizeGlobalSettings(settings);
  return normalizeRunnerBindingConfiguration(
    targetId,
    normalized.runners.configurationByBinding?.[sourceId]?.[targetId]
  );
}

export function getDefaultGlobalSettings() {
  return cloneDefaults();
}

export async function loadGlobalSettings() {
  if (isExtensionStorageAvailable()) {
    const values = await callChrome((done) => chrome.storage.local.get(GLOBAL_SETTINGS_STORAGE_KEY, done));
    return normalizeGlobalSettings(values?.[GLOBAL_SETTINGS_STORAGE_KEY]);
  }

  try {
    return normalizeGlobalSettings(JSON.parse(globalThis.localStorage?.getItem(GLOBAL_SETTINGS_STORAGE_KEY) || "null"));
  } catch {
    return cloneDefaults();
  }
}

export async function saveGlobalSettings(value) {
  const settings = normalizeGlobalSettings(value);
  if (isExtensionStorageAvailable()) {
    await callChrome((done) => chrome.storage.local.set({
      [GLOBAL_SETTINGS_STORAGE_KEY]: settings
    }, done));
  } else {
    globalThis.localStorage?.setItem(GLOBAL_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  }

  globalThis.dispatchEvent?.(new CustomEvent(GLOBAL_SETTINGS_CHANGED_EVENT, {
    detail: { settings }
  }));
  return settings;
}

export async function resetGlobalSettings() {
  return saveGlobalSettings(cloneDefaults());
}

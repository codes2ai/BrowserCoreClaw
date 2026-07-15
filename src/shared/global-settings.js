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
  })
});

function cloneDefaults() {
  return {
    interface: { ...DEFAULT_GLOBAL_SETTINGS.interface },
    limits: { ...DEFAULT_GLOBAL_SETTINGS.limits },
    storage: { ...DEFAULT_GLOBAL_SETTINGS.storage }
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
    }
  };
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

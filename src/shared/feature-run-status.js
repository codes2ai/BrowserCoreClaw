export const FEATURE_RUN_STATUS_EVENT = "browser-core-claw-feature-run-status-changed";

const STORAGE_PREFIX = "browserCoreClawFeatureRunning:";

function isExtensionStorageAvailable() {
  return Boolean(globalThis.chrome?.runtime?.id && chrome.storage?.local);
}

function storageKey(featureKey) {
  return `${STORAGE_PREFIX}${featureKey}`;
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

export function buildFeatureKey(groupId, featureId) {
  return `${String(groupId || "").trim()}/${String(featureId || "").trim()}`;
}

export async function loadRunningFeatureKeys(featureKeys = []) {
  if (!isExtensionStorageAvailable()) return new Set();
  const keys = featureKeys.map(storageKey);
  const values = await callChrome((done) => chrome.storage.local.get(keys, done));
  return new Set(featureKeys.filter((featureKey) => values?.[storageKey(featureKey)]?.running === true));
}

export async function clearRunningFeatureKeys(featureKeys = []) {
  if (!isExtensionStorageAvailable() || !featureKeys.length) return;
  await callChrome((done) => chrome.storage.local.remove(featureKeys.map(storageKey), done)).catch(() => {});
}

export async function setFeatureRunning(featureKey, running) {
  const normalizedKey = String(featureKey || "").trim();
  if (!normalizedKey) return;

  if (isExtensionStorageAvailable()) {
    const key = storageKey(normalizedKey);
    if (running) {
      await callChrome((done) => chrome.storage.local.set({
        [key]: { running: true, updatedAt: new Date().toISOString() }
      }, done)).catch(() => {});
    } else {
      await callChrome((done) => chrome.storage.local.remove(key, done)).catch(() => {});
    }
  }

  globalThis.dispatchEvent?.(new CustomEvent(FEATURE_RUN_STATUS_EVENT, {
    detail: { featureKey: normalizedKey, running: Boolean(running) }
  }));
}

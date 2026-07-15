import { loadGlobalSettings } from "./global-settings.js";

export const TASK_TIMEOUT_ERROR_CODE = "BROWSER_CORE_CLAW_TASK_TIMEOUT";

export async function loadTaskTimeoutSeconds() {
  const settings = await loadGlobalSettings().catch(() => null);
  return Number(settings?.limits?.taskTimeoutSeconds) || 120;
}

export function createTaskTimeoutError(timeoutSeconds) {
  const error = new Error(`任务运行超过 ${timeoutSeconds} 秒，已自动停止并记为失败。`);
  error.code = TASK_TIMEOUT_ERROR_CODE;
  error.timeoutSeconds = timeoutSeconds;
  return error;
}

export function runWithTaskTimeout(task, options = {}) {
  const timeoutSeconds = Math.max(0.001, Number(options.timeoutSeconds) || 120);
  const timeoutMilliseconds = Math.max(1, Math.round(timeoutSeconds * 1000));
  const taskPromise = Promise.resolve().then(() => (
    typeof task === "function" ? task() : task
  ));

  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      Promise.resolve()
        .then(() => options.onTimeout?.())
        .catch(() => {});
      reject(createTaskTimeoutError(timeoutSeconds));
    }, timeoutMilliseconds);
  });

  return Promise.race([taskPromise, timeoutPromise]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

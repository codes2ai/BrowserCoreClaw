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
  const isPaused = typeof options.isPaused === "function" ? options.isPaused : () => false;
  const taskPromise = Promise.resolve().then(() => (
    typeof task === "function" ? task() : task
  ));

  let timer = null;
  let elapsedMilliseconds = 0;
  let lastCheckedAt = Date.now();
  const timeoutPromise = new Promise((_, reject) => {
    const checkTimeout = () => {
      const now = Date.now();
      if (!isPaused()) {
        elapsedMilliseconds += now - lastCheckedAt;
      }
      lastCheckedAt = now;
      if (elapsedMilliseconds >= timeoutMilliseconds) {
        Promise.resolve()
          .then(() => options.onTimeout?.())
          .catch(() => {});
        reject(createTaskTimeoutError(timeoutSeconds));
        return;
      }
      const remainingMilliseconds = timeoutMilliseconds - elapsedMilliseconds;
      timer = setTimeout(checkTimeout, Math.min(250, Math.max(1, remainingMilliseconds)));
    };
    timer = setTimeout(checkTimeout, Math.min(250, timeoutMilliseconds));
  });

  return Promise.race([taskPromise, timeoutPromise]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

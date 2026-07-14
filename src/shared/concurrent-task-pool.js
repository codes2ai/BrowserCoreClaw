// 默认按顺序执行；用户可在需要时将同一功能的并发数提高到 3。
export const DEFAULT_TASK_CONCURRENCY = 1;
export const MAX_TASK_CONCURRENCY = 3;

export function normalizeTaskConcurrency(value, fallback = DEFAULT_TASK_CONCURRENCY) {
  const parsed = Number.parseInt(value, 10);
  const candidate = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(MAX_TASK_CONCURRENCY, Math.max(1, candidate));
}

/**
 * 在不超过指定并发数的前提下执行一组独立任务。
 * 调用方负责在 worker 内处理单项任务错误，避免一个失败中断同批其他任务。
 */
export async function runConcurrentTasks(items, options = {}) {
  const tasks = Array.isArray(items) ? items : [];
  const concurrency = normalizeTaskConcurrency(options.concurrency);
  const shouldStop = typeof options.shouldStop === "function" ? options.shouldStop : () => false;
  const worker = typeof options.worker === "function" ? options.worker : async () => {};
  let cursor = 0;

  const claimNext = () => {
    if (shouldStop() || cursor >= tasks.length) return null;
    const index = cursor;
    cursor += 1;
    return { item: tasks[index], index };
  };

  const runWorker = async () => {
    while (!shouldStop()) {
      const task = claimNext();
      if (!task) return;
      await worker(task.item, task.index);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, runWorker));
}

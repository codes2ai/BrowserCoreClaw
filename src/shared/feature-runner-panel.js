import {
  MESSAGE_EXECUTE_FEATURE_RUNNER,
  MESSAGE_FEATURE_RUNNER_TASK_STATUS,
  MESSAGE_STOP_FEATURE_RUNNER,
  MESSAGE_VALIDATE_FEATURE_RUNNER
} from "../background/runner-messages.js";

const panelStates = new Map();

function isExtensionRuntime() {
  return Boolean(globalThis.chrome?.runtime?.id && chrome.runtime?.sendMessage);
}

function callChrome(callbackApi) {
  return new Promise((resolve, reject) => callbackApi((result) => {
    const error = chrome.runtime.lastError;
    if (error) reject(new Error(error.message));
    else resolve(result);
  }));
}

function sendMessage(message) {
  if (!isExtensionRuntime()) {
    return Promise.reject(new Error("Runner 只能在已加载扩展的 Chrome 控制台中运行。"));
  }
  return callChrome((done) => chrome.runtime.sendMessage(message, done));
}

function createTaskId(featureId) {
  const prefix = featureId.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toUpperCase();
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}

function statusLabel(status) {
  return ({
    pending: "等待执行",
    running: "运行中",
    stopping: "停止中",
    success: "完成",
    partial: "部分完成",
    no_data: "无数据",
    failed: "失败",
    stopped: "已停止"
  })[status] || status || "未运行";
}

function statusTone(status) {
  if (["success", "no_data"].includes(status)) return "success";
  if (["failed"].includes(status)) return "error";
  if (["partial", "stopping", "stopped"].includes(status)) return "warning";
  return "info";
}

function buildConfig(featureId, parameters) {
  return {
    schemaVersion: 1,
    featureId,
    parameters,
    execution: {
      persistData: true,
      sourceFeatureId: ""
    }
  };
}

function parsePanelConfig(panel) {
  let config;
  try {
    config = JSON.parse(panel.draft);
  } catch (error) {
    throw new Error(`Runner JSON 解析失败：${error.message}`);
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Runner JSON 顶层必须是一个对象。");
  }
  if (String(config.featureId || "").trim() !== panel.featureId) {
    throw new Error(`当前页面只能执行 ${panel.featureId}。`);
  }
  return config;
}

export function getFeatureRunnerPanelState(featureId) {
  const normalizedId = String(featureId || "").trim();
  if (!panelStates.has(normalizedId)) {
    panelStates.set(normalizedId, {
      featureId: normalizedId,
      draft: "",
      running: false,
      taskId: "",
      task: null,
      notice: {
        tone: "info",
        text: "载入当前表单参数后，可以校验并手动创建后台 Runner 任务。"
      }
    });
  }
  return panelStates.get(normalizedId);
}

export function syncFeatureRunnerDraft(panel, parameters, options = {}) {
  if (!panel || (panel.draft && !options.force)) return;
  panel.draft = JSON.stringify(buildConfig(panel.featureId, parameters), null, 2);
  panel.notice = {
    tone: "success",
    text: options.message || "已载入当前表单参数。"
  };
}

export function updateFeatureRunnerDraft(panel, value) {
  panel.draft = String(value ?? "");
  panel.notice = { tone: "info", text: "Runner 配置已修改，执行前请先校验。" };
}

export function renderFeatureRunnerModeButton(panel, options = {}) {
  const className = String(options.className || "");
  const primaryClass = String(options.primaryClass || "xhs-primary-button");
  const stopClass = String(options.stopClass || "xhs-stop-button");
  const disabled = Boolean(options.disabled);
  if (panel?.running) {
    return `<button class="${stopClass} ${className}" type="button" data-action="runner-stop">停止 Runner</button>`;
  }
  return `<button class="${primaryClass} ${className}" type="button" data-action="runner-execute" ${disabled ? "disabled" : ""}>创建任务</button>`;
}

function progressText(task) {
  const progress = task?.progress || {};
  if (progress.phase === "waiting_interval") return `等待随机间隔 ${progress.intervalMs || 0} ms`;
  if (progress.phase === "waiting_polling") return `等待下一轮：${progress.nextRunAt || "-"}`;
  if (progress.phase === "item_started") return `正在处理第 ${Number(progress.index) + 1} 个输入项`;
  if (progress.phase === "item_finished") return `已完成第 ${Number(progress.index) + 1} 个输入项`;
  if (progress.phase === "round_started") return `正在执行第 ${progress.round || 1} 轮`;
  if (progress.phase === "task_finished") return "任务执行结束";
  return task?.status === "running" ? "正在准备 Runner 任务" : "-";
}

export function renderFeatureRunnerPanel(panel, options = {}) {
  const escapeHtml = typeof options.escapeHtml === "function" ? options.escapeHtml : (value) => String(value ?? "");
  const disabled = Boolean(options.disabled) || panel.running;
  const task = panel.task;
  const status = task?.status || (panel.running ? "running" : "");
  const statusMarkup = task ? `
    <section class="feature-runner-status ${statusTone(status)}" aria-live="polite">
      <div class="feature-runner-status-head">
        <div><span>当前任务</span><code>${escapeHtml(task.taskId || panel.taskId || "-")}</code></div>
        <strong>${escapeHtml(statusLabel(status))}</strong>
      </div>
      <div class="feature-runner-metrics">
        <span><small>结果数量</small><strong>${Number(task.resultCount) || 0}</strong></span>
        <span><small>新增数量</small><strong>${Number(task.addedCount) || 0}</strong></span>
        <span><small>失败输入</small><strong>${Number(task.failedCount) || 0}</strong></span>
        <span><small>耗时</small><strong>${Number.isFinite(Number(task.durationMs)) ? `${Number(task.durationMs)} ms` : "-"}</strong></span>
      </div>
      <p>${escapeHtml(progressText(task))}</p>
      ${task.error ? `<pre class="feature-runner-error">${escapeHtml(task.error)}</pre>` : ""}
    </section>
  ` : "";
  return `
    <div class="feature-runner-panel">
      <div class="feature-runner-heading">
        <div>
          <span>FEATURE RUNNER</span>
          <h3>手动运行配置</h3>
          <p>通过全局唯一功能标识校验配置，并调用与功能间调用相同的后台 Runner。</p>
        </div>
        <label>功能标识<input type="text" value="${escapeHtml(panel.featureId)}" readonly></label>
      </div>
      <div class="feature-runner-notice ${escapeHtml(panel.notice?.tone || "info")}" role="status">${escapeHtml(panel.notice?.text || "")}</div>
      <label class="feature-runner-editor">
        <span>Runner 配置 JSON</span>
        <textarea data-runner-json-input spellcheck="false" rows="18" ${disabled ? "disabled" : ""}>${escapeHtml(panel.draft)}</textarea>
      </label>
      <div class="feature-runner-actions">
        <button class="runner-secondary-button" type="button" data-action="runner-load-parameters" ${disabled ? "disabled" : ""}>载入当前参数</button>
        <button class="runner-secondary-button emphasized" type="button" data-action="runner-validate" ${disabled ? "disabled" : ""}>校验配置</button>
        ${renderFeatureRunnerModeButton(panel, { disabled: Boolean(options.disabled), primaryClass: "runner-primary-button", stopClass: "runner-stop-button" })}
      </div>
      ${statusMarkup}
    </div>
  `;
}

export async function handleFeatureRunnerPanelAction(panel, action, options = {}) {
  if (!action?.startsWith("runner-")) return false;
  const onChange = typeof options.onChange === "function" ? options.onChange : () => {};
  if (action === "runner-load-parameters") {
    if (panel.running) return true;
    syncFeatureRunnerDraft(panel, options.getParameters(), { force: true });
    onChange();
    return true;
  }
  if (action === "runner-validate") {
    if (panel.running) return true;
    try {
      const config = parsePanelConfig(panel);
      const response = await sendMessage({ type: MESSAGE_VALIDATE_FEATURE_RUNNER, options: config });
      if (!response?.ok) throw new Error(response?.error || "Runner 配置校验失败。");
      panel.draft = JSON.stringify(response.config, null, 2);
      panel.notice = { tone: "success", text: "Runner 配置校验通过，已完成参数规范化。" };
    } catch (error) {
      panel.notice = { tone: "error", text: error.message || String(error) };
    }
    onChange();
    return true;
  }
  if (action === "runner-execute") {
    if (panel.running || options.disabled) return true;
    let config;
    try {
      config = parsePanelConfig(panel);
    } catch (error) {
      panel.notice = { tone: "error", text: error.message || String(error) };
      onChange();
      return true;
    }
    const taskId = createTaskId(panel.featureId);
    panel.running = true;
    panel.taskId = taskId;
    panel.task = {
      taskId,
      featureId: panel.featureId,
      status: "running",
      resultCount: 0,
      addedCount: 0,
      failedCount: 0,
      progress: { phase: "task_started" }
    };
    panel.notice = { tone: "info", text: "Runner 任务已创建，正在后台执行。" };
    onChange();
    try {
      const response = await sendMessage({
        type: MESSAGE_EXECUTE_FEATURE_RUNNER,
        options: { ...config, taskId }
      });
      if (!response || (response.ok === false && !response.status)) {
        throw new Error(response?.error || "Runner 执行失败。");
      }
      panel.task = { ...panel.task, ...response, taskId };
      panel.notice = {
        tone: response.status === "failed" ? "error" : response.status === "partial" ? "warning" : "success",
        text: `Runner 任务${statusLabel(response.status)}：结果 ${Number(response.resultCount) || 0} 条，新增 ${Number(response.addedCount) || 0} 条。`
      };
      await options.onFinished?.(response);
    } catch (error) {
      panel.task = {
        ...panel.task,
        taskId,
        status: "failed",
        error: error.message || String(error),
        finishedAt: new Date().toISOString()
      };
      panel.notice = { tone: "error", text: error.message || String(error) };
    } finally {
      panel.running = false;
      onChange();
    }
    return true;
  }
  if (action === "runner-stop") {
    if (!panel.running || !panel.taskId) return true;
    panel.task = { ...panel.task, status: "stopping" };
    panel.notice = { tone: "warning", text: "正在停止 Runner 及其全部并发输入项…" };
    onChange();
    try {
      const response = await sendMessage({
        type: MESSAGE_STOP_FEATURE_RUNNER,
        options: { taskId: panel.taskId }
      });
      if (!response?.ok) throw new Error(response?.error || "停止 Runner 失败。");
    } catch (error) {
      panel.notice = { tone: "error", text: error.message || String(error) };
      onChange();
    }
    return true;
  }
  return false;
}

export function subscribeFeatureRunnerPanel(panel, onChange, onFinished, onTaskUpdate) {
  if (!isExtensionRuntime()) return () => {};
  const listener = (message) => {
    if (message?.type !== MESSAGE_FEATURE_RUNNER_TASK_STATUS) return;
    const task = message.options;
    if (!task?.taskId || task.taskId !== panel.taskId) return;
    const wasRunning = panel.running;
    panel.task = { ...panel.task, ...task };
    panel.running = ["running", "stopping"].includes(task.status);
    onChange?.();
    if (typeof onTaskUpdate === "function") {
      Promise.resolve(onTaskUpdate(task)).then(() => onChange?.()).catch(() => {});
    }
    if (wasRunning && !panel.running && typeof onFinished === "function") {
      Promise.resolve(onFinished(task)).then(() => onChange?.()).catch(() => {});
    }
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}

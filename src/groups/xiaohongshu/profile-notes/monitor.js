import {
  buildXiaohongshuProfileExportRows
} from "./export-data.js";
import {
  MESSAGE_CAPTURE_XIAOHONGSHU_PROFILE,
  MESSAGE_STOP_XIAOHONGSHU_PROFILE
} from "./constants.js";
import {
  getTaskId,
  getTaskRecordDetails,
  renderTaskDetailModal,
  tagTaskDataRow
} from "../../../shared/task-detail.js";
import {
  DEFAULT_TASK_CONCURRENCY,
  MAX_TASK_CONCURRENCY,
  normalizeTaskConcurrency,
  runConcurrentTasks
} from "../../../shared/concurrent-task-pool.js";
import { setFeatureRunning } from "../../../shared/feature-run-status.js";
import { loadTaskTimeoutSeconds, runWithTaskTimeout } from "../../../shared/task-timeout.js";
import { normalizeXiaohongshuLikes } from "../likes-normalizer.js";
import { mergeDataRowsByKey, normalizeForceUpdateData } from "../../../shared/data-update-policy.js";
import {
  applyItemLimit,
  DEFAULT_TASK_RECORDS_PER_STATUS_LIMIT,
  formatLimitValue,
  limitItemsPerGroup,
  loadGlobalStorageLimits
} from "../../../shared/storage-limits.js";
import {
  DEFAULT_EXECUTION_INTERVAL_MAX_MS,
  DEFAULT_EXECUTION_INTERVAL_MIN_MS,
  migrateLegacyExecutionInterval
} from "../../../shared/execution-interval.js";
import {
  clampInputListPage,
  pageForInputIndex,
  paginateInputList,
  renderInputListPagination
} from "../../../shared/input-list-pagination.js";
import {
  createDataFilterValues,
  filterDataRows,
  openRowsJsonPreview,
  renderDataFilterPanel
} from "../../../shared/data-table-filter.js";
import {
  createDataColumnVisibility,
  downloadDataRowsCsv,
  projectDataRowsByColumns,
  renderConfiguredDataTable,
  renderDataColumnSettingsPanel,
  scheduleDataColumnRender,
  showAllDataColumns
} from "../../../shared/data-column-settings.js";
import {
  getFeatureRunnerPanelState,
  handleFeatureRunnerPanelAction,
  renderFeatureRunnerModeButton,
  renderFeatureRunnerPanel,
  subscribeFeatureRunnerPanel,
  syncFeatureRunnerDraft,
  updateFeatureRunnerDraft
} from "../../../shared/feature-runner-panel.js";
import {
  getTaskExecutionTypeLabel,
  normalizeTaskExecutionType,
  TASK_EXECUTION_TYPE_MANUAL
} from "../../../shared/task-record-type.js";
import { renderPageParametersCard } from "../../../shared/page-parameters.js";

const STORAGE_KEY = "browserCoreClawXiaohongshuProfileV1";
const FEATURE_KEY = "xiaohongshu/profile-notes";
const ALL_RECORD_FILTER = "__all__";
const DATA_FILTER_DEFINITIONS = Object.freeze([
  { key: "pageOrder", label: "顺序" },
  { key: "noteId", label: "博文 ID" },
  { key: "noteTitle", label: "博文标题" },
  { key: "noteAuthor", label: "作者", type: "select" },
  { key: "noteLikes", label: "点赞" },
  { key: "noteUrl", label: "博文链接" },
  { key: "capturedAt", label: "采集时间", placeholder: "例如 2025-11-18" }
]);
const DATA_COLUMNS = Object.freeze([
  { key: "pageOrder", label: "顺序" },
  { key: "noteId", label: "博文 ID" },
  { key: "noteTitle", label: "博文标题", type: "long" },
  { key: "noteAuthor", label: "作者" },
  { key: "noteLikes", label: "点赞" },
  { key: "noteCover", label: "封面", type: "image" },
  { key: "noteUrl", label: "博文链接", type: "link" },
  { key: "collectedAt", label: "采集时间" }
]);
const DEFAULT_PROFILE_URLS = [""];
const DEFAULT_OPTIONS = Object.freeze({
  limit: 20,
  intervalMinMs: DEFAULT_EXECUTION_INTERVAL_MIN_MS,
  intervalMaxMs: DEFAULT_EXECUTION_INTERVAL_MAX_MS,
  concurrency: DEFAULT_TASK_CONCURRENCY,
  forceUpdateData: false,
  polling: false,
  pollingMinutes: 10
});
const RECORD_STATUS_META = Object.freeze({
  running: { label: "运行中", tone: "running" },
  success: { label: "完成", tone: "success" },
  empty: { label: "无数据", tone: "success" },
  partial: { label: "部分完成", tone: "warning" },
  error: { label: "失败", tone: "error" },
  stopped: { label: "已停止", tone: "stopped" }
});

// This lives at module scope so changing back to the feature list does not
// interrupt a task that is already running in the side-panel document.
let activeProfileRun = null;
const PROFILE_RUN_EVENT = "browser-core-claw-profile-run-finished";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function asInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function formatTime(date = new Date()) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date);
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "-";
  if (milliseconds < 1000) return `${milliseconds} ms`;
  return `${(milliseconds / 1000).toFixed(milliseconds < 10000 ? 1 : 0)} 秒`;
}

function uniqueUrls(values) {
  return Array.from(new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean)
  ));
}

function isXiaohongshuProfileUrl(value) {
  try {
    const url = new URL(value);
    return /(^|\.)xiaohongshu\.com$/i.test(url.hostname) && /^\/user\/profile\/[^/]+\/?$/i.test(url.pathname);
  } catch {
    return false;
  }
}

function buildProfileJsonParameters(state) {
  return {
    profileUrls: [...state.profileUrls],
    limit: state.limit,
    concurrency: state.concurrency,
    intervalMinMs: state.intervalMinMs,
    intervalMaxMs: state.intervalMaxMs,
    forceUpdateData: Boolean(state.forceUpdateData),
    polling: Boolean(state.polling),
    pollingMinutes: state.pollingMinutes
  };
}

function normalizeProfileJsonParameters(input, state) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("JSON 顶层必须是一个对象。");
  }
  if (!Array.isArray(input.profileUrls)) throw new Error("profileUrls 必须是字符串数组。");
  const profileUrls = uniqueUrls(input.profileUrls);
  if (!profileUrls.length && !input.profileUrls.length) throw new Error("profileUrls 至少需要保留一个输入项。");
  if (!profileUrls.length) profileUrls.push("");
  const invalidUrl = profileUrls.find((url) => url && !isXiaohongshuProfileUrl(url));
  if (invalidUrl) throw new Error(`博主主页链接格式不正确：${invalidUrl}`);
  if (input.polling !== undefined && typeof input.polling !== "boolean") {
    throw new Error("polling 必须是布尔值 true 或 false。");
  }
  if (input.forceUpdateData !== undefined && typeof input.forceUpdateData !== "boolean") {
    throw new Error("forceUpdateData 必须是布尔值 true 或 false。");
  }
  return {
    profileUrls,
    limit: asInteger(input.limit, state.limit, 1, 100),
    concurrency: normalizeTaskConcurrency(input.concurrency ?? state.concurrency),
    ...normalizeProfileIntervalRange({
      intervalMinMs: input.intervalMinMs ?? state.intervalMinMs,
      intervalMaxMs: input.intervalMaxMs ?? state.intervalMaxMs
    }),
    forceUpdateData: normalizeForceUpdateData(input.forceUpdateData ?? state.forceUpdateData),
    polling: input.polling ?? state.polling,
    pollingMinutes: asInteger(input.pollingMinutes, state.pollingMinutes, 1, 1440)
  };
}

export function normalizeProfileIntervalRange(config) {
  const first = asInteger(config?.intervalMinMs, DEFAULT_OPTIONS.intervalMinMs, 100, 6000);
  const second = asInteger(config?.intervalMaxMs, DEFAULT_OPTIONS.intervalMaxMs, 100, 6000);
  return { intervalMinMs: Math.min(first, second), intervalMaxMs: Math.max(first, second) };
}

export function pickProfileIntervalMs(config, randomFunction = Math.random) {
  const { intervalMinMs, intervalMaxMs } = normalizeProfileIntervalRange(config);
  if (intervalMinMs === intervalMaxMs) return intervalMinMs;
  const randomValue = Math.min(0.999999999, Math.max(0, Number(randomFunction()) || 0));
  return intervalMinMs + Math.floor(randomValue * (intervalMaxMs - intervalMinMs + 1));
}

function intervalSummary(state) {
  const { intervalMinMs, intervalMaxMs } = normalizeProfileIntervalRange(state);
  return `${intervalMinMs} - ${intervalMaxMs} ms`;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitWhileRunning(milliseconds, control) {
  const deadline = Date.now() + milliseconds;
  while (!control.stopRequested && Date.now() < deadline) {
    await wait(Math.min(100, deadline - Date.now()));
  }
}

export async function waitForProfileInterval(config, control, options = {}) {
  const intervalMs = pickProfileIntervalMs(config, options.randomFunction);
  options.onWait?.(intervalMs);
  await (options.waitFunction || waitWhileRunning)(intervalMs, control);
  return intervalMs;
}

export function getProfileRecordStatusKey(record) {
  if (RECORD_STATUS_META[record?.statusKey]) return record.statusKey;
  const status = String(record?.status || "");
  if (/停止/.test(status)) return "stopped";
  if (/无数据/.test(status)) return "empty";
  if (/部分/.test(status)) return "partial";
  if (/失败/.test(status)) return "error";
  if (/完成/.test(status)) return "success";
  return "running";
}

function normalizeRecord(record, index = 0) {
  const normalized = record && typeof record === "object" ? record : {};
  const statusKey = getProfileRecordStatusKey(normalized);
  const meta = RECORD_STATUS_META[statusKey];
  return {
    ...normalized,
    id: normalized.id || `XHP-OLD-${index + 1}`,
    keyword: normalized.keyword || "-",
    round: normalized.round || "-",
    status: normalized.status || meta.label,
    statusKey,
    tone: normalized.tone || meta.tone,
    executionType: normalizeTaskExecutionType(normalized),
    resultCount: Number(normalized.resultCount) || 0,
    addedCount: Number(normalized.addedCount) || 0,
    duration: normalized.duration || "-",
    error: normalized.error || ""
  };
}

export function limitProfileRecordsPerStatus(records, limit = DEFAULT_TASK_RECORDS_PER_STATUS_LIMIT) {
  return limitItemsPerGroup(
    (Array.isArray(records) ? records : []).map(normalizeRecord),
    getProfileRecordStatusKey,
    limit
  );
}

export function filterProfileRecords(records, filters = {}) {
  const profileFilter = filters.profile || ALL_RECORD_FILTER;
  const statusFilter = filters.status || ALL_RECORD_FILTER;
  const executionTypeFilter = filters.executionType || ALL_RECORD_FILTER;
  return (Array.isArray(records) ? records : []).filter((record) => (
    (profileFilter === ALL_RECORD_FILTER || record.keyword === profileFilter)
    && (statusFilter === ALL_RECORD_FILTER || getProfileRecordStatusKey(record) === statusFilter)
    && (executionTypeFilter === ALL_RECORD_FILTER || normalizeTaskExecutionType(record) === executionTypeFilter)
  ));
}

export function updateProfileRecord(
  records,
  recordId,
  patch = {},
  limit = DEFAULT_TASK_RECORDS_PER_STATUS_LIMIT
) {
  const targetId = String(recordId || "");
  return limitProfileRecordsPerStatus(
    (Array.isArray(records) ? records : []).map((record) => (
      String(record?.id || "") === targetId ? { ...record, ...patch } : record
    )),
    limit
  );
}

function isExtensionRuntime() {
  return Boolean(globalThis.chrome?.runtime?.id && chrome.runtime?.sendMessage && chrome.tabs?.query);
}

function callChrome(callbackApi) {
  return new Promise((resolve, reject) => {
    callbackApi((result) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(result);
    });
  });
}

function sendMessage(message) {
  return callChrome((done) => chrome.runtime.sendMessage(message, done));
}

async function loadSavedState() {
  if (!isExtensionRuntime() || !chrome.storage?.local) return null;
  const values = await callChrome((done) => chrome.storage.local.get(STORAGE_KEY, done));
  return values?.[STORAGE_KEY] || null;
}

function saveState(state) {
  if (!isExtensionRuntime() || !chrome.storage?.local) return;
  chrome.storage.local.set({
    [STORAGE_KEY]: {
      profileUrls: uniqueUrls(state.profileUrls),
      config: {
        limit: state.limit,
        concurrency: normalizeTaskConcurrency(state.concurrency),
        ...normalizeProfileIntervalRange(state),
        forceUpdateData: Boolean(state.forceUpdateData),
        polling: Boolean(state.polling),
        pollingMinutes: asInteger(state.pollingMinutes, DEFAULT_OPTIONS.pollingMinutes, 1, 1440)
      },
      records: limitProfileRecordsPerStatus(state.records, state.taskRecordsPerStatusLimit),
      dataRows: applyItemLimit(state.dataRows, state.dataStorageLimit),
      dataColumnVisibility: state.dataColumnVisibility,
      notice: state.notice
    }
  }).catch(() => {});
}

function renderStatus(record) {
  return `<span class="xhs-table-status ${escapeHtml(record.tone || "running")}">${escapeHtml(record.status || "运行中")}</span>`;
}

function renderTabs(state) {
  return [
    ["params", "运行参数"],
    ["records", `运行记录(${state.records.length})`],
    ["data", `数据(${state.dataRows.length})`]
  ].map(([id, label]) => `
    <button class="xhs-tab ${state.tab === id ? "active" : ""}" type="button" role="tab" aria-selected="${state.tab === id}" data-tab="${id}">${label}</button>
  `).join("");
}

function renderProfileRows(state, pagination) {
  return pagination.items.map(({ value: profileUrl, index }) => `
    <div class="xhs-keyword-row">
      <span class="xhs-row-index">${index + 1}</span>
      <label class="xhs-keyword-input">
        <span class="sr-only">第 ${index + 1} 个博主主页</span>
        <input type="url" value="${escapeHtml(profileUrl)}" placeholder="https://www.xiaohongshu.com/user/profile/..." data-profile-index="${index}" ${state.running ? "disabled" : ""}>
      </label>
      <button class="xhs-remove-button" type="button" data-action="remove-profile" data-index="${index}" aria-label="删除第 ${index + 1} 个主页" ${state.profileUrls.length === 1 || state.running ? "disabled" : ""}>X</button>
    </div>
  `).join("");
}

function renderRunOptions(state) {
  const disabled = state.running ? "disabled" : "";
  return `
    <section class="xhs-options-card">
      <button class="xhs-options-header" type="button" data-action="toggle-options" aria-expanded="${state.optionsOpen}">
        <span aria-hidden="true">⌄</span>
        <span class="xhs-options-title"><strong>运行选项</strong><small>结果数量、并发任务、随机执行间隔与循环监控</small></span>
        <span class="xhs-option-summary">
          <span><small>每个主页笔记数</small><strong>${state.limit}</strong></span>
          <span><small>并发任务</small><strong>${state.concurrency}</strong></span>
          <span><small>执行间隔</small><strong>${intervalSummary(state)}</strong></span>
          <span><small>循环监控</small><strong>${state.polling ? `${state.pollingMinutes} 分钟` : "关闭"}</strong></span>
        </span>
        <span class="xhs-options-toggle-label">${state.optionsOpen ? "收起选项" : "展开选项"}</span>
      </button>
      ${state.optionsOpen ? `
        <div class="xhs-options-body">
          <p class="xhs-options-note">每个主页链接都是独立任务，并发任务使用独立后台标签页；笔记不足设定数量时，以实际数量为准。</p>
          <div class="xhs-options-grid">
            <label class="xhs-control">
              <span>每个主页笔记数</span>
              <input type="number" min="1" max="100" value="${state.limit}" data-field="limit" ${disabled}>
              <small>默认 20 条；采集顺序与博主主页笔记列表保持一致。</small>
            </label>
            <label class="xhs-control">
              <span>并发任务数</span>
              <input type="number" min="1" max="${MAX_TASK_CONCURRENCY}" value="${state.concurrency}" data-field="concurrency" ${disabled}>
              <small>同时采集 ${state.concurrency} 个主页；设为 1 时按顺序执行，最多 ${MAX_TASK_CONCURRENCY} 个。</small>
            </label>
            <label class="xhs-control">
              <span>博主主页执行间隔</span>
              <div class="xhs-range-inputs">
                <div class="xhs-input-with-unit"><input type="number" min="100" max="6000" step="50" value="${state.intervalMinMs}" data-field="intervalMinMs" aria-label="最短执行间隔" ${disabled}><span>ms</span></div>
                <span class="xhs-range-separator" aria-hidden="true">-</span>
                <div class="xhs-input-with-unit"><input type="number" min="100" max="6000" step="50" value="${state.intervalMaxMs}" data-field="intervalMaxMs" aria-label="最长执行间隔" ${disabled}><span>ms</span></div>
              </div>
              <small>每个主页完成后，会在 ${intervalSummary(state)} 内随机等待。</small>
            </label>
          </div>
          <div class="xhs-polling-row">
            <label class="xhs-switch-control">
              <input type="checkbox" data-field="forceUpdateData" ${state.forceUpdateData ? "checked" : ""} ${disabled}>
              <span><strong>强制更新数据</strong><small>遇到相同博文时，使用本次采集结果覆盖本地旧数据。</small></span>
            </label>
            <label class="xhs-switch-control">
              <input type="checkbox" data-field="polling" ${state.polling ? "checked" : ""} ${disabled}>
              <span><strong>循环监控</strong><small>每轮主页任务完成后，按设定周期再次执行，直到手动停止。</small></span>
            </label>
            <label class="xhs-control compact ${state.polling ? "" : "is-disabled"}">
              <span>轮询周期</span>
              <div class="xhs-input-with-unit"><input type="number" min="1" max="1440" value="${state.pollingMinutes}" data-field="pollingMinutes" ${state.polling && !state.running ? "" : "disabled"}><span>分钟</span></div>
            </label>
          </div>
        </div>
      ` : ""}
    </section>
  `;
}

function renderPageParameters(state) {
  return renderPageParametersCard({
    prefix: "xhs",
    open: state.pageParametersOpen,
    description: "此功能直接按博主主页当前的笔记列表采集，不额外改写目标页面的筛选或展示状态。"
  });
}

function renderFormParameters(state) {
  const pagination = paginateInputList(state.profileUrls, state.inputListPage);
  return `
      <div class="xhs-field-heading">
        <div>
          <label>博主主页链接</label>
          <p>每个主页链接会独立采集笔记卡片；不包含关键词搜索、页面筛选或博主资料采集。</p>
        </div>
        <span>${state.profileUrls.filter(Boolean).length} 个主页</span>
      </div>
      <div class="xhs-keyword-list xhs-profile-list">${renderProfileRows(state, pagination)}</div>
      ${renderInputListPagination(pagination, { itemLabel: "个主页" })}
      <div class="xhs-inline-actions">
        <button class="xhs-secondary-button emphasized" type="button" data-action="add-profile" ${state.running ? "disabled" : ""}>＋ 添加主页</button>
        <button class="xhs-secondary-button" type="button" data-action="open-batch" ${state.running ? "disabled" : ""}>批量编辑</button>
      </div>
      <p class="xhs-profile-init-note"><strong>采集链路：</strong>复用当前 Chrome 的小红书登录会话，打开主页并等待笔记列表稳定，再按页面顺序读取博文封面、标题、作者、链接和点赞数。</p>
  `;
}

function renderJsonParameters(state) {
  return `
    <div class="xhs-json-editor">
      <div class="xhs-field-heading"><div><label for="profileNotesJsonInput">运行参数 JSON</label><p>应用后会同步到表单，并用于真实的小红书博主博文采集任务。</p></div></div>
      <textarea id="profileNotesJsonInput" data-json-input spellcheck="false" rows="14" ${state.running ? "disabled" : ""}>${escapeHtml(state.jsonDraft)}</textarea>
      <div class="xhs-inline-actions"><button class="xhs-secondary-button emphasized" type="button" data-action="apply-json" ${state.running ? "disabled" : ""}>校验并应用</button></div>
    </div>
  `;
}

function renderParameters(state) {
  const controlsLocked = state.running || state.runnerPanel.running;
  return `
    <section class="xhs-parameter-card">
      <div class="xhs-mode-switch" role="tablist" aria-label="参数编辑方式">
        <button class="${state.mode === "form" ? "active" : ""}" type="button" data-action="set-mode" data-mode="form" ${controlsLocked ? "disabled" : ""}>表单</button>
        <button class="${state.mode === "json" ? "active" : ""}" type="button" data-action="set-mode" data-mode="json" ${controlsLocked ? "disabled" : ""}>JSON</button>
        <button class="${state.mode === "runner" ? "active" : ""}" type="button" data-action="set-mode" data-mode="runner" ${controlsLocked ? "disabled" : ""}>运行器</button>
      </div>
      ${state.mode === "form"
        ? renderFormParameters(state)
        : state.mode === "json"
          ? renderJsonParameters(state)
          : renderFeatureRunnerPanel(state.runnerPanel, { escapeHtml, disabled: state.running })}
    </section>
    ${state.mode === "runner" ? "" : `${renderPageParameters(state)}${renderRunOptions(state)}`}
  `;
}

function renderRecordFilters(state, filteredCount) {
  const profiles = Array.from(new Set(state.records.map((record) => record.keyword).filter(Boolean)));
  return `
    <div class="xhs-record-filters" aria-label="运行记录筛选">
      <label class="xhs-filter-control"><span>博主主页</span><select data-record-filter="profile"><option value="${ALL_RECORD_FILTER}">全部主页</option>${profiles.map((profile) => `<option value="${escapeHtml(profile)}" ${state.recordFilters.profile === profile ? "selected" : ""}>${escapeHtml(profile)}</option>`).join("")}</select></label>
      <label class="xhs-filter-control"><span>状态</span><select data-record-filter="status"><option value="${ALL_RECORD_FILTER}">全部状态</option>${Object.entries(RECORD_STATUS_META).map(([key, meta]) => `<option value="${key}" ${state.recordFilters.status === key ? "selected" : ""}>${meta.label}</option>`).join("")}</select></label>
      <label class="xhs-filter-control"><span>类型</span><select data-record-filter="executionType"><option value="${ALL_RECORD_FILTER}">全部类型</option><option value="manual" ${state.recordFilters.executionType === "manual" ? "selected" : ""}>普通运行</option><option value="runner" ${state.recordFilters.executionType === "runner" ? "selected" : ""}>运行器</option></select></label>
      <span class="xhs-filter-result">显示 ${filteredCount} / ${state.records.length} 条</span>
    </div>
  `;
}

function renderRecords(state) {
  const records = filterProfileRecords(state.records, state.recordFilters);
  return `
    <section class="xhs-content-card xhs-table-page">
      <div class="xhs-panel-head"><div><h2>运行记录</h2><p>每个博主主页独立记录；每一种状态最多保留 ${formatLimitValue(state.taskRecordsPerStatusLimit)}。</p></div></div>
      ${renderRecordFilters(state, records.length)}
      <div class="xhs-table-shell records" tabindex="0" aria-label="可滚动的博主采集运行记录表格">
        <table class="xhs-table">
          <thead><tr><th>任务编号</th><th>类型</th><th>开始时间</th><th>博主主页</th><th>轮次</th><th>状态</th><th>结果数量</th><th>新增数量</th><th>耗时</th></tr></thead>
          <tbody>${records.length ? records.map((record) => `
            <tr>
              <td><button class="xhs-task-id-button" type="button" data-action="open-task-detail" data-record-id="${escapeHtml(record.id)}" title="查看当前博主任务明细"><code>${escapeHtml(getTaskId(record))}</code></button></td>
              <td><span class="task-execution-type ${normalizeTaskExecutionType(record)}">${escapeHtml(getTaskExecutionTypeLabel(record))}</span></td>
              <td>${escapeHtml(record.startedAt)}</td><td class="xhs-profile-url-cell" title="${escapeHtml(record.keyword)}">${escapeHtml(record.keyword)}</td><td>${escapeHtml(record.round)}</td>
              <td title="${escapeHtml(record.error || "")}">${renderStatus(record)}</td><td>${record.resultCount}</td><td>${record.addedCount}</td><td>${escapeHtml(record.duration)}</td>
            </tr>
          `).join("") : `<tr><td class="xhs-table-empty" colspan="9">${state.records.length ? "没有符合筛选条件的记录" : "暂无运行记录"}</td></tr>`}</tbody>
        </table>
      </div>
    </section>
  `;
}

function renderData(state) {
  const filteredRows = filterDataRows(state.dataRows, DATA_FILTER_DEFINITIONS, state.dataFilters);
  const exportRows = buildXiaohongshuProfileExportRows(filteredRows);
  return `
    <section class="xhs-content-card xhs-table-page">
      <div class="xhs-panel-head"><div><h2>数据</h2><p>共 ${state.dataRows.length} 条，最多保留 ${formatLimitValue(state.dataStorageLimit)}；博文按主页卡片原始顺序保存。</p></div>${renderDataColumnSettingsPanel({ columns: DATA_COLUMNS, visibility: state.dataColumnVisibility, expanded: state.dataColumnsOpen, escapeHtml })}</div>
      ${renderDataFilterPanel({ rows: state.dataRows, definitions: DATA_FILTER_DEFINITIONS, values: state.dataFilters, expanded: state.dataFiltersOpen, escapeHtml })}
      <div class="xhs-table-shell data" tabindex="0" aria-label="可滚动的博文数据表格">
        <table class="xhs-table xhs-data-table">
          ${renderConfiguredDataTable({ rows: exportRows, columns: DATA_COLUMNS, visibility: state.dataColumnVisibility, escapeHtml, emptyText: state.dataRows.length ? "没有符合筛选条件的数据" : "运行后，主页博文卡片会显示在这里" })}
        </table>
      </div>
    </section>
  `;
}

function renderBatchModal(state) {
  if (!state.batchOpen) return "";
  return `
    <div class="xhs-modal-backdrop" data-modal="batch"><section class="xhs-batch-modal" role="dialog" aria-modal="true" aria-labelledby="xhsProfileBatchTitle">
      <header><div><span>BATCH EDIT</span><h2 id="xhsProfileBatchTitle">批量编辑博主主页</h2></div><button class="xhs-modal-close" type="button" data-action="close-batch" aria-label="关闭批量编辑">X</button></header>
      <p>每行一个小红书博主主页链接；应用后会替换当前列表。</p><label for="xhsProfileBatchInput">主页链接列表</label>
      <textarea id="xhsProfileBatchInput" data-batch-input rows="10" placeholder="https://www.xiaohongshu.com/user/profile/...">${escapeHtml(state.batchDraft)}</textarea>
      <footer><button class="xhs-secondary-button" type="button" data-action="close-batch">取消</button><button class="xhs-primary-button" type="button" data-action="apply-batch">应用主页链接</button></footer>
    </section></div>
  `;
}

function renderGuide(state) {
  if (!state.guideOpen) return "";
  return `
    <div class="xhs-modal-backdrop" data-modal="guide"><section class="xhs-batch-modal xhs-guide-modal" role="dialog" aria-modal="true" aria-labelledby="xhsProfileGuideTitle">
      <header><div><span>QUICK START</span><h2 id="xhsProfileGuideTitle">使用说明</h2></div><button class="xhs-modal-close" type="button" data-action="close-guide" data-guide-autofocus aria-label="关闭使用说明">X</button></header>
      <div class="xhs-guide"><p class="xhs-guide-intro">功能会复用当前 Chrome Profile 的小红书登录会话，按主页链接采集主页博文卡片。</p><ol>
        <li><strong>确认登录</strong><span>进入功能前会确认当前 Chrome Profile 的小红书登录状态。</span></li>
        <li><strong>填写主页</strong><span>输入一个或多个 <code>/user/profile/</code> 主页链接。</span></li>
        <li><strong>运行并导出</strong><span>程序会等待页面稳定、滚动补齐笔记并去重，数据页支持筛选、复制 JSON 和导出 CSV 表格。</span></li>
      </ol><div class="xhs-schema-box"><strong>采集字段</strong><code>pageOrder · noteId · noteTitle · noteAuthor · noteLikes · noteUrl · noteCover · collectedAt</code></div></div>
      <footer><button class="xhs-primary-button" type="button" data-action="close-guide">知道了</button></footer>
    </section></div>
  `;
}

function renderTaskDetails(state) {
  if (!state.taskDetailRecordId) return "";
  return renderTaskDetailModal({
    detail: getTaskRecordDetails(state.records, state.taskDetailRecordId),
    prefix: "xhs",
    featureName: "小红书博主博文采集",
    detailTitle: "小红书博主博文采集任务明细",
    subjectLabel: "博主主页",
    escapeHtml,
    renderStatus
  });
}

function renderRunButton(state, className = "") {
  if (state.mode === "runner") return renderFeatureRunnerModeButton(state.runnerPanel, {
    className,
    primaryClass: "xhs-primary-button",
    stopClass: "xhs-stop-button",
    disabled: state.running
  });
  if (state.running) return `<button class="xhs-stop-button ${className}" type="button" data-action="stop" ${state.stopping ? "disabled" : ""}>${state.stopping ? "停止中…" : "停止全部"}</button>`;
  return `<button class="xhs-primary-button ${className}" type="button" data-action="run">运行</button>`;
}

function renderActionBar(state) {
  const runnerMode = state.mode === "runner";
  if (state.tab === "params") return `
    <footer class="xhs-action-bar">${renderRunButton(state)}<button class="xhs-secondary-button" type="button" data-action="reset" ${state.running || state.runnerPanel.running ? "disabled" : ""}>还原输入</button><span>${runnerMode ? (state.runnerPanel.running ? "Runner 后台任务运行中，配置已锁定；可以停止任务。" : "运行器会校验功能 ID 与 JSON 参数，然后创建可跟踪的后台任务。") : (state.running ? "任务运行中，参数已锁定；可以停止任务。" : "运行会打开小红书博主主页，等待列表稳定后采集主页博文。")}</span></footer>
  `;
  if (state.tab === "records") return `
    <footer class="xhs-action-bar xhs-table-action-bar"><button class="xhs-secondary-button" type="button" data-action="clear-records" ${state.records.length && !state.running ? "" : "disabled"}>清空记录</button><span>当前 ${state.records.length} 条 · 每种状态最多保留 ${formatLimitValue(state.taskRecordsPerStatusLimit)}</span></footer>
  `;
  const filteredRows = filterDataRows(state.dataRows, DATA_FILTER_DEFINITIONS, state.dataFilters);
  return `
    <footer class="xhs-action-bar xhs-table-action-bar"><button class="xhs-secondary-button emphasized" type="button" data-action="copy-json" ${filteredRows.length ? "" : "disabled"}>复制 JSON</button><button class="xhs-secondary-button emphasized" type="button" data-action="export-csv" ${filteredRows.length ? "" : "disabled"}>导出表格</button><button class="xhs-secondary-button" type="button" data-action="clear-data" ${state.dataRows.length && !state.running ? "" : "disabled"}>清空数据</button><span>筛选结果 ${filteredRows.length} / ${state.dataRows.length} 条 · 最多保留 ${formatLimitValue(state.dataStorageLimit)}</span></footer>
  `;
}

function renderPage(state, context) {
  const isTable = state.tab === "records" || state.tab === "data";
  const workspace = state.tab === "records" ? renderRecords(state) : state.tab === "data" ? renderData(state) : renderParameters(state);
  return `
    <section class="xhs-monitor has-fixed-actions" aria-labelledby="xhsProfileMonitorTitle">
      <header class="xhs-hero"><div class="xhs-title-row"><h1 id="xhsProfileMonitorTitle">${escapeHtml(context.feature.name)}</h1><span class="xhs-version">v0.2.0</span><button class="xhs-guide-button ${state.guideOpen ? "active" : ""}" type="button" data-action="open-guide" title="查看使用说明" aria-haspopup="dialog" aria-expanded="${state.guideOpen}"><span>使用说明</span><img src="src/assets/icons/question-circle.svg" alt="" aria-hidden="true"></button></div>${renderRunButton(state, "xhs-top-run")}</header>
      <nav class="xhs-tabs" role="tablist" aria-label="小红书博主博文采集页面">${renderTabs(state)}</nav>
      <div class="xhs-notice ${escapeHtml(state.notice.tone)}" role="status">${escapeHtml(state.notice.text)}</div>
      <div class="xhs-workspace has-fixed-actions ${isTable ? "is-table-view" : ""}">${workspace}</div>
      ${renderActionBar(state)}${renderBatchModal(state)}${renderGuide(state)}${renderTaskDetails(state)}
    </section>
  `;
}

function buildPostRows(data) {
  const notes = Array.isArray(data?.notes) ? data.notes : [];
  return notes.map((note, index) => ({
    id: String(note.noteId || note.url || index),
    pageOrder: Number(note.order) || index + 1,
    noteId: note.noteId || "",
    noteTitle: note.title || "",
    noteAuthor: note.author || "",
    noteLikes: normalizeXiaohongshuLikes(note.likes),
    noteCover: note.cover || "",
    noteUrl: note.url || "",
    capturedAt: data?.capturedAt || new Date().toISOString()
  }));
}

function mergeDataRows(state, data, task) {
  const incoming = buildPostRows(data);
  const merged = mergeDataRowsByKey({
    currentRows: state.dataRows,
    incomingRows: incoming,
    getKey: (row) => row.id,
    forceUpdateData: state.forceUpdateData,
    mergeRow: (previous, row) => tagTaskDataRow({ ...previous, ...row }, task)
  });
  state.dataRows = applyItemLimit(merged.rows, state.dataStorageLimit);
  return merged.addedCount;
}

export async function mountXiaohongshuProfileNotesMonitor(container, context) {
  const storageLimits = await loadGlobalStorageLimits().catch(() => ({
    dataStorageLimit: 3000,
    taskRecordsPerStatusLimit: 200
  }));
  const saved = await loadSavedState().catch(() => null);
  const savedConfig = migrateLegacyExecutionInterval(saved?.config || {}, {
    legacyMinMs: 100,
    legacyMaxMs: 6000
  });
  const savedInterval = normalizeProfileIntervalRange(savedConfig);
  const runnerPanel = getFeatureRunnerPanelState(FEATURE_KEY);
  const state = {
    tab: "params",
    mode: runnerPanel.running ? "runner" : "form",
    runnerPanel,
    jsonDraft: "",
    profileUrls: Array.isArray(saved?.profileUrls) && saved.profileUrls.length ? saved.profileUrls : [...DEFAULT_PROFILE_URLS],
    inputListPage: 1,
    dataStorageLimit: storageLimits.dataStorageLimit,
    taskRecordsPerStatusLimit: storageLimits.taskRecordsPerStatusLimit,
    records: limitProfileRecordsPerStatus(saved?.records, storageLimits.taskRecordsPerStatusLimit),
    dataRows: applyItemLimit(saved?.dataRows, storageLimits.dataStorageLimit)
      .map((row) => ({ ...row, noteLikes: normalizeXiaohongshuLikes(row?.noteLikes ?? row?.likes) })),
    batchOpen: false,
    batchDraft: "",
    guideOpen: false,
    taskDetailRecordId: "",
    limit: asInteger(savedConfig.limit, DEFAULT_OPTIONS.limit, 1, 100),
    concurrency: normalizeTaskConcurrency(savedConfig.concurrency),
    intervalMinMs: savedInterval.intervalMinMs,
    intervalMaxMs: savedInterval.intervalMaxMs,
    forceUpdateData: normalizeForceUpdateData(savedConfig.forceUpdateData),
    polling: Boolean(savedConfig.polling),
    pollingMinutes: asInteger(savedConfig.pollingMinutes, DEFAULT_OPTIONS.pollingMinutes, 1, 1440),
    optionsOpen: false,
    pageParametersOpen: false,
    running: Boolean(activeProfileRun && !activeProfileRun.stopRequested),
    stopping: false,
    recordFilters: { profile: ALL_RECORD_FILTER, status: ALL_RECORD_FILTER, executionType: ALL_RECORD_FILTER },
    dataFilters: createDataFilterValues(DATA_FILTER_DEFINITIONS),
    dataFiltersOpen: true,
    dataColumnVisibility: createDataColumnVisibility(DATA_COLUMNS, saved?.dataColumnVisibility),
    dataColumnsOpen: false,
    notice: saved?.notice || { tone: "info", text: "已确认小红书登录状态。填写博主主页链接后即可采集主页博文。" }
  };
  saveState(state);
  let disposed = false;
  let activeRun = activeProfileRun;

  const syncJsonDraft = () => {
    state.jsonDraft = JSON.stringify(buildProfileJsonParameters(state), null, 2);
  };
  const applyJsonDraft = () => {
    try {
      Object.assign(state, normalizeProfileJsonParameters(JSON.parse(state.jsonDraft), state));
      state.inputListPage = 1;
      syncJsonDraft();
      state.notice = { tone: "success", text: "JSON 参数已校验并同步到表单。" };
      saveState(state);
      return true;
    } catch (error) {
      state.notice = { tone: "error", text: error.message || "JSON 参数格式不正确。" };
      return false;
    }
  };

  const render = () => {
    if (!disposed) container.innerHTML = renderPage(state, context);
  };
  const closeTaskDetails = () => { state.taskDetailRecordId = ""; render(); };
  const openTaskDetails = (recordId) => {
    state.batchOpen = false;
    state.guideOpen = false;
    state.taskDetailRecordId = recordId;
    render();
    requestAnimationFrame(() => container.querySelector("[data-task-detail-close]")?.focus());
  };
  const finishRecord = (recordId, startedAtMs, statusKey, resultCount = 0, addedCount = 0, error = "") => {
    const meta = RECORD_STATUS_META[statusKey] || RECORD_STATUS_META.error;
    state.records = updateProfileRecord(state.records, recordId, {
      status: meta.label,
      statusKey,
      tone: meta.tone,
      resultCount: Number(resultCount) || 0,
      addedCount: Number(addedCount) || 0,
      error,
      duration: formatDuration(Date.now() - startedAtMs)
    }, state.taskRecordsPerStatusLimit);
  };
  const createRecord = (control, profileUrl, round, index) => {
    const startedAtMs = Date.now();
    const record = {
      id: `${control.runId}-R${round}-P${index + 1}`,
      runId: control.runId,
      executionType: TASK_EXECUTION_TYPE_MANUAL,
      startedAt: formatTime(new Date(startedAtMs)),
      keyword: profileUrl,
      round,
      status: RECORD_STATUS_META.running.label,
      statusKey: "running",
      tone: "running",
      resultCount: 0,
      addedCount: 0,
      duration: "-",
      error: ""
    };
    state.records.unshift(record);
    state.records = limitProfileRecordsPerStatus(state.records, state.taskRecordsPerStatusLimit);
    return {
      record: state.records.find((item) => item.id === record.id) || record,
      startedAtMs
    };
  };

  const startRun = async () => {
    if (state.running) return;
    if (!isExtensionRuntime()) {
      state.notice = { tone: "error", text: "博主主页采集只能在已加载扩展的 Chrome 控制台中运行。" };
      render();
      return;
    }
    const profileUrls = uniqueUrls(state.profileUrls);
    if (!profileUrls.length) {
      state.notice = { tone: "error", text: "请至少填写一个小红书博主主页链接。" };
      render();
      return;
    }
    const invalidUrl = profileUrls.find((url) => !isXiaohongshuProfileUrl(url));
    if (invalidUrl) {
      state.notice = { tone: "error", text: `主页链接格式不正确：${invalidUrl}` };
      render();
      return;
    }

    state.profileUrls = profileUrls;
    const control = {
      runId: `XHP-${String(Date.now()).slice(-8)}`,
      stopRequested: false,
      activeCaptureRunIds: new Set()
    };
    activeRun = control;
    activeProfileRun = control;
    state.running = true;
    state.stopping = false;
    state.notice = { tone: "info", text: `正在准备 ${profileUrls.length} 个小红书博主主页…` };
    saveState(state);
    render();

    await setFeatureRunning(FEATURE_KEY, true);
    const taskTimeoutSeconds = await loadTaskTimeoutSeconds();
    let addedTotal = 0;
    let completedRounds = 0;
    try {
      do {
        const round = completedRounds + 1;
        let roundFailed = 0;
        let roundAdded = 0;
        await runConcurrentTasks(profileUrls, {
          concurrency: state.concurrency,
          shouldStop: () => control.stopRequested,
          worker: async (profileUrl, index) => {
            if (index >= state.concurrency) {
              await waitForProfileInterval(state, control, {
                onWait: (intervalMs) => {
                  state.notice = { tone: "info", text: `正在准备后续主页，随机等待 ${intervalMs} ms（范围 ${intervalSummary(state)}）…` };
                  saveState(state);
                  render();
                }
              });
            }
            if (control.stopRequested) return;
            const profileRecord = createRecord(control, profileUrl, round, index);
            const captureRunId = profileRecord.record.id;
            control.activeCaptureRunIds.add(captureRunId);
            state.notice = { tone: "info", text: `第 ${round} 轮，正在并发采集 ${control.activeCaptureRunIds.size}/${state.concurrency} 个博主主页…` };
            saveState(state);
            render();
            try {
              const response = await runWithTaskTimeout(() => sendMessage({
                type: MESSAGE_CAPTURE_XIAOHONGSHU_PROFILE,
                options: { runId: captureRunId, tabId: null, isolated: true, profileUrl, limit: state.limit }
              }), {
                timeoutSeconds: taskTimeoutSeconds,
                onTimeout: () => sendMessage({
                  type: MESSAGE_STOP_XIAOHONGSHU_PROFILE,
                  options: { runId: captureRunId }
                }).catch(() => null)
              });
              if (control.stopRequested) {
                finishRecord(profileRecord.record.id, profileRecord.startedAtMs, "stopped");
                return;
              }
              if (!response?.ok) throw new Error(response?.error || "小红书博主采集失败");
              const added = mergeDataRows(state, response.data, { runId: control.runId, recordId: profileRecord.record.id });
              roundAdded += added;
              addedTotal += added;
              finishRecord(profileRecord.record.id, profileRecord.startedAtMs, "success", response.data?.notes?.length || 0, added);
            } catch (error) {
              if (control.stopRequested) finishRecord(profileRecord.record.id, profileRecord.startedAtMs, "stopped");
              else {
                const errorText = error.message || String(error);
                roundFailed += 1;
                finishRecord(profileRecord.record.id, profileRecord.startedAtMs, "error", 0, 0, errorText);
                state.notice = { tone: "error", text: `博主主页采集失败：${errorText}` };
              }
            } finally {
              control.activeCaptureRunIds.delete(captureRunId);
              saveState(state);
              render();
            }
          }
        });
        if (control.stopRequested) break;
        completedRounds = round;
        if (!state.polling) {
          state.notice = { tone: roundFailed ? "warning" : "success", text: `运行结束：新增 ${addedTotal} 条数据，失败 ${roundFailed} 个主页。` };
          state.tab = addedTotal ? "data" : "records";
          break;
        }
        const pollingMs = state.pollingMinutes * 60 * 1000;
        state.notice = { tone: roundFailed ? "warning" : "success", text: `第 ${round} 轮完成，新增 ${roundAdded} 条；下一轮 ${formatTime(new Date(Date.now() + pollingMs))} 开始。` };
        saveState(state);
        render();
        await waitWhileRunning(pollingMs, control);
      } while (!control.stopRequested);

      if (control.stopRequested) {
        state.notice = { tone: "warning", text: `任务已停止，共完成 ${completedRounds} 轮，新增 ${addedTotal} 条数据。` };
        state.tab = "records";
      }
    } catch (error) {
      const errorText = error.message || String(error);
      state.notice = control.stopRequested ? { tone: "warning", text: `任务已停止，停止前新增 ${addedTotal} 条数据。` } : { tone: "error", text: errorText };
      state.tab = "records";
    } finally {
      await setFeatureRunning(FEATURE_KEY, false);
      if (activeProfileRun === control) activeProfileRun = null;
      if (activeRun === control) activeRun = null;
      state.running = false;
      state.stopping = false;
      saveState(state);
      render();
      globalThis.dispatchEvent?.(new Event(PROFILE_RUN_EVENT));
    }
  };

  const stopRun = async () => {
    const control = activeRun || activeProfileRun;
    if (!state.running || !control || control.stopRequested) return;
    control.stopRequested = true;
    state.stopping = true;
    state.notice = { tone: "warning", text: "正在停止全部并发任务并释放小红书页面连接…" };
    render();
    await Promise.all([...control.activeCaptureRunIds].map((runId) => (
      sendMessage({ type: MESSAGE_STOP_XIAOHONGSHU_PROFILE, options: { runId } }).catch(() => null)
    )));
  };

  const handleLiveRunFinished = async () => {
    if (activeProfileRun || !state.running) return;
    const latest = await loadSavedState().catch(() => null);
    state.running = false;
    state.stopping = false;
    state.records = limitProfileRecordsPerStatus(latest?.records || state.records, state.taskRecordsPerStatusLimit);
    state.dataRows = Array.isArray(latest?.dataRows)
      ? applyItemLimit(latest.dataRows, state.dataStorageLimit)
        .map((row) => ({ ...row, noteLikes: normalizeXiaohongshuLikes(row?.noteLikes ?? row?.likes) }))
      : state.dataRows;
    state.notice = latest?.notice || state.notice;
    render();
  };

  const handleClick = async (event) => {
    if (event.target.matches(".xhs-modal-backdrop")) {
      if (state.taskDetailRecordId) closeTaskDetails();
      else if (state.guideOpen) { state.guideOpen = false; render(); }
      else { state.batchOpen = false; render(); }
      return;
    }
    const tab = event.target.closest("[data-tab]");
    if (tab) { state.tab = tab.dataset.tab; render(); return; }
    const button = event.target.closest("[data-action]");
    if (!button || button.disabled) return;
    const action = button.dataset.action;
    if (await handleFeatureRunnerPanelAction(state.runnerPanel, action, {
      disabled: state.running,
      getParameters: () => buildProfileJsonParameters(state),
      onChange: render,
      onFinished: async () => {
        const latest = await loadSavedState().catch(() => null);
        state.records = limitProfileRecordsPerStatus(latest?.records || state.records, state.taskRecordsPerStatusLimit);
        state.dataRows = Array.isArray(latest?.dataRows)
          ? applyItemLimit(latest.dataRows, state.dataStorageLimit)
            .map((row) => ({ ...row, noteLikes: normalizeXiaohongshuLikes(row?.noteLikes ?? row?.likes) }))
          : state.dataRows;
        state.notice = latest?.notice || state.notice;
      }
    })) return;
    switch (action) {
      case "run": startRun().catch((error) => { state.running = false; state.stopping = false; activeRun = null; activeProfileRun = null; state.notice = { tone: "error", text: error.message || String(error) }; render(); }); break;
      case "stop": stopRun().catch((error) => { state.notice = { tone: "error", text: `停止任务失败：${error.message || String(error)}` }; render(); }); break;
      case "set-mode": {
        const nextMode = button.dataset.mode;
        if (nextMode !== "json" && state.mode === "json" && !applyJsonDraft()) { render(); break; }
        if (nextMode === "json") syncJsonDraft();
        if (nextMode === "runner") syncFeatureRunnerDraft(state.runnerPanel, buildProfileJsonParameters(state), { force: true });
        state.mode = nextMode;
        render();
        break;
      }
      case "apply-json": applyJsonDraft(); render(); break;
      case "toggle-options": state.optionsOpen = !state.optionsOpen; render(); break;
      case "toggle-page-parameters": state.pageParametersOpen = !state.pageParametersOpen; render(); break;
      case "toggle-data-filters": state.dataFiltersOpen = !state.dataFiltersOpen; render(); break;
      case "clear-data-filters": state.dataFilters = createDataFilterValues(DATA_FILTER_DEFINITIONS); render(); break;
      case "toggle-data-columns": state.dataColumnsOpen = !state.dataColumnsOpen; scheduleDataColumnRender(render); break;
      case "show-all-data-columns": state.dataColumnVisibility = showAllDataColumns(DATA_COLUMNS); saveState(state); scheduleDataColumnRender(render); break;
      case "set-input-list-page": state.inputListPage = clampInputListPage(button.dataset.page, state.profileUrls); render(); break;
      case "add-profile": state.profileUrls.push(""); state.inputListPage = pageForInputIndex(state.profileUrls.length - 1); render(); requestAnimationFrame(() => container.querySelector(`[data-profile-index="${state.profileUrls.length - 1}"]`)?.focus()); break;
      case "remove-profile": state.profileUrls.splice(Number(button.dataset.index), 1); state.inputListPage = clampInputListPage(state.inputListPage, state.profileUrls); saveState(state); render(); break;
      case "open-batch": state.batchDraft = state.profileUrls.filter(Boolean).join("\n"); state.guideOpen = false; state.batchOpen = true; render(); requestAnimationFrame(() => container.querySelector("[data-batch-input]")?.focus()); break;
      case "close-batch": state.batchOpen = false; render(); break;
      case "apply-batch": {
        const profileUrls = uniqueUrls(state.batchDraft.split(/[\n,，;；]+/));
        if (!profileUrls.length) { state.notice = { tone: "error", text: "批量列表中至少需要一个主页链接。" }; render(); break; }
        state.profileUrls = profileUrls;
        state.inputListPage = 1;
        state.batchOpen = false;
        state.notice = { tone: "success", text: `已应用 ${profileUrls.length} 个博主主页链接。` };
        saveState(state);
        render();
        break;
      }
      case "open-guide": state.batchOpen = false; state.guideOpen = true; render(); requestAnimationFrame(() => container.querySelector("[data-guide-autofocus]")?.focus()); break;
      case "close-guide": state.guideOpen = false; render(); break;
      case "open-task-detail": openTaskDetails(button.dataset.recordId); break;
      case "close-task-detail": closeTaskDetails(); break;
      case "clear-records": state.records = []; state.recordFilters = { profile: ALL_RECORD_FILTER, status: ALL_RECORD_FILTER, executionType: ALL_RECORD_FILTER }; state.taskDetailRecordId = ""; saveState(state); render(); break;
      case "clear-data": state.dataRows = []; state.dataFilters = createDataFilterValues(DATA_FILTER_DEFINITIONS); saveState(state); render(); break;
      case "copy-json": {
        const rows = filterDataRows(state.dataRows, DATA_FILTER_DEFINITIONS, state.dataFilters);
        try {
          openRowsJsonPreview(rows, (currentRows) => projectDataRowsByColumns(
            buildXiaohongshuProfileExportRows(currentRows), DATA_COLUMNS, state.dataColumnVisibility
          ));
        } catch (error) {
          state.notice = { tone: "error", text: `打开 JSON 数据失败：${error.message || String(error)}` };
          render();
        }
        break;
      }
      case "export-csv": {
        const rows = filterDataRows(state.dataRows, DATA_FILTER_DEFINITIONS, state.dataFilters);
        downloadDataRowsCsv(buildXiaohongshuProfileExportRows(rows), DATA_COLUMNS, state.dataColumnVisibility, "xiaohongshu-profile-notes-data");
        state.notice = { tone: "success", text: `已导出 ${rows.length} 条筛选后的表格数据（CSV）。` };
        render();
        break;
      }
      case "reset":
        state.profileUrls = [...DEFAULT_PROFILE_URLS];
        state.inputListPage = 1;
        state.limit = DEFAULT_OPTIONS.limit;
        state.concurrency = DEFAULT_OPTIONS.concurrency;
        state.intervalMinMs = DEFAULT_OPTIONS.intervalMinMs;
        state.intervalMaxMs = DEFAULT_OPTIONS.intervalMaxMs;
        state.forceUpdateData = DEFAULT_OPTIONS.forceUpdateData;
        state.polling = DEFAULT_OPTIONS.polling;
        state.pollingMinutes = DEFAULT_OPTIONS.pollingMinutes;
        state.optionsOpen = false;
        state.pageParametersOpen = false;
        state.notice = { tone: "success", text: "已还原主页输入与基础运行选项。" };
        syncJsonDraft();
        saveState(state);
        render();
        break;
      default: break;
    }
  };

  const handleInput = (event) => {
    if (event.target.matches("[data-runner-json-input]")) { updateFeatureRunnerDraft(state.runnerPanel, event.target.value); return; }
    const dataFilter = event.target.dataset.dataFilter;
    if (dataFilter && event.target.tagName === "INPUT") {
      const selectionStart = event.target.selectionStart;
      state.dataFilters[dataFilter] = event.target.value;
      render();
      requestAnimationFrame(() => {
        const input = container.querySelector(`[data-data-filter="${dataFilter}"]`);
        input?.focus();
        input?.setSelectionRange?.(selectionStart, selectionStart);
      });
      return;
    }
    if (event.target.matches("[data-json-input]")) { state.jsonDraft = event.target.value; return; }
    if (event.target.dataset.profileIndex !== undefined) state.profileUrls[Number(event.target.dataset.profileIndex)] = event.target.value;
    if (event.target.matches("[data-batch-input]")) state.batchDraft = event.target.value;
    const field = event.target.dataset.field;
    if (field === "limit") state.limit = asInteger(event.target.value, state.limit, 1, 100);
    if (field === "concurrency") state.concurrency = normalizeTaskConcurrency(event.target.value, state.concurrency);
    if (field === "intervalMinMs") state.intervalMinMs = asInteger(event.target.value, state.intervalMinMs, 100, 6000);
    if (field === "intervalMaxMs") state.intervalMaxMs = asInteger(event.target.value, state.intervalMaxMs, 100, 6000);
    if (field === "pollingMinutes") state.pollingMinutes = asInteger(event.target.value, state.pollingMinutes, 1, 1440);
  };
  const handleChange = (event) => {
    const dataColumn = event.target.dataset.dataColumn;
    if (dataColumn) {
      state.dataColumnVisibility[dataColumn] = event.target.checked;
      state.dataColumnVisibility = createDataColumnVisibility(DATA_COLUMNS, state.dataColumnVisibility);
      saveState(state);
      scheduleDataColumnRender(render);
      return;
    }
    const dataFilter = event.target.dataset.dataFilter;
    if (dataFilter) { state.dataFilters[dataFilter] = event.target.value; render(); return; }
    const recordFilter = event.target.dataset.recordFilter;
    if (recordFilter) { state.recordFilters[recordFilter] = event.target.value; render(); return; }
    const field = event.target.dataset.field;
    if (field === "intervalMinMs" || field === "intervalMaxMs") Object.assign(state, normalizeProfileIntervalRange(state));
    if (field === "forceUpdateData") state.forceUpdateData = event.target.checked;
    if (field === "polling") state.polling = event.target.checked;
    if (["limit", "concurrency", "intervalMinMs", "intervalMaxMs", "forceUpdateData", "polling", "pollingMinutes"].includes(field)) { saveState(state); render(); }
  };
  const handleKeydown = (event) => {
    if (event.key !== "Escape") return;
    if (state.taskDetailRecordId) closeTaskDetails();
    else if (state.guideOpen) { state.guideOpen = false; render(); }
    else if (state.batchOpen) { state.batchOpen = false; render(); }
  };

  syncFeatureRunnerDraft(state.runnerPanel, buildProfileJsonParameters(state));
  const unsubscribeRunner = subscribeFeatureRunnerPanel(state.runnerPanel, render, async () => {
    const latest = await loadSavedState().catch(() => null);
    state.records = limitProfileRecordsPerStatus(latest?.records || state.records, state.taskRecordsPerStatusLimit);
    state.dataRows = Array.isArray(latest?.dataRows)
      ? applyItemLimit(latest.dataRows, state.dataStorageLimit)
        .map((row) => ({ ...row, noteLikes: normalizeXiaohongshuLikes(row?.noteLikes ?? row?.likes) }))
      : state.dataRows;
    state.notice = latest?.notice || state.notice;
  }, async () => {
    const latest = await loadSavedState().catch(() => null);
    state.records = limitProfileRecordsPerStatus(latest?.records || state.records, state.taskRecordsPerStatusLimit);
  });
  container.addEventListener("click", handleClick);
  container.addEventListener("input", handleInput);
  container.addEventListener("change", handleChange);
  document.addEventListener("keydown", handleKeydown);
  globalThis.addEventListener?.(PROFILE_RUN_EVENT, handleLiveRunFinished);
  render();
  return () => {
    // Do not stop the task here: navigating back to the feature list must not
    // terminate a running collection. The visible monitor can reconnect to it.
    disposed = true;
    container.removeEventListener("click", handleClick);
    container.removeEventListener("input", handleInput);
    container.removeEventListener("change", handleChange);
    document.removeEventListener("keydown", handleKeydown);
    globalThis.removeEventListener?.(PROFILE_RUN_EVENT, handleLiveRunFinished);
    unsubscribeRunner();
    container.replaceChildren();
  };
}

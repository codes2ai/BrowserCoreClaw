import {
  filterProfileRecords,
  limitProfileRecordsPerStatus,
  normalizeProfileIntervalRange,
  updateProfileRecord,
  waitForProfileInterval
} from "../xiaohongshu/profile-notes/monitor.js";
import { getTaskId, getTaskRecordDetails, renderTaskDetailModal, tagTaskDataRow } from "../../shared/task-detail.js";
import {
  DEFAULT_TASK_CONCURRENCY,
  MAX_TASK_CONCURRENCY,
  normalizeTaskConcurrency,
  runConcurrentTasks
} from "../../shared/concurrent-task-pool.js";
import { buildFeatureKey, setFeatureRunning } from "../../shared/feature-run-status.js";
import { loadTaskTimeoutSeconds, runWithTaskTimeout } from "../../shared/task-timeout.js";
import {
  applyItemLimit,
  formatLimitValue,
  loadGlobalStorageLimits
} from "../../shared/storage-limits.js";
import {
  DEFAULT_EXECUTION_INTERVAL_MAX_MS,
  DEFAULT_EXECUTION_INTERVAL_MIN_MS,
  migrateLegacyExecutionInterval
} from "../../shared/execution-interval.js";
import {
  clampInputListPage,
  pageForInputIndex,
  paginateInputList,
  renderInputListPagination
} from "../../shared/input-list-pagination.js";
import {
  createDataFilterValues,
  filterDataRows,
  openRowsJsonPreview,
  renderDataFilterPanel
} from "../../shared/data-table-filter.js";

const ALL_RECORD_FILTER = "__all__";
const STATUS = Object.freeze({
  running: { label: "运行中", tone: "running" },
  success: { label: "完成", tone: "success" },
  error: { label: "失败", tone: "error" },
  stopped: { label: "已停止", tone: "stopped" }
});
const DEFAULT_OPTIONS = Object.freeze({ limit: 20, intervalMinMs: DEFAULT_EXECUTION_INTERVAL_MIN_MS, intervalMaxMs: DEFAULT_EXECUTION_INTERVAL_MAX_MS, concurrency: DEFAULT_TASK_CONCURRENCY, polling: false, pollingMinutes: 10 });
const activeRuns = new Map();

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function asInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function uniqueUrls(values) {
  return Array.from(new Set((Array.isArray(values) ? values : []).map((value) => String(value || "").trim()).filter(Boolean)));
}

function isWeiboProfileUrl(value) {
  try {
    const url = new URL(value);
    return /(^|\.)weibo\.com$/i.test(url.hostname) && /^\/u\/\d+\/?$/i.test(url.pathname);
  } catch { return false; }
}

function formatTime(date = new Date()) {
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(date);
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "-";
  return milliseconds < 1000 ? `${milliseconds} ms` : `${(milliseconds / 1000).toFixed(milliseconds < 10000 ? 1 : 0)} 秒`;
}

function wait(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
async function waitWhileRunning(milliseconds, control) {
  const deadline = Date.now() + milliseconds;
  while (!control.stopRequested && Date.now() < deadline) await wait(Math.min(100, deadline - Date.now()));
}

function isExtensionRuntime() { return Boolean(globalThis.chrome?.runtime?.id && chrome.runtime?.sendMessage && chrome.tabs?.query); }
function callChrome(callbackApi) {
  return new Promise((resolve, reject) => callbackApi((result) => {
    const error = chrome.runtime.lastError;
    if (error) reject(new Error(error.message)); else resolve(result);
  }));
}
function sendMessage(message) { return callChrome((done) => chrome.runtime.sendMessage(message, done)); }

export function createWeiboProfileMonitor(settings) {
  const platformName = settings.platformName || "微博";
  const runPrefix = settings.runPrefix || "WB";
  const runScope = settings.runScope || settings.kind;
  const eventName = `browser-core-claw-${settings.platformId || "weibo"}-${settings.kind}-finished`;
  const defaultUrls = [""];
  const rowLabel = settings.rowLabel || (settings.kind === "posts" ? "博文" : "资料");
  const hasLimit = Boolean(settings.hasLimit ?? settings.kind === "posts");
  const supportsPolling = settings.supportsPolling !== false;
  const featureId = settings.featureId || (settings.kind === "posts" ? "profile-posts" : settings.kind === "info" ? "profile-info" : settings.kind);
  const featureKey = buildFeatureKey(settings.platformId || "weibo", featureId);
  const subjectLabel = settings.subjectLabel || "博主主页";
  const inputPlaceholder = settings.inputPlaceholder || "https://weibo.com/u/数字ID";
  const validTargetUrl = settings.validateTargetUrl || isWeiboProfileUrl;
  const targetOptionKey = settings.targetOptionKey || "profileUrl";
  const dataFilterDefinitions = Object.freeze(Array.isArray(settings.dataFilters) ? [...settings.dataFilters] : []);
  const buildExportRows = typeof settings.buildExportRows === "function" ? settings.buildExportRows : (rows) => rows;

  const loadSavedState = async () => {
    if (!isExtensionRuntime() || !chrome.storage?.local) return null;
    const values = await callChrome((done) => chrome.storage.local.get(settings.storageKey, done));
    return values?.[settings.storageKey] || null;
  };
  const saveState = (state) => {
    if (!isExtensionRuntime() || !chrome.storage?.local) return;
    const config = {
      limit: state.limit,
      concurrency: normalizeTaskConcurrency(state.concurrency),
      ...normalizeProfileIntervalRange(state)
    };
    if (supportsPolling) {
      config.polling = Boolean(state.polling);
      config.pollingMinutes = asInteger(state.pollingMinutes, DEFAULT_OPTIONS.pollingMinutes, 1, 1440);
    }
    chrome.storage.local.set({
      [settings.storageKey]: {
        profileUrls: uniqueUrls(state.profileUrls),
        config,
        records: limitProfileRecordsPerStatus(state.records, state.taskRecordsPerStatusLimit),
        dataRows: applyItemLimit(state.dataRows, state.dataStorageLimit),
        notice: state.notice
      }
    }).catch(() => {});
  };
  const renderStatus = (record) => `<span class="xhs-table-status ${escapeHtml(record.tone || "running")}">${escapeHtml(record.status || "运行中")}</span>`;
  const intervalSummary = (state) => {
    const range = normalizeProfileIntervalRange(state);
    return `${range.intervalMinMs} - ${range.intervalMaxMs} ms`;
  };
  const renderRunButton = (state, className = "") => state.running
    ? `<button class="xhs-stop-button ${className}" type="button" data-action="stop" ${state.stopping ? "disabled" : ""}>${state.stopping ? "停止中…" : "停止全部"}</button>`
    : `<button class="xhs-primary-button ${className}" type="button" data-action="run">运行</button>`;
  const renderTabs = (state) => [["params", "运行参数"], ["records", `运行记录(${state.records.length})`], ["data", `数据(${state.dataRows.length})`]]
    .map(([id, label]) => `<button class="xhs-tab ${state.tab === id ? "active" : ""}" type="button" role="tab" aria-selected="${state.tab === id}" data-tab="${id}">${label}</button>`).join("");
  const renderProfileRows = (state, pagination) => pagination.items.map(({ value: url, index }) => `<div class="xhs-keyword-row"><span class="xhs-row-index">${index + 1}</span><label class="xhs-keyword-input"><span class="sr-only">第 ${index + 1} 个${escapeHtml(subjectLabel)}</span><input type="url" value="${escapeHtml(url)}" placeholder="${escapeHtml(inputPlaceholder)}" data-profile-index="${index}" ${state.running ? "disabled" : ""}></label><button class="xhs-remove-button" type="button" data-action="remove-profile" data-index="${index}" aria-label="删除第 ${index + 1} 个${escapeHtml(subjectLabel)}" ${state.profileUrls.length === 1 || state.running ? "disabled" : ""}>X</button></div>`).join("");
  const renderOptions = (state) => {
    const disabled = state.running ? "disabled" : "";
    const optionSubtitle = supportsPolling
      ? (hasLimit ? "结果数量、并发任务、随机执行间隔与循环监控" : "并发任务、随机执行间隔与循环监控")
      : (hasLimit ? "结果数量、并发任务与随机执行间隔" : "并发任务与随机执行间隔");
    const resultSummary = hasLimit
      ? `<span><small>${escapeHtml(settings.limitLabel || "每任务结果数")}</small><strong>${state.limit}</strong></span>`
      : `<span><small>${escapeHtml(settings.singleResultLabel || "每任务资料数")}</small><strong>1</strong></span>`;
    const limitControl = hasLimit ? `<label class="xhs-control"><span>${escapeHtml(settings.limitLabel || "每任务结果数")}</span><input type="number" min="1" max="100" value="${state.limit}" data-field="limit" ${disabled}><small>${escapeHtml(settings.limitHelp || "默认 20 条，保留页面原始顺序。")}</small></label>` : "";
    const pollingSummary = supportsPolling ? `<span><small>循环监控</small><strong>${state.polling ? `${state.pollingMinutes} 分钟` : "关闭"}</strong></span>` : "";
    const pollingControls = supportsPolling ? `<div class="xhs-polling-row"><label class="xhs-switch-control"><input type="checkbox" data-field="polling" ${state.polling ? "checked" : ""} ${disabled}><span><strong>循环监控</strong><small>每轮任务完成后按设定周期再次执行，直到手动停止。</small></span></label><label class="xhs-control compact ${state.polling ? "" : "is-disabled"}"><span>轮询周期</span><div class="xhs-input-with-unit"><input type="number" min="1" max="1440" value="${state.pollingMinutes}" data-field="pollingMinutes" ${state.polling && !state.running ? "" : "disabled"}><span>分钟</span></div></label></div>` : "";
    const concurrencyControl = `<label class="xhs-control"><span>并发任务数</span><input type="number" min="1" max="${MAX_TASK_CONCURRENCY}" value="${state.concurrency}" data-field="concurrency" ${disabled}><small>同时采集 ${state.concurrency} 个${escapeHtml(subjectLabel)}；设为 1 时按顺序执行，最多 ${MAX_TASK_CONCURRENCY} 个。</small></label>`;
    return `<section class="xhs-options-card"><button class="xhs-options-header" type="button" data-action="toggle-options" aria-expanded="${state.optionsOpen}"><span aria-hidden="true">⌄</span><span class="xhs-options-title"><strong>运行选项</strong><small>${optionSubtitle}</small></span><span class="xhs-option-summary">${resultSummary}<span><small>并发任务</small><strong>${state.concurrency}</strong></span><span><small>执行间隔</small><strong>${intervalSummary(state)}</strong></span>${pollingSummary}</span><span class="xhs-options-toggle-label">${state.optionsOpen ? "收起选项" : "展开选项"}</span></button>${state.optionsOpen ? `<div class="xhs-options-body"><p class="xhs-options-note">${settings.optionsNote || (hasLimit ? "每个输入链接都是独立任务；并发任务使用独立标签页，博文不足设定数量时以页面实际数量为准。" : `每个${subjectLabel}只读取一条公开资料，并发任务使用独立标签页。`)}</p><div class="xhs-options-grid">${limitControl}${concurrencyControl}<label class="xhs-control"><span>${escapeHtml(subjectLabel)}执行间隔</span><div class="xhs-range-inputs"><div class="xhs-input-with-unit"><input type="number" min="100" max="6000" step="50" value="${state.intervalMinMs}" data-field="intervalMinMs" ${disabled}><span>ms</span></div><span class="xhs-range-separator">-</span><div class="xhs-input-with-unit"><input type="number" min="100" max="6000" step="50" value="${state.intervalMaxMs}" data-field="intervalMaxMs" ${disabled}><span>ms</span></div></div><small>启动后续任务时，在 ${intervalSummary(state)} 内随机等待。</small></label></div>${pollingControls}</div>` : ""}</section>`;
  };
  const renderParameters = (state) => {
    const pagination = paginateInputList(state.profileUrls, state.inputListPage);
    return `<section class="xhs-parameter-card"><div class="xhs-field-heading"><div><label>${escapeHtml(settings.inputLabel || `${platformName}博主主页链接`)}</label><p>${settings.inputDescription || (hasLimit ? "每个主页链接独立采集公开博文，不包含关键词搜索或额外筛选条件。" : `每个主页链接独立采集公开资料；无需先登录${platformName}。`)}</p></div><span>${state.profileUrls.filter(Boolean).length} 个${escapeHtml(subjectLabel)}</span></div><div class="xhs-keyword-list xhs-profile-list">${renderProfileRows(state, pagination)}</div>${renderInputListPagination(pagination, { itemLabel: `个${subjectLabel}` })}<div class="xhs-inline-actions"><button class="xhs-secondary-button emphasized" type="button" data-action="add-profile" ${state.running ? "disabled" : ""}>＋ 添加${escapeHtml(subjectLabel)}</button><button class="xhs-secondary-button" type="button" data-action="open-batch" ${state.running ? "disabled" : ""}>批量编辑</button></div><p class="xhs-profile-init-note"><strong>采集链路：</strong>${settings.pipelineText}</p></section>${renderOptions(state)}`;
  };
  const renderRecords = (state) => {
    const records = filterProfileRecords(state.records, state.recordFilters);
    const profiles = Array.from(new Set(state.records.map((record) => record.keyword).filter(Boolean)));
    return `<section class="xhs-content-card xhs-table-page"><div class="xhs-panel-head"><div><h2>运行记录</h2><p>每个${escapeHtml(subjectLabel)}独立记录；每一种状态最多保留 ${formatLimitValue(state.taskRecordsPerStatusLimit)}。</p></div></div><div class="xhs-record-filters"><label class="xhs-filter-control"><span>${escapeHtml(subjectLabel)}</span><select data-record-filter="profile"><option value="${ALL_RECORD_FILTER}">全部${escapeHtml(subjectLabel)}</option>${profiles.map((url) => `<option value="${escapeHtml(url)}" ${state.recordFilters.profile === url ? "selected" : ""}>${escapeHtml(url)}</option>`).join("")}</select></label><label class="xhs-filter-control"><span>状态</span><select data-record-filter="status"><option value="${ALL_RECORD_FILTER}">全部状态</option>${Object.entries(STATUS).map(([key, meta]) => `<option value="${key}" ${state.recordFilters.status === key ? "selected" : ""}>${meta.label}</option>`).join("")}</select></label><span class="xhs-filter-result">显示 ${records.length} / ${state.records.length} 条</span></div><div class="xhs-table-shell records" tabindex="0"><table class="xhs-table"><thead><tr><th>任务编号</th><th>开始时间</th><th>${escapeHtml(subjectLabel)}</th><th>轮次</th><th>状态</th><th>${rowLabel}数</th><th>耗时</th></tr></thead><tbody>${records.length ? records.map((record) => `<tr><td><button class="xhs-task-id-button" type="button" data-action="open-task-detail" data-record-id="${escapeHtml(record.id)}"><code>${escapeHtml(getTaskId(record))}</code></button></td><td>${escapeHtml(record.startedAt)}</td><td class="xhs-profile-url-cell" title="${escapeHtml(record.keyword)}">${escapeHtml(record.keyword)}</td><td>${escapeHtml(record.round)}</td><td title="${escapeHtml(record.error || "")}">${renderStatus(record)}</td><td>${record.resultCount}</td><td>${escapeHtml(record.duration)}</td></tr>`).join("") : `<tr><td class="xhs-table-empty" colspan="7">${state.records.length ? "没有符合筛选条件的记录" : "暂无运行记录"}</td></tr>`}</tbody></table></div></section>`;
  };
  const renderData = (state) => {
    const filteredRows = filterDataRows(state.dataRows, dataFilterDefinitions, state.dataFilters);
    const emptyText = state.dataRows.length ? "没有符合筛选条件的数据" : settings.emptyDataText;
    return `<section class="xhs-content-card xhs-table-page"><div class="xhs-panel-head"><div><h2>数据</h2><p>共 ${state.dataRows.length} 条，最多保留 ${formatLimitValue(state.dataStorageLimit)}；${settings.dataSummary}</p></div></div>${renderDataFilterPanel({ rows: state.dataRows, definitions: dataFilterDefinitions, values: state.dataFilters, expanded: state.dataFiltersOpen, escapeHtml })}<div class="xhs-table-shell data" tabindex="0"><table class="xhs-table xhs-data-table">${settings.renderDataTable(filteredRows, escapeHtml, { emptyText })}</table></div></section>`;
  };
  const renderBatch = (state) => state.batchOpen ? `<div class="xhs-modal-backdrop" data-modal="batch"><section class="xhs-batch-modal" role="dialog" aria-modal="true" aria-labelledby="weiboBatchTitle"><header><div><span>BATCH EDIT</span><h2 id="weiboBatchTitle">批量编辑${escapeHtml(subjectLabel)}</h2></div><button class="xhs-modal-close" type="button" data-action="close-batch" aria-label="关闭">X</button></header><p>${settings.batchDescription || `每行一个${subjectLabel}链接（<code>${escapeHtml(inputPlaceholder)}</code>）；应用后会替换当前列表。`}</p><textarea data-batch-input rows="10">${escapeHtml(state.batchDraft)}</textarea><footer><button class="xhs-secondary-button" type="button" data-action="close-batch">取消</button><button class="xhs-primary-button" type="button" data-action="apply-batch">应用链接</button></footer></section></div>` : "";
  const renderGuide = (state) => state.guideOpen ? `<div class="xhs-modal-backdrop" data-modal="guide"><section class="xhs-batch-modal xhs-guide-modal" role="dialog" aria-modal="true" aria-labelledby="profileGuideTitle"><header><div><span>QUICK START</span><h2 id="profileGuideTitle">使用说明</h2></div><button class="xhs-modal-close" type="button" data-action="close-guide" data-guide-autofocus aria-label="关闭">X</button></header><div class="xhs-guide"><p class="xhs-guide-intro">${settings.guideIntro}</p><ol><li><strong>填写${escapeHtml(subjectLabel)}</strong><span>${settings.guideInputText || `输入一个或多个${platformName}${subjectLabel}链接。`}</span></li><li><strong>等待稳定</strong><span>${settings.guideWaitText || "程序会打开链接，连续确认页面数据稳定后才开始读取。"}</span></li><li><strong>查看与导出</strong><span>每个${escapeHtml(subjectLabel)}会生成一条运行记录；数据支持筛选、复制 JSON 和导出 CSV 表格。</span></li></ol><div class="xhs-schema-box"><strong>采集字段</strong><code>${settings.fieldList}</code></div></div><footer><button class="xhs-primary-button" type="button" data-action="close-guide">知道了</button></footer></section></div>` : "";
  const renderTask = (state) => state.taskDetailRecordId ? renderTaskDetailModal({ detail: getTaskRecordDetails(state.records, state.taskDetailRecordId), prefix: "xhs", featureName: settings.featureName, detailTitle: `${settings.featureName}任务明细`, subjectLabel, escapeHtml, renderStatus }) : "";
  const renderAction = (state) => {
    if (state.tab === "params") return `<footer class="xhs-action-bar">${renderRunButton(state)}<button class="xhs-secondary-button" type="button" data-action="reset" ${state.running ? "disabled" : ""}>还原输入</button><span>${state.running ? "任务运行中，参数已锁定；可以停止任务。" : settings.idleActionText}</span></footer>`;
    if (state.tab === "records") return `<footer class="xhs-action-bar xhs-table-action-bar"><button class="xhs-secondary-button" type="button" data-action="clear-records" ${state.records.length && !state.running ? "" : "disabled"}>清空记录</button><span>当前 ${state.records.length} 条 · 每种状态最多保留 ${formatLimitValue(state.taskRecordsPerStatusLimit)}</span></footer>`;
    const filteredRows = filterDataRows(state.dataRows, dataFilterDefinitions, state.dataFilters);
    return `<footer class="xhs-action-bar xhs-table-action-bar"><button class="xhs-secondary-button emphasized" type="button" data-action="copy-json" ${filteredRows.length ? "" : "disabled"}>复制 JSON</button><button class="xhs-secondary-button emphasized" type="button" data-action="export-csv" ${filteredRows.length ? "" : "disabled"}>导出表格</button><button class="xhs-secondary-button" type="button" data-action="clear-data" ${state.dataRows.length && !state.running ? "" : "disabled"}>清空数据</button><span>筛选结果 ${filteredRows.length} / ${state.dataRows.length} 条 · 最多保留 ${formatLimitValue(state.dataStorageLimit)}</span></footer>`;
  };
  const renderPage = (state, context) => `<section class="xhs-monitor has-fixed-actions" aria-labelledby="profileMonitorTitle"><header class="xhs-hero"><div class="xhs-title-row"><h1 id="profileMonitorTitle">${escapeHtml(context.feature.name)}</h1><span class="xhs-version">v0.1.0</span><button class="xhs-guide-button" type="button" data-action="open-guide" title="查看使用说明"><span>使用说明</span><img src="src/assets/icons/question-circle.svg" alt=""></button></div>${renderRunButton(state, "xhs-top-run")}</header><nav class="xhs-tabs" role="tablist">${renderTabs(state)}</nav><div class="xhs-notice ${escapeHtml(state.notice.tone)}" role="status">${escapeHtml(state.notice.text)}</div><div class="xhs-workspace has-fixed-actions ${state.tab === "params" ? "" : "is-table-view"}">${state.tab === "params" ? renderParameters(state) : state.tab === "records" ? renderRecords(state) : renderData(state)}</div>${renderAction(state)}${renderBatch(state)}${renderGuide(state)}${renderTask(state)}</section>`;

  return async function mountWeiboProfileMonitor(container, context) {
    const storageLimits = await loadGlobalStorageLimits().catch(() => ({ dataStorageLimit: 3000, taskRecordsPerStatusLimit: 200 }));
    const saved = await loadSavedState().catch(() => null);
    const savedConfig = migrateLegacyExecutionInterval(saved?.config || {}, {
      legacyMinMs: 100,
      legacyMaxMs: 6000
    });
    const savedRange = normalizeProfileIntervalRange(savedConfig);
    const state = {
      tab: "params", profileUrls: Array.isArray(saved?.profileUrls) && saved.profileUrls.length ? saved.profileUrls : [...defaultUrls], inputListPage: 1, dataStorageLimit: storageLimits.dataStorageLimit, taskRecordsPerStatusLimit: storageLimits.taskRecordsPerStatusLimit, records: limitProfileRecordsPerStatus(saved?.records, storageLimits.taskRecordsPerStatusLimit), dataRows: applyItemLimit(saved?.dataRows, storageLimits.dataStorageLimit), batchOpen: false, batchDraft: "", guideOpen: false, taskDetailRecordId: "", limit: asInteger(savedConfig.limit, DEFAULT_OPTIONS.limit, 1, 100), concurrency: normalizeTaskConcurrency(savedConfig.concurrency), intervalMinMs: savedRange.intervalMinMs, intervalMaxMs: savedRange.intervalMaxMs, polling: supportsPolling && Boolean(savedConfig.polling), pollingMinutes: asInteger(savedConfig.pollingMinutes, DEFAULT_OPTIONS.pollingMinutes, 1, 1440), optionsOpen: false, running: Boolean(activeRuns.get(runScope) && !activeRuns.get(runScope).stopRequested), stopping: false, recordFilters: { profile: ALL_RECORD_FILTER, status: ALL_RECORD_FILTER }, dataFilters: createDataFilterValues(dataFilterDefinitions), dataFiltersOpen: true, notice: saved?.notice || { tone: "info", text: settings.initialNotice }
    };
    saveState(state);
    let disposed = false;
    let activeRun = activeRuns.get(runScope) || null;
    const render = () => { if (!disposed) container.innerHTML = renderPage(state, context); };
    const finishRecord = (id, startedAtMs, statusKey, resultCount = 0, error = "") => {
      const meta = STATUS[statusKey] || STATUS.error;
      state.records = updateProfileRecord(state.records, id, { status: meta.label, statusKey, tone: meta.tone, resultCount: Number(resultCount) || 0, error, duration: formatDuration(Date.now() - startedAtMs) }, state.taskRecordsPerStatusLimit);
    };
    const createRecord = (control, profileUrl, round, index) => {
      const startedAtMs = Date.now();
      const record = { id: `${control.runId}-R${round}-P${index + 1}`, runId: control.runId, startedAt: formatTime(new Date(startedAtMs)), keyword: profileUrl, round, status: STATUS.running.label, statusKey: "running", tone: "running", resultCount: 0, duration: "-", error: "" };
      state.records = limitProfileRecordsPerStatus([record, ...state.records], state.taskRecordsPerStatusLimit);
      return { record, startedAtMs };
    };
    const mergeRows = (data, task, profileUrl) => {
      const rows = settings.toRows(data, profileUrl);
      const existing = new Map(state.dataRows.map((row) => [row.id, row]));
      let added = 0;
      for (const row of rows) {
        if (!row?.id) continue;
        if (!existing.has(row.id)) added += 1;
        existing.set(row.id, { ...existing.get(row.id), ...tagTaskDataRow(row, task) });
      }
      const ordered = [...rows.map((row) => existing.get(row.id)).filter(Boolean), ...state.dataRows.filter((row) => !rows.some((next) => next.id === row.id))];
      state.dataRows = applyItemLimit(ordered, state.dataStorageLimit);
      return { added, count: rows.length };
    };
    const startRun = async () => {
      if (state.running) return;
      if (!isExtensionRuntime()) { state.notice = { tone: "error", text: `${platformName}采集只能在已加载扩展的 Chrome 控制台中运行。` }; render(); return; }
      const profileUrls = uniqueUrls(state.profileUrls);
      if (!profileUrls.length) { state.notice = { tone: "error", text: `请至少填写一个${platformName}${subjectLabel}链接。` }; render(); return; }
      const invalidUrl = profileUrls.find((url) => !validTargetUrl(url));
      if (invalidUrl) { state.notice = { tone: "error", text: `${subjectLabel}链接格式不正确：${invalidUrl}` }; render(); return; }
      state.profileUrls = profileUrls;
      const control = {
        runId: `${runPrefix}-${String(Date.now()).slice(-8)}`,
        stopRequested: false,
        activeCaptureRunIds: new Set()
      };
      activeRun = control; activeRuns.set(runScope, control); state.running = true; state.stopping = false;
      state.notice = { tone: "info", text: `正在准备 ${profileUrls.length} 个${platformName}${subjectLabel}…` }; saveState(state); render();
      await setFeatureRunning(featureKey, true);
      const taskTimeoutSeconds = await loadTaskTimeoutSeconds();
      let addedTotal = 0; let completedRounds = 0;
      try {
        do {
          const round = completedRounds + 1; let failed = 0;
          await runConcurrentTasks(profileUrls, {
            concurrency: state.concurrency,
            shouldStop: () => control.stopRequested,
            worker: async (profileUrl, index) => {
              if (index >= state.concurrency) {
                await waitForProfileInterval(state, control, {
                  onWait: (milliseconds) => {
                    state.notice = { tone: "info", text: `正在准备后续${subjectLabel}，随机等待 ${milliseconds} ms…` };
                    saveState(state);
                    render();
                  }
                });
              }
              if (control.stopRequested) return;

              const current = createRecord(control, profileUrl, round, index);
              const captureRunId = current.record.id;
              control.activeCaptureRunIds.add(captureRunId);
              state.notice = { tone: "info", text: `第 ${round} 轮，正在并发采集 ${control.activeCaptureRunIds.size}/${state.concurrency} 个${subjectLabel}…` };
              saveState(state);
              render();
              try {
                const response = await runWithTaskTimeout(() => sendMessage({
                  type: settings.captureMessage,
                  options: {
                    runId: captureRunId,
                    tabId: null,
                    isolated: true,
                    [targetOptionKey]: profileUrl,
                    ...(hasLimit ? { limit: state.limit } : {})
                  }
                }), {
                  timeoutSeconds: taskTimeoutSeconds,
                  onTimeout: () => sendMessage({
                    type: settings.stopMessage,
                    options: { runId: captureRunId }
                  }).catch(() => null)
                });
                if (control.stopRequested) {
                  finishRecord(current.record.id, current.startedAtMs, "stopped");
                  return;
                }
                if (!response?.ok) throw new Error(response?.error || `${settings.featureName}失败`);
                const result = mergeRows(response.data, { runId: control.runId, recordId: current.record.id }, profileUrl);
                addedTotal += result.added;
                finishRecord(current.record.id, current.startedAtMs, "success", result.count);
              } catch (error) {
                if (control.stopRequested) finishRecord(current.record.id, current.startedAtMs, "stopped");
                else {
                  failed += 1;
                  const message = error.message || String(error);
                  finishRecord(current.record.id, current.startedAtMs, "error", 0, message);
                  state.notice = { tone: "error", text: `${subjectLabel}采集失败：${message}` };
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
          if (!supportsPolling || !state.polling) { state.notice = { tone: failed ? "warning" : "success", text: `运行结束：新增 ${addedTotal} 条${rowLabel}数据，失败 ${failed} 个主页。` }; state.tab = addedTotal ? "data" : "records"; break; }
          const pollingMs = state.pollingMinutes * 60 * 1000;
          state.notice = { tone: failed ? "warning" : "success", text: `第 ${round} 轮完成；下一轮 ${formatTime(new Date(Date.now() + pollingMs))} 开始。` }; saveState(state); render(); await waitWhileRunning(pollingMs, control);
        } while (!control.stopRequested);
        if (control.stopRequested) { state.notice = { tone: "warning", text: `任务已停止，共完成 ${completedRounds} 轮，新增 ${addedTotal} 条${rowLabel}数据。` }; state.tab = "records"; }
      } catch (error) {
        const message = error.message || String(error);
        state.notice = control.stopRequested ? { tone: "warning", text: "任务已停止。" } : { tone: "error", text: message }; state.tab = "records";
      } finally {
        await setFeatureRunning(featureKey, false);
        if (activeRuns.get(runScope) === control) activeRuns.delete(runScope);
        if (activeRun === control) activeRun = null;
        state.running = false; state.stopping = false; saveState(state); render(); globalThis.dispatchEvent?.(new Event(eventName));
      }
    };
    const stopRun = async () => {
      const control = activeRun || activeRuns.get(runScope);
      if (!state.running || !control || control.stopRequested) return;
      control.stopRequested = true; state.stopping = true; state.notice = { tone: "warning", text: `正在停止全部并发任务并释放${platformName}页面连接…` }; render();
      await Promise.all([...control.activeCaptureRunIds].map((runId) => (
        sendMessage({ type: settings.stopMessage, options: { runId } }).catch(() => null)
      )));
    };
    const handleLiveRunFinished = async () => {
      if (activeRuns.get(runScope) || !state.running) return;
      const latest = await loadSavedState().catch(() => null);
      state.running = false; state.stopping = false; state.records = limitProfileRecordsPerStatus(latest?.records || state.records, state.taskRecordsPerStatusLimit); state.dataRows = Array.isArray(latest?.dataRows) ? applyItemLimit(latest.dataRows, state.dataStorageLimit) : state.dataRows; state.notice = latest?.notice || state.notice; render();
    };
    const closeModal = () => { state.taskDetailRecordId = ""; state.batchOpen = false; state.guideOpen = false; render(); };
    const handleClick = async (event) => {
      if (event.target.matches(".xhs-modal-backdrop")) { closeModal(); return; }
      const tab = event.target.closest("[data-tab]"); if (tab) { state.tab = tab.dataset.tab; render(); return; }
      const button = event.target.closest("[data-action]"); if (!button || button.disabled) return;
      switch (button.dataset.action) {
        case "run": startRun().catch((error) => { activeRun = null; activeRuns.delete(runScope); state.running = false; state.stopping = false; state.notice = { tone: "error", text: error.message || String(error) }; render(); }); break;
        case "stop": stopRun().catch((error) => { state.notice = { tone: "error", text: `停止任务失败：${error.message || String(error)}` }; render(); }); break;
        case "toggle-options": state.optionsOpen = !state.optionsOpen; render(); break;
        case "toggle-data-filters": state.dataFiltersOpen = !state.dataFiltersOpen; render(); break;
        case "clear-data-filters": state.dataFilters = createDataFilterValues(dataFilterDefinitions); render(); break;
        case "set-input-list-page": state.inputListPage = clampInputListPage(button.dataset.page, state.profileUrls); render(); break;
        case "add-profile": state.profileUrls.push(""); state.inputListPage = pageForInputIndex(state.profileUrls.length - 1); render(); requestAnimationFrame(() => container.querySelector(`[data-profile-index="${state.profileUrls.length - 1}"]`)?.focus()); break;
        case "remove-profile": state.profileUrls.splice(Number(button.dataset.index), 1); state.inputListPage = clampInputListPage(state.inputListPage, state.profileUrls); saveState(state); render(); break;
        case "open-batch": state.batchDraft = state.profileUrls.filter(Boolean).join("\n"); state.batchOpen = true; state.guideOpen = false; render(); requestAnimationFrame(() => container.querySelector("[data-batch-input]")?.focus()); break;
        case "close-batch": state.batchOpen = false; render(); break;
        case "apply-batch": { const urls = uniqueUrls(state.batchDraft.split(/[\n,，;；]+/)); if (!urls.length) { state.notice = { tone: "error", text: `批量列表中至少需要一个${subjectLabel}链接。` }; render(); break; } state.profileUrls = urls; state.inputListPage = 1; state.batchOpen = false; state.notice = { tone: "success", text: `已应用 ${urls.length} 个${subjectLabel}链接。` }; saveState(state); render(); break; }
        case "open-guide": state.guideOpen = true; state.batchOpen = false; render(); requestAnimationFrame(() => container.querySelector("[data-guide-autofocus]")?.focus()); break;
        case "close-guide": state.guideOpen = false; render(); break;
        case "open-task-detail": state.taskDetailRecordId = button.dataset.recordId; state.batchOpen = false; state.guideOpen = false; render(); break;
        case "close-task-detail": state.taskDetailRecordId = ""; render(); break;
        case "clear-records": state.records = []; state.recordFilters = { profile: ALL_RECORD_FILTER, status: ALL_RECORD_FILTER }; state.taskDetailRecordId = ""; saveState(state); render(); break;
        case "clear-data": state.dataRows = []; state.dataFilters = createDataFilterValues(dataFilterDefinitions); saveState(state); render(); break;
        case "copy-json": {
          const rows = filterDataRows(state.dataRows, dataFilterDefinitions, state.dataFilters);
          try {
            openRowsJsonPreview(rows, buildExportRows);
          } catch (error) {
            state.notice = { tone: "error", text: `打开 JSON 数据失败：${error.message || String(error)}` };
            render();
          }
          break;
        }
        case "export-csv": {
          const rows = filterDataRows(state.dataRows, dataFilterDefinitions, state.dataFilters);
          settings.downloadData(rows, "csv");
          state.notice = { tone: "success", text: `已导出 ${rows.length} 条筛选后的表格数据（CSV）。` };
          render();
          break;
        }
        case "reset": Object.assign(state, { profileUrls: [...defaultUrls], inputListPage: 1, limit: DEFAULT_OPTIONS.limit, concurrency: DEFAULT_OPTIONS.concurrency, intervalMinMs: DEFAULT_OPTIONS.intervalMinMs, intervalMaxMs: DEFAULT_OPTIONS.intervalMaxMs, polling: false, pollingMinutes: DEFAULT_OPTIONS.pollingMinutes, optionsOpen: false, notice: { tone: "success", text: "已还原主页输入与基础运行选项。" } }); saveState(state); render(); break;
        default: break;
      }
    };
    const handleInput = (event) => {
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
      if (event.target.dataset.profileIndex !== undefined) state.profileUrls[Number(event.target.dataset.profileIndex)] = event.target.value;
      if (event.target.matches("[data-batch-input]")) state.batchDraft = event.target.value;
      const field = event.target.dataset.field;
      if (field === "limit") state.limit = asInteger(event.target.value, state.limit, 1, 100);
      if (field === "concurrency") state.concurrency = normalizeTaskConcurrency(event.target.value, state.concurrency);
      if (field === "intervalMinMs") state.intervalMinMs = asInteger(event.target.value, state.intervalMinMs, 100, 6000);
      if (field === "intervalMaxMs") state.intervalMaxMs = asInteger(event.target.value, state.intervalMaxMs, 100, 6000);
      if (supportsPolling && field === "pollingMinutes") state.pollingMinutes = asInteger(event.target.value, state.pollingMinutes, 1, 1440);
    };
    const handleChange = (event) => {
      const dataFilter = event.target.dataset.dataFilter;
      if (dataFilter) { state.dataFilters[dataFilter] = event.target.value; render(); return; }
      const recordFilter = event.target.dataset.recordFilter;
      if (recordFilter) { state.recordFilters[recordFilter] = event.target.value; render(); return; }
      const field = event.target.dataset.field;
      if (field === "intervalMinMs" || field === "intervalMaxMs") Object.assign(state, normalizeProfileIntervalRange(state));
      if (supportsPolling && field === "polling") state.polling = event.target.checked;
      if (["limit", "concurrency", "intervalMinMs", "intervalMaxMs", ...(supportsPolling ? ["polling", "pollingMinutes"] : [])].includes(field)) { saveState(state); render(); }
    };
    const handleKeydown = (event) => { if (event.key === "Escape" && (state.batchOpen || state.guideOpen || state.taskDetailRecordId)) closeModal(); };
    container.addEventListener("click", handleClick); container.addEventListener("input", handleInput); container.addEventListener("change", handleChange); document.addEventListener("keydown", handleKeydown); globalThis.addEventListener?.(eventName, handleLiveRunFinished); render();
    return () => { disposed = true; container.removeEventListener("click", handleClick); container.removeEventListener("input", handleInput); container.removeEventListener("change", handleChange); document.removeEventListener("keydown", handleKeydown); globalThis.removeEventListener?.(eventName, handleLiveRunFinished); container.replaceChildren(); };
  };
}

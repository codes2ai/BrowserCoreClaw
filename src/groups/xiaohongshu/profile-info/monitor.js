import {
  buildXiaohongshuProfileInfoExportRows,
  downloadXiaohongshuProfileInfoData
} from "./export-data.js";
import {
  MESSAGE_CAPTURE_XIAOHONGSHU_PROFILE_INFO,
  MESSAGE_STOP_XIAOHONGSHU_PROFILE_INFO
} from "./constants.js";
import {
  filterProfileRecords,
  limitProfileRecordsPerStatus,
  normalizeProfileIntervalRange,
  updateProfileRecord,
  waitForProfileInterval
} from "../profile-notes/monitor.js";
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
import {
  applyItemLimit,
  formatLimitValue,
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

const STORAGE_KEY = "browserCoreClawXiaohongshuProfileInfoV1";
const FEATURE_KEY = "xiaohongshu/profile-info";
const ALL_RECORD_FILTER = "__all__";
const DATA_FILTER_DEFINITIONS = Object.freeze([
  { key: "nickname", label: "昵称" },
  { key: "xiaohongshuId", label: "小红书号" },
  { key: "ipLocation", label: "IP 属地", type: "select" },
  { key: "bio", label: "简介" },
  { key: "tags", label: "标签" },
  { key: "following", label: "关注" },
  { key: "followers", label: "粉丝" },
  { key: "likedAndCollected", label: "获赞与收藏" },
  { key: "profileUrl", label: "主页链接" },
  { key: "capturedAt", label: "采集时间", placeholder: "例如 2025-11-18" }
]);
const DEFAULT_PROFILE_URLS = [""];
const DEFAULT_OPTIONS = Object.freeze({ intervalMinMs: DEFAULT_EXECUTION_INTERVAL_MIN_MS, intervalMaxMs: DEFAULT_EXECUTION_INTERVAL_MAX_MS, concurrency: DEFAULT_TASK_CONCURRENCY, polling: false, pollingMinutes: 10 });
const STATUS = Object.freeze({
  running: { label: "运行中", tone: "running" },
  success: { label: "完成", tone: "success" },
  error: { label: "失败", tone: "error" },
  stopped: { label: "已停止", tone: "stopped" }
});

let activeInfoRun = null;
const INFO_RUN_EVENT = "browser-core-claw-profile-info-run-finished";

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

function isProfileUrl(value) {
  try {
    const url = new URL(value);
    return /(^|\.)xiaohongshu\.com$/i.test(url.hostname) && /^\/user\/profile\/[^/]+\/?$/i.test(url.pathname);
  } catch {
    return false;
  }
}

function formatTime(date = new Date()) {
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(date);
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "-";
  if (milliseconds < 1000) return `${milliseconds} ms`;
  return `${(milliseconds / 1000).toFixed(milliseconds < 10000 ? 1 : 0)} 秒`;
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
  while (!control.stopRequested && Date.now() < deadline) await wait(Math.min(100, deadline - Date.now()));
}

function isExtensionRuntime() {
  return Boolean(globalThis.chrome?.runtime?.id && chrome.runtime?.sendMessage && chrome.tabs?.query);
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
      config: { ...normalizeProfileIntervalRange(state), concurrency: normalizeTaskConcurrency(state.concurrency), polling: Boolean(state.polling), pollingMinutes: asInteger(state.pollingMinutes, DEFAULT_OPTIONS.pollingMinutes, 1, 1440) },
      records: limitProfileRecordsPerStatus(state.records, state.taskRecordsPerStatusLimit),
      dataRows: applyItemLimit(state.dataRows, state.dataStorageLimit),
      notice: state.notice
    }
  }).catch(() => {});
}

function renderStatus(record) {
  return `<span class="xhs-table-status ${escapeHtml(record.tone || "running")}">${escapeHtml(record.status || "运行中")}</span>`;
}

function renderTabs(state) {
  return [["params", "运行参数"], ["records", `运行记录(${state.records.length})`], ["data", `数据(${state.dataRows.length})`]]
    .map(([id, label]) => `<button class="xhs-tab ${state.tab === id ? "active" : ""}" type="button" role="tab" aria-selected="${state.tab === id}" data-tab="${id}">${label}</button>`).join("");
}

function renderProfileRows(state, pagination) {
  return pagination.items.map(({ value: url, index }) => `
    <div class="xhs-keyword-row"><span class="xhs-row-index">${index + 1}</span><label class="xhs-keyword-input"><span class="sr-only">第 ${index + 1} 个博主主页</span><input type="url" value="${escapeHtml(url)}" placeholder="https://www.xiaohongshu.com/user/profile/..." data-profile-index="${index}" ${state.running ? "disabled" : ""}></label><button class="xhs-remove-button" type="button" data-action="remove-profile" data-index="${index}" aria-label="删除第 ${index + 1} 个主页" ${state.profileUrls.length === 1 || state.running ? "disabled" : ""}>X</button></div>
  `).join("");
}

function renderOptions(state) {
  const disabled = state.running ? "disabled" : "";
  return `
    <section class="xhs-options-card"><button class="xhs-options-header" type="button" data-action="toggle-options" aria-expanded="${state.optionsOpen}"><span aria-hidden="true">⌄</span><span class="xhs-options-title"><strong>运行选项</strong><small>并发任务、随机执行间隔与循环监控</small></span><span class="xhs-option-summary"><span><small>每主页信息数</small><strong>1</strong></span><span><small>并发任务</small><strong>${state.concurrency}</strong></span><span><small>执行间隔</small><strong>${intervalSummary(state)}</strong></span><span><small>循环监控</small><strong>${state.polling ? `${state.pollingMinutes} 分钟` : "关闭"}</strong></span></span><span class="xhs-options-toggle-label">${state.optionsOpen ? "收起选项" : "展开选项"}</span></button>
      ${state.optionsOpen ? `<div class="xhs-options-body"><p class="xhs-options-note">每个主页仅采集一条博主资料，不读取主页博文或其他筛选条件。并发任务使用独立后台标签页。</p><div class="xhs-options-grid"><label class="xhs-control"><span>并发任务数</span><input type="number" min="1" max="${MAX_TASK_CONCURRENCY}" value="${state.concurrency}" data-field="concurrency" ${disabled}><small>同时采集 ${state.concurrency} 个主页；设为 1 时按顺序执行，最多 ${MAX_TASK_CONCURRENCY} 个。</small></label><label class="xhs-control"><span>博主主页执行间隔</span><div class="xhs-range-inputs"><div class="xhs-input-with-unit"><input type="number" min="100" max="6000" step="50" value="${state.intervalMinMs}" data-field="intervalMinMs" ${disabled}><span>ms</span></div><span class="xhs-range-separator">-</span><div class="xhs-input-with-unit"><input type="number" min="100" max="6000" step="50" value="${state.intervalMaxMs}" data-field="intervalMaxMs" ${disabled}><span>ms</span></div></div><small>启动后续主页时，在 ${intervalSummary(state)} 内随机等待。</small></label></div><div class="xhs-polling-row"><label class="xhs-switch-control"><input type="checkbox" data-field="polling" ${state.polling ? "checked" : ""} ${disabled}><span><strong>循环监控</strong><small>每轮主页任务完成后按设定周期再次执行，直到手动停止。</small></span></label><label class="xhs-control compact ${state.polling ? "" : "is-disabled"}"><span>轮询周期</span><div class="xhs-input-with-unit"><input type="number" min="1" max="1440" value="${state.pollingMinutes}" data-field="pollingMinutes" ${state.polling && !state.running ? "" : "disabled"}><span>分钟</span></div></label></div></div>` : ""}
    </section>
  `;
}

function renderParameters(state) {
  const pagination = paginateInputList(state.profileUrls, state.inputListPage);
  return `
    <section class="xhs-parameter-card"><div class="xhs-field-heading"><div><label>博主主页链接</label><p>每个主页链接独立采集博主资料；不读取博文卡片或页面筛选条件。</p></div><span>${state.profileUrls.filter(Boolean).length} 个主页</span></div><div class="xhs-keyword-list xhs-profile-list">${renderProfileRows(state, pagination)}</div>${renderInputListPagination(pagination, { itemLabel: "个主页" })}<div class="xhs-inline-actions"><button class="xhs-secondary-button emphasized" type="button" data-action="add-profile" ${state.running ? "disabled" : ""}>＋ 添加主页</button><button class="xhs-secondary-button" type="button" data-action="open-batch" ${state.running ? "disabled" : ""}>批量编辑</button></div><p class="xhs-profile-init-note"><strong>采集链路：</strong>复用当前 Chrome 的小红书登录会话，打开主页并等待资料区稳定，再读取头像、昵称、小红书号、IP 属地、简介、标签与互动统计。</p></section>
    ${renderOptions(state)}
  `;
}

function renderRecordFilters(state, filteredCount) {
  const profiles = Array.from(new Set(state.records.map((record) => record.keyword).filter(Boolean)));
  return `<div class="xhs-record-filters" aria-label="运行记录筛选"><label class="xhs-filter-control"><span>博主主页</span><select data-record-filter="profile"><option value="${ALL_RECORD_FILTER}">全部主页</option>${profiles.map((profile) => `<option value="${escapeHtml(profile)}" ${state.recordFilters.profile === profile ? "selected" : ""}>${escapeHtml(profile)}</option>`).join("")}</select></label><label class="xhs-filter-control"><span>状态</span><select data-record-filter="status"><option value="${ALL_RECORD_FILTER}">全部状态</option>${Object.entries(STATUS).map(([key, meta]) => `<option value="${key}" ${state.recordFilters.status === key ? "selected" : ""}>${meta.label}</option>`).join("")}</select></label><span class="xhs-filter-result">显示 ${filteredCount} / ${state.records.length} 条</span></div>`;
}

function renderRecords(state) {
  const records = filterProfileRecords(state.records, state.recordFilters);
  return `<section class="xhs-content-card xhs-table-page"><div class="xhs-panel-head"><div><h2>运行记录</h2><p>每个博主主页独立记录；每种状态最多保留 ${formatLimitValue(state.taskRecordsPerStatusLimit)}。</p></div></div>${renderRecordFilters(state, records.length)}<div class="xhs-table-shell records" tabindex="0"><table class="xhs-table"><thead><tr><th>任务编号</th><th>开始时间</th><th>博主主页</th><th>轮次</th><th>状态</th><th>信息数</th><th>耗时</th></tr></thead><tbody>${records.length ? records.map((record) => `<tr><td><button class="xhs-task-id-button" type="button" data-action="open-task-detail" data-record-id="${escapeHtml(record.id)}"><code>${escapeHtml(getTaskId(record))}</code></button></td><td>${escapeHtml(record.startedAt)}</td><td class="xhs-profile-url-cell" title="${escapeHtml(record.keyword)}">${escapeHtml(record.keyword)}</td><td>${escapeHtml(record.round)}</td><td title="${escapeHtml(record.error || "")}">${renderStatus(record)}</td><td>${record.resultCount}</td><td>${escapeHtml(record.duration)}</td></tr>`).join("") : `<tr><td class="xhs-table-empty" colspan="7">${state.records.length ? "没有符合筛选条件的记录" : "暂无运行记录"}</td></tr>`}</tbody></table></div></section>`;
}

function renderData(state) {
  const filteredRows = filterDataRows(state.dataRows, DATA_FILTER_DEFINITIONS, state.dataFilters);
  return `<section class="xhs-content-card xhs-table-page"><div class="xhs-panel-head"><div><h2>数据</h2><p>共 ${state.dataRows.length} 条，最多保留 ${formatLimitValue(state.dataStorageLimit)}；每个主页仅保留最新一条博主资料。</p></div></div>${renderDataFilterPanel({ rows: state.dataRows, definitions: DATA_FILTER_DEFINITIONS, values: state.dataFilters, expanded: state.dataFiltersOpen, escapeHtml })}<div class="xhs-table-shell data" tabindex="0"><table class="xhs-table xhs-data-table"><thead><tr><th>头像</th><th>昵称</th><th>小红书号</th><th>IP属地</th><th>简介</th><th>标签</th><th>关注</th><th>粉丝</th><th>获赞与收藏</th><th>主页链接</th><th>采集时间</th></tr></thead><tbody>${filteredRows.length ? filteredRows.map((row) => `<tr><td>${row.avatar ? `<img class="xhs-cover-thumb" src="${escapeHtml(row.avatar)}" alt="" loading="lazy">` : "-"}</td><td>${escapeHtml(row.nickname || "-")}</td><td>${escapeHtml(row.xiaohongshuId || "-")}</td><td>${escapeHtml(row.ipLocation || "-")}</td><td class="xhs-description-cell" title="${escapeHtml(row.bio || "")}">${escapeHtml(row.bio || "-")}</td><td>${escapeHtml(row.tags || "-")}</td><td>${escapeHtml(row.following || "-")}</td><td>${escapeHtml(row.followers || "-")}</td><td>${escapeHtml(row.likedAndCollected || "-")}</td><td>${row.profileUrl ? `<a href="${escapeHtml(row.profileUrl)}" target="_blank" rel="noreferrer">打开</a>` : "-"}</td><td>${escapeHtml(row.capturedAt || "-")}</td></tr>`).join("") : `<tr><td class="xhs-table-empty" colspan="11">${state.dataRows.length ? "没有符合筛选条件的数据" : "运行后，博主信息会显示在这里"}</td></tr>`}</tbody></table></div></section>`;
}

function renderBatchModal(state) {
  if (!state.batchOpen) return "";
  return `<div class="xhs-modal-backdrop" data-modal="batch"><section class="xhs-batch-modal" role="dialog" aria-modal="true" aria-labelledby="xhsInfoBatchTitle"><header><div><span>BATCH EDIT</span><h2 id="xhsInfoBatchTitle">批量编辑博主主页</h2></div><button class="xhs-modal-close" type="button" data-action="close-batch" aria-label="关闭">X</button></header><p>每行一个小红书博主主页链接；应用后会替换当前列表。</p><label for="xhsInfoBatchInput">主页链接列表</label><textarea id="xhsInfoBatchInput" data-batch-input rows="10">${escapeHtml(state.batchDraft)}</textarea><footer><button class="xhs-secondary-button" type="button" data-action="close-batch">取消</button><button class="xhs-primary-button" type="button" data-action="apply-batch">应用主页链接</button></footer></section></div>`;
}

function renderGuide(state) {
  if (!state.guideOpen) return "";
  return `<div class="xhs-modal-backdrop" data-modal="guide"><section class="xhs-batch-modal xhs-guide-modal" role="dialog" aria-modal="true" aria-labelledby="xhsInfoGuideTitle"><header><div><span>QUICK START</span><h2 id="xhsInfoGuideTitle">使用说明</h2></div><button class="xhs-modal-close" type="button" data-action="close-guide" data-guide-autofocus aria-label="关闭">X</button></header><div class="xhs-guide"><p class="xhs-guide-intro">功能会复用当前 Chrome Profile 的小红书登录会话，按主页链接采集公开的博主资料。</p><ol><li><strong>确认登录</strong><span>进入功能前会确认当前 Chrome Profile 的小红书登录状态。</span></li><li><strong>填写主页</strong><span>输入一个或多个 <code>/user/profile/</code> 主页链接。</span></li><li><strong>运行并导出</strong><span>程序确认资料区稳定后保存一条博主资料，支持筛选、复制 JSON 和导出 CSV 表格。</span></li></ol><div class="xhs-schema-box"><strong>采集字段</strong><code>avatar · nickname · xiaohongshuId · ipLocation · bio · tags · following · followers · likedAndCollected</code></div></div><footer><button class="xhs-primary-button" type="button" data-action="close-guide">知道了</button></footer></section></div>`;
}

function renderTaskDetails(state) {
  if (!state.taskDetailRecordId) return "";
  return renderTaskDetailModal({ detail: getTaskRecordDetails(state.records, state.taskDetailRecordId), prefix: "xhs", featureName: "小红书博主信息采集", detailTitle: "小红书博主信息采集任务明细", subjectLabel: "博主主页", escapeHtml, renderStatus });
}

function renderRunButton(state, className = "") {
  return state.running ? `<button class="xhs-stop-button ${className}" type="button" data-action="stop" ${state.stopping ? "disabled" : ""}>${state.stopping ? "停止中…" : "停止全部"}</button>` : `<button class="xhs-primary-button ${className}" type="button" data-action="run">运行</button>`;
}

function renderActionBar(state) {
  if (state.tab === "params") return `<footer class="xhs-action-bar">${renderRunButton(state)}<button class="xhs-secondary-button" type="button" data-action="reset" ${state.running ? "disabled" : ""}>还原输入</button><span>${state.running ? "任务运行中，参数已锁定；可以停止任务。" : "运行会打开小红书博主主页并采集资料区。"}</span></footer>`;
  if (state.tab === "records") return `<footer class="xhs-action-bar xhs-table-action-bar"><button class="xhs-secondary-button" type="button" data-action="clear-records" ${state.records.length && !state.running ? "" : "disabled"}>清空记录</button><span>当前 ${state.records.length} 条 · 每种状态最多保留 ${formatLimitValue(state.taskRecordsPerStatusLimit)}</span></footer>`;
  const filteredRows = filterDataRows(state.dataRows, DATA_FILTER_DEFINITIONS, state.dataFilters);
  return `<footer class="xhs-action-bar xhs-table-action-bar"><button class="xhs-secondary-button emphasized" type="button" data-action="copy-json" ${filteredRows.length ? "" : "disabled"}>复制 JSON</button><button class="xhs-secondary-button emphasized" type="button" data-action="export-csv" ${filteredRows.length ? "" : "disabled"}>导出表格</button><button class="xhs-secondary-button" type="button" data-action="clear-data" ${state.dataRows.length && !state.running ? "" : "disabled"}>清空数据</button><span>筛选结果 ${filteredRows.length} / ${state.dataRows.length} 条 · 最多保留 ${formatLimitValue(state.dataStorageLimit)}</span></footer>`;
}

function renderPage(state, context) {
  const isTable = state.tab === "records" || state.tab === "data";
  const workspace = state.tab === "records" ? renderRecords(state) : state.tab === "data" ? renderData(state) : renderParameters(state);
  return `<section class="xhs-monitor has-fixed-actions" aria-labelledby="xhsInfoMonitorTitle"><header class="xhs-hero"><div class="xhs-title-row"><h1 id="xhsInfoMonitorTitle">${escapeHtml(context.feature.name)}</h1><span class="xhs-version">v0.1.0</span><button class="xhs-guide-button ${state.guideOpen ? "active" : ""}" type="button" data-action="open-guide" title="查看使用说明"><span>使用说明</span><img src="src/assets/icons/question-circle.svg" alt=""></button></div>${renderRunButton(state, "xhs-top-run")}</header><nav class="xhs-tabs" role="tablist" aria-label="小红书博主信息采集页面">${renderTabs(state)}</nav><div class="xhs-notice ${escapeHtml(state.notice.tone)}" role="status">${escapeHtml(state.notice.text)}</div><div class="xhs-workspace has-fixed-actions ${isTable ? "is-table-view" : ""}">${workspace}</div>${renderActionBar(state)}${renderBatchModal(state)}${renderGuide(state)}${renderTaskDetails(state)}</section>`;
}

function mergeInfoRow(state, data, task) {
  const profile = data?.profile || {};
  const id = String(profile.profileId || profile.profileUrl || "").trim();
  if (!id) return 0;
  const row = tagTaskDataRow({ id, ...profile, capturedAt: data.capturedAt || new Date().toISOString() }, task);
  const previous = new Map(state.dataRows.map((item) => [item.id, item]));
  const added = previous.has(id) ? 0 : 1;
  state.dataRows = applyItemLimit(
    [{ ...previous.get(id), ...row }, ...state.dataRows.filter((item) => item.id !== id)],
    state.dataStorageLimit
  );
  return added;
}

export async function mountXiaohongshuProfileInfoMonitor(container, context) {
  const storageLimits = await loadGlobalStorageLimits().catch(() => ({ dataStorageLimit: 3000, taskRecordsPerStatusLimit: 200 }));
  const saved = await loadSavedState().catch(() => null);
  const savedConfig = migrateLegacyExecutionInterval(saved?.config || {}, {
    legacyMinMs: 100,
    legacyMaxMs: 6000
  });
  const savedInterval = normalizeProfileIntervalRange(savedConfig);
  const state = {
    tab: "params", profileUrls: Array.isArray(saved?.profileUrls) && saved.profileUrls.length ? saved.profileUrls : [...DEFAULT_PROFILE_URLS], inputListPage: 1, dataStorageLimit: storageLimits.dataStorageLimit, taskRecordsPerStatusLimit: storageLimits.taskRecordsPerStatusLimit, records: limitProfileRecordsPerStatus(saved?.records, storageLimits.taskRecordsPerStatusLimit), dataRows: applyItemLimit(saved?.dataRows, storageLimits.dataStorageLimit), batchOpen: false, batchDraft: "", guideOpen: false, taskDetailRecordId: "", concurrency: normalizeTaskConcurrency(savedConfig.concurrency), intervalMinMs: savedInterval.intervalMinMs, intervalMaxMs: savedInterval.intervalMaxMs, polling: Boolean(savedConfig.polling), pollingMinutes: asInteger(savedConfig.pollingMinutes, DEFAULT_OPTIONS.pollingMinutes, 1, 1440), optionsOpen: false, running: Boolean(activeInfoRun && !activeInfoRun.stopRequested), stopping: false, recordFilters: { profile: ALL_RECORD_FILTER, status: ALL_RECORD_FILTER }, dataFilters: createDataFilterValues(DATA_FILTER_DEFINITIONS), dataFiltersOpen: true, notice: saved?.notice || { tone: "info", text: "已确认小红书登录状态。填写博主主页链接后即可采集资料。" }
  };
  saveState(state);
  let disposed = false;
  let activeRun = activeInfoRun;
  const render = () => { if (!disposed) container.innerHTML = renderPage(state, context); };
  const closeTask = () => { state.taskDetailRecordId = ""; render(); };
  const finishRecord = (recordId, startedAtMs, statusKey, resultCount = 0, error = "") => {
    const meta = STATUS[statusKey] || STATUS.error;
    state.records = updateProfileRecord(state.records, recordId, { status: meta.label, statusKey, tone: meta.tone, resultCount: Number(resultCount) || 0, error, duration: formatDuration(Date.now() - startedAtMs) }, state.taskRecordsPerStatusLimit);
  };
  const createRecord = (control, profileUrl, round, index) => {
    const startedAtMs = Date.now();
    const record = { id: `${control.runId}-R${round}-P${index + 1}`, runId: control.runId, startedAt: formatTime(new Date(startedAtMs)), keyword: profileUrl, round, status: STATUS.running.label, statusKey: "running", tone: "running", resultCount: 0, duration: "-", error: "" };
    state.records = limitProfileRecordsPerStatus([record, ...state.records], state.taskRecordsPerStatusLimit);
    return { record: state.records.find((item) => item.id === record.id) || record, startedAtMs };
  };
  const startRun = async () => {
    if (state.running) return;
    if (!isExtensionRuntime()) { state.notice = { tone: "error", text: "博主信息采集只能在已加载扩展的 Chrome 控制台中运行。" }; render(); return; }
    const profileUrls = uniqueUrls(state.profileUrls);
    if (!profileUrls.length) { state.notice = { tone: "error", text: "请至少填写一个小红书博主主页链接。" }; render(); return; }
    const invalidUrl = profileUrls.find((url) => !isProfileUrl(url));
    if (invalidUrl) { state.notice = { tone: "error", text: `主页链接格式不正确：${invalidUrl}` }; render(); return; }
    state.profileUrls = profileUrls;
    const control = {
      runId: `XHI-${String(Date.now()).slice(-8)}`,
      stopRequested: false,
      activeCaptureRunIds: new Set()
    };
    activeRun = control;
    activeInfoRun = control;
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
        await runConcurrentTasks(profileUrls, {
          concurrency: state.concurrency,
          shouldStop: () => control.stopRequested,
          worker: async (profileUrl, index) => {
            if (index >= state.concurrency) {
              await waitForProfileInterval(state, control, {
                onWait: (milliseconds) => {
                  state.notice = { tone: "info", text: `正在准备后续主页，随机等待 ${milliseconds} ms（范围 ${intervalSummary(state)}）…` };
                  saveState(state);
                  render();
                }
              });
            }
            if (control.stopRequested) return;
            const current = createRecord(control, profileUrl, round, index);
            const captureRunId = current.record.id;
            control.activeCaptureRunIds.add(captureRunId);
            state.notice = { tone: "info", text: `第 ${round} 轮，正在并发采集 ${control.activeCaptureRunIds.size}/${state.concurrency} 个博主资料…` };
            saveState(state);
            render();
            try {
              const response = await runWithTaskTimeout(() => sendMessage({
                type: MESSAGE_CAPTURE_XIAOHONGSHU_PROFILE_INFO,
                options: { runId: captureRunId, tabId: null, isolated: true, profileUrl }
              }), {
                timeoutSeconds: taskTimeoutSeconds,
                onTimeout: () => sendMessage({
                  type: MESSAGE_STOP_XIAOHONGSHU_PROFILE_INFO,
                  options: { runId: captureRunId }
                }).catch(() => null)
              });
              if (control.stopRequested) {
                finishRecord(current.record.id, current.startedAtMs, "stopped");
                return;
              }
              if (!response?.ok) throw new Error(response?.error || "小红书博主信息采集失败");
              addedTotal += mergeInfoRow(state, response.data, { runId: control.runId, recordId: current.record.id });
              finishRecord(current.record.id, current.startedAtMs, "success", 1);
            } catch (error) {
              if (control.stopRequested) finishRecord(current.record.id, current.startedAtMs, "stopped");
              else {
                const errorText = error.message || String(error);
                roundFailed += 1;
                finishRecord(current.record.id, current.startedAtMs, "error", 0, errorText);
                state.notice = { tone: "error", text: `博主资料采集失败：${errorText}` };
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
        if (!state.polling) { state.notice = { tone: roundFailed ? "warning" : "success", text: `运行结束：新增 ${addedTotal} 条博主资料，失败 ${roundFailed} 个主页。` }; state.tab = addedTotal ? "data" : "records"; break; }
        const pollingMs = state.pollingMinutes * 60 * 1000;
        state.notice = { tone: roundFailed ? "warning" : "success", text: `第 ${round} 轮完成；下一轮 ${formatTime(new Date(Date.now() + pollingMs))} 开始。` };
        saveState(state);
        render();
        await waitWhileRunning(pollingMs, control);
      } while (!control.stopRequested);
      if (control.stopRequested) { state.notice = { tone: "warning", text: `任务已停止，共完成 ${completedRounds} 轮，新增 ${addedTotal} 条资料。` }; state.tab = "records"; }
    } catch (error) {
      const errorText = error.message || String(error);
      state.notice = control.stopRequested ? { tone: "warning", text: "任务已停止。" } : { tone: "error", text: errorText };
      state.tab = "records";
    } finally {
      await setFeatureRunning(FEATURE_KEY, false);
      if (activeInfoRun === control) activeInfoRun = null;
      if (activeRun === control) activeRun = null;
      state.running = false;
      state.stopping = false;
      saveState(state);
      render();
      globalThis.dispatchEvent?.(new Event(INFO_RUN_EVENT));
    }
  };
  const stopRun = async () => {
    const control = activeRun || activeInfoRun;
    if (!state.running || !control || control.stopRequested) return;
    control.stopRequested = true;
    state.stopping = true;
    state.notice = { tone: "warning", text: "正在停止全部并发任务并释放小红书页面连接…" };
    render();
    await Promise.all([...control.activeCaptureRunIds].map((runId) => (
      sendMessage({ type: MESSAGE_STOP_XIAOHONGSHU_PROFILE_INFO, options: { runId } }).catch(() => null)
    )));
  };
  const handleLiveRunFinished = async () => {
    if (activeInfoRun || !state.running) return;
    const latest = await loadSavedState().catch(() => null);
    state.running = false;
    state.stopping = false;
    state.records = limitProfileRecordsPerStatus(latest?.records || state.records, state.taskRecordsPerStatusLimit);
    state.dataRows = Array.isArray(latest?.dataRows) ? applyItemLimit(latest.dataRows, state.dataStorageLimit) : state.dataRows;
    state.notice = latest?.notice || state.notice;
    render();
  };
  const handleClick = async (event) => {
    if (event.target.matches(".xhs-modal-backdrop")) { if (state.taskDetailRecordId) closeTask(); else if (state.guideOpen) { state.guideOpen = false; render(); } else { state.batchOpen = false; render(); } return; }
    const tab = event.target.closest("[data-tab]");
    if (tab) { state.tab = tab.dataset.tab; render(); return; }
    const button = event.target.closest("[data-action]");
    if (!button || button.disabled) return;
    switch (button.dataset.action) {
      case "run": startRun().catch((error) => { activeRun = null; activeInfoRun = null; state.running = false; state.stopping = false; state.notice = { tone: "error", text: error.message || String(error) }; render(); }); break;
      case "stop": stopRun().catch((error) => { state.notice = { tone: "error", text: `停止任务失败：${error.message || String(error)}` }; render(); }); break;
      case "toggle-options": state.optionsOpen = !state.optionsOpen; render(); break;
      case "toggle-data-filters": state.dataFiltersOpen = !state.dataFiltersOpen; render(); break;
      case "clear-data-filters": state.dataFilters = createDataFilterValues(DATA_FILTER_DEFINITIONS); render(); break;
      case "set-input-list-page": state.inputListPage = clampInputListPage(button.dataset.page, state.profileUrls); render(); break;
      case "add-profile": state.profileUrls.push(""); state.inputListPage = pageForInputIndex(state.profileUrls.length - 1); render(); requestAnimationFrame(() => container.querySelector(`[data-profile-index="${state.profileUrls.length - 1}"]`)?.focus()); break;
      case "remove-profile": state.profileUrls.splice(Number(button.dataset.index), 1); state.inputListPage = clampInputListPage(state.inputListPage, state.profileUrls); saveState(state); render(); break;
      case "open-batch": state.batchDraft = state.profileUrls.filter(Boolean).join("\n"); state.guideOpen = false; state.batchOpen = true; render(); requestAnimationFrame(() => container.querySelector("[data-batch-input]")?.focus()); break;
      case "close-batch": state.batchOpen = false; render(); break;
      case "apply-batch": { const urls = uniqueUrls(state.batchDraft.split(/[\n,，;；]+/)); if (!urls.length) { state.notice = { tone: "error", text: "批量列表中至少需要一个主页链接。" }; render(); break; } state.profileUrls = urls; state.inputListPage = 1; state.batchOpen = false; state.notice = { tone: "success", text: `已应用 ${urls.length} 个博主主页链接。` }; saveState(state); render(); break; }
      case "open-guide": state.batchOpen = false; state.guideOpen = true; render(); requestAnimationFrame(() => container.querySelector("[data-guide-autofocus]")?.focus()); break;
      case "close-guide": state.guideOpen = false; render(); break;
      case "open-task-detail": state.taskDetailRecordId = button.dataset.recordId; state.batchOpen = false; state.guideOpen = false; render(); break;
      case "close-task-detail": closeTask(); break;
      case "clear-records": state.records = []; state.recordFilters = { profile: ALL_RECORD_FILTER, status: ALL_RECORD_FILTER }; state.taskDetailRecordId = ""; saveState(state); render(); break;
      case "clear-data": state.dataRows = []; state.dataFilters = createDataFilterValues(DATA_FILTER_DEFINITIONS); saveState(state); render(); break;
      case "copy-json": {
        const rows = filterDataRows(state.dataRows, DATA_FILTER_DEFINITIONS, state.dataFilters);
        try {
          openRowsJsonPreview(rows, buildXiaohongshuProfileInfoExportRows);
        } catch (error) {
          state.notice = { tone: "error", text: `打开 JSON 数据失败：${error.message || String(error)}` };
          render();
        }
        break;
      }
      case "export-csv": {
        const rows = filterDataRows(state.dataRows, DATA_FILTER_DEFINITIONS, state.dataFilters);
        downloadXiaohongshuProfileInfoData(rows, "csv");
        state.notice = { tone: "success", text: `已导出 ${rows.length} 条筛选后的表格数据（CSV）。` };
        render();
        break;
      }
      case "reset": state.profileUrls = [...DEFAULT_PROFILE_URLS]; state.inputListPage = 1; state.concurrency = DEFAULT_OPTIONS.concurrency; state.intervalMinMs = DEFAULT_OPTIONS.intervalMinMs; state.intervalMaxMs = DEFAULT_OPTIONS.intervalMaxMs; state.polling = DEFAULT_OPTIONS.polling; state.pollingMinutes = DEFAULT_OPTIONS.pollingMinutes; state.optionsOpen = false; state.notice = { tone: "success", text: "已还原主页输入与基础运行选项。" }; saveState(state); render(); break;
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
    if (field === "concurrency") state.concurrency = normalizeTaskConcurrency(event.target.value, state.concurrency);
    if (field === "intervalMinMs") state.intervalMinMs = asInteger(event.target.value, state.intervalMinMs, 100, 6000);
    if (field === "intervalMaxMs") state.intervalMaxMs = asInteger(event.target.value, state.intervalMaxMs, 100, 6000);
    if (field === "pollingMinutes") state.pollingMinutes = asInteger(event.target.value, state.pollingMinutes, 1, 1440);
  };
  const handleChange = (event) => {
    const dataFilter = event.target.dataset.dataFilter;
    if (dataFilter) { state.dataFilters[dataFilter] = event.target.value; render(); return; }
    const recordFilter = event.target.dataset.recordFilter;
    if (recordFilter) { state.recordFilters[recordFilter] = event.target.value; render(); return; }
    const field = event.target.dataset.field;
    if (field === "intervalMinMs" || field === "intervalMaxMs") Object.assign(state, normalizeProfileIntervalRange(state));
    if (field === "polling") state.polling = event.target.checked;
    if (["concurrency", "intervalMinMs", "intervalMaxMs", "polling", "pollingMinutes"].includes(field)) { saveState(state); render(); }
  };
  const handleKeydown = (event) => { if (event.key === "Escape") { if (state.taskDetailRecordId) closeTask(); else if (state.guideOpen) { state.guideOpen = false; render(); } else if (state.batchOpen) { state.batchOpen = false; render(); } } };
  container.addEventListener("click", handleClick);
  container.addEventListener("input", handleInput);
  container.addEventListener("change", handleChange);
  document.addEventListener("keydown", handleKeydown);
  globalThis.addEventListener?.(INFO_RUN_EVENT, handleLiveRunFinished);
  render();
  return () => {
    disposed = true;
    container.removeEventListener("click", handleClick);
    container.removeEventListener("input", handleInput);
    container.removeEventListener("change", handleChange);
    document.removeEventListener("keydown", handleKeydown);
    globalThis.removeEventListener?.(INFO_RUN_EVENT, handleLiveRunFinished);
    container.replaceChildren();
  };
}

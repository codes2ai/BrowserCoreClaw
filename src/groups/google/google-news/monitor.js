import {
  MESSAGE_CAPTURE_GOOGLE_NEWS,
  MESSAGE_GOOGLE_NEWS_CAPTURE_STATUS,
  MESSAGE_STOP_GOOGLE_NEWS
} from "./constants.js";
import { buildGoogleNewsExportRows, downloadGoogleNewsData } from "./export-data.js";
import { buildGoogleNewsSearchUrl } from "./search-url.js";
import {
  getTaskRecordDetails,
  getTaskId,
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
import { formatLocalDateTime, normalizePublishedDateTime } from "../../../shared/date-normalizer.js";
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

const STORAGE_KEY = "browserCoreClawGoogleNewsV1";
const FEATURE_KEY = "google/google-news";
const ALL_RECORD_FILTER = "__all__";
const DATA_FILTER_DEFINITIONS = Object.freeze([
  { key: "keyword", label: "关键词", type: "select" },
  { key: "title", label: "新闻标题" },
  { key: "description", label: "描述", keys: ["description", "desc"] },
  { key: "source", label: "来源", type: "select" },
  { key: "publishedAt", label: "发布时间", placeholder: "例如 2026-07-15" },
  { key: "collectedAt", label: "采集时间", placeholder: "例如 2026-07-16" },
  { key: "url", label: "链接" }
]);
const RECORD_STATUS_META = Object.freeze({
  running: { label: "运行中", tone: "running" },
  success: { label: "完成", tone: "success" },
  empty: { label: "无数据", tone: "empty" },
  verification: { label: "等待验证", tone: "risk" },
  risk: { label: "风控", tone: "risk" },
  partial: { label: "部分完成", tone: "warning" },
  error: { label: "失败", tone: "error" },
  stopped: { label: "已停止", tone: "stopped" },
  preview: { label: "已打开搜索页", tone: "preview" }
});
const SAMPLE_CONFIG = Object.freeze({
  keywords: ["OpenAI", "人工智能"],
  limit: 20,
  keywordIntervalMinMs: DEFAULT_EXECUTION_INTERVAL_MIN_MS,
  keywordIntervalMaxMs: DEFAULT_EXECUTION_INTERVAL_MAX_MS,
  concurrency: DEFAULT_TASK_CONCURRENCY,
  timeRange: "last_hour",
  language: "zh-CN",
  polling: false,
  pollingMinutes: 10
});

// 功能页面切换时模块不会重新加载。将实际运行控制器保存在模块级，
// 让任务脱离某次页面挂载继续执行，并在重新打开功能时恢复控制入口。
let activeGoogleNewsRun = null;
const GOOGLE_NEWS_RUN_FINISHED_EVENT = "browser-core-claw-google-news-run-finished";
const GOOGLE_NEWS_RUN_STATUS_EVENT = "browser-core-claw-google-news-run-status";
let googleNewsCaptureStatusListenerInstalled = false;

function cloneSampleConfig() {
  return { ...SAMPLE_CONFIG, keywords: [...SAMPLE_CONFIG.keywords] };
}

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

function asDecimal(value, fallback, min, max) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return fallback;
  const clamped = Math.min(max, Math.max(min, parsed));
  return Math.round(clamped * 10) / 10;
}

function normalizeConfig(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("JSON 顶层必须是一个对象。");
  }
  if (!Array.isArray(input.keywords)) {
    throw new Error("keywords 必须是字符串数组。");
  }

  const keywords = Array.from(new Set(
    input.keywords.map((item) => String(item ?? "").trim()).filter(Boolean)
  ));
  if (!keywords.length) {
    throw new Error("请至少保留一个非空关键词。");
  }

  const legacyIntervalMs = input.keywordIntervalSeconds !== undefined
    ? Number(input.keywordIntervalSeconds) * 1000
    : input.intervalSeconds !== undefined
      ? Number(input.intervalSeconds) * 1000
      : input.interval !== undefined
        ? Number(input.interval)
        : undefined;
  const fallbackMinMs = Number.isFinite(legacyIntervalMs)
    ? Math.min(SAMPLE_CONFIG.keywordIntervalMinMs, Math.max(0, legacyIntervalMs))
    : SAMPLE_CONFIG.keywordIntervalMinMs;
  const fallbackMaxMs = Number.isFinite(legacyIntervalMs)
    ? Math.max(0, legacyIntervalMs)
    : SAMPLE_CONFIG.keywordIntervalMaxMs;
  const intervalRange = normalizeKeywordIntervalRange({
    keywordIntervalMinMs: input.keywordIntervalMinMs ?? fallbackMinMs,
    keywordIntervalMaxMs: input.keywordIntervalMaxMs ?? fallbackMaxMs
  });

  return {
    keywords,
    limit: asInteger(input.limit, SAMPLE_CONFIG.limit, 1, 100),
    ...intervalRange,
    concurrency: normalizeTaskConcurrency(input.concurrency),
    timeRange: "last_hour",
    language: ["zh-CN", "en-US", "ja-JP"].includes(input.language)
      ? input.language
      : SAMPLE_CONFIG.language,
    polling: Boolean(input.polling),
    pollingMinutes: asInteger(input.pollingMinutes, SAMPLE_CONFIG.pollingMinutes, 1, 1440)
  };
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

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) {
    return "-";
  }
  if (ms < 1000) {
    return `${ms} ms`;
  }
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} 秒`;
}

export function getRecordStatusKey(record) {
  if (RECORD_STATUS_META[record?.statusKey]) {
    return record.statusKey;
  }
  const status = String(record?.status || "");
  if (/停止/.test(status)) return "stopped";
  if (/等待验证|验证通过/.test(status)) return "verification";
  if (/风控|人机验证|异常流量/.test(status)) return "risk";
  if (/无数据/.test(status)) return "empty";
  if (/部分/.test(status)) return "partial";
  if (/失败|打开失败/.test(status)) return "error";
  if (/完成/.test(status)) return "success";
  if (/打开搜索页/.test(status)) return "preview";
  const toneMap = {
    success: "success",
    empty: "empty",
    verification: "verification",
    risk: "risk",
    warning: "partial",
    error: "error",
    stopped: "stopped",
    preview: "preview"
  };
  return toneMap[record?.tone] || "running";
}

function normalizeRecord(record, index = 0) {
  const normalized = record && typeof record === "object" ? record : {};
  const statusKey = getRecordStatusKey(normalized);
  return Object.assign(normalized, {
    id: normalized.id || `GN-OLD-${index + 1}`,
    keyword: normalized.keyword || (normalized.keywordCount ? `${normalized.keywordCount} 个关键词（旧汇总）` : "-"),
    round: normalized.round || normalized.roundCount || "-",
    status: normalized.status || RECORD_STATUS_META[statusKey].label,
    statusKey,
    tone: normalized.tone || RECORD_STATUS_META[statusKey].tone,
    resultCount: Number(normalized.resultCount) || 0,
    duration: normalized.duration || "-"
  });
}

export function limitRecordsPerStatus(records, limit = DEFAULT_TASK_RECORDS_PER_STATUS_LIMIT) {
  return limitItemsPerGroup(
    (Array.isArray(records) ? records : []).map(normalizeRecord),
    getRecordStatusKey,
    limit
  );
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitWhileRunning(ms, control) {
  const deadline = Date.now() + ms;
  while (!control.stopRequested && !control.riskControlTriggered && Date.now() < deadline) {
    await wait(Math.min(100, deadline - Date.now()));
  }
}

function isGoogleNewsRiskControlError(error) {
  return error?.code === "GOOGLE_NEWS_RISK_CONTROL"
    || /Google[^。]*(?:人机验证|异常流量|风控)|\/sorry\//i.test(error?.message || String(error || ""));
}

export function normalizeKeywordIntervalRange(config) {
  const first = asInteger(
    config?.keywordIntervalMinMs,
    SAMPLE_CONFIG.keywordIntervalMinMs,
    0,
    60000
  );
  const second = asInteger(
    config?.keywordIntervalMaxMs,
    SAMPLE_CONFIG.keywordIntervalMaxMs,
    0,
    60000
  );
  return {
    keywordIntervalMinMs: Math.min(first, second),
    keywordIntervalMaxMs: Math.max(first, second)
  };
}

export function pickKeywordIntervalMs(config, randomFunction = Math.random) {
  const { keywordIntervalMinMs, keywordIntervalMaxMs } = normalizeKeywordIntervalRange(config);
  if (keywordIntervalMinMs === keywordIntervalMaxMs) return keywordIntervalMinMs;
  const randomValue = Math.min(0.999999999, Math.max(0, Number(randomFunction()) || 0));
  return keywordIntervalMinMs
    + Math.floor(randomValue * (keywordIntervalMaxMs - keywordIntervalMinMs + 1));
}

export async function waitForKeywordInterval(config, control, options = {}) {
  const intervalMs = pickKeywordIntervalMs(config, options.randomFunction);
  options.onWait?.(intervalMs);
  await (options.waitFunction || waitWhileRunning)(intervalMs, control);
  return intervalMs;
}

function formatKeywordIntervalRange(config) {
  const { keywordIntervalMinMs, keywordIntervalMaxMs } = normalizeKeywordIntervalRange(config);
  return `${keywordIntervalMinMs} - ${keywordIntervalMaxMs} ms`;
}

function isExtensionRuntime() {
  return Boolean(globalThis.chrome?.runtime?.id && chrome.tabs?.query && chrome.runtime?.sendMessage);
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

function isGoogleTab(tab) {
  try {
    const url = new URL(tab?.url || "");
    return url.protocol === "https:" && /(^|\.)google\.com$/i.test(url.hostname);
  } catch {
    return false;
  }
}

export async function getOrCreateGoogleTab(preferredTabId = null, isolated = false) {
  if (isolated) {
    return callChrome((done) => {
      chrome.tabs.create({ url: "https://www.google.com/", active: false }, done);
    });
  }
  const tabs = await callChrome((done) => {
    chrome.tabs.query({ currentWindow: true }, done);
  });
  const preferred = tabs.find((tab) => tab.id === preferredTabId && isGoogleTab(tab));
  const existing = preferred || tabs.find((tab) => tab.active && isGoogleTab(tab)) || tabs.find(isGoogleTab);
  if (existing) {
    return existing;
  }

  return callChrome((done) => {
    chrome.tabs.create({ url: "https://www.google.com/", active: true }, done);
  });
}

async function closePluginCreatedGoogleTab(tabId) {
  if (!Number.isInteger(tabId) || !isExtensionRuntime()) return;
  await callChrome((done) => chrome.tabs.remove(tabId, done)).catch(() => {});
}

function sendMessage(message) {
  return callChrome((done) => chrome.runtime.sendMessage(message, done));
}

function ensureGoogleNewsCaptureStatusListener() {
  if (googleNewsCaptureStatusListenerInstalled || !isExtensionRuntime()) return;
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== MESSAGE_GOOGLE_NEWS_CAPTURE_STATUS) return false;
    const control = activeGoogleNewsRun;
    if (!control || message.options?.runId && !control.activeCaptureRunIds.has(message.options.runId)) {
      return false;
    }
    Promise.resolve(control.handleCaptureStatus?.(message.options || {})).catch(() => {});
    return false;
  });
  googleNewsCaptureStatusListenerInstalled = true;
}

async function loadSavedState() {
  if (!isExtensionRuntime() || !chrome.storage?.local) {
    return null;
  }
  const values = await callChrome((done) => chrome.storage.local.get(STORAGE_KEY, done));
  return values?.[STORAGE_KEY] || null;
}

function saveState(state) {
  if (!isExtensionRuntime() || !chrome.storage?.local) {
    return;
  }
  const value = {
    config: state.config,
    records: limitRecordsPerStatus(state.records, state.taskRecordsPerStatusLimit),
    dataRows: applyItemLimit(state.dataRows, state.dataStorageLimit),
    notice: state.notice
  };
  chrome.storage.local.set({ [STORAGE_KEY]: value }).catch(() => {});
}

function renderTabs(state) {
  const tabs = [
    ["params", "运行参数"],
    ["records", `运行记录(${state.records.length})`],
    ["data", `数据(${state.dataRows.length})`]
  ];
  return tabs.map(([id, label]) => `
    <button
      class="news-tab ${state.tab === id ? "active" : ""}"
      type="button"
      role="tab"
      data-tab="${id}"
      aria-selected="${state.tab === id}"
    >${escapeHtml(label)}</button>
  `).join("");
}

function renderKeywordRows(state, pagination) {
  return pagination.items.map(({ value: keyword, index }) => `
    <div class="news-keyword-row">
      <span class="news-row-index" aria-hidden="true">${index + 1}</span>
      <label class="news-keyword-input">
        <span class="sr-only">关键词 ${index + 1}</span>
        <input type="text" value="${escapeHtml(keyword)}" placeholder="输入新闻关键词" data-keyword-index="${index}" autocomplete="off" ${state.running ? "disabled" : ""}>
      </label>
      <button
        class="news-remove-button"
        type="button"
        data-action="remove-keyword"
        data-index="${index}"
        aria-label="删除关键词 ${index + 1}"
        title="删除关键词 ${index + 1}"
        ${state.config.keywords.length === 1 || state.running ? "disabled" : ""}
      >X</button>
    </div>
  `).join("");
}

function renderFormMode(state) {
  const pagination = paginateInputList(state.config.keywords, state.inputListPage);
  return `
    <div class="news-field-heading">
      <div>
        <label>监控关键词</label>
        <p>运行时会依次打开 Google 新闻最近一小时的搜索结果。</p>
      </div>
      <span>${state.config.keywords.length} 个关键词</span>
    </div>
    <div class="news-keyword-list">${renderKeywordRows(state, pagination)}</div>
    ${renderInputListPagination(pagination, { itemLabel: "个关键词" })}
    <div class="news-inline-actions">
      <button class="news-secondary-button emphasized" type="button" data-action="add-keyword" ${state.running ? "disabled" : ""}>添加关键词</button>
      <button class="news-secondary-button" type="button" data-action="open-batch" ${state.running ? "disabled" : ""}>批量编辑</button>
    </div>
  `;
}

function renderJsonMode(state) {
  return `
    <div class="news-json-editor">
      <div class="news-field-heading">
        <div>
          <label for="newsJsonInput">运行参数 JSON</label>
          <p>应用后会同步到表单，并用于真实的 Google 新闻搜索。</p>
        </div>
      </div>
      <textarea id="newsJsonInput" data-json-input spellcheck="false" rows="14" ${state.running ? "disabled" : ""}>${escapeHtml(state.jsonDraft)}</textarea>
      <div class="news-inline-actions">
        <button class="news-secondary-button emphasized" type="button" data-action="apply-json" ${state.running ? "disabled" : ""}>校验并应用</button>
      </div>
    </div>
  `;
}

function renderRunOptions(state) {
  return `
    <section class="news-options-card">
      <button class="news-options-header" type="button" data-action="toggle-options" aria-expanded="${state.optionsOpen}">
        <span class="news-options-title">
          <strong>运行选项</strong>
          <small>调整条数、并发任务、间隔、语言和轮询</small>
        </span>
        <span class="news-option-summary" aria-label="当前运行选项摘要">
          <span><small>关键词</small><strong>${state.config.keywords.length}</strong></span>
          <span><small>每词条数</small><strong>${state.config.limit}</strong></span>
          <span><small>并发任务</small><strong>${state.config.concurrency}</strong></span>
          <span><small>关键词间隔</small><strong>${formatKeywordIntervalRange(state.config)}</strong></span>
        </span>
        <span class="news-options-toggle-label">${state.optionsOpen ? "收起选项" : "展开选项"}</span>
      </button>
      ${state.optionsOpen ? `
        <div class="news-options-body">
          <p class="news-options-note">每个关键词都是独立任务。并发任务会使用独立的后台标签页；设为 1 时按顺序执行。</p>
          <div class="news-options-grid">
            <label class="news-control">
              <span>每个关键词结果数</span>
              <input type="number" min="1" max="100" value="${state.config.limit}" data-field="limit" ${state.running ? "disabled" : ""}>
              <small>允许 1–100 条，采集后写入数据表格。</small>
            </label>
            <label class="news-control">
              <span>并发任务数</span>
              <input type="number" min="1" max="${MAX_TASK_CONCURRENCY}" value="${state.config.concurrency}" data-field="concurrency" ${state.running ? "disabled" : ""}>
              <small>同时采集 ${state.config.concurrency} 个关键词，最多 ${MAX_TASK_CONCURRENCY} 个。</small>
            </label>
            <label class="news-control">
              <span>关键词间隔</span>
              <div class="news-range-inputs">
                <div class="news-input-with-unit">
                  <input type="number" min="0" max="60000" step="50" value="${state.config.keywordIntervalMinMs}" data-field="keywordIntervalMinMs" aria-label="关键词最短间隔" ${state.running ? "disabled" : ""}>
                  <span>ms</span>
                </div>
                <span class="news-range-separator" aria-hidden="true">-</span>
                <div class="news-input-with-unit">
                  <input type="number" min="0" max="60000" step="50" value="${state.config.keywordIntervalMaxMs}" data-field="keywordIntervalMaxMs" aria-label="关键词最长间隔" ${state.running ? "disabled" : ""}>
                  <span>ms</span>
                </div>
              </div>
              <small>每个关键词完成后，会在 ${formatKeywordIntervalRange(state.config)} 内重新随机等待。</small>
            </label>
            <label class="news-control">
              <span>时间范围</span>
              <select data-field="timeRange" disabled><option value="last_hour" selected>最近一小时</option></select>
              <small>通过 Google 新闻搜索参数固定最近一小时。</small>
            </label>
            <label class="news-control">
              <span>界面语言</span>
              <select data-field="language" ${state.running ? "disabled" : ""}>
                <option value="zh-CN" ${state.config.language === "zh-CN" ? "selected" : ""}>简体中文</option>
                <option value="en-US" ${state.config.language === "en-US" ? "selected" : ""}>English</option>
                <option value="ja-JP" ${state.config.language === "ja-JP" ? "selected" : ""}>日本語</option>
              </select>
              <small>用于 Google 搜索页面的语言参数。</small>
            </label>
          </div>
          <div class="news-polling-row">
            <label class="news-switch-control">
              <input type="checkbox" data-field="polling" ${state.config.polling ? "checked" : ""} ${state.running ? "disabled" : ""}>
              <span><strong>循环监控</strong><small>每轮完成后等待设定周期，再自动开始下一轮，直到手动停止。</small></span>
            </label>
            <label class="news-control compact ${state.config.polling ? "" : "is-disabled"}">
              <span>轮询周期</span>
              <div class="news-input-with-unit">
                <input type="number" min="1" max="1440" value="${state.config.pollingMinutes}" data-field="pollingMinutes" ${state.config.polling && !state.running ? "" : "disabled"}>
                <span>分钟</span>
              </div>
            </label>
          </div>
        </div>
      ` : ""}
    </section>
  `;
}

function renderParameters(state) {
  return `
    <section class="news-parameter-card">
      <div class="news-mode-switch" role="tablist" aria-label="参数编辑方式">
        <button class="${state.mode === "form" ? "active" : ""}" type="button" data-action="set-mode" data-mode="form" ${state.running ? "disabled" : ""}>表单</button>
        <button class="${state.mode === "json" ? "active" : ""}" type="button" data-action="set-mode" data-mode="json" ${state.running ? "disabled" : ""}>JSON</button>
      </div>
      ${state.mode === "form" ? renderFormMode(state) : renderJsonMode(state)}
    </section>
    ${renderRunOptions(state)}
  `;
}

function renderGuideModal(state) {
  if (!state.guideOpen) return "";
  return `
    <div class="news-modal-backdrop" data-modal="guide">
      <section class="news-batch-modal news-guide-modal" role="dialog" aria-modal="true" aria-labelledby="newsGuideTitle" aria-describedby="newsGuideDescription">
        <header>
          <div><span>QUICK START</span><h2 id="newsGuideTitle">使用说明</h2></div>
          <button class="news-modal-close" type="button" data-action="close-guide" data-guide-autofocus aria-label="关闭使用说明">X</button>
        </header>
        <div class="news-guide">
          <p class="news-guide-intro" id="newsGuideDescription">扩展会依次搜索关键词，并把最近一小时的新闻结果写入数据表。</p>
          <ol>
            <li><strong>准备标签页</strong><span>无需手动打开 Google；没有可复用的 Google 标签页时，扩展会自动创建。</span></li>
            <li><strong>填写关键词</strong><span>支持逐条编辑、批量弹窗粘贴或 JSON 参数方式。</span></li>
            <li><strong>点击运行</strong><span>标签页会依次打开 Google 新闻结果；开启循环监控后会按周期持续运行，直到手动停止。</span></li>
          </ol>
          <div class="news-schema-box">
            <strong>采集字段</strong>
            <code>keyword · title · description · source · publishedAt · url · collectedAt</code>
          </div>
        </div>
        <footer>
          <button class="news-primary-button" type="button" data-action="close-guide">知道了</button>
        </footer>
      </section>
    </div>
  `;
}

function renderRecordStatus(record) {
  const tone = record.tone || "running";
  return `<span class="news-table-status ${escapeHtml(tone)}">${escapeHtml(record.status)}</span>`;
}

export function filterRecords(records, filters = {}) {
  const keywordFilter = filters.keyword || ALL_RECORD_FILTER;
  const statusFilter = filters.status || ALL_RECORD_FILTER;
  return (Array.isArray(records) ? records : []).filter((record) => {
    const keywordMatches = keywordFilter === ALL_RECORD_FILTER
      || record.keyword === keywordFilter;
    const statusMatches = statusFilter === ALL_RECORD_FILTER
      || getRecordStatusKey(record) === statusFilter;
    return keywordMatches && statusMatches;
  });
}

function renderRecordFilters(state, filteredCount) {
  const keywords = Array.from(new Set(state.records.map((record) => record.keyword).filter(Boolean)))
    .sort((a, b) => a.localeCompare(b, "zh-CN"));
  const statusOptions = Object.entries(RECORD_STATUS_META);
  return `
    <div class="news-record-filters" aria-label="运行记录筛选">
      <label class="news-filter-control">
        <span>关键词</span>
        <select data-record-filter="keyword">
          <option value="${ALL_RECORD_FILTER}">全部关键词</option>
          ${keywords.map((keyword) => `<option value="${escapeHtml(keyword)}" ${state.recordFilters.keyword === keyword ? "selected" : ""}>${escapeHtml(keyword)}</option>`).join("")}
        </select>
      </label>
      <label class="news-filter-control">
        <span>状态</span>
        <select data-record-filter="status">
          <option value="${ALL_RECORD_FILTER}">全部状态</option>
          ${statusOptions.map(([statusKey, meta]) => `<option value="${statusKey}" ${state.recordFilters.status === statusKey ? "selected" : ""}>${meta.label}</option>`).join("")}
        </select>
      </label>
      <span class="news-filter-result">显示 ${filteredCount} / ${state.records.length} 条</span>
    </div>
  `;
}

function renderRecords(state) {
  const records = filterRecords(state.records, state.recordFilters);
  return `
    <section class="news-content-card news-table-page">
      <div class="news-panel-head">
        <div><h2>运行记录</h2><p>每次关键词采集单独记录；每一种状态最多保留 ${formatLimitValue(state.taskRecordsPerStatusLimit)}。</p></div>
      </div>
      ${renderRecordFilters(state, records.length)}
      <div class="news-table-shell records" tabindex="0" aria-label="可滚动的运行记录表格">
        <table class="news-table">
          <thead><tr><th>任务编号</th><th>开始时间</th><th>关键词</th><th>轮次</th><th>状态</th><th>数据量</th><th>耗时</th></tr></thead>
          <tbody>
            ${records.length ? records.map((record) => `
              <tr>
                <td><button class="news-task-id-button" type="button" data-action="open-task-detail" data-record-id="${escapeHtml(record.id)}" title="查看当前关键词任务明细"><code>${escapeHtml(getTaskId(record))}</code></button></td>
                <td>${escapeHtml(record.startedAt)}</td>
                <td>${escapeHtml(record.keyword || "-")}</td>
                <td>${escapeHtml(record.round || "-")}</td>
                <td title="${escapeHtml(record.error || "")}">${renderRecordStatus(record)}</td>
                <td>${record.resultCount}</td>
                <td>${escapeHtml(record.duration || "-")}</td>
              </tr>
            `).join("") : `<tr><td class="news-table-empty" colspan="7">${state.records.length ? "没有符合筛选条件的记录" : "暂无运行记录"}</td></tr>`}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function renderTaskDetails(state) {
  if (!state.taskDetailRecordId) return "";
  return renderTaskDetailModal({
    detail: getTaskRecordDetails(state.records, state.taskDetailRecordId),
    prefix: "news",
    featureName: "Google 新闻监控",
    escapeHtml,
    renderStatus: renderRecordStatus
  });
}

function renderData(state) {
  const filteredRows = filterDataRows(state.dataRows, DATA_FILTER_DEFINITIONS, state.dataFilters);
  return `
    <section class="news-content-card news-table-page">
      <div class="news-panel-head">
        <div><h2>数据</h2><p>共 ${state.dataRows.length} 条，最多保留 ${formatLimitValue(state.dataStorageLimit)}；发布时间和采集时间统一为 YYYY-MM-DD HH:mm:ss。</p></div>
      </div>
      ${renderDataFilterPanel({ rows: state.dataRows, definitions: DATA_FILTER_DEFINITIONS, values: state.dataFilters, expanded: state.dataFiltersOpen, escapeHtml })}
      <div class="news-table-shell data" tabindex="0" aria-label="可滚动的 Google 新闻采集数据表格">
        <table class="news-table news-data-table">
          <thead><tr><th>关键词</th><th>新闻标题</th><th>描述</th><th>来源</th><th>发布时间</th><th>采集时间</th><th>链接</th></tr></thead>
          <tbody>
            ${filteredRows.length ? filteredRows.map((row) => `
              <tr>
                <td>${escapeHtml(row.keyword)}</td>
                <td class="news-title-cell" title="${escapeHtml(row.title)}">${escapeHtml(row.title)}</td>
                <td class="news-description-cell" title="${escapeHtml(row.description || row.desc || "")}">${escapeHtml(row.description || row.desc || "-")}</td>
                <td>${escapeHtml(row.source || "-")}</td>
                <td>${escapeHtml(row.publishedAt || "-")}</td>
                <td>${escapeHtml(row.collectedAt || "-")}</td>
                <td><a href="${escapeHtml(row.url)}" target="_blank" rel="noreferrer">打开</a></td>
              </tr>
            `).join("") : `<tr><td class="news-table-empty" colspan="7">${state.dataRows.length ? "没有符合筛选条件的数据" : "运行后，Google 新闻结果会显示在这里"}</td></tr>`}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function renderWorkspace(state) {
  if (state.tab === "records") return renderRecords(state);
  if (state.tab === "data") return renderData(state);
  return renderParameters(state);
}

function renderNotice(state) {
  if (!state.notice) return "";
  return `<div class="news-notice ${escapeHtml(state.notice.tone || "info")}" role="status">${escapeHtml(state.notice.text)}</div>`;
}

function renderBatchModal(state) {
  if (!state.batchOpen) return "";
  return `
    <div class="news-modal-backdrop">
      <section class="news-batch-modal" role="dialog" aria-modal="true" aria-labelledby="newsBatchTitle">
        <header>
          <div><span>BATCH EDIT</span><h2 id="newsBatchTitle">批量编辑关键词</h2></div>
          <button class="news-modal-close" type="button" data-action="close-batch" aria-label="关闭批量编辑">X</button>
        </header>
        <p>每行一个关键词，也支持使用逗号分隔；应用后会替换当前列表。</p>
        <label for="newsBatchInput">关键词列表</label>
        <textarea id="newsBatchInput" data-batch-input rows="10" placeholder="OpenAI&#10;人工智能">${escapeHtml(state.batchDraft)}</textarea>
        <footer>
          <button class="news-secondary-button" type="button" data-action="close-batch">取消</button>
          <button class="news-primary-button" type="button" data-action="apply-batch">应用关键词</button>
        </footer>
      </section>
    </div>
  `;
}

function renderRunButton(state, className = "") {
  if (state.running) {
    return `<button class="news-stop-button ${className}" type="button" data-action="stop" ${state.stopping ? "disabled" : ""}>${state.stopping ? "停止中…" : "停止全部"}</button>`;
  }
  return `<button class="news-primary-button ${className}" type="button" data-action="run">运行</button>`;
}

function renderActionBar(state) {
  if (state.tab === "params") {
    return `
      <footer class="news-action-bar">
        ${renderRunButton(state)}
        <button class="news-secondary-button" type="button" data-action="reset" ${state.running ? "disabled" : ""}>还原示例输入</button>
        <span>${state.verificationPending ? "等待你在 Google 页面完成人机验证；完成后任务会自动恢复。" : state.running ? "任务运行中，参数已锁定；可点击停止终止任务。" : isExtensionRuntime() ? "无需预先打开 Google 页面，扩展会自动准备标签页。" : "网页预览仅打开搜索页；扩展环境才会采集数据。"}</span>
      </footer>
    `;
  }
  if (state.tab === "records") {
    return `
      <footer class="news-action-bar news-table-action-bar">
        <button class="news-secondary-button" type="button" data-action="clear-records" ${state.records.length && !state.running ? "" : "disabled"}>清空记录</button>
        <span>当前 ${state.records.length} 条 · 每种状态最多保留 ${formatLimitValue(state.taskRecordsPerStatusLimit)}</span>
      </footer>
    `;
  }
  if (state.tab === "data") {
    const filteredRows = filterDataRows(state.dataRows, DATA_FILTER_DEFINITIONS, state.dataFilters);
    return `
      <footer class="news-action-bar news-table-action-bar">
        <button class="news-secondary-button emphasized" type="button" data-action="copy-json" ${filteredRows.length ? "" : "disabled"}>复制 JSON</button>
        <button class="news-secondary-button emphasized" type="button" data-action="export-csv" ${filteredRows.length ? "" : "disabled"}>导出表格</button>
        <button class="news-secondary-button" type="button" data-action="clear-data" ${state.dataRows.length ? "" : "disabled"}>清空数据</button>
        <span>筛选结果 ${filteredRows.length} / ${state.dataRows.length} 条 · 最多保留 ${formatLimitValue(state.dataStorageLimit)}</span>
      </footer>
    `;
  }
  return "";
}

function renderPage(state, context) {
  const isTableTab = state.tab === "records" || state.tab === "data";
  const hasFixedActions = state.tab === "params" || isTableTab;
  return `
    <section class="news-monitor ${hasFixedActions ? "has-fixed-actions" : ""}" aria-labelledby="newsMonitorTitle">
      <header class="news-hero">
        <div class="news-title-row">
          <h1 id="newsMonitorTitle">${escapeHtml(context.feature.name)}</h1>
          <span class="news-version">v0.4.4</span>
          <button
            class="news-guide-button ${state.guideOpen ? "active" : ""}"
            type="button"
            data-action="open-guide"
            aria-haspopup="dialog"
            aria-expanded="${state.guideOpen}"
            title="查看使用说明"
          >
            <span>使用说明</span>
            <img src="src/assets/icons/question-circle.svg" alt="" aria-hidden="true">
          </button>
        </div>
        ${renderRunButton(state, "news-top-run")}
      </header>
      <nav class="news-tabs" role="tablist" aria-label="Google 新闻监控页面">${renderTabs(state)}</nav>
      ${renderNotice(state)}
      <div class="news-workspace ${hasFixedActions ? "has-fixed-actions" : ""} ${isTableTab ? "is-table-view" : ""}">${renderWorkspace(state)}</div>
      ${renderActionBar(state)}
      ${renderBatchModal(state)}
      ${renderGuideModal(state)}
      ${renderTaskDetails(state)}
    </section>
  `;
}

function normalizeStoredDataRow(row) {
  const capturedAt = row.capturedAt || row.collectedAt || "";
  // 旧版本的 row.time 实际含义不可靠，不能再回填为真正发布时间。
  const publishedAtRaw = row.publishedAtRaw || row.publishedAt || "";
  const publishedAt = row.publishedAtTimestamp
    ? formatLocalDateTime(row.publishedAtTimestamp)
    : normalizePublishedDateTime(publishedAtRaw, { referenceDate: capturedAt });
  const collectedAt = capturedAt ? formatLocalDateTime(capturedAt) : "";
  return {
    ...row,
    description: row.description || row.desc || "",
    time: publishedAt,
    publishedAt,
    publishedAtRaw,
    collectedAt,
    capturedAt
  };
}

function mergeDataRows(state, keyword, data, task) {
  const capturedAt = data?.capturedAt || new Date().toISOString();
  const collectedAt = formatLocalDateTime(capturedAt);
  const incoming = (data?.results || []).map((result) => {
    const publishedAtRaw = result.publishedAtRaw || result.publishedAt || "";
    const publishedAtTimestamp = result.publishedAtTimestamp || "";
    const publishedAt = publishedAtTimestamp
      ? formatLocalDateTime(publishedAtTimestamp)
      : normalizePublishedDateTime(publishedAtRaw, { referenceDate: capturedAt });
    return {
      id: `${keyword}|${result.url || result.title}`,
      keyword,
      title: result.title || "",
      description: result.description || result.desc || "",
      source: result.source || "",
      time: publishedAt,
      publishedAt,
      publishedAtRaw,
      publishedAtLabel: result.publishedAtLabel || "",
      publishedAtTimestamp,
      collectedAt,
      url: result.url || "",
      capturedAt
    };
  });
  const existing = new Map(state.dataRows.map((row) => [row.id, row]));
  let added = 0;
  for (const row of incoming) {
    if (!existing.has(row.id)) added += 1;
    existing.set(row.id, tagTaskDataRow({ ...existing.get(row.id), ...row }, task));
  }
  state.dataRows = applyItemLimit(
    [...existing.values()].sort((a, b) => String(b.capturedAt).localeCompare(String(a.capturedAt))),
    state.dataStorageLimit
  );
  return added;
}

export async function mountGoogleNewsMonitor(container, context) {
  ensureGoogleNewsCaptureStatusListener();
  const storageLimits = await loadGlobalStorageLimits().catch(() => ({
    dataStorageLimit: 3000,
    taskRecordsPerStatusLimit: 200
  }));
  const saved = await loadSavedState().catch(() => null);
  const savedConfig = migrateLegacyExecutionInterval(saved?.config, {
    minKey: "keywordIntervalMinMs",
    maxKey: "keywordIntervalMaxMs",
    legacyMinMs: 100,
    legacyMaxMs: 1000
  });
  const state = {
    tab: "params",
    mode: "form",
    config: savedConfig ? normalizeConfig(savedConfig) : cloneSampleConfig(),
    jsonDraft: "",
    batchOpen: false,
    batchDraft: "",
    inputListPage: 1,
    guideOpen: false,
    taskDetailRecordId: "",
    optionsOpen: false,
    running: Boolean(activeGoogleNewsRun),
    stopping: Boolean(activeGoogleNewsRun?.stopRequested),
    verificationPending: Boolean(activeGoogleNewsRun?.verificationPending),
    recordFilters: { keyword: ALL_RECORD_FILTER, status: ALL_RECORD_FILTER },
    dataFilters: createDataFilterValues(DATA_FILTER_DEFINITIONS),
    dataFiltersOpen: true,
    notice: saved?.notice || (!isExtensionRuntime()
      ? { tone: "info", text: "当前是网页预览：运行会打开 Google 新闻搜索页；数据采集请在 Chrome 中加载扩展后测试。" }
      : null),
    dataStorageLimit: storageLimits.dataStorageLimit,
    taskRecordsPerStatusLimit: storageLimits.taskRecordsPerStatusLimit,
    records: limitRecordsPerStatus(saved?.records, storageLimits.taskRecordsPerStatusLimit),
    dataRows: Array.isArray(saved?.dataRows)
      ? applyItemLimit(
        saved.dataRows.map(normalizeStoredDataRow),
        storageLimits.dataStorageLimit
      )
      : []
  };
  saveState(state);
  let disposed = false;
  let activeRun = activeGoogleNewsRun;

  const syncJsonDraft = () => {
    state.jsonDraft = JSON.stringify(state.config, null, 2);
  };

  const render = () => {
    if (!disposed) container.innerHTML = renderPage(state, context);
  };

  const closeBatch = () => {
    state.batchOpen = false;
    render();
  };

  const openBatch = () => {
    state.batchDraft = state.config.keywords.join("\n");
    state.guideOpen = false;
    state.batchOpen = true;
    render();
    requestAnimationFrame(() => container.querySelector("[data-batch-input]")?.focus());
  };

  const closeGuide = () => {
    state.guideOpen = false;
    render();
    requestAnimationFrame(() => container.querySelector('[data-action="open-guide"]')?.focus());
  };

  const closeTaskDetails = () => {
    state.taskDetailRecordId = "";
    render();
  };

  const openTaskDetails = (recordId) => {
    if (!recordId) return;
    state.batchOpen = false;
    state.guideOpen = false;
    state.taskDetailRecordId = recordId;
    render();
    requestAnimationFrame(() => container.querySelector("[data-task-detail-close]")?.focus());
  };

  const openGuide = () => {
    state.batchOpen = false;
    state.guideOpen = true;
    render();
    requestAnimationFrame(() => container.querySelector("[data-guide-autofocus]")?.focus());
  };

  const applyJsonDraft = () => {
    try {
      state.config = normalizeConfig(JSON.parse(state.jsonDraft));
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

  const createKeywordRecord = (control, keyword, round, keywordIndex) => {
    const startedAtMs = Date.now();
    const record = {
      id: `${control.runId}-R${round}-K${keywordIndex + 1}`,
      runId: control.runId,
      startedAt: formatTime(new Date(startedAtMs)),
      keyword,
      round,
      status: RECORD_STATUS_META.running.label,
      statusKey: "running",
      tone: RECORD_STATUS_META.running.tone,
      resultCount: 0,
      duration: "-",
      error: ""
    };
    state.records.unshift(record);
    state.records = limitRecordsPerStatus(state.records, state.taskRecordsPerStatusLimit);
    return { record, startedAtMs };
  };

  const finishRecord = (record, startedAtMs, statusKey, resultCount = 0, error = "") => {
    const meta = RECORD_STATUS_META[statusKey] || RECORD_STATUS_META.error;
    record.status = meta.label;
    record.statusKey = statusKey;
    record.tone = meta.tone;
    record.resultCount = resultCount;
    record.error = error;
    record.duration = formatDuration(Date.now() - startedAtMs);
    state.records = limitRecordsPerStatus(state.records, state.taskRecordsPerStatusLimit);
  };

  const startRun = async () => {
    if (state.running) return;
    const keywords = Array.from(new Set(state.config.keywords.map((item) => item.trim()).filter(Boolean)));
    if (!keywords.length) {
      state.notice = { tone: "error", text: "请至少填写一个关键词后再运行。" };
      render();
      return;
    }

    state.config.keywords = keywords;
    syncJsonDraft();
    const runStartedAtMs = Date.now();
    const control = {
      runId: `GN-${String(runStartedAtMs).slice(-8)}`,
      stopRequested: false,
      riskControlTriggered: false,
      riskCleanupPromise: null,
      verificationPending: false,
      verificationTabId: null,
      verificationRunId: "",
      verificationCycle: 0,
      activeCaptureRunIds: new Set(),
      ownedTargetTabIds: new Set()
    };
    activeRun = control;
    activeGoogleNewsRun = control;
    state.running = true;
    state.stopping = false;
    state.notice = { tone: "info", text: `正在准备 ${keywords.length} 个关键词的 Google 新闻搜索…` };
    render();

    if (!isExtensionRuntime()) {
      let previewTab = null;
      let openedCount = 0;
      let previewError = "";

      for (let index = 0; index < keywords.length; index += 1) {
        if (control.stopRequested) break;
        const keyword = keywords[index];
        const previewRecord = createKeywordRecord(control, keyword, 1, index);
        state.notice = { tone: "info", text: `网页预览正在打开 ${index + 1}/${keywords.length}：${keyword}` };
        render();

        try {
          const searchUrl = buildGoogleNewsSearchUrl(keyword, state.config);
          if (!previewTab) {
            previewTab = globalThis.open(searchUrl, "_blank");
            if (!previewTab) throw new Error("浏览器阻止了新标签页");
            previewTab.opener = null;
          } else {
            previewTab.location.href = searchUrl;
          }
          openedCount += 1;
          finishRecord(previewRecord.record, previewRecord.startedAtMs, "preview");
        } catch (error) {
          const errorText = error.message || String(error);
          previewError = errorText;
          finishRecord(previewRecord.record, previewRecord.startedAtMs, "error", 0, errorText);
          state.notice = { tone: "error", text: `${keyword} 打开失败：${errorText}` };
          break;
        }

        saveState(state);
        render();
        if (index < keywords.length - 1) {
          await waitForKeywordInterval(state.config, control, {
            onWait: (intervalMs) => {
              state.notice = {
                tone: "info",
                text: `“${keyword}”已打开，本次随机等待 ${intervalMs} ms（范围 ${formatKeywordIntervalRange(state.config)}），然后搜索“${keywords[index + 1]}”…`
              };
              render();
            }
          });
        }
      }

      state.running = false;
      state.stopping = false;
      activeRun = null;
      if (activeGoogleNewsRun === control) activeGoogleNewsRun = null;
      state.notice = control.stopRequested
        ? { tone: "warning", text: `网页预览已停止，共打开 ${openedCount} 个关键词。` }
        : previewError
          ? { tone: "error", text: `网页预览中断：已打开 ${openedCount} 个关键词；${previewError}` }
          : { tone: "success", text: `网页预览完成：已按间隔依次打开 ${openedCount} 个关键词；扩展环境会继续采集并回填数据。` };
      saveState(state);
      render();
      globalThis.dispatchEvent?.(new Event(GOOGLE_NEWS_RUN_FINISHED_EVENT));
      return;
    }

    await setFeatureRunning(FEATURE_KEY, true);
    const taskTimeoutSeconds = await loadTaskTimeoutSeconds();
    let addedTotal = 0;
    let emptyTotal = 0;
    let riskTotal = 0;
    let completedRounds = 0;
    const haltForRiskControl = async (verificationTabId, verificationRunId) => {
      control.riskControlTriggered = true;
      control.verificationPending = true;
      control.verificationTabId = Number(verificationTabId);
      control.verificationRunId = String(verificationRunId || "");
      if (!control.riskCleanupPromise) {
        control.riskCleanupPromise = (async () => {
          await Promise.all([...control.activeCaptureRunIds]
            .filter((runId) => runId !== control.verificationRunId)
            .map((runId) => (
              sendMessage({ type: MESSAGE_STOP_GOOGLE_NEWS, options: { runId } }).catch(() => null)
            )));
          const ownedTabIds = [...control.ownedTargetTabIds]
            .filter((tabId) => tabId !== control.verificationTabId);
          await Promise.all(ownedTabIds.map((tabId) => closePluginCreatedGoogleTab(tabId)));
          ownedTabIds.forEach((tabId) => control.ownedTargetTabIds.delete(tabId));
        })();
      }
      await control.riskCleanupPromise;
    };
    const abortForUnexpectedRiskControl = async () => {
      control.riskControlTriggered = true;
      await Promise.all([...control.activeCaptureRunIds].map((runId) => (
        sendMessage({ type: MESSAGE_STOP_GOOGLE_NEWS, options: { runId } }).catch(() => null)
      )));
      const ownedTabIds = [...control.ownedTargetTabIds];
      await Promise.all(ownedTabIds.map((tabId) => closePluginCreatedGoogleTab(tabId)));
      control.ownedTargetTabIds.clear();
    };
    control.handleCaptureStatus = async (captureStatus) => {
      if (!captureStatus?.runId || !control.activeCaptureRunIds.has(captureStatus.runId)) return;
      const record = state.records.find((item) => item.id === captureStatus.runId);
      if (captureStatus.status === "waiting_verification") {
        await haltForRiskControl(captureStatus.tabId, captureStatus.runId);
        state.verificationPending = true;
        if (record) {
          record.status = RECORD_STATUS_META.verification.label;
          record.statusKey = "verification";
          record.tone = RECORD_STATUS_META.verification.tone;
          record.error = "Google 检测到异常流量，正在等待人工完成 reCAPTCHA 验证。";
        }
        state.notice = {
          tone: "error",
          text: "Google 已触发人机验证：其他 Google 关键词已暂停并关闭，只保留当前验证页。请手动完成验证，插件会自动检测并继续任务。"
        };
        state.tab = "records";
      } else if (captureStatus.status === "verification_passed") {
        state.verificationPending = true;
        if (record) record.status = "验证通过，冷却中";
        state.notice = {
          tone: "success",
          text: `Google 验证已通过，正在冷却 ${Math.round((Number(captureStatus.cooldownMs) || 0) / 1000)} 秒，然后自动恢复未完成关键词。`
        };
      } else if (captureStatus.status === "capture_resumed") {
        control.verificationPending = false;
        control.riskControlTriggered = false;
        control.riskCleanupPromise = null;
        control.verificationTabId = null;
        control.verificationRunId = "";
        control.verificationCycle += 1;
        state.verificationPending = false;
        if (record) {
          record.status = RECORD_STATUS_META.running.label;
          record.statusKey = "running";
          record.tone = RECORD_STATUS_META.running.tone;
          record.error = "";
        }
        state.notice = { tone: "info", text: "Google 验证已解除，正在恢复当前任务和未完成关键词…" };
      } else {
        return;
      }
      saveState(state);
      render();
      globalThis.dispatchEvent?.(new Event(GOOGLE_NEWS_RUN_STATUS_EVENT));
    };
    try {
      do {
        const round = completedRounds + 1;
        let roundFailed = 0;
        let roundEmpty = 0;
        let roundRisk = 0;
        let roundAdded = 0;
        const settledKeywordIndexes = new Set();
        let pendingKeywordEntries = keywords.map((keyword, index) => ({ keyword, index }));
        while (pendingKeywordEntries.length && !control.stopRequested && !control.riskControlTriggered) {
          const verificationCycleBefore = control.verificationCycle;
          await runConcurrentTasks(pendingKeywordEntries, {
            concurrency: state.config.concurrency,
            shouldStop: () => control.stopRequested || control.riskControlTriggered,
            worker: async (entry, queueIndex) => {
              const { keyword, index } = entry;
              if (queueIndex >= state.config.concurrency) {
                await waitForKeywordInterval(state.config, control, {
                  onWait: (intervalMs) => {
                    state.notice = { tone: "info", text: `正在准备后续关键词，随机等待 ${intervalMs} ms（范围 ${formatKeywordIntervalRange(state.config)}）…` };
                    saveState(state);
                    render();
                  }
                });
              }
              if (control.stopRequested || control.riskControlTriggered) return;

              const keywordRecord = createKeywordRecord(control, keyword, round, index);
              const captureRunId = keywordRecord.record.id;
              control.activeCaptureRunIds.add(captureRunId);
              state.notice = { tone: "info", text: `第 ${round} 轮，正在并发搜索 ${control.activeCaptureRunIds.size}/${state.config.concurrency} 个关键词…` };
              saveState(state);
              render();
              let tab = null;
              try {
                tab = await getOrCreateGoogleTab(null, true);
                if (!Number.isInteger(tab?.id)) throw new Error("无法创建用于 Google 新闻采集的标签页。");
                control.ownedTargetTabIds.add(tab.id);
                const response = await runWithTaskTimeout(() => sendMessage({
                    type: MESSAGE_CAPTURE_GOOGLE_NEWS,
                    options: {
                      runId: captureRunId,
                      tabId: tab.id,
                      query: keyword,
                      limit: state.config.limit,
                      language: state.config.language
                    }
                  }), {
                  timeoutSeconds: taskTimeoutSeconds,
                  isPaused: () => control.verificationPending && control.verificationRunId === captureRunId,
                  onTimeout: async () => {
                    await sendMessage({ type: MESSAGE_STOP_GOOGLE_NEWS, options: { runId: captureRunId } }).catch(() => null);
                    await closePluginCreatedGoogleTab(tab.id);
                    control.ownedTargetTabIds.delete(tab.id);
                  }
                });
                if (control.stopRequested) {
                  finishRecord(keywordRecord.record, keywordRecord.startedAtMs, "stopped");
                  return;
                }
                if (!response?.ok) {
                  const responseError = new Error(response?.error || "采集失败");
                  responseError.code = response?.errorCode || "";
                  throw responseError;
                }
                await closePluginCreatedGoogleTab(tab.id);
                control.ownedTargetTabIds.delete(tab.id);
                if (response.empty) {
                  roundEmpty += 1;
                  emptyTotal += 1;
                  settledKeywordIndexes.add(index);
                  finishRecord(keywordRecord.record, keywordRecord.startedAtMs, "empty", 0);
                  return;
                }
                const added = mergeDataRows(state, keyword, response.data, {
                  runId: control.runId,
                  recordId: keywordRecord.record.id
                });
                roundAdded += added;
                addedTotal += added;
                settledKeywordIndexes.add(index);
                finishRecord(keywordRecord.record, keywordRecord.startedAtMs, "success", added);
              } catch (error) {
                if (control.stopRequested) {
                  finishRecord(keywordRecord.record, keywordRecord.startedAtMs, "stopped");
                } else if (control.verificationPending && captureRunId !== control.verificationRunId) {
                  state.records = state.records.filter((item) => item !== keywordRecord.record);
                } else if (control.verificationPending && captureRunId === control.verificationRunId) {
                  const errorText = error.message || String(error);
                  control.verificationPending = false;
                  control.riskControlTriggered = false;
                  control.riskCleanupPromise = null;
                  control.verificationTabId = null;
                  control.verificationRunId = "";
                  state.verificationPending = false;
                  roundFailed += 1;
                  settledKeywordIndexes.add(index);
                  finishRecord(keywordRecord.record, keywordRecord.startedAtMs, "error", 0, errorText);
                  state.notice = { tone: "error", text: `Google 验证流程中断：${errorText}` };
                } else if (isGoogleNewsRiskControlError(error)) {
                  const errorText = error.message || String(error);
                  roundRisk += 1;
                  riskTotal += 1;
                  settledKeywordIndexes.add(index);
                  await abortForUnexpectedRiskControl();
                  finishRecord(keywordRecord.record, keywordRecord.startedAtMs, "risk", 0, errorText);
                  state.notice = {
                    tone: "error",
                    text: "Google 风控状态通知异常，已停止本批任务并关闭采集标签页。请重新加载扩展后再试。"
                  };
                } else {
                  const errorText = error.message || String(error);
                  roundFailed += 1;
                  settledKeywordIndexes.add(index);
                  finishRecord(keywordRecord.record, keywordRecord.startedAtMs, "error", 0, errorText);
                  state.notice = { tone: "error", text: `${keyword} 采集失败：${errorText}` };
                }
              } finally {
                control.activeCaptureRunIds.delete(captureRunId);
                saveState(state);
                render();
              }
            }
          });

          const nextPendingEntries = keywords
            .map((keyword, index) => ({ keyword, index }))
            .filter((entry) => !settledKeywordIndexes.has(entry.index));
          if (!nextPendingEntries.length || control.stopRequested || control.riskControlTriggered) break;
          if (control.verificationCycle <= verificationCycleBefore) break;
          pendingKeywordEntries = nextPendingEntries;
          state.notice = { tone: "info", text: `Google 验证已解除，正在恢复 ${pendingKeywordEntries.length} 个未完成关键词…` };
          saveState(state);
          render();
        }

        saveState(state);
        if (control.stopRequested) break;
        if (control.riskControlTriggered) {
          state.notice = {
            tone: "error",
            text: `本轮触发 Google 风控 ${roundRisk} 个任务，已停止剩余关键词并关闭插件创建的采集标签页；本次已新增 ${addedTotal} 条数据。请稍后再运行。`
          };
          state.tab = "records";
          break;
        }
        completedRounds = round;

        if (!state.config.polling) {
          state.notice = {
            tone: roundFailed ? "error" : emptyTotal ? "info" : "success",
            text: `运行结束：新增 ${addedTotal} 条数据，无数据 ${emptyTotal} 个关键词，风控 ${riskTotal} 个关键词，失败 ${roundFailed} 个关键词。`
          };
          state.tab = addedTotal ? "data" : "records";
          break;
        }

        const pollingMs = state.config.pollingMinutes * 60 * 1000;
        const nextRunAt = new Date(Date.now() + pollingMs);
        state.notice = {
          tone: roundFailed ? "warning" : "success",
          text: `第 ${round} 轮完成，新增 ${roundAdded} 条，无数据 ${roundEmpty} 个关键词；下一轮 ${formatTime(nextRunAt)} 开始。`
        };
        saveState(state);
        render();
        await waitWhileRunning(pollingMs, control);
      } while (!control.stopRequested);

      if (control.stopRequested) {
        state.notice = { tone: "warning", text: `循环监控已停止，共完成 ${completedRounds} 轮，新增 ${addedTotal} 条数据。` };
        state.tab = "records";
      }
    } catch (error) {
      const errorText = error.message || String(error);
      if (!control.stopRequested) {
        keywords.forEach((keyword, index) => {
          const failedRecord = createKeywordRecord(control, keyword, completedRounds + 1, index);
          finishRecord(failedRecord.record, failedRecord.startedAtMs, "error", 0, errorText);
        });
      }
      if (control.stopRequested) {
        state.notice = { tone: "warning", text: `任务已停止，停止前新增 ${addedTotal} 条数据。` };
      } else {
        state.notice = { tone: "error", text: errorText };
      }
      state.tab = "records";
    } finally {
      await setFeatureRunning(FEATURE_KEY, false);
      if (activeGoogleNewsRun === control) {
        activeGoogleNewsRun = null;
      }
      if (activeRun === control) {
        activeRun = null;
        state.running = false;
        state.stopping = false;
      }
      control.verificationPending = false;
      state.verificationPending = false;
      saveState(state);
      render();
      globalThis.dispatchEvent?.(new Event(GOOGLE_NEWS_RUN_FINISHED_EVENT));
    }
  };

  const stopRun = async () => {
    const control = activeRun || activeGoogleNewsRun;
    if (!state.running || !control || control.stopRequested) return;
    control.stopRequested = true;
    state.stopping = true;
    state.notice = { tone: "warning", text: "正在停止全部并发任务并释放浏览器连接…" };
    render();

    if (isExtensionRuntime()) {
      await Promise.all([...control.activeCaptureRunIds].map((runId) => (
        sendMessage({ type: MESSAGE_STOP_GOOGLE_NEWS, options: { runId } }).catch(() => null)
      )));
      await Promise.all([...control.ownedTargetTabIds].map((tabId) => closePluginCreatedGoogleTab(tabId)));
      control.ownedTargetTabIds.clear();
    }
  };

  const handleLiveRunFinished = async () => {
    if (activeGoogleNewsRun || !state.running) return;
    const latest = await loadSavedState().catch(() => null);
    state.running = false;
    state.stopping = false;
    state.verificationPending = false;
    state.config = latest?.config ? normalizeConfig(latest.config) : state.config;
    state.records = limitRecordsPerStatus(latest?.records || state.records, state.taskRecordsPerStatusLimit);
    state.dataRows = Array.isArray(latest?.dataRows)
      ? applyItemLimit(
        latest.dataRows.map(normalizeStoredDataRow),
        state.dataStorageLimit
      )
      : state.dataRows;
    state.notice = latest?.notice || state.notice;
    syncJsonDraft();
    render();
  };

  const handleLiveRunStatus = async () => {
    const latest = await loadSavedState().catch(() => null);
    state.running = Boolean(activeGoogleNewsRun);
    state.stopping = Boolean(activeGoogleNewsRun?.stopRequested);
    state.verificationPending = Boolean(activeGoogleNewsRun?.verificationPending);
    state.records = limitRecordsPerStatus(latest?.records || state.records, state.taskRecordsPerStatusLimit);
    state.dataRows = Array.isArray(latest?.dataRows)
      ? applyItemLimit(
        latest.dataRows.map(normalizeStoredDataRow),
        state.dataStorageLimit
      )
      : state.dataRows;
    state.notice = latest?.notice || state.notice;
    render();
  };

  const handleClick = async (event) => {
    if (event.target.matches(".news-modal-backdrop")) {
      if (state.taskDetailRecordId) closeTaskDetails();
      else if (state.guideOpen) closeGuide();
      else closeBatch();
      return;
    }

    const tab = event.target.closest("[data-tab]");
    if (tab) {
      state.tab = tab.dataset.tab;
      render();
      return;
    }

    const button = event.target.closest("[data-action]");
    if (!button || button.disabled) return;
    const action = button.dataset.action;

    if (action === "run") {
      startRun().catch((error) => {
        const failedRun = activeRun;
        activeRun = null;
        if (activeGoogleNewsRun === failedRun) activeGoogleNewsRun = null;
        state.running = false;
        state.stopping = false;
        state.notice = { tone: "error", text: error.message || String(error) };
        render();
      });
      return;
    }
    if (action === "stop") {
      stopRun().catch((error) => {
        state.notice = { tone: "error", text: `停止任务失败：${error.message || String(error)}` };
        render();
      });
      return;
    }
    if (action === "set-mode") {
      const nextMode = button.dataset.mode;
      if (nextMode === "form" && state.mode === "json" && !applyJsonDraft()) {
        render();
        return;
      }
      if (nextMode === "json") syncJsonDraft();
      state.mode = nextMode;
      render();
      return;
    }
    if (action === "set-input-list-page") {
      state.inputListPage = clampInputListPage(button.dataset.page, state.config.keywords);
      render();
      return;
    }
    if (action === "add-keyword") {
      state.config.keywords.push("");
      state.inputListPage = pageForInputIndex(state.config.keywords.length - 1);
      render();
      container.querySelector(`[data-keyword-index="${state.config.keywords.length - 1}"]`)?.focus();
      return;
    }
    if (action === "remove-keyword") {
      state.config.keywords.splice(Number(button.dataset.index), 1);
      state.inputListPage = clampInputListPage(state.inputListPage, state.config.keywords);
      saveState(state);
      render();
      return;
    }
    if (action === "open-batch") {
      openBatch();
      return;
    }
    if (action === "open-guide") {
      openGuide();
      return;
    }
    if (action === "open-task-detail") {
      openTaskDetails(button.dataset.recordId);
      return;
    }
    if (action === "close-task-detail") {
      closeTaskDetails();
      return;
    }
    if (action === "close-guide") {
      closeGuide();
      return;
    }
    if (action === "close-batch") {
      closeBatch();
      return;
    }
    if (action === "apply-batch") {
      const keywords = Array.from(new Set(state.batchDraft.split(/[\n,，;；]+/).map((item) => item.trim()).filter(Boolean)));
      if (!keywords.length) {
        state.notice = { tone: "error", text: "批量列表中至少需要一个关键词。" };
        render();
        requestAnimationFrame(() => container.querySelector("[data-batch-input]")?.focus());
      } else {
        state.config.keywords = keywords;
        state.inputListPage = 1;
        state.batchOpen = false;
        state.notice = { tone: "success", text: `已应用 ${keywords.length} 个关键词。` };
        syncJsonDraft();
        saveState(state);
        render();
      }
      return;
    }
    if (action === "toggle-options") {
      state.optionsOpen = !state.optionsOpen;
      render();
      return;
    }
    if (action === "toggle-data-filters") {
      state.dataFiltersOpen = !state.dataFiltersOpen;
      render();
      return;
    }
    if (action === "clear-data-filters") {
      state.dataFilters = createDataFilterValues(DATA_FILTER_DEFINITIONS);
      render();
      return;
    }
    if (action === "apply-json") {
      applyJsonDraft();
      render();
      return;
    }
    if (action === "clear-records") {
      state.records = [];
      state.recordFilters = { keyword: ALL_RECORD_FILTER, status: ALL_RECORD_FILTER };
      state.taskDetailRecordId = "";
      saveState(state);
      render();
      return;
    }
    if (action === "copy-json") {
      const rows = filterDataRows(state.dataRows, DATA_FILTER_DEFINITIONS, state.dataFilters);
      try {
        openRowsJsonPreview(rows, buildGoogleNewsExportRows);
      } catch (error) {
        state.notice = { tone: "error", text: `打开 JSON 数据失败：${error.message || String(error)}` };
        render();
      }
      return;
    }
    if (action === "export-csv") {
      const rows = filterDataRows(state.dataRows, DATA_FILTER_DEFINITIONS, state.dataFilters);
      downloadGoogleNewsData(rows, "csv");
      state.notice = { tone: "success", text: `已导出 ${rows.length} 条筛选后的表格数据（CSV）。` };
      render();
      return;
    }
    if (action === "clear-data") {
      state.dataRows = [];
      state.dataFilters = createDataFilterValues(DATA_FILTER_DEFINITIONS);
      saveState(state);
      render();
      return;
    }
    if (action === "reset") {
      state.config = cloneSampleConfig();
      state.inputListPage = 1;
      state.optionsOpen = false;
      state.notice = { tone: "success", text: "已还原示例输入。" };
      syncJsonDraft();
      saveState(state);
      render();
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
    const keywordIndex = event.target.dataset.keywordIndex;
    if (keywordIndex !== undefined) {
      state.config.keywords[Number(keywordIndex)] = event.target.value;
      return;
    }
    if (event.target.matches("[data-json-input]")) {
      state.jsonDraft = event.target.value;
      return;
    }
    if (event.target.matches("[data-batch-input]")) {
      state.batchDraft = event.target.value;
      return;
    }
    const field = event.target.dataset.field;
    if (field === "limit") state.config.limit = asInteger(event.target.value, state.config.limit, 1, 100);
    if (field === "concurrency") state.config.concurrency = normalizeTaskConcurrency(event.target.value, state.config.concurrency);
    if (field === "keywordIntervalMinMs") state.config.keywordIntervalMinMs = asInteger(event.target.value, state.config.keywordIntervalMinMs, 0, 60000);
    if (field === "keywordIntervalMaxMs") state.config.keywordIntervalMaxMs = asInteger(event.target.value, state.config.keywordIntervalMaxMs, 0, 60000);
    if (field === "pollingMinutes") state.config.pollingMinutes = asInteger(event.target.value, state.config.pollingMinutes, 1, 1440);
  };

  const handleChange = (event) => {
    const dataFilter = event.target.dataset.dataFilter;
    if (dataFilter) {
      state.dataFilters[dataFilter] = event.target.value;
      render();
      return;
    }
    const recordFilter = event.target.dataset.recordFilter;
    if (recordFilter) {
      state.recordFilters[recordFilter] = event.target.value;
      render();
      return;
    }
    const field = event.target.dataset.field;
    if (!field) return;
    if (field === "keywordIntervalMinMs" || field === "keywordIntervalMaxMs") {
      Object.assign(state.config, normalizeKeywordIntervalRange(state.config));
      syncJsonDraft();
      saveState(state);
      render();
      return;
    }
    if (field === "language") state.config.language = event.target.value;
    if (field === "concurrency") state.config.concurrency = normalizeTaskConcurrency(state.config.concurrency);
    if (field === "polling") {
      state.config.polling = event.target.checked;
      render();
    }
    saveState(state);
  };

  const handleKeydown = (event) => {
    if (event.key !== "Escape") return;
    if (state.taskDetailRecordId) closeTaskDetails();
    else if (state.guideOpen) closeGuide();
    else if (state.batchOpen) closeBatch();
  };

  syncJsonDraft();
  container.addEventListener("click", handleClick);
  container.addEventListener("input", handleInput);
  container.addEventListener("change", handleChange);
  document.addEventListener("keydown", handleKeydown);
  globalThis.addEventListener?.(GOOGLE_NEWS_RUN_FINISHED_EVENT, handleLiveRunFinished);
  globalThis.addEventListener?.(GOOGLE_NEWS_RUN_STATUS_EVENT, handleLiveRunStatus);
  render();

  return () => {
    // 切换功能页面只卸载界面和事件；正在运行的任务继续保持运行。
    disposed = true;
    container.removeEventListener("click", handleClick);
    container.removeEventListener("input", handleInput);
    container.removeEventListener("change", handleChange);
    document.removeEventListener("keydown", handleKeydown);
    globalThis.removeEventListener?.(GOOGLE_NEWS_RUN_FINISHED_EVENT, handleLiveRunFinished);
    globalThis.removeEventListener?.(GOOGLE_NEWS_RUN_STATUS_EVENT, handleLiveRunStatus);
    container.replaceChildren();
  };
}

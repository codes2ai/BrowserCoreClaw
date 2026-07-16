import { downloadXiaohongshuKeywordData } from "./export-data.js";
import {
  MESSAGE_CAPTURE_XIAOHONGSHU_KEYWORD,
  MESSAGE_STOP_XIAOHONGSHU_KEYWORD
} from "./constants.js";
import {
  getXiaohongshuFilterLabel,
  getXiaohongshuFilterSummary,
  normalizeXiaohongshuFilters,
  XIAOHONGSHU_FILTER_GROUPS
} from "./filter-options.js";
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
import { normalizeXiaohongshuPublishedDate } from "../date-normalizer.js";
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

const STORAGE_KEY = "browserCoreClawXiaohongshuKeywordV1";
const FEATURE_KEY = "xiaohongshu/keyword-search";
const ALL_RECORD_FILTER = "__all__";
const RECORD_STATUS_META = Object.freeze({
  running: { label: "运行中", tone: "running" },
  success: { label: "完成", tone: "success" },
  partial: { label: "部分完成", tone: "warning" },
  error: { label: "失败", tone: "error" },
  stopped: { label: "已停止", tone: "stopped" },
  preview: { label: "待接入", tone: "preview" }
});
const SAMPLE_CONFIG = Object.freeze({
  keywords: ["穿搭", "护肤"],
  limit: 20,
  keywordIntervalMinMs: DEFAULT_EXECUTION_INTERVAL_MIN_MS,
  keywordIntervalMaxMs: DEFAULT_EXECUTION_INTERVAL_MAX_MS,
  concurrency: DEFAULT_TASK_CONCURRENCY,
  ...normalizeXiaohongshuFilters(),
  polling: false,
  pollingMinutes: 10
});

// 与 Google 新闻监控相同：功能页面的卸载不应终止仍在执行的采集任务。
let activeXiaohongshuKeywordRun = null;
const XIAOHONGSHU_KEYWORD_RUN_FINISHED_EVENT = "browser-core-claw-xiaohongshu-keyword-run-finished";

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
    ...normalizeXiaohongshuFilters(input),
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
  if (/部分/.test(status)) return "partial";
  if (/失败|打开失败/.test(status)) return "error";
  if (/完成/.test(status)) return "success";
  if (/打开搜索页/.test(status)) return "preview";
  const toneMap = {
    success: "success",
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
  while (!control.stopRequested && Date.now() < deadline) {
    await wait(Math.min(100, deadline - Date.now()));
  }
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

// Keep the side-panel-to-service-worker channel local to this feature.  The
// login gate has an equivalent helper, but the monitor is loaded separately
// after login succeeds and therefore must not depend on that module's scope.
function sendMessage(message) {
  return callChrome((done) => chrome.runtime.sendMessage(message, done));
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
      class="xhs-tab ${state.tab === id ? "active" : ""}"
      type="button"
      role="tab"
      data-tab="${id}"
      aria-selected="${state.tab === id}"
    >${escapeHtml(label)}</button>
  `).join("");
}

function renderKeywordRows(state, pagination) {
  return pagination.items.map(({ value: keyword, index }) => `
    <div class="xhs-keyword-row">
      <span class="xhs-row-index" aria-hidden="true">${index + 1}</span>
      <label class="xhs-keyword-input">
        <span class="sr-only">关键词 ${index + 1}</span>
        <input type="text" value="${escapeHtml(keyword)}" placeholder="输入小红书搜索关键词" data-keyword-index="${index}" autocomplete="off" ${state.running ? "disabled" : ""}>
      </label>
      <button
        class="xhs-remove-button"
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
    <div class="xhs-field-heading">
      <div>
        <label>搜索关键词</label>
        <p>每个关键词会作为独立的小红书搜索任务，依次打开搜索页、应用筛选并滚动采集。</p>
      </div>
      <span>${state.config.keywords.length} 个关键词</span>
    </div>
    <div class="xhs-keyword-list">${renderKeywordRows(state, pagination)}</div>
    ${renderInputListPagination(pagination, { itemLabel: "个关键词" })}
    <div class="xhs-inline-actions">
      <button class="xhs-secondary-button emphasized" type="button" data-action="add-keyword" ${state.running ? "disabled" : ""}>添加关键词</button>
      <button class="xhs-secondary-button" type="button" data-action="open-batch" ${state.running ? "disabled" : ""}>批量编辑</button>
    </div>
  `;
}

function renderJsonMode(state) {
  return `
    <div class="xhs-json-editor">
      <div class="xhs-field-heading">
        <div>
          <label for="xhsJsonInput">运行参数 JSON</label>
          <p>应用后会同步到表单，并作为后续小红书搜索、筛选与采集的输入。</p>
        </div>
      </div>
      <textarea id="xhsJsonInput" data-json-input spellcheck="false" rows="14" ${state.running ? "disabled" : ""}>${escapeHtml(state.jsonDraft)}</textarea>
      <div class="xhs-inline-actions">
        <button class="xhs-secondary-button emphasized" type="button" data-action="apply-json" ${state.running ? "disabled" : ""}>校验并应用</button>
      </div>
    </div>
  `;
}

function renderRunOptions(state) {
  return `
    <section class="xhs-options-card">
      <button class="xhs-options-header" type="button" data-action="toggle-options" aria-expanded="${state.optionsOpen}">
        <span class="xhs-options-title">
          <strong>运行选项</strong>
          <small>调整条数、并发任务、页面筛选、间隔和轮询</small>
        </span>
        <span class="xhs-option-summary" aria-label="当前运行选项摘要">
          <span><small>关键词</small><strong>${state.config.keywords.length}</strong></span>
          <span><small>每词条数</small><strong>${state.config.limit}</strong></span>
          <span><small>并发任务</small><strong>${state.config.concurrency}</strong></span>
          <span><small>关键词间隔</small><strong>${formatKeywordIntervalRange(state.config)}</strong></span>
        </span>
        <span class="xhs-options-toggle-label">${state.optionsOpen ? "收起选项" : "展开选项"}</span>
      </button>
      ${state.optionsOpen ? `
        <div class="xhs-options-body">
          <p class="xhs-options-note">每个关键词都是独立任务。并发任务使用当前登录会话的独立后台标签页，并分别应用排序、笔记类型、发布时间、搜索范围和位置距离筛选。</p>
          <div class="xhs-options-grid">
            <label class="xhs-control">
              <span>每个关键词结果数</span>
              <input type="number" min="1" max="100" value="${state.config.limit}" data-field="limit" ${state.running ? "disabled" : ""}>
              <small>允许 1–100 条，采集后写入数据表格。</small>
            </label>
            <label class="xhs-control">
              <span>并发任务数</span>
              <input type="number" min="1" max="${MAX_TASK_CONCURRENCY}" value="${state.config.concurrency}" data-field="concurrency" ${state.running ? "disabled" : ""}>
              <small>同时采集 ${state.config.concurrency} 个关键词，最多 ${MAX_TASK_CONCURRENCY} 个。</small>
            </label>
            <label class="xhs-control">
              <span>关键词间隔</span>
              <div class="xhs-range-inputs">
                <div class="xhs-input-with-unit">
                  <input type="number" min="0" max="60000" step="50" value="${state.config.keywordIntervalMinMs}" data-field="keywordIntervalMinMs" aria-label="关键词最短间隔" ${state.running ? "disabled" : ""}>
                  <span>ms</span>
                </div>
                <span class="xhs-range-separator" aria-hidden="true">-</span>
                <div class="xhs-input-with-unit">
                  <input type="number" min="0" max="60000" step="50" value="${state.config.keywordIntervalMaxMs}" data-field="keywordIntervalMaxMs" aria-label="关键词最长间隔" ${state.running ? "disabled" : ""}>
                  <span>ms</span>
                </div>
              </div>
              <small>每个关键词完成后，会在 ${formatKeywordIntervalRange(state.config)} 内重新随机等待。</small>
            </label>
            ${XIAOHONGSHU_FILTER_GROUPS.map((group) => `
              <label class="xhs-control">
                <span>${escapeHtml(group.label)}</span>
                <select data-field="${escapeHtml(group.key)}" ${state.running ? "disabled" : ""}>
                  ${group.options.map(([value, label]) => `<option value="${escapeHtml(value)}" ${state.config[group.key] === value ? "selected" : ""}>${escapeHtml(label)}</option>`).join("")}
                </select>
                <small>与小红书搜索页“${escapeHtml(group.label)}”筛选项一致。</small>
              </label>
            `).join("")}
          </div>
          <div class="xhs-polling-row">
            <label class="xhs-switch-control">
              <input type="checkbox" data-field="polling" ${state.config.polling ? "checked" : ""} ${state.running ? "disabled" : ""}>
              <span><strong>循环监控</strong><small>每轮完成后等待设定周期，再自动开始下一轮，直到手动停止。</small></span>
            </label>
            <label class="xhs-control compact ${state.config.polling ? "" : "is-disabled"}">
              <span>轮询周期</span>
              <div class="xhs-input-with-unit">
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
    <section class="xhs-parameter-card">
      <div class="xhs-mode-switch" role="tablist" aria-label="参数编辑方式">
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
    <div class="xhs-modal-backdrop" data-modal="guide">
      <section class="xhs-batch-modal xhs-guide-modal" role="dialog" aria-modal="true" aria-labelledby="xhsGuideTitle" aria-describedby="xhsGuideDescription">
        <header>
          <div><span>QUICK START</span><h2 id="xhsGuideTitle">使用说明</h2></div>
          <button class="xhs-modal-close" type="button" data-action="close-guide" data-guide-autofocus aria-label="关闭使用说明">X</button>
        </header>
        <div class="xhs-guide">
          <p class="xhs-guide-intro" id="xhsGuideDescription">运行会复用当前登录会话，按关键词打开小红书搜索页、应用筛选、滚动加载并解析页面中的笔记卡片。</p>
          <ol>
            <li><strong>准备搜索页</strong><span>复用或创建小红书搜索页，并使用进入功能时已确认的当前登录会话。</span></li>
            <li><strong>填写关键词</strong><span>支持逐条编辑、批量弹窗粘贴或 JSON 参数方式。</span></li>
            <li><strong>设置筛选并运行</strong><span>筛选项与页面中的排序依据、笔记类型、发布时间、搜索范围、位置距离一致；每个关键词会记录独立结果。</span></li>
          </ol>
          <div class="xhs-schema-box">
            <strong>采集字段</strong>
            <code>pageOrder · cover · keyword · noteTitle · noteContent · author · likes · publishedAt · url · collectedAt</code>
          </div>
        </div>
        <footer>
          <button class="xhs-primary-button" type="button" data-action="close-guide">知道了</button>
        </footer>
      </section>
    </div>
  `;
}

function renderRecordStatus(record) {
  const tone = record.tone || "running";
  return `<span class="xhs-table-status ${escapeHtml(tone)}">${escapeHtml(record.status)}</span>`;
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
    <div class="xhs-record-filters" aria-label="运行记录筛选">
      <label class="xhs-filter-control">
        <span>关键词</span>
        <select data-record-filter="keyword">
          <option value="${ALL_RECORD_FILTER}">全部关键词</option>
          ${keywords.map((keyword) => `<option value="${escapeHtml(keyword)}" ${state.recordFilters.keyword === keyword ? "selected" : ""}>${escapeHtml(keyword)}</option>`).join("")}
        </select>
      </label>
      <label class="xhs-filter-control">
        <span>状态</span>
        <select data-record-filter="status">
          <option value="${ALL_RECORD_FILTER}">全部状态</option>
          ${statusOptions.map(([statusKey, meta]) => `<option value="${statusKey}" ${state.recordFilters.status === statusKey ? "selected" : ""}>${meta.label}</option>`).join("")}
        </select>
      </label>
      <span class="xhs-filter-result">显示 ${filteredCount} / ${state.records.length} 条</span>
    </div>
  `;
}

function renderRecords(state) {
  const records = filterRecords(state.records, state.recordFilters);
  return `
    <section class="xhs-content-card xhs-table-page">
      <div class="xhs-panel-head">
        <div><h2>运行记录</h2><p>每次关键词采集单独记录；每一种状态最多保留 ${formatLimitValue(state.taskRecordsPerStatusLimit)}。</p></div>
      </div>
      ${renderRecordFilters(state, records.length)}
      <div class="xhs-table-shell records" tabindex="0" aria-label="可滚动的运行记录表格">
        <table class="xhs-table">
          <thead><tr><th>任务编号</th><th>开始时间</th><th>关键词</th><th>轮次</th><th>状态</th><th>数据量</th><th>耗时</th></tr></thead>
          <tbody>
            ${records.length ? records.map((record) => `
              <tr>
                <td><button class="xhs-task-id-button" type="button" data-action="open-task-detail" data-record-id="${escapeHtml(record.id)}" title="查看当前关键词任务明细"><code>${escapeHtml(getTaskId(record))}</code></button></td>
                <td>${escapeHtml(record.startedAt)}</td>
                <td>${escapeHtml(record.keyword || "-")}</td>
                <td>${escapeHtml(record.round || "-")}</td>
                <td title="${escapeHtml(record.error || "")}">${renderRecordStatus(record)}</td>
                <td>${record.resultCount}</td>
                <td>${escapeHtml(record.duration || "-")}</td>
              </tr>
            `).join("") : `<tr><td class="xhs-table-empty" colspan="7">${state.records.length ? "没有符合筛选条件的记录" : "暂无运行记录"}</td></tr>`}
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
    prefix: "xhs",
    featureName: "小红书关键词搜索",
    escapeHtml,
    renderStatus: renderRecordStatus
  });
}

function renderData(state) {
  return `
    <section class="xhs-content-card xhs-table-page">
      <div class="xhs-panel-head">
        <div><h2>数据</h2><p>共 ${state.dataRows.length} 条，最多保留 ${formatLimitValue(state.dataStorageLimit)}；每次搜索结果均按页面卡片的原始顺序保存。</p></div>
      </div>
      <div class="xhs-table-shell data" tabindex="0" aria-label="可滚动的 小红书笔记采集数据表格">
        <table class="xhs-table xhs-data-table">
          <thead><tr><th>顺序</th><th>封面</th><th>关键词</th><th>笔记标题</th><th>笔记正文</th><th>作者</th><th>发布时间</th><th>点赞</th><th>链接</th></tr></thead>
          <tbody>
            ${state.dataRows.length ? state.dataRows.map((row) => `
              <tr>
                <td>${row.pageOrder || "-"}</td>
                <td>${row.cover ? `<img class="xhs-cover-thumb" src="${escapeHtml(row.cover)}" alt="" loading="lazy">` : "-"}</td>
                <td>${escapeHtml(row.keyword)}</td>
                <td class="xhs-title-cell" title="${escapeHtml(row.title)}">${escapeHtml(row.title)}</td>
                <td class="xhs-description-cell" title="${escapeHtml(row.description || row.desc || "")}">${escapeHtml(row.description || row.desc || "-")}</td>
                <td>${escapeHtml(row.author || row.source || "-")}</td>
                <td>${escapeHtml(row.time || "-")}</td>
                <td>${escapeHtml(row.likes || "-")}</td>
                <td><a href="${escapeHtml(row.url)}" target="_blank" rel="noreferrer">打开</a></td>
              </tr>
            `).join("") : `<tr><td class="xhs-table-empty" colspan="9">运行后，按小红书搜索页面顺序采集的笔记结果会显示在这里</td></tr>`}
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
  return `<div class="xhs-notice ${escapeHtml(state.notice.tone || "info")}" role="status">${escapeHtml(state.notice.text)}</div>`;
}

function renderBatchModal(state) {
  if (!state.batchOpen) return "";
  return `
    <div class="xhs-modal-backdrop">
      <section class="xhs-batch-modal" role="dialog" aria-modal="true" aria-labelledby="xhsBatchTitle">
        <header>
          <div><span>BATCH EDIT</span><h2 id="xhsBatchTitle">批量编辑关键词</h2></div>
          <button class="xhs-modal-close" type="button" data-action="close-batch" aria-label="关闭批量编辑">X</button>
        </header>
        <p>每行一个关键词，也支持使用逗号分隔；应用后会替换当前列表。</p>
        <label for="xhsBatchInput">关键词列表</label>
        <textarea id="xhsBatchInput" data-batch-input rows="10" placeholder="穿搭&#10;护肤">${escapeHtml(state.batchDraft)}</textarea>
        <footer>
          <button class="xhs-secondary-button" type="button" data-action="close-batch">取消</button>
          <button class="xhs-primary-button" type="button" data-action="apply-batch">应用关键词</button>
        </footer>
      </section>
    </div>
  `;
}

function renderRunButton(state, className = "") {
  if (state.running) {
    return `<button class="xhs-stop-button ${className}" type="button" data-action="stop" ${state.stopping ? "disabled" : ""}>${state.stopping ? "停止中…" : "停止全部"}</button>`;
  }
  return `<button class="xhs-primary-button ${className}" type="button" data-action="run">运行</button>`;
}

function renderActionBar(state) {
  if (state.tab === "params") {
    return `
      <footer class="xhs-action-bar">
        ${renderRunButton(state)}
        <button class="xhs-secondary-button" type="button" data-action="reset" ${state.running ? "disabled" : ""}>还原示例输入</button>
        <span>${state.running ? "任务运行中，参数已锁定；可点击停止终止任务。" : "运行会打开小红书搜索页，应用筛选并按页面顺序采集笔记。"}</span>
      </footer>
    `;
  }
  if (state.tab === "records") {
    return `
      <footer class="xhs-action-bar xhs-table-action-bar">
        <button class="xhs-secondary-button" type="button" data-action="clear-records" ${state.records.length && !state.running ? "" : "disabled"}>清空记录</button>
        <span>当前 ${state.records.length} 条 · 每种状态最多保留 ${formatLimitValue(state.taskRecordsPerStatusLimit)}</span>
      </footer>
    `;
  }
  if (state.tab === "data") {
    return `
      <footer class="xhs-action-bar xhs-table-action-bar">
        <button class="xhs-secondary-button emphasized" type="button" data-action="export-json" ${state.dataRows.length ? "" : "disabled"}>导出 JSON</button>
        <button class="xhs-secondary-button emphasized" type="button" data-action="export-csv" ${state.dataRows.length ? "" : "disabled"}>导出表格</button>
        <button class="xhs-secondary-button" type="button" data-action="clear-data" ${state.dataRows.length ? "" : "disabled"}>清空数据</button>
        <span>当前 ${state.dataRows.length} 条 · 最多保留 ${formatLimitValue(state.dataStorageLimit)}</span>
      </footer>
    `;
  }
  return "";
}

function renderPage(state, context) {
  const isTableTab = state.tab === "records" || state.tab === "data";
  const hasFixedActions = state.tab === "params" || isTableTab;
  return `
    <section class="xhs-monitor ${hasFixedActions ? "has-fixed-actions" : ""}" aria-labelledby="xhsMonitorTitle">
      <header class="xhs-hero">
        <div class="xhs-title-row">
          <h1 id="xhsMonitorTitle">${escapeHtml(context.feature.name)}</h1>
          <span class="xhs-version">v0.2.0</span>
          <button
            class="xhs-guide-button ${state.guideOpen ? "active" : ""}"
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
        ${renderRunButton(state, "xhs-top-run")}
      </header>
      <nav class="xhs-tabs" role="tablist" aria-label="小红书关键词搜索页面">${renderTabs(state)}</nav>
      ${renderNotice(state)}
      <div class="xhs-workspace ${hasFixedActions ? "has-fixed-actions" : ""} ${isTableTab ? "is-table-view" : ""}">${renderWorkspace(state)}</div>
      ${renderActionBar(state)}
      ${renderBatchModal(state)}
      ${renderGuideModal(state)}
      ${renderTaskDetails(state)}
    </section>
  `;
}

function normalizeStoredDataRow(row) {
  const capturedAt = row.capturedAt || new Date().toISOString();
  const publishedAtRaw = row.publishedAtRaw || row.publishedAt || row.time || "";
  const publishedAt = normalizeXiaohongshuPublishedDate(publishedAtRaw, { referenceDate: capturedAt });
  return {
    ...row,
    pageOrder: Number(row.pageOrder) || 0,
    description: row.description || row.desc || "",
    author: row.author || row.source || "",
    likes: row.likes || "",
    time: publishedAt,
    publishedAt,
    publishedAtRaw,
    cover: row.cover || "",
    capturedAt
  };
}

function mergeDataRows(state, keyword, data, task) {
  const capturedAt = data?.capturedAt || new Date().toISOString();
  const incoming = (data?.results || []).map((result, index) => {
    const publishedAtRaw = result.publishedAtRaw || result.publishedAt || result.time || "";
    const publishedAt = normalizeXiaohongshuPublishedDate(publishedAtRaw, { referenceDate: capturedAt });
    return {
      id: `${keyword}|${result.url || result.title}`,
      keyword,
      pageOrder: Number(result.order) || index + 1,
      title: result.title || "",
      description: result.description || result.desc || "",
      author: result.author || result.source || "",
      likes: result.likes || "",
      time: publishedAt,
      publishedAt,
      publishedAtRaw,
      cover: result.cover || "",
      url: result.url || "",
      capturedAt
    };
  });
  const existingById = new Map(state.dataRows.map((row) => [row.id, row]));
  const taggedIncoming = incoming.map((row) => tagTaskDataRow({ ...existingById.get(row.id), ...row }, task));
  const incomingIds = new Set(taggedIncoming.map((row) => row.id));
  const priorIds = new Set(state.dataRows.map((row) => row.id));
  const added = taggedIncoming.filter((row) => !priorIds.has(row.id)).length;
  state.dataRows = applyItemLimit([
    ...taggedIncoming,
    ...state.dataRows.filter((row) => !incomingIds.has(row.id))
  ], state.dataStorageLimit);
  return added;
}

export async function mountXiaohongshuKeywordMonitor(container, context) {
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
    running: Boolean(activeXiaohongshuKeywordRun),
    stopping: Boolean(activeXiaohongshuKeywordRun?.stopRequested),
    recordFilters: { keyword: ALL_RECORD_FILTER, status: ALL_RECORD_FILTER },
    notice: saved?.notice || { tone: "info", text: "已确认小红书登录状态。设置筛选条件后点击运行，扩展会按页面顺序采集搜索结果。" },
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
  let activeRun = activeXiaohongshuKeywordRun;

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
    if (!isExtensionRuntime()) {
      state.notice = { tone: "error", text: "小红书搜索与数据采集只能在已加载扩展的 Chrome 控制台中运行。" };
      render();
      return;
    }
    const keywords = Array.from(new Set(state.config.keywords.map((item) => item.trim()).filter(Boolean)));
    if (!keywords.length) {
      state.notice = { tone: "error", text: "请至少填写一个关键词后再运行。" };
      render();
      return;
    }

    state.config.keywords = keywords;
    syncJsonDraft();
    const control = {
      runId: "XHS-" + String(Date.now()).slice(-8),
      stopRequested: false,
      activeCaptureRunIds: new Set()
    };
    activeRun = control;
    activeXiaohongshuKeywordRun = control;
    state.running = true;
    state.stopping = false;
    state.notice = { tone: "info", text: `正在准备 ${keywords.length} 个小红书搜索关键词…` };
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
        await runConcurrentTasks(keywords, {
          concurrency: state.config.concurrency,
          shouldStop: () => control.stopRequested,
          worker: async (keyword, index) => {
            if (index >= state.config.concurrency) {
              await waitForKeywordInterval(state.config, control, {
                onWait: (intervalMs) => {
                  state.notice = { tone: "info", text: `正在准备后续关键词，随机等待 ${intervalMs} ms（范围 ${formatKeywordIntervalRange(state.config)}）…` };
                  saveState(state);
                  render();
                }
              });
            }
            if (control.stopRequested) return;

            const keywordRecord = createKeywordRecord(control, keyword, round, index);
            const captureRunId = keywordRecord.record.id;
            control.activeCaptureRunIds.add(captureRunId);
            state.notice = { tone: "info", text: `第 ${round} 轮，正在并发搜索 ${control.activeCaptureRunIds.size}/${state.config.concurrency} 个关键词…` };
            saveState(state);
            render();
            try {
              const response = await runWithTaskTimeout(() => sendMessage({
                type: MESSAGE_CAPTURE_XIAOHONGSHU_KEYWORD,
                options: {
                  runId: captureRunId,
                  tabId: null,
                  isolated: true,
                  query: keyword,
                  limit: state.config.limit,
                  filters: Object.fromEntries(XIAOHONGSHU_FILTER_GROUPS.map((group) => [
                    `${group.key}Label`,
                    getXiaohongshuFilterLabel(group.key, state.config[group.key])
                  ]))
                }
              }), {
                timeoutSeconds: taskTimeoutSeconds,
                onTimeout: () => sendMessage({
                  type: MESSAGE_STOP_XIAOHONGSHU_KEYWORD,
                  options: { runId: captureRunId }
                }).catch(() => null)
              });
              if (control.stopRequested) {
                finishRecord(keywordRecord.record, keywordRecord.startedAtMs, "stopped");
                return;
              }
              if (!response?.ok) throw new Error(response?.error || "小红书采集失败");
              const added = mergeDataRows(state, keyword, response.data, {
                runId: control.runId,
                recordId: keywordRecord.record.id
              });
              roundAdded += added;
              addedTotal += added;
              finishRecord(keywordRecord.record, keywordRecord.startedAtMs, "success", response.data?.results?.length || 0);
            } catch (error) {
              if (control.stopRequested) finishRecord(keywordRecord.record, keywordRecord.startedAtMs, "stopped");
              else {
                const errorText = error.message || String(error);
                roundFailed += 1;
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

        saveState(state);
        if (control.stopRequested) break;
        completedRounds = round;
        if (!state.config.polling) {
          state.notice = {
            tone: roundFailed ? "warning" : "success",
            text: `运行结束：新增 ${addedTotal} 条数据，失败 ${roundFailed} 个关键词；${getXiaohongshuFilterSummary(state.config)}`
          };
          state.tab = addedTotal ? "data" : "records";
          break;
        }
        const pollingMs = state.config.pollingMinutes * 60 * 1000;
        state.notice = {
          tone: roundFailed ? "warning" : "success",
          text: `第 ${round} 轮完成，新增 ${roundAdded} 条；下一轮 ${formatTime(new Date(Date.now() + pollingMs))} 开始。`
        };
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
      state.notice = control.stopRequested
        ? { tone: "warning", text: `任务已停止，停止前新增 ${addedTotal} 条数据。` }
        : { tone: "error", text: errorText };
      state.tab = "records";
    } finally {
      await setFeatureRunning(FEATURE_KEY, false);
      if (activeXiaohongshuKeywordRun === control) {
        activeXiaohongshuKeywordRun = null;
      }
      if (activeRun === control) {
        activeRun = null;
        state.running = false;
        state.stopping = false;
      }
      saveState(state);
      render();
      globalThis.dispatchEvent?.(new Event(XIAOHONGSHU_KEYWORD_RUN_FINISHED_EVENT));
    }
  };

  const stopRun = async () => {
    const control = activeRun || activeXiaohongshuKeywordRun;
    if (!state.running || !control || control.stopRequested) return;
    control.stopRequested = true;
    state.stopping = true;
    state.notice = { tone: "warning", text: "正在停止全部并发任务并释放小红书页面连接…" };
    render();
    await Promise.all([...control.activeCaptureRunIds].map((runId) => (
      sendMessage({ type: MESSAGE_STOP_XIAOHONGSHU_KEYWORD, options: { runId } }).catch(() => null)
    )));
  };

  const handleLiveRunFinished = async () => {
    if (activeXiaohongshuKeywordRun || !state.running) return;
    const latest = await loadSavedState().catch(() => null);
    state.running = false;
    state.stopping = false;
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

  const handleClick = (event) => {
    if (event.target.matches(".xhs-modal-backdrop")) {
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
        if (activeXiaohongshuKeywordRun === failedRun) activeXiaohongshuKeywordRun = null;
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
    if (action === "export-json") {
      downloadXiaohongshuKeywordData(state.dataRows, "json");
      state.notice = { tone: "success", text: `已导出 ${state.dataRows.length} 条 JSON 数据。` };
      render();
      return;
    }
    if (action === "export-csv") {
      downloadXiaohongshuKeywordData(state.dataRows, "csv");
      state.notice = { tone: "success", text: `已导出 ${state.dataRows.length} 条表格数据（CSV）。` };
      render();
      return;
    }
    if (action === "clear-data") {
      state.dataRows = [];
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
    if (XIAOHONGSHU_FILTER_GROUPS.some((group) => group.key === field)) {
      state.config[field] = event.target.value;
      syncJsonDraft();
    }
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
  globalThis.addEventListener?.(XIAOHONGSHU_KEYWORD_RUN_FINISHED_EVENT, handleLiveRunFinished);
  render();

  return () => {
    // 页面切换时保留任务，只有用户点击“停止”才会终止当前运行。
    disposed = true;
    container.removeEventListener("click", handleClick);
    container.removeEventListener("input", handleInput);
    container.removeEventListener("change", handleChange);
    document.removeEventListener("keydown", handleKeydown);
    globalThis.removeEventListener?.(XIAOHONGSHU_KEYWORD_RUN_FINISHED_EVENT, handleLiveRunFinished);
    container.replaceChildren();
  };
}

import { MESSAGE_CAPTURE_GOOGLE_NEWS, MESSAGE_STOP_GOOGLE_NEWS } from "./constants.js";
import { downloadGoogleNewsData } from "./export-data.js";
import { buildGoogleNewsSearchUrl } from "./search-url.js";

const STORAGE_KEY = "browserCoreClawGoogleNewsV1";
const MAX_RECORDS_PER_STATUS = 200;
const MAX_STORED_RESULTS = 3000;
const ALL_RECORD_FILTER = "__all__";
const RECORD_STATUS_META = Object.freeze({
  running: { label: "运行中", tone: "running" },
  success: { label: "完成", tone: "success" },
  partial: { label: "部分完成", tone: "warning" },
  error: { label: "失败", tone: "error" },
  stopped: { label: "已停止", tone: "stopped" },
  preview: { label: "已打开搜索页", tone: "preview" }
});
const SAMPLE_CONFIG = Object.freeze({
  keywords: ["OpenAI", "人工智能"],
  limit: 20,
  keywordIntervalMinMs: 100,
  keywordIntervalMaxMs: 1000,
  timeRange: "last_hour",
  language: "zh-CN",
  polling: false,
  pollingMinutes: 10
});

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

export function limitRecordsPerStatus(records, limit = MAX_RECORDS_PER_STATUS) {
  const counts = new Map();
  return (Array.isArray(records) ? records : [])
    .map(normalizeRecord)
    .filter((record) => {
      const statusKey = getRecordStatusKey(record);
      const count = counts.get(statusKey) || 0;
      if (count >= limit) return false;
      counts.set(statusKey, count + 1);
      return true;
    });
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

function isGoogleTab(tab) {
  try {
    const url = new URL(tab?.url || "");
    return url.protocol === "https:" && /(^|\.)google\.com$/i.test(url.hostname);
  } catch {
    return false;
  }
}

export async function getOrCreateGoogleTab(preferredTabId = null) {
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
    records: limitRecordsPerStatus(state.records),
    dataRows: state.dataRows.slice(0, MAX_STORED_RESULTS)
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

function renderKeywordRows(state) {
  return state.config.keywords.map((keyword, index) => `
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
  return `
    <div class="news-field-heading">
      <div>
        <label>监控关键词</label>
        <p>运行时会依次打开 Google 新闻最近一小时的搜索结果。</p>
      </div>
      <span>${state.config.keywords.length} 个关键词</span>
    </div>
    <div class="news-keyword-list">${renderKeywordRows(state)}</div>
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
          <small>调整条数、间隔、语言和轮询</small>
        </span>
        <span class="news-option-summary" aria-label="当前运行选项摘要">
          <span><small>关键词</small><strong>${state.config.keywords.length}</strong></span>
          <span><small>每词条数</small><strong>${state.config.limit}</strong></span>
          <span><small>关键词间隔</small><strong>${formatKeywordIntervalRange(state.config)}</strong></span>
        </span>
        <span class="news-options-toggle-label">${state.optionsOpen ? "收起选项" : "展开选项"}</span>
      </button>
      ${state.optionsOpen ? `
        <div class="news-options-body">
          <p class="news-options-note">运行会优先复用 Google 标签页；未找到时自动创建，然后按关键词依次搜索。</p>
          <div class="news-options-grid">
            <label class="news-control">
              <span>每个关键词结果数</span>
              <input type="number" min="1" max="100" value="${state.config.limit}" data-field="limit" ${state.running ? "disabled" : ""}>
              <small>允许 1–100 条，采集后写入数据表格。</small>
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
        <div><h2>运行记录</h2><p>每次关键词采集单独记录；每一种状态最多保留 ${MAX_RECORDS_PER_STATUS} 条。</p></div>
      </div>
      ${renderRecordFilters(state, records.length)}
      <div class="news-table-shell records" tabindex="0" aria-label="可滚动的运行记录表格">
        <table class="news-table">
          <thead><tr><th>任务编号</th><th>开始时间</th><th>关键词</th><th>轮次</th><th>状态</th><th>数据量</th><th>耗时</th></tr></thead>
          <tbody>
            ${records.length ? records.map((record) => `
              <tr>
                <td><code>${escapeHtml(record.id)}</code></td>
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

function renderData(state) {
  return `
    <section class="news-content-card news-table-page">
      <div class="news-panel-head">
        <div><h2>数据</h2><p>共 ${state.dataRows.length} 条，最多保留 ${MAX_STORED_RESULTS} 条；表格支持横向与纵向滚动。</p></div>
      </div>
      <div class="news-table-shell data" tabindex="0" aria-label="可滚动的 Google 新闻采集数据表格">
        <table class="news-table news-data-table">
          <thead><tr><th>关键词</th><th>新闻标题</th><th>描述</th><th>来源</th><th>发布时间</th><th>链接</th></tr></thead>
          <tbody>
            ${state.dataRows.length ? state.dataRows.map((row) => `
              <tr>
                <td>${escapeHtml(row.keyword)}</td>
                <td class="news-title-cell" title="${escapeHtml(row.title)}">${escapeHtml(row.title)}</td>
                <td class="news-description-cell" title="${escapeHtml(row.description || row.desc || "")}">${escapeHtml(row.description || row.desc || "-")}</td>
                <td>${escapeHtml(row.source || "-")}</td>
                <td>${escapeHtml(row.time || "-")}</td>
                <td><a href="${escapeHtml(row.url)}" target="_blank" rel="noreferrer">打开</a></td>
              </tr>
            `).join("") : `<tr><td class="news-table-empty" colspan="6">运行后，Google 新闻结果会显示在这里</td></tr>`}
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
    return `<button class="news-stop-button ${className}" type="button" data-action="stop" ${state.stopping ? "disabled" : ""}>${state.stopping ? "停止中…" : "停止"}</button>`;
  }
  return `<button class="news-primary-button ${className}" type="button" data-action="run">运行</button>`;
}

function renderActionBar(state) {
  if (state.tab === "params") {
    return `
      <footer class="news-action-bar">
        ${renderRunButton(state)}
        <button class="news-secondary-button" type="button" data-action="reset" ${state.running ? "disabled" : ""}>还原示例输入</button>
        <span>${state.running ? "任务运行中，参数已锁定；可点击停止终止任务。" : isExtensionRuntime() ? "无需预先打开 Google 页面，扩展会自动准备标签页。" : "网页预览仅打开搜索页；扩展环境才会采集数据。"}</span>
      </footer>
    `;
  }
  if (state.tab === "records") {
    return `
      <footer class="news-action-bar news-table-action-bar">
        <button class="news-secondary-button" type="button" data-action="clear-records" ${state.records.length && !state.running ? "" : "disabled"}>清空记录</button>
        <span>当前 ${state.records.length} 条 · 每种状态最多保留 ${MAX_RECORDS_PER_STATUS} 条</span>
      </footer>
    `;
  }
  if (state.tab === "data") {
    return `
      <footer class="news-action-bar news-table-action-bar">
        <button class="news-secondary-button emphasized" type="button" data-action="export-json" ${state.dataRows.length ? "" : "disabled"}>导出 JSON</button>
        <button class="news-secondary-button emphasized" type="button" data-action="export-csv" ${state.dataRows.length ? "" : "disabled"}>导出表格</button>
        <button class="news-secondary-button" type="button" data-action="clear-data" ${state.dataRows.length ? "" : "disabled"}>清空数据</button>
        <span>当前 ${state.dataRows.length} 条 · 最多保留 ${MAX_STORED_RESULTS} 条</span>
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
    </section>
  `;
}

function mergeDataRows(state, keyword, data) {
  const incoming = (data?.results || []).map((result) => ({
    id: `${keyword}|${result.url || result.title}`,
    keyword,
    title: result.title || "",
    description: result.description || result.desc || "",
    source: result.source || "",
    time: result.time || "",
    url: result.url || "",
    capturedAt: data.capturedAt || new Date().toISOString()
  }));
  const existing = new Map(state.dataRows.map((row) => [row.id, row]));
  let added = 0;
  for (const row of incoming) {
    if (!existing.has(row.id)) added += 1;
    existing.set(row.id, row);
  }
  state.dataRows = [...existing.values()]
    .sort((a, b) => String(b.capturedAt).localeCompare(String(a.capturedAt)))
    .slice(0, MAX_STORED_RESULTS);
  return added;
}

export async function mountGoogleNewsMonitor(container, context) {
  const saved = await loadSavedState().catch(() => null);
  const state = {
    tab: "params",
    mode: "form",
    config: saved?.config ? normalizeConfig(saved.config) : cloneSampleConfig(),
    jsonDraft: "",
    batchOpen: false,
    batchDraft: "",
    guideOpen: false,
    optionsOpen: false,
    running: false,
    stopping: false,
    recordFilters: { keyword: ALL_RECORD_FILTER, status: ALL_RECORD_FILTER },
    notice: !isExtensionRuntime()
      ? { tone: "info", text: "当前是网页预览：运行会打开 Google 新闻搜索页；数据采集请在 Chrome 中加载扩展后测试。" }
      : null,
    records: limitRecordsPerStatus(saved?.records),
    dataRows: Array.isArray(saved?.dataRows)
      ? saved.dataRows
        .map((row) => ({ ...row, description: row.description || row.desc || "" }))
        .slice(0, MAX_STORED_RESULTS)
      : []
  };
  let disposed = false;
  let activeRun = null;

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

  const openGuide = () => {
    state.batchOpen = false;
    state.guideOpen = true;
    render();
    requestAnimationFrame(() => container.querySelector("[data-guide-autofocus]")?.focus());
  };

  const applyJsonDraft = () => {
    try {
      state.config = normalizeConfig(JSON.parse(state.jsonDraft));
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
    state.records = limitRecordsPerStatus(state.records);
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
    state.records = limitRecordsPerStatus(state.records);
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
      tabId: null,
      stopRequested: false,
      activeRecord: null
    };
    activeRun = control;
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
      state.notice = control.stopRequested
        ? { tone: "warning", text: `网页预览已停止，共打开 ${openedCount} 个关键词。` }
        : previewError
          ? { tone: "error", text: `网页预览中断：已打开 ${openedCount} 个关键词；${previewError}` }
          : { tone: "success", text: `网页预览完成：已按间隔依次打开 ${openedCount} 个关键词；扩展环境会继续采集并回填数据。` };
      saveState(state);
      render();
      return;
    }

    let addedTotal = 0;
    let completedRounds = 0;
    try {
      do {
        const round = completedRounds + 1;
        let roundFailed = 0;
        let roundAdded = 0;
        const tab = await getOrCreateGoogleTab(control.tabId);
        if (!Number.isInteger(tab?.id)) {
          throw new Error("无法创建用于 Google 新闻采集的标签页。");
        }
        control.tabId = tab.id;

        for (let index = 0; index < keywords.length; index += 1) {
          if (control.stopRequested) break;
          const keyword = keywords[index];
          const keywordRecord = createKeywordRecord(control, keyword, round, index);
          control.activeRecord = keywordRecord;
          state.notice = { tone: "info", text: `第 ${round} 轮，正在搜索 ${index + 1}/${keywords.length}：${keyword}` };
          saveState(state);
          render();

          try {
            const response = await sendMessage({
              type: MESSAGE_CAPTURE_GOOGLE_NEWS,
              options: {
                runId: control.runId,
                tabId: tab.id,
                query: keyword,
                limit: state.config.limit,
                language: state.config.language
              }
            });
            if (control.stopRequested) {
              finishRecord(keywordRecord.record, keywordRecord.startedAtMs, "stopped");
              break;
            }
            if (!response?.ok) {
              throw new Error(response?.error || "采集失败");
            }
            const added = mergeDataRows(state, keyword, response.data);
            roundAdded += added;
            addedTotal += added;
            finishRecord(keywordRecord.record, keywordRecord.startedAtMs, "success", added);
          } catch (error) {
            if (control.stopRequested) {
              finishRecord(keywordRecord.record, keywordRecord.startedAtMs, "stopped");
            } else {
              const errorText = error.message || String(error);
              roundFailed += 1;
              finishRecord(keywordRecord.record, keywordRecord.startedAtMs, "error", 0, errorText);
              state.notice = { tone: "error", text: `${keyword} 采集失败：${errorText}` };
            }
          } finally {
            control.activeRecord = null;
            saveState(state);
            render();
          }

          if (control.stopRequested) break;
          if (index < keywords.length - 1) {
            await waitForKeywordInterval(state.config, control, {
              onWait: (intervalMs) => {
                state.notice = {
                  tone: "info",
                  text: `“${keyword}”已完成，本次随机等待 ${intervalMs} ms（范围 ${formatKeywordIntervalRange(state.config)}），然后搜索“${keywords[index + 1]}”…`
                };
                saveState(state);
                render();
              }
            });
          }
        }

        saveState(state);
        if (control.stopRequested) break;
        completedRounds = round;

        if (!state.config.polling) {
          state.notice = {
            tone: roundFailed ? "error" : "success",
            text: `运行结束：新增 ${addedTotal} 条数据，失败 ${roundFailed} 个关键词。`
          };
          state.tab = addedTotal ? "data" : "records";
          break;
        }

        const pollingMs = state.config.pollingMinutes * 60 * 1000;
        const nextRunAt = new Date(Date.now() + pollingMs);
        state.notice = {
          tone: roundFailed ? "warning" : "success",
          text: `第 ${round} 轮完成，新增 ${roundAdded} 条；下一轮 ${formatTime(nextRunAt)} 开始。`
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
      if (control.activeRecord) {
        finishRecord(
          control.activeRecord.record,
          control.activeRecord.startedAtMs,
          control.stopRequested ? "stopped" : "error",
          0,
          control.stopRequested ? "" : errorText
        );
        control.activeRecord = null;
      } else if (!control.stopRequested) {
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
      if (activeRun === control) {
        activeRun = null;
        state.running = false;
        state.stopping = false;
      }
      saveState(state);
      render();
    }
  };

  const stopRun = async () => {
    if (!state.running || !activeRun || activeRun.stopRequested) return;
    activeRun.stopRequested = true;
    state.stopping = true;
    state.notice = { tone: "warning", text: "正在停止任务并释放浏览器连接…" };
    render();

    if (isExtensionRuntime()) {
      await sendMessage({
        type: MESSAGE_STOP_GOOGLE_NEWS,
        options: { runId: activeRun.runId }
      });
    }
  };

  const handleClick = (event) => {
    if (event.target.matches(".news-modal-backdrop")) {
      if (state.guideOpen) closeGuide();
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
        activeRun = null;
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
    if (action === "add-keyword") {
      state.config.keywords.push("");
      render();
      container.querySelector(`[data-keyword-index="${state.config.keywords.length - 1}"]`)?.focus();
      return;
    }
    if (action === "remove-keyword") {
      state.config.keywords.splice(Number(button.dataset.index), 1);
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
      saveState(state);
      render();
      return;
    }
    if (action === "export-json") {
      downloadGoogleNewsData(state.dataRows, "json");
      state.notice = { tone: "success", text: `已导出 ${state.dataRows.length} 条 JSON 数据。` };
      render();
      return;
    }
    if (action === "export-csv") {
      downloadGoogleNewsData(state.dataRows, "csv");
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
    if (field === "language") state.config.language = event.target.value;
    if (field === "polling") {
      state.config.polling = event.target.checked;
      render();
    }
    saveState(state);
  };

  const handleKeydown = (event) => {
    if (event.key !== "Escape") return;
    if (state.guideOpen) closeGuide();
    else if (state.batchOpen) closeBatch();
  };

  syncJsonDraft();
  container.addEventListener("click", handleClick);
  container.addEventListener("input", handleInput);
  container.addEventListener("change", handleChange);
  document.addEventListener("keydown", handleKeydown);
  render();

  return () => {
    if (activeRun && !activeRun.stopRequested) {
      activeRun.stopRequested = true;
      if (isExtensionRuntime()) {
        sendMessage({
          type: MESSAGE_STOP_GOOGLE_NEWS,
          options: { runId: activeRun.runId }
        }).catch(() => {});
      }
    }
    disposed = true;
    container.removeEventListener("click", handleClick);
    container.removeEventListener("input", handleInput);
    container.removeEventListener("change", handleChange);
    document.removeEventListener("keydown", handleKeydown);
    container.replaceChildren();
  };
}

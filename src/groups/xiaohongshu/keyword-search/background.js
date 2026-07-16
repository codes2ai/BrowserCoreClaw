import {
  executeTabFunction,
  navigateTab,
  scrollPageToBottom,
  sleep
} from "../../../background/tab-script-client.js";
import {
  XIAOHONGSHU_FILTER_SETTLE_MIN_MS,
  XIAOHONGSHU_FILTER_SETTLE_POLLS,
  XIAOHONGSHU_FILTER_SETTLE_TIMEOUT_MS,
  XIAOHONGSHU_HOME_URL,
  XIAOHONGSHU_READY_TIMEOUT_MS
} from "./constants.js";
import {
  runXiaohongshuSearchPageCommand
} from "./page-extract.js";
import { buildXiaohongshuSearchUrl } from "./search-url.js";

const XIAOHONGSHU_URL_PATTERNS = ["https://www.xiaohongshu.com/*", "https://*.xiaohongshu.com/*"];
const activeCaptures = new Map();
let managedLoginTabId = null;

function readXiaohongshuLoginState() {
  const isVisible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden"
      && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
  };
  const controls = [...document.querySelectorAll("a, button, [role='button']")]
    .filter(isVisible)
    .map((element) => String(
      element.innerText || element.getAttribute("aria-label") || element.getAttribute("title") || ""
    ).trim())
    .filter(Boolean);
  const pageText = String(document.body?.innerText || "").replace(/\s+/g, " ").trim();
  return {
    href: location.href,
    readyState: document.readyState,
    hasLoginEntry: controls.some((label) => /登录|登入|注册/.test(label)),
    isVerificationPage: /验证码|安全验证|人机验证|访问过于频繁/.test(pageText),
    hasEnoughContent: pageText.length > 80
  };
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

async function closePluginCreatedTab(tabId) {
  if (!Number.isInteger(tabId)) return;
  await callChrome((done) => chrome.tabs.remove(tabId, done)).catch(() => {});
}

async function getManagedLoginTab(active = true) {
  if (Number.isInteger(managedLoginTabId)) {
    try {
      const existing = await callChrome((done) => chrome.tabs.get(managedLoginTabId, done));
      if (existing?.url && /(^https:\/\/)([^/]+\.)?xiaohongshu\.com\//i.test(existing.url)) {
        return callChrome((done) => chrome.tabs.update(existing.id, { active }, done));
      }
    } catch {
      // The login page may have been closed manually.
    }
  }

  const tab = await callChrome((done) => chrome.tabs.create({
    url: XIAOHONGSHU_HOME_URL,
    active
  }, done));
  managedLoginTabId = Number.isInteger(tab?.id) ? tab.id : null;
  return tab;
}

async function closeManagedLoginTab() {
  const tabId = managedLoginTabId;
  managedLoginTabId = null;
  await closePluginCreatedTab(tabId);
}

async function findOrOpenXiaohongshuTab(options = {}) {
  const tabs = await callChrome((done) => chrome.tabs.query({ url: XIAOHONGSHU_URL_PATTERNS }, done));
  const tab = [...tabs].sort((first, second) => {
    if (first.active !== second.active) return first.active ? -1 : 1;
    return (second.lastAccessed || 0) - (first.lastAccessed || 0);
  })[0];

  if (tab?.id) {
    return { tab, opened: false };
  }

  const openedTab = await callChrome((done) => chrome.tabs.create({
    url: XIAOHONGSHU_HOME_URL,
    active: options.active !== false
  }, done));
  return { tab: openedTab, opened: true };
}

async function getXiaohongshuTab(preferredTabId = null, isolated = false) {
  if (Number.isInteger(preferredTabId)) {
    try {
      const preferredTab = await callChrome((done) => chrome.tabs.get(preferredTabId, done));
      if (preferredTab?.url && /(^https:\/\/)([^/]+\.)?xiaohongshu\.com\//i.test(preferredTab.url)) {
        return preferredTab;
      }
    } catch {
      // The previous tab may have been closed while a long-running task was active.
    }
  }
  if (isolated) {
    return callChrome((done) => chrome.tabs.create({ url: XIAOHONGSHU_HOME_URL, active: false }, done));
  }
  const { tab } = await findOrOpenXiaohongshuTab();
  return tab;
}

async function inspectLoginState(tabId) {
  const deadline = Date.now() + XIAOHONGSHU_READY_TIMEOUT_MS;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const pageState = await executeTabFunction(tabId, readXiaohongshuLoginState);
      if (pageState?.readyState === "complete" && pageState.hasEnoughContent) {
        if (pageState.isVerificationPage) {
          return {
            state: "unknown",
            reason: "小红书页面需要安全验证，请在标签页中完成后重新检测。"
          };
        }
        return pageState.hasLoginEntry
          ? { state: "logged_out", reason: "当前 Chrome Profile 尚未登录小红书。" }
          : { state: "logged_in", reason: "已确认当前 Chrome Profile 的小红书登录状态。" };
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }

  return {
    state: "unknown",
    reason: `小红书页面加载超时${lastError ? `：${lastError.message}` : ""}`
  };
}

export async function checkXiaohongshuLogin() {
  // 每次检测都使用专用临时页，绝不复用正在被采集任务控制的小红书页。
  // 这样三个小红书功能可以同时运行，登录检测也不会占用其它任务的采集页面。
  const tab = await callChrome((done) => chrome.tabs.create({
    url: XIAOHONGSHU_HOME_URL,
    active: false
  }, done));
  if (!tab?.id) {
    throw new Error("无法找到用于检测的小红书标签页。");
  }
  try {
    const login = await inspectLoginState(tab.id);
    if (login.state === "logged_in") await closeManagedLoginTab();
    return {
      ok: true,
      tabId: tab.id,
      opened: true,
      autoClosed: true,
      loggedIn: login.state === "logged_in",
      state: login.state,
      reason: login.reason
    };
  } finally {
    await closePluginCreatedTab(tab.id);
  }
}

export async function openXiaohongshuLogin() {
  // 登录入口只复用本功能自己创建的登录页，不接管任何采集任务标签页。
  const tab = await getManagedLoginTab(true);
  if (!Number.isInteger(tab?.id)) {
    throw new Error("无法打开小红书登录页面。");
  }
  if (Number.isInteger(tab.windowId)) {
    await callChrome((done) => chrome.windows.update(tab.windowId, { focused: true }, done));
  }
  return { ok: true, tabId: tab.id };
}

function stopError() {
  const error = new Error("任务已停止");
  error.code = "XIAOHONGSHU_CAPTURE_STOPPED";
  return error;
}

function throwIfStopped(session) {
  if (session.stopped) throw stopError();
}

async function getSearchPageState(tabId) {
  return executeTabFunction(tabId, runXiaohongshuSearchPageCommand, ["inspect"]);
}

async function waitForSearchResults(tabId, session) {
  const deadline = Date.now() + XIAOHONGSHU_READY_TIMEOUT_MS;
  let lastState = null;
  let lastError = null;

  while (Date.now() < deadline) {
    throwIfStopped(session);
    try {
      lastState = await getSearchPageState(tabId);
      throwIfStopped(session);
      if (lastState?.captcha) {
        throw new Error("小红书页面需要安全验证，请在标签页中完成后重新运行。");
      }
      if (lastState?.hasLoginEntry) {
        throw new Error("小红书登录状态已失效，请重新登录后再次检测。");
      }
      if (lastState?.isSearchPage && lastState.readyState === "complete" && (lastState.resultCount > 0 || lastState.noResults)) {
        return lastState;
      }
    } catch (error) {
      if (session.stopped || error.code === "XIAOHONGSHU_CAPTURE_STOPPED") throw stopError();
      if (/安全验证|登录状态/.test(error.message)) throw error;
      lastError = error;
    }
    await sleep(400);
  }

  throw new Error(`等待小红书搜索结果超时：${lastState?.href || lastError?.message || "页面未返回结果"}`);
}

async function applySearchFilters(tabId, filters, session) {
  throwIfStopped(session);
  const response = await executeTabFunction(
    tabId,
    runXiaohongshuSearchPageCommand,
    ["apply_filters", { filters }]
  );
  throwIfStopped(session);
  if (!response?.ok) {
    throw new Error(response?.error || "应用小红书筛选条件失败。");
  }
  return response;
}

async function waitForFilteredSearchResults(tabId, session) {
  const deadline = Date.now() + XIAOHONGSHU_FILTER_SETTLE_TIMEOUT_MS;
  let lastState = null;
  let lastSignature = "";
  let stableSince = 0;
  let stablePolls = 0;

  while (Date.now() < deadline) {
    throwIfStopped(session);
    try {
      lastState = await getSearchPageState(tabId);
      throwIfStopped(session);
      if (lastState?.captcha) {
        throw new Error("小红书页面需要安全验证，请在标签页中完成后重新运行。");
      }
      if (lastState?.hasLoginEntry) {
        throw new Error("小红书登录状态已失效，请重新登录后再次检测。");
      }

      const hasResults = lastState?.isSearchPage
        && lastState?.readyState === "complete"
        && (lastState.resultCount > 0 || lastState.noResults);
      const signature = `${lastState?.noResults ? "empty" : "results"}:${lastState?.resultCount || 0}:${lastState?.resultSignature || ""}`;
      if (!hasResults || lastState?.loading) {
        lastSignature = "";
        stableSince = 0;
        stablePolls = 0;
      } else if (signature === lastSignature) {
        stablePolls += 1;
      } else {
        lastSignature = signature;
        stableSince = Date.now();
        stablePolls = 1;
      }

      if (
        hasResults
        && !lastState?.loading
        && stablePolls >= XIAOHONGSHU_FILTER_SETTLE_POLLS
        && stableSince > 0
        && Date.now() - stableSince >= XIAOHONGSHU_FILTER_SETTLE_MIN_MS
      ) {
        return lastState;
      }
    } catch (error) {
      if (session.stopped || error.code === "XIAOHONGSHU_CAPTURE_STOPPED") throw stopError();
      if (/安全验证|登录状态/.test(error.message)) throw error;
      lastSignature = "";
      stableSince = 0;
      stablePolls = 0;
      lastState = { error: error.message || String(error) };
    }
    await sleep(350);
  }

  throw new Error(
    `筛选后的结果列表未在 ${Math.round(XIAOHONGSHU_FILTER_SETTLE_TIMEOUT_MS / 1000)} 秒内稳定；为避免采集到未完成筛选的数据，本次采集已停止。${lastState?.href || lastState?.error ? ` 当前状态：${lastState.href || lastState.error}` : ""}`
  );
}

async function collectSearchResults(tabId, limit, session) {
  const maximum = Math.min(100, Math.max(1, Number(limit) || 20));
  let bestData = null;
  let unchangedRounds = 0;
  let previousCount = 0;

  for (let round = 0; round < 24; round += 1) {
    throwIfStopped(session);
    const data = await executeTabFunction(
      tabId,
      runXiaohongshuSearchPageCommand,
      ["extract", { limit: maximum }]
    );
    throwIfStopped(session);
    if (!bestData || data.results.length >= bestData.results.length) bestData = data;
    if (data.results.length >= maximum) return data;

    if (data.results.length <= previousCount) unchangedRounds += 1;
    else unchangedRounds = 0;
    if (unchangedRounds >= 3) break;
    previousCount = data.results.length;

    await executeTabFunction(tabId, scrollPageToBottom);
    await sleep(1100);
  }

  return bestData || { results: [], capturedAt: new Date().toISOString(), pageUrl: "" };
}

export async function captureXiaohongshuKeyword(options) {
  const query = String(options.query || "").trim();
  const runId = String(options.runId || "").trim();
  if (!query) throw new Error("搜索关键词不能为空。");
  if (!runId) throw new Error("缺少运行任务编号。");

  const parsedTabId = Number(options.tabId);
  const hasRequestedTab = Number.isInteger(parsedTabId) && parsedTabId > 0;
  const requestedTabId = hasRequestedTab ? parsedTabId : null;
  const ownsTargetTab = Boolean(options.isolated) && !hasRequestedTab;
  const tab = await getXiaohongshuTab(requestedTabId, Boolean(options.isolated));
  if (!Number.isInteger(tab?.id)) {
    throw new Error("无法找到用于小红书搜索的标签页。");
  }

  const session = { runId, tabId: tab.id, stopped: false };
  activeCaptures.set(runId, session);
  let completed = false;
  try {
    throwIfStopped(session);
    if (!options.isolated) await callChrome((done) => chrome.tabs.update(tab.id, { active: true }, done));
    throwIfStopped(session);
    await navigateTab(tab.id, buildXiaohongshuSearchUrl(query));
    const pageState = await waitForSearchResults(tab.id, session);
    if (pageState.noResults) {
      completed = true;
      return { ok: true, tabId: tab.id, data: { results: [], capturedAt: new Date().toISOString(), pageUrl: pageState.href } };
    }
    await applySearchFilters(tab.id, options.filters || {}, session);
    const filteredPageState = await waitForFilteredSearchResults(tab.id, session);
    if (filteredPageState.noResults) {
      completed = true;
      return { ok: true, tabId: tab.id, data: { results: [], capturedAt: new Date().toISOString(), pageUrl: filteredPageState.href } };
    }
    const data = await collectSearchResults(tab.id, options.limit, session);
    completed = true;
    return { ok: true, tabId: tab.id, data };
  } finally {
    if (activeCaptures.get(runId) === session) activeCaptures.delete(runId);
    if (ownsTargetTab && (completed || session.stopped)) await closePluginCreatedTab(tab.id);
  }
}

export async function stopXiaohongshuKeywordCapture(options) {
  const runId = String(options.runId || "").trim();
  const session = activeCaptures.get(runId);
  if (!session) return { ok: true, stopped: false };
  session.stopped = true;
  return { ok: true, stopped: true };
}

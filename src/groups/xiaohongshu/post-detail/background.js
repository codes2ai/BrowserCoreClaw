import { executeTabFunction, navigateTab, sleep } from "../../../background/tab-script-client.js";
import {
  XIAOHONGSHU_POST_DETAIL_HOME_URL,
  XIAOHONGSHU_POST_DETAIL_READY_TIMEOUT_MS,
  XIAOHONGSHU_POST_DETAIL_SETTLE_MIN_MS,
  XIAOHONGSHU_POST_DETAIL_SETTLE_POLLS
} from "./constants.js";
import { runXiaohongshuPostDetailPageCommand } from "./page-extract.js";

const XIAOHONGSHU_URL_PATTERNS = ["https://www.xiaohongshu.com/*", "https://*.xiaohongshu.com/*"];
const activeCaptures = new Map();

function callChrome(callbackApi) {
  return new Promise((resolve, reject) => callbackApi((result) => {
    const error = chrome.runtime.lastError;
    if (error) reject(new Error(error.message)); else resolve(result);
  }));
}

async function closePluginCreatedTab(tabId) {
  if (!Number.isInteger(tabId)) return;
  await callChrome((done) => chrome.tabs.remove(tabId, done)).catch(() => {});
}

export function getXiaohongshuNoteId(value) {
  try {
    const url = new URL(value);
    if (!/(^|\.)xiaohongshu\.com$/i.test(url.hostname)) return "";
    const parts = url.pathname.split("/").filter(Boolean);
    if (["search_result", "explore"].includes(parts[0])) return parts[1] || "";
    if (parts[0] === "discovery" && parts[1] === "item") return parts[2] || "";
    if (parts[0] === "user" && parts[1] === "profile") return parts[3] || "";
    return "";
  } catch {
    return "";
  }
}

export function isXiaohongshuPostUrl(value) {
  return /^[a-f0-9]{16,32}$/i.test(getXiaohongshuNoteId(value));
}

async function getXiaohongshuTab(preferredTabId = null, isolated = false) {
  if (Number.isInteger(preferredTabId)) {
    try {
      const tab = await callChrome((done) => chrome.tabs.get(preferredTabId, done));
      if (tab?.url && /(^https:\/\/)([^/]+\.)?xiaohongshu\.com\//i.test(tab.url)) return tab;
    } catch {
      // A previous task tab may have been closed.
    }
  }
  if (isolated) {
    return callChrome((done) => chrome.tabs.create({ url: XIAOHONGSHU_POST_DETAIL_HOME_URL, active: false }, done));
  }
  const tabs = await callChrome((done) => chrome.tabs.query({ url: XIAOHONGSHU_URL_PATTERNS }, done));
  const existing = [...tabs].sort((first, second) => {
    if (first.active !== second.active) return first.active ? -1 : 1;
    return (second.lastAccessed || 0) - (first.lastAccessed || 0);
  })[0];
  return existing?.id
    ? existing
    : callChrome((done) => chrome.tabs.create({ url: XIAOHONGSHU_POST_DETAIL_HOME_URL, active: true }, done));
}

function stoppedError() {
  const error = new Error("任务已停止");
  error.code = "XIAOHONGSHU_POST_DETAIL_STOPPED";
  return error;
}

function throwIfStopped(session) {
  if (session.stopped) throw stoppedError();
}

function pageCommand(tabId, command) {
  return executeTabFunction(tabId, runXiaohongshuPostDetailPageCommand, [command]);
}

async function waitForPostDetail(tabId, session, expectedNoteId) {
  const deadline = Date.now() + XIAOHONGSHU_POST_DETAIL_READY_TIMEOUT_MS;
  let previousSignature = "";
  let stableSince = 0;
  let stablePolls = 0;
  let lastState = null;

  while (Date.now() < deadline) {
    throwIfStopped(session);
    try {
      lastState = await pageCommand(tabId, "inspect-detail");
      throwIfStopped(session);
      if (lastState?.captcha) {
        throw new Error("小红书页面需要安全验证，请在标签页完成验证后再次运行。");
      }
      if (lastState?.hasLoginEntry) {
        throw new Error("小红书登录状态已失效，请重新登录后再次检测。");
      }
      if (lastState?.notFound) {
        session.closeOnExit = true;
        throw new Error("小红书正文链接不存在、已删除或不可访问。");
      }
      const matchesTarget = !expectedNoteId || lastState?.noteId === expectedNoteId;
      const ready = lastState?.isDetailPage
        && matchesTarget
        && lastState?.hasDetail
        && !lastState?.loading
        && lastState?.readyState === "complete";
      const signature = lastState?.detailSignature || "";
      if (!ready || !signature) {
        previousSignature = "";
        stableSince = 0;
        stablePolls = 0;
      } else if (signature === previousSignature) {
        stablePolls += 1;
      } else {
        previousSignature = signature;
        stableSince = Date.now();
        stablePolls = 1;
      }
      if (
        ready
        && stablePolls >= XIAOHONGSHU_POST_DETAIL_SETTLE_POLLS
        && Date.now() - stableSince >= XIAOHONGSHU_POST_DETAIL_SETTLE_MIN_MS
      ) return;
    } catch (error) {
      if (session.stopped || error.code === "XIAOHONGSHU_POST_DETAIL_STOPPED") throw stoppedError();
      if (/安全验证|登录状态|不存在|已删除|不可访问/.test(error.message)) throw error;
      lastState = { error: error.message || String(error) };
      previousSignature = "";
      stableSince = 0;
      stablePolls = 0;
    }
    await sleep(350);
  }

  if (lastState && lastState.isDetailPage === false) session.closeOnExit = true;
  throw new Error(`等待小红书正文稳定超时：${lastState?.href || lastState?.error || "页面未返回可采集正文"}`);
}

export async function captureXiaohongshuPostDetail(options) {
  const postUrl = String(options.postUrl || "").trim();
  const runId = String(options.runId || "").trim();
  const expectedNoteId = getXiaohongshuNoteId(postUrl);
  if (!isXiaohongshuPostUrl(postUrl)) {
    throw new Error("小红书正文链接必须是 search_result、explore、discovery/item 或博主主页中的笔记链接。");
  }
  if (!runId) throw new Error("缺少运行任务编号。");

  const parsedTabId = Number(options.tabId);
  const hasRequestedTab = Number.isInteger(parsedTabId) && parsedTabId > 0;
  const requestedTabId = hasRequestedTab ? parsedTabId : null;
  const ownsTargetTab = Boolean(options.isolated) && !hasRequestedTab;
  const tab = await getXiaohongshuTab(requestedTabId, Boolean(options.isolated));
  if (!Number.isInteger(tab?.id)) throw new Error("无法找到用于小红书正文采集的标签页。");

  const session = { runId, tabId: tab.id, stopped: false, closeOnExit: false };
  activeCaptures.set(runId, session);
  let completed = false;
  try {
    if (!options.isolated) await callChrome((done) => chrome.tabs.update(tab.id, { active: true }, done));
    throwIfStopped(session);
    await navigateTab(tab.id, postUrl);
    await waitForPostDetail(tab.id, session, expectedNoteId);
    throwIfStopped(session);
    const data = await pageCommand(tab.id, "extract-detail");
    const actualNoteId = String(data?.detail?.noteId || "").trim();
    if (!actualNoteId || actualNoteId !== expectedNoteId || (!data?.detail?.title && !data?.detail?.description)) {
      session.closeOnExit = true;
      throw new Error("未读取到目标小红书正文，请确认链接仍可公开访问。");
    }
    completed = true;
    return { ok: true, tabId: tab.id, data };
  } finally {
    if (activeCaptures.get(runId) === session) activeCaptures.delete(runId);
    if (ownsTargetTab && (completed || session.stopped || session.closeOnExit)) {
      await closePluginCreatedTab(tab.id);
    }
  }
}

export async function stopXiaohongshuPostDetailCapture(options) {
  const session = activeCaptures.get(String(options.runId || "").trim());
  if (!session) return { ok: true, stopped: false };
  session.stopped = true;
  return { ok: true, stopped: true };
}

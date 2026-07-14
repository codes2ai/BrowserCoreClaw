import { attachDebugger, detachDebugger, evaluate, sendCommand, sleep } from "../../../background/debugger-client.js";
import { WEIBO_HOME_URL } from "../profile-posts/constants.js";
import { runWeiboPageCommand } from "../page-extract.js";
import {
  WEIBO_DETAIL_READY_TIMEOUT_MS,
  WEIBO_DETAIL_SETTLE_MIN_MS,
  WEIBO_DETAIL_SETTLE_POLLS
} from "./constants.js";

const WEIBO_URL_PATTERNS = ["https://weibo.com/*", "https://www.weibo.com/*"];
const activeCaptures = new Map();

function callChrome(callbackApi) {
  return new Promise((resolve, reject) => callbackApi((result) => {
    const error = chrome.runtime.lastError;
    if (error) reject(new Error(error.message)); else resolve(result);
  }));
}

function isWeiboPostUrl(value) {
  try {
    const url = new URL(value);
    return /(^|\.)weibo\.com$/i.test(url.hostname) && /^\/\d+\/[A-Za-z0-9]+\/?$/i.test(url.pathname);
  } catch { return false; }
}

async function getWeiboTab(preferredTabId = null) {
  if (Number.isInteger(preferredTabId)) {
    try {
      const tab = await callChrome((done) => chrome.tabs.get(preferredTabId, done));
      if (tab?.url && /(^https:\/\/)([^/]+\.)?weibo\.com\//i.test(tab.url)) return tab;
    } catch { /* A previous task tab may have been closed. */ }
  }
  const tabs = await callChrome((done) => chrome.tabs.query({ url: WEIBO_URL_PATTERNS }, done));
  const existing = [...tabs].sort((first, second) => {
    if (first.active !== second.active) return first.active ? -1 : 1;
    return (second.lastAccessed || 0) - (first.lastAccessed || 0);
  })[0];
  return existing?.id ? existing : callChrome((done) => chrome.tabs.create({ url: WEIBO_HOME_URL, active: true }, done));
}

function stoppedError() { const error = new Error("任务已停止"); error.code = "WEIBO_POST_DETAIL_STOPPED"; return error; }
function throwIfStopped(session) { if (session.stopped) throw stoppedError(); }
function pageCommand(tabId, command) { return evaluate(tabId, `(${runWeiboPageCommand.toString()})(${JSON.stringify(command)})`); }

async function waitForPostDetail(tabId, session) {
  const deadline = Date.now() + WEIBO_DETAIL_READY_TIMEOUT_MS;
  let previousSignature = "";
  let stableSince = 0;
  let stablePolls = 0;
  let lastState = null;
  while (Date.now() < deadline) {
    throwIfStopped(session);
    try {
      lastState = await pageCommand(tabId, "inspect-detail");
      throwIfStopped(session);
      if (lastState?.captcha) throw new Error("微博页面需要安全验证，请在标签页完成验证后再次运行。");
      // Public post details are supported without a login-state precheck.
      const ready = lastState?.isDetailPage && lastState?.hasDetail && lastState?.readyState === "complete";
      const signature = lastState?.detailSignature || "";
      if (!ready || !signature) { previousSignature = ""; stableSince = 0; stablePolls = 0; }
      else if (signature === previousSignature) stablePolls += 1;
      else { previousSignature = signature; stableSince = Date.now(); stablePolls = 1; }
      if (ready && stablePolls >= WEIBO_DETAIL_SETTLE_POLLS && Date.now() - stableSince >= WEIBO_DETAIL_SETTLE_MIN_MS) return;
    } catch (error) {
      if (session.stopped || error.code === "WEIBO_POST_DETAIL_STOPPED") throw stoppedError();
      if (/安全验证/.test(error.message)) throw error;
      lastState = { error: error.message || String(error) };
      previousSignature = ""; stableSince = 0; stablePolls = 0;
    }
    await sleep(350);
  }
  throw new Error(`等待微博正文稳定超时：${lastState?.href || lastState?.error || "页面未返回可采集正文"}`);
}

export async function captureWeiboPostDetail(options) {
  const postUrl = String(options.postUrl || "").trim();
  const runId = String(options.runId || "").trim();
  if (!isWeiboPostUrl(postUrl)) throw new Error("微博正文链接必须是 https://weibo.com/数字用户ID/博文ID 格式。");
  if (!runId) throw new Error("缺少运行任务编号。");
  const tab = await getWeiboTab(Number(options.tabId));
  if (!Number.isInteger(tab?.id)) throw new Error("无法找到用于微博正文采集的标签页。");
  const session = { runId, tabId: tab.id, stopped: false };
  activeCaptures.set(runId, session);
  let attached = false;
  try {
    await callChrome((done) => chrome.tabs.update(tab.id, { active: true }, done));
    await attachDebugger(tab.id); attached = true;
    await sendCommand(tab.id, "Runtime.enable"); await sendCommand(tab.id, "Page.enable");
    throwIfStopped(session);
    await sendCommand(tab.id, "Page.navigate", { url: postUrl });
    await waitForPostDetail(tab.id, session);
    throwIfStopped(session);
    const data = await pageCommand(tab.id, "extract-detail");
    if (!data?.detail?.postId && !data?.detail?.text) throw new Error("未读取到微博正文，请确认链接可公开访问。");
    return { ok: true, tabId: tab.id, data };
  } finally {
    if (activeCaptures.get(runId) === session) activeCaptures.delete(runId);
    if (attached) await detachDebugger(tab.id).catch(() => {});
  }
}

export async function stopWeiboPostDetailCapture(options) {
  const session = activeCaptures.get(String(options.runId || "").trim());
  if (!session) return { ok: true, stopped: false };
  session.stopped = true;
  await detachDebugger(session.tabId).catch(() => {});
  return { ok: true, stopped: true };
}

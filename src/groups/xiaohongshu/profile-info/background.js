import { attachDebugger, detachDebugger, evaluate, sendCommand, sleep } from "../../../background/debugger-client.js";
import {
  XIAOHONGSHU_HOME_URL,
  XIAOHONGSHU_PROFILE_INFO_READY_TIMEOUT_MS,
  XIAOHONGSHU_PROFILE_INFO_SETTLE_MIN_MS,
  XIAOHONGSHU_PROFILE_INFO_SETTLE_POLLS,
  XIAOHONGSHU_PROFILE_INFO_SETTLE_TIMEOUT_MS
} from "./constants.js";
import { runXiaohongshuProfileInfoPageCommand } from "./page-extract.js";

const XIAOHONGSHU_URL_PATTERNS = ["https://www.xiaohongshu.com/*", "https://*.xiaohongshu.com/*"];
const activeCaptures = new Map();

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

async function getXiaohongshuTab(preferredTabId = null, isolated = false) {
  if (Number.isInteger(preferredTabId)) {
    try {
      const tab = await callChrome((done) => chrome.tabs.get(preferredTabId, done));
      if (tab?.url && /(^https:\/\/)([^/]+\.)?xiaohongshu\.com\//i.test(tab.url)) return tab;
    } catch {
      // The prior task tab may have been closed.
    }
  }
  if (isolated) {
    return callChrome((done) => chrome.tabs.create({ url: XIAOHONGSHU_HOME_URL, active: false }, done));
  }
  const tabs = await callChrome((done) => chrome.tabs.query({ url: XIAOHONGSHU_URL_PATTERNS }, done));
  const tab = [...tabs].sort((first, second) => {
    if (first.active !== second.active) return first.active ? -1 : 1;
    return (second.lastAccessed || 0) - (first.lastAccessed || 0);
  })[0];
  if (tab?.id) return tab;
  return callChrome((done) => chrome.tabs.create({ url: XIAOHONGSHU_HOME_URL, active: true }, done));
}

function stopError() {
  const error = new Error("任务已停止");
  error.code = "XIAOHONGSHU_PROFILE_INFO_STOPPED";
  return error;
}

function throwIfStopped(session) {
  if (session.stopped) throw stopError();
}

async function getPageState(tabId) {
  return evaluate(tabId, `(${runXiaohongshuProfileInfoPageCommand.toString()})("inspect")`);
}

async function waitForProfileInfo(tabId, session) {
  const readyDeadline = Date.now() + XIAOHONGSHU_PROFILE_INFO_READY_TIMEOUT_MS;
  const settleDeadline = Date.now() + XIAOHONGSHU_PROFILE_INFO_SETTLE_TIMEOUT_MS;
  let lastState = null;
  let lastSignature = "";
  let stableSince = 0;
  let stablePolls = 0;

  while (Date.now() < readyDeadline) {
    throwIfStopped(session);
    try {
      lastState = await getPageState(tabId);
      throwIfStopped(session);
      if (lastState?.captcha) throw new Error("小红书页面需要安全验证，请在标签页中完成后重新运行。");
      if (lastState?.hasLoginEntry) throw new Error("小红书登录状态已失效，请重新登录后再次检测。");
      const ready = lastState?.isProfilePage && lastState?.hasProfile && lastState?.readyState === "complete";
      const signature = lastState?.profileSignature || "";
      if (!ready || !signature) {
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
      if (ready && stablePolls >= XIAOHONGSHU_PROFILE_INFO_SETTLE_POLLS && Date.now() - stableSince >= XIAOHONGSHU_PROFILE_INFO_SETTLE_MIN_MS) {
        return;
      }
      if (Date.now() > settleDeadline && ready) {
        return;
      }
    } catch (error) {
      if (session.stopped || error.code === "XIAOHONGSHU_PROFILE_INFO_STOPPED") throw stopError();
      if (/安全验证|登录状态/.test(error.message)) throw error;
      lastState = { error: error.message || String(error) };
    }
    await sleep(350);
  }
  throw new Error(`等待博主信息稳定超时：${lastState?.href || lastState?.error || "页面未返回资料区"}`);
}

export async function captureXiaohongshuProfileInfo(options) {
  const profileUrl = String(options.profileUrl || "").trim();
  const runId = String(options.runId || "").trim();
  if (!/^https:\/\/([^/]+\.)?xiaohongshu\.com\/user\/profile\/[^/?#]+\/?(?:[?#].*)?$/i.test(profileUrl)) {
    throw new Error("博主主页链接必须是 https://www.xiaohongshu.com/user/profile/... 格式。");
  }
  if (!runId) throw new Error("缺少运行任务编号。");
  const parsedTabId = Number(options.tabId);
  const hasRequestedTab = Number.isInteger(parsedTabId) && parsedTabId > 0;
  const requestedTabId = hasRequestedTab ? parsedTabId : null;
  const ownsTargetTab = Boolean(options.isolated) && !hasRequestedTab;
  const tab = await getXiaohongshuTab(requestedTabId, Boolean(options.isolated));
  if (!Number.isInteger(tab?.id)) throw new Error("无法找到用于小红书博主信息采集的标签页。");

  const session = { runId, tabId: tab.id, stopped: false };
  activeCaptures.set(runId, session);
  let attached = false;
  let completed = false;
  try {
    if (!options.isolated) await callChrome((done) => chrome.tabs.update(tab.id, { active: true }, done));
    await attachDebugger(tab.id);
    attached = true;
    await sendCommand(tab.id, "Runtime.enable");
    await sendCommand(tab.id, "Page.enable");
    throwIfStopped(session);
    await sendCommand(tab.id, "Page.navigate", { url: profileUrl });
    await waitForProfileInfo(tab.id, session);
    throwIfStopped(session);
    const data = await evaluate(tab.id, `(${runXiaohongshuProfileInfoPageCommand.toString()})("extract")`);
    if (!data?.profile?.profileId && !data?.profile?.nickname) throw new Error("未读取到博主资料，请确认主页可访问。");
    completed = true;
    return { ok: true, tabId: tab.id, data };
  } finally {
    if (activeCaptures.get(runId) === session) activeCaptures.delete(runId);
    if (attached) await detachDebugger(tab.id).catch(() => {});
    if (ownsTargetTab && (completed || session.stopped)) await closePluginCreatedTab(tab.id);
  }
}

export async function stopXiaohongshuProfileInfoCapture(options) {
  const session = activeCaptures.get(String(options.runId || "").trim());
  if (!session) return { ok: true, stopped: false };
  session.stopped = true;
  await detachDebugger(session.tabId).catch(() => {});
  return { ok: true, stopped: true };
}

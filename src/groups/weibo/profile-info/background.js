import { attachDebugger, detachDebugger, evaluate, sendCommand, sleep } from "../../../background/debugger-client.js";
import { WEIBO_HOME_URL, WEIBO_PROFILE_READY_TIMEOUT_MS, WEIBO_PROFILE_SETTLE_MIN_MS, WEIBO_PROFILE_SETTLE_POLLS } from "../profile-posts/constants.js";
import { runWeiboPageCommand } from "../page-extract.js";

const WEIBO_URL_PATTERNS = ["https://weibo.com/*", "https://www.weibo.com/*"];
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

function isWeiboProfileUrl(value) {
  try { const url = new URL(value); return /(^|\.)weibo\.com$/i.test(url.hostname) && /^\/u\/\d+\/?$/i.test(url.pathname); } catch { return false; }
}

async function getWeiboTab(preferredTabId = null, isolated = false) {
  if (Number.isInteger(preferredTabId)) {
    try { const tab = await callChrome((done) => chrome.tabs.get(preferredTabId, done)); if (tab?.url && /weibo\.com/i.test(tab.url)) return tab; } catch { /* ignore */ }
  }
  if (isolated) return callChrome((done) => chrome.tabs.create({ url: WEIBO_HOME_URL, active: false }, done));
  const tabs = await callChrome((done) => chrome.tabs.query({ url: WEIBO_URL_PATTERNS }, done));
  const existing = [...tabs].sort((a, b) => (b.active - a.active) || ((b.lastAccessed || 0) - (a.lastAccessed || 0)))[0];
  return existing?.id ? existing : callChrome((done) => chrome.tabs.create({ url: WEIBO_HOME_URL, active: true }, done));
}

function stoppedError() { const error = new Error("任务已停止"); error.code = "WEIBO_PROFILE_INFO_STOPPED"; return error; }
function throwIfStopped(session) { if (session.stopped) throw stoppedError(); }
function pageCommand(tabId, command) { return evaluate(tabId, `(${runWeiboPageCommand.toString()})(${JSON.stringify(command)})`); }

async function waitForProfileInfo(tabId, session) {
  const deadline = Date.now() + WEIBO_PROFILE_READY_TIMEOUT_MS;
  let signature = "";
  let stableSince = 0;
  let stablePolls = 0;
  let lastState = null;
  while (Date.now() < deadline) {
    throwIfStopped(session);
    try {
      lastState = await pageCommand(tabId, "inspect");
      throwIfStopped(session);
      if (lastState?.captcha) throw new Error("微博页面需要安全验证，请在标签页完成验证后再次运行。");
      if (lastState?.profileDetailsCollapsed) {
        await pageCommand(tabId, "expand-profile-details");
        // 点击展开后，微博会异步插入认证与机构资料行；等待下一轮
        // 重新读取完整资料，再开始稳定性判断。
        signature = "";
        stableSince = 0;
        stablePolls = 0;
        await sleep(250);
        continue;
      }
      // Intentionally no login check: publicly available profile data is supported without a session.
      const ready = lastState?.isProfilePage && lastState?.hasProfile && lastState?.readyState === "complete";
      const nextSignature = lastState?.profileSignature || "";
      if (!ready || !nextSignature) { signature = ""; stableSince = 0; stablePolls = 0; }
      else if (nextSignature === signature) stablePolls += 1;
      else { signature = nextSignature; stableSince = Date.now(); stablePolls = 1; }
      if (ready && stablePolls >= WEIBO_PROFILE_SETTLE_POLLS && Date.now() - stableSince >= WEIBO_PROFILE_SETTLE_MIN_MS) return;
    } catch (error) {
      if (session.stopped || error.code === "WEIBO_PROFILE_INFO_STOPPED") throw stoppedError();
      if (/安全验证/.test(error.message)) throw error;
      lastState = { error: error.message || String(error) };
      signature = ""; stableSince = 0; stablePolls = 0;
    }
    await sleep(350);
  }
  throw new Error(`等待微博博主资料稳定超时：${lastState?.href || lastState?.error || "页面未返回资料区"}`);
}

export async function captureWeiboProfileInfo(options) {
  const profileUrl = String(options.profileUrl || "").trim();
  const runId = String(options.runId || "").trim();
  if (!isWeiboProfileUrl(profileUrl)) throw new Error("博主主页链接必须是 https://weibo.com/u/数字ID 格式。");
  if (!runId) throw new Error("缺少运行任务编号。");
  const parsedTabId = Number(options.tabId);
  const hasRequestedTab = Number.isInteger(parsedTabId) && parsedTabId > 0;
  const requestedTabId = hasRequestedTab ? parsedTabId : null;
  const ownsTargetTab = Boolean(options.isolated) && !hasRequestedTab;
  const tab = await getWeiboTab(requestedTabId, Boolean(options.isolated));
  if (!Number.isInteger(tab?.id)) throw new Error("无法找到用于微博博主信息采集的标签页。");
  const session = { runId, tabId: tab.id, stopped: false };
  activeCaptures.set(runId, session);
  let attached = false;
  let completed = false;
  try {
    if (!options.isolated) await callChrome((done) => chrome.tabs.update(tab.id, { active: true }, done));
    await attachDebugger(tab.id); attached = true;
    await sendCommand(tab.id, "Runtime.enable"); await sendCommand(tab.id, "Page.enable");
    throwIfStopped(session);
    await sendCommand(tab.id, "Page.navigate", { url: profileUrl });
    await waitForProfileInfo(tab.id, session);
    throwIfStopped(session);
    const data = await pageCommand(tab.id, "extract-profile");
    if (!data?.profile?.profileId && !data?.profile?.nickname) throw new Error("未读取到微博博主资料，请确认主页可公开访问。");
    completed = true;
    return { ok: true, tabId: tab.id, data };
  } finally {
    if (activeCaptures.get(runId) === session) activeCaptures.delete(runId);
    if (attached) await detachDebugger(tab.id).catch(() => {});
    if (ownsTargetTab && (completed || session.stopped)) await closePluginCreatedTab(tab.id);
  }
}

export async function stopWeiboProfileInfoCapture(options) {
  const session = activeCaptures.get(String(options.runId || "").trim());
  if (!session) return { ok: true, stopped: false };
  session.stopped = true;
  await detachDebugger(session.tabId).catch(() => {});
  return { ok: true, stopped: true };
}

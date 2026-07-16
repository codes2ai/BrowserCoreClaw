import {
  executeTabFunction,
  navigateTab,
  scrollPageToBottom,
  sleep
} from "../../../background/tab-script-client.js";
import {
  XIAOHONGSHU_HOME_URL,
  XIAOHONGSHU_PROFILE_READY_TIMEOUT_MS,
  XIAOHONGSHU_PROFILE_SETTLE_MIN_MS,
  XIAOHONGSHU_PROFILE_SETTLE_POLLS,
  XIAOHONGSHU_PROFILE_SETTLE_TIMEOUT_MS
} from "./constants.js";
import { runXiaohongshuProfilePageCommand } from "./page-extract.js";

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

async function findOrOpenXiaohongshuTab() {
  const tabs = await callChrome((done) => chrome.tabs.query({ url: XIAOHONGSHU_URL_PATTERNS }, done));
  const tab = [...tabs].sort((first, second) => {
    if (first.active !== second.active) return first.active ? -1 : 1;
    return (second.lastAccessed || 0) - (first.lastAccessed || 0);
  })[0];
  if (tab?.id) return tab;
  return callChrome((done) => chrome.tabs.create({ url: XIAOHONGSHU_HOME_URL, active: true }, done));
}

async function getXiaohongshuTab(preferredTabId = null, isolated = false) {
  if (Number.isInteger(preferredTabId)) {
    try {
      const preferredTab = await callChrome((done) => chrome.tabs.get(preferredTabId, done));
      if (preferredTab?.url && /(^https:\/\/)([^/]+\.)?xiaohongshu\.com\//i.test(preferredTab.url)) {
        return preferredTab;
      }
    } catch {
      // The previous tab may have been closed while a multi-profile task was running.
    }
  }
  if (isolated) {
    return callChrome((done) => chrome.tabs.create({ url: XIAOHONGSHU_HOME_URL, active: false }, done));
  }
  return findOrOpenXiaohongshuTab();
}

function stopError() {
  const error = new Error("任务已停止");
  error.code = "XIAOHONGSHU_PROFILE_CAPTURE_STOPPED";
  return error;
}

function throwIfStopped(session) {
  if (session.stopped) throw stopError();
}

async function getProfilePageState(tabId) {
  return executeTabFunction(tabId, runXiaohongshuProfilePageCommand, ["inspect"]);
}

async function waitForProfilePage(tabId, session) {
  const deadline = Date.now() + XIAOHONGSHU_PROFILE_READY_TIMEOUT_MS;
  let lastState = null;
  let lastSignature = "";
  let stableSince = 0;
  let stablePolls = 0;

  while (Date.now() < deadline) {
    throwIfStopped(session);
    try {
      lastState = await getProfilePageState(tabId);
      throwIfStopped(session);
      if (lastState?.captcha) {
        throw new Error("小红书页面需要安全验证，请在标签页中完成后重新运行。");
      }
      if (lastState?.hasLoginEntry) {
        throw new Error("小红书登录状态已失效，请重新登录后再次检测。");
      }
      const hasReadyProfile = lastState?.isProfilePage
        && lastState?.profileReady
        && lastState?.readyState === "complete"
        && (lastState.noteCount > 0 || lastState.noNotes);
      const signature = `${lastState?.noteCount || 0}:${lastState?.noteSignature || "empty"}`;
      if (!hasReadyProfile || lastState?.loading) {
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
        hasReadyProfile
        && !lastState?.loading
        && stablePolls >= XIAOHONGSHU_PROFILE_SETTLE_POLLS
        && Date.now() - stableSince >= XIAOHONGSHU_PROFILE_SETTLE_MIN_MS
      ) {
        return lastState;
      }
    } catch (error) {
      if (session.stopped || error.code === "XIAOHONGSHU_PROFILE_CAPTURE_STOPPED") throw stopError();
      if (/安全验证|登录状态/.test(error.message)) throw error;
      lastState = { error: error.message || String(error) };
      lastSignature = "";
      stableSince = 0;
      stablePolls = 0;
    }
    await sleep(350);
  }

  throw new Error(
    `等待博主主页及笔记列表稳定超时：${lastState?.href || lastState?.error || "页面未返回可采集内容"}`
  );
}

function noteKey(note) {
  return String(note?.noteId || note?.url || "").trim();
}

async function collectProfileData(tabId, limit, session) {
  const maximum = Math.min(100, Math.max(1, Number(limit) || 20));
  const notesByKey = new Map();
  let pageUrl = "";
  let capturedAt = new Date().toISOString();
  let unchangedRounds = 0;
  let previousSignature = "";

  for (let round = 0; round < 24; round += 1) {
    throwIfStopped(session);
    const data = await executeTabFunction(
      tabId,
      runXiaohongshuProfilePageCommand,
      ["extract", { limit: maximum }]
    );
    throwIfStopped(session);
    pageUrl = data?.pageUrl || pageUrl;
    capturedAt = data?.capturedAt || capturedAt;

    for (const note of data?.notes || []) {
      const key = noteKey(note);
      if (!key) continue;
      if (!notesByKey.has(key)) notesByKey.set(key, { ...note, order: notesByKey.size + 1 });
      else notesByKey.set(key, { ...notesByKey.get(key), ...note });
      if (notesByKey.size >= maximum) break;
    }
    if (notesByKey.size >= maximum || data?.noteCardCount === 0) break;

    const signature = `${notesByKey.size}:${data?.noteCardCount || 0}:${(data?.notes || []).map(noteKey).join("|")}`;
    if (signature === previousSignature) unchangedRounds += 1;
    else unchangedRounds = 0;
    previousSignature = signature;
    if (unchangedRounds >= 3) break;

    await executeTabFunction(tabId, scrollPageToBottom);
    await sleep(1100);
  }

  return {
    notes: [...notesByKey.values()].slice(0, maximum),
    capturedAt,
    pageUrl
  };
}

export async function captureXiaohongshuProfile(options) {
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
  if (!Number.isInteger(tab?.id)) throw new Error("无法找到用于小红书博主采集的标签页。");

  const session = { runId, tabId: tab.id, stopped: false };
  activeCaptures.set(runId, session);
  let completed = false;
  try {
    throwIfStopped(session);
    if (!options.isolated) await callChrome((done) => chrome.tabs.update(tab.id, { active: true }, done));
    throwIfStopped(session);
    await navigateTab(tab.id, profileUrl);
    await waitForProfilePage(tab.id, session);
    const data = await collectProfileData(tab.id, options.limit, session);
    completed = true;
    return { ok: true, tabId: tab.id, data };
  } finally {
    if (activeCaptures.get(runId) === session) activeCaptures.delete(runId);
    if (ownsTargetTab && (completed || session.stopped)) await closePluginCreatedTab(tab.id);
  }
}

export async function stopXiaohongshuProfileCapture(options) {
  const runId = String(options.runId || "").trim();
  const session = activeCaptures.get(runId);
  if (!session) return { ok: true, stopped: false };
  session.stopped = true;
  return { ok: true, stopped: true };
}

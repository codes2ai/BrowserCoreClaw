import { attachDebugger, detachDebugger, evaluate, sendCommand, sleep } from "../../../background/debugger-client.js";
import {
  WEIBO_HOME_URL,
  WEIBO_PROFILE_READY_TIMEOUT_MS,
  WEIBO_PROFILE_SETTLE_MIN_MS,
  WEIBO_PROFILE_SETTLE_POLLS
} from "./constants.js";
import { runWeiboPageCommand } from "../page-extract.js";

const WEIBO_URL_PATTERNS = ["https://weibo.com/*", "https://www.weibo.com/*"];
const activeCaptures = new Map();

function callChrome(callbackApi) {
  return new Promise((resolve, reject) => {
    callbackApi((result) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result);
    });
  });
}

async function closePluginCreatedTab(tabId) {
  if (!Number.isInteger(tabId)) return;
  await callChrome((done) => chrome.tabs.remove(tabId, done)).catch(() => {});
}

function isWeiboProfileUrl(value) {
  try {
    const url = new URL(value);
    return /(^|\.)weibo\.com$/i.test(url.hostname) && /^\/u\/\d+\/?$/i.test(url.pathname);
  } catch { return false; }
}

async function getWeiboTab(preferredTabId = null, isolated = false) {
  if (Number.isInteger(preferredTabId)) {
    try {
      const tab = await callChrome((done) => chrome.tabs.get(preferredTabId, done));
      if (tab?.url && /(^https:\/\/)([^/]+\.)?weibo\.com\//i.test(tab.url)) return tab;
    } catch { /* The previous task tab was closed. */ }
  }
  if (isolated) {
    return callChrome((done) => chrome.tabs.create({ url: WEIBO_HOME_URL, active: false }, done));
  }
  const tabs = await callChrome((done) => chrome.tabs.query({ url: WEIBO_URL_PATTERNS }, done));
  const existing = [...tabs].sort((first, second) => {
    if (first.active !== second.active) return first.active ? -1 : 1;
    return (second.lastAccessed || 0) - (first.lastAccessed || 0);
  })[0];
  return existing?.id ? existing : callChrome((done) => chrome.tabs.create({ url: WEIBO_HOME_URL, active: true }, done));
}

function stoppedError() {
  const error = new Error("任务已停止");
  error.code = "WEIBO_PROFILE_POSTS_STOPPED";
  return error;
}

function throwIfStopped(session) {
  if (session.stopped) throw stoppedError();
}

function pageCommand(tabId, command, options = {}) {
  return evaluate(tabId, `(${runWeiboPageCommand.toString()})(${JSON.stringify(command)}, ${JSON.stringify(options)})`);
}

async function waitForWeiboProfile(tabId, session) {
  const deadline = Date.now() + WEIBO_PROFILE_READY_TIMEOUT_MS;
  let previousSignature = "";
  let stableSince = 0;
  let stablePolls = 0;
  let lastState = null;
  while (Date.now() < deadline) {
    throwIfStopped(session);
    try {
      lastState = await pageCommand(tabId, "inspect");
      throwIfStopped(session);
      if (lastState?.captcha) throw new Error("微博页面需要安全验证，请在标签页完成验证后再次运行。");
      if (lastState?.requiresLogin) throw new Error("微博页面要求登录，请在当前浏览器标签页登录后再次运行。");
      const ready = lastState?.isProfilePage && lastState?.hasProfile && lastState?.readyState === "complete";
      const hasContent = Number(lastState?.postCount) > 0 || lastState?.noPosts;
      const signature = `${lastState?.profileSignature || ""}|${lastState?.postSignature || ""}|${lastState?.postCount || 0}`;
      if (!ready || !hasContent || !signature) {
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
      if (ready && hasContent && stablePolls >= WEIBO_PROFILE_SETTLE_POLLS && Date.now() - stableSince >= WEIBO_PROFILE_SETTLE_MIN_MS) return lastState;
    } catch (error) {
      if (session.stopped || error.code === "WEIBO_PROFILE_POSTS_STOPPED") throw stoppedError();
      if (/安全验证|要求登录/.test(error.message)) throw error;
      lastState = { error: error.message || String(error) };
      previousSignature = "";
      stableSince = 0;
      stablePolls = 0;
    }
    await sleep(350);
  }
  throw new Error(`等待微博主页和博文列表稳定超时：${lastState?.href || lastState?.error || "页面未返回可采集内容"}`);
}

function postKey(post) {
  return String(post?.postId || post?.url || "").trim();
}

async function collectPosts(tabId, limit, session) {
  const maximum = Math.max(1, Math.min(100, Number(limit) || 20));
  const posts = new Map();
  let capturedAt = new Date().toISOString();
  let pageUrl = "";
  let unchangedRounds = 0;
  let previousSignature = "";
  for (let round = 0; round < 24; round += 1) {
    throwIfStopped(session);
    const data = await pageCommand(tabId, "extract-posts", { limit: maximum });
    throwIfStopped(session);
    capturedAt = data?.capturedAt || capturedAt;
    pageUrl = data?.pageUrl || pageUrl;
    for (const post of data?.posts || []) {
      const key = postKey(post);
      if (!key) continue;
      posts.set(key, { ...posts.get(key), ...post, order: posts.has(key) ? posts.get(key).order : posts.size + 1 });
      if (posts.size >= maximum) break;
    }
    if (posts.size >= maximum || data?.postCardCount === 0) break;
    const signature = `${posts.size}:${data?.postCardCount || 0}:${(data?.posts || []).map(postKey).join("|")}`;
    unchangedRounds = signature === previousSignature ? unchangedRounds + 1 : 0;
    previousSignature = signature;
    if (unchangedRounds >= 3) break;
    await pageCommand(tabId, "scroll");
    await sleep(1100);
  }
  return { posts: [...posts.values()].slice(0, maximum), capturedAt, pageUrl };
}

export async function captureWeiboProfilePosts(options) {
  const profileUrl = String(options.profileUrl || "").trim();
  const runId = String(options.runId || "").trim();
  if (!isWeiboProfileUrl(profileUrl)) throw new Error("博主主页链接必须是 https://weibo.com/u/数字ID 格式。");
  if (!runId) throw new Error("缺少运行任务编号。");
  const parsedTabId = Number(options.tabId);
  const hasRequestedTab = Number.isInteger(parsedTabId) && parsedTabId > 0;
  const requestedTabId = hasRequestedTab ? parsedTabId : null;
  const ownsTargetTab = Boolean(options.isolated) && !hasRequestedTab;
  const tab = await getWeiboTab(requestedTabId, Boolean(options.isolated));
  if (!Number.isInteger(tab?.id)) throw new Error("无法找到用于微博博文采集的标签页。");
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
    await waitForWeiboProfile(tab.id, session);
    const data = await collectPosts(tab.id, options.limit, session);
    completed = true;
    return { ok: true, tabId: tab.id, data };
  } finally {
    if (activeCaptures.get(runId) === session) activeCaptures.delete(runId);
    if (attached) await detachDebugger(tab.id).catch(() => {});
    if (ownsTargetTab && (completed || session.stopped)) await closePluginCreatedTab(tab.id);
  }
}

export async function stopWeiboProfilePostsCapture(options) {
  const session = activeCaptures.get(String(options.runId || "").trim());
  if (!session) return { ok: true, stopped: false };
  session.stopped = true;
  await detachDebugger(session.tabId).catch(() => {});
  return { ok: true, stopped: true };
}

import { executeTabFunction, navigateTab, sleep } from "../../../background/tab-script-client.js";
import {
  WEIBO_HOME_URL,
  WEIBO_PROFILE_READY_TIMEOUT_MS,
  WEIBO_PROFILE_SETTLE_MIN_MS,
  WEIBO_PROFILE_SETTLE_POLLS
} from "./constants.js";
import { runWeiboPageCommand } from "../page-extract.js";

const WEIBO_URL_PATTERNS = ["https://weibo.com/*", "https://www.weibo.com/*"];
const activeCaptures = new Map();
let managedLoginTabId = null;

function readWeiboLoginState() {
  const text = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const isVisible = (element) => {
    if (!element) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden"
      && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
  };
  const controls = [...document.querySelectorAll("a, button, [role='button']")]
    .filter(isVisible)
    .map((element) => text(element.innerText || element.getAttribute("aria-label") || element.getAttribute("title")))
    .filter(Boolean);
  const pageText = text(document.body?.innerText);
  return {
    href: location.href,
    readyState: document.readyState,
    hasLoginEntry: controls.some((label) => /^(?:登录|注册|登录\/注册|立即登录|账号登录)$/.test(label))
      || Boolean(document.querySelector('input[type="password"], input[name="username"], input[autocomplete="username"]')),
    isVerificationPage: /安全验证|验证码|访问频繁|操作频繁|请完成验证/.test(pageText),
    hasEnoughContent: pageText.length > 80
  };
}

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

function isWeiboLoginPageUrl(value) {
  try {
    const url = new URL(value);
    return /(^|\.)weibo\.com$/i.test(url.hostname)
      || /(^|\.)passport\.weibo\.com$/i.test(url.hostname)
      || /(^|\.)login\.sina\.com\.cn$/i.test(url.hostname);
  } catch { return false; }
}

async function getManagedLoginTab(active = true) {
  if (Number.isInteger(managedLoginTabId)) {
    try {
      const existing = await callChrome((done) => chrome.tabs.get(managedLoginTabId, done));
      if (existing?.url && isWeiboLoginPageUrl(existing.url)) {
        return callChrome((done) => chrome.tabs.update(existing.id, { active }, done));
      }
    } catch {
      // The user may have closed the dedicated login page.
    }
  }
  const tab = await callChrome((done) => chrome.tabs.create({ url: WEIBO_HOME_URL, active }, done));
  managedLoginTabId = Number.isInteger(tab?.id) ? tab.id : null;
  return tab;
}

async function closeManagedLoginTab() {
  const tabId = managedLoginTabId;
  managedLoginTabId = null;
  await closePluginCreatedTab(tabId);
}

async function inspectWeiboLoginState(tabId) {
  const deadline = Date.now() + WEIBO_PROFILE_READY_TIMEOUT_MS;
  let lastError = null;
  let loggedInPolls = 0;
  while (Date.now() < deadline) {
    try {
      const tab = await callChrome((done) => chrome.tabs.get(tabId, done));
      const currentUrl = String(tab?.url || tab?.pendingUrl || "");
      let currentHost = "";
      try { currentHost = new URL(currentUrl).hostname; } catch { /* keep waiting for a navigable URL */ }
      if (/(^|\.)passport\.weibo\.com$|(^|\.)login\.sina\.com\.cn$/i.test(currentHost)) {
        return { state: "logged_out", reason: "当前 Chrome Profile 尚未登录微博。" };
      }
      if (/(^https:\/\/)([^/]+\.)?weibo\.com\//i.test(currentUrl)) {
        const pageState = await executeTabFunction(tabId, readWeiboLoginState);
        if (pageState?.readyState === "complete" && (pageState.hasEnoughContent || pageState.hasLoginEntry)) {
          if (pageState.isVerificationPage) {
            return { state: "unknown", reason: "微博页面需要安全验证，请在登录页完成后重新检测。" };
          }
          if (pageState.hasLoginEntry) {
            return { state: "logged_out", reason: "当前 Chrome Profile 尚未登录微博。" };
          }
          loggedInPolls += 1;
          if (loggedInPolls >= 3) {
            return { state: "logged_in", reason: "已确认当前 Chrome Profile 的微博登录状态。" };
          }
        }
      }
    } catch (error) {
      lastError = error;
      loggedInPolls = 0;
    }
    await sleep(500);
  }
  return {
    state: "unknown",
    reason: `微博页面加载超时${lastError ? `：${lastError.message}` : ""}`
  };
}

export async function checkWeiboProfilePostsLogin() {
  // 每次检测使用独立临时页，避免占用正在运行的微博采集任务标签页。
  const tab = await callChrome((done) => chrome.tabs.create({
    url: WEIBO_HOME_URL,
    active: false
  }, done));
  if (!Number.isInteger(tab?.id)) throw new Error("无法打开用于检测的微博标签页。");
  try {
    const login = await inspectWeiboLoginState(tab.id);
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

export async function openWeiboProfilePostsLogin() {
  const tab = await getManagedLoginTab(true);
  if (!Number.isInteger(tab?.id)) throw new Error("无法打开微博登录页面。");
  if (Number.isInteger(tab.windowId)) {
    await callChrome((done) => chrome.windows.update(tab.windowId, { focused: true }, done));
  }
  return { ok: true, tabId: tab.id };
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
  return executeTabFunction(tabId, runWeiboPageCommand, [command, options]);
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

function randomScrollPause() {
  return Math.floor(2200 + Math.random() * 2301);
}

async function waitForScrollPause(session, milliseconds) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    throwIfStopped(session);
    await sleep(Math.min(180, Math.max(1, deadline - Date.now())));
  }
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
    const scrollState = await pageCommand(tabId, "scroll", { minimumRatio: 0.55, maximumRatio: 0.9 });
    await waitForScrollPause(session, randomScrollPause());
    if (scrollState?.reachedEnd && unchangedRounds >= 1) break;
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
  let completed = false;
  try {
    if (!options.isolated) await callChrome((done) => chrome.tabs.update(tab.id, { active: true }, done));
    throwIfStopped(session);
    await navigateTab(tab.id, profileUrl);
    await waitForWeiboProfile(tab.id, session);
    const data = await collectPosts(tab.id, options.limit, session);
    completed = true;
    return { ok: true, tabId: tab.id, data };
  } finally {
    if (activeCaptures.get(runId) === session) activeCaptures.delete(runId);
    if (ownsTargetTab && (completed || session.stopped)) await closePluginCreatedTab(tab.id);
  }
}

export async function stopWeiboProfilePostsCapture(options) {
  const session = activeCaptures.get(String(options.runId || "").trim());
  if (!session) return { ok: true, stopped: false };
  session.stopped = true;
  return { ok: true, stopped: true };
}

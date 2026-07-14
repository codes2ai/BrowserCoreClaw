import { attachDebugger, detachDebugger, evaluate, sendCommand, sleep } from "../../background/debugger-client.js";
import { runDouyinPageCommand } from "./page-extract.js";

const DOUYIN_HOME_URL = "https://www.douyin.com/";
const READY_TIMEOUT_MS = 30000;
const SETTLE_MIN_MS = 900;
const SETTLE_POLLS = 3;
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

export function isDouyinProfileUrl(value) {
  try {
    const url = new URL(value);
    return /(^|\.)douyin\.com$/i.test(url.hostname) && /^\/user\/[^/]+\/?$/i.test(url.pathname);
  } catch { return false; }
}

export function isDouyinPostUrl(value) {
  try {
    const url = new URL(value);
    const isDouyinHost = /(^|\.)douyin\.com$/i.test(url.hostname);
    const isShortLink = /^v\.douyin\.com$/i.test(url.hostname) && /^\/[A-Za-z0-9_-]+\/?$/i.test(url.pathname);
    return isDouyinHost
      && (/^\/video\/\d+\/?$/i.test(url.pathname) || (/^\/user\/[^/]+\/?$/i.test(url.pathname) && /^\d+$/.test(url.searchParams.get("modal_id") || "")) || isShortLink);
  } catch { return false; }
}

async function getDouyinTab(preferredTabId = null, isolated = false) {
  if (Number.isInteger(preferredTabId)) {
    try {
      const tab = await callChrome((done) => chrome.tabs.get(preferredTabId, done));
      if (tab?.url && /(^https:\/\/)([^/]+\.)?douyin\.com\//i.test(tab.url)) return tab;
    } catch { /* The former task tab might have been closed. */ }
  }
  if (isolated) {
    return callChrome((done) => chrome.tabs.create({ url: DOUYIN_HOME_URL, active: false }, done));
  }
  // 任务首次运行时使用独立标签页，避免占用用户正在浏览、且可能被其它
  // 采集工具调试的抖音页面。后续同一任务会通过 tabId 复用该页面。
  return callChrome((done) => chrome.tabs.create({ url: DOUYIN_HOME_URL, active: true }, done));
}

function stoppedError(operation) {
  const error = new Error("任务已停止");
  error.code = `DOUYIN_${operation.toUpperCase().replaceAll("-", "_")}_STOPPED`;
  return error;
}

function throwIfStopped(session) {
  if (session.stopped) throw stoppedError(session.operation);
}

function pageCommand(tabId, command, options = {}) {
  return evaluate(tabId, `(${runDouyinPageCommand.toString()})(${JSON.stringify(command)}, ${JSON.stringify(options)})`);
}

function isDetachedDebuggerError(error) {
  return /debugger is not attached|cannot find context with specified id|inspected target navigated or closed/i.test(error?.message || "");
}

async function reconnectDebugger(tabId, session) {
  throwIfStopped(session);
  session.reconnects = Number(session.reconnects || 0) + 1;
  if (session.reconnects > 3) {
    throw new Error("抖音页面调试连接连续中断。请关闭同时占用抖音页面的采集/调试扩展后重试。");
  }
  await attachDebugger(tabId).catch((error) => {
    if (!/already attached/i.test(error.message)) throw error;
  });
  await sendCommand(tabId, "Runtime.enable");
  await sendCommand(tabId, "Page.enable");
}

async function waitForStablePage(tabId, operation, session) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let signature = "";
  let stableSince = 0;
  let stablePolls = 0;
  let lastState = null;
  const isPosts = operation === "profile-posts";
  const isInfo = operation === "profile-info";
  const inspectCommand = operation === "post-detail" ? "inspect-detail" : "inspect-profile";
  while (Date.now() < deadline) {
    throwIfStopped(session);
    try {
      lastState = await pageCommand(tabId, inspectCommand);
      throwIfStopped(session);
      if (lastState?.captcha) throw new Error("抖音页面需要安全验证，请在标签页完成验证后再次运行。");
      const ready = operation === "post-detail"
        ? lastState?.hasDetail && lastState?.readyState === "complete"
        : lastState?.isProfilePage && lastState?.hasProfile && lastState?.readyState === "complete" && (!isPosts || Number(lastState?.postCount) > 0 || lastState?.noPosts);
      const nextSignature = operation === "post-detail"
        ? lastState?.detailSignature
        : isPosts ? `${lastState?.profileSignature || ""}|${lastState?.postSignature || ""}|${lastState?.postCount || 0}` : lastState?.profileSignature;
      if (!ready || !nextSignature) { signature = ""; stableSince = 0; stablePolls = 0; }
      else if (nextSignature === signature) stablePolls += 1;
      else { signature = nextSignature; stableSince = Date.now(); stablePolls = 1; }
      if (ready && stablePolls >= SETTLE_POLLS && Date.now() - stableSince >= SETTLE_MIN_MS) return lastState;
    } catch (error) {
      if (session.stopped || error.code === stoppedError(operation).code) throw stoppedError(operation);
      if (/安全验证/.test(error.message)) throw error;
      if (isDetachedDebuggerError(error)) {
        lastState = { error: "页面导航时调试连接中断，正在重新连接" };
        signature = ""; stableSince = 0; stablePolls = 0;
        await reconnectDebugger(tabId, session);
        await sleep(250);
        continue;
      }
      lastState = { error: error.message || String(error) };
      signature = ""; stableSince = 0; stablePolls = 0;
    }
    await sleep(350);
  }
  const label = isPosts ? "博主主页和作品列表" : isInfo ? "博主资料" : "作品详情";
  throw new Error(`等待抖音${label}稳定超时：${lastState?.href || lastState?.error || "页面未返回可采集内容"}`);
}

async function collectPosts(tabId, limit, session) {
  const maximum = Math.max(1, Math.min(100, Number(limit) || 20));
  const posts = new Map();
  let capturedAt = new Date().toISOString();
  let pageUrl = "";
  let previousSignature = "";
  let unchangedRounds = 0;
  for (let round = 0; round < 24; round += 1) {
    throwIfStopped(session);
    const data = await pageCommand(tabId, "extract-posts", { limit: maximum });
    throwIfStopped(session);
    capturedAt = data?.capturedAt || capturedAt;
    pageUrl = data?.pageUrl || pageUrl;
    for (const post of data?.posts || []) {
      const key = String(post?.videoId || post?.url || "").trim();
      if (!key) continue;
      posts.set(key, { ...posts.get(key), ...post, order: posts.has(key) ? posts.get(key).order : posts.size + 1 });
      if (posts.size >= maximum) break;
    }
    if (posts.size >= maximum || data?.postCardCount === 0) break;
    const nextSignature = `${posts.size}:${data?.postCardCount || 0}:${(data?.posts || []).map((post) => post.videoId).join("|")}`;
    unchangedRounds = nextSignature === previousSignature ? unchangedRounds + 1 : 0;
    previousSignature = nextSignature;
    if (unchangedRounds >= 3) break;
    await pageCommand(tabId, "scroll");
    await sleep(1100);
  }
  return { posts: [...posts.values()].slice(0, maximum), capturedAt, pageUrl };
}

export async function captureDouyin(operation, options) {
  const targetKey = operation === "post-detail" ? "postUrl" : "profileUrl";
  const targetUrl = String(options[targetKey] || "").trim();
  const runId = String(options.runId || "").trim();
  const valid = operation === "post-detail" ? isDouyinPostUrl(targetUrl) : isDouyinProfileUrl(targetUrl);
  if (!valid) throw new Error(operation === "post-detail"
    ? "抖音作品链接必须是 https://www.douyin.com/video/数字ID 或 v.douyin.com 短链格式。"
    : "抖音博主主页链接必须是 https://www.douyin.com/user/用户ID 格式。");
  if (!runId) throw new Error("缺少运行任务编号。");
  const parsedTabId = Number(options.tabId);
  const hasRequestedTab = Number.isInteger(parsedTabId) && parsedTabId > 0;
  const requestedTabId = hasRequestedTab ? parsedTabId : null;
  const ownsTargetTab = Boolean(options.isolated) && !hasRequestedTab;
  const tab = await getDouyinTab(requestedTabId, Boolean(options.isolated));
  if (!Number.isInteger(tab?.id)) throw new Error("无法找到用于抖音采集的标签页。");
  const session = { runId, operation, tabId: tab.id, stopped: false, reconnects: 0 };
  activeCaptures.set(`${operation}:${runId}`, session);
  let attached = false;
  let completed = false;
  try {
    if (!options.isolated) await callChrome((done) => chrome.tabs.update(tab.id, { active: true }, done));
    await attachDebugger(tab.id); attached = true;
    await sendCommand(tab.id, "Runtime.enable");
    await sendCommand(tab.id, "Page.enable");
    throwIfStopped(session);
    await sendCommand(tab.id, "Page.navigate", { url: targetUrl });
    await waitForStablePage(tab.id, operation, session);
    throwIfStopped(session);
    const data = operation === "profile-posts"
      ? await collectPosts(tab.id, options.limit, session)
      : await pageCommand(tab.id, operation === "profile-info" ? "extract-profile" : "extract-detail");
    const validData = operation === "profile-posts" ? Array.isArray(data?.posts) : operation === "profile-info" ? Boolean(data?.profile?.profileId || data?.profile?.nickname) : Boolean(data?.detail?.videoId || data?.detail?.text);
    if (!validData) throw new Error(`未读取到抖音${operation === "profile-info" ? "博主资料" : operation === "profile-posts" ? "作品" : "作品详情"}，请确认链接可公开访问。`);
    completed = true;
    return { ok: true, tabId: tab.id, data };
  } finally {
    if (activeCaptures.get(`${operation}:${runId}`) === session) activeCaptures.delete(`${operation}:${runId}`);
    if (attached) await detachDebugger(tab.id).catch(() => {});
    if (ownsTargetTab && (completed || session.stopped)) await closePluginCreatedTab(tab.id);
  }
}

export async function stopDouyinCapture(operation, options) {
  const session = activeCaptures.get(`${operation}:${String(options.runId || "").trim()}`);
  if (!session) return { ok: true, stopped: false };
  session.stopped = true;
  await detachDebugger(session.tabId).catch(() => {});
  return { ok: true, stopped: true };
}

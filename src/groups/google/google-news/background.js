import { attachDebugger, detachDebugger, evaluate, sendCommand, sleep } from "../../../background/debugger-client.js";
import { GOOGLE_NEWS_READY_TIMEOUT_MS } from "./constants.js";
import { extractGoogleNewsResults } from "./page-extract.js";
import { buildGoogleNewsSearchUrl } from "./search-url.js";

function normalizeLimit(rawLimit) {
  const value = Number(rawLimit);
  return Number.isFinite(value) ? Math.min(100, Math.max(1, Math.round(value))) : 20;
}

const activeCaptures = new Map();

function stopError() {
  const error = new Error("任务已停止");
  error.code = "GOOGLE_NEWS_STOPPED";
  return error;
}

function throwIfStopped(session) {
  if (session.stopped) {
    throw stopError();
  }
}

async function getNewsPageState(tabId) {
  return evaluate(tabId, `(() => {
    const text = document.body ? document.body.innerText : "";
    const url = new URL(location.href);
    const resultCount = document.querySelectorAll("#rso a h3, #search a h3, #rso a [role='heading'], #search a [role='heading']").length;
    const newsContainers = document.querySelectorAll("#rso div.SoaBEf, #search div.SoaBEf, #rso div.MjjYud, #search div.MjjYud").length;
    return {
      href: location.href,
      readyState: document.readyState,
      tbm: url.searchParams.get("tbm") || "",
      isGoogleSearchPage: /(^|\\.)google\\./i.test(location.hostname) && location.pathname === "/search",
      resultCount,
      newsContainers,
      captcha: /unusual traffic|not a robot|captcha|验证码|人机身份/i.test(text),
      noResults: /did not match any documents|没有找到|找不到和.*相符|没有与.*相符的结果/i.test(text)
    };
  })()`);
}

async function waitForGoogleNews(tabId, session) {
  const deadline = Date.now() + GOOGLE_NEWS_READY_TIMEOUT_MS;
  let lastState = null;
  let lastError = null;

  while (Date.now() < deadline) {
    throwIfStopped(session);
    try {
      lastState = await getNewsPageState(tabId);
      throwIfStopped(session);
      if (lastState?.captcha) {
        throw new Error("Google 返回了人机验证页面，请在标签页中完成验证后重试。");
      }
      if (
        lastState?.isGoogleSearchPage &&
        lastState.readyState === "complete" &&
        lastState.tbm === "nws" &&
        (lastState.resultCount > 0 || lastState.newsContainers > 0 || lastState.noResults)
      ) {
        return;
      }
    } catch (error) {
      if (session.stopped || error.code === "GOOGLE_NEWS_STOPPED") {
        throw stopError();
      }
      lastError = error;
      if (/人机验证/.test(error.message)) {
        throw error;
      }
    }
    await sleep(500);
  }

  throw new Error(`等待 Google 新闻结果超时：${lastState?.href || lastError?.message || "页面未返回状态"}`);
}

export async function captureGoogleNews(options) {
  const tabId = Number(options.tabId);
  if (!Number.isInteger(tabId)) {
    throw new Error("找不到用于搜索的浏览器标签页。");
  }

  const query = String(options.query || "").trim();
  if (!query) {
    throw new Error("搜索关键词不能为空。");
  }

  const runId = String(options.runId || "").trim();
  if (!runId) {
    throw new Error("缺少运行任务编号。");
  }

  const limit = normalizeLimit(options.limit);
  const session = { runId, tabId, stopped: false };
  activeCaptures.set(runId, session);
  let attached = false;
  try {
    throwIfStopped(session);
    await attachDebugger(tabId);
    attached = true;
    throwIfStopped(session);
    await sendCommand(tabId, "Runtime.enable");
    await sendCommand(tabId, "Page.enable");
    throwIfStopped(session);
    await sendCommand(tabId, "Page.navigate", {
      url: buildGoogleNewsSearchUrl(query, { limit, language: options.language })
    });
    await waitForGoogleNews(tabId, session);
    throwIfStopped(session);
    const data = await evaluate(
      tabId,
      `(${extractGoogleNewsResults.toString()})(${JSON.stringify({ limit })})`
    );
    throwIfStopped(session);
    return { ok: true, data };
  } finally {
    if (activeCaptures.get(runId) === session) {
      activeCaptures.delete(runId);
    }
    if (attached) {
      await detachDebugger(tabId);
    }
  }
}

export async function stopGoogleNewsCapture(options) {
  const runId = String(options.runId || "").trim();
  const session = activeCaptures.get(runId);
  if (!session) {
    return { ok: true, stopped: false };
  }

  session.stopped = true;
  await detachDebugger(session.tabId).catch(() => {});
  return { ok: true, stopped: true };
}

import { attachDebugger, detachDebugger, evaluate, sendCommand, sleep } from "../../../background/debugger-client.js";
import {
  GOOGLE_NEWS_READY_TIMEOUT_MS,
  GOOGLE_NEWS_VERIFICATION_COOLDOWN_MS,
  MESSAGE_GOOGLE_NEWS_CAPTURE_STATUS
} from "./constants.js";
import { extractGoogleNewsResults } from "./page-extract.js";
import { buildGoogleNewsSearchUrl } from "./search-url.js";

function normalizeLimit(rawLimit) {
  const value = Number(rawLimit);
  return Number.isFinite(value) ? Math.min(100, Math.max(1, Math.round(value))) : 20;
}

const activeCaptures = new Map();
const GOOGLE_NEWS_NO_RESULTS_PATTERN = String.raw`did not match any (?:news )?(?:documents|results)|no news results|没有找到|未找到与[\s\S]{0,200}?相关的新闻|未搜到与[\s\S]{0,200}?相关的新闻|找不到和[\s\S]{0,200}?相符|没有与[\s\S]{0,200}?(?:相符的结果|相关的新闻)`;
const GOOGLE_NEWS_RISK_CONTROL_PATTERN = String.raw`unusual traffic|not a robot|captcha|recaptcha|验证码|人机身份|异常流量|自动程序发出`;

export function isGoogleNewsNoResultsText(value) {
  return new RegExp(GOOGLE_NEWS_NO_RESULTS_PATTERN, "i").test(String(value || ""));
}

export function isGoogleNewsRiskControlState(value = {}) {
  const state = value && typeof value === "object" ? value : {};
  let pathname = String(state.pathname || "");
  if (!pathname && state.href) {
    try {
      pathname = new URL(String(state.href)).pathname;
    } catch {
      pathname = "";
    }
  }
  return /^\/sorry(?:\/|$)/i.test(pathname)
    || Boolean(state.hasCaptchaFrame)
    || new RegExp(GOOGLE_NEWS_RISK_CONTROL_PATTERN, "i").test(String(state.text || ""));
}

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

function isVerificationTabUnavailableError(error) {
  return /no tab|tab (?:was )?closed|target closed|not attached|cannot access|inspected target navigated or closed/i
    .test(error?.message || String(error || ""));
}

function notifyCaptureStatus(session, status, extra = {}) {
  try {
    chrome.runtime.sendMessage({
      type: MESSAGE_GOOGLE_NEWS_CAPTURE_STATUS,
      options: {
        runId: session.runId,
        tabId: session.tabId,
        status,
        ...extra
      }
    }, () => void chrome.runtime.lastError);
  } catch {
    // 控制台暂未打开时不影响当前采集流程。
  }
}

function focusVerificationTab(tabId) {
  try {
    chrome.tabs.update(tabId, { active: true }, (tab) => {
      void chrome.runtime.lastError;
      if (!Number.isInteger(tab?.windowId)) return;
      chrome.windows.update(tab.windowId, { focused: true }, () => void chrome.runtime.lastError);
    });
  } catch {
    // 标签页可能刚好被用户关闭，后续轮询会返回明确错误。
  }
}

async function waitForVerificationCooldown(session) {
  const deadline = Date.now() + GOOGLE_NEWS_VERIFICATION_COOLDOWN_MS;
  while (Date.now() < deadline) {
    throwIfStopped(session);
    await sleep(Math.min(250, deadline - Date.now()));
  }
}

async function getNewsPageState(tabId) {
  return evaluate(tabId, `(() => {
    const text = document.body ? document.body.innerText : "";
    const url = new URL(location.href);
    const resultCount = document.querySelectorAll("#rso a h3, #search a h3, #rso a [role='heading'], #search a [role='heading']").length;
    const newsContainers = document.querySelectorAll("#rso div.SoaBEf, #search div.SoaBEf, #rso div.MjjYud, #search div.MjjYud").length;
    const hasCaptchaFrame = Boolean(document.querySelector("iframe[src*='recaptcha'], .g-recaptcha, [data-sitekey]"));
    const riskControl = /^\\/sorry(?:\\/|$)/i.test(location.pathname)
      || hasCaptchaFrame
      || new RegExp(${JSON.stringify(GOOGLE_NEWS_RISK_CONTROL_PATTERN)}, "i").test(text);
    return {
      href: location.href,
      pathname: location.pathname,
      readyState: document.readyState,
      tbm: url.searchParams.get("tbm") || "",
      isGoogleSearchPage: /(^|\\.)google\\./i.test(location.hostname) && location.pathname === "/search",
      resultCount,
      newsContainers,
      hasCaptchaFrame,
      riskControl,
      noResults: new RegExp(${JSON.stringify(GOOGLE_NEWS_NO_RESULTS_PATTERN)}, "i").test(text)
    };
  })()`);
}

async function waitForGoogleNews(tabId, session) {
  let deadline = Date.now() + GOOGLE_NEWS_READY_TIMEOUT_MS;
  let lastState = null;
  let lastError = null;

  while (Date.now() < deadline || session.waitingVerification) {
    throwIfStopped(session);
    try {
      lastState = await getNewsPageState(tabId);
      throwIfStopped(session);
      if (lastState?.riskControl) {
        if (!session.waitingVerification) {
          session.waitingVerification = true;
          session.verificationCount += 1;
          notifyCaptureStatus(session, "waiting_verification", {
            href: lastState.href,
            verificationCount: session.verificationCount
          });
          focusVerificationTab(tabId);
        }
        await sleep(500);
        continue;
      }
      if (
        lastState?.isGoogleSearchPage &&
        lastState.readyState === "complete" &&
        lastState.tbm === "nws" &&
        (lastState.resultCount > 0 || lastState.newsContainers > 0 || lastState.noResults)
      ) {
        if (session.waitingVerification) {
          notifyCaptureStatus(session, "verification_passed", {
            href: lastState.href,
            cooldownMs: GOOGLE_NEWS_VERIFICATION_COOLDOWN_MS
          });
          await waitForVerificationCooldown(session);
          session.waitingVerification = false;
          deadline = Date.now() + GOOGLE_NEWS_READY_TIMEOUT_MS;
          notifyCaptureStatus(session, "capture_resumed", { href: lastState.href });
        }
        return lastState;
      }
    } catch (error) {
      if (session.stopped || error.code === "GOOGLE_NEWS_STOPPED") {
        throw stopError();
      }
      if (session.waitingVerification && isVerificationTabUnavailableError(error)) {
        throw new Error("Google 验证页面已被关闭，无法继续当前任务。");
      }
      lastError = error;
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
  const session = {
    runId,
    tabId,
    stopped: false,
    waitingVerification: false,
    verificationCount: 0
  };
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
    const pageState = await waitForGoogleNews(tabId, session);
    throwIfStopped(session);
    const data = await evaluate(
      tabId,
      `(${extractGoogleNewsResults.toString()})(${JSON.stringify({ limit })})`
    );
    throwIfStopped(session);
    return {
      ok: true,
      empty: Boolean(pageState?.noResults && Number(data?.resultCount) === 0),
      data
    };
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

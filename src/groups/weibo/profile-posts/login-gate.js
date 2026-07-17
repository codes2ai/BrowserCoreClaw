import {
  MESSAGE_CHECK_WEIBO_PROFILE_POSTS_LOGIN,
  MESSAGE_OPEN_WEIBO_PROFILE_POSTS_LOGIN
} from "./constants.js";
import { mountWeiboProfilePostsMonitor } from "./monitor.js";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function isExtensionRuntime() {
  return Boolean(globalThis.chrome?.runtime?.id && chrome.runtime?.sendMessage);
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(response);
    });
  });
}

function waitForNextPaint() {
  return new Promise((resolve) => {
    const schedule = globalThis.requestAnimationFrame || ((callback) => setTimeout(callback, 0));
    schedule(() => schedule(resolve));
  });
}

function renderProgress(state) {
  const stages = [
    ["preparing", "准备检测", "正在建立微博检测连接"],
    ["checking", "读取登录状态", "正在确认当前 Chrome Profile"],
    ["ready", "进入功能", "登录确认后加载博文采集"]
  ];
  const stageIndex = stages.findIndex(([id]) => id === state.step);
  const activeIndex = stageIndex >= 0 ? stageIndex : state.phase === "logged_out" || state.phase === "error" ? 1 : 0;
  return `
    <ol class="xhs-login-progress" aria-label="微博登录检测进度">
      ${stages.map(([, title, description], index) => {
        const status = index < activeIndex ? "done" : index === activeIndex ? "active" : "pending";
        return `<li class="${status}"><span aria-hidden="true">${status === "done" ? "✓" : index + 1}</span><div><strong>${title}</strong><small>${description}</small></div></li>`;
      }).join("")}
    </ol>
  `;
}

function gateTemplate(state, context) {
  const featureName = context?.feature?.name || "微博博主博文采集";
  const isChecking = state.phase === "checking";
  const isLoggedOut = state.phase === "logged_out";
  const isUnavailable = state.phase === "unavailable";
  const isError = state.phase === "error";
  const statusLabel = isChecking
    ? "正在检测"
    : isLoggedOut
      ? "需要登录"
      : isUnavailable
        ? "仅扩展可用"
        : isError
          ? "检测未完成"
          : "等待检测";

  return `
    <section class="xhs-login-gate" aria-labelledby="weibo-profile-posts-login-title">
      <header class="xhs-login-gate-header">
        <div>
          <p class="xhs-eyebrow">WEIBO / LOGIN CHECK</p>
          <div class="xhs-title-row">
            <h1 id="weibo-profile-posts-login-title">${escapeHtml(featureName)}</h1>
            <span class="xhs-version">v0.1.0</span>
          </div>
        </div>
        <span class="xhs-login-status ${escapeHtml(state.phase)}">${statusLabel}</span>
      </header>

      <div class="xhs-login-gate-body">
        <div class="xhs-login-icon" aria-hidden="true">微博</div>
        <h2>${isLoggedOut ? "请先登录微博" : "正在确认微博登录状态"}</h2>
        <p>${escapeHtml(state.message)}</p>
        ${renderProgress(state)}
        <ol class="xhs-login-steps">
          <li>在当前 Chrome Profile 的微博页面完成账号登录。</li>
          <li>回到扩展，点击“重新检测”。</li>
          <li>仅检测到登录成功后，才会显示博主主页输入和运行参数。</li>
        </ol>
        <div class="xhs-login-actions">
          <button class="xhs-primary-button" type="button" data-weibo-login-action="open" ${isChecking || isUnavailable ? "disabled" : ""}>
            打开微博登录页
          </button>
          <button class="xhs-secondary-button" type="button" data-weibo-login-action="check" ${isChecking || isUnavailable ? "disabled" : ""}>
            ${isChecking ? "检测中…" : "重新检测"}
          </button>
        </div>
        ${isError ? '<p class="xhs-login-hint">若页面尚在加载或需要安全验证，请完成后重新检测。</p>' : ""}
        ${isUnavailable ? '<p class="xhs-login-hint">请在已安装 BrowserCoreClaw 的 Chrome 扩展控制台中打开此功能。</p>' : ""}
      </div>
    </section>
  `;
}

export function mountWeiboProfilePostsLoginGate(container, context, options = {}) {
  let disposed = false;
  let monitorCleanup = null;
  let requestId = 0;
  const mountMonitor = options.mountMonitor || mountWeiboProfilePostsMonitor;
  const state = {
    phase: isExtensionRuntime() ? "checking" : "unavailable",
    step: isExtensionRuntime() ? "preparing" : "",
    message: isExtensionRuntime()
      ? "正在准备微博登录检测，检测页会在后台打开，不会打断当前操作。"
      : "网页预览无法读取 Chrome Profile 的微博登录状态。"
  };

  const render = () => {
    if (!disposed && !monitorCleanup) container.innerHTML = gateTemplate(state, context);
  };

  const enterFeature = async () => {
    if (disposed || monitorCleanup) return;
    container.replaceChildren();
    monitorCleanup = await mountMonitor(container, context);
  };

  const checkLogin = async () => {
    if (!isExtensionRuntime() || disposed || monitorCleanup) return;
    const currentRequestId = ++requestId;
    state.phase = "checking";
    state.step = "preparing";
    state.message = "正在准备微博登录检测，检测页会在后台打开。";
    render();
    await waitForNextPaint();
    if (disposed || currentRequestId !== requestId || monitorCleanup) return;
    state.step = "checking";
    state.message = "正在后台读取当前 Chrome Profile 的微博登录状态…";
    render();
    try {
      const response = await sendMessage({ type: MESSAGE_CHECK_WEIBO_PROFILE_POSTS_LOGIN });
      if (disposed || currentRequestId !== requestId || monitorCleanup) return;
      if (!response?.ok) throw new Error(response?.error || "微博登录状态检测失败。");
      if (response.loggedIn) {
        state.step = "ready";
        state.message = "已确认微博登录状态，正在进入博主博文采集功能…";
        render();
        await waitForNextPaint();
        await enterFeature();
        return;
      }
      state.phase = response.state === "logged_out" ? "logged_out" : "error";
      state.step = "";
      state.message = response.reason || "尚未确认微博登录状态，请完成登录后重新检测。";
      render();
    } catch (error) {
      if (disposed || currentRequestId !== requestId || monitorCleanup) return;
      state.phase = "error";
      state.step = "";
      state.message = error.message || "微博登录状态检测失败，请重新检测。";
      render();
    }
  };

  const openLoginPage = async () => {
    if (!isExtensionRuntime() || disposed || monitorCleanup) return;
    state.phase = "checking";
    state.step = "checking";
    state.message = "正在打开微博登录页，请在该标签页完成登录。";
    render();
    try {
      const response = await sendMessage({ type: MESSAGE_OPEN_WEIBO_PROFILE_POSTS_LOGIN });
      if (!response?.ok) throw new Error(response?.error || "无法打开微博登录页。");
      if (disposed || monitorCleanup) return;
      state.phase = "logged_out";
      state.step = "";
      state.message = "微博登录页已打开。完成账号登录或安全验证后，回到这里点击“重新检测”。";
      render();
    } catch (error) {
      if (disposed || monitorCleanup) return;
      state.phase = "error";
      state.step = "";
      state.message = error.message || "无法打开微博登录页。";
      render();
    }
  };

  const handleClick = (event) => {
    const button = event.target.closest("[data-weibo-login-action]");
    if (!button || button.disabled) return;
    if (button.dataset.weiboLoginAction === "open") openLoginPage().catch(console.error);
    else if (button.dataset.weiboLoginAction === "check") checkLogin().catch(console.error);
  };

  container.addEventListener("click", handleClick);
  render();
  if (isExtensionRuntime()) checkLogin().catch(console.error);

  return () => {
    disposed = true;
    requestId += 1;
    container.removeEventListener("click", handleClick);
    monitorCleanup?.();
    container.replaceChildren();
  };
}

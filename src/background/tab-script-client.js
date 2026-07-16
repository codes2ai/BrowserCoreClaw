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

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function navigateTab(tabId, url) {
  if (!Number.isInteger(Number(tabId))) {
    throw new Error("找不到用于页面导航的浏览器标签页。");
  }
  return callChrome((done) => chrome.tabs.update(Number(tabId), { url: String(url || "") }, done));
}

export async function executeTabFunction(tabId, func, args = []) {
  if (!Number.isInteger(Number(tabId))) {
    throw new Error("找不到用于页面脚本执行的浏览器标签页。");
  }
  if (typeof func !== "function") {
    throw new Error("页面脚本必须是可执行函数。");
  }
  const results = await callChrome((done) => chrome.scripting.executeScript({
    target: { tabId: Number(tabId) },
    func,
    args: Array.isArray(args) ? args : [],
    world: "ISOLATED"
  }, done));
  return results?.[0]?.result;
}

export function scrollPageToBottom() {
  window.scrollTo({
    top: document.documentElement.scrollHeight,
    behavior: "smooth"
  });
  return true;
}

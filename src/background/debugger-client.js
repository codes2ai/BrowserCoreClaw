const DEBUGGER_VERSION = "1.3";

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

function debuggee(tabId) {
  return { tabId };
}

export function sendCommand(tabId, method, params = {}) {
  return callChrome((done) => {
    chrome.debugger.sendCommand(debuggee(tabId), method, params, done);
  });
}

export function attachDebugger(tabId) {
  return callChrome((done) => {
    chrome.debugger.attach(debuggee(tabId), DEBUGGER_VERSION, done);
  });
}

export async function detachDebugger(tabId) {
  try {
    await callChrome((done) => {
      chrome.debugger.detach(debuggee(tabId), done);
    });
  } catch (error) {
    if (!/not attached/i.test(error.message)) {
      throw error;
    }
  }
}

export async function evaluate(tabId, expression) {
  const result = await sendCommand(tabId, "Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });

  if (result.exceptionDetails) {
    const exception = result.exceptionDetails.exception;
    const message = exception?.description || exception?.value || result.exceptionDetails.text;
    throw new Error(`页面脚本执行失败：${message}`);
  }

  return result.result?.value;
}

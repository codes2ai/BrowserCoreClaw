import { captureGoogleNews, stopGoogleNewsCapture } from "../groups/google/google-news/background.js";
import { MESSAGE_CAPTURE_GOOGLE_NEWS, MESSAGE_STOP_GOOGLE_NEWS } from "../groups/google/google-news/constants.js";

async function enableActionToOpenSidePanel() {
  if (!chrome.sidePanel?.setPanelBehavior) {
    return;
  }

  await chrome.sidePanel.setPanelBehavior({
    openPanelOnActionClick: true
  });
}

chrome.runtime.onInstalled.addListener(() => {
  enableActionToOpenSidePanel().catch(console.error);
});

chrome.runtime.onStartup.addListener(() => {
  enableActionToOpenSidePanel().catch(console.error);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handlers = {
    [MESSAGE_CAPTURE_GOOGLE_NEWS]: captureGoogleNews,
    [MESSAGE_STOP_GOOGLE_NEWS]: stopGoogleNewsCapture
  };
  const handler = handlers[message?.type];
  if (!handler) {
    return false;
  }

  handler(message.options || {})
    .then(sendResponse)
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error.message || String(error)
      });
    });
  return true;
});

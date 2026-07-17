import { createBatchFeatureRunner } from "../../../shared/feature-runner.js";
import { formatLocalDateTime, normalizePublishedDateTime } from "../../../shared/date-normalizer.js";
import { captureGoogleNews, stopGoogleNewsCapture } from "./background.js";

function callChrome(callbackApi) {
  return new Promise((resolve, reject) => callbackApi((result) => {
    const error = chrome.runtime.lastError;
    if (error) reject(new Error(error.message));
    else resolve(result);
  }));
}

async function executeGoogleNewsItem({ input, runId, parameters }) {
  const tab = await callChrome((done) => chrome.tabs.create({
    url: "https://www.google.com/",
    active: false
  }, done));
  if (!Number.isInteger(tab?.id)) throw new Error("无法创建用于 Google 新闻采集的标签页。");
  try {
    return await captureGoogleNews({
      runId,
      tabId: tab.id,
      query: input,
      limit: parameters.limit,
      language: parameters.language
    });
  } finally {
    await callChrome((done) => chrome.tabs.remove(tab.id, done)).catch(() => {});
  }
}

export const googleNewsRunner = createBatchFeatureRunner({
  featureId: "google/google-news",
  name: "Google 新闻监控",
  storageKey: "browserCoreClawGoogleNewsV1",
  inputKey: "keywords",
  inputLabel: "关键词",
  defaultLimit: 20,
  validateInput: (value) => Boolean(String(value || "").trim()),
  normalizeExtraParameters(input) {
    return {
      language: ["zh-CN", "en-US", "ja-JP"].includes(input.language) ? input.language : "zh-CN",
      timeRange: "last_hour"
    };
  },
  executeItem: executeGoogleNewsItem,
  stopItem: ({ runId }) => stopGoogleNewsCapture({ runId }),
  toRows(data, keyword) {
    const capturedAt = data?.capturedAt || new Date().toISOString();
    const collectedAt = formatLocalDateTime(capturedAt);
    return (data?.results || []).map((result) => {
      const publishedAtRaw = result.publishedAtRaw || result.publishedAt || "";
      const publishedAtTimestamp = result.publishedAtTimestamp || "";
      const publishedAt = publishedAtTimestamp
        ? formatLocalDateTime(publishedAtTimestamp)
        : normalizePublishedDateTime(publishedAtRaw, { referenceDate: capturedAt });
      return {
        id: `${keyword}|${result.url || result.title}`,
        keyword,
        title: result.title || "",
        description: result.description || result.desc || "",
        source: result.source || "",
        time: publishedAt,
        publishedAt,
        publishedAtRaw,
        publishedAtLabel: result.publishedAtLabel || "",
        publishedAtTimestamp,
        collectedAt,
        url: result.url || "",
        capturedAt
      };
    });
  }
});

export default googleNewsRunner;

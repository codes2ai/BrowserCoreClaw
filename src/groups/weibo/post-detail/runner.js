import { createBatchFeatureRunner } from "../../../shared/feature-runner.js";
import { normalizeWeiboPublishedAt } from "../date-normalizer.js";
import { captureWeiboPostDetail, stopWeiboPostDetailCapture } from "./background.js";

function isPostUrl(value) {
  try {
    const url = new URL(value);
    return /(^|\.)weibo\.com$/i.test(url.hostname)
      && /^\/\d+\/[A-Za-z0-9]+\/?$/i.test(url.pathname);
  } catch {
    return false;
  }
}

export const weiboPostDetailRunner = createBatchFeatureRunner({
  featureId: "weibo/post-detail",
  name: "微博正文采集",
  storageKey: "browserCoreClawWeiboPostDetailV1",
  inputKey: "postUrls",
  inputLabel: "微博正文链接",
  hasLimit: false,
  supportsPolling: false,
  validateInput: isPostUrl,
  executeItem({ input, runId }) {
    return captureWeiboPostDetail({
      runId,
      tabId: null,
      isolated: true,
      postUrl: input
    });
  },
  stopItem: ({ runId }) => stopWeiboPostDetailCapture({ runId }),
  toRows(data, postUrl) {
    const detail = data?.detail || {};
    const id = String(detail.postId || detail.postUrl || postUrl || "").trim();
    if (!id) return [];
    const capturedAt = data?.capturedAt || new Date().toISOString();
    return [{
      id,
      ...detail,
      publishedAt: normalizeWeiboPublishedAt(detail.publishedAt, { referenceDate: capturedAt }),
      postUrl: detail.postUrl || postUrl,
      capturedAt
    }];
  }
});

export default weiboPostDetailRunner;

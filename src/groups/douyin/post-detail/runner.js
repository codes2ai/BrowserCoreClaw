import { createBatchFeatureRunner } from "../../../shared/feature-runner.js";
import { isDouyinPostUrl } from "../capture.js";
import { captureDouyinPostDetail, stopDouyinPostDetailCapture } from "./background.js";

export const douyinPostDetailRunner = createBatchFeatureRunner({
  featureId: "douyin/post-detail",
  name: "抖音博文采集",
  storageKey: "browserCoreClawDouyinPostDetailV1",
  inputKey: "postUrls",
  inputLabel: "抖音作品链接",
  hasLimit: false,
  supportsPolling: false,
  validateInput: isDouyinPostUrl,
  executeItem({ input, runId }) {
    return captureDouyinPostDetail({
      runId,
      tabId: null,
      isolated: true,
      postUrl: input
    });
  },
  stopItem: ({ runId }) => stopDouyinPostDetailCapture({ runId }),
  toRows(data, postUrl) {
    const detail = data?.detail || {};
    const id = String(detail.videoId || detail.postUrl || postUrl || "").trim();
    return id ? [{
      id,
      ...detail,
      postUrl: detail.postUrl || postUrl,
      capturedAt: data?.capturedAt || new Date().toISOString()
    }] : [];
  }
});

export default douyinPostDetailRunner;

import { createBatchFeatureRunner } from "../../../shared/feature-runner.js";
import { normalizeXiaohongshuPublishedDate } from "../date-normalizer.js";
import {
  mergeXiaohongshuPostDetailDataRow,
  normalizeXiaohongshuPostDetailDataRow
} from "./data-row.js";
import {
  captureXiaohongshuPostDetail,
  isXiaohongshuPostUrl,
  stopXiaohongshuPostDetailCapture
} from "./background.js";

export const xiaohongshuPostDetailRunner = createBatchFeatureRunner({
  featureId: "xiaohongshu/post-detail",
  name: "小红书正文采集",
  storageKey: "browserCoreClawXiaohongshuPostDetailV1",
  inputKey: "postUrls",
  inputLabel: "小红书正文链接",
  hasLimit: false,
  supportsPolling: false,
  mergeRow: mergeXiaohongshuPostDetailDataRow,
  validateInput: isXiaohongshuPostUrl,
  executeItem({ input, runId }) {
    return captureXiaohongshuPostDetail({
      runId,
      tabId: null,
      isolated: true,
      postUrl: input
    });
  },
  stopItem: ({ runId }) => stopXiaohongshuPostDetailCapture({ runId }),
  toRows(data, postUrl) {
    const detail = data?.detail || {};
    const id = String(detail.noteId || "").trim();
    if (!id) return [];
    const capturedAt = data?.capturedAt || new Date().toISOString();
    return [normalizeXiaohongshuPostDetailDataRow({
      id,
      ...detail,
      publishedAt: normalizeXiaohongshuPublishedDate(
        detail.publishedAt || detail.publishedAtRaw,
        { referenceDate: capturedAt }
      ),
      postUrl: detail.postUrl || postUrl,
      capturedAt
    })];
  }
});

export default xiaohongshuPostDetailRunner;

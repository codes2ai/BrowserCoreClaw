import { createBatchFeatureRunner } from "../../../shared/feature-runner.js";
import { isDouyinProfileUrl } from "../capture.js";
import { captureDouyinProfileInfo, stopDouyinProfileInfoCapture } from "./background.js";

export const douyinProfileInfoRunner = createBatchFeatureRunner({
  featureId: "douyin/profile-info",
  name: "抖音博主信息采集",
  storageKey: "browserCoreClawDouyinProfileInfoV1",
  inputKey: "profileUrls",
  inputLabel: "抖音博主主页链接",
  hasLimit: false,
  validateInput: isDouyinProfileUrl,
  executeItem({ input, runId }) {
    return captureDouyinProfileInfo({
      runId,
      tabId: null,
      isolated: true,
      profileUrl: input
    });
  },
  stopItem: ({ runId }) => stopDouyinProfileInfoCapture({ runId }),
  toRows(data, profileUrl) {
    const profile = data?.profile || {};
    const id = String(profile.profileId || profileUrl || "").trim();
    return id ? [{
      id,
      ...profile,
      profileUrl: profile.profileUrl || profileUrl,
      capturedAt: data?.capturedAt || new Date().toISOString()
    }] : [];
  }
});

export default douyinProfileInfoRunner;

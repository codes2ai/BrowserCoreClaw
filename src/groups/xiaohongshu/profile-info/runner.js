import { createBatchFeatureRunner } from "../../../shared/feature-runner.js";
import { captureXiaohongshuProfileInfo, stopXiaohongshuProfileInfoCapture } from "./background.js";

function isProfileUrl(value) {
  try {
    const url = new URL(value);
    return /(^|\.)xiaohongshu\.com$/i.test(url.hostname)
      && /^\/user\/profile\/[^/]+\/?$/i.test(url.pathname);
  } catch {
    return false;
  }
}

export const xiaohongshuProfileInfoRunner = createBatchFeatureRunner({
  featureId: "xiaohongshu/profile-info",
  name: "小红书博主信息采集",
  storageKey: "browserCoreClawXiaohongshuProfileInfoV1",
  inputKey: "profileUrls",
  inputLabel: "小红书博主主页链接",
  hasLimit: false,
  validateInput: isProfileUrl,
  executeItem({ input, runId }) {
    return captureXiaohongshuProfileInfo({
      runId,
      tabId: null,
      isolated: true,
      profileUrl: input
    });
  },
  stopItem: ({ runId }) => stopXiaohongshuProfileInfoCapture({ runId }),
  toRows(data, profileUrl) {
    const profile = data?.profile || {};
    const id = String(profile.profileId || profile.profileUrl || profileUrl || "").trim();
    return id ? [{
      id,
      ...profile,
      profileUrl: profile.profileUrl || profileUrl,
      capturedAt: data?.capturedAt || new Date().toISOString()
    }] : [];
  }
});

export default xiaohongshuProfileInfoRunner;

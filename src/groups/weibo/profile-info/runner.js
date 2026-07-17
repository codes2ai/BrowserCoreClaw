import { createBatchFeatureRunner } from "../../../shared/feature-runner.js";
import { captureWeiboProfileInfo, stopWeiboProfileInfoCapture } from "./background.js";

function isProfileUrl(value) {
  try {
    const url = new URL(value);
    return /(^|\.)weibo\.com$/i.test(url.hostname) && /^\/u\/\d+\/?$/i.test(url.pathname);
  } catch {
    return false;
  }
}

export const weiboProfileInfoRunner = createBatchFeatureRunner({
  featureId: "weibo/profile-info",
  name: "微博博主信息采集",
  storageKey: "browserCoreClawWeiboProfileInfoV1",
  inputKey: "profileUrls",
  inputLabel: "微博博主主页链接",
  hasLimit: false,
  validateInput: isProfileUrl,
  executeItem({ input, runId }) {
    return captureWeiboProfileInfo({
      runId,
      tabId: null,
      isolated: true,
      profileUrl: input
    });
  },
  stopItem: ({ runId }) => stopWeiboProfileInfoCapture({ runId }),
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

export default weiboProfileInfoRunner;

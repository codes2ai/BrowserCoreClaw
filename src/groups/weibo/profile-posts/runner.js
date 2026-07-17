import { createBatchFeatureRunner } from "../../../shared/feature-runner.js";
import { normalizeWeiboPublishedAt } from "../date-normalizer.js";
import { captureWeiboProfilePosts, stopWeiboProfilePostsCapture } from "./background.js";

function isProfileUrl(value) {
  try {
    const url = new URL(value);
    return /(^|\.)weibo\.com$/i.test(url.hostname) && /^\/u\/\d+\/?$/i.test(url.pathname);
  } catch {
    return false;
  }
}

export const weiboProfilePostsRunner = createBatchFeatureRunner({
  featureId: "weibo/profile-posts",
  name: "微博博主博文采集",
  storageKey: "browserCoreClawWeiboProfilePostsV1",
  inputKey: "profileUrls",
  inputLabel: "微博博主主页链接",
  defaultLimit: 10,
  validateInput: isProfileUrl,
  executeItem({ input, runId, parameters }) {
    return captureWeiboProfilePosts({
      runId,
      tabId: null,
      isolated: true,
      profileUrl: input,
      limit: parameters.limit
    });
  },
  stopItem: ({ runId }) => stopWeiboProfilePostsCapture({ runId }),
  toRows(data, profileUrl) {
    const capturedAt = data?.capturedAt || new Date().toISOString();
    return (data?.posts || []).map((post) => ({
      id: `${profileUrl}|${post.postId || post.url}`,
      profileUrl,
      pageOrder: post.order,
      ...post,
      publishedAt: normalizeWeiboPublishedAt(post.publishedAt, { referenceDate: capturedAt }),
      capturedAt
    }));
  }
});

export default weiboProfilePostsRunner;

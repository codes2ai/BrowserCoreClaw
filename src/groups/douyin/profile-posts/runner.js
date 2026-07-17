import { createBatchFeatureRunner } from "../../../shared/feature-runner.js";
import { isDouyinProfileUrl } from "../capture.js";
import { captureDouyinProfilePosts, stopDouyinProfilePostsCapture } from "./background.js";

export const douyinProfilePostsRunner = createBatchFeatureRunner({
  featureId: "douyin/profile-posts",
  name: "抖音博主博文采集",
  storageKey: "browserCoreClawDouyinProfilePostsV1",
  inputKey: "profileUrls",
  inputLabel: "抖音博主主页链接",
  defaultLimit: 20,
  validateInput: isDouyinProfileUrl,
  executeItem({ input, runId, parameters }) {
    return captureDouyinProfilePosts({
      runId,
      tabId: null,
      isolated: true,
      profileUrl: input,
      limit: parameters.limit
    });
  },
  stopItem: ({ runId }) => stopDouyinProfilePostsCapture({ runId }),
  toRows(data, profileUrl) {
    return (data?.posts || []).map((post) => ({
      id: `${profileUrl}|${post.videoId || post.url}`,
      profileUrl,
      pageOrder: post.order,
      ...post,
      capturedAt: data?.capturedAt || new Date().toISOString()
    }));
  }
});

export default douyinProfilePostsRunner;

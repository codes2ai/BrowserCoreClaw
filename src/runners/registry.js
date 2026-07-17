import { googleNewsRunner } from "../groups/google/google-news/runner.js";
import { weiboProfilePostsRunner } from "../groups/weibo/profile-posts/runner.js";
import { weiboProfileInfoRunner } from "../groups/weibo/profile-info/runner.js";
import { weiboPostDetailRunner } from "../groups/weibo/post-detail/runner.js";
import { douyinProfilePostsRunner } from "../groups/douyin/profile-posts/runner.js";
import { douyinProfileInfoRunner } from "../groups/douyin/profile-info/runner.js";
import { douyinPostDetailRunner } from "../groups/douyin/post-detail/runner.js";
import { xiaohongshuKeywordSearchRunner } from "../groups/xiaohongshu/keyword-search/runner.js";
import { xiaohongshuProfileNotesRunner } from "../groups/xiaohongshu/profile-notes/runner.js";
import { xiaohongshuProfileInfoRunner } from "../groups/xiaohongshu/profile-info/runner.js";
import { xiaohongshuPostDetailRunner } from "../groups/xiaohongshu/post-detail/runner.js";

const RUNNERS = [
  googleNewsRunner,
  weiboProfilePostsRunner,
  weiboProfileInfoRunner,
  weiboPostDetailRunner,
  douyinProfilePostsRunner,
  douyinProfileInfoRunner,
  douyinPostDetailRunner,
  xiaohongshuKeywordSearchRunner,
  xiaohongshuProfileNotesRunner,
  xiaohongshuProfileInfoRunner,
  xiaohongshuPostDetailRunner
];

const runnerRegistry = new Map();
for (const runner of RUNNERS) {
  if (runnerRegistry.has(runner.featureId)) {
    throw new Error(`Runner 功能标识重复：${runner.featureId}`);
  }
  runnerRegistry.set(runner.featureId, runner);
}

export function getFeatureRunner(featureId) {
  return runnerRegistry.get(String(featureId || "").trim()) || null;
}

export function listFeatureRunners() {
  return [...runnerRegistry.values()].map((runner) => ({
    featureId: runner.featureId,
    name: runner.name,
    inputKey: runner.inputKey,
    supportsPolling: runner.supportsPolling
  }));
}

export function validateFeatureRunnerRegistry(expectedFeatureIds = []) {
  const expected = new Set(expectedFeatureIds);
  const actual = new Set(runnerRegistry.keys());
  return {
    valid: expected.size === actual.size
      && [...expected].every((featureId) => actual.has(featureId)),
    missing: [...expected].filter((featureId) => !actual.has(featureId)),
    unexpected: [...actual].filter((featureId) => !expected.has(featureId))
  };
}

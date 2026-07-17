import {
  DEFAULT_TASK_CONCURRENCY,
  MAX_TASK_CONCURRENCY,
  normalizeTaskConcurrency
} from "./concurrent-task-pool.js";
import {
  DEFAULT_EXECUTION_INTERVAL_MAX_MS,
  DEFAULT_EXECUTION_INTERVAL_MIN_MS
} from "./execution-interval.js";

const field = (key, label) => Object.freeze({ key, label });

const RUNNER_CAPABILITY_SCHEMAS = Object.freeze({
  "google/google-news": Object.freeze({
    inputKey: "keywords",
    inputLabel: "关键词",
    hasLimit: true,
    defaultLimit: 20,
    outputFields: Object.freeze([
      field("keyword", "关键词"), field("title", "新闻标题"), field("description", "描述"),
      field("source", "来源"), field("publishedAt", "发布时间"), field("collectedAt", "采集时间"),
      field("url", "链接")
    ])
  }),
  "weibo/profile-posts": Object.freeze({
    inputKey: "profileUrls",
    inputLabel: "微博主页链接",
    hasLimit: true,
    defaultLimit: 10,
    outputFields: Object.freeze([
      field("profileUrl", "博主主页"), field("pageOrder", "页面顺序"), field("postId", "博文 ID"),
      field("author", "作者"), field("text", "正文"),
      field("publishedAt", "发布时间"), field("source", "来源"), field("reposts", "转发数"),
      field("comments", "评论数"), field("likes", "点赞数"), field("mediaUrls", "媒体链接"),
      field("url", "博文链接"), field("capturedAt", "采集时间")
    ])
  }),
  "weibo/profile-info": Object.freeze({
    inputKey: "profileUrls",
    inputLabel: "微博主页链接",
    hasLimit: false,
    defaultLimit: 0,
    outputFields: Object.freeze([
      field("cover", "封面"), field("avatar", "头像"), field("nickname", "昵称"),
      field("profileId", "微博 ID"),
      field("gender", "性别"), field("membershipBadges", "会员标识"), field("bio", "简介"),
      field("profileDescription", "主页描述"), field("following", "关注数"), field("followers", "粉丝数"),
      field("engagement", "互动数"), field("yesterdayPosts", "昨日发博"), field("yesterdayReads", "昨日阅读"),
      field("yesterdayInteractions", "昨日互动"), field("videoTotalViews", "视频播放"),
      field("influenceRanks", "影响力排名"), field("serviceUnit", "服务单位"),
      field("newsServiceLicense", "新闻许可"), field("serviceCategory", "服务类别"),
      field("friendCount", "好友数"), field("profileDetailLines", "主页详情"),
      field("profileCardText", "资料卡文本"), field("profileUrl", "主页链接"),
      field("capturedAt", "采集时间")
    ])
  }),
  "weibo/post-detail": Object.freeze({
    inputKey: "postUrls",
    inputLabel: "微博正文链接",
    hasLimit: false,
    defaultLimit: 0,
    outputFields: Object.freeze([
      field("postId", "博文 ID"), field("visibility", "可见范围"), field("author", "作者"),
      field("authorUrl", "作者主页"), field("authorAvatar", "作者头像"), field("text", "正文"),
      field("publishedAt", "发布时间"), field("source", "来源"), field("reposts", "转发数"),
      field("comments", "评论数"), field("likes", "点赞数"), field("topics", "话题"),
      field("mentions", "提及用户"), field("contentLinks", "正文链接"), field("mediaUrls", "媒体链接"),
      field("postUrl", "博文链接"), field("capturedAt", "采集时间")
    ])
  }),
  "douyin/profile-posts": Object.freeze({
    inputKey: "profileUrls",
    inputLabel: "抖音主页链接",
    hasLimit: true,
    defaultLimit: 20,
    outputFields: Object.freeze([
      field("profileUrl", "主页链接"), field("pageOrder", "页面顺序"), field("videoId", "作品 ID"),
      field("text", "作品描述"), field("likes", "点赞数"), field("cover", "封面"),
      field("url", "作品链接"), field("capturedAt", "采集时间")
    ])
  }),
  "douyin/profile-info": Object.freeze({
    inputKey: "profileUrls",
    inputLabel: "抖音主页链接",
    hasLimit: false,
    defaultLimit: 0,
    outputFields: Object.freeze([
      field("avatar", "头像"), field("nickname", "昵称"), field("profileId", "主页 ID"),
      field("douyinId", "抖音号"), field("following", "关注数"), field("followers", "粉丝数"),
      field("likes", "获赞数"), field("ipLocation", "IP 属地"), field("age", "年龄"),
      field("location", "所在地"), field("bio", "简介"), field("profileTags", "主页标签"),
      field("profileRawText", "主页原文"), field("profileUrl", "主页链接"), field("capturedAt", "采集时间")
    ])
  }),
  "douyin/post-detail": Object.freeze({
    inputKey: "postUrls",
    inputLabel: "抖音作品链接",
    hasLimit: false,
    defaultLimit: 0,
    outputFields: Object.freeze([
      field("videoId", "作品 ID"), field("author", "作者"), field("authorUrl", "作者主页"),
      field("authorAvatar", "作者头像"), field("text", "作品描述"), field("publishedAt", "发布时间"),
      field("likes", "点赞数"), field("comments", "评论数"), field("favorites", "收藏数"),
      field("shares", "分享数"), field("topics", "话题"), field("contentLinks", "正文链接"),
      field("cover", "封面"), field("mediaUrls", "媒体链接"), field("detailRawText", "详情原文"),
      field("postUrl", "作品链接"), field("capturedAt", "采集时间")
    ])
  }),
  "xiaohongshu/keyword-search": Object.freeze({
    inputKey: "keywords",
    inputLabel: "关键词",
    hasLimit: true,
    defaultLimit: 20,
    outputFields: Object.freeze([
      field("pageOrder", "页面顺序"), field("cover", "封面"), field("keyword", "关键词"),
      field("title", "笔记标题"), field("description", "笔记内容"), field("author", "作者"),
      field("publishedAt", "发布时间"), field("likes", "点赞数"), field("url", "笔记链接"),
      field("capturedAt", "采集时间")
    ])
  }),
  "xiaohongshu/profile-notes": Object.freeze({
    inputKey: "profileUrls",
    inputLabel: "小红书主页链接",
    hasLimit: true,
    defaultLimit: 20,
    outputFields: Object.freeze([
      field("pageOrder", "页面顺序"), field("noteId", "笔记 ID"), field("noteTitle", "笔记标题"),
      field("noteAuthor", "作者"), field("noteLikes", "点赞数"), field("noteCover", "封面"),
      field("noteUrl", "笔记链接"), field("profileUrl", "主页链接"), field("capturedAt", "采集时间")
    ])
  }),
  "xiaohongshu/profile-info": Object.freeze({
    inputKey: "profileUrls",
    inputLabel: "小红书主页链接",
    hasLimit: false,
    defaultLimit: 0,
    outputFields: Object.freeze([
      field("avatar", "头像"), field("nickname", "昵称"), field("profileId", "主页 ID"),
      field("xiaohongshuId", "小红书号"), field("ipLocation", "IP 属地"), field("bio", "简介"),
      field("tags", "标签"), field("following", "关注数"), field("followers", "粉丝数"),
      field("likedAndCollected", "获赞与收藏"), field("profileUrl", "主页链接"),
      field("capturedAt", "采集时间")
    ])
  }),
  "xiaohongshu/post-detail": Object.freeze({
    inputKey: "postUrls",
    inputLabel: "小红书正文链接",
    hasLimit: false,
    defaultLimit: 0,
    outputFields: Object.freeze([
      field("noteId", "笔记 ID"), field("noteType", "笔记类型"), field("title", "标题"),
      field("description", "正文"), field("author", "作者"), field("authorId", "作者 ID"),
      field("authorUrl", "作者主页"), field("authorAvatar", "作者头像"), field("publishedAt", "发布时间"),
      field("ipLocation", "IP 属地"), field("likes", "点赞数"), field("favorites", "收藏数"),
      field("comments", "评论数"), field("shares", "分享数"), field("topics", "话题"),
      field("cover", "封面"), field("imageUrls", "图片链接"), field("videoUrls", "视频链接"),
      field("postUrl", "笔记链接"), field("capturedAt", "采集时间")
    ])
  })
});

function asInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

export function getRunnerCapabilitySchema(featureId) {
  return RUNNER_CAPABILITY_SCHEMAS[String(featureId || "").trim()] || Object.freeze({
    inputKey: "inputs",
    inputLabel: "输入项",
    hasLimit: true,
    defaultLimit: 20,
    outputFields: Object.freeze([])
  });
}

export function getDefaultRunnerBindingConfiguration(targetFeatureId) {
  const schema = getRunnerCapabilitySchema(targetFeatureId);
  return {
    outputFields: schema.outputFields.map((item) => item.key),
    parameters: {
      ...(schema.hasLimit ? { limit: schema.defaultLimit } : {}),
      concurrency: DEFAULT_TASK_CONCURRENCY,
      intervalMinMs: DEFAULT_EXECUTION_INTERVAL_MIN_MS,
      intervalMaxMs: DEFAULT_EXECUTION_INTERVAL_MAX_MS,
      forceUpdateData: false
    }
  };
}

export function normalizeRunnerBindingConfiguration(targetFeatureId, value = {}) {
  const schema = getRunnerCapabilitySchema(targetFeatureId);
  const defaults = getDefaultRunnerBindingConfiguration(targetFeatureId);
  const rawFields = Array.isArray(value?.outputFields) ? value.outputFields : defaults.outputFields;
  const allowedFields = new Set(schema.outputFields.map((item) => item.key));
  const outputFields = [...new Set(rawFields
    .map((item) => String(item || "").trim())
    .filter((item) => allowedFields.has(item)))];
  const firstInterval = asInteger(
    value?.parameters?.intervalMinMs,
    defaults.parameters.intervalMinMs,
    100,
    6000
  );
  const secondInterval = asInteger(
    value?.parameters?.intervalMaxMs,
    defaults.parameters.intervalMaxMs,
    100,
    6000
  );

  return {
    outputFields: outputFields.length || !defaults.outputFields.length ? outputFields : defaults.outputFields,
    parameters: {
      ...(schema.hasLimit ? {
        limit: asInteger(value?.parameters?.limit, schema.defaultLimit, 1, 100)
      } : {}),
      concurrency: normalizeTaskConcurrency(value?.parameters?.concurrency ?? DEFAULT_TASK_CONCURRENCY),
      intervalMinMs: Math.min(firstInterval, secondInterval),
      intervalMaxMs: Math.max(firstInterval, secondInterval),
      forceUpdateData: value?.parameters?.forceUpdateData === true
    }
  };
}

export const RUNNER_BINDING_PARAMETER_LIMITS = Object.freeze({
  limit: Object.freeze({ min: 1, max: 100 }),
  concurrency: Object.freeze({ min: 1, max: MAX_TASK_CONCURRENCY }),
  interval: Object.freeze({ min: 100, max: 6000 })
});

export const CANONICAL_DATA_SCHEMA_VERSION = 1;

const CONTENT_FEATURES = Object.freeze({
  "google/google-news": { platform: "google", contentType: "news", entryType: "keyword-search" },
  "xiaohongshu/keyword-search": { platform: "xiaohongshu", contentType: "note", entryType: "keyword-search" },
  "xiaohongshu/profile-notes": { platform: "xiaohongshu", contentType: "note", entryType: "profile-list" },
  "xiaohongshu/post-detail": { platform: "xiaohongshu", contentType: "note", entryType: "post-detail" },
  "weibo/profile-posts": { platform: "weibo", contentType: "post", entryType: "profile-list" },
  "weibo/post-detail": { platform: "weibo", contentType: "post", entryType: "post-detail" },
  "douyin/profile-posts": { platform: "douyin", contentType: "video", entryType: "profile-list" },
  "douyin/post-detail": { platform: "douyin", contentType: "video", entryType: "post-detail" }
});

const PROFILE_FEATURES = Object.freeze({
  "xiaohongshu/profile-info": { platform: "xiaohongshu", entryType: "profile-info" },
  "weibo/profile-info": { platform: "weibo", entryType: "profile-info" },
  "douyin/profile-info": { platform: "douyin", entryType: "profile-info" }
});

function text(value) {
  return String(value ?? "").trim();
}

function firstText(...values) {
  return values.map(text).find(Boolean) || "";
}

function splitValues(value) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean);
  return text(value).split(/\s*\|\s*/).map(text).filter(Boolean);
}

function parseMetric(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const source = text(value).replaceAll(",", "");
  if (!source) return null;
  const match = source.match(/(\d+(?:\.\d+)?)\s*(万|亿|w|W)?/);
  if (!match) return null;
  const number = Number(match[1]);
  if (!Number.isFinite(number)) return null;
  const unit = match[2];
  if (unit === "亿") return Math.round(number * 100000000);
  if (unit === "万" || unit === "w" || unit === "W") return Math.round(number * 10000);
  return number;
}

function compactText(value, maximum = 120) {
  const source = text(value);
  return source.length > maximum ? `${source.slice(0, maximum)}…` : source;
}

function urlId(value) {
  const source = text(value);
  if (!source) return "";
  try {
    const url = new URL(source);
    const parts = url.pathname.split("/").filter(Boolean);
    return parts.at(-1) || url.href;
  } catch {
    return source;
  }
}

function media(type, values) {
  return splitValues(values).map((url) => ({ type, url }));
}

function distinctMedia(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.type}:${item.url}`;
    if (!item.url || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function rawPageText(row) {
  return firstText(
    row?.rawPageText,
    row?.pageRawText,
    row?.detailRawText,
    row?.profileRawText,
    row?.profileCardText,
    row?.description,
    row?.noteContent,
    row?.text
  );
}

function rawFields(row) {
  const fields = { ...(row && typeof row === "object" ? row : {}) };
  delete fields.canonical;
  delete fields.id;
  delete fields.rawPageText;
  delete fields.pageRawText;
  delete fields.detailRawText;
  delete fields.profileRawText;
  delete fields.profileCardText;
  return fields;
}

function cloneRunnerOutputs(row) {
  const outputs = row?.canonical?.platformExtra?.runnerOutputs;
  if (!outputs || typeof outputs !== "object" || Array.isArray(outputs)) return null;
  try {
    return typeof structuredClone === "function"
      ? structuredClone(outputs)
      : JSON.parse(JSON.stringify(outputs));
  } catch {
    return { ...outputs };
  }
}

function sourceContext(feature, row) {
  return {
    entryType: feature.entryType,
    query: firstText(row.keyword),
    sourceProfileUrl: firstText(row.profileUrl),
    pageOrder: Number(row.pageOrder || row.order) || null
  };
}

function contentCommon(featureId, feature, row, details = {}) {
  const canonicalUrl = firstText(row.url, row.postUrl, row.noteUrl);
  const platformEntityId = firstText(
    row.noteId,
    row.postId,
    row.videoId,
    details.platformEntityId,
    urlId(canonicalUrl),
    row.id
  );
  const title = firstText(details.title, row.title, row.noteTitle, compactText(row.text));
  const body = firstText(details.text, row.description, row.noteContent, row.text);
  const collectedAt = firstText(row.collectedAt, row.capturedAt);
  return {
    schemaVersion: CANONICAL_DATA_SCHEMA_VERSION,
    id: `${feature.platform}:content:${platformEntityId || canonicalUrl || row.id || "unknown"}`,
    entityType: "content",
    platform: feature.platform,
    featureId,
    contentType: feature.contentType,
    platformEntityId,
    canonicalUrl,
    title,
    text: body,
    summary: firstText(details.summary, row.description, row.desc),
    author: {
      id: firstText(row.authorId),
      name: firstText(row.author, row.noteAuthor),
      url: firstText(row.authorUrl),
      avatarUrl: firstText(row.authorAvatar)
    },
    publishedAt: firstText(row.publishedAt),
    collectedAt,
    media: [],
    topics: splitValues(row.topics),
    mentions: splitValues(row.mentions),
    metrics: {},
    sourceContext: sourceContext(feature, row),
    platformExtra: {
      rawPageText: rawPageText(row),
      rawFields: rawFields(row)
    }
  };
}

function profileCommon(featureId, feature, row) {
  const profileUrl = firstText(row.profileUrl, row.url);
  const platformEntityId = firstText(row.profileId, row.xiaohongshuId, row.douyinId, urlId(profileUrl), row.id);
  return {
    schemaVersion: CANONICAL_DATA_SCHEMA_VERSION,
    id: `${feature.platform}:profile:${platformEntityId || profileUrl || "unknown"}`,
    entityType: "profile",
    platform: feature.platform,
    featureId,
    contentType: "",
    platformEntityId,
    canonicalUrl: profileUrl,
    title: firstText(row.nickname, row.profileId, profileUrl),
    text: firstText(row.bio, row.profileDescription),
    summary: firstText(row.bio, row.profileDescription),
    author: null,
    profile: {
      id: platformEntityId,
      url: profileUrl,
      avatarUrl: firstText(row.avatar),
      coverUrl: firstText(row.cover),
      displayName: firstText(row.nickname),
      handle: firstText(row.xiaohongshuId, row.douyinId),
      bio: firstText(row.bio, row.profileDescription),
      location: firstText(row.ipLocation, row.location),
      tags: splitValues(row.tags || row.profileTags || row.membershipBadges)
    },
    publishedAt: "",
    collectedAt: firstText(row.collectedAt, row.capturedAt),
    media: distinctMedia([...
      media("avatar", row.avatar),
      media("cover", row.cover)
    ]),
    topics: [],
    mentions: [],
    metrics: {
      followingCount: parseMetric(row.following),
      followerCount: parseMetric(row.followers),
      likedReceivedCount: parseMetric(row.likedAndCollected || row.likes),
      engagementCount: parseMetric(row.engagement),
      yesterdayPostCount: parseMetric(row.yesterdayPosts),
      yesterdayReadCount: parseMetric(row.yesterdayReads),
      yesterdayInteractionCount: parseMetric(row.yesterdayInteractions),
      videoViewCount: parseMetric(row.videoTotalViews),
      friendCount: parseMetric(row.friendCount)
    },
    sourceContext: sourceContext(feature, row),
    platformExtra: {
      rawPageText: rawPageText(row),
      rawFields: rawFields(row)
    }
  };
}

function contentRecord(featureId, feature, row) {
  const record = contentCommon(featureId, feature, row);
  if (featureId === "google/google-news") {
    record.metrics = {};
    record.platformExtra.source = firstText(row.source);
    record.platformExtra.publishedAtRaw = firstText(row.publishedAtRaw);
    record.platformExtra.publishedAtLabel = firstText(row.publishedAtLabel);
    record.platformExtra.publishedAtTimestamp = firstText(row.publishedAtTimestamp);
    return record;
  }

  if (feature.platform === "xiaohongshu") {
    record.media = distinctMedia([
      ...media("cover", row.cover || row.noteCover),
      ...media("image", row.imageUrls),
      ...media("video", row.videoUrls)
    ]);
    record.metrics = {
      likeCount: parseMetric(row.likes ?? row.noteLikes),
      commentCount: parseMetric(row.comments),
      favoriteCount: parseMetric(row.favorites),
      shareCount: parseMetric(row.shares)
    };
    record.platformExtra.noteType = firstText(row.noteType);
    record.platformExtra.ipLocation = firstText(row.ipLocation);
    record.platformExtra.publishedAtRaw = firstText(row.publishedAtRaw);
    record.platformExtra.capturedInteractionFields = Array.isArray(row.capturedInteractionFields)
      ? [...row.capturedInteractionFields]
      : [];
    return record;
  }

  if (feature.platform === "weibo") {
    record.media = distinctMedia(media("media", row.mediaUrls));
    record.metrics = {
      likeCount: parseMetric(row.likes),
      commentCount: parseMetric(row.comments),
      repostCount: parseMetric(row.reposts)
    };
    record.platformExtra.source = firstText(row.source);
    record.platformExtra.visibility = firstText(row.visibility);
    record.platformExtra.contentLinks = splitValues(row.contentLinks);
    return record;
  }

  record.media = distinctMedia([
    ...media("cover", row.cover),
    ...media("media", row.mediaUrls)
  ]);
  record.metrics = {
    likeCount: parseMetric(row.likes),
    commentCount: parseMetric(row.comments),
    favoriteCount: parseMetric(row.favorites),
    shareCount: parseMetric(row.shares)
  };
  record.platformExtra.contentLinks = splitValues(row.contentLinks);
  record.platformExtra.publishedAtRaw = firstText(row.publishedAtRaw);
  return record;
}

export function buildCanonicalRecord(featureId, row = {}) {
  const normalizedFeatureId = text(featureId);
  const source = row && typeof row === "object" ? row : {};
  const contentFeature = CONTENT_FEATURES[normalizedFeatureId];
  if (contentFeature) return contentRecord(normalizedFeatureId, contentFeature, source);

  const profileFeature = PROFILE_FEATURES[normalizedFeatureId];
  if (profileFeature) return profileCommon(normalizedFeatureId, profileFeature, source);

  const [platform = "unknown"] = normalizedFeatureId.split("/");
  return {
    schemaVersion: CANONICAL_DATA_SCHEMA_VERSION,
    id: `${platform}:unknown:${text(source.id) || "unknown"}`,
    entityType: "unknown",
    platform,
    featureId: normalizedFeatureId,
    contentType: "",
    platformEntityId: text(source.id),
    canonicalUrl: firstText(source.url, source.postUrl, source.profileUrl),
    title: firstText(source.title, source.nickname),
    text: firstText(source.description, source.text),
    summary: "",
    author: null,
    publishedAt: firstText(source.publishedAt),
    collectedAt: firstText(source.collectedAt, source.capturedAt),
    media: [],
    topics: [],
    mentions: [],
    metrics: {},
    sourceContext: { entryType: "unknown", query: "", sourceProfileUrl: "", pageOrder: null },
    platformExtra: { rawPageText: rawPageText(source), rawFields: rawFields(source) }
  };
}

export function withCanonicalRecord(featureId, row = {}) {
  const source = row && typeof row === "object" ? row : {};
  const canonical = buildCanonicalRecord(featureId, source);
  const runnerOutputs = cloneRunnerOutputs(source);
  if (runnerOutputs) canonical.platformExtra.runnerOutputs = runnerOutputs;
  // 页面全文只在统一扩展字段中保存一次，避免列表采集时重复占用本地存储。
  const { rawPageText: _rawPageText, ...storedRow } = source;
  return { ...storedRow, canonical };
}

export function getCanonicalRecord(featureId, row = {}) {
  const existing = row?.canonical;
  if (existing && typeof existing === "object" && text(existing.entityType)) return existing;
  return buildCanonicalRecord(featureId, row);
}

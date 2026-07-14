import { downloadDouyinRows } from "../export-utils.js";

const columns = ["postUrl", "videoId", "author", "authorUrl", "authorAvatar", "text", "publishedAt", "likes", "comments", "favorites", "shares", "topics", "contentLinks", "cover", "mediaUrls", "detailRawText", "collectedAt"];

export function buildDouyinPostDetailExportRows(dataRows) {
  return (Array.isArray(dataRows) ? dataRows : []).map((row) => ({
    postUrl: row.postUrl || "",
    videoId: row.videoId || "",
    author: row.author || "",
    authorUrl: row.authorUrl || "",
    authorAvatar: row.authorAvatar || "",
    text: row.text || "",
    publishedAt: row.publishedAt || "",
    likes: row.likes || "",
    comments: row.comments || "",
    favorites: row.favorites || "",
    shares: row.shares || "",
    topics: row.topics || "",
    contentLinks: row.contentLinks || "",
    cover: row.cover || "",
    mediaUrls: row.mediaUrls || "",
    detailRawText: row.detailRawText || "",
    collectedAt: row.capturedAt || ""
  }));
}

export function downloadDouyinPostDetailData(dataRows, format) {
  return downloadDouyinRows(buildDouyinPostDetailExportRows(dataRows), { filenamePrefix: "douyin-post-detail", columns }, format);
}

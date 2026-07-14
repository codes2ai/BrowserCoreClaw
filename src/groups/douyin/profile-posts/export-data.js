import { downloadDouyinRows } from "../export-utils.js";

const columns = ["profileUrl", "videoId", "order", "text", "likes", "cover", "postUrl", "collectedAt"];

export function buildDouyinProfilePostsExportRows(dataRows) {
  return (Array.isArray(dataRows) ? dataRows : []).map((row) => ({
    profileUrl: row.profileUrl || "",
    videoId: row.videoId || "",
    order: row.pageOrder || "",
    text: row.text || "",
    likes: row.likes || "",
    cover: row.cover || "",
    postUrl: row.url || "",
    collectedAt: row.capturedAt || ""
  }));
}

export function downloadDouyinProfilePostsData(dataRows, format) {
  return downloadDouyinRows(buildDouyinProfilePostsExportRows(dataRows), { filenamePrefix: "douyin-profile-posts", columns }, format);
}

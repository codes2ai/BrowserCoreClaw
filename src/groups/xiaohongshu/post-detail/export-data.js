import { normalizeXiaohongshuPublishedDate } from "../date-normalizer.js";
import { normalizeXiaohongshuLikes } from "../likes-normalizer.js";

export function buildXiaohongshuPostDetailExportRows(dataRows) {
  return (Array.isArray(dataRows) ? dataRows : []).map((row) => ({
    postUrl: row.postUrl || "",
    noteId: row.noteId || "",
    noteType: row.noteType || "",
    title: row.title || "",
    description: row.description || "",
    author: row.author || "",
    authorId: row.authorId || "",
    authorUrl: row.authorUrl || "",
    authorAvatar: row.authorAvatar || "",
    publishedAt: normalizeXiaohongshuPublishedDate(row.publishedAt || row.publishedAtRaw, {
      referenceDate: row.capturedAt
    }),
    ipLocation: row.ipLocation || "",
    likes: normalizeXiaohongshuLikes(row.likes),
    favorites: row.favorites || "0",
    comments: row.comments || "0",
    shares: row.shares || "0",
    topics: row.topics || "",
    cover: row.cover || "",
    imageUrls: row.imageUrls || "",
    videoUrls: row.videoUrls || "",
    collectedAt: row.capturedAt || ""
  }));
}

function csvCell(value) {
  let text = String(value ?? "");
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function timestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function download(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function downloadXiaohongshuPostDetailData(dataRows, format) {
  const rows = buildXiaohongshuPostDetailExportRows(dataRows);
  if (format === "json") {
    return download(`xiaohongshu-post-detail-${timestamp()}.json`, JSON.stringify(rows, null, 2), "application/json;charset=utf-8");
  }
  if (format === "csv") {
    const columns = [
      "postUrl", "noteId", "noteType", "title", "description", "author", "authorId", "authorUrl",
      "authorAvatar", "publishedAt", "ipLocation", "likes", "favorites", "comments", "shares", "topics",
      "cover", "imageUrls", "videoUrls", "collectedAt"
    ];
    const content = [columns.map(csvCell).join(","), ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(","))].join("\r\n");
    return download(`xiaohongshu-post-detail-${timestamp()}.csv`, `\uFEFF${content}`, "text/csv;charset=utf-8");
  }
  throw new Error(`不支持的导出格式：${format}`);
}

export function buildWeiboPostDetailExportRows(dataRows) {
  return (Array.isArray(dataRows) ? dataRows : []).map((row) => ({
    postUrl: row.postUrl || "",
    postId: row.postId || "",
    visibility: row.visibility || "",
    author: row.author || "",
    authorUrl: row.authorUrl || "",
    authorAvatar: row.authorAvatar || "",
    text: row.text || "",
    publishedAt: row.publishedAt || "",
    source: row.source || "",
    reposts: row.reposts || "",
    comments: row.comments || "",
    likes: row.likes || "",
    topics: row.topics || "",
    mentions: row.mentions || "",
    contentLinks: row.contentLinks || "",
    mediaUrls: row.mediaUrls || "",
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
  anchor.href = url; anchor.download = filename; document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function downloadWeiboPostDetailData(dataRows, format) {
  const rows = buildWeiboPostDetailExportRows(dataRows);
  if (format === "json") return download(`weibo-post-detail-${timestamp()}.json`, JSON.stringify(rows, null, 2), "application/json;charset=utf-8");
  if (format === "csv") {
    const columns = ["postUrl", "postId", "visibility", "author", "authorUrl", "authorAvatar", "text", "publishedAt", "source", "reposts", "comments", "likes", "topics", "mentions", "contentLinks", "mediaUrls", "collectedAt"];
    return download(`weibo-post-detail-${timestamp()}.csv`, `\uFEFF${[columns.map(csvCell).join(","), ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(","))].join("\r\n")}`, "text/csv;charset=utf-8");
  }
  throw new Error(`不支持的导出格式：${format}`);
}

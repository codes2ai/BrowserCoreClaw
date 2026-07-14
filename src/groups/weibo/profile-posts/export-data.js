export function buildWeiboProfilePostsExportRows(dataRows) {
  return (Array.isArray(dataRows) ? dataRows : []).map((row) => ({
    profileUrl: row.profileUrl || "",
    postId: row.postId || "",
    order: row.pageOrder || "",
    author: row.author || "",
    text: row.text || "",
    publishedAt: row.publishedAt || "",
    source: row.source || "",
    reposts: row.reposts || "",
    comments: row.comments || "",
    likes: row.likes || "",
    mediaUrls: row.mediaUrls || "",
    postUrl: row.url || "",
    collectedAt: row.capturedAt || ""
  }));
}

function csvCell(value) {
  let text = String(value ?? "");
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function download(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = filename; document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function timestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function downloadWeiboProfilePostsData(dataRows, format) {
  const rows = buildWeiboProfilePostsExportRows(dataRows);
  if (format === "json") return download(`weibo-profile-posts-${timestamp()}.json`, JSON.stringify(rows, null, 2), "application/json;charset=utf-8");
  if (format === "csv") {
    const columns = ["profileUrl", "postId", "order", "author", "text", "publishedAt", "source", "reposts", "comments", "likes", "mediaUrls", "postUrl", "collectedAt"];
    return download(`weibo-profile-posts-${timestamp()}.csv`, `\uFEFF${[columns.map(csvCell).join(","), ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(","))].join("\r\n")}`, "text/csv;charset=utf-8");
  }
  throw new Error(`不支持的导出格式：${format}`);
}

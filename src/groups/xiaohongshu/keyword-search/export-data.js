export function buildXiaohongshuKeywordExportRows(dataRows) {
  return dataRows.map((row) => ({
    pageOrder: row.pageOrder || "",
    cover: row.cover || "",
    keyword: row.keyword || "",
    noteTitle: row.title || row.noteTitle || "",
    noteContent: row.description || row.noteContent || row.desc || "",
    author: row.author || row.source || "",
    likes: row.likes || "",
    publishedAt: row.publishedAt || row.time || "",
    url: row.url || "",
    collectedAt: row.capturedAt || ""
  }));
}

function csvCell(value) {
  let text = String(value ?? "");
  if (/^[=+\-@]/.test(text)) {
    text = `'${text}`;
  }
  return `"${text.replaceAll('"', '""')}"`;
}

export function serializeXiaohongshuKeywordJson(dataRows) {
  return JSON.stringify(buildXiaohongshuKeywordExportRows(dataRows), null, 2);
}

export function serializeXiaohongshuKeywordCsv(dataRows) {
  const columns = ["pageOrder", "cover", "keyword", "noteTitle", "noteContent", "author", "likes", "publishedAt", "url", "collectedAt"];
  const rows = buildXiaohongshuKeywordExportRows(dataRows);
  const content = [
    columns.map(csvCell).join(","),
    ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(","))
  ].join("\r\n");
  return `\uFEFF${content}`;
}

function exportTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function downloadFile(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function downloadXiaohongshuKeywordData(dataRows, format) {
  const timestamp = exportTimestamp();
  if (format === "json") {
    downloadFile(
      `xiaohongshu-keyword-data-${timestamp}.json`,
      serializeXiaohongshuKeywordJson(dataRows),
      "application/json;charset=utf-8"
    );
    return;
  }
  if (format === "csv") {
    downloadFile(
      `xiaohongshu-keyword-data-${timestamp}.csv`,
      serializeXiaohongshuKeywordCsv(dataRows),
      "text/csv;charset=utf-8"
    );
    return;
  }
  throw new Error(`不支持的导出格式：${format}`);
}

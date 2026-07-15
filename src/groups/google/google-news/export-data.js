export function buildGoogleNewsExportRows(dataRows) {
  return dataRows.map((row) => ({
    keyword: row.keyword || "",
    title: row.title || "",
    description: row.description || row.desc || "",
    source: row.source || "",
    publishedAt: row.publishedAt || "",
    url: row.url || "",
    collectedAt: row.collectedAt || ""
  }));
}

function csvCell(value) {
  let text = String(value ?? "");
  if (/^[=+\-@]/.test(text)) {
    text = `'${text}`;
  }
  return `"${text.replaceAll('"', '""')}"`;
}

export function serializeGoogleNewsJson(dataRows) {
  return JSON.stringify(buildGoogleNewsExportRows(dataRows), null, 2);
}

export function serializeGoogleNewsCsv(dataRows) {
  const columns = ["keyword", "title", "description", "source", "publishedAt", "url", "collectedAt"];
  const rows = buildGoogleNewsExportRows(dataRows);
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

export function downloadGoogleNewsData(dataRows, format) {
  const timestamp = exportTimestamp();
  if (format === "json") {
    downloadFile(
      `google-news-data-${timestamp}.json`,
      serializeGoogleNewsJson(dataRows),
      "application/json;charset=utf-8"
    );
    return;
  }
  if (format === "csv") {
    downloadFile(
      `google-news-data-${timestamp}.csv`,
      serializeGoogleNewsCsv(dataRows),
      "text/csv;charset=utf-8"
    );
    return;
  }
  throw new Error(`不支持的导出格式：${format}`);
}

export function buildXiaohongshuProfileExportRows(dataRows) {
  return (Array.isArray(dataRows) ? dataRows : []).map((row) => ({
    pageOrder: row.pageOrder || "",
    noteId: row.noteId || "",
    noteTitle: row.noteTitle || "",
    noteAuthor: row.noteAuthor || "",
    noteLikes: row.noteLikes || "",
    noteCover: row.noteCover || "",
    noteUrl: row.noteUrl || "",
    collectedAt: row.capturedAt || ""
  }));
}

function csvCell(value) {
  let text = String(value ?? "");
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function serializeXiaohongshuProfileJson(dataRows) {
  return JSON.stringify(buildXiaohongshuProfileExportRows(dataRows), null, 2);
}

export function serializeXiaohongshuProfileCsv(dataRows) {
  const columns = [
    "pageOrder", "noteId", "noteTitle", "noteAuthor", "noteLikes", "noteCover", "noteUrl", "collectedAt"
  ];
  const rows = buildXiaohongshuProfileExportRows(dataRows);
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

export function downloadXiaohongshuProfileData(dataRows, format) {
  const timestamp = exportTimestamp();
  if (format === "json") {
    downloadFile(
      `xiaohongshu-profile-data-${timestamp}.json`,
      serializeXiaohongshuProfileJson(dataRows),
      "application/json;charset=utf-8"
    );
    return;
  }
  if (format === "csv") {
    downloadFile(
      `xiaohongshu-profile-data-${timestamp}.csv`,
      serializeXiaohongshuProfileCsv(dataRows),
      "text/csv;charset=utf-8"
    );
    return;
  }
  throw new Error(`不支持的导出格式：${format}`);
}

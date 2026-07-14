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

export function downloadDouyinRows(dataRows, { filenamePrefix, columns }, format) {
  const rows = Array.isArray(dataRows) ? dataRows : [];
  if (format === "json") return download(`${filenamePrefix}-${timestamp()}.json`, JSON.stringify(rows, null, 2), "application/json;charset=utf-8");
  if (format === "csv") return download(`${filenamePrefix}-${timestamp()}.csv`, `\uFEFF${[columns.map(csvCell).join(","), ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(","))].join("\r\n")}`, "text/csv;charset=utf-8");
  throw new Error(`不支持的导出格式：${format}`);
}
